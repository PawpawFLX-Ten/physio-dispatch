import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api.js"
import {
  DIRECTIONS,
  TECHNIQUES,
  allowsChief,
  allowsEquipment,
  allowsWork,
  doseLabel,
  directionLabel,
  hasSides,
  targetById,
  targetTitle,
  techniqueLabel,
} from "@shared/catalog.js"
import { itemsOnSpot } from "@shared/body-marks.js"
import { useBackLayer } from "../back-layer.js"
import { BodyStage } from "./BodyStage.jsx"
import { EquipmentPicker } from "./patient/EquipmentPicker.jsx"
import { ListPicker } from "./patient/ListPicker.jsx"
import { DoseControl, PlanList } from "./patient/PlanList.jsx"
import { Notice, Sheet } from "./patient/ui.jsx"
import {
  blankNotice,
  clockOf,
  conditionText,
  equipmentParameterSummary,
  isConflictError,
  isEquipmentItem,
  isPastMidnightError,
  itemSnapshot,
  linkedTargetTitles,
  normalizeQuickOrderSides,
  numeric,
  pastMidnightNotice,
} from "./patient/helpers.js"
import "./patient.css"

export function PatientDay({ entryId, initial, pulse, live = true, onBack }) {
  const [entry, setEntry] = useState(null)
  const [staff, setStaff] = useState([])
  const [patients, setPatients] = useState([])
  // 常见搭配表：随 entryView 一起来，加项面板照它出芯片。
  const [pairings, setPairings] = useState({})
  // 名单只有一个人时收起全部派工界面：项目自动记在那人名下（服务端本来就会这么派）。
  const solo = staff.length === 1
  const [templates, setTemplates] = useState([])
  // 设备目录随每次 entryView 下发；选择器和操作卡都直接用服务端这份，避免客户端另存一份真相。
  const [equipmentTypes, setEquipmentTypes] = useState([])
  const [equipmentUnits, setEquipmentUnits] = useState([])
  const [exerciseTemplates, setExerciseTemplates] = useState([])
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
  // 手动模式保留原来的点一下直接加项；设备模式先弹选择器，确定设备/模板后才入库。
  const [addMode, setAddMode] = useState("manual")
  const [equipmentTarget, setEquipmentTarget] = useState(null)
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
      equipmentTarget ||
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
    if (Array.isArray(result.equipmentTypes)) setEquipmentTypes(result.equipmentTypes)
    if (Array.isArray(result.equipmentUnits)) setEquipmentUnits(result.equipmentUnits)
    if (Array.isArray(result.exerciseTemplates)) setExerciseTemplates(result.exerciseTemplates)
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
    setEquipmentTarget(null)
    setAddMode("manual")
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
          setEquipmentTarget(null)
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

    // 无主诉时两种模式都沿用原语义：先定要治的位置。设备要作用在主诉区域时再点一次。
    if (!entry.chiefSiteId) {
      if (!allowsChief(target)) return
      const ok = await mutate(() => api.setChief(entryId, targetId, pickedSide))
      if (ok) setReselecting(false)
      return
    }

    // 设备模式先于 reselect/普通下手判断：膝/颈这类 equipmentCapable 主诉区域
    // 也能作为设备作用目标，同一点击不再解释成“重选主诉”。
    if (addMode === "equipment" && allowsEquipment(target)) {
      if (hasSides(target) && !pickedSide) {
        setNotice({ text: "这个部位需要明确的左侧或右侧，请从人体侧面点选", tone: "error" })
        return
      }
      setNotice(blankNotice)
      setReselecting(false)
      closeSheets()
      setEquipmentTarget({ targetId, side: pickedSide })
      return
    }

    // 手动模式的 reselect：点了主诉之外的可当主诉目标，才改要治的位置。
    if (reselecting) {
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

    // 普通下手仍只收 allowsWork；膝/颈不会因为 equipmentCapable 被塞进普通下手网格。
    if (allowsWork(target)) {
      if (hasSides(target) && !pickedSide) {
        setNotice({ text: "这个部位需要明确的左侧或右侧，请从人体侧面点选", tone: "error" })
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
    setEquipmentTarget(null)
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
    // 解析器允许“没说侧别”，但器械项服务端是严格侧别；提交前统一把可侧化项落实成左/右。
    const safeParsed = normalizeQuickOrderSides(parsed, {
      chiefSide: entry?.chiefSide,
      chiefSiteId: entry?.chiefSiteId,
    })
    if (safeParsed.items.length && !safeParsed.chief && !entry?.chiefSiteId) {
      setNotice({ text: "先点要治的地方", tone: "error" })
      return
    }
    // 显式带上整批派工和设备字段；items 里的 equipmentTypeId/parameters 原样交给服务端。
    const payload = {
      chief: safeParsed.chief,
      items: safeParsed.items,
      assigneeId: safeParsed.assigneeId || null,
    }
    mutate(() => api.quickAdd(entryId, payload), {
      success: safeParsed.items.length ? `已加 ${safeParsed.items.length} 项` : "已记要治的地方",
      fail: "未能保存",
    }).then((ok) => {
      if (ok) afterSave?.()
    })
  }

  // 设备/模板选择完成后只调用一次 addItem；服务端负责默认参数、自动机台和模板关联目标。
  function addEquipmentChoice(extra, label) {
    if (!equipmentTarget || pending) return
    mutate(() => api.addItem(entryId, equipmentTarget.targetId, equipmentTarget.side, extra), {
      success: `已加 ${label || "设备项"}`,
      fail: "未能保存",
    }).then((ok) => {
      if (ok) setEquipmentTarget(null)
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
    Boolean(equipmentTarget) ||
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
  const activeEquipmentType = activeItem
    ? equipmentTypes.find((type) => type.id === activeItem.equipmentTypeId) || null
    : null
  const activeEquipment = Boolean(activeItem && isEquipmentItem(activeItem))
  const activeParameterText = activeEquipment ? equipmentParameterSummary(activeItem, equipmentTypes) : ""
  const activeLinkedTitles = activeEquipment ? linkedTargetTitles(activeItem) : []
  const chiefTitle = entry.chiefSiteId
    ? targetTitle(entry.chiefSiteId, hasSides(targetById(entry.chiefSiteId)) ? entry.chiefSide : null)
    : ""
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
            <span>{entry.chiefSiteId ? `要治 ${chiefTitle}` : "人体已收起"}</span>
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
        {entry.chiefSiteId ? <p className="patient-hint">要治 {chiefTitle}</p> : null}
        <div className="patient-mode-switch" role="group" aria-label="人体点选模式">
          <button
            type="button"
            className={addMode === "manual" ? "patient-mode-btn is-on" : "patient-mode-btn"}
            aria-pressed={addMode === "manual"}
            disabled={pending}
            onClick={() => {
              setNotice(blankNotice)
              setAddMode("manual")
            }}
          >
            手动
          </button>
          <button
            type="button"
            className={addMode === "equipment" ? "patient-mode-btn is-on" : "patient-mode-btn"}
            aria-pressed={addMode === "equipment"}
            disabled={pending}
            onClick={() => {
              setNotice(blankNotice)
              setAddMode("equipment")
            }}
          >
            设备
          </button>
        </div>
        {addMode === "equipment" ? (
          <p className="patient-hint is-mode">设备模式：点人体部位（含主诉区域）选择设备；改主诉切回手动</p>
        ) : null}
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
            {bodyGroupItems.map((item, index) => {
              const equipment = isEquipmentItem(item)
              const linked = linkedTargetTitles(item)
              const detail = equipment
                ? [
                    item.equipmentSummary || "器械",
                    item.exerciseName ? doseLabel("equipment", item.dose) : "",
                    linked.length ? `关联 ${linked.join(" · ")}` : "",
                    item.done ? "已完成" : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : [doseLabel(item.technique, item.dose), item.done ? "已完成" : ""].filter(Boolean).join(" · ")
              return (
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
                      {`${index + 1}. ${equipment ? item.exerciseName || item.equipmentTypeName || "器械" : `${techniqueLabel(item.technique)} · ${directionLabel(item.direction)}`}`}
                    </span>
                    <span className="patient-body-item-meta">{detail}</span>
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
              )
            })}
          </div>
          <button
            type="button"
            className="primary"
            disabled={pending}
            onClick={() => {
              // 同一点已经有设备项时，“再加一项”不能悄悄落成 legacy 器械；
              // 改走设备选择器，让类型/机台/参数继续有真实来源。
              if (addMode === "equipment" || bodyGroupItems.some(isEquipmentItem)) {
                setNotice(blankNotice)
                setBodyGroup(null)
                setEquipmentTarget({ targetId: bodyGroup.targetId, side: bodyGroup.side })
                return
              }
              mutate(() => api.addItem(entryId, bodyGroup.targetId, bodyGroup.side), {
                success: "已再加一项",
                fail: "未能保存",
              })
            }}
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
          {activeEquipment ? (
            <section className="patient-equipment-readonly" aria-label="设备信息，只读">
              <p className="patient-equipment-readonly-title">设备信息 · 只读</p>
              <dl>
                <div>
                  <dt>设备</dt>
                  <dd>{activeItem.equipmentTypeName || activeEquipmentType?.name || activeItem.equipmentSummary || "器械"}</dd>
                </div>
                <div>
                  <dt>机台</dt>
                  <dd>
                    {activeItem.equipmentUnitName ||
                      (activeEquipmentType?.requiresUnit === false ? "共享设备，不占机台" : "自动安排")}
                  </dd>
                </div>
                <div>
                  <dt>模板</dt>
                  <dd>{activeItem.exerciseName || "未使用动作模板"}</dd>
                </div>
                <div>
                  <dt>参数</dt>
                  <dd>{activeParameterText || "默认参数"}</dd>
                </div>
              </dl>
              {activeLinkedTitles.length ? (
                <p className="patient-equipment-linked">{`关联 ${activeLinkedTitles.join(" · ")}`}</p>
              ) : null}
              <p className="patient-equipment-readonly-hint">参数暂为只读；完成、改派、删除和下面的组次调整保持原有操作。</p>
            </section>
          ) : null}
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
          {!(activeEquipment && activeEquipmentType?.doseMode === "parameters") ? (
            <>
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
            </>
          ) : (
            <p className="patient-equipment-dose-note">设备参数见上方只读摘要；组次剂量不适用于这类设备。</p>
          )}
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
          staff={staff}
          equipmentTypes={equipmentTypes}
          exerciseTemplates={exerciseTemplates}
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

      {equipmentTarget && !leaveAsk ? (
        <EquipmentPicker
          targetId={equipmentTarget.targetId}
          side={equipmentTarget.side}
          equipmentTypes={equipmentTypes}
          equipmentUnits={equipmentUnits}
          exerciseTemplates={exerciseTemplates}
          pending={pending}
          notice={notice}
          onAdd={addEquipmentChoice}
          onClose={() => setEquipmentTarget(null)}
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
