import test from "node:test"
import assert from "node:assert/strict"
import { initialsOf, matchesInitials } from "../client/src/pinyin.js"

test("initials of names and muscle terms", () => {
  assert.equal(initialsOf("王阿姨"), "way")
  assert.equal(initialsOf("腘绳肌"), "gsj")
})

test("hanzi and initials both hit", () => {
  assert.equal(matchesInitials("王", "王阿姨"), true)
  assert.equal(matchesInitials("way", "王阿姨"), true)
  assert.equal(matchesInitials("gst", "股四头肌"), true)
  assert.equal(matchesInitials("xyz", "股四头肌"), false)
})

// 语音输入的同音错字（「国绳肌」说成「腘绳肌」）：查询也转首字母再比一次，
// 没认出的词点一下去搜才搜得到。
test("homophone typos still find the target", () => {
  assert.equal(matchesInitials("国绳肌", "腘绳肌"), true)
  assert.equal(matchesInitials("骨四头", "股四头肌"), true)
  assert.equal(matchesInitials("协方肌", "斜方肌"), true)
  assert.equal(matchesInitials("肥肠肌", "腓肠肌"), true)
})
