import { useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { directionLabel, doseLabel, targetTitle, techniqueLabel } from "@shared/catalog.js"
import { api } from "../api.js"
import { matchesInitials } from "../pinyin.js"

// 选择患者只读；预览和派发分开。关闭草稿不增加今日单、不追加项目。
export function TodayCommandSheet({ snap, onClose, onSnap, onDone }) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(null)
  const [text, setText] = useState("")
  const [side, setSide] = useState("")
  const [sequential, setSequential] = useState(true)
  const [preview, setPreview] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const busy = useRef(false)
  const inputRef = useRef(null)
  const patients = useMemo(() => {
    const today = new Map((snap.today || []).map((entry) => [entry.patientId, entry]))
    return (snap.patients || [])
      .filter((patient) => !patient.archived || today.has(patient.id))
      .map((patient) => ({ ...patient, inToday: today.has(patient.id) }))
      .filter((patient) => matchesInitials(query, patient.name) || patient.conditions.some((condition) => matchesInitials(query, condition.name)))
      .sort((left, right) => Number(right.inToday) - Number(left.inToday))
  }, [snap.today, snap.patients, query])

  function change(setter, value) {
    setter(value)
    setPreview(null)
    setError("")
  }

  async function submit(event) {
    event.preventDefault()
    if (busy.current || !selected || !text.trim()) return
    busy.current = true
    setPending(true)
    setError("")
    const input = { patientId: selected.id, text: text.trim(), side: side || undefined, sequential }
    try {
      if (!preview) {
        inputRef.current?.blur()
        setPreview(await api.previewOrder(input))
      } else if (!preview.draft.issues.length) {
        const result = await api.dispatchOrder({ ...input, token: preview.token })
        onSnap(result)
        onDone(result.entry.items.length, { addedToday: !selected.inToday })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "未能保存")
      if (err?.status === 409) setPreview(null)
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  return createPortal(
    <div className="sheet-back" onClick={pending ? undefined : onClose} role="presentation">
      <div className="sheet today-command-sheet" role="dialog" aria-modal="true" aria-labelledby="today-command-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="today-command-heading">
          <div>
            <h2 id="today-command-title">吩咐</h2>
            <p className="today-command-hint">先选患者，照上次、套方案或说变化。预览确认后才派发。</p>
          </div>
          <button type="button" className="today-gear" disabled={pending} onClick={onClose}>收起</button>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {!selected ? (
          <>
            <input className="today-search" type="search" aria-label="搜病人（今天未加入的会先加入今天）" placeholder="搜病人，选择不会立即加入今天" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="today-command-patients">
              {patients.map((patient) => (
                <button key={patient.id} type="button" className="row-btn today-command-patient" onClick={() => setSelected(patient)}>
                  <span><strong>{patient.name}</strong><span className="today-command-patient-conditions">{patient.conditions.map((condition) => condition.name).join("、")}</span></span>
                  <span className="today-command-patient-state">{patient.inToday ? "已在今天" : "未加入今天"}</span>
                </button>
              ))}
              {!patients.length ? <p>没找到患者，请先加入患者档案。</p> : null}
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="today-command-selected">
              <strong>{selected.name}</strong>
              <button type="button" className="secondary" disabled={pending} onClick={() => { setSelected(null); setPreview(null); setText(""); setError("") }}>换病人</button>
            </div>
            <div className="command-shortcuts">
              <button type="button" className="secondary" disabled={pending} onClick={() => change(setText, "照上次")}>照上次</button>
              {(snap.templates || []).map((template) => (
                <button key={template.id} type="button" className="secondary" disabled={pending} onClick={() => change(setText, `套用${template.name}`)}>{template.shortName || template.name}</button>
              ))}
            </div>
            <textarea ref={inputRef} className="today-search today-command-input" value={text} disabled={pending} aria-label="输入吩咐" placeholder="照上次，第二项改成5分钟，最后一项今天不做，交给小李" rows={3} onChange={(event) => change(setText, event.target.value)} />
            <p className="muted">可用手机键盘的话筒输入。支持第几项、去掉、改时长/手法/侧别、移到第一/最后、分步派工。</p>
            <label className="field">整套侧别
              <select value={side} disabled={pending} onChange={(event) => change(setSide, event.target.value)}>
                <option value="">沿用原侧别</option><option value="left">左侧</option><option value="right">右侧</option><option value="both">双侧</option>
              </select>
            </label>
            <label className="workflow-check"><input type="checkbox" checked={sequential} disabled={pending} onChange={(event) => change(setSequential, event.target.checked)} />按顺序执行，前一步完成后才能做下一步</label>
            {preview ? (
              <div className="today-command-preview" aria-live="polite">
                <h3>{preview.draft.sourceLabel}</h3>
                <p>{`要治 ${targetTitle(preview.draft.chiefSiteId, preview.draft.chiefSide)}`}</p>
                <ul>{preview.draft.changes.map((line, index) => <li key={index}>{line}</li>)}</ul>
                {preview.draft.issues.length ? <div className="error" role="alert"><strong>以下内容待确认，暂不派发：</strong><ul>{preview.draft.issues.map((line) => <li key={line}>{line}</li>)}</ul></div> : null}
                <ol className="command-draft-items">
                  {preview.draft.items.map((item, index) => (
                    <li key={`${item.id}:${index}`}>
                      <strong>{targetTitle(item.targetId, item.side)}</strong>
                      <p>{item.equipmentSummary || [techniqueLabel(item.technique), directionLabel(item.direction), doseLabel(item.technique, item.dose)].join(" · ")}</p>
                      <p>{`执行：${snap.staff.find((person) => person.id === item.assigneeId)?.name || "未派工"}`}</p>
                      {item.position ? <p>体位：{item.position}</p> : null}
                      {item.instructions ? <p>{item.instructions}</p> : null}
                      {item.caution ? <p className="error">{item.caution}</p> : null}
                      <small className="muted">{item.provenance || "沿用今天"}</small>
                    </li>
                  ))}
                </ol>
                <p className="muted">未明确说出的参数会在上方完整列出，请核对；程序不作治疗建议。</p>
                {side ? <p className="muted">整套换侧只映射结构化部位；操作说明文字里的左右也请核对。</p> : null}
              </div>
            ) : null}
            <button type="submit" className="primary today-command-submit" disabled={pending || !text.trim() || Boolean(preview?.draft.issues.length)}>{pending ? "正在处理…" : preview ? "确认派发" : "预览安排"}</button>
          </form>
        )}
      </div>
    </div>, document.body,
  )
}
