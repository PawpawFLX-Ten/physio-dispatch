export const TECHNIQUES = [
  { id: "massage", label: "按摩" },
  { id: "release", label: "松解" },
  { id: "stretch", label: "牵伸" },
  { id: "equipment", label: "器械" },
]

export const DIRECTIONS = [
  { id: "along", label: "沿肌纤维" },
  { id: "against", label: "逆肌纤维" },
  { id: "outward", label: "由近到远" },
  { id: "inward", label: "由远到近" },
]

export const TARGETS = [
  { id: "knee", name: "膝盖", kind: "site", equipmentCapable: true, x: 0.2, y: 0.46, z: 0.1 },
  { id: "lumbar", name: "腰", kind: "both", x: 0, y: 1.02, z: -0.12 },
  { id: "neck", name: "颈", kind: "site", equipmentCapable: true, x: 0, y: 1.48, z: 0.02 },
  { id: "shoulder", name: "肩", kind: "both", x: -0.34, y: 1.32, z: 0.02 },
  { id: "hamstring", name: "腘绳肌", kind: "muscle", x: -0.16, y: 0.7, z: -0.12 },
  { id: "quad", name: "股四头肌", kind: "muscle", x: 0.18, y: 0.72, z: 0.12 },
  { id: "glute", name: "臀肌群", kind: "muscle", x: 0.02, y: 0.9, z: -0.16 },
  // 臀中肌单独立项：膝骨关节炎/髌股痛的指南都强调髋外展肌（JOSPT），不能只按「臀」打包。
  { id: "glute-med", name: "臀中肌", kind: "muscle" },
  { id: "soleus", name: "比目鱼肌", kind: "muscle", x: -0.16, y: 0.26, z: -0.08 },
  { id: "gastroc", name: "腓肠肌", kind: "muscle", x: 0.16, y: 0.3, z: -0.1 },
  { id: "plantar", name: "足底", kind: "node", x: 0.02, y: 0.05, z: 0.04 },
  { id: "chengshan", name: "承山", kind: "node", x: 0.14, y: 0.28, z: -0.12 },
  { id: "itband", name: "髂胫束", kind: "node", x: 0.26, y: 0.78, z: 0.04 },
  // 大腿与髋
  { id: "adductors", name: "内收肌群", kind: "muscle" },
  { id: "sartorius", name: "缝匠肌", kind: "muscle" },
  { id: "iliopsoas", name: "髂腰肌", kind: "muscle" },
  // 梨状肌属臀区深群，贴着坐骨神经：深压前先看备注。
  { id: "piriformis", name: "梨状肌", kind: "muscle" },
  // 小腿与足（腘肌是小腿后群深层，归这儿不归大腿）
  { id: "popliteus", name: "腘肌", kind: "muscle" },
  { id: "tib-anterior", name: "胫骨前肌", kind: "muscle" },
  { id: "tib-posterior", name: "胫骨后肌", kind: "muscle" },
  { id: "fibularis", name: "腓骨肌", kind: "muscle" },
  { id: "edl", name: "趾长伸肌", kind: "muscle" },
  { id: "fdl", name: "趾长屈肌", kind: "muscle" },
  // 肩背与颈
  { id: "trapezius", name: "斜方肌", kind: "muscle" },
  { id: "erector-spinae", name: "竖脊肌", kind: "muscle" },
  { id: "levator-scap", name: "肩胛提肌", kind: "muscle" },
  { id: "rhomboid", name: "菱形肌", kind: "muscle" },
  { id: "serratus", name: "前锯肌", kind: "muscle" },
  { id: "supraspinatus", name: "冈上肌", kind: "muscle" },
  { id: "infraspinatus", name: "冈下肌", kind: "muscle" },
  { id: "subscapularis", name: "肩胛下肌", kind: "muscle" },
  { id: "teres-minor", name: "小圆肌", kind: "muscle" },
  { id: "teres-major", name: "大圆肌", kind: "muscle" },
  { id: "scm", name: "胸锁乳突肌", kind: "muscle" },
  // 手臂与躯干补充（BodyParts3D）
  { id: "pectoralis-major", name: "胸大肌", kind: "muscle" },
  { id: "pectoralis-minor", name: "胸小肌", kind: "muscle" },
  { id: "obliquus-externus", name: "腹外斜肌", kind: "muscle" },
  { id: "biceps-brachii", name: "肱二头肌", kind: "muscle" },
  { id: "triceps-brachii", name: "肱三头肌", kind: "muscle" },
  { id: "brachioradialis", name: "肱桡肌", kind: "muscle" },
  { id: "forearm-extensors", name: "前臂伸肌群", kind: "muscle" },
  { id: "forearm-flexors", name: "前臂屈肌群", kind: "muscle" },
]

export function targetById(id) {
  return TARGETS.find((item) => item.id === id) || null
}

export function allowsChief(target) {
  return target && (target.kind === "site" || target.kind === "both")
}

export function allowsWork(target) {
  return target && target.kind !== "site"
}

// 少数纯部位（膝、颈）可以作为设备作用区域；它们仍不能作为普通手工下手项。
export function allowsEquipment(target) {
  return target && (target.kind !== "site" || target.equipmentCapable === true)
}

export function defaultDose(technique) {
  if (technique === "equipment") return { sets: 3, reps: 10 }
  return { minutes: 8 }
}

// 剂量钳制：说一句解析和服务端入库共用这一份，缺省给默认、至少为 1。
// （patchItem 的部分补丁语义不同——没提到的键要保留原值——那边单独写。）
export function clampDose(technique, dose) {
  if (technique === "equipment") {
    return {
      sets: Math.max(1, Number(dose?.sets) || 3),
      reps: Math.max(1, Number(dose?.reps) || 10),
    }
  }
  return { minutes: Math.max(1, Number(dose?.minutes) || 8) }
}

export function techniqueLabel(id) {
  return TECHNIQUES.find((item) => item.id === id)?.label || id
}

export function directionLabel(id) {
  return DIRECTIONS.find((item) => item.id === id)?.label || id
}

export function doseLabel(technique, dose) {
  if (!dose) return ""
  if (technique === "equipment") return `${dose.sets || 0} 组 · ${dose.reps || 0} 次`
  return `${dose.minutes || 0} 分钟`
}

export function hasSides(target) {
  return Boolean(target) && target.id !== "lumbar" && target.id !== "neck"
}

export function sideLabel(side) {
  if (side === "left") return "左"
  if (side === "right") return "右"
  return ""
}

export function targetTitle(targetId, side) {
  const name = targetById(targetId)?.name || targetId
  const label = sideLabel(side)
  return label ? `${label}${name}` : name
}
