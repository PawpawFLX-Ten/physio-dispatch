// 落盘的事都在这：原子写、备份、审计、导入导出。
import fs from "node:fs"
import path from "node:path"
import { emptyState, fail, normalizeLoadedState, sanitizeState, two } from "./helpers.js"

const BACKUP_INTERVAL_MS = 60_000
const BACKUP_KEEP = 30
const BACKUP_KEEP_DAYS = 30
const BACKUP_NAME = /^clinic-\d{8}-\d{6}\.json$/
const AUDIT_MAX_BYTES = 5 * 1024 * 1024
// 单行审计的上限：改动内容（比如整段 patch）原样进日志会把文件撑爆，超长就折成预览。
const AUDIT_LINE_MAX = 600

function backupName(now = new Date()) {
  return `clinic-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.json`
}

export const ioMethods = {
  backupDir() {
    return path.join(path.dirname(this.file), "backups")
  },

  backupFiles(dir) {
    try {
      return fs.readdirSync(dir).filter((name) => BACKUP_NAME.test(name)).sort()
    } catch {
      return []
    }
  },

  // 保存前把上一份完整数据抄进 backups。同一分钟内只抄一次，太频繁没有必要。
  backup() {
    try {
      if (!fs.existsSync(this.file)) return
      const dir = this.backupDir()
      const files = this.backupFiles(dir)
      if (files.length) {
        const newest = fs.statSync(path.join(dir, files[files.length - 1])).mtimeMs
        if (Date.now() - newest < BACKUP_INTERVAL_MS) return
      }
      fs.mkdirSync(dir, { recursive: true })
      // 同一秒里可能连续保存好几次，名字撞了就往后推一秒，别把上一份盖掉。
      let name = backupName()
      for (let bump = 1; files.includes(name); bump++) {
        name = backupName(new Date(Date.now() + bump * 1000))
      }
      fs.copyFileSync(this.file, path.join(dir, name))
      this.pruneBackups(dir)
      // 可选：再抄一份到机外目录（U 盘、网盘同步夹）。没设环境变量就不做。
      const mirror = process.env.BACKUP_MIRROR_DIR
      if (mirror && String(mirror).trim()) {
        try {
          const mirrorDir = path.resolve(String(mirror).trim())
          fs.mkdirSync(mirrorDir, { recursive: true })
          fs.copyFileSync(this.file, path.join(mirrorDir, name))
        } catch {
          /* 镜像失败不挡主备份 */
        }
      }
    } catch {
      /* 备份失败不挡保存，主文件照常写 */
    }
  },

  // 留最近 BACKUP_KEEP 份分钟级备份；另外每天最早的一份也留，最多 BACKUP_KEEP_DAYS 天。
  pruneBackups(dir) {
    const files = this.backupFiles(dir)
    const keep = new Set(files.slice(-BACKUP_KEEP))
    const firstOfDay = new Map()
    for (const name of files) {
      const day = name.slice(7, 15)
      if (!firstOfDay.has(day)) firstOfDay.set(day, name)
    }
    for (const day of [...firstOfDay.keys()].sort().slice(-BACKUP_KEEP_DAYS)) {
      keep.add(firstOfDay.get(day))
    }
    for (const name of files) {
      if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true })
    }
  },

  audit(deviceId, action, detail = {}) {
    try {
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true })
      const meId = this.device(deviceId)
      const me = this.state.staff.find((person) => person.id === meId)
      const base = { t: new Date().toISOString(), who: me?.name || "", action }
      let line = JSON.stringify({ ...base, ...detail })
      if (line.length > AUDIT_LINE_MAX) {
        // 保持每行仍是合法 JSON，只是把改动折成截断的预览。
        line = JSON.stringify({ ...base, 改动预览: JSON.stringify(detail).slice(0, 400) })
      }
      fs.appendFileSync(this.auditFile, `${line}\n`)
      if (fs.statSync(this.auditFile).size > AUDIT_MAX_BYTES) this.rotateAudit()
    } catch {
      /* 审计写不进去不挡操作 */
    }
  },

  rotateAudit() {
    const dir = path.dirname(this.auditFile)
    const base = path.basename(this.auditFile, path.extname(this.auditFile))
    fs.renameSync(this.auditFile, path.join(dir, `${base}-${Date.now()}.log`))
    const olds = fs.readdirSync(dir).filter((name) => name.startsWith(`${base}-`) && name.endsWith(".log")).sort()
    // 留 12 份旧档（约 60MB）：留痕周期太短，出了争议翻不回去。
    for (const name of olds.slice(0, -12)) fs.rmSync(path.join(dir, name), { force: true })
  },

  load() {
    if (!fs.existsSync(this.file)) {
      this.state = emptyState()
      this.rebuildDayIndex()
      return
    }
    let state = null
    try {
      state = normalizeLoadedState(JSON.parse(fs.readFileSync(this.file, "utf8")))
    } catch {
      state = null
    }
    if (!state) {
      // 主文件读不出来或形状不对时退回最新一份能用的备份，别让整间治疗室开不了门。
      const recovered = this.recoverFromBackup()
      if (!recovered) fail(500, "治疗室数据读不出来")
      state = recovered
      console.error(`[clinic] clinic.json 损坏，已回退到备份 ${this.recoveredFrom}（最近一分钟的数据可能没有）`)
    }
    this.state = state
    this.rebuildDayIndex()
  },

  recoverFromBackup() {
    const dir = this.backupDir()
    for (const name of [...this.backupFiles(dir)].reverse()) {
      try {
        const state = normalizeLoadedState(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")))
        if (state) {
          this.recoveredFrom = name
          return state
        }
      } catch {
        /* 这份备份也读不出来，接着试更早的 */
      }
    }
    return null
  },

  // 「病人 → 来过哪几天」的索引，visitHistory / patientLastDays 不用每次全量翻历史。
  // 索引不跟着写路径维护：读之前对一遍「天数键 + 各天条目数」的签名，对不上就重建。
  // 签名只数各天 entries.length，代价小；旁路改动（测试直接挪 state.days、导入整份数据）
  // 也不会读出脏结果。
  rebuildDayIndex() {
    this.byPatient = new Map()
    for (const [day, record] of Object.entries(this.state.days || {})) {
      for (const entry of record?.entries || []) {
        if (!entry?.patientId) continue
        const list = this.byPatient.get(entry.patientId) || []
        list.push({ day, entryId: entry.id })
        this.byPatient.set(entry.patientId, list)
      }
    }
    this.indexedDays = this.daysSignature()
  },

  daysSignature() {
    const days = this.state.days || {}
    const parts = []
    for (const key of Object.keys(days)) {
      parts.push(`${key}:${days[key]?.entries?.length || 0}`)
    }
    return parts.join("|")
  },

  ensureDayIndex() {
    if (this.indexedDays !== this.daysSignature()) this.rebuildDayIndex()
  },

  // 写穿到磁盘：文件内容和目录项都 fsync，掉电后 clinic.json 不会变空。
  save() {
    this.backup()
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    const fd = fs.openSync(tmp, "w")
    try {
      fs.writeFileSync(fd, JSON.stringify(this.state, null, 2))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.file)
    try {
      const dirFd = fs.openSync(dir, "r")
      try {
        fs.fsyncSync(dirFd)
      } finally {
        fs.closeSync(dirFd)
      }
    } catch {
      /* 有些文件系统不让 fsync 目录，主文件已经 fsync 过，够了 */
    }
    this.emitChange()
  },

  exportData(deviceId) {
    this.requireStaff(deviceId)
    this.state.lastExportAt = new Date().toISOString()
    this.save()
    this.audit(deviceId, "导出数据")
    return structuredClone(this.state)
  },

  importData({ deviceId, data }) {
    const staff = this.requireStaff(deviceId)
    const next = sanitizeState(data)
    // 导入的名单里有当前这个人，就保住这台手机的绑定，导入完不用重新进门。
    if (next.staff.some((person) => person.id === staff.id)) next.devices[deviceId] = staff.id
    const prev = this.state
    this.state = next
    this.rebuildDayIndex()
    try {
      // 先确认新数据能正常投影再落盘：万一视图还有意外，坏数据不至于写进档案。
      const result = this.view(deviceId)
      this.save()
      this.audit(deviceId, "导入数据", { 病人: next.patients.length, 名单: next.staff.length })
      return result
    } catch (error) {
      // 落盘失败（比如磁盘满）：内存回到导入前，别让内存和磁盘各说各话、重启后「回到过去」。
      this.state = prev
      this.rebuildDayIndex()
      throw error
    }
  },
}
