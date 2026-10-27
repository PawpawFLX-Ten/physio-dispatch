// 病人页的小件：提示条、弹层容器、部位选择钮。
import { targetTitle } from "@shared/catalog.js"

export function Notice({ notice }) {
  if (!notice?.text) return null
  const tone = notice.tone === "error" ? "is-error" : "is-ok"
  return (
    <p className={`patient-notice ${tone}`} role="status">
      {notice.text}
    </p>
  )
}

export function Sheet({ title, children, onClose }) {
  return (
    <div className="patient-shade" onClick={() => onClose?.()} role="presentation">
      <div
        className="patient-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title || "请选择"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="patient-grab" />
        {title ? <h2>{title}</h2> : null}
        {children}
      </div>
    </div>
  )
}

// 定义在组件外面：放在函数体里的话每个按键都会换一个组件类型，全部按钮被卸载重挂。
export function ChoiceButton({ target, side, pending, onPick }) {
  return (
    <button
      type="button"
      className="patient-choice"
      disabled={pending}
      onClick={() => onPick(target.id, side)}
    >
      {targetTitle(target.id, side)}
    </button>
  )
}
