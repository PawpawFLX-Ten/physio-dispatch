import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { generateKeyPair, SignJWT } from "jose"
import { ClinicCore } from "../server/core.js"
import { todayKey } from "../server/helpers.js"
import { DurableClinicStore, encodeRecords, decodeRecords, splitSnapshot } from "../cloudflare/storage.js"
import { verifyAccess } from "../cloudflare/access.js"
import { checkOrigin, readJsonBody } from "../cloudflare/http.js"
import { matchRoute } from "../cloudflare/routes.js"
import { socketAuthorized } from "../cloudflare/sockets.js"
import { authMode, authenticateRequest, loginWithPasscode, logoutResponse, passcodePage, SESSION_COOKIE } from "../cloudflare/auth.js"

function storage(t) {
  const db = new DatabaseSync(":memory:")
  t.after(() => db.close())
  return {
    sql: { exec(query, ...bindings) {
      if (query.includes("CREATE TABLE")) { db.exec(query); return { toArray: () => [] } }
      const rows = db.prepare(query).all(...bindings).map((row) => ({ ...row }))
      return { toArray: () => rows }
    } },
    transactionSync(callback) {
      db.exec("BEGIN")
      try { const value = callback(); db.exec("COMMIT"); return value }
      catch (error) { db.exec("ROLLBACK"); throw error }
    },
  }
}

function room(t) {
  const disk = storage(t)
  const store = new DurableClinicStore(disk)
  const run = (handler, mutating = true) => JSON.parse(store.run(handler, { mutating, email: "doctor@example.test", deviceId: "doc" }).body)
  run(() => store.setup({ deviceId: "doc", staffName: "主治" }))
  return { store, disk, run }
}

test("云端记录拆分持久化、重建对象恢复数据与幂等令牌", (t) => {
  const { store, disk, run } = room(t)
  const patient = run(() => store.createPatient({ deviceId: "doc", name: "云端模拟患者", conditionName: "左膝" }))
  const input = { deviceId: "doc", patientId: patient.entry.patientId, text: "左膝，股四头肌和腘绳肌各松解5分钟", sequential: true }
  const preview = run(() => store.previewOrder(input), false)
  run(() => store.dispatchOrder({ ...input, token: preview.token }))
  const revived = new DurableClinicStore(disk)
  assert.equal(revived.state.patients[0].name, "云端模拟患者")
  assert.equal(revived.state.days[todayKey()].entries[0].items.length, 2)
  const again = revived.run(() => revived.dispatchOrder({ ...input, token: preview.token }), { mutating: true })
  assert.equal(again.changed, false)
  assert.equal(JSON.parse(again.body).hosting, "cloudflare")
})

test("业务异常、SQL 异常都回滚内存和 SQLite，不提前广播成功", (t) => {
  const { store, disk, run } = room(t)
  const before = JSON.stringify(store.state)
  const sequence = store.sequence
  assert.throws(() => run(() => { store.state.staff[0].name = "不应保存"; store.save(); throw new Error("模拟业务失败") }), /业务失败/)
  assert.equal(JSON.stringify(store.state), before)
  const exec = disk.sql.exec
  disk.sql.exec = (query, ...args) => {
    if (query.startsWith("INSERT INTO records")) throw new Error("模拟 SQL 失败")
    return exec(query, ...args)
  }
  assert.throws(() => run(() => store.claim({ deviceId: "other", staffName: "不应加入" })), /SQL 失败/)
  disk.sql.exec = exec
  assert.equal(JSON.stringify(store.state), before)
  assert.equal(store.sequence, sequence)
  assert.equal(new DurableClinicStore(disk).state.staff.length, 1)
})

test("自动备份可下载恢复；恢复前发生其他改动会冲突；审计记录 Access 身份", (t) => {
  const { store, run } = room(t)
  run(() => store.createPatient({ deviceId: "doc", name: "会被恢复移除", conditionName: "左膝" }))
  const listing = store.listBackups("doc")
  assert.ok(listing.backups.length >= 2)
  assert.equal(store.readBackup("doc", listing.backups[0].id).patients.length, 0)
  const stale = store.sequence
  run(() => store.claim({ deviceId: "aide", staffName: "助手" }))
  assert.throws(() => run(() => store.restoreBackup({ deviceId: "doc", backupId: listing.backups[0].id, expectedSequence: stale })), /刷新列表/)
  run(() => store.restoreBackup({ deviceId: "doc", backupId: listing.backups[0].id, expectedSequence: store.sequence }))
  assert.equal(store.state.patients.length, 0)
  assert.equal(store.listAudit("doc").audit[0].email, "doctor@example.test")
})

test("云端 8MB、单行 1MB、重复 ID 保护；快照分块不损坏中文和 emoji", () => {
  const core = new ClinicCore()
  core.state.patients.push({ id: "patient", name: "测试", conditions: [] })
  assert.equal(decodeRecords(encodeRecords(core.state)).patients[0].name, "测试")
  core.state.patients.push({ id: "patient", name: "重复", conditions: [] })
  assert.throws(() => encodeRecords(core.state), /重复 ID/)
  core.state.patients = [{ id: "large", note: "a".repeat(1024 * 1024) }]
  assert.throws(() => encodeRecords(core.state), /1MB/)
  core.state.patients = [{ id: "large", note: "a".repeat(8 * 1024 * 1024) }]
  assert.throws(() => encodeRecords(core.state), /8MB/)
  const text = JSON.stringify({ note: "中文😀".repeat(10000) })
  assert.equal(splitSnapshot(text, 31).map((chunk) => new TextDecoder().decode(new TextEncoder().encode(chunk))).join(""), text)
})

test("Access 缺配置/伪造身份/错误签名、过期、错误 AUD 均拒绝；开发豁免仅限回环地址", async () => {
  const env = { ACCESS_TEAM_DOMAIN: "clinic.cloudflareaccess.com", ACCESS_AUD: "clinic-audience" }
  await assert.rejects(verifyAccess(new Request("https://physio.pawpawmaster.com/"), {}), { status: 503 })
  await assert.rejects(verifyAccess(new Request("https://physio.pawpawmaster.com/", { headers: { "cf-access-authenticated-user-email": "spoof@example.test" } }), env), { status: 401 })
  assert.equal((await verifyAccess(new Request("http://127.0.0.1/"), { LOCAL_DEVELOPMENT: "true" })).sub, "local-development")
  await assert.rejects(verifyAccess(new Request("https://physio.pawpawmaster.com/"), { LOCAL_DEVELOPMENT: "true" }), { status: 503 })
  const { privateKey, publicKey } = await generateKeyPair("RS256")
  const sign = (audience = env.ACCESS_AUD, expiry = "1h") => new SignJWT({ email: "doctor@example.test" }).setProtectedHeader({ alg: "RS256" }).setSubject("user").setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`).setAudience(audience).setExpirationTime(expiry).sign(privateKey)
  const req = (token) => new Request("https://physio.pawpawmaster.com/", { headers: { "cf-access-jwt-assertion": token } })
  assert.equal((await verifyAccess(req(await sign()), env, publicKey)).email, "doctor@example.test")
  await assert.rejects(verifyAccess(req(await sign("wrong-audience")), env, publicKey), { status: 401 })
  await assert.rejects(verifyAccess(req(await sign(env.ACCESS_AUD, "-1h")), env, publicKey), { status: 401 })
  const wrong = await generateKeyPair("RS256")
  await assert.rejects(verifyAccess(req(await sign()), env, wrong.publicKey), { status: 401 })
})

test("大请求流式限长、JSON 格式约束、跨站写入和跨站 WebSocket 拦截", async () => {
  const request = (body, headers = {}) => new Request("https://physio.pawpawmaster.com/api/setup", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body })
  assert.deepEqual(await readJsonBody(request('{"a":1}')), { a: 1 })
  await assert.rejects(readJsonBody(request("[]")), { status: 400 })
  await assert.rejects(readJsonBody(request("broken")), { status: 400 })
  await assert.rejects(readJsonBody(request("a".repeat(100)), 10), { status: 413 })
  await assert.rejects(readJsonBody(request("{}", { "Content-Type": "text/plain" })), { status: 415 })
  assert.throws(() => checkOrigin(request("{}", { Origin: "https://evil.example" })), { status: 403 })
  assert.throws(() => checkOrigin(new Request("https://physio.pawpawmaster.com/api/events", { headers: { Upgrade: "websocket", Origin: "https://evil.example" } })), { status: 403 })
  assert.doesNotThrow(() => checkOrigin(request("{}", { Origin: "https://physio.pawpawmaster.com" })))
})

test("云端路由参数正确解码，未知方法/接口不落到前端 SPA", () => {
  assert.deepEqual(matchRoute("POST", "/api/cloud/backups/minute%3A2026-11-07/restore").params, { backupId: "minute:2026-11-07" })
  assert.equal(matchRoute("POST", "/api/unknown"), null)
  assert.equal(matchRoute("DELETE", "/api/health"), null)
})

test("休眠的 WebSocket 不能在 Access 令牌过期后继续接收业务通知", () => {
  assert.equal(socketAuthorized({ deserializeAttachment: () => ({ expiresAt: 2000 }) }, 1000), true)
  assert.equal(socketAuthorized({ deserializeAttachment: () => ({ expiresAt: 1000 }) }, 1000), false)
  assert.equal(socketAuthorized({ deserializeAttachment: () => null }, 1000), false)
  const socket = { deserializeAttachment: () => ({ expiresAt: 2000, mode: "public-demo", generation: "public-demo-v1" }) }
  assert.equal(socketAuthorized(socket, 1000, { mode: "passcode", generation: "private" }), false)
  assert.equal(socketAuthorized(socket, 1000, { mode: "public-demo", generation: "public-demo-v1" }), true)
})

test("只有显式确认的公开演示可以无登录，缺省及拼错模式仍拒绝匿名访问", async () => {
  const request = new Request("https://physio.pawpawmaster.com/")
  assert.equal(authMode({}), "access")
  assert.throws(() => authMode({ AUTH_MODE: "publc" }), { status: 503 })
  await assert.rejects(authenticateRequest(request, { AUTH_MODE: "public-demo" }), { status: 503 })
  const identity = await authenticateRequest(request, { AUTH_MODE: "public-demo", PUBLIC_DEMO_ACK: "fictional-data-only" })
  assert.equal(identity.mode, "public-demo")
  assert.equal(identity.email, "")
  await assert.rejects(authenticateRequest(request, { AUTH_MODE: "access" }), { status: 503 })
  await assert.rejects(authenticateRequest(request, { AUTH_MODE: "passcode" }), { status: 503 })
})

test("治疗室口令登录使用安全 Cookie、7 天会话，改口令后旧会话失效", async () => {
  const env = { AUTH_MODE: "passcode", CLINIC_ID: "test-clinic", CLINIC_PASSCODE: "test-only-example-passcode-16-characters" }
  const request = new Request("https://physio.pawpawmaster.com/")
  const login = (value) => new Request("https://physio.pawpawmaster.com/_clinic/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: value }) })
  await assert.rejects(authenticateRequest(request, env), { status: 401 })
  await assert.rejects(loginWithPasscode(login("wrong"), env, async () => true), { status: 401 })
  await assert.rejects(loginWithPasscode(login(env.CLINIC_PASSCODE), env, async () => false), { status: 429 })
  const response = await loginWithPasscode(login(env.CLINIC_PASSCODE), env, async () => true)
  const cookie = response.headers.get("set-cookie")
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict; Max-Age=604800/)
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`))
  const signed = new Request(request, { headers: { Cookie: cookie.split(";")[0] } })
  assert.equal((await authenticateRequest(signed, env)).mode, "passcode")
  await assert.rejects(authenticateRequest(signed, { ...env, CLINIC_PASSCODE: "another-test-only-example-passcode" }), { status: 401 })
  assert.match(logoutResponse().headers.get("set-cookie"), /Max-Age=0/)
  assert.equal(passcodePage(env).headers.get("cache-control"), "no-store")
})

test("口令防猜次数存在 SQLite，重启不重置，十分钟窗口结束后恢复", (t) => {
  const { store, disk } = room(t)
  const now = 1000000
  for (let count = 0; count < 10; count += 1) assert.equal(store.allowLoginAttempt("test-ip", now), true)
  assert.equal(store.allowLoginAttempt("test-ip", now), false)
  assert.equal(new DurableClinicStore(disk).allowLoginAttempt("test-ip", now), false)
  assert.equal(store.allowLoginAttempt("test-ip", now + 10 * 60 * 1000), true)
})
