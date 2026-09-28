export function getDeviceId() {
  const forced = new URLSearchParams(window.location.search).get("device")
  const key = forced ? `physio-device-id:${forced}` : "physio-device-id"
  let id = localStorage.getItem(key) || sessionStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(key, id)
  } else if (!localStorage.getItem(key)) {
    localStorage.setItem(key, id)
  }
  return id
}

// 局域网 Wi-Fi 抖动会让 fetch 挂住：不设上限的话按钮会永久灰着。
const REQUEST_TIMEOUT_MS = 30_000

async function request(path, { method = "GET", body } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
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
  deleteTemplate: (templateId) => request(`/api/templates/${templateId}`, { method: "DELETE", body: {} }),
  applyTemplateToEntry: (entryId, templateId) =>
    request(`/api/entries/${entryId}/apply-template`, { method: "POST", body: { templateId } }),
  quickAdd: (entryId, parsed) =>
    request(`/api/entries/${entryId}/quick-add`, { method: "POST", body: parsed }),
  repeatLastDay: (patientId) =>
    request("/api/today/entries/repeat-last", { method: "POST", body: { patientId } }),
  setPatientNote: (patientId, note) =>
    request(`/api/patients/${patientId}/note`, { method: "POST", body: { note } }),
  addExisting: (patientId, conditionIds) => request("/api/today/entries", { method: "POST", body: { patientId, conditionIds } }),
  entry: (id) => request(withDevice(`/api/entries/${id}`)),
  addCondition: (id, name) => request(`/api/entries/${id}/conditions`, { method: "POST", body: { name } }),
  setChief: (id, targetId, side) => request(`/api/entries/${id}/chief`, { method: "POST", body: { targetId, side } }),
  addItem: (id, targetId, side) => request(`/api/entries/${id}/items`, { method: "POST", body: { targetId, side } }),
  patchItem: (id, itemId, patch) => request(`/api/entries/${id}/items/${itemId}`, { method: "PATCH", body: { patch } }),
  removeItem: (id, itemId) => request(`/api/entries/${id}/items/${itemId}`, { method: "DELETE", body: {} }),
  reorder: (id, orderedIds) => request(`/api/entries/${id}/reorder`, { method: "POST", body: { orderedIds } }),
  assignAll: (id, assigneeId) => request(`/api/entries/${id}/assign-all`, { method: "POST", body: { assigneeId } }),
  includeCondition: (id, conditionId) => request(`/api/entries/${id}/include`, { method: "POST", body: { conditionId } }),
  setFocus: (id, conditionId) => request(`/api/entries/${id}/focus`, { method: "POST", body: { conditionId } }),
  dropEntry: (id) => request(`/api/entries/${id}/drop`, { method: "POST", body: {} }),
  leave: (id, updateCondition) => request(`/api/entries/${id}/leave`, { method: "POST", body: { updateCondition } }),
  copyCondition: (conditionId, targetPatientId) =>
    request(`/api/conditions/${conditionId}/copy`, { method: "POST", body: { targetPatientId } }),
}
