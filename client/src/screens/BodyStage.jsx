// 预览人体使用 BodyParts3D 网格。正式小程序用同一批 glb，改由 xr-frame 加载。
import { useEffect, useRef, useState } from "react"
import {
  BatchedMesh,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js"
import { hasSides, targetById, TARGETS } from "@shared/catalog.js"
import { BODY_CAMERA, BODY_FILES, meshSlug, OCCLUDED_TARGETS, resolveMesh } from "@shared/body-map.js"
import { BODY_VERSION } from "@shared/body-assets.js"
import { chooseBodyHit } from "@shared/body-pick.js"
import {
  buildMarkState,
  markKey,
  ordersFor,
  resolvePaintRole,
} from "@shared/body-marks.js"
import "./body.css"

const DRAG_PX = 8
// 要治的地方：暖橙。下手：冷色深蓝——橙/蓝是色相加明度双分离，
// 红绿色弱的眼睛也能分清「哪里要治」和「哪里下手」，不再共用绿系。
const CHIEF = 0xe08a4a
const WORK = 0x2e5fa3
const WORK_DONE = 0x9aabc4
const BONE = 0xeadccb
const MUSCLE = 0xa24b38
const NODE = 0x2f5f73
const FOOT = /calcaneus|talus|navicular|cuboid|cuneiform|metatarsal|toe|sesamoid/
const MIN_Z = 1.7
const MAX_Z = 4.8

// 模块级缓存：人体模型解码一次就留在内存里，进出病人页不再重付 15 个 GLB 的解码开销。
// 每次挂载 clone 一份场景（geometry/material 是共享引用），所以绝不能 dispose 共享资源。
const gltfCache = new Map()
const sharedLoader = new GLTFLoader()
// 模型用 meshopt + 量化（KHR_mesh_quantization）压的：解码器是纯 JS 随包走，
// 不用再下 draco 的 wasm，低端机解码也快得多。
sharedLoader.setMeshoptDecoder(MeshoptDecoder)

function loadBodyFile(file) {
  const hit = gltfCache.get(file)
  if (hit) return hit
  const pending = sharedLoader.loadAsync(`/body/${file}?v=${BODY_VERSION}`).catch((err) => {
    // 失败不留在缓存里，下次挂载还能重试。
    gltfCache.delete(file)
    throw err
  })
  gltfCache.set(file, pending)
  return pending
}

function sideOf(point, targetId) {
  if (!hasSides(targetById(targetId))) return null
  return point.x >= 0 ? "right" : "left"
}

function restingColor(targetId, tissue) {
  const target = targetById(targetId)
  if (!target) return tissue === "bone" ? BONE : MUSCLE
  if (target.kind === "node") return NODE
  if (target.kind === "site" && tissue === "bone") return 0xd7a07a
  if (tissue === "bone") return BONE
  return MUSCLE
}

function hexForRole(role, baseHex) {
  if (role === "chief") return CHIEF
  if (role === "work") return WORK
  if (role === "workDone") return WORK_DONE
  return baseHex
}

function roundPoint(vector) {
  return {
    x: Number(vector.x.toFixed(4)),
    y: Number(vector.y.toFixed(4)),
    z: Number(vector.z.toFixed(4)),
  }
}

export function BodyStage({ chiefSiteId, chiefSide, items, reselecting, onSelect }) {
  const viewRef = useRef(null)
  const propsRef = useRef({ chiefSiteId, chiefSide, items, onSelect })
  const paintRef = useRef(() => {})
  const yawRef = useRef(null)
  const zoomRef = useRef(null)
  const [phase, setPhase] = useState("loading")
  const [progress, setProgress] = useState(0)
  // 加载失败后整段初始化重来一遍的计数器（挂进大 effect 的依赖）。
  const [attempt, setAttempt] = useState(0)

  propsRef.current = { chiefSiteId, chiefSide, items, onSelect }

  useEffect(() => {
    const view = viewRef.current
    if (!view) return undefined

    let mounted = true
    let stopped = false
    let released = false
    let frameId = 0
    const geos = new Set()
    const mats = new Set()
    const unlisten = []
    let renderer = null
    let labelRenderer = null
    let resizeObserver = null
    const batchedMeshes = []

    // 按需渲染：场景只在旋转/缩放/标记变化时重画一帧，静止时不空转 60fps。
    let dirty = true
    function invalidate() {
      dirty = true
    }

    function trackMaterial(material) {
      mats.add(material)
      return material
    }

    function listen(target, type, fn) {
      target.addEventListener(type, fn)
      unlisten.push(() => target.removeEventListener(type, fn))
    }

    function release() {
      if (released) return
      released = true
      stopped = true
      cancelAnimationFrame(frameId)
      resizeObserver?.disconnect()
      for (const off of unlisten) off()
      unlisten.length = 0
      yawRef.current = null
      zoomRef.current = null
      paintRef.current = () => {}
      if (view.dataset) {
        delete view.dataset.ready
        delete view.dataset.picks
        delete view.dataset.camera
        delete view.dataset.meshes
        delete view.dataset.bounds
      }
      for (const geometry of geos) geometry.dispose()
      for (const material of mats) material.dispose()
      // BatchedMesh 的内部缓冲是自己开的，得自己收。
      for (const batched of batchedMeshes) batched.dispose()
      batchedMeshes.length = 0
      geos.clear()
      mats.clear()
      try {
        labelRenderer?.domElement.remove()
      } catch {
        /* 标签层已经不在页面上 */
      }
      labelRenderer = null
      if (renderer) {
        try {
          renderer.dispose()
          renderer.domElement.remove()
        } catch {
          /* 上下文已经没了 */
        }
        renderer = null
      }
    }

    function fail() {
      release()
      if (mounted) setPhase("failed")
    }

    const markers = []
    const pickMeshes = []
    const anchors = new Map()

    function addMarker(position, targetId, radius) {
      const geometry = new SphereGeometry(radius, 18, 14)
      geos.add(geometry)
      const base = restingColor(targetId, "node")
      const material = trackMaterial(new MeshStandardMaterial({
        color: base,
        roughness: 0.45,
        metalness: 0.02,
      }))
      const mesh = new Mesh(geometry, material)
      mesh.position.copy(position)
      const side = sideOf(position, targetId)
      mesh.userData.targetId = targetId
      mesh.userData.side = side
      return { mesh, base, side }
    }

    async function loadBody(figure) {
      let loaded = 0
      const rig = new Group()
      const content = new Group()
      rig.add(content)
      const models = await Promise.all(
        BODY_FILES.map(async (file) => {
          const gltf = await loadBodyFile(file)
          loaded += 1
          if (mounted) setProgress(loaded)
          // clone 一份再动：材质与父子关系只改这份，缓存里的原件保持原样。
          return { file, scene: gltf.scene.clone(true) }
        }),
      )
      if (stopped) return

      // 同一目标、同一侧的网格合成一件、共用一个材质：draw call 从三百多路降到几十路，
      // 拾取语义不变（userData 仍在）。几何一律不克隆不改写——合并件挂在带原始变换的
      // 节点下；跨文件的件变换一致（矩阵完全相同）时并进同一件。
      const pickGroups = new Map()
      const contextGroups = new Map()
      const footBoxes = []
      for (const { file, scene } of models) {
        const meshes = []
        scene.traverse((obj) => {
          if (obj.isMesh) meshes.push(obj)
        })
        scene.updateMatrixWorld(true)
        // 根节点带着 Y-up 旋转和 0.001 缩放，网格节点自身都是恒等（构建时已烤进根）。
        const bakeRoot = scene.children.length === 1 ? scene.children[0].matrixWorld : null
        for (const mesh of meshes) {
          const name = mesh.userData.name || mesh.name || ""
          const decision = resolveMesh(name, file)
          if (decision.kind === "hide") continue
          const box = new Box3().setFromObject(mesh)
          if (FOOT.test(meshSlug(name))) footBoxes.push(box.clone())
          const matrix = bakeRoot && mesh.matrixWorld.equals(bakeRoot) ? bakeRoot : mesh.matrixWorld.clone()
          const matrixKey = matrix.elements.join(",")
          const map = decision.kind === "pick" ? pickGroups : contextGroups
          const side = decision.kind === "pick" ? sideOf(box.getCenter(new Vector3()), decision.targetId) : null
          const groupKey =
            decision.kind === "pick"
              ? `${decision.targetId}|${decision.tissue}|${side || "mid"}`
              : decision.tissue
          const group =
            map.get(groupKey) || {
              targetId: decision.kind === "pick" ? decision.targetId : null,
              tissue: decision.tissue,
              side,
              buckets: new Map(),
              boxes: [],
            }
          const bucket = group.buckets.get(matrixKey) || { matrix, geometries: [] }
          bucket.geometries.push(mesh.geometry)
          group.buckets.set(matrixKey, bucket)
          group.boxes.push(box)
          map.set(groupKey, group)
        }
      }

      const boneMat = trackMaterial(new MeshStandardMaterial({ color: BONE, roughness: 0.72, metalness: 0.02 }))
      const muscleMat = trackMaterial(new MeshStandardMaterial({ color: MUSCLE, roughness: 0.58, metalness: 0.02 }))
      let contextMeshCount = 0

      // 一组（目标×侧别，或上下文×组织）一个 BatchedMesh：一组一次 draw call。
      // 量化的反量化矩阵留在网格节点上（烤进几何会破坏量化属性），所以每件带着
      // 自己的矩阵进批；同一变换的件先 mergeGeometries 再进批，批数更少。
      function mountGroup(group, material, base) {
        const pieces = []
        for (const bucket of group.buckets.values()) {
          const merged = bucket.geometries.length > 1 ? mergeGeometries(bucket.geometries, false) : null
          if (merged) geos.add(merged)
          for (const geometry of merged ? [merged] : bucket.geometries) {
            pieces.push({ geometry, matrix: bucket.matrix })
          }
        }
        if (!pieces.length) return
        let totalVerts = 0
        let totalIndices = 0
        for (const piece of pieces) {
          totalVerts += piece.geometry.getAttribute("position").count
          const index = piece.geometry.getIndex()
          totalIndices += index ? index.count : 0
        }
        const batched = new BatchedMesh(pieces.length, totalVerts, Math.max(totalIndices, 1), material)
        for (const piece of pieces) {
          const geometryId = batched.addGeometry(piece.geometry)
          const instanceId = batched.addInstance(geometryId)
          batched.setMatrixAt(instanceId, piece.matrix)
        }
        batched.computeBoundingSphere()
        batched.userData.targetId = group.targetId
        batched.userData.side = group.side
        content.add(batched)
        batchedMeshes.push(batched)
        if (group.targetId) {
          pickMeshes.push(batched)
          group.material = material
          group.base = base
        } else {
          contextMeshCount += 1
        }
      }

      for (const group of contextGroups.values()) {
        mountGroup(group, group.tissue === "bone" ? boneMat : muscleMat, null)
      }
      for (const group of pickGroups.values()) {
        const base = restingColor(group.targetId, group.tissue)
        mountGroup(group, trackMaterial(new MeshStandardMaterial({ color: base, roughness: 0.62, metalness: 0.02 })), base)
      }

      // 量体归一化必须在挂载之后：量一个空的 content 会把 rig.position 算成 NaN，
      // 整个人体的世界矩阵跟着变 NaN，一个像素都画不出来。
      figure.add(rig)
      figure.updateWorldMatrix(true, true)
      const measured = new Box3().setFromObject(content)
      const measuredSize = measured.getSize(new Vector3())
      const height = measuredSize.y || 1
      rig.scale.setScalar(1.68 / height)
      rig.updateMatrixWorld(true)
      const fitted = new Box3().setFromObject(rig)
      const fittedValues = [fitted.min.x, fitted.min.y, fitted.min.z, fitted.max.x, fitted.max.y, fitted.max.z]
      if (fittedValues.every(Number.isFinite)) {
        rig.position.set(
          -(fitted.min.x + fitted.max.x) / 2,
          -fitted.min.y,
          -(fitted.min.z + fitted.max.z) / 2,
        )
      }
      figure.updateWorldMatrix(true, true)

      // 分组包围盒是缩放前算的；rig 只有平移+均匀缩放，搬进最终空间 v' = p + s·v，
      // 穴位球、标签锚点才和网格在同一个坐标系里。
      const fittedScale = rig.scale.x
      const fittedShift = rig.position
      const liftBox = (box) => {
        box.min.multiplyScalar(fittedScale).add(fittedShift)
        box.max.multiplyScalar(fittedScale).add(fittedShift)
        return box
      }
      for (const group of pickGroups.values()) {
        group.boxes = group.boxes.map(liftBox)
        markers.push({ id: group.targetId, material: group.material, base: group.base, side: group.side })
        const list = anchors.get(markKey(group.targetId, group.side)) || []
        for (const box of group.boxes) list.push(box.getCenter(new Vector3()))
        anchors.set(markKey(group.targetId, group.side), list)
      }
      for (let i = 0; i < footBoxes.length; i++) liftBox(footBoxes[i])

      const groupsOf = (id) => [...pickGroups.values()].filter((group) => group.targetId === id)
      const unionBox = (boxes) => {
        const box = new Box3()
        for (const part of boxes) box.union(part)
        return box
      }
      for (const group of groupsOf("gastroc")) {
        const box = unionBox(group.boxes)
        const point = new Vector3()
        box.getCenter(point)
        // 承山贴在腓肠肌下段外侧、再往后挪一点，避免挡在比目鱼肌中心射线上。
        const size = box.getSize(new Vector3())
        point.y = box.min.y + size.y * 0.18
        point.x = point.x >= 0 ? box.max.x + 0.012 : box.min.x - 0.012
        point.z = box.min.z - 0.05
        const marker = addMarker(point, "chengshan", 0.014)
        figure.add(marker.mesh)
        pickMeshes.push(marker.mesh)
        markers.push({ id: "chengshan", material: marker.mesh.material, base: marker.base, side: marker.side })
        const list = anchors.get(markKey("chengshan", marker.side)) || []
        list.push(point.clone())
        anchors.set(markKey("chengshan", marker.side), list)
      }
      for (const group of groupsOf("quad")) {
        const box = unionBox(group.boxes)
        const point = box.getCenter(new Vector3())
        point.x = point.x >= 0 ? box.max.x + 0.02 : box.min.x - 0.02
        const marker = addMarker(point, "itband", 0.028)
        figure.add(marker.mesh)
        pickMeshes.push(marker.mesh)
        markers.push({ id: "itband", material: marker.mesh.material, base: marker.base, side: marker.side })
        const list = anchors.get(markKey("itband", marker.side)) || []
        list.push(point.clone())
        anchors.set(markKey("itband", marker.side), list)
      }
      const footBySide = new Map()
      for (const box of footBoxes) {
        const side = box.getCenter(new Vector3()).x >= 0 ? "right" : "left"
        const union = footBySide.get(side) || new Box3()
        union.union(box)
        footBySide.set(side, union)
      }
      for (const box of footBySide.values()) {
        const point = box.getCenter(new Vector3())
        point.y = box.min.y + 0.02
        const marker = addMarker(point, "plantar", 0.03)
        figure.add(marker.mesh)
        pickMeshes.push(marker.mesh)
        markers.push({ id: "plantar", material: marker.mesh.material, base: marker.base, side: marker.side })
        const list = anchors.get(markKey("plantar", marker.side)) || []
        list.push(point.clone())
        anchors.set(markKey("plantar", marker.side), list)
      }
      for (const group of groupsOf("knee")) {
        const point = unionBox(group.boxes).getCenter(new Vector3())
        const geometry = new SphereGeometry(0.055, 16, 12)
        geos.add(geometry)
        const material = trackMaterial(new MeshStandardMaterial({
          color: CHIEF,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }))
        const helper = new Mesh(geometry, material)
        helper.position.copy(point)
        const side = sideOf(point, "knee")
        helper.userData.targetId = "knee"
        helper.userData.side = side
        figure.add(helper)
        pickMeshes.push(helper)
        markers.push({ id: "knee", material, base: restingColor("knee", "bone"), side })
        const list = anchors.get(markKey("knee", side)) || []
        list.push(point.clone())
        anchors.set(markKey("knee", side), list)
      }

      const labelAnchors = new Map()
      for (const [key, points] of anchors) {
        const used = points
        const anchor = new Vector3()
        for (const point of used) anchor.add(point)
        anchor.multiplyScalar(1 / used.length)
        anchor.y += 0.03
        const badge = document.createElement("div")
        badge.className = "body-stage-label"
        const label = new CSS2DObject(badge)
        label.position.copy(anchor)
        label.visible = false
        figure.add(label)
        labelAnchors.set(key, label)
      }

      function applyMarks() {
        const current = propsRef.current
        const state = buildMarkState({
          chiefSiteId: current.chiefSiteId,
          chiefSide: current.chiefSide,
          items: current.items,
        })
        for (const entry of markers) {
          const role = resolvePaintRole(entry.id, entry.side, state)
          entry.material.color.setHex(hexForRole(role, entry.base))
          const order = ordersFor(entry.id, entry.side, state)
          const label = labelAnchors.get(markKey(entry.id, entry.side))
          if (!label) continue
          label.visible = order.length > 0
          if (order.length) {
            label.element.textContent = order.join(" ")
            label.element.className =
              role === "workDone" ? "body-stage-label is-done" : "body-stage-label"
          }
        }
        // 深层肌肉被浅层盖住：单子上出现这类目标时自动「透视」，
        // 无关的组调淡，颜色和序号才看得见。不需要任何人按开关。
        const markedIds = new Set([state.chiefSiteId])
        for (const key of state.byKey.keys()) markedIds.add(String(key).split(":")[0])
        markedIds.delete(null)
        const xray = [...markedIds].some((id) => OCCLUDED_TARGETS.has(id))
        const dim = (material, marked) => {
          if (material.opacity === 0) return // 隐形拾取球不参与透视
          const faint = xray && !marked
          material.transparent = faint
          material.opacity = faint ? 0.12 : 1
          material.depthWrite = !faint
        }
        for (const entry of markers) dim(entry.material, markedIds.has(entry.id))
        dim(boneMat, false)
        dim(muscleMat, false)
        invalidate()
      }

      paintRef.current = applyMarks
      applyMarks()

      const picks = {}
      const byId = new Map()
      for (const [key, points] of anchors) {
        const id = String(key).split(":")[0]
        const list = byId.get(id) || []
        list.push(...points)
        byId.set(id, list)
      }
      for (const { id } of TARGETS) {
        const points = byId.get(id)
        if (!points?.length) continue
        const right = points.filter((point) => point.x >= -0.01)
        const used = right.length ? right : points
        const anchor = new Vector3()
        for (const point of used) anchor.add(point)
        anchor.multiplyScalar(1 / used.length)
        picks[id] = roundPoint(anchor)
      }
      view.dataset.picks = JSON.stringify(picks)
      view.dataset.camera = JSON.stringify(BODY_CAMERA)
      // 调试/自检钩子：件数和最终包围盒。归一化出过 NaN（整屏空白）的事故就靠这两个值兜住。
      view.dataset.meshes = String(pickMeshes.length + contextMeshCount)
      const allBounds = new Box3().setFromObject(figure)
      view.dataset.bounds = allBounds.isEmpty()
        ? ""
        : JSON.stringify({ min: roundPoint(allBounds.min), max: roundPoint(allBounds.max) })
      view.dataset.ready = "1"
      if (mounted) setPhase("ready")
    }

    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false })
      if (!renderer.getContext()) throw new Error("webgl")
      renderer.setClearColor(0xf3eadf, 1)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      renderer.domElement.style.display = "block"
      renderer.domElement.style.width = "100%"
      renderer.domElement.style.height = "100%"

      labelRenderer = new CSS2DRenderer()
      Object.assign(labelRenderer.domElement.style, {
        position: "absolute",
        left: "0",
        top: "0",
        pointerEvents: "none",
      })
      view.append(renderer.domElement, labelRenderer.domElement)

      const scene = new Scene()
      const camera = new PerspectiveCamera(BODY_CAMERA.fov, 1, 0.05, 30)
      camera.position.set(BODY_CAMERA.x, BODY_CAMERA.y, BODY_CAMERA.z)
      camera.lookAt(0, BODY_CAMERA.lookY, 0)

      scene.add(new HemisphereLight(0xfff7ef, 0xc8b19a, 0.85))
      const sun = new DirectionalLight(0xffffff, 1.25)
      sun.position.set(0.6, 1.6, 1.3)
      scene.add(sun)
      const fill = new DirectionalLight(0xffe4cc, 0.45)
      fill.position.set(-0.9, 0.4, -0.8)
      scene.add(fill)

      const figure = new Group()
      scene.add(figure)
      yawRef.current = (yaw) => {
        figure.rotation.y = yaw
        invalidate()
      }
      let camZ = BODY_CAMERA.z
      function setZoom(z) {
        camZ = Math.min(MAX_Z, Math.max(MIN_Z, z))
        camera.position.z = camZ
        invalidate()
      }
      zoomRef.current = (delta) => setZoom(camZ + delta)

      const pointer = new Vector2()
      const raycaster = new Raycaster()
      const pointers = new Set()
      const pointerPos = new Map()
      let drag = null
      let pinch = null

      function pick(clientX, clientY) {
        const rect = renderer.domElement.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return
        pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
        figure.updateMatrixWorld(true)
        raycaster.setFromCamera(pointer, camera)
        const ranked = raycaster.intersectObjects(pickMeshes, false).map((hit) => {
          const targetId = hit.object.userData.targetId
          return {
            hit,
            targetId,
            kind: targetById(targetId)?.kind || "muscle",
            distance: hit.distance,
          }
        })
        const chosen = chooseBodyHit(ranked)
        const id = chosen?.targetId
        if (!id) return
        const side = chosen.hit.object.userData.side ?? sideOf(chosen.hit.point, id)
        propsRef.current.onSelect?.(id, side)
      }

      function onDown(event) {
        if (event.pointerType === "mouse" && event.button !== 0) return
        pointers.add(event.pointerId)
        pointerPos.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (pointers.size >= 2) {
          drag = null
          const pts = [...pointerPos.values()]
          pinch = {
            dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
            z: camZ,
          }
          return
        }
        drag = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          lastX: event.clientX,
          turned: false,
        }
        try {
          view.setPointerCapture(event.pointerId)
        } catch {
          /* 捕获失败时仍按移动距离判断 */
        }
      }

      function onMove(event) {
        if (pointerPos.has(event.pointerId)) {
          pointerPos.set(event.pointerId, { x: event.clientX, y: event.clientY })
        }
        if (pinch && pointerPos.size >= 2) {
          const pts = [...pointerPos.values()]
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
          if (pinch.dist > 8 && dist > 8) setZoom(pinch.z * (pinch.dist / dist))
          return
        }
        if (!drag || event.pointerId !== drag.id || pointers.size > 1) return
        const dist = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
        if (dist > DRAG_PX) {
          drag.turned = true
          figure.rotation.y += (event.clientX - drag.lastX) * 0.008
          invalidate()
        }
        drag.lastX = event.clientX
      }

      function onUp(event) {
        pointers.delete(event.pointerId)
        pointerPos.delete(event.pointerId)
        if (pointerPos.size < 2) pinch = null
        if (!drag || drag.id !== event.pointerId) return
        const dist = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
        const turned = drag.turned
        drag = null
        if (turned || dist > DRAG_PX || pointers.size > 0) return
        if (dist < DRAG_PX) pick(event.clientX, event.clientY)
      }

      function onCancel(event) {
        pointers.delete(event.pointerId)
        pointerPos.delete(event.pointerId)
        if (pointerPos.size < 2) pinch = null
        if (drag?.id === event.pointerId) drag = null
      }

      listen(view, "pointerdown", onDown)
      listen(view, "pointermove", onMove)
      listen(view, "pointerup", onUp)
      listen(view, "pointercancel", onCancel)
      let contextLostRetried = false
      listen(renderer.domElement, "webglcontextlost", (event) => {
        event.preventDefault()
        fail()
        // 上下文丢失多半能自己恢复：自动重建一次，别让人手点「重试」；
        // 接连丢就不再硬试，交给手动重试。
        if (!contextLostRetried && mounted) {
          contextLostRetried = true
          window.setTimeout(() => {
            if (!mounted) return
            setPhase("loading")
            setProgress(0)
            setAttempt((n) => n + 1)
          }, 800)
        }
      })

      function resize() {
        const width = view.clientWidth
        const height = view.clientHeight
        if (width < 2 || height < 2 || !renderer || !labelRenderer) return
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height, false)
        labelRenderer.setSize(width, height)
        invalidate()
      }

      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(view)
      resize()

      function tick() {
        if (stopped) return
        frameId = requestAnimationFrame(tick)
        if (!dirty) return
        dirty = false
        try {
          renderer.render(scene, camera)
          labelRenderer.render(scene, camera)
        } catch {
          fail()
        }
      }
      tick()
      loadBody(figure).catch((err) => {
        // 加载失败的具体原因挂到节点上：真机上没法开 devtools，还能从 dataset 里看出来。
        try {
          view.dataset.error = String(err?.message || err)
        } catch {
          /* dataset 不可用就算了 */
        }
        fail()
      })
    } catch {
      fail()
    }

    return () => {
      mounted = false
      release()
    }
  }, [attempt])

  useEffect(() => {
    paintRef.current()
  }, [chiefSiteId, chiefSide, items])

  return (
    <section className={phase === "failed" ? "body-stage is-failed" : "body-stage"}>
      <div className="body-stage-view" ref={viewRef} />
      {reselecting && phase === "ready" ? <p className="body-stage-hint">再点一个地方，改要治的位置</p> : null}
      {phase === "ready" ? (
        <div className="body-stage-actions">
          <button type="button" onClick={() => yawRef.current?.(0)}>正面</button>
          <button type="button" onClick={() => yawRef.current?.(Math.PI)}>背面</button>
          <button type="button" onClick={() => zoomRef.current?.(-0.35)}>靠近</button>
          <button type="button" onClick={() => zoomRef.current?.(0.35)}>远离</button>
        </div>
      ) : null}
      {phase === "ready" ? (
        <p className="body-stage-credit">BodyParts3D，© Database Center for Life Science，CC BY 4.0</p>
      ) : null}
      {phase === "loading" ? (
        <p className="body-stage-fail">{`正在加载人体 ${progress}/${BODY_FILES.length}`}</p>
      ) : null}
      {phase === "failed" ? (
        <>
          <p className="body-stage-fail">模型没有加载出来</p>
          <div className="body-stage-actions">
            <button
              type="button"
              onClick={() => {
                setPhase("loading")
                setProgress(0)
                setAttempt((n) => n + 1)
              }}
            >
              重试
            </button>
          </div>
        </>
      ) : null}
    </section>
  )
}
