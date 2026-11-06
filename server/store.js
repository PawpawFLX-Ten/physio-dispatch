// 局域网文件适配器；业务规则与 Cloudflare 版本共用 ClinicCore。
import { ClinicCore } from "./core.js"
import { ioMethods } from "./io.js"

export { todayKey } from "./helpers.js"

export class ClinicStore extends ClinicCore {
  constructor(file, auditFile = `${file.replace(/\.json$/, "")}.audit.log`) {
    super()
    this.file = file
    this.auditFile = auditFile
  }
}

Object.assign(ClinicStore.prototype, ioMethods)
