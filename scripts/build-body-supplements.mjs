// 用 BodyParts3D 4.0 的 isa OBJ 归档（dbarchive.biosciencedbc.jp，CC BY-SA 2.1 JP）
// 构建缺失部位的 supplement 肌肉 glb。顶点数据是 OBJ 毫米原样（M 文件是 X 镜像），
// 根节点烤 -90°X（Z-up→Y-up）+ 0.001 缩放，与既有 supplement glb 的约定一致。
// 用法：
//   1. 下载归档：curl -LO https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip
//   2. 解出需要的 OBJ（见下方 MUSCLES 的 FJ 列表）放进 OBJ_DIR
//   3. node scripts/build-body-supplements.mjs            # 产出原始 glb 到 client/public/body/
//   4. npm run optimize:body                              # Draco 压缩 + 版本号
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Accessor, Document, NodeIO, Primitive } from "@gltf-transform/core"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const objDir = process.env.OBJ_DIR || "/tmp/bp3d-objs"
const outDir = path.join(root, "client", "public", "body")

// 每个新 supplement 文件：区域前缀 → 肌肉 slug → 元素 FJ 文件（左右两侧）。
// 深层或分组肌把多个元素并进同一个 target。
export const FILES = [
  {
    file: "supplement-arm-muscle.glb",
    region: "arm",
    muscles: {
      "biceps-brachii": ["FJ1512", "FJ1512M", "FJ1478", "FJ1478M"],
      "triceps-brachii": ["FJ1479", "FJ1479M", "FJ1480", "FJ1480M", "FJ1477", "FJ1477M"],
      brachioradialis: ["FJ1487", "FJ1487M"],
      "forearm-extensors": ["FJ1490", "FJ1490M", "FJ1489", "FJ1489M", "FJ1492", "FJ1492M", "FJ1472", "FJ1472M"],
      "forearm-flexors": ["FJ1496", "FJ1496M", "FJ1502", "FJ1502M", "FJ1473", "FJ1473M", "FJ1518", "FJ1518M"],
    },
  },
  {
    file: "supplement-trunk-muscle.glb",
    region: "trunk",
    muscles: {
      "pectoralis-major": ["FJ1447", "FJ1447M", "FJ1464", "FJ1464M", "FJ1446", "FJ1446M"],
      "pectoralis-minor": ["FJ1456", "FJ1456M"],
      "obliquus-externus": ["FJ1452", "FJ1452M"],
    },
  },
]

function parseObj(file) {
  const positions = []
  const normals = []
  const indices = []
  const lines = fs.readFileSync(file, "utf8").split("\n")
  for (const line of lines) {
    if (line.startsWith("v ")) {
      const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number)
      positions.push(x, y, z)
    } else if (line.startsWith("vn ")) {
      const [x, y, z] = line.slice(3).trim().split(/\s+/).map(Number)
      normals.push(x, y, z)
    } else if (line.startsWith("f ")) {
      const corners = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((token) => Number(token.split("//")[0]) - 1)
      for (let i = 2; i < corners.length; i += 1) {
        indices.push(corners[0], corners[i - 1], corners[i])
      }
    }
  }
  return { positions, normals, indices }
}

const io = new NodeIO()
fs.mkdirSync(outDir, { recursive: true })

for (const group of FILES) {
  const doc = new Document()
  const buffer = doc.createBuffer(group.file)
  const root3d = doc
    .createNode("BodyParts3D")
    .setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2])
    .setScale([0.001, 0.001, 0.001])
  const scene = doc.createScene()
  scene.addChild(root3d)
  doc.getRoot().setDefaultScene(scene)
  let meshCount = 0
  for (const [slug, elements] of Object.entries(group.muscles)) {
    const muscleNode = doc.createNode(`${group.region}:${slug}`)
    root3d.addChild(muscleNode)
    for (const fj of elements) {
      const file = path.join(objDir, `${fj}.obj`)
      if (!fs.existsSync(file)) {
        console.error(`缺少 ${file}：先把 OBJ 解到 OBJ_DIR（默认 /tmp/bp3d-objs）`)
        process.exit(1)
      }
      const { positions, normals, indices } = parseObj(file)
      const posArray = doc
        .createAccessor(`${fj}-pos`)
        .setType(Accessor.Type.VEC3)
        .setArray(new Float32Array(positions))
        .setBuffer(buffer)
      const prim = doc.createPrimitive().setAttribute("POSITION", posArray).setMode(Primitive.Mode.TRIANGLES)
      if (normals.length === positions.length) {
        prim.setAttribute(
          "NORMAL",
          doc
            .createAccessor(`${fj}-nrm`)
            .setType(Accessor.Type.VEC3)
            .setArray(new Float32Array(normals))
            .setBuffer(buffer),
        )
      }
      if (indices.length) {
        prim.setIndices(
          doc
            .createAccessor(`${fj}-idx`)
            .setType(Accessor.Type.SCALAR)
            .setArray(new Uint32Array(indices))
            .setBuffer(buffer),
        )
      }
      const holder = doc.createNode(`isa:${fj}`)
      const leaf = doc.createNode(`${group.region}:${slug}:isa:${fj}`).setMesh(doc.createMesh(fj).addPrimitive(prim))
      muscleNode.addChild(holder).addChild(leaf)
      meshCount += 1
    }
  }
  const out = path.join(outDir, group.file)
  await io.write(out, doc)
  console.log(`${out}: ${meshCount} 个网格，${(fs.statSync(out).size / 1048576).toFixed(1)} MB`)
}
