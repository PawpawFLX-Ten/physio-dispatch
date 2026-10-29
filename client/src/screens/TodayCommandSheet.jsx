import { useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { doseLabel, targetTitle, techniqueLabel } from "@shared/catalog.js"
import { parseQuickOrder } from "@shared/quick-order.js"
import { api } from "../api.js"
import { matchesInitials } from "../pinyin.js"
import { equipmentItemSummary, isEquipmentItem, normalizeQuickOrderSides } from "./patient/helpers.js"

function readableError(err) {
  return err instanceof Error ? err.message : "未能吩咐"
}

// 今日单的全局吩咐：今天已有或尚未加入的病人可选；未加入的先加入，再说一句。
export function TodayCommandSheet({ snap, onClose, onSnap, onDone }) {
  const [query, setQuery] = useState("")
  const [entryView, setEntryView] = useState(null)
  const [text, setText] = useState("")
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [addedNotice, setAddedNotice] = useState("")
  const [addedToday, setAddedToday] = useState(false)
  const todayEntries = useMemo(() => snap.today || [], [snap.today])
  const patients = useMemo(() => snap.patients || [], [snap.patients])
  const patientsById = useMemo(() => new Map(patients.map((patient) => [patient.id, patient])), [patients])
  const todayByPatient = useMemo(() => {
    const map = new Map()
    for (const entry of todayEntries) {
      if (entry.patientId && !map.has(entry.patientId)) map.set(entry.patientId, entry)
    }
    return map
  }, [todayEntries])
  const commandPatients = useMemo(() => {
    const rows = []
    const seeToday = new Set(todayByPatient.keys())
    const conditionsOf = (patient) => (patient?.conditions || []).map((condition) => condition.name).filter(Boolean)
    // 今天在单上的病人先列，即使档案列表里暂时找不到也要可点。
    for (const [patientId, entry] of todayByPatient) {
      const patient = patientsById.get(patientId)
      const conditionNames = [...new Set([...conditionsOf(patient), ...(entry.conditionNames || [])])]
      rows.push({
        patientId,
        entryId: entry.id,
        name: entry.patientName || patient?.name || "病人",
        conditions: conditionNames,
        lastDay: patient?.lastDay || null,
        inToday: true,
      })
    }
    // 其余全部未归档档案按最近来过、再按姓名排；今天的人已经在上面优先展示。
    const others = patients
      .filter((patient) => !patient.archived && !seeToday.has(patient.id))
      .map((patient) => ({
        patientId: patient.id,
        entryId: null,
        name: patient.name,
        conditions: conditionsOf(patient),
        lastDay: patient.lastDay || null,
        inToday: false,
      }))
      .sort((left, right) => {
        if (Boolean(left.lastDay) !== Boolean(right.lastDay)) return left.lastDay ? -1 : 1
        if (left.lastDay && right.lastDay && left.lastDay !== right.lastDay) {
          return left.lastDay < right.lastDay ? 1 : -1
        }
        return left.name.localeCompare(right.name, "zh-Hans-CN")
      })
    return [...rows, ...others]
  }, [todayByPatient, patientsById, patients])
  const entry = entryView?.entry || null
  const staff = entryView?.staff || snap.staff || []
  const equipmentTypes = entryView?.equipmentTypes || snap.equipmentTypes || []
  const exerciseTemplates = entryView?.exerciseTemplates || snap.exerciseTemplates || []
  const filteredPatients = useMemo(() => {
    const q = query.trim()
    if (!q) return commandPatients
    return commandPatients.filter(
      (row) =>
        matchesInitials(q, row.name) ||
        row.conditions.some((conditionName) => matchesInitials(q, conditionName)),
    )
  }, [commandPatients, query])
  const parsed = normalizeQuickOrderSides(
    parseQuickOrder(text, { staff, equipment: equipmentTypes }),
    { chiefSide: entry?.chiefSide, chiefSiteId: entry?.chiefSiteId },
  )
  const hasSomething = Boolean(parsed.chief) || parsed.items.length > 0
  const previewAssignee =
    parsed.assigneeName || staff.find((person) => person.id === parsed.assigneeId)?.name || ""

  async function pickPatient(row) {
    if (loading) return
    setLoading(true)
    setError("")
    setAddedNotice("")
    setAddedToday(false)
    setEntryView(null)
    setText("")
    try {
      if (row.inToday) {
        const next = await api.entry(row.entryId)
        if (!next?.entry) throw new Error("没有读到这张单")
        setEntryView(next)
        return
      }
      const result = await api.addExisting(row.patientId)
      if (!result?.entry) throw new Error("病人已加入，但没有读到今日单")
      setEntryView(result)
      setAddedToday(true)
      setAddedNotice("已加入今日单，继续吩咐（关闭不会撤销加入）")
      onSnap(result)
    } catch (err) {
      setError(readableError(err))
    } finally {
      setLoading(false)
    }
  }

  async function submit(event) {
    event.preventDefault()
    if (pending) return
    if (!hasSomething) {
      setError("没听清，再说一句")
      return
    }
    if (parsed.items.length && !parsed.chief && !entry?.chiefSiteId) {
      setError("这张单还没有定要治的位置，请先回今日单处理")
      return
    }
    setPending(true)
    setError("")
    try {
      const result = await api.quickAdd(entry.id, {
        chief: parsed.chief || null,
        items: parsed.items,
        assigneeId: parsed.assigneeId || null,
      })
      onSnap(result)
      onDone(parsed.items.length, { addedToday })
    } catch (err) {
      setError(readableError(err))
    } finally {
      setPending(false)
    }
  }

  return createPortal(
    <div className="sheet-back" onClick={onClose} role="presentation">
      <div
        className="sheet today-command-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="today-command-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="today-command-heading">
          <div>
            <h2 id="today-command-title">吩咐</h2>
            <p className="today-command-hint">搜病人（今天未加入的会先加入今天）；也可以选今天已在单上的病人，再说一句。</p>
          </div>
          <button type="button" className="today-gear" onClick={onClose}>收起</button>
        </div>
        {error ? <p className="error today-command-error" role="alert">{error}</p> : null}
        {addedNotice ? <p className="today-command-added-notice" role="status">{addedNotice}</p> : null}
        {entry ? (
          <>
            <div className="today-command-selected">
              <div>
                <strong>{entry.patientName}</strong>
                <p>{entry.chiefSiteId ? `要治 ${targetTitle(entry.chiefSiteId, entry.chiefSide)}` : "还没定要治的位置"}</p>
              </div>
              <button
                type="button"
                className="secondary today-command-change"
                onClick={() => {
                  setEntryView(null)
                  setText("")
                  setError("")
                  setAddedNotice("")
                  setAddedToday(false)
                }}
              >
                换病人
              </button>
            </div>
            <form className="today-command-form" onSubmit={submit}>
              <input
                className="today-search today-command-input"
                type="text"
                value={text}
                placeholder="比如：左膝 股四头肌超声8分钟 给小李"
                aria-label="输入吩咐"
                autoFocus
                autoComplete="off"
                enterKeyHint="done"
                onChange={(event) => setText(event.target.value)}
              />
              {text.trim() ? (
                <div className="today-command-preview">
                  {parsed.chief ? (
                    <p className="today-command-chief">{`要治 ${targetTitle(parsed.chief.targetId, parsed.chief.side)}`}</p>
                  ) : null}
                  <p className={previewAssignee ? "today-command-assignee" : "today-command-assignee is-default"}>
                    {previewAssignee ? `派给 ${previewAssignee}` : "派给：默认当前操作者"}
                  </p>
                  {parsed.items.length ? (
                    <ol className="today-command-items">
                      {parsed.items.map((item, index) => {
                        const equipment = isEquipmentItem(item)
                        const detail = equipment
                          ? equipmentItemSummary(item, equipmentTypes, exerciseTemplates)
                          : techniqueLabel(item.technique)
                        const equipmentDose = equipment && (item.dose?.sets || item.dose?.reps)
                          ? doseLabel("equipment", item.dose)
                          : ""
                        const dose = equipment ? equipmentDose : doseLabel(item.technique, item.dose)
                        return (
                          <li key={`${item.targetId}:${item.side || ""}:${index}`}>
                            {[targetTitle(item.targetId, item.side), detail, dose].filter(Boolean).join(" · ")}
                          </li>
                        )
                      })}
                    </ol>
                  ) : (
                    <p className="today-command-empty">还没认出下手项。</p>
                  )}
                  {parsed.unknown.length ? (
                    <p className="today-command-unknown">
                      {`没认出来：${parsed.unknown.join("、")}${hasSomething ? "（仍可先吩咐已识别项）" : "（再补一个能认出的动作）"}`}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="today-command-example">可以带左右、设备、时长和「给小李」。</p>
              )}
              <button className="primary today-command-submit" type="submit" disabled={pending || !hasSomething}>
                {pending ? "正在吩咐…" : parsed.items.length ? `吩咐 ${parsed.items.length} 项` : "只记要治的位置"}
              </button>
            </form>
          </>
        ) : loading ? (
          <p className="today-command-loading">正在读取病人单…</p>
        ) : (
          <>
            <input
              className="today-search today-command-search"
              type="search"
              value={query}
              placeholder="搜病人（今天未加入的会先加入今天）"
              aria-label="搜病人（今天未加入的会先加入今天）"
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="today-command-patients">
              {filteredPatients.length ? filteredPatients.map((row) => (
                <button
                  key={row.patientId}
                  type="button"
                  className="row-btn today-command-patient"
                  onClick={() => pickPatient(row)}
                >
                  <span className="today-command-patient-main">
                    <span className="today-command-patient-name">{row.name}</span>
                    <span className="today-command-patient-conditions">
                      {row.conditions.join("、") || "暂无病症"}
                    </span>
                  </span>
                  <span className={row.inToday ? "today-command-patient-state is-today" : "today-command-patient-state is-new"}>
                    {row.inToday ? "已在今天" : "未加入今天"}
                  </span>
                </button>
              )) : (
                <div className="today-command-empty">
                  <p>{commandPatients.length ? "没搜到这位病人。" : "还没有可吩咐的病人。"}</p>
                  <p className="today-command-empty-hint">搜病人（今天未加入的会先加入今天）</p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
