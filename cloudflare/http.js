export const API_BODY_LIMIT = 64 * 1024
export const CLOUD_DATA_LIMIT = 8 * 1024 * 1024
export const CLOUD_IMPORT_LIMIT = CLOUD_DATA_LIMIT + 64 * 1024

export function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers,
  } })
}

export function errorResponse(error) {
  if (!error.status) console.error("[cloudflare-clinic]", error)
  return jsonResponse({ error: error.status ? error.message : "服务器暂时无法保存，请稍后重试" }, error.status || 500)
}

export async function readJsonBody(request, limit = API_BODY_LIMIT) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) {
    throw Object.assign(new Error("请求需要 JSON 格式"), { status: 415 })
  }
  const declared = Number(request.headers.get("content-length"))
  if (declared > limit) throw Object.assign(new Error("请求太大，超出云端上限"), { status: 413 })
  const reader = request.body?.getReader()
  let size = 0
  const chunks = []
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) {
          await reader.cancel()
          throw Object.assign(new Error("请求太大，超出云端上限"), { status: 413 })
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object")
    return value
  } catch {
    throw Object.assign(new Error("发过去的数据不是有效的 JSON 对象"), { status: 400 })
  }
}

export function checkOrigin(request) {
  if (["GET", "HEAD"].includes(request.method) && request.headers.get("upgrade")?.toLowerCase() !== "websocket") return
  const origin = request.headers.get("origin")
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw Object.assign(new Error("不允许跨站修改派工单"), { status: 403 })
  }
}
