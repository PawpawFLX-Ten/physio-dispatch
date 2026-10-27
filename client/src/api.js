// crypto.randomUUID 是安全上下文（https / localhost）才有的；
// 局域网 http 或微信内置浏览器里是 undefined，得退回 getRandomValues 自己拼。
function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export function getDeviceId() {
  const forced = new URLSearchParams(window.location.search).get("device")
  const key = forced ? `physio-device-id:${forced}` : "physio-device-id"
  let id = localStorage.getItem(key) || sessionStorage.getItem(key)
  if (!id) {
    id = uuid()
    localStorage.setItem(key, id)
  } else if (!localStorage.getItem(key)) {
    localStorage.setItem(key, id)
  }
  return id
}

// 局域网 Wi-Fi 抖动会让 fetch 挂住：不设上限的话按钮会永久灰着。
// 普通请求 10 秒足够（超时多半是网络真断了，别让按钮灰半分钟）；
// 导入导出要搬整间治疗室的数据，各给自己的宽限。
const REQUEST_TIMEOUT_MS = 10_000
const EXPORT_TIMEOUT_MS = 60_000
const IMPORT_TIMEOUT_MS = 120_000

async function request(path, { method = "GET", body, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let response
  try {
    response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify({ ...body, deviceId: getDeviceId() }) : undefined,
      signal: controller.signal,
    })
  } catch {
    throw new Error("网络不通，稍后再试")
  } finally {
    clearTimeout(timer)
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || "未能保存")
    error.status = response.status
    throw error
  }
  return data
}

function withDevice(path) {
  const mark = path.includes("?") ? "&" : "?"
  return `${path}${mark}deviceId=${encodeURIComponent(getDeviceId())}`
}

export const api = {
  session: () => request(withDevice("/api/session")),
  setup: (staffName) => request("/api/setup", { method: "POST", body: { staffName } }),
  claim: (body) => request("/api/claim", { method: "POST", body }),
  createPatient: (name, conditionName) => request("/api/patients", { method: "POST", body: { name, conditionName } }),
  createPatientFromTemplate: (name, templateId) =>
    request("/api/patients/from-template", { method: "POST", body: { name, templateId } }),
  saveTemplateFromEntry: (entryId, conditionId, name) =>
    request("/api/templates", { method: "POST", body: { entryId, conditionId, name } }),
  // DELETE 也把 deviceId 放进 query：个别代理会剥掉 DELETE 的 body。
  deleteTemplate: (templateId) => request(withDevice(`/api/templates/${templateId}`), { method: "DELETE", body: {} }),
  applyTemplateToEntry: (entryId, templateId) =>
    request(`/api/entries/${entryId}/apply-template`, { method: "POST", body: { templateId } }),
  // 常见搭配：整张表一次存下，覆盖默认。
  savePairings: (pairings) => request("/api/pairings", { method: "POST", body: { pairings } }),
  quickAdd: (entryId, parsed) =>
    request(`/api/entries/${entryId}/quick-add`, { method: "POST", body: parsed }),
  repeatLastDay: (patientId) =>
    request("/api/today/entries/repeat-last", { method: "POST", body: { patientId } }),
  carryUnfinished: (patientId, entryId) =>
    request("/api/today/entries/carry-unfinished", {
      method: "POST",
      body: { ...(patientId ? { patientId } : {}), ...(entryId ? { entryId } : {}) },
    }),
  setPatientNote: (patientId, note) =>
    request(`/api/patients/${patientId}/note`, { method: "POST", body: { note } }),
  renamePatient: (patientId, name) =>
    request(`/api/patients/${patientId}/rename`, { method: "POST", body: { name } }),
  setPatientArchived: (patientId, archived) =>
    request(`/api/patients/${patientId}/archive`, { method: "POST", body: { archived } }),
  deleteCondition: (patientId, conditionId) =>
    request(withDevice(`/api/patients/${patientId}/conditions/${conditionId}`), { method: "DELETE", body: {} }),
  addExisting: (patientId, conditionIds) => request("/api/today/entries", { method: "POST", body: { patientId, conditionIds } }),
  entry: (id) => request(withDevice(`/api/entries/${id}`)),
  addCondition: (id, name) => request(`/api/entries/${id}/conditions`, { method: "POST", body: { name } }),
  setChief: (id, targetId, side) => request(`/api/entries/${id}/chief`, { method: "POST", body: { targetId, side } }),
  addItem: (id, targetId, side) => request(`/api/entries/${id}/items`, { method: "POST", body: { targetId, side } }),
  patchItem: (id, itemId, patch, expectedVersion) =>
    request(`/api/entries/${id}/items/${itemId}`, {
      method: "PATCH",
      body: { patch, ...(expectedVersion != null ? { expectedVersion } : {}) },
    }),
  removeItem: (id, itemId) => request(withDevice(`/api/entries/${id}/items/${itemId}`), { method: "DELETE", body: {} }),
  // 撤销删除：把删除前的完整项快照插回原位（含派工与完成）。
  restoreItem: (id, index, item) =>
    request(`/api/entries/${id}/items/restore`, { method: "POST", body: { index, item } }),
  reorder: (id, orderedIds, expectedVersion) =>
    request(`/api/entries/${id}/reorder`, {
      method: "POST",
      body: { orderedIds, ...(expectedVersion != null ? { expectedVersion } : {}) },
    }),
  assignAll: (id, assigneeId, expectedVersion) =>
    request(`/api/entries/${id}/assign-all`, {
      method: "POST",
      body: { assigneeId, ...(expectedVersion != null ? { expectedVersion } : {}) },
    }),
  includeCondition: (id, conditionId) => request(`/api/entries/${id}/include`, { method: "POST", body: { conditionId } }),
  setFocus: (id, conditionId) => request(`/api/entries/${id}/focus`, { method: "POST", body: { conditionId } }),
  dropEntry: (id) => request(`/api/entries/${id}/drop`, { method: "POST", body: {} }),
  leave: (id, updateCondition) => request(`/api/entries/${id}/leave`, { method: "POST", body: { updateCondition } }),
  // fromToday: true 时复制今日单这套（不复制派工和完成）；不传则仍复制病症存档。
  copyCondition: (conditionId, targetPatientId, options = {}) =>
    request(`/api/conditions/${conditionId}/copy`, {
      method: "POST",
      body: {
        targetPatientId,
        ...(options.fromToday ? { fromToday: true } : {}),
      },
    }),
  // 导出走 GET 附件下载；失败时接口返回 JSON 错误。
  exportClinic: async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS)
    let response
    try {
      response = await fetch(withDevice("/api/data/export"), { signal: controller.signal })
    } catch {
      throw new Error("网络不通，稍后再试")
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      const error = new Error(data.error || "导不出")
      error.status = response.status
      throw error
    }
    return response.json()
  },
  // deviceId 也在 URL 上带一份：服务端解析大请求体之前就先认身份。
  importClinic: (data) =>
    request(withDevice("/api/data/import"), { method: "POST", body: { data }, timeout: IMPORT_TIMEOUT_MS }),
}
