import { parseQuickOrder } from "./quick-order.js"
import { hasSides, targetById, targetTitle } from "./catalog.js"
import { remapPlanSide } from "./workflow.js"

const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const numberOf = (value) => Number(value) || digits[value] || 0
const ordinal = /第([0-9]+|[一二两三四五六七八九十])(?:项|步|个)/
const splitClauses = (text) => text.split(/[，,。；;\n]+|然后|接着/).map((part) => part.trim()).filter(Boolean)

function selectedIndexes(text, items, options, issues) {
  const index = text.match(ordinal)
  if (index) {
    const at = numberOf(index[1]) - 1
    if (!items[at]) issues.push(`找不到第 ${at + 1} 项`)
    return items[at] ? [at] : []
  }
  if (/最后一(?:项|步|个)/.test(text)) return items.length ? [items.length - 1] : []
  if (/全部|整套|整单/.test(text)) return items.map((_, at) => at)
  const parsed = parseQuickOrder(text.replace(/今天|不做|不要做|别做|跳过|去掉|删除|只做|改成|改为|改|移到/g, ""), options)
  const targets = parsed.items.length ? parsed.items : parsed.chief ? [parsed.chief] : []
  const indexes = items.flatMap((item, at) => targets.some((target) => target.targetId === item.targetId && (!target.side || target.side === item.side)) ? [at] : [])
  if (indexes.length > 1 && !/各|全部|整套|整单|都/.test(text)) issues.push("同名项目不止一项，请说第几项，或明确说全部")
  return indexes
}

// 返回草稿而不是直接写数据；服务端也使用相同解析，客户端不能提交任意可执行操作。
export function buildOrderDraft(text, context = {}) {
  const options = { staff: context.staff || [], equipment: context.equipment || [] }
  const issues = []
  const changes = []
  let plan = structuredClone(context.current || { chiefSiteId: null, chiefSide: null, items: [] })
  let base = "current"
  let sourceLabel = context.current ? "今天这张单" : "新安排"
  let clauses = splitClauses(String(text || "").trim())
  if (!clauses.length) issues.push("先说一句或选择方案")
  if (/不照|别照|不要套用|不套用|别套用/.test(text)) issues.push("否定的复用指令不明确，请直接说要用的方案")

  const baseline = clauses.find((clause) => /照上次|照旧|套用|用.+方案/.test(clause))
  if (baseline) {
    if (/照上次|照旧/.test(baseline)) {
      if (!context.last) issues.push("没有上次的单，先选择方案或直接报项目")
      else {
        plan = structuredClone(context.last)
        base = "last"
        sourceLabel = `沿用 ${context.lastDate || "上次"} 的安排`
      }
      clauses = clauses.map((clause) => clause.replace(/照上次(?:的单)?|照旧/g, "").trim()).filter(Boolean)
    } else {
      const templates = (context.templates || []).filter((template) =>
        [template.name, template.shortName].filter(Boolean).some((name) => baseline.includes(name)))
      if (templates.length !== 1) issues.push("方案名称不明确，请从方案按钮中选择")
      else {
        const template = templates[0]
        plan = structuredClone(template)
        base = `template:${template.id}`
        sourceLabel = `套用 ${template.name}`
        const name = [template.name, template.shortName].filter(Boolean).find((value) => baseline.includes(value))
        clauses = clauses.map((clause) => clause.replace(`套用${name}`, "").replace(`用${name}`, "").trim()).filter(Boolean)
      }
    }
  }
  if (base !== "current") {
    if ((context.current?.items || []).some((item) => item.done || item.startedAt)) issues.push("今天已开始执行，不能整单覆盖；请直接修改未开始的项")
    plan.items = (plan.items || []).map((item, at) => ({
      ...item, id: `draft:${at}`, done: false, completedAt: null, completedBy: null,
      startedAt: null, startedBy: null, problem: "", problemBy: null,
      provenance: sourceLabel,
    }))
  }
  if (context.side) {
    if ((context.current?.items || []).some((item) => item.done || item.startedAt)) issues.push("已有执行记录，不能整套换侧；请明确修改尚未开始的某一项")
  }
  const items = plan.items || []
  const originalIds = [...items.map((item) => item.id)]
  for (const clause of clauses) {
    const staffMatches = options.staff.filter((person) => ["派给", "交给", "给"].some((prefix) => clause.includes(`${prefix}${person.name}`)))
    const person = staffMatches.sort((a, b) => b.name.length - a.name.length)[0]
    const assignmentOnly = person && ["", "全部", "整套", "整单"].some((scope) => ["派给", "交给", "给"].some((verb) => clause === `${scope}${verb}${person.name}`))
    if (assignmentOnly && person) {
      for (const item of items) if (!item.done) item.assigneeId = person.id
      changes.push(`未完成项交给 ${person.name}`)
      continue
    }
    const removing = /不做|不要做|别做|跳过|去掉|删除/.test(clause)
    const editing = /改成|改为|改到|移到|调整|不对/.test(clause)
    const indexed = ordinal.test(clause) || /最后一(?:项|步|个)/.test(clause)
    if (removing || editing || indexed) {
      if (staffMatches.length > 1) issues.push("同一步骤出现多个执行者，请只指定一人")
      if (removing) {
        const selectorText = clause.replace(ordinal, "").replace(/最后一(?:项|步|个)|今天|不要做|别做|不做|跳过|去掉|删除|全部|整套|整单|都/g, "")
        const selector = parseQuickOrder(selectorText, options)
        if (selector.unknown.length || selector.issues.length || /或|但|除|如果/.test(clause)) issues.push(`排除范围不明确，请重新说：${clause}`)
      }
      const indexes = selectedIndexes(clause, items, options, issues)
      if (!indexes.length) {
        if (removing && !indexed) changes.push(`已排除：${clause}`)
        else issues.push(`没有找到要改的项：${clause}`)
        continue
      }
      if (indexes.some((at) => items[at].done || items[at].startedAt)) {
        issues.push("已完成或使用中的项目不能删改，请先处理现场状态")
        continue
      }
      if (removing) {
        for (const at of [...indexes].sort((a, b) => b - a)) {
          changes.push(`去掉 ${targetTitle(items[at].targetId, items[at].side)}`)
          items.splice(at, 1)
        }
        continue
      }
      if (/移到/.test(clause)) {
        const destination = clause.split("移到")[1]
        const dest = destination.match(ordinal)
        const exact = destination === "最前" || destination === "最后" || destination === "最后一项" || dest?.[0] === destination
        const to = !exact ? -1 : /最前|第一/.test(destination) ? 0 : /最后/.test(destination) ? items.length - 1 : dest ? numberOf(dest[1]) - 1 : -1
        if (indexes.length !== 1 || to < 0 || to >= items.length) issues.push("请明确说：第二项移到第一项，或第二项移到最后")
        else {
          const [item] = items.splice(indexes[0], 1)
          items.splice(to, 0, item)
          changes.push(`调整顺序：${clause}`)
        }
        continue
      }
      const explicitChange = clause.split(/改成|改为|改到|调整/)
      const changeText = explicitChange.length > 1 ? explicitChange.slice(1).join("") : clause.replace(ordinal, "").replace(/最后一(?:项|步|个)/, "")
      const changedTarget = parseQuickOrder(changeText, options)
      if (changedTarget.items.length || changedTarget.chief) issues.push("更换目标请在项目卡中处理；口令目前只改时长、手法、侧别和派工")
      const patch = parseQuickOrder(`股四头肌${changeText}`, options)
      const doseSpoken = /分钟|小时|刻钟|组|次/.test(changeText)
      const techniqueSpoken = /按摩|松解|放松|牵伸|拉伸/.test(changeText)
      const side = /右侧/.test(changeText) ? "right" : /左侧/.test(changeText) ? "left" : null
      const leftover = patch.unknown.filter((word) => !["左侧", "右侧"].includes(word))
      if (leftover.length || patch.issues.length) issues.push(`请重新说清这项改动：${clause}`)
      if (!doseSpoken && !techniqueSpoken && !side && !person) issues.push(`没有识别出具体改动：${clause}`)
      for (const at of indexes) {
        const item = items[at]
        if (/组|次/.test(changeText)) {
          const type = options.equipment.find((row) => row.id === item.equipmentTypeId)
          if (item.technique !== "equipment" || (type && type.doseMode !== "setsReps")) issues.push("这项不按组次计量，请按分钟或到设备卡修改对应参数")
        }
        if (doseSpoken && item.technique === "equipment" && !item.equipmentTypeId) issues.push("旧器械项请在设备编辑卡里修改")
        if (doseSpoken) {
          if (item.equipmentTypeId && /分钟|小时|刻钟/.test(changeText)) {
            const type = options.equipment.find((row) => row.id === item.equipmentTypeId)
            if (!type?.parameterSchema?.some((field) => field.key === "minutes")) issues.push("这类设备不按分钟计，请到设备卡修改相应参数")
            else item.parameters = { ...item.parameters, minutes: patch.items.at(-1)?.dose?.minutes }
          }
          else item.dose = patch.items.at(-1)?.dose
        }
        if (techniqueSpoken) {
          if (item.technique === "equipment") issues.push("设备替换请在设备编辑卡中选择，不能按手法直接替换")
          else item.technique = patch.items.at(-1)?.technique
        }
        if (side && hasSides(targetById(item.targetId))) {
          item.side = side
          item.linkedTargets = (item.linkedTargets || []).map((link) => ({ ...link, side: hasSides(targetById(link.targetId)) ? side : null }))
        }
        if (person) item.assigneeId = person.id
        item.provenance = "本次口述改动"
      }
      changes.push(clause)
      continue
    }
    const only = /^(?:今天)?只做/.test(clause)
    const parsed = parseQuickOrder(clause.replace(/^(?:今天)?(?:只做|先做|再做|加上|新增|加)/, ""), options)
    issues.push(...parsed.issues, ...parsed.unknown.map((word) => `没认出来：${word}`))
    if (parsed.chief) {
      plan.chiefSiteId = parsed.chief.targetId
      plan.chiefSide = parsed.chief.side || plan.chiefSide || null
    }
    const previousItems = only ? items.splice(0) : []
    if (only && previousItems.some((item) => item.done || item.startedAt)) issues.push("今天已有执行记录，请用第几项明确修改未开始的步骤，不用只做整单替换")
    for (const item of parsed.items) {
      const matches = previousItems.filter((row) => row.targetId === item.targetId && (!item.side || row.side === item.side))
      if (matches.length > 1) issues.push("只做的同名目标不止一项，请用第几项明确选择")
      const existing = matches.length === 1 ? matches[0] : null
      items.push({
        ...existing,
        ...item,
        id: existing?.id || `new:${items.length}`,
        side: item.side || (hasSides(targetById(item.targetId)) ? plan.chiefSide : null),
        provenance: "本次口述（未提到的手法/剂量使用预览所示默认值）",
      })
    }
    if (only) changes.push("只保留本句明确指定的目标")
    if (!parsed.items.length && !parsed.chief) issues.push(`没识别出操作：${clause}`)
    if (parsed.items.length) changes.push(`新增 ${parsed.items.length} 项`)
  }
  // 结构化选择优先于口述侧别；必须在整句解析完后整套映射，不能被后面的口述悄悄盖回去。
  const finalPlan = context.side ? remapPlanSide({ ...plan, items }, context.side) : { ...plan, items }
  if (items.length && !plan.chiefSiteId) issues.push("请补要治的位置，例如左膝或右肩")
  return {
    base, sourceLabel, chiefSiteId: finalPlan.chiefSiteId, chiefSide: finalPlan.chiefSide || null,
    items: finalPlan.items, sequential: context.sequential ?? Boolean(plan.sequential),
    changes: changes.length ? changes : [sourceLabel],
    issues: [...new Set(issues)], originalIds,
  }
}
