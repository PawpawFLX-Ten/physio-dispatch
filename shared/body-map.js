// BodyParts3D 4.0 区域网格。节点里已经换成 Y 轴向上的米。
export const BODY_FILES = [
  "knee.glb",
  "ankle-foot.glb",
  "hip-pelvis.glb",
  "spine-trunk.glb",
  "head-neck.glb",
  "shoulder.glb",
  "elbow-forearm.glb",
  "wrist-hand.glb",
  "supplement-knee-muscle.glb",
  "supplement-ankle-foot-muscle.glb",
  "supplement-hip-pelvis-muscle.glb",
  "supplement-shoulder-muscle.glb",
  "supplement-spine-trunk-muscle-erector-spinae.glb",
]

export const BODY_CAMERA = {
  fov: 34,
  x: 0,
  y: 0.82,
  z: 3.05,
  lookY: 0.82,
}

const TARGET_BY_SLUG = {
  patella: "knee",
  "tibiofemoral-joint": "knee",
  "patellar-tendon": "knee",
  "biceps-femoris": "hamstring",
  semitendinosus: "hamstring",
  semimembranosus: "hamstring",
  quadriceps: "quad",
  "gluteus-maximus": "glute",
  "gluteus-medius": "glute",
  "gluteus-minimus": "glute",
  soleus: "soleus",
  gastrocnemius: "gastroc",
  deltoid: "shoulder",
  "glenohumeral-joint": "shoulder",
  atlas: "neck",
  axis: "neck",
  "third-cervical-vertebra": "neck",
  "fourth-cervical-vertebra": "neck",
  "fifth-cervical-vertebra": "neck",
  "sixth-cervical-vertebra": "neck",
  "seventh-cervical-vertebra": "neck",
  sternocleidomastoid: "scm",
  "first-lumbar-vertebra": "lumbar",
  "second-lumbar-vertebra": "lumbar",
  "third-lumbar-vertebra": "lumbar",
  "fourth-lumbar-vertebra": "lumbar",
  "fifth-lumbar-vertebra": "lumbar",
  // 大腿与髋
  "adductor-brevis": "adductors",
  "adductor-longus": "adductors",
  "adductor-magnus": "adductors",
  gracilis: "adductors",
  sartorius: "sartorius",
  popliteus: "popliteus",
  "psoas-major": "iliopsoas",
  iliacus: "iliopsoas",
  piriformis: "piriformis",
  // 小腿与足
  "tibialis-anterior": "tib-anterior",
  "tibialis-posterior": "tib-posterior",
  "fibularis-longus": "fibularis",
  "fibularis-brevis": "fibularis",
  "extensor-digitorum-longus": "edl",
  "flexor-digitorum-longus": "fdl",
  // 肩背与颈
  trapezius: "trapezius",
  "levator-scapulae": "levator-scap",
  "rhomboid-major": "rhomboid",
  "serratus-anterior": "serratus",
  supraspinatus: "supraspinatus",
  infraspinatus: "infraspinatus",
  subscapularis: "subscapularis",
  "teres-minor": "teres-minor",
  "teres-major": "teres-major",
}

// 竖脊肌一直延伸到颈根：靠下的两段贴着腰椎算「腰」，其余胸段是竖脊肌下手项。
const LUMBAR_ERECTOR = new Set(["FJ1527", "FJ1527M", "FJ1535", "FJ1535M"])

export function meshSlug(name) {
  const parts = String(name || "").split(":")
  return parts.length > 1 ? parts[1] : ""
}

export function resolveMesh(name, file) {
  const slug = meshSlug(name)
  const fj = String(name || "").split(":").pop()
  if (slug === "erector-spinae") {
    // 靠下的两段贴着腰椎算「要治腰」，胸段点出来是竖脊肌自己的下手项。
    if (LUMBAR_ERECTOR.has(fj)) return { kind: "pick", targetId: "lumbar", tissue: "muscle" }
    return { kind: "pick", targetId: "erector-spinae", tissue: "muscle" }
  }
  const targetId = TARGET_BY_SLUG[slug]
  if (targetId) {
  const tissue =
    slug.includes("vertebra") ||
    slug.includes("joint") ||
    slug === "atlas" ||
    slug === "axis" ||
    slug === "patella"
      ? "bone"
      : "muscle"
    return { kind: "pick", targetId, tissue }
  }
  if (String(file).includes("supplement")) return { kind: "hide" }
  return { kind: "context", tissue: "bone" }
}
