import { emptyState } from "./helpers.js"
import { stateMethods } from "./state.js"
import { authMethods } from "./auth.js"
import { viewMethods } from "./views.js"
import { entryMethods } from "./entries.js"
import { templateMethods } from "./templates.js"
import { pairingMethods } from "./pairings.js"
import { workflowMethods } from "./workflow.js"
import { orderCommandMethods } from "./order-commands.js"

export class ClinicCore {
  constructor() {
    this.state = emptyState()
    this.listeners = new Set()
    this.byPatient = new Map()
    this.indexedDays = ""
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitChange() {
    for (const listener of this.listeners) {
      try { listener() } catch { /* 通知失败不影响已保存的数据 */ }
    }
  }

  save() { throw new Error("未配置持久化适配器") }
  audit() { throw new Error("未配置审计适配器") }
}

Object.assign(ClinicCore.prototype, stateMethods, authMethods, viewMethods, entryMethods, templateMethods, pairingMethods, workflowMethods, orderCommandMethods)
