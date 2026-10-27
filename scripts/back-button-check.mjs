// 返回键分层的行为验证：需要 dev 环境（vite 5173 + api 8787）和 BiDi 浏览器：
//   node scripts/back-button-check.mjs
// 环境要求与 ui-e2e.mjs 相同：BIDI=ws://127.0.0.1:9222/session，数据目录可重复跑。


const wsUrl = process.env.BIDI || "ws://127.0.0.1:9222/session"
const base = process.env.APP || "http://127.0.0.1:5173"
const api = process.env.API || "http://127.0.0.1:8787"
const device = "backcheck"

const socket = new WebSocket(wsUrl)
const pending = new Map()
let nextId = 1

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method })
  })
}

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(message.error)}`))
  else waiter.resolve(message.result)
})

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve)
  socket.addEventListener("error", reject)
})

await send("session.new", { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } })

const tab = await send("browsingContext.create", { type: "tab" })
const ctx = tab.context
// 无论成败都把 BiDi 会话关掉，免得残留会话卡死下一次运行。
try {
  await main()
} finally {
  socket.close()
}

async function main() {
try {
  await send("browsingContext.setViewport", {
    context: ctx,
    viewport: { width: 430, height: 932, devicePixelRatio: 1 },
  })
} catch {
  /* 视口接口不可用时沿用窗口尺寸 */
}

async function evaluate(expression) {
  const result = await send("script.evaluate", {
    expression,
    target: { context: ctx },
    awaitPromise: true,
  })
  const remote = result.result || result
  if (remote.type === "exception" || result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails || remote))
  }
  return remote.value ?? remote
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const text = () => evaluate("document.body ? document.body.innerText : ''")
const run = (code) => evaluate(`(() => { ${code} })()`)

async function waitCond(label, check, timeout = 8000) {
  const start = Date.now()
  let latest = ""
  while (Date.now() - start < timeout) {
    latest = await text()
    if (await check(latest)) return latest
    await sleep(150)
  }
  throw new Error(`等待超时：${label}。页面是：\n${latest.slice(0, 400)}`)
}

async function clickButton(name) {
  const clicked = await run(`
    const name = ${JSON.stringify(name)}
    const buttons = [...document.querySelectorAll("button")]
    const exact = buttons.find((node) => node.textContent.trim().replace(/\\s+/g, " ") === name)
    const row = buttons.find((node) => node.classList.contains("row-btn") && node.textContent.replace(/\\s+/g, "").includes(name))
    const button = exact || row
    if (!button) return "MISS:" + buttons.slice(0, 25).map((node) => node.textContent.trim().replace(/\\s+/g, " ")).join("|")
    button.click()
    return true
  `)
  if (clicked !== true) throw new Error(`找不到按钮 ${name}。页面按钮有：${clicked}`)
}

async function post(path, body) {
  const response = await fetch(api + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: device, ...body }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path}: ${data.error || response.status}`)
  return data
}

// ---- 造数：先拿到浏览器真实 deviceId（?device= 只是独立的存储槽，值仍是随机 UUID）----
await send("browsingContext.navigate", { context: ctx, url: `${base}/?device=${device}`, wait: "complete" })
let devId = ""
for (let attempt = 0; attempt < 20 && !devId; attempt += 1) {
  devId = await run(
    `return localStorage.getItem('physio-device-id:${device}') || localStorage.getItem('physio-device-id') || ""`,
  )
  if (devId) break
  await sleep(150)
}
if (!devId) throw new Error("拿不到浏览器的 deviceId")
await post("/api/setup", { deviceId: devId, staffName: "甲" }).catch(async () => {
  await post("/api/claim", { deviceId: devId, staffName: "甲" })
})

const stamp = Date.now() % 10000
const patientName = `测试${stamp}`
const patient = await post("/api/patients", { deviceId: devId, name: patientName, conditionName: "膝盖" })
const entryId = patient.entry.id
await post(`/api/entries/${entryId}/chief`, { deviceId: devId, targetId: "knee" })
await post(`/api/entries/${entryId}/items`, { deviceId: devId, targetId: "hamstring" })
await post(`/api/entries/${entryId}/leave`, { deviceId: devId, updateCondition: true })
const rejoined = await post("/api/today/entries", { deviceId: devId, patientId: patient.entry.patientId })
const cleanEntryId = rejoined.entry.id

await send("browsingContext.navigate", { context: ctx, url: `${base}/?device=${device}`, wait: "complete" })
await waitCond("今日单出现", (t) => t.includes("今日单") && t.includes(patientName))

// 1. 今日单没有弹层时，不该有我们的哨兵
const bareState = await run("return JSON.stringify(history.state && history.state.physioLayer ? 'sentinel' : 'none')")
if (bareState !== '"none"') throw new Error(`无弹层时不该有哨兵：${bareState}`)
console.log("1 底层无哨兵：通过")

// 2. 返回键关「加入病人」弹层，而不是退出
await clickButton("加入病人")
await waitCond("弹层打开", (t) => t.includes("新病人"))
// 文本出现到 effect 推哨兵之间有毫秒级窗口，稍等再断言
let sheetState = "none"
for (let attempt = 0; attempt < 10 && sheetState !== '"sentinel"'; attempt += 1) {
  sheetState = await run("return JSON.stringify(history.state && history.state.physioLayer ? 'sentinel' : 'none')")
  if (sheetState === '"sentinel"') break
  await sleep(150)
}
if (sheetState !== '"sentinel"') throw new Error("弹层打开应有哨兵")
await run("history.back()")
await waitCond("返回关掉弹层", (t) => !t.includes("新病人") && t.includes("今日单"))
console.log("2 返回键关弹层：通过")

// 3. Escape 也走同一层
await clickButton("加入病人")
await waitCond("弹层再开", (t) => t.includes("新病人"))
await run("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
await waitCond("Escape 关弹层", (t) => !t.includes("新病人"))
console.log("3 Escape 关弹层：通过")

// 4. 病人页里：先关「名单加项」，再返回今日单
await clickButton(patientName)
await waitCond("病人页打开", (t) => t.includes("全部派给"))
await clickButton("名单加项")
await waitCond("名单弹层", (t) => t.includes("点名加项"))
await run("history.back()")
await waitCond("返回关名单弹层", (t) => !t.includes("点名加项") && t.includes("全部派给"))
await run("history.back()")
await waitCond("返回今日单（无分歧直接走）", (t) => t.includes("加入病人") || t.includes("记回病症"))
const afterBack = await text()
if (afterBack.includes("记回病症")) {
  await clickButton("留在今天")
  await waitCond("留在今天后回今日单", (t) => t.includes("今日单"))
}
console.log("4 病人页两层返回：通过")

// 5. 有分歧时：返回弹「记回病症」提醒，再按返回只关提醒、病人页还在哨兵保护里
await waitCond("病人回到今日单列表", (t) => t.includes("加入病人") && t.includes(patientName))
await clickButton(patientName)
await waitCond("病人页再开", (t) => t.includes("全部派给"))
await post(`/api/entries/${cleanEntryId}/items`, { targetId: "quad" })
await run("history.back()")
await waitCond("返回出现提醒", (t) => t.includes("记回病症"))
await run("history.back()")
await waitCond("再返回只关提醒", (t) => !t.includes("记回病症") && t.includes("全部派给"))
// 病人页还开着：再按返回应该重新弹提醒（哨兵补位成功），而不是退出应用
await run("history.back()")
await waitCond("提醒重新出现", (t) => t.includes("记回病症") && t.includes("全部派给"))
await clickButton("留在今天")
await waitCond("留在今天回今日单", (t) => t.includes("今日单"))
console.log("5 分歧提醒的返回分层：通过")

console.log("BACK_BUTTON_OK")
}
