import test from "node:test"
import assert from "node:assert/strict"
import { parseQuickOrder } from "../shared/quick-order.js"

test("a spoken chain becomes chief plus ordered items", () => {
  const parsed = parseQuickOrder("左膝，股四头按摩8分钟，然后腘绳肌松解，比目鱼肌")
  assert.deepEqual(parsed.chief, { targetId: "knee", side: "left" })
  assert.deepEqual(
    parsed.items.map((item) => [item.targetId, item.side, item.technique, item.dose.minutes]),
    [
      ["quad", "left", "massage", 8],
      ["hamstring", "left", "release", 8],
      ["soleus", "left", "release", 8],
    ],
  )
  assert.equal(parsed.unknown.length, 0)
})

test("chinese numerals and words after the muscle are picked up", () => {
  const parsed = parseQuickOrder("右肩 冈下肌由近到远五分钟 冈上肌")
  assert.deepEqual(parsed.chief, { targetId: "shoulder", side: "right" })
  assert.equal(parsed.items[0].targetId, "infraspinatus")
  assert.equal(parsed.items[0].direction, "outward")
  assert.equal(parsed.items[0].dose.minutes, 5)
  assert.equal(parsed.items[1].targetId, "supraspinatus")
  assert.equal(parsed.items[1].direction, "outward")
})

test("shuang means both sides", () => {
  const parsed = parseQuickOrder("双侧冈上肌松解十分钟")
  assert.equal(parsed.chief, null)
  assert.deepEqual(
    parsed.items.map((item) => item.side),
    ["left", "right"],
  )
  assert.equal(parsed.items[0].technique, "release")
  assert.equal(parsed.items[0].dose.minutes, 10)
})

test("sets and reps imply equipment", () => {
  const parsed = parseQuickOrder("股四头 三组 每组十二次")
  assert.equal(parsed.items[0].technique, "equipment")
  assert.deepEqual(parsed.items[0].dose, { sets: 3, reps: 12 })
})

test("shoulder can also be a work item after the chief is set", () => {
  const parsed = parseQuickOrder("右肩，冈上肌按摩5分钟，然后肩松解")
  assert.deepEqual(parsed.chief, { targetId: "shoulder", side: "right" })
  assert.equal(parsed.items.length, 2)
  assert.equal(parsed.items[1].targetId, "shoulder")
  assert.equal(parsed.items[1].technique, "release")
})

test("unrecognized words are reported back", () => {
  const parsed = parseQuickOrder("左膝，肱二头肌和三角肌前束按摩")
  assert.equal(parsed.chief.targetId, "knee")
  assert.equal(parsed.items.length, 0)
  assert.equal(parsed.unknown.length >= 1, true)
})

test("longer aliases win at the same position", () => {
  const parsed = parseQuickOrder("肩胛提肌松解")
  assert.equal(parsed.items[0].targetId, "levator-scap")
})

test("empty or garbage input yields nothing", () => {
  assert.deepEqual(parseQuickOrder("").items, [])
  assert.deepEqual(parseQuickOrder(",,,。。。").items, [])
})
