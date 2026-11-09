// 人体模型的下载：国内连 Cloudflare 常绕到美西节点，又慢又会「卡死」——连接不断、数据也不来，
// fetch 自己永远不会超时，页面就一直停在「正在加载人体 3/15」，连重试按钮都不出来。
// 这里按「多久没收到新数据」判断卡死，主动断开重下；慢但一直在走的下载不打断，
// 所以 1MB 多的文件在几 KB/s 的线路上也能下完。

// 这么久一个字节都没来就算卡死（包括等响应头的阶段）。
export const STALL_MS = 15000
// 第一次 + 重试 5 次；全部卡死时大约两分钟后报错，页面给出「重试」按钮。
export const MAX_ATTEMPTS = 6

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function retryable(message, cause) {
  return Object.assign(new Error(message, { cause }), { retryable: true })
}

async function downloadOnce(url, { fetchImpl, stallMs, onProgress, retry }) {
  const controller = new AbortController()
  let stalled = false
  let timer = 0
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, stallMs)
  }
  const interrupted = (error) => retryable(stalled ? "人体模型下载卡住了" : `人体模型下载中断：${error?.message || error}`, error)

  arm()
  try {
    let response
    try {
      // 重下要跳过浏览器 HTTP 缓存里的旧条目：经 service worker 的请求在等响应头时被取消，底层那次
      // 网络请求并不会真断开，还占着这个网址的缓存条目；同一网址照常请求会排在它后面干等，永远下不来
      // （Chromium 实测）。reload 不读旧条目、下好照样写回缓存，service worker 也照常存它那份。
      response = await fetchImpl(url, retry ? { signal: controller.signal, cache: "reload" } : { signal: controller.signal })
    } catch (error) {
      throw interrupted(error)
    }
    if (!response.ok) {
      const error = new Error(`人体模型下载失败（HTTP ${response.status}）`)
      // 404 这类重下也没用；服务端临时出错、限流才值得再试。
      error.retryable = response.status >= 500 || response.status === 408 || response.status === 429
      throw error
    }
    // 压缩传输时 Content-Length 是压缩后的长度，和解出来的字节数对不上，不能拿来核对。
    const expected = response.headers.get("content-encoding") ? 0 : Number(response.headers.get("content-length")) || 0

    if (!response.body?.getReader) {
      // 极少数不支持流式读取的老浏览器：保持原来的行为，一次读完，不做卡死计时。
      clearTimeout(timer)
      const buffer = await response.arrayBuffer()
      onProgress?.(buffer.byteLength, expected)
      return buffer
    }

    const reader = response.body.getReader()
    const chunks = []
    let received = 0
    arm()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.byteLength
        arm()
        onProgress?.(received, expected)
      }
    } catch (error) {
      throw interrupted(error)
    }
    if (expected && received !== expected) throw retryable(`人体模型下载不完整（${received}/${expected} 字节）`)

    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes.buffer
  } finally {
    clearTimeout(timer)
  }
}

// 下载一个文件的全部字节（ArrayBuffer）。卡死、断线、服务端临时出错会自动重下，
// 每次重下前调 onRetry(第几次尝试, 上次的错误)，并按 1、2、4、8、8 秒退避。
export async function downloadBytes(url, options = {}) {
  const { fetchImpl = fetch, stallMs = STALL_MS, maxAttempts = MAX_ATTEMPTS, onProgress, onRetry, wait = sleep } = options
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      onRetry?.(attempt, lastError)
      await wait(Math.min(1000 * 2 ** (attempt - 2), 8000))
    }
    try {
      return await downloadOnce(url, { fetchImpl, stallMs, onProgress, retry: attempt > 1 })
    } catch (error) {
      if (!error.retryable) throw error
      lastError = error
    }
  }
  throw new Error(`${lastError.message}，已自动重试 ${maxAttempts - 1} 次`, { cause: lastError })
}

// 并发闸门：同一时刻最多跑 limit 个任务，其余按提交顺序排队。
// 慢线路上 15 个文件一起抢带宽谁都下不完；排队下，文件一个个落地，卡住也只重下少数几个。
export function createLimiter(limit) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= limit || !queue.length) return
    active += 1
    const { task, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1
        next()
      })
  }
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject })
      next()
    })
}
