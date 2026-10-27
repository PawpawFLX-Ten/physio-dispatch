import test from "node:test"
import assert from "node:assert/strict"
import { changeEvent, parseChangeEvent } from "../shared/events.js"

test("change events round-trip between server and client", () => {
  const event = changeEvent(7, "device-1", "之之")
  assert.deepEqual(event, { n: 7, origin: "device-1", by: "之之" })
  assert.deepEqual(parseChangeEvent(JSON.stringify(event)), event)
  // origin/by 缺省成空串；坏内容解析成 null，别把前端砸了。
  assert.deepEqual(parseChangeEvent(JSON.stringify({ n: 3 })), { n: 3, origin: "", by: "" })
  assert.deepEqual(parseChangeEvent(JSON.stringify({ n: 3, by: 9 })), { n: 3, origin: "", by: "" })
  assert.equal(parseChangeEvent("not json"), null)
  assert.equal(parseChangeEvent(JSON.stringify({ origin: "x" })), null)
})

test("clinic.json is written compact so saves stay small as data grows", () => {
  const store = openStoreLike()
  store.setup({ deviceId: "doc", staffName: "之之" })
  const raw = store.fs.readFileSync(store.file, "utf8")
  assert.equal(raw.includes("\n"), false)
})

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClinicStore } from "../server/store.js"

function openStoreLike() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-events-"))
  const store = new ClinicStore(path.join(dir, "clinic.json"))
  store.load()
  store.fs = fs
  return store
}
