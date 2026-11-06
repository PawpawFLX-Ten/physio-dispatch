// Access 只在 WebSocket 握手时检查 JWT；每次发送业务通知还需检查握手令牌是否过期。
export function socketAuthorized(socket, now = Date.now()) {
  try {
    const expiresAt = socket.deserializeAttachment()?.expiresAt
    return Number.isFinite(expiresAt) && expiresAt > now
  } catch { return false }
}
