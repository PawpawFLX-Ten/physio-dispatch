import crypto from "node:crypto"
import { buildOrderDraft } from "../shared/order-command.js"
import { EQUIPMENT_TYPES, equipmentSummaryForItem } from "../shared/equipment.js"
import { instructionFields } from "../shared/workflow.js"
import { prepareNewItem } from "./entries.js"
import { bumpEntryVersion, entryVersion, fail, id } from "./helpers.js"

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export const orderCommandMethods = {
  orderDraft({ deviceId, patientId, text, side, sequential }) {
    const staff = this.requireStaff(deviceId)
    if (typeof text !== "string" || text.length > 2000) fail(400, "口令最多 2000 字")
    if (side && !["left", "right", "both"].includes(side)) fail(400, "侧别不对")
    if (sequential !== undefined && typeof sequential !== "boolean") fail(400, "顺序设置不对")
    const patient = this.patient(patientId)
    const current = this.todayRecord().entries.find((entry) => entry.patientId === patient.id)
    const lastDate = this.patientLastDays(true).get(patient.id)
    const last = lastDate ? this.state.days[lastDate].entries.find((entry) => entry.patientId === patient.id) : null
    const draft = buildOrderDraft(text, { current, last, lastDate, templates: this.state.templates, staff: this.state.staff, equipment: EQUIPMENT_TYPES, side, sequential })
    if (!patient.conditions.length) draft.issues.push("请先给患者建立病症")
    const focus = current?.focusConditionId || patient.conditions.at(-1)?.id
    const usage = {}
    for (const entry of this.todayRecord().entries) {
      for (const item of entry.items) if (!item.done && item.equipmentUnitId && entry.id !== current?.id) {
        usage[item.equipmentUnitId] = (usage[item.equipmentUnitId] || 0) + 1
      }
    }
    draft.items = draft.items.map((item) => {
      const existing = draft.base === "current" && current?.items.find((row) => row.id === item.id)
      const conditionId = patient.conditions.some((condition) => condition.id === item.conditionId) ? item.conditionId : focus
      try {
        // 运行中项原样保留，不在预览时重设设备锁或补写临床参数。
        if (existing && JSON.stringify(existing) === JSON.stringify(item)) return { ...item, equipmentSummary: equipmentSummaryForItem(item), provenance: "沿用今天" }
        const typed = Boolean(item.equipmentTypeId)
        const input = { ...item }
        if (input.technique !== "equipment") {
          delete input.parameters
          delete input.linkedTargets
        }
        if (draft.base.startsWith("template:")) {
          delete input.equipmentUnitId
        }
        const normalized = prepareNewItem({ store: this, staff, entry: { chiefSide: draft.chiefSide }, input,
          previous: existing || null, fallbackTechnique: "massage", inheritPrevious: false,
          options: { fallbackChiefSide: draft.chiefSide, unitUsage: usage } })
        if (normalized.equipmentUnitId) usage[normalized.equipmentUnitId] = (usage[normalized.equipmentUnitId] || 0) + 1
        return {
          ...existing, ...normalized, ...instructionFields(item),
          id: item.id, conditionId, sourceItemId: existing?.sourceItemId || null,
          done: Boolean(existing?.done), completedAt: existing?.completedAt || null,
          completedBy: existing?.completedBy || null,
          startedAt: existing?.startedAt || null, startedBy: existing?.startedBy || null,
          problem: existing?.problem || "", problemBy: existing?.problemBy || null,
          provenance: item.provenance || "沿用今天",
          equipmentSummary: typed ? equipmentSummaryForItem(normalized) : "",
        }
      } catch (error) {
        draft.issues.push(error.message)
        return item
      }
    })
    draft.issues = [...new Set(draft.issues)]
    const token = fingerprint({ patientId, currentId: current?.id, version: current ? entryVersion(current) : null, text, side, sequential, draft })
    return { draft, token, patientName: patient.name }
  },

  previewOrder(input) {
    return this.orderDraft(input)
  },

  dispatchOrder(input) {
    this.requireStaff(input.deviceId)
    const previous = this.todayRecord().entries.find((entry) => entry.patientId === input.patientId)
    if (typeof input.token !== "string" || !input.token) fail(400, "请先预览安排")
    // 同一确认重复到达只返回原结果，不重复加项。
    if (previous?.lastCommandToken === input.token) return this.entryView(input.deviceId, previous.id)
    const { draft, token } = this.orderDraft(input)
    if (token !== input.token) fail(409, "安排或方案已变化，请重新预览后派发")
    if (draft.issues.length) fail(400, draft.issues.join("；"))
    const snapshot = structuredClone(this.state)
    try {
      const patient = this.patient(input.patientId)
      const entry = previous || this.makeEntry(patient, patient.conditions.map((condition) => condition.id), patient.conditions.at(-1).id)
      const existingIds = new Set(previous?.items.map((item) => item.id) || [])
      const reusedIds = new Set()
      entry.items = draft.items.map((item) => {
        const { equipmentSummary: _summary, provenance: _provenance, assigneeName: _assignee, ...stored } = item
        const itemId = existingIds.has(item.id) && !reusedIds.has(item.id) ? item.id : id()
        reusedIds.add(itemId)
        return { ...stored, id: itemId }
      })
      entry.chiefSiteId = draft.chiefSiteId
      entry.chiefSide = draft.chiefSide
      entry.sequential = draft.sequential
      entry.supervisorId = this.device(input.deviceId)
      entry.divergedAcked = false
      entry.lastCommandToken = token
      bumpEntryVersion(entry)
      if (!previous) this.day().entries.push(entry)
      const result = this.entryView(input.deviceId, entry.id)
      this.save()
      this.audit(input.deviceId, "预览后派发", { 病人: patient.name, 改动: draft.changes })
      return result
    } catch (error) {
      this.state = snapshot
      this.rebuildDayIndex()
      throw error
    }
  },
}
