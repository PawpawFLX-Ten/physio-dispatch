// 今日单怎么映回人体：哪一侧、治哪/下手、做完变淡。判断放这儿，别只写在 three 回调里。

export function markKey(targetId, side) {
  return `${targetId}:${side || "mid"}`
}

/** 一项对应模型上哪些键：有左右只标那一侧；没有左右（腰/颈）落 mid。 */
export function keysForItem(item) {
  if (!item?.targetId) return []
  if (item.side) return [markKey(item.targetId, item.side)]
  return [markKey(item.targetId, null)]
}

/**
 * @param {{ chiefSiteId?: string|null, chiefSide?: string|null, items?: object[] }} input
 * @returns {{
 *   byKey: Map<string, { orders: number[], allDone: boolean }>,
 *   chiefSiteId: string|null,
 *   chiefSide: string|null,
 * }}
 */
export function buildMarkState({ chiefSiteId = null, chiefSide = null, items = [] } = {}) {
  const byKey = new Map()
  const list = Array.isArray(items) ? items : []
  list.forEach((item, index) => {
    if (!item?.targetId) return
    for (const key of keysForItem(item)) {
      const row = byKey.get(key) || { orders: [], allDone: true }
      row.orders.push(index + 1)
      if (!item.done) row.allDone = false
      byKey.set(key, row)
    }
  })
  return {
    byKey,
    chiefSiteId: chiefSiteId || null,
    chiefSide: chiefSide || null,
  }
}

/**
 * 这块网格该怎么上色。
 * - work / workDone：下手项（同一侧还有未完成就按 work）
 * - chief：要治的地方，更轻
 * - base：未点到
 * @returns {'base'|'chief'|'work'|'workDone'}
 */
export function resolvePaintRole(targetId, side, state) {
  if (!state) return "base"
  const row = state.byKey.get(markKey(targetId, side))
  if (row?.orders.length) return row.allDone ? "workDone" : "work"
  const isChief =
    Boolean(state.chiefSiteId) &&
    targetId === state.chiefSiteId &&
    (!state.chiefSide || !side || side === state.chiefSide)
  if (isChief) return "chief"
  return "base"
}

export function ordersFor(targetId, side, state) {
  if (!state) return []
  return state.byKey.get(markKey(targetId, side))?.orders || []
}

/** 点选时：这块肉（含左右）上已有的项。 */
export function itemsOnSpot(items, targetId, side) {
  const list = Array.isArray(items) ? items : []
  const want = side || null
  return list.filter((item) => {
    if (item?.targetId !== targetId) return false
    return (item.side || null) === want
  })
}
