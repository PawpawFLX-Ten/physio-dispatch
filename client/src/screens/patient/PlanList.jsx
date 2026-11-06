// 今日单条目清单：滑动删除、拖动排序、当前项标记、行内完成。
import { useEffect, useRef, useState } from "react"
import { targetTitle } from "@shared/catalog.js"
import { isEquipmentInUse, isEquipmentItem, itemLine, linkedTargetTitles, originElement, removePast, sameIds, stepsFrom } from "./helpers.js"

export function TreatmentRow({ item, index, current, solo, dragging, offsetY, swipeX, onToggle, onAssign, onRowPointerDown, onHandlePointerDown }) {
  const transform = dragging
    ? `translate3d(0, ${offsetY}px, 0)`
    : swipeX
      ? `translate3d(${swipeX}px, 0, 0)`
      : undefined
  const equipment = isEquipmentItem(item)
  const inUse = isEquipmentInUse(item)
  const rowClass = ["patient-row", item.done ? "is-done" : "", current ? "is-current" : "", dragging ? "is-dragging" : "", inUse ? "is-in-use" : ""]
    .filter(Boolean)
    .join(" ")
  // 设备摘要由服务端统一拼接设备/机台/参数；组次型设备也已在摘要里带剂量，避免重复。
  const cardDetail = equipment && item.equipmentSummary ? item.equipmentSummary : itemLine(item)
  const linkedTitles = linkedTargetTitles(item)
  return (
    <li className={rowClass} data-item={item.id}>
      <div className="patient-row-delete" aria-hidden="true">
        删除
      </div>
      <div
        className="patient-row-main"
        style={transform ? { transform } : undefined}
        onPointerDown={onRowPointerDown}
      >
        <div className="patient-row-copy">
          <div className="patient-row-title">
            <span className="patient-index">{current ? "▶" : index + 1}</span>
            <span className="patient-target">{targetTitle(item.targetId, item.side)}</span>
          </div>
          {linkedTitles.length ? <p className="patient-row-linked">{`关联 ${linkedTitles.join(" · ")}`}</p> : null}
          {inUse ? (
            <p className="patient-row-in-use">
              <span className="patient-in-use-badge">使用中</span>
            </p>
          ) : null}
          <p className={equipment ? "patient-meta is-equipment" : "patient-meta"}>{cardDetail}</p>
          {!item.done && item.canExecute === false ? <p className="patient-meta error">{item.reason}</p> : null}
        </div>
        {!solo ? (
          <button
            type="button"
            className={item.assigneeId ? "patient-who" : "patient-who is-empty"}
            data-stop=""
            aria-label={item.assigneeName ? `派给 ${item.assigneeName}` : "派给谁"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onAssign}
          >
            {item.assigneeName || "未派"}
          </button>
        ) : null}
        <button
          type="button"
          className={item.done ? "patient-done is-done" : "patient-done"}
          data-stop=""
          aria-pressed={item.done}
          disabled={!item.done && item.canExecute === false}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onToggle}
        >
          {item.done ? "已完成" : "完成"}
        </button>
        <button
          type="button"
          className="patient-handle"
          data-stop=""
          aria-label="拖动排序"
          onPointerDown={onHandlePointerDown}
          onContextMenu={(event) => event.preventDefault()}
        >
          <span className="patient-grip" />
        </button>
      </div>
    </li>
  )
}

export function PlanList({ items, currentIndex, solo, onToggle, onAssign, onOpen, onRemove, onReorder }) {
  const [preview, setPreview] = useState(null)
  const [draggingId, setDraggingId] = useState(null)
  const [dragY, setDragY] = useState(0)
  const [swipeOffset, setSwipeOffset] = useState(null)
  const shownRef = useRef(items)
  const itemsRef = useRef(items)
  const dragRef = useRef(null)
  const swipeRef = useRef(null)
  const savingRef = useRef(false)
  const liveRef = useRef(true)
  const openRef = useRef(onOpen)
  const removeRef = useRef(onRemove)
  const reorderRef = useRef(onReorder)
  const shown = preview ?? items
  shownRef.current = shown
  openRef.current = onOpen
  removeRef.current = onRemove
  reorderRef.current = onReorder

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  useEffect(() => {
    let armed = false
    function onMove(event) {
      const drag = dragRef.current
      if (drag && event.pointerId === drag.pointerId) {
        if (event.cancelable) event.preventDefault()
        const rawPx = event.clientY - drag.startY
        const shift = stepsFrom(rawPx, drag.rowHeight)
        const last = Math.max(0, itemsRef.current.length - 1)
        const target = Math.max(0, Math.min(last, drag.startIndex + shift))
        const applied = target - drag.startIndex
        setDragY(rawPx - applied * drag.rowHeight)
        if (target === drag.placed) return
        const list = itemsRef.current
        const from = list.findIndex((item) => item.id === drag.itemId)
        if (from < 0 || from === target) {
          drag.placed = target
          return
        }
        const next = list.slice()
        const [moved] = next.splice(from, 1)
        next.splice(target, 0, moved)
        itemsRef.current = next
        drag.placed = target
        setPreview(next)
        return
      }

      const swipe = swipeRef.current
      if (!swipe || event.pointerId !== swipe.pointerId) return
      const dx = event.clientX - swipe.x
      const dy = event.clientY - swipe.y
      if (!swipe.decided) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
        swipe.decided = true
        swipe.active = dx < 0 && Math.abs(dx) > Math.abs(dy)
        if (swipe.active) {
          try {
            swipe.el?.setPointerCapture?.(event.pointerId)
          } catch {
            /* 模拟事件没有活动指针，捕获失败不影响滑动 */
          }
        }
      }
      if (!swipe.active) return
      if (event.cancelable) event.preventDefault()
      swipe.dx = Math.min(0, dx)
      setSwipeOffset({ id: swipe.itemId, dx: Math.max(swipe.dx, -180) })
    }

    function onUp(event) {
      const drag = dragRef.current
      if (drag && event.pointerId === drag.pointerId) {
        const orderedIds = itemsRef.current.map((item) => item.id)
        const snapshot = drag.snapshot
        dragRef.current = null
        setDraggingId(null)
        setDragY(0)
        if (event.type === "pointercancel" || sameIds(orderedIds, snapshot)) {
          setPreview(null)
          return
        }
        savingRef.current = true
        reorderRef.current(orderedIds).finally(() => {
          savingRef.current = false
          if (liveRef.current) setPreview(null)
        })
        return
      }

      const swipe = swipeRef.current
      if (!swipe || swipe.pointerId !== event.pointerId) return
      const itemId = swipe.itemId
      const dx = swipe.dx
      const decided = swipe.decided
      const active = swipe.active
      swipeRef.current = null
      if (event.type === "pointercancel" || !(active && dx < -removePast)) {
        setSwipeOffset(null)
        if (event.type !== "pointercancel" && !decided) {
          armed = true
          openRef.current(itemId)
        }
        return
      }
      setSwipeOffset({ id: itemId, dx: Math.max(dx, -180) })
      removeRef.current(itemId).finally(() => {
        if (!liveRef.current) return
        setSwipeOffset((current) => (current?.id === itemId ? null : current))
      })
    }

    function swallow(event) {
      if (!armed) return
      armed = false
      event.preventDefault()
      event.stopPropagation()
    }

    function disarm() {
      armed = false
    }

    window.addEventListener("pointerdown", disarm, true)
    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp, true)
    window.addEventListener("pointercancel", onUp, true)
    window.addEventListener("click", swallow, true)
    return () => {
      window.removeEventListener("pointerdown", disarm, true)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp, true)
      window.removeEventListener("pointercancel", onUp, true)
      window.removeEventListener("click", swallow, true)
    }
  }, [])

  function startSwipe(event, itemId) {
    if (event.button !== 0) return
    if (savingRef.current || dragRef.current) return
    const origin = originElement(event.target)
    if (origin?.closest("[data-stop]")) return
    swipeRef.current = {
      pointerId: event.pointerId,
      itemId,
      x: event.clientX,
      y: event.clientY,
      dx: 0,
      decided: false,
      active: false,
      el: event.currentTarget,
    }
  }

  function startDrag(event, itemId) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    if (savingRef.current || dragRef.current) return
    const row = event.currentTarget.closest("[data-item]")
    if (!row) return
    const rect = row.getBoundingClientRect()
    const nextRow = row.nextElementSibling
    const prevRow = row.previousElementSibling
    let rowHeight = rect.height
    if (nextRow) rowHeight = nextRow.getBoundingClientRect().top - rect.top
    else if (prevRow) rowHeight = rect.top - prevRow.getBoundingClientRect().top
    const source = shownRef.current
    const startIndex = source.findIndex((item) => item.id === itemId)
    if (startIndex < 0) return
    swipeRef.current = null
    setSwipeOffset(null)
    const copy = source.slice()
    itemsRef.current = copy
    dragRef.current = {
      pointerId: event.pointerId,
      itemId,
      startIndex,
      startY: event.clientY,
      rowHeight: Math.max(rowHeight, 44),
      snapshot: source.map((item) => item.id),
      placed: startIndex,
    }
    setPreview(copy)
    setDraggingId(itemId)
    setDragY(0)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  return (
    <ol className={draggingId ? "patient-items is-dragging" : "patient-items"}>
      {shown.map((item, index) => (
        <TreatmentRow
          key={item.id}
          item={item}
          index={index}
          current={index === currentIndex && !item.done}
          solo={solo}
          dragging={draggingId === item.id}
          offsetY={draggingId === item.id ? dragY : 0}
          swipeX={swipeOffset?.id === item.id ? swipeOffset.dx : 0}
          onToggle={() => onToggle(item)}
          onAssign={() => onAssign(item)}
          onRowPointerDown={(event) => startSwipe(event, item.id)}
          onHandlePointerDown={(event) => startDrag(event, item.id)}
        />
      ))}
    </ol>
  )
}

// 剂量步进：点一下 ±1；按住不放连续走，本地先累加，松手才存一次（省网络也省步骤）。
export function DoseControl({ label, value, minusLabel, plusLabel, pending, onCommit }) {
  const min = 1
  const [delta, setDelta] = useState(0)
  const deltaRef = useRef(0)
  const holdTimer = useRef(null)
  const repeatTimer = useRef(null)
  const pointerDriven = useRef(false)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  const shown = Math.max(min, value + delta)

  function step(dir) {
    if (Math.max(min, value + deltaRef.current + dir) === Math.max(min, value + deltaRef.current)) return
    deltaRef.current += dir
    setDelta(deltaRef.current)
  }

  function stop(commit = true) {
    if (holdTimer.current) clearTimeout(holdTimer.current)
    if (repeatTimer.current) clearInterval(repeatTimer.current)
    holdTimer.current = null
    repeatTimer.current = null
    const total = deltaRef.current
    deltaRef.current = 0
    setDelta(0)
    if (commit && total) commitRef.current(total)
  }

  function press(dir) {
    if (pending && deltaRef.current === 0) return
    step(dir)
    holdTimer.current = setTimeout(() => {
      repeatTimer.current = setInterval(() => step(dir), 110)
    }, 380)
  }

  // 卸载时按住还没松开：丢掉没提交的累加，不偷偷存。
  useEffect(() => () => stop(false), [])

  const holdProps = (dir) => ({
    onPointerDown: () => {
      pointerDriven.current = true
      press(dir)
    },
    onPointerUp: () => stop(),
    onPointerLeave: () => stop(),
    onPointerCancel: () => stop(),
    // 键盘（回车/空格触发 click）：算一次点按。
    onClick: () => {
      if (pointerDriven.current) {
        pointerDriven.current = false
        return
      }
      press(dir)
      stop()
    },
  })

  return (
    <div className="patient-stepper">
      <button type="button" aria-label={minusLabel} disabled={pending && !delta} {...holdProps(-1)}>
        −
      </button>
      <span>
        {shown} {label}
      </span>
      <button type="button" aria-label={plusLabel} disabled={pending && !delta} {...holdProps(1)}>
        +
      </button>
    </div>
  )
}
