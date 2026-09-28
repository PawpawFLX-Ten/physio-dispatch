import { spawn } from "node:child_process"
import os from "node:os"

function lanAddresses() {
  const found = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) found.push(item.address)
    }
  }
  return found
}

const env = { ...process.env, HOST: "0.0.0.0" }
const api = spawn(process.execPath, ["server/index.js"], { stdio: "inherit", env })
const client = spawn(
  process.execPath,
  ["./node_modules/vite/bin/vite.js", "--config", "client/vite.config.js", "--host", "0.0.0.0", "--port", "5173"],
  { stdio: "inherit", env },
)

const phones = ["127.0.0.1", ...lanAddresses()]
console.log("治疗室页面：")
for (const ip of phones) console.log(`  http://${ip}:5173/`)
console.log("同一局域网的手机用上面的地址打开。第一台写下名字；之后的手机选「我是谁」。")

function shut() {
  api.kill()
  client.kill()
}

process.on("SIGINT", shut)
process.on("SIGTERM", shut)

const stop = (child) =>
  child.on("exit", (code) => {
    shut()
    process.exit(code ?? 0)
  })
stop(api)
stop(client)
