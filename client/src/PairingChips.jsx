// 常见搭配的芯片行：加项面板（点击加项）和设置编辑器（预览）共用同一份长相。
import { hasSides, targetById, targetTitle } from "@shared/catalog.js"
import "./pairing.css"

// ids：搭配表里的靶点列表；side：主诉那一侧（有侧的靶点跟着用）。
// added：「targetId:side」集合，已在单上的芯片点亮；onPick 缺省时按纯展示渲染。
export function PairingChips({ ids, side, added, disabled, onPick, splitSides = false }) {
  if (!ids?.length) return null
  const rows = []
  for (const targetId of ids) {
    const target = targetById(targetId)
    if (!target) continue
    // 加项面板里主诉没有侧别（例如腰/颈）时，可侧化目标必须落成两个明确芯片；
    // 设置页保持原来的一枚无侧预览，避免编辑器把同一条搭配显示两遍。
    const chipSides = splitSides && hasSides(target) && !side ? ["left", "right"] : [hasSides(target) ? side ?? null : null]
    for (const chipSide of chipSides) rows.push({ targetId, chipSide })
  }
  return (
    <div className="pairing-chips">
      {rows.map(({ targetId, chipSide }) => {
        const on = added?.has(`${targetId}:${chipSide || ""}`)
        const className = ["pairing-chip", on ? "is-on" : "", onPick ? "" : "is-static"]
          .filter(Boolean)
          .join(" ")
        return onPick ? (
          <button
            key={`${targetId}:${chipSide || "mid"}`}
            type="button"
            className={className}
            disabled={disabled}
            onClick={() => onPick(targetId, chipSide)}
          >
            {targetTitle(targetId, chipSide)}
          </button>
        ) : (
          <span key={`${targetId}:${chipSide || "mid"}`} className={className}>
            {targetTitle(targetId, chipSide)}
          </span>
        )
      })}
    </div>
  )
}
