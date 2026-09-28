// 把 client/public/body 里的 BodyParts3D 网格用 Draco 压小。
// 原始文件搬去 assets/body-source，压缩结果放回 public/body。
// 用法：npm run optimize:body
// 注：不走 @gltf-transform/cli——它的大文件在 ntfs3 挂载上加载会 SIGBUS，这里用底层 API。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { NodeIO } from "@gltf-transform/core"
import { KHRDracoMeshCompression } from "@gltf-transform/extensions"
import draco3d from "draco3dgltf"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bodyDir = path.join(root, "client", "public", "body")
const sourceDir = path.join(root, "assets", "body-source")
const dracoTarget = path.join(root, "client", "public", "draco")
const versionFile = path.join(root, "shared", "body-assets.js")

function fail(message) {
  console.error(`optimize-body: ${message}`)
  process.exit(1)
}

// 只读 GLB 的 JSON 块，数一数「前缀:slug:FMA」这类点选要用的名字还在不在。
function glbNames(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) fail(`${file} 不是 glb`)
  const chunkLength = buf.readUInt32LE(12)
  const chunkType = buf.readUInt32LE(16)
  if (chunkType !== 0x4e4f534a) fail(`${file} 没有 JSON 块`)
  const json = JSON.parse(buf.subarray(20, 20 + chunkLength).toString("utf8"))
  const names = new Set()
  for (const node of json.nodes || []) {
    if (typeof node?.name === "string" && node.name.includes(":")) names.add(node.name)
  }
  for (const mesh of json.meshes || []) {
    if (typeof mesh?.name === "string" && mesh.name.includes(":")) names.add(mesh.name)
  }
  return names
}

fs.mkdirSync(sourceDir, { recursive: true })

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
  })

const files = fs.readdirSync(bodyDir).filter((name) => name.endsWith(".glb")).sort()
if (!files.length) fail(`${bodyDir} 里没有 glb`)

// glb 的几何都在文件里，散落的 .glb.bin 是老管线的遗留，加载器不会请求，纯占地方。
for (const stray of fs.readdirSync(bodyDir).filter((name) => name.endsWith(".glb.bin"))) {
  fs.rmSync(path.join(bodyDir, stray), { force: true })
  console.log(`清理遗留文件 ${stray}`)
}

let beforeBytes = 0
let afterBytes = 0

for (const name of files) {
  const publicFile = path.join(bodyDir, name)
  const sourceFile = path.join(sourceDir, name)
  const tmpFile = path.join(bodyDir, `${name}.tmp.glb`)

  if (!fs.existsSync(sourceFile)) fs.copyFileSync(publicFile, sourceFile)
  const namesBefore = glbNames(sourceFile)
  const beforeSize = fs.statSync(sourceFile).size
  beforeBytes += beforeSize

  const doc = await io.read(sourceFile)
  doc
    .createExtension(KHRDracoMeshCompression)
    .setRequired(true)
    .setEncoderOptions({
      method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
      encodeSpeed: 5,
      decodeSpeed: 5,
      // 试过 quantizationBits: { POSITION: 11, NORMAL: 8 }，体积 -23%，但 Firefox 的
      // Draco WASM 解码会挂起（Node 解码正常、无报错，进度停在 0/13）。在真机上
      // 验证清楚之前不要开启量化。
    })
  await io.write(tmpFile, doc)

  const namesAfter = glbNames(tmpFile)
  const lost = [...namesBefore].filter((item) => !namesAfter.has(item))
  if (lost.length) fail(`压缩 ${name} 丢了 ${lost.length} 个点选名字，例如 ${lost[0]}`)

  const afterSize = fs.statSync(tmpFile).size
  if (afterSize >= beforeSize) {
    console.log(`${name} 压不小（${beforeSize} -> ${afterSize}），保留原文件`)
    fs.rmSync(tmpFile, { force: true })
    fs.copyFileSync(sourceFile, publicFile)
    afterBytes += beforeSize
    continue
  }
  fs.renameSync(tmpFile, publicFile)
  afterBytes += afterSize
  console.log(`${name} ${Math.round(beforeSize / 1024)}KB -> ${Math.round(afterSize / 1024)}KB（名字 ${namesAfter.size}/${namesBefore.size}）`)
}

// three 自带 Draco 解码器，复制一份给前端用，不依赖网络。
fs.rmSync(dracoTarget, { recursive: true, force: true })
fs.mkdirSync(dracoTarget, { recursive: true })
const decoderSrc = path.join(root, "node_modules", "three", "examples", "jsm", "libs", "draco")
for (const name of fs.readdirSync(decoderSrc)) {
  if (!name.startsWith("draco_decoder") && !name.startsWith("draco_wasm_wrapper")) continue
  fs.copyFileSync(path.join(decoderSrc, name), path.join(dracoTarget, name))
  console.log(`draco/${name} 已复制`)
}

// 模型内容变了，版本号跟着变，浏览器才会扔掉旧缓存。
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12)
fs.writeFileSync(versionFile, `// 由 npm run optimize:body 生成，模型一换这里就变。\nexport const BODY_VERSION = "${stamp}"\n`)
console.log(`shared/body-assets.js 版本号 ${stamp}`)
console.log(`合计 ${Math.round(beforeBytes / 1024)}KB -> ${Math.round(afterBytes / 1024)}KB`)
