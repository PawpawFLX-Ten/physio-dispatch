import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClinicStore, todayKey } from "../server/store.js"

function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-test-"))
  const store = new ClinicStore(path.join(dir, "clinic.json"))
  store.load()
  return store
}

function setupRoom(store) {
  store.setup({ deviceId: "doc", staffName: "之之" })
  store.claim({ deviceId: "aide", staffName: "小李" })
}

test("first device sets the name; next phone picks who they are", () => {
  const store = openStore()
  const view = store.setup({ deviceId: "doc", staffName: "之之" })
  assert.equal(view.stage, "ready")
  assert.equal(view.me.name, "之之")
  assert.equal(store.view("new-phone").stage, "whoami")
})

test("the second phone picks a name without a passphrase", () => {
  const store = openStore()
  setupRoom(store)
  const pending = store.view("other")
  assert.equal(pending.stage, "whoami")
  const ready = store.claim({ deviceId: "other", staffId: store.state.staff[0].id })
  assert.equal(ready.me.name, "之之")
})

test("claiming a new phone writes once; looking at a known phone does not", () => {
  const store = openStore()
  setupRoom(store)
  let broadcasts = 0
  store.subscribe(() => {
    broadcasts += 1
  })
  const file = store.file
  const before = fs.statSync(file).mtimeMs
  const view = store.view("doc")
  assert.equal(view.stage, "ready")
  assert.equal(broadcasts, 0)
  assert.equal(fs.statSync(file).mtimeMs, before)
  // 新设备认人时才真正写盘：广播一次，文件时间戳也变了。
  store.claim({ deviceId: "new-phone", staffName: "小王" })
  assert.equal(broadcasts, 1)
  assert.ok(fs.statSync(file).mtimeMs >= before)
})

test("day index matches brute force and self-heals after direct days surgery", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "历史阿姨", conditionName: "膝盖" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring" })
  store.leave({ deviceId: "doc", entryId, updateCondition: true })
  const brute = new Map()
  for (const [day, record] of Object.entries(store.state.days)) {
    for (const entry of record?.entries || []) {
      const known = brute.get(entry.patientId)
      if (!known || day > known) brute.set(entry.patientId, day)
    }
  }
  const patientId = created.entry.patientId
  assert.equal(store.patientLastDays().get(patientId), brute.get(patientId))
  assert.ok(store.visitHistory(patientId).length >= 1)
  // 直接清空历史（绕过所有写方法），索引必须自己发现并重建
  store.state.days = {}
  assert.equal(store.patientLastDays().size, 0)
  assert.equal(store.visitHistory(patientId).length, 0)
  store.addExisting({ deviceId: "doc", patientId })
  assert.equal(store.visitHistory(patientId).length, 1)
})

test("corrupt clinic.json falls back to the newest readable backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-recover-"))
  const file = path.join(dir, "clinic.json")
  const store = new ClinicStore(file)
  store.load()
  store.setup({ deviceId: "doc", staffName: "之之" })
  store.claim({ deviceId: "aide", staffName: "小李" }) // 第二次保存，产生第一份备份
  fs.writeFileSync(file, "{broken")
  const revived = new ClinicStore(file)
  revived.load()
  assert.equal(revived.stage("doc"), "ready")
  assert.equal(revived.state.staff.length, 1)
  assert.equal(revived.state.staff[0].name, "之之")
  assert.equal(revived.stage("aide"), "whoami")
})

test("an existing single condition opens without asking, assign and complete stay on today", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring" })
  store.addItem({ deviceId: "doc", entryId, targetId: "soleus" })
  store.leave({ deviceId: "doc", entryId, updateCondition: false })
  const patientId = created.entry.patientId
  store.state.days = {}
  const again = store.addExisting({ deviceId: "aide", patientId })
  assert.equal(again.entry.items.length, 2)
  assert.equal(again.entry.items[0].targetId, "hamstring")
  assert.equal(again.entry.items[0].assigneeId, null)
  const aide = store.state.staff.find((person) => person.name === "小李")
  const assigned = store.assignAll({ deviceId: "aide", entryId: again.entry.id, assigneeId: aide.id })
  assert.equal(assigned.entry.items.every((item) => item.assigneeName === "小李"), true)
  const done = store.patchItem({
    deviceId: "aide",
    entryId: again.entry.id,
    itemId: assigned.entry.items[0].id,
    patch: { done: true },
  })
  assert.equal(done.entry.diverged, false)
  const condition = store.patient(patientId).conditions[0]
  assert.equal(condition.items[0].targetId, "hamstring")
  assert.equal(condition.items[0].assigneeId, undefined)
})

test("new items keep the previous assignee; first item goes to the operator", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  const doc = store.state.staff.find((person) => person.name === "之之")
  const aide = store.state.staff.find((person) => person.name === "小李")
  store.setChief({ deviceId: "doc", entryId, targetId: "knee" })
  const first = store.addItem({ deviceId: "doc", entryId, targetId: "hamstring" })
  assert.equal(first.entry.items[0].assigneeId, doc.id)
  store.patchItem({ deviceId: "doc", entryId, itemId: first.entry.items[0].id, patch: { assigneeId: aide.id } })
  const second = store.addItem({ deviceId: "doc", entryId, targetId: "soleus" })
  assert.equal(second.entry.items[1].assigneeId, aide.id)
  // 单项改派不写回病症
  const patched = store.patchItem({
    deviceId: "doc",
    entryId,
    itemId: second.entry.items[1].id,
    patch: { assigneeId: doc.id },
  })
  assert.equal(patched.entry.items[1].assigneeId, doc.id)
  assert.equal(patched.entry.diverged, false)
})

test("reorder asks before writing back, and declining keeps the saved condition", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "soleus" })
  store.leave({ deviceId: "doc", entryId: created.entry.id, updateCondition: false })
  store.state.days = {}
  const again = store.addExisting({ deviceId: "doc", patientId: created.entry.patientId })
  const [first, second] = again.entry.items
  const moved = store.reorder({
    deviceId: "aide",
    entryId: again.entry.id,
    orderedIds: [second.id, first.id],
  })
  assert.equal(moved.entry.diverged, true)
  assert.equal(moved.entry.items[0].targetId, "soleus")
  store.leave({ deviceId: "aide", entryId: again.entry.id, updateCondition: false })
  const saved = store.patient(created.entry.patientId).conditions[0].items.map((item) => item.targetId)
  assert.deepEqual(saved, ["hamstring", "soleus"])
  const today = store.entryById(again.entry.id).items.map((item) => item.targetId)
  assert.deepEqual(today, ["soleus", "hamstring"])
})

test("copy keeps the chain and leaves assignee empty until someone is chosen", () => {
  const store = openStore()
  setupRoom(store)
  const origin = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: origin.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: origin.entry.id, targetId: "hamstring" })
  store.leave({ deviceId: "doc", entryId: origin.entry.id, updateCondition: true })
  const other = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  const conditionId = store.patient(origin.entry.patientId).conditions[0].id
  store.copyCondition({ deviceId: "doc", conditionId, targetPatientId: other.entry.patientId })
  const copied = store.patient(other.entry.patientId).conditions.find((condition) => condition.name === "右膝疼痛")
  assert.equal(copied.items[0].targetId, "hamstring")
  assert.equal(copied.items[0].assigneeId, undefined)
  store.state.days = {}
  const opened = store.addExisting({
    deviceId: "doc",
    patientId: other.entry.patientId,
    conditionIds: [copied.id],
  })
  assert.equal(opened.entry.items[0].assigneeId, null)
})

test("including a condition makes it the focus for new taps", () => {
  const store = openStore()
  setupRoom(store)
  const origin = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: origin.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: origin.entry.id, targetId: "hamstring" })
  store.leave({ deviceId: "doc", entryId: origin.entry.id, updateCondition: true })
  const created = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  const copiedId = store.patient(origin.entry.patientId).conditions[0].id
  store.copyCondition({ deviceId: "doc", conditionId: copiedId, targetPatientId: created.entry.patientId })
  const copied = store.patient(created.entry.patientId).conditions.find((condition) => condition.name === "右膝疼痛")
  store.includeCondition({ deviceId: "doc", entryId: created.entry.id, conditionId: copied.id })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "quad" })
  const last = store.entryById(created.entry.id).items.at(-1)
  assert.equal(last.conditionId, copied.id)
  assert.equal(last.targetId, "quad")
})

test("adding an existing patient already on today still includes selected conditions", () => {
  const store = openStore()
  setupRoom(store)
  const origin = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: origin.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: origin.entry.id, targetId: "hamstring" })
  store.leave({ deviceId: "doc", entryId: origin.entry.id, updateCondition: true })
  const created = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  const copiedId = store.patient(origin.entry.patientId).conditions[0].id
  store.copyCondition({ deviceId: "doc", conditionId: copiedId, targetPatientId: created.entry.patientId })
  const copied = store.patient(created.entry.patientId).conditions.find((condition) => condition.name === "右膝疼痛")
  const again = store.addExisting({
    deviceId: "doc",
    patientId: created.entry.patientId,
    conditionIds: [copied.id],
  })
  assert.equal(again.entry.id, created.entry.id)
  assert.equal(again.entry.conditionIds.includes(copied.id), true)
  assert.equal(again.entry.items.some((item) => item.targetId === "hamstring"), true)
})

test("joining multiple conditions keeps the order they were given", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  store.addCondition({ deviceId: "doc", entryId: created.entry.id, name: "右膝疼痛" })
  store.leave({ deviceId: "doc", entryId: created.entry.id, updateCondition: false })
  const patient = store.patient(created.entry.patientId)
  const [waist, knee] = patient.conditions
  store.state.days = {}
  const opened = store.addExisting({
    deviceId: "doc",
    patientId: patient.id,
    conditionIds: [knee.id, waist.id],
  })
  assert.deepEqual(opened.entry.conditionIds, [knee.id, waist.id])
})

test("claiming a typed name that already exists reuses that person", () => {
  const store = openStore()
  setupRoom(store)
  const result = store.claim({ deviceId: "other", staffName: "之之" })
  assert.equal(result.me.name, "之之")
  assert.equal(store.state.staff.filter((person) => person.name === "之之").length, 1)
})

test("completing records who did it and a second complete does not overwrite", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  const itemId = created.entry.items?.length
    ? created.entry.items[0].id
    : store.entryById(created.entry.id).items[0].id
  const done = store.patchItem({
    deviceId: "doc",
    entryId: created.entry.id,
    itemId,
    patch: { done: true },
  })
  const zhi = store.state.staff.find((person) => person.name === "之之")
  assert.equal(done.entry.items[0].completedBy, zhi.id)
  assert.equal(done.entry.items[0].completedByName, "之之")
  const again = store.patchItem({
    deviceId: "aide",
    entryId: created.entry.id,
    itemId,
    patch: { done: true },
  })
  assert.equal(again.entry.items[0].completedBy, zhi.id)
  assert.equal(again.entry.items[0].completedByName, "之之")
})

test("addItem stores left or right side and side changes count as diverged", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee", side: "right" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring", side: "right" })
  store.leave({ deviceId: "doc", entryId: created.entry.id, updateCondition: true })
  assert.equal(store.patient(created.entry.patientId).conditions[0].chiefSide, "right")
  assert.equal(store.patient(created.entry.patientId).conditions[0].items[0].side, "right")
  store.state.days = {}
  const again = store.addExisting({ deviceId: "doc", patientId: created.entry.patientId })
  assert.equal(again.entry.chiefSide, "right")
  assert.equal(again.entry.items[0].side, "right")
  assert.equal(again.entry.diverged, false)
  store.patchItem({
    deviceId: "doc",
    entryId: again.entry.id,
    itemId: again.entry.items[0].id,
    patch: { side: "left" },
  })
  assert.equal(store.entryView("doc", again.entry.id).entry.diverged, true)
})

test("dropping an entry removes it from today without deleting the patient", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.dropEntry({ deviceId: "doc", entryId: created.entry.id })
  assert.equal(store.todayList().length, 0)
  assert.equal(store.patient(created.entry.patientId).name, "王阿姨")
})

test("old clinic.json with a passphrase hash skips straight to whoami or ready", () => {
  const store = openStore()
  store.state = {
    passphrase: "pbkdf2$100000$deadbeef$cafebabe",
    staff: [{ id: "s1", name: "之之" }],
    devices: { doc: "s1" },
    patients: [],
    templates: [],
    days: {},
  }
  store.save()
  store.load()
  assert.equal(store.view("doc").stage, "ready")
  assert.equal(store.view("phone").stage, "whoami")
})

test("setFocus directs the next added item", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  store.addCondition({ deviceId: "doc", entryId: created.entry.id, name: "右膝疼痛" })
  const [waist, knee] = store.patient(created.entry.patientId).conditions
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "lumbar" })
  store.setFocus({ deviceId: "doc", entryId: created.entry.id, conditionId: waist.id })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "lumbar" })
  assert.equal(store.entryById(created.entry.id).items.at(-1).conditionId, waist.id)
  store.setFocus({ deviceId: "doc", entryId: created.entry.id, conditionId: knee.id })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "quad" })
  assert.equal(store.entryById(created.entry.id).items.at(-1).conditionId, knee.id)
})

test("atomic save leaves a valid json file and no leftover temp", () => {
  const store = openStore()
  setupRoom(store)
  JSON.parse(fs.readFileSync(store.file, "utf8"))
  assert.equal(fs.existsSync(`${store.file}.tmp`), false)
})

test("opening yesterday's slip after midnight does not invent a new today entry", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  const today = todayKey()
  store.state.days = { "2020-01-01": store.state.days[today] }
  assert.throws(() => store.entryView("doc", entryId), /过了零点|今天没有/)
  assert.equal(store.todayList().length, 0)
})

function backupNames(store) {
  return fs.readdirSync(store.backupDir()).filter((name) => /^clinic-\d{8}-\d{6}\.json$/.test(name)).sort()
}

test("saves within the same minute keep only one backup", () => {
  const store = openStore()
  setupRoom(store)
  const names = backupNames(store)
  assert.equal(names.length, 1)
  JSON.parse(fs.readFileSync(path.join(store.backupDir(), names[0]), "utf8"))
})

test("an aged newest backup lets the next save take another one", () => {
  const store = openStore()
  setupRoom(store)
  const dir = store.backupDir()
  const first = path.join(dir, backupNames(store)[0])
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(first, old, old)
  store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  assert.equal(backupNames(store).length, 2)
})

test("backup retention keeps the newest thirty plus the first of each day", () => {
  const store = openStore()
  setupRoom(store)
  const dir = store.backupDir()
  fs.rmSync(path.join(dir, backupNames(store)[0]))
  const old = new Date(Date.now() - 120_000)
  for (let i = 0; i < 40; i++) {
    const stamp = String(i).padStart(6, "0")
    const file = path.join(dir, `clinic-20250101-${stamp}.json`)
    fs.writeFileSync(file, "{}")
    fs.utimesSync(file, old, old)
  }
  store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  assert.equal(backupNames(store).length, 31)
})

test("mutations append who-did-what lines to the audit log", () => {
  const store = openStore()
  setupRoom(store)
  store.createPatient({ deviceId: "aide", name: "王阿姨", conditionName: "右膝疼痛" })
  const lines = fs.readFileSync(store.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const last = lines[lines.length - 1]
  assert.equal(last.who, "小李")
  assert.equal(last.action, "新建病人")
  assert.equal(last.病人, "王阿姨")
})

test("export then import round-trips a room file", () => {
  const store = openStore()
  setupRoom(store)
  store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const data = store.exportData("doc")

  store.state.patients = []
  assert.equal(store.patientList().length, 0)
  assert.throws(() => store.importData({ deviceId: "doc", data: { patients: [] } }), /没有名单/)
  const result = store.importData({ deviceId: "doc", data })
  assert.equal(result.stage, "ready")
  assert.equal(store.state.patients[0].name, "王阿姨")
  assert.equal(store.view("guest").stage, "whoami")
})

test("importing another room's file asks this phone to pick a name again", () => {
  const source = openStore()
  setupRoom(source)
  source.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const target = openStore()
  target.setup({ deviceId: "boss", staffName: "老板" })
  const result = target.importData({ deviceId: "boss", data: source.exportData("doc") })
  assert.equal(result.stage, "whoami")
  assert.equal(target.state.patients[0].name, "王阿姨")
  assert.equal(target.claim({ deviceId: "boss", staffName: "老板" }).stage, "ready")
})

test("imported junk fields are dropped instead of crashing the room", () => {
  const store = openStore()
  setupRoom(store)
  const clean = store.exportData("doc")
  const junk = {
    ...clean,
    patients: [...clean.patients, { id: 42, name: "", conditions: "nope" }, null],
    days: { "not-a-date": { entries: [] }, "2026-01-01": { entries: [{ id: "e1" }, null, "x"] } },
    devices: { good: clean.staff[0].id, bad: "missing-staff", weird: 7 },
  }
  const result = store.importData({ deviceId: "doc", data: junk })
  assert.equal(result.stage, "ready")
  assert.equal(store.state.patients.every((patient) => typeof patient.id === "string"), true)
  assert.deepEqual(store.state.days["not-a-date"], undefined)
  // 无 patientId / 病人不存在的条目在导入时丢掉
  assert.equal(store.state.days["2026-01-01"].entries.length, 0)
  assert.equal(store.state.devices.good, clean.staff[0].id)
  assert.equal("bad" in store.state.devices, false)
  assert.equal("weird" in store.state.devices, false)
})

test("templates capture today's chain and seed new patients", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "soleus" })
  const itemId = store.entryById(created.entry.id).items[0].id
  store.patchItem({ deviceId: "doc", entryId: created.entry.id, itemId, patch: { technique: "release" } })
  store.saveTemplateFromEntry({ deviceId: "doc", entryId: created.entry.id, name: "膝痛常规" })
  const template = store.state.templates[0]
  assert.equal(template.name, "膝痛常规")
  assert.equal(template.items.length, 2)
  assert.equal(template.items[0].technique, "release")
  assert.equal(template.chiefSiteId, "knee")

  const fresh = store.createPatientFromTemplate({ deviceId: "aide", name: "李叔", templateId: template.id })
  assert.deepEqual(
    fresh.entry.items.map((item) => item.targetId),
    ["hamstring", "soleus"],
  )
  assert.equal(fresh.entry.items[0].technique, "release")
  assert.equal(fresh.entry.chiefSiteId, "knee")
  assert.equal(fresh.entry.items[0].assigneeId, null)
  const patient = store.patient(fresh.entry.patientId)
  assert.equal(patient.conditions[0].name, "膝痛常规")
  assert.equal(patient.conditions[0].fresh, false)

  assert.throws(() => store.deleteTemplate({ deviceId: "doc", templateId: "nope" }), /找不到这个模板/)
  store.deleteTemplate({ deviceId: "doc", templateId: template.id })
  assert.equal(store.state.templates.length, 0)
})

test("a template can be applied to an existing patient as a new condition", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  store.saveTemplateFromEntry({ deviceId: "doc", entryId: created.entry.id, name: "膝痛常规" })
  const templateId = store.state.templates[0].id
  const other = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  const result = store.applyTemplateToEntry({ deviceId: "doc", entryId: other.entry.id, templateId })
  assert.equal(result.entry.conditionIds.length, 2)
  assert.equal(result.entry.items.some((item) => item.targetId === "hamstring"), true)
  assert.equal(result.entry.focusConditionId, result.entry.conditionIds[1])
  const patient = store.patient(other.entry.patientId)
  assert.equal(patient.conditions.length, 2)
  assert.equal(patient.conditions[1].name, "膝痛常规")
})

test("templates survive export and import", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  store.saveTemplateFromEntry({ deviceId: "doc", entryId: created.entry.id, name: "膝痛常规" })
  const data = store.exportData("doc")
  store.importData({ deviceId: "doc", data: { ...data, templates: [...data.templates, null, { name: "" }] } })
  assert.equal(store.state.templates.length, 1)
  assert.equal(store.state.templates[0].name, "膝痛常规")
})

test("today rows count my items and the room remembers the last assignee", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "soleus" })
  const aide = store.state.staff.find((person) => person.name === "小李")
  const doc = store.state.staff.find((person) => person.name === "之之")
  const items = store.entryById(created.entry.id).items
  store.patchItem({ deviceId: "doc", entryId: created.entry.id, itemId: items[0].id, patch: { assigneeId: aide.id } })
  store.patchItem({ deviceId: "doc", entryId: created.entry.id, itemId: items[0].id, patch: { done: true } })
  const row = store.view("aide").today[0]
  assert.equal(row.total, 2)
  assert.equal(row.doneCount, 1)
  assert.equal(row.mineTotal, 1)
  assert.equal(row.mineDone, 1)
  const stranger = store.view("doc")
  // 新点的项默认派给点的人：doc 手上还有没转出去的 soleus
  assert.equal(stranger.today[0].mineTotal, 1)
  assert.equal(stranger.today[0].mineDone, 0)
  const entry = store.entryView("doc", created.entry.id).entry
  assert.equal(entry.lastAssigneeId, aide.id)
  assert.equal(entry.lastAssigneeName, "小李")
  store.assignAll({ deviceId: "doc", entryId: created.entry.id, assigneeId: doc.id })
  const after = store.entryView("doc", created.entry.id).entry
  assert.equal(after.lastAssigneeName, "之之")
})

test("patient list puts the recently treated first", () => {
  const store = openStore()
  setupRoom(store)
  const first = store.createPatient({ deviceId: "doc", name: "张三", conditionName: "腰紧" })
  store.leave({ deviceId: "doc", entryId: first.entry.id, updateCondition: true })
  const today = todayKey()
  const days = { ...store.state.days }
  days["2020-01-01"] = days[today]
  delete days[today]
  store.state.days = days
  store.createPatient({ deviceId: "doc", name: "李四", conditionName: "颈僵" })
  const list = store.view("doc").patients
  const names = list.map((patient) => patient.name)
  assert.equal(names.indexOf("李四") < names.indexOf("张三"), true)
  assert.equal(list.find((patient) => patient.name === "李四").lastDay, today)
  assert.equal(list.find((patient) => patient.name === "张三").lastDay, "2020-01-01")
})

test("new muscle targets are pickable work items", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "肩袖损伤" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "shoulder", side: "right" })
  for (const targetId of ["supraspinatus", "infraspinatus", "subscapularis", "teres-minor"]) {
    store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId, side: "right" })
  }
  const items = store.entryById(created.entry.id).items
  assert.deepEqual(
    items.map((item) => item.targetId),
    ["supraspinatus", "infraspinatus", "subscapularis", "teres-minor"],
  )
  assert.equal(items.every((item) => item.side === "right"), true)
})

test("repeat last day copies the actual chain, order and assignees", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "knee", side: "left" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring", side: "left" })
  store.addItem({ deviceId: "doc", entryId, targetId: "soleus", side: "left" })
  const aide = store.state.staff.find((person) => person.name === "小李")
  const items = store.entryById(entryId).items
  store.reorder({ deviceId: "doc", entryId, orderedIds: [items[1].id, items[0].id] })
  store.assignAll({ deviceId: "doc", entryId, assigneeId: aide.id })
  store.leave({ deviceId: "doc", entryId, updateCondition: false })

  // 把今天挪到昨天，明天再来照上次的单
  const today = todayKey()
  const days = { ...store.state.days }
  days["2020-01-01"] = days[today]
  delete days[today]
  store.state.days = days

  const patientRow = store.view("doc").patients.find((patient) => patient.name === "王阿姨")
  assert.equal(patientRow.prevDay, "2020-01-01")
  const repeated = store.repeatLastDay({ deviceId: "doc", patientId: patientRow.id })
  assert.deepEqual(
    repeated.entry.items.map((item) => item.targetId),
    ["soleus", "hamstring"],
  )
  assert.equal(repeated.entry.items.every((item) => item.assigneeId === aide.id), true)
  assert.equal(repeated.entry.items.every((item) => item.done === false), true)
  assert.equal(repeated.entry.chiefSide, "left")
  assert.throws(() => store.repeatLastDay({ deviceId: "doc", patientId: patientRow.id }), /已经在单上/)
})

test("quick add stores the parsed chain in one request", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "肩袖损伤" })
  const result = store.quickAdd({
    deviceId: "doc",
    entryId: created.entry.id,
    chief: { targetId: "shoulder", side: "right" },
    items: [
      { targetId: "supraspinatus", side: "right", technique: "release", direction: "along", dose: { minutes: 10 } },
      { targetId: "infraspinatus", side: "right", technique: "equipment", direction: "along", dose: { sets: 3, reps: 12 } },
    ],
  })
  assert.equal(result.entry.chiefSiteId, "shoulder")
  assert.equal(result.entry.chiefSide, "right")
  assert.equal(result.entry.items[0].dose.minutes, 10)
  assert.deepEqual(result.entry.items[1].dose, { sets: 3, reps: 12 })
  assert.throws(
    () =>
      store.quickAdd({
        deviceId: "doc",
        entryId: created.entry.id,
        chief: null,
        items: [{ targetId: "supraspinatus", technique: "nope", direction: "along" }],
      }),
    /手法不对/,
  )
})

test("patient notes show up in today rows and the patient page", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setPatientNote({ deviceId: "doc", patientId: created.entry.patientId, note: "  高血压，别趴着按  " })
  assert.equal(store.view("doc").today[0].note, "高血压，别趴着按")
  assert.equal(store.entryView("doc", created.entry.id).entry.note, "高血压，别趴着按")
  assert.equal(store.view("doc").patients[0].note, "高血压，别趴着按")
  store.setPatientNote({ deviceId: "doc", patientId: created.entry.patientId, note: "" })
  assert.equal(store.view("doc").today[0].note, "")
})

test("today by staff groups counts per person with unassigned last", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "soleus" })
  const aide = store.state.staff.find((person) => person.name === "小李")
  const doc = store.state.staff.find((person) => person.name === "之之")
  const items = store.entryById(created.entry.id).items
  store.patchItem({ deviceId: "doc", entryId: created.entry.id, itemId: items[0].id, patch: { assigneeId: aide.id } })
  store.patchItem({ deviceId: "doc", entryId: created.entry.id, itemId: items[0].id, patch: { done: true } })
  const groups = store.view("doc").todayByStaff
  // doc 点的两项默认派给 doc，第一项转给了小李
  const aideGroup = groups.find((group) => group.staffId === aide.id)
  const docGroup = groups.find((group) => group.staffId === doc.id)
  assert.equal(aideGroup.total, 1)
  assert.equal(aideGroup.done, 1)
  assert.equal(docGroup.total, 1)
  assert.equal(docGroup.patients[0].patientName, "王阿姨")
})

test("visit history and last summary reflect what was actually done", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "knee", side: "left" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring", side: "left" })
  store.addItem({ deviceId: "doc", entryId, targetId: "soleus", side: "left" })
  const items = store.entryById(entryId).items
  store.patchItem({ deviceId: "doc", entryId, itemId: items[0].id, patch: { done: true } })
  store.leave({ deviceId: "doc", entryId, updateCondition: false })

  // 把今天挪去前天，再照病症建今天的单
  const today = todayKey()
  const days = { ...store.state.days }
  days["2026-09-21"] = days[today]
  delete days[today]
  store.state.days = days
  const again = store.addExisting({ deviceId: "doc", patientId: created.entry.patientId })
  store.setChief({ deviceId: "doc", entryId: again.entry.id, targetId: "knee", side: "left" })
  store.addItem({ deviceId: "doc", entryId: again.entry.id, targetId: "quad", side: "left" })

  const row = store.view("doc").patients.find((patient) => patient.name === "王阿姨")
  assert.equal(row.lastSummary, "左腘绳肌、左比目鱼肌")
  assert.equal(row.prevDay, "2026-09-21")

  const history = store.entryView("doc", again.entry.id).entry.history
  assert.equal(history.length, 2)
  assert.equal(history[0].isToday, true)
  assert.equal(history[0].names, "左腘绳肌、左比目鱼肌、左股四头肌")
  assert.equal(history[1].day, "2026-09-21")
  assert.equal(history[1].doneCount, 1)
  assert.equal(history[1].total, 2)
})

test("print grouping carries the note for the handover sheet", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  store.setPatientNote({ deviceId: "doc", patientId: created.entry.patientId, note: "术后三个月" })
  const groups = store.view("doc").todayByStaff
  const row = groups[0].patients[0]
  assert.equal(row.note, "术后三个月")
})

test("last assignee survives export and import", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  const aide = store.state.staff.find((person) => person.name === "小李")
  store.assignAll({ deviceId: "doc", entryId: created.entry.id, assigneeId: aide.id })
  assert.equal(store.entryView("doc", created.entry.id).entry.lastAssigneeName, "小李")
  const data = store.exportData("doc")
  store.importData({ deviceId: "doc", data })
  const entryId = store.day().entries[0].id
  const again = store.entryView("doc", entryId).entry
  assert.equal(again.lastAssigneeId, aide.id)
  assert.equal(again.lastAssigneeName, "小李")
})

test("orphan today entries are skipped so the room still opens", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "hamstring" })
  const today = todayKey()
  store.state.days[today].entries.push({
    id: "orphan-entry",
    patientId: "missing-patient",
    conditionIds: [],
    chiefSiteId: null,
    chiefSide: null,
    focusConditionId: null,
    items: [{ id: "orphan-item", targetId: "soleus", side: null, done: false }],
  })
  const view = store.view("doc")
  assert.equal(view.stage, "ready")
  assert.equal(view.today.some((row) => row.id === "orphan-entry"), false)
  assert.equal(view.today.some((row) => row.patientName === "王阿姨"), true)
  assert.equal(
    view.todayByStaff.every((group) => group.patients.every((row) => row.entryId !== "orphan-entry")),
    true,
  )
})

test("import drops day entries whose patient is gone", () => {
  const store = openStore()
  setupRoom(store)
  const clean = store.exportData("doc")
  const junk = {
    ...clean,
    days: {
      [todayKey()]: {
        entries: [
          {
            id: "ghost",
            patientId: "no-such-patient",
            conditionIds: [],
            items: [],
          },
        ],
      },
    },
  }
  store.importData({ deviceId: "doc", data: junk })
  assert.equal(store.day().entries.length, 0)
  assert.equal(store.view("doc").stage, "ready")
})

test("rename patient blocks empty and duplicate names", () => {
  const store = openStore()
  setupRoom(store)
  const a = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  assert.throws(() => store.renamePatient({ deviceId: "doc", patientId: a.entry.patientId, name: "  " }), /请填写病人姓名/)
  assert.throws(
    () => store.renamePatient({ deviceId: "doc", patientId: a.entry.patientId, name: "李叔" }),
    /已有叫李叔的病人/,
  )
  store.renamePatient({ deviceId: "doc", patientId: a.entry.patientId, name: " 王阿姨改 " })
  assert.equal(store.patient(a.entry.patientId).name, "王阿姨改")
  assert.equal(store.entryView("doc", a.entry.id).entry.patientName, "王阿姨改")
})

test("archived patients leave the join list and can be restored", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const patientId = created.entry.patientId
  store.setPatientArchived({ deviceId: "doc", patientId, archived: true })
  assert.equal(store.patient(patientId).archived, true)
  assert.equal(store.patientList().find((row) => row.id === patientId).archived, true)
  // 已归档仍在名单投影里（设置页要能恢复），但加入列表前端会滤掉。
  assert.equal(store.patientList().some((row) => row.id === patientId && row.archived), true)
  // 今日单上的条目仍在。
  assert.equal(store.view("doc").today.some((row) => row.patientId === patientId), true)
  store.setPatientArchived({ deviceId: "doc", patientId, archived: false })
  assert.equal(store.patient(patientId).archived, false)
})

test("unused conditions can be deleted; ones on any day cannot", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const patientId = created.entry.patientId
  const usedId = store.patient(patientId).conditions[0].id
  // 再加一条病症挂进今天，再从今天拿掉它：档案里还在，但今天的单不再引用 → 仍算「用过」。
  store.addCondition({ deviceId: "doc", entryId: created.entry.id, name: "肩紧" })
  const shoulderId = store.patient(patientId).conditions.find((row) => row.name === "肩紧").id
  assert.throws(
    () => store.deleteCondition({ deviceId: "doc", patientId, conditionId: usedId }),
    /还在某天的单上用过/,
  )
  assert.throws(
    () => store.deleteCondition({ deviceId: "doc", patientId, conditionId: shoulderId }),
    /还在某天的单上用过/,
  )
  // 复制一条到别的病人，再在源病人上加一条从未上过单的。
  const other = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  // 直接往档案塞一条从未出现在 days 里的病症。
  const orphan = {
    id: "unused-cond",
    name: "试了一下",
    chiefSiteId: null,
    chiefSide: null,
    fresh: true,
    items: [],
  }
  store.patient(patientId).conditions.push(orphan)
  store.save()
  store.deleteCondition({ deviceId: "doc", patientId, conditionId: orphan.id })
  assert.equal(store.patient(patientId).conditions.some((row) => row.id === orphan.id), false)
  assert.ok(other.entry.id)
})

test("export then import keeps archived flag", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  store.setPatientArchived({ deviceId: "doc", patientId: created.entry.patientId, archived: true })
  const data = store.exportData("doc")
  assert.equal(data.patients[0].archived, true)
  store.importData({ deviceId: "doc", data })
  assert.equal(store.patient(created.entry.patientId).archived, true)
  assert.equal(store.patientList().find((row) => row.id === created.entry.patientId).archived, true)
})

test("restore puts a snapshot back with assignee and done intact", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring" })
  store.addItem({ deviceId: "doc", entryId, targetId: "soleus" })
  const aide = store.state.staff.find((person) => person.name === "小李")
  const [first, second] = store.entryById(entryId).items
  store.patchItem({ deviceId: "doc", entryId, itemId: first.id, patch: { assigneeId: aide.id, done: true } })
  const snapshot = structuredClone(store.entryById(entryId).items[0])
  store.removeItem({ deviceId: "doc", entryId, itemId: snapshot.id })
  assert.equal(store.entryById(entryId).items.length, 1)
  assert.equal(store.entryById(entryId).items[0].id, second.id)
  const restored = store.restoreItem({ deviceId: "doc", entryId, index: 0, item: snapshot })
  assert.equal(restored.entry.items.length, 2)
  assert.equal(restored.entry.items[0].targetId, "hamstring")
  assert.notEqual(restored.entry.items[0].id, snapshot.id)
  assert.equal(restored.entry.items[0].assigneeId, aide.id)
  assert.equal(restored.entry.items[0].done, true)
  assert.equal(restored.entry.items[0].completedBy, store.state.staff.find((person) => person.name === "之之").id)
  assert.equal(restored.entry.items[1].id, second.id)
  assert.throws(() => store.restoreItem({ deviceId: "doc", entryId, index: 9, item: snapshot }), /插回位置不对/)
})

test("reorder rejects duplicate ids and leaves the list unchanged", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring" })
  store.addItem({ deviceId: "doc", entryId, targetId: "soleus" })
  const before = store.entryById(entryId).items.map((item) => item.id)
  assert.throws(
    () => store.reorder({ deviceId: "doc", entryId, orderedIds: [before[0], before[0]] }),
    /顺序有重复/,
  )
  assert.deepEqual(
    store.entryById(entryId).items.map((item) => item.id),
    before,
  )
})

test("addItem and quickAdd require a chief site before work items", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  assert.throws(() => store.addItem({ deviceId: "doc", entryId, targetId: "hamstring" }), /要治的地方/)
  assert.throws(
    () =>
      store.quickAdd({
        deviceId: "doc",
        entryId,
        chief: null,
        items: [{ targetId: "hamstring", technique: "massage", direction: "along", dose: { minutes: 8 } }],
      }),
    /要治的地方/,
  )
  store.setChief({ deviceId: "doc", entryId, targetId: "knee" })
  const added = store.addItem({ deviceId: "doc", entryId, targetId: "hamstring" })
  assert.equal(added.entry.items[0].targetId, "hamstring")
  const spoken = store.quickAdd({
    deviceId: "doc",
    entryId,
    items: [{ targetId: "soleus", technique: "release", direction: "along", dose: { minutes: 6 } }],
  })
  assert.equal(spoken.entry.items.at(-1).targetId, "soleus")
})

test("copyCondition fromToday uses today's chain without assignee or done", () => {
  const store = openStore()
  setupRoom(store)
  const origin = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = origin.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "knee", side: "right" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring", side: "right" })
  store.addItem({ deviceId: "doc", entryId, targetId: "soleus", side: "right" })
  // 回写旧存档：顺序与今天不同，用来证明 fromToday 不读档案。
  store.leave({ deviceId: "doc", entryId, updateCondition: true })
  const condition = store.patient(origin.entry.patientId).conditions[0]
  condition.items.reverse()
  store.save()
  const items = store.entryById(entryId).items
  const aide = store.state.staff.find((person) => person.name === "小李")
  store.patchItem({
    deviceId: "doc",
    entryId,
    itemId: items[0].id,
    patch: { assigneeId: aide.id, done: true, technique: "release", dose: { minutes: 12 } },
  })
  store.reorder({ deviceId: "doc", entryId, orderedIds: [items[1].id, items[0].id] })
  const other = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  store.copyCondition({
    deviceId: "doc",
    conditionId: condition.id,
    targetPatientId: other.entry.patientId,
    fromToday: true,
  })
  const copied = store.patient(other.entry.patientId).conditions.find((row) => row.name === "右膝疼痛")
  assert.deepEqual(
    copied.items.map((item) => item.targetId),
    ["soleus", "hamstring"],
  )
  assert.equal(copied.items[1].technique, "release")
  assert.equal(copied.items[1].dose.minutes, 12)
  assert.equal(copied.chiefSiteId, "knee")
  assert.equal(copied.chiefSide, "right")
  assert.equal(copied.items.every((item) => item.assigneeId === undefined), true)
  assert.equal(copied.items.every((item) => item.done === undefined), true)
  store.dropEntry({ deviceId: "doc", entryId })
  assert.throws(
    () =>
      store.copyCondition({
        deviceId: "doc",
        conditionId: condition.id,
        targetPatientId: other.entry.patientId,
        fromToday: true,
      }),
    /今天没有这张单/,
  )
})

test("entry version bumps; stale reorder loses to a completed item", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring" })
  store.addItem({ deviceId: "doc", entryId, targetId: "soleus" })
  // 旧数据没有 version 时按 0 兼容
  delete store.entryById(entryId).version
  const entry = store.entryById(entryId)
  assert.equal(created.entry.version ?? 0, 0)

  const aide = store.state.staff.find((person) => person.name === "小李")
  store.assignAll({ deviceId: "doc", entryId, assigneeId: aide.id, expectedVersion: 0 })
  assert.equal(store.entryById(entryId).version, 1)

  const ids = store.entryById(entryId).items.map((item) => item.id)
  // 助手先完成第一项（版本 1）
  store.patchItem({
    deviceId: "aide",
    entryId,
    itemId: ids[0],
    patch: { done: true },
    expectedVersion: 1,
  })
  assert.equal(store.entryById(entryId).items[0].done, true)
  assert.equal(store.entryById(entryId).version, 2)

  // 主治还拿着旧版本去重排：冲突，完成态不能丢
  assert.throws(
    () =>
      store.reorder({
        deviceId: "doc",
        entryId,
        orderedIds: [ids[1], ids[0]],
        expectedVersion: 1,
      }),
    (err) => err.status === 409 && /别人刚改过|重新拉取/.test(err.message),
  )
  assert.equal(store.entryById(entryId).items[0].done, true)
  assert.equal(store.entryById(entryId).items[0].id, ids[0])
  assert.equal(store.entryById(entryId).version, 2)

  // 不带期望版本时仍可改（旧客户端），但会继续往上加版本
  store.reorder({ deviceId: "doc", entryId, orderedIds: [ids[1], ids[0]] })
  assert.equal(store.entryById(entryId).version, 3)
  assert.equal(store.entryById(entryId).items[0].id, ids[1])
  assert.equal(store.entryById(entryId).items[1].done, true)
})

test("carry unfinished brings only open items; repeat-last still resets a full chain", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  const aide = store.state.staff.find((person) => person.name === "小李")
  store.setChief({ deviceId: "doc", entryId, targetId: "knee", side: "right" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring", side: "right" })
  store.addItem({ deviceId: "doc", entryId, targetId: "soleus", side: "right" })
  store.addItem({ deviceId: "doc", entryId, targetId: "plantar", side: "right" })
  store.assignAll({ deviceId: "doc", entryId, assigneeId: aide.id })
  const [first, second, third] = store.entryById(entryId).items
  store.patchItem({ deviceId: "aide", entryId, itemId: first.id, patch: { done: true } })

  const today = todayKey()
  const days = { ...store.state.days }
  days["2020-01-02"] = days[today]
  delete days[today]
  store.state.days = days

  const patientRow = store.view("doc").patients.find((patient) => patient.name === "王阿姨")
  assert.equal(patientRow.hasUnfinishedPrev, true)
  const carried = store.carryUnfinished({ deviceId: "doc", patientId: patientRow.id })
  assert.deepEqual(
    carried.entry.items.map((item) => item.targetId),
    ["soleus", "plantar"],
  )
  assert.equal(carried.entry.items.every((item) => item.done === false), true)
  assert.equal(carried.entry.items.every((item) => item.assigneeId === aide.id), true)
  assert.equal(carried.entry.chiefSiteId, "knee")
  assert.equal(carried.entry.chiefSide, "right")
  // 已完成的 hamstring 不能原样拷成已完成
  assert.equal(
    carried.entry.items.some((item) => item.targetId === "hamstring"),
    false,
  )
  assert.throws(() => store.carryUnfinished({ deviceId: "doc", patientId: patientRow.id }), /已经在单上/)

  store.dropEntry({ deviceId: "doc", entryId: carried.entry.id })
  const repeated = store.repeatLastDay({ deviceId: "doc", patientId: patientRow.id })
  assert.deepEqual(
    repeated.entry.items.map((item) => item.targetId),
    ["hamstring", "soleus", "plantar"],
  )
  assert.equal(repeated.entry.items.every((item) => item.done === false), true)
  assert.equal(second.targetId, "soleus")
  assert.equal(third.targetId, "plantar")
})

test("export records lastExportAt; backup mirror copies only when BACKUP_MIRROR_DIR is set", () => {
  const store = openStore()
  setupRoom(store)
  assert.equal(store.view("doc").lastExportAt, null)
  const before = store.exportData("doc")
  assert.ok(before.lastExportAt)
  assert.equal(store.view("doc").lastExportAt, before.lastExportAt)

  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-mirror-"))
  const untouched = path.join(os.tmpdir(), `clinic-no-mirror-${Date.now()}`)
  const prev = process.env.BACKUP_MIRROR_DIR
  try {
    delete process.env.BACKUP_MIRROR_DIR
    store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
    assert.equal(fs.existsSync(untouched), false)

    process.env.BACKUP_MIRROR_DIR = mirror
    // 拉开备份间隔，强制再抄一份
    const backupDir = store.backupDir()
    for (const name of store.backupFiles(backupDir)) {
      const stamp = Date.now() - 120_000
      fs.utimesSync(path.join(backupDir, name), stamp / 1000, stamp / 1000)
    }
    store.createPatient({ deviceId: "doc", name: "张姐", conditionName: "肩紧" })
    const mirrored = fs.readdirSync(mirror).filter((name) => /^clinic-\d{8}-\d{6}\.json$/.test(name))
    assert.ok(mirrored.length >= 1)
  } finally {
    if (prev === undefined) delete process.env.BACKUP_MIRROR_DIR
    else process.env.BACKUP_MIRROR_DIR = prev
  }
})

test("imported day entries with broken innards get cleaned; view stays usable", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "导入阿姨", conditionName: "腰紧" })
  const patientId = created.entry.patientId
  const data = structuredClone(store.state)
  const key = Object.keys(data.days)[0]
  data.passphrase = "遗留的口令哈希"
  data.days[key].entries = [
    { id: "e-bare", patientId }, // 缺 conditionIds / items
    {
      id: "e-junk",
      patientId,
      conditionIds: "腰紧",
      items: [null, { targetId: "hamstring", technique: "乱写", assigneeId: "没这个人" }],
    },
  ]
  const view = store.importData({ deviceId: "doc", data })
  assert.equal(view.today.length, 2)
  assert.equal("passphrase" in store.state, false)
  const bare = store.state.days[key].entries.find((entry) => entry.id === "e-bare")
  assert.deepEqual(bare.conditionIds, [])
  assert.deepEqual(bare.items, [])
  const junk = store.state.days[key].entries.find((entry) => entry.id === "e-junk")
  assert.equal(junk.items.length, 1)
  assert.equal(junk.items[0].technique, "massage")
  assert.equal(junk.items[0].direction, "along")
  assert.equal(junk.items[0].assigneeId, null)
  assert.deepEqual(junk.conditionIds, [])
})

test("clinic.json with broken day innards loads into a usable shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-broken-innards-"))
  const file = path.join(dir, "clinic.json")
  const store = new ClinicStore(file)
  store.load()
  store.setup({ deviceId: "doc", staffName: "之之" })
  const created = store.createPatient({ deviceId: "doc", name: "磁盘阿姨", conditionName: "膝盖" })
  const data = JSON.parse(fs.readFileSync(file, "utf8"))
  const key = Object.keys(data.days)[0]
  data.days[key].entries[0].items = null
  data.days[key].entries[0].conditionIds = 7
  data.passphrase = "遗留的口令哈希"
  fs.writeFileSync(file, JSON.stringify(data))

  const revived = new ClinicStore(file)
  revived.load()
  const view = revived.view("doc")
  assert.equal(view.stage, "ready")
  assert.equal(view.today.length, 1)
  const entry = revived.state.days[key].entries.find((row) => row.patientId === created.entry.patientId)
  assert.deepEqual(entry.conditionIds, [])
  assert.deepEqual(entry.items, [])
  assert.equal("passphrase" in revived.state, false)
})

test("patchItem rejects unknown technique, direction and assignee without touching the item", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId, targetId: "hamstring" })
  const item = store.entryById(entryId).items[0]
  assert.throws(
    () => store.patchItem({ deviceId: "doc", entryId, itemId: item.id, patch: { technique: "乱写" } }),
    /手法不对/,
  )
  assert.throws(
    () => store.patchItem({ deviceId: "doc", entryId, itemId: item.id, patch: { direction: "乱写" } }),
    /方向不对/,
  )
  assert.throws(
    () => store.patchItem({ deviceId: "doc", entryId, itemId: item.id, patch: { assigneeId: "没这个人" } }),
    /找不到这个人/,
  )
  assert.equal(item.technique, "massage")
  assert.equal(item.direction, "along")
  assert.equal(item.assigneeId, store.state.staff[0].id)
  assert.equal(store.state.patients[0].lastAssigneeId, undefined)
})

test("dropping an orphan entry no longer blows up after save", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "孤儿阿姨", conditionName: "腰紧" })
  const entryId = created.entry.id
  // 病人被直接从档案里抠掉（绕过所有写方法），条目成了孤儿
  store.state.patients = []
  const view = store.dropEntry({ deviceId: "doc", entryId })
  assert.equal(view.today.length, 0)
})

test("merely reading the session no longer leaves an empty day behind", () => {
  const store = openStore()
  setupRoom(store)
  const view = store.view("doc")
  assert.equal(view.today.length, 0)
  assert.equal(store.state.days[todayKey()], undefined)
  // 写路径照旧能建今天
  store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "腰紧" })
  assert.ok(store.state.days[todayKey()])
})

test("pairings: view falls back to defaults, savePairings sanitizes and persists", () => {
  const store = openStore()
  setupRoom(store)
  // 没改过：view 给默认表
  let view = store.view("doc")
  assert.equal(view.pairings.knee[0], "quad")
  assert.equal(view.pairings.lumbar.includes("glute"), true)
  // 改膝盖：脏数据（重复、不认识的 id、部位键塞肌肉、超长）都洗掉，别的部位回默认
  const noisy = Array.from({ length: 20 }, () => "quad").concat(["knee", "没这块肉"])
  view = store.savePairings({ deviceId: "doc", pairings: { knee: noisy, hamster: ["quad"] } })
  assert.deepEqual(view.pairings.knee, ["quad"])
  assert.equal("hamster" in view.pairings, false)
  assert.equal(view.pairings.neck[0], "trapezius")
  // 没登录的设备改不了
  assert.throws(() => store.savePairings({ deviceId: "nobody", pairings: { knee: ["quad"] } }), /请先选择你是谁/)
  // 空表（一个部位都不剩）直接拒绝
  assert.throws(() => store.savePairings({ deviceId: "doc", pairings: { hamster: ["quad"] } }), /没有认得的部位/)
  // 存盘再读回来还是改过的
  const revived = new ClinicStore(store.file)
  revived.load()
  assert.deepEqual(revived.view("doc").pairings.knee, ["quad"])
  assert.equal(revived.view("doc").pairings.lumbar[0], "glute")
})

test("pairings: sanitizeState keeps the edited table on import, empty chips allowed", () => {
  const store = openStore()
  setupRoom(store)
  store.savePairings({ deviceId: "doc", pairings: { knee: [], lumbar: ["glute", "glute", " quad "] } })
  const view = store.view("doc")
  // 膝盖清空是合法的（面板就不显示这一排）；带空格的 id 洗掉而不是猜
  assert.deepEqual(view.pairings.knee, [])
  assert.deepEqual(view.pairings.lumbar, ["glute"])
})

test("solo clinic: archive items land on the only staff; inline complete sees legacy nulls", () => {
  const store = openStore()
  store.setup({ deviceId: "doc", staffName: "之之" })
  // 第一天：建档并写回病症
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName: "右膝疼痛" })
  const firstEntry = created.entry.id
  store.setChief({ deviceId: "doc", entryId: firstEntry, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId: firstEntry, targetId: "hamstring" })
  store.leave({ deviceId: "doc", entryId: firstEntry, updateCondition: true })
  const patientId = created.entry.patientId
  // 换一天再来：档案带出来的项自动记在唯一的人名下
  store.state.days = {}
  const again = store.addExisting({ deviceId: "doc", patientId })
  const staffId = store.state.staff[0].id
  assert.equal(again.entry.items.every((item) => item.assigneeId === staffId), true)
  // 今日单摘要给行内完成用的「我的当前项」也在
  let summary = store.view("doc").today[0]
  assert.equal(summary.mineTotal, 1)
  assert.equal(summary.mineNextName, "腘绳肌")
  // 老数据里没派工的项（多人时期留下的 null）在单人时同样算「我的」
  const entry = store.todayRecord().entries.find((row) => row.patientId === patientId)
  entry.items[0].assigneeId = null
  summary = store.view("doc").today[0]
  assert.equal(summary.mineTotal, 1)
  assert.equal(summary.mineNextName, "腘绳肌")
})

test("leave ask fires once per change round, not on every re-entry", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "赵阿姨", conditionName: "腰痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "lumbar" })
  store.addItem({ deviceId: "doc", entryId, targetId: "glute" })
  // 选「更新病症」离开：档案与今天一致，之后不问
  store.leave({ deviceId: "doc", entryId, updateCondition: true })
  let view = store.entryView("doc", entryId)
  assert.equal(view.entry.diverged, false)
  assert.equal(view.entry.leaveAsk, false)
  // 改到会写回的字段（剂量）：要问
  const itemId = view.entry.items[0].id
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { dose: { minutes: 12 } } })
  view = store.entryView("doc", entryId)
  assert.equal(view.entry.leaveAsk, true)
  // 答了「留在今天」：反复进出不再问；完成/改派也不重新触发
  store.leave({ deviceId: "doc", entryId, updateCondition: false })
  view = store.entryView("doc", entryId)
  assert.equal(view.entry.leaveAsk, false)
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { done: true } })
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { assigneeId: store.state.staff[1].id } })
  view = store.entryView("doc", entryId)
  assert.equal(view.entry.leaveAsk, false)
  // 又改了内容：重新问
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { technique: "release" } })
  view = store.entryView("doc", entryId)
  assert.equal(view.entry.leaveAsk, true)
  // 重排和去掉/加回也会重新点亮问询
  store.leave({ deviceId: "doc", entryId, updateCondition: false })
  store.removeItem({ deviceId: "doc", entryId, itemId })
  view = store.entryView("doc", entryId)
  assert.equal(view.entry.leaveAsk, true)
})

test("technique switch keeps minutes between massage and release, resets across equipment", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "钱阿姨", conditionName: "肩痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "shoulder" })
  store.addItem({ deviceId: "doc", entryId, targetId: "supraspinatus" })
  let view = store.entryView("doc", entryId)
  const itemId = view.entry.items[0].id
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { dose: { minutes: 12 } } })
  // 按摩→松解：调好的 12 分钟保留
  view = store.patchItem({ deviceId: "doc", entryId, itemId, patch: { technique: "release" } })
  assert.equal(view.entry.items[0].technique, "release")
  assert.equal(view.entry.items[0].dose.minutes, 12)
  // 换成器械：单位变了，重置默认组次
  view = store.patchItem({ deviceId: "doc", entryId, itemId, patch: { technique: "equipment" } })
  assert.deepEqual(view.entry.items[0].dose, { sets: 3, reps: 10 })
})

test("failed repeat/carry/drop no longer leaves an empty today behind", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "孙阿姨", conditionName: "膝痛" })
  const patientId = created.entry.patientId
  // 今天已经在单上：repeat 与 carry 都应被拒
  assert.throws(() => store.repeatLastDay({ deviceId: "doc", patientId }), /今天已经在单上/)
  assert.throws(() => store.carryUnfinished({ deviceId: "doc", patientId }), /今天已经在单上/)
  assert.throws(() => store.dropEntry({ deviceId: "doc", entryId: "nope" }), /今天没有这张单/)
  // 拒绝的请求不许在内存里留下空天（会被下一次别人的保存顺带落盘）
  assert.equal(Object.keys(store.state.days).length, 1)
})

test("sanitizeState keeps divergedAcked through export/import", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "周阿姨", conditionName: "颈痛" })
  const entryId = created.entry.id
  store.setChief({ deviceId: "doc", entryId, targetId: "neck" })
  store.addItem({ deviceId: "doc", entryId, targetId: "trapezius" })
  store.leave({ deviceId: "doc", entryId, updateCondition: true })
  const itemId = store.entryView("doc", entryId).entry.items[0].id
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { dose: { minutes: 15 } } })
  store.leave({ deviceId: "doc", entryId, updateCondition: false })
  const data = store.exportData("doc")
  const imported = store.importData({ deviceId: "aide", data })
  const entry = imported.today[0]
  assert.equal(entry.version >= 0, true)
  const raw = store.todayRecord().entries[0]
  assert.equal(raw.divergedAcked, true)
})

test("carryUnunfinished finds yesterday's entry by id for the past-midnight phone", () => {
  const store = openStore()
  setupRoom(store)
  const created = store.createPatient({ deviceId: "doc", name: "吴阿姨", conditionName: "踝扭伤" })
  const entryId = created.entry.id
  const patientId = created.entry.patientId
  store.setChief({ deviceId: "doc", entryId, targetId: "knee" })
  store.addItem({ deviceId: "doc", entryId, targetId: "gastroc" })
  store.addItem({ deviceId: "doc", entryId, targetId: "soleus" })
  const itemId = store.entryView("doc", entryId).entry.items[0].id
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { done: true } })
  store.leave({ deviceId: "doc", entryId, updateCondition: true })
  // 模拟跨零点：今天这张单变成「昨天」的，手机上只剩 entryId。
  const today = todayKey()
  store.state.days["2000-01-01"] = store.state.days[today]
  delete store.state.days[today]
  const carried = store.carryUnfinished({ deviceId: "doc", entryId })
  assert.equal(carried.entry.patientId, patientId)
  // 已完成的腓肠肌不带，只接没做完的比目鱼肌
  assert.deepEqual(
    carried.entry.items.map((item) => item.targetId),
    ["soleus"],
  )
  assert.throws(() => store.carryUnfinished({ deviceId: "doc", entryId }), /今天已经在单上/)
})
