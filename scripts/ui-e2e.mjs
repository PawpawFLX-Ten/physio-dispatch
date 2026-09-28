import fs from "node:fs"

const wsUrl = process.env.BIDI || "ws://127.0.0.1:9222/session"
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

async function context() {
  const created = await send("browsingContext.create", { type: "tab" })
  const id = created.context
  try {
    await send("browsingContext.setViewport", {
      context: id,
      viewport: { width: 430, height: 932 },
      devicePixelRatio: 1,
    })
  } catch {
    /* 视口接口不可用时沿用窗口尺寸 */
  }
  return id
}

async function evaluate(contextId, expression) {
  const result = await send("script.evaluate", {
    expression,
    target: { context: contextId },
    awaitPromise: true,
  })
  if (result.type === "exception" || result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails || result))
  }
  const remote = result.result || result
  if (remote.type === "exception") throw new Error(JSON.stringify(remote))
  if (remote.type === "string" || remote.type === "number" || remote.type === "boolean") return remote.value
  if (remote.type === "null" || remote.type === "undefined") return null
  return remote.value ?? remote
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function text(contextId) {
  return evaluate(contextId, "document.body ? document.body.innerText : ''")
}

async function waitText(contextId, includes, timeout = 8000) {
  const start = Date.now()
  let latest = ""
  while (Date.now() - start < timeout) {
    latest = await text(contextId)
    if (includes.every((part) => latest.includes(part))) return latest
    await sleep(150)
  }
  throw new Error(`等待超时，想看到 ${includes.join(" / ")}，页面是：\n${latest}`)
}

async function run(contextId, expression) {
  return evaluate(contextId, `(() => { ${expression} })()`)
}

async function fill(contextId, label, value) {
  await run(contextId, `
    const label = [...document.querySelectorAll("label")].find((node) => node.textContent.includes(${JSON.stringify(label)}))
    const input = label?.querySelector("input")
    if (!input) throw new Error("找不到字段 ${label}")
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
    set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event("input", { bubbles: true }))
  `)
}

async function clickButton(contextId, name) {
  const clicked = await run(contextId, `
    const name = ${JSON.stringify(name)}
    const buttons = [...document.querySelectorAll("button")]
    const exact = buttons.find((node) => node.textContent.trim().replace(/\\s+/g, " ") === name)
    const row = buttons.find((node) => node.classList.contains("row-btn") && node.textContent.replace(/\\s+/g, "").includes(name))
    const button = exact || row
    if (!button) return false
    button.click()
    return true
  `)
  if (!clicked) throw new Error(`找不到按钮 ${name}`)
}

async function shot(contextId, file) {
  const image = await send("browsingContext.captureScreenshot", { context: contextId })
  const data = image.data || image.base64 || image
  fs.writeFileSync(file, Buffer.from(data, "base64"))
}

async function waitReady(contextId) {
  const start = Date.now()
  let latest = ""
  while (Date.now() - start < 30000) {
    latest = await run(contextId, `return document.querySelector(".body-stage-view")?.dataset.ready || ""`)
    if (latest === "1") return
    await sleep(200)
  }
  const page = await text(contextId)
  throw new Error(`人体模型没有准备好：\n${page.slice(0, 400)}`)
}

async function tapBody(contextId, name, yaw, nudgeY = 0) {
  await run(contextId, `
    const view = document.querySelector(".body-stage-view")
    const canvas = view?.querySelector("canvas")
    if (!view || !canvas || view.dataset.ready !== "1") throw new Error("人体还没出来")
    const picks = JSON.parse(view.dataset.picks)
    const camera = JSON.parse(view.dataset.camera)
    const target = picks[${JSON.stringify(name)}]
    if (!target) throw new Error("没有可点的位置：" + ${JSON.stringify(name)} + " " + view.dataset.picks)
    const yaw = ${yaw}
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    const x = target.x * cos + target.z * sin
    const z = -target.x * sin + target.z * cos
    const y = target.y
    const rect = canvas.getBoundingClientRect()
    const tan = Math.tan((camera.fov * Math.PI) / 180 / 2)
    const aspect = rect.width / rect.height
    const depth = camera.z - z
    const ndcX = x / (depth * tan * aspect)
    const ndcY = (y - camera.lookY) / (depth * tan)
    const clientX = rect.left + ((ndcX + 1) / 2) * rect.width
    const clientY = rect.top + ((1 - ndcY) / 2) * rect.height + ${nudgeY}
    view.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX, clientY, pointerId: 1, button: 0 }))
    view.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX, clientY, pointerId: 1, button: 0 }))
  `)
}

const doctor = await context()
await send("browsingContext.navigate", { context: doctor, url: "http://127.0.0.1:5173/?device=1", wait: "complete" })
await waitText(doctor, ["进入治疗室", "我的名字"])
await fill(doctor, "我的名字", "之之")
await clickButton(doctor, "进入治疗室")
await waitText(doctor, ["今日单", "之之"])
await shot(doctor, "/tmp/physio-today.png")
console.log("1 建立名字：通过")

const aide = await context()
await send("browsingContext.navigate", { context: aide, url: "http://127.0.0.1:5173/?device=2", wait: "complete" })
await waitText(aide, ["今天你是谁", "之之"])
await fill(aide, "新名字", "小李")
await clickButton(aide, "添加并进入")
await waitText(aide, ["今日单", "小李"])
console.log("1b 第二台选名字：通过")

await clickButton(doctor, "加入病人")
await waitText(doctor, ["新病人"])
await fill(doctor, "姓名", "王阿姨")
await fill(doctor, "病症名称", "右膝疼痛")
await clickButton(doctor, "开始点选")
await waitText(doctor, ["王阿姨", "先点要治的地方"])
await waitReady(doctor)
// 模型就绪后布局还在稳定（画布尺寸、字体），等一等再按锚点投影点击。
await sleep(800)
for (let attempt = 0; attempt < 3; attempt += 1) {
  await tapBody(doctor, "knee", 0)
  await sleep(300)
  const chiefOk = await run(doctor, `return document.body.innerText.includes("要治 膝盖")`)
  if (chiefOk) break
}
await clickButton(doctor, "背面")
await sleep(400)
// 承山标记球已外移缩小，点选时若穴位挡在肌肉正前方会认后面的肌肉；正对比目鱼肌中心应加出比目鱼肌。
for (const [name, nudgeY] of [["hamstring", 0], ["soleus", 0], ["plantar", 0], ["lumbar", 0]]) {
  await tapBody(doctor, name, Math.PI, nudgeY)
  await sleep(250)
}
await waitText(doctor, ["要治 膝盖", "腘绳肌", "比目鱼肌", "足底", "腰"])
const listOrder = await run(doctor, `return [...document.querySelectorAll(".patient-target")].map((node) => node.textContent).join(">")`)
if (listOrder !== "腘绳肌>比目鱼肌>足底>腰") throw new Error(`清单顺序不对：${listOrder}`)
let labels = ""
for (let attempt = 0; attempt < 20; attempt += 1) {
  labels = await run(doctor, `return [...document.querySelectorAll(".body-stage-label")].map((node) => node.textContent).filter(Boolean).sort().join(",")`)
  if (labels === "1,2,3,4") break
  await sleep(100)
}
if (labels !== "1,2,3,4") throw new Error(`人体序号不对：${labels}`)
await shot(doctor, "/tmp/physio-body.png")
console.log("3 点选顺序出现在清单和人体：通过")

await clickButton(doctor, "返回")
await waitText(doctor, ["今日单", "王阿姨"])
await clickButton(doctor, "王阿姨")
await waitText(doctor, ["腘绳肌", "按摩", "沿肌纤维", "8 分钟"])
await clickButton(doctor, "全部派给")
await waitText(doctor, ["小李"])
await clickButton(doctor, "小李")
await waitText(doctor, ["小李"])
await clickButton(doctor, "完成")
await waitText(doctor, ["已完成"])
const bodyTaps = await run(doctor, `return document.body.innerText.includes("先点要治的地方")`)
if (bodyTaps) throw new Error("老病人仍要求先点人体")
await clickButton(doctor, "返回")
await waitText(doctor, ["今日单"])
console.log("2 老病人一次派完并完成：通过")

await send("browsingContext.navigate", { context: aide, url: "http://127.0.0.1:5173/?device=2", wait: "complete" })
await waitText(aide, ["今日单", "王阿姨"])
await clickButton(aide, "王阿姨")
await waitText(aide, ["腘绳肌", "比目鱼肌"])
await run(aide, `
  const handle = document.querySelector(".patient-handle")
  const row = handle.closest("[data-item]")
  const height = row.getBoundingClientRect().height
  const rect = handle.getBoundingClientRect()
  const startX = rect.left + 8
  const startY = rect.top + 8
  handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: startX, clientY: startY, pointerId: 7, button: 0, buttons: 1 }))
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: startX, clientY: startY + height + 8, pointerId: 7, button: 0, buttons: 1 }))
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: startX, clientY: startY + height + 8, pointerId: 7, button: 0 }))
`)
await sleep(400)
await clickButton(aide, "返回")
await waitText(aide, ["今天的改动要记回病症吗"])
await clickButton(aide, "留在今天")
await waitText(aide, ["今日单"])
await clickButton(doctor, "王阿姨")
await waitText(doctor, ["比目鱼肌", "腘绳肌"])
const doctorOrder = await run(doctor, `return [...document.querySelectorAll(".patient-target")].map((node) => node.textContent).join(">")`)
if (!doctorOrder.startsWith("比目鱼肌>腘绳肌")) throw new Error(`两台顺序不一致：${doctorOrder}`)
const clinic = JSON.parse(fs.readFileSync(process.env.CLINIC_DATA || new URL("../data/clinic.json", import.meta.url)))
const savedPatient = clinic.patients.find((patient) => patient.name === "王阿姨")
const savedOrder = savedPatient.conditions[0].items.map((item) => item.targetId)
if (savedOrder.join(">") !== "hamstring>soleus>plantar>lumbar") {
  throw new Error(`病症被改写了：${savedOrder.join(">")}`)
}
if (savedPatient.conditions[0].items.some((item) => item.assigneeId || item.done)) {
  throw new Error("派给谁或完成写进了病症")
}
const todayEntry = Object.values(clinic.days)[0].entries.find((entry) => entry.patientId === savedPatient.id)
const todayOrder = todayEntry.items.map((item) => item.targetId)
if (todayOrder[0] !== "soleus" || todayOrder[1] !== "hamstring") {
  throw new Error(`今天的单没有新顺序：${todayOrder.join(">")}`)
}
console.log("4 另一台看到新顺序：", doctorOrder)
console.log("5 派发和完成不写回，不更新则病症保持旧顺序：通过")

await clickButton(doctor, "返回")
await waitText(doctor, ["今天的改动要记回病症吗"])
await clickButton(doctor, "留在今天")
await waitText(doctor, ["今日单"])
await clickButton(doctor, "加入病人")
await fill(doctor, "姓名", "李叔")
await fill(doctor, "病症名称", "腰紧")
await clickButton(doctor, "开始点选")
await waitText(doctor, ["李叔"])
await clickButton(doctor, "返回")
await waitText(doctor, ["今日单", "李叔"])
await clickButton(doctor, "王阿姨")
await waitText(doctor, ["复制病症", "比目鱼肌"])
await clickButton(doctor, "复制病症")
await waitText(doctor, ["复制到"])
await clickButton(doctor, "李叔")
await clickButton(doctor, "复制")
await waitText(doctor, ["已复制，派给谁要重新填"])
await clickButton(doctor, "返回")
await waitText(doctor, ["留在今天"])
await clickButton(doctor, "留在今天")
await waitText(doctor, ["今日单", "李叔"])
await clickButton(doctor, "李叔")
await waitText(doctor, ["把「右膝疼痛」加入今天"])
await clickButton(doctor, "把「右膝疼痛」加入今天")
await waitText(doctor, ["腘绳肌", "未派"])
console.log("6 复制后派给谁为空：通过")

const broken = await context()
await send("script.addPreloadScript", {
  functionDeclaration: `() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (String(type).includes("webgl")) return null
      return original.call(this, type, ...args)
    }
  }`,
  contexts: [broken],
})
await send("browsingContext.navigate", { context: broken, url: "http://127.0.0.1:5173/?device=3", wait: "complete" })
await waitText(broken, ["今天你是谁"])
await clickButton(broken, "之之")
await waitText(broken, ["今日单"])
await clickButton(broken, "李叔")
await waitText(broken, ["模型没有加载出来", "腘绳肌"])
await clickButton(broken, "完成")
await waitText(broken, ["已完成", "模型没有加载出来"])
console.log("7 模型失败时清单仍能完成：通过")

console.log("UI_E2E_OK")
socket.close()
