import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const clientRoot = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(clientRoot, "..")

export default defineConfig({
  root: clientRoot,
  plugins: [react()],
  resolve: { alias: { "@shared": path.join(root, "shared") } },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    fs: { allow: [root] },
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
})
