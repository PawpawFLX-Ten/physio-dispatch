// 治疗室派工的 service worker：
// - 模型、图标这类不会变的资源进缓存，手机上第二次打开不用重新下载
// - 页面本身网络优先，网络不通时给上次缓存的那份
// - /api 永远直连，失败就让页面明明白白报「未能保存」，绝不把没存上的操作当成功
const CACHE = "physio-dispatch-v1"

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["/"]))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith("/api/")) return

  const immutable = /^\/(?:body|draco|icons|assets)\//.test(url.pathname)
  if (immutable) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()))
            return response
          }),
      ),
    )
    return
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()))
        return response
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match("/"))),
  )
})

// 本机任务提醒：点击通知时优先聚焦已打开的派工页面，没有就新开。
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const hit = list.find((client) => new URL(client.url).origin === self.location.origin)
      if (hit) return hit.focus()
      return self.clients.openWindow("/")
    }),
  )
})
