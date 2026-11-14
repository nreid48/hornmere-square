// Hornmere Square v2: third-person JRPG-style walkaround in an Atlas Gaussian-splat village.
import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SparkRenderer, SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode } from "@sparkjsdev/spark";

const params = new URLSearchParams(location.search);
const CAPTURE = params.has("capture");
if (CAPTURE) document.body.classList.add("capture");

// ---------------- scene data (world units come from the Atlas reconstruction) ----------------
const SCENE = params.get("scene") || ((await fetch("./assets/village_v6.spz", { method: "HEAD" })).ok ? "v6" : (await fetch("./assets/village_v5.spz", { method: "HEAD" })).ok ? "v5" : (await fetch("./assets/village_v4.spz", { method: "HEAD" })).ok ? "v4" : (await fetch("./assets/village_v3.spz", { method: "HEAD" })).ok ? "v3" : "v2");
const bounds = await (await fetch(`./assets/bounds_${SCENE}.json`)).json();
const [FA, FB, FC] = bounds.floorPlane;                 // floor: y = FA + FB*x + FC*z
const floorAt = (x, z) => FA + FB * x + FC * z;
const FOUNTAIN = (SCENE === "v4" || SCENE === "v5" || SCENE === "v6") ? { x: 1.81, z: -10.47, r: 2.4 } : SCENE === "v3" ? { x: 1.69, z: -10.09, r: 1.85 } : { x: 1.68, z: -9.74, r: 1.7 };
const HERO_SCALE = +(params.get("hero") || 1.0);
const CFG = {
  splat: params.get("spz") || `./assets/village_${SCENE}.spz`,
  spawn: { x: 0.2, z: -7.4, yaw: 0 },
  walk: 2.2, run: 4.6,
  camDist: 4.2, camHeight: 1.45,
};

// Things you can inspect that are part of the painted world.
const SPOTS = [
  { id: "gate", name: "The town gate", x: 1.9, y: 1.4, z: -21.6, r: 2.4,
    text: "Oak beams bound in black iron. Locked tight. The keyhole is the size of your thumb." },
  { id: "fountain", name: "The dry fountain", x: FOUNTAIN.x, y: 1.0, z: FOUNTAIN.z, r: 2.6,
    text: "Three tiers of weathered stone and not a drop of water. Someone has carved “B.” into the rim, next to an arrow pointing at the market." },
  { id: "stairs", name: "The inn stairs", x: 7.4, y: 1.3, z: -16.5, r: 2.2,
    text: "Worn wooden steps up to the inn. The third one creaks on purpose, to warn of late guests." },
  { id: "awning", name: "The cloth-seller's stall", x: -6.0, y: 1.6, z: -9.5, r: 2.2,
    text: "Bolts of dyed wool behind the shutters. A note on the door: “Back after the bells. — Bram”" },
];

// Props (Meshy models) with real-world sizes, mass and a line of text.
const PROPS = [
  { file: "basket_v2", name: "Apple basket", h: 0.48, mass: 8, x: -4.7, z: -12.2, yaw: 0.4, key: true,
    text: "Crisp red and green apples, and something cold underneath them…" },
  { file: "barrel_v2", name: "Rain barrel", h: 0.95, mass: 55, x: 6.6, z: -8.2, yaw: 0.2,
    text: "Full of rainwater. With the fountain dry, the whole square has been drawing from it." },
  { file: "barrel_v2", name: "Ale barrel", h: 0.95, mass: 55, x: 7.2, z: -9.3, yaw: 1.4,
    text: "Stamped with a horned bull. Hornmere's own brew, untouched." },
  { file: "crate_v2", name: "Crate of turnips", h: 0.72, mass: 22, x: -5.4, z: -7.4, yaw: 0.25,
    text: "Turnips packed in straw. Someone has scratched “NOT FOR THE GOAT” into the lid." },
  { file: "crate_v2", name: "Crate of candles", h: 0.6, mass: 15, x: -5.5, z: -7.4, yaw: -0.3, stackOn: 3,
    text: "Beeswax candles, bundled in twine, for the chapel up the hill." },
  { file: "sack_v2", name: "Sack of flour", h: 0.78, mass: 28, x: -5.9, z: -14.6, yaw: 0.6,
    text: "Milled this week. A thin trail of flour leads toward the baker's door." },
  { file: "sack_v2", name: "Sack of barley", h: 0.72, mass: 26, x: -5.3, z: -15.4, yaw: -0.5,
    text: "Barley for the brewer." },
  { file: "cart_v2", name: "Hand cart", h: 0.95, mass: 45, x: 5.8, z: -14.2, yaw: -2.2,
    text: "Bram's hand cart. One wheel squeaks, the other squeaks louder." },
  { file: "bucket_v2", name: "Empty bucket", h: 0.45, mass: 3, x: 4.8, z: -6.0, yaw: 0.0,
    text: "Bone dry. Whoever left it here was hoping the fountain would flow again." },
  { file: "stool_v2", name: "Stool", h: 0.6, mass: 5, x: -4.6, z: -11.0, yaw: 0.3,
    text: "Three legs, one wobble. Bram's market stool." },
  { file: "pot_v2", name: "Storage jar", h: 0.85, mass: 20, x: 7.0, z: -12.2, yaw: 0.9,
    text: "Sealed with a cork. It smells faintly of pickled onions." },
  { file: "lantern_v2", name: "Street lantern", h: 1.75, mass: 0, x: -2.6, z: -18.4, yaw: 0.0,
    text: "Amber glass in an iron cage. The flame hums faintly, as if it's pleased with itself." },
  { file: "lantern_v2", name: "Street lantern", h: 1.75, mass: 0, x: 5.4, z: -18.8, yaw: 0.0,
    text: "Amber glass in an iron cage, lit early for the evening market." },
];

// Quest: like a JRPG opening errand.
const QUEST = [
  { text: "Look around the square", target: "fountain", done: (s) => s.inspected.fountain },
  { text: "Find Bram's hidden key", target: "basket", done: (s) => s.hasKey },
  { text: "Through the archway", target: "gate", done: (s) => s.gateOpen },
];

// ---------------- renderer ----------------
let W = CAPTURE ? +(params.get("w") || 1280) : innerWidth;
let H = CAPTURE ? +(params.get("h") || 720) : innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: CAPTURE, powerPreference: "high-performance" });
const MOBILE = matchMedia("(pointer: coarse)").matches;
renderer.setPixelRatio(CAPTURE ? 1 : Math.min(devicePixelRatio, MOBILE ? 1.25 : 2));   // phones: keep 2M splats smooth
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fbbe6);
const camera = new THREE.PerspectiveCamera(55, W / H, 0.05, 400);
scene.add(new SparkRenderer({ renderer }));
const village = new SplatMesh({ url: CFG.splat });
scene.add(village);

// Warm late-afternoon light, matched to the painted sun (from the back-left of the square).
scene.add(new THREE.HemisphereLight(0xfff0d8, 0x9a7a52, 0.9));
const sun = new THREE.DirectionalLight(0xffe2b8, 2.4);
sun.position.set(-9, 14, -20);
sun.target.position.set(1, 0, -12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 60 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 4;
scene.add(sun, sun.target);

// Shadow catcher on the cobbles: the splats can't receive shadows, so this plane does it for them.
{
  const n = new THREE.Vector3(-FB, 1, -FC).normalize();
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ color: 0x3a1e08, opacity: 0.42 }));
  catcher.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  catcher.position.set(1, floorAt(1, -12) + 0.055, -12);
  catcher.receiveShadow = true;
  catcher.renderOrder = 2;
  scene.add(catcher);
}

// ---------------- painted ground, deep dry fountain, sky (meshes replace the noisiest splats) ----------------
{
  const texLoader = new THREE.TextureLoader();
  const tex = (f, rep) => { const t = texLoader.load(`./assets/tex/${f}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; if (rep) t.repeat.set(rep[0], rep[1]); return t; };
  const n = new THREE.Vector3(-FB, 1, -FC).normalize();
  const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  const fy = floorAt(FOUNTAIN.x, FOUNTAIN.z);
  const INNER = FOUNTAIN.r - 0.35;                     // basin inner radius
  const LIT = new THREE.Color(1.0, 0.96, 0.9);         // matches the splats' warm painted exposure

  // 1) hide the splat floor (a thin slab) and the splat basin interior
  const hide = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.03 });
  const slab = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0, color: new THREE.Color(1, 1, 1) });
  const [cx, cz] = bounds.center;
  // top at +0.2: also clears the pale low splat "skirts" along the building bases (the mesh ground runs under the walls)
  slab.position.set(cx, floorAt(cx, cz) - 0.2, cz); slab.quaternion.copy(tilt); slab.scale.set(40, 0.4, 40);
  // the whole splat fountain goes (rim included); the meshes below replace it
  const bowl = new SplatEditSdf({ type: SplatEditSdfType.CYLINDER, radius: FOUNTAIN.r + 0.3, opacity: 0, color: new THREE.Color(1, 1, 1) });
  bowl.position.set(FOUNTAIN.x, fy + 0.6, FOUNTAIN.z); bowl.scale.set(1, 2.2, 1);
  hide.add(slab); hide.add(bowl); hide.addSdf(slab); hide.addSdf(bowl); scene.add(hide);
  // warm colour grade on the splats: the reconstruction drifted lilac; the target is cream plaster in warm sun
  const grade = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY });
  // v5 (Chisel) is already warm: pull it slightly cooler toward the target's cream plaster instead
  const all = new SplatEditSdf({ type: SplatEditSdfType.ALL, color: (SCENE === "v5" || SCENE === "v6") ? new THREE.Color(0.95, 0.95, 1.0) : new THREE.Color(1.0, 0.94, 0.83), opacity: 1 });
  grade.add(all); grade.addSdf(all); scene.add(grade);

  // 2) painted cobble ground over the walkable area (pushed under the walls), with a hole for the basin
  const shape = new THREE.Shape(), [pcx, pcz] = bounds.center;
  bounds.polygon.forEach(([x, z], i) => { const dx = x - pcx, dz = z - pcz, l = Math.hypot(dx, dz), X = x + dx / l * 2.6, Z = -(z + dz / l * 2.6); /* well under the walls: no dark wedge at the building bases */ i ? shape.lineTo(X, Z) : shape.moveTo(X, Z); });
  const hole = new THREE.Path(); hole.absarc(FOUNTAIN.x, -FOUNTAIN.z, INNER, 0, Math.PI * 2, true); shape.holes.push(hole);
  const gGeo = new THREE.ShapeGeometry(shape, 48); gGeo.rotateX(-Math.PI / 2);
  const p = gGeo.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, floorAt(p.getX(i), p.getZ(i)) + 0.04);
  const uv = gGeo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / 5.5, p.getZ(i) / 5.5);
  // break up tiling: warm sunlit patches and cooler worn areas, like the painted target
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const nse = 0.5 + 0.25 * Math.sin(x * 0.55 + z * 0.21) + 0.25 * Math.sin(z * 0.47 - x * 0.18 + 1.7);
    col.set([1.12 + 0.12 * nse, 1.0 + 0.08 * nse, 0.86 + 0.02 * nse], i * 3);
  }
  gGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  gGeo.computeVertexNormals();
  const ground = new THREE.Mesh(gGeo, new THREE.MeshBasicMaterial({ map: tex("cobbles"), vertexColors: true }));
  scene.add(ground);

  // 3) deep, dry basin: inner wall down below the street, flagstone floor, rim cap, tiered column
  const DEPTH = 0.45, RIM = 0.6;
  const wallH = DEPTH + RIM;
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(INNER, INNER, wallH, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: tex("basin_wall", [6, 1]), color: LIT.clone().multiplyScalar(0.82), side: THREE.BackSide }));
  wall.position.set(FOUNTAIN.x, fy - DEPTH + wallH / 2, FOUNTAIN.z); scene.add(wall);
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(INNER + 0.32, INNER + 0.38, RIM, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: tex("basin_wall", [7, 0.55]), color: new THREE.Color(0.86, 0.78, 0.7) }));
  outer.position.set(FOUNTAIN.x, fy + RIM / 2, FOUNTAIN.z); scene.add(outer);
  // rounded capstones along the rim
  const cap = new THREE.Mesh(new THREE.TorusGeometry(INNER + 0.17, 0.2, 10, 64),
    new THREE.MeshBasicMaterial({ map: tex("basin_wall", [14, 1]), color: new THREE.Color(1.18, 1.1, 1.0) }));
  cap.rotation.x = -Math.PI / 2; cap.scale.set(1, 1, 0.75); cap.position.set(FOUNTAIN.x, fy + RIM, FOUNTAIN.z); scene.add(cap);
  const floorDisk = new THREE.Mesh(new THREE.CircleGeometry(INNER, 48),
    new THREE.MeshBasicMaterial({ map: tex("basin_floor", [1.6, 1.6]), color: LIT.clone().multiplyScalar(0.78) }));
  floorDisk.rotation.x = -Math.PI / 2; floorDisk.position.set(FOUNTAIN.x, fy - DEPTH, FOUNTAIN.z); scene.add(floorDisk);
  // carved two-tier fountain: plinth, fluted stem, wide curved lower bowl, slim stem, small upper bowl, finial
  const prof = [[0, 0], [0.5, 0], [0.5, 0.14], [0.36, 0.2], [0.26, 0.3], [0.22, 0.75], [0.26, 0.84], [0.45, 0.9], [0.75, 0.98], [0.98, 1.1],
    [1.05, 1.18], [1.0, 1.22], [0.7, 1.18], [0.3, 1.2], [0.15, 1.28], [0.13, 1.6], [0.2, 1.66], [0.42, 1.72], [0.5, 1.8], [0.46, 1.84],
    [0.2, 1.84], [0.1, 1.9], [0.1, 2.05], [0.14, 2.1], [0.08, 2.2], [0.03, 2.32], [0, 2.36]].map(([r, y]) => new THREE.Vector2(r, y));
  const column = new THREE.Mesh(new THREE.LatheGeometry(prof, 36), new THREE.MeshToonMaterial({ map: tex("basin_wall", [3, 2]), gradientMap: TOON_BANDS_EARLY() }));
  column.position.set(FOUNTAIN.x, fy - DEPTH, FOUNTAIN.z); column.castShadow = true; scene.add(column);

  // 4) painted sky dome behind any gaps above the rooftops
  const c = document.createElement("canvas"); c.width = 512; c.height = 512; const g2 = c.getContext("2d");
  const gr = g2.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "#6f9fd8"); gr.addColorStop(0.45, "#a9c9ec"); gr.addColorStop(0.49, "#d8cbb4"); gr.addColorStop(0.5, "#7a6450"); gr.addColorStop(1, "#5e4b3c");   // below the horizon: dark stone, so gaps under walls never show a pale seam
  g2.fillStyle = gr; g2.fillRect(0, 0, 512, 512);
  // big soft cumulus clouds like the painting: white tops, lavender undersides
  for (let i = 0; i < 9; i++) {
    const x = (i * 61 + 20) % 512, y = 90 + (i * 37) % 110, r = 26 + (i * 11) % 22;
    for (let k = 0; k < 7; k++) {
      const px = x + (k - 3) * r * 0.62, py = y - Math.abs(3 - k) * -r * 0.18 - (k % 2) * r * 0.3, rr = r * (1 - Math.abs(3 - k) * 0.12);
      g2.fillStyle = "rgba(200,190,225,.85)"; g2.beginPath(); g2.arc(px, py + rr * 0.25, rr, 0, 7); g2.fill();
      g2.fillStyle = "rgba(255,255,255,.95)"; g2.beginPath(); g2.arc(px, py, rr * 0.92, 0, 7); g2.fill();
    }
  }
  const skyTex = new THREE.CanvasTexture(c); skyTex.colorSpace = THREE.SRGBColorSpace; skyTex.wrapS = THREE.RepeatWrapping;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: false }));
  sky.position.set(cx, 0, cz); sky.renderOrder = -1; scene.add(sky);
}
function TOON_BANDS_EARLY() { const d = new Uint8Array([150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]); const t = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat); t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; }

// ---------------- physics ----------------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
const matWorld = new CANNON.Material("world"), matPlayer = new CANNON.Material("player"), matProp = new CANNON.Material("prop");
world.addContactMaterial(new CANNON.ContactMaterial(matPlayer, matWorld, { friction: 0, restitution: 0 }));
world.addContactMaterial(new CANNON.ContactMaterial(matPlayer, matProp, { friction: 0, restitution: 0 }));
world.addContactMaterial(new CANNON.ContactMaterial(matProp, matWorld, { friction: 0.7, restitution: 0.02 }));
world.addContactMaterial(new CANNON.ContactMaterial(matProp, matProp, { friction: 0.6, restitution: 0.02 }));
{
  const n = new THREE.Vector3(-FB, 1, -FC).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const floor = new CANNON.Body({ mass: 0, material: matWorld, shape: new CANNON.Plane() });
  floor.quaternion.set(q.x, q.y, q.z, q.w); floor.position.set(0, FA, 0);
  world.addBody(floor);
}
const POLY = bounds.polygon;                               // walkable edge of the square, [x,z]
{
  const [cx, cz] = bounds.center;
  for (let i = 0; i < POLY.length; i++) {
    const [x1, z1] = POLY[i], [x2, z2] = POLY[(i + 1) % POLY.length];
    const len = Math.hypot(x2 - x1, z2 - z1) + 0.4;
    let mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
    const ox = mx - cx, oz = mz - cz, ol = Math.hypot(ox, oz);
    mx += ox / ol * 0.4; mz += oz / ol * 0.4;
    const wall = new CANNON.Body({ mass: 0, material: matWorld, shape: new CANNON.Box(new CANNON.Vec3(len / 2, 4, 0.4)) });
    wall.position.set(mx, floorAt(mx, mz) + 3.5, mz);
    wall.quaternion.setFromEuler(0, -Math.atan2(z2 - z1, x2 - x1), 0);
    world.addBody(wall);
  }
  const f = new CANNON.Body({ mass: 0, material: matWorld, shape: new CANNON.Cylinder(FOUNTAIN.r, FOUNTAIN.r, 1.6, 24) });
  f.position.set(FOUNTAIN.x, floorAt(FOUNTAIN.x, FOUNTAIN.z) + 0.6, FOUNTAIN.z);
  world.addBody(f);
}
// The camera may float a little beyond the walkable edge (the walls are set back from it).
const CAM_POLY = POLY.map(([x, z]) => { const [cx, cz] = bounds.center, dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz); return [x - dx / l * 0.3, z - dz / l * 0.3]; });
function insidePoly(x, z, poly = POLY) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}

// ---------------- loading ----------------
const loader = new GLTFLoader();
const load = (f) => new Promise((res, rej) => loader.load(`./assets/models/${f}.glb`, res, undefined, rej));
const status = (t) => { const el = document.getElementById("go"); if (el) el.textContent = t; };

// ---------------- toon shading ----------------
// Hero and props use cel shading: 3 soft light bands with a warm lit tone and a cool shadow tone (like the painted world),
// plus a thin ink outline. Textures should carry colour only; the game supplies the light.
const TOON_BANDS = (() => {
  const d = new Uint8Array([150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]); // shadow, mid, lit
  const t = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t;
})();
const SHADOW_TINT = new THREE.Color(0x8d8fc4);   // cool blue-violet shadows, as in the painting
function toonify(root, { outline = 0.012, matte = false } = {}) {
  const outlines = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const old = o.material;
    const mats = (Array.isArray(old) ? old : [old]).map(m => {
      const t = new THREE.MeshToonMaterial({ map: m.map || null, color: m.color ? m.color.clone() : new THREE.Color(1, 1, 1), gradientMap: TOON_BANDS,
        transparent: m.transparent, alphaTest: m.alphaTest || 0, side: m.side });
      t.onBeforeCompile = (s) => {   // tint the dark bands cool instead of plain grey
        s.uniforms.shadowTint = { value: SHADOW_TINT };
        s.fragmentShader = "uniform vec3 shadowTint;\n" + s.fragmentShader.replace("#include <opaque_fragment>",
          "float lum = dot(outgoingLight, vec3(0.299,0.587,0.114)) / max(0.001, dot(diffuseColor.rgb, vec3(0.299,0.587,0.114)));\n" +
          "outgoingLight = mix(outgoingLight * mix(vec3(1.0), shadowTint * 1.3, 0.6), outgoingLight, smoothstep(0.45, 0.95, lum));\n" +
          (matte ? "outgoingLight = mix(vec3(dot(outgoingLight, vec3(0.299,0.587,0.114))), outgoingLight, 0.78) * vec3(1.0,0.97,0.93);\n" : "") +
          "#include <opaque_fragment>");
      };
      return t;
    });
    o.material = Array.isArray(old) ? mats : mats[0];
    const twoSided = (Array.isArray(old) ? old : [old]).some(m => m.side === THREE.DoubleSide);
    if (outline > 0 && !twoSided) outlines.push(o);   // an outline shell shows through double-sided meshes
    for (const m of mats) m.side = THREE.FrontSide;
  });
  for (const o of outlines) {   // inverted-hull ink outline
    const mat = new THREE.MeshBasicMaterial({ color: 0x3a2414, side: THREE.BackSide });
    mat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\ntransformed += normal * ${outline.toFixed(4)};`); };
    const hull = o.isSkinnedMesh ? new THREE.SkinnedMesh(o.geometry, mat) : new THREE.Mesh(o.geometry, mat);
    if (o.isSkinnedMesh) hull.bind(o.skeleton, o.bindMatrix);
    hull.castShadow = false; hull.frustumCulled = false;
    o.parent.add(hull); hull.position.copy(o.position); hull.quaternion.copy(o.quaternion); hull.scale.copy(o.scale);
  }
}

// Props
const PROP_BLOB_MAT = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
  const gr = x.createRadialGradient(64, 64, 4, 64, 64, 62); gr.addColorStop(0, "rgba(55,38,60,.6)"); gr.addColorStop(0.55, "rgba(55,38,60,.28)"); gr.addColorStop(1, "rgba(55,38,60,0)");
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
})();
const props = [];
const propFiles = [...new Set(PROPS.map(p => p.file))];
const gltfs = Object.fromEntries(await Promise.all(propFiles.map(async f => [f, await load(f)])));
for (const def of PROPS) {
  const src = gltfs[def.file].scene;
  const box0 = new THREE.Box3().setFromObject(src);
  const size0 = box0.getSize(new THREE.Vector3());
  const s = def.h / size0.y;
  const inner = src.clone(true);
  inner.scale.setScalar(s);
  inner.position.set(-(box0.min.x + box0.max.x) / 2 * s, -(box0.min.y + box0.max.y) / 2 * s, -(box0.min.z + box0.max.z) / 2 * s);
  inner.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  toonify(inner, { outline: 0.012 / s, matte: true });
  const holder = new THREE.Group(); holder.add(inner); scene.add(holder);
  const half = new CANNON.Vec3(size0.x * s / 2 * 0.92, size0.y * s / 2, size0.z * s / 2 * 0.92);
  const round = /barrel|bucket|pot/.test(def.file);
  const shape = round ? new CANNON.Cylinder(Math.min(half.x, half.z), Math.min(half.x, half.z), half.y * 2, 14) : new CANNON.Box(half);
  const body = new CANNON.Body({ mass: def.mass, material: matProp, shape, linearDamping: 0.75, angularDamping: 0.9 });
  body.sleepSpeedLimit = 0.08; body.sleepTimeLimit = 0.4;
  let y = floorAt(def.x, def.z) + half.y + 0.01;
  if (def.stackOn != null) { const under = props[def.stackOn]; y = under.body.position.y + under.half.y + half.y + 0.01; }
  body.position.set(def.x, y, def.z);
  body.quaternion.setFromEuler(0, def.yaw || 0, 0);
  world.addBody(body);
  holder.position.copy(body.position); holder.quaternion.copy(body.quaternion);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), PROP_BLOB_MAT);
  blob.rotation.x = -Math.PI / 2; blob.scale.set(half.x * 2.9, half.z * 2.9, 1); blob.renderOrder = 3;
  blob.position.set(def.x, floorAt(def.x, def.z) + 0.05, def.z); scene.add(blob);
  const prop = { ...def, id: def.key ? "basket" : def.file + props.length, holder, body, half, blob, kind: "prop" };
  props.push(prop);
}

// Hero
status("Loading hero…");
const heroGltf = await load(params.get("heroModel") || "hero_v4_anim_0_30_14");   // unlit-texture Sol, lit by the toon shader
const hero = heroGltf.scene;
hero.scale.setScalar(HERO_SCALE);
hero.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
toonify(hero, { outline: 0.016 });
scene.add(hero);
// Soft painted contact shadow that follows the hero (the splat ground can't receive real shadows up close).
const heroBlob = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
  const gr = x.createRadialGradient(64, 64, 4, 64, 64, 62); gr.addColorStop(0, "rgba(60,40,70,.55)"); gr.addColorStop(0.6, "rgba(60,40,70,.25)"); gr.addColorStop(1, "rgba(60,40,70,0)");
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.1 * HERO_SCALE, 0.9 * HERO_SCALE), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.renderOrder = 3; scene.add(m); return m;
})();
const mixer = new THREE.AnimationMixer(hero);
const clip = (n) => heroGltf.animations.find(a => a.name.toLowerCase().includes(n));
const actions = { idle: mixer.clipAction(clip("idle")), walk: mixer.clipAction(clip("walk")), run: mixer.clipAction(clip("run")) };
for (const a of Object.values(actions)) { a.play(); a.setEffectiveWeight(0); }
actions.idle.setEffectiveWeight(1);

const player = new CANNON.Body({ mass: 70, material: matPlayer, fixedRotation: true, linearDamping: 0 });
player.addShape(new CANNON.Sphere(0.3 * HERO_SCALE), new CANNON.Vec3(0, 0.3 * HERO_SCALE, 0));
player.addShape(new CANNON.Sphere(0.3 * HERO_SCALE), new CANNON.Vec3(0, 0.9 * HERO_SCALE, 0));
player.allowSleep = false;
player.position.set(CFG.spawn.x, floorAt(CFG.spawn.x, CFG.spawn.z) + 0.02, CFG.spawn.z);
world.addBody(player);

// ---------------- HUD (drawn on its own canvas so captures include it) ----------------
const hud = document.createElement("canvas");
hud.id = "hud"; document.body.appendChild(hud);
const g = hud.getContext("2d");
const portrait = new Image(); portrait.src = "./assets/ui/portrait.png";
function sizeHud() { const dpr = CAPTURE ? 1 : Math.min(devicePixelRatio, 2); hud.width = W * dpr; hud.height = H * dpr; hud.style.width = W + "px"; hud.style.height = H + "px"; g.setTransform(dpr, 0, 0, dpr, 0, 0); }
sizeHud();

const state = { inspected: {}, hasKey: false, gateOpen: false, step: 0, dialog: null, toast: null, banner: null };
const targets = () => [...SPOTS.map(s => ({ ...s, kind: "spot", pos: new THREE.Vector3(s.x, floorAt(s.x, s.z) + s.y, s.z) })),
  ...props.map(p => ({ ...p, pos: new THREE.Vector3(p.body.position.x, p.body.position.y + p.half.y + 0.25, p.body.position.z), r: 1.6 + Math.max(p.half.x, p.half.z) }))];
const findTarget = (id) => targets().find(t => t.id === id);

const C = { gold: "#f2c35a", cream: "#fff3da", ink: "#2b1a0e", panel: "rgba(24,14,6,.62)", panelEdge: "rgba(242,195,90,.55)" };
function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function text(t, x, y, font, color, align = "left", shadow = true) {
  g.font = font; g.textAlign = align; g.fillStyle = color;
  if (shadow) { g.shadowColor = "rgba(0,0,0,.7)"; g.shadowBlur = 6; }
  g.fillText(t, x, y); g.shadowBlur = 0; g.textAlign = "left";
}
function project(v) { const p = v.clone().project(camera); return { x: (p.x + 1) / 2 * W, y: (1 - p.y) / 2 * H, front: p.z < 1 }; }
function keyIcon(x, y, s) {
  g.save(); g.translate(x, y); g.scale(s, s); g.strokeStyle = "#f2c35a"; g.fillStyle = "#f2c35a"; g.lineWidth = 3;
  g.beginPath(); g.arc(-8, 0, 6, 0, 7); g.stroke(); g.fillRect(-2, -1.5, 16, 3); g.fillRect(9, 1, 3, 5); g.fillRect(4, 1, 3, 4); g.restore();
}
function wrap(t, maxW) { const out = []; let line = ""; for (const w of t.split(" ")) { const tt = line ? line + " " + w : w; if (g.measureText(tt).width > maxW && line) { out.push(line); line = w; } else line = tt; } if (line) out.push(line); return out; }

function drawHud(nearest) {
  g.clearRect(0, 0, W, H);
  const q = QUEST[Math.min(state.step, QUEST.length - 1)], done = state.step >= QUEST.length;
  // quest tracker (top-left)
  const tgt = done ? null : findTarget(q.target);
  const dist = tgt ? Math.round(Math.hypot(tgt.pos.x - player.position.x, tgt.pos.z - player.position.z)) : 0;
  g.font = "800 17px Nunito"; const qw = Math.max(210, g.measureText(done ? "Quest complete" : q.text).width + 110);
  rr(18, 18, qw, 46, 23); g.fillStyle = C.panel; g.fill(); g.strokeStyle = C.panelEdge; g.lineWidth = 1.5; g.stroke();
  g.beginPath(); g.arc(41, 41, 13, 0, 7); g.fillStyle = C.gold; g.fill();
  text("!", 41, 47, "800 17px Nunito", C.ink, "center", false);
  text(done ? "Quest complete" : q.text, 62, 47, "800 17px Nunito", C.cream);
  if (!done) { rr(18 + qw - 52, 29, 40, 24, 12); g.fillStyle = "rgba(242,195,90,.2)"; g.fill(); text(dist + "m", 18 + qw - 32, 46, "800 13px Nunito", C.gold, "center"); }
  // compass minimap (top-right)
  const small = W < 560, mr = small ? 40 : 64, mx = W - mr - 18, my = small ? 120 : 86;   // phones: smaller map, below the quest bar
  g.save(); g.beginPath(); g.arc(mx, my, mr, 0, 7); g.fillStyle = "rgba(240,224,190,.88)"; g.fill(); g.clip();
  const yawNow = camYaw, sc = 3.1;
  const toMap = (x, z) => { const dx = (x - player.position.x) * sc, dz = (z - player.position.z) * sc;
    const c = Math.cos(yawNow), s = Math.sin(yawNow); return [mx + dx * c - dz * s, my + dx * s + dz * c]; };
  g.beginPath(); POLY.forEach(([x, z], i) => { const [px, py] = toMap(x, z); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.closePath();
  g.fillStyle = "rgba(196,160,108,.9)"; g.fill(); g.strokeStyle = "rgba(90,52,20,.9)"; g.lineWidth = 2.5; g.stroke();
  { const [fx, fy] = toMap(FOUNTAIN.x, FOUNTAIN.z); g.beginPath(); g.arc(fx, fy, FOUNTAIN.r * sc, 0, 7); g.fillStyle = "rgba(120,96,70,.9)"; g.fill(); }
  if (tgt) { const [tx, ty] = toMap(tgt.pos.x, tgt.pos.z); g.beginPath(); g.arc(tx, ty, 5, 0, 7); g.fillStyle = "#d9452b"; g.fill(); g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.stroke(); }
  g.restore();
  g.beginPath(); g.arc(mx, my, mr, 0, 7); g.strokeStyle = "#6b4520"; g.lineWidth = 4; g.stroke(); g.strokeStyle = C.gold; g.lineWidth = 1.5; g.stroke();
  // player arrow
  { const a = heroFacing - camYaw; g.save(); g.translate(mx, my); g.rotate(-a + Math.PI); g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(0, 3); g.lineTo(-6, 7); g.closePath(); g.fillStyle = "#2a6fd6"; g.fill(); g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.stroke(); g.restore(); }
  { const nx = mx + Math.sin(-camYaw + Math.PI) * (mr - 10), ny = my + Math.cos(-camYaw + Math.PI) * (mr - 10); text("N", nx, ny + 5, "800 13px Cinzel", "#7a2d10", "center", false); }
  text("Hornmere Square", mx, my + mr + 22, "600 14px Cinzel", C.cream, "center");
  // portrait (bottom-left)
  const px = 26, py = H - 96;
  g.beginPath(); g.arc(px + 36, py + 36, 38, 0, 7); g.fillStyle = "#3a2410"; g.fill();
  if (portrait.complete) { g.save(); g.beginPath(); g.arc(px + 36, py + 36, 34, 0, 7); g.clip(); g.drawImage(portrait, px + 2, py + 2, 68, 68); g.restore(); }
  g.beginPath(); g.arc(px + 36, py + 36, 36, 0, 7); g.strokeStyle = C.gold; g.lineWidth = 3; g.stroke();
  text("Sol", px + 84, py + 30, "800 20px Cinzel", C.cream);
  for (let i = 0; i < 5; i++) { const hx = px + 92 + i * 20, hy = py + 50; g.save(); g.translate(hx, hy); g.fillStyle = "#e0483a"; g.beginPath(); g.moveTo(0, 5); g.bezierCurveTo(-9, -2, -5, -9, 0, -4); g.bezierCurveTo(5, -9, 9, -2, 0, 5); g.fill(); g.restore(); }
  // inventory (bottom-right)
  for (let i = 0; i < 3; i++) {
    const bx = W - 62 - i * 56, by = H - 70;
    rr(bx, by, 46, 46, 10); g.fillStyle = C.panel; g.fill(); g.strokeStyle = C.panelEdge; g.lineWidth = 1.5; g.stroke();
    if (i === 0 && state.hasKey) keyIcon(bx + 23, by + 23, 1.15);
  }
  // world markers: waypoint diamond over the quest target, inspect bubble over the nearest thing
  if (tgt) {
    const p = project(tgt.pos.clone().add(new THREE.Vector3(0, 0.9, 0)));
    if (p.front && (!nearest || nearest.id !== tgt.id)) {
      const x = Math.max(30, Math.min(W - 30, p.x)), y = Math.max(90, Math.min(H - 120, p.y));
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4); g.fillStyle = C.gold; g.strokeStyle = "#5a2e0c"; g.lineWidth = 2; g.fillRect(-7, -7, 14, 14); g.strokeRect(-7, -7, 14, 14); g.restore();
      text(dist + " m", x, y + 26, "800 13px Nunito", C.cream, "center");
    }
  }
  if (nearest && !state.dialog) {
    const p = project(nearest.pos);
    if (p.front) {
      const label = nearest.id === "gate" && state.hasKey ? "Unlock" : "Inspect";
      g.font = "800 15px Nunito"; const w = g.measureText(label).width + 50;
      rr(p.x - w / 2, p.y - 18, w, 32, 16); g.fillStyle = "rgba(255,247,232,.94)"; g.fill(); g.strokeStyle = "rgba(90,52,20,.5)"; g.lineWidth = 1; g.stroke();
      rr(p.x - w / 2 + 6, p.y - 12, 22, 20, 5); g.fillStyle = C.ink; g.fill();
      text("E", p.x - w / 2 + 17, p.y + 3, "800 13px Nunito", C.cream, "center", false);
      text(label, p.x - w / 2 + 36, p.y + 4, "800 15px Nunito", C.ink, "left", false);
    }
  }
  // dialog box
  if (state.dialog) {
    const d = state.dialog, w = Math.min(760, W - 40), x = (W - w) / 2;
    g.font = "600 19px Nunito"; const shown = d.text.slice(0, Math.floor(d.chars)); const lines = wrap(d.text, w - 150);
    const h = 64 + lines.length * 27, y = H - 30 - h;
    g.shadowColor = "rgba(0,0,0,.5)"; g.shadowBlur = 24; rr(x, y, w, h, 14); g.fillStyle = "rgba(255,248,234,.96)"; g.fill(); g.shadowBlur = 0;
    g.strokeStyle = "#c79a4a"; g.lineWidth = 2; g.stroke();
    rr(x + 22, y - 16, g.measureText(d.name).width + 36, 32, 16); g.fillStyle = "#6b3a12"; g.fill();
    text(d.name, x + 40, y + 6, "800 16px Cinzel", C.cream, "left", false);
    let left = shown.length;
    lines.forEach((l, i) => { const part = l.slice(0, Math.max(0, left)); left -= l.length + 1; text(part, x + 32, y + 52 + i * 27, "600 19px Nunito", C.ink, "left", false); });
    if (d.chars >= d.text.length) { const t = performance.now() / 300; text("▼", x + w - 30, y + h - 14 + Math.sin(t) * 2, "12px Nunito", "#8a5a22", "center", false); }
  }
  if (state.toast) { const a = Math.min(1, state.toast.t); g.globalAlpha = a; rr(W / 2 - 150, 92, 300, 40, 20); g.fillStyle = C.panel; g.fill(); keyIcon(W / 2 - 112, 112, 1); text(state.toast.text, W / 2 + 12, 118, "800 16px Nunito", C.cream, "center"); g.globalAlpha = 1; }
  if (state.banner) { const a = Math.min(1, state.banner.t); g.globalAlpha = a; text(state.banner.text, W / 2, H * 0.26, "800 52px Cinzel", C.gold, "center"); g.globalAlpha = 1; }
}

// ---------------- interaction ----------------
function say(name, t) { state.dialog = { name, text: t, chars: 0 }; }
function interact() {
  if (state.dialog) { if (state.dialog.chars < state.dialog.text.length) state.dialog.chars = state.dialog.text.length; else state.dialog = null; return; }
  const t = nearestTarget(); if (!t) return;
  if (t.id === "gate" && state.hasKey && !state.gateOpen) {
    state.gateOpen = true; say("The town gate", "The key turns with a deep iron clunk. Somewhere beyond the gate a dog starts barking. The road out of Hornmere is open.");
    state.banner = { text: "Quest complete", t: 4 }; return;
  }
  if (t.key && !state.hasKey) {
    state.hasKey = true; say(t.name, "Under the apples: a heavy brass key, warm from the sun. Bram's spare gate key!");
    state.toast = { text: "Got: Gate key", t: 3 }; return;
  }
  state.inspected[t.id] = true;
  say(t.name, t.text);
}
let _near = null;
function nearestTarget() { return _near; }
function computeNearest() {
  const fwd = new THREE.Vector3(Math.sin(heroFacing), 0, Math.cos(heroFacing));
  let best = null, bestScore = Infinity;
  for (const t of targets()) {
    const dx = t.pos.x - player.position.x, dz = t.pos.z - player.position.z, d = Math.hypot(dx, dz);
    if (d > t.r) continue;
    const facing = (dx * fwd.x + dz * fwd.z) / (d || 1);
    if (facing < -0.2) continue;
    const score = d - facing * 0.8;
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

// ---------------- input & camera ----------------
const keys = new Set();
let camYaw = Math.PI, camPitch = -0.2, heroFacing = Math.PI; // camYaw = direction the camera looks (PI = toward -z)
addEventListener("keydown", (e) => { keys.add(e.code); if (e.code === "KeyE") interact(); });
addEventListener("keyup", (e) => keys.delete(e.code));
const canvas = renderer.domElement;
// Mouse look: pointer lock when the browser allows it, otherwise hold a mouse button and drag.
let dragging = false;
addEventListener("mousedown", () => { dragging = true; });
addEventListener("mouseup", () => { dragging = false; });
addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas && !dragging) return;
  camYaw -= e.movementX * 0.0025; camPitch = Math.max(-0.75, Math.min(0.28, camPitch - e.movementY * 0.0022));
});
const titleEl = document.getElementById("title");
function enter() {
  if (!window.loaded) return;
  titleEl.classList.add("hidden");
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch {}
}
titleEl.addEventListener("click", enter);
canvas.addEventListener("click", () => { if (document.pointerLockElement !== canvas) enter(); });
addEventListener("keydown", (e) => { if (e.code === "Enter" && !titleEl.classList.contains("hidden")) enter(); });
addEventListener("resize", () => { if (CAPTURE) return; W = innerWidth; H = innerHeight; renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix(); sizeHud(); });

const input = { f: 0, r: 0, run: false };

// ---------------- touch controls (phones/tablets) ----------------
// Left half: virtual joystick to move (push far to run). Right half: drag to turn the camera. Button: Inspect.
const touch = { active: false, f: 0, r: 0, stickId: null, lookId: null, sx: 0, sy: 0, lx: 0, ly: 0 };
const IS_TOUCH = !CAPTURE && (matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
if (IS_TOUCH) {
  const css = document.createElement("style");
  css.textContent = `#stickBase{position:fixed;left:28px;bottom:120px;width:120px;height:120px;border-radius:50%;background:rgba(255,248,234,.18);border:2px solid rgba(255,248,234,.55);touch-action:none;z-index:5}
  #stickKnob{position:absolute;left:35px;top:35px;width:50px;height:50px;border-radius:50%;background:rgba(255,248,234,.75)}
  #btnE{position:fixed;right:26px;bottom:120px;width:76px;height:76px;border-radius:50%;background:rgba(255,248,234,.85);color:#2b1a0e;font:800 16px Nunito,sans-serif;display:flex;align-items:center;justify-content:center;border:2px solid #c79a4a;z-index:5;touch-action:none;user-select:none}
  canvas{touch-action:none}`;
  document.head.appendChild(css);
  const base = document.createElement("div"); base.id = "stickBase"; const knob = document.createElement("div"); knob.id = "stickKnob"; base.appendChild(knob);
  const btn = document.createElement("div"); btn.id = "btnE"; btn.textContent = "Inspect";
  document.body.append(base, btn);
  btn.addEventListener("touchstart", (e) => { e.preventDefault(); interact(); }, { passive: false });
  const R = 50;
  const moveKnob = (dx, dy) => { const l = Math.hypot(dx, dy), k = l > R ? R / l : 1; knob.style.transform = `translate(${dx * k}px,${dy * k}px)`; touch.r = dx * k / R; touch.f = -dy * k / R; };
  addEventListener("touchstart", (e) => {
    touch.active = true;
    for (const t of e.changedTouches) {
      if (t.target === btn) continue;
      if (t.clientX < innerWidth / 2 && touch.stickId === null) { touch.stickId = t.identifier; const b = base.getBoundingClientRect(); touch.sx = b.left + b.width / 2; touch.sy = b.top + b.height / 2; moveKnob(t.clientX - touch.sx, t.clientY - touch.sy); }
      else if (touch.lookId === null) { touch.lookId = t.identifier; touch.lx = t.clientX; touch.ly = t.clientY; }
    }
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === touch.stickId) moveKnob(t.clientX - touch.sx, t.clientY - touch.sy);
      if (t.identifier === touch.lookId) {
        camYaw -= (t.clientX - touch.lx) * 0.006; camPitch = Math.max(-0.75, Math.min(0.28, camPitch - (t.clientY - touch.ly) * 0.005));
        touch.lx = t.clientX; touch.ly = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });
  const end = (e) => { for (const t of e.changedTouches) {
    if (t.identifier === touch.stickId) { touch.stickId = null; touch.f = touch.r = 0; knob.style.transform = ""; }
    if (t.identifier === touch.lookId) touch.lookId = null; } };
  addEventListener("touchend", end); addEventListener("touchcancel", end);
  const keysEl = document.querySelector("#title .keys"); if (keysEl) keysEl.innerHTML = "<b>Left</b><span>Joystick to move (push far to run)</span><b>Right</b><span>Drag to look around</span><b>Button</b><span>Inspect</span>";
}
let camDist = CFG.camDist;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
function updateCamera(dt, snap = false) {
  const head = new THREE.Vector3(player.position.x, player.position.y + CFG.camHeight * HERO_SCALE, player.position.z);
  // spring arm: pull in when the camera would end up outside the square
  let want = CFG.camDist;
  for (let d = CFG.camDist; d > 0.8; d -= 0.15) {
    const cx = head.x - Math.sin(camYaw) * Math.cos(camPitch) * d, cz = head.z - Math.cos(camYaw) * Math.cos(camPitch) * d;
    want = d; if (insidePoly(cx, cz, CAM_POLY)) break;
  }
  camDist = snap ? want : camDist + (want - camDist) * Math.min(1, dt * (want < camDist ? 14 : 3));
  const goal = new THREE.Vector3(head.x - Math.sin(camYaw) * Math.cos(camPitch) * camDist, head.y - Math.sin(camPitch) * camDist, head.z - Math.cos(camYaw) * Math.cos(camPitch) * camDist);
  // Keep the camera well above the cobbles (the splat ground is thick and blurs up close) and out of the fountain.
  const minY = floorAt(goal.x, goal.z) + 1.0; if (goal.y < minY) goal.y = minY;
  { const dx = goal.x - FOUNTAIN.x, dz = goal.z - FOUNTAIN.z, d = Math.hypot(dx, dz), keep = FOUNTAIN.r + 1.2;
    if (d < keep) { const k = keep / (d || 1); goal.x = FOUNTAIN.x + dx * k; goal.z = FOUNTAIN.z + dz * k; goal.y = Math.max(goal.y, floorAt(goal.x, goal.z) + 2.6); } }
  // Tilting up raises where the camera looks, so you can actually look up at the rooftops.
  const look = head.clone(); look.y += Math.max(0, camPitch) * 9;
  if (snap) { camPos.copy(goal); camLook.copy(look); } else { camPos.lerp(goal, Math.min(1, dt * 10)); camLook.lerp(look, Math.min(1, dt * 12)); }
  camera.position.copy(camPos); camera.lookAt(camLook);
}

// ---------------- simulation ----------------
let speedNow = 0;
function setAnim(speed, dt) {
  const wIdle = Math.max(0, 1 - speed / CFG.walk), wWalk = speed <= CFG.walk ? speed / CFG.walk : Math.max(0, 1 - (speed - CFG.walk) / (CFG.run - CFG.walk)), wRun = Math.max(0, (speed - CFG.walk) / (CFG.run - CFG.walk));
  const k = Math.min(1, dt * 10);
  for (const [a, w] of [[actions.idle, wIdle], [actions.walk, wWalk], [actions.run, wRun]]) a.setEffectiveWeight(a.getEffectiveWeight() + (w - a.getEffectiveWeight()) * k);
  actions.walk.timeScale = Math.max(0.6, speed / CFG.walk); actions.run.timeScale = Math.max(0.8, speed / CFG.run);
}
function step(dt) {
  let f = input.f, r = input.r, run = input.run;
  if (!CAPTURE) {
    f = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    r = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
    run = keys.has("ShiftLeft") || keys.has("ShiftRight");
    if (touch.active) { f = touch.f; r = touch.r; run = Math.hypot(f, r) > 0.85; }
  }
  if (state.dialog) { f = 0; r = 0; }
  const mag = Math.min(1, Math.hypot(f, r));
  const len = Math.hypot(f, r), sp = len ? (run ? CFG.run : CFG.walk * (touch.active ? Math.max(0.35, mag) : 1)) : 0;
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw);            // camera forward on the ground
  let vx = 0, vz = 0;
  if (len) { vx = (fx * f - fz * r) / len * sp; vz = (fz * f + fx * r) / len * sp; heroFacing = lerpAngle(heroFacing, Math.atan2(vx, vz), Math.min(1, dt * 12)); }
  const k = Math.min(1, dt * 12);
  player.velocity.x += (vx - player.velocity.x) * k; player.velocity.z += (vz - player.velocity.z) * k;
  world.step(1 / 60, dt, 5);
  const fy = floorAt(player.position.x, player.position.z);
  if (player.position.y < fy) { player.position.y = fy; player.velocity.y = Math.max(0, player.velocity.y); }
  hero.position.set(player.position.x, player.position.y, player.position.z);
  hero.rotation.y = heroFacing;
  heroBlob.position.set(player.position.x, floorAt(player.position.x, player.position.z) + 0.03, player.position.z);
  speedNow = Math.hypot(player.velocity.x, player.velocity.z);
  setAnim(speedNow, dt); mixer.update(dt);
  for (const p of props) { p.holder.position.copy(p.body.position); p.holder.quaternion.copy(p.body.quaternion);
    p.blob.position.set(p.body.position.x, floorAt(p.body.position.x, p.body.position.z) + 0.05, p.body.position.z);
    const pfy = floorAt(p.body.position.x, p.body.position.z); if (p.body.position.y < pfy - 0.3) { p.body.position.y = pfy + p.half.y + 0.05; p.body.velocity.set(0, 0, 0); } }
  updateCamera(dt);
  sun.position.set(player.position.x - 9, 14, player.position.z - 8); sun.target.position.set(player.position.x, player.position.y, player.position.z);
  _near = computeNearest();
  if (state.dialog) state.dialog.chars = Math.min(state.dialog.text.length, state.dialog.chars + dt * 55);
  if (state.toast) { state.toast.t -= dt; if (state.toast.t <= 0) state.toast = null; }
  if (state.banner) { state.banner.t -= dt; if (state.banner.t <= 0) state.banner = null; }
  while (state.step < QUEST.length && QUEST[state.step].done(state)) state.step++;
}
const lerpAngle = (a, b, t) => { let d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t; };

// ---------------- loop & capture API ----------------
updateCamera(0, true);
let last = performance.now();
(village.initialized || Promise.resolve()).then(() => {
  window.loaded = true; status("Click to enter");
  if (!CAPTURE) renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
    step(dt); renderer.render(scene, camera); drawHud(_near);
  });
});
window.game = {
  input, props, player, hero, camera, state, floorAt, CFG, world,
  get camYaw() { return camYaw; }, set camYaw(v) { camYaw = v; },
  get camPitch() { return camPitch; }, set camPitch(v) { camPitch = v; },
  get heroFacing() { return heroFacing; }, set heroFacing(v) { heroFacing = v; },
  place(x, z, facing = Math.PI, yaw = facing) { player.position.set(x, floorAt(x, z) + 0.02, z); player.velocity.set(0, 0, 0); heroFacing = facing; camYaw = yaw; updateCamera(0, true); },
  interact, nearest: () => _near,
  frame(dt = 1 / 30) { step(dt); renderer.render(scene, camera); drawHud(_near); },
  // Advance one video frame and give Spark time to re-sort the splats for the new view.
  async frameSettled(dt = 1 / 30, waitMs = 45) { step(dt); renderer.render(scene, camera); await new Promise(r => setTimeout(r, waitMs)); renderer.render(scene, camera); drawHud(_near); },
  composite(out) { const c = out.getContext("2d"); c.drawImage(renderer.domElement, 0, 0, out.width, out.height); c.drawImage(hud, 0, 0, out.width, out.height); },
  canvas: renderer.domElement, hud,
};
