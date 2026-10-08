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
  assert.deepEqual(keysForItem({ targetId: "lumbar", side: null }), ["lumbar:mid"])
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
  assert.equal(itemsOnSpot(items, "quad", "right").length, 1)
  assert.equal(itemsOnSpot(items, "hamstring", "left").length, 0)
})
