import { lazy, Suspense, useEffect, useState } from "react"
import { api, getDeviceId } from "./api.js"
import { Gate } from "./screens/Gate.jsx"
import { Today } from "./screens/Today.jsx"

// 病人页拖着 three.js 和 3D 模型，懒加载后今日单首屏不用等它们。
const PatientDay = lazy(() =>
  import("./screens/PatientDay.jsx").then((module) => ({ default: module.PatientDay })),
)

export default function App() {
  const [snap, setSnap] = useState(null)
  const [entryId, setEntryId] = useState(null)
  const [error, setError] = useState("")
  const [pulse, setPulse] = useState(0)

  async function refresh() {
    const next = await api.session()
    setSnap(next)
    setError("")
    return next
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message))
  }, [])

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
      try {
        const payload = JSON.parse(event.data)
        if (payload?.origin && payload.origin === getDeviceId()) return
      } catch {
        // 解析不了就当普通事件处理
      }
      clearTimeout(debounce)
      debounce = setTimeout(() => setPulse((n) => n + 1), 400)
    }
    return () => {
      clearTimeout(debounce)
      source.close()
    }
  }, [])

  useEffect(() => {
    if (!pulse) return
    if (entryId) return
    refresh().catch(() => {})
  }, [pulse])

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
    return <main className="screen"><p className="error">{error}</p></main>
  }
  if (!snap) return <main className="screen"><p>正在打开治疗室…</p></main>
  if (snap.stage !== "ready") return <Gate snap={snap} onChange={setSnap} />
  if (entryId) {
    return (
      <Suspense fallback={<main className="screen"><p>正在打开病人页…</p></main>}>
        <PatientDay
          entryId={entryId}
          pulse={pulse}
          onBack={() => {
            setEntryId(null)
            refresh().catch((err) => setError(err.message))
          }}
        />
      </Suspense>
    )
  }
  return <Today snap={snap} onRefresh={refresh} onOpen={setEntryId} />
}
