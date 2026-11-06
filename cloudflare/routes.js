// HTTP 传输适配；所有临床规则仍调用同一份 ClinicCore，防止云版和局域网版漂移。
export const routes = [
  ["GET", "/api/health", () => ({ ok: true, hosting: "cloudflare" })],
  ["GET", "/api/session", (s, b) => s.view(b.deviceId)],
  ["POST", "/api/setup", (s, b) => s.setup(b)],
  ["POST", "/api/claim", (s, b) => s.claim(b)],
  ["POST", "/api/data/import", (s, b) => s.importData(b)],
  ["GET", "/api/data/export", (s, b) => s.exportData(b.deviceId)],
  ["POST", "/api/patients", (s, b) => s.createPatient(b)],
  ["POST", "/api/patients/from-template", (s, b) => s.createPatientFromTemplate(b)],
  ["POST", "/api/patients/:patientId/note", (s, b) => s.setPatientNote(b)],
  ["POST", "/api/patients/:patientId/rename", (s, b) => s.renamePatient(b)],
  ["POST", "/api/patients/:patientId/archive", (s, b) => s.setPatientArchived(b)],
  ["DELETE", "/api/patients/:patientId/conditions/:conditionId", (s, b) => s.deleteCondition(b)],
  ["POST", "/api/templates", (s, b) => s.saveTemplateFromEntry(b)],
  ["DELETE", "/api/templates/:templateId", (s, b) => s.deleteTemplate(b)],
  ["POST", "/api/pairings", (s, b) => s.savePairings(b)],
  ["POST", "/api/today/entries", (s, b) => s.addExisting(b)],
  ["POST", "/api/today/entries/repeat-last", (s, b) => s.repeatLastDay(b)],
  ["POST", "/api/today/entries/carry-unfinished", (s, b) => s.carryUnfinished(b)],
  ["POST", "/api/today/reassign-open", (s, b) => s.reassignOpen(b)],
  ["POST", "/api/orders/preview", (s, b) => s.previewOrder(b)],
  ["POST", "/api/orders/dispatch", (s, b) => s.dispatchOrder(b)],
  ["GET", "/api/entries/:entryId", (s, b) => s.entryView(b.deviceId, b.entryId)],
  ["POST", "/api/entries/:entryId/workflow", (s, b) => s.configureWorkflow(b)],
  ["POST", "/api/entries/:entryId/conditions", (s, b) => s.addCondition(b)],
  ["POST", "/api/entries/:entryId/chief", (s, b) => s.setChief(b)],
  ["POST", "/api/entries/:entryId/items", (s, b) => s.addItem(b)],
  ["POST", "/api/entries/:entryId/items/:itemId/replace", (s, b) => s.replaceItem(b)],
  ["POST", "/api/entries/:entryId/items/restore", (s, b) => s.restoreItem(b)],
  ["PATCH", "/api/entries/:entryId/items/:itemId", (s, b) => s.patchItem(b)],
  ["DELETE", "/api/entries/:entryId/items/:itemId", (s, b) => s.removeItem(b)],
  ["POST", "/api/entries/:entryId/reorder", (s, b) => s.reorder(b)],
  ["POST", "/api/entries/:entryId/assign-all", (s, b) => s.assignAll(b)],
  ["POST", "/api/entries/:entryId/include", (s, b) => s.includeCondition(b)],
  ["POST", "/api/entries/:entryId/leave", (s, b) => s.leave(b)],
  ["POST", "/api/entries/:entryId/focus", (s, b) => s.setFocus(b)],
  ["POST", "/api/entries/:entryId/drop", (s, b) => s.dropEntry(b)],
  ["POST", "/api/entries/:entryId/apply-template", (s, b) => s.applyTemplateToEntry(b)],
  ["POST", "/api/entries/:entryId/quick-add", (s, b) => s.quickAdd(b)],
  ["POST", "/api/conditions/:conditionId/copy", (s, b) => s.copyCondition(b)],
  ["GET", "/api/cloud/backups", (s, b) => ({ ...s.listBackups(b.deviceId), sequence: s.sequence })],
  ["GET", "/api/cloud/backups/:backupId", (s, b) => s.readBackup(b.deviceId, b.backupId)],
  ["POST", "/api/cloud/backups/:backupId/restore", (s, b) => s.restoreBackup(b)],
  ["GET", "/api/cloud/audit", (s, b) => s.listAudit(b.deviceId)],
]

export function matchRoute(method, pathname) {
  const parts = pathname.split("/")
  for (const [verb, pattern, handle] of routes) {
    if (method !== verb) continue
    const expected = pattern.split("/")
    if (parts.length !== expected.length) continue
    const params = {}
    if (expected.every((part, at) => {
      if (!part.startsWith(":")) return part === parts[at]
      try { params[part.slice(1)] = decodeURIComponent(parts[at]); return Boolean(parts[at]) } catch { return false }
    })) return { handle, params }
  }
  return null
}
