import { targetTitle } from "../shared/catalog.js"
import { equipmentUnitName } from "../shared/equipment.js"
import { assertExpectedVersion, bumpEntryVersion, fail } from "./helpers.js"

export const workflowMethods = {
  executionState(entry, item) {
    if (item.done) return { state: "done", canExecute: false, reason: "已完成" }
    if (item.problem) return { state: "review", canExecute: false, reason: `需主治处理：${item.problem}` }
    if (item.startedAt) return { state: "in_progress", canExecute: true, reason: "使用中" }
    if (entry.sequential) {
      const at = entry.items.findIndex((row) => row.id === item.id)
      const previous = entry.items.slice(0, at).find((row) => !row.done)
      if (previous) {
        const who = this.state.staff.find((person) => person.id === previous.assigneeId)?.name || "未派工"
        return { state: "waiting_step", canExecute: false, reason: `等前一步：${targetTitle(previous.targetId, previous.side)}（${who}）` }
      }
    }
    if (item.equipmentUnitId) {
      for (const other of this.todayRecord().entries) {
        const occupied = other.items.find((row) => row.id !== item.id && !row.done && row.startedAt && row.equipmentUnitId === item.equipmentUnitId)
        if (occupied) {
          const name = this.state.patients.find((patient) => patient.id === other.patientId)?.name || "其他患者"
          return { state: "waiting_equipment", canExecute: false, reason: `等设备：${equipmentUnitName(item.equipmentUnitId)}正在被${name}使用，请先结束` }
        }
      }
    }
    return { state: "ready", canExecute: true, reason: "现在可以做" }
  },

  configureWorkflow({ deviceId, entryId, sequential, bedLabel, expectedVersion }) {
    const staff = this.requireStaff(deviceId)
    const entry = this.entryById(entryId)
    assertExpectedVersion(entry, expectedVersion)
    if (sequential !== undefined && typeof sequential !== "boolean") fail(400, "顺序设置不对")
    if (sequential !== undefined) entry.sequential = sequential
    if (bedLabel !== undefined) entry.bedLabel = String(bedLabel || "").trim().slice(0, 60)
    entry.supervisorId = staff.id
    bumpEntryVersion(entry)
    this.save()
    this.audit(deviceId, "改执行安排", { 顺序: entry.sequential, 床位: entry.bedLabel })
    return this.entryView(deviceId, entryId)
  },
}
