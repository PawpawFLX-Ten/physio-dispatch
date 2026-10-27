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
  const parsed = parseQuickOrder("左膝，腹横肌和三角肌前束按摩")
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

test("erector spinae parses into its own work item", () => {
  const parsed = parseQuickOrder("腰 竖脊肌松解10分钟")
  assert.equal(parsed.chief.targetId, "lumbar")
  assert.equal(parsed.items[0].targetId, "erector-spinae")
  assert.equal(parsed.items[0].technique, "release")
})

test("new arm and trunk muscles parse", () => {
  const parsed = parseQuickOrder("左肩 肱二头肌按摩8分钟 然后肱三头肌松解，胸大肌按摩5分钟")
  assert.equal(parsed.chief.targetId, "shoulder")
  assert.equal(parsed.chief.side, "left")
  assert.deepEqual(
    parsed.items.map((item) => item.targetId),
    ["biceps-brachii", "triceps-brachii", "pectoralis-major"],
  )
  assert.equal(parsed.items[0].side, "left")
})

test("prefixed muscle names must not be hijacked by the arm version", () => {
  // 「股二头肌」曾被裸词「二头肌」静默错认成手臂的肱二头肌，unknown 还为空。
  const thigh = parseQuickOrder("股二头肌松解八分钟")
  assert.equal(thigh.items[0].targetId, "hamstring")
  assert.equal(thigh.unknown.length, 0)
  const surae = parseQuickOrder("小腿三头肌按摩")
  assert.equal(surae.items[0].targetId, "gastroc")
  assert.equal(surae.unknown.length, 0)
  // 语音错字「骨二头肌」也认腘绳。
  assert.equal(parseQuickOrder("骨二头肌松解").items[0].targetId, "hamstring")
})

test("bare er-tou/san-tou fall back to search instead of guessing the arm", () => {
  const bare = parseQuickOrder("二头肌松解八分钟")
  assert.equal(bare.items.length, 0)
  assert.equal(bare.unknown.includes("二头肌"), true)
  const bareTriceps = parseQuickOrder("三头肌按摩")
  assert.equal(bareTriceps.items.length, 0)
  assert.equal(bareTriceps.unknown.includes("三头肌"), true)
})

test("forearm groups parse", () => {
  const parsed = parseQuickOrder("右肘 前臂伸肌群器械3组10次")
  assert.equal(parsed.items[0].targetId, "forearm-extensors")
  assert.equal(parsed.items[0].technique, "equipment")
})

test("ASR homophone typos resolve to the right muscles", () => {
  assert.equal(parseQuickOrder("骨四头按摩8分钟").items[0].targetId, "quad")
  assert.equal(parseQuickOrder("国绳肌松解").items[0].targetId, "hamstring")
  assert.equal(parseQuickOrder("协方肌放松").items[0].targetId, "trapezius")
  assert.equal(parseQuickOrder("肥肠肌按摩").items[0].targetId, "gastroc")
  // 「肩甲提肌」现状曾别「肩」截断误判成主诉：长匹配必须压过短字。
  const levator = parseQuickOrder("肩甲提肌松解")
  assert.equal(levator.chief, null)
  assert.equal(levator.items[0].targetId, "levator-scap")
  assert.equal(levator.unknown.length, 0)
})

test("colloquial duration words parse instead of silently defaulting", () => {
  assert.equal(parseQuickOrder("腘绳肌半小时").items[0].dose.minutes, 30)
  assert.equal(parseQuickOrder("腘绳肌一个半小时").items[0].dose.minutes, 90)
  assert.equal(parseQuickOrder("冈上肌一个小时").items[0].dose.minutes, 60)
  assert.equal(parseQuickOrder("冈上肌两个钟头").items[0].dose.minutes, 120)
  assert.equal(parseQuickOrder("比目鱼肌一刻钟").items[0].dose.minutes, 15)
  assert.equal(parseQuickOrder("比目鱼肌三刻钟").items[0].dose.minutes, 45)
  assert.equal(parseQuickOrder("腘绳肌半小时").unknown.length, 0)
})

test("colloquial technique phrases parse", () => {
  assert.equal(parseQuickOrder("股四头按一按").items[0].technique, "massage")
  assert.equal(parseQuickOrder("小腿肚压一压").items[0].technique, "massage")
  assert.equal(parseQuickOrder("腘绳肌松一下").items[0].technique, "release")
  assert.equal(parseQuickOrder("腘绳肌松一松").items[0].technique, "release")
  assert.equal(parseQuickOrder("臀松松").items[0].technique, "release")
  assert.equal(parseQuickOrder("腘绳肌松一下").unknown.length, 0)
})

test("stretch parses as its own technique instead of silently becoming massage", () => {
  const parsed = parseQuickOrder("腘绳肌牵伸十分钟")
  assert.equal(parsed.items[0].technique, "stretch")
  assert.equal(parsed.items[0].dose.minutes, 10)
  assert.equal(parseQuickOrder("小腿肚拉伸8分钟").items[0].technique, "stretch")
  assert.equal(parseQuickOrder("腘绳肌拉一下").items[0].technique, "stretch")
  assert.equal(parseQuickOrder("腘绳肌拉一拉，比目鱼肌").items[1].technique, "stretch")
})

test("gluteus medius is its own target, not folded into the glute group", () => {
  assert.equal(parseQuickOrder("左臀中肌松解").items[0].targetId, "glute-med")
  assert.equal(parseQuickOrder("臀中肌拉伸十分钟").items[0].targetId, "glute-med")
  // 说「臀」还是整个臀肌群。
  assert.equal(parseQuickOrder("臀松松").items[0].targetId, "glute")
})

test("connective words do not pollute unknown list", () => {
  const parsed = parseQuickOrder("冈上肌还有冈下肌，以及斜方肌顺便松一下")
  assert.equal(parsed.items.length, 3)
  assert.equal(parsed.unknown.length, 0)
})

test("spoken location phrases map to itband and rhomboid", () => {
  assert.equal(parseQuickOrder("左膝 大腿外侧松解8分钟").items[0].targetId, "itband")
  const seam = parseQuickOrder("肩胛骨缝按一按")
  assert.equal(seam.chief, null)
  assert.equal(seam.items[0].targetId, "rhomboid")
})

test("stuttered duplicate target collapses into one item", () => {
  assert.equal(parseQuickOrder("股四头股四头按摩").items.length, 1)
  // 隔着标点的重复不折叠：用户可能真要两项。
  assert.equal(parseQuickOrder("冈上肌，再来一个冈上肌").items.length, 2)
})

test("both-sided chief is not carried as side=both", () => {
  // 「双侧」只管紧跟着的那个目标（既有语义）：主诉吃掉后，后面的项不带侧。
  const parsed = parseQuickOrder("双膝 股四头按摩8分钟")
  assert.deepEqual(parsed.chief, { targetId: "knee", side: null })
  assert.equal(parsed.items[0].side, null)
  const both = parseQuickOrder("双侧股四头按摩8分钟")
  assert.deepEqual(both.items.map((item) => item.side), ["left", "right"])
})
