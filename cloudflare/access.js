import { createRemoteJWKSet, jwtVerify } from "jose"

const keySets = new Map()

export function isLocalDevelopment(request, env) {
  return env.LOCAL_DEVELOPMENT === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)
}

export async function verifyAccess(request, env, keyResolver) {
  if (isLocalDevelopment(request, env)) return { email: "local-development@localhost", sub: "local-development" }
  const team = String(env.ACCESS_TEAM_DOMAIN || "").replace(/^https:\/\//, "").replace(/\/$/, "")
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team) || !env.ACCESS_AUD) {
    throw Object.assign(new Error("站点尚未配置 Cloudflare Access，暂不开放"), { status: 503 })
  }
  const token = request.headers.get("cf-access-jwt-assertion")
  if (!token) throw Object.assign(new Error("请先通过 Cloudflare Access 登录"), { status: 401 })
  const issuer = `https://${team}`
  if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)))
  try {
    const { payload } = await jwtVerify(token, keyResolver || keySets.get(issuer), {
      issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"], requiredClaims: ["exp", "sub", "email"],
    })
    if (typeof payload.email !== "string" || !payload.email.includes("@")) throw new Error("missing email")
    return payload
  } catch {
    throw Object.assign(new Error("登录验证已失效，请刷新页面重新登录"), { status: 401 })
  }
}
