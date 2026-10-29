// 病人页的纯函数和常量：不碰 React、不碰 this，好测好搬。
import { techniqueLabel, directionLabel, doseLabel, hasSides, targetById, targetTitle } from "@shared/catalog.js"

export const blankNotice = { text: "", tone: "ok" }
export const pastMidnightNotice = {
  text: "已经是新的一天。回到今日单后，可在加入病人里把昨天未完成接进今天。",
  tone: "error",
}
export const removePast = 72

export function isPastMidnightError(err) {
  return typeof err?.message === "string" && err.message.includes("过了零点")
}

export function isConflictError(err) {
  return err?.status === 409 || (typeof err?.message === "string" && err.message.includes("别人刚改过"))
}

export function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export function stepsFrom(delta, size) {
  if (!size) return 0
  const raw = delta / size
  if (raw === 0) return 0
  return Math.trunc(raw + Math.sign(raw) * 0.5)
}

export function numeric(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function conditionText(entry) {
  return (entry.conditionIds || [])
    .map((id) => entry.conditions?.find((condition) => condition.id === id)?.name)
    .filter(Boolean)
    .join("、")
}

// 撤销恢复用的持久化字段快照（不含界面展示名）。
export function itemSnapshot(item) {
  return {
    id: item.id,
    conditionId: item.conditionId,
    sourceItemId: item.sourceItemId ?? null,
    targetId: item.targetId,
    side: item.side || null,
    technique: item.technique,
    direction: item.direction,
    dose: item.dose == null ? item.dose : structuredClone(item.dose),
    assigneeId: item.assigneeId || null,
    done: Boolean(item.done),
    completedBy: item.completedBy || null,
    completedAt: item.completedAt || null,
  }
}

// 完成时刻只看时分：条目行和来过几次都印「HH:MM」。
export function clockOf(iso) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ""
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
}

export function itemLine(item) {
  // 派给谁单独成钮，不塞进这一行说明。
  const doneBit = item.done && item.completedByName
    ? `${item.completedByName}完成${item.completedAt ? ` ${clockOf(item.completedAt)}` : ""}`
    : ""
  return [
    techniqueLabel(item.technique),
    directionLabel(item.direction),
    doseLabel(item.technique, item.dose),
    doneBit,
  ]
    .filter(Boolean)
    .join(" · ")
}

export function originElement(target) {
  if (target instanceof Element) return target
  return target?.parentElement || null
}


// 设备项：列表、操作卡和快捷预览共用同一套“人话”摘要，避免每处各拼一遍。
export function isEquipmentItem(item) {
  return Boolean(item && (item.technique === "equipment" || item.equipmentTypeId || item.exerciseTemplateId))
}

function findEquipmentType(item, equipmentTypes) {
  return (equipmentTypes || []).find((type) => type?.id === item?.equipmentTypeId) || null
}

function findExerciseTemplate(item, exerciseTemplates) {
  return (exerciseTemplates || []).find((template) => template?.id === item?.exerciseTemplateId) || null
}

function optionLabel(field, value) {
  const option = (field?.options || []).find((row) => (typeof row === "string" ? row : row.value) === value)
  return typeof option === "string" ? option : option?.label || String(value)
}

function parameterValueLabel(field, value) {
  if (field?.type === "select") return optionLabel(field, value)
  return `${value}${field?.unit ? ` ${field.unit}` : ""}`
}

// 只展示 schema 允许的字段；旧数据没有 schema 时退回安全标量，不让空对象变成“参数”。
export function equipmentParameterSummary(item, equipmentTypes) {
  const parameters = item?.parameters && typeof item.parameters === "object" ? item.parameters : {}
  const type = findEquipmentType(item, equipmentTypes)
  if (type?.parameterSchema?.length) {
    return type.parameterSchema
      .filter((field) => parameters[field.key] !== undefined && parameters[field.key] !== null && parameters[field.key] !== "")
      .map((field) => `${field.label} ${parameterValueLabel(field, parameters[field.key])}`)
      .join(" · ")
  }
  return Object.entries(parameters)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ")
}

// 选设备时还没入库：把 schema 默认值显示出来，和服务端稍后实际落库的值一致。
export function equipmentDefaultParameterSummary(type) {
  const defaults = type?.defaultParameters || {}
  if (!type?.parameterSchema?.length) return ""
  return type.parameterSchema
    .filter((field) => defaults[field.key] !== undefined)
    .map((field) => `${field.label} ${parameterValueLabel(field, defaults[field.key])}`)
    .join(" · ")
}

export function equipmentItemName(item, equipmentTypes, exerciseTemplates) {
  const template = findExerciseTemplate(item, exerciseTemplates)
  if (template?.name) return template.name
  const type = findEquipmentType(item, equipmentTypes)
  return type?.name || item?.equipmentTypeName || item?.equipmentSummary || "器械"
}

// 快捷预览用：动作模板名优先于设备名，再补机台和参数。
export function equipmentItemSummary(item, equipmentTypes, exerciseTemplates) {
  const type = findEquipmentType(item, equipmentTypes)
  const template = findExerciseTemplate(item, exerciseTemplates)
  const parts = [equipmentItemName(item, equipmentTypes, exerciseTemplates)]
  if (item?.equipmentUnitName) parts.push(item.equipmentUnitName)
  if (item?.exerciseName && item.exerciseName !== parts[0]) parts.push(item.exerciseName)
  // 语音预览发生在入库前：按“模板默认 < 设备默认 < 用户已说参数”合并，预览就是服务端将落库的值。
  const previewParameters = {
    ...(type?.defaultParameters || {}),
    ...(template?.defaultParameters || {}),
    ...(item?.parameters && typeof item.parameters === "object" ? item.parameters : {}),
  }
  const parameterText = equipmentParameterSummary({ ...item, parameters: previewParameters }, equipmentTypes)
  if (parameterText) parts.push(parameterText)
  return [...new Set(parts.filter(Boolean))].join(" · ")
}

// 任务卡标题保留主 target；关联 target 去重后单独一行，不把主 target 重复印两遍。
export function linkedTargetTitles(item) {
  const primary = targetTitle(item?.targetId, item?.side || null)
  const raw = Array.isArray(item?.linkedTargetTitles)
    ? item.linkedTargetTitles
    : Array.isArray(item?.linkedTargets)
      ? item.linkedTargets.map((row) => targetTitle(row.targetId, row.side || null))
      : []
  const seen = new Set([primary])
  const result = []
  for (const title of raw) {
    const text = String(title || "").trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

// 语音解析可能给出可侧化 target 的 side=null；定主诉侧能沿用就沿用，
// 否则拆成明确的左右两项。快捷预览和提交前都跑这一层，保证不会把 null 写进新项。
export function normalizeQuickOrderSides(parsed, options = {}) {
  if (!parsed || !Array.isArray(parsed.items)) return parsed
  const currentChiefSide = options.chiefSide === "left" || options.chiefSide === "right" ? options.chiefSide : null
  let fallbackSide = currentChiefSide
  const nextChief = parsed.chief?.targetId ? targetById(parsed.chief.targetId) : null
  if (nextChief) {
    const explicitChiefSide = hasSides(nextChief) && (parsed.chief.side === "left" || parsed.chief.side === "right")
      ? parsed.chief.side
      : null
    if (explicitChiefSide) fallbackSide = explicitChiefSide
    else if (nextChief.id !== options.chiefSiteId) fallbackSide = null
  }
  const items = []
  for (const item of parsed.items) {
    const target = targetById(item?.targetId)
    if (!target || !hasSides(target)) {
      items.push({ ...item, side: null })
      continue
    }
    const explicitSide = item.side === "left" || item.side === "right" ? item.side : null
    if (explicitSide) {
      items.push({ ...item, side: explicitSide })
      continue
    }
    if (fallbackSide) {
      items.push({ ...item, side: fallbackSide })
      continue
    }
    items.push({ ...item, side: "left" }, { ...item, side: "right" })
  }
  return { ...parsed, items }
}
