// 读侧：把 state 投影成各页面要的样子。
import { sideLabel, targetById, targetTitle } from "../shared/catalog.js"
import {
  equipmentCatalogSnapshot,
  equipmentSummaryForItem,
  equipmentTypeById,
  equipmentUnitName,
  exerciseTemplateName,
} from "../shared/equipment.js"
import { mergedPairings } from "../shared/pairings.js"
import { entryVersion, fail, todayKey, workSignature } from "./helpers.js"

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
    const equipmentCatalog = equipmentCatalogSnapshot()
    return {
      ...base,
      // 单人治疗室的界面差异（收起派工、行内完成口径）以服务端这份为准，别三处各算各的。
      solo: this.state.staff.length === 1,
      today: this.todayList(meId),
      todayByStaff: this.todayByStaff(),
      todayByEquipment: this.todayByEquipment(),
      ...equipmentCatalog,
      patients: this.patientList(),
      templates: this.templateList(),
      lastExportAt: typeof this.state.lastExportAt === "string" ? this.state.lastExportAt : null,
      // 常见搭配：设置里改过的覆盖默认，加项面板照这张表出芯片。
      pairings: mergedPairings(this.state.pairings),
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
        let hasUnfinishedPrev = false
        const prevDay = prevDays.get(patient.id)
        if (prevDay) {
          const entry = this.state.days[prevDay].entries.find((row) => row.patientId === patient.id)
          if (entry) {
            lastSummary = entry.items.map((item) => targetTitle(item.targetId, item.side || null)).join("、")
            hasUnfinishedPrev = entry.items.some((item) => !item.done)
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
          hasUnfinishedPrev,
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
        // 这一天最后一项完成的时刻（没有完成项就是空）：交班时知道干到几点。
        lastDoneAt: entry.items.reduce((best, item) => {
          if (!item.done || typeof item.completedAt !== "string") return best
          return !best || item.completedAt > best ? item.completedAt : best
        }, null),
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

  // 读侧拿今天：只看不建，免得每个只是开过 App 的日子都在档案里留下一个空天。
  todayRecord() {
    return this.state.days[todayKey()] || { entries: [] }
  },

  // 写侧拿今天：没有就建。
  day() {
    const key = todayKey()
    if (!this.state.days[key]) this.state.days[key] = { entries: [] }
    return this.state.days[key]
  },

  todayList(meId) {
    // 跳过「条目还在、病人没了」的孤儿，避免整间屋子 view() 打不开。
    return this.todayRecord()
      .entries.map((entry) => this.entrySummary(entry, meId))
      .filter(Boolean)
  },

  entrySummary(entry, meId) {
    const patient = this.state.patients.find((item) => item.id === entry.patientId)
    if (!patient) return null
    const done = entry.items.filter((item) => item.done).length
    // 单人治疗室所有活都是「我的」：档案带出来还没派工的项也能行内完成。
    const solo = this.state.staff.length === 1
    const mine = meId ? entry.items.filter((item) => solo || item.assigneeId === meId) : []
    const mineNext = mine.find((item) => !item.done) || null
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
      mineNextId: mineNext?.id || null,
      mineNextName: mineNext ? targetTitle(mineNext.targetId, mineNext.side || null) : "",
      equipmentCount: entry.items.filter((item) => item.technique === "equipment" || item.equipmentTypeId).length,
      // 来过几天就是第几次：直接从索引数，不用任何人手工记疗程次数。
      visitCount: this.visitCountOf(patient.id),
      version: entryVersion(entry),
      note: patient.note || "",
    }
  },

  visitCountOf(patientId) {
    this.ensureDayIndex()
    const days = new Set()
    for (const visit of this.byPatient.get(patientId) || []) days.add(visit.day)
    return days.size
  },

  // 主治一眼看谁手里多少活：按人分桶，未派的单独一桶。
  todayByStaff() {
    const groups = new Map()
    const bucketOf = (assigneeId) => {
      const person = assigneeId ? this.state.staff.find((row) => row.id === assigneeId) : null
      const key = person?.id || "none"
      if (!groups.has(key)) {
        groups.set(key, { staffId: person?.id || null, name: person?.name || "未派", done: 0, total: 0, minutes: 0, patients: new Map() })
      }
      return groups.get(key)
    }
    for (const entry of this.todayRecord().entries) {
      const patient = this.state.patients.find((item) => item.id === entry.patientId)
      if (!patient) continue
      for (const item of entry.items) {
        const bucket = bucketOf(item.assigneeId)
        bucket.total += 1
        if (item.done) bucket.done += 1
        // 没做完的分钟数顺手累加：主治看「还剩多少活」不用再心算（器械按组次计，不折分钟）。
        else if (Number(item.dose?.minutes) > 0) bucket.minutes += Math.round(item.dose.minutes)
        const row = bucket.patients.get(entry.patientId) || {
          entryId: entry.id,
          patientName: patient.name,
          note: patient.note || "",
          done: 0,
          total: 0,
          lastDoneAt: null,
        }
        row.total += 1
        if (item.done) {
          row.done += 1
          // 这位病人最后一项完成的时刻：交班单上印「完于几点」。
          if (typeof item.completedAt === "string" && (!row.lastDoneAt || item.completedAt > row.lastDoneAt)) {
            row.lastDoneAt = item.completedAt
          }
        }
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

  // 今日设备视图：按“设备类型 + 具体机台”分桶，但组内保留全局工作顺序。
  // 旧 technique:"equipment" 但没有类型的数据归到 type=null 的“器械”桶，照样可读。
  todayByEquipment() {
    const groups = new Map()
    let order = 0
    for (const entry of this.todayRecord().entries) {
      const patient = this.state.patients.find((item) => item.id === entry.patientId)
      if (!patient) continue
      for (const item of entry.items || []) {
        order += 1
        const type = equipmentTypeById(item.equipmentTypeId)
        const isEquipment = item.technique === "equipment" || Boolean(type)
        if (!isEquipment) continue
        const typeName = type?.name || "器械"
        const unitName = equipmentUnitName(item.equipmentUnitId)
        const key = `${type?.id || "legacy"}:${item.equipmentUnitId || "none"}`
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            equipmentTypeId: type?.id || null,
            equipmentTypeName: typeName,
            equipmentUnitId: typeof item.equipmentUnitId === "string" ? item.equipmentUnitId : null,
            equipmentUnitName: unitName,
            name: [typeName, unitName].filter(Boolean).join(" · "),
            shared: Boolean(type && !type.requiresUnit),
            done: 0,
            total: 0,
            tasks: [],
          })
        }
        const group = groups.get(key)
        const assignee = this.state.staff.find((person) => person.id === item.assigneeId)
        const task = {
          order,
          entryId: entry.id,
          itemId: item.id,
          patientId: patient.id,
          patientName: patient.name,
          assigneeId: item.assigneeId || null,
          assigneeName: assignee?.name || "",
          done: Boolean(item.done),
          completedAt: item.completedAt || null,
          equipmentTypeId: type?.id || null,
          equipmentTypeName: typeName,
          equipmentUnitId: typeof item.equipmentUnitId === "string" ? item.equipmentUnitId : null,
          equipmentUnitName: unitName,
          equipmentSummary: equipmentSummaryForItem(item),
          targetTitle: targetTitle(item.targetId, item.side || null),
          linkedTargetTitles: (Array.isArray(item.linkedTargets) ? item.linkedTargets : [])
            .map((link) => targetTitle(link.targetId, link.side || null))
            .filter(Boolean),
        }
        group.tasks.push(task)
        group.total += 1
        if (item.done) group.done += 1
      }
    }
    return [...groups.values()].map((group) => ({
      ...group,
      doneCount: group.done,
      items: group.tasks,
    }))
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
    const entry = this.todayRecord().entries.find((item) => item.id === entryId)
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
    const type = equipmentTypeById(item.equipmentTypeId)
    const linkedTargets = Array.isArray(item.linkedTargets) ? structuredClone(item.linkedTargets) : []
    return {
      ...item,
      side: item.side || null,
      parameters:
        item.parameters && typeof item.parameters === "object" && !Array.isArray(item.parameters)
          ? structuredClone(item.parameters)
          : {},
      linkedTargets,
      targetName: target?.name || item.targetId,
      targetKind: target?.kind || "muscle",
      equipmentTypeName: type?.name || "",
      equipmentUnitName: equipmentUnitName(item.equipmentUnitId),
      exerciseName: exerciseTemplateName(item.exerciseTemplateId),
      equipmentSummary: equipmentSummaryForItem(item),
      equipmentDoseMode: type?.doseMode || null,
      linkedTargetTitles: linkedTargets.map((link) => targetTitle(link.targetId, link.side || null)).filter(Boolean),
      sideLabel: sideLabel(item.side || null),
      assigneeName: assignee?.name || "",
      completedBy: item.completedBy || null,
      completedAt: item.completedAt || null,
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
        // 离开时问不问「记回病症」：改过、且这轮还没答过才问。
        leaveAsk: this.diverged(entry) && !entry.divergedAcked,
        version: entryVersion(entry),
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
