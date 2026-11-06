import { ClinicCore } from "../server/core.js"
import { emptyState, fail, normalizeLoadedState, todayKey } from "../server/helpers.js"
import { CLOUD_DATA_LIMIT } from "./http.js"

const encoder = new TextEncoder()
const RECORD_LIMIT = 1024 * 1024

// 不是把整间治疗室塞进单个 KV 值：每位患者、模板和每日条目各一行，只写变化行。
export function encodeRecords(state) {
  if (encoder.encode(JSON.stringify(state)).byteLength > CLOUD_DATA_LIMIT) fail(413, "云端治疗室数据超过 8MB，请先导出并联系维护者扩容")
  const rows = new Map()
  const put = (key, value) => {
    if (rows.has(key)) fail(400, "数据中存在重复 ID，不能安全保存")
    const json = JSON.stringify(value)
    if (encoder.encode(json).byteLength > RECORD_LIMIT) fail(413, "单份患者档案或条目超过云端 1MB 上限")
    rows.set(key, json)
  }
  const meta = {
    schema: 1, staff: state.staff, devices: state.devices, lastExportAt: state.lastExportAt,
    pairings: state.pairings, patients: [], templates: [], days: [],
  }
  for (const patient of state.patients) { meta.patients.push(patient.id); put(`p:${patient.id}`, patient) }
  for (const template of state.templates) { meta.templates.push(template.id); put(`t:${template.id}`, template) }
  for (const [day, record] of Object.entries(state.days)) {
    meta.days.push([day, record.entries.map((entry) => entry.id)])
    for (const entry of record.entries) put(`e:${day}:${entry.id}`, entry)
  }
  put("meta", meta)
  return rows
}

export function decodeRecords(rows) {
  if (!rows.size) return emptyState()
  const get = (key) => {
    if (!rows.has(key)) fail(500, "云端数据不完整，请联系维护者恢复备份")
    return JSON.parse(rows.get(key))
  }
  const meta = get("meta")
  if (meta.schema !== 1) fail(500, "不支持的云端数据版本")
  const state = normalizeLoadedState({
    staff: meta.staff, devices: meta.devices, lastExportAt: meta.lastExportAt, pairings: meta.pairings,
    patients: meta.patients.map((id) => get(`p:${id}`)),
    templates: meta.templates.map((id) => get(`t:${id}`)),
    days: Object.fromEntries(meta.days.map(([day, ids]) => [day, { entries: ids.map((id) => get(`e:${day}:${id}`)) }])),
  })
  if (!state) fail(500, "云端数据无法读取，请恢复备份")
  return state
}

export function splitSnapshot(text, size = 16000) {
  const parts = []
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + size, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    parts.push(text.slice(at, end))
    at = end
  }
  return parts
}

export class DurableClinicStore extends ClinicCore {
  constructor(storage) {
    super()
    this.storage = storage
    this.sql = storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_chunks (backup_id TEXT NOT NULL, part INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (backup_id, part));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, email TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
    `)
    this.records = new Map(this.sql.exec("SELECT key, json FROM records").toArray().map((row) => [row.key, row.json]))
    this.state = decodeRecords(this.records)
    this.rebuildDayIndex()
    this.dirty = false
    this.pendingAudit = []
    this.sequence = this.sql.exec("SELECT value FROM runtime WHERE key = 'sequence'").toArray()[0]?.value || 0
  }

  save() { this.dirty = true }

  allowLoginAttempt(key, now = Date.now()) {
    const window = Math.floor(now / (10 * 60 * 1000))
    return this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM login_attempts WHERE window < ?", window - 1)
      const count = (name) => {
        const row = this.sql.exec("SELECT window, count FROM login_attempts WHERE key = ?", name).toArray()[0]
        return row?.window === window ? row.count : 0
      }
      const ipCount = count(`ip:${key}`)
      const total = count("all")
      if (ipCount >= 10 || total >= 100) return false
      for (const [name, next] of [[`ip:${key}`, ipCount + 1], ["all", total + 1]]) {
        this.sql.exec("INSERT INTO login_attempts (key, window, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window = excluded.window, count = excluded.count", name, window, next)
      }
      return true
    })
  }

  audit(deviceId, action, detail = {}) {
    const who = this.state.staff.find((person) => person.id === this.device(deviceId))?.name || ""
    const text = JSON.stringify(detail)
    this.pendingAudit.push({ at: new Date().toISOString(), email: this.actorEmail || "", who, action, detail: text.length > 600 ? JSON.stringify({ 预览: text.slice(0, 400) }) : text })
  }

  backup(before, now = new Date()) {
    if (!before.staff.length) return
    const timestamp = now.toISOString()
    const candidates = [[`minute:${timestamp.slice(0, 16)}`, "minute"], [`day:${todayKey(now)}`, "day"]]
    let parts
    for (const [id, kind] of candidates) {
      if (this.sql.exec("SELECT id FROM backups WHERE id = ?", id).toArray().length) continue
      parts ||= splitSnapshot(JSON.stringify(before))
      this.sql.exec("INSERT INTO backups (id, created_at, kind) VALUES (?, ?, ?)", id, timestamp, kind)
      parts.forEach((part, index) => this.sql.exec("INSERT INTO backup_chunks (backup_id, part, json) VALUES (?, ?, ?)", id, index, part))
      const expired = this.sql.exec("SELECT id FROM backups WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 30", kind).toArray()
      for (const row of expired) {
        this.sql.exec("DELETE FROM backup_chunks WHERE backup_id = ?", row.id)
        this.sql.exec("DELETE FROM backups WHERE id = ?", row.id)
      }
    }
  }

  // handler 及持久化均同步执行，期间绝不 await；事务失败后内存也回滚，失败不广播。
  run(handler, { mutating = false, email = "", deviceId = "" } = {}) {
    const before = mutating ? structuredClone(this.state) : null
    this.dirty = false
    this.pendingAudit = []
    this.actorEmail = email
    let nextRecords = this.records
    let nextSequence = this.sequence
    try {
      const body = this.storage.transactionSync(() => {
        let result = handler()
        if (result && typeof result.then === "function") throw new Error("持久化事务不能包含异步业务操作")
        if (this.dirty) {
          if (!mutating) throw new Error("只读请求意外修改了数据")
          nextRecords = encodeRecords(this.state)
          this.backup(before)
          for (const key of this.records.keys()) if (!nextRecords.has(key)) this.sql.exec("DELETE FROM records WHERE key = ?", key)
          for (const [key, json] of nextRecords) {
            if (this.records.get(key) !== json) this.sql.exec("INSERT INTO records (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json", key, json)
          }
          nextSequence += 1
          this.sql.exec("INSERT INTO runtime (key, value) VALUES ('sequence', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", nextSequence)
        }
        for (const row of this.pendingAudit) this.sql.exec("INSERT INTO audit (at, email, who, action, detail) VALUES (?, ?, ?, ?, ?)", row.at, row.email, row.who, row.action, row.detail)
        if (this.pendingAudit.length) this.sql.exec("DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET 9999)")
        if (result?.stage) result = { ...result, hosting: "cloudflare", cloudDataLimit: CLOUD_DATA_LIMIT }
        return JSON.stringify(result)
      })
      this.records = nextRecords
      this.sequence = nextSequence
      const changed = this.dirty
      const by = this.state.staff.find((person) => person.id === this.device(deviceId))?.name || ""
      return { body, changed, sequence: this.sequence, by }
    } catch (error) {
      if (before) { this.state = before; this.rebuildDayIndex() }
      throw error
    } finally {
      this.dirty = false
      this.pendingAudit = []
      this.actorEmail = ""
    }
  }

  listBackups(deviceId) {
    this.requireStaff(deviceId)
    return { backups: this.sql.exec("SELECT id, created_at AS createdAt, kind FROM backups ORDER BY created_at DESC, id DESC").toArray() }
  }

  readBackup(deviceId, backupId) {
    this.requireStaff(deviceId)
    const parts = this.sql.exec("SELECT json FROM backup_chunks WHERE backup_id = ? ORDER BY part", backupId).toArray()
    if (!parts.length) fail(404, "找不到这份云端备份")
    return JSON.parse(parts.map((part) => part.json).join(""))
  }

  restoreBackup({ deviceId, backupId, expectedSequence }) {
    this.requireStaff(deviceId)
    if (expectedSequence !== this.sequence) fail(409, "备份列表加载后又有人修改数据，请刷新列表再恢复")
    const data = this.readBackup(deviceId, backupId)
    const result = this.importData({ deviceId, data })
    this.audit(deviceId, "恢复云端备份", { backupId })
    return result
  }

  listAudit(deviceId) {
    this.requireStaff(deviceId)
    return { audit: this.sql.exec("SELECT at, email, who, action, detail FROM audit ORDER BY id DESC LIMIT 10000").toArray() }
  }
}
