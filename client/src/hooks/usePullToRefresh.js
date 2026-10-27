// 下拉刷新的手势：只在容器贴顶时生效，和页面滚动不抢路。
import { useEffect, useRef, useState } from "react"

export const PULL_LIMIT = 88
const PULL_ARM = 64

export function usePullToRefresh({ enabled, onRefresh, onSuccess, onFail }) {
  const ref = useRef(null)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const enabledRef = useRef(enabled)
  const onRefreshRef = useRef(onRefresh)
  const onSuccessRef = useRef(onSuccess)
  const onFailRef = useRef(onFail)
  enabledRef.current = enabled
  onRefreshRef.current = onRefresh
  onSuccessRef.current = onSuccess
  onFailRef.current = onFail

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    let startY = 0
    let distance = 0
    let tracking = false
    let fromTouch = false
    let busy = false

    function nearTop() {
      return el.scrollTop <= 4
    }

    function begin(y) {
      tracking = false
      distance = 0
      if (busy || !enabledRef.current || !nearTop()) return
      startY = y
      tracking = true
    }

    function update(y, event) {
      if (!tracking) return
      if (!nearTop()) {
        tracking = false
        distance = 0
        setPull(0)
        return
      }
      const dy = y - startY
      if (dy > 10) {
        if (event?.cancelable) event.preventDefault()
        distance = dy
        setPull(dy)
        return
      }
      distance = dy > 0 ? dy : 0
      setPull(0)
    }

    function finish(commit) {
      if (!tracking) return
      tracking = false
      const should = commit && nearTop() && distance > 56
      distance = 0
      if (!should) {
        setPull(0)
        return
      }
      busy = true
      setRefreshing(true)
      setPull(PULL_ARM)
      Promise.resolve()
        .then(() => onRefreshRef.current())
        .then(() => onSuccessRef.current())
        .catch((err) => onFailRef.current(err))
        .finally(() => {
          busy = false
          setRefreshing(false)
          setPull(0)
        })
    }

    function onTouchStart(event) {
      fromTouch = true
      if (event.touches.length !== 1) {
        tracking = false
        distance = 0
        setPull(0)
        return
      }
      begin(event.touches[0].clientY)
    }

    function onTouchMove(event) {
      if (event.touches.length !== 1) return
      update(event.touches[0].clientY, event)
    }

    function onTouchEnd() {
      finish(true)
      window.setTimeout(() => {
        fromTouch = false
      }, 700)
    }

    function onMouseDown(event) {
      if (fromTouch || event.button !== 0) return
      begin(event.clientY)
    }

    function onMouseMove(event) {
      if (fromTouch || !tracking) return
      update(event.clientY)
    }

    function onTouchCancel() {
      finish(false)
    }

    function onMouseUp() {
      finish(true)
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true })
    el.addEventListener("touchmove", onTouchMove, { passive: false })
    el.addEventListener("touchend", onTouchEnd)
    el.addEventListener("touchcancel", onTouchCancel)
    el.addEventListener("mousedown", onMouseDown)
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)

    return () => {
      tracking = false
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("touchend", onTouchEnd)
      el.removeEventListener("touchcancel", onTouchCancel)
      el.removeEventListener("mousedown", onMouseDown)
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    }
  }, [])

  return { ref, pull, refreshing }
}
