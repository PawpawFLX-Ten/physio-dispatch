// 加项面板：说一句 + 常见搭配芯片 + 搜肌肉 + 全部目标点选。
import { useMemo, useRef, useState } from "react"
import { TARGETS, allowsChief, allowsWork, doseLabel, hasSides, targetById, techniqueLabel, targetTitle } from "@shared/catalog.js"
import { parseQuickOrder } from "@shared/quick-order.js"
import { matchesInitials } from "../../pinyin.js"
import { PairingChips } from "../../PairingChips.jsx"
import {
  equipmentItemSummary,
  isEquipmentItem,
  normalizeQuickOrderSides,
} from "./helpers.js"
import { ChoiceButton, Notice, Sheet } from "./ui.jsx"

export function ListPicker({
  entry,
  pairings,
  staff = [],
  equipmentTypes = [],
  exerciseTemplates = [],
  pending,
  notice,
  query,
  onQuery,
  onPickSite,
  onPickWork,
  onQuickAdd,
  onClose,
}) {
  const [quickText, setQuickText] = useState("")
  const sheetSearchRef = useRef(null)
  const parsed = useMemo(
    () =>
      normalizeQuickOrderSides(parseQuickOrder(quickText, { staff, equipment: equipmentTypes }), {
        chiefSide: entry?.chiefSide,
        chiefSiteId: entry?.chiefSiteId,
      }),
    [quickText, staff, equipmentTypes, entry?.chiefSide, entry?.chiefSiteId],
  )
  const hasSomething = Boolean(parsed.chief) || parsed.items.length > 0
  const parsedAssigneeName =
    parsed.assigneeName || staff.find((person) => person.id === parsed.assigneeId)?.name || ""
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
  // 腰/颈主诉本身无可侧化；旧服务端字段里可能残留上一次的 chiefSide，芯片必须以“无侧”呈现。
  const pairingSide = hasSides(targetById(entry?.chiefSiteId)) ? entry?.chiefSide : null
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
            {parsedAssigneeName ? (
              <p className="patient-quick-assignee">{`派给 ${parsedAssigneeName}`}</p>
            ) : null}
            {parsed.items.length ? (
              <ol className="patient-quick-items">
                {parsed.items.map((item, index) => {
                  const equipment = isEquipmentItem(item)
                  const detail = equipment
                    ? equipmentItemSummary(item, equipmentTypes, exerciseTemplates)
                    : techniqueLabel(item.technique)
                  // 设备参数已由 summary 展示；只在真有组次时补剂量，避免冲击波/超声出现“0组×0次”。
                  const dose = equipment
                    ? item.dose?.sets || item.dose?.reps
                      ? doseLabel("equipment", item.dose)
                      : ""
                    : doseLabel(item.technique, item.dose)
                  return (
                    <li key={index}>
                      {[targetTitle(item.targetId, item.side), detail, dose].filter(Boolean).join(" · ")}
                    </li>
                  )
                })}
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
            side={pairingSide}
            added={addedSpots}
            disabled={pending}
            splitSides
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
