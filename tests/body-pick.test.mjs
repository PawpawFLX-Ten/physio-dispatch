import test from "node:test"
import assert from "node:assert/strict"
import { chooseBodyHit } from "../shared/body-pick.js"

test("chooseBodyHit prefers muscle behind a node that occludes it", () => {
  const hits = [
    { targetId: "chengshan", kind: "node", distance: 1.0 },
    { targetId: "soleus", kind: "muscle", distance: 1.03 },
  ]
  assert.equal(chooseBodyHit(hits).targetId, "soleus")
})

test("chooseBodyHit keeps a lone node hit", () => {
  const hits = [{ targetId: "chengshan", kind: "node", distance: 1.0 }]
  assert.equal(chooseBodyHit(hits).targetId, "chengshan")
})

test("chooseBodyHit ignores a muscle too far behind the node", () => {
  const hits = [
    { targetId: "chengshan", kind: "node", distance: 1.0 },
    { targetId: "soleus", kind: "muscle", distance: 1.2 },
  ]
  assert.equal(chooseBodyHit(hits).targetId, "chengshan")
})

test("chooseBodyHit keeps a first muscle hit", () => {
  const hits = [
    { targetId: "soleus", kind: "muscle", distance: 1.0 },
    { targetId: "chengshan", kind: "node", distance: 1.02 },
  ]
  assert.equal(chooseBodyHit(hits).targetId, "soleus")
})

test("chooseBodyHit returns null for empty hits", () => {
  assert.equal(chooseBodyHit([]), null)
  assert.equal(chooseBodyHit(null), null)
})
