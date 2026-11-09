// 把 client/public/body 里的 BodyParts3D 网格用 Meshopt + 量化（KHR_mesh_quantization）压小。
// 原始文件搬去 assets/body-source，压缩结果放回 public/body。
// 用法：npm run optimize:body
// 注：不走 @gltf-transform/cli——它的大文件在 ntfs3 挂载上加载会 SIGBUS，这里用底层 API。
// 之前用过 Draco：解码要下 286KB wasm、低端机全量解码 1-3 秒，且一开顶点量化 Firefox
// 的 wasm 解码就挂起。Meshopt 解码器是纯 JS（随前端包走）、解码快数倍，量化由 three
// 原生支持，绕开了那两类问题。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { NodeIO } from "@gltf-transform/core"
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions"
import { meshopt } from "@gltf-transform/functions"
import { MeshoptEncoder } from "meshoptimizer"
import { BODY_FILES } from "../shared/body-map.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bodyDir = path.join(root, "client", "public", "body")
const sourceDir = path.join(root, "assets", "body-source")
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

// 依赖要的是模块本身（ready 只是预热用的 Promise，不是实例）。
await MeshoptEncoder.ready
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({
    "meshopt.encoder": MeshoptEncoder,
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
  // meshopt() 一趟做完：顶点重排 + 量化（默认 POSITION 14 位 / NORMAL 10 位）+ EXT_meshopt_compression。
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }))
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

// 模型内容变了，版本号跟着变，浏览器才会扔掉旧缓存。
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12)
// 只算页面真正会加载的那些文件，加载进度的分母才准。
const bodyBytes = BODY_FILES.reduce((sum, name) => sum + fs.statSync(path.join(bodyDir, name)).size, 0)
fs.writeFileSync(
  versionFile,
  `// 由 npm run optimize:body 生成，模型一换这里就变。\nexport const BODY_VERSION = "${stamp}"\n` +
    `// 页面要加载的全部模型文件合计字节数，加载时显示「已下载 x / 共 y MB」。\nexport const BODY_BYTES = ${bodyBytes}\n`,
)
console.log(`shared/body-assets.js 版本号 ${stamp}`)
console.log(`合计 ${Math.round(beforeBytes / 1024)}KB -> ${Math.round(afterBytes / 1024)}KB`)
