import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../api.js"
import { TARGETS, allowsWork, targetById } from "@shared/catalog.js"
import { CHIEF_SITES, DEFAULT_PAIRINGS } from "@shared/pairings.js"
import { matchesInitials } from "../pinyin.js"
import { PairingChips } from "../PairingChips.jsx"
import { useBackLayer } from "../back-layer.js"
import "./today.css"

const PULL_LIMIT = 88
const PULL_ARM = 64

export function Today({ snap, onRefresh, onSnap, onOpen }) {
  const today = snap.today || []
  const patients = snap.patients || []
  const activePatients = useMemo(() => patients.filter((patient) => !patient.archived), [patients])
  const archivedPatients = useMemo(() => patients.filter((patient) => patient.archived), [patients])
  const templates = snap.templates || []
  const [open, setOpen] = useState(false)
  const [banner, setBanner] = useState("")
  const [error, setError] = useState("")
  const [name, setName] = useState("")
  const [conditionName, setConditionName] = useState("")
  const [activeId, setActiveId] = useState(null)
  const [checked, setChecked] = useState([])
  const [settings, setSettings] = useState(false)
  const [newStaffName, setNewStaffName] = useState("")
  const [mineOnly, setMineOnly] = useState(false)
  const [staffView, setStaffView] = useState(false)
  const prevMineCount = useRef(null)
  const [query, setQuery] = useState("")
  const [templatePick, setTemplatePick] = useState(null)
  const [templateName, setTemplateName] = useState("")
  // 常见搭配编辑器：draft 为 null 是收起状态；site 是正在编辑的部位页签。
  const [pairingDraft, setPairingDraft] = useState(null)
  const [pairingSite, setPairingSite] = useState(CHIEF_SITES[0])
  const [pairingQuery, setPairingQuery] = useState("")
  const importRef = useRef(null)
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
        onOpen(result.entry.id, result)
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

  const trimmedQuery = query.trim()
  const shownPatients = useMemo(() => {
    if (!trimmedQuery) return activePatients
    return activePatients.filter(
      (patient) =>
        matchesInitials(trimmedQuery, patient.name) ||
        (patient.conditions || []).some((condition) => matchesInitials(trimmedQuery, condition.name)),
    )
  }, [activePatients, trimmedQuery])

  // 重名提醒看全部档案（含已归档），避免建出两个同名。
  const sameName = name.trim() ? patients.find((patient) => patient.name === name.trim()) : null
  const shownToday = mineOnly ? today.filter((entry) => (entry.mineTotal || 0) > 0) : today
  const byStaff = snap.todayByStaff || []
  // 病人多时今日单也能搜（和加入病人一个习惯：汉字/拼音首字母都行），人少时不占地方。
  const [todayQuery, setTodayQuery] = useState("")
  const filteredToday = useMemo(() => {
    const q = todayQuery.trim()
    if (!q) return shownToday
    return shownToday.filter(
      (entry) =>
        matchesInitials(q, entry.patientName) ||
        (entry.conditionNames || []).some((conditionName) => matchesInitials(q, conditionName)),
    )
  }, [shownToday, todayQuery])

  function downloadExport(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `clinic-${snap.date || "backup"}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  function onImportFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (
      !window.confirm(
        "导入会替换本机治疗室的全部数据（病人、今日单、模板）。确定继续？",
      )
    ) {
      return
    }
    run(async () => {
      const text = await file.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error("这个文件不是有效的 JSON")
      }
      await api.importClinic(data)
      await onRefresh()
      setSettings(false)
    })
  }

  // 有新活派给自己就震一下（第一次加载不震）。单人治疗室所有项都算自己的，
  // 自己刚加的项不该震，只有多人才提醒。
  const multi = (snap.staff?.length || 0) > 1
  useEffect(() => {
    if (!multi) {
      prevMineCount.current = null
      return
    }
    const mineCount = today.reduce(
      (sum, entry) => sum + (entry.mineTotal || 0) - (entry.mineDone || 0),
      0,
    )
    if (prevMineCount.current != null && mineCount > prevMineCount.current) {
      navigator.vibrate?.(60)
    }
    prevMineCount.current = mineCount
  }, [today, multi])

  function joinSelected(patient) {
    const allowed = extraConditions(patient).map((condition) => condition.id)
    const ids = checked.filter((id) => allowed.includes(id))
    if (!ids.length) {
      setError("请勾选病症")
      return
    }
    run(async () => {
      const result = await api.addExisting(patient.id, ids)
      onOpen(result.entry.id, result)
    })
  }

  function repeatLast(patient) {
    run(async () => {
      const result = await api.repeatLastDay(patient.id)
      setOpen(false)
      onOpen(result.entry.id, result)
    })
  }

  function carryUnfinished(patient) {
    run(async () => {
      const result = await api.carryUnfinished(patient.id)
      setOpen(false)
      onOpen(result.entry.id, result)
    })
  }

  // 行内完成：只锁正在做的那一行（别的行照常点），返回值就是最新视图，不再重拉一遍。
  const [busyEntryId, setBusyEntryId] = useState(null)
  function completeMine(entry) {
    if (!entry.mineNextId || busyEntryId) return
    setBusyEntryId(entry.id)
    setError("")
    Promise.resolve(api.patchItem(entry.id, entry.mineNextId, { done: true }, entry.version))
      .then((next) => {
        onSnap(next)
      })
      .catch(async (err) => {
        await onRefresh().catch(() => {})
        setError(err instanceof Error ? err.message : "未能保存")
      })
      .finally(() => setBusyEntryId(null))
  }

  const exportAgeDays = (() => {
    if (!snap.lastExportAt) return null
    const at = Date.parse(snap.lastExportAt)
    if (!Number.isFinite(at)) return null
    return Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000))
  })()
  const clinicUrl = typeof window !== "undefined" ? window.location.origin : ""

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
        {/* 名单只有一个人时收起派工标签：没有「派给我的」「按人」，整栏都不要。 */}
        {(snap.staff?.length || 0) > 1 ? (
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
        ) : null}
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
          ) : filteredToday.length === 0 ? (
            <p className="today-empty">
              {todayQuery.trim() ? "没搜到这位病人" : mineOnly ? "还没有派给你的项" : "今天还没有病人"}
            </p>
          ) : (
            <div className="today-list">
              {!staffView && today.length >= 8 ? (
                <input
                  className="today-search today-filter"
                  type="search"
                  value={todayQuery}
                  placeholder="搜今天的病人，可输拼音首字母"
                  aria-label="搜今天的病人"
                  onChange={(event) => setTodayQuery(event.target.value)}
                />
              ) : null}
              {filteredToday.map((entry) => {
                // 单人治疗室没有「派给我的」标签：行内完成直接开在名单行上。
                const inline = mineOnly || !multi
                const showComplete = inline && entry.mineNextId
                return (
                <div key={entry.id} className={showComplete ? "today-row-wrap" : undefined}>
                  <button
                    type="button"
                    className="row-btn today-row"
                    onClick={() => onOpen(todayByPatient.get(entry.patientId)?.id || entry.id)}
                  >
                    <span className="today-name">{entry.patientName}</span>
                    {entry.note ? <span className="today-note">{`⚠ ${entry.note}`}</span> : null}
                    {entry.conditionNames?.length ? (
                      <span className="today-conditions">{entry.conditionNames.join("、")}</span>
                    ) : null}
                    {showComplete && entry.mineNextName ? (
                      <span className="today-conditions">{`当前：${entry.mineNextName}`}</span>
                    ) : null}
                    <span className="today-count">
                      {inline ? `${entry.mineDone}/${entry.mineTotal}` : `${entry.doneCount}/${entry.total}`}
                    </span>
                  </button>
                  {showComplete ? (
                    <button
                      type="button"
                      className="today-complete"
                      disabled={busyEntryId === entry.id}
                      onClick={() => completeMine(entry)}
                    >
                      完成
                    </button>
                  ) : null}
                </div>
                )
              })}
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
            {/* 老病人是最常见的进法：搜索放在最上面、自动聚焦，打开就能打字。 */}
            <section className="sheet-existing">
              <h3>已有病人</h3>
              {activePatients.length ? (
                <input
                  className="today-search"
                  type="search"
                  value={query}
                  placeholder="搜名字或病症，可输拼音首字母"
                  aria-label="搜病人"
                  autoFocus
                  onChange={(event) => setQuery(event.target.value)}
                />
              ) : (
                <p className="muted">还没有病人档案，从下面的新病人开始。</p>
              )}
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
                      {patient.hasUnfinishedPrev && patient.prevDay && !todayByPatient.has(patient.id) ? (
                        <button
                          type="button"
                          className="today-repeat"
                          disabled={pending}
                          onClick={() => carryUnfinished(patient)}
                        >
                          {`把昨天未完成接进今天（${patient.prevDay.slice(5).replace("-", "月")}日）`}
                        </button>
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
            <form
              className="stack"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                run(async () => {
                  const result = await api.createPatient(name, conditionName)
                  onOpen(result.entry.id, result)
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
                  autoFocus={!activePatients.length}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {sameName ? (
                <div className="today-same-name">
                  <p className="error">{`已有叫${sameName.name}的病人`}</p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => choosePatient(sameName)}
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
                            onOpen(result.entry.id, result)
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
                {clinicUrl ? (
                  <>
                    <h3>本机地址</h3>
                    <p className="muted">{clinicUrl}</p>
                    <p className="muted">同一 Wi‑Fi 的手机用这个地址打开（以终端打印的局域网 IP 为准）。</p>
                  </>
                ) : null}
                <h3>备份</h3>
                <div className="today-template-buttons">
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        const data = await api.exportClinic()
                        downloadExport(data)
                        await onRefresh()
                      })
                    }
                  >
                    导出
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending}
                    onClick={() => importRef.current?.click()}
                  >
                    导入
                  </button>
                  <input
                    ref={importRef}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={onImportFile}
                  />
                </div>
                <p className="muted">
                  {snap.lastExportAt
                    ? `上次导出：${new Date(snap.lastExportAt).toLocaleString("zh-CN", { hour12: false })}`
                    : "还没有导出过，建议每周拷一份到 U 盘或网盘。"}
                </p>
                {exportAgeDays != null && exportAgeDays >= 7 ? (
                  <p className="error">已经超过 7 天没导出，建议现在拷一份机外备份。</p>
                ) : null}
                <p className="muted">导出会下载完整 JSON；导入会替换本机全部数据，请先确认。</p>
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
                {/* 单人时新手机会被自动认领：想加第二个名字，从这里进来。 */}
                <form
                  className="stack gate-form"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault()
                    run(async () => {
                      await api.claim({ staffName: newStaffName })
                      setNewStaffName("")
                      await onRefresh()
                      setSettings(false)
                    })
                  }}
                >
                  <label className="field">
                    新名字
                    <input
                      value={newStaffName}
                      autoComplete="off"
                      enterKeyHint="done"
                      onChange={(event) => setNewStaffName(event.target.value)}
                    />
                  </label>
                  <button className="secondary" type="submit" disabled={pending || !newStaffName.trim()}>
                    加名字并切换
                  </button>
                </form>
                <h3>常见搭配</h3>
                {pairingDraft ? (
                  <>
                    <p className="muted">
                      预览就是加项面板里那一排的样子。下面的芯片点一下去掉、再下面搜到点一下加入，改完记得保存。
                    </p>
                    <div className="pairing-sites">
                      {CHIEF_SITES.map((site) => (
                        <button
                          key={site}
                          type="button"
                          className={site === pairingSite ? "pairing-site is-on" : "pairing-site"}
                          onClick={() => {
                            setPairingSite(site)
                            setPairingQuery("")
                          }}
                        >
                          {targetById(site)?.name || site}
                        </button>
                      ))}
                    </div>
                    <p className="patient-label">预览</p>
                    {pairingDraft[pairingSite]?.length ? (
                      <PairingChips ids={pairingDraft[pairingSite]} />
                    ) : (
                      <p className="muted">这个部位不显示搭配。</p>
                    )}
                    <p className="patient-label">当前搭配 · 点一下去掉</p>
                    <PairingChips
                      ids={pairingDraft[pairingSite]}
                      disabled={pending}
                      onPick={(targetId) => {
                        setPairingDraft((draft) => ({
                          ...draft,
                          [pairingSite]: draft[pairingSite].filter((item) => item !== targetId),
                        }))
                      }}
                    />
                    <input
                      className="patient-search"
                      type="search"
                      value={pairingQuery}
                      placeholder="搜肌肉加入，可输拼音首字母"
                      aria-label="搜肌肉加入搭配"
                      onChange={(event) => setPairingQuery(event.target.value)}
                    />
                    {(() => {
                      const current = new Set(pairingDraft[pairingSite])
                      const ids = TARGETS.filter(
                        (target) =>
                          allowsWork(target) &&
                          !current.has(target.id) &&
                          matchesInitials(pairingQuery, target.name),
                      )
                        .slice(0, 30)
                        .map((target) => target.id)
                      return (
                        <PairingChips
                          ids={ids}
                          disabled={pending}
                          onPick={(targetId) => {
                            setPairingDraft((draft) => ({
                              ...draft,
                              [pairingSite]: [...draft[pairingSite], targetId].slice(0, 12),
                            }))
                          }}
                        />
                      )
                    })()}
                    <div className="today-template-buttons">
                      <button
                        type="button"
                        className="primary"
                        disabled={pending}
                        onClick={() =>
                          run(async () => {
                            await api.savePairings(pairingDraft)
                            setPairingDraft(null)
                            await onRefresh()
                          })
                        }
                      >
                        保存搭配
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={pending}
                        onClick={() => setPairingDraft(structuredClone(DEFAULT_PAIRINGS))}
                      >
                        恢复默认
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={pending}
                        onClick={() => setPairingDraft(null)}
                      >
                        收起
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="muted">
                      要治的地方定了以后，加项面板会亮出一排这个部位常用的肌肉，点一下就加项。
                    </p>
                    <div className="today-template-buttons">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setPairingDraft(structuredClone(snap.pairings || DEFAULT_PAIRINGS))
                          setPairingQuery("")
                        }}
                      >
                        改搭配
                      </button>
                    </div>
                  </>
                )}
                {archivedPatients.length ? (
                  <>
                    <h3>已归档病人</h3>
                    <p className="muted">归档后不会出现在「加入已有病人」里，历史和今日单上的条目仍保留。</p>
                    <div className="patient-list">
                      {archivedPatients.map((patient) => (
                        <div key={patient.id} className="row-btn patient-row today-template-row">
                          <span className="patient-name">{patient.name}</span>
                          <button
                            type="button"
                            className="today-gear"
                            disabled={pending}
                            onClick={() =>
                              run(async () => {
                                await api.setPatientArchived(patient.id, false)
                                await onRefresh()
                              })
                            }
                          >
                            取消归档
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
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
                            onClick={() => {
                              if (!window.confirm(`删除模板「${template.name}」？确认后才会删掉。`)) return
                              run(async () => {
                                await api.deleteTemplate(template.id)
                                await onRefresh()
                              })
                            }}
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
