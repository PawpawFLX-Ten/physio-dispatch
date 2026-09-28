// 安卓返回键 / 浏览器返回 / Escape 的统一分层处理。
// 每个打开的界面层（病人页、弹层、重选模式…）登记一个 history 哨兵：
// - 按返回键 → popstate → 关掉最上面一层（不是退出整个应用）
// - 界面自己关掉一层（点遮罩、点收起）→ 静默退掉对应哨兵，不惊动别的层
// - 关闭被拦下（保存中上锁、改弹「记回病症」提醒）→ 补一个哨兵，返回键仍然受保护
// 快速连按返回时，上一层可能还没被 React 清走：consumed 标记保证一次返回只关一层、
// 下一层不会被同一连按误触发；哨兵重新对齐时自动解除标记。
import { useEffect, useRef } from "react"

const stack = []
let suppress = 0
let pendingBack = false
let reconcileTimer = 0
let seq = 0

function topSentinelId() {
  return history.state && Object.prototype.hasOwnProperty.call(history.state, "physioLayer")
    ? history.state.physioLayer
    : null
}

function scheduleReconcile() {
  if (!reconcileTimer) reconcileTimer = setTimeout(reconcile, 0)
}

function reconcile() {
  reconcileTimer = 0
  if (pendingBack) {
    scheduleReconcile()
    return
  }
  const top = topSentinelId()
  // 界面已经关了、浏览器却还停在对应哨兵上：静默退掉它
  if (top != null && !stack.some((layer) => layer.id === top)) {
    pendingBack = true
    suppress += 1
    history.back()
    scheduleReconcile()
    return
  }
  const layer = stack[stack.length - 1]
  if (!layer) return
  if (top === layer.id) {
    // 哨兵和顶层对上了：这层重新武装，下一次返回键由它响应
    layer.consumed = false
    return
  }
  // 顶层还开着却没了哨兵（返回被锁、或弹层换血）：补一个
  history.pushState({ physioLayer: layer.id }, "")
  layer.consumed = false
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (suppress > 0) {
      suppress -= 1
      pendingBack = false
      reconcile()
      return
    }
    // 跳过刚被上一次返回关掉、React 还没来得及清理的层
    while (stack.length && stack[stack.length - 1].consumed) stack.pop()
    const layer = stack[stack.length - 1]
    if (layer) {
      layer.consumed = true
      layer.close()
    }
    scheduleReconcile()
  })
}

// active 为 true 时占一层；close 负责把这层关掉（setState 即可）。
// 只在顶层响应 Escape，和返回键同一语义。
export function useBackLayer(active, close) {
  const idRef = useRef(0)
  if (!idRef.current) idRef.current = ++seq
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!active) return undefined
    const layer = { id: idRef.current, close: () => closeRef.current(), consumed: false }
    stack.push(layer)
    history.pushState({ physioLayer: layer.id }, "")
    const onKey = (event) => {
      if (event.key !== "Escape") return
      if (stack[stack.length - 1] !== layer) return
      closeRef.current()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      const index = stack.indexOf(layer)
      if (index >= 0) stack.splice(index, 1)
      scheduleReconcile()
    }
  }, [active])
}
