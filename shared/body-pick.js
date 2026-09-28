// 点选命中优先级：穴位球贴在肌腹上时，正对肌肉中心的射线会先打到球。
// 若紧挨着还有肌肉/部位，认后面的；穴位仍可从名单加，或点偏一点专打球。

const NODE_OVERLAP = 0.08

/**
 * @param {{ targetId: string, kind: string, distance: number }[]} hits 按距离从近到远
 * @returns {{ targetId: string, kind: string, distance: number } | null}
 */
export function chooseBodyHit(hits) {
  if (!hits?.length) return null
  const first = hits[0]
  if (first.kind === "node") {
    const behind = hits.find(
      (hit) => hit !== first && hit.kind !== "node" && hit.distance - first.distance <= NODE_OVERLAP,
    )
    if (behind) return behind
  }
  return first
}
