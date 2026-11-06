// 与持久化介质无关的历史索引、导入导出；局域网和 Cloudflare 共用。
import { sanitizeState } from "./helpers.js"

export const stateMethods = {
  rebuildDayIndex() {
    this.byPatient = new Map()
    for (const [day, record] of Object.entries(this.state.days || {})) {
      for (const entry of record?.entries || []) {
        if (!entry?.patientId) continue
        const list = this.byPatient.get(entry.patientId) || []
        list.push({ day, entryId: entry.id })
        this.byPatient.set(entry.patientId, list)
      }
    }
    this.indexedDays = this.daysSignature()
  },

  daysSignature() {
    return Object.entries(this.state.days || {}).map(([day, record]) => `${day}:${record?.entries?.length || 0}`).join("|")
  },

  ensureDayIndex() {
    if (this.indexedDays !== this.daysSignature()) this.rebuildDayIndex()
  },

  exportData(deviceId) {
    this.requireStaff(deviceId)
    this.state.lastExportAt = new Date().toISOString()
    this.save()
    this.audit(deviceId, "导出数据")
    return structuredClone(this.state)
  },

  importData({ deviceId, data }) {
    const staff = this.requireStaff(deviceId)
    const next = sanitizeState(data)
    if (next.staff.some((person) => person.id === staff.id)) next.devices[deviceId] = staff.id
    const prev = this.state
    this.state = next
    this.rebuildDayIndex()
    try {
      const result = this.view(deviceId)
      this.save()
      this.audit(deviceId, "导入数据", { 病人: next.patients.length, 名单: next.staff.length })
      return result
    } catch (error) {
      this.state = prev
      this.rebuildDayIndex()
      throw error
    }
  },
}
