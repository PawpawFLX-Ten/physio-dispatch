import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import express from "express"
import { fileURLToPath } from "node:url"
import { ClinicStore, todayKey } from "./store.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
// DATA_DIR 给测试用：指向一次性目录，别碰真实档案。
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data")
const store = new ClinicStore(
  path.join(dataDir, "clinic.json"),
  path.join(dataDir, "audit.log"),
)
store.load()

const app = express()
app.use(express.json({ limit: "12mb" }))

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
app.post("/api/data/import", asyncRoute((req) => store.importData(req.body)))
app.post("/api/patients", asyncRoute((req) => store.createPatient(req.body)))
app.post("/api/patients/from-template", asyncRoute((req) => store.createPatientFromTemplate(req.body)))
app.post("/api/patients/:id/note", asyncRoute((req) => store.setPatientNote({ ...req.body, patientId: req.params.id })))
app.post("/api/patients/:id/rename", asyncRoute((req) => store.renamePatient({ ...req.body, patientId: req.params.id })))
app.post("/api/patients/:id/archive", asyncRoute((req) => store.setPatientArchived({ ...req.body, patientId: req.params.id })))
app.delete(
  "/api/patients/:id/conditions/:conditionId",
  asyncRoute((req) =>
    store.deleteCondition({
      deviceId: req.body.deviceId,
      patientId: req.params.id,
      conditionId: req.params.conditionId,
    }),
  ),
)
app.post("/api/templates", asyncRoute((req) => store.saveTemplateFromEntry(req.body)))
app.delete("/api/templates/:id", asyncRoute((req) => store.deleteTemplate({ deviceId: req.body.deviceId, templateId: req.params.id })))
app.post("/api/today/entries", asyncRoute((req) => store.addExisting(req.body)))
app.post("/api/today/entries/repeat-last", asyncRoute((req) => store.repeatLastDay(req.body)))
app.get("/api/entries/:id", asyncRoute((req) => store.entryView(req.query.deviceId, req.params.id)))
app.post("/api/entries/:id/conditions", asyncRoute((req) => store.addCondition({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/chief", asyncRoute((req) => store.setChief({ ...req.body, entryId: req.params.id })))
app.post("/api/entries/:id/items", asyncRoute((req) => store.addItem({ ...req.body, entryId: req.params.id })))
app.patch("/api/entries/:id/items/:itemId", asyncRoute((req) => store.patchItem({ ...req.body, entryId: req.params.id, itemId: req.params.itemId })))
app.delete("/api/entries/:id/items/:itemId", asyncRoute((req) => store.removeItem({ deviceId: req.body.deviceId, entryId: req.params.id, itemId: req.params.itemId })))
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
  // origin 是改数据那台手机的 deviceId：自己的改动自己已经拿到返回值，不用再拉。
  const payload = `data: ${JSON.stringify({ n: sseSeq, origin: currentOrigin })}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
})

app.get("/api/data/export", (req, res) => {
  try {
    const data = store.exportData(String(req.query.deviceId || ""))
    res.setHeader("Content-Disposition", `attachment; filename="clinic-${todayKey()}.json"`)
    res.json(data)
  } catch (error) {
    if (error.status) {
      res.status(error.status).json({ error: error.message || "导不出" })
    } else {
      console.error("[clinic]", error)
      res.status(500).json({ error: "导不出，稍后再试" })
    }
  }
})

const dist = path.join(root, "client", "dist")
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(
    express.static(dist, {
      setHeaders(res, filePath) {
        const rel = path.relative(dist, filePath)
        if (/^(?:body|draco|icons|assets)[\\/]/.test(rel)) {
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
