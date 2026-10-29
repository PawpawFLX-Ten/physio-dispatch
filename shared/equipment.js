// 治疗室设备与动作模板的唯一目录：服务端校验、投影和客户端选择共用这一份。
// 这里不保存库存数量等运行时状态；今日占用情况由 store 按 equipmentUnitId 汇总后传入。
import { allowsEquipment, TARGETS, targetById } from "./catalog.js"

const workTargetIds = TARGETS.filter((target) => allowsEquipment(target)).map((target) => target.id)

// 参数控件的 schema 就是前端渲染和导入清洗共用的契约：
// number 用 min/max/step/unit，select 用 options；default 始终是合法值。
const SHOCKWAVE_SCHEMA = [
  { key: "energy", label: "能量密度", type: "number", default: 2, min: 0.1, max: 10, step: 0.1, unit: "mJ/mm²" },
  { key: "frequency", label: "频率", type: "number", default: 10, min: 1, max: 25, step: 1, unit: "Hz" },
  { key: "pulses", label: "脉冲次数", type: "number", default: 2000, min: 100, max: 10000, step: 100, unit: "次" },
]

const ULTRASOUND_SCHEMA = [
  { key: "intensity", label: "强度", type: "number", default: 1, min: 0.1, max: 3, step: 0.1, unit: "W/cm²" },
  { key: "frequencyMHz", label: "频率", type: "number", default: 1, min: 1, max: 3, step: 1, unit: "MHz" },
  {
    key: "mode",
    label: "模式",
    type: "select",
    default: "continuous",
    options: [
      { value: "continuous", label: "连续" },
      { value: "pulsed", label: "脉冲" },
    ],
  },
  { key: "minutes", label: "时长", type: "number", default: 8, min: 1, max: 30, step: 1, unit: "分钟" },
]

const ELECTROTHERAPY_SCHEMA = [
  {
    key: "program",
    label: "程序",
    type: "select",
    default: "tens",
    options: [
      { value: "tens", label: "TENS" },
      { value: "ems", label: "EMS" },
      { value: "interferential", label: "干扰电" },
    ],
  },
  { key: "intensity", label: "强度", type: "number", default: 20, min: 0, max: 100, step: 1, unit: "mA" },
  { key: "minutes", label: "时长", type: "number", default: 20, min: 1, max: 60, step: 1, unit: "分钟" },
]

const TRACTION_BED_SCHEMA = [
  { key: "forceKg", label: "牵引力", type: "number", default: 20, min: 1, max: 80, step: 1, unit: "kg" },
  { key: "minutes", label: "时长", type: "number", default: 20, min: 1, max: 60, step: 1, unit: "分钟" },
  {
    key: "mode",
    label: "模式",
    type: "select",
    default: "intermittent",
    options: [
      { value: "intermittent", label: "间歇" },
      { value: "continuous", label: "持续" },
    ],
  },
]

const ELASTIC_BAND_SCHEMA = [
  {
    key: "resistance",
    label: "阻力",
    type: "select",
    default: "light",
    options: [
      { value: "light", label: "轻" },
      { value: "medium", label: "中" },
      { value: "heavy", label: "重" },
    ],
  },
]

const ISOKINETIC_SCHEMA = [
  { key: "speed", label: "角速度", type: "number", default: 60, min: 10, max: 300, step: 5, unit: "°/s" },
  {
    key: "mode",
    label: "模式",
    type: "select",
    default: "concentric",
    options: [
      { value: "concentric", label: "向心" },
      { value: "eccentric", label: "离心" },
    ],
  },
]

function defaultsFromSchema(schema) {
  return Object.fromEntries(schema.map((field) => [field.key, field.default]))
}

// 6 类设备。requiresUnit=false 表示共享设备，不占具体机台，也不允许写 equipmentUnitId。
export const EQUIPMENT_TYPES = [
  {
    id: "shockwave",
    name: "冲击波",
    shortName: "冲击波",
    aliases: ["冲击波", "冲击波治疗", "冲击波仪"],
    category: "device",
    categoryLabel: "设备",
    technique: "equipment",
    doseMode: "parameters",
    requiresUnit: true,
    unitIds: ["shockwave-1"],
    compatibleTargetIds: workTargetIds,
    parameterSchema: SHOCKWAVE_SCHEMA,
    defaultParameters: defaultsFromSchema(SHOCKWAVE_SCHEMA),
  },
  {
    id: "ultrasound",
    name: "超声",
    shortName: "超声",
    aliases: ["超声", "超声波"],
    category: "device",
    categoryLabel: "设备",
    technique: "equipment",
    doseMode: "parameters",
    requiresUnit: true,
    unitIds: ["ultrasound-1", "ultrasound-2"],
    compatibleTargetIds: workTargetIds,
    parameterSchema: ULTRASOUND_SCHEMA,
    defaultParameters: defaultsFromSchema(ULTRASOUND_SCHEMA),
  },
  {
    id: "electrotherapy",
    name: "电疗",
    shortName: "电疗",
    aliases: ["电疗", "中频", "低频", "干扰电"],
    category: "device",
    categoryLabel: "设备",
    technique: "equipment",
    doseMode: "parameters",
    requiresUnit: true,
    unitIds: ["electrotherapy-1"],
    compatibleTargetIds: workTargetIds,
    parameterSchema: ELECTROTHERAPY_SCHEMA,
    defaultParameters: defaultsFromSchema(ELECTROTHERAPY_SCHEMA),
  },
  {
    id: "traction-bed",
    name: "牵引床",
    shortName: "牵引",
    aliases: ["牵引", "牵引床"],
    category: "device",
    categoryLabel: "设备",
    technique: "equipment",
    doseMode: "parameters",
    requiresUnit: true,
    unitIds: ["traction-bed-1", "traction-bed-2"],
    compatibleTargetIds: workTargetIds,
    parameterSchema: TRACTION_BED_SCHEMA,
    defaultParameters: defaultsFromSchema(TRACTION_BED_SCHEMA),
  },
  {
    id: "elastic-band",
    name: "弹力带",
    shortName: "弹力带",
    aliases: ["弹力带", "弹力绳"],
    category: "shared",
    categoryLabel: "共享设备",
    technique: "equipment",
    doseMode: "setsReps",
    requiresUnit: false,
    unitIds: [],
    compatibleTargetIds: workTargetIds,
    parameterSchema: ELASTIC_BAND_SCHEMA,
    defaultParameters: defaultsFromSchema(ELASTIC_BAND_SCHEMA),
  },
  {
    id: "isokinetic",
    name: "等速机",
    shortName: "等速",
    aliases: ["等速", "等速机"],
    category: "device",
    categoryLabel: "设备",
    technique: "equipment",
    doseMode: "setsReps",
    requiresUnit: true,
    unitIds: ["isokinetic-1"],
    compatibleTargetIds: workTargetIds,
    parameterSchema: ISOKINETIC_SCHEMA,
    defaultParameters: defaultsFromSchema(ISOKINETIC_SCHEMA),
  },
]

// 7 个可排班机台；弹力带是共享设备，没有 unit。
export const EQUIPMENT_UNITS = [
  { id: "shockwave-1", equipmentTypeId: "shockwave", name: "冲击波 1 号机", order: 1 },
  { id: "ultrasound-1", equipmentTypeId: "ultrasound", name: "超声 1 号机", order: 1 },
  { id: "ultrasound-2", equipmentTypeId: "ultrasound", name: "超声 2 号机", order: 2 },
  { id: "electrotherapy-1", equipmentTypeId: "electrotherapy", name: "电疗 1 号机", order: 1 },
  { id: "traction-bed-1", equipmentTypeId: "traction-bed", name: "牵引床 1 号机", order: 1 },
  { id: "traction-bed-2", equipmentTypeId: "traction-bed", name: "牵引床 2 号机", order: 2 },
  { id: "isokinetic-1", equipmentTypeId: "isokinetic", name: "等速机 1 号机", order: 1 },
]

const TEMPLATE_TARGETS = {
  kneeExtension: [{ targetId: "quad", side: null }],
  shoulderExternalRotation: [
    { targetId: "infraspinatus", side: null },
    { targetId: "shoulder", side: null },
  ],
  bandRow: [
    { targetId: "rhomboid", side: null },
    { targetId: "trapezius", side: null },
  ],
  isokineticKnee: [
    { targetId: "quad", side: null },
    { targetId: "hamstring", side: null },
  ],
  isokineticShoulder: [
    { targetId: "shoulder", side: null },
    { targetId: "supraspinatus", side: null },
    { targetId: "infraspinatus", side: null },
  ],
}

// 动作模板定义“选了这个动作，默认练哪些目标、用什么参数”；side 在业务请求时按主诉侧补齐。
export const EXERCISE_TEMPLATES = [
  {
    id: "band-terminal-knee-extension",
    name: "弹力带终末伸膝",
    equipmentTypeId: "elastic-band",
    technique: "equipment",
    linkedTargets: TEMPLATE_TARGETS.kneeExtension,
    compatibleTargetIds: ["quad"],
    defaultDirection: "along",
    defaultDose: { sets: 3, reps: 10 },
    defaultParameters: { ...defaultsFromSchema(ELASTIC_BAND_SCHEMA), resistance: "light" },
  },
  {
    id: "band-shoulder-external-rotation",
    name: "弹力带肩外旋",
    equipmentTypeId: "elastic-band",
    technique: "equipment",
    linkedTargets: TEMPLATE_TARGETS.shoulderExternalRotation,
    compatibleTargetIds: ["infraspinatus", "shoulder"],
    defaultDirection: "outward",
    defaultDose: { sets: 3, reps: 12 },
    defaultParameters: { ...defaultsFromSchema(ELASTIC_BAND_SCHEMA), resistance: "light" },
  },
  {
    id: "band-row",
    name: "弹力带划船",
    equipmentTypeId: "elastic-band",
    technique: "equipment",
    linkedTargets: TEMPLATE_TARGETS.bandRow,
    compatibleTargetIds: ["rhomboid", "trapezius"],
    defaultDirection: "inward",
    defaultDose: { sets: 3, reps: 12 },
    defaultParameters: { ...defaultsFromSchema(ELASTIC_BAND_SCHEMA), resistance: "medium" },
  },
  {
    id: "isokinetic-knee",
    name: "等速膝",
    equipmentTypeId: "isokinetic",
    technique: "equipment",
    linkedTargets: TEMPLATE_TARGETS.isokineticKnee,
    compatibleTargetIds: ["quad", "hamstring"],
    defaultDirection: "along",
    defaultDose: { sets: 3, reps: 10 },
    defaultParameters: { ...defaultsFromSchema(ISOKINETIC_SCHEMA) },
  },
  {
    id: "isokinetic-shoulder",
    name: "等速肩",
    equipmentTypeId: "isokinetic",
    technique: "equipment",
    linkedTargets: TEMPLATE_TARGETS.isokineticShoulder,
    compatibleTargetIds: ["shoulder", "supraspinatus", "infraspinatus"],
    defaultDirection: "along",
    defaultDose: { sets: 3, reps: 10 },
    defaultParameters: { ...defaultsFromSchema(ISOKINETIC_SCHEMA) },
  },
]

export const equipmentTypes = EQUIPMENT_TYPES
export const equipmentUnits = EQUIPMENT_UNITS
export const exerciseTemplates = EXERCISE_TEMPLATES

export function equipmentTypeById(typeId) {
  return EQUIPMENT_TYPES.find((type) => type.id === typeId) || null
}

export function equipmentUnitById(unitId) {
  return EQUIPMENT_UNITS.find((unit) => unit.id === unitId) || null
}

export function exerciseTemplateById(templateId) {
  return EXERCISE_TEMPLATES.find((template) => template.id === templateId) || null
}

// byId 同时提供完整单词和短别名，调用点不用记目录名。
export const byId = Object.freeze({
  equipmentType: equipmentTypeById,
  equipmentUnit: equipmentUnitById,
  exerciseTemplate: exerciseTemplateById,
  type: equipmentTypeById,
  unit: equipmentUnitById,
  template: exerciseTemplateById,
})

export function unitsForEquipmentType(typeId) {
  return EQUIPMENT_UNITS.filter((unit) => unit.equipmentTypeId === typeId).sort((left, right) => left.order - right.order)
}

export function equipmentSupportsUnit(typeId) {
  return Boolean(equipmentTypeById(typeId)?.requiresUnit)
}

export function isEquipmentType(typeId) {
  return Boolean(equipmentTypeById(typeId))
}

export function defaultParametersForEquipmentType(typeId) {
  const type = equipmentTypeById(typeId)
  return type ? structuredClone(type.defaultParameters) : {}
}

function optionValues(field) {
  return Array.isArray(field.options) ? field.options.map((option) => (typeof option === "string" ? option : option.value)) : []
}

function sanitizeParameterValue(field, value) {
  if (value === undefined || value === null || value === "") return field.default
  if (field.type === "number") {
    const number = Number(value)
    if (!Number.isFinite(number)) return field.default
    const min = Number.isFinite(field.min) ? field.min : -Infinity
    const max = Number.isFinite(field.max) ? field.max : Infinity
    return Math.min(max, Math.max(min, number))
  }
  if (field.type === "select") {
    const normalized = String(value)
    return optionValues(field).includes(normalized) ? normalized : field.default
  }
  if (field.type === "boolean") return typeof value === "boolean" ? value : Boolean(field.default)
  return String(value).trim().slice(0, 200) || String(field.default ?? "")
}

function sanitizeGenericParameters(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const cleaned = {}
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(key)) continue
    if (typeof value === "string") cleaned[key] = value.slice(0, 200)
    else if (typeof value === "number" && Number.isFinite(value)) cleaned[key] = value
    else if (typeof value === "boolean") cleaned[key] = value
  }
  return cleaned
}

// 已知设备按 schema 补默认值、钳数值、丢弃非法枚举；未知/旧设备只保留安全标量。
export function sanitizeEquipmentParameters(typeId, input) {
  const type = equipmentTypeById(typeId)
  if (!type) return sanitizeGenericParameters(input)
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {}
  // 兼容语音解析曾使用的 shots 写法；对外 schema/存储统一是 pulses。
  const source =
    type.id === "shockwave" && raw.pulses === undefined && raw.shots !== undefined
      ? { ...raw, pulses: raw.shots }
      : raw
  const cleaned = {}
  for (const field of type.parameterSchema) {
    cleaned[field.key] = sanitizeParameterValue(field, source[field.key])
  }
  return cleaned
}

export const sanitizeParameters = sanitizeEquipmentParameters

function normalizeSideValue(side) {
  return side === "left" || side === "right" ? side : null
}

// linkedTargets 是“这个动作还关联了哪些部位”的稳定数组；旧数据的 side=null 允许保留。
// strictSide=true 由服务端新写入路径使用，缺侧会抛错；导入路径用 false 兼容旧档。
export function sanitizeLinkedTargets(input, options = {}) {
  const { fallbackSide = null, strictSide = false } = options
  if (!Array.isArray(input)) return []
  const fallback = normalizeSideValue(fallbackSide)
  const cleaned = []
  const seen = new Set()
  for (const row of input) {
    if (!row || typeof row !== "object") continue
    const targetId = typeof row.targetId === "string" ? row.targetId : ""
    const target = targetById(targetId)
    if (!target || target.kind === "site") continue
    let side = normalizeSideValue(row.side)
    if (!side && fallback) side = fallback
    if (target.id === "lumbar" || target.id === "neck") side = null
    if (strictSide && target.id !== "lumbar" && target.id !== "neck" && !side) {
      const error = new Error("请选择左侧或右侧")
      error.code = "SIDE_REQUIRED"
      throw error
    }
    const key = `${targetId}:${side || ""}`
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push({ targetId, side: side || null })
  }
  return cleaned
}

export function templateLinkedTargets(templateOrId, side = null) {
  const template = typeof templateOrId === "string" ? exerciseTemplateById(templateOrId) : templateOrId
  if (!template) return []
  return sanitizeLinkedTargets(template.linkedTargets, { fallbackSide: side, strictSide: false })
}

export function targetsCompatibleWithEquipmentType(typeId) {
  const type = equipmentTypeById(typeId)
  if (!type) return []
  return type.compatibleTargetIds.map((targetId) => targetById(targetId)).filter(Boolean)
}

export function targetsCompatibleWithExerciseTemplate(templateOrId) {
  const template = typeof templateOrId === "string" ? exerciseTemplateById(templateOrId) : templateOrId
  if (!template) return []
  return template.compatibleTargetIds.map((targetId) => targetById(targetId)).filter(Boolean)
}

export function isTargetCompatibleWithEquipmentType(typeId, targetId) {
  const type = equipmentTypeById(typeId)
  return Boolean(type && type.compatibleTargetIds.includes(targetId))
}

export function isTargetCompatibleWithExerciseTemplate(templateOrId, targetId) {
  const template = typeof templateOrId === "string" ? exerciseTemplateById(templateOrId) : templateOrId
  return Boolean(template && template.compatibleTargetIds.includes(targetId))
}

// 自动排机台：显式请求必须属于该设备；否则按今天已有占用数少的机台优先，平手按目录顺序。
// usageByUnit 形如 { "ultrasound-1": 2 }，只用于选机，不改变机台是否可重复使用。
export function chooseEquipmentUnitId(typeId, requestedUnitId = null, usageByUnit = {}) {
  const type = equipmentTypeById(typeId)
  if (!type) throw new Error("找不到设备类型")
  if (!type.requiresUnit) {
    if (requestedUnitId) throw new Error("共享设备不需要选择机台")
    return null
  }
  const units = unitsForEquipmentType(type.id)
  if (requestedUnitId !== undefined && requestedUnitId !== null && requestedUnitId !== "") {
    const unit = equipmentUnitById(requestedUnitId)
    if (!unit || unit.equipmentTypeId !== type.id) throw new Error("这台机和设备类型不匹配")
    return unit.id
  }
  if (!units.length) return null
  const usage = usageByUnit && typeof usageByUnit === "object" ? usageByUnit : {}
  return [...units].sort((left, right) => {
    const diff = (Number(usage[left.id]) || 0) - (Number(usage[right.id]) || 0)
    return diff || left.order - right.order
  })[0].id
}

export function autoAssignEquipmentUnit(typeId, requestedUnitId = null, usageByUnit = {}) {
  const unitId = chooseEquipmentUnitId(typeId, requestedUnitId, usageByUnit)
  return equipmentUnitById(unitId)
}

export function equipmentTypeName(typeId) {
  return equipmentTypeById(typeId)?.name || ""
}

export function equipmentUnitName(unitId) {
  return equipmentUnitById(unitId)?.name || ""
}

export function exerciseTemplateName(templateId) {
  return exerciseTemplateById(templateId)?.name || ""
}

function parameterLabel(typeId, key, value) {
  const field = equipmentTypeById(typeId)?.parameterSchema.find((row) => row.key === key)
  if (!field) return String(value)
  if (field.type === "select") {
    const option = field.options.find((row) => (typeof row === "string" ? row : row.value) === value)
    return typeof option === "string" ? option : option?.label || String(value)
  }
  return `${value}${field.unit ? ` ${field.unit}` : ""}`
}

// 给列表行和 todayByEquipment 用的一段可读摘要，不依赖前端再拼一遍字段。
export function equipmentSummaryForItem(item) {
  const type = equipmentTypeById(item?.equipmentTypeId)
  const unit = equipmentUnitById(item?.equipmentUnitId)
  const template = exerciseTemplateById(item?.exerciseTemplateId)
  const parts = []
  if (template) parts.push(template.name)
  else if (type) parts.push(type.name)
  else if (item?.technique === "equipment") parts.push("器械")
  if (unit) parts.push(unit.name)
  if (type && item?.parameters && typeof item.parameters === "object") {
    for (const field of type.parameterSchema) {
      const value = item.parameters[field.key]
      if (value === undefined || value === null || value === "") continue
      parts.push(`${field.label} ${parameterLabel(type.id, field.key, value)}`)
    }
  }
  if (type?.doseMode === "setsReps" && item?.dose) {
    const sets = Number(item.dose.sets)
    const reps = Number(item.dose.reps)
    if (Number.isFinite(sets) && Number.isFinite(reps) && sets > 0 && reps > 0) {
      parts.push(`${sets} 组 × ${reps} 次`)
    }
  }
  return parts.join(" · ")
}

export function equipmentCatalogSnapshot() {
  return {
    equipmentTypes: structuredClone(EQUIPMENT_TYPES),
    equipmentUnits: structuredClone(EQUIPMENT_UNITS),
    exerciseTemplates: structuredClone(EXERCISE_TEMPLATES),
  }
}
