import { useRef, useState } from "react"
import { api } from "../api.js"
import "./gate.css"

export function Gate({ snap, onChange }) {
  const pending = useRef(false)
  const [staffName, setStaffName] = useState("")
  const [error, setError] = useState("")
  const staff = snap.staff || []

  async function run(task) {
    if (pending.current) return
    pending.current = true
    setError("")
    try {
      const next = await task()
      onChange(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : "未能保存")
    } finally {
      pending.current = false
    }
  }

  if (snap.stage === "whoami") {
    return (
      <main className="screen gate">
        <h1>今天你是谁</h1>
        <div className="gate-names">
          {staff.map((person) => (
            <button
              key={person.id}
              type="button"
              className="name-btn"
              onClick={() => run(() => api.claim({ staffId: person.id }))}
            >
              {person.name}
            </button>
          ))}
        </div>
        <form
          className="stack gate-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            run(() => api.claim({ staffName }))
          }}
        >
          <div className="gate-spacer" />
          <label className="field">
            新名字
            <input
              value={staffName}
              autoComplete="off"
              enterKeyHint="done"
              onChange={(event) => setStaffName(event.target.value)}
            />
          </label>
          <div className="dock">
            <p className="error">{error}</p>
            <button className="primary" type="submit">添加并进入</button>
          </div>
        </form>
      </main>
    )
  }

  return (
    <main className="screen gate">
      <h1>治疗室</h1>
      <p className="muted">第一台手机写下自己的名字。关掉页面后仍会记住这台手机。</p>
      <form
        className="stack gate-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          run(() => api.setup(staffName))
        }}
      >
        <label className="field">
          我的名字
          <input
            value={staffName}
            autoComplete="off"
            enterKeyHint="done"
            onChange={(event) => setStaffName(event.target.value)}
          />
        </label>
        <div className="gate-spacer" />
        <div className="dock">
          <p className="error">{error}</p>
          <button className="primary" type="submit">进入治疗室</button>
        </div>
      </form>
    </main>
  )
}
