import { useState } from "react"
import { directionLabel, doseLabel, techniqueLabel } from "@shared/catalog.js"

export function ExecutionCard({ task, current, busy, onOpen, onPatch }) {
  const [report, setReport] = useState(false)
  const [problem, setProblem] = useState("")
  const equipment = task.technique === "equipment" || Boolean(task.equipmentTypeId)
  const started = Boolean(task.startedAt)
  const canExecute = task.canExecute !== false
  const detail = equipment
    ? task.equipmentSummary || doseLabel("equipment", task.dose)
    : [techniqueLabel(task.technique), directionLabel(task.direction), doseLabel(task.technique, task.dose)].join(" · ")
  const safeDemo = /^https:\/\//i.test(task.demoUrl || "")
  return (
    <article data-item={task.itemId} className={`execution-card today-my-wrap${current ? " is-current" : ""}${started ? " is-started" : ""}`}>
      <p className="execution-status">{current ? "当前步骤 · " : ""}{task.reason || "待执行"}</p>
      <div className="execution-heading">
        <h3>{task.patientName}{task.bedLabel ? ` · ${task.bedLabel}` : ""}</h3>
        <button type="button" className="today-gear" onClick={onOpen}>查看整单</button>
      </div>
      <h2 className="execution-target">{task.targetTitle}</h2>
      <p className="execution-detail">{detail}</p>
      {task.position ? <p><strong>体位：</strong>{task.position}</p> : null}
      {task.instructions ? <p className="execution-instructions">{task.instructions}</p> : <p className="muted">未附详细操作说明；不确定时请先联系{task.supervisorName || "主治"}。</p>}
      {task.caution ? <p className="error">特别交代：{task.caution}</p> : null}
      {task.note ? <p className="error">患者提醒：{task.note}</p> : null}
      {safeDemo ? <a href={task.demoUrl} target="_blank" rel="noopener noreferrer">查看主治提供的示范</a> : null}
      {started ? <p className="muted">设备使用中{task.startedByName ? ` · 最初开始：${task.startedByName}` : ""}</p> : null}
      <div className="today-my-actions execution-actions">
        {equipment && !started ? <button type="button" className="primary" disabled={busy || !canExecute} onClick={() => onPatch({ started: true })}>开始设备</button> : null}
        <button type="button" className={equipment && !started ? "secondary" : "primary"} disabled={busy || !canExecute || Boolean(equipment && !started)} onClick={() => onPatch({ done: true })}>{busy ? "保存中…" : "完成并下一步"}</button>
        {started ? <button type="button" className="secondary" disabled={busy} onClick={() => onPatch({ started: false })}>结束设备</button> : null}
        <button type="button" className="secondary" disabled={busy} onClick={() => setReport(!report)}>遇到问题</button>
      </div>
      {report ? (
        <form className="execution-report" onSubmit={async (event) => {
          event.preventDefault()
          if (!problem.trim()) return
          const ok = await onPatch({ problem: problem.trim() })
          if (ok) { setReport(false); setProblem("") }
        }}>
          <label className="field">请联系{task.supervisorName || "主治"}并说明问题<textarea rows={2} maxLength={500} value={problem} required onChange={(event) => setProblem(event.target.value)} /></label>
          <p className="muted">反馈后暂停此项，不会自动结束设备；如仍在使用，请先处理现场。主治在整单的项目卡中处理后恢复。</p>
          <button type="submit" className="secondary" disabled={busy || !problem.trim()}>反馈并暂停此项</button>
        </form>
      ) : null}
    </article>
  )
}
