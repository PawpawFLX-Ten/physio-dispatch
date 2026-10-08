// 浏览器端到端回归：自己起一套一次性环境（临时数据目录 + 打包前端 + 独立端口），
// 不碰 data/ 里的真实档案，也不需要另开开发服务或带调试端口的浏览器。
// 前提：本机有 Chromium（Playwright 缓存或系统浏览器；可用 CHROME_PATH 指定）。
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

// import.meta.url 的 pathname 带中文时是 URL 编码过的，必须 fileURLToPath 还原。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PORT = Number(process.env.E2E_PORT || 8178)
const BASE = `http://127.0.0.1:${PORT}`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildClient() {
  if (process.env.SKIP_BUILD === "1") return
  const result = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" })
  if (result.status !== 0) throw new Error("前端打包失败，先解决 build 再跑 UI 回归")
}

async function startServer(dataDir) {
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", () => {})
  server.stderr.on("data", (chunk) => process.stderr.write(`[clinic-e2e] ${chunk}`))
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return server
    } catch {
      /* 还没起来，接着等 */
    }
    await sleep(250)
  }
  server.kill()
  throw new Error("临时服务没起来")
}

async function launchBrowser() {
  const direct = await chromium.launch({ headless: true }).catch(() => null)
  if (direct) return direct
  const candidates = [
    process.env.CHROME_PATH,
    ...fs
      .readdirSync(path.join(os.homedir(), ".cache", "ms-playwright"))
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse()
      .map((name) => path.join(os.homedir(), ".cache", "ms-playwright", name, "chrome-linux", "chrome")),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean)
  for (const executablePath of candidates) {
    if (!fs.existsSync(executablePath)) continue
    try {
      return await chromium.launch({ headless: true, executablePath })
    } catch {
      /* 这个起不来，试下一个 */
    }
  }
  throw new Error("找不到能用的 Chromium：装一份 Playwright 浏览器（npx playwright install chromium）或设 CHROME_PATH")
}

buildClient()
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-ui-e2e-"))
const server = await startServer(dataDir)
const browser = await launchBrowser()
let soloServer = null

async function context() {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  return { ctx, page }
}

async function evaluate(page, expression) {
  return page.evaluate(expression)
}

async function text(page) {
  return evaluate(page, "document.body ? document.body.innerText : ''")
}

async function waitText(page, includes, timeout = 8000) {
  const start = Date.now()
  let latest = ""
  while (Date.now() - start < timeout) {
    latest = await text(page)
    if (includes.every((part) => latest.includes(part))) return latest
    await sleep(150)
  }
  throw new Error(`等待超时，想看到 ${includes.join(" / ")}，页面是：\n${latest}`)
}

async function run(page, expression) {
  return evaluate(page, `(() => { ${expression} })()`)
}

async function fill(page, label, value) {
  await run(page, `
    const label = [...document.querySelectorAll("label")].find((node) => node.textContent.includes(${JSON.stringify(label)}))
    const input = label?.querySelector("input")
    if (!input) throw new Error("找不到字段 ${label}")
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
    set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event("input", { bubbles: true }))
  `)
}

async function clickButton(page, name) {
  const clicked = await run(page, `
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

async function shot(page, file) {
  await page.screenshot({ path: file })
}

async function waitReady(page) {
  const start = Date.now()
  let latest = ""
  while (Date.now() - start < 30000) {
    latest = await run(page, `return document.querySelector(".body-stage-view")?.dataset.ready || ""`)
    if (latest === "1") return
    await sleep(200)
  }
  const pageText = await text(page)
  throw new Error(`人体模型没有准备好：\n${pageText.slice(0, 400)}`)
}

async function tapBody(page, name, yaw, nudgeY = 0) {
  await run(page, `
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

try {
  const doctor = await context()
  await doctor.page.goto(`${BASE}/?device=1`, { waitUntil: "load" })
  await waitText(doctor.page, ["进入治疗室", "我的名字"])
  await fill(doctor.page, "我的名字", "之之")
  await clickButton(doctor.page, "进入治疗室")
  await waitText(doctor.page, ["今日单", "之之"])
  await shot(doctor.page, "/tmp/physio-today.png")
  console.log("1 建立名字：通过")

  const aide = await context()
  await aide.page.goto(`${BASE}/?device=2`, { waitUntil: "load" })
  // 单人名单：自动认领为「之之」，不问身份直接进今日单。
  await waitText(aide.page, ["今日单", "之之"])
  // 要当第二个名字：设置 → 我是谁 → 新名字。
  await clickButton(aide.page, "设置")
  await waitText(aide.page, ["我是谁"])
  await fill(aide.page, "新名字", "小李")
  await clickButton(aide.page, "加名字并切换")
  await waitText(aide.page, ["今日单", "小李"])
  console.log("1b 单人免选身份直接进；加第二个名字走设置：通过")

  await clickButton(doctor.page, "加入病人")
  await waitText(doctor.page, ["新病人"])
  await fill(doctor.page, "姓名", "王阿姨")
  await fill(doctor.page, "病症名称", "右膝疼痛")
  await clickButton(doctor.page, "开始点选")
  await waitText(doctor.page, ["王阿姨", "先点要治的地方"])
  await waitReady(doctor.page)
  // 模型就绪后布局还在稳定（画布尺寸、字体），等一等再按锚点投影点击。
  await sleep(800)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tapBody(doctor.page, "knee", 0)
    await sleep(300)
    // 膝盖点位点出来可能带左右（要治 右膝盖）：认「要治」+「膝盖」就行。
    const chiefOk = await run(
      doctor.page,
      `const text = document.body.innerText; return text.includes("要治") && text.includes("膝盖")`,
    )
    if (chiefOk) break
  }
  await clickButton(doctor.page, "背面")
  await sleep(400)
  // 承山标记球已外移缩小，点选时若穴位挡在肌肉正前方会认后面的肌肉；
  // 比目鱼肌从背后看被腓肠肌盖着，往脚踝方向让一让（比目鱼肌在远端露出）。
  for (const [name, nudgeY] of [["hamstring", 0], ["soleus", 26], ["plantar", 0], ["lumbar", 0]]) {
    await tapBody(doctor.page, name, Math.PI, nudgeY)
    await sleep(250)
  }
  await waitText(doctor.page, ["膝盖", "腘绳肌", "比目鱼肌", "足底", "腰"])
  const listOrder = await run(doctor.page, `return [...document.querySelectorAll(".patient-target")].map((node) => node.textContent).join(">")`)
  if (listOrder !== "右腘绳肌>右比目鱼肌>右足底>腰") throw new Error(`清单顺序不对：${listOrder}`)
  let labels = ""
  for (let attempt = 0; attempt < 20; attempt += 1) {
    labels = await run(doctor.page, `return [...document.querySelectorAll(".body-stage-label")].map((node) => node.textContent).filter(Boolean).sort().join(",")`)
    if (labels === "1,2,3,4") break
    await sleep(100)
  }
  if (labels !== "1,2,3,4") throw new Error(`人体序号不对：${labels}`)
  await shot(doctor.page, "/tmp/physio-body.png")
  console.log("3 点选顺序出现在清单和人体：通过")

  // 「全部派给」应在主操作栏（加项旁），不在「更多」里才找得到。
  const assignAllInActions = await run(doctor.page, `
    const actions = document.querySelector(".patient-actions")
    return Boolean(actions && [...actions.querySelectorAll("button")].some((b) => b.textContent.trim() === "全部派给"))
  `)
  if (!assignAllInActions) throw new Error("主操作栏没有「全部派给」")

  // 行内派工：点「未派」只弹出名单。
  const whoClicked = await run(doctor.page, `
    const who = document.querySelector(".patient-who")
    if (!who) return false
    who.click()
    return true
  `)
  if (!whoClicked) throw new Error("找不到行内派给按钮")
  await waitText(doctor.page, ["派给谁", "小李"])
  await clickButton(doctor.page, "小李")
  await waitText(doctor.page, ["小李"])
  console.log("3b 行内派工：通过")

  // 点已标记肌肉：弹出该部位上的组，而不是再加一项。
  await tapBody(doctor.page, "hamstring", Math.PI, 0)
  await sleep(400)
  await waitText(doctor.page, ["腘绳肌", "再加一项"])
  const groupOk = await run(doctor.page, `
    return Boolean(document.querySelector(".patient-body-item") && document.body.innerText.includes("再加一项"))
  `)
  if (!groupOk) throw new Error("点已标记肌肉没有出组")
  await clickButton(doctor.page, "收起")
  console.log("3c 点已标记肌肉出组：通过")

  await clickButton(doctor.page, "返回")
  await waitText(doctor.page, ["今日单", "王阿姨"])
  await clickButton(doctor.page, "王阿姨")
  await waitText(doctor.page, ["腘绳肌", "按摩", "沿肌纤维", "8 分钟"])
  await clickButton(doctor.page, "全部派给")
  await waitText(doctor.page, ["小李"])
  await clickButton(doctor.page, "小李")
  await waitText(doctor.page, ["小李"])
  await clickButton(doctor.page, "完成")
  await waitText(doctor.page, ["已完成"])
  const bodyTaps = await run(doctor.page, `return document.body.innerText.includes("先点要治的地方")`)
  if (bodyTaps) throw new Error("老病人仍要求先点人体")
  await clickButton(doctor.page, "返回")
  await waitText(doctor.page, ["今日单"])
  console.log("2 老病人一次派完并完成：通过")

  await aide.page.goto(`${BASE}/?device=2`, { waitUntil: "load" })
  await waitText(aide.page, ["今日单", "王阿姨"])
  await clickButton(aide.page, "王阿姨")
  await waitText(aide.page, ["腘绳肌", "比目鱼肌"])
  await run(aide.page, `
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
  await clickButton(aide.page, "返回")
  await waitText(aide.page, ["今天的改动要记回病症吗"])
  await clickButton(aide.page, "留在今天")
  await waitText(aide.page, ["今日单"])
  await clickButton(doctor.page, "王阿姨")
  await waitText(doctor.page, ["比目鱼肌", "腘绳肌"])
  const doctorOrder = await run(doctor.page, `return [...document.querySelectorAll(".patient-target")].map((node) => node.textContent).join(">")`)
  if (!doctorOrder.startsWith("右比目鱼肌>右腘绳肌")) throw new Error(`两台顺序不一致：${doctorOrder}`)
  const clinic = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json")))
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

  await clickButton(doctor.page, "返回")
  await waitText(doctor.page, ["今天的改动要记回病症吗"])
  await clickButton(doctor.page, "留在今天")
  await waitText(doctor.page, ["今日单"])
  await clickButton(doctor.page, "加入病人")
  await fill(doctor.page, "姓名", "李叔")
  await fill(doctor.page, "病症名称", "腰紧")
  await clickButton(doctor.page, "开始点选")
  await waitText(doctor.page, ["李叔", "加项"])
  console.log("6a 无项时主路径露出加项（面板里说一句自动聚焦）：通过")
  await clickButton(doctor.page, "返回")
  await waitText(doctor.page, ["今日单", "李叔"])
  await clickButton(doctor.page, "王阿姨")
  await waitText(doctor.page, ["比目鱼肌"])
  // 复制等次要操作收在「更多」里：先展开（等「档案」出现），再点「复制」。
  await clickButton(doctor.page, "更多")
  await waitText(doctor.page, ["档案"])
  await clickButton(doctor.page, "复制")
  await waitText(doctor.page, ["复制到"])
  await clickButton(doctor.page, "李叔")
  await clickButton(doctor.page, "复制")
  await waitText(doctor.page, ["已复制，派给谁要重新填"])
  await clickButton(doctor.page, "返回")
  await waitText(doctor.page, ["留在今天"])
  await clickButton(doctor.page, "留在今天")
  await waitText(doctor.page, ["今日单", "李叔"])
  await clickButton(doctor.page, "李叔")
  await waitText(doctor.page, ["李叔"])
  // 复制来的病症不在今天单上：「把…加入今天」的入口也收在「更多」里。
  await clickButton(doctor.page, "更多")
  await waitText(doctor.page, ["把「右膝疼痛」加入今天"])
  await clickButton(doctor.page, "把「右膝疼痛」加入今天")
  await waitText(doctor.page, ["腘绳肌", "未派"])
  console.log("6 复制后派给谁为空：通过")

  const broken = await context()
  await broken.ctx.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (String(type).includes("webgl")) return null
      return original.call(this, type, ...args)
    }
  })
  await broken.page.goto(`${BASE}/?device=3`, { waitUntil: "load" })
  await waitText(broken.page, ["今天你是谁"])
  await clickButton(broken.page, "之之")
  await waitText(broken.page, ["今日单"])
  await clickButton(broken.page, "李叔")
  await waitText(broken.page, ["模型没有加载出来", "腘绳肌"])
  await clickButton(broken.page, "完成")
  await waitText(broken.page, ["已完成", "模型没有加载出来"])
  console.log("7 模型失败时清单仍能完成：通过")

  // 8 单人治疗室免选身份：第二台手机打开不问「今天你是谁」，直接就是今日单。
  const soloDir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-ui-e2e-solo-"))
  const soloPort = PORT + 1
  soloServer = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: { ...process.env, DATA_DIR: soloDir, PORT: String(soloPort), HOST: "127.0.0.1" },
    stdio: "ignore",
  })
  const soloBase = `http://127.0.0.1:${soloPort}`
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${soloBase}/api/health`)).ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  const soloDoctor = await context()
  await soloDoctor.page.goto(`${soloBase}/?device=9`, { waitUntil: "load" })
  await waitText(soloDoctor.page, ["进入治疗室", "我的名字"])
  await fill(soloDoctor.page, "我的名字", "独立医生")
  await clickButton(soloDoctor.page, "进入治疗室")
  await waitText(soloDoctor.page, ["今日单", "独立医生"])
  const soloSecond = await context()
  await soloSecond.page.goto(`${soloBase}/?device=10`, { waitUntil: "load" })
  await waitText(soloSecond.page, ["今日单", "今天还没有病人"])
  const askedWho = await run(soloSecond.page, `return document.body.innerText.includes("今天你是谁")`)
  if (askedWho) throw new Error("单人治疗室还在问身份")
  console.log("8 单人治疗室免选身份，打开就是今日单：通过")

  console.log("UI_E2E_OK")
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(soloDir, { recursive: true, force: true })
} finally {
  await browser.close().catch(() => {})
  server.kill()
  soloServer?.kill()
}
