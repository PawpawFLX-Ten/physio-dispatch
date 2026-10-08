// 常见搭配的芯片行：加项面板（点击加项）和设置编辑器（预览）共用同一份长相。
import { hasSides, targetById, targetTitle } from "@shared/catalog.js"
import "./pairing.css"

// ids：搭配表里的靶点列表；side：主诉那一侧（有侧的靶点跟着用）。
// added：「targetId:side」集合，已在单上的芯片点亮；onPick 缺省时按纯展示渲染。
export function PairingChips({ ids, side, added, disabled, onPick }) {
  if (!ids?.length) return null
  return (
    <div className="pairing-chips">
      {ids.map((targetId) => {
        const target = targetById(targetId)
        if (!target) return null
        const chipSide = hasSides(target) ? side ?? null : null
        const on = added?.has(`${targetId}:${chipSide || ""}`)
        const className = ["pairing-chip", on ? "is-on" : "", onPick ? "" : "is-static"]
          .filter(Boolean)
          .join(" ")
        return onPick ? (
          <button
            key={targetId}
            type="button"
            className={className}
            disabled={disabled}
            onClick={() => onPick(targetId, chipSide)}
          >
            {targetTitle(targetId, chipSide)}
          </button>
        ) : (
          <span key={targetId} className={className}>
            {targetTitle(targetId, chipSide)}
          </span>
        )
      })}
    </div>
  )
}
