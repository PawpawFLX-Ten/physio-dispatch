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
  "supplement-arm-muscle.glb",
  "supplement-trunk-muscle.glb",
]

export const BODY_CAMERA = {
  fov: 34,
  x: 0,
  y: 0.82,
  z: 3.05,
  lookY: 0.82,
}

// 被浅层完全盖住、射线点不到的目标：单子上有它们时模型自动「透视」，
// 把无关的组调淡，好看见深层的颜色和序号（不用任何人按开关）。
export const OCCLUDED_TARGETS = new Set([
  "iliopsoas", // 髂腰肌：藏在腹腔里
  "piriformis", // 梨状肌：被臀肌盖住
  "popliteus", // 腘肌：膝关节深面
  "tib-posterior", // 胫骨后肌：小腿深层
  "fdl", // 趾长屈肌：小腿深层
  "subscapularis", // 肩胛下肌：肩胛骨深面
  "pectoralis-minor", // 胸小肌：胸大肌深面
  "erector-spinae", // 竖脊肌胸段：被斜方肌/菱形肌盖住（README 同款说明）
])

const TARGET_BY_SLUG = {
  patella: "knee",
  "tibiofemoral-joint": "knee",
  "patellar-tendon": "knee",
  "biceps-femoris": "hamstring",
  semitendinosus: "hamstring",
  semimembranosus: "hamstring",
  quadriceps: "quad",
  "gluteus-maximus": "glute",
  // 臀中肌有自己的下手项；臀大/臀小仍归「臀肌群」。
  "gluteus-medius": "glute-med",
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
  // 手臂与躯干补充：节点名里直接写最终 slug（scripts/build-body-supplements.mjs）
  "biceps-brachii": "biceps-brachii",
  "triceps-brachii": "triceps-brachii",
  brachioradialis: "brachioradialis",
  "forearm-extensors": "forearm-extensors",
  "forearm-flexors": "forearm-flexors",
  "pectoralis-major": "pectoralis-major",
  "pectoralis-minor": "pectoralis-minor",
  "obliquus-externus": "obliquus-externus",
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
