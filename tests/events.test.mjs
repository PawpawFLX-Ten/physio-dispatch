import test from "node:test"
import assert from "node:assert/strict"
import { changeEvent, parseChangeEvent } from "../shared/events.js"

test("change events round-trip between server and client", () => {
  const event = changeEvent(7, "device-1")
  assert.deepEqual(event, { n: 7, origin: "device-1" })
  assert.deepEqual(parseChangeEvent(JSON.stringify(event)), event)
  // origin 缺省成空串；坏内容解析成 null，别把前端砸了。
  assert.deepEqual(parseChangeEvent(JSON.stringify({ n: 3 })), { n: 3, origin: "" })
  assert.equal(parseChangeEvent("not json"), null)
  assert.equal(parseChangeEvent(JSON.stringify({ origin: "x" })), null)
})
