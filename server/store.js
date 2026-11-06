// 数据层入口：一个 ClinicStore 类，方法按领域放在旁边的文件里（io / auth / views / entries / templates / pairings）。
// 对外的接口不变：index.js 和测试仍然从这里拿 ClinicStore 和 todayKey。
import { emptyState } from "./helpers.js"
import { ioMethods } from "./io.js"
import { authMethods } from "./auth.js"
import { viewMethods } from "./views.js"
import { entryMethods } from "./entries.js"
import { templateMethods } from "./templates.js"
import { pairingMethods } from "./pairings.js"
import { workflowMethods } from "./workflow.js"
import { orderCommandMethods } from "./order-commands.js"

export { todayKey } from "./helpers.js"

export class ClinicStore {
  constructor(file, auditFile = `${file.replace(/\.json$/, "")}.audit.log`) {
    this.file = file
    this.auditFile = auditFile
    this.state = emptyState()
    this.listeners = new Set()
    this.byPatient = new Map()
    this.indexedDays = ""
  }

  // index.js 拿这个接 SSE：数据一变，其他手机立刻知道该刷新了。
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitChange() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* 通知坏了不影响保存 */
      }
    }
  }
}

Object.assign(ClinicStore.prototype, ioMethods, authMethods, viewMethods, entryMethods, templateMethods, pairingMethods, workflowMethods, orderCommandMethods)
