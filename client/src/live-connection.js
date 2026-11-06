// 局域网保持 SSE；云端使用 Durable Object 可休眠 WebSocket，避免空闲长连接持续占用计算。
export function openLiveConnection({ cloud, onMessage, onState, onOpen }) {
  if (!cloud) {
    let source
    try { source = new EventSource("/api/events") } catch { onState(false); return undefined }
    source.onmessage = (event) => onMessage(event.data)
    source.onopen = () => { onState(true); onOpen() }
    source.onerror = () => onState(false)
    return () => source.close()
  }
  let socket
  let closed = false
  let retry
  let heartbeat
  let delay = 1000
  let lastSeen = 0
  function connect() {
    if (closed) return
    const url = new URL("/api/events", window.location.origin)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    try { socket = new WebSocket(url) } catch { disconnected(); return }
    socket.onopen = () => {
      delay = 1000
      lastSeen = Date.now()
      onState(true)
      onOpen()
      clearInterval(heartbeat)
      heartbeat = setInterval(() => {
        if (Date.now() - lastSeen > 60000) socket.close()
        else if (socket.readyState === WebSocket.OPEN) socket.send("ping")
      }, 25000)
    }
    socket.onmessage = (event) => {
      lastSeen = Date.now()
      if (event.data !== "pong") onMessage(event.data)
    }
    socket.onclose = disconnected
    socket.onerror = () => { onState(false); socket.close() }
  }
  function disconnected() {
    clearInterval(heartbeat)
    if (closed) return
    onState(false)
    clearTimeout(retry)
    retry = setTimeout(connect, delay)
    delay = Math.min(15000, delay * 2)
  }
  function visible() {
    if (document.visibilityState === "visible" && socket?.readyState === WebSocket.OPEN && Date.now() - lastSeen > 60000) socket.close()
  }
  document.addEventListener("visibilitychange", visible)
  connect()
  return () => {
    closed = true
    clearTimeout(retry)
    clearInterval(heartbeat)
    document.removeEventListener("visibilitychange", visible)
    socket?.close()
  }
}
