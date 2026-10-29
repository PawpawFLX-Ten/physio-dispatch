// 数据层的纯函数和公共小工具：不碰 this、不碰文件。
import crypto from "node:crypto"
import { DIRECTIONS, TECHNIQUES, clampDose } from "../shared/catalog.js"
import {
  equipmentTypeById,
  equipmentUnitById,
  exerciseTemplateById,
  sanitizeEquipmentParameters,
  sanitizeLinkedTargets,
} from "../shared/equipment.js"
import { sanitizePairings } from "../shared/pairings.js"

export function id() {
  return crypto.randomUUID()
}

export function two(n) {
  return String(n).padStart(2, "0")
}

// Intl 构造不便宜，一次请求里会问好几次「今天几号」：formatter 只建一次。
const shanghaiDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })

export function todayKey(date = new Date()) {
  return shanghaiDay.format(date)
}

export function emptyState() {
  return {
    staff: [],
    devices: {},
    patients: [],
    templates: [],
    days: {},
    lastExportAt: null,
    // 常见搭配表：null = 没在设置里改过，读侧回退 shared/pairings.js 的默认。
    pairings: null,
  }
}

export function normalizeSide(side) {
  if (side === "left" || side === "right") return side
  return null
}

// 新设备字段进入工作签名：离开病人页时才能判断器械/参数/关联目标是否改过。
// 参数对象按 key 排序，避免只是对象插入顺序不同就误报“偏离病症”。
export function workSignature(item) {
  const parameters =
    item.parameters && typeof item.parameters === "object" && !Array.isArray(item.parameters)
      ? Object.fromEntries(Object.keys(item.parameters).sort().map((key) => [key, item.parameters[key]]))
      : {}
  return JSON.stringify({
    targetId: item.targetId,
    side: item.side || null,
    technique: item.technique,
    direction: item.direction,
    dose: item.dose,
    equipmentTypeId: item.equipmentTypeId || null,
    equipmentUnitId: item.equipmentUnitId || null,
    exerciseTemplateId: item.exerciseTemplateId || null,
    parameters,
    linkedTargets: sanitizeLinkedTargets(item.linkedTargets, { strictSide: false }),
  })
}

// 导入/读盘共用的器械字段形状：非法类型/机台/模板降级为空，不丢掉整条旧任务。
function sanitizeItemEquipment(item, technique) {
  if (technique !== "equipment") {
    return {
      equipmentTypeId: null,
      equipmentUnitId: null,
      exerciseTemplateId: null,
      parameters: {},
      linkedTargets: [],
    }
  }
  let type = equipmentTypeById(item.equipmentTypeId)
  let template = exerciseTemplateById(item.exerciseTemplateId)
  if (template) {
    if (!type) type = equipmentTypeById(template.equipmentTypeId)
    else if (type.id !== template.equipmentTypeId) template = null
  }
  let unit = equipmentUnitById(item.equipmentUnitId)
  if (!type && unit) type = equipmentTypeById(unit.equipmentTypeId)
  if (unit && (!type || !type.requiresUnit || unit.equipmentTypeId !== type.id)) unit = null
  let linkedTargets = sanitizeLinkedTargets(item.linkedTargets, { strictSide: false })
  if (template) {
    linkedTargets = linkedTargets.filter((link) => template.compatibleTargetIds.includes(link.targetId))
  }
  return {
    equipmentTypeId: type?.id || null,
    equipmentUnitId: type?.requiresUnit ? unit?.id || null : null,
    exerciseTemplateId: template?.id || null,
    parameters: sanitizeEquipmentParameters(type?.id || null, item.parameters),
    linkedTargets,
  }
}

// 病症档案项与今日项共用这层清洗；side=null 是合法旧数据，不在这里强补侧别。
function sanitizeConditionItem(item) {
  const technique = TECHNIQUES.some((row) => row.id === item.technique) ? item.technique : "massage"
  return {
    ...item,
    side: normalizeSide(item.side),
    technique,
    dose: clampDose(technique, item.dose),
    ...sanitizeItemEquipment(item, technique),
  }
}

export function fail(status, message) {
  const error = new Error(message)
  error.status = status
  throw error
}

/** 今日单条目版本：旧数据缺省按 0。 */
export function entryVersion(entry) {
  const n = Number(entry?.version)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/** 带了期望版本才校验；不带则兼容旧客户端。 */
export function assertExpectedVersion(entry, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === "") return
  const expected = Number(expectedVersion)
  if (!Number.isFinite(expected)) fail(400, "版本号不对")
  if (entryVersion(entry) !== Math.floor(expected)) {
    fail(409, "别人刚改过这张单，请重新拉取")
  }
}

export function bumpEntryVersion(entry) {
  entry.version = entryVersion(entry) + 1
}

function sanitizeStaff(person) {
  if (!person || typeof person !== "object") return null
  if (typeof person.id !== "string" || !person.id || typeof person.name !== "string" || !person.name.trim()) return null
  return { id: person.id, name: person.name.trim() }
}

function sanitizePatient(patient, staffIds) {
  if (!patient || typeof patient !== "object") return null
  if (typeof patient.id !== "string" || !patient.id || typeof patient.name !== "string" || !patient.name.trim()) return null
  const conditions = Array.isArray(patient.conditions)
    ? patient.conditions
        .filter(
          (condition) =>
            condition &&
            typeof condition === "object" &&
            typeof condition.id === "string" &&
            condition.id &&
            typeof condition.name === "string" &&
            condition.name.trim() &&
            Array.isArray(condition.items),
        )
        .map((condition) => ({
          id: condition.id,
          name: condition.name.trim(),
          chiefSiteId: typeof condition.chiefSiteId === "string" ? condition.chiefSiteId : null,
          chiefSide: normalizeSide(condition.chiefSide),
          fresh: Boolean(condition.fresh),
          items: condition.items
            .filter((item) => item && typeof item === "object" && typeof item.targetId === "string" && item.targetId)
            .map(sanitizeConditionItem),
        }))
    : []
  const cleaned = {
    id: patient.id,
    name: patient.name.trim(),
    note: typeof patient.note === "string" ? patient.note : "",
    archived: Boolean(patient.archived),
    conditions,
  }
  // 上次派给谁：只保留仍在名单里的员工，脏 id / 已删员工一律丢掉。
  if (typeof patient.lastAssigneeId === "string" && staffIds.has(patient.lastAssigneeId)) {
    cleaned.lastAssigneeId = patient.lastAssigneeId
  }
  return cleaned
}

// 日条目内部（导入路径用）：数组字段补齐；认不出的手法/方向换成默认；派工只留名单里的人。
export function sanitizeDayEntry(entry, staffIds) {
  return {
    id: entry.id,
    patientId: entry.patientId,
    conditionIds: (Array.isArray(entry.conditionIds) ? entry.conditionIds : []).filter(
      (conditionId) => typeof conditionId === "string",
    ),
    focusConditionId: typeof entry.focusConditionId === "string" ? entry.focusConditionId : null,
    chiefSiteId: typeof entry.chiefSiteId === "string" ? entry.chiefSiteId : null,
    chiefSide: normalizeSide(entry.chiefSide),
    // 导入后这轮答没答过「记回病症」跟着走，别让所有人重答一遍。
    divergedAcked: Boolean(entry.divergedAcked),
    version: entryVersion(entry),
    items: (Array.isArray(entry.items) ? entry.items : [])
      .filter((item) => item && typeof item === "object" && typeof item.targetId === "string" && item.targetId)
      .map((item) => {
        const technique = TECHNIQUES.some((row) => row.id === item.technique) ? item.technique : "massage"
        const direction = DIRECTIONS.some((row) => row.id === item.direction) ? item.direction : "along"
        return {
          id: typeof item.id === "string" && item.id ? item.id : id(),
          conditionId: typeof item.conditionId === "string" ? item.conditionId : null,
          sourceItemId: typeof item.sourceItemId === "string" ? item.sourceItemId : null,
          targetId: item.targetId,
          side: normalizeSide(item.side),
          technique,
          direction,
          dose: clampDose(technique, item.dose),
          assigneeId: typeof item.assigneeId === "string" && staffIds.has(item.assigneeId) ? item.assigneeId : null,
          done: Boolean(item.done),
          completedBy: typeof item.completedBy === "string" ? item.completedBy : null,
          completedAt: item.done && typeof item.completedAt === "string" ? item.completedAt : null,
          ...sanitizeItemEquipment(item, technique),
        }
      }),
  }
}

export function sanitizeState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "这份文件不是治疗室数据")
  const staff = (Array.isArray(data.staff) ? data.staff : []).map(sanitizeStaff).filter(Boolean)
  if (!staff.length) fail(400, "这份文件里没有名单")
  const staffIds = new Set(staff.map((person) => person.id))
  const patients = (Array.isArray(data.patients) ? data.patients : [])
    .map((patient) => sanitizePatient(patient, staffIds))
    .filter(Boolean)
  const patientIds = new Set(patients.map((patient) => patient.id))
  const templates = (Array.isArray(data.templates) ? data.templates : [])
    .filter(
      (template) =>
        template &&
        typeof template === "object" &&
        typeof template.name === "string" &&
        template.name.trim() &&
        Array.isArray(template.items),
    )
    .map((template) => ({
      id: typeof template.id === "string" && template.id ? template.id : id(),
      name: template.name.trim(),
      chiefSiteId: typeof template.chiefSiteId === "string" ? template.chiefSiteId : null,
      chiefSide: normalizeSide(template.chiefSide),
      items: template.items
        .filter((item) => item && typeof item === "object" && typeof item.targetId === "string" && item.targetId)
        .map(sanitizeConditionItem),
    }))
  const days = {}
  if (data.days && typeof data.days === "object" && !Array.isArray(data.days)) {
    for (const [key, day] of Object.entries(data.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      if (!day || typeof day !== "object" || !Array.isArray(day.entries)) continue
      // 孤儿天条目（病人已不在）丢掉；留下的把内部也扶正，
      // 免得一条缺 items/conditionIds 的坏条目把整间屋子的 view() 打不开。
      days[key] = {
        entries: day.entries
          .filter(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              typeof entry.id === "string" &&
              typeof entry.patientId === "string" &&
              patientIds.has(entry.patientId),
          )
          .map((entry) => sanitizeDayEntry(entry, staffIds)),
      }
    }
  }
  const devices = {}
  if (data.devices && typeof data.devices === "object" && !Array.isArray(data.devices)) {
    for (const [deviceId, staffId] of Object.entries(data.devices)) {
      if (!deviceId) continue
      if (staffId === null) devices[deviceId] = null
      else if (typeof staffId === "string" && staffIds.has(staffId)) devices[deviceId] = staffId
    }
  }
  const lastExportAt =
    typeof data.lastExportAt === "string" && data.lastExportAt.trim() ? data.lastExportAt.trim() : null
  return { staff, devices, patients, templates, days, lastExportAt, pairings: sanitizePairings(data.pairings) }
}

// 磁盘读回来的数据只做「形状扶正」：不删还看得懂的历史，只补上会让读侧崩掉的洞
// （数组字段缺失、条目/项不是对象），并顺手扔掉已废弃的 passphrase 字段。
// 跟导入用的 sanitizeState 分工：这里宁可保数据，那里宁可保干净。
export function normalizeLoadedState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  if (!Array.isArray(data.staff) || !Array.isArray(data.patients)) return null
  const days = {}
  if (data.days && typeof data.days === "object" && !Array.isArray(data.days)) {
    for (const [key, day] of Object.entries(data.days)) {
      days[key] = {
        entries: (Array.isArray(day?.entries) ? day.entries : [])
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => ({
            ...entry,
            conditionIds: Array.isArray(entry.conditionIds)
              ? entry.conditionIds.filter((row) => typeof row === "string")
              : [],
            items: Array.isArray(entry.items)
              ? entry.items
                  .filter((row) => row && typeof row === "object")
                  .map((row) => ({ ...row, ...sanitizeItemEquipment(row, row.technique) }))
              : [],
          })),
      }
    }
  }
  return {
    staff: data.staff.filter((row) => row && typeof row === "object"),
    devices: data.devices && typeof data.devices === "object" && !Array.isArray(data.devices) ? data.devices : {},
    patients: data.patients
      .filter((patient) => patient && typeof patient === "object" && typeof patient.id === "string")
      .map((patient) => ({
        ...patient,
        name: String(patient.name ?? ""),
        conditions: (Array.isArray(patient.conditions) ? patient.conditions : [])
          .filter((condition) => condition && typeof condition === "object")
          .map((condition) => ({
            ...condition,
            items: Array.isArray(condition.items)
              ? condition.items
                  .filter((row) => row && typeof row === "object")
                  .map((row) => ({ ...row, ...sanitizeItemEquipment(row, row.technique) }))
              : [],
          })),
      })),
    templates: (Array.isArray(data.templates) ? data.templates : [])
      .filter((template) => template && typeof template === "object")
      .map((template) => ({
        ...template,
        items: Array.isArray(template.items)
          ? template.items
              .filter((row) => row && typeof row === "object")
              .map((row) => ({ ...row, ...sanitizeItemEquipment(row, row.technique) }))
          : [],
      })),
    days,
    lastExportAt: typeof data.lastExportAt === "string" ? data.lastExportAt : null,
    pairings:
      data.pairings && typeof data.pairings === "object" && !Array.isArray(data.pairings) ? data.pairings : null,
  }
}
