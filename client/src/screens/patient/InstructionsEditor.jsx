import { useState } from "react"
import { instructionFields } from "@shared/workflow.js"

export function InstructionsEditor({ item, pending, onSave }) {
  const [values, setValues] = useState(() => instructionFields(item))
  const [baseline, setBaseline] = useState(() => instructionFields(item))
  const [saved, setSaved] = useState(false)
  return (
    <form className="instruction-editor" onSubmit={async (event) => {
      event.preventDefault()
      const ok = Boolean(await onSave({ ...values, expectedInstructions: baseline }))
      setSaved(ok)
      if (ok) setBaseline({ ...values })
    }}>
      <h3>给执行者的操作说明</h3>
      <p className="muted">由主治填写，存为模板后整套继承。程序不会自动生成临床操作。</p>
      {JSON.stringify(instructionFields(item)) !== JSON.stringify(baseline) ? (
        <div className="error"><p>其他人更新了说明；你的未保存文字仍在，直接保存不会覆盖对方。</p><button type="button" className="secondary" onClick={() => {
          if (!window.confirm("载入最新说明会替换本框未保存的文字，继续？")) return
          const latest = instructionFields(item)
          setValues(latest); setBaseline(latest); setSaved(false)
        }}>载入最新说明</button></div>
      ) : null}
      {[
        ["position", "体位", "例如由主治指定的摆位", 120],
        ["instructions", "操作要点", "准备、具体步骤和完成标准", 1000],
        ["caution", "特别交代", "本步骤需注意的事项、何时停止并找主治", 500],
        ["demoUrl", "示范链接（HTTPS）", "https://…", 1000],
      ].map(([key, label, placeholder, maxLength]) => (
        <label key={key} className="field">{label}
          {key === "instructions" || key === "caution" ? (
            <textarea rows={3} maxLength={maxLength} value={values[key]} placeholder={placeholder} onChange={(event) => { setSaved(false); setValues({ ...values, [key]: event.target.value }) }} />
          ) : (
            <input type={key === "demoUrl" ? "url" : "text"} maxLength={maxLength} value={values[key]} placeholder={placeholder} onChange={(event) => { setSaved(false); setValues({ ...values, [key]: event.target.value }) }} />
          )}
        </label>
      ))}
      <button type="submit" className="secondary" disabled={pending}>{saved ? "说明已保存" : "保存操作说明"}</button>
      {item.problem ? <div className="error"><p>执行者反馈：{item.problem}</p><button type="button" className="secondary" disabled={pending} onClick={() => onSave({ problem: "" })}>已处理，恢复执行</button></div> : null}
    </form>
  )
}

export function WorkflowControls({ entry, pending, onSave }) {
  return (
    <form className="instruction-editor" onSubmit={(event) => {
      event.preventDefault()
      onSave({ bedLabel: new FormData(event.currentTarget).get("bedLabel") })
    }}>
      <h3>执行安排</h3>
      <label className="workflow-check"><input type="checkbox" checked={entry.sequential} disabled={pending} onChange={(event) => onSave({ sequential: event.target.checked })} />按顺序执行（前一步完成后才能做下一步）</label>
      <p className="muted">旧单默认不强制顺序。开启后所有手机和接口同时生效。</p>
      <label className="field">床位 / 现场位置<input name="bedLabel" defaultValue={entry.bedLabel} maxLength={60} placeholder="例如 3 号床" /></label>
      <button type="submit" className="secondary" disabled={pending}>保存位置</button>
    </form>
  )
}
