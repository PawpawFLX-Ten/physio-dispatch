// 进门的逻辑：建立员工、设备绑定、我是谁。局域网演示不设共用口令。
import { fail, id } from "./helpers.js"

export const authMethods = {
  device(deviceId) {
    if (!Object.prototype.hasOwnProperty.call(this.state.devices, deviceId)) return undefined
    return this.state.devices[deviceId]
  },

  requireStaff(deviceId) {
    const staffId = this.device(deviceId)
    const staff = this.state.staff.find((item) => item.id === staffId)
    if (!staff) fail(401, "请先选择你是谁")
    return staff
  },

  stage(deviceId) {
    if (!this.state.staff.length) return "setup"
    if (!this.device(deviceId)) return "whoami"
    return "ready"
  },

  setup({ deviceId, staffName }) {
    if (this.state.staff.length) fail(409, "治疗室已经有人了")
    if (!staffName?.trim()) fail(400, "请填写名字")
    const staff = { id: id(), name: staffName.trim() }
    this.state.staff.push(staff)
    this.state.devices[deviceId] = staff.id
    this.save()
    this.audit(deviceId, "建立员工", { 第一个名字: staff.name })
    return this.view(deviceId)
  },

  claim({ deviceId, staffId, staffName }) {
    if (!this.state.staff.length) fail(401, "请先建立员工名字")
    let staff = staffId ? this.state.staff.find((item) => item.id === staffId) : null
    const name = staffName?.trim()
    if (!staff && name) {
      staff = this.state.staff.find((item) => item.name === name) || null
      if (!staff) {
        staff = { id: id(), name }
        this.state.staff.push(staff)
      }
    }
    if (!staff) fail(400, "请选择或填写名字")
    this.state.devices[deviceId] = staff.id
    this.save()
    this.audit(deviceId, "选择身份", { 名字: staff.name })
    return this.view(deviceId)
  },
}
