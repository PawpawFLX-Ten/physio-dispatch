// 常见搭配：要治的地方 → 常一起下手的肌肉，理疗上的经验表。
// 默认表写在这里；治疗室在设置里改过后存 state.pairings，缺的键仍回退默认。
import { allowsWork, targetById } from "./catalog.js"

// 能当主诉的部位，也是搭配表的键。
export const CHIEF_SITES = ["knee", "lumbar", "neck", "shoulder"]

export const DEFAULT_PAIRINGS = {
  // 膝：按髌股痛指南补髋周（臀肌群+臀中肌），不再只有大腿前后侧。
  knee: ["quad", "hamstring", "glute", "glute-med", "itband", "soleus", "gastroc"],
  lumbar: ["glute", "erector-spinae", "iliopsoas", "piriformis", "hamstring"],
  // 颈：去掉胸锁乳突肌（老年人颈动脉窦区按压有晕厥风险，要做得单独点名，不进默认）。
  neck: ["trapezius", "levator-scap", "rhomboid"],
  // 肩：补前锯肌（肩胛控制是肩袖指南要点）。
  shoulder: ["supraspinatus", "infraspinatus", "subscapularis", "teres-minor", "serratus", "trapezius", "pectoralis-major"],
}

// 读侧：没编辑过的部位用默认，编辑过的用存下的；顺手滤掉目录里已不存在的靶点。
export function mergedPairings(stored) {
  const table = {}
  for (const site of CHIEF_SITES) {
    const source = Array.isArray(stored?.[site]) ? stored[site] : DEFAULT_PAIRINGS[site]
    table[site] = source.filter((targetId) => allowsWork(targetById(targetId)))
  }
  return table
}

// 写侧清洗：只认主诉部位键，值只认下手项 id；去重，每个部位最多 12 个。
export function sanitizePairings(input) {
  const clean = {}
  if (!input || typeof input !== "object" || Array.isArray(input)) return clean
  for (const site of CHIEF_SITES) {
    if (!Array.isArray(input[site])) continue
    const seen = new Set()
    const list = []
    for (const targetId of input[site]) {
      if (typeof targetId !== "string" || seen.has(targetId)) continue
      if (!allowsWork(targetById(targetId))) continue
      seen.add(targetId)
      list.push(targetId)
      if (list.length >= 12) break
    }
    clean[site] = list
  }
  return clean
}
