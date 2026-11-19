// Elderbrook: fixed-camera prerendered-background JRPG screens.
// Each screen = a painted plate + Atlas depth (occlusion, shadow receiver) + walk grid; Sol is a live, toon-lit 3D character.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

const params = new URLSearchParams(location.search);
const CAPTURE = params.has("capture");
// Every asset is requested with the game's version on the end, so a new release can never show a stale picture or flow map from the browser's cache.
const VER = new URL(import.meta.url).searchParams.get("v") || String(Math.floor(performance.timeOrigin));
const vurl = (u) => /^(data:|blob:)/.test(u) ? u : u + (u.includes("?") ? "&" : "?") + "v=" + VER;
THREE.DefaultLoadingManager.setURLModifier(vurl);
const vfetch = (u, o) => fetch(vurl(u), o);
const SCREEN = params.get("screen") || "square";

// ---------------- screen data ----------------
const base = `./plates/${SCREEN}`;
const [cam, walk, floor] = await Promise.all([`${base}_cam.json`, `${base}_walk.json`, `${base}_floor.json`].map(u => vfetch(u).then(r => r.json())));
const K = cam.intrinsics, E = cam.extrinsics;
const fn = new THREE.Vector3(...floor.n);
const planeAt = (x, z) => -(fn.x * x + fn.z * z + floor.d) / fn.y;
// ground height: a flat fitted plane, or (where the land rises and falls) a height stored per walk-grid cell
const floorAt = !walk.hgt ? planeAt : (x, z) => { const fx = Math.min(walk.w - 1.001, Math.max(0, (x - walk.x0) / walk.cell - 0.5)), fz = Math.min(walk.h - 1.001, Math.max(0, (z - walk.z0) / walk.cell - 0.5));
  const i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, h = walk.hgt, w = walk.w;
  return (h[j * w + i] * (1 - a) + h[j * w + i + 1] * a) * (1 - b) + (h[(j + 1) * w + i] * (1 - a) + h[(j + 1) * w + i + 1] * a) * b; };
const walkable = (x, z) => {
  const i = Math.floor((x - walk.x0) / walk.cell), j = Math.floor((z - walk.z0) / walk.cell);
  return i >= 0 && j >= 0 && i < walk.w && j < walk.h && walk.data[j * walk.w + i] === "1";
};
const SCREENS = {
  square: { name: "Town Square", spawn: [0.0, -6.0], facing: Math.PI, heroH: 1.45,
    exits: [{ id: "gate", x: 5.9, z: -23.8, r: 2.0, label: "Through the town gate", to: "mill" }],
    entries: { mill: { at: [5.9, -22.6], facing: 0 } },
    fxBox: { x: [-9, 3], z: [-14.5, -3.5] }, birds: [41.5, 56],
    sun: { dir: [-0.55, 0.62, -0.55], color: 0xfff0d4, sky: 0xbcd8f5, ground: 0x6f7a52 } },
  mill: { name: "The Old Mill", spawn: [-1.1, -5.8], facing: Math.PI, heroH: 1.0,
    exits: [{ id: "town", x: -10.8, z: -30.6, r: 2.2, label: "Back to Elderbrook", to: "square" },
            { id: "door", x: 2.2, z: -23.8, r: 2.6, label: "The mill door", say: ["The old mill", "The door is barred from inside. Beyond it the great wheel turns, slow and steady, as it has for a hundred years."] }],
    entries: { square: { at: [-7.9, -18.9], facing: 0 } },
    fxBox: { x: [-5, 1.5], z: [-13, -4.5] }, birds: [27, 42],
    flow: { stream: [0.467, 0.884, 1.5, 1.0], fall: [1126 / 1280, 1 - 186 / 720, 1192 / 1280, 1 - 497 / 720] },     // stream: world direction (x, z), speed, glint strength; fall: top and bottom of its arc on screen
    sun: { dir: [-0.55, 0.62, -0.55], color: 0xfff0d4, sky: 0xbcd8f5, ground: 0x6f8a4a } },
};
const S = SCREENS[SCREEN], FROM = params.get("from"), ENTRY = (S.entries || {})[FROM];
const HERO_H = +(params.get("heroH") || S.heroH), SC = HERO_H / 1.45;   // Sol's height in plate units (each painting has its own scale)

// ---------------- renderer: fixed 16:9 frame ----------------
const ASPECT = K.width / K.height;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: CAPTURE });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;
document.getElementById("stage").appendChild(renderer.domElement);
let W = 1280, H = 720;
function fit() {
  const CW = +(params.get("cw") || 1280), ww = CAPTURE ? CW : innerWidth, wh = CAPTURE ? Math.round(CW * 9 / 16) : innerHeight;
  if (ww / wh > ASPECT) { H = wh; W = Math.round(wh * ASPECT); } else { W = ww; H = Math.round(ww / ASPECT); }
  renderer.setPixelRatio(CAPTURE ? 1 : Math.min(devicePixelRatio, 2)); renderer.setSize(W, H);
}
fit(); addEventListener("resize", fit);

// The game camera is exactly the camera Atlas estimated for the painting.
const NEAR = 0.3, FAR = 300;
const camera = new THREE.PerspectiveCamera(2 * Math.atan(K.height / 2 / K.fy) * 180 / Math.PI, ASPECT, NEAR, FAR);
camera.position.fromArray(E.position); camera.quaternion.fromArray(E.quaternion); camera.updateMatrixWorld(); camera.updateProjectionMatrix();

// ---------------- background plate with per-pixel depth ----------------
const texLoader = new THREE.TextureLoader();
const [plateTex, depthTex, depthPng, lightTex, fxTex, skyTex] = await Promise.all([
  texLoader.loadAsync(`${base}.png`),
  new EXRLoader().setDataType(THREE.FloatType).loadAsync(`${base}_depth.exr`),   // CPU copy (shadow-receiver mesh)
  texLoader.loadAsync(`${base}_depth.png`),                                     // GPU copy: packed RGB, same orientation as the plate
  texLoader.loadAsync(`${base}_light.png`),                                     // the painting's sun/shade on the ground (white = sun)
  texLoader.loadAsync(`${base}_fx.png`),                                        // R pool water, G falling water, B foliage
  texLoader.loadAsync(`./plates/sky.jpg`),                                      // drifting cloud layer
]);
skyTex.colorSpace = THREE.SRGBColorSpace; skyTex.wrapS = THREE.MirroredRepeatWrapping; skyTex.generateMipmaps = false; skyTex.minFilter = THREE.LinearFilter;
fxTex.colorSpace = THREE.NoColorSpace; fxTex.generateMipmaps = false; fxTex.minFilter = fxTex.magFilter = THREE.LinearFilter;
lightTex.colorSpace = THREE.NoColorSpace; lightTex.generateMipmaps = false; lightTex.minFilter = lightTex.magFilter = THREE.LinearFilter;
plateTex.colorSpace = THREE.SRGBColorSpace; plateTex.minFilter = THREE.LinearFilter; plateTex.generateMipmaps = false;
depthPng.colorSpace = THREE.NoColorSpace; depthPng.minFilter = depthPng.magFilter = THREE.NearestFilter; depthPng.generateMipmaps = false;
const river = S.flow ? await vfetch(`${base}_river.json`).then(r => r.json()) : null;
const riverTex = river ? await Promise.all([`${base}_flow.png`, "./plates/water_a.png", "./plates/water_b.png", `${base}_caus.png`].map(u => texLoader.loadAsync(u))) : [null, null, null, null];
riverTex.forEach((t, i) => { if (!t) return; t.colorSpace = THREE.NoColorSpace; if (i === 1 || i === 2) { t.wrapS = t.wrapT = THREE.RepeatWrapping; } else { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; } });
const bgScene = new THREE.Scene(), bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const bgMat = new THREE.ShaderMaterial({
  uniforms: { plate: { value: plateTex }, flowMap: { value: riverTex[0] }, waterA: { value: riverTex[1] }, waterB: { value: riverTex[2] }, causK: { value: new THREE.Vector4(+(params.get("cscale") || 9), +(params.get("caus") || 1.7), +(params.get("ascale") || 4.5), +(params.get("arch") || 3.5)) }, surfK: { value: new THREE.Vector4(+(params.get("surface") ?? 1), +(params.get("refl") || 1), +(params.get("lines") || 1), 0) }, proxyP: { value: new THREE.Vector4(-1.11, 3.1, -15.45, 0) }, proxyN: { value: new THREE.Vector4(0.52, 0, 0.85, 0) }, camV: { value: camera.matrixWorldInverse }, streamDir: { value: new THREE.Vector2(0.6, 0.8) }, causMask: { value: riverTex[3] }, wPlane: { value: new THREE.Vector4(...(river ? river.plane : [0, 1, 0, 0])) }, flowSpeed: { value: river ? river.speed * +(params.get("flow") || 1) : 0 }, wdbg: { value: +(params.get("wdbg") || 0) }, camM: { value: camera.matrixWorld }, camK: { value: new THREE.Vector4(K.width / K.fx, K.height / K.fy, K.cx / K.width, 1 - K.cy / K.height) }, flowOn: { value: S.flow ? 1 : 0 }, flowS: { value: new THREE.Vector4(...(S.flow ? S.flow.stream : [0, 0, 0, 0])) }, flowF: { value: new THREE.Vector4(...(S.flow ? S.flow.fall : [0, 0, 0, 0])) }, fx: { value: fxTex }, light: { value: lightTex }, sky: { value: skyTex }, t: { value: 0 }, depth: { value: depthPng }, near: { value: NEAR }, far: { value: FAR } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
  fragmentShader: `uniform sampler2D plate, depth, fx, light, sky; uniform float near, far, t, flowOn, flowSpeed, wdbg; uniform vec4 flowS, flowF, camK, wPlane; uniform mat4 camM; uniform sampler2D flowMap, waterA, waterB, causMask; uniform vec4 causK, surfK, proxyP, proxyN; uniform mat4 camV; uniform vec2 streamDir; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
    void cWaves(vec2 p, float tt, out vec2 g, out vec3 H){
      g = vec2(0.0); H = vec3(0.0);
      for (int i = 0; i < 7; i++) { float fi = float(i), a = fi * 2.399963 + 0.5, k = 1.0 + 0.45 * fi, w = 1.0 / (1.0 + 0.6 * fi);
        vec2 d = vec2(cos(a), sin(a)); float sg = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;          // waves run both ways: it shimmers, it does not drift
        float ph = k * dot(d, p) + sg * tt * sqrt(k) + fi * 1.7;
        g += (w / k) * d * cos(ph); H -= w * sin(ph) * vec3(d.x * d.x, d.y * d.y, d.x * d.y); } }
    float caustic(vec2 p, float tt, float focus, float eps){
      vec2 g; vec3 H; cWaves(p, tt, g, H); cWaves(p - focus * g, tt, g, H);
      float det = (1.0 + focus * H.x) * (1.0 + focus * H.y) - focus * focus * H.z * H.z;
      return 1.0 / (eps + abs(det)); }
    // foam lace: the edges of slowly morphing cells (F2 - F1), drawn as lines
    // foam lace, after Alex Kent Dixon's river: big flat cells of water, the foam being the gaps between them, swelling into
    // pools where three cells meet. Returns x = distance to the nearest cell wall, y = how close to a three-way join.
    vec2 laceE(vec2 q, float tt){ q += (vec2(vnoise(q * 0.45), vnoise(q * 0.45 + 5.2)) - 0.5) * 1.0;
      vec2 i = floor(q), f = fract(q); float d1 = 8.0, d2 = 8.0, d3 = 8.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(float(x), float(y)), h = vec2(hash(i + g), hash(i + g + 19.1));
        vec2 o = 0.5 + 0.40 * sin(tt * 0.6 + 6.2831 * h); float d = length(g + o - f);
        if (d < d1) { d3 = d2; d2 = d1; d1 = d; } else if (d < d2) { d3 = d2; d2 = d; } else if (d < d3) d3 = d; }
      return vec2(d2 - d1, d3 - d1); }
    // two-phase flow: the texture is carried along the current twice, half a cycle apart, and cross-faded so neither reset is ever seen
    vec4 flowTex(sampler2D tex, vec2 uv, vec2 flow, float period){
      float p0 = fract(t / period), p1 = fract(t / period + 0.5);
      vec4 a = texture2D(tex, uv - flow * (p0 - 0.5) * period), b = texture2D(tex, uv - flow * (p1 - 0.5) * period + vec2(0.37, 0.21));
      return mix(a, b, abs(p0 - 0.5) * 2.0); }
    void main(){
      // the painting, brought to life with smooth noise (no repeating patterns)
      vec3 m = texture2D(fx, vUv).rgb; vec2 uv = vUv; vec3 mw = m; m *= 1.0 - flowOn;   // screens with running water handle R/G below
      // plants: whole clumps lean together as gusts cross the square
      float gust = smoothstep(0.25, 0.7, vnoise(vec2(vUv.x * 2.2 - t * 0.3, vUv.y * 1.6 + t * 0.05)));
      vec2 sway = vec2(vnoise(vUv * vec2(9.0, 6.0) + vec2(t * 0.7, 0.0)), vnoise(vUv * vec2(7.0, 9.0) + vec2(5.0 + t * 0.5, t * 0.25))) - 0.5;
      sway += 0.35 * (vec2(vnoise(vUv * vec2(40.0, 30.0) + vec2(t * 1.9, 3.0)), vnoise(vUv * vec2(33.0, 41.0) + vec2(8.0, t * 1.6))) - 0.5);   // leaf flutter
      uv += m.b * (0.3 + 0.7 * gust) * sway * vec2(0.0048, 0.0022);
      // pool: ripples travelling outward-ish, squashed to the pool's perspective
      vec2 pp = vec2(vUv.x * 70.0, vUv.y * 620.0);
      uv += m.r * (vec2(vnoise(pp + vec2(t * 1.5, t * 0.6)), vnoise(pp * 1.3 + vec2(9.0 - t * 1.1, t * 0.9))) - 0.5) * vec2(0.0065, 0.0024);
      // falling water: the painted streaks themselves slide down
      uv.y += m.g * 0.012 * (vnoise(vec2(vUv.x * 420.0, vUv.y * 30.0 + t * 7.0)) - 0.5);
      vec4 col = texture2D(plate, uv);
      col.rgb *= 1.0 + m.r * 0.5 * (vnoise(pp * 0.6 + vec2(t * 1.0, -t * 0.7)) - 0.5);
      col.rgb *= 1.0 + m.g * 1.2 * (vnoise(vec2(vUv.x * 420.0, vUv.y * 34.0 + t * 8.0)) - 0.45);
      if (flowOn > 0.5 && (mw.r > 0.01 || mw.g > 0.01)) {
        // The river (painted-board workflow): a still painted bed, and on top of it layers that are carried along an authored flow map.
        // Everything is laid out on the water's own plane in the world, so it foreshortens with the stream; the mask keeps it off rocks.
        vec3 ro = camM[3].xyz, rdir = (camM * vec4((vUv.x - camK.z) * camK.x, (vUv.y - camK.w) * camK.y, -1.0, 0.0)).xyz;
        float tt = -(dot(wPlane.xyz, ro) + wPlane.w) / dot(wPlane.xyz, rdir); vec2 wxz = ro.xz + rdir.xz * tt;
        vec4 fm = texture2D(flowMap, vUv); vec2 flow = (fm.rg - 0.5) * 2.0 * fm.b * flowSpeed;                 // world units per second
        // 1. ripple first: it bends what lies under it (the bed and the caustics), only inside the water mask
        vec2 rip = (flowTex(waterA, wxz * 0.22, flow, 2.6).gb - 0.5) * 2.0 * mw.r;
        // 2. the still riverbed, gently refracted; never from a pixel that is not water
        vec2 ub = vUv + rip * (0.022 / tt); float okb = step(0.85, texture2D(fx, ub).r);
        vec3 w = mix(col.rgb, texture2D(plate, ub).rgb, okb);
        // 3. caustics carried by the current, kept low so the painting reads through; brightest on the sunlit shallows
        // open, wavering filaments of light ON the bed: they stay where they are and shimmer, nudged by the same ripple that bends the bed;
        // they brighten the painted pebbles (multiply) and only where the sun reaches the water
        vec2 pc = (wxz + rip * 0.10) * causK.x;
        float ca = caustic(pc, t * 1.1, 0.9, 0.10 + 1.5 * length(fwidth(pc)));
        float lit = clamp((ca - 0.42) * 2.4, -0.15, 3.0);
        w *= 1.0 + vec3(1.0, 0.92, 0.75) * lit * causK.y * (0.35 + 0.65 * mw.b);
        if (surfK.x > 0.5) {
          // THE SURFACE. Seen at a low angle, water mirrors what stands behind it: here the bridge and the sky. The painting itself is
          // reflected (about the water, via the bridge's near face), broken up by the ripples, and it takes over from the bed with distance.
          vec3 rdn = normalize(rdir), nw = normalize(vec3(-rip.x * 0.05, 1.0, -rip.y * 0.05)), rr = reflect(rdn, nw), wpos = ro + rdir * tt;
          float th = dot(proxyP.xyz - wpos, proxyN.xyz) / min(dot(rr, proxyN.xyz), -1e-3);                    // where the mirrored ray meets the bridge face
          vec3 hc = (camV * vec4(wpos + rr * max(th, 0.0), 1.0)).xyz;
          vec2 ur = vec2(hc.x / -hc.z / camK.x + camK.z, hc.y / -hc.z / camK.y + camK.w);
          ur.x += rip.x * 0.004; ur.y = min(ur.y, 0.985);
          vec3 refl = texture2D(plate, ur).rgb * (1.0 - texture2D(fx, ur).r);                                 // never reflect the water in itself
          refl = mix(refl, vec3(0.42, 0.56, 0.70), smoothstep(0.80, 0.985, ur.y) * 0.6);                      // high up it is sky
          float fr = 0.02 + 0.98 * pow(1.0 - max(dot(-rdn, nw), 0.0), 5.0);
          float mini = length(fwidth(ur)) / max(length(fwidth(vUv)), 1e-6);                                      // where the mirror image is squeezed it would shimmer into rings: fade it out there
          w = mix(w, refl * 0.85, clamp(fr * 2.2, 0.0, 0.55) * surfK.y * step(ur.y, 0.999) * step(0.0, ur.x) * step(ur.x, 1.0) * (1.0 - smoothstep(1.3, 2.2, mini)));
          // thin bright strokes that ride the current: the painter's way of saying 'this is moving'
          vec2 sq = vec2(dot(wxz, vec2(streamDir.y, -streamDir.x)), dot(wxz, streamDir));   // one steady frame: turning it per pixel tears the strokes into rings
          vec2 ls = vec2(sq.x * 5.0, (sq.y - t * flowSpeed * 0.9) * 0.7); ls.x += 0.7 * vnoise(vec2(ls.x * 0.3, ls.y * 0.8) + 3.1);
          float rdg = 1.0 - abs(2.0 * vnoise(ls + vec2(t * 0.12, 0.0)) - 1.0), aa = fwidth(rdg) * 1.5 + 0.02;
          float ln = smoothstep(0.955 - aa, 0.955, rdg) * smoothstep(0.45, 0.62, vnoise(ls * vec2(0.35, 0.5) + 17.0));
          w += mix(vec3(0.75, 0.85, 1.0) * 0.07, vec3(1.0, 0.96, 0.86) * 0.16, mw.b) * ln * surfK.z * fm.b;
        }
        // 4. glints: sparse sparkles that drift with the water, sunlit water only
        float gl = flowTex(waterB, wxz * 0.9, flow * 1.15, 1.9).g * (0.6 + 0.8 * flowTex(waterB, wxz * 0.31, flow, 2.3).b);
        w += vec3(1.0, 0.97, 0.9) * smoothstep(0.25, 0.7, gl) * 0.55 * mw.b;
        col.rgb = mix(col.rgb, w, mw.r);
        // 5. foam: painted-looking, laid over (not glowing), in the band round rocks and banks, streaming with the flow
        // foam, painted the way the references do it: a lace of thin white lines stretched along the current, thick and dense right
        // behind each rock, thinning and breaking up downstream; the water between the lines keeps a soft facet of light and shade
        vec2 fx2 = vec2(streamDir.y, -streamDir.x), fqq = vec2(dot(wxz, fx2), dot(wxz, streamDir)), fll = vec2(dot(flow, fx2), dot(flow, streamDir)) * 0.9;
        float fp0 = fract(t / 3.2), fp1 = fract(t / 3.2 + 0.5), fwgt = abs(fp0 - 0.5) * 2.0; vec2 lsc = vec2(1.5, 1.25);      // cells ~0.65 m across, ~0.8 m along the flow
        vec2 e0 = laceE((fqq - fll * (fp0 - 0.5) * 3.2) * lsc, t), e1 = laceE((fqq - fll * (fp1 - 0.5) * 3.2) * lsc + vec2(5.3, 2.1), t + 7.0);
        float wk = mw.g, fok = texture2D(fx, vUv).a, brk = flowTex(waterB, wxz * 0.22, flow, 3.0).b;
        float amt = smoothstep(0.02, 0.32, wk) * smoothstep(0.12, 0.36, brk + wk * 0.8) * fok;                  // only near rocks: full in their wakes, fading to nothing in open water
        float lw = mix(0.04, 0.15, smoothstep(0.0, 0.6, wk));                                              // lines thin away as they leave the rock                                                                     // thicker near the rocks
        float soft = 0.05;                                                                                  // softer edges than the reference
        float sw0 = lw + 0.11 * (1.0 - smoothstep(0.0, 0.30, e0.y)), sw1 = lw + 0.11 * (1.0 - smoothstep(0.0, 0.30, e1.y));     // pools where three cells meet
        float l0 = 1.0 - smoothstep(sw0 - soft, sw0 + soft, e0.x), l1 = 1.0 - smoothstep(sw1 - soft, sw1 + soft, e1.x);
        float foam = mix(l0, l1, fwgt) * amt;
        foam = max(foam, smoothstep(0.80, 0.92, wk + (brk - 0.5) * 0.3) * fok);                             // white water piled against the rock
        // each cell is a flat slab with its own slight tone, like the reference
        float slab = mix(hash(floor((fqq - fll * (fp0 - 0.5) * 3.2) * lsc)), hash(floor((fqq - fll * (fp1 - 0.5) * 3.2) * lsc + vec2(5.3, 2.1))), fwgt);
        col.rgb *= 1.0 + (slab - 0.5) * 0.08 * amt * mw.r;
        col.rgb = mix(col.rgb, vec3(0.90, 0.96, 0.97), foam * 0.82);
        col.rgb = min(col.rgb, 1.0);
        if (wdbg > 0.5) col.rgb = wdbg < 1.5 ? mw : wdbg < 2.5 ? vec3(fm.rg, fm.b) : wdbg < 3.5 ? vec3(ca) : vec3(foam, gl, 0.0);   // ?wdbg=1 mask, 2 flow, 3 caustics, 4 foam+glints
      }
      if (flowOn > 0.5) { float cm = texture2D(causMask, vUv).r;
        if (cm > 0.01) {   // light thrown up off the moving water plays across the underside of the arch: two caustic nets sliding through each other
          // water light on the vault: far out of focus, so a few broad soft warm bands, laid on the stone itself (its real position in the
          // scene) and wavering in place; it brightens the painted stone, so the mortar lines still show through
          vec3 dqa = floor(texture2D(depth, vUv).rgb * 255.0 + 0.5); float za = near / max((dqa.r * 65536.0 + dqa.g * 256.0 + dqa.b) / 16777215.0, 1e-6);
          vec3 sp = (camM * vec4(vec3((vUv.x - camK.z) * camK.x, (vUv.y - camK.w) * camK.y, -1.0) * za, 1.0)).xyz;
          vec2 pa = vec2(sp.x * 0.8 + sp.z * 0.45, sp.y * 1.25) * causK.z;
          float band = caustic(pa, t * 0.55, 0.6, 0.32);
          col.rgb *= 1.0 + vec3(1.0, 0.80, 0.52) * clamp((band - 0.34) * 1.5, 0.0, 1.6) * causK.w * cm; } }
      // sky: clouds drifting slowly behind the rooftops
      float skyM = texture2D(light, vUv).g;
      if (skyM > 0.003) { vec3 sk = texture2D(sky, vec2(vUv.x * 1.2 + t * 0.0022, 0.42 + (vUv.y - 0.9) * 1.0)).rgb;
        float sl = dot(sk, vec3(0.3, 0.59, 0.11)); sk = mix(vec3(sl), sk, 1.35) * vec3(0.94, 1.0, 1.06);
        col.rgb = mix(col.rgb, sk, skyM); }
      gl_FragColor = col;
      #include <colorspace_fragment>
      vec3 dq = floor(texture2D(depth, vUv).rgb * 255.0 + 0.5);
      float z = near / max((dq.r * 65536.0 + dq.g * 256.0 + dq.b) / 16777215.0, 1e-6);   // planar distance along the view axis
      if (!(z > 0.0) || z > far * 0.99) z = far * 0.99;                   // sky / no surface
      float ndc = (far + near) / (far - near) - (2.0 * far * near) / ((far - near) * z);
      gl_FragDepth = ndc * 0.5 + 0.5;
    }`,
  depthWrite: true, depthTest: true,
});
bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));

// ---------------- 3D scene in the plate's space ----------------
const scene = new THREE.Scene();
const sunDir = new THREE.Vector3(...S.sun.dir).normalize();
// Painted light: for any point, follow the sun ray down to the ground and read the painting's own sun/shade there.
const LIGHT_GLSL = `uniform sampler2D lightTex; uniform mat4 lightVP; uniform vec3 sunDirU; uniform vec4 floorN; uniform float lightT, groundY;
  float paintedSun(vec3 wp){
    float hgt = max(0.0, wp.y - groundY);
    vec4 lc = lightVP * vec4(wp - sunDirU * (hgt / sunDirU.y), 1.0);
    vec2 uv = lc.w > 0.05 ? clamp(lc.xy / lc.w * 0.5 + 0.5, 0.0, 1.0) : vec2(clamp(0.5 + lc.x * 0.1, 0.0, 1.0), 0.0);
    uv += 0.0035 * vec2(sin(lightT * 0.9 + wp.x * 1.7), cos(lightT * 0.7 + wp.z * 1.3));     // leaves stirring overhead
    return smoothstep(0.3, 0.7, texture2D(lightTex, uv).r);
  }`;
const lightU = { lightTex: { value: lightTex }, lightVP: { value: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse) },
  sunDirU: { value: sunDir }, lightT: { value: 0 }, groundY: { value: 0 }, floorN: { value: new THREE.Vector4(fn.x, fn.y, fn.z, floor.d) }, shadeK: { value: new THREE.Vector3(0.25, 0.30, 0.45) } };
const withWp = (sh) => { Object.assign(sh.uniforms, lightU);
  sh.vertexShader = "varying vec3 vWp;\n" + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;");
  sh.fragmentShader = "varying vec3 vWp;\n" + LIGHT_GLSL + "\n" + sh.fragmentShader; };
scene.add(new THREE.HemisphereLight(S.sun.sky, S.sun.ground, 0.95));
const sun = new THREE.DirectionalLight(S.sun.color, 2.2);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 5;
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 0.5, far: 80 });
scene.add(sun, sun.target);

// Shadow receiver: the plate's own depth turned into an invisible mesh, so Sol's shadow falls over cobbles, steps and walls.
{
  const dw = depthTex.image.width, dh = depthTex.image.height, data = depthTex.image.data, step = 4;
  const cw = Math.floor(dw / step), ch = Math.floor(dh / step);
  const pos = new Float32Array(cw * ch * 3), zs = new Float32Array(cw * ch), idx = [];
  const inv = camera.matrixWorld;
  const v = new THREE.Vector3();
  const stride = data.length / (dw * dh);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const px = i * step, py = j * step;
    // EXR rows are bottom-up in the loaded texture; flip to image rows
    let z = data[((dh - 1 - py) * dw + px) * stride]; if (!(z > 0) || z > 200) z = 0;
    zs[j * cw + i] = z;
    const zz = (z || 200) * 0.993;                                     // a hair in front of the plate depth
    v.set((px - K.cx) / K.fx * zz, -(py - K.cy) / K.fy * zz, -zz).applyMatrix4(inv);
    pos.set([v.x, v.y, v.z], (j * cw + i) * 3);
  }
  for (let j = 0; j < ch - 1; j++) for (let i = 0; i < cw - 1; i++) {
    const a = j * cw + i, b = a + 1, c = a + cw, d = c + 1, q = [zs[a], zs[b], zs[c], zs[d]];
    if (q.some(z => !z)) continue;
    const mx = Math.max(...q), mn = Math.min(...q); if (mx / mn > 1.08) continue;      // don't bridge depth jumps
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const recvMat = new THREE.ShadowMaterial({ color: 0x1d1a3a, opacity: 0.5 });
  recvMat.onBeforeCompile = (sh) => { withWp(sh);       // no second shadow inside painted shade
    sh.fragmentShader = sh.fragmentShader.replace("#include <tonemapping_fragment>", "gl_FragColor.a *= mix(0.15, 1.0, paintedSun(vWp));\n#include <tonemapping_fragment>"); };
  const recv = new THREE.Mesh(g, recvMat);
  recv.receiveShadow = true; recv.renderOrder = 1; scene.add(recv);
  // drifting cloud shadows over the whole plate (soft, slow, multiply)
  const cc = document.createElement("canvas"); cc.width = cc.height = 256; const cx = cc.getContext("2d");
  cx.fillStyle = "#fff"; cx.fillRect(0, 0, 256, 256);
  for (let k = 0; k < 9; k++) { const x = (k * 97) % 256, y = (k * 61) % 256, r = 40 + (k * 13) % 50;
    const gr = cx.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, "rgba(120,125,160,.55)"); gr.addColorStop(1, "rgba(120,125,160,0)");
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) { cx.fillStyle = gr; cx.save(); cx.translate(ox, oy); cx.fillRect(x - r, y - r, 2 * r, 2 * r); cx.restore(); } }
  const cloudTex = new THREE.CanvasTexture(cc); cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: cloudTex }, t: { value: 0 } }, transparent: true, depthWrite: false,
    blending: THREE.MultiplyBlending, premultipliedAlpha: true,
    vertexShader: "varying vec3 wp; void main(){ vec4 w = modelMatrix * vec4(position,1.0); wp = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
    fragmentShader: "uniform sampler2D map; uniform float t; varying vec3 wp; void main(){ vec3 c = texture2D(map, wp.xz / 34.0 + vec2(t * 0.004, t * 0.0015)).rgb; gl_FragColor = vec4(mix(vec3(1.0), c, 0.55), 1.0); }",
  });
  const clouds = new THREE.Mesh(g, cloudMat); clouds.renderOrder = 2; scene.add(clouds);
  window.__cloudMat = cloudMat;
}

// ---------------- Sol ----------------
const TOON = (() => { const d = new Uint8Array([150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]); const t = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat); t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; })();
// Sol's look.  0 = soft toon (the original), 1 = flat cel + ink line, 2 = cel with the scene's palette, drawn at the painting's softness
const LOOK = +(params.get("look") ?? 2);
const CEL_GLSL = LOOK < 1 ? "" : `
  { vec3 base = diffuseColor.rgb; float bl = dot(base, vec3(0.299, 0.587, 0.114));
    ${LOOK >= 2 ? "base = mix(vec3(bl), base, 1.3); base = pow(max(base, 0.0), vec3(1.08));" : ""}
    float ndl = dot(normal, directionalLights[0].direction);
    float cel = smoothstep(0.0, 0.05, ndl - 0.06) * smoothstep(0.4, 0.6, sunL);              // one lit tone, one shadow tone, a crisp edge
    #ifdef USE_SHADOWMAP
      cel *= smoothstep(0.35, 0.65, getShadowMask());
    #endif
    vec3 lit = base * ${LOOK >= 2 ? "vec3(1.12, 1.03, 0.88)" : "vec3(1.05, 1.02, 0.96)"};
    vec3 shd = base * ${LOOK >= 2 ? "vec3(0.33, 0.32, 0.52) + vec3(0.035, 0.028, 0.012) * max(-normal.y, 0.0)" : "shadeK"};   // violet shade, warm bounce off the cobbles
    float rim = pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 2.5) * smoothstep(0.0, 0.3, ndl) * smoothstep(0.4, 0.6, sunL);
    outgoingLight = mix(shd, lit, cel) + vec3(1.0, 0.82, 0.55) * rim * ${LOOK >= 2 ? "0.22" : "0.12"}; }
`;
function toonify(root, outline) {
  const outl = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const m0 = o.material;
    const m = new THREE.MeshToonMaterial({ map: m0.map || null, color: m0.color ? m0.color.clone() : new THREE.Color(1, 1, 1), gradientMap: TOON });
    m.onBeforeCompile = (s) => {   // cool, painted shadow side like the plate's shadows + the painting's dappled sun on his body
      withWp(s);
      s.fragmentShader = s.fragmentShader.replace("void main() {", "uniform vec3 shadeK;\n" + (LOOK >= 1 ? "#include <shadowmask_pars_fragment>\n" : "") + "void main() {").replace("#include <opaque_fragment>",
        "float sunL = paintedSun(vWp);\n" +
        "vec3 shadeCol = diffuseColor.rgb * shadeK * (0.92 + 0.08 * normal.y);\n" +
        "float lum = dot(outgoingLight, vec3(0.299,0.587,0.114)) / max(0.001, dot(diffuseColor.rgb, vec3(0.299,0.587,0.114)));\n" +
        "outgoingLight = mix(outgoingLight * vec3(0.78, 0.8, 1.02), outgoingLight, smoothstep(0.45, 0.95, lum));\n" +
        "outgoingLight = mix(shadeCol, outgoingLight * vec3(1.05, 1.02, 0.96), sunL);\n" + CEL_GLSL + "#include <opaque_fragment>");
    };
    o.material = m; o.castShadow = true; o.frustumCulled = false;
    m.side = THREE.FrontSide; outl.push(o);   // every mesh gets an ink hull (the model ships double-sided, which used to skip it)
  });
  if (outline > 0) for (const o of outl) {
    const mat = new THREE.MeshBasicMaterial({ color: LOOK >= 2 ? 0x2c1712 : LOOK >= 1 ? 0x3a2416 : 0x2e1f14, side: THREE.BackSide }); mat.userData.hull = true;
    mat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\ntransformed += normal * ${outline.toFixed(4)};`); };
    const hull = o.isSkinnedMesh ? new THREE.SkinnedMesh(o.geometry, mat) : new THREE.Mesh(o.geometry, mat);
    if (o.isSkinnedMesh) hull.bind(o.skeleton, o.bindMatrix);
    hull.frustumCulled = false; o.parent.add(hull); hull.position.copy(o.position); hull.quaternion.copy(o.quaternion); hull.scale.copy(o.scale);
  }
}
const gltf = await new GLTFLoader().loadAsync("../assets/models/hero_v4_anim_0_30_14.glb");
const hero = gltf.scene; hero.scale.setScalar(HERO_H / 1.7); const INK = params.has("ink") ? +params.get("ink") * 0.01 : LOOK >= 2 ? 0.0025 : LOOK >= 1 ? 0.010 : 0.014;
toonify(hero, LOOK >= 2 ? 0 : INK); scene.add(hero);   // look 2 inks the silhouette only, when he is laid into the picture
const clip = (n) => gltf.animations.find(a => a.name.toLowerCase().includes(n));
// a natural walk cycle for the same skeleton (the "casual walk" in the main file is a stiff shuffle)
const walkClip = (await new GLTFLoader().loadAsync("../assets/models/hero_v4_walk.glb")).animations[0];
// Measure the clips themselves so movement matches the feet: sample bone positions through a clip with Sol at the origin.
function sampleClip(c, names, n) {
  const m = new THREE.AnimationMixer(hero), a = m.clipAction(c); a.play();
  const bs = names.map(nm => hero.getObjectByName(nm)), out = [];
  for (let i = 0; i < n; i++) { m.setTime(c.duration * i / n); hero.updateMatrixWorld(true); out.push(bs.map(b => b.getWorldPosition(new THREE.Vector3()))); }
  a.stop(); m.uncacheRoot(hero); return out;
}
function groundSpeed(c) {            // how fast the planted foot slides back under the hips = the speed the clip was animated for
  const n = 120, dt = c.duration / n, sm = sampleClip(c, ["Hips", "LeftFoot", "RightFoot"], n), vs = [];
  for (const f of [1, 2]) {
    const minY = Math.min(...sm.map(q => q[f].y));
    for (let i = 0; i < n; i++) { const a = sm[(i + n - 1) % n], b = sm[(i + 1) % n];
      if (sm[i][f].y < minY + 0.035 * HERO_H) vs.push(Math.abs(((b[f].z - b[0].z) - (a[f].z - a[0].z)) / (2 * dt))); }
  }
  vs.sort((a, b) => a - b); return vs[Math.floor(vs.length * 0.6)] || 1;
}
function calmIdle(c) {               // the still stretch of the idle (standing, not looking around), played very gently back and forth
  const fps = 30, n = Math.max(8, Math.round(c.duration * fps)), sm = sampleClip(c, ["Head", "headfront", "LeftHand", "RightHand", "Hips", "Spine02"], n);
  const mv = []; for (let i = 0; i < n - 1; i++) mv.push(sm[i].reduce((s, q, k) => s + q.distanceTo(sm[i + 1][k]), 0));
  const lim = Math.max(...mv) * 0.14; let best = 0, len = 0;
  for (let i = 0, run = 0; i < mv.length; i++) { run = mv[i] < lim ? run + 1 : 0; if (run > len) { len = run; best = i - run + 1; } }
  if (len < 6) { best = 0; len = Math.min(12, n - 2); }
  return { clip: THREE.AnimationUtils.subclip(c, "calm_idle", best, best + len, fps), from: best / fps, to: (best + len) / fps };
}
const WALK_PACE = +(params.get("pace") || 0.9) * SC, WALK_NAT = groundSpeed(walkClip), WALK_RATE = WALK_PACE / WALK_NAT, WALK = WALK_PACE, RUN = groundSpeed(clip("run")), calm = calmIdle(clip("idle"));
const mixer = new THREE.AnimationMixer(hero);
const act = { idle: mixer.clipAction(calm.clip), walk: mixer.clipAction(walkClip), run: mixer.clipAction(clip("run")) };
act.idle.setLoop(THREE.LoopPingPong, Infinity); act.idle.timeScale = (calm.to - calm.from) / 2.4;   // one slow breath each way
for (const a of Object.values(act)) { a.play(); a.setEffectiveWeight(0); } act.idle.setEffectiveWeight(1);
// soft contact shadow under the feet
const blob = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d");
  const gr = x.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, "rgba(25,20,45,.55)"); gr.addColorStop(1, "rgba(25,20,45,0)"); x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.8), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.renderOrder = 3; scene.add(m); return m;
})();

const P = ENTRY ? { x: ENTRY.at[0], z: ENTRY.at[1], facing: ENTRY.facing, speed: 0 } : { x: S.spawn[0], z: S.spawn[1], facing: S.facing, speed: 0 };

// ---------------- VFX: falling leaves + sunlit dust motes ----------------
const fx = new THREE.Group(); scene.add(fx);
// hand-painted leaves (a 2x2 sheet in the plate's style) on small curled cards, so they never read as flat squares
const leafSheet = await texLoader.loadAsync("./plates/leaves.png"); leafSheet.colorSpace = THREE.SRGBColorSpace;
const leafTexs = [0, 1, 2, 3].map(k => { const t = leafSheet.clone(); t.repeat.set(0.5, 0.5); t.offset.set((k % 2) * 0.5, k < 2 ? 0.5 : 0); t.needsUpdate = true; return t; });
const leafGeo = new THREE.PlaneGeometry(1, 1, 6, 6);
{ const q = leafGeo.attributes.position; for (let k = 0; k < q.count; k++) { const a = (q.getX(k) + q.getY(k)) * 0.7071, b = (q.getX(k) - q.getY(k)) * 0.7071;   // a = along the midrib, b = across it
    q.setZ(k, 0.55 * b * b - 0.22 * a * a + 0.12 * a * b); } leafGeo.computeVertexNormals(); }
const leaves = [];
for (let i = 0; i < 9; i++) {
  const m = new THREE.Mesh(leafGeo, new THREE.MeshBasicMaterial({ map: leafTexs[[0, 1, 2, 0, 1, 3, 2, 0, 1][i]], alphaTest: 0.02, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
  m.userData = { seed: Math.random() * 100 }; resetLeaf(m, true); fx.add(m); leaves.push(m);
}
function resetLeaf(m, any) { const u = m.userData;
  const B = S.fxBox, lx = B.x[0] + Math.random() * (B.x[1] - B.x[0]), lz = B.z[0] + Math.random() * (B.z[1] - B.z[0]);
  m.position.set(lx, floorAt(lx, lz) + (any ? 0.5 + Math.random() * 5 : 4.5 + Math.random() * 1.5) * SC, lz);
  u.vy = 0.38 + Math.random() * 0.22; u.vx = 0.25 + Math.random() * 0.3; u.w = 1.7 + Math.random() * 1.1; u.sway = 0.35 + Math.random() * 0.35;
  u.spin = Math.random() < 0.45 ? 2.2 + Math.random() * 2.5 : 0; u.age = 0; u.rest = 0; m.scale.setScalar((0.11 + Math.random() * 0.06) * SC);
}
function updateLeaf(m, dt) { const u = m.userData; u.age += dt;
  if (u.rest > 0) { u.rest += dt; m.material.opacity = Math.max(0, 1 - (u.rest - 2.5) / 1.5); if (u.rest > 4) resetLeaf(m, false); return; }
  const sw = time * u.w + u.seed, s = Math.sin(sw), c = Math.cos(sw);
  // a falling leaf glides side to side like a pendulum: fastest and flattest mid-swing, stalling and dropping at each end
  m.position.y -= u.vy * (0.55 + 0.75 * s * s) * dt;
  m.position.x += (u.vx * (0.6 + 0.8 * Math.sin(time * 0.31 + u.seed)) + u.sway * u.w * c * 0.5) * dt;
  m.position.z += 0.12 * Math.sin(sw * 0.63 + 1.0) * dt;
  m.rotation.set(u.spin ? time * u.spin + u.seed : -1.15 + 0.35 * Math.sin(sw * 2.0), u.seed + time * 0.4, -0.75 * c);   // banks into each swing; some also tumble end over end
  m.material.opacity = Math.min(1, u.age / 0.7);
  const gy = floorAt(m.position.x, m.position.z) + 0.02;
  if (m.position.y < gy) { m.position.y = gy; m.rotation.set(-Math.PI / 2, 0, u.seed); u.rest = 0.001; }       // settles flat on the cobbles, then fades
}
// dust motes: soft specks adrift in the air that only glow where the painted sunlight reaches them, and glint as they turn
const moteGeo = new THREE.BufferGeometry(), N = 170, mp = new Float32Array(N * 3), ms = new Float32Array(N * 3);
for (let i = 0; i < N; i++) { const big = false;
  mp.set([-8 + Math.random() * 16, 0.15 + Math.pow(Math.random(), 1.4) * 4.2, -5 - Math.random() * 13], i * 3);
  ms.set([Math.random() * 100, big ? 0.13 + Math.random() * 0.08 : 0.035 + Math.random() * 0.04, Math.random()], i * 3); }
moteGeo.setAttribute("position", new THREE.BufferAttribute(mp, 3)); moteGeo.setAttribute("seed", new THREE.BufferAttribute(ms, 3));
const moteMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: Object.assign({ t: { value: 0 }, pxScale: { value: 360 }, moteK: { value: params.has("motes") ? +params.get("motes") : 1 } }, lightU),
  vertexShader: `attribute vec3 seed; uniform float t, pxScale, moteK; varying float vA; varying float vSoft;
    ${LIGHT_GLSL}
    void main(){
      vec3 p = position; float s = seed.x, sp = 0.6 + 0.8 * seed.z;
      p.x = mod(p.x + t * 0.035 * sp + 8.0, 16.0) - 8.0;                                       // the faint breeze carries them across
      p.x += 0.30 * sin(t * 0.11 * sp + s) + 0.10 * sin(t * 0.37 + s * 2.3);
      p.y += 0.22 * sin(t * 0.13 * sp + s * 1.7) + 0.07 * sin(t * 0.43 + s);
      p.z += 0.28 * sin(t * 0.09 * sp + s * 3.1);
      vec4 mv = viewMatrix * vec4(p, 1.0); float dist = -mv.z;
      float glint = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(t * (0.7 + 1.6 * seed.z) + s * 5.0), 2.0);
      float edge = smoothstep(0.0, 1.2, 8.0 - abs(p.x));                                       // fade where they wrap around
      float big = step(0.1, seed.y);
      vA = moteK * (0.28 + 0.72 * paintedSun(p)) * glint * edge * smoothstep(4.0, 6.5, dist) * mix(3.2, 1.3, big);
      vSoft = big;
      gl_PointSize = max(3.0, seed.y * pxScale * projectionMatrix[1][1] / dist);
      gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying float vA; varying float vSoft;
    void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard;
      float a = mix(pow(1.0 - d, 3.0) + 0.22 * (1.0 - d), smoothstep(1.0, 0.55, d) * 0.8, vSoft);                 // tiny ones are sharp glints, near ones are soft out-of-focus discs
      gl_FragColor = vec4(vec3(1.0, 0.92, 0.70) * a * vA, 1.0); }` });
const motes = new THREE.Points(moteGeo, moteMat); motes.frustumCulled = false; fx.add(motes);
// ---------------- input ----------------
const keys = new Set();
addEventListener("keydown", (e) => { keys.add(e.code); if (e.code === "KeyE" || e.code === "Enter") interact(); });
addEventListener("keyup", (e) => keys.delete(e.code));
const input = { x: 0, y: 0, run: false };   // capture/touch drive this directly
const touch = { id: null, sx: 0, sy: 0 };
addEventListener("touchstart", (e) => { const t = e.changedTouches[0]; if (t.clientX < innerWidth * 0.6 && touch.id === null) { touch.id = t.identifier; touch.sx = t.clientX; touch.sy = t.clientY; } else interact(); }, { passive: true });
addEventListener("touchmove", (e) => { for (const t of e.changedTouches) if (t.identifier === touch.id) { const dx = (t.clientX - touch.sx) / 60, dy = (t.clientY - touch.sy) / 60, l = Math.hypot(dx, dy); input.x = l > 1 ? dx / l : dx; input.y = l > 1 ? dy / l : dy; input.run = l > 1.6; } e.preventDefault(); }, { passive: false });
addEventListener("touchend", (e) => { for (const t of e.changedTouches) if (t.identifier === touch.id) { touch.id = null; input.x = input.y = 0; input.run = false; } });

// ---------------- interaction / UI ----------------
const ui = { prompt: document.getElementById("prompt"), dialog: document.getElementById("dialog"), place: document.getElementById("place") };
let dialogOpen = false, nearExit = null, leaving = false;
function say(name, text) { ui.dialog.querySelector(".n").textContent = name; ui.dialog.querySelector(".x").textContent = text; ui.dialog.style.display = "block"; dialogOpen = true; }
function interact() {
  if (dialogOpen) { ui.dialog.style.display = "none"; dialogOpen = false; return; }
  if (!nearExit) return;
  if (nearExit.say) return say(...nearExit.say);
  if (nearExit.to && !leaving) { leaving = true; document.getElementById("fade").classList.remove("clear");     // fade out, then load the next painting
    const q = new URLSearchParams(location.search); q.set("screen", nearExit.to); q.set("from", SCREEN);
    setTimeout(() => { location.search = q.toString(); }, 850); }
}
function project(v) { const p = v.clone().project(camera); const r = renderer.domElement.getBoundingClientRect(); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; }

// ---------------- simulation ----------------
const lerpA = (a, b, t) => { const d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t; };
let time = 0;
function step(dt) {
  time += dt;
  let ix = input.x, iy = input.y, run = input.run;
  if (!CAPTURE && touch.id === null) {
    ix = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
    iy = (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
    run = keys.has("ShiftLeft") || keys.has("ShiftRight");
  }
  if (dialogOpen) ix = iy = 0;
  const len = Math.hypot(ix, iy);
  const target = len ? (run ? RUN : WALK) * Math.min(1, len) : 0;
  P.speed += (target - P.speed) * Math.min(1, dt * 10);
  if (len > 0.05) {
    // screen-relative: up on screen = away from the camera
    const dx = ix / Math.max(1, len), dz = iy / Math.max(1, len);
    P.facing = lerpA(P.facing, Math.atan2(dx, dz), Math.min(1, dt * 12));
    const nx = P.x + dx * P.speed * dt, nz = P.z + dz * P.speed * dt;
    if (walkable(nx, nz)) { P.x = nx; P.z = nz; }
    else { // blocked: slide along whatever he hit, trying headings a little to either side before giving up, so round and slanted edges don't snag
      const sx = nx - P.x, sz = nz - P.z; let done = false;
      for (const a of [0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.35, -1.35]) { const c = Math.cos(a), sn = Math.sin(a), k = Math.cos(a) * 0.9 + 0.1;
        const tx = P.x + (sx * c - sz * sn) * k, tz = P.z + (sx * sn + sz * c) * k;
        if (walkable(tx, tz)) { P.x = tx; P.z = tz; done = true; break; } }
      if (!done) { if (walkable(nx, P.z)) P.x = nx; else if (walkable(P.x, nz)) P.z = nz; } }
  }
  const y = floorAt(P.x, P.z); lightU.groundY.value = y;
  hero.position.set(P.x, y, P.z); hero.rotation.y = P.facing;
  blob.position.set(P.x, y + 0.02, P.z); blob.scale.setScalar(HERO_H);
  const w = P.speed;
  const wi = Math.max(0, 1 - w / WALK), ww = w <= WALK ? w / WALK : Math.max(0, 1 - (w - WALK) / (RUN - WALK)), wr = Math.max(0, (w - WALK) / (RUN - WALK));
  for (const [a, t] of [[act.idle, wi], [act.walk, ww], [act.run, wr]]) a.setEffectiveWeight(a.getEffectiveWeight() + (t - a.getEffectiveWeight()) * Math.min(1, dt * 10));
  act.walk.timeScale = WALK_RATE * Math.max(0.5, Math.min(1.3, w / WALK)); act.run.timeScale = Math.max(0.75, w / RUN);   // feet keep pace with the ground
  mixer.update(dt);
  // sun shadow follows Sol (fixed direction from the painting)
  sun.position.copy(hero.position).addScaledVector(sunDir, 30); sun.target.position.copy(hero.position);
  // VFX
  window.__cloudMat.uniforms.t.value = time; lightU.lightT.value = time;
  for (const m of leaves) updateLeaf(m, dt);
  moteMat.uniforms.t.value = time; moteMat.uniforms.pxScale.value = renderer.domElement.height / 2;
  // exits
  nearExit = S.exits.find(e => Math.hypot(P.x - e.x, P.z - e.z) < e.r) || null;   // only right at the gate
  if (nearExit && !dialogOpen) { const p = project(new THREE.Vector3(P.x, y + HERO_H * 1.25, P.z)); ui.prompt.style.left = p.x + "px"; ui.prompt.style.top = p.y + "px"; ui.prompt.querySelector("span").textContent = nearExit.label; ui.prompt.classList.add("show"); }
  else ui.prompt.classList.remove("show");
}
// soft sun shafts slanting in from the upper left, over everything
const shaftMat = new THREE.ShaderMaterial({ uniforms: { t: { value: 0 }, shaftK: { value: (params.has("shafts") ? +params.get("shafts") : 0.3) } }, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
  fragmentShader: `uniform float t, shaftK; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
    void main(){
      vec2 p = vec2(vUv.x * 1.777, vUv.y); vec2 d = normalize(vec2(0.5, -0.87));
      float c = dot(p, vec2(-d.y, d.x)), l = dot(p - vec2(0.0, 1.0), d);
      // the beams stay put; the light inside them shimmers in place as the leaves overhead stir
      float cs = c;
      float beam = smoothstep(0.25, 0.95, sin(cs * 10.5 + 0.9));
      float swell = 0.7 + 0.4 * vnoise(vec2(floor((cs * 10.5 + 0.9 - 1.57) / 6.283) * 7.3 + 2.0, t * 0.3));
      float ph = 6.0 * vnoise(vec2(cs * 23.0, l * 3.0));                                   // every patch of a beam flickers on its own clock
      float streak = 0.5 + 0.45 * vnoise(vec2(cs * 60.0, t * 0.9 + ph)) + 0.3 * vnoise(vec2(cs * 140.0 + 7.0, t * 1.7 + ph * 1.6));
      float b = beam * swell * streak;
      float fade = (1.0 - smoothstep(0.45, 1.55, l)) * smoothstep(0.1, 0.35, c) * (1.0 - smoothstep(1.25, 1.75, c));
      gl_FragColor = vec4(vec3(1.0, 0.9, 0.66) * b * fade * shaftK, 1.0);
    }` });
const fxScene = new THREE.Scene(); fxScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shaftMat));
// birds far behind the rooftops (the roofs hide them, like any other depth): each is a brush-stroke silhouette drawn in a shader,
// wings bending as they beat, in two loose flocks that flap, glide and drift across the sky
const birds = [];
{ const g = new THREE.PlaneGeometry(2.6, 1.3);
  const mk = () => new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: { flap: { value: 0 }, lag: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform float flap, lag; varying vec2 vUv;
      void main(){ vec2 p = (vUv - 0.5) * vec2(2.0, 1.0);
        float span = 1.0 - 0.22 * abs(flap), ax = abs(p.x) / span, aa = fwidth(p.y) * 1.4 + 0.004;
        float y = 0.40 * flap * ax - 0.30 * lag * ax * ax + 0.07 * ax * (1.0 - ax);          // the wingtips trail behind the stroke
        float th = mix(0.062, 0.010, pow(min(ax, 1.0), 0.75));
        float wing = (1.0 - smoothstep(0.0, aa, abs(p.y - y) - th)) * (1.0 - smoothstep(0.93, 1.0, ax));
        float body = 1.0 - smoothstep(0.85, 1.15, length((p - vec2(0.0, 0.01)) / vec2(0.085, 0.085)));
        float a = max(wing, body); if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.045, 0.055, 0.09), a * 0.9);
        #include <colorspace_fragment>
      }` });
  const flocks = [{ n: 5, sp: 4.6, y: S.birds[0], z: -112, off: 40, dir: 1, sc: 1.5 }, { n: 3, sp: 3.4, y: S.birds[1], z: -150, off: 150, dir: -1, sc: 1.6 }];
  flocks.forEach((f, k) => { for (let i = 0; i < f.n; i++) { const b = new THREE.Mesh(g, mk()); const side = i % 2 ? 1 : -1, rank = Math.ceil(i / 2);
    b.userData = { f, ph: k * 3.1 + i * 1.9, dx: -rank * 3.4 - (i % 3) * 0.6, dy: side * rank * 0.8 + (i * 0.37 % 1) * 0.6, w: 7.5 + (i * 0.61 % 1) * 2.0, sc: f.sc * (0.85 + (i * 0.43 % 1) * 0.3) };
    b.frustumCulled = false; b.renderOrder = 2; scene.add(b); birds.push(b); } }); }
// Cloth cut out of the painting: each banner is its own small mesh, pinned along its pole, with the wall repainted behind it.
const banners = [];
{ const bj = await vfetch(`${base}_banners.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (bj) { const tex = await texLoader.loadAsync(`${base}_banners.png`); tex.colorSpace = THREE.SRGBColorSpace;
    const [PW, PH] = bj.size;
    bj.banners.forEach((b, i) => { const [x0, y0, x1, y1] = b.rect, [a0, b0, a1, b1] = b.atlas, D = b.depth * 0.97;
      const g = new THREE.PlaneGeometry(1, 1, 6, 22), pos = g.attributes.position, uv = g.attributes.uv, hang = new Float32Array(pos.count * 2), v = new THREE.Vector3();
      for (let k = 0; k < pos.count; k++) { const ux = uv.getX(k), h = 1 - uv.getY(k), px = x0 + (x1 - x0) * ux, py = y0 + (y1 - y0) * h;
        v.set((px / PW * K.width - K.cx) / K.fx * D, -(py / PH * K.height - K.cy) / K.fy * D, -D).applyMatrix4(camera.matrixWorld); pos.setXYZ(k, v.x, v.y, v.z);
        uv.setXY(k, a0 + (a1 - a0) * ux, 1 - (b0 + (b1 - b0) * h)); hang[k * 2] = ux - 0.5; hang[k * 2 + 1] = h; }
      g.setAttribute("hang", new THREE.BufferAttribute(hang, 2));
      const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { map: { value: tex }, t: { value: 0 }, ph: { value: i * 2.1 + 0.4 }, wid: { value: (x1 - x0) / PW * K.width / K.fx * D }, gx: { value: (x0 + x1) / 2 / PW }, amp: { value: +(params.get("cloth") || 1) } },
        vertexShader: `attribute vec2 hang; uniform float t, ph, wid, gx, amp; varying vec2 vUv; varying float vSh;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
          void main(){
            vUv = uv; float h = hang.y, fall = h * (0.3 + 0.7 * h) * amp;
            // the same gusts that cross the plants reach the cloth
            float gust = smoothstep(0.25, 0.7, vnoise(vec2(gx * 2.2 - t * 0.3, 1.3 + t * 0.05)));
            float wind = 0.25 + 0.75 * gust;
            // the whole banner leans downwind and swings back like a slow pendulum
            float lean = wind * (0.13 + 0.07 * sin(t * 1.15 + ph)) + 0.045 * sin(t * 2.05 + ph * 1.7);
            // ripples run down the cloth from the pole to the free tails, a little out of step across its width
            float a = h * 6.0 - t * 2.7 + ph + hang.x * 1.9;
            float rip = 0.6 * sin(a) + 0.3 * sin(a * 1.8 + 1.3), slope = 0.6 * cos(a) + 0.54 * cos(a * 1.8 + 1.3);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            mv.x += wid * fall * (lean + wind * 0.085 * rip);
            mv.x -= hang.x * wid * fall * wind * 0.2 * (0.5 + 0.5 * sin(a * 0.5 + 0.7));      // the tails turn edge-on as they twist
            mv.y += wid * fall * (abs(lean) * 0.3 + wind * 0.03 * rip);                        // and lift a touch as they swing out
            vSh = 1.0 + min(h * 3.0, 1.0) * wind * 0.2 * slope;                                // folds catch and lose the light
            gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying float vSh;
          void main(){ vec4 c = texture2D(map, vUv); if (c.a < 0.01) discard; gl_FragColor = vec4(c.rgb * vSh, c.a);
            #include <colorspace_fragment>
          }` });
      const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 5; scene.add(m); banners.push(m); }); } }
// Awning valances: the scalloped flaps are strips pinned along the awning's edge; each flap lifts and flutters as gusts pass.
{ const fj = await vfetch(`${base}_fringes.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (fj) { const tex = await texLoader.loadAsync(`${base}_fringes.png`); tex.colorSpace = THREE.SRGBColorSpace;
    const [PW, PH] = fj.size, R = 5;
    fj.pieces.forEach((pc, i) => { const n = pc.top.length, [bx0, by0, bx1, by1] = pc.bbox, [a0, b0, a1, b1] = pc.atlas;
      const pos = new Float32Array(n * (R + 1) * 3), uv = new Float32Array(n * (R + 1) * 2), hang = new Float32Array(n * (R + 1) * 3), idx = [], v = new THREE.Vector3();
      pc.top.forEach(([x, y, d], c) => { const D = d * 0.97; for (let r = 0; r <= R; r++) { const k = c * (R + 1) + r, h = r / R, py = y + pc.len * h;
        v.set((x / PW * K.width - K.cx) / K.fx * D, -(py / PH * K.height - K.cy) / K.fy * D, -D).applyMatrix4(camera.matrixWorld); pos.set([v.x, v.y, v.z], k * 3);
        uv.set([a0 + (a1 - a0) * (x - bx0) / (bx1 - bx0), 1 - (b0 + (b1 - b0) * (py - by0) / (by1 - by0))], k * 2);
        hang.set([x / PW, h, pc.len / PH * K.height / K.fy * D], k * 3);
        if (c < n - 1 && r < R) idx.push(k, k + 1, k + R + 1, k + 1, k + R + 2, k + R + 1); } });
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      g.setAttribute("hang", new THREE.BufferAttribute(hang, 3)); g.setIndex(idx);
      const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { map: { value: tex }, t: { value: 0 }, ph: { value: i * 1.7 }, amp: { value: +(params.get("cloth") || 1) } },
        vertexShader: `attribute vec3 hang; uniform float t, ph, amp; varying vec2 vUv; varying float vSh;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
          void main(){
            vUv = uv; float h = hang.y, len = hang.z, fall = h * (0.4 + 0.6 * h) * amp;
            float gust = smoothstep(0.25, 0.7, vnoise(vec2(hang.x * 2.2 - t * 0.3, 2.1 + t * 0.05)));
            float wind = 0.2 + 0.8 * gust;
            // a flutter that runs along the awning, so neighbouring flaps move one after another rather than together
            float a = hang.x * 95.0 - t * 3.1 + ph, b = hang.x * 41.0 - t * 1.7 + ph * 2.0;
            float fl = 0.6 * sin(a) + 0.4 * sin(b), lift = 0.5 + 0.5 * sin(b + 1.1);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            mv.x += len * fall * wind * (0.10 + 0.09 * fl);                 // pushed downwind, wobbling
            mv.y += len * fall * wind * (0.05 + 0.13 * lift);               // and lifted, which shortens the flap as it swings out toward us
            vSh = 1.0 + h * wind * (0.10 * fl + 0.10 * lift);               // a lifted flap turns its face to the sky
            gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying float vSh;
          void main(){ vec4 c = texture2D(map, vUv); if (c.a < 0.01) discard; gl_FragColor = vec4(c.rgb * vSh, c.a);
            #include <colorspace_fragment>
          }` });
      const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 5; scene.add(m); banners.push(m); }); } }
// The branch overhanging the corner: one cut-out that rocks from where it leaves the frame, its leaf clumps stirring on top of that.
{ const bj = await vfetch(`${base}_branch.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (bj) { const tex = await texLoader.loadAsync(`${base}_branch.png`); tex.colorSpace = THREE.SRGBColorSpace;
    const [PW, PH] = bj.size, [x0, y0, x1, y1] = bj.rect, D = bj.depth, g = new THREE.PlaneGeometry(1, 1, 36, 12), pos = g.attributes.position, uv = g.attributes.uv, hang = new Float32Array(pos.count * 2), v = new THREE.Vector3();
    for (let k = 0; k < pos.count; k++) { const px = x0 + (x1 - x0) * uv.getX(k), py = y0 + (y1 - y0) * (1 - uv.getY(k));
      v.set((px / PW * K.width - K.cx) / K.fx * D, -(py / PH * K.height - K.cy) / K.fy * D, -D).applyMatrix4(camera.matrixWorld); pos.setXYZ(k, v.x, v.y, v.z);
      hang[k * 2] = px - bj.pivot[0]; hang[k * 2 + 1] = py - bj.pivot[1]; }
    g.setAttribute("hang", new THREE.BufferAttribute(hang, 2));
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { map: { value: tex }, t: { value: 0 }, pxw: { value: K.width / PW / K.fx * D }, amp: { value: +(params.get("cloth") || 1) } },
      vertexShader: `attribute vec2 hang; uniform float t, pxw, amp; varying vec2 vUv; varying float vSh;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
        void main(){
          vUv = uv; float r = length(hang) / 300.0;
          float gust = smoothstep(0.25, 0.7, vnoise(vec2(0.1 * 2.2 - t * 0.3, 1.5 + t * 0.05))), wind = 0.25 + 0.75 * gust;
          // the bough dips and recovers; the further from where it is anchored, the more it travels
          float ang = amp * wind * (0.012 * sin(t * 0.8) + 0.02 * (vnoise(vec2(t * 0.35, 4.0)) - 0.5));
          vec2 d = vec2(-hang.y, hang.x) * ang;
          // leaf clumps stir on their own
          vec2 q = hang * 0.022;
          d += amp * wind * r * 3.2 * (vec2(vnoise(q + vec2(t * 0.9, 0.0)), vnoise(q * 1.2 + vec2(7.0, t * 0.7))) - 0.5);
          d += amp * wind * r * 1.2 * (vec2(vnoise(q * 3.1 + vec2(t * 2.1, 3.0)), vnoise(q * 2.7 + vec2(1.0, t * 1.8))) - 0.5);
          vec4 mv = modelViewMatrix * vec4(position, 1.0); mv.x += d.x * pxw; mv.y -= d.y * pxw;
          vSh = 1.0 + 0.08 * wind * (vnoise(q * 1.5 + vec2(t * 0.8, 9.0)) - 0.5) * 2.0;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying float vSh;
        void main(){ vec4 c = texture2D(map, vUv); if (c.a < 0.01) discard; gl_FragColor = vec4(c.rgb * vSh, c.a);
          #include <colorspace_fragment>
        }` });
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 6; scene.add(m); banners.push(m); } }
// The mill's waterwheel: a real modelled wheel (two rims, spokes, hub, paddle boards) standing in the painting where the painted one
// was, at the angle the painting shows it, so its far side, its thickness and its paddles are true geometry and turn correctly.
let wheelSpin = null;
{ const wj = await vfetch(`${base}_wheel.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (wj) { const wood = await texLoader.loadAsync(`${base}_wood.jpg`); wood.colorSpace = THREE.SRGBColorSpace; wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
    const [PW, PH] = wj.size, D = wj.depth * 0.95, R = wj.b / PW * K.width / K.fx * D, T = R * 0.36, yaw = Math.acos(Math.min(1, wj.a / wj.b));
    const look = Math.atan2((wj.c[0] / PW * K.width - K.cx) / K.fx, 1), n = new THREE.Vector3(Math.sin(look + yaw), 0, -Math.cos(look + yaw)).applyQuaternion(camera.quaternion);            // the axle: away from us and to the right
    const front = new THREE.Vector3((wj.c[0] / PW * K.width - K.cx) / K.fx * D, -(wj.c[1] / PH * K.height - K.cy) / K.fy * D, -D).applyMatrix4(camera.matrixWorld);
    const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: wood }, face: { value: await texLoader.loadAsync(`${base}_wheel.png`).then(t => { t.colorSpace = THREE.SRGBColorSpace; return t; }) }, sunD: { value: new THREE.Vector3(-0.62, 0.55, 0.56).normalize().applyQuaternion(camera.quaternion) }, cy: { value: front.y }, rad: { value: R } },
      vertexShader: `attribute float tone; varying vec2 vUv; varying vec3 vN, vW, vLp, vLn; varying float vTone;
        void main(){ vUv = uv; vTone = tone; vLp = position; vLn = normal; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform sampler2D map, face; uniform vec3 sunD; uniform float cy, rad; varying vec2 vUv; varying vec3 vN, vW, vLp, vLn; varying float vTone;
        void main(){ vec3 base = texture2D(map, vUv).rgb * vTone;
          if (abs(vLn.z) > 0.9 && vTone > 0.8) { float rr = length(vLp.xy) / rad; vec4 fc = texture2D(face, vLp.xy / (rad * 1.06) * 0.5 + 0.5);
            if ((rr > 0.82 || rr < 0.27) && fc.a > 0.6) base = fc.rgb * 0.92; } vec3 nn = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
          float cel = smoothstep(0.05, 0.16, dot(nn, sunD));                                                          // one lit tone, one shade tone, like Sol
          cel *= smoothstep(-0.75, 0.15, (vW.y - cy) / rad + 0.35 * (vW.x - 0.0) * 0.0);                                                          // the lower half sits in the shade of the wall and pit
          vec3 col = mix(base * vec3(0.36, 0.37, 0.50), base * vec3(1.22, 1.12, 0.92), cel);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }` });
    const parts = [], add = (g, tone, m) => { g.applyMatrix4(m); g.setAttribute("tone", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(tone), 1)); parts.push(g); };
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = (x, y, z) => new THREE.Vector3(x, y, z), one = V(1, 1, 1), Zax = V(0, 0, 1);
    const ringShape = new THREE.Shape(); ringShape.absarc(0, 0, R, 0, Math.PI * 2, false); const hole = new THREE.Path(); hole.absarc(0, 0, R * 0.83, 0, Math.PI * 2, true); ringShape.holes.push(hole);
    const rimT = T * 0.22;
    for (const zc of [-T / 2, T / 2 - rimT]) { const g = new THREE.ExtrudeGeometry(ringShape, { depth: rimT, bevelEnabled: false, curveSegments: 56 });
      const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) / R * 1.5, uv.getY(k) / R * 1.5);
      add(g, 1.0, M.makeTranslation(0, 0, zc)); }
    for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; Q.setFromAxisAngle(Zax, a);
      for (const zc of [-T / 2 + rimT / 2, T / 2 - rimT / 2]) add(new THREE.BoxGeometry(R * 0.085, R * 0.74, rimT * 0.8), 0.95, M.compose(V(-Math.sin(a) * R * 0.48, Math.cos(a) * R * 0.48, zc), Q.clone(), one)); }
    for (let k = 0; k < 28; k++) { const a = (k + 0.5) / 28 * Math.PI * 2; Q.setFromAxisAngle(Zax, a + 0.35);                                   // paddle boards between the rims, slightly raked
      add(new THREE.BoxGeometry(R * 0.022, R * 0.20, T * 0.98), 0.62, M.compose(V(-Math.sin(a) * R * 0.915, Math.cos(a) * R * 0.915, 0), Q.clone(), one)); }
    { const g = new THREE.CylinderGeometry(R * 0.985, R * 0.985, T * 0.6, 56, 1, true); add(g, 0.42, M.makeRotationX(Math.PI / 2)); }           // the sole boards behind the paddles
    add(new THREE.CylinderGeometry(R * 0.25, R * 0.25, T * 1.12, 32), 0.9, M.makeRotationX(Math.PI / 2));                                       // hub
    add(new THREE.CylinderGeometry(R * 0.07, R * 0.07, T * 1.5, 12), 0.45, M.makeRotationX(Math.PI / 2));                                       // axle
    const geos = parts.map(g => g.index ? g.toNonIndexed() : g), total = geos.reduce((a, g) => a + g.attributes.position.count, 0), merged = new THREE.BufferGeometry();
    for (const name of ["position", "normal", "uv", "tone"]) { const sz = geos[0].attributes[name].itemSize, arr = new Float32Array(total * sz); let o = 0;
      for (const g of geos) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; } merged.setAttribute(name, new THREE.BufferAttribute(arr, sz)); }
    mat.side = THREE.DoubleSide;
    const spin = new THREE.Mesh(merged, mat); spin.frustumCulled = false; const holder = new THREE.Group(); holder.add(spin);
    holder.quaternion.setFromUnitVectors(Zax, n.clone().normalize()); holder.position.copy(front).addScaledVector(n, T / 2); scene.add(holder);
    wheelSpin = { mesh: spin, speed: wj.speed, holder, R, T, n: n.clone(), depth: D }; } }
// Foreground elements cut out of the painting (willow, tree, flower beds): each is its own object drawn over the scene, exactly where
// it was painted, with the scene repainted behind it. They are still for now; each carries what a motion pass needs (time, anchor, weights).
const props = [];
{ const pj = await vfetch(`${base}_props.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (pj && !params.has("noprops")) for (const pr of pj.props) { const tex = await texLoader.loadAsync(`${base}_prop_${pr.name}.png`); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
    const [PW, PH] = pj.size, [x0, y0, x1, y1] = pr.rect, g = new THREE.PlaneGeometry(1, 1, 24, 16), pos = g.attributes.position, uv = g.attributes.uv, wgt = new Float32Array(pos.count);
    for (let k = 0; k < pos.count; k++) { const ux = uv.getX(k), uy = uv.getY(k); pos.setXYZ(k, (x0 + (x1 - x0) * ux) / PW * 2 - 1, 1 - (y1 - (y1 - y0) * uy) / PH * 2, 0);
      wgt[k] = pr.anchor === "top" ? 1 - uy : pr.anchor === "left" ? ux : uy; }                       // 0 where it is rooted, 1 at its free end
    g.setAttribute("wgt", new THREE.BufferAttribute(wgt, 1));
    const mat = new THREE.ShaderMaterial({ transparent: true, depthTest: false, depthWrite: false, uniforms: { map: { value: tex }, t: { value: 0 }, amp: { value: +(params.get("sway") ?? 1.5) }, kind: { value: pr.anchor === "top" ? 0 : pr.anchor === "left" ? 1 : 2 }, seed: { value: props.length * 2.37 + 0.6 }, px: { value: 2 / PW }, asp: { value: PW / PH } },
      vertexShader: `attribute float wgt; uniform float t, amp, kind, seed, px, asp; varying vec2 vUv;
        void main(){ vUv = uv; vec2 p = position.xy; float sx = p.x * 3.0;
          // one wind for the whole scene, blowing to the right in slow gusts that cross the screen; every object answers it in its own way
          float gust = smoothstep(0.15, 0.95, 0.5 + 0.35 * sin(t * 0.21 - p.x * 1.1 + 0.8) + 0.25 * sin(t * 0.13 - p.x * 0.6 + 2.0));
          float wind = 0.3 + 0.7 * gust; vec2 d = vec2(0.0);
          if (kind < 0.5) {            // willow: fronds hang from the top; the swing travels down each one, and neighbours are out of step
            float w = pow(wgt, 1.5), ph = sx * 2.3 + seed;
            float sw = 0.55 * sin(t * 0.85 + ph - wgt * 2.2) + 0.30 * sin(t * 1.9 + ph * 1.7 - wgt * 4.0) + 0.15 * sin(t * 3.1 + ph * 2.9 - wgt * 6.0);
            d.x = w * (wind * 7.0 * sw + gust * 6.0);  d.y = w * abs(d.x / max(w, 0.05)) * 0.12;               // pushed downwind, lifting a touch as it swings out
          } else if (kind < 1.5) {     // tree: a heavy mass rooted at the frame's edge; boughs nod slowly, outer leaves shiver
            float w = wgt * wgt, ph = p.y * 4.0 + seed;
            d.x = w * wind * (2.6 * sin(t * 0.6 + ph) + 1.0 * sin(t * 2.3 + ph * 3.1 + sx * 5.0));
            d.y = w * wind * (1.8 * sin(t * 0.5 + ph * 1.3 + 1.0) + 0.8 * sin(t * 2.7 + sx * 7.0));
          } else {                     // flowers: stems bend from the ground, heads bobbing, each clump on its own beat
            float w = wgt * wgt, ph = sx * 9.0 + seed;
            float sw = 0.6 * sin(t * 1.25 + ph) + 0.4 * sin(t * 2.6 + ph * 1.8);
            d.x = w * (wind * 5.0 * sw + gust * 3.5);  d.y = -w * abs(d.x / max(w, 0.05)) * 0.10;
          }
          gl_Position = vec4(p + d * amp * px * vec2(1.0, asp), 0.0, 1.0); }`,
      fragmentShader: `uniform sampler2D map; varying vec2 vUv;
        void main(){ vec4 c = texture2D(map, vUv); if (c.a < 0.01) discard; gl_FragColor = c;
          #include <colorspace_fragment>
        }` });
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 7; m.name = pr.name; scene.add(m); props.push(m); } }
const wheelFx = (() => { if (!wheelSpin || !params.has("oldvfx")) return null;
  const MAX = 420, { holder, R, T, n, speed } = wheelSpin, ex = new THREE.Vector3(1, 0, 0).applyQuaternion(holder.quaternion), ey = new THREE.Vector3(0, 1, 0).applyQuaternion(holder.quaternion);
  const C = holder.position.clone(), waterY = C.y - R * 0.86, wSign = Math.sign(speed);
  const g = new THREE.InstancedBufferGeometry(); g.instanceCount = 0;
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3), iVel = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3), iData = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
  [iPos, iVel, iData].forEach(a => a.setUsage(THREE.DynamicDrawUsage)); g.setAttribute("iPos", iPos); g.setAttribute("iVel", iVel); g.setAttribute("iData", iData);
  const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: { res: { value: new THREE.Vector2(1280, 720) }, t: { value: 0 } },
    vertexShader: `attribute vec3 iPos, iVel; attribute vec4 iData; uniform vec2 res; varying float vA, vL, vW, vAl, vAc, vKind, vSeed;
      void main(){
        vec4 c0 = projectionMatrix * viewMatrix * vec4(iPos, 1.0), c1 = projectionMatrix * viewMatrix * vec4(iPos - iVel * iData.w, 1.0);
        vec2 s0 = c0.xy / c0.w * res * 0.5, s1 = c1.xy / c1.w * res * 0.5, d = s1 - s0; float L = length(d);
        vec2 dir = L > 0.3 ? d / L : vec2(0.0, 1.0), perp = vec2(-dir.y, dir.x);
        float w = max(iData.x * projectionMatrix[1][1] * res.y * 0.5 / c0.w, 0.9);                         // size in metres -> pixels at this depth
        float al = -w + position.y * (L + 2.0 * w), ac = position.x * w;
        vec2 sp = s0 + dir * al + perp * ac;
        gl_Position = vec4(sp / (res * 0.5) * c0.w, c0.z, c0.w);
        vA = iData.y; vL = L; vW = w; vAl = al; vAc = ac; vKind = iData.z; vSeed = fract(iData.z * 7.31 + iPos.x * 3.7); }`,
    fragmentShader: `varying float vA, vL, vW, vAl, vAc, vKind, vSeed;
      void main(){
        float dd = length(vec2(max(-vAl, 0.0) + max(vAl - vL, 0.0), vAc)) / vW;
        float a; vec3 c;
        if (vKind < 1.5) { a = 1.0 - smoothstep(0.45, 1.0, dd); a *= mix(0.25, 1.0, clamp(1.0 - vAl / max(vL, 1.0), 0.0, 1.0)); c = vec3(0.82, 0.90, 0.98); }   // drops and spray: bright head, fading tail
        else { a = exp(-dd * dd * 2.6); c = vec3(0.84, 0.90, 0.95); }                                                           // mist: a soft puff
        a *= vA; if (a < 0.004) discard;
        gl_FragColor = vec4(c, a);
        #include <colorspace_fragment>
      }` });
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.renderOrder = 6; scene.add(mesh);
  const P = []; let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rimPoint = (a, z) => C.clone().addScaledVector(ex, Math.cos(a) * R).addScaledVector(ey, Math.sin(a) * R).addScaledVector(n, z);
  const spinVel = (p) => new THREE.Vector3().crossVectors(n, p.clone().sub(C)).multiplyScalar(speed);
  const emit = (kind, p, v, life, size, stretch, alpha) => { if (P.length < MAX) P.push({ kind, p, v, age: 0, life, size, stretch, alpha }); };
  let acc = [0, 0, 0];
  function step(dt) {
    const rate = [110, 130, 2.6];                                                                                    // drips, spray, mist per second
    for (let k = 0; k < 3; k++) { acc[k] += rate[k] * dt;
      while (acc[k] >= 1) { acc[k] -= 1;
        if (k === 0) { // drips and spill: the loaded, descending side (under the fall) sheds water off its rim and paddles, carrying the wheel's motion
          for (let tries = 0; tries < 6; tries++) { const a = rnd() * Math.PI * 2, p = rimPoint(a, (rnd() - 0.5) * T), v = spinVel(p);
            if (p.y < C.y + R * 0.6 && p.y > waterY + R * 0.05 && v.y < -0.05) {
              emit(0, p, v.multiplyScalar(0.8).add(new THREE.Vector3((rnd() - 0.5) * 0.15, rnd() * 0.1, (rnd() - 0.5) * 0.15)), 1.6, 0.016 + rnd() * 0.02, 0.045, 0.35 + rnd() * 0.35); break; } } }
        else if (k === 1) { // spray: where the paddles hit the pool, thrown up and out, along the way the wheel is moving
          const side = rnd() < 0.5 ? -1 : 1, a0 = Math.asin(Math.max(-1, Math.min(1, (waterY - C.y) / R)));
          for (let tries = 0; tries < 4; tries++) { const a = rnd() * Math.PI * 2, p = rimPoint(a, (rnd() - 0.5) * T);
            if (Math.abs(p.y - waterY) < R * 0.14 && spinVel(p).y < 0) { const v = spinVel(p).multiplyScalar(0.6).add(new THREE.Vector3((rnd() - 0.5) * 0.6, 0.6 + rnd() * 1.1, (rnd() - 0.5) * 0.6));
              emit(1, p.setY(waterY + 0.02), v, 0.45 + rnd() * 0.5, 0.014 + rnd() * 0.02, 0.04, 0.5 + rnd() * 0.3); break; } } }
        else { const a = Math.PI * 1.5 + (rnd() - 0.5) * 1.4, p = rimPoint(a, (rnd() - 0.5) * T); p.y = waterY + 0.15;            // mist at the foot
          emit(2, p, new THREE.Vector3(0.10 + rnd() * 0.08, 0.06 + rnd() * 0.06, (rnd() - 0.5) * 0.05), 3 + rnd() * 2, 0.55 + rnd() * 0.5, 0, 0.22); } } }
    for (let i = P.length - 1; i >= 0; i--) { const q = P[i]; q.age += dt;
      if (q.kind < 2) { q.v.y -= 9.8 * dt; q.v.multiplyScalar(1 - 0.4 * dt); }
      q.p.addScaledVector(q.v, dt);
      if (q.age > q.life || (q.kind < 2 && q.p.y < waterY && q.v.y < 0)) P.splice(i, 1); }
  }
  for (let i = 0; i < 150; i++) step(1 / 30);                                                                      // prewarmed: never starts empty
  function update(dt) { step(dt); const tmp = new THREE.Vector2(); renderer.getDrawingBufferSize(tmp); mat.uniforms.res.value.copy(tmp);
    P.forEach((q, i) => { const f = q.age / q.life;
      const env = q.kind < 2 ? Math.min(1, q.age / 0.06) * (1 - Math.max(0, (f - 0.7) / 0.3)) : Math.sin(Math.PI * Math.min(f, 1));       // drops: quick in, hold, out; mist: soft triangle
      const sz = q.kind < 2 ? q.size * (q.kind === 1 ? 1 - f * 0.6 : 1) : q.size * (0.45 + 0.55 * f);
      iPos.setXYZ(i, q.p.x, q.p.y, q.p.z); iVel.setXYZ(i, q.v.x, q.v.y, q.v.z); iData.setXYZW(i, sz, q.alpha * env, q.kind, q.stretch); });
    g.instanceCount = P.length; iPos.needsUpdate = iVel.needsUpdate = iData.needsUpdate = true; }
  return { update };
})();
// ============ painted water VFX (docs/Waterfall_VFX_Plan.md): textured ribbons for pouring water, painted flipbook-style particles ============
const waterVfx = await (async () => { if (!S.flow || !wheelSpin || params.has("oldvfx")) return null;
  const tl = (u, lin = true, rep = false) => texLoader.loadAsync(u).then(t => { t.colorSpace = lin ? THREE.NoColorSpace : THREE.SRGBColorSpace; if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; });
  const [strand, foamT, dropsT, crownsT, mistT, ramp] = await Promise.all([tl("./plates/water_strand.png", true, true), tl("./plates/water_foam.png", true, true), tl("./plates/vfx_drops.png"), tl("./plates/vfx_crowns.png"), tl("./plates/vfx_mist.png"), tl("./plates/water_ramp.png", false)]);
  ramp.generateMipmaps = false; ramp.minFilter = ramp.magFilter = THREE.LinearFilter;
  const res = new THREE.Vector2(1280, 720), PREM = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), toCam = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion).setY(0).normalize();
  const atDepth = (u, v, D) => new THREE.Vector3((u - K.cx) / K.fx * D, -(v - K.cy) / K.fy * D, -D).applyMatrix4(camera.matrixWorld);
  const { holder, R: WR, n: WN, speed: WS } = wheelSpin, WC = holder.position.clone(), WEX = new THREE.Vector3(1, 0, 0).applyQuaternion(holder.quaternion), WEY = new THREE.Vector3(0, 1, 0).applyQuaternion(holder.quaternion);
  const pj = await vfetch(`${base}_pour.json`).then(r => r.json()), PV = (a) => new THREE.Vector3(...a);
  const pourPts = pj.pour.map(PV), flumePts = pj.flume.map(PV), mouthA = PV(pj.mouth[0]), mouthB = PV(pj.mouth[1]);
  const wheelPoolY = WC.y - WR * 0.86, mouthW = mouthA.distanceTo(mouthB), lip = mouthA.clone().add(mouthB).multiplyScalar(0.5);
  // angles round the axle, measured from the top towards the side the water runs down (the right, as seen)
  const UPV = new THREE.Vector3(0, 1, 0), aTop = Math.atan2(UPV.dot(WEY), UPV.dot(WEX)), aRight = Math.atan2(camRight.dot(WEY), camRight.dot(WEX));
  const sgn = Math.sign(Math.sin(aRight - aTop)) || 1, clockA = (deg) => aTop + sgn * deg * Math.PI / 180;
  const onWheel = (deg, r, z = 0) => { const a = clockA(deg); return WC.clone().addScaledVector(WEX, Math.cos(a) * r).addScaledVector(WEY, Math.sin(a) * r).addScaledVector(WN, z); };
  // 4. the top of the wheel must move away from the flume, towards the side the water runs down
  { const topV = new THREE.Vector3().crossVectors(WN, onWheel(0, WR).sub(WC)).multiplyScalar(wheelSpin.speed); if (topV.dot(camRight) < 0) wheelSpin.speed = -wheelSpin.speed; }
  const WS2 = wheelSpin.speed, LAND = 50, CASC_END = 150, RC = WR + 0.07;                     // lands at about 1:40, runs down to 5 o'clock
  const landPt = onWheel(LAND, RC), cascEnd = onWheel(CASC_END, RC), foot = cascEnd.clone().setY(wheelPoolY), poolY = wheelPoolY;
  // ---- ribbon along a path, like a trail renderer: each row faces the camera across its own direction of travel (cross(tangent, toCamera)),
  // with a slight bow for volume. V is the water's time of travel, so a constant scroll moves the paint at the water's own speed and it
  // stretches as the water speeds up. sStart/sEnd set where on the erosion profile this piece sits (0 = solid lip, 1 = foot).
  function buildPath(pts, { v0 = 0.8, w, rows = 60, cols = 8, bow = 0.06, back = 0, wScale = 1, seed = 0, flip = false, tStart = 0, sStart = 0, sEnd = 1, slow = null, side0 = null }) {
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal"), P = [], UV = [], AUX = [], N = [], I = [], camPos = camera.position;
    const top = pts[0].y; let t = tStart, prev = curve.getPoint(0);
    for (let i = 0; i <= rows; i++) { const f = i / rows, c = curve.getPoint(f), tan = curve.getTangent(f), toCam = camPos.clone().sub(c).normalize();
      if (i > 0) { const ds = c.distanceTo(prev), sp = Math.sqrt(v0 * v0 + 2 * 9.81 * Math.max(0, top - c.y)) * (slow ? slow(f) : 1); t += ds / Math.max(sp, 0.2); } prev = c;
      let side = new THREE.Vector3().crossVectors(tan, toCam).normalize(); if (side0) { const s0 = side0.clone().multiplyScalar(Math.sign(side0.dot(side)) || 1); side = s0.lerp(side, THREE.MathUtils.smoothstep(f, 0, 0.35)).normalize(); }
      const width = w(f) * wScale;
      for (let j = 0; j <= cols; j++) { const u = j / cols, x = 2 * u - 1;
        const q = c.clone().addScaledVector(side, x * width * 0.5).addScaledVector(toCam, bow * Math.cos(x * Math.PI / 2) - back);
        P.push(q.x, q.y, q.z); UV.push(flip ? 1 - u : u, t); AUX.push(sStart + (sEnd - sStart) * f, Math.abs(x), seed); N.push(toCam.x, toCam.y, toCam.z); } }
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { const a = i * (cols + 1) + j, b = a + cols + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
    const geo = new THREE.BufferGeometry(); geo.setIndex(I);
    geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3)); geo.setAttribute("aAux", new THREE.Float32BufferAttribute(AUX, 3)); return { geo, T: t }; }
  // ---- ribbon: a ballistic arc (used for the spill tongues off the wheel)
  const pourMat = (o) => new THREE.ShaderMaterial(Object.assign({}, PREM, { side: THREE.DoubleSide, defines: Object.assign(o.hilite ? { HILITE: 1 } : {}, o.steps ? { STEPS: 1 } : {}),
    uniforms: { uStrand: { value: strand }, uRamp: { value: ramp }, uPlate: { value: plateTex }, uTime: { value: 0 }, uThr: { value: o.thr }, uRow: { value: o.row }, uAdd: { value: o.add || 0 },
      uStrength: { value: o.strength || 1 }, uPoolY: { value: o.poolY }, uPulse: { value: 0 }, uTileA: { value: new THREE.Vector2(...o.tileA) }, uTileB: { value: new THREE.Vector2(...o.tileB) },
      uSpeed: { value: new THREE.Vector2(...o.speed) }, uRes: { value: res }, uWobble: { value: o.wobble ?? 1 }, uFoam: { value: new THREE.Color(0.91, 0.95, 0.93) }, uSun: { value: new THREE.Color(1.0, 0.945, 0.785) }, uSpin: { value: 0 }, uNB: { value: 28 }, uPad: { value: 0 } },
    vertexShader: `uniform float uTime, uWobble; uniform sampler2D uStrand; attribute vec3 aAux; attribute float aArc; varying vec2 vUv; varying vec3 vAux; varying vec3 vWorld; varying float vArc;
      void main(){ vArc = aArc; float n = textureLod(uStrand, vec2(uv.x * 0.5 + aAux.z, (uv.y - uTime) * 0.5), 3.0).a - 0.5;
        vec3 p = position + normal * n * mix(0.03, 0.12, aAux.x) * uWobble; vec4 w = modelMatrix * vec4(p, 1.0); vWorld = w.xyz; vUv = uv; vAux = aAux;
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform sampler2D uStrand, uRamp, uPlate; uniform float uTime, uThr, uRow, uAdd, uStrength, uPoolY, uPulse; uniform vec2 uTileA, uTileB, uSpeed, uRes; uniform vec3 uFoam, uSun;
      uniform float uSpin, uNB, uPad; varying vec2 vUv; varying vec3 vAux; varying vec3 vWorld; varying float vArc;
      void main(){
        float t = vUv.y, s = vAux.x, edge = vAux.y, sd = vAux.z;
        vec2 d = (texture2D(uStrand, vec2(vUv.x + sd, (t - uTime * 0.35) * 0.5)).ga - 0.5) * 0.06;
        vec4 A = texture2D(uStrand, vec2(vUv.x * uTileA.x + sd, (t - uTime * uSpeed.x) * uTileA.y) + d);
        vec4 B = texture2D(uStrand, vec2(vUv.x * uTileB.x + 0.37 + sd, (t - uTime * uSpeed.y) * uTileB.y) + d);
        float wob = texture2D(uStrand, vec2(vUv.x * 0.15 + sd, (t - uTime * 0.1) * 0.6)).a;
        float n = 0.6 * A.g + 0.4 * B.g;
        float th = uThr + 0.40 * pow(s, 1.5) + 0.35 * smoothstep(0.45, 1.0, edge) + uPulse;
        th = mix(-0.2, th, smoothstep(0.03, 0.06 + 0.04 * wob, s));
        float f = max(1.5 * fwidth(n), 0.03), a = smoothstep(th - f, th + f, n);
        a *= 1.0 - smoothstep(0.90 - 0.06 * wob, 0.98, s);
        a *= smoothstep(uPoolY - 0.02, uPoolY + 0.25, vWorld.y);
      #ifdef HILITE
        a *= smoothstep(0.72, 0.80, B.b) * ((1.0 - vUv.x) * 0.6 + 0.4); vec3 col = uSun;
      #else
        float tone = 0.65 * A.r + 0.35 * B.r + 0.22 * (1.0 - vUv.x) - 0.18 * edge;
        tone = (floor(clamp(tone, 0.0, 0.999) * 4.0) + 0.5) / 4.0;                            // 4 painted bands
        vec3 col = texture2D(uRamp, vec2(tone, uRow)).rgb;
        col = mix(col, uFoam, (1.0 - smoothstep(th + f, th + f + 0.07, n)) * 0.8);              // light edge on every break
        col = mix(col, uFoam, smoothstep(0.7, 1.0, s) * 0.6 * (0.5 + 0.5 * A.a));               // aerated foot
        vec3 bg = texture2D(uPlate, gl_FragCoord.xy / uRes + d * 0.5).rgb;
        col = mix(bg * vec3(0.82, 0.95, 0.97), col, mix(0.70, 0.92, s));                       // a little see-through, refracted
      #ifdef STEPS
        float ph = fract((vArc - uSpin) * uNB / 6.2831853 - uPad);                              // 0 at each paddle, moving down with it
        float lipL = 1.0 - smoothstep(0.0, 0.07, ph), gap = smoothstep(0.05, 0.10, ph) * (1.0 - smoothstep(0.10, 0.20, ph));
        a = max(a * (1.0 - 0.55 * gap), lipL * 0.9 * (1.0 - smoothstep(0.85, 1.0, edge)));      // a white lip, a small drop, then a new sheet
        col = mix(col, uFoam, lipL * 0.85); col *= 1.0 + 0.12 * (1.0 - ph);
      #endif
      #endif
        a *= uStrength; if (a < 0.003) discard;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        gl_FragColor = vec4(gl_FragColor.rgb * a, a * (1.0 - uAdd));
      }` }));
  const meshes = [], add = (geo, mat, order) => { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = order; scene.add(m); meshes.push(m); return m; };
  // water in the flume, running straight into the pour (V continues through the lip)
  const flumeDir = flumePts[flumePts.length - 1].clone().sub(flumePts[0]).normalize(), mouthAxis = mouthB.clone().sub(mouthA).normalize();
  const flumeLen = flumePts[0].distanceTo(lip), tFl = flumeLen / 0.8;
  add(buildPath([...flumePts.slice(0, -1), lip], { v0: 0.8, w: () => mouthW * 0.9, rows: 16, bow: 0.0, tStart: -tFl, sStart: 0, sEnd: 0, side0: mouthAxis }).geo,
      pourMat({ thr: -0.1, row: 0.5 / 8, tileA: [0.7, 1.4], tileB: [1.2, 1.9], speed: [0.68, 0.88], poolY: poolY - 2, wobble: 0.2 }), 9);
  // 1. a short pour off the lip, launched along the flume (out, down and toward the wheel), landing on the rim at about 1:40; 3-4 glassy strands
  const ctrl = lip.clone().addScaledVector(flumeDir, 0.35).add(new THREE.Vector3(0, -0.08, 0)), pourPts2 = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; pourPts2.push(lip.clone().multiplyScalar((1 - t) * (1 - t)).addScaledVector(ctrl, 2 * t * (1 - t)).addScaledVector(landPt, t * t)); }
  const pourW = (f) => THREE.MathUtils.lerp(mouthW * 0.95, mouthW * 0.8, f);
  const pr = buildPath(pourPts2, { v0: 0.8, w: pourW, rows: 24, cols: 8, bow: 0.04, side0: mouthAxis, sStart: 0.0, sEnd: 0.55 });
  add(pr.geo, pourMat({ thr: 0.32, row: 0.5 / 8, tileA: [0.7, 1.4], tileB: [1.2, 1.9], speed: [0.68, 0.88], poolY: poolY - 2, wobble: 0.4 }), 9);
  add(buildPath(pourPts2, { v0: 0.8, w: pourW, rows: 24, cols: 6, back: -0.01, wScale: 0.5, side0: mouthAxis, sStart: 0.0, sEnd: 0.55 }).geo,
      pourMat({ thr: 0.32, row: 0.5 / 8, tileA: [0.7, 1.4], tileB: [2, 0.6], speed: [0.68, 1.6], poolY: poolY - 2, hilite: true, add: 1, strength: 0.3 }), 11);
  // 2. the cascade: a sheet lying across the paddles, just outside the rim, from the landing point round to 5 o'clock.
  //    Width runs along the axle (the wheel's thickness); V is time at a little over rim speed; steps travel down with each paddle.
  const NB = 28, rimSpeed = Math.abs(WS2) * WR * 1.25, cascade = (() => {
    const rows = 56, cols = 6, P = [], UV = [], AUX = [], N = [], ARC = [], I = [], camPos = camera.position, half = wheelSpin.T / 2 + 0.05;
    for (let i = 0; i <= rows; i++) { const f = i / rows, deg = LAND + (CASC_END - LAND) * f, a = clockA(deg), r = RC + 0.04 * f;
      const t = (deg - LAND) * Math.PI / 180 * r / rimSpeed;
      for (let j = 0; j <= cols; j++) { const u = j / cols, z = (2 * u - 1) * half * (1 + 0.35 * f);
        const q = WC.clone().addScaledVector(WEX, Math.cos(a) * r).addScaledVector(WEY, Math.sin(a) * r).addScaledVector(WN, z), nrm = q.clone().sub(WC).sub(WN.clone().multiplyScalar(z)).normalize();
        P.push(q.x, q.y, q.z); UV.push(u, t); AUX.push(0.35 + 0.65 * f, Math.abs(2 * u - 1), 0.61); N.push(nrm.x, nrm.y, nrm.z); ARC.push(a); } }
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { const a = i * (cols + 1) + j, b = a + cols + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
    const geo = new THREE.BufferGeometry(); geo.setIndex(I);
    geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2)); geo.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute("aAux", new THREE.Float32BufferAttribute(AUX, 3)); geo.setAttribute("aArc", new THREE.Float32BufferAttribute(ARC, 1));
    return add(geo, pourMat({ thr: 0.12, row: 0.5 / 8, tileA: [1.2, 1.3], tileB: [2.2, 1.8], speed: [1.0, 1.2], poolY: poolY - 0.3, wobble: 0.25, steps: true }), 9); })();
  // the paddle phase offset of the modelled wheel (paddles sit at (k + 0.5) / 28 of a turn, a quarter turn round from the x axis)
  cascade.material.uniforms.uPad.value = 0.5 + NB / 4; const tongues = [];
  // foam ring where the pour hits the pool
  { const RI = 0.35, RO = 1.5, seg = 48, rr = 6, P = [], UV = [], F = [], I = [];
    for (let i = 0; i <= rr; i++) { const r = RI + (RO - RI) * i / rr; for (let j = 0; j <= seg; j++) { const a = j / seg * Math.PI * 2;
      P.push(foot.x + Math.cos(a) * r, poolY + 0.01, foot.z + Math.sin(a) * r * 0.8); UV.push(j / seg * 3, Math.pow((r - RI) / (RO - RI), 0.6)); F.push(1 - i / rr); } }
    for (let i = 0; i < rr; i++) for (let j = 0; j < seg; j++) { const a = i * (seg + 1) + j, b = a + seg + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
    const geo = new THREE.BufferGeometry(); geo.setIndex(I); geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2)); geo.setAttribute("aFade", new THREE.Float32BufferAttribute(F, 1));
    add(geo, new THREE.ShaderMaterial(Object.assign({}, PREM, { side: THREE.DoubleSide, uniforms: { uFoam: { value: foamT }, uRamp: { value: ramp }, uTime: { value: 0 } },
      vertexShader: "attribute float aFade; varying vec2 vUv; varying float vF; void main(){ vUv = uv; vF = aFade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform sampler2D uFoam, uRamp; uniform float uTime; varying vec2 vUv; varying float vF;
        void main(){ vec4 f1 = texture2D(uFoam, vec2(vUv.x, vUv.y - uTime * 0.25)), f2 = texture2D(uFoam, vec2(vUv.x * 1.7 + 0.3, vUv.y * 1.7 - uTime * 0.40));
          float cov = max(f1.a, f2.a * 0.8) * vF, a = smoothstep(0.42, 0.56, cov) * 0.9; if (a < 0.01) discard;
          gl_FragColor = vec4(texture2D(uRamp, vec2(0.72 + 0.2 * max(f1.r, f2.r), 0.06)).rgb, 1.0);
          #include <colorspace_fragment>
          gl_FragColor = vec4(gl_FragColor.rgb * a, a); }` })), 7); }
  // ---- painted particles: one instanced emitter per atlas, CPU-simulated, velocity-stretched, eroded as they age
  function emitter({ tex, grid, anchor = 0.5, stretch = 0, maxStretch = 1, add = 0, rowY = 4.5 / 8, max = 160, erode = 0.6, order = 10, radial = false }) {
    const g = new THREE.InstancedBufferGeometry(); g.instanceCount = 0; g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
    const A0 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4), A1 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4), A2 = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    [A0, A1, A2].forEach(a => a.setUsage(THREE.DynamicDrawUsage)); g.setAttribute("iP", A0); g.setAttribute("iV", A1); g.setAttribute("iD", A2);
    const mat = new THREE.ShaderMaterial(Object.assign({}, PREM, { side: THREE.DoubleSide, uniforms: { uAtlas: { value: tex }, uRamp: { value: ramp }, uGrid: { value: grid }, uRow: { value: rowY }, uStretch: { value: stretch }, uMaxS: { value: maxStretch }, uAnchor: { value: anchor }, uErode: { value: erode }, uRadial: { value: radial ? 1 : 0 } },
      vertexShader: `attribute vec4 iP, iV, iD; uniform float uStretch, uMaxS, uAnchor; varying vec2 vUv; varying float vK, vA, vAdd, vCell;
        void main(){ // iP: xyz position, w size (m); iV: xyz velocity, w age 0..1; iD: x cell, y rotation (sign = mirror), z alpha, w scale-y
          vec4 mv = modelViewMatrix * vec4(iP.xyz, 1.0); vec2 vs = (modelViewMatrix * vec4(iV.xyz, 0.0)).xy; float sp = length(vs);
          vec2 rd = vec2(sin(iD.y), -cos(iD.y)), dir = (uStretch > 0.0 && sp > 1e-3) ? vs / sp : rd;    // 'down' on the sprite follows its motion
          vec2 up = -dir, sd = vec2(-dir.y, dir.x);
          float sx = iP.w, sy = iP.w * iD.w, L = min(sy + sp * uStretch, sy * uMaxS);
          mv.xy += up * (position.y + uAnchor) * L + sd * position.x * sx * sign(iD.y + 1e-6);
          vUv = position.xy + 0.5; vK = iV.w; vA = iD.z; vCell = iD.x; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D uAtlas, uRamp; uniform float uGrid, uRow, uErode, uRadial; varying vec2 vUv; varying float vK, vA, vCell;
        void main(){ vec2 cell = vec2(mod(vCell, uGrid), uGrid - 1.0 - floor(vCell / uGrid));
          vec4 t = texture2D(uAtlas, (cell + clamp(vUv, 0.01, 0.99)) / uGrid);
          float thr = uErode * smoothstep(0.35, 1.0, vK), a = t.a * smoothstep(thr - 0.06, thr + 0.06, t.g + 0.02) * vA;
          a *= mix(1.0, 1.0 - smoothstep(0.32, 0.5, length(vUv - 0.5)), uRadial);                                            // soft cards never show their square   // thin parts die first
          if (a < 0.004) discard;
          gl_FragColor = vec4(texture2D(uRamp, vec2(clamp(0.25 + 0.75 * t.r, 0.0, 0.999), uRow)).rgb, 1.0);
          #include <colorspace_fragment>
          gl_FragColor = vec4(gl_FragColor.rgb * a, a); }` }));
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = order; scene.add(m);
    const P = [];
    return { P, spawn(q) { if (P.length < max) P.push(q); },
      update(dt) { for (let i = P.length - 1; i >= 0; i--) { const q = P[i]; q.age += dt; q.v.y -= (q.g ?? 9.81) * dt; if (q.drag) q.v.multiplyScalar(1 - q.drag * dt); q.p.addScaledVector(q.v, dt);
          if (q.age > q.life || (q.kill !== undefined && q.p.y < q.kill && q.v.y < 0)) P.splice(i, 1); }
        P.forEach((q, i) => { const k = q.age / q.life, grow = 1 - Math.pow(1 - Math.min(k / 0.25, 1), 2), s0 = q.s0 ?? [1, 1], s1 = q.s1 ?? [1, 1];
          const sx = q.size * (s0[0] + (s1[0] - s0[0]) * grow), sy = (s0[1] + (s1[1] - s0[1]) * grow) / (s0[0] + (s1[0] - s0[0]) * grow);
          const env = q.env === "soft" ? Math.sin(Math.PI * Math.min(k, 1)) : Math.min(1, q.age / 0.05) * (1 - Math.max(0, (k - 0.85) / 0.15));
          A0.setXYZW(i, q.p.x, q.p.y, q.p.z, sx); A1.setXYZW(i, q.v.x, q.v.y, q.v.z, k); A2.setXYZW(i, q.cell, q.rot, q.alpha * env, sy); });
        g.instanceCount = P.length; A0.needsUpdate = A1.needsUpdate = A2.needsUpdate = true; } }; }
  const drops = emitter({ tex: dropsT, grid: 4, anchor: 0.5, stretch: 0.04, maxStretch: 2.0, max: 260, order: 10 });
  const crowns = emitter({ tex: crownsT, grid: 2, anchor: 0.5, max: 24, erode: 0.95, order: 10, rowY: 2.5 / 8 });
  const mist = emitter({ tex: mistT, grid: 2, anchor: 0, max: 24, erode: 0.5, order: 12, rowY: 3.5 / 8, radial: true });
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, V = (x, y, z) => new THREE.Vector3(x, y, z);
  const rimPoint = (a, z) => WC.clone().addScaledVector(WEX, Math.cos(a) * WR).addScaledVector(WEY, Math.sin(a) * WR).addScaledVector(WN, z);
  const spinVel = (pt) => new THREE.Vector3().crossVectors(WN, pt.clone().sub(WC)).multiplyScalar(WS2);
  const acc = { land: 0, pad: 0, crown: 0, mist: 0 }, screenH = 2 * WC.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const burst = (at, n) => { for (let k = 0; k < n; k++) { const pt = at.clone().addScaledVector(WN, (rnd() - 0.5) * wheelSpin.T), out = pt.clone().sub(WC).sub(WN.clone().multiplyScalar(pt.clone().sub(WC).dot(WN))).normalize();
      drops.spawn({ p: pt, v: out.multiplyScalar(0.5 + rnd() * 0.9).add(spinVel(pt).multiplyScalar(1.2)).add(V((rnd() - 0.5) * 0.3, rnd() * 0.4, (rnd() - 0.5) * 0.3)), age: 0, life: 0.5 + rnd() * 1.0,
        size: screenH * (0.004 + rnd() * 0.008), cell: rnd() < 0.6 ? Math.floor(rnd() * 8) : 8 + Math.floor(rnd() * 4), rot: rnd() < 0.5 ? 1 : -1, alpha: 0.75, env: "soft", kill: wheelPoolY }); } };
  function step(dt, tt) {
    acc.land += dt / 0.22; acc.pad += dt / 0.16; acc.crown += dt / 0.3; acc.mist += 1.4 * dt;
    while (acc.land >= 1) { acc.land -= 1; burst(landPt, 10 + Math.floor(rnd() * 10)); }                       // where the pour hits the rim
    while (acc.pad >= 1) { acc.pad -= 1; burst(onWheel(LAND + 10 + rnd() * (CASC_END - LAND - 10), RC), 6 + Math.floor(rnd() * 8)); }   // off the paddle edges as they carry the sheet down
    while (acc.crown >= 1) { acc.crown -= 1;                                                      // churn where the cascade meets the race
      crowns.spawn({ p: foot.clone().addScaledVector(WN, (rnd() - 0.5) * wheelSpin.T), v: V(0, 0, 0), g: 0, age: 0, life: 0.55 + rnd() * 0.25, size: 0.22 + rnd() * 0.16, s0: [0.5, 0.3], s1: [1.1, 0.9],
        cell: Math.floor(rnd() * 4), rot: (rnd() < 0.5 ? 1 : -1) * (0.0001 + (rnd() - 0.5) * 0.4), alpha: 0.38 }); }
    while (acc.mist >= 1) { acc.mist -= 1;                                                        // a little white mist where it meets the race
      const at = foot.clone().addScaledVector(WN, (rnd() - 0.5) * wheelSpin.T * 1.5); at.y = wheelPoolY + 0.15;
      mist.spawn({ p: at, v: V(0.1 + rnd() * 0.08, 0.08 + rnd() * 0.08, 0), g: 0, age: 0, life: 4, size: 1.0 + rnd() * 0.7, s0: [0.5, 0.5], s1: [1.0, 1.0], cell: Math.floor(rnd() * 4), rot: (rnd() - 0.5) * 6, alpha: 0.1 + rnd() * 0.05, env: "soft" }); }
    drops.update(dt); crowns.update(dt); mist.update(dt);
  }
  for (let i = 0; i < 150; i++) step(1 / 30, 0);                                                  // prewarmed
  let last = null;
  return { update(tt) { renderer.getDrawingBufferSize(res); const dt = last === null ? 0 : Math.min(0.05, Math.max(0, tt - last)); last = tt; step(dt, tt);
      for (const m of meshes) if (m.material.uniforms.uTime) m.material.uniforms.uTime.value = tt;
      cascade.material.uniforms.uSpin.value = wheelSpin.mesh.rotation.z;                          // the paddle steps travel down with the wheel
    } };
})();
let fallMat = null;
if (S.flow && params.has("oldvfx")) { fallMat = new THREE.ShaderMaterial({ transparent: true, depthTest: false, depthWrite: false, uniforms: { t: { value: 0 }, F: { value: new THREE.Vector4(...S.flow.fall) } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `uniform float t; uniform vec4 F; varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
      void main(){
        float sr = (F.y - vUv.y) / (F.y - F.w), s0 = clamp(sr, 0.0, 1.0);
        float xc = mix(F.x, F.z, pow(s0, 0.7)), hw = (15.0 + 40.0 * s0) / 1280.0, ac = (vUv.x - xc) / hw;
        // water leaves the lip slowly and speeds up as it drops; the sheet tears into strands on the way down
        float ph = pow(s0, 0.62) * 5.0 - t * 1.9;
        float aw = ac + 0.22 * (vnoise(vec2(ph * 0.6, ac * 1.5)) - 0.5);                               // strands wander a little as they fall
        float n1 = vnoise(vec2(aw * 2.4 + 1.0, ph * 0.55)), n2 = vnoise(vec2(aw * 5.5 + 4.0, ph * 1.0)), n3 = vnoise(vec2(aw * 10.0 + 9.0, ph * 1.7));
        float w = n1 * 0.5 + n2 * 0.32 + n3 * 0.18, prof = clamp(1.0 - ac * ac, 0.0, 1.0);
        float brk = mix(0.10, 0.40, s0);
        float a = smoothstep(brk - 0.07, brk + 0.12, w * (0.5 + 0.5 * prof)) * smoothstep(1.15, 0.85, abs(ac)) * smoothstep(-0.01, 0.03, sr) * (1.0 - smoothstep(0.97, 1.06, sr));
        // three flat tones, like the painted water: blue shade, pale body, white crests
        vec3 c = mix(vec3(0.11, 0.21, 0.44), vec3(0.36, 0.55, 0.83), smoothstep(0.33, 0.52, w));
        c = mix(c, vec3(0.93, 0.97, 1.0), smoothstep(0.50, 0.66, n2 * 0.55 + n3 * 0.45));
        c *= mix(1.06, 0.80, clamp(ac * 0.5 + 0.5, 0.0, 1.0));                                   // the side away from the sun is darker
        // where it lands: boiling white water and a drift of mist
        vec2 sd = (vUv - vec2(F.z, F.w)) * vec2(1280.0, 720.0);
        float boil = exp(-dot(sd / vec2(66.0, 13.0), sd / vec2(66.0, 13.0))) * (0.45 + 0.55 * vnoise(vec2(sd.x * 0.035 + t * 0.5, sd.y * 0.08 - t * 1.6))) * 0.85;
        float mist = exp(-dot(sd / vec2(105.0, 52.0), sd / vec2(105.0, 52.0))) * (0.35 + 0.65 * vnoise(vec2(sd.x * 0.022 + t * 0.25, sd.y * 0.03 - t * 0.9))) * 0.42;
        // droplets thrown off the sheet
        vec2 dg = vec2(ac * 5.0, ph * 5.0); vec2 dc = floor(dg); float dr = hash(dc);
        float drop = step(0.90, dr) * (1.0 - smoothstep(0.10, 0.22, length(fract(dg) - 0.5 - (vec2(hash(dc + 3.0), hash(dc + 7.0)) - 0.5) * 0.5))) * smoothstep(1.0, 1.25, abs(ac)) * (1.0 - smoothstep(1.7, 2.1, abs(ac))) * smoothstep(0.15, 0.4, s0) * step(sr, 1.0);
        vec3 col = c; float al = a * 0.96;
        col = mix(col, vec3(0.95, 0.98, 1.0), boil * (1.0 - al * 0.5)); al = max(al, boil);
        col = mix(vec3(0.82, 0.90, 1.0), col, al / max(al + mist * (1.0 - al), 1e-4)); al = al + mist * (1.0 - al);
        col = mix(col, vec3(0.95, 0.98, 1.0), drop * (1.0 - al)); al = max(al, drop * 0.9);
        if (al < 0.01) discard;
        gl_FragColor = vec4(col, al);
        #include <colorspace_fragment>
      }` });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fallMat); m.frustumCulled = false; m.renderOrder = 8; scene.add(m); }
function animateFx() {
  if (fallMat) fallMat.uniforms.t.value = time;
  for (const q of props) q.material.uniforms.t.value = time;
  for (const b of banners) b.material.uniforms.t.value = time;
  if (wheelSpin) wheelSpin.mesh.rotation.z = time * wheelSpin.speed;
  if (waterVfx) waterVfx.update(time);
  if (wheelFx) wheelFx.update(Math.min(0.05, Math.max(0, time - (wheelFx.last ?? time)))), wheelFx.last = time;
  bgMat.uniforms.t.value = time; shaftMat.uniforms.t.value = time;
  for (const b of birds) { const u = b.userData, f = u.f, span = 300, x = ((time * f.sp + f.off + u.dx + span * 10) % span) - span / 2;
    const bob = Math.sin(time * 0.31 + u.ph) * 0.5 + Math.sin(time * 0.13 + f.off) * 1.2;
    b.position.set(f.dir * x, f.y + u.dy + bob, f.z); b.scale.setScalar(u.sc); b.rotation.z = 0.12 * Math.sin(time * 0.4 + u.ph);
    // beat for a while, then hold the wings out and glide
    const gl = Math.sin(time * 0.37 + u.ph * 3.0) + Math.sin(time * 0.23 + u.ph), glide = Math.min(1, Math.max(0, (gl - 0.7) / 0.5)), g2 = glide * glide * (3 - 2 * glide), a = time * u.w + u.ph;
    b.material.uniforms.flap.value = Math.sin(a) * (1 - g2) + 0.22 * g2; b.material.uniforms.lag.value = Math.sin(a - 1.1) * (1 - g2) - 0.15 * g2; }
}
const heroMats = []; hero.traverse(o => { if (o.isMesh) { o.layers.enable(1); heroMats.push(o.material); } });
scene.traverse(o => { if (o.isLight) o.layers.enable(1); });
const heroRT = LOOK >= 2 ? new THREE.WebGLRenderTarget(plateTex.image.width, plateTex.image.height, { type: THREE.HalfFloatType, samples: 4 }) : null;
const heroQuad = LOOK >= 2 ? new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ transparent: true, depthTest: false, depthWrite: false,
  uniforms: { map: { value: heroRT.texture }, ink: { value: 1.5 }, px: { value: new THREE.Vector2(1 / heroRT.width, 1 / heroRT.height) } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
  fragmentShader: `uniform sampler2D map; uniform vec2 px; uniform float ink; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main(){ vec4 c = 0.7 * texture2D(map, vUv) + 0.075 * (texture2D(map, vUv + vec2(px.x, 0.0) * 0.5) + texture2D(map, vUv - vec2(px.x, 0.0) * 0.5) + texture2D(map, vUv + vec2(0.0, px.y) * 0.5) + texture2D(map, vUv - vec2(0.0, px.y) * 0.5));
      // ink only around his outer silhouette: wherever he is not, but is within a line's width
      float ring = 0.0;
      for (int k = 0; k < 12; k++) { float a = float(k) * 0.5236; vec2 d = vec2(cos(a), sin(a)) * px * ink;
        ring = max(ring, max(texture2D(map, vUv + d).a, texture2D(map, vUv + d * 0.5).a)); }
      float al = max(c.a, ring); if (al < 0.004) discard;
      vec3 col = c.a > 0.004 ? c.rgb / c.a : vec3(0.0);
      col *= 1.0 + 0.05 * (hash(floor(vUv / px)) - 0.5);                                     // a little of the painting's grain
      col = mix(vec3(0.026, 0.009, 0.006), col, c.a / al);                                   // dark brown ink
      gl_FragColor = vec4(col, al);
      #include <colorspace_fragment>
    }` })) : null;
const heroScene = new THREE.Scene(); if (heroQuad) heroScene.add(heroQuad);
function render() { animateFx(); 
  if (heroRT) {   // Sol alone, at the painting's resolution, hidden wherever the painting is in front of him
    renderer.setRenderTarget(heroRT); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(bgScene, bgCam); renderer.clearColor();
    camera.layers.set(1); const sh = renderer.shadowMap.autoUpdate; renderer.render(scene, camera); camera.layers.set(0); renderer.setRenderTarget(null); }
  renderer.clear(); renderer.render(bgScene, bgCam);
  if (heroRT) { heroQuad.material.uniforms.ink.value = Math.max(0.25, INK * heroRT.width / K.width * K.fx / Math.max(1, -P.z)); renderer.render(heroScene, bgCam); for (const m of heroMats) m.colorWrite = false; }
  renderer.render(scene, camera);
  if (heroRT) for (const m of heroMats) m.colorWrite = true;
  renderer.render(fxScene, bgCam); }

// ---------------- start ----------------
let last = performance.now();
document.getElementById("go").textContent = "Click to begin";
function begin() {
  document.getElementById("title").classList.add("hidden");
  document.getElementById("fade").classList.add("clear");
  setTimeout(() => ui.place.classList.add("show"), 600); setTimeout(() => ui.place.classList.remove("show"), 3600);
}
document.getElementById("title").addEventListener("click", begin);
addEventListener("keydown", (e) => { if (!document.getElementById("title").classList.contains("hidden")) begin(); }, { once: true });
ui.place.querySelector(".s").textContent = S.name.toUpperCase();
if (CAPTURE) { document.getElementById("title").classList.add("hidden"); document.getElementById("fade").classList.add("clear"); }
else if (FROM) begin();
if (!CAPTURE) renderer.setAnimationLoop(() => { const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now; step(dt); render(); });
window.eb = { P, input, step: (n = 1) => { for (let i = 0; i < n; i++) step(1 / 30); render(); }, camera, floorAt, walkable, hero, canvas: renderer.domElement, lightU, shaftMat, banners, props, info: { WALK, RUN, WALK_NAT, WALK_RATE, walkClipDur: walkClip.duration, calm, idleDur: clip("idle").duration, walkDur: clip("walk").duration, runDur: clip("run").duration } };
window.ready = true;
