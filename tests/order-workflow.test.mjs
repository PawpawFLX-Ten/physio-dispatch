import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClinicStore, todayKey } from "../server/store.js"
import { parseQuickOrder } from "../shared/quick-order.js"
import { buildOrderDraft } from "../shared/order-command.js"
import { remapPlanSide } from "../shared/workflow.js"
import { EQUIPMENT_TYPES } from "../shared/equipment.js"

const staff = [{ id: "li", name: "小李" }, { id: "wang", name: "小王" }]
const options = { staff, equipment: EQUIPMENT_TYPES }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-order-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "clinic.json")
  const store = new ClinicStore(file)
  store.load()
  store.setup({ deviceId: "doc", staffName: "主治" })
  const aide = store.claim({ deviceId: "aide", staffName: "小李" }).me
  const view = store.createPatient({ deviceId: "doc", name: "测试患者", conditionName: "左膝" })
  const entryId = view.entry.id
  store.quickAdd({ deviceId: "doc", entryId, ...parseQuickOrder("左膝，股四头肌按摩8分钟，然后腘绳肌松解5分钟") })
  return { store, entryId, patientId: view.entry.patientId, aide, file }
}

test("自然口令：共同手法剂量、否定排除、分步派工、纠正不猜", () => {
  const group = parseQuickOrder("左膝，股四头肌和腘绳肌各松解5分钟", options)
  assert.deepEqual(group.items.map((item) => [item.technique, item.dose.minutes]), [["release", 5], ["release", 5]])
  const negative = parseQuickOrder("左膝，今天不做股四头肌，只做腘绳肌松解5分钟", options)
  assert.deepEqual(negative.items.map((item) => item.targetId), ["hamstring"])
  const assigned = parseQuickOrder("左膝，股四头肌按摩8分钟给小李，然后腘绳肌松解5分钟给小王", options)
  assert.deepEqual(assigned.items.map((item) => item.assigneeId), ["li", "wang"])
  assert.equal(assigned.assigneeId, null)
  for (const text of ["不按摩股四头肌", "股四头肌不对改成右侧", "照上次，去掉第二项"]) {
    assert.ok(parseQuickOrder(text, options).issues.length, text)
  }
  assert.ok(parseQuickOrder("腘绳肌EMS8分钟", options).unknown.includes("EMS"))
  assert.ok(parseQuickOrder("股四头肌今天不做", options).issues.length)
  assert.ok(parseQuickOrder("股四头肌按摩一分钟半", options).unknown.includes("半"))
  assert.ok(parseQuickOrder("股四头肌轻按摩5分钟", options).unknown.includes("轻"))
  assert.ok(parseQuickOrder("左膝不做股四头肌只做腘绳肌", options).issues.length)
  const prefix = parseQuickOrder("左膝，股四头肌按摩8分钟，然后松解腘绳肌5分钟", options)
  assert.deepEqual(prefix.items.map((item) => [item.technique, item.dose.minutes]), [["massage", 8], ["release", 5]])
  const twoSides = parseQuickOrder("左股四头肌和右腘绳肌各松解5分钟", options)
  assert.deepEqual(twoSides.items.map((item) => [item.side, item.technique, item.dose.minutes]), [["left", "release", 5], ["right", "release", 5]])
})

test("草稿：照旧后按序号修改、排除末项、整体派工", () => {
  const items = ["quad", "hamstring", "soleus"].map((targetId, index) => ({ id: String(index), targetId, side: "left", technique: "release", dose: { minutes: 8 }, direction: "along" }))
  const draft = buildOrderDraft("照上次，第二项改成五分钟，最后一项今天不做，交给小李", {
    last: { chiefSiteId: "knee", chiefSide: "left", items }, lastDate: "2026-11-01", ...options,
  })
  assert.deepEqual(draft.issues, [])
  assert.equal(draft.items.length, 2)
  assert.equal(draft.items[1].dose.minutes, 5)
  assert.ok(draft.items.every((item) => item.assigneeId === "li"))
  const moved = buildOrderDraft("第二项移到第一项", { current: { items }, ...options })
  assert.equal(moved.items[0].targetId, "hamstring")
})

test("预览只读、派发一次写入、重复确认幂等", (t) => {
  const { store, entryId, patientId, aide, file } = fixture(t)
  // 模拟已有档案、尚未加入今天。
  store.state.days[todayKey()].entries = []
  store.save()
  const before = fs.readFileSync(file, "utf8")
  const input = { deviceId: "doc", patientId, text: "左膝，股四头肌和腘绳肌各松解5分钟，交给小李", sequential: true }
  const preview = store.previewOrder(input)
  assert.deepEqual(preview.draft.issues, [])
  assert.equal(fs.readFileSync(file, "utf8"), before)
  assert.equal(store.todayRecord().entries.length, 0)
  const result = store.dispatchOrder({ ...input, token: preview.token })
  assert.notEqual(result.entry.id, entryId)
  assert.equal(result.entry.items.length, 2)
  assert.ok(result.entry.items.every((item) => item.assigneeId === aide.id))
  assert.equal(result.entry.sequential, true)
  const after = fs.readFileSync(file, "utf8")
  assert.equal(store.dispatchOrder({ ...input, token: preview.token }).entry.id, result.entry.id)
  assert.equal(fs.readFileSync(file, "utf8"), after)
})

test("不理解的口令整单拒绝，预览后他人改动必须重新预览", (t) => {
  const { store, entryId, patientId } = fixture(t)
  const input = { deviceId: "doc", patientId, text: "第二项改成5分钟" }
  const preview = store.previewOrder(input)
  assert.deepEqual(preview.draft.issues, [])
  store.patchItem({ deviceId: "doc", entryId, itemId: store.entryById(entryId).items[0].id, patch: { dose: { minutes: 6 } } })
  const before = JSON.stringify(store.state)
  assert.throws(() => store.dispatchOrder({ ...input, token: preview.token }), /重新预览/)
  assert.equal(JSON.stringify(store.state), before)
  for (const text of ["第二项改成股四头肌松解5分钟", "交给小李除了第二项", "不照上次", "第二项今天不做但保留", "第二项移到第一项之后", "第二项改成三组十次"]) {
    assert.ok(store.previewOrder({ ...input, text }).draft.issues.length, text)
  }
  const bad = { ...input, text: "股四头肌松解5分钟，随便做点别的" }
  const blocked = store.previewOrder(bad)
  assert.ok(blocked.draft.issues.length)
  assert.throws(() => store.dispatchOrder({ ...bad, token: blocked.token }), /没认出来|没识别/)
  assert.equal(JSON.stringify(store.state), before)
})

test("照上次保留说明、重置完成；已开始的今天不能整单覆盖", (t) => {
  const { store, entryId, patientId } = fixture(t)
  const entry = store.entryById(entryId)
  entry.items[0].instructions = "主治录入的步骤"
  entry.items[0].done = true
  store.state.days["2020-01-01"] = { entries: [structuredClone(entry)] }
  store.state.days[todayKey()].entries = []
  store.save()
  const input = { deviceId: "doc", patientId, text: "照上次，第二项改成5分钟，交给小李" }
  const preview = store.previewOrder(input)
  assert.deepEqual(preview.draft.issues, [])
  const dispatched = store.dispatchOrder({ ...input, token: preview.token })
  assert.equal(dispatched.entry.items[0].instructions, "主治录入的步骤")
  assert.ok(dispatched.entry.items.every((item) => !item.done))
  store.patchItem({ deviceId: "doc", entryId: dispatched.entry.id, itemId: dispatched.entry.items[0].id, patch: { done: true } })
  assert.ok(store.previewOrder(input).draft.issues.some((issue) => issue.includes("已开始")))
})

test("模板简称、说明及整套换侧（关联目标、对侧关系、双侧）", (t) => {
  const { store, entryId, patientId } = fixture(t)
  const itemId = store.entryById(entryId).items[0].id
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { position: "测试体位", instructions: "测试步骤", caution: "测试提醒", demoUrl: "https://example.org/demo" } })
  const templates = store.saveTemplateFromEntry({ deviceId: "doc", entryId, name: "测试方案", shortName: "A方案" }).templates
  const template = store.templateById(templates.at(-1).id)
  const count = store.patient(patientId).conditions.length
  const input = { deviceId: "doc", patientId, text: "套用A方案，交给小李", side: "right", sequential: true }
  const preview = store.previewOrder(input)
  assert.deepEqual(preview.draft.issues, [])
  const dispatched = store.dispatchOrder({ ...input, token: preview.token })
  assert.ok(dispatched.entry.items.every((item) => item.side === "right"))
  assert.ok(dispatched.entry.items.every((item) => item.assigneeId === store.device("aide")))
  assert.equal(dispatched.entry.items[0].instructions, "测试步骤")
  assert.equal(store.patient(patientId).conditions.length, count)
  assert.equal(template.items[0].side, "left")
  const mixed = remapPlanSide({ chiefSide: "left", items: [{ targetId: "quad", side: "left", linkedTargets: [{ targetId: "hamstring", side: "right" }] }] }, "right")
  assert.equal(mixed.items[0].side, "right")
  assert.equal(mixed.items[0].linkedTargets[0].side, "left")
  assert.equal(remapPlanSide(template, "both").items.length, template.items.length * 2)
})

test("整套侧别选择优先于口述；双侧不会重复任务 ID", (t) => {
  const { store, patientId } = fixture(t)
  const input = { deviceId: "doc", patientId, text: "左膝，股四头肌松解5分钟", side: "right" }
  const right = store.previewOrder(input)
  assert.deepEqual(right.draft.issues, [])
  assert.equal(right.draft.chiefSide, "right")
  assert.ok(right.draft.items.every((item) => item.side === "right"))
  const bothInput = { ...input, text: "交给小李", side: "both" }
  const both = store.previewOrder(bothInput)
  const result = store.dispatchOrder({ ...bothInput, token: both.token })
  assert.equal(result.entry.items.length, 4)
  assert.equal(new Set(result.entry.items.map((item) => item.id)).size, 4)
})

test("指定只做不会把原有同名步骤重复追加", (t) => {
  const { store, patientId } = fixture(t)
  const input = { deviceId: "doc", patientId, text: "今天不做股四头肌，只做腘绳肌松解5分钟" }
  const preview = store.previewOrder(input)
  assert.deepEqual(preview.draft.issues, [])
  const result = store.dispatchOrder({ ...input, token: preview.token })
  assert.deepEqual(result.entry.items.map((item) => item.targetId), ["hamstring"])
})

test("派发保存失败回滚整单内存，原磁盘数据不变", (t) => {
  const { store, patientId, file } = fixture(t)
  const input = { deviceId: "doc", patientId, text: "第二项改成6分钟" }
  const preview = store.previewOrder(input)
  const before = JSON.stringify(store.state)
  const disk = fs.readFileSync(file, "utf8")
  const save = store.save
  store.save = () => { throw new Error("模拟磁盘满") }
  assert.throws(() => store.dispatchOrder({ ...input, token: preview.token }), /磁盘满/)
  assert.equal(JSON.stringify(store.state), before)
  assert.equal(fs.readFileSync(file, "utf8"), disk)
  store.save = save
})

test("多人编辑说明按字段快照防止过期文本覆盖，即使界面版本已同步", (t) => {
  const { store, entryId } = fixture(t)
  const itemId = store.entryById(entryId).items[0].id
  const baseline = { position: "", instructions: "", caution: "", demoUrl: "" }
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { instructions: "另一位主治刚写的", expectedInstructions: baseline } })
  assert.throws(() => store.patchItem({ deviceId: "aide", entryId, itemId, expectedVersion: store.entryById(entryId).version, patch: { instructions: "旧表单的文字", expectedInstructions: baseline } }), /说明已被别人更新/)
  assert.equal(store.entryById(entryId).items[0].instructions, "另一位主治刚写的")
})

test("说明、顺序、床位和异常反馈经历保存、导出导入仍在", (t) => {
  const { store, entryId, file } = fixture(t)
  const itemId = store.entryById(entryId).items[0].id
  store.configureWorkflow({ deviceId: "doc", entryId, sequential: true, bedLabel: "3号床" })
  store.patchItem({ deviceId: "doc", entryId, itemId, patch: { instructions: "第一步\n第二步", problem: "请主治复核" } })
  const exported = store.exportData("doc")
  store.importData({ deviceId: "doc", data: exported })
  const reloaded = new ClinicStore(file)
  reloaded.load()
  const entry = reloaded.entryView("doc", entryId).entry
  assert.equal(entry.sequential, true)
  assert.equal(entry.bedLabel, "3号床")
  assert.equal(entry.items[0].instructions, "第一步\n第二步")
  assert.equal(entry.items[0].state, "review")
})

test("顺序在服务端执行；问题暂停、解除后继续；旧单不强制顺序", (t) => {
  const { store, entryId } = fixture(t)
  const [first, second] = store.entryById(entryId).items
  assert.equal(store.executionState(store.entryById(entryId), second).canExecute, true)
  store.configureWorkflow({ deviceId: "doc", entryId, sequential: true })
  assert.throws(() => store.patchItem({ deviceId: "aide", entryId, itemId: second.id, patch: { done: true } }), /等前一步/)
  store.patchItem({ deviceId: "aide", entryId, itemId: first.id, patch: { problem: "不确定摆位" } })
  assert.throws(() => store.patchItem({ deviceId: "aide", entryId, itemId: first.id, patch: { done: true } }), /需主治处理/)
  store.patchItem({ deviceId: "doc", entryId, itemId: first.id, patch: { problem: "" } })
  store.patchItem({ deviceId: "doc", entryId, itemId: first.id, patch: { done: true } })
  assert.equal(store.executionState(store.entryById(entryId), second).canExecute, true)
})

test("交接不释放真实设备锁，仍占用直到显式结束；使用中不能删单", (t) => {
  const { store, entryId, aide } = fixture(t)
  const result = store.addItem({ deviceId: "aide", entryId, targetId: "quad", side: "left", equipmentTypeId: "ultrasound" })
  const item = result.entry.items.at(-1)
  store.patchItem({ deviceId: "aide", entryId, itemId: item.id, patch: { started: true } })
  const startedAt = store.entryById(entryId).items.at(-1).startedAt
  store.reassignOpen({ deviceId: "doc", fromStaffId: aide.id, toStaffId: store.device("doc") })
  assert.equal(store.entryById(entryId).items.at(-1).startedAt, startedAt)
  assert.throws(() => store.removeItem({ deviceId: "doc", entryId, itemId: item.id }), /仍在使用/)
  assert.throws(() => store.dropEntry({ deviceId: "doc", entryId }), /仍在使用/)
  store.patchItem({ deviceId: "doc", entryId, itemId: item.id, patch: { started: false } })
  assert.equal(store.entryById(entryId).items.at(-1).startedAt, null)
})
