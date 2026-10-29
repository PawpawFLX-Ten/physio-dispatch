import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { api, getDeviceId } from "./api.js"
import { parseChangeEvent } from "@shared/events.js"
import { Gate } from "./screens/Gate.jsx"
import { Today } from "./screens/Today.jsx"

// 病人页拖着 three.js 和 3D 模型，懒加载后今日单首屏不用等它们。
const PatientDay = lazy(() =>
  import("./screens/PatientDay.jsx").then((module) => ({ default: module.PatientDay })),
)

export default function App() {
  const [snap, setSnap] = useState(null)
  const [entryId, setEntryId] = useState(null)
  // 打开病人页时带着的初始数据（开单类接口的返回就是完整视图）：省掉进页后的第一次拉取。
  const [entryInitial, setEntryInitial] = useState(null)
  const [error, setError] = useState("")
  const [pulse, setPulse] = useState(0)
  // 别人刚改过数据的名字：被动提示几秒就收，不用任何人点。
  const [changedBy, setChangedBy] = useState("")
  const changedByTimer = useRef(null)
  // 实时连接断了要让用的人知道（列表停在旧数据不是「没活派给我」）。
  const [live, setLive] = useState(true)
  // 深色模式跟随系统：自动换、没有开关（昏暗的治疗室里不刺眼）。
  const [dark, setDark] = useState(() => Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches))
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)")
    if (!mq) return undefined
    const apply = () => setDark(mq.matches)
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light"
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#12100d" : "#f3eadf")
  }, [dark])

  async function refresh() {
    const next = await api.session()
    setSnap(next)
    setError("")
    return next
  }

  // 写接口的返回都带全套最新视图：直接喂给状态，省一次「改完再拉一遍」的往返。
  function applySnap(next) {
    if (next && next.stage === "ready") setSnap(next)
  }

  // 空闲时预取病人页的懒包（three.js + 模型加载逻辑）：第一次点病人行不用现场下几百 KB。
  useEffect(() => {
    const idle = window.requestIdleCallback || ((fn) => window.setTimeout(fn, 1500))
    idle(() => {
      import("./screens/PatientDay.jsx").catch(() => {})
    })
  }, [])

  useEffect(() => {
    refresh().catch((err) => setError(err.message))
  }, [])

  // 首屏打不开（开店时 Wi-Fi 还没起来是常事）：5 秒自动再试一次，别停成死屏。
  useEffect(() => {
    if (!error || snap) return undefined
    const timer = setTimeout(() => {
      setError("")
      refresh().catch((err) => setError(err.message))
    }, 5000)
    return () => clearTimeout(timer)
  }, [error, snap])

  // 单人治疗室不用挑身份：名单里只有一个人时自动认领，打开就是今日单。
  // 挑选界面只留给多人治疗室；第一台手机建名字的流程不受影响。
  useEffect(() => {
    if (snap?.stage !== "whoami" || snap.staff?.length !== 1) return undefined
    let cancelled = false
    api
      .claim({ staffId: snap.staff[0].id })
      .then((next) => {
        if (!cancelled && next.stage === "ready") setSnap(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [snap?.stage, snap?.staff?.length])

  // 别的手机一改，服务器推一条过来：停在今日单就刷新列表，开着病人页由病人页自己拉。
  useEffect(() => {
    let source
    try {
      source = new EventSource("/api/events")
    } catch {
      return undefined
    }
    let debounce
    source.onmessage = (event) => {
      // 自己改的数据服务器会带上 origin，应用返回值时已经拿到了最新状态，不用再拉一遍。
      const payload = parseChangeEvent(event.data)
      if (payload?.origin && payload.origin === getDeviceId()) return
      if (payload?.by) {
        setChangedBy(payload.by)
        clearTimeout(changedByTimer.current)
        changedByTimer.current = setTimeout(() => setChangedBy(""), 4000)
      }
      clearTimeout(debounce)
      debounce = setTimeout(() => setPulse((n) => n + 1), 400)
    }
    source.onopen = () => {
      setLive(true)
      // 重连成功当收到一次推送：断线期间别人的改动补上。
      setPulse((n) => n + 1)
    }
    source.onerror = () => {
      // EventSource 自己会按 retry 重试：出错先亮提示，重连成功由 onopen 收掉。
      setLive(false)
    }
    return () => {
      clearTimeout(debounce)
      clearTimeout(changedByTimer.current)
      source.close()
    }
  }, [])

  useEffect(() => {
    if (!pulse) return
    if (entryId) return
    refresh().catch(() => {})
  }, [pulse])

  // 今日任务角标 + 本地通知：PWA 装在主屏时能显示未完成数；页面在后台但没被系统杀掉时，
  // 新任务仍可发出本机通知。真正的锁屏推送受局域网 HTTP/系统省电限制，不做虚假承诺。
  const myOpenCount =
    snap?.stage === "ready" && Array.isArray(snap.myTasks)
      ? snap.myTasks.filter((task) => !task.done).length
      : 0
  const previousOpenCount = useRef(null)
  useEffect(() => {
    document.title = myOpenCount ? `(${myOpenCount}) 治疗室派工` : "治疗室派工"
    try {
      if (myOpenCount && typeof navigator.setAppBadge === "function") navigator.setAppBadge(myOpenCount).catch(() => {})
      else if (!myOpenCount && typeof navigator.clearAppBadge === "function") navigator.clearAppBadge().catch(() => {})
    } catch {
      /* 不支持 Badging API 的浏览器忽略 */
    }
    const previous = previousOpenCount.current
    previousOpenCount.current = myOpenCount
    if (
      previous != null &&
      myOpenCount > previous &&
      document.visibilityState === "hidden" &&
      typeof window.Notification === "function" &&
      window.Notification.permission === "granted"
    ) {
      const body = `你有 ${myOpenCount} 项未完成`
      const options = {
        body,
        tag: "clinic-tasks",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
      }
      // Service Worker 通知在已安装 PWA/部分手机上比页面 Notification 更稳；
      // 注册还没就绪时退回页面通知，两者失败都不阻塞治疗流程。
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.ready
          .then((registration) => registration.showNotification("治疗室有新任务", options))
          .catch(() => {
            try {
              new window.Notification("治疗室有新任务", options)
            } catch {
              /* 系统不支持就保持页面内提示 */
            }
          })
      } else {
        try {
          new window.Notification("治疗室有新任务", options)
        } catch {
          /* iOS/微信可能只允许 Service Worker 通知：不阻塞主流程 */
        }
      }
    }
  }, [myOpenCount])

  // 微信里切走或手机锁屏时页面会被挂起，SSE 可能悄悄断掉：
  // 回到前台就当收到一次推送，别等心跳慢慢补。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setPulse((n) => n + 1)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  if (error && !snap) {
    return (
      <main className="screen">
        <p className="error">{error}</p>
        <button
          type="button"
          className="primary screen-retry"
          onClick={() => {
            setError("")
            refresh().catch((err) => setError(err.message))
          }}
        >
          再试一次
        </button>
      </main>
    )
  }
  if (!snap) return <main className="screen"><p>正在打开治疗室…</p></main>
  if (snap.stage !== "ready") return <Gate snap={snap} onChange={setSnap} />
  if (entryId) {
    return (
      <Suspense fallback={<main className="screen"><p>正在打开病人页…</p></main>}>
        <PatientDay
          entryId={entryId}
          initial={entryInitial}
          pulse={pulse}
          live={live}
          onBack={(result) => {
            setEntryId(null)
            setEntryInitial(null)
            // 返回路径上的 leave/drop 返回值就是最新视图；拿不到（如过了零点）再拉一次。
            if (result && result.stage === "ready") setSnap(result)
            else refresh().catch((err) => setError(err.message))
          }}
        />
      </Suspense>
    )
  }
  return <Today snap={snap} live={live} changedBy={changedBy} onRefresh={refresh} onSnap={applySnap} onOpen={(id, initial) => {
    setEntryId(id)
    setEntryInitial(initial || null)
  }} />
}
