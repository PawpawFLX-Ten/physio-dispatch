import { createRoot } from "react-dom/client"
import App from "./App.jsx"
import "./styles.css"

createRoot(document.getElementById("root")).render(<App />)

// 服务工作线程要安全上下文：localhost 或 https 才注册，局域网 http 下安静跳过。
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  })
}
