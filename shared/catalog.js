export const TECHNIQUES = [
  { id: "massage", label: "按摩" },
  { id: "release", label: "松解" },
  { id: "equipment", label: "器械" },
]

export const DIRECTIONS = [
  { id: "along", label: "沿肌纤维" },
  { id: "against", label: "逆肌纤维" },
  { id: "outward", label: "由近到远" },
  { id: "inward", label: "由远到近" },
]

export const TARGETS = [
  { id: "knee", name: "膝盖", kind: "site", x: 0.2, y: 0.46, z: 0.1 },
  { id: "lumbar", name: "腰", kind: "both", x: 0, y: 1.02, z: -0.12 },
  { id: "neck", name: "颈", kind: "site", x: 0, y: 1.48, z: 0.02 },
  { id: "shoulder", name: "肩", kind: "both", x: -0.34, y: 1.32, z: 0.02 },
  { id: "hamstring", name: "腘绳肌", kind: "muscle", x: -0.16, y: 0.7, z: -0.12 },
  { id: "quad", name: "股四头肌", kind: "muscle", x: 0.18, y: 0.72, z: 0.12 },
  { id: "glute", name: "臀", kind: "muscle", x: 0.02, y: 0.9, z: -0.16 },
  { id: "soleus", name: "比目鱼肌", kind: "muscle", x: -0.16, y: 0.26, z: -0.08 },
  { id: "gastroc", name: "腓肠肌", kind: "muscle", x: 0.16, y: 0.3, z: -0.1 },
  { id: "plantar", name: "足底", kind: "node", x: 0.02, y: 0.05, z: 0.04 },
  { id: "chengshan", name: "承山", kind: "node", x: 0.14, y: 0.28, z: -0.12 },
  { id: "itband", name: "髂胫束", kind: "node", x: 0.26, y: 0.78, z: 0.04 },
  // 大腿与髋
  { id: "adductors", name: "内收肌群", kind: "muscle" },
  { id: "sartorius", name: "缝匠肌", kind: "muscle" },
  { id: "popliteus", name: "腘肌", kind: "muscle" },
  { id: "iliopsoas", name: "髂腰肌", kind: "muscle" },
  { id: "piriformis", name: "梨状肌", kind: "muscle" },
  // 小腿与足
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

export function defaultDose(technique) {
  if (technique === "equipment") return { sets: 3, reps: 10 }
  return { minutes: 8 }
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
