import { useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../api.js"

function handoffError(err) {
  return err instanceof Error ? err.message : "未能移交"
}

// 按人移交责任人，不改变设备真实使用状态。
export function TodayHandoffSheet({ snap, group, onClose, onSnap, onDone }) {
  const [pendingId, setPendingId] = useState(null)
  const [error, setError] = useState("")
  const openCount = Number.isFinite(group.open)
    ? group.open
    : Math.max(0, Number(group.total || 0) - Number(group.done || 0))
  const peers = (snap.staff || []).filter((person) => person.id !== group.staffId)

  async function moveTo(person) {
    if (pendingId || !group.staffId) return
    setPendingId(person.id)
    setError("")
    try {
      const result = await api.reassignOpen(group.staffId, person.id)
      onSnap(result)
      onDone(result.handoff?.count ?? openCount)
    } catch (err) {
      setError(handoffError(err))
    } finally {
      setPendingId(null)
    }
  }

  return createPortal(
    <div className="sheet-back" onClick={onClose} role="presentation">
      <div
        className="sheet today-handoff-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="today-handoff-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="today-handoff-heading">
          <div>
            <h2 id="today-handoff-title">移交任务</h2>
            <p>{`把 ${group.name || "这位员工"} 名下 ${openCount} 个未完成项移交给：`}</p>
          </div>
          <button type="button" className="today-gear" onClick={onClose}>收起</button>
        </div>
        <p className="today-handoff-hint">跨病人整批移交；仍在使用的设备保持占用，请当面交接。</p>
        {error ? <p className="error today-handoff-error" role="alert">{error}</p> : null}
        <div className="today-handoff-list">
          {peers.length ? peers.map((person) => (
            <button
              key={person.id}
              type="button"
              className="row-btn today-handoff-person"
              disabled={Boolean(pendingId)}
              onClick={() => moveTo(person)}
            >
              <span>{person.name}</span>
              <span>{pendingId === person.id ? "正在移交…" : "移交给 TA"}</span>
            </button>
          )) : <p className="today-command-empty">没有其他员工可移交。</p>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
