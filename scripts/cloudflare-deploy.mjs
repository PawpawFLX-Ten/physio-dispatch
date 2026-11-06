// Access 的域名与 AUD 是公开标识，不是 API 密钥；部署凭据只由 Wrangler 登录或环境提供。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.json"), "utf8"))
const team = String(process.env.ACCESS_TEAM_DOMAIN || config.vars.ACCESS_TEAM_DOMAIN).replace(/^https:\/\//, "").replace(/\/$/, "")
const audience = String(process.env.ACCESS_AUD || config.vars.ACCESS_AUD)
const mode = process.env.AUTH_MODE || config.vars.AUTH_MODE || "access"
if (!["access", "passcode", "public-demo"].includes(mode)) {
  console.error("AUTH_MODE 只能为 access、passcode 或 public-demo")
  process.exit(1)
}
if (mode === "access" && (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team) || !audience || /\s/.test(audience))) {
  console.error("尚未配置 Access。请先按 docs/Cloudflare部署.md 创建仅允许员工的 Access 应用，再设置 ACCESS_TEAM_DOMAIN 和 ACCESS_AUD；不会发布未保护的站点。")
  process.exit(1)
}
if (mode === "public-demo" && config.vars.PUBLIC_DEMO_ACK !== "fictional-data-only") {
  console.error("公开演示必须明确确认仅使用虚构数据")
  process.exit(1)
}
if (mode === "public-demo") console.warn("正在发布公开演示：无需登录，所有访问者可查看和修改模拟数据；外层 Cloudflare Access 应用需在控制台单独暂停。")
if (mode === "passcode") console.warn("请确认 Worker 已设置 CLINIC_PASSCODE Secret（至少 16 字符）；未设置时站点会拒绝访问，口令不会写入部署配置。")

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

config.main = path.join(root, config.main)
config.assets.directory = path.join(root, config.assets.directory)
config.vars.ACCESS_TEAM_DOMAIN = team
config.vars.ACCESS_AUD = audience
config.vars.AUTH_MODE = mode
delete config.env
const generated = path.join(root, ".wrangler", "deploy.json")
fs.mkdirSync(path.dirname(generated), { recursive: true })
fs.writeFileSync(generated, JSON.stringify(config, null, 2))
run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"])
run(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", generated])
