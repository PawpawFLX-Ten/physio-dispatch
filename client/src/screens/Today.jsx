import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../api.js"
import { matchesInitials } from "../pinyin.js"
import { SettingsSheet } from "./SettingsSheet.jsx"
import { PULL_LIMIT, usePullToRefresh } from "../hooks/usePullToRefresh.js"
import { useBackLayer } from "../back-layer.js"
import "./today.css"

export function Today({ snap, live, changedBy, onRefresh, onSnap, onOpen }) {
  const today = snap.today || []
  const patients = snap.patients || []
  const activePatients = useMemo(() => patients.filter((patient) => !patient.archived), [patients])
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
  const [equipmentView, setEquipmentView] = useState(false)
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
    onSuccess: () => {
      setBanner("")
      setError("")
    },
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
  const byEquipment = snap.todayByEquipment || []
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

  // 有新活派给自己就震一下（第一次加载不震）。单人治疗室所有项都算自己的，
  // 自己刚加的项不该震，只有多人才提醒。
  const multi = snap.solo !== true
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
      if (typeof navigator.vibrate === "function") {
        navigator.vibrate(60)
      } else {
        // iOS / 微信里没有震动：亮一条短横幅兜底，几秒后自己收掉。
        setBanner(`有新活派给你，共 ${mineCount} 项`)
        window.setTimeout(() => setBanner(""), 4000)
      }
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
        // 409 多半是两台手机同时动了同一张单：重拉一遍，这项还开着、还归自己就自动再试一次，
        // 最高频的动作不该被冲突打断。重拉或重试都不成才把错误亮出来。
        try {
          const fresh = await api.entry(entry.id)
          const item = fresh.entry?.items?.find((row) => row.id === entry.mineNextId)
          if (item && !item.done && (!multi || item.assigneeId === snap.me?.id)) {
            const next = await api.patchItem(entry.id, entry.mineNextId, { done: true }, fresh.entry?.version)
            onSnap(next)
            return
          }
        } catch {
          /* 重拉也失败：按原来的错误报 */
        }
        await onRefresh().catch(() => {})
        setError(err instanceof Error ? err.message : "未能保存")
      })
      .finally(() => setBusyEntryId(null))
  }


  const shown = Math.min(pull, PULL_LIMIT)
  const hint = refreshing ? "正在刷新" : pull > 56 ? "松开刷新" : "下拉刷新"
  const who = [snap.date, snap.me?.name].filter(Boolean).join(" · ")
  const mineCount = today.reduce((sum, entry) => sum + (entry.mineTotal || 0) - (entry.mineDone || 0), 0)
  const staffCount = snap.staff?.length || 0

  // 四个视图只能亮一个：每次切换都明确关掉另外两个，避免出现“全部 + 按设备”同时选中。
  function selectTodayView(nextView) {
    setMineOnly(nextView === "mine")
    setStaffView(nextView === "staff")
    setEquipmentView(nextView === "equipment")
  }

  function lastDayLabel(patient) {
    if (!patient.lastDay) return ""
    if (patient.lastDay === snap.date) return "今天来过"
    return `上次 ${patient.lastDay.slice(5).replace("-", "月")}日`
  }

  // 完成时刻只看时分：交班单上「完于 14:05」比完整时间戳好读。
  function timeLabel(iso) {
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) return ""
    return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
  }

  // 微信内置浏览器调不起系统打印：别放一个点了没反应的按钮。
  const canPrint = !/MicroMessenger/i.test(navigator.userAgent)

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
                    {row.lastDoneAt ? `完于 ${timeLabel(row.lastDoneAt)}` : ""}
                    {row.done < row.total ? " □ 未完" : ""}
                    {row.note ? ` ⚠ ${row.note}` : ""}
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
            {canPrint ? (
              <button type="button" className="today-gear" onClick={() => window.print()}>
                打印
              </button>
            ) : null}
            <button type="button" className="today-gear" onClick={() => setSettings(true)}>
              设置
            </button>
          </span>
        </p>
        {banner ? <p className="error">{banner}</p> : null}
        {/* 弹层都关着时，行内完成这类主界面上的失败也要看得见：不能只弹回按钮。 */}
        {error && !open && !settings ? (
          <p className="error today-error" role="alert">{error}</p>
        ) : null}
        {live === false ? (
          <p className="today-offline" role="status">连接断了，正在重连…恢复后自动刷新</p>
        ) : null}
        {changedBy ? <p className="today-changedby" role="status">{`${changedBy} 刚改过，已更新`}</p> : null}
        {/* 单人治疗室仍需要「按设备」入口，但没有派工语义，所以只保留「全部」和「按设备」。 */}
        <div className="today-tabs" role="tablist" aria-label="今日单视图">
          <button
            type="button"
            role="tab"
            aria-selected={!mineOnly && !staffView && !equipmentView}
            className={!mineOnly && !staffView && !equipmentView ? "today-tab is-on" : "today-tab"}
            onClick={() => selectTodayView("all")}
          >
            全部
          </button>
          {staffCount > 1 ? (
            <>
              <button
                type="button"
                role="tab"
                aria-selected={mineOnly}
                className={mineOnly ? "today-tab is-on" : "today-tab"}
                onClick={() => selectTodayView("mine")}
              >
                派给我的{mineCount ? ` ${mineCount}` : ""}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={staffView}
                className={staffView ? "today-tab is-on" : "today-tab"}
                onClick={() => selectTodayView("staff")}
              >
                按人
              </button>
            </>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={equipmentView}
            className={equipmentView ? "today-tab is-on" : "today-tab"}
            onClick={() => selectTodayView("equipment")}
          >
            按设备
          </button>
        </div>
      </header>
      <div className="today-scroll" ref={scrollRef}>
        <div className="pull-label" style={{ height: shown }} aria-live="polite">
          {shown > 0 ? hint : ""}
        </div>
        <div className="today-shift" style={shown ? { transform: `translateY(${shown}px)` } : undefined}>
          {equipmentView ? (
            byEquipment.length === 0 ? (
              <p className="today-empty">今天还没有设备任务</p>
            ) : (
              byEquipment.map((group) => {
                const tasks = Array.isArray(group.items) ? group.items : group.tasks || []
                const done = Number.isFinite(group.doneCount)
                  ? group.doneCount
                  : Number.isFinite(group.done)
                    ? group.done
                    : tasks.filter((task) => task.done).length
                const total = Number.isFinite(group.total) ? group.total : tasks.length
                const baseTitle =
                  group.name ||
                  [group.equipmentTypeName, group.equipmentUnitName].filter(Boolean).join(" · ") ||
                  "器械"
                // 正常契约里 name 已含机台；若服务端只给类型名，再补上 unit，避免设备重名。
                const title = group.equipmentUnitName && !baseTitle.includes(group.equipmentUnitName)
                  ? `${baseTitle} · ${group.equipmentUnitName}`
                  : baseTitle
                return (
                  <section key={group.key || group.equipmentUnitId || group.equipmentTypeId} className="today-group today-equipment-group">
                    <h2 className="today-group-title today-equipment-title">
                      <span className="today-equipment-group-name">{title}</span>
                      <span className="today-equipment-meta">
                        {group.shared ? <span className="today-equipment-shared">共享</span> : null}
                        <span className="today-group-count">{`${done}/${total}`}</span>
                      </span>
                    </h2>
                    <div className="today-list today-equipment-list">
                      {tasks.map((task) => (
                        <button
                          key={task.itemId || `${task.entryId}-${task.order}`}
                          type="button"
                          className="row-btn today-equipment-task"
                          onClick={() => onOpen(task.entryId)}
                        >
                          <span className="today-equipment-order" aria-label={`顺序 ${task.order}`}>
                            {task.order ?? "·"}
                          </span>
                          <span className="today-equipment-body">
                            <span className="today-equipment-patient">{task.patientName}</span>
                            {task.targetTitle ? <span className="today-equipment-target">{task.targetTitle}</span> : null}
                            <span className="today-equipment-summary">{task.equipmentSummary || title}</span>
                            {task.linkedTargetTitles?.length ? (
                              <span className="today-equipment-linked">{task.linkedTargetTitles.join("、")}</span>
                            ) : null}
                          </span>
                          <span className="today-equipment-status">
                            <span className={task.assigneeName ? "today-equipment-assignee" : "today-equipment-assignee is-unassigned"}>
                              {task.assigneeName || "未派"}
                            </span>
                            <span className={task.done ? "today-equipment-state is-done" : "today-equipment-state"}>
                              {task.done ? "已完成" : "未完成"}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                )
              })
            )
          ) : staffView ? (
            byStaff.length === 0 ? (
              <p className="today-empty">今天还没有病人</p>
            ) : (
              byStaff.map((group) => (
                <section key={group.staffId || "none"} className="today-group">
                  <h2 className="today-group-title">
                    {group.name}
                    <span className="today-group-count">
                      {`${group.done}/${group.total}`}
                      {group.minutes ? ` · 剩约${group.minutes}分钟` : ""}
                    </span>
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
              {!equipmentView && !staffView && today.length >= 8 ? (
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
                    {entry.visitCount > 1 ? <span className="today-visit">{`第${entry.visitCount}次来`}</span> : null}
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
      {settings ? (
        <SettingsSheet
          snap={snap}
          pending={pending}
          error={error}
          run={run}
          onRefresh={onRefresh}
          onClose={() => setSettings(false)}
        />
      ) : null}
    </main>
  )
}