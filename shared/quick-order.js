// 「说一句」快速开单的解析器。
// 词表是封闭的（42 个目标 + 同义词、4 个手法、4 个方向、左右双、数字），
// 规则匹配就够，不需要模型：主治说一遍，助手打字或用键盘语音输入，直接变成清单。
import { allowsChief, clampDose, hasSides, targetById } from "./catalog.js"

const TARGET_ALIASES = [
  ["膝盖", "knee"], ["膝关节", "knee"], ["膝", "knee"],
  ["腰", "lumbar"],
  ["脖子", "neck"], ["颈椎", "neck"], ["颈", "neck"],
  ["肩", "shoulder"],
  // 语音输入的同音错字也认（腘/腓是生僻字，键盘话筒几乎必错）。
  ["腘绳肌", "hamstring"], ["腘绳", "hamstring"], ["大腿后侧", "hamstring"], ["大腿后", "hamstring"],
  ["国绳肌", "hamstring"], ["国绳", "hamstring"],
  // 股二头肌是腘绳肌群的一头，别落进手臂的「二头肌」；「骨」是语音同音错字。
  ["股二头肌", "hamstring"], ["骨二头肌", "hamstring"],
  // 小腿三头肌落在腓肠肌（其主要部分），不能被手臂的「三头肌」截走。
  ["小腿三头肌", "gastroc"],
  ["股四头肌", "quad"], ["股四头", "quad"], ["大腿前侧", "quad"], ["大腿前", "quad"],
  ["骨四头肌", "quad"], ["骨四头", "quad"], ["故四头", "quad"],
  ["臀", "glute"], ["屁股", "glute"], ["臀肌群", "glute"],
  ["臀中肌", "glute-med"], ["臀中", "glute-med"],
  ["比目鱼肌", "soleus"], ["比目鱼", "soleus"],
  ["腓肠肌", "gastroc"], ["腓肠", "gastroc"], ["小腿肚", "gastroc"],
  ["肥肠肌", "gastroc"], ["肥肠", "gastroc"],
  ["足底", "plantar"], ["脚底", "plantar"], ["脚掌", "plantar"],
  ["承山", "chengshan"],
  ["髂胫束", "itband"], ["大腿外侧", "itband"],
  ["内收肌群", "adductors"], ["内收肌", "adductors"], ["大腿内侧", "adductors"],
  ["缝匠肌", "sartorius"], ["缝匠", "sartorius"],
  ["腘肌", "popliteus"],
  ["髂腰肌", "iliopsoas"], ["髂腰", "iliopsoas"],
  ["梨状肌", "piriformis"], ["梨状", "piriformis"],
  ["胫骨前肌", "tib-anterior"], ["胫前肌", "tib-anterior"], ["小腿前侧", "tib-anterior"],
  ["胫骨后肌", "tib-posterior"], ["胫后肌", "tib-posterior"],
  ["腓骨长短肌", "fibularis"], ["腓骨肌", "fibularis"],
  ["趾长伸肌", "edl"],
  ["趾长屈肌", "fdl"],
  ["斜方肌", "trapezius"], ["斜方", "trapezius"], ["协方肌", "trapezius"], ["协方", "trapezius"],
  ["竖脊肌", "erector-spinae"], ["竖脊", "erector-spinae"], ["脊柱两侧", "erector-spinae"],
  ["胸大肌", "pectoralis-major"], ["胸小肌", "pectoralis-minor"],
  ["腹外斜肌", "obliquus-externus"], ["腹斜肌", "obliquus-externus"],
  // 不收「二头肌/三头肌」裸词：任何带部位前缀的真名（股二头肌、小腿三头肌…）都可能包含它，
  // 静默错认到手臂比认不出更危险；裸词落进 unknown 走「点一下进搜索」的既定兜底。
  ["肱二头肌", "biceps-brachii"],
  ["肱三头肌", "triceps-brachii"],
  ["肱桡肌", "brachioradialis"],
  ["前臂伸肌群", "forearm-extensors"], ["前臂伸肌", "forearm-extensors"],
  ["前臂屈肌群", "forearm-flexors"], ["前臂屈肌", "forearm-flexors"],
  ["肩胛提肌", "levator-scap"], ["肩甲提肌", "levator-scap"], ["肩钾提肌", "levator-scap"],
  ["菱形肌", "rhomboid"], ["菱形", "rhomboid"], ["肩胛骨缝", "rhomboid"], ["肩胛缝", "rhomboid"],
  ["前锯肌", "serratus"], ["前锯", "serratus"],
  ["冈上肌", "supraspinatus"], ["冈上", "supraspinatus"],
  ["冈下肌", "infraspinatus"], ["冈下", "infraspinatus"],
  ["肩胛下肌", "subscapularis"],
  ["小圆肌", "teres-minor"], ["小圆", "teres-minor"],
  ["大圆肌", "teres-major"], ["大圆", "teres-major"],
  ["胸锁乳突肌", "scm"], ["胸锁乳突", "scm"],
]

const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function cnNum(text) {
  if (/^[0-9]+$/.test(text)) return Number(text)
  if (text.includes("十")) {
    const [head = "", tail = ""] = text.split("十")
    return (head ? CN_DIGITS[head] : 1) * 10 + (tail ? CN_DIGITS[tail] || 0 : 0)
  }
  return CN_DIGITS[text] || 0
}

const NUM = "([0-9]+|[一二两三四五六七八九十]{1,3})"

// 把整句话变成记号流，再从左到右走一遍。
// 手法/方向/剂量跟在肌肉名后面也认得（「股四头按摩八分钟」），会回头补到刚加的那项上，
// 后面没说的沿用上一项（「腘绳肌松解，比目鱼肌」——比目鱼肌也是松解）。
export function parseQuickOrder(text, options = {}) {
  const raw = String(text || "")
  const spans = []
  const staff = Array.isArray(options.staff) ? options.staff : []
  const equipment = Array.isArray(options.equipment) ? options.equipment : []

  function addAll(pattern, kind, map) {
    for (const match of raw.matchAll(pattern)) {
      spans.push({ start: match.index, end: match.index + match[0].length, kind, value: map(match) })
    }
  }

  for (const [alias, targetId] of TARGET_ALIASES) {
    let from = 0
    for (;;) {
      const at = raw.indexOf(alias, from)
      if (at < 0) break
      spans.push({ start: at, end: at + alias.length, kind: "target", value: targetId })
      from = at + alias.length
    }
  }
  // 设备名也是封闭词表：由调用方传入设备目录及别名，解析器本身不硬编码设备知识。
  const equipmentRows = equipment
    .filter((row) => row && typeof row.id === "string")
    .map((row) => ({
      ...row,
      aliases: [...new Set([row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])].filter(Boolean))],
    }))
  for (const row of equipmentRows) {
    for (const alias of row.aliases) {
      let from = 0
      for (;;) {
        const at = raw.indexOf(String(alias), from)
        if (at < 0) break
        spans.push({ start: at, end: at + String(alias).length, kind: "equipment", value: row })
        from = at + String(alias).length
      }
    }
  }
  addAll(/按摩|揉捏|揉|推拿|按一按|按按|压一压|揉揉|推一推|按压/g, "technique", () => "massage")
  addAll(/松解|放松|松一下|松一松|松松/g, "technique", () => "release")
  // 牵伸是常说的「拉伸」：以前没这个词会静默落回按摩，处方意图被吞掉。
  addAll(/牵伸|拉伸|牵一牵|拉一拉|拉一下|拉开/g, "technique", () => "stretch")
  addAll(/器械|训练/g, "technique", () => "equipment")
  addAll(/沿肌纤维|顺肌纤维/g, "direction", () => "along")
  addAll(/逆着肌纤维|逆肌纤维/g, "direction", () => "against")
  addAll(/由近到远|从近到远/g, "direction", () => "outward")
  addAll(/由远到近|从远到近/g, "direction", () => "inward")
  // 口语时长：半小时/一个半小时/一个小时/一刻钟（数字+分钟的规则认不出这些）。
  addAll(/一个半(?:小时|钟头)/g, "dose", () => ({ minutes: 90 }))
  addAll(/半(?:小时|钟头)/g, "dose", () => ({ minutes: 30 }))
  addAll(/([一二两三四五六七八九]|十)个?(?:小时|钟头)/g, "dose", (m) => ({ minutes: cnNum(m[1]) * 60 }))
  addAll(/([一二三])刻钟/g, "dose", (m) => ({ minutes: cnNum(m[1]) * 15 }))
  addAll(new RegExp(`${NUM}分钟`, "g"), "dose", (m) => ({ minutes: cnNum(m[1]) }))
  addAll(new RegExp(`${NUM}组`, "g"), "dose", (m) => ({ sets: cnNum(m[1]) }))
  addAll(new RegExp(`${NUM}次`, "g"), "dose", (m) => ({ reps: cnNum(m[1]) }))
  addAll(/两侧|两边|双/g, "side", () => "both")
  addAll(/左/g, "side", () => "left")
  addAll(/右/g, "side", () => "right")
  // 员工派工：只认明确前缀，避免病人名/普通词被误当成人名。
  // 动态人名比固定词表更容易产生重叠，先按名字长度降序匹配。
  const staffRows = staff
    .filter((person) => person && typeof person.id === "string" && typeof person.name === "string" && person.name.trim())
    .map((person) => ({ id: person.id, name: person.name.trim() }))
    .sort((left, right) => right.name.length - left.name.length)
  for (const person of staffRows) {
    for (const prefix of ["派给", "交给", "给"]) {
      const phrase = `${prefix}${person.name}`
      let from = 0
      for (;;) {
        const at = raw.indexOf(phrase, from)
        if (at < 0) break
        spans.push({ start: at, end: at + phrase.length, kind: "assignee", value: person })
        from = at + phrase.length
      }
    }
  }

  // 同一个位置长的词优先（「肩胛提肌」不能拆成「肩」），重叠的丢掉。
  spans.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const tokens = []
  let lastEnd = -1
  for (const span of spans) {
    if (span.start < lastEnd) continue
    tokens.push(span)
    lastEnd = span.end
  }
  // 「左右肩」= 双侧
  for (let i = 0; i < tokens.length - 1; i++) {
    if (
      tokens[i].kind === "side" && tokens[i].value === "left" &&
      tokens[i + 1].kind === "side" && tokens[i + 1].value === "right" &&
      tokens[i + 1].start === tokens[i].end
    ) {
      tokens[i] = { ...tokens[i], value: "both" }
      tokens.splice(i + 1, 1)
    }
  }
  // 语音卡顿会把同一个词连说两遍：完全相邻的同名目标只留一个（隔着标点的重复不算）。
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (
      tokens[i].kind === "target" && tokens[i + 1].kind === "target" &&
      tokens[i + 1].start === tokens[i].end && tokens[i + 1].value === tokens[i].value
    ) {
      tokens.splice(i + 1, 1)
    }
  }

  const sticky = { technique: "massage", direction: "along", dose: { minutes: 8 }, equipmentTypeId: null }
  let pendingSide = null
  let chief = null
  let assignee = null
  const items = []
  let groupStart = 0

  for (const token of tokens) {
    if (token.kind === "target") {
      const target = targetById(token.value)
      if (!target) continue
      if (!chief && allowsChief(target)) {
        // 「双侧」由两条左右分开的项表达，主诉不承载：存成不带侧，免得服务端静默丢掉。
        chief = { targetId: target.id, side: hasSides(target) && pendingSide !== "both" ? pendingSide : null }
      } else if (target.kind !== "site" || sticky.equipmentTypeId) {
        const sides = pendingSide === "both" ? ["left", "right"] : [pendingSide]
        groupStart = items.length
        for (const side of sides) {
          items.push({
            targetId: target.id,
            side: hasSides(target) ? side : null,
            technique: sticky.technique,
            direction: sticky.direction,
            equipmentTypeId: sticky.equipmentTypeId || null,
            dose: doseFor(sticky),
          })
        }
      }
      // 说「左膝，股四头…」时左右会一直管到换了侧为止；「双侧」也持续生效。
    } else if (token.kind === "side") {
      pendingSide = token.value
    } else if (token.kind === "assignee") {
      assignee = token.value
    } else if (token.kind === "equipment") {
      sticky.technique = "equipment"
      sticky.equipmentTypeId = token.value.id
      // 新设备不带上一项的手工剂量；后面明确说了分钟/组次再覆盖。
      sticky.dose = {}
      for (let i = groupStart; i < items.length; i++) {
        items[i].technique = "equipment"
        items[i].equipmentTypeId = token.value.id
        items[i].dose = doseFor(sticky)
      }
    } else if (token.kind === "technique") {
      sticky.technique = token.value
      if (token.value === "equipment") sticky.dose = { sets: 3, reps: 10 }
      if (token.value !== "equipment") sticky.equipmentTypeId = null
      applyToGroup(items, groupStart, "technique", token.value, sticky)
    } else if (token.kind === "direction") {
      sticky.direction = token.value
      applyToGroup(items, groupStart, "direction", token.value, sticky)
    } else if (token.kind === "dose") {
      if (token.value.sets != null || token.value.reps != null) {
        // 说到组数次数就按器械训练算
        sticky.technique = "equipment"
        applyToGroup(items, groupStart, "technique", "equipment", sticky)
      }
      mergeDose(sticky, token.value)
      for (let i = groupStart; i < items.length; i++) items[i].dose = doseFor(sticky)
    }
  }

  const equipmentById = new Map(equipmentRows.map((row) => [row.id, row]))
  for (const item of items) {
    if (!item.equipmentTypeId) continue
    const type = equipmentById.get(item.equipmentTypeId)
    const dose = item.dose || {}
    const schemaKeys = new Set(
      Array.isArray(type?.parameterSchema)
        ? type.parameterSchema.map((field) => field?.key).filter(Boolean)
        : [],
    )
    const parameters = {}
    if (schemaKeys.size) {
      for (const [key, value] of Object.entries(dose)) {
        if (schemaKeys.has(key)) parameters[key] = value
      }
    } else if (item.equipmentTypeId === "shockwave" && dose.reps != null && dose.pulses == null) {
      parameters.pulses = dose.reps
    } else {
      Object.assign(parameters, dose)
    }
    item.parameters = parameters
  }

  return {
    chief,
    items,
    unknown: leftoverWords(raw, tokens),
    assigneeId: assignee?.id || null,
    assigneeName: assignee?.name || "",
  }
}

function doseFor(sticky) {
  // 已明确设备类型的项，参数由设备 schema 兜底；这里保留用户说出的原始分钟/组次，
  // 避免超声/牵引等按分钟计的设备被通用的器械 3×10 规则改写。
  if (sticky.technique === "equipment" && sticky.equipmentTypeId) return { ...(sticky.dose || {}) }
  return clampDose(sticky.technique, sticky.dose)
}

function mergeDose(sticky, dose) {
  if (dose.minutes != null) {
    sticky.dose = { minutes: dose.minutes }
    return
  }
  // 冲击波口述里的「2000次」是脉冲次数，不补成 3 组。设备 schema 用 pulses。
  if (sticky.equipmentTypeId === "shockwave" && dose.reps != null && dose.sets == null) {
    sticky.dose = { pulses: Math.max(1, Number(dose.reps) || 1) }
    return
  }
  sticky.dose = {
    sets: Math.max(1, dose.sets ?? sticky.dose.sets ?? 3),
    reps: Math.max(1, dose.reps ?? sticky.dose.reps ?? 10),
  }
}

function applyToGroup(items, groupStart, key, value, sticky) {
  for (let i = groupStart; i < items.length; i++) {
    items[i][key] = value
    items[i].dose = doseFor({ ...sticky, technique: items[i].technique })
  }
}

// 没被吃掉的词挑出来给用户看，方便发现说岔了的地方。连接词不算。
const STOP_WORDS = new Set(["然后", "接着", "接下来", "再", "先", "最后", "和", "跟", "与", "每", "各", "做", "一下", "再来", "之后", "其次", "还有", "以及", "加上", "顺便", "再来一次", "然后呢"])

function leftoverWords(raw, tokens) {
  const mask = raw.split("")
  for (const token of tokens) mask.fill("*", token.start, token.end)
  const chunks = mask
    .join("")
    .split(/[^\u4e00-\u9fa5]+/)
    .filter((word) => /[\u4e00-\u9fa5]/.test(word) && word.length >= 2 && !STOP_WORDS.has(word))
  const unknown = []
  for (const word of chunks) {
    if (!unknown.includes(word)) unknown.push(word)
    if (unknown.length >= 4) break
  }
  return unknown
}
