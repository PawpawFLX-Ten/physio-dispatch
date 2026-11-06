// Access 只在 WebSocket 握手时检查 JWT；每次发送业务通知还需检查握手令牌是否过期。
export function socketAuthorized(socket, now = Date.now(), expected) {
  try {
    const attachment = socket.deserializeAttachment()
    return Number.isFinite(attachment?.expiresAt) && attachment.expiresAt > now &&
      (!expected || (attachment.mode === expected.mode && attachment.generation === expected.generation))
  } catch { return false }
}
