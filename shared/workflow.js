// 操作说明是主治录入的内容；不由程序推断临床操作或参数。
export function instructionFields(item = {}) {
  const text = (key, max = 1000) => typeof item[key] === "string" ? item[key].trim().slice(0, max) : ""
  return {
    position: text("position", 120),
    instructions: text("instructions"),
    caution: text("caution", 500),
    demoUrl: /^https:\/\//i.test(text("demoUrl", 1000)) ? text("demoUrl", 1000) : "",
  }
}

export function remapPlanSide(plan, side) {
  if (!["left", "right", "both"].includes(side)) return structuredClone(plan)
  const original = plan.chiefSide
  const sides = side === "both" ? ["left", "right"] : [side]
  const lateral = (id) => id !== "lumbar" && id !== "neck"
  return {
    ...structuredClone(plan),
    chiefSide: lateral(plan.chiefSiteId) && side !== "both" ? side : null,
    items: (plan.items || []).flatMap((item) => {
      // 有明确主诉侧的混合方案保留对侧关系；无主诉侧时显式把所有侧化项换为所选侧。
      const relative = (value, chosen) => original && value && value !== original
        ? chosen === "left" ? "right" : "left"
        : chosen
      return (lateral(item.targetId) ? sides : [null]).map((chosen, index) => ({
        ...structuredClone(item),
        ...(index > 0 && item.id ? { id: `${item.id}:side:${chosen}`, sourceItemId: null } : {}),
        side: chosen ? relative(item.side, chosen) : null,
        linkedTargets: (item.linkedTargets || []).map((link) => ({
          ...link,
          side: lateral(link.targetId) ? relative(link.side, chosen || sides[0]) : null,
        })),
      }))
    }),
  }
}
