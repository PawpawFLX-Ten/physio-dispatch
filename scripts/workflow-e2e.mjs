/* global localStorage, document, window */
// 工作流专项：独立临时构建和模拟数据，双手机、窄屏、预览与执行闭环。
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { ClinicStore, todayKey } from "../server/store.js"
import { parseQuickOrder } from "../shared/quick-order.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-workflow-e2e-"))
const dataDir = path.join(dir, "data")
const dist = path.join(dir, "dist")
let browser
let server
let stopped

try {
  const build = spawnSync(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--config", "client/vite.config.js", "--outDir", dist], { cwd: root, stdio: "inherit" })
  if (build.status !== 0) throw new Error("专项构建失败")
  const store = new ClinicStore(path.join(dataDir, "clinic.json"))
  store.load()
  store.setup({ deviceId: "doc", staffName: "主治" })
  const aide = store.claim({ deviceId: "aide", staffName: "小李" }).me
  const previous = store.createPatient({ deviceId: "doc", name: "复用测试患者", conditionName: "左膝" }).entry
  store.quickAdd({ deviceId: "doc", entryId: previous.id, ...parseQuickOrder("左膝，股四头肌松解8分钟，然后腘绳肌松解8分钟，然后比目鱼肌牵伸5分钟") })
  const firstId = store.entryById(previous.id).items[0].id
  store.patchItem({ deviceId: "doc", entryId: previous.id, itemId: firstId, patch: { position: "主治指定体位", instructions: "核对患者及左侧，再按主治示范操作。", caution: "不确定时先联系主治" } })
  store.configureWorkflow({ deviceId: "doc", entryId: previous.id, sequential: true })
  store.leave({ deviceId: "doc", entryId: previous.id, updateCondition: true })
  store.saveTemplateFromEntry({ deviceId: "doc", entryId: previous.id, name: "复用方案", shortName: "A方案" })
  store.state.days["2020-01-01"] = { entries: [structuredClone(store.entryById(previous.id))] }
  store.state.days[todayKey()].entries = []
  const waiting = store.createPatient({ deviceId: "doc", name: "顺序测试患者", conditionName: "左膝" }).entry
  store.quickAdd({ deviceId: "doc", entryId: waiting.id, ...parseQuickOrder("左膝，股四头肌按摩8分钟，然后腘绳肌松解5分钟") })
  const waitingItems = store.entryById(waiting.id).items
  store.patchItem({ deviceId: "doc", entryId: waiting.id, itemId: waitingItems[1].id, patch: { assigneeId: aide.id } })
  store.configureWorkflow({ deviceId: "doc", entryId: waiting.id, sequential: true, bedLabel: "3号床" })
  const templated = store.createPatient({ deviceId: "doc", name: "模板测试患者", conditionName: "右膝" }).entry
  store.dropEntry({ deviceId: "doc", entryId: templated.id })
  store.save()

  const reservation = net.createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, DIST_DIR: dist, HOST: "127.0.0.1", PORT: String(port), TLS_KEY: "", TLS_CERT: "", BACKUP_MIRROR_DIR: "" },
    stdio: ["ignore", "pipe", "inherit"],
  })
  stopped = once(server, "exit")
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("临时服务启动超时")), 15000)
    server.stdout.on("data", () => { clearTimeout(timer); resolve() })
    server.once("error", (error) => { clearTimeout(timer); reject(error) })
    server.once("exit", () => { clearTimeout(timer); reject(new Error("临时服务提前退出")) })
  })
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
  const errors = []
  async function phone(deviceId) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light" })
    await context.addInitScript((id) => localStorage.setItem("physio-device-id", id), deviceId)
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(base)
    await page.getByRole("heading", { name: "今日单", exact: true }).waitFor()
    return page
  }
  async function request(route, body = {}, method = "POST") {
    const response = await fetch(`${base}${route}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, deviceId: "doc" }) })
    const data = await response.json()
    if (!response.ok) throw new Error(JSON.stringify(data))
    return data
  }
  const clinic = () => JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json")))
  const todays = () => clinic().days[todayKey()].entries
  async function command(page, name, text) {
    await page.getByRole("button", { name: "吩咐", exact: true }).click()
    await page.locator(".today-command-patient").filter({ hasText: name }).click()
    await page.getByRole("textbox", { name: "输入吩咐" }).fill(text)
    await page.getByRole("button", { name: "预览安排", exact: true }).click()
    await page.getByRole("button", { name: "确认派发", exact: true }).waitFor()
  }
  const doc = await phone("doc")
  const text = "照上次，第二项改成五分钟，最后一项今天不做，交给小李"
  await command(doc, "复用测试患者", text)
  if (todays().some((entry) => entry.patientId === previous.patientId)) throw new Error("预览写入了今日单")
  await doc.getByRole("button", { name: "收起", exact: true }).click()
  if (todays().some((entry) => entry.patientId === previous.patientId)) throw new Error("取消草稿写入了今日单")
  await command(doc, "复用测试患者", text)
  await doc.getByRole("button", { name: "确认派发", exact: true }).click()
  await doc.locator(".today-command-sheet").waitFor({ state: "detached" })
  const dispatched = todays().find((entry) => entry.patientId === previous.patientId)
  if (dispatched.items.length !== 2 || dispatched.items[1].dose.minutes !== 5) throw new Error("复用与改动落库不对")
  console.log("1 草稿只读、取消无副作用、照旧加改动一次派发：通过")

  const aidePage = await phone("aide")
  await aidePage.getByRole("tab", { name: /我的任务/ }).click()
  const first = aidePage.locator(`.execution-card[data-item="${dispatched.items[0].id}"]`)
  await first.getByText("主治指定体位", { exact: false }).waitFor()
  const blocked = aidePage.locator(`.execution-card[data-item="${waitingItems[1].id}"]`)
  if (!(await blocked.getByRole("button", { name: "完成并下一步", exact: true }).isDisabled())) throw new Error("跨人前序未完成却可执行")
  await first.getByRole("button", { name: "完成并下一步", exact: true }).click()
  await first.waitFor({ state: "detached" })
  await request(`/api/entries/${waiting.id}/items/${waitingItems[0].id}`, { patch: { done: true } }, "PATCH")
  await aidePage.waitForFunction((id) => {
    const card = document.querySelector(`.execution-card[data-item="${id}"]`)
    return card && [...card.querySelectorAll("button")].some((button) => button.textContent === "完成并下一步" && !button.disabled)
  }, waitingItems[1].id)
  console.log("2 新人卡完整说明、跨人等待、完成后自动推进：通过")

  await blocked.getByRole("button", { name: "遇到问题", exact: true }).click()
  await blocked.getByRole("textbox").fill("请主治再确认体位")
  await blocked.getByRole("button", { name: "反馈并暂停此项", exact: true }).click()
  await blocked.getByText("需主治处理：请主治再确认体位", { exact: false }).waitFor()
  await doc.locator(".today-row").filter({ hasText: "顺序测试患者" }).click()
  await doc.locator(`[data-item="${waitingItems[1].id}"] .patient-row-copy`).click()
  await doc.getByRole("button", { name: "已处理，恢复执行", exact: true }).click()
  await doc.getByRole("button", { name: "已处理，恢复执行", exact: true }).waitFor({ state: "detached" })
  console.log("3 问题反馈暂停、主治处理恢复：通过")
  await doc.getByRole("button", { name: "收起", exact: true }).click()
  await doc.getByRole("button", { name: "返回", exact: true }).click()
  if (await doc.getByRole("button", { name: "留在今天", exact: true }).isVisible()) await doc.getByRole("button", { name: "留在今天", exact: true }).click()
  await doc.getByRole("heading", { name: "今日单", exact: true }).waitFor()

  await doc.getByRole("button", { name: "吩咐", exact: true }).click()
  await doc.locator(".today-command-patient").filter({ hasText: "模板测试患者" }).click()
  await doc.getByRole("button", { name: "A方案", exact: true }).click()
  await doc.getByLabel("整套侧别").selectOption("right")
  await doc.getByRole("button", { name: "预览安排", exact: true }).click()
  await doc.locator(".command-draft-items").getByText("右股四头肌", { exact: true }).waitFor()
  await doc.screenshot({ path: path.join(dir, "template-preview.png"), fullPage: true })
  await doc.getByRole("button", { name: "确认派发", exact: true }).click()
  await doc.locator(".today-command-sheet").waitFor({ state: "detached" })
  const templateEntry = todays().find((entry) => entry.patientId === templated.patientId)
  if (templateEntry.items.some((item) => item.side !== "right")) throw new Error("整套换侧失败")
  if (clinic().patients.find((patient) => patient.id === templated.patientId).conditions.length !== 1) throw new Error("套方案新增了病症")
  console.log("4 方案简称、整套换侧、操作说明继承且不增加诊断：通过")

  await command(doc, "复用测试患者", "腘绳肌超声脉冲模式8分钟")
  if (!(await doc.getByRole("button", { name: "确认派发", exact: true }).isDisabled())) throw new Error("未知参数竟可派发")
  await doc.getByRole("button", { name: "收起", exact: true }).click()
  await aidePage.screenshot({ path: path.join(dir, "execution-light.png"), fullPage: true })
  await aidePage.emulateMedia({ colorScheme: "dark" })
  await aidePage.screenshot({ path: path.join(dir, "execution-dark.png"), fullPage: true })
  const overflow = await aidePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  if (overflow) throw new Error("390px 手机横向溢出")
  const buttonHeight = await aidePage.locator(".execution-actions button").first().evaluate((button) => button.getBoundingClientRect().height)
  if (buttonHeight < 44 || buttonHeight > 80) throw new Error(`执行按钮高度不适合手机：${buttonHeight}`)
  if (errors.length) throw new Error(errors.join("\n"))
  console.log("5 歧义阻断、390px 浅深色、无页面异常：通过")
  console.log(`WORKFLOW_E2E_OK（临时截图：${dir}）`)
} finally {
  await browser?.close()
  if (server) {
    server.kill()
    await stopped
  }
  // 截图留在临时目录便于检查；患者数据和构建产物无需保留。
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(dist, { recursive: true, force: true })
}
