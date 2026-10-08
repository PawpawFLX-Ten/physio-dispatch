// 写侧：病人、病症、今日单和单项的所有改动。
import {
  DIRECTIONS,
  TECHNIQUES,
  allowsChief,
  defaultDose,
  targetById,
  targetTitle,
} from "../shared/catalog.js"
import { assertExpectedVersion, bumpEntryVersion, fail, id, normalizeSide } from "./helpers.js"

export const entryMethods = {
  createPatient({ deviceId, name, conditionName }) {
    this.requireStaff(deviceId)
    if (!name?.trim() || !conditionName?.trim()) fail(400, "请填写病人姓名和病症")
    const condition = {
      id: id(),
      name: conditionName.trim(),
      chiefSiteId: null,
      chiefSide: null,
      fresh: true,
      items: [],
    }
    const patient = { id: id(), name: name.trim(), conditions: [condition] }
    this.state.patients.push(patient)
    const entry = this.makeEntry(patient, [condition.id], condition.id)
    this.day().entries.push(entry)
    this.save()
    this.audit(deviceId, "新建病人", { 病人: patient.name, 病症: condition.name })
    return this.entryView(deviceId, entry.id)
  },

  addExisting({ deviceId, patientId, conditionIds }) {
    this.requireStaff(deviceId)
    const patient = this.patient(patientId)
    const existing = this.day().entries.find((entry) => entry.patientId === patientId)
    if (existing) {
      if (conditionIds?.length) {
        for (const conditionId of conditionIds) {
          this.attachCondition(existing, patient, conditionId)
        }
        this.save()
        this.audit(deviceId, "病人加入今天", { 病人: patient.name, 加病症: conditionIds.length })
      }
      return this.entryView(deviceId, existing.id)
    }
    const ids = conditionIds?.length ? conditionIds : patient.conditions.map((condition) => condition.id)
    if (!ids.length) fail(400, "这个病人还没有病症")
    for (const conditionId of ids) {
      if (!this.condition(patient, conditionId)) fail(404, "找不到病症")
    }
    const entry = this.makeEntry(patient, ids, ids[ids.length - 1])
    this.day().entries.push(entry)
    this.save()
    this.audit(deviceId, "病人加入今天", { 病人: patient.name })
    return this.entryView(deviceId, entry.id)
  },

  // 照上次的单：直接复制这位最近一天的实际单（含当天调过的顺序和派给谁）。
  repeatLastDay({ deviceId, patientId }) {
    this.requireStaff(deviceId)
    const patient = this.patient(patientId)
    if (this.day().entries.some((entry) => entry.patientId === patientId)) {
      fail(400, "这位今天已经在单上了")
    }
    const prevDays = this.patientLastDays(true)
    const prevDay = prevDays.get(patientId)
    if (!prevDay) fail(404, "这位还没来过，先按病症建")
    const last = this.state.days[prevDay].entries.find((entry) => entry.patientId === patientId)
    if (!last) fail(404, "找不到上次的那张单")
    const entry = {
      id: id(),
      patientId,
      conditionIds: [...last.conditionIds],
      focusConditionId: last.conditionIds[last.conditionIds.length - 1],
      chiefSiteId: last.chiefSiteId,
      chiefSide: last.chiefSide || null,
      version: 0,
      items: last.items.map((item) => ({
        id: id(),
        conditionId: item.conditionId,
        sourceItemId: item.sourceItemId,
        targetId: item.targetId,
        side: item.side || null,
        technique: item.technique,
        direction: item.direction,
        dose: structuredClone(item.dose),
        assigneeId: item.assigneeId || null,
        done: false,
        completedBy: null,
      })),
    }
    this.day().entries.push(entry)
    this.save()
    this.audit(deviceId, "照上次的单", { 病人: patient.name, 上次: prevDay })
    return this.entryView(deviceId, entry.id)
  },

  // 把昨天未完成接进今天：只带未完成项与派工，不做完的项原样拷成已完成。
  carryUnfinished({ deviceId, patientId }) {
    this.requireStaff(deviceId)
    const patient = this.patient(patientId)
    if (this.day().entries.some((entry) => entry.patientId === patientId)) {
      fail(400, "这位今天已经在单上了")
    }
    const prevDays = this.patientLastDays(true)
    const prevDay = prevDays.get(patientId)
    if (!prevDay) fail(404, "这位还没来过，先按病症建")
    const last = this.state.days[prevDay].entries.find((entry) => entry.patientId === patientId)
    if (!last) fail(404, "找不到上次的那张单")
    const open = (last.items || []).filter((item) => !item.done)
    if (!open.length) fail(400, "昨天没有未完成的项")
    const conditionIds = [...new Set(open.map((item) => item.conditionId).filter(Boolean))]
    const ids = conditionIds.length ? conditionIds : [...last.conditionIds]
    const entry = {
      id: id(),
      patientId,
      conditionIds: ids,
      focusConditionId: ids[ids.length - 1],
      chiefSiteId: last.chiefSiteId,
      chiefSide: last.chiefSide || null,
      version: 0,
      items: open.map((item) => ({
        id: id(),
        conditionId: item.conditionId,
        sourceItemId: item.sourceItemId,
        targetId: item.targetId,
        side: item.side || null,
        technique: item.technique,
        direction: item.direction,
        dose: structuredClone(item.dose),
        assigneeId: item.assigneeId || null,
        done: false,
        completedBy: null,
      })),
    }
    this.day().entries.push(entry)
    this.save()
    this.audit(deviceId, "接昨天未完成", { 病人: patient.name, 上次: prevDay, 项数: open.length })
    return this.entryView(deviceId, entry.id)
  },

  // 「说一句」解析结果一次入库，省得一条一条点。
  quickAdd({ deviceId, entryId, chief, items }) {
    const staff = this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    if (chief?.targetId) {
      const target = targetById(chief.targetId)
      if (!target || !allowsChief(target)) fail(400, "这个位置不能当作要治的地方")
      entry.chiefSiteId = chief.targetId
      entry.chiefSide = normalizeSide(chief.side)
    }
    const focus =
      entry.focusConditionId && entry.conditionIds.includes(entry.focusConditionId)
        ? entry.focusConditionId
        : entry.conditionIds[entry.conditionIds.length - 1]
    const previous = entry.items[entry.items.length - 1]
    let added = 0
    for (const item of Array.isArray(items) ? items : []) {
      const target = targetById(item?.targetId)
      if (!target || target.kind === "site") fail(400, "这项不能当下手项")
      // 下手项必须先有要治的地方（本请求里刚设的也算）。
      if (!entry.chiefSiteId) fail(400, "请先点要治的地方，再加下手项")
      if (!TECHNIQUES.some((row) => row.id === item.technique)) fail(400, "手法不对")
      if (!DIRECTIONS.some((row) => row.id === item.direction)) fail(400, "方向不对")
      const dose =
        item.technique === "equipment"
          ? { sets: Math.max(1, Number(item.dose?.sets) || 3), reps: Math.max(1, Number(item.dose?.reps) || 10) }
          : { minutes: Math.max(1, Number(item.dose?.minutes) || 8) }
      entry.items.push({
        id: id(),
        conditionId: focus,
        sourceItemId: null,
        targetId: target.id,
        side: normalizeSide(item.side),
        technique: item.technique,
        direction: item.direction,
        dose,
        assigneeId: previous?.assigneeId || staff.id,
        done: false,
        completedBy: null,
      })
      added += 1
    }
    if (!added && !chief?.targetId) fail(400, "没有可加的项")
    this.save()
    this.audit(deviceId, "说一句加项", { 项数: added })
    return this.entryView(deviceId, entry.id)
  },

  setPatientNote({ deviceId, patientId, note }) {
    this.requireStaff(deviceId)
    const patient = this.patient(patientId)
    patient.note = String(note || "").trim().slice(0, 200)
    this.save()
    this.audit(deviceId, "改备注", { 病人: patient.name })
    return this.view(deviceId)
  },

  renamePatient({ deviceId, patientId, name }) {
    this.requireStaff(deviceId)
    const trimmed = String(name || "").trim()
    if (!trimmed) fail(400, "请填写病人姓名")
    const patient = this.patient(patientId)
    const clash = this.state.patients.find((row) => row.id !== patientId && row.name === trimmed)
    if (clash) fail(400, `已有叫${trimmed}的病人`)
    const before = patient.name
    patient.name = trimmed
    this.save()
    this.audit(deviceId, "改姓名", { 原名: before, 新名: trimmed })
    return this.view(deviceId)
  },

  setPatientArchived({ deviceId, patientId, archived }) {
    this.requireStaff(deviceId)
    const patient = this.patient(patientId)
    patient.archived = Boolean(archived)
    this.save()
    this.audit(deviceId, patient.archived ? "归档病人" : "恢复病人", { 病人: patient.name })
    return this.view(deviceId)
  },

  // 病症有没有被任何一天的单用过（含今天）。用过的不能删，免得历史对不上。
  conditionInUse(conditionId) {
    for (const day of Object.values(this.state.days || {})) {
      for (const entry of day?.entries || []) {
        if (entry?.conditionIds?.includes(conditionId)) return true
      }
    }
    return false
  },

  deleteCondition({ deviceId, patientId, conditionId }) {
    this.requireStaff(deviceId)
    const patient = this.patient(patientId)
    const condition = this.condition(patient, conditionId)
    if (!condition) fail(404, "找不到病症")
    if (this.conditionInUse(conditionId)) {
      fail(400, "这条病症还在某天的单上用过，不能删")
    }
    patient.conditions = patient.conditions.filter((row) => row.id !== conditionId)
    this.save()
    this.audit(deviceId, "删除病症", { 病人: patient.name, 病症: condition.name })
    return this.view(deviceId)
  },

  makeEntry(patient, conditionIds, focusConditionId) {
    const items = []
    for (const conditionId of conditionIds) {
      const condition = this.condition(patient, conditionId)
      for (const item of condition.items) {
        items.push({
          id: id(),
          conditionId,
          sourceItemId: item.id,
          targetId: item.targetId,
          side: item.side || null,
          technique: item.technique,
          direction: item.direction,
          dose: structuredClone(item.dose),
          assigneeId: null,
          done: false,
          completedBy: null,
        })
      }
    }
    const first = this.condition(patient, conditionIds[0])
    return {
      id: id(),
      patientId: patient.id,
      conditionIds: [...conditionIds],
      focusConditionId,
      chiefSiteId: first?.chiefSiteId || null,
      chiefSide: first?.chiefSide || null,
      version: 0,
      items,
    }
  },

  addCondition({ deviceId, entryId, name }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    const patient = this.patient(entry.patientId)
    if (!name?.trim()) fail(400, "请填写病症名称")
    const condition = {
      id: id(),
      name: name.trim(),
      chiefSiteId: null,
      chiefSide: null,
      fresh: true,
      items: [],
    }
    patient.conditions.push(condition)
    entry.conditionIds.push(condition.id)
    entry.focusConditionId = condition.id
    this.save()
    this.audit(deviceId, "新增病症", { 病人: patient.name, 病症: condition.name })
    return this.entryView(deviceId, entry.id)
  },

  setFocus({ deviceId, entryId, conditionId }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    const patient = this.patient(entry.patientId)
    if (!this.condition(patient, conditionId) || !entry.conditionIds.includes(conditionId)) {
      fail(404, "找不到病症")
    }
    entry.focusConditionId = conditionId
    this.save()
    this.audit(deviceId, "切换焦点病症", { 病症: this.condition(patient, conditionId)?.name || conditionId })
    return this.entryView(deviceId, entry.id)
  },

  setChief({ deviceId, entryId, targetId, side }) {
    this.requireStaff(deviceId)
    const target = targetById(targetId)
    if (!target || (target.kind !== "site" && target.kind !== "both")) {
      fail(400, "这个位置不能当作要治的地方")
    }
    const entry = this.entryById(entryId)
    entry.chiefSiteId = targetId
    entry.chiefSide = normalizeSide(side)
    this.save()
    this.audit(deviceId, "改要治的位置", { 位置: targetTitle(targetId, normalizeSide(side)) })
    return this.entryView(deviceId, entry.id)
  },

  addItem({ deviceId, entryId, targetId, side }) {
    const staff = this.requireStaff(deviceId)
    const target = targetById(targetId)
    if (!target || target.kind === "site") fail(400, "这个位置要先当作要治的地方，不能直接下手")
    const entry = this.entryById(entryId)
    if (!entry.chiefSiteId) fail(400, "请先点要治的地方，再加下手项")
    const previous = entry.items[entry.items.length - 1]
    const technique = previous?.technique || "massage"
    const direction = previous?.direction || "along"
    const dose = previous ? structuredClone(previous.dose) : defaultDose(technique)
    if (technique === "equipment" && dose.minutes != null) {
      Object.assign(dose, defaultDose("equipment"))
      delete dose.minutes
    }
    const focus =
      entry.focusConditionId && entry.conditionIds.includes(entry.focusConditionId)
        ? entry.focusConditionId
        : entry.conditionIds[entry.conditionIds.length - 1]
    entry.items.push({
      id: id(),
      conditionId: focus,
      sourceItemId: null,
      targetId,
      side: normalizeSide(side),
      technique,
      direction,
      dose,
      assigneeId: previous?.assigneeId || staff.id,
      done: false,
      completedBy: null,
    })
    this.save()
    this.audit(deviceId, "点选一项", { 位置: targetTitle(targetId, normalizeSide(side)), 派给: staff.name })
    return this.entryView(deviceId, entry.id)
  },

  patchItem({ deviceId, entryId, itemId, patch, expectedVersion }) {
    const staff = this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    assertExpectedVersion(entry, expectedVersion)
    const item = entry.items.find((row) => row.id === itemId)
    if (!item) fail(404, "找不到这一项")
    if (patch.technique && patch.technique !== item.technique) {
      if (!TECHNIQUES.some((row) => row.id === patch.technique)) fail(400, "手法不对")
      item.technique = patch.technique
      item.dose = defaultDose(patch.technique)
    }
    if (patch.direction) {
      if (!DIRECTIONS.some((row) => row.id === patch.direction)) fail(400, "方向不对")
      item.direction = patch.direction
    }
    if (patch.assigneeId) {
      if (!this.state.staff.some((row) => row.id === patch.assigneeId)) fail(404, "找不到这个人")
      item.assigneeId = patch.assigneeId
      const owner = this.patient(entry.patientId)
      owner.lastAssigneeId = patch.assigneeId
    }
    if (Object.prototype.hasOwnProperty.call(patch, "side")) item.side = normalizeSide(patch.side)
    if (typeof patch.done === "boolean") {
      if (patch.done) {
        if (!item.done) {
          item.done = true
          item.completedBy = staff.id
        }
      } else {
        item.done = false
        item.completedBy = null
      }
    }
    if (patch.dose && item.technique === "equipment") {
      item.dose = {
        sets: Math.max(1, Number(patch.dose.sets ?? item.dose.sets) || 1),
        reps: Math.max(1, Number(patch.dose.reps ?? item.dose.reps) || 1),
      }
    } else if (patch.dose) {
      item.dose = { minutes: Math.max(1, Number(patch.dose.minutes ?? item.dose.minutes) || 1) }
    }
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "改一项", { 项: targetTitle(item.targetId, item.side || null), 改动: patch })
    return this.entryView(deviceId, entry.id)
  },

  removeItem({ deviceId, entryId, itemId }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    const item = entry.items.find((row) => row.id === itemId)
    entry.items = entry.items.filter((item) => item.id !== itemId)
    this.save()
    this.audit(deviceId, "去掉一项", { 项: item ? targetTitle(item.targetId, item.side || null) : itemId })
    return this.entryView(deviceId, entry.id)
  },

  // 撤销删除：把快照插回原位，派工和完成状态原样保留，但换新 id。
  restoreItem({ deviceId, entryId, index, item }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    const at = Number(index)
    if (!Number.isInteger(at) || at < 0 || at > entry.items.length) fail(400, "插回位置不对")
    if (!item || typeof item !== "object") fail(400, "缺少要插回的项")
    const target = targetById(item.targetId)
    if (!target || target.kind === "site") fail(400, "这个位置要先当作要治的地方，不能直接下手")
    if (item.technique && !TECHNIQUES.some((row) => row.id === item.technique)) fail(400, "手法不对")
    if (item.direction && !DIRECTIONS.some((row) => row.id === item.direction)) fail(400, "方向不对")
    const focus =
      entry.focusConditionId && entry.conditionIds.includes(entry.focusConditionId)
        ? entry.focusConditionId
        : entry.conditionIds[entry.conditionIds.length - 1]
    const conditionId =
      typeof item.conditionId === "string" && entry.conditionIds.includes(item.conditionId)
        ? item.conditionId
        : focus
    const technique = item.technique || "massage"
    const direction = item.direction || "along"
    const dose = item.dose ? structuredClone(item.dose) : defaultDose(technique)
    const restored = {
      id: id(),
      conditionId,
      sourceItemId: typeof item.sourceItemId === "string" ? item.sourceItemId : null,
      targetId: item.targetId,
      side: normalizeSide(item.side),
      technique,
      direction,
      dose,
      assigneeId: typeof item.assigneeId === "string" ? item.assigneeId : null,
      done: Boolean(item.done),
      completedBy: typeof item.completedBy === "string" ? item.completedBy : null,
    }
    entry.items.splice(at, 0, restored)
    this.save()
    this.audit(deviceId, "插回一项", { 项: targetTitle(restored.targetId, restored.side) })
    return this.entryView(deviceId, entry.id)
  },

  reorder({ deviceId, entryId, orderedIds, expectedVersion }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    assertExpectedVersion(entry, expectedVersion)
    const ids = Array.isArray(orderedIds) ? orderedIds : []
    if (new Set(ids).size !== ids.length) fail(400, "顺序有重复")
    const map = new Map(entry.items.map((item) => [item.id, item]))
    if (ids.length !== entry.items.length || ids.some((itemId) => !map.has(itemId))) {
      fail(400, "顺序不完整")
    }
    entry.items = ids.map((itemId) => map.get(itemId))
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "调整顺序")
    return this.entryView(deviceId, entry.id)
  },

  assignAll({ deviceId, entryId, assigneeId, expectedVersion }) {
    this.requireStaff(deviceId)
    const person = this.state.staff.find((row) => row.id === assigneeId)
    if (!person) fail(404, "找不到这个人")
    const entry = this.entryById(entryId)
    assertExpectedVersion(entry, expectedVersion)
    for (const item of entry.items) item.assigneeId = assigneeId
    // 记住这个病人上次派给谁，下次「全部派给」一键照旧。
    const patient = this.patient(entry.patientId)
    patient.lastAssigneeId = assigneeId
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "全部派给", { 派给: person.name })
    return this.entryView(deviceId, entry.id)
  },

  dropEntry({ deviceId, entryId }) {
    this.requireStaff(deviceId)
    const day = this.day()
    const entry = day.entries.find((item) => item.id === entryId)
    if (!entry) fail(404, "今天没有这张单")
    // 病人可能已经不在档案里（孤儿条目）：名字拿得到就用，拿不到也照样能拿掉。
    const patient = this.state.patients.find((row) => row.id === entry.patientId)
    const name = patient?.name || entry.patientId
    day.entries = day.entries.filter((item) => item.id !== entryId)
    this.save()
    this.audit(deviceId, "从今天拿掉", { 病人: name })
    return this.view(deviceId)
  },

  writeCondition(patient, condition, entry) {
    const mine = entry.items.filter((item) => item.conditionId === condition.id)
    condition.items = mine.map((item) => ({
      id: item.sourceItemId || id(),
      targetId: item.targetId,
      side: item.side || null,
      technique: item.technique,
      direction: item.direction,
      dose: structuredClone(item.dose),
    }))
    for (const [index, item] of mine.entries()) {
      item.sourceItemId = condition.items[index].id
    }
    if (entry.conditionIds.length === 1 || condition.fresh) {
      condition.chiefSiteId = entry.chiefSiteId
      condition.chiefSide = entry.chiefSide || null
    }
    condition.fresh = false
  },

  leave({ deviceId, entryId, updateCondition }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    const patient = this.patient(entry.patientId)
    for (const conditionId of entry.conditionIds) {
      const condition = this.condition(patient, conditionId)
      if (!condition) continue
      if (condition.fresh || updateCondition) this.writeCondition(patient, condition, entry)
    }
    this.save()
    this.audit(deviceId, "离开病人页", { 回写病症: updateCondition })
    return this.entryView(deviceId, entry.id)
  },

  attachCondition(entry, patient, conditionId) {
    const condition = this.condition(patient, conditionId)
    if (!condition) fail(404, "找不到病症")
    if (!entry.conditionIds.includes(conditionId)) entry.conditionIds.push(conditionId)
    if (!entry.chiefSiteId && condition.chiefSiteId) {
      entry.chiefSiteId = condition.chiefSiteId
      entry.chiefSide = condition.chiefSide || null
    }
    const have = new Set(entry.items.filter((item) => item.conditionId === conditionId).map((item) => item.sourceItemId))
    for (const item of condition.items) {
      if (have.has(item.id)) continue
      entry.items.push({
        id: id(),
        conditionId,
        sourceItemId: item.id,
        targetId: item.targetId,
        side: item.side || null,
        technique: item.technique,
        direction: item.direction,
        dose: structuredClone(item.dose),
        assigneeId: null,
        done: false,
        completedBy: null,
      })
    }
    entry.focusConditionId = conditionId
  },

  includeCondition({ deviceId, entryId, conditionId }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    const patient = this.patient(entry.patientId)
    this.attachCondition(entry, patient, conditionId)
    this.save()
    this.audit(deviceId, "病症加入今天", { 病症: this.condition(patient, conditionId)?.name || conditionId })
    return this.entryView(deviceId, entry.id)
  },

  copyCondition({ deviceId, conditionId, targetPatientId, fromToday }) {
    this.requireStaff(deviceId)
    let source = null
    let sourcePatient = null
    for (const patient of this.state.patients) {
      const found = patient.conditions.find((condition) => condition.id === conditionId)
      if (found) {
        source = found
        sourcePatient = patient
        break
      }
    }
    if (!source) fail(404, "找不到病症")
    const target = this.patient(targetPatientId)
    if (target.id === sourcePatient.id) fail(400, "请复制到另一个病人")

    let chiefSiteId = source.chiefSiteId
    let chiefSide = source.chiefSide || null
    let items = source.items
    if (fromToday) {
      // 用今天这张单上的工作链，不走档案里旧存档。
      const todayEntry = this.todayRecord().entries.find(
        (entry) => entry.patientId === sourcePatient.id && entry.conditionIds.includes(conditionId),
      )
      if (!todayEntry) fail(404, "今天没有这张单")
      chiefSiteId = todayEntry.chiefSiteId
      chiefSide = todayEntry.chiefSide || null
      items = todayEntry.items.filter((item) => item.conditionId === conditionId)
    }

    target.conditions.push({
      id: id(),
      name: source.name,
      chiefSiteId,
      chiefSide,
      fresh: false,
      items: items.map((item) => ({
        id: id(),
        targetId: item.targetId,
        side: item.side || null,
        technique: item.technique,
        direction: item.direction,
        dose: structuredClone(item.dose),
      })),
    })
    this.save()
    this.audit(deviceId, fromToday ? "从今天复制病症" : "复制病症", { 病症: source.name, 到: target.name })
    return this.view(deviceId)
  },
}
