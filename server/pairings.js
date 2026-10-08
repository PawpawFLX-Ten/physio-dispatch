// 常见搭配表的写侧：设置里改完，整张表一次性存下。
import { fail } from "./helpers.js"
import { sanitizePairings } from "../shared/pairings.js"

export const pairingMethods = {
  savePairings({ deviceId, pairings }) {
    this.requireStaff(deviceId)
    const clean = sanitizePairings(pairings)
    if (!Object.keys(clean).length) fail(400, "搭配表里没有认得的部位")
    this.state.pairings = clean
    this.save()
    this.audit(deviceId, "改常见搭配", { 部位: Object.keys(clean).join("、") })
    return this.view(deviceId)
  },
}
