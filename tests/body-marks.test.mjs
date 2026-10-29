import test from "node:test"
import assert from "node:assert/strict"
import {
  buildMarkState,
  itemsOnSpot,
  keysForItem,
  markKey,
  ordersFor,
  resolvePaintRole,
} from "../shared/body-marks.js"

test("markKey 用 mid 表示没有左右", () => {
  assert.equal(markKey("lumbar", null), "lumbar:mid")
  assert.equal(markKey("quad", "left"), "quad:left")
})

test("keysForItem 有左右只标那一侧，不会两边一起亮", () => {
  assert.deepEqual(keysForItem({ targetId: "quad", side: "left" }), ["quad:left"])
  assert.deepEqual(keysForItem({ targetId: "quad", side: "right" }), ["quad:right"])
  assert.deepEqual(keysForItem({ targetId: "lumbar", side: null }), ["lumbar:mid"])
})

test("旧数据没有侧别时，可侧化目标左右两键都标；腰颈仍落 mid", () => {
  assert.deepEqual(keysForItem({ targetId: "quad", side: null }), ["quad:left", "quad:right"])
  assert.deepEqual(keysForItem({ targetId: "knee" }), ["knee:left", "knee:right"])
  assert.deepEqual(keysForItem({ targetId: "lumbar", side: "left" }), ["lumbar:mid"])
  assert.deepEqual(keysForItem({ targetId: "neck", side: null }), ["neck:mid"])
})

test("linkedTargets 一并生成键，主目标在前且不重复", () => {
  assert.deepEqual(
    keysForItem({
      targetId: "quad",
      side: "left",
      linkedTargets: [
        { targetId: "knee", side: "right" },
        { targetId: "quad", side: "left" },
        { targetId: "glute", side: null },
        { targetId: "neck", side: "left" },
      ],
    }),
    ["quad:left", "knee:right", "glute:left", "glute:right", "neck:mid"],
  )
})

test("下手项只亮被点到的一侧", () => {
  const state = buildMarkState({
    chiefSiteId: "knee",
    chiefSide: "right",
    items: [{ targetId: "quad", side: "left", done: false }],
  })
  assert.equal(resolvePaintRole("quad", "left", state), "work")
  assert.equal(resolvePaintRole("quad", "right", state), "base")
  assert.equal(resolvePaintRole("knee", "right", state), "chief")
  assert.equal(resolvePaintRole("knee", "left", state), "base")
})

test("要治的地方和下手用不同角色", () => {
  const state = buildMarkState({
    chiefSiteId: "shoulder",
    chiefSide: "right",
    items: [{ targetId: "supraspinatus", side: "right", done: false }],
  })
  assert.equal(resolvePaintRole("shoulder", "right", state), "chief")
  assert.equal(resolvePaintRole("supraspinatus", "right", state), "work")
})

test("同一块肉还有未完成就按未完成亮度，全部完成才变淡", () => {
  const mixed = buildMarkState({
    items: [
      { targetId: "gastroc", side: "left", done: true },
      { targetId: "gastroc", side: "left", done: false },
    ],
  })
  assert.equal(resolvePaintRole("gastroc", "left", mixed), "work")
  assert.deepEqual(ordersFor("gastroc", "left", mixed), [1, 2])

  const allDone = buildMarkState({
    items: [
      { targetId: "gastroc", side: "left", done: true },
      { targetId: "gastroc", side: "left", done: true },
    ],
  })
  assert.equal(resolvePaintRole("gastroc", "left", allDone), "workDone")
})

test("linkedTargets 共用主项序号，后续主项序号不被额外键挤动", () => {
  const state = buildMarkState({
    items: [
      {
        targetId: "quad",
        side: "left",
        done: false,
        linkedTargets: [{ targetId: "knee", side: "right" }],
      },
      { targetId: "hamstring", side: "right", done: true },
    ],
  })
  assert.deepEqual(ordersFor("quad", "left", state), [1])
  assert.deepEqual(ordersFor("knee", "right", state), [1])
  assert.deepEqual(ordersFor("hamstring", "right", state), [2])
  assert.equal(resolvePaintRole("knee", "right", state), "work")
})

test("旧数据空侧别在左右两侧都高亮，避免人体上看不见", () => {
  const state = buildMarkState({
    items: [{ targetId: "quad", side: null, done: false }],
  })
  assert.equal(resolvePaintRole("quad", "left", state), "work")
  assert.equal(resolvePaintRole("quad", "right", state), "work")
  assert.equal(resolvePaintRole("hamstring", "left", state), "base")
})

test("下手项盖过同一侧的要治高亮", () => {
  const state = buildMarkState({
    chiefSiteId: "shoulder",
    chiefSide: "left",
    items: [{ targetId: "shoulder", side: "left", done: false }],
  })
  assert.equal(resolvePaintRole("shoulder", "left", state), "work")
})

test("itemsOnSpot 按左右分开", () => {
  const items = [
    { id: "a", targetId: "quad", side: "left" },
    { id: "b", targetId: "quad", side: "right" },
    { id: "c", targetId: "soleus", side: "left" },
  ]
  assert.deepEqual(
    itemsOnSpot(items, "quad", "left").map((item) => item.id),
    ["a"],
  )
  assert.deepEqual(
    itemsOnSpot(items, "quad", "right").map((item) => item.id),
    ["b"],
  )
  assert.equal(itemsOnSpot(items, "hamstring", "left").length, 0)
})

test("itemsOnSpot 对旧数据空侧别做 wildcard，并认 linkedTargets", () => {
  const items = [
    { id: "legacy", targetId: "quad", side: null },
    { id: "left", targetId: "quad", side: "left" },
    { id: "linked", targetId: "hamstring", side: "right", linkedTargets: [{ targetId: "knee", side: "left" }] },
    { id: "linked-legacy", targetId: "glute", side: "right", linkedTargets: [{ targetId: "soleus", side: null }] },
  ]
  assert.deepEqual(
    itemsOnSpot(items, "quad", "left").map((item) => item.id),
    ["legacy", "left"],
  )
  assert.deepEqual(
    itemsOnSpot(items, "quad", "right").map((item) => item.id),
    ["legacy"],
  )
  assert.deepEqual(
    itemsOnSpot(items, "knee", "left").map((item) => item.id),
    ["linked"],
  )
  assert.deepEqual(
    itemsOnSpot(items, "soleus", "right").map((item) => item.id),
    ["linked-legacy"],
  )
})
