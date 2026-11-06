import { SignJWT, jwtVerify } from "jose"
import { verifyAccess } from "./access.js"
import { readJsonBody, jsonResponse } from "./http.js"

export const SESSION_COOKIE = "__Host-physio-session"
export const SESSION_SECONDS = 7 * 24 * 60 * 60
const encoder = new TextEncoder()
const authError = (message, status) => Object.assign(new Error(message), { status })

export function authMode(env) {
  const mode = env.AUTH_MODE || "access"
  if (!["access", "passcode", "public-demo"].includes(mode)) throw authError("站点登录模式配置不正确", 503)
  if (mode === "public-demo" && env.PUBLIC_DEMO_ACK !== "fictional-data-only") throw authError("公开演示模式尚未明确确认仅使用虚构数据", 503)
  return mode
}

function passcode(env) {
  if (typeof env.CLINIC_PASSCODE !== "string" || env.CLINIC_PASSCODE.length < 16 || env.CLINIC_PASSCODE.length > 256) throw authError("请先设置 16～256 字符的治疗室口令 Secret，再启用口令登录", 503)
  return env.CLINIC_PASSCODE
}

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))
}

async function sessionKey(env) {
  return digest(`physio/session/v1\0${env.CLINIC_ID}\0${passcode(env)}`)
}

export async function authenticateRequest(request, env) {
  const mode = authMode(env)
  if (mode === "public-demo") return { sub: "public-demo", email: "", mode, generation: "public-demo-v1", exp: Math.floor(Date.now() / 1000) + 3600 }
  if (mode === "access") return { ...await verifyAccess(request, env), mode, generation: `${env.ACCESS_TEAM_DOMAIN || ""}:${env.ACCESS_AUD || ""}` }
  const key = await sessionKey(env)
  const token = (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1)
  if (!token) throw authError("请输入治疗室共用口令", 401)
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer: "physio-clinic", audience: env.CLINIC_ID, requiredClaims: ["exp", "sub"] })
    if (payload.sub !== "clinic-passcode") throw new Error("wrong session type")
    const generation = Array.from(await digest(`physio/socket-generation/v1\0${passcode(env)}`), (byte) => byte.toString(16).padStart(2, "0")).join("")
    return { ...payload, mode, generation, email: "" }
  } catch { throw authError("治疗室登录已过期，请重新输入口令", 401) }
}

export async function loginWithPasscode(request, env, allowAttempt) {
  const expected = passcode(env)
  const input = await readJsonBody(request, 2048)
  if (typeof input.passcode !== "string" || input.passcode.length > 256) throw authError("口令格式不正确", 400)
  if (!await allowAttempt()) throw authError("尝试次数太多，请十分钟后再试", 429)
  const [actualHash, expectedHash] = await Promise.all([digest(input.passcode), digest(expected)])
  let difference = 0
  for (let at = 0; at < actualHash.length; at += 1) difference |= actualHash[at] ^ expectedHash[at]
  if (difference) throw authError("治疗室口令不正确", 401)
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("physio-clinic").setAudience(env.CLINIC_ID).setSubject("clinic-passcode").setIssuedAt().setExpirationTime(`${SESSION_SECONDS}s`).sign(await sessionKey(env))
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}` })
}

export function logoutResponse() {
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` })
}

export function passcodePage(env) {
  passcode(env)
  const nonce = crypto.randomUUID()
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>治疗室派工 · 口令登录</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;padding:32px 20px;background:#f6f1e7;color:#1c1915;font:18px/1.5 system-ui,sans-serif}main{max-width:400px;margin:12vh auto}input,button{width:100%;min-height:52px;padding:12px;font:inherit;border:1px solid #e4dccb;border-radius:12px}button{margin-top:16px;background:#0f5f5c;color:#fff}p{font-size:15px}#error{color:#8d3418}</style></head><body><main><h1>治疗室派工</h1><p>输入治疗室共用口令。这台手机可记住登录 7 天，不需要邮箱。</p><form id="login"><label>治疗室口令<input id="passcode" type="password" autocomplete="current-password" required maxlength="256" autofocus></label><button type="submit">进入治疗室</button><p id="error" role="alert"></p></form></main><script nonce="${nonce}">const form=document.getElementById('login');form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const response=await fetch('/_clinic/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passcode:document.getElementById('passcode').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'未能登录');location.replace('/')}catch(error){document.getElementById('error').textContent=error.message}finally{button.disabled=false}});</script></body></html>`, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  } })
}

export async function loginBucket(request, env) {
  return Array.from(await digest(`physio/login/v1\0${passcode(env)}\0${request.headers.get("cf-connecting-ip") || "unknown"}`), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
