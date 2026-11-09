import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { ReadableStream } from "node:stream/web"
import { fileURLToPath } from "node:url"
import { createLimiter, downloadBytes } from "../shared/body-download.js"
import { BODY_BYTES } from "../shared/body-assets.js"
import { BODY_FILES } from "../shared/body-map.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const noWait = () => Promise.resolve()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bytes = (n) => new Uint8Array(n).fill(n)

// 假响应：依次吐出 chunks。hang 时吐完就挂住不结束（像卡死的连接），请求被 abort 才报错；
// gapMs 时每块之间隔一会儿（像慢但一直在走的线路）。
function fakeResponse(signal, chunks, { hang = false, gapMs = 0, status = 200, headers = {} } = {}) {
  let index = 0
  const body = new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => {
        try {
          controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }))
        } catch {
          /* 流已经结束 */
        }
      })
    },
    async pull(controller) {
      if (gapMs) await sleep(gapMs)
      if (index < chunks.length) {
        controller.enqueue(chunks[index])
        index += 1
        return
      }
      if (hang) return new Promise(() => {})
      controller.close()
    },
  })
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), body }
}

test("downloadBytes returns the whole file in order and reports progress", async () => {
  const seen = []
  const buffer = await downloadBytes("/body/a.glb", {
    fetchImpl: async (_url, { signal }) => fakeResponse(signal, [bytes(3), bytes(4)], { headers: { "content-length": "7" } }),
    onProgress: (received, total) => seen.push([received, total]),
  })
  assert.deepEqual([...new Uint8Array(buffer)], [3, 3, 3, 4, 4, 4, 4])
  assert.deepEqual(seen, [[3, 7], [7, 7]])
})

test("downloadBytes aborts a body that stops sending data and downloads it again", async () => {
  let calls = 0
  const retries = []
  const buffer = await downloadBytes("/body/a.glb", {
    stallMs: 30,
    wait: noWait,
    fetchImpl: async (_url, { signal }) => {
      calls += 1
      return calls === 1 ? fakeResponse(signal, [bytes(2)], { hang: true }) : fakeResponse(signal, [bytes(5)])
    },
    onRetry: (attempt, error) => retries.push([attempt, error.message]),
  })
  assert.equal(calls, 2)
  assert.equal(buffer.byteLength, 5)
  assert.deepEqual(retries, [[2, "人体模型下载卡住了"]])
})

test("downloadBytes also gives up waiting for response headers that never arrive", async () => {
  let calls = 0
  const cacheModes = []
  const buffer = await downloadBytes("/body/a.glb", {
    stallMs: 30,
    wait: noWait,
    fetchImpl: (_url, { signal, cache }) => {
      calls += 1
      cacheModes.push(cache)
      if (calls > 1) return Promise.resolve(fakeResponse(signal, [bytes(1)]))
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
    },
  })
  assert.equal(calls, 2)
  assert.equal(buffer.byteLength, 1)
  // 首次照常走浏览器缓存；重下必须跳过卡死那次占着的缓存条目，否则会排在它后面干等。
  assert.deepEqual(cacheModes, [undefined, "reload"])
})

test("downloadBytes keeps a slow download that is still receiving data", async () => {
  let calls = 0
  const buffer = await downloadBytes("/body/a.glb", {
    stallMs: 60,
    wait: noWait,
    fetchImpl: async (_url, { signal }) => {
      calls += 1
      // 总共约 120ms，超过卡死阈值，但每块间隔都在阈值内，不该被打断。
      return fakeResponse(signal, [bytes(1), bytes(1), bytes(1), bytes(1), bytes(1)], { gapMs: 20 })
    },
  })
  assert.equal(calls, 1)
  assert.equal(buffer.byteLength, 5)
})

test("downloadBytes does not retry a missing file", async () => {
  let calls = 0
  await assert.rejects(
    downloadBytes("/body/missing.glb", {
      wait: noWait,
      fetchImpl: async () => {
        calls += 1
        return { ok: false, status: 404, headers: new Headers(), body: null }
      },
    }),
    /HTTP 404/,
  )
  assert.equal(calls, 1)
})

test("downloadBytes retries server errors up to the limit, then explains what happened", async () => {
  let calls = 0
  const retries = []
  await assert.rejects(
    downloadBytes("/body/a.glb", {
      maxAttempts: 3,
      wait: noWait,
      fetchImpl: async () => {
        calls += 1
        return { ok: false, status: 503, headers: new Headers(), body: null }
      },
      onRetry: (attempt) => retries.push(attempt),
    }),
    /HTTP 503），已自动重试 2 次/,
  )
  assert.equal(calls, 3)
  assert.deepEqual(retries, [2, 3])
})

test("downloadBytes downloads again when the body ends short of Content-Length", async () => {
  let calls = 0
  const buffer = await downloadBytes("/body/a.glb", {
    wait: noWait,
    fetchImpl: async (_url, { signal }) => {
      calls += 1
      return fakeResponse(signal, calls === 1 ? [bytes(4)] : [bytes(10)], { headers: { "content-length": "10" } })
    },
  })
  assert.equal(calls, 2)
  assert.equal(buffer.byteLength, 10)
})

test("downloadBytes skips the length check for compressed responses", async () => {
  let calls = 0
  const buffer = await downloadBytes("/body/a.glb", {
    wait: noWait,
    fetchImpl: async (_url, { signal }) => {
      calls += 1
      return fakeResponse(signal, [bytes(7)], { headers: { "content-length": "3", "content-encoding": "br" } })
    },
  })
  assert.equal(calls, 1)
  assert.equal(buffer.byteLength, 7)
})

test("createLimiter never runs more than the limit at once and keeps each result", async () => {
  const limit = createLimiter(2)
  let active = 0
  let peak = 0
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      limit(async () => {
        active += 1
        peak = Math.max(peak, active)
        await sleep(5)
        active -= 1
        return n * 10
      }),
    ),
  )
  assert.deepEqual(results, [10, 20, 30, 40, 50])
  assert.equal(peak, 2)
})

test("createLimiter keeps going after a task fails", async () => {
  const limit = createLimiter(1)
  const [failed, passed] = await Promise.allSettled([limit(async () => { throw new Error("坏了") }), limit(async () => "好了")])
  assert.equal(failed.status, "rejected")
  assert.equal(passed.value, "好了")
})

test("BODY_BYTES matches the model files the page loads", () => {
  const total = BODY_FILES.reduce((sum, file) => sum + fs.statSync(path.join(root, "client", "public", "body", file)).size, 0)
  assert.equal(total, BODY_BYTES)
})
