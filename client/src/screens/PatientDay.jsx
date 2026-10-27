import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api.js"
import {
  DIRECTIONS,
  TARGETS,
  TECHNIQUES,
  allowsChief,
  allowsWork,
  directionLabel,
  doseLabel,
  hasSides,
  targetById,
  targetTitle,
  techniqueLabel,
} from "@shared/catalog.js"
import { matchesInitials } from "../pinyin.js"
import { parseQuickOrder } from "@shared/quick-order.js"
import { itemsOnSpot } from "@shared/body-marks.js"
import { PairingChips } from "../PairingChips.jsx"
import { useBackLayer } from "../back-layer.js"
import { BodyStage } from "./BodyStage.jsx"
import "./patient.css"

const blankNotice = { text: "", tone: "ok" }
const pastMidnightNotice = {
  text: "已经是新的一天。回到今日单后，可在加入病人里把昨天未完成接进今天。",
  tone: "error",
}
const removePast = 72

function isPastMidnightError(err) {
  return typeof err?.message === "string" && err.message.includes("过了零点")
}

function isConflictError(err) {
  return err?.status === 409 || (typeof err?.message === "string" && err.message.includes("别人刚改过"))
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function stepsFrom(delta, size) {
  if (!size) return 0
  const raw = delta / size
  if (raw === 0) return 0
  return Math.trunc(raw + Math.sign(raw) * 0.5)
}

function numeric(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function conditionText(entry) {
  return (entry.conditionIds || [])
    .map((id) => entry.conditions?.find((condition) => condition.id === id)?.name)
    .filter(Boolean)
    .join("、")
}

// 撤销恢复用的持久化字段快照（不含界面展示名）。
function itemSnapshot(item) {
  return {
    id: item.id,
    conditionId: item.conditionId,
    sourceItemId: item.sourceItemId ?? null,
    targetId: item.targetId,
    side: item.side || null,
    technique: item.technique,
    direction: item.direction,
    dose: item.dose == null ? item.dose : structuredClone(item.dose),
    assigneeId: item.assigneeId || null,
    done: Boolean(item.done),
    completedBy: item.completedBy || null,
    completedAt: item.completedAt || null,
  }
}

// 完成时刻只看时分：条目行和来过几次都印「HH:MM」。
function clockOf(iso) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ""
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
}

function itemLine(item) {
  // 派给谁单独成钮，不塞进这一行说明。
  const doneBit = item.done && item.completedByName
    ? `${item.completedByName}完成${item.completedAt ? ` ${clockOf(item.completedAt)}` : ""}`
    : ""
  return [
    techniqueLabel(item.technique),
    directionLabel(item.direction),
    doseLabel(item.technique, item.dose),
    doneBit,
  ]
    .filter(Boolean)
    .join(" · ")
}

function originElement(target) {
  if (target instanceof Element) return target
  return target?.parentElement || null
}

function Notice({ notice }) {
  if (!notice?.text) return null
  const tone = notice.tone === "error" ? "is-error" : "is-ok"
  return (
    <p className={`patient-notice ${tone}`} role="status">
      {notice.text}
    </p>
  )
}

function Sheet({ title, children, onClose }) {
  return (
    <div className="patient-shade" onClick={() => onClose?.()} role="presentation">
      <div
        className="patient-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title || "请选择"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="patient-grab" />
        {title ? <h2>{title}</h2> : null}
        {children}
      </div>
    </div>
  )
}

// 定义在组件外面：放在函数体里的话每个按键都会换一个组件类型，全部按钮被卸载重挂。
function ChoiceButton({ target, side, pending, onPick }) {
  return (
    <button
      type="button"
      className="patient-choice"
      disabled={pending}
      onClick={() => onPick(target.id, side)}
    >
      {targetTitle(target.id, side)}
    </button>
  )
}

// 名单点选：不转模型也能加项，深层肌肉（肩袖这类被盖住的）在这里点。
// 顶上「说一句」把整句话直接变成清单，说话靠键盘自带的语音输入。
// 主诉定了以后，紧跟一行常见搭配芯片：点一下就按主诉那一侧加项。
function ListPicker({ entry, pairings, pending, notice, query, onQuery, onPickSite, onPickWork, onQuickAdd, onClose }) {
  const [quickText, setQuickText] = useState("")
  const sheetSearchRef = useRef(null)
  const parsed = useMemo(() => parseQuickOrder(quickText), [quickText])
  const hasSomething = Boolean(parsed.chief) || parsed.items.length > 0
  const needSite = !entry?.chiefSiteId
  const sites = useMemo(
    () => TARGETS.filter((target) => allowsChief(target) && matchesInitials(query, target.name)),
    [query],
  )
  const works = useMemo(
    () => TARGETS.filter((target) => allowsWork(target) && matchesInitials(query, target.name)),
    [query],
  )
  const sideTags = (target) => (hasSides(target) ? ["left", "right"] : [null])
  const pairingIds = pairings?.[entry?.chiefSiteId] || []
  const addedSpots = useMemo(
    () => new Set((entry?.items || []).map((item) => `${item.targetId}:${item.side || ""}`)),
    [entry],
  )

  return (
    <Sheet title="加项" onClose={onClose}>
      <Notice notice={notice} />
      {/* 包成表单：键盘上的完成/回车直接入库，语音说完不用再腾手点按钮。 */}
      <form
        className="patient-quick"
        onSubmit={(event) => {
          event.preventDefault()
          if (pending || !hasSomething) return
          onQuickAdd(parsed, () => setQuickText(""))
        }}
      >
        <input
          className="patient-search patient-quick-input"
          type="text"
          value={quickText}
          // 新单还没定主诉时才自动弹键盘（说一句是主路）；已定主诉的加项走搭配芯片更快，
          // 键盘别把它们挡住，要说一句点一下输入框就行。
          autoFocus={needSite}
          placeholder="说一句：左膝 股四头按摩8分钟 然后腘绳肌松解"
          aria-label="说一句加项"
          enterKeyHint="done"
          autoComplete="off"
          onChange={(event) => setQuickText(event.target.value)}
        />
        {quickText.trim() ? (
          <div className="patient-quick-preview">
            {parsed.chief ? (
              <p className="patient-quick-chief">{`要治 ${targetTitle(parsed.chief.targetId, parsed.chief.side)}`}</p>
            ) : null}
            {parsed.items.length ? (
              <ol className="patient-quick-items">
                {parsed.items.map((item, index) => (
                  <li key={index}>
                    {`${targetTitle(item.targetId, item.side)} · ${techniqueLabel(item.technique)} · ${doseLabel(item.technique, item.dose)}`}
                  </li>
                ))}
              </ol>
            ) : null}
            {parsed.unknown.length ? (
              <p className="patient-quick-unknown">
                {"没认出来（点一下去搜）："}
                {parsed.unknown.map((word) => (
                  <button
                    key={word}
                    type="button"
                    className="patient-quick-word"
                    onClick={() => {
                      onQuery(word)
                      sheetSearchRef.current?.focus()
                    }}
                  >
                    {word}
                  </button>
                ))}
              </p>
            ) : null}
            <button
              type="submit"
              className="primary"
              disabled={pending || !hasSomething}
            >
              {parsed.items.length ? `加 ${parsed.items.length} 项` : "只记要治的地方"}
            </button>
          </div>
        ) : null}
      </form>
      {pairingIds.length && !needSite ? (
        <div className="patient-pairing-block">
          <p className="patient-label">常见搭配</p>
          <PairingChips
            ids={pairingIds}
            side={entry.chiefSide}
            added={addedSpots}
            disabled={pending}
            onPick={(targetId, side) => onPickWork(targetId, side)}
          />
        </div>
      ) : null}
      <input
        ref={sheetSearchRef}
        className="patient-search"
        type="search"
        value={query}
        placeholder="或搜肌肉名点选，可输拼音首字母"
        aria-label="搜肌肉"
        onChange={(event) => onQuery(event.target.value)}
      />
      {needSite ? (
        <>
          <p className="patient-label">先点要治的地方</p>
          <div className="patient-grid">
            {sites.flatMap((target) =>
              sideTags(target).map((side) => (
                <ChoiceButton
                  key={`${target.id}:${side || "mid"}`}
                  target={target}
                  side={side}
                  pending={pending}
                  onPick={onPickSite}
                />
              )),
            )}
          </div>
        </>
      ) : null}
      <p className="patient-label">{needSite ? "下手项（可选）" : "下手项"}</p>
      <div className="patient-grid">
        {works.flatMap((target) =>
          sideTags(target).map((side) => (
            <ChoiceButton
              key={`${target.id}:${side || "mid"}`}
              target={target}
              side={side}
              pending={pending}
              onPick={onPickWork}
            />
          )),
        )}
      </div>
      <button type="button" className="secondary" onClick={onClose}>
        收起
      </button>
    </Sheet>
  )
}

function TreatmentRow({ item, index, current, solo, dragging, offsetY, swipeX, onToggle, onAssign, onRowPointerDown, onHandlePointerDown }) {
  const transform = dragging
    ? `translate3d(0, ${offsetY}px, 0)`
    : swipeX
      ? `translate3d(${swipeX}px, 0, 0)`
      : undefined
  const rowClass = ["patient-row", item.done ? "is-done" : "", current ? "is-current" : "", dragging ? "is-dragging" : ""]
    .filter(Boolean)
    .join(" ")
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
          <p className="patient-meta">{itemLine(item)}</p>
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

function PlanList({ items, currentIndex, solo, onToggle, onAssign, onOpen, onRemove, onReorder }) {
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
function DoseControl({ label, value, minusLabel, plusLabel, pending, onCommit }) {
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

export function PatientDay({ entryId, initial, pulse, live = true, onBack }) {
  const [entry, setEntry] = useState(null)
  const [staff, setStaff] = useState([])
  const [patients, setPatients] = useState([])
  // 常见搭配表：随 entryView 一起来，加项面板照它出芯片。
  const [pairings, setPairings] = useState({})
  // 名单只有一个人时收起全部派工界面：项目自动记在那人名下（服务端本来就会这么派）。
  const solo = staff.length === 1
  const [templates, setTemplates] = useState([])
  const [me, setMe] = useState(null)
  const [notice, setNotice] = useState(blankNotice)
  const [pastMidnight, setPastMidnight] = useState(false)
  const [reselecting, setReselecting] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [itemAssignId, setItemAssignId] = useState(null)
  const [activeItemId, setActiveItemId] = useState(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyMode, setCopyMode] = useState("archive")
  const [leaveAsk, setLeaveAsk] = useState(false)
  const [pending, setPending] = useState(false)
  const [conditionName, setConditionName] = useState("")
  const [copyConditionId, setCopyConditionId] = useState("")
  const [copyPatientId, setCopyPatientId] = useState("")
  const [saveTmplOpen, setSaveTmplOpen] = useState(false)
  const [applyTmplOpen, setApplyTmplOpen] = useState(false)
  const [templateName, setTemplateName] = useState("")
  const [undo, setUndo] = useState(null)
  const [listOpen, setListOpen] = useState(false)
  const [listQuery, setListQuery] = useState("")
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState("")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameText, setRenameText] = useState("")
  const [manageOpen, setManageOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [bodyGroup, setBodyGroup] = useState(null)
  // 人体收起是本机偏好：开完单只看清单的人不用每次都等模型。
  const [modelTucked, setModelTucked] = useState(() => {
    try {
      return localStorage.getItem("physio-model-tucked") === "1"
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem("physio-model-tucked", modelTucked ? "1" : "0")
    } catch {
      /* 隐私模式存不进去就算了，本次会话内仍然生效 */
    }
  }, [modelTucked])
  const pendingRef = useRef(false)
  const mountedRef = useRef(true)
  const backLock = useRef(false)
  const tailRef = useRef(Promise.resolve())
  const queueDepthRef = useRef(0)
  const staleRef = useRef(false)
  const entryVersionRef = useRef(0)
  const onSelectRef = useRef(() => {})
  const stableSelect = useCallback((targetId, side) => onSelectRef.current(targetId, side), [])

  // 返回键分层：重选模式 → 弹层 → 病人页本体（含「记回病症」提醒），按一次关一层。
  const anySheet = Boolean(
    leaveAsk ||
      assignOpen ||
      itemAssignId ||
      activeItemId ||
      bodyGroup ||
      copyOpen ||
      saveTmplOpen ||
      applyTmplOpen ||
      listOpen ||
      noteOpen ||
      historyOpen ||
      renameOpen ||
      manageOpen ||
      moreOpen,
  )
  useBackLayer(Boolean(entryId), handleBack)
  useBackLayer(anySheet, () => {
    closeSheets()
    setLeaveAsk(false)
  })
  useBackLayer(reselecting, () => setReselecting(false))

  const applyResult = useCallback((result) => {
    if (!result) return
    if (result.entry) {
      setEntry(result.entry)
      entryVersionRef.current = Number(result.entry.version) || 0
    }
    if (result.staff) setStaff(result.staff)
    if (result.patients) setPatients(result.patients)
    if (result.templates) setTemplates(result.templates)
    if (result.pairings) setPairings(result.pairings)
    if (Object.prototype.hasOwnProperty.call(result, "me")) setMe(result.me)
  }, [])

  function withVersion(call) {
    return call(entryVersionRef.current)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let gone = false
    setLeaveAsk(false)
    setReselecting(false)
    setAssignOpen(false)
    setItemAssignId(null)
    setActiveItemId(null)
    setBodyGroup(null)
    setCopyOpen(false)
    setSaveTmplOpen(false)
    setApplyTmplOpen(false)
    setListOpen(false)
    setListQuery("")
    setUndo(null)
    setMoreOpen(false)
    setCopyMode("archive")
    setNotice(blankNotice)
    setPastMidnight(false)
    setRenameOpen(false)
    setManageOpen(false)
    // 开单类接口的返回就是这张单的最新视图：带着进来就不再拉第一次。
    if (initial?.entry && initial.entry.id === entryId) {
      applyResult(initial)
      return undefined
    }
    api
      .entry(entryId)
      .then((result) => {
        if (!gone) applyResult(result)
      })
      .catch((err) => {
        if (!gone) {
          if (isPastMidnightError(err)) {
            setPastMidnight(true)
            setNotice(pastMidnightNotice)
          } else {
            setNotice({ text: err.message || "未能保存", tone: "error" })
          }
        }
      })
    return () => {
      gone = true
    }
  }, [entryId, initial, applyResult])

  // 别的手机改了这张单：拉一次最新的。自己改动排队中则先记过期，队空后再补拉。
  useEffect(() => {
    if (!pulse) return
    if (queueDepthRef.current > 0 || pendingRef.current) {
      staleRef.current = true
      return
    }
    if (!mountedRef.current) return
    api
      .entry(entryId)
      .then(applyResult)
      .catch((err) => {
        if (isPastMidnightError(err) && mountedRef.current) {
          setPastMidnight(true)
          setNotice(pastMidnightNotice)
        }
      })
  }, [pulse])

  // 撤销条停 10 秒，过了就沉下去：滑错手后有足够时间反应，又不会一直挂着。
  useEffect(() => {
    if (!undo) return undefined
    const timer = setTimeout(() => setUndo(null), 10_000)
    return () => clearTimeout(timer)
  }, [undo])

  function refreshIfStale() {
    if (!staleRef.current || queueDepthRef.current > 0) return
    if (!mountedRef.current) return
    staleRef.current = false
    api
      .entry(entryId)
      .then((result) => {
        if (mountedRef.current) applyResult(result)
      })
      .catch((err) => {
        if (isPastMidnightError(err) && mountedRef.current) {
          setPastMidnight(true)
          setNotice(pastMidnightNotice)
        }
      })
  }

  async function reloadEntryKeepNotice() {
    try {
      const latest = await api.entry(entryId)
      if (mountedRef.current) applyResult(latest)
    } catch (err) {
      if (isPastMidnightError(err) && mountedRef.current) {
        setPastMidnight(true)
        setNotice(pastMidnightNotice)
      }
    }
  }

  function enqueue(task) {
    queueDepthRef.current += 1
    const run = tailRef.current.then(task, task)
    tailRef.current = run.then(
      () => {
        queueDepthRef.current = Math.max(0, queueDepthRef.current - 1)
        if (queueDepthRef.current === 0) refreshIfStale()
      },
      () => {
        queueDepthRef.current = Math.max(0, queueDepthRef.current - 1)
        if (queueDepthRef.current === 0) refreshIfStale()
      },
    )
    return run
  }

  function mutate(work, options = {}) {
    return enqueue(async () => {
      if (!mountedRef.current) return false
      pendingRef.current = true
      setPending(true)
      try {
        const result = await work()
        if (!mountedRef.current) return true
        applyResult(result)
        setNotice(options.success ? { text: options.success, tone: "ok" } : blankNotice)
        return true
      } catch (err) {
        if (!mountedRef.current) return false
        if (isPastMidnightError(err)) {
          setPastMidnight(true)
          setNotice(pastMidnightNotice)
          return false
        }
        const failText = isConflictError(err)
          ? err.message || "别人刚改过这张单，请重新拉取"
          : options.fail || err?.message || "未能保存"
        setNotice({ text: failText, tone: "error" })
        // 改单失败（尤其重排/冲突）后拉回服务器清单，别停在过期预览上。
        await reloadEntryKeepNotice()
        return false
      } finally {
        pendingRef.current = false
        if (mountedRef.current) setPending(false)
      }
    })
  }

  function markPastMidnight() {
    setPastMidnight(true)
    setNotice(pastMidnightNotice)
    setLeaveAsk(false)
  }

  function handleBack() {
    if (pastMidnight) {
      onBack()
      return
    }
    if (leaveAsk || backLock.current) return
    backLock.current = true
    return enqueue(async () => {
      if (!mountedRef.current) return
      pendingRef.current = true
      setPending(true)
      try {
        const latest = await api.entry(entryId)
        if (!mountedRef.current) return
        applyResult(latest)
        // 只在改过且这轮还没答过时问；答过「留在今天」后反复进出不再打扰。
        if (latest.entry?.leaveAsk) {
          setAssignOpen(false)
          setItemAssignId(null)
          setCopyOpen(false)
          setActiveItemId(null)
          setBodyGroup(null)
          setMoreOpen(false)
          setSaveTmplOpen(false)
          setApplyTmplOpen(false)
          setListOpen(false)
          setNoteOpen(false)
          setHistoryOpen(false)
          setRenameOpen(false)
          setManageOpen(false)
          setNotice(blankNotice)
          setLeaveAsk(true)
          return
        }
        // leave 的返回值就是最新视图：直接带回今日单，省一次重拉。
        const left = await api.leave(entryId, false)
        if (!mountedRef.current) return
        onBack(left)
      } catch (err) {
        if (!mountedRef.current) return
        // 过了零点别再 leave：提示后返回键直接回今日单。
        if (isPastMidnightError(err)) {
          markPastMidnight()
          return
        }
        setNotice({ text: "未能保存", tone: "error" })
      } finally {
        pendingRef.current = false
        backLock.current = false
        if (mountedRef.current) setPending(false)
      }
    })
  }

  function finishLeave(updateCondition) {
    if (pastMidnight) {
      onBack()
      return
    }
    if (backLock.current) return
    backLock.current = true
    return enqueue(async () => {
      if (!mountedRef.current) return
      pendingRef.current = true
      setPending(true)
      try {
        const left = await api.leave(entryId, updateCondition)
        if (!mountedRef.current) return
        onBack(left)
      } catch (err) {
        if (!mountedRef.current) return
        if (isPastMidnightError(err)) {
          markPastMidnight()
          return
        }
        setNotice({ text: "未能保存", tone: "error" })
      } finally {
        pendingRef.current = false
        backLock.current = false
        if (mountedRef.current) setPending(false)
      }
    })
  }

  async function onSelect(targetId, side) {
    if (!entry) return
    const target = targetById(targetId)
    const pickedSide = hasSides(target) ? side || null : null
    if (!entry.chiefSiteId || reselecting) {
      if (!allowsChief(target)) return
      const ok = await mutate(() => api.setChief(entryId, targetId, pickedSide))
      if (ok) setReselecting(false)
      return
    }
    if (targetId === entry.chiefSiteId) {
      if (hasSides(target) && pickedSide && pickedSide !== (entry.chiefSide || null)) {
        await mutate(() => api.setChief(entryId, targetId, pickedSide))
        return
      }
      setNotice(blankNotice)
      setReselecting(true)
      return
    }
    if (allowsWork(target)) {
      if (!entry.chiefSiteId) {
        setNotice({ text: "先点要治的地方", tone: "error" })
        return
      }
      const existing = itemsOnSpot(entry.items, targetId, pickedSide)
      if (existing.length) {
        setNotice(blankNotice)
        closeSheets()
        setBodyGroup({ targetId, side: pickedSide })
        return
      }
      await mutate(() => api.addItem(entryId, targetId, pickedSide))
    }
  }
  onSelectRef.current = onSelect

  function personLabel(person) {
    return me?.id === person.id ? `${person.name} · 我` : person.name
  }

  function closeSheets() {
    setAssignOpen(false)
    setItemAssignId(null)
    setActiveItemId(null)
    setBodyGroup(null)
    setCopyOpen(false)
    setSaveTmplOpen(false)
    setApplyTmplOpen(false)
    setListOpen(false)
    setNoteOpen(false)
    setHistoryOpen(false)
    setRenameOpen(false)
    setManageOpen(false)
    setMoreOpen(false)
  }

  async function submitCondition(event) {
    event.preventDefault()
    const ok = await mutate(() => api.addCondition(entryId, conditionName.trim()))
    if (ok) setConditionName("")
  }

  async function submitCopy() {
    const conditionOk = (entry?.conditionIds || []).includes(copyConditionId)
    if (!conditionOk || !copyPatientId) {
      setNotice({ text: "先选择病症和病人", tone: "error" })
      return
    }
    const fromToday = copyMode === "today"
    const ok = await mutate(
      () => api.copyCondition(copyConditionId, copyPatientId, fromToday ? { fromToday: true } : {}),
      {
        success: fromToday ? "已复制今天这套，派给谁要重新填" : "已复制，派给谁要重新填",
      },
    )
    if (ok) {
      setCopyPatientId("")
      setCopyOpen(false)
    }
  }

  // 左滑去掉之后给反悔的机会：先删，撤销用 restore 把完整快照插回原位。
  function removeWithUndo(itemId) {
    const snapshot = entry?.items || []
    const index = snapshot.findIndex((item) => item.id === itemId)
    const item = index >= 0 ? itemSnapshot(snapshot[index]) : null
    // 撤销校验用：删完之后清单本来的样子，服务端对得上才按原位插回。
    const afterIds = snapshot.filter((row) => row.id !== itemId).map((row) => row.id)
    let removedElsewhere = false
    setUndo(null)
    return mutate(
      () =>
        api.removeItem(entryId, itemId, entry?.version).catch(async (err) => {
          // 撞单（409）先重拉：项还在就自动再删一次；已经没了说明别人删过，也算达成。
          if (!isConflictError(err)) throw err
          const fresh = await api.entry(entryId)
          const stillThere = fresh.entry?.items?.some((row) => row.id === itemId)
          if (!stillThere) {
            removedElsewhere = true
            return fresh
          }
          return api.removeItem(entryId, itemId, fresh.entry?.version)
        }),
      { fail: "未能保存" },
    ).then((ok) => {
      if (ok && item && !removedElsewhere) setUndo({ item, index, afterIds })
    })
  }

  function undoRemove() {
    const target = undo
    if (!target) return
    setUndo(null)
    mutate(() => api.restoreItem(entryId, target.index, target.item, target.afterIds), {
      success: "已恢复",
      fail: "未能恢复",
    })
  }

  async function submitTemplate(event) {
    event.preventDefault()
    const conditionId =
      (entry?.conditionIds || []).length === 1 ? entry.conditionIds[0] : entry?.focusConditionId || null
    const ok = await mutate(() => api.saveTemplateFromEntry(entryId, conditionId, templateName.trim()), {
      success: "已存为模板",
    })
    if (ok) {
      setTemplateName("")
      setSaveTmplOpen(false)
    }
  }

  function applyTemplate(templateId) {
    mutate(() => api.applyTemplateToEntry(entryId, templateId), { success: "模板已加入今天" }).then((ok) => {
      if (ok) setApplyTmplOpen(false)
    })
  }

  // 「说一句」的解析结果一次入库，面板留着继续说下一句。
  function quickAddParsed(parsed, afterSave) {
    if (parsed.items.length && !parsed.chief && !entry?.chiefSiteId) {
      setNotice({ text: "先点要治的地方", tone: "error" })
      return
    }
    mutate(() => api.quickAdd(entryId, parsed), {
      success: parsed.items.length ? `已加 ${parsed.items.length} 项` : "已记要治的地方",
      fail: "未能保存",
    }).then((ok) => {
      if (ok) afterSave?.()
    })
  }

  async function submitNote(event) {
    event.preventDefault()
    const ok = await mutate(
      async () => {
        await api.setPatientNote(entry.patientId, noteText)
        return api.entry(entryId)
      },
      { success: "备注已存", fail: "未能保存" },
    )
    if (ok) setNoteOpen(false)
  }

  async function submitRename(event) {
    event.preventDefault()
    const trimmed = renameText.trim()
    if (!trimmed) {
      setNotice({ text: "请填写病人姓名", tone: "error" })
      return
    }
    const clash = patients.find((patient) => patient.id !== entry.patientId && patient.name === trimmed)
    if (clash) {
      setNotice({ text: `已有叫${trimmed}的病人`, tone: "error" })
      return
    }
    const ok = await mutate(
      async () => {
        await api.renamePatient(entry.patientId, trimmed)
        return api.entry(entryId)
      },
      { success: "姓名已改", fail: "未能保存" },
    )
    if (ok) setRenameOpen(false)
  }

  function archivePatient() {
    if (!window.confirm(`把「${entry.patientName}」归档？之后不会出现在加入病人列表里，今日单和历史仍保留。`)) {
      return
    }
    mutate(
      async () => {
        await api.setPatientArchived(entry.patientId, true)
        return api.entry(entryId)
      },
      { success: "已归档", fail: "未能保存" },
    ).then((ok) => {
      if (ok) setManageOpen(false)
    })
  }

  function unarchivePatient() {
    mutate(
      async () => {
        await api.setPatientArchived(entry.patientId, false)
        return api.entry(entryId)
      },
      { success: "已取消归档", fail: "未能保存" },
    ).then((ok) => {
      if (ok) setManageOpen(false)
    })
  }

  function removeUnusedCondition(condition) {
    if (!window.confirm(`删除病症「${condition.name}」？只有从没上过任何一天单的病症才能删。`)) {
      return
    }
    mutate(
      async () => {
        await api.deleteCondition(entry.patientId, condition.id)
        return api.entry(entryId)
      },
      { fail: "未能删除" },
    )
  }

  function dropToday() {
    if (pastMidnight) {
      onBack()
      return
    }
    if (!window.confirm(`把「${entry.patientName}」从今日单拿掉？`)) {
      return
    }
    if (backLock.current) return
    backLock.current = true
    return enqueue(async () => {
      if (!mountedRef.current) return
      pendingRef.current = true
      setPending(true)
      try {
        await api.leave(entryId, false)
        // dropEntry 的返回是去掉这张单之后的今日单视图，同样直接带回。
        const dropped = await api.dropEntry(entryId)
        if (!mountedRef.current) return
        onBack(dropped)
      } catch (err) {
        if (!mountedRef.current) return
        if (isPastMidnightError(err)) {
          markPastMidnight()
          return
        }
        setNotice({ text: "未能保存", tone: "error" })
        await reloadEntryKeepNotice()
      } finally {
        pendingRef.current = false
        backLock.current = false
        if (mountedRef.current) setPending(false)
      }
    })
  }

  // 过了零点还在治：把昨天没做完的就地接进今天，不用退出去加入病人里翻找。
  function carryIntoToday() {
    if (!entry && !entryId) return
    if (backLock.current) return
    backLock.current = true
    return enqueue(async () => {
      if (!mountedRef.current) return
      pendingRef.current = true
      setPending(true)
      try {
        // 返回值就是接好后的最新视图，直接带回今日单。
        const carried = await api.carryUnfinished(entry?.patientId, entryId)
        if (!mountedRef.current) return
        onBack(carried)
      } catch (err) {
        if (!mountedRef.current) return
        if (isPastMidnightError(err)) return
        setNotice({ text: err?.message || "未能接进今天", tone: "error" })
      } finally {
        pendingRef.current = false
        backLock.current = false
        if (mountedRef.current) setPending(false)
      }
    })
  }

  // 过了零点：无论有没有加载出 entry，都给退回今日单的出路，不再 leave。
  if (!entry || pastMidnight) {
    return (
      <main className="patient-day">
        <header className="patient-top">
          <button type="button" className="back" onClick={pastMidnight ? onBack : handleBack}>
            返回
          </button>
        </header>
        <p className={notice.text ? "patient-notice is-error" : "patient-status"}>
          {pastMidnight ? pastMidnightNotice.text : notice.text || "正在打开…"}
        </p>
        {pastMidnight ? (
          <button type="button" className="primary patient-carry" disabled={pending} onClick={carryIntoToday}>
            把这张单没做完的接到今天
          </button>
        ) : null}
        {notice.text && pastMidnight ? <p className="patient-notice is-error">{notice.text}</p> : null}
      </main>
    )
  }

  const activeItem = entry.items?.find((item) => item.id === activeItemId) || null
  const assignItem = entry.items?.find((item) => item.id === itemAssignId) || null
  const bodyGroupItems = bodyGroup
    ? itemsOnSpot(entry.items, bodyGroup.targetId, bodyGroup.side)
    : []
  const entryConditions = (entry.conditionIds || [])
    .map((id) => entry.conditions?.find((condition) => condition.id === id))
    .filter(Boolean)
  const names = conditionText(entry)
  const covering =
    assignOpen ||
    Boolean(assignItem) ||
    Boolean(bodyGroup) ||
    copyOpen ||
    saveTmplOpen ||
    applyTmplOpen ||
    listOpen ||
    noteOpen ||
    historyOpen ||
    renameOpen ||
    manageOpen ||
    moreOpen ||
    Boolean(activeItem) ||
    leaveAsk
  const focusName = entryConditions.length
    ? (entryConditions.find((condition) => condition.id === entry.focusConditionId) || entryConditions[0]).name
    : ""
  const firstUndone = (entry.items || []).findIndex((item) => !item.done)
  const unusedConditions = (entry.conditions || []).filter(
    (condition) => !(entry.conditionIds || []).includes(condition.id),
  )
  const renameClash =
    renameText.trim() &&
    patients.find((patient) => patient.id !== entry.patientId && patient.name === renameText.trim())

  return (
    <main className="patient-day">
      <header className="patient-top">
        <button type="button" className="back" onClick={handleBack}>
          返回
        </button>
        <h1>{entry.patientName}</h1>
        {live === false ? (
          <p className="patient-offline" role="status">连接断了，正在重连…恢复后自动刷新</p>
        ) : null}
        {entry.archived ? <p className="muted">已归档 · 不会出现在加入病人列表</p> : null}
        {names ? <p className="patient-conditions">{names}</p> : null}
        {entry.note ? (
          <p className="patient-note" role="note">{`⚠ ${entry.note}`}</p>
        ) : null}
        {entryConditions.length > 1 ? (
          <div className="patient-focus">
            {entryConditions.map((condition) => (
              <button
                key={condition.id}
                type="button"
                className={entry.focusConditionId === condition.id ? "patient-chip is-on" : "patient-chip"}
                disabled={pending}
                onClick={() => mutate(() => api.setFocus(entryId, condition.id))}
              >
                {condition.name}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <div className={modelTucked ? "patient-stage is-tucked" : "patient-stage"}>
        {modelTucked ? (
          <div className="patient-stage-tucked">
            <span>{entry.chiefSiteId ? `要治 ${targetTitle(entry.chiefSiteId, entry.chiefSide)}` : "人体已收起"}</span>
            {/* 收起/展开是纯本地状态，不等保存：开单慢时也要能马上把清单放大。 */}
            <button type="button" className="secondary" onClick={() => setModelTucked(false)}>
              展开人体
            </button>
          </div>
        ) : (
          <>
            <button type="button" className="patient-stage-tuck" onClick={() => setModelTucked(true)}>
              收起人体
            </button>
            <BodyStage
              chiefSiteId={entry.chiefSiteId}
              chiefSide={entry.chiefSide}
              items={entry.items || []}
              reselecting={reselecting}
              onSelect={stableSelect}
            />
          </>
        )}
      </div>

      <div className="patient-lower">
        {reselecting ? <p className="patient-hint">再点一个地方，改要治的位置</p> : null}
        {!entry.chiefSiteId && !reselecting ? (
          <p className="patient-hint">先点要治的地方，例如膝盖、腰、肩或颈。之后点的才是下手的肌肉或节点。</p>
        ) : null}
        {entry.chiefSiteId ? <p className="patient-hint">要治 {targetTitle(entry.chiefSiteId, entry.chiefSide)}</p> : null}
        {!covering ? <Notice notice={notice} /> : null}
        <PlanList
          items={entry.items || []}
          currentIndex={firstUndone}
          solo={solo}
          onToggle={(item) =>
            mutate(() => withVersion((v) => api.patchItem(entryId, item.id, { done: !item.done }, v)), {
              fail: "未能保存",
            })
          }
          onAssign={(item) => {
            setNotice(blankNotice)
            closeSheets()
            setItemAssignId(item.id)
          }}
          onOpen={(itemId) => {
            setNotice(blankNotice)
            closeSheets()
            setActiveItemId(itemId)
          }}
          onRemove={removeWithUndo}
          onReorder={(orderedIds) =>
            mutate(() => withVersion((v) => api.reorder(entryId, orderedIds, v)), { fail: "未能保存" })
          }
        />
        {undo ? (
          <div className="patient-undo" role="status">
            <span>{`已去掉 ${targetTitle(undo.item.targetId, undo.item.side)}`}</span>
            <button type="button" className="patient-undo-btn" disabled={pending} onClick={undoRemove}>
              撤销
            </button>
          </div>
        ) : null}
        <div className="patient-actions">
          {/* 一个「加项」进面板：顶上是说一句，往下是搜名单，不再分两个按钮。 */}
          <button
            type="button"
            className={(entry.items?.length || 0) === 0 ? "primary" : "secondary"}
            disabled={pending}
            onClick={() => {
              setNotice(blankNotice)
              closeSheets()
              setListOpen(true)
            }}
          >
            加项
          </button>
          {entry.items?.length > 0 && !solo ? (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => {
                setNotice(blankNotice)
                closeSheets()
                setAssignOpen(true)
              }}
            >
              全部派给
            </button>
          ) : null}
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => {
              setNotice(blankNotice)
              closeSheets()
              setMoreOpen(true)
            }}
          >
            更多
          </button>
        </div>
      </div>

      {moreOpen && !leaveAsk ? (
        <Sheet title="更多" onClose={() => setMoreOpen(false)}>
          <Notice notice={notice} />
          {entry.items?.length > 0 ? (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => {
                setMoreOpen(false)
                setTemplateName(focusName)
                setSaveTmplOpen(true)
              }}
            >
              存为模板
            </button>
          ) : null}
          {templates.length ? (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => {
                setMoreOpen(false)
                setApplyTmplOpen(true)
              }}
            >
              套用模板
            </button>
          ) : null}
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => {
              setMoreOpen(false)
              setNoteText(entry.note || "")
              setNoteOpen(true)
            }}
          >
            备注
          </button>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => {
              setMoreOpen(false)
              setHistoryOpen(true)
            }}
          >
            来过几次
          </button>
          <form className="patient-add" onSubmit={submitCondition}>
            <input
              value={conditionName}
              onChange={(event) => setConditionName(event.target.value)}
              placeholder="病症名称"
              aria-label="病症名称"
              enterKeyHint="done"
            />
            <button type="submit" className="secondary" disabled={pending}>
              再加一条病症
            </button>
          </form>
          {(entry.conditions || [])
            .filter((condition) => !(entry.conditionIds || []).includes(condition.id) && condition.items?.length)
            .map((condition) => (
              <button
                key={condition.id}
                type="button"
                className="secondary"
                disabled={pending}
                onClick={() => mutate(() => api.includeCondition(entryId, condition.id))}
              >
                {`把「${condition.name}」加入今天`}
              </button>
            ))}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setMoreOpen(false)
              const ids = entry.conditionIds || []
              if (ids.length === 1) setCopyConditionId(ids[0])
              setCopyMode("archive")
              setCopyOpen(true)
            }}
          >
            复制
          </button>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => {
              setMoreOpen(false)
              dropToday()
            }}
          >
            从今日单拿掉
          </button>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => {
              setMoreOpen(false)
              setRenameText(entry.patientName || "")
              setRenameOpen(true)
            }}
          >
            改姓名
          </button>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => {
              setMoreOpen(false)
              setManageOpen(true)
            }}
          >
            档案
          </button>
          <button type="button" className="secondary" onClick={() => setMoreOpen(false)}>
            收起
          </button>
        </Sheet>
      ) : null}

      {assignOpen && !leaveAsk ? (
        <Sheet title="全部派给" onClose={() => setAssignOpen(false)}>
          <Notice notice={notice} />
          {entry.lastAssigneeId ? (
            <div className="patient-stack">
              <button
                type="button"
                className="patient-choice is-last"
                disabled={pending}
                onClick={async () => {
                  const ok = await mutate(
                    () => withVersion((v) => api.assignAll(entryId, entry.lastAssigneeId, v)),
                    { fail: "未能保存" },
                  )
                  if (ok) setAssignOpen(false)
                }}
              >
                {`上次：${entry.lastAssigneeName}（照旧）`}
              </button>
            </div>
          ) : null}
          <div className="patient-stack">
            {staff.map((person) => (
              <button
                type="button"
                key={person.id}
                className="patient-choice"
                disabled={pending}
                onClick={async () => {
                  const ok = await mutate(() => withVersion((v) => api.assignAll(entryId, person.id, v)), {
                    fail: "未能保存",
                  })
                  if (ok) setAssignOpen(false)
                }}
              >
                {personLabel(person)}
              </button>
            ))}
          </div>
        </Sheet>
      ) : null}

      {assignItem && !leaveAsk ? (
        <Sheet title="派给谁" onClose={() => setItemAssignId(null)}>
          <Notice notice={notice} />
          <p className="patient-label">{targetTitle(assignItem.targetId, assignItem.side)}</p>
          <div className="patient-stack">
            {staff.map((person) => (
              <button
                type="button"
                key={person.id}
                className={assignItem.assigneeId === person.id ? "patient-choice is-on" : "patient-choice"}
                aria-pressed={assignItem.assigneeId === person.id}
                disabled={pending}
                onClick={async () => {
                  if (assignItem.assigneeId === person.id) {
                    setItemAssignId(null)
                    return
                  }
                  const ok = await mutate(
                    () => withVersion((v) => api.patchItem(entryId, assignItem.id, { assigneeId: person.id }, v)),
                    { fail: "未能保存" },
                  )
                  if (ok) setItemAssignId(null)
                }}
              >
                {personLabel(person)}
              </button>
            ))}
          </div>
        </Sheet>
      ) : null}

      {bodyGroup && !assignItem && !leaveAsk ? (
        <Sheet
          title={targetTitle(bodyGroup.targetId, bodyGroup.side)}
          onClose={() => setBodyGroup(null)}
        >
          <Notice notice={notice} />
          <div className="patient-stack">
            {bodyGroupItems.map((item, index) => (
              <div key={item.id} className={item.done ? "patient-body-item is-done" : "patient-body-item"}>
                <button
                  type="button"
                  className="patient-body-item-main"
                  disabled={pending}
                  onClick={() => {
                    setActiveItemId(item.id)
                    setBodyGroup(null)
                  }}
                >
                  <span className="patient-body-item-title">
                    {`${index + 1}. ${techniqueLabel(item.technique)} · ${directionLabel(item.direction)}`}
                  </span>
                  <span className="patient-body-item-meta">
                    {[doseLabel(item.technique, item.dose), item.done ? "已完成" : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
                {!solo ? (
                  <button
                    type="button"
                    className={item.assigneeId ? "patient-who" : "patient-who is-empty"}
                    disabled={pending}
                    aria-label={item.assigneeName ? `派给 ${item.assigneeName}` : "派给谁"}
                    onClick={() => setItemAssignId(item.id)}
                  >
                    {item.assigneeName || "未派"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="primary"
            disabled={pending}
            onClick={() =>
              mutate(() => api.addItem(entryId, bodyGroup.targetId, bodyGroup.side), {
                success: "已再加一项",
                fail: "未能保存",
              })
            }
          >
            再加一项
          </button>
          <button type="button" className="secondary" onClick={() => setBodyGroup(null)}>
            收起
          </button>
        </Sheet>
      ) : null}

      {saveTmplOpen && !leaveAsk ? (
        <Sheet title="存为模板" onClose={() => setSaveTmplOpen(false)}>
          <Notice notice={notice} />
          <p className="patient-label">{`把「${focusName}」今天这套存成模板，下次新病人一键套用`}</p>
          <form
            className="stack"
            noValidate
            onSubmit={submitTemplate}
          >
            <label className="field">
              模板名称
              <input
                value={templateName}
                autoComplete="off"
                enterKeyHint="done"
                onChange={(event) => setTemplateName(event.target.value)}
              />
            </label>
            <button className="primary" type="submit" disabled={pending}>存下</button>
          </form>
        </Sheet>
      ) : null}

      {applyTmplOpen && !leaveAsk ? (
        <Sheet title="套用模板" onClose={() => setApplyTmplOpen(false)}>
          <Notice notice={notice} />
          <p className="muted">选一条模板，作为新病症加入今天。</p>
          <div className="patient-stack">
            {templates.map((template) => (
              <button
                type="button"
                key={template.id}
                className="patient-choice"
                disabled={pending}
                onClick={() => applyTemplate(template.id)}
              >
                {`${template.name} · ${template.itemCount} 项`}
              </button>
            ))}
          </div>
        </Sheet>
      ) : null}

      {activeItem && !leaveAsk ? (
        <Sheet title={targetTitle(activeItem.targetId, activeItem.side)} onClose={() => setActiveItemId(null)}>
          <Notice notice={notice} />
          <p className="patient-label">手法</p>
          <div className="patient-techniques">
            {TECHNIQUES.map((technique) => (
              <button
                type="button"
                key={technique.id}
                className={activeItem.technique === technique.id ? "patient-choice is-on" : "patient-choice"}
                aria-pressed={activeItem.technique === technique.id}
                disabled={pending}
                onClick={() => {
                  if (activeItem.technique === technique.id) return
                  // 换进/换出器械时剂量会重置成默认组次：明说，别让 12 分钟悄悄变 3组×10次。
                  const crossesEquipment =
                    activeItem.technique === "equipment" || technique.id === "equipment"
                  mutate(
                    () => withVersion((v) => api.patchItem(entryId, activeItem.id, { technique: technique.id }, v)),
                    {
                      fail: "未能保存",
                      ...(crossesEquipment ? { success: "剂量已按新手法重置，看一眼再走" } : {}),
                    },
                  )
                }}
              >
                {technique.label}
              </button>
            ))}
          </div>
          <p className="patient-label">方向</p>
          <div className="patient-directions">
            {DIRECTIONS.map((direction) => (
              <button
                type="button"
                key={direction.id}
                className={activeItem.direction === direction.id ? "patient-choice is-on" : "patient-choice"}
                aria-pressed={activeItem.direction === direction.id}
                disabled={pending}
                onClick={() => {
                  if (activeItem.direction === direction.id) return
                  mutate(
                    () => withVersion((v) => api.patchItem(entryId, activeItem.id, { direction: direction.id }, v)),
                    { fail: "未能保存" },
                  )
                }}
              >
                {direction.label}
              </button>
            ))}
          </div>
          {hasSides(targetById(activeItem.targetId)) ? (
            <>
              <p className="patient-label">侧别</p>
              <div className="patient-directions">
                {["left", "right"].map((side) => (
                  <button
                    type="button"
                    key={side}
                    className={activeItem.side === side ? "patient-choice is-on" : "patient-choice"}
                    aria-pressed={activeItem.side === side}
                    disabled={pending}
                    onClick={() => {
                      if (activeItem.side === side) return
                      mutate(
                        () => withVersion((v) => api.patchItem(entryId, activeItem.id, { side }, v)),
                        { fail: "未能保存" },
                      )
                    }}
                  >
                    {side === "left" ? "左" : "右"}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <p className="patient-label">剂量</p>
          <div className="patient-stack">
            {activeItem.technique === "equipment" ? (
              <>
                <DoseControl
                  label="组"
                  value={numeric(activeItem.dose?.sets, 1)}
                  minusLabel="减少组数"
                  plusLabel="增加组数"
                  pending={pending}
                  onCommit={(delta) => {
                    const sets = numeric(activeItem.dose?.sets, 1)
                    const reps = numeric(activeItem.dose?.reps, 1)
                    const next = Math.max(1, sets + delta)
                    if (next === sets) return
                    mutate(
                      () =>
                        withVersion((v) =>
                          api.patchItem(entryId, activeItem.id, { dose: { sets: next, reps } }, v),
                        ),
                      { fail: "未能保存" },
                    )
                  }}
                />
                <DoseControl
                  label="次"
                  value={numeric(activeItem.dose?.reps, 1)}
                  minusLabel="减少次数"
                  plusLabel="增加次数"
                  pending={pending}
                  onCommit={(delta) => {
                    const sets = numeric(activeItem.dose?.sets, 1)
                    const reps = numeric(activeItem.dose?.reps, 1)
                    const next = Math.max(1, reps + delta)
                    if (next === reps) return
                    mutate(
                      () =>
                        withVersion((v) =>
                          api.patchItem(entryId, activeItem.id, { dose: { sets, reps: next } }, v),
                        ),
                      { fail: "未能保存" },
                    )
                  }}
                />
              </>
            ) : (
              <DoseControl
                label="分钟"
                value={numeric(activeItem.dose?.minutes, 1)}
                minusLabel="减少分钟"
                plusLabel="增加分钟"
                pending={pending}
                onCommit={(delta) => {
                  const minutes = numeric(activeItem.dose?.minutes, 1)
                  const next = Math.max(1, minutes + delta)
                  if (next === minutes) return
                  mutate(
                    () => withVersion((v) => api.patchItem(entryId, activeItem.id, { dose: { minutes: next } }, v)),
                    { fail: "未能保存" },
                  )
                }}
              />
            )}
          </div>
          <p className="patient-label">派给谁</p>
          <div className="patient-stack">
            {staff.map((person) => (
              <button
                type="button"
                key={person.id}
                className={activeItem.assigneeId === person.id ? "patient-choice is-on" : "patient-choice"}
                aria-pressed={activeItem.assigneeId === person.id}
                disabled={pending}
                onClick={() => {
                  if (activeItem.assigneeId === person.id) return
                  mutate(
                    () => withVersion((v) => api.patchItem(entryId, activeItem.id, { assigneeId: person.id }, v)),
                    { fail: "未能保存" },
                  )
                }}
              >
                {personLabel(person)}
              </button>
            ))}
          </div>
          <button type="button" className="secondary" onClick={() => setActiveItemId(null)}>
            收起
          </button>
        </Sheet>
      ) : null}

      {copyOpen && !leaveAsk ? (
        <Sheet title="复制" onClose={() => setCopyOpen(false)}>
          <Notice notice={notice} />
          <p className="patient-label">复制什么</p>
          <div className="patient-stack">
            <button
              type="button"
              className={copyMode === "archive" ? "patient-choice is-on" : "patient-choice"}
              aria-pressed={copyMode === "archive"}
              onClick={() => setCopyMode("archive")}
            >
              复制病症存档
            </button>
            <button
              type="button"
              className={copyMode === "today" ? "patient-choice is-on" : "patient-choice"}
              aria-pressed={copyMode === "today"}
              onClick={() => setCopyMode("today")}
            >
              复制今天这套
            </button>
          </div>
          {copyMode === "archive" && entry.diverged ? (
            <p className="muted">今天的改动还没写回病症，存档可能不是今天这套。</p>
          ) : null}
          <p className="patient-label">这一张单上的病症</p>
          <div className="patient-stack">
            {entryConditions.map((condition) => (
              <button
                type="button"
                key={condition.id}
                className={copyConditionId === condition.id ? "patient-choice is-on" : "patient-choice"}
                aria-pressed={copyConditionId === condition.id}
                onClick={() => setCopyConditionId(condition.id)}
              >
                {condition.name}
              </button>
            ))}
          </div>
          <p className="patient-label">复制到</p>
          <div className="patient-stack">
            {patients
              .filter((patient) => patient.id !== entry.patientId && !patient.archived)
              .map((patient) => (
              <button
                type="button"
                key={patient.id}
                className={copyPatientId === patient.id ? "patient-choice is-on" : "patient-choice"}
                aria-pressed={copyPatientId === patient.id}
                onClick={() => setCopyPatientId(patient.id)}
              >
                {patient.name}
              </button>
            ))}
          </div>
          <button type="button" className="primary" disabled={pending} onClick={submitCopy}>
            复制
          </button>
        </Sheet>
      ) : null}

      {listOpen && !leaveAsk ? (
        <ListPicker
          entry={entry}
          pairings={pairings}
          pending={pending}
          notice={notice}
          query={listQuery}
          onQuery={setListQuery}
          onPickSite={(targetId, side) => {
            mutate(() => api.setChief(entryId, targetId, side), { success: `要治 ${targetTitle(targetId, side)}` }).then(
              (ok) => {
                if (ok) setReselecting(false)
              },
            )
          }}
          onPickWork={(targetId, side) => {
            if (!entry.chiefSiteId) {
              setNotice({ text: "先点要治的地方", tone: "error" })
              return
            }
            mutate(() => api.addItem(entryId, targetId, side), { success: `已加 ${targetTitle(targetId, side)}` })
          }}
          onQuickAdd={quickAddParsed}
          onClose={() => setListOpen(false)}
        />
      ) : null}

      {noteOpen && !leaveAsk ? (
        <Sheet title="备注 / 禁忌" onClose={() => setNoteOpen(false)}>
          <Notice notice={notice} />
          <p className="muted">禁忌和注意事项写在这里，今日单和病人页都会一直红字显示。</p>
          <form className="stack" noValidate onSubmit={submitNote}>
            <label className="field">
              内容
              <textarea
                rows={3}
                value={noteText}
                maxLength={200}
                onChange={(event) => setNoteText(event.target.value)}
              />
            </label>
            <button className="primary" type="submit" disabled={pending}>存下</button>
          </form>
        </Sheet>
      ) : null}

      {renameOpen && !leaveAsk ? (
        <Sheet title="改姓名" onClose={() => setRenameOpen(false)}>
          <Notice notice={notice} />
          <form className="stack" noValidate onSubmit={submitRename}>
            <label className="field">
              姓名
              <input
                value={renameText}
                autoComplete="off"
                enterKeyHint="done"
                autoFocus
                onChange={(event) => setRenameText(event.target.value)}
              />
            </label>
            {renameClash ? <p className="error">{`已有叫${renameClash.name}的病人`}</p> : null}
            <button className="primary" type="submit" disabled={pending || Boolean(renameClash)}>
              存下
            </button>
          </form>
        </Sheet>
      ) : null}

      {manageOpen && !leaveAsk ? (
        <Sheet title="档案" onClose={() => setManageOpen(false)}>
          <Notice notice={notice} />
          <p className="muted">归档不会删档案；历史天数和今日单上的条目仍保留。</p>
          {entry.archived ? (
            <button type="button" className="secondary" disabled={pending} onClick={unarchivePatient}>
              取消归档
            </button>
          ) : (
            <button type="button" className="secondary" disabled={pending} onClick={archivePatient}>
              归档病人
            </button>
          )}
          <h3 className="patient-label">未在今天使用的病症</h3>
          {unusedConditions.length === 0 ? (
            <p className="muted">没有可删的：今天正在用的病症不能删；从没上过单的才可以删。</p>
          ) : (
            <div className="patient-stack">
              {unusedConditions.map((condition) => (
                <div key={condition.id} className="patient-history-row">
                  <p className="patient-history-day">{condition.name}</p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending}
                    onClick={() => removeUnusedCondition(condition)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </Sheet>
      ) : null}

      {historyOpen && !leaveAsk ? (
        <Sheet title="来过几次" onClose={() => setHistoryOpen(false)}>
          <Notice notice={notice} />
          {(entry.history || []).length === 0 ? (
            <p className="muted">还没来过。</p>
          ) : (
            <div className="patient-history">
              {entry.history.map((row) => (
                <div key={row.day} className="patient-history-row">
                  <p className="patient-history-day">
                    {row.isToday ? "今天" : `${row.day.slice(5).replace("-", "月")}日`}
                    <span className="patient-history-count">{`${row.doneCount}/${row.total}`}</span>
                    {row.lastDoneAt ? <span className="patient-history-time">{`完于 ${clockOf(row.lastDoneAt)}`}</span> : null}
                  </p>
                  <p className="patient-history-names">{row.names || "（这天没排项）"}</p>
                </div>
              ))}
            </div>
          )}
        </Sheet>
      ) : null}

      {leaveAsk ? (
        <Sheet title="今天的改动要记回病症吗？">
          <Notice notice={notice} />
          <div className="patient-stack">
            <button type="button" className="primary" disabled={pending} onClick={() => finishLeave(false)}>
              留在今天
            </button>
            <button type="button" className="secondary" disabled={pending} onClick={() => finishLeave(true)}>
              更新病症
            </button>
          </div>
        </Sheet>
      ) : null}
    </main>
  )
}
