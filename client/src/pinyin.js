import PinYin from "tiny-pinyin"

// 病人名、目标名都是稳定字符串，解析一次就够，别每个按键重来。
const initialsCache = new Map()

// 拼音首字母，比如「王阿姨」→「way」。搜名字时汉字和首字母都能命中。
export function initialsOf(text) {
  const key = String(text)
  const hit = initialsCache.get(key)
  if (hit !== undefined) return hit
  let value
  try {
    value = PinYin.parse(key)
      .map((token) => (token.target ? token.target[0] : token.source).toLowerCase())
      .join("")
  } catch {
    value = key.toLowerCase()
  }
  if (initialsCache.size > 2000) initialsCache.clear()
  initialsCache.set(key, value)
  return value
}

export function matchesInitials(query, text) {
  const q = String(query || "").trim().toLowerCase()
  if (!q) return true
  if (String(text).toLowerCase().includes(q)) return true
  const initials = initialsOf(text)
  if (initials.includes(q)) return true
  // 语音输入的同音错字（「国绳肌」搜「腘绳肌」）：查询也转成首字母再比一次，
  // 没认出的词点一下去搜才搜得到，不用清掉重打拼音。
  if (/[\u4e00-\u9fa5]/.test(q)) return initials.includes(initialsOf(q))
  return false
}
