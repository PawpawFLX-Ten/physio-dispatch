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
  return String(text).toLowerCase().includes(q) || initialsOf(text).includes(q)
}
