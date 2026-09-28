import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../api.js"
import { initialsOf } from "../pinyin.js"
import { useBackLayer } from "../back-layer.js"
import "./today.css"

const PULL_LIMIT = 88
const PULL_ARM = 64

export function Today({ snap, onRefresh, onOpen }) {
  const today = snap.today || []
  const patients = snap.patients || []
  const templates = snap.templates || []
  const [open, setOpen] = useState(false)
  const [banner, setBanner] = useState("")
  const [error, setError] = useState("")
  const [name, setName] = useState("")
  const [conditionName, setConditionName] = useState("")
  const [activeId, setActiveId] = useState(null)
  const [checked, setChecked] = useState([])
  const [settings, setSettings] = useState(false)
  const [mineOnly, setMineOnly] = useState(false)
  const [staffView, setStaffView] = useState(false)
  const prevMineCount = useRef(null)
  const [query, setQuery] = useState("")
  const [templatePick, setTemplatePick] = useState(null)
  const [templateName, setTemplateName] = useState("")
  // ref 当同步守卫拦双击，state 让按钮变灰看得见。
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const { ref: scrollRef, pull, refreshing } = usePullToRefresh({
    enabled: !open && !settings,
    onRefresh,
    onSuccess: () => setBanner(""),
    onFail: (err) => setBanner(err instanceof Error ? err.message : "未能保存"),
  })

  // 返回键 / Escape 关弹层，而不是退出应用。
  useBackLayer(open || settings, () => {
    setOpen(false)
    setSettings(false)
  })

  async function run(task) {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError("")
    try {
      await task()
    } catch (err) {
      setError(err instanceof Error ? err.message : "未能保存")
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  // 一个病人一天只有一条单：预构成 Map，避免每行都 today.find 一遍。
  const todayByPatient = useMemo(() => {
    const map = new Map()
    for (const item of today) {
      if (item.patientId && !map.has(item.patientId)) map.set(item.patientId, item)
    }
    return map
  }, [today])

  function extraConditions(patient) {
    const conditions = patient.conditions || []
    const existing = todayByPatient.get(patient.id)
    if (!existing) return conditions
    const onToday = new Set(existing.conditionIds || [])
    return conditions.filter((condition) => !onToday.has(condition.id))
  }

  function choosePatient(patient) {
    const existing = todayByPatient.get(patient.id)
    const extra = extraConditions(patient)
    if (existing && extra.length === 0) {
      onOpen(existing.id)
      return
    }
    if (extra.length === 0) {
      setActiveId(patient.id)
      setError("这个病人还没有病症")
      return
    }
    if (extra.length === 1) {
      setActiveId(patient.id)
      run(async () => {
        const result = await api.addExisting(patient.id, [extra[0].id])
        onOpen(result.entry.id)
      })
      return
    }
    if (activeId !== patient.id) {
      setActiveId(patient.id)
      setChecked([])
      setError("")
    }
  }

  function toggleCondition(id) {
    setChecked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  const trimmedQuery = query.trim().toLowerCase()
  const shownPatients = useMemo(() => {
    if (!trimmedQuery) return patients
    return patients.filter(
      (patient) =>
        patient.name.toLowerCase().includes(trimmedQuery) ||
        initialsOf(patient.name).includes(trimmedQuery) ||
        (patient.conditions || []).some((condition) => condition.name.toLowerCase().includes(trimmedQuery)),
    )
  }, [patients, trimmedQuery])

  const sameName = name.trim() ? patients.find((patient) => patient.name === name.trim()) : null
  const shownToday = mineOnly ? today.filter((entry) => (entry.mineTotal || 0) > 0) : today
  const byStaff = snap.todayByStaff || []

  // 有新活派给自己就震一下（第一次加载不震）。
  useEffect(() => {
    const mineCount = today.reduce(
      (sum, entry) => sum + (entry.mineTotal || 0) - (entry.mineDone || 0),
      0,
    )
    if (prevMineCount.current != null && mineCount > prevMineCount.current) {
      navigator.vibrate?.(60)
    }
    prevMineCount.current = mineCount
  }, [today])

  function joinSelected(patient) {
    const allowed = extraConditions(patient).map((condition) => condition.id)
    const ids = checked.filter((id) => allowed.includes(id))
    if (!ids.length) {
      setError("请勾选病症")
      return
    }
    run(async () => {
      const result = await api.addExisting(patient.id, ids)
      onOpen(result.entry.id)
    })
  }

  function repeatLast(patient) {
    run(async () => {
      const result = await api.repeatLastDay(patient.id)
      setOpen(false)
      onOpen(result.entry.id)
    })
  }

  const shown = Math.min(pull, PULL_LIMIT)
  const hint = refreshing ? "正在刷新" : pull > 56 ? "松开刷新" : "下拉刷新"
  const who = [snap.date, snap.me?.name].filter(Boolean).join(" · ")
  const mineCount = today.reduce((sum, entry) => sum + (entry.mineTotal || 0) - (entry.mineDone || 0), 0)

  function lastDayLabel(patient) {
    if (!patient.lastDay) return ""
    if (patient.lastDay === snap.date) return "今天来过"
    return `上次 ${patient.lastDay.slice(5).replace("-", "月")}日`
  }

  return (
    <main className="screen today">
      {/* 打印时只出这一块：一页纸的交班单 */}
      <div className="print-sheet" aria-hidden="true">
        <h1>{`治疗室今日单 · ${snap.date}`}</h1>
        {byStaff.length === 0 ? (
          <p>今天还没有病人</p>
        ) : (
          byStaff.map((group) => (
            <section key={group.staffId || "none"} className="print-section">
              <h2>{`${group.name}（${group.done}/${group.total}）`}</h2>
              <ul>
                {group.patients.map((row) => (
                  <li key={row.entryId}>
                    {`${row.patientName} ${row.done}/${row.total}`}
                    {row.note ? `　⚠ ${row.note}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <header>
        <h1>今日单</h1>
        <p className="muted today-sub">
          <span>{who}</span>
          <span className="today-sub-actions">
            <button type="button" className="today-gear" onClick={() => window.print()}>
              打印
            </button>
            <button type="button" className="today-gear" onClick={() => setSettings(true)}>
              设置
            </button>
          </span>
        </p>
        {banner ? <p className="error">{banner}</p> : null}
        <div className="today-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!mineOnly && !staffView}
            className={!mineOnly && !staffView ? "today-tab is-on" : "today-tab"}
            onClick={() => {
              setMineOnly(false)
              setStaffView(false)
            }}
          >
            全部
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mineOnly}
            className={mineOnly ? "today-tab is-on" : "today-tab"}
            onClick={() => {
              setMineOnly(true)
              setStaffView(false)
            }}
          >
            派给我的{mineCount ? ` ${mineCount}` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={staffView}
            className={staffView ? "today-tab is-on" : "today-tab"}
            onClick={() => {
              setStaffView(true)
              setMineOnly(false)
            }}
          >
            按人
          </button>
        </div>
      </header>
      <div className="today-scroll" ref={scrollRef}>
        <div className="pull-label" style={{ height: shown }} aria-live="polite">
          {shown > 0 ? hint : ""}
        </div>
        <div className="today-shift" style={shown ? { transform: `translateY(${shown}px)` } : undefined}>
          {staffView ? (
            byStaff.length === 0 ? (
              <p className="today-empty">今天还没有病人</p>
            ) : (
              byStaff.map((group) => (
                <section key={group.staffId || "none"} className="today-group">
                  <h2 className="today-group-title">
                    {group.name}
                    <span className="today-group-count">{`${group.done}/${group.total}`}</span>
                  </h2>
                  <div className="today-list">
                    {group.patients.map((row) => (
                      <button
                        key={row.entryId}
                        type="button"
                        className="row-btn today-row"
                        onClick={() => onOpen(row.entryId)}
                      >
                        <span className="today-name">{row.patientName}</span>
                        <span className="today-count">{`${row.done}/${row.total}`}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))
            )
          ) : shownToday.length === 0 ? (
            <p className="today-empty">{mineOnly ? "还没有派给你的项" : "今天还没有病人"}</p>
          ) : (
            <div className="today-list">
              {shownToday.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="row-btn today-row"
                  onClick={() => onOpen(todayByPatient.get(entry.patientId)?.id || entry.id)}
                >
                  <span className="today-name">{entry.patientName}</span>
                  {entry.note ? <span className="today-note">{`⚠ ${entry.note}`}</span> : null}
                  {entry.conditionNames?.length ? (
                    <span className="today-conditions">{entry.conditionNames.join("、")}</span>
                  ) : null}
                  <span className="today-count">
                    {mineOnly ? `${entry.mineDone}/${entry.mineTotal}` : `${entry.doneCount}/${entry.total}`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="dock">
        <button
          type="button"
          className="primary"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          加入病人
        </button>
      </div>
      {open
        ? createPortal(
        <div className="sheet-back" onClick={() => setOpen(false)}>
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="join-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <h2 id="join-title">加入病人</h2>
            <p className="muted">点外面关闭</p>
            <p className="error sheet-error">{error}</p>
            {templates.length ? (
              <>
                <h3>从模板开始</h3>
                <div className="patient-list">
                  {templates.map((template) =>
                    templatePick === template.id ? (
                      <form
                        key={template.id}
                        className="today-template-form"
                        onSubmit={(event) => {
                          event.preventDefault()
                          run(async () => {
                            const result = await api.createPatientFromTemplate(templateName.trim(), template.id)
                            setTemplatePick(null)
                            setTemplateName("")
                            onOpen(result.entry.id)
                          })
                        }}
                      >
                        <p className="muted">{`「${template.name}」共 ${template.itemCount} 项，写下病人姓名就能开始`}</p>
                        <label className="field">
                          病人姓名
                          <input
                            value={templateName}
                            autoComplete="off"
                            enterKeyHint="done"
                            autoFocus
                            onChange={(event) => setTemplateName(event.target.value)}
                          />
                        </label>
                        <div className="today-template-buttons">
                          <button type="button" className="secondary" onClick={() => setTemplatePick(null)}>
                            取消
                          </button>
                          <button className="primary" type="submit">开始</button>
                        </div>
                      </form>
                    ) : (
                      <button
                        key={template.id}
                        type="button"
                        className="row-btn patient-row"
                        onClick={() => {
                          setTemplatePick(template.id)
                          setTemplateName("")
                        }}
                      >
                        <span className="patient-name">{template.name}</span>
                        <span className="patient-conds">{`模板 · ${template.itemCount} 项`}</span>
                      </button>
                    ),
                  )}
                </div>
              </>
            ) : null}
            <form
              className="stack"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                run(async () => {
                  const result = await api.createPatient(name, conditionName)
                  onOpen(result.entry.id)
                })
              }}
            >
              <h3>新病人</h3>
              <label className="field">
                姓名
                <input
                  value={name}
                  autoComplete="off"
                  enterKeyHint="next"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {sameName ? (
                <div className="today-same-name">
                  <p className="error">{`已有叫${sameName.name}的病人`}</p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setOpen(false)
                      choosePatient(sameName)
                    }}
                  >
                    打开 {sameName.name}
                  </button>
                </div>
              ) : null}
              <label className="field">
                病症名称
                <input
                  value={conditionName}
                  autoComplete="off"
                  enterKeyHint="done"
                  onChange={(event) => setConditionName(event.target.value)}
                />
              </label>
              <button className="primary" type="submit">开始点选</button>
            </form>
            <section className="sheet-existing">
              <h3>已有病人</h3>
              {patients.length > 6 ? (
                <input
                  className="today-search"
                  type="search"
                  value={query}
                  placeholder="搜名字或病症，可输拼音首字母"
                  aria-label="搜病人"
                  onChange={(event) => setQuery(event.target.value)}
                />
              ) : null}
              <div className="patient-list">
                {shownPatients.map((patient) => {
                  const conditions = patient.conditions || []
                  const extra = extraConditions(patient)
                  const expanded = activeId === patient.id && extra.length > 1
                  const lastDay = lastDayLabel(patient)
                  return (
                    <div key={patient.id} className="patient-block">
                      <button type="button" className="row-btn patient-row" onClick={() => choosePatient(patient)}>
                        <span className="patient-name">{patient.name}</span>
                        {conditions.length === 0 ? (
                          <span className="error">这个病人还没有病症</span>
                        ) : (
                          <span className="patient-conds">{conditions.map((condition) => condition.name).join("、")}</span>
                        )}
                        {lastDay ? <span className="patient-last">{lastDay}</span> : null}
                      </button>
                      {patient.lastSummary ? (
                        <p className="patient-last-summary">{`上次做了：${patient.lastSummary}`}</p>
                      ) : null}
                      {patient.prevDay && !todayByPatient.has(patient.id) ? (
                        <button
                          type="button"
                          className="today-repeat"
                          disabled={pending}
                          onClick={() => repeatLast(patient)}
                        >
                          {`照上次的单（${patient.prevDay.slice(5).replace("-", "月")}日）`}
                        </button>
                      ) : null}
                      {expanded ? (
                        <div className="check-list">
                          {extra.map((condition) => (
                            <label key={condition.id} className="check-row">
                              <input
                                type="checkbox"
                                checked={checked.includes(condition.id)}
                                onChange={() => toggleCondition(condition.id)}
                              />
                              <span>{condition.name}</span>
                            </label>
                          ))}
                          <button type="button" className="primary" onClick={() => joinSelected(patient)}>
                            加入今天
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </section>
          </div>
        </div>,
          document.body,
        )
        : null}
      {settings
        ? createPortal(
            <div className="sheet-back" onClick={() => setSettings(false)}>
              <div
                className="sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="settings-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="sheet-handle" />
                <h2 id="settings-title">设置</h2>
                <p className="muted">关掉标签后仍会记住这台手机绑定的名字。</p>
                <p className="error sheet-error">{error}</p>
                <h3>我是谁</h3>
                <div className="patient-list">
                  {snap.staff?.map((person) => (
                    <button
                      key={person.id}
                      type="button"
                      className={snap.me?.id === person.id ? "row-btn patient-row is-me" : "row-btn patient-row"}
                      onClick={() =>
                        run(async () => {
                          await api.claim({ staffId: person.id })
                          await onRefresh()
                          setSettings(false)
                        })
                      }
                    >
                      <span className="patient-name">{person.name}</span>
                    </button>
                  ))}
                </div>
                {templates.length ? (
                  <>
                    <h3>病症模板</h3>
                    <div className="patient-list">
                      {templates.map((template) => (
                        <div key={template.id} className="row-btn patient-row today-template-row">
                          <span className="patient-name">{template.name}</span>
                          <span className="patient-conds">{`${template.itemCount} 项`}</span>
                          <button
                            type="button"
                            className="today-gear"
                            disabled={pending}
                            onClick={() =>
                              run(async () => {
                                await api.deleteTemplate(template.id)
                                await onRefresh()
                              })
                            }
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </main>
  )
}

function usePullToRefresh({ enabled, onRefresh, onSuccess, onFail }) {
  const ref = useRef(null)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const enabledRef = useRef(enabled)
  const onRefreshRef = useRef(onRefresh)
  const onSuccessRef = useRef(onSuccess)
  const onFailRef = useRef(onFail)
  enabledRef.current = enabled
  onRefreshRef.current = onRefresh
  onSuccessRef.current = onSuccess
  onFailRef.current = onFail

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    let startY = 0
    let distance = 0
    let tracking = false
    let fromTouch = false
    let busy = false

    function nearTop() {
      return el.scrollTop <= 4
    }

    function begin(y) {
      tracking = false
      distance = 0
      if (busy || !enabledRef.current || !nearTop()) return
      startY = y
      tracking = true
    }

    function update(y, event) {
      if (!tracking) return
      if (!nearTop()) {
        tracking = false
        distance = 0
        setPull(0)
        return
      }
      const dy = y - startY
      if (dy > 10) {
        if (event?.cancelable) event.preventDefault()
        distance = dy
        setPull(dy)
        return
      }
      distance = dy > 0 ? dy : 0
      setPull(0)
    }

    function finish(commit) {
      if (!tracking) return
      tracking = false
      const should = commit && nearTop() && distance > 56
      distance = 0
      if (!should) {
        setPull(0)
        return
      }
      busy = true
      setRefreshing(true)
      setPull(PULL_ARM)
      Promise.resolve()
        .then(() => onRefreshRef.current())
        .then(() => onSuccessRef.current())
        .catch((err) => onFailRef.current(err))
        .finally(() => {
          busy = false
          setRefreshing(false)
          setPull(0)
        })
    }

    function onTouchStart(event) {
      fromTouch = true
      if (event.touches.length !== 1) {
        tracking = false
        distance = 0
        setPull(0)
        return
      }
      begin(event.touches[0].clientY)
    }

    function onTouchMove(event) {
      if (event.touches.length !== 1) return
      update(event.touches[0].clientY, event)
    }

    function onTouchEnd() {
      finish(true)
      window.setTimeout(() => {
        fromTouch = false
      }, 700)
    }

    function onMouseDown(event) {
      if (fromTouch || event.button !== 0) return
      begin(event.clientY)
    }

    function onMouseMove(event) {
      if (fromTouch || !tracking) return
      update(event.clientY)
    }

    function onTouchCancel() {
      finish(false)
    }

    function onMouseUp() {
      finish(true)
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true })
    el.addEventListener("touchmove", onTouchMove, { passive: false })
    el.addEventListener("touchend", onTouchEnd)
    el.addEventListener("touchcancel", onTouchCancel)
    el.addEventListener("mousedown", onMouseDown)
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)

    return () => {
      tracking = false
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("touchend", onTouchEnd)
      el.removeEventListener("touchcancel", onTouchCancel)
      el.removeEventListener("mousedown", onMouseDown)
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    }
  }, [])

  return { ref, pull, refreshing }
}
