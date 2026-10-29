import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClinicStore, todayKey } from "../server/store.js"
import { parseQuickOrder } from "../shared/quick-order.js"
import {
  EQUIPMENT_TYPES,
  EQUIPMENT_UNITS,
  EXERCISE_TEMPLATES,
  chooseEquipmentUnitId,
  equipmentTypeById,
  equipmentUnitById,
  exerciseTemplateById,
  sanitizeEquipmentParameters,
} from "../shared/equipment.js"

function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-equipment-test-"))
  const file = path.join(dir, "clinic.json")
  const store = new ClinicStore(file)
  store.load()
  store.setup({ deviceId: "doc", staffName: "之之" })
  store.claim({ deviceId: "aide", staffName: "小李" })
  return { store, file }
}

function patientWithChief(store, side = "right", conditionName = "右膝疼痛") {
  const created = store.createPatient({ deviceId: "doc", name: "王阿姨", conditionName })
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "knee", side })
  return created
}

test("equipment catalog exposes six types, seven units and usable templates", () => {
  assert.equal(EQUIPMENT_TYPES.length, 6)
  assert.equal(EQUIPMENT_UNITS.length, 7)
  assert.deepEqual(
    EQUIPMENT_TYPES.map((type) => [type.id, type.unitIds.length]),
    [
      ["shockwave", 1],
      ["ultrasound", 2],
      ["electrotherapy", 1],
      ["traction-bed", 2],
      ["elastic-band", 0],
      ["isokinetic", 1],
    ],
  )
  const band = equipmentTypeById("elastic-band")
  assert.equal(band.requiresUnit, false)
  assert.deepEqual(band.unitIds, [])
  assert.deepEqual(equipmentTypeById("shockwave").aliases, ["冲击波", "冲击波治疗", "冲击波仪"])
  assert.deepEqual(equipmentTypeById("elastic-band").aliases, ["弹力带", "弹力绳"])
  assert.ok(equipmentUnitById("ultrasound-2"))
  assert.equal(equipmentUnitById("ultrasound-2").equipmentTypeId, "ultrasound")

  for (const type of EQUIPMENT_TYPES) {
    for (const unitId of type.unitIds) {
      assert.equal(equipmentUnitById(unitId)?.equipmentTypeId, type.id)
    }
  }
  const names = EXERCISE_TEMPLATES.map((template) => template.name)
  for (const required of ["弹力带终末伸膝", "弹力带肩外旋", "弹力带划船", "等速膝", "等速肩"]) {
    assert.ok(names.includes(required), required)
  }
  assert.ok(EXERCISE_TEMPLATES.every((template) => equipmentTypeById(template.equipmentTypeId)))
  assert.ok(EXERCISE_TEMPLATES.every((template) => template.linkedTargets.length > 0))
  assert.equal(exerciseTemplateById("band-row").linkedTargets.length >= 2, true)
  assert.equal(chooseEquipmentUnitId("ultrasound", null, { "ultrasound-1": 1 }), "ultrasound-2")
  assert.equal(sanitizeEquipmentParameters("shockwave", { pulses: 2500 }).pulses, 2500)
  assert.equal(sanitizeEquipmentParameters("elastic-band", { resistance: "heavy" }).resistance, "heavy")
})

test("multi-unit equipment auto-assigns units, single machines stay fixed, and side falls back to chiefSide", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "right")
  const entryId = created.entry.id

  const first = store.addItem({ deviceId: "doc", entryId, targetId: "quad", equipmentTypeId: "ultrasound" })
  assert.equal(first.entry.items[0].equipmentUnitId, "ultrasound-1")
  assert.equal(first.entry.items[0].technique, "equipment")
  assert.equal(first.entry.items[0].side, "right")
  assert.equal(first.entry.items[0].equipmentTypeName, "超声")
  assert.equal(first.entry.items[0].equipmentUnitName, "超声 1 号机")
  assert.equal(first.entry.items[0].parameters.intensity, 1)

  const second = store.addItem({ deviceId: "doc", entryId, targetId: "hamstring", equipmentTypeId: "ultrasound" })
  assert.equal(second.entry.items[1].equipmentUnitId, "ultrasound-2")

  const fixed = store.addItem({ deviceId: "doc", entryId, targetId: "glute", equipmentTypeId: "isokinetic" })
  assert.equal(fixed.entry.items[2].equipmentUnitId, "isokinetic-1")

  const traction = store.addItem({
    deviceId: "doc",
    entryId,
    targetId: "lumbar",
    equipmentTypeId: "traction-bed",
    equipmentUnitId: "traction-bed-2",
  })
  assert.equal(traction.entry.items[3].equipmentUnitId, "traction-bed-2")
  assert.equal(traction.entry.items[3].side, null)

  const before = store.entryById(entryId).items.length
  assert.throws(
    () =>
      store.addItem({
        deviceId: "doc",
        entryId,
        targetId: "quad",
        equipmentTypeId: "isokinetic",
        equipmentUnitId: "ultrasound-1",
      }),
    /机台|设备/,
  )
  assert.equal(store.entryById(entryId).items.length, before)
})

test("exercise templates fill type, multi-target links, defaults and equipment summary", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "right")
  const entryId = created.entry.id

  const band = store.addItem({ deviceId: "doc", entryId, exerciseTemplateId: "band-terminal-knee-extension" })
  const bandItem = band.entry.items.at(-1)
  assert.equal(bandItem.targetId, "quad")
  assert.equal(bandItem.technique, "equipment")
  assert.equal(bandItem.equipmentTypeId, "elastic-band")
  assert.equal(bandItem.equipmentUnitId, null)
  assert.equal(bandItem.exerciseTemplateId, "band-terminal-knee-extension")
  assert.deepEqual(bandItem.parameters, { resistance: "light" })
  assert.deepEqual(bandItem.linkedTargets, [{ targetId: "quad", side: "right" }])
  assert.equal(bandItem.exerciseName, "弹力带终末伸膝")
  assert.match(bandItem.equipmentSummary, /弹力带终末伸膝/)
  assert.match(bandItem.equipmentSummary, /阻力 轻/)
  assert.deepEqual(bandItem.linkedTargetTitles, ["右股四头肌"])
  assert.equal(bandItem.sideLabel, "右")

  const multi = store.quickAdd({
    deviceId: "doc",
    entryId,
    items: [
      {
        exerciseTemplateId: "band-shoulder-external-rotation",
        targetId: "infraspinatus",
        side: "right",
        parameters: { resistance: "heavy" },
      },
    ],
  })
  const multiItem = multi.entry.items.at(-1)
  assert.equal(multiItem.linkedTargets.length, 2)
  assert.deepEqual(
    multiItem.linkedTargets.map((row) => row.targetId),
    ["infraspinatus", "shoulder"],
  )
  assert.equal(multiItem.linkedTargets.every((row) => row.side === "right"), true)
  assert.equal(multiItem.parameters.resistance, "heavy")
  assert.match(multiItem.equipmentSummary, /弹力带肩外旋/)
  assert.match(multiItem.equipmentSummary, /阻力 重/)
})

test("quickAdd accepts equipment parameters and a top-level assignee override", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "right")
  const aide = store.state.staff.find((person) => person.name === "小李")
  const view = store.quickAdd({
    deviceId: "doc",
    entryId: created.entry.id,
    assigneeId: aide.id,
    items: [
      {
        targetId: "quad",
        technique: "equipment",
        equipmentTypeId: "shockwave",
        parameters: { pulses: 2000 },
      },
      {
        targetId: "glute",
        technique: "equipment",
        equipmentTypeId: "elastic-band",
        parameters: { resistance: "medium" },
        assigneeId: store.state.staff[0].id,
      },
    ],
  })
  const [shockwave, band] = view.entry.items
  assert.equal(shockwave.assigneeId, aide.id)
  assert.equal(shockwave.equipmentUnitId, "shockwave-1")
  assert.equal(shockwave.parameters.pulses, 2000)
  assert.equal(shockwave.parameters.energy, 2)
  assert.equal(shockwave.side, "right")
  assert.match(shockwave.equipmentSummary, /脉冲次数 2000 次/)
  assert.equal(band.assigneeId, store.state.staff[0].id)
  assert.equal(band.equipmentUnitId, null)
  assert.equal(band.parameters.resistance, "medium")
  assert.match(band.equipmentSummary, /阻力 中/)
})

test("quickAdd consumes parser output: pulses/minutes parameters and nullable top-level assignee", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "right", "肩袖损伤")
  store.setChief({ deviceId: "doc", entryId: created.entry.id, targetId: "shoulder", side: "right" })
  const operator = store.state.staff[0]
  const parsed = parseQuickOrder("右肩 冈上肌冲击波2000次", {
    staff: store.state.staff,
    equipment: EQUIPMENT_TYPES,
  })
  assert.equal(parsed.assigneeId, null)
  const view = store.quickAdd({
    deviceId: "doc",
    entryId: created.entry.id,
    chief: parsed.chief,
    items: parsed.items,
    assigneeId: parsed.assigneeId,
  })
  const shockwave = view.entry.items.at(-1)
  // 顶层 null 表示“没说派给谁”，不能把默认派工覆盖成未派。
  assert.equal(shockwave.assigneeId, operator.id)
  assert.equal(shockwave.parameters.pulses, 2000)
  assert.match(shockwave.equipmentSummary, /脉冲次数 2000 次/)

  const ultrasound = parseQuickOrder("左膝 超声波8分钟 股四头肌", {
    equipment: EQUIPMENT_TYPES,
  })
  const withUltrasound = store.quickAdd({
    deviceId: "doc",
    entryId: created.entry.id,
    chief: ultrasound.chief,
    items: ultrasound.items,
  })
  const usItem = withUltrasound.entry.items.at(-1)
  assert.equal(usItem.parameters.minutes, 8)
  assert.equal(usItem.equipmentUnitId, "ultrasound-1")

  const band = parseQuickOrder("左膝 股四头肌弹力带3组15次", { equipment: EQUIPMENT_TYPES })
  const withBand = store.quickAdd({
    deviceId: "doc",
    entryId: created.entry.id,
    chief: band.chief,
    items: band.items,
  })
  const bandItem = withBand.entry.items.at(-1)
  assert.deepEqual(bandItem.dose, { sets: 3, reps: 15 })
  assert.deepEqual(bandItem.parameters, { resistance: "light" })
  assert.equal(bandItem.equipmentUnitId, null)
  assert.match(bandItem.equipmentSummary, /阻力 轻/)
})

test("invalid equipment combinations and batch items reject without any partial write", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "right")
  const entryId = created.entry.id
  const addOne = (overrides) =>
    store.addItem({
      deviceId: "doc",
      entryId,
      targetId: "quad",
      ...overrides,
    })

  const count = () => store.entryById(entryId).items.length
  assert.equal(count(), 0)

  for (const overrides of [
    { technique: "massage", equipmentTypeId: "ultrasound" },
    { technique: "equipment", equipmentTypeId: "elastic-band", equipmentUnitId: "ultrasound-1" },
    { technique: "equipment", exerciseTemplateId: "band-row", equipmentTypeId: "isokinetic" },
    { technique: "equipment", targetId: "shoulder", exerciseTemplateId: "isokinetic-knee" },
    { technique: "massage", parameters: { minutes: 8 } },
  ]) {
    assert.throws(() => addOne(overrides), /设备|机台|模板|部位|器械/)
    assert.equal(count(), 0)
  }

  const before = structuredClone(store.entryById(entryId))
  assert.throws(
    () =>
      store.quickAdd({
        deviceId: "doc",
        entryId,
        chief: { targetId: "shoulder", side: "left" },
        items: [
          {
            targetId: "supraspinatus",
            side: "left",
            technique: "massage",
            direction: "along",
            dose: { minutes: 5 },
          },
          {
            targetId: "infraspinatus",
            technique: "equipment",
            equipmentTypeId: "ultrasound",
            equipmentUnitId: "shockwave-1",
          },
        ],
      }),
    /机台|设备/,
  )
  assert.deepEqual(store.entryById(entryId), before)
  assert.equal(store.entryById(entryId).chiefSiteId, "knee")
  assert.equal(count(), 0)
})

test("sideable equipment requires a real side, while explicit side wins over chiefSide", () => {
  const { store } = openStore()
  const withSide = patientWithChief(store, "right")
  const fallback = store.addItem({
    deviceId: "doc",
    entryId: withSide.entry.id,
    targetId: "quad",
    equipmentTypeId: "ultrasound",
  })
  assert.equal(fallback.entry.items[0].side, "right")

  const explicit = store.addItem({
    deviceId: "doc",
    entryId: withSide.entry.id,
    targetId: "hamstring",
    side: "left",
    equipmentTypeId: "ultrasound",
  })
  assert.equal(explicit.entry.items[1].side, "left")

  const noSide = patientWithChief(store, null, "膝痛待侧")
  assert.throws(
    () =>
      store.addItem({
        deviceId: "doc",
        entryId: noSide.entry.id,
        exerciseTemplateId: "band-terminal-knee-extension",
      }),
    /请选择左侧或右侧/,
  )
  assert.equal(store.entryById(noSide.entry.id).items.length, 0)

  const before = structuredClone(store.entryById(noSide.entry.id))
  assert.throws(
    () =>
      store.quickAdd({
        deviceId: "doc",
        entryId: noSide.entry.id,
        chief: { targetId: "shoulder" },
        items: [{ targetId: "supraspinatus", technique: "equipment", equipmentTypeId: "shockwave" }],
      }),
    /请选择左侧或右侧/,
  )
  assert.deepEqual(store.entryById(noSide.entry.id), before)
})

test("legacy equipment items load without new fields, stay side-null readable and appear in todayByEquipment", () => {
  const { store, file } = openStore()
  const created = patientWithChief(store, "right")
  const entry = store.entryById(created.entry.id)
  entry.items = [
    {
      id: "legacy-equipment-item",
      conditionId: entry.conditionIds[0],
      targetId: "quad",
      side: null,
      technique: "equipment",
      direction: "along",
      dose: { sets: 3, reps: 10 },
      done: false,
    },
  ]
  store.save()

  const revived = new ClinicStore(file)
  revived.load()
  const item = revived.entryView("doc", created.entry.id).entry.items[0]
  assert.equal(item.technique, "equipment")
  assert.equal(item.side, null)
  assert.equal(item.equipmentTypeId, null)
  assert.equal(item.equipmentUnitId, null)
  assert.deepEqual(item.parameters, {})
  assert.deepEqual(item.linkedTargets, [])
  assert.equal(item.equipmentSummary, "器械")
  assert.equal(revived.view("doc").today[0].equipmentCount, 1)
  const legacyGroup = revived.view("doc").todayByEquipment.find((group) => group.equipmentTypeId === null)
  assert.ok(legacyGroup)
  assert.equal(legacyGroup.tasks[0].patientName, "王阿姨")
  assert.equal(legacyGroup.tasks[0].equipmentSummary, "器械")
})

test("todayByEquipment aggregates typed tasks by type/unit with order, assignee and done", () => {
  const { store } = openStore()
  const first = patientWithChief(store, "right", "右膝疼痛")
  const second = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "左肩痛" })
  store.setChief({ deviceId: "doc", entryId: second.entry.id, targetId: "shoulder", side: "left" })
  const aide = store.state.staff.find((person) => person.name === "小李")

  store.addItem({
    deviceId: "doc",
    entryId: first.entry.id,
    targetId: "quad",
    equipmentTypeId: "ultrasound",
    assigneeId: aide.id,
  })
  store.addItem({
    deviceId: "doc",
    entryId: second.entry.id,
    targetId: "supraspinatus",
    equipmentTypeId: "ultrasound",
  })
  store.addItem({
    deviceId: "doc",
    entryId: first.entry.id,
    exerciseTemplateId: "band-terminal-knee-extension",
  })
  const firstUltrasound = store.entryById(first.entry.id).items[0]
  store.patchItem({
    deviceId: "doc",
    entryId: first.entry.id,
    itemId: firstUltrasound.id,
    patch: { done: true },
  })

  const view = store.view("doc")
  assert.equal(view.equipmentTypes.length, 6)
  assert.equal(view.equipmentUnits.length, 7)
  assert.equal(view.exerciseTemplates.length >= 5, true)

  const unitGroups = view.todayByEquipment.filter((group) => group.equipmentTypeId === "ultrasound")
  assert.equal(unitGroups.length, 2)
  const task = unitGroups.flatMap((group) => group.tasks).find((row) => row.patientName === "王阿姨")
  assert.ok(task)
  assert.equal(task.assigneeName, "小李")
  assert.equal(task.done, true)
  assert.equal(typeof task.order, "number")
  assert.match(task.equipmentSummary, /超声/)

  const bandGroup = view.todayByEquipment.find((group) => group.equipmentTypeId === "elastic-band")
  assert.equal(bandGroup.equipmentUnitId, null)
  assert.equal(bandGroup.shared, true)
  assert.equal(bandGroup.tasks[0].patientName, "王阿姨")
  assert.match(bandGroup.tasks[0].equipmentSummary, /弹力带终末伸膝/)
  assert.equal(view.today.find((entry) => entry.patientId === first.entry.patientId).equipmentCount, 2)
})

test("equipment fields survive writing back to a condition and reopening today", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "right")
  store.addItem({
    deviceId: "doc",
    entryId: created.entry.id,
    exerciseTemplateId: "band-terminal-knee-extension",
    parameters: { resistance: "heavy" },
  })
  store.leave({ deviceId: "doc", entryId: created.entry.id, updateCondition: true })
  const condition = store.patient(created.entry.patientId).conditions[0]
  assert.equal(condition.items[0].equipmentTypeId, "elastic-band")
  assert.equal(condition.items[0].equipmentUnitId, null)
  assert.equal(condition.items[0].exerciseTemplateId, "band-terminal-knee-extension")
  assert.equal(condition.items[0].parameters.resistance, "heavy")
  assert.deepEqual(condition.items[0].linkedTargets, [{ targetId: "quad", side: "right" }])

  store.state.days = {}
  const reopened = store.addExisting({ deviceId: "doc", patientId: created.entry.patientId })
  const item = reopened.entry.items[0]
  assert.equal(item.equipmentTypeId, "elastic-band")
  assert.equal(item.exerciseTemplateId, "band-terminal-knee-extension")
  assert.equal(item.parameters.resistance, "heavy")
  assert.deepEqual(item.linkedTargets, [{ targetId: "quad", side: "right" }])
  assert.equal(store.view("doc").today[0].equipmentCount, 1)
})

test("sanitizeState drops impossible unit/type links but keeps safe parameters and legacy null side", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "right")
  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "quad", equipmentTypeId: "ultrasound" })
  const data = structuredClone(store.exportData("doc"))
  const day = data.days[todayKey()]
  const entry = day.entries[0]
  const entryId = entry.id
  entry.items = [
    {
      id: "imported-equipment",
      conditionId: entry.conditionIds[0],
      targetId: "quad",
      side: null,
      technique: "equipment",
      direction: "along",
      dose: { sets: 3, reps: 10 },
      equipmentTypeId: "elastic-band",
      equipmentUnitId: "ultrasound-1",
      exerciseTemplateId: "band-terminal-knee-extension",
      parameters: { resistance: "heavy", unknown: "drop" },
      linkedTargets: [{ targetId: "quad", side: null }],
      done: false,
    },
  ]
  store.importData({ deviceId: "doc", data })
  const item = store.entryById(entryId).items[0]
  assert.equal(item.equipmentTypeId, "elastic-band")
  assert.equal(item.equipmentUnitId, null)
  assert.equal(item.exerciseTemplateId, "band-terminal-knee-extension")
  assert.equal(item.parameters.resistance, "heavy")
  assert.equal("unknown" in item.parameters, false)
  assert.deepEqual(item.linkedTargets, [{ targetId: "quad", side: null }])
  assert.equal(store.entryView("doc", entryId).entry.items[0].side, null)
})

test("templates keep equipment type, parameters, linked targets and template id", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "left")
  const { entry } = store.entryView("doc", created.entry.id)
  store.addItem({
    deviceId: "doc",
    entryId: entry.id,
    targetId: "quad",
    side: "left",
    equipmentTypeId: "elastic-band",
    exerciseTemplateId: "band-terminal-knee-extension",
    parameters: { resistance: "heavy" },
  })
  store.saveTemplateFromEntry({ deviceId: "doc", entryId: entry.id, name: "膝弹力带模板" })
  const savedTemplate = store.state.templates.find((template) => template.name === "膝弹力带模板")
  assert.equal(savedTemplate.items[0].equipmentTypeId, "elastic-band")
  assert.equal(savedTemplate.items[0].exerciseTemplateId, "band-terminal-knee-extension")
  assert.equal(savedTemplate.items[0].parameters.resistance, "heavy")
  assert.deepEqual(savedTemplate.items[0].linkedTargets, [{ targetId: "quad", side: "left" }])

  const next = store.createPatientFromTemplate({ deviceId: "doc", name: "李叔", templateId: savedTemplate.id })
  const nextItem = next.entry.items[0]
  assert.equal(nextItem.equipmentTypeId, "elastic-band")
  assert.equal(nextItem.exerciseTemplateId, "band-terminal-knee-extension")
  assert.equal(nextItem.parameters.resistance, "heavy")
  assert.deepEqual(nextItem.linkedTargets, [{ targetId: "quad", side: "left" }])
})

test("knee and neck can be equipment targets while remaining unavailable for manual work", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "right")
  const kneeEquipment = store.addItem({
    deviceId: "doc",
    entryId: created.entry.id,
    targetId: "knee",
    side: "right",
    equipmentTypeId: "shockwave",
  })
  assert.equal(kneeEquipment.entry.items.at(-1).targetId, "knee")
  assert.equal(kneeEquipment.entry.items.at(-1).equipmentTypeId, "shockwave")
  assert.throws(
    () => store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "knee", side: "left" }),
    /要治的地方/,
  )
  const neckEquipment = store.addItem({
    deviceId: "doc",
    entryId: created.entry.id,
    targetId: "neck",
    equipmentTypeId: "traction-bed",
  })
  const item = neckEquipment.entry.items.at(-1)
  assert.equal(item.targetId, "neck")
  assert.equal(item.side, null)
  assert.equal(item.equipmentUnitId, "traction-bed-1")
})

test("equipment patch edits schema parameters and switches a unit without changing type", () => {
  const { store } = openStore()
  const created = patientWithChief(store, "right")
  store.addItem({
    deviceId: "doc",
    entryId: created.entry.id,
    targetId: "quad",
    side: "right",
    equipmentTypeId: "ultrasound",
    equipmentUnitId: "ultrasound-1",
  })
  const item = store.entryById(created.entry.id).items[0]
  const changed = store.patchItem({
    deviceId: "doc",
    entryId: created.entry.id,
    itemId: item.id,
    patch: { parameters: { intensity: 1.7, minutes: 11 } },
  })
  const edited = changed.entry.items[0]
  assert.equal(edited.equipmentTypeId, "ultrasound")
  assert.equal(edited.parameters.intensity, 1.7)
  assert.equal(edited.parameters.minutes, 11)
  assert.equal(edited.parameters.mode, "continuous")

  const switched = store.patchItem({
    deviceId: "doc",
    entryId: created.entry.id,
    itemId: item.id,
    patch: { equipmentUnitId: "ultrasound-2" },
  })
  assert.equal(switched.entry.items[0].equipmentUnitId, "ultrasound-2")
  assert.throws(
    () =>
      store.patchItem({
        deviceId: "doc",
        entryId: created.entry.id,
        itemId: item.id,
        patch: { equipmentUnitId: "traction-bed-1" },
      }),
    /机.*设备类型不匹配/,
  )
  assert.equal(store.entryById(created.entry.id).items[0].equipmentUnitId, "ultrasound-2")

  store.addItem({ deviceId: "doc", entryId: created.entry.id, targetId: "quad", side: "right", technique: "massage", direction: "along", dose: { minutes: 8 } })
  const manual = store.entryById(created.entry.id).items.at(-1)
  assert.throws(
    () =>
      store.patchItem({
        deviceId: "doc",
        entryId: created.entry.id,
        itemId: manual.id,
        patch: { parameters: { minutes: 4 } },
      }),
    /只有设备项/,
  )
})

test("todayByEquipment shows idle units plus soft current/queued occupancy", () => {
  const { store } = openStore()
  const first = patientWithChief(store, "right", "右膝疼痛")
  const second = store.createPatient({ deviceId: "doc", name: "李叔", conditionName: "左肩痛" })
  store.setChief({ deviceId: "doc", entryId: second.entry.id, targetId: "shoulder", side: "left" })

  const idleView = store.view("doc")
  assert.equal(idleView.todayByEquipment.length, 8)
  assert.ok(idleView.todayByEquipment.every((group) => group.status === "available" && group.openCount === 0))

  store.addItem({
    deviceId: "doc",
    entryId: first.entry.id,
    targetId: "quad",
    equipmentTypeId: "ultrasound",
    equipmentUnitId: "ultrasound-1",
  })
  store.addItem({
    deviceId: "doc",
    entryId: second.entry.id,
    targetId: "supraspinatus",
    equipmentTypeId: "ultrasound",
    equipmentUnitId: "ultrasound-1",
  })
  const occupied = store.view("doc").todayByEquipment.find((group) => group.equipmentUnitId === "ultrasound-1")
  assert.equal(occupied.status, "occupied")
  assert.equal(occupied.openCount, 2)
  assert.equal(occupied.queuedCount, 1)
  assert.equal(occupied.currentTask.patientName, "王阿姨")
  assert.equal(occupied.tasks.length, 2)

  const currentItem = store.entryById(first.entry.id).items[0]
  store.patchItem({ deviceId: "doc", entryId: first.entry.id, itemId: currentItem.id, patch: { done: true } })
  const advanced = store.view("doc").todayByEquipment.find((group) => group.equipmentUnitId === "ultrasound-1")
  assert.equal(advanced.currentTask.patientName, "李叔")
  assert.equal(advanced.queuedCount, 0)
  assert.equal(advanced.openCount, 1)
})
