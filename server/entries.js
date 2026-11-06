// 写侧：病人、病症、今日单和单项的所有改动。
import {
  DIRECTIONS,
  TECHNIQUES,
  allowsChief,
  allowsEquipment,
  clampDose,
  defaultDose,
  hasSides,
  targetById,
  targetTitle,
} from "../shared/catalog.js"
import {
  chooseEquipmentUnitId,
  equipmentTypeById,
  equipmentUnitById,
  exerciseTemplateById,
  sanitizeEquipmentParameters,
} from "../shared/equipment.js"
import { assertExpectedVersion, bumpEntryVersion, fail, id, normalizeSide, todayKey } from "./helpers.js"
import { instructionFields } from "../shared/workflow.js"

// 下手项的部位必须真实存在；纯 site 仍只能作为主诉，kind=both 的区域可做设备/区域级下手项。
// 点选、说一句、撤销插回三条路共用同一句报错。
function workTargetOrThrow(targetId) {
  const target = targetById(targetId)
  if (!target || target.kind === "site") fail(400, "这个位置要先当作要治的地方，不能直接下手")
  return target
}

// 设备可以把膝、颈这类纯部位当作作用区域；普通手工项仍不能。
function equipmentTargetOrThrow(targetId) {
  const target = targetById(targetId)
  if (!target || !allowsEquipment(target)) fail(400, "这个位置不能关联设备")
  return target
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)
}

// 病症存档和今日项共用同一组器械字段，避免今天用了设备、回写时却悄悄丢设备。
function equipmentFieldsOf(item) {
  return {
    ...instructionFields(item),
    equipmentTypeId: typeof item?.equipmentTypeId === "string" ? item.equipmentTypeId : null,
    equipmentUnitId: typeof item?.equipmentUnitId === "string" ? item.equipmentUnitId : null,
    exerciseTemplateId: typeof item?.exerciseTemplateId === "string" ? item.exerciseTemplateId : null,
    parameters:
      item?.parameters && typeof item.parameters === "object" && !Array.isArray(item.parameters)
        ? structuredClone(item.parameters)
        : {},
    linkedTargets: Array.isArray(item?.linkedTargets) ? structuredClone(item.linkedTargets) : [],
  }
}

function equipmentUsageToday(store, skipItemId = null) {
  const usage = {}
  for (const entry of store.todayRecord().entries || []) {
    for (const item of entry.items || []) {
      if (!item || item.done || item.id === skipItemId) continue
      if (typeof item.equipmentUnitId !== "string" || !item.equipmentUnitId) continue
      usage[item.equipmentUnitId] = (usage[item.equipmentUnitId] || 0) + 1
    }
  }
  return usage
}

// 真实占用只看“未完成且已 started”的任务；同一项自己不算冲突。
function activeEquipmentConflict(store, unitId, skipItemId) {
  if (!unitId) return null
  for (const entry of store.todayRecord().entries || []) {
    for (const item of entry.items || []) {
      if (!item || item.id === skipItemId || item.done || item.equipmentUnitId !== unitId) continue
      if (typeof item.startedAt !== "string" || !item.startedAt) continue
      const patient = store.state.patients.find((person) => person.id === entry.patientId) || null
      return { item, entry, patient }
    }
  }
  return null
}

function resolveSide(target, requestedSide, fallbackSide, strict) {
  let side = normalizeSide(requestedSide) || normalizeSide(fallbackSide)
  if (!hasSides(target)) side = null
  if (strict && hasSides(target) && !side) fail(400, "请选择左侧或右侧")
  return side
}

function resolveAssignee(store, input, previous, staff) {
  if (hasOwn(input, "assigneeId")) {
    if (input.assigneeId === null || input.assigneeId === "") return null
    if (typeof input.assigneeId !== "string" || !store.state.staff.some((person) => person.id === input.assigneeId)) {
      fail(404, "找不到这个人")
    }
    return input.assigneeId
  }
  return previous?.assigneeId || staff.id
}

// 新 item 的唯一预校验入口：只返回完整数据，不碰 entry。调用方把全部项都算完后再 splice。
// options.fallbackChiefSide 让 quickAdd 本轮刚设的主诉侧也能给下属项兜底。
export function prepareNewItem({ store, staff, entry, input, previous, fallbackTechnique, inheritPrevious, options = {} }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "缺少要加的项")

  const templateId =
    typeof input.exerciseTemplateId === "string" && input.exerciseTemplateId ? input.exerciseTemplateId : null
  let template = null
  if (templateId) {
    template = exerciseTemplateById(templateId)
    if (!template) fail(400, "找不到动作模板")
  }

  let targetId = typeof input.targetId === "string" ? input.targetId : ""
  if (!targetId && template?.linkedTargets?.length) targetId = template.linkedTargets[0].targetId
  if (!targetId) fail(400, "请选择治疗部位")
  const looksLikeEquipment =
    Boolean(template) || input.technique === "equipment" || Boolean(input.equipmentTypeId) || Boolean(input.equipmentUnitId)
  const target = looksLikeEquipment ? equipmentTargetOrThrow(targetId) : workTargetOrThrow(targetId)

  let equipmentTypeId =
    typeof input.equipmentTypeId === "string" && input.equipmentTypeId ? input.equipmentTypeId : null
  const requestedUnitId =
    typeof input.equipmentUnitId === "string" && input.equipmentUnitId ? input.equipmentUnitId : null
  let type = null
  if (equipmentTypeId) {
    type = equipmentTypeById(equipmentTypeId)
    if (!type) fail(400, "找不到设备类型")
  }
  if (requestedUnitId) {
    const unit = equipmentUnitById(requestedUnitId)
    if (!unit) fail(400, "找不到这台设备")
    if (type && unit.equipmentTypeId !== type.id) fail(400, "这台机和设备类型不匹配")
    if (!type) {
      type = equipmentTypeById(unit.equipmentTypeId)
      equipmentTypeId = type?.id || null
    }
  }
  if (template) {
    if (type && type.id !== template.equipmentTypeId) fail(400, "动作模板与设备类型不匹配")
    type = equipmentTypeById(template.equipmentTypeId)
    equipmentTypeId = type?.id || null
  }
  if (template && !template.compatibleTargetIds.includes(targetId)) {
    fail(400, "这个动作模板不适用这个部位")
  }

  let technique = typeof input.technique === "string" && input.technique ? input.technique : ""
  if (technique) {
    if (!TECHNIQUES.some((row) => row.id === technique)) fail(400, "手法不对")
  } else if (template || equipmentTypeId || requestedUnitId) {
    technique = "equipment"
  } else {
    technique = fallbackTechnique || "massage"
  }

  const hasEquipmentInput =
    Boolean(template || equipmentTypeId || requestedUnitId) ||
    hasOwn(input, "parameters") ||
    hasOwn(input, "linkedTargets")
  if (technique !== "equipment" && hasEquipmentInput) fail(400, "只有器械项可以关联设备")

  let direction = input.direction
  if (direction !== undefined && direction !== null) {
    if (!DIRECTIONS.some((row) => row.id === direction)) fail(400, "方向不对")
  } else if (template?.defaultDirection) {
    direction = template.defaultDirection
  } else if (inheritPrevious && previous?.direction) {
    direction = previous.direction
  } else {
    direction = "along"
  }

  const fallbackChiefSide = hasOwn(options, "fallbackChiefSide") ? options.fallbackChiefSide : entry.chiefSide
  const side = resolveSide(target, input.side, fallbackChiefSide, technique === "equipment")

  let linkedTargets = []
  if (technique === "equipment") {
    const rawLinkedTargets =
      hasOwn(input, "linkedTargets") && input.linkedTargets !== undefined
        ? input.linkedTargets
        : template?.linkedTargets || []
    if (!Array.isArray(rawLinkedTargets)) fail(400, "关联目标格式不对")
    const seen = new Set()
    for (const row of rawLinkedTargets) {
      if (!row || typeof row !== "object") fail(400, "关联目标格式不对")
      const linkedTarget = technique === "equipment" ? equipmentTargetOrThrow(row.targetId) : workTargetOrThrow(row.targetId)
      if (template && !template.compatibleTargetIds.includes(linkedTarget.id)) {
        fail(400, "这个动作模板不适用这个部位")
      }
      const linkedSide = resolveSide(linkedTarget, row.side, side || fallbackChiefSide, true)
      const key = `${linkedTarget.id}:${linkedSide || ""}`
      if (seen.has(key)) continue
      seen.add(key)
      linkedTargets.push({ targetId: linkedTarget.id, side: linkedSide })
    }
  }

  let parameters = {}
  if (technique === "equipment") {
    const mergedParameters = {
      ...(template?.defaultParameters || type?.defaultParameters || {}),
      ...(input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters)
        ? input.parameters
        : {}),
    }
    parameters = sanitizeEquipmentParameters(type?.id || null, mergedParameters)
  }

  let equipmentUnitId = null
  if (technique === "equipment" && type) {
    try {
      equipmentUnitId = chooseEquipmentUnitId(type.id, requestedUnitId, options.unitUsage || {})
    } catch (error) {
      fail(400, error.message)
    }
  }

  let doseInput
  if (hasOwn(input, "dose")) doseInput = input.dose
  else if (template) doseInput = template.defaultDose
  else if (inheritPrevious && previous && (!hasOwn(input, "technique") || input.technique === previous.technique)) {
    doseInput = previous.dose
  }
  const dose = clampDose(technique, doseInput)
  const assigneeId = resolveAssignee(store, input, previous, staff)

  return {
    ...instructionFields(input),
    targetId,
    side,
    technique,
    direction,
    dose,
    assigneeId,
    equipmentTypeId: type?.id || null,
    equipmentUnitId,
    exerciseTemplateId: template?.id || null,
    parameters,
    linkedTargets,
    startedAt: null,
    startedBy: null,
  }
}

// 焦点病症：没设或已失效时，退回最后挂进今天的那条。
function focusOf(entry) {
  return entry.focusConditionId && entry.conditionIds.includes(entry.focusConditionId)
    ? entry.focusConditionId
    : entry.conditionIds[entry.conditionIds.length - 1]
}

// 单子改了会偏离病症存档的内容：下次离开要重新问「记回病症吗」。
function touchDiverged(entry) {
  entry.divergedAcked = false
}

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
    // 先用只读的 todayRecord 判断：校验失败时别在内存里留下一个空的「今天」。
    if (this.todayRecord().entries.some((entry) => entry.patientId === patientId)) {
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
      sequential: Boolean(last.sequential),
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
        ...equipmentFieldsOf(item),
        assigneeId: item.assigneeId || null,
        done: false,
        completedBy: null,
        completedAt: null,
        startedAt: null,
        startedBy: null,
      })),
    }
    this.day().entries.push(entry)
    this.save()
    this.audit(deviceId, "照上次的单", { 病人: patient.name, 上次: prevDay })
    return this.entryView(deviceId, entry.id)
  },

  // 把昨天未完成接进今天：只带未完成项与派工，不做完的项原样拷成已完成。
  // entryId 给跨零点还在病人页的手机用：那张单已属昨天，按 id 反查到病人再接。
  carryUnfinished({ deviceId, patientId, entryId }) {
    this.requireStaff(deviceId)
    let who = patientId || null
    if (!who && typeof entryId === "string" && entryId) {
      const today = todayKey()
      for (const [key, day] of Object.entries(this.state.days)) {
        if (key >= today) continue
        const found = (day?.entries || []).find((row) => row.id === entryId)
        if (found) {
          who = found.patientId
          break
        }
      }
    }
    const patient = this.patient(who)
    if (this.todayRecord().entries.some((entry) => entry.patientId === patient.id)) {
      fail(400, "这位今天已经在单上了")
    }
    const prevDays = this.patientLastDays(true)
    const prevDay = prevDays.get(patient.id)
    if (!prevDay) fail(404, "这位还没来过，先按病症建")
    const last = this.state.days[prevDay].entries.find((entry) => entry.patientId === patient.id)
    if (!last) fail(404, "找不到上次的那张单")
    const open = (last.items || []).filter((item) => !item.done)
    if (!open.length) fail(400, "昨天没有未完成的项")
    const conditionIds = [...new Set(open.map((item) => item.conditionId).filter(Boolean))]
    const ids = conditionIds.length ? conditionIds : [...last.conditionIds]
    const entry = {
      id: id(),
      patientId: patient.id,
      conditionIds: ids,
      focusConditionId: ids[ids.length - 1],
      chiefSiteId: last.chiefSiteId,
      chiefSide: last.chiefSide || null,
      sequential: Boolean(last.sequential),
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
        ...equipmentFieldsOf(item),
        assigneeId: item.assigneeId || null,
        done: false,
        completedBy: null,
        completedAt: null,
        startedAt: null,
        startedBy: null,
      })),
    }
    this.day().entries.push(entry)
    this.save()
    this.audit(deviceId, "接昨天未完成", { 病人: patient.name, 上次: prevDay, 项数: open.length })
    return this.entryView(deviceId, entry.id)
  },

  // 「说一句」解析结果一次入库，省得一条一条点。
  // 先只读校验整批；任何一项非法都不改主诉、不 splice，最后才一次写入。
  quickAdd({ deviceId, entryId, chief, items, assigneeId, expectedVersion, issues, unknown }) {
    const staff = this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    assertExpectedVersion(entry, expectedVersion)
    if (issues?.length || unknown?.length) fail(400, "还有未确认的口令，请改清楚再提交")
    let chiefChange = null
    if (chief?.targetId) {
      const target = targetById(chief.targetId)
      if (!target || !allowsChief(target)) fail(400, "这个位置不能当作要治的地方")
      chiefChange = {
        chiefSiteId: chief.targetId,
        // 本次没给合法侧时沿用这张单已有的合法侧，别把侧别静默清空。
        chiefSide: normalizeSide(chief.side) || normalizeSide(entry.chiefSide),
      }
    }
    const nextChiefSiteId = chiefChange?.chiefSiteId || entry.chiefSiteId
    const fallbackChiefSide = chiefChange ? chiefChange.chiefSide : normalizeSide(entry.chiefSide)
    const incoming = Array.isArray(items) ? items : []
    if (incoming.length && !nextChiefSiteId) fail(400, "请先点要治的地方，再加下手项")
    if (!incoming.length && !chiefChange) fail(400, "没有可加的项")

    const previous = entry.items[entry.items.length - 1]
    const focus = focusOf(entry)
    const unitUsage = equipmentUsageToday(this)
    const prepared = []
    for (const item of incoming) {
      // 顶层 assigneeId 是整批默认派工；单项显式 assigneeId 仍可覆盖它。
      const hasTopLevelAssignee = assigneeId !== undefined && assigneeId !== null && assigneeId !== ""
      const input =
        hasTopLevelAssignee && !Object.prototype.hasOwnProperty.call(item || {}, "assigneeId")
          ? { ...item, assigneeId }
          : item
      const normalized = prepareNewItem({
        store: this,
        staff,
        entry,
        input,
        previous,
        fallbackTechnique: previous?.technique || "massage",
        inheritPrevious: false,
        options: { fallbackChiefSide, unitUsage },
      })
      if (normalized.equipmentUnitId) {
        unitUsage[normalized.equipmentUnitId] = (unitUsage[normalized.equipmentUnitId] || 0) + 1
      }
      prepared.push({
        id: id(),
        conditionId: focus,
        sourceItemId: null,
        ...normalized,
        done: false,
        completedBy: null,
        completedAt: null,
        startedAt: null,
        startedBy: null,
      })
    }

    if (chiefChange) {
      entry.chiefSiteId = chiefChange.chiefSiteId
      entry.chiefSide = chiefChange.chiefSide
    }
    entry.items.push(...prepared)
    touchDiverged(entry)
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "说一句加项", { 项数: prepared.length })
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
    // 单人治疗室：档案带出来的项也记在那个人名下，今日单上能直接完成当前项。
    const soloStaffId = this.state.staff.length === 1 ? this.state.staff[0].id : null
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
          ...equipmentFieldsOf(item),
          assigneeId: soloStaffId,
          done: false,
          completedBy: null,
          completedAt: null,
          startedAt: null,
          startedBy: null,
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
      sequential: Boolean(first?.sequential),
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
    bumpEntryVersion(entry)
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
    bumpEntryVersion(entry)
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
    touchDiverged(entry)
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "改要治的位置", { 位置: targetTitle(targetId, normalizeSide(side)) })
    return this.entryView(deviceId, entry.id)
  },

  addItem({ deviceId, entryId, targetId, side, ...input }) {
    const staff = this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    if (!entry.chiefSiteId) fail(400, "请先点要治的地方，再加下手项")
    const previous = entry.items[entry.items.length - 1]
    const prepared = prepareNewItem({
      store: this,
      staff,
      entry,
      input: { ...input, targetId, side },
      previous,
      fallbackTechnique: previous?.technique || "massage",
      inheritPrevious: true,
      options: { unitUsage: equipmentUsageToday(this) },
    })
    const item = {
      id: id(),
      conditionId: focusOf(entry),
      sourceItemId: null,
      ...prepared,
      done: false,
      completedBy: null,
      completedAt: null,
      startedAt: null,
      startedBy: null,
    }
    entry.items.push(item)
    touchDiverged(entry)
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "点选一项", { 位置: targetTitle(item.targetId, item.side), 派给: staff.name })
    return this.entryView(deviceId, entry.id)
  },

  // 原位替换设备/动作：先复用 prepareNewItem 做全量校验，成功后才替换数组同一格。
  // 当前项必须空闲且未完成；新任务 id、清完成/来源链，conditionId 与队列位置保持不变。
  replaceItem({ deviceId, entryId, itemId, expectedVersion, ...input }) {
    const staff = this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    assertExpectedVersion(entry, expectedVersion)
    const at = entry.items.findIndex((row) => row.id === itemId)
    if (at < 0) fail(404, "找不到这一项")
    const current = entry.items[at]
    if (current.technique !== "equipment") fail(400, "只有设备项可以更换")
    if (current.startedAt) fail(409, "设备使用中，请先结束使用")
    if (current.done) fail(409, "已完成的任务不能更换")

    // 可选字段默认沿用旧项；设备字段不默认沿用，让调用方明确选择新设备/模板。
    const provided = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
    const payload = {
      targetId: current.targetId,
      side: current.side || null,
      assigneeId: current.assigneeId ?? null,
      ...provided,
      technique: "equipment",
    }
    const prepared = prepareNewItem({
      store: this,
      staff,
      entry,
      input: payload,
      previous: current,
      fallbackTechnique: "equipment",
      inheritPrevious: true,
      options: { unitUsage: equipmentUsageToday(this, current.id) },
    })
    const replacement = {
      id: id(),
      conditionId: current.conditionId,
      sourceItemId: null,
      ...prepared,
      done: false,
      completedBy: null,
      completedAt: null,
      startedAt: null,
      startedBy: null,
    }
    entry.items[at] = replacement
    touchDiverged(entry)
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "更换设备/动作", {
      项: targetTitle(replacement.targetId, replacement.side || null),
      设备: replacement.equipmentTypeId || "",
      动作: replacement.exerciseTemplateId || "",
      派给: this.state.staff.find((person) => person.id === replacement.assigneeId)?.name || "",
    })
    return this.entryView(deviceId, entry.id)
  },

  patchItem({ deviceId, entryId, itemId, patch, expectedVersion }) {
    const staff = this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    assertExpectedVersion(entry, expectedVersion)
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) fail(400, "改动格式不对")
    const item = entry.items.find((row) => row.id === itemId)
    if (!item) fail(404, "找不到这一项")
    if (hasOwn(patch, "expectedInstructions") && JSON.stringify(instructionFields(patch.expectedInstructions)) !== JSON.stringify(instructionFields(item))) {
      fail(409, "操作说明已被别人更新，请载入最新说明后再保存")
    }
    if (item.startedAt && patch.started !== false && ["technique", "side"].some((key) => hasOwn(patch, key))) {
      fail(409, "设备使用中，请先结束使用再改治疗内容")
    }

    if ((!item.done && patch.done === true) || (!item.startedAt && patch.started === true)) {
      const execution = this.executionState(entry, item)
      if (!execution.canExecute) fail(409, execution.reason)
    }

    if (hasOwn(patch, "started") && typeof patch.started !== "boolean") fail(400, "开始状态格式不对")
    if (hasOwn(patch, "technique") && !TECHNIQUES.some((row) => row.id === patch.technique)) {
      fail(400, "手法不对")
    }
    const nextTechnique = hasOwn(patch, "technique") ? patch.technique : item.technique
    if (hasOwn(patch, "started") && nextTechnique !== "equipment") {
      fail(400, "只有设备项可以开始或结束使用")
    }
    const nextDone = typeof patch.done === "boolean" ? patch.done : Boolean(item.done)
    if (patch.started === true && nextDone) fail(409, "已完成的任务不能开始使用")

    // 所有改动先落在副本上，最后才一次性提交；任何校验失败都不留下半改状态。
    const candidate = structuredClone(item)
    let touched = false
    let patientAssigneeId = null
    for (const key of ["position", "instructions", "caution", "demoUrl"]) {
      if (!hasOwn(patch, key)) continue
      if (typeof patch[key] !== "string") fail(400, "操作说明格式不对")
      if (key === "demoUrl" && patch[key] && !/^https:\/\//i.test(patch[key])) fail(400, "示范链接需要 HTTPS 地址")
      candidate[key] = instructionFields({ [key]: patch[key] })[key]
      if (candidate[key] !== (item[key] || "")) touched = true
    }
    if (hasOwn(patch, "problem")) {
      if (typeof patch.problem !== "string") fail(400, "问题格式不对")
      candidate.problem = patch.problem.trim().slice(0, 500)
      candidate.problemBy = candidate.problem ? staff.id : null
    }

    if (hasOwn(patch, "technique") && candidate.technique !== patch.technique) {
      // 按摩↔松解↔牵伸都按分钟计：换手法不丢调好的时长；只有换成/换出器械才重置成默认组次。
      const staysMinutes = candidate.technique !== "equipment" && patch.technique !== "equipment"
      candidate.technique = patch.technique
      if (!staysMinutes) candidate.dose = defaultDose(patch.technique)
      if (candidate.technique !== "equipment") {
        candidate.equipmentTypeId = null
        candidate.equipmentUnitId = null
        candidate.exerciseTemplateId = null
        candidate.parameters = {}
        candidate.linkedTargets = []
        candidate.startedAt = null
        candidate.startedBy = null
      }
      touched = true
    }

    if (hasOwn(patch, "parameters")) {
      if (candidate.technique !== "equipment") fail(400, "只有设备项可以改设备参数")
      if (!patch.parameters || typeof patch.parameters !== "object" || Array.isArray(patch.parameters)) {
        fail(400, "设备参数格式不对")
      }
      const type = equipmentTypeById(candidate.equipmentTypeId)
      const merged = {
        ...(candidate.parameters && typeof candidate.parameters === "object" ? candidate.parameters : {}),
        ...patch.parameters,
      }
      const nextParameters = sanitizeEquipmentParameters(type?.id || null, merged)
      if (JSON.stringify(nextParameters) !== JSON.stringify(candidate.parameters || {})) touched = true
      candidate.parameters = nextParameters
    }

    if (hasOwn(patch, "equipmentUnitId")) {
      if (candidate.technique !== "equipment") fail(400, "只有设备项可以改机台")
      const type = equipmentTypeById(candidate.equipmentTypeId)
      if (!type) fail(400, "这项器械没有可切换的设备类型，请删除后重新选择")
      let nextUnitId = patch.equipmentUnitId === null || patch.equipmentUnitId === "" ? null : patch.equipmentUnitId
      if (type.requiresUnit) {
        if (nextUnitId === null) {
          try {
            nextUnitId = chooseEquipmentUnitId(type.id, null, equipmentUsageToday(this, item.id))
          } catch (error) {
            fail(400, error.message)
          }
        } else {
          const unit = equipmentUnitById(nextUnitId)
          if (!unit || unit.equipmentTypeId !== type.id) fail(400, "这台机和设备类型不匹配")
          nextUnitId = unit.id
        }
      } else {
        if (nextUnitId) fail(400, "共享设备不占具体机台")
        nextUnitId = null
      }
      const unitChanged = (item.equipmentUnitId || null) !== nextUnitId
      if (unitChanged && item.startedAt) fail(409, "设备使用中，请先结束使用再换机台")
      if (unitChanged) touched = true
      candidate.equipmentUnitId = nextUnitId
    }

    if (patch.direction) {
      if (!DIRECTIONS.some((row) => row.id === patch.direction)) fail(400, "方向不对")
      if (patch.direction !== candidate.direction) touched = true
      candidate.direction = patch.direction
    }

    if (patch.assigneeId) {
      if (!this.state.staff.some((row) => row.id === patch.assigneeId)) fail(404, "找不到这个人")
      candidate.assigneeId = patch.assigneeId
      patientAssigneeId = patch.assigneeId
    }

    if (hasOwn(patch, "side")) {
      let side = normalizeSide(patch.side)
      // 新写入的器械项不能把可侧化目标的侧别静默清成 null；旧数据仍可原样读取。
      if (candidate.technique === "equipment" && hasSides(targetById(candidate.targetId))) {
        side = side || normalizeSide(entry.chiefSide)
        if (!side) fail(400, "请选择左侧或右侧")
      }
      if (side !== (candidate.side || null)) touched = true
      candidate.side = side
    }

    if (hasOwn(patch, "started")) {
      if (patch.started) {
        if (candidate.equipmentUnitId) {
          const conflict = activeEquipmentConflict(this, candidate.equipmentUnitId, item.id)
          if (conflict) {
            const unitName = equipmentUnitById(candidate.equipmentUnitId)?.name || candidate.equipmentUnitId
            const patientName = conflict.patient?.name || "其他病人"
            fail(409, `${unitName}正在被${patientName}使用，请先结束`)
          }
        }
        if (!candidate.startedAt) {
          candidate.startedAt = new Date().toISOString()
          candidate.startedBy = staff.id
        }
      } else {
        candidate.startedAt = null
        candidate.startedBy = null
      }
    }

    if (typeof patch.done === "boolean") {
      if (patch.done) {
        if (!candidate.done) {
          candidate.done = true
          candidate.completedBy = staff.id
          // 完成时刻跟着项走：交班、对账、事后还原顺序都靠它。
          candidate.completedAt = new Date().toISOString()
        }
        // 完成即释放设备；不依赖前端再发一次 started:false。
        candidate.startedAt = null
        candidate.startedBy = null
      } else {
        candidate.done = false
        candidate.completedBy = null
        candidate.completedAt = null
        // 撤销完成不会自动开始设备；但同一请求显式 started:true 时保留这次启动。
        if (patch.started !== true) {
          candidate.startedAt = null
          candidate.startedBy = null
        }
      }
    }

    if (patch.dose && candidate.technique === "equipment") {
      const sets = Math.max(1, Number(patch.dose.sets ?? candidate.dose?.sets) || 1)
      const reps = Math.max(1, Number(patch.dose.reps ?? candidate.dose?.reps) || 1)
      if (candidate.dose?.sets !== sets || candidate.dose?.reps !== reps) touched = true
      candidate.dose = { sets, reps }
    } else if (patch.dose) {
      const minutes = Math.max(1, Number(patch.dose.minutes ?? candidate.dose?.minutes) || 1)
      if (candidate.dose?.minutes !== minutes) touched = true
      candidate.dose = { minutes }
    }

    Object.assign(item, candidate)
    if (patientAssigneeId) this.patient(entry.patientId).lastAssigneeId = patientAssigneeId
    if (touched) touchDiverged(entry)
    // started/完成状态变化也要推进版本号，但不触发 diverged。
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "改一项", { 项: targetTitle(item.targetId, item.side || null), 改动: patch })
    return this.entryView(deviceId, entry.id)
  },

  removeItem({ deviceId, entryId, itemId, expectedVersion }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    // 删除也带期望版本：别人刚改过这张单时别盲目删，让客户端重拉后再说。
    assertExpectedVersion(entry, expectedVersion)
    const item = entry.items.find((item) => item.id === itemId)
    if (item?.startedAt) fail(409, "设备仍在使用，请先结束使用再删除")
    entry.items = entry.items.filter((item) => item.id !== itemId)
    touchDiverged(entry)
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "去掉一项", { 项: item ? targetTitle(item.targetId, item.side || null) : itemId })
    return this.entryView(deviceId, entry.id)
  },

  // 撤销删除：把快照插回原位，派工和完成状态原样保留，但换新 id。
  restoreItem({ deviceId, entryId, index, item, afterIds }) {
    this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    // 撤销只对「删完之后」的清单负责：别人又加/删/重排过，老位置就不再可靠，
    // 宁可提示手动加回，也不把项插到语义错位的地方。
    if (Array.isArray(afterIds)) {
      const currentIds = entry.items.map((row) => row.id)
      if (currentIds.length !== afterIds.length || currentIds.some((id, at) => id !== afterIds[at])) {
        fail(409, "别人刚改过这张单，这一项没法自动放回，请在加项里重新点")
      }
    }
    const at = Number(index)
    if (!Number.isInteger(at) || at < 0 || at > entry.items.length) fail(400, "插回位置不对")
    if (!item || typeof item !== "object") fail(400, "缺少要插回的项")
    if (item.technique && !TECHNIQUES.some((row) => row.id === item.technique)) fail(400, "手法不对")
    if (item.direction && !DIRECTIONS.some((row) => row.id === item.direction)) fail(400, "方向不对")
    const technique = item.technique || "massage"
    if (technique === "equipment") equipmentTargetOrThrow(item.targetId)
    else workTargetOrThrow(item.targetId)
    const focus = focusOf(entry)
    const conditionId =
      typeof item.conditionId === "string" && entry.conditionIds.includes(item.conditionId)
        ? item.conditionId
        : focus
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
      ...equipmentFieldsOf(item),
      assigneeId: typeof item.assigneeId === "string" ? item.assigneeId : null,
      done: Boolean(item.done),
      completedBy: typeof item.completedBy === "string" ? item.completedBy : null,
      completedAt: item.done && typeof item.completedAt === "string" ? item.completedAt : null,
      // 撤销不恢复旧锁：被删时若还在使用，插回后必须重新确认机台空闲再开始。
      startedAt: null,
      startedBy: null,
    }
    entry.items.splice(at, 0, restored)
    touchDiverged(entry)
    bumpEntryVersion(entry)
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
    touchDiverged(entry)
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

  // 移交责任人不等于结束治疗；保留真实设备占用及最初开始者。
  reassignOpen({ deviceId, fromStaffId, toStaffId }) {
    this.requireStaff(deviceId)
    const from = this.state.staff.find((person) => person.id === fromStaffId) || null
    const to = this.state.staff.find((person) => person.id === toStaffId) || null
    if (!from || !to) fail(404, "找不到这个人")
    if (from.id === to.id) fail(400, "不能移交给自己")

    const changedPatients = new Set()
    let count = 0
    for (const entry of this.todayRecord().entries || []) {
      let changed = false
      for (const item of entry.items || []) {
        if (!item || item.done || item.assigneeId !== from.id) continue
        item.assigneeId = to.id
        changedPatients.add(entry.patientId)
        changed = true
        count += 1
      }
      if (changed) bumpEntryVersion(entry)
    }
    for (const patientId of changedPatients) {
      const patient = this.state.patients.find((row) => row.id === patientId)
      if (patient) patient.lastAssigneeId = to.id
    }
    this.save()
    this.audit(deviceId, "移交未完成", { 从: from.name, 到: to.name, 项数: count })
    // 用只读 todayRecord 遍历，count=0 时不会凭空建一个空天。
    return {
      ...this.view(deviceId),
      handoff: { fromStaffId: from.id, toStaffId: to.id, count },
    }
  },

  dropEntry({ deviceId, entryId }) {
    this.requireStaff(deviceId)
    // 只读地找：拿掉不存在的条目时别顺手创建一个空的「今天」。
    const day = this.todayRecord()
    const entry = day.entries.find((item) => item.id === entryId)
    if (!entry) fail(404, "今天没有这张单")
    if (entry.items.some((item) => item.startedAt)) fail(409, "设备仍在使用，请先结束使用再拿掉今日单")
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
      ...equipmentFieldsOf(item),
    }))
    for (const [index, item] of mine.entries()) {
      item.sourceItemId = condition.items[index].id
    }
    if (entry.conditionIds.length === 1 || condition.fresh) {
      condition.chiefSiteId = entry.chiefSiteId
      condition.chiefSide = entry.chiefSide || null
    }
    condition.fresh = false
    condition.sequential = Boolean(entry.sequential)
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
    // 答过这一轮就不再问：再改动（leaveAsk 重新亮起）前，反复进出病人页都直接走。
    entry.divergedAcked = !updateCondition
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
    // 单人治疗室里挂进来的档案项照旧记在那个人名下。
    const soloStaffId = this.state.staff.length === 1 ? this.state.staff[0].id : null
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
        ...equipmentFieldsOf(item),
        assigneeId: soloStaffId,
        done: false,
        completedBy: null,
        completedAt: null,
        startedAt: null,
        startedBy: null,
      })
    }
    entry.focusConditionId = conditionId
    bumpEntryVersion(entry)
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
        ...equipmentFieldsOf(item),
      })),
    })
    this.save()
    this.audit(deviceId, fromToday ? "从今天复制病症" : "复制病症", { 病症: source.name, 到: target.name })
    return this.view(deviceId)
  },
}
