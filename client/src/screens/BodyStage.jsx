// 预览人体使用 BodyParts3D 网格。正式小程序用同一批 glb，改由 xr-frame 加载。
import { useEffect, useRef, useState } from "react"
import {
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
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js"
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js"
import { hasSides, targetById, TARGETS } from "@shared/catalog.js"
import { BODY_CAMERA, BODY_FILES, meshSlug, resolveMesh } from "@shared/body-map.js"
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
// 要治的地方：偏暖、比骨表亮一档，仍比下手绿淡。
const CHIEF = 0xe08a4a
// 下手：能看出左右，但不刺眼。
const WORK = 0x3d8f6a
const WORK_DONE = 0x8fad9c
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
const sharedDraco = new DRACOLoader()
sharedDraco.setDecoderPath(`/draco/`)
sharedLoader.setDRACOLoader(sharedDraco)

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

    // 按需渲染：场景只在旋转/缩放/标记变化时重画一帧，静止时不空转 60fps。
    let dirty = true
    function invalidate() {
      dirty = true
    }

    function useMat(material) {
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
      }
      for (const geometry of geos) geometry.dispose()
      for (const material of mats) material.dispose()
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

    function track(mesh, targetId, tissue, baseHex) {
      const material = useMat(new MeshStandardMaterial({
        color: baseHex,
        roughness: 0.62,
        metalness: 0.02,
      }))
      // 换掉的材质属于缓存共享件，不能 dispose；geos 也只收本实例新建的。
      mesh.material = material
      const box = new Box3().setFromObject(mesh)
      const center = box.getCenter(new Vector3())
      const side = sideOf(center, targetId)
      mesh.userData.targetId = targetId
      mesh.userData.side = side
      pickMeshes.push(mesh)
      markers.push({ id: targetId, mesh, base: baseHex, side })
      const key = markKey(targetId, side)
      const list = anchors.get(key) || []
      list.push(center)
      anchors.set(key, list)
    }

    function addMarker(position, targetId, radius) {
      const geometry = new SphereGeometry(radius, 18, 14)
      geos.add(geometry)
      const base = restingColor(targetId, "node")
      const material = useMat(new MeshStandardMaterial({
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

      const footMeshes = []
      const kept = []
      for (const { file, scene } of models) {
        const meshes = []
        scene.traverse((obj) => {
          if (obj.isMesh) meshes.push(obj)
        })
        for (const mesh of meshes) {
          const name = mesh.userData.name || mesh.name || ""
          const decision = resolveMesh(name, file)
          if (decision.kind === "hide") {
            // geometry/material 与缓存共享：只摘下来，不 dispose。
            mesh.removeFromParent()
            continue
          }
          kept.push(mesh)
          mesh.userData.part = decision
          if (FOOT.test(meshSlug(name))) footMeshes.push(mesh)
          mesh.castShadow = false
          mesh.receiveShadow = false
        }
        content.add(scene)
      }

      figure.add(rig)
      figure.updateWorldMatrix(true, true)
      const measured = new Box3().setFromObject(content)
      const measuredSize = measured.getSize(new Vector3())
      const height = measuredSize.y || 1
      rig.scale.setScalar(1.68 / height)
      rig.updateMatrixWorld(true)
      const fitted = new Box3().setFromObject(rig)
      rig.position.set(
        -(fitted.min.x + fitted.max.x) / 2,
        -fitted.min.y,
        -(fitted.min.z + fitted.max.z) / 2,
      )
      figure.updateWorldMatrix(true, true)

      const boneMat = useMat(new MeshStandardMaterial({ color: BONE, roughness: 0.72, metalness: 0.02 }))
      const muscleMat = useMat(new MeshStandardMaterial({ color: MUSCLE, roughness: 0.58, metalness: 0.02 }))
      for (const mesh of kept) {
        const decision = mesh.userData.part
        if (decision.kind === "pick") {
          track(mesh, decision.targetId, decision.tissue, restingColor(decision.targetId, decision.tissue))
          continue
        }
        mesh.material = decision.tissue === "muscle" ? muscleMat : boneMat
      }

      const sideBoxes = (meshes) => {
        const sides = { left: new Box3(), right: new Box3() }
        let leftCount = 0
        let rightCount = 0
        for (const mesh of meshes) {
          const box = new Box3().setFromObject(mesh)
          if (box.isEmpty()) continue
          const center = box.getCenter(new Vector3())
          if (center.x >= 0) {
            sides.right.union(box)
            rightCount += 1
          } else {
            sides.left.union(box)
            leftCount += 1
          }
        }
        return [
          leftCount ? sides.left : null,
          rightCount ? sides.right : null,
        ].filter(Boolean)
      }

      const byTarget = (id) => kept.filter((mesh) => mesh.userData.targetId === id)
      for (const box of sideBoxes(byTarget("gastroc"))) {
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
        markers.push({ id: "chengshan", mesh: marker.mesh, base: marker.base, side: marker.side })
        const list = anchors.get(markKey("chengshan", marker.side)) || []
        list.push(point.clone())
        anchors.set(markKey("chengshan", marker.side), list)
      }
      for (const box of sideBoxes(byTarget("quad"))) {
        const point = box.getCenter(new Vector3())
        point.x = point.x >= 0 ? box.max.x + 0.02 : box.min.x - 0.02
        const marker = addMarker(point, "itband", 0.028)
        figure.add(marker.mesh)
        pickMeshes.push(marker.mesh)
        markers.push({ id: "itband", mesh: marker.mesh, base: marker.base, side: marker.side })
        const list = anchors.get(markKey("itband", marker.side)) || []
        list.push(point.clone())
        anchors.set(markKey("itband", marker.side), list)
      }
      for (const box of sideBoxes(footMeshes)) {
        const point = box.getCenter(new Vector3())
        point.y = box.min.y + 0.02
        const marker = addMarker(point, "plantar", 0.03)
        figure.add(marker.mesh)
        pickMeshes.push(marker.mesh)
        markers.push({ id: "plantar", mesh: marker.mesh, base: marker.base, side: marker.side })
        const list = anchors.get(markKey("plantar", marker.side)) || []
        list.push(point.clone())
        anchors.set(markKey("plantar", marker.side), list)
      }
      for (const mesh of byTarget("knee")) {
        const point = new Box3().setFromObject(mesh).getCenter(new Vector3())
        const geometry = new SphereGeometry(0.055, 16, 12)
        geos.add(geometry)
        const material = useMat(new MeshStandardMaterial({
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
        markers.push({ id: "knee", mesh: helper, base: restingColor("knee", "bone"), side })
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
          entry.mesh.material.color.setHex(hexForRole(role, entry.base))
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
      listen(renderer.domElement, "webglcontextlost", (event) => {
        event.preventDefault()
        fail()
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
      loadBody(figure).catch(() => fail())
    } catch {
      fail()
    }

    return () => {
      mounted = false
      release()
    }
  }, [])

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
      {phase === "failed" ? <p className="body-stage-fail">模型没有加载出来</p> : null}
    </section>
  )
}
