// SSE「数据一变就推」的契约，两端共用这一份：
// n 单调递增的事件序号；origin 是改数据那台手机的 deviceId——
// 自己的改动写接口的返回值里已经拿到，收到 origin 是自己就不用再拉。
// by 是改数据那个人的名字，给别的手机一个「谁刚动过」的被动提示。
export function changeEvent(n, origin, by = "") {
  return { n, origin: origin || "", by: typeof by === "string" ? by : "" }
}

export function parseChangeEvent(raw) {
  try {
    const data = JSON.parse(raw)
    if (data && typeof data.n === "number") {
      return changeEvent(data.n, data.origin, data.by)
    }
  } catch {
    /* 推送内容坏了就当没有这条 */
  }
  return null
}
