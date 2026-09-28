// 读侧：把 state 投影成各页面要的样子。
import { targetById, targetTitle } from "../shared/catalog.js"
import { fail, todayKey, workSignature } from "./helpers.js"

export const viewMethods = {
  view(deviceId) {
    const stage = this.stage(deviceId)
    const meId = this.device(deviceId)
    const base = {
      stage,
      staff: this.state.staff.map(({ id: staffId, name }) => ({ id: staffId, name })),
      me: this.state.staff.find((item) => item.id === meId) || null,
      date: todayKey(),
    }
    if (base.stage !== "ready") return base
    return {
      ...base,
      today: this.todayList(meId),
      todayByStaff: this.todayByStaff(),
      patients: this.patientList(),
      templates: this.templateList(),
    }
  },

  templateList() {
    return this.state.templates.map((template) => ({
      id: template.id,
      name: template.name,
      itemCount: template.items.length,
    }))
  },

  patientList() {
    const lastDays = this.patientLastDays()
    const prevDays = this.patientLastDays(true)
    return [...this.state.patients]
      .map((patient) => {
        let lastSummary = ""
        const prevDay = prevDays.get(patient.id)
        if (prevDay) {
          const entry = this.state.days[prevDay].entries.find((row) => row.patientId === patient.id)
          if (entry) {
            lastSummary = entry.items.map((item) => targetTitle(item.targetId, item.side || null)).join("、")
          }
        }
        return {
          id: patient.id,
          name: patient.name,
          archived: Boolean(patient.archived),
          conditions: patient.conditions.map((condition) => ({
            id: condition.id,
            name: condition.name,
            itemCount: condition.items.length,
            fresh: condition.fresh,
          })),
          lastDay: lastDays.get(patient.id) || null,
          prevDay: prevDay || null,
          lastSummary,
          note: patient.note || "",
        }
      })
      .sort((left, right) => {
        if (Boolean(left.lastDay) !== Boolean(right.lastDay)) return left.lastDay ? -1 : 1
        if (left.lastDay !== right.lastDay) return left.lastDay < right.lastDay ? 1 : -1
        return left.name.localeCompare(right.name, "zh-Hans-CN")
      })
  },

  // 来过几次：每次的日子、做了什么、完成几项，最近的排前面。
  visitHistory(patientId, limit = 12) {
    this.ensureDayIndex()
    const today = todayKey()
    const rows = []
    for (const { day, entryId } of this.byPatient.get(patientId) || []) {
      const entry = this.state.days[day]?.entries?.find((row) => row.id === entryId)
      if (!entry) continue
      rows.push({
        day,
        isToday: day === today,
        names: entry.items.map((item) => targetTitle(item.targetId, item.side || null)).join("、"),
        doneCount: entry.items.filter((item) => item.done).length,
        total: entry.items.length,
      })
    }
    return rows.sort((left, right) => (left.day < right.day ? 1 : -1)).slice(0, limit)
  },

  // 每个病人最近一次出现在哪天。excludeToday 时只看今天以前的，给「照上次的单」用。
  patientLastDays(excludeToday = false) {
    this.ensureDayIndex()
    const today = todayKey()
    const map = new Map()
    for (const [patientId, visits] of this.byPatient) {
      let best = null
      for (const visit of visits) {
        if (excludeToday && visit.day >= today) continue
        if (!best || visit.day > best) best = visit.day
      }
      if (best != null) map.set(patientId, best)
    }
    return map
  },

  day() {
    const key = todayKey()
    if (!this.state.days[key]) this.state.days[key] = { entries: [] }
    return this.state.days[key]
  },

  todayList(meId) {
    // 跳过「条目还在、病人没了」的孤儿，避免整间屋子 view() 打不开。
    return this.day()
      .entries.map((entry) => this.entrySummary(entry, meId))
      .filter(Boolean)
  },

  entrySummary(entry, meId) {
    const patient = this.state.patients.find((item) => item.id === entry.patientId)
    if (!patient) return null
    const done = entry.items.filter((item) => item.done).length
    const mine = meId ? entry.items.filter((item) => item.assigneeId === meId) : []
    return {
      id: entry.id,
      patientId: patient.id,
      patientName: patient.name,
      conditionIds: [...entry.conditionIds],
      conditionNames: entry.conditionIds.map((conditionId) => this.condition(patient, conditionId)?.name).filter(Boolean),
      doneCount: done,
      total: entry.items.length,
      mineTotal: mine.length,
      mineDone: mine.filter((item) => item.done).length,
      note: patient.note || "",
    }
  },

  // 主治一眼看谁手里多少活：按人分桶，未派的单独一桶。
  todayByStaff() {
    const groups = new Map()
    const bucketOf = (assigneeId) => {
      const person = assigneeId ? this.state.staff.find((row) => row.id === assigneeId) : null
      const key = person?.id || "none"
      if (!groups.has(key)) {
        groups.set(key, { staffId: person?.id || null, name: person?.name || "未派", done: 0, total: 0, patients: new Map() })
      }
      return groups.get(key)
    }
    for (const entry of this.day().entries) {
      const patient = this.state.patients.find((item) => item.id === entry.patientId)
      if (!patient) continue
      for (const item of entry.items) {
        const bucket = bucketOf(item.assigneeId)
        bucket.total += 1
        if (item.done) bucket.done += 1
        const row = bucket.patients.get(entry.patientId) || {
          entryId: entry.id,
          patientName: patient.name,
          note: patient.note || "",
          done: 0,
          total: 0,
        }
        row.total += 1
        if (item.done) row.done += 1
        bucket.patients.set(entry.patientId, row)
      }
    }
    const unassigned = groups.get("none")
    if (unassigned) groups.delete("none")
    const list = [...groups.values()]
    if (unassigned) list.push(unassigned)
    for (const group of list) group.patients = [...group.patients.values()]
    return list
  },

  patient(patientId) {
    const patient = this.state.patients.find((item) => item.id === patientId)
    if (!patient) fail(404, "找不到这个病人")
    return patient
  },

  condition(patient, conditionId) {
    return patient.conditions.find((item) => item.id === conditionId) || null
  },

  entryById(entryId) {
    const entry = this.day().entries.find((item) => item.id === entryId)
    if (entry) return entry
    const today = todayKey()
    for (const [key, day] of Object.entries(this.state.days)) {
      if (key === today) continue
      if (day?.entries?.some((item) => item.id === entryId)) fail(404, "这张单已经过了零点")
    }
    fail(404, "今天没有这张单")
  },

  presentItem(item) {
    const target = targetById(item.targetId)
    const assignee = this.state.staff.find((person) => person.id === item.assigneeId)
    const closer = this.state.staff.find((person) => person.id === item.completedBy)
    return {
      ...item,
      side: item.side || null,
      targetName: target?.name || item.targetId,
      targetKind: target?.kind || "muscle",
      assigneeName: assignee?.name || "",
      completedBy: item.completedBy || null,
      completedByName: closer?.name || "",
    }
  },

  entryView(deviceId, entryId) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    const patient = this.patient(entry.patientId)
    const lastAssignee = this.state.staff.find((person) => person.id === patient.lastAssigneeId) || null
    return {
      ...this.view(deviceId),
      entry: {
        id: entry.id,
        patientId: patient.id,
        patientName: patient.name,
        archived: Boolean(patient.archived),
        note: patient.note || "",
        lastAssigneeId: lastAssignee?.id || null,
        lastAssigneeName: lastAssignee?.name || "",
        conditionIds: entry.conditionIds,
        conditions: patient.conditions.map((condition) => ({
          id: condition.id,
          name: condition.name,
          chiefSiteId: condition.chiefSiteId,
          chiefSide: condition.chiefSide || null,
          fresh: condition.fresh,
          items: condition.items,
        })),
        chiefSiteId: entry.chiefSiteId,
        chiefSide: entry.chiefSide || null,
        focusConditionId: entry.focusConditionId,
        history: this.visitHistory(patient.id),
        diverged: this.diverged(entry),
        items: entry.items.map((item) => this.presentItem(item)),
      },
    }
  },

  diverged(entry) {
    const patient = this.patient(entry.patientId)
    return entry.conditionIds.some((conditionId) => {
      const condition = this.condition(patient, conditionId)
      if (!condition || condition.fresh) return false
      if (
        entry.conditionIds.length === 1 &&
        (condition.chiefSiteId !== entry.chiefSiteId || (condition.chiefSide || null) !== (entry.chiefSide || null))
      ) {
        return true
      }
      const saved = condition.items.map(workSignature)
      const current = entry.items.filter((item) => item.conditionId === conditionId).map(workSignature)
      return JSON.stringify(saved) !== JSON.stringify(current)
    })
  },
}
