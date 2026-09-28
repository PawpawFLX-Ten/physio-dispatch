// 数据层的纯函数和公共小工具：不碰 this、不碰文件。
import crypto from "node:crypto"

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
  return { passphrase: null, staff: [], devices: {}, patients: [], templates: [], days: {} }
}

export function normalizeSide(side) {
  if (side === "left" || side === "right") return side
  return null
}

export function workSignature(item) {
  return JSON.stringify({
    targetId: item.targetId,
    side: item.side || null,
    technique: item.technique,
    direction: item.direction,
    dose: item.dose,
  })
}

export function fail(status, message) {
  const error = new Error(message)
  error.status = status
  throw error
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
          items: condition.items.filter(
            (item) => item && typeof item === "object" && typeof item.targetId === "string" && item.targetId,
          ),
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
      items: template.items.filter(
        (item) => item && typeof item === "object" && typeof item.targetId === "string" && item.targetId,
      ),
    }))
  const days = {}
  if (data.days && typeof data.days === "object" && !Array.isArray(data.days)) {
    for (const [key, day] of Object.entries(data.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      if (!day || typeof day !== "object" || !Array.isArray(day.entries)) continue
      // 孤儿天条目（病人已不在）丢掉，避免今日单投影整间屋子打不开。
      days[key] = {
        entries: day.entries.filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            typeof entry.id === "string" &&
            typeof entry.patientId === "string" &&
            patientIds.has(entry.patientId),
        ),
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
  const passphrase = typeof data.passphrase === "string" && data.passphrase ? data.passphrase : null
  return { passphrase, staff, devices, patients, templates, days }
}
