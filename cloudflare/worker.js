import { DurableObject } from "cloudflare:workers"
import { verifyAccess } from "./access.js"
import { checkOrigin, CLOUD_IMPORT_LIMIT, errorResponse, jsonResponse, readJsonBody } from "./http.js"
import { DurableClinicStore } from "./storage.js"
import { matchRoute } from "./routes.js"
import { socketAuthorized } from "./sockets.js"
import { changeEvent } from "../shared/events.js"
import { fail, todayKey } from "../server/helpers.js"

export class ClinicRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.store = new DurableClinicStore(ctx.storage)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/events") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return jsonResponse({ error: "云端实时同步请使用 WebSocket" }, 426)
      const expiresAt = Number(request.headers.get("x-clinic-access-expires"))
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return jsonResponse({ error: "请重新登录" }, 401)
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      pair[1].serializeAttachment({ expiresAt })
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    try {
      const route = matchRoute(request.method, url.pathname)
      if (!route) return jsonResponse({ error: "找不到这个接口" }, 404)
      let body = {}
      const importing = url.pathname === "/api/data/import"
      if (importing) this.store.requireStaff(url.searchParams.get("deviceId") || "")
      if (!["GET", "HEAD"].includes(request.method)) body = await readJsonBody(request, importing ? CLOUD_IMPORT_LIMIT : undefined)
      // 路径参数不可被 body 覆盖；导入身份也固定从 query 读取，先验身份再读大请求体。
      const input = { ...body, ...route.params, deviceId: importing ? url.searchParams.get("deviceId") || "" : body.deviceId || url.searchParams.get("deviceId") || "" }
      if (url.pathname !== "/api/health" && (typeof input.deviceId !== "string" || !input.deviceId || input.deviceId.length > 200)) fail(400, "设备标识不对")
      const exporting = url.pathname === "/api/data/export"
      const result = this.store.run(() => route.handle(this.store, input), {
        mutating: request.method !== "GET" || exporting,
        email: request.headers.get("x-clinic-verified-email") || "", deviceId: input.deviceId,
      })
      if (result.changed) {
        const payload = JSON.stringify(changeEvent(result.sequence, input.deviceId, result.by))
        for (const socket of this.ctx.getWebSockets()) {
          try {
            if (!socketAuthorized(socket)) { socket.close(4001, "Access session expired; sign in again"); continue }
            socket.send(payload)
          } catch { try { socket.close(1011, "reconnect") } catch { /* 已断开 */ } }
        }
      }
      return new Response(result.body, { headers: {
        "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        ...(exporting ? { "Content-Disposition": `attachment; filename="clinic-${todayKey()}.json"` } : {}),
      } })
    } catch (error) { return errorResponse(error) }
  }

  webSocketMessage(socket, message) {
    // 正常 ping/pong 由平台自动响应，不唤醒对象；其它输入不当作业务命令。
    if (message !== "ping") socket.close(1008, "Use the authenticated HTTP API")
  }

  webSocketClose(socket, code) { socket.close(code === 1006 ? 1000 : code) }
  webSocketError(socket) { socket.close(1011, "reconnect") }
}

export default {
  async fetch(request, env) {
    try {
      const identity = await verifyAccess(request, env)
      checkOrigin(request)
      const url = new URL(request.url)
      if (url.pathname.startsWith("/api/")) {
        const id = env.CLINIC.idFromName(env.CLINIC_ID)
        const headers = new Headers(request.headers)
        headers.set("x-clinic-verified-email", identity.email)
        headers.set("x-clinic-access-expires", String(identity.exp ? identity.exp * 1000 : Date.now() + 60 * 60 * 1000))
        return await env.CLINIC.get(id).fetch(new Request(request, { headers }))
      }
      if (!["GET", "HEAD"].includes(request.method)) return jsonResponse({ error: "不支持这个请求" }, 405)
      const asset = await env.ASSETS.fetch(request)
      const headers = new Headers(asset.headers)
      // 静态资源也先验 Access；仅允许浏览器私有缓存，不能被公共缓存绕过访问保护。
      headers.set("Cache-Control", /^\/(assets|body|icons)\//.test(url.pathname) ? "private, max-age=31536000, immutable" : "private, no-cache")
      headers.set("X-Content-Type-Options", "nosniff")
      headers.set("X-Frame-Options", "DENY")
      headers.set("Referrer-Policy", "no-referrer")
      return new Response(asset.body, { status: asset.status, headers })
    } catch (error) { return errorResponse(error) }
  },
}
