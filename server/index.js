import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import express from "express"
import compression from "compression"
import { fileURLToPath } from "node:url"
import { ClinicStore, todayKey } from "./store.js"
import { changeEvent } from "../shared/events.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
// DATA_DIR 给测试用：指向一次性目录，别碰真实档案。
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data")
const store = new ClinicStore(
  path.join(dataDir, "clinic.json"),
  path.join(dataDir, "audit.log"),
)
store.load()

const app = express()
// 普通请求体都是几百字节：全局收紧到 64KB，免得没认过身份的设备一坨大 JSON 把单线程冻住。
// 导入恢复是唯一的例外，走自己的路由：先过身份再按 128MB 解析（见 /api/data/import）。
app.use(express.json({ limit: "64kb", type: (req) => req.path !== "/api/data/import" }))
// 明文 HTTP 下 gzip：首访的 JS/CSS 少传约七成。SSE 绝不能压（会缓冲住实时推送）。
app.use(
  compression({
    filter(req, res) {
      if (req.path === "/api/events") return false
      return compression.filter(req, res)
    },
  }),
)

let currentOrigin = null

function asyncRoute(handler) {
  return (req, res) => {
    // handler 同步执行，save() 触发的 SSE 广播能在这里读到这次是谁改的。
    currentOrigin = String(req.body?.deviceId || req.query?.deviceId || "")
    try {
      const body = handler(req)
      res.json(body)
    } catch (error) {
      if (error.status) {
        res.status(error.status).json({ error: error.message || "未能保存" })
      } else {
        // 意外异常不带状态码：细节只进日志，不给手机看内部信息。
        console.error("[clinic]", error)
        res.status(500).json({ error: "服务器出了点问题，稍后再试" })
      }
    } finally {
      currentOrigin = null
    }
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true }))
app.get("/api/session", asyncRoute((req) => store.view(String(req.query.deviceId || ""))))
app.post("/api/setup", asyncRoute((req) => store.setup(req.body)))
app.post("/api/claim", asyncRoute((req) => store.claim(req.body)))
// 导入要先认身份再解析大请求体：身份在 query 里（此时 body 还没解，解析也拿不到）。
app.post(
  "/api/data/import",
  (req, res, next) => {
    try {
      store.requireStaff(String(req.query?.deviceId || ""))
      next()
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message || "先在名单里认个名字" })
      console.error("[clinic]", error)
      return res.status(500).json({ error: "服务器出了点问题，稍后再试" })
    }
  },
  // 只给导入留够（每天 20 单 × 7 项约 20-35MB/年）。
  express.json({ limit: "128mb" }),
  asyncRoute((req) => store.importData(req.body)),
)
app.post("/api/patients", asyncRoute((req) => store.createPatient(req.body)))
app.post("/api/patients/from-template", asyncRoute((req) => store.createPatientFromTemplate(req.body)))
app.post("/api/patients/:id/note", asyncRoute((req) => store.setPatientNote({ ...req.body, patientId: req.params.id })))
app.post("/api/patients/:id/rename", asyncRoute((req) => store.renamePatient({ ...req.body, patientId: req.params.id })))
app.post("/api/patients/:id/archive", asyncRoute((req) => store.setPatientArchived({ ...req.body, patientId: req.params.id })))
app.delete(
  "/api/patients/:id/conditions/:conditionId",
  asyncRoute((req) =>
    store.deleteCondition({
      // DELETE 的 body 个别代理会剥掉：deviceId 也认 query 里的。
      deviceId: req.body?.deviceId || req.query?.deviceId,
      patientId: req.params.id,
      conditionId: req.params.conditionId,
    }),
  ),
)
app.post("/api/templates", asyncRoute((req) => store.saveTemplateFromEntry(req.body)))
app.post("/api/pairings", asyncRoute((req) => store.savePairings(req.body)))
app.delete(
  "/api/templates/:id",
  asyncRoute((req) => store.deleteTemplate({ deviceId: req.body?.deviceId || req.query?.deviceId, templateId: req.params.id })),
)
app.post("/api/today/entries", asyncRoute((req) => store.addExisting(req.body)))
app.post("/api/today/entries/repeat-last", asyncRoute((req) => store.repeatLastDay(req.body)))
app.post("/api/today/entries/carry-unfinished", asyncRoute((req) => store.carryUnfinished(req.body)))
app.post("/api/today/reassign-open", asyncRoute((req) => store.reassignOpen(req.body)))
app.get("/api/entries/:id", asyncRoute((req) => store.entryView(req.query.deviceId, req.params.id)))
app.post("/api/entries/:id/conditions", asyncRoute((req) => store.addCondition({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/chief", asyncRoute((req) => store.setChief({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/items", asyncRoute((req) => store.addItem({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/items/restore", asyncRoute((req) => store.restoreItem({ ...req.body, entryId: req.params.id })))
app.patch("/api/entries/:id/items/:itemId", asyncRoute((req) => store.patchItem({ ...req.body, entryId: req.params.id, itemId: req.params.itemId })))
app.delete("/api/entries/:id/items/:itemId", asyncRoute((req) => store.removeItem({ deviceId: req.body?.deviceId || req.query?.deviceId, entryId: req.params.id, itemId: req.params.itemId })))
app.post("/api/entries/:id/reorder", asyncRoute((req) => store.reorder({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/assign-all", asyncRoute((req) => store.assignAll({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/include", asyncRoute((req) => store.includeCondition({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/leave", asyncRoute((req) => store.leave({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/focus", asyncRoute((req) => store.setFocus({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/drop", asyncRoute((req) => store.dropEntry({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/apply-template", asyncRoute((req) => store.applyTemplateToEntry({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/quick-add", asyncRoute((req) => store.quickAdd({ ...req.body, entryId: req.params.id })))
app.post("/api/conditions/:id/copy", asyncRoute((req) => store.copyCondition({ ...req.body, conditionId: req.params.id })))

// SSE：数据一变就推给各台手机，不用再靠下拉刷新。
const sseClients = new Set()

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  })
  res.flushHeaders()
  res.write("retry: 3000\n\n")
  sseClients.add(res)
  req.on("close", () => sseClients.delete(res))
})

setInterval(() => {
  for (const res of sseClients) {
    if (res.destroyed || res.writableEnded) {
      sseClients.delete(res)
      continue
    }
    try {
      res.write(":hb\n\n")
    } catch {
      sseClients.delete(res)
    }
  }
}, 25_000).unref()

let sseSeq = 0
store.subscribe(() => {
  sseSeq += 1
  // origin 是改数据那台手机的 deviceId：自己的改动自己已经拿到返回值，不用再拉；
  // by 带上那个人的名字，别的手机能被动看到「谁刚动过」。
  const whoId = store.device(currentOrigin)
  const by = store.state.staff.find((person) => person.id === whoId)?.name || ""
  const payload = `data: ${JSON.stringify(changeEvent(sseSeq, currentOrigin, by))}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
})

app.get("/api/data/export", (req, res) => {
  // 和 asyncRoute 一样标好这次是谁在动数据：导出也会落盘（记 lastExportAt），
  // 触发的 SSE 广播得带上 origin，免得导出者自己也被白拉一遍。
  currentOrigin = String(req.query.deviceId || "")
  try {
    const data = store.exportData(currentOrigin)
    res.setHeader("Content-Disposition", `attachment; filename="clinic-${todayKey()}.json"`)
    res.json(data)
  } catch (error) {
    if (error.status) {
      res.status(error.status).json({ error: error.message || "导不出" })
    } else {
      console.error("[clinic]", error)
      res.status(500).json({ error: "导不出，稍后再试" })
    }
  } finally {
    currentOrigin = null
  }
})

// DIST_DIR 给 e2e 用：打包到独立目录再起临时服务，测试永远不碰线上 dist。
const dist = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(root, "client", "dist")
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(
    express.static(dist, {
      setHeaders(res, filePath) {
        const rel = path.relative(dist, filePath)
        if (/^(?:body|icons|assets)[\\/]/.test(rel)) {
          // 模型和图标换版本时文件名/参数会变，可以放心长缓存
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
        } else if (/(?:^|[\\/])sw\.js$/.test(rel) || /(?:^|[\\/])index\.html$/.test(rel) || /(?:^|[\\/])manifest\.webmanifest$/.test(rel)) {
          res.setHeader("Cache-Control", "no-cache")
        }
      },
    }),
  )
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next()
    res.setHeader("Cache-Control", "no-cache")
    res.sendFile(path.join(dist, "index.html"))
  })
}

// body-parser 的错误默认回一张 HTML 页，手机上只能看到笼统的「未能保存」：
// 超限（导入的文件太大）和坏 JSON 各给一句能看懂的话。
app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") {
    const message = error.limit === "128mb" ? "文件太大，超出能导入的上限（128MB）" : "发过去的内容太大"
    return res.status(413).json({ error: message })
  }
  if (error?.type === "entity.parse.failed" || error?.status === 400) {
    return res.status(400).json({ error: "发过去的数据不是有效的 JSON" })
  }
  console.error("[clinic]", error)
  res.status(500).json({ error: "服务器出了点问题，稍后再试" })
})

function lanAddresses() {
  const found = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) found.push(item.address)
    }
  }
  return found
}

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || "0.0.0.0"

function onListen() {
  const scheme = this instanceof https.Server ? "https" : "http"
  const locals = ["127.0.0.1", ...lanAddresses()]
  for (const ip of locals) console.log(`clinic api ${scheme}://${ip}:${port}`)
}

let server
if (process.env.TLS_KEY && process.env.TLS_CERT) {
  server = https.createServer(
    {
      key: fs.readFileSync(process.env.TLS_KEY),
      cert: fs.readFileSync(process.env.TLS_CERT),
    },
    app,
  )
} else {
  server = http.createServer(app)
}
server.listen(port, host, onListen)
