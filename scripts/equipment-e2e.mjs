/* global document, window, PointerEvent, localStorage, HTMLInputElement, Event */
// 设备专项浏览器回归：临时数据 + 独立构建目录 + 独立端口，不碰真实 data/。
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PORT = Number(process.env.EQUIPMENT_E2E_PORT || 8180)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function buildClient() {
  if (process.env.SKIP_BUILD === "1") return
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "client/vite.config.js", "--outDir", "dist-e2e"],
    { cwd: root, stdio: "inherit" },
  )
  if (result.status !== 0) throw new Error("前端打包失败")
}

async function startServer(dataDir) {
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DIST_DIR: path.join(root, "client", "dist-e2e"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  })
  server.stderr.on("data", (chunk) => process.stderr.write(`[equipment-e2e] ${chunk}`))
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return server
    } catch {
      /* 服务还没起来 */
    }
    await sleep(150)
  }
  server.kill()
  throw new Error("设备专项临时服务没起来")
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
      .flatMap((name) => [
        path.join(os.homedir(), ".cache", "ms-playwright", name, "chrome-linux", "chrome"),
        path.join(os.homedir(), ".cache", "ms-playwright", name, "chrome-linux64", "chrome"),
      ]),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter(Boolean)
  for (const executablePath of candidates) {
    if (!fs.existsSync(executablePath)) continue
    try {
      return await chromium.launch({ headless: true, executablePath })
    } catch {
      /* 继续尝试下一个 */
    }
  }
  throw new Error("找不到可用 Chromium，可设置 CHROME_PATH")
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clinic-equipment-e2e-"))
let server = null
let browser = null

const bodyText = (page) => page.evaluate(() => document.body.innerText)
async function waitText(page, parts, timeout = 15000) {
  const start = Date.now()
  let latest = ""
  while (Date.now() - start < timeout) {
    latest = await bodyText(page)
    if (parts.every((part) => latest.includes(part))) return latest
    await sleep(150)
  }
  throw new Error(`等待超时：${parts.join(" / ")}\n${latest.slice(0, 1600)}`)
}
async function waitGone(page, part, timeout = 12000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (!(await bodyText(page)).includes(part)) return
    await sleep(150)
  }
  throw new Error(`仍然可见：${part}`)
}
async function waitClinic(predicate, label, timeout = 12000) {
  const start = Date.now()
  let latest = null
  while (Date.now() - start < timeout) {
    try {
      latest = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json"), "utf8"))
      if (predicate(latest)) return latest
    } catch {
      /* 正在原子替换文件时可能短暂读不到 */
    }
    await sleep(150)
  }
  throw new Error(`等待落库超时：${label}`)
}

async function clickButton(page, name) {
  const clicked = await page.evaluate((label) => {
    const buttons = [...document.querySelectorAll("button")]
    const exact = buttons.find((node) => node.textContent.trim().replace(/\s+/g, " ") === label)
    const row = buttons.find((node) => node.classList.contains("row-btn") && node.textContent.replace(/\s+/g, "").includes(label))
    const button = exact || row
    if (!button) return false
    button.click()
    return true
  }, name)
  if (!clicked) throw new Error(`找不到按钮：${name}`)
}
async function tapBody(page, name, yaw = 0) {
  await page.evaluate(({ targetName, yawValue }) => {
    const view = document.querySelector(".body-stage-view")
    const canvas = view?.querySelector("canvas")
    if (!view || !canvas || view.dataset.ready !== "1") throw new Error("人体没准备好")
    const picks = JSON.parse(view.dataset.picks)
    const camera = JSON.parse(view.dataset.camera)
    const target = picks[targetName]
    if (!target) throw new Error(`没有可点位置：${targetName}`)
    const cos = Math.cos(yawValue)
    const sin = Math.sin(yawValue)
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
    const clientY = rect.top + ((1 - ndcY) / 2) * rect.height
    view.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX, clientY, pointerId: 1, button: 0 }))
    view.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX, clientY, pointerId: 1, button: 0 }))
  }, { targetName: name, yawValue: yaw })
}

async function tapPlanRow(page, includes) {
  const tapped = await page.evaluate((needleText) => {
    const row = [...document.querySelectorAll(".patient-row")].find((node) => node.textContent.includes(needleText))
    const main = row?.querySelector(".patient-row-main")
    if (!main) return false
    const rect = main.getBoundingClientRect()
    const point = { clientX: rect.left + 20, clientY: rect.top + 20, pointerId: 71, button: 0 }
    main.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, ...point }))
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, ...point }))
    return true
  }, includes)
  if (!tapped) throw new Error(`找不到治疗行：${includes}`)
}

try {
  buildClient()
  server = await startServer(dataDir)
  browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } })
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto(`${BASE}/?device=equipment-e2e`, { waitUntil: "load" })
  await sleep(350)
  const deviceId = await page.evaluate(() => localStorage.getItem("physio-device-id:equipment-e2e"))
  const post = async (pathName, body, requestDeviceId = deviceId) => {
    const response = await fetch(`${BASE}${pathName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: requestDeviceId, ...body }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`${pathName}: ${data.error || response.status}`)
    return data
  }

  await post("/api/setup", { staffName: "之之" })
  await post("/api/claim", { deviceId: "equipment-e2e-aide", staffName: "小李" })
  const patient = await post("/api/patients", { name: "设备测试阿姨", conditionName: "右膝痛" })
  await post(`/api/entries/${patient.entry.id}/chief`, { targetId: "knee", side: "right" })

  await page.reload({ waitUntil: "load" })
  await waitText(page, ["今日单", "设备测试阿姨"])
  await clickButton(page, "设备测试阿姨")
  await waitText(page, ["要治 右膝盖"])
  for (let i = 0; i < 200; i += 1) {
    if (await page.evaluate(() => document.querySelector(".body-stage-view")?.dataset.ready === "1")) break
    await sleep(150)
  }
  await sleep(300)

  // 设备模式点主诉区域本身：应该打开设备选择器，而不是进入“重选主诉”。
  await clickButton(page, "设备")
  await tapBody(page, "knee")
  await waitText(page, ["选择设备或动作", "冲击波"])
  await clickButton(page, "冲击波")
  await waitGone(page, "选择设备或动作")
  await waitText(page, ["冲击波 1 号机", "脉冲次数 2000 次"])
  console.log("1 设备模式主诉区域添加冲击波：通过")

  // 动作模板：一个设备动作关联多个人体目标。
  await tapBody(page, "quad", Math.PI)
  await waitText(page, ["选择设备或动作", "弹力带终末伸膝"])
  await clickButton(page, "弹力带终末伸膝")
  await waitGone(page, "选择设备或动作")
  await waitText(page, ["弹力带终末伸膝", "3 组 × 10 次"])
  console.log("2 动作模板一次入库并关联人体：通过")

  // 一句话同时带设备、参数和员工。
  await clickButton(page, "加项")
  await page.waitForSelector(".patient-quick-input", { state: "visible" })
  await page.evaluate(() => {
    const input = document.querySelector(".patient-quick-input")
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
    set.call(input, "冈下肌超声波8分钟派给小李")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await waitText(page, ["派给 小李", "超声", "时长 8 分钟"])
  await clickButton(page, "加 1 项")
  await waitText(page, ["超声 1 号机", "小李"])
  console.log("3 一句话带设备和员工：通过")

  // 参数编辑：打开超声任务，改强度并保存；再切到 2 号机。
  await clickButton(page, "收起")
  await tapPlanRow(page, "超声 1 号机")
  await waitText(page, ["设备", "参数", "机台", "超声 1 号机"])
  const changed = await page.evaluate(() => {
    const field = [...document.querySelectorAll(".patient-equipment-field")].find((node) => node.textContent.includes("强度"))
    const input = field?.querySelector("input")
    if (!input) return false
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
    set.call(input, "1.5")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  })
  if (!changed) throw new Error("找不到超声强度输入框")
  await page.getByRole("button", { name: "保存参数", exact: true }).click()
  await waitClinic(
    (data) => Object.values(data.days)
      .flatMap((day) => day.entries)
      .flatMap((entry) => entry.items)
      .some((item) => item.equipmentTypeId === "ultrasound" && item.parameters?.intensity === 1.5),
    "超声强度 1.5",
  )
  await page.getByRole("button", { name: "超声 2 号机", exact: true }).click()
  await waitClinic(
    (data) => Object.values(data.days)
      .flatMap((day) => day.entries)
      .flatMap((entry) => entry.items)
      .some((item) => item.equipmentTypeId === "ultrasound" && item.equipmentUnitId === "ultrasound-2"),
    "切换超声 2 号机",
  )
  console.log("4 设备参数编辑与机台切换：通过")

  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json"), "utf8"))
  const entry = Object.values(saved.days).flatMap((day) => day.entries).find((row) => row.id === patient.entry.id)
  const equipmentItems = entry.items.filter((item) => item.equipmentTypeId)
  const shockwave = equipmentItems.find((item) => item.equipmentTypeId === "shockwave")
  const band = equipmentItems.find((item) => item.exerciseTemplateId === "band-terminal-knee-extension")
  const ultrasound = equipmentItems.find((item) => item.equipmentTypeId === "ultrasound")
  if (!shockwave || shockwave.equipmentUnitId !== "shockwave-1") throw new Error("冲击波未落库或未指定机台")
  if (!band || !band.linkedTargets?.length) throw new Error("弹力带模板未保留关联目标")
  if (!ultrasound || !ultrasound.assigneeId) throw new Error("超声未保留派工")
  if (ultrasound.parameters.minutes !== 8) throw new Error("超声时长参数未落库")
  if ([shockwave, band, ultrasound].some((item) => item.side !== "left" && item.side !== "right")) {
    throw new Error("设备任务出现空侧")
  }
  console.log("5 设备、机台、参数、关联目标、派工、侧别落库：通过")

  // 原位更换：把当前超声任务换成冲击波，位置/派工不变，不能让用户删了重加。
  await page.getByRole("button", { name: "更换设备或动作", exact: true }).click()
  await waitText(page, ["更换设备或动作", "原位替换"])
  await page.locator(".patient-equipment-type").filter({ hasText: "冲击波" }).click()
  await waitGone(page, "更换设备或动作")
  await waitClinic(
    (data) => Object.values(data.days)
      .flatMap((day) => day.entries)
      .flatMap((entry) => entry.items)
      .some((item) => item.targetId === "infraspinatus" && item.equipmentTypeId === "shockwave" && !item.startedAt),
    "超声原位换冲击波",
  )
  const replaced = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json"), "utf8"))
  const replacedEntry = Object.values(replaced.days).flatMap((day) => day.entries).find((row) => row.id === patient.entry.id)
  const originalTargets = entry.items.map((item) => item.targetId)
  const replacedTargets = replacedEntry.items.map((item) => item.targetId)
  if (JSON.stringify(originalTargets) !== JSON.stringify(replacedTargets)) throw new Error("原位替换改变了任务顺序")
  console.log("6 设备类型原位替换、顺序与派工保持：通过")

  await clickButton(page, "返回")
  const afterBack = await bodyText(page)
  if (afterBack.includes("今天的改动要记回病症吗")) await clickButton(page, "留在今天")
  await waitText(page, ["今日单"])
  await clickButton(page, "按设备")
  await waitText(page, ["冲击波", "超声 1 号机", "超声 2 号机", "弹力带", "空闲"])
  await waitText(page, ["当前：", "设备测试阿姨"])
  console.log("7 今日单按设备视图展示软占用/空闲状态：通过")

  // 今日单全局吩咐：选今天已有病人，一句话再派 1 项。
  const beforeCommand = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json"), "utf8"))
  const beforeItemCount = Object.values(beforeCommand.days).flatMap((day) => day.entries).find((row) => row.id === patient.entry.id).items.length
  await clickButton(page, "吩咐")
  await waitText(page, ["先选患者", "设备测试阿姨"])
  await page.locator(".today-command-patient").filter({ hasText: "设备测试阿姨" }).click()
  await waitText(page, ["换病人"])
  await page.waitForSelector(".today-command-input", { state: "visible" })
  await page.getByRole("textbox", { name: "输入吩咐" }).fill("冈上肌按摩5分钟派给小李")
  // 本段专测设备互斥，独立于步骤顺序；顺序依赖另有工作流专项测试。
  await page.getByRole("checkbox", { name: /按顺序执行/ }).uncheck()
  await clickButton(page, "预览安排")
  await waitText(page, ["执行：小李", "冈上肌", "按摩"])
  await clickButton(page, "确认派发")
  await waitText(page, ["已吩咐"])
  const afterCommand = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json"), "utf8"))
  const afterEntry = Object.values(afterCommand.days).flatMap((day) => day.entries).find((row) => row.id === patient.entry.id)
  if (afterEntry.items.length !== beforeItemCount + 1) throw new Error("全局吩咐没有新增一项")
  const commanded = afterEntry.items.at(-1)
  if (!commanded.assigneeId || commanded.targetId !== "supraspinatus" || commanded.technique !== "massage") {
    throw new Error(`全局吩咐落库不对：${JSON.stringify(commanded)}`)
  }
  console.log("8 今日单全局吩咐入口：通过")

  // 为真实设备锁补两项同机台超声任务，均派给当前医生。
  const staffRows = afterCommand.staff || []
  const doctor = staffRows.find((person) => person.name === "之之")
  if (!doctor) throw new Error("找不到当前医生")
  await post(`/api/entries/${patient.entry.id}/items`, {
    targetId: "gastroc",
    side: "left",
    equipmentTypeId: "ultrasound",
    equipmentUnitId: "ultrasound-2",
    assigneeId: doctor.id,
  })
  await post(`/api/entries/${patient.entry.id}/items`, {
    targetId: "soleus",
    side: "left",
    equipmentTypeId: "ultrasound",
    equipmentUnitId: "ultrasound-2",
    assigneeId: doctor.id,
  })
  await page.reload({ waitUntil: "load" })
  await waitText(page, ["今日单", "我的任务"])
  await page.locator(".today-tab").filter({ hasText: "我的任务" }).click()
  await waitText(page, ["我的任务", "开始设备", "左腓肠肌", "左比目鱼肌"])
  await page.waitForFunction(() => /^\(\d+\) 治疗室派工$/.test(document.title))
  const firstDeviceRow = page.locator(".today-my-wrap").filter({ hasText: "左腓肠肌" })
  const secondDeviceRow = page.locator(".today-my-wrap").filter({ hasText: "左比目鱼肌" })
  await firstDeviceRow.getByRole("button", { name: "开始设备", exact: true }).click()
  await waitText(page, ["使用中"])
  await waitText(page, ["等设备", "正在被", "请先结束"])
  if (!(await secondDeviceRow.getByRole("button", { name: "开始设备", exact: true }).isDisabled())) throw new Error("等待设备时不应允许开始")
  await firstDeviceRow.getByRole("button", { name: "结束设备", exact: true }).click()
  await waitText(page, ["现在可以做"])
  await secondDeviceRow.getByRole("button", { name: "开始设备", exact: true }).click()
  await waitText(page, ["使用中"])
  await secondDeviceRow.getByRole("button", { name: "完成并下一步", exact: true }).click()
  await secondDeviceRow.waitFor({ state: "detached" })
  console.log("9 我的任务队列与设备真实开始/冲突/结束/完成释放：通过")

  // 将医生的未完成项跨病人整批移交给小李；设备占用必须保持直到显式结束。
  const shockwaveRow = page.locator(".today-my-wrap").filter({ hasText: "冲击波" }).first()
  await shockwaveRow.getByRole("button", { name: "开始设备", exact: true }).click()
  await waitText(page, ["使用中"])
  const beforeHandoff = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json"), "utf8"))
  const startedBeforeHandoff = Object.values(beforeHandoff.days)
    .flatMap((day) => day.entries)
    .flatMap((entry) => entry.items)
    .find((item) => item.equipmentTypeId === "shockwave" && item.startedAt)
  if (!startedBeforeHandoff) throw new Error("移交前冲击波没有建立使用锁")
  await page.locator(".today-tab").filter({ hasText: "按人" }).click()
  await waitText(page, ["按人", "移交"])
  const doctorGroup = page.locator(".today-group").filter({ hasText: "之之" })
  await doctorGroup.getByRole("button", { name: /移交 \d+ 项/ }).click()
  await waitText(page, ["移交任务", "小李"])
  await page.locator(".today-handoff-person").filter({ hasText: "小李" }).click()
  await waitText(page, ["已移交"])
  const afterHandoff = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json"), "utf8"))
  const afterEntryForHandoff = Object.values(afterHandoff.days).flatMap((day) => day.entries).find((row) => row.id === patient.entry.id)
  const doctorAfter = afterHandoff.staff.find((person) => person.name === "之之")
  const aide = afterHandoff.staff.find((person) => person.name === "小李")
  const stillDoctorOpen = afterEntryForHandoff.items.filter((item) => !item.done && item.assigneeId === doctorAfter.id)
  if (stillDoctorOpen.length) throw new Error(`移交后仍有医生未完成项 ${stillDoctorOpen.length}`)
  if (!afterEntryForHandoff.items.some((item) => !item.done && item.assigneeId === aide.id)) throw new Error("移交后目标员工没有未完成项")
  const transferred = afterEntryForHandoff.items.find((item) => item.id === startedBeforeHandoff.id)
  if (transferred.startedAt !== startedBeforeHandoff.startedAt || transferred.startedBy !== startedBeforeHandoff.startedBy) throw new Error("交接误释放或重置了设备占用")
  await page.waitForFunction(() => document.title === "治疗室派工")
  console.log("10 跨病人一键移交并保留设备真实占用：通过")

  // 全局吩咐：不在今天的档案也应可先加入今天再吩咐。
  const newPatient = await post("/api/patients", { name: "未加入阿姨", conditionName: "左肩痛" })
  await post(`/api/entries/${newPatient.entry.id}/drop`, {})
  await page.reload({ waitUntil: "load" })
  await waitText(page, ["今日单", "吩咐"])
  await clickButton(page, "吩咐")
  await waitText(page, ["未加入今天", "未加入阿姨"])
  await page.locator(".today-command-patient").filter({ hasText: "未加入阿姨" }).click()
  await waitText(page, ["换病人"])
  await page.waitForSelector(".today-command-input", { state: "visible" })
  await page.getByRole("textbox", { name: "输入吩咐" }).fill("左肩冈上肌按摩5分钟派给小李")
  await clickButton(page, "预览安排")
  await waitText(page, ["执行：小李", "冈上肌", "按摩"])
  const beforeConfirm = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json"), "utf8"))
  if (Object.values(beforeConfirm.days).flatMap((day) => day.entries).some((entry) => entry.patientId === newPatient.entry.patientId)) throw new Error("预览不应加入今日单")
  await clickButton(page, "确认派发")
  await waitText(page, ["已加入今日并吩咐 1 项"])
  const newPatientAfter = JSON.parse(fs.readFileSync(path.join(dataDir, "clinic.json"), "utf8"))
  const newEntryAfter = Object.values(newPatientAfter.days)
    .flatMap((day) => day.entries)
    .find((row) => row.patientId === newPatient.entry.patientId)
  if (!newEntryAfter || newEntryAfter.chiefSiteId !== "shoulder" || newEntryAfter.chiefSide !== "left") {
    throw new Error("新加入病人的主诉/侧别不对")
  }
  const newItem = newEntryAfter.items.find((item) => item.targetId === "supraspinatus" && item.technique === "massage")
  if (!newItem || !newItem.assigneeId) throw new Error("新加入病人的吩咐没有落库")
  console.log("11 未加入今天的病人一键加入并吩咐：通过")

  await clickButton(page, "设置")
  await waitText(page, ["任务提醒"])
  const notificationText = await bodyText(page)
  if (
    !notificationText.includes("开启任务提醒") &&
    !notificationText.includes("已开启") &&
    !notificationText.includes("浏览器已拒绝通知") &&
    !notificationText.includes("HTTP 打开")
  ) {
    throw new Error("任务提醒区没有可识别的状态")
  }
  await page.keyboard.press("Escape")
  await waitGone(page, "任务提醒")
  console.log("12 PWA 角标与本机通知入口：通过")

  if (pageErrors.length) throw new Error(`页面异常：${pageErrors.join(" | ")}`)
  console.log("EQUIPMENT_E2E_OK")
} finally {
  await browser?.close().catch(() => {})
  server?.kill()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
