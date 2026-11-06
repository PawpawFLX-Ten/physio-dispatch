/* global localStorage */
// 真正启动 workerd/SQLite 与两台移动浏览器；只使用临时模拟数据，不访问 Cloudflare 账户。
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-cloudflare-e2e-"))
const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js")
let server
let exited
let browser
let logs = ""
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const socket = net.createServer()
  socket.listen(0, "127.0.0.1")
  await once(socket, "listening")
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

async function stop() {
  if (!server) return
  const child = server
  server = null
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000)
  try { await exited } finally { clearTimeout(timer) }
}

async function start(config, port, expectedStatus = 200) {
  const configFile = path.join(dir, "wrangler.json")
  fs.writeFileSync(configFile, JSON.stringify(config))
  server = spawn(process.execPath, [wrangler, "dev", "--config", configFile, "--ip", "127.0.0.1", "--port", String(port), "--persist-to", path.join(dir, "state"), "--log-level", "warn"], {
    cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"],
  })
  exited = once(server, "exit")
  const current = server
  current.stdout.on("data", (part) => { logs += part })
  current.stderr.on("data", (part) => { logs += part })
  for (let i = 0; i < 150; i += 1) {
    if (current.exitCode !== null) throw new Error(`本地 Workers 提前退出：${logs}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (response.status === expectedStatus) return
    } catch { /* 等待本地 workerd 就绪 */ }
    await pause(200)
  }
  throw new Error(`本地 Workers 启动超时：${logs}`)
}

try {
  const built = spawnSync(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--config", "client/vite.config.js", "--outDir", path.join(dir, "dist")], { cwd: root, stdio: "inherit" })
  if (built.status !== 0) throw new Error("云端专项前端构建失败")
  const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.json")))
  config.main = path.join(root, config.main)
  config.assets.directory = path.join(dir, "dist")
  config.routes = []
  delete config.env
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`

  await start(config, port, 503)
  for (const route of ["/", "/body/knee.glb", "/api/session?deviceId=doc"]) {
    const response = await fetch(`${base}${route}`, { headers: { "cf-access-authenticated-user-email": "spoof@example.test" } })
    if (response.status !== 503) throw new Error(`缺少 Access 配置却能访问 ${route}`)
  }
  await stop()
  console.log("1 生产默认拒绝访问，静态资源和 API 均不能绕过 Access：通过")

  config.vars = { CLINIC_ID: "cloudflare-integration-test", LOCAL_DEVELOPMENT: "true" }
  await start(config, port)
  async function api(route, body, deviceId = "doc", method = "POST") {
    const response = await fetch(`${base}${route}${method === "GET" ? `${route.includes("?") ? "&" : "?"}deviceId=${deviceId}` : ""}`, {
      method, headers: { "Content-Type": "application/json", Origin: base },
      body: method === "GET" ? undefined : JSON.stringify({ ...body, deviceId }), signal: AbortSignal.timeout(15000),
    })
    const data = await response.json()
    if (!response.ok) throw Object.assign(new Error(`${route}: ${JSON.stringify(data)}`), { status: response.status })
    return data
  }
  const doc = await api("/api/setup", { staffName: "云端主治" })
  const aide = await api("/api/claim", { staffName: "云端助手" }, "aide")
  if (doc.hosting !== "cloudflare" || aide.hosting !== "cloudflare") throw new Error("云端视图缺少 hosting 标记")
  const created = await api("/api/patients", { name: "云端模拟患者", conditionName: "左膝" })
  const entryId = created.entry.id
  const input = { patientId: created.entry.patientId, text: "左膝，股四头肌和腘绳肌各松解5分钟，交给云端助手", sequential: true }
  const preview = await api("/api/orders/preview", input)
  if (preview.draft.issues.length) throw new Error(JSON.stringify(preview.draft.issues))
  const order = await api("/api/orders/dispatch", { ...input, token: preview.token })
  const firstId = order.entry.items[0].id
  const secondId = order.entry.items[1].id
  await api(`/api/entries/${entryId}/items/${firstId}`, { patch: { position: "主治指定体位", instructions: "先核对患者及侧别，再按已培训的步骤执行。" } }, "doc", "PATCH")
  try {
    await api(`/api/entries/${entryId}/items/${secondId}`, { patch: { done: true } }, "aide", "PATCH")
    throw new Error("前一步未完成却允许完成下一步")
  } catch (error) { if (error.status !== 409) throw error }
  console.log("2 云端建档、口令预览派发、说明与顺序约束：通过")

  const socket = new WebSocket(base.replace(/^http/, "ws") + "/api/events")
  await once(socket, "open", { signal: AbortSignal.timeout(10000) })
  const pong = once(socket, "message", { signal: AbortSignal.timeout(10000) })
  socket.send("ping")
  if ((await pong)[0].data !== "pong") throw new Error("休眠心跳未自动响应")
  const message = once(socket, "message", { signal: AbortSignal.timeout(10000) })
  await api(`/api/entries/${entryId}/items/${firstId}`, { patch: { caution: "不确定时先问主治" } }, "doc", "PATCH")
  const event = JSON.parse((await message)[0].data)
  if (event.origin !== "doc" || event.by !== "云端主治") throw new Error("WebSocket 变更通知不对")
  socket.close()

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
  const errors = []
  let webSockets = 0
  async function phone(deviceId) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    await context.addInitScript((id) => localStorage.setItem("physio-device-id", id), deviceId)
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("websocket", () => { webSockets += 1 })
    await page.goto(base)
    await page.getByRole("heading", { name: "今日单", exact: true }).waitFor()
    return page
  }
  const doctorPage = await phone("doc")
  const aidePage = await phone("aide")
  await aidePage.getByRole("tab", { name: /我的任务/ }).click()
  const card = aidePage.locator(`.execution-card[data-item="${firstId}"]`)
  await card.getByText("主治指定体位", { exact: false }).waitFor()
  await card.getByRole("button", { name: "完成并下一步", exact: true }).click()
  await card.waitFor({ state: "detached" })
  await doctorPage.locator(".today-row").filter({ hasText: "云端模拟患者" }).getByText("1/2", { exact: true }).waitFor()
  if (webSockets < 2) throw new Error("浏览器没有使用云端 WebSocket")
  await doctorPage.getByRole("button", { name: "设置", exact: true }).click()
  await doctorPage.getByText("Cloudflare 云端备份", { exact: true }).waitFor()
  await doctorPage.getByRole("button", { name: "查看云端备份", exact: true }).click()
  await doctorPage.getByRole("button", { name: "恢复这份", exact: true }).first().waitFor()
  await doctorPage.screenshot({ path: path.join(dir, "cloud-backups.png"), fullPage: true })
  if (errors.length) throw new Error(errors.join("\n"))
  await browser.close()
  browser = null
  console.log("3 可休眠 WebSocket、双手机实时同步、云端备份界面：通过")

  const exported = await api("/api/data/export", undefined, "doc", "GET")
  await stop()
  await start(config, port)
  const reopened = await api(`/api/entries/${entryId}`, undefined, "doc", "GET")
  if (!reopened.entry.items[0].done || reopened.entry.items[1].canExecute !== true || reopened.entry.items[0].instructions !== "先核对患者及侧别，再按已培训的步骤执行。") throw new Error("重启后数据或顺序状态丢失")
  const exportedAgain = await api("/api/data/export", undefined, "doc", "GET")
  if (JSON.stringify(exported.days) !== JSON.stringify(exportedAgain.days)) throw new Error("重启前后派工数据不一致")
  const backups = await api("/api/cloud/backups", undefined, "doc", "GET")
  const beforePatient = backups.backups.find((backup) => backup.kind === "day")
  if (!beforePatient) throw new Error("缺少首日备份")
  const backupData = await api(`/api/cloud/backups/${encodeURIComponent(beforePatient.id)}`, undefined, "doc", "GET")
  await api(`/api/cloud/backups/${encodeURIComponent(beforePatient.id)}/restore`, { expectedSequence: backups.sequence })
  const restored = await api("/api/session", undefined, "doc", "GET")
  if (restored.patients.length !== backupData.patients.length) throw new Error("恢复后的患者数量与所选备份不一致")
  console.log("4 workerd 重启后持久化保留、完整导出、恢复备份：通过")
  console.log(`CLOUDFLARE_E2E_OK（本地临时截图：${dir}）`)
} finally {
  await browser?.close()
  await stop()
  fs.rmSync(path.join(dir, "state"), { recursive: true, force: true })
  fs.rmSync(path.join(dir, "dist"), { recursive: true, force: true })
}
