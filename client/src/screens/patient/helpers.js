// 病人页的纯函数和常量：不碰 React、不碰 this，好测好搬。
import { techniqueLabel, directionLabel, doseLabel } from "@shared/catalog.js"

export const blankNotice = { text: "", tone: "ok" }
export const pastMidnightNotice = {
  text: "已经是新的一天。回到今日单后，可在加入病人里把昨天未完成接进今天。",
  tone: "error",
}
export const removePast = 72

export function isPastMidnightError(err) {
  return typeof err?.message === "string" && err.message.includes("过了零点")
}

export function isConflictError(err) {
  return err?.status === 409 || (typeof err?.message === "string" && err.message.includes("别人刚改过"))
}

export function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export function stepsFrom(delta, size) {
  if (!size) return 0
  const raw = delta / size
  if (raw === 0) return 0
  return Math.trunc(raw + Math.sign(raw) * 0.5)
}

export function numeric(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function conditionText(entry) {
  return (entry.conditionIds || [])
    .map((id) => entry.conditions?.find((condition) => condition.id === id)?.name)
    .filter(Boolean)
    .join("、")
}

// 撤销恢复用的持久化字段快照（不含界面展示名）。
export function itemSnapshot(item) {
  return {
    id: item.id,
    conditionId: item.conditionId,
    sourceItemId: item.sourceItemId ?? null,
    targetId: item.targetId,
    side: item.side || null,
    technique: item.technique,
    direction: item.direction,
    dose: item.dose == null ? item.dose : structuredClone(item.dose),
    assigneeId: item.assigneeId || null,
    done: Boolean(item.done),
    completedBy: item.completedBy || null,
    completedAt: item.completedAt || null,
  }
}

// 完成时刻只看时分：条目行和来过几次都印「HH:MM」。
export function clockOf(iso) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ""
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
}

export function itemLine(item) {
  // 派给谁单独成钮，不塞进这一行说明。
  const doneBit = item.done && item.completedByName
    ? `${item.completedByName}完成${item.completedAt ? ` ${clockOf(item.completedAt)}` : ""}`
    : ""
  return [
    techniqueLabel(item.technique),
    directionLabel(item.direction),
    doseLabel(item.technique, item.dose),
    doneBit,
  ]
    .filter(Boolean)
    .join(" · ")
}

export function originElement(target) {
  if (target instanceof Element) return target
  return target?.parentElement || null
}
