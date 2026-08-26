/* ============================================================================
 * ELDERWOOD — game.js
 * A 3D first-person melee-combat game set in an endless procedural forest.
 * Built with Three.js. Desktop (mouse + keyboard).
 *
 * Systems:
 *   • Infinite chunked terrain (value-noise fBm) — mountains, hills, plains,
 *     valleys, lakes. Height-based biome colouring + slope rock/snow.
 *   • Instanced scatter: trees, rocks, grass, flowers per chunk.
 *   • Water planes for lakes; animated fish near shorelines.
 *   • First-person controller: WASD, sprint, jump, gravity, terrain collision.
 *   • Weapons: dagger / sword / spear with viewmodel swing + arc hit detection.
 *   • Enemies: deer (passive), wolves (pack hunters), a LEGENDARY BEAR (Lv100)
 *     that visibly SHRINKS as it loses health.
 *   • Loot with rarity tiers; villages (houses) as points of interest.
 *   • Top-left circular minimap, full AAA-style HUD, boss bar, menus.
 * ========================================================================== */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ----------------------------------------------------------------------------
 * 0. Utilities
 * -------------------------------------------------------------------------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp  = (a, b, t) => a + (b - a) * t;
const rand  = (a = 1, b = 0) => b + Math.random() * (a - b);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const smooth = t => t * t * (3 - 2 * t);
const TAU = Math.PI * 2;
const $ = id => document.getElementById(id);   // DOM helper (used across modules)

// deterministic hash → [0,1)
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
// seeded RNG (mulberry32)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2D value noise with smooth interpolation
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm(x, y, oct = 5, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * freq, y * freq);
    norm += amp; amp *= gain; freq *= lac;
  }
  return sum / norm;
}
function ridged(x, y, oct = 4) {
  let amp = 0.5, freq = 1, sum = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoise(x * freq, y * freq) * 2 - 1);
    sum += amp * n * n; amp *= 0.5; freq *= 2.0;
  }
  return sum;
}

// merge two non-indexed-or-indexed BufferGeometries (positions/normals/uv) into one
function mergeGeos(a, b) {
  const ga = a.toNonIndexed(), gb = b.toNonIndexed();
  const out = new THREE.BufferGeometry();
  for (const key of ['position', 'normal', 'uv']) {
    const aa = ga.attributes[key], bb = gb.attributes[key];
    if (!aa || !bb) continue;
    const merged = new Float32Array(aa.array.length + bb.array.length);
    merged.set(aa.array, 0); merged.set(bb.array, aa.array.length);
    out.setAttribute(key, new THREE.BufferAttribute(merged, aa.itemSize));
  }
  return out;
}

// procedural grass-tuft alpha texture (blades on transparent bg)
function makeGrassTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  for (let i = 0; i < 14; i++) {
    const x = 6 + Math.random() * 52;
    const w = 2 + Math.random() * 2;
    const h = 30 + Math.random() * 30;
    const hue = 95 + Math.random() * 30;
    g.strokeStyle = `hsl(${hue},55%,${28 + Math.random()*18}%)`;
    g.lineWidth = w; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, 64);
    g.quadraticCurveTo(x + (Math.random()*10-5), 40, x + (Math.random()*16-8), 64 - h);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ----------------------------------------------------------------------------
 * 1. World / terrain definition
 * -------------------------------------------------------------------------- */
const CHUNK = 64;          // world units per chunk edge
const SEG   = 24;          // grid segments per chunk (24×24 quads)
const WATER = 4.2;         // water surface height
let   VIEW  = 5;           // chunk radius rendered (from settings)

// Master height function — must match the terrain mesh exactly (used for collision).
function terrainHeight(x, z) {
  // continent / mountain mass
  let e = fbm(x * 0.0016 + 42, z * 0.0016 - 17, 5, 2.1, 0.5); // 0..1
  e = Math.pow(e, 1.6);
  let h = e * 74;
  // ridged peaks concentrate where e is high
  h += ridged(x * 0.0042, z * 0.0042, 4) * e * 52;
  // rolling hills
  h += fbm(x * 0.02 + 130, z * 0.02 - 90, 3, 2, 0.5) * 6.5;
  // gentle plains detail
  h += fbm(x * 0.06, z * 0.06, 2) * 1.6;
  // carve river valleys: a winding low band
  const river = Math.abs(fbm(x * 0.0012 - 300, z * 0.0012 + 220, 3) - 0.5);
  const carve = smooth(clamp(1 - river * 9, 0, 1)) * 9;
  h -= carve;
  // desert dunes
  const dez = desertFactor(x, z);
  if (dez > 0) h += dez * (fbm(x * 0.02 + 900, z * 0.02 - 60, 2) - 0.4) * 9;
  return h;
}
// desert region mask 0..1 (large-scale patch on the map)
function desertFactor(x, z) {
  const n = fbm(x * 0.00085 - 800, z * 0.00085 + 640, 3);
  return smooth(clamp((n - 0.57) * 4.5, 0, 1));
}
// approximate slope 0..1 by sampling neighbours
function terrainSlope(x, z) {
  const d = 2.0;
  const hx = terrainHeight(x + d, z) - terrainHeight(x - d, z);
  const hz = terrainHeight(x, z + d) - terrainHeight(x, z - d);
  return Math.min(1, Math.hypot(hx, hz) / (2 * d) * 1.4);
}

// biome vertex colour
const _c = new THREE.Color();
const _sand = new THREE.Color();
function biomeColor(h, slope, dez, out) {
  if (h < WATER + 0.6) {           // sand / shore
    out.setRGB(0.72, 0.66, 0.44);
  } else if (h > 46) {             // snow peaks
    const t = clamp((h - 46) / 18, 0, 1);
    out.setRGB(lerp(0.55,0.95,t), lerp(0.58,0.97,t), lerp(0.55,1.0,t));
  } else if (h > 34 || slope > 0.62) { // rock
    out.setRGB(0.36, 0.34, 0.31);
  } else {                          // grass, darker in valleys
    const shade = 0.75 + fbm(h * 0.3, slope * 5, 2) * 0.25;
    out.setRGB(0.20 * shade, 0.42 * shade, 0.17 * shade);
  }
  // rocky patches on steep grass
  if (slope > 0.5 && h < 34) out.lerp(_c.setRGB(0.34,0.32,0.29), (slope - 0.5) * 2);
  // desert → warm sand (keeps rock on steep cliffs)
  if (dez > 0 && h > WATER + 0.3 && slope < 0.6) {
    const g = 0.86 + fbm(h * 0.5, slope, 2) * 0.12;
    out.lerp(_sand.setRGB(0.82 * g, 0.71 * g, 0.44 * g), dez);
  }
  return out;
}

/* ----------------------------------------------------------------------------
 * 2. Renderer / scene / camera / lights / sky
 * -------------------------------------------------------------------------- */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;

const scene = new THREE.Scene();
const SKY_TOP = new THREE.Color(0x8ec3e8);
const SKY_HORIZON = new THREE.Color(0xcfe0dc);
const FOG = new THREE.Color(0xbcd0cf);
scene.background = SKY_TOP.clone();
scene.fog = new THREE.Fog(FOG, CHUNK * 2.2, CHUNK * (VIEW + 0.6));

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 3000);

// sky dome (gradient shader)
const skyGeo = new THREE.SphereGeometry(1600, 24, 12);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  vertexShader: `varying vec3 vp; void main(){ vp = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
  uniforms: {
    top: { value: SKY_TOP }, bottom: { value: SKY_HORIZON },
    sun: { value: new THREE.Vector3(0.5, 0.7, 0.2).normalize() },
    night: { value: 0 },   // 0 = day, 1 = night (shows the moon)
  },
  fragmentShader: `
    varying vec3 vp; uniform vec3 top; uniform vec3 bottom; uniform vec3 sun; uniform float night;
    void main(){
      float t = clamp(vp.y*1.1+0.15, 0.0, 1.0);
      vec3 col = mix(bottom, top, pow(t,0.7));
      float s = max(dot(normalize(vp), normalize(sun)),0.0);
      col += vec3(1.0,0.9,0.7) * pow(s, 90.0) * 0.9 * (1.0-night);   // sun disc
      col += vec3(1.0,0.85,0.6) * pow(s, 6.0) * 0.12 * (1.0-night);  // glow
      float m = max(dot(normalize(vp), normalize(-sun)),0.0);
      col += vec3(0.85,0.9,1.0) * pow(m, 200.0) * night * 1.2;       // moon disc
      col += vec3(0.5,0.6,0.9) * pow(m, 8.0) * night * 0.08;         // moon glow
      gl_FragColor = vec4(col,1.0);
    }`
});
scene.add(new THREE.Mesh(skyGeo, skyMat));

// starfield (visible at night)
const starGeo = new THREE.BufferGeometry();
{
  const N = 900, arr = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const u = Math.random(), v = Math.random();
    const th = u * TAU, ph = Math.acos(2*v - 1);
    const R = 1500;
    arr[i*3] = R*Math.sin(ph)*Math.cos(th);
    arr[i*3+1] = Math.abs(R*Math.cos(ph)) * 0.9 + 40;   // upper hemisphere
    arr[i*3+2] = R*Math.sin(ph)*Math.sin(th);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
}
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 4, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false }));
stars.frustumCulled = false;
scene.add(stars);

// lights
const SUN_MAX = 2.1;
const sun = new THREE.DirectionalLight(0xfff2d6, SUN_MAX);
sun.position.set(90, 140, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 420;
const SH = 150;
sun.shadow.camera.left = -SH; sun.shadow.camera.right = SH;
sun.shadow.camera.top = SH; sun.shadow.camera.bottom = -SH;
sun.shadow.bias = -0.0004;
scene.add(sun); scene.add(sun.target);
const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x415e2e, 0.85);
const amb = new THREE.AmbientLight(0x556655, 0.25);
scene.add(hemi); scene.add(amb);

// post fx (subtle bloom)
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.7, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* ----------------------------------------------------------------------------
 * 3. Shared geometries / materials for scatter (built once, instanced)
 * -------------------------------------------------------------------------- */
const MAT = {
  trunk:   new THREE.MeshLambertMaterial({ color: 0x5a3d24 }),
  pine:    new THREE.MeshLambertMaterial({ color: 0x2f6b34 }),
  pineHi:  new THREE.MeshLambertMaterial({ color: 0x3f8a44 }),
  rock:    new THREE.MeshLambertMaterial({ color: 0x6b6a63 }),
  grass:   new THREE.MeshLambertMaterial({ map: makeGrassTexture(), color: 0x8fbf6a, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide }),
  wood:    new THREE.MeshLambertMaterial({ color: 0x6b4a2c }),
  roof:    new THREE.MeshLambertMaterial({ color: 0x8a4a2f }),
  fur:     new THREE.MeshLambertMaterial({ color: 0x4a3626 }),
  deer:    new THREE.MeshLambertMaterial({ color: 0xa9744f }),
  wolf:    new THREE.MeshLambertMaterial({ color: 0x6e6e74 }),
  fish:    new THREE.MeshLambertMaterial({ color: 0x9fb6c9 }),
  petal:   new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  cactus:  new THREE.MeshLambertMaterial({ color: 0x3f7d43 }),
  drock:   new THREE.MeshLambertMaterial({ color: 0xb08a55 }),   // desert rock
  horse:   new THREE.MeshLambertMaterial({ color: 0x6a4526 }),
  boar:    new THREE.MeshLambertMaterial({ color: 0x53463b }),
  rabbit:  new THREE.MeshLambertMaterial({ color: 0xc9beb0 }),
  camel:   new THREE.MeshLambertMaterial({ color: 0xc79a5b }),
  scorp:   new THREE.MeshLambertMaterial({ color: 0x3a2418 }),
  snake:   new THREE.MeshLambertMaterial({ color: 0x5c7a3a }),
  chicken: new THREE.MeshLambertMaterial({ color: 0xf2ede2 }),
  cat:     new THREE.MeshLambertMaterial({ color: 0x9a7350 }),
  dog:     new THREE.MeshLambertMaterial({ color: 0x8a6a44 }),
  palm:    new THREE.MeshLambertMaterial({ color: 0x7a5a2c }),
  frond:   new THREE.MeshLambertMaterial({ color: 0x3f8a44, side: THREE.DoubleSide }),
  bush:    new THREE.MeshLambertMaterial({ color: 0x4a7a35 }),
  npc:     new THREE.MeshLambertMaterial({ color: 0x8a7a6a }),
  bird:    new THREE.MeshLambertMaterial({ color: 0x33302e, side: THREE.DoubleSide }),
};

const GEO = {
  trunk:  new THREE.CylinderGeometry(0.28, 0.42, 5, 6),
  pine1:  new THREE.ConeGeometry(2.4, 4.5, 7),
  pine2:  new THREE.ConeGeometry(1.8, 3.6, 7),
  pine3:  new THREE.ConeGeometry(1.1, 2.6, 7),
  rock:   new THREE.DodecahedronGeometry(1, 0),
  grass:  (() => {
    // a crossed-plane (X) grass tuft so it reads from any angle
    const a = new THREE.PlaneGeometry(0.95, 0.8); a.translate(0, 0.4, 0);
    const b = new THREE.PlaneGeometry(0.95, 0.8); b.rotateY(Math.PI/2); b.translate(0, 0.4, 0);
    return mergeGeos(a, b);
  })(),
  flower: new THREE.CircleGeometry(0.22, 5),
  cactus: (() => {
    // saguaro: a tall body + two arms, merged into one geometry
    const body = new THREE.CylinderGeometry(0.4, 0.5, 3.2, 7); body.translate(0, 1.6, 0);
    const armL = new THREE.CylinderGeometry(0.22, 0.24, 1.3, 6); armL.rotateZ(0.5); armL.translate(-0.55, 1.9, 0);
    const armLu = new THREE.CylinderGeometry(0.22, 0.22, 0.9, 6); armLu.translate(-0.85, 2.6, 0);
    const armR = new THREE.CylinderGeometry(0.22, 0.24, 1.1, 6); armR.rotateZ(-0.5); armR.translate(0.5, 2.1, 0);
    return mergeGeos(mergeGeos(mergeGeos(body, armL), armLu), armR);
  })(),
  drock:  new THREE.DodecahedronGeometry(1, 0),
};
GEO.trunk.translate(0, 2.5, 0);
GEO.pine1.translate(0, 5.4, 0);
GEO.pine2.translate(0, 7.2, 0);
GEO.pine3.translate(0, 8.7, 0);

/* wind: shared uniforms + a vertex-sway shader hook (grass strong, foliage subtle) */
const timeUniform = { value: 0 };
const windUniform = { value: new THREE.Vector2(0.3, 0.0) }; // world-space wind vector
function applyWind(mat, amount) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = timeUniform;
    sh.uniforms.uWind = windUniform;
    sh.vertexShader = 'uniform float uTime;\nuniform vec2 uWind;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 iw = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 iw = vec3(0.0);
      #endif
      float ph = iw.x * 0.25 + iw.z * 0.25;
      float bend = max(position.y, 0.0) * ${amount.toFixed(3)};
      transformed.x += sin(uTime * 1.7 + ph) * uWind.x * bend;
      transformed.z += cos(uTime * 1.4 + ph) * uWind.y * bend;
    `);
  };
  mat.needsUpdate = true;
}
applyWind(MAT.grass, 0.55);
applyWind(MAT.pine, 0.012);
applyWind(MAT.pineHi, 0.012);

/* ----------------------------------------------------------------------------
 * 4. Chunk manager — terrain + scatter
 * -------------------------------------------------------------------------- */
const chunkGroup = new THREE.Group();
scene.add(chunkGroup);
const chunks = new Map();       // key "cx,cz" -> chunk object
const villages = [];            // {x,z} village centers for minimap

function chunkKey(cx, cz) { return cx + ',' + cz; }

function buildTerrainMesh(cx, cz) {
  const geo = new THREE.PlaneGeometry(CHUNK, CHUNK, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const ox = cx * CHUNK, oz = cz * CHUNK;
  for (let i = 0; i < pos.count; i++) {
    const wx = ox + pos.getX(i);
    const wz = oz + pos.getZ(i);
    const h = terrainHeight(wx, wz);
    pos.setY(i, h);
    biomeColor(h, terrainSlope(wx, wz), desertFactor(wx, wz), _c);
    colors[i*3] = _c.r; colors[i*3+1] = _c.g; colors[i*3+2] = _c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(ox, 0, oz);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

// place instanced scatter for one chunk, deterministically
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

// forest density type from a low-frequency map: 0 = dense, 1 = medium, 2 = sparse
function forestType(cx, cz) {
  const n = fbm(cx * 0.16 + 500, cz * 0.16 - 500, 2);
  return n < 0.42 ? 0 : n < 0.68 ? 1 : 2;
}

function buildScatter(cx, cz, group) {
  const r = rng((cx * 73856093) ^ (cz * 19349663) ^ 0x9e37);
  const ox = cx * CHUNK, oz = cz * CHUNK;
  const colliders = group.userData.colliders = [];   // {x,z,r} for physics

  // decide biome density from average height + forest type
  const midH = terrainHeight(ox + CHUNK/2, oz + CHUNK/2);
  const ft = forestType(cx, cz);
  const dez = desertFactor(ox + CHUNK/2, oz + CHUNK/2);
  const isDesert = dez > 0.5;
  group.userData.forestType = ft;
  group.userData.isDesert = isDesert;

  // ---- village? rare, on flattish low-mid land (not in deep desert) ----
  if (!isDesert && hash2(cx + 999, cz - 999) > 0.93 && midH > WATER + 3 && midH < 26) {
    buildVillage(ox + CHUNK/2, oz + CHUNK/2, group, colliders);
    villages.push({ x: ox + CHUNK/2, z: oz + CHUNK/2 });
  }

  // ---- trees (density by forest type; none in desert) ----
  //   0 dense ≈ 46, 1 medium ≈ 20, 2 sparse ≈ 2 (≈4 trees / 100m×100m)
  let treeN = isDesert ? 0 : (ft === 0 ? 46 : ft === 1 ? 20 : 2);
  if (midH > 40) treeN = Math.min(treeN, 4); else if (midH < WATER + 1) treeN = 0;
  const trunkM = new THREE.InstancedMesh(GEO.trunk, MAT.trunk, treeN);
  const p1 = new THREE.InstancedMesh(GEO.pine1, MAT.pine, treeN);
  const p2 = new THREE.InstancedMesh(GEO.pine2, MAT.pineHi, treeN);
  const p3 = new THREE.InstancedMesh(GEO.pine3, MAT.pine, treeN);
  [trunkM,p1,p2,p3].forEach(m => { m.castShadow = true; m.receiveShadow = true; });
  let tc = 0;
  for (let i = 0; i < treeN; i++) {
    const lx = r() * CHUNK, lz = r() * CHUNK;
    const wx = ox + lx, wz = oz + lz;
    const h = terrainHeight(wx, wz);
    if (h < WATER + 1 || h > 44 || terrainSlope(wx, wz) > 0.55) continue;
    const sc = 0.7 + r() * 0.8;
    _q.setFromAxisAngle(_v.set(0,1,0), r() * TAU);
    _s.set(sc, sc * (0.9 + r()*0.3), sc);
    _m.compose(_v.set(wx, h, wz), _q, _s);
    trunkM.setMatrixAt(tc, _m); p1.setMatrixAt(tc, _m); p2.setMatrixAt(tc, _m); p3.setMatrixAt(tc, _m);
    colliders.push({ x: wx, z: wz, r: 0.45 * sc });   // trunk collision
    tc++;
  }
  [trunkM,p1,p2,p3].forEach(m => { m.count = tc; m.instanceMatrix.needsUpdate = true; if (tc) group.add(m); });

  // ---- rocks ----
  const rockN = 8;
  const rockM = new THREE.InstancedMesh(GEO.rock, MAT.rock, rockN);
  rockM.castShadow = true; rockM.receiveShadow = true;
  let rc = 0;
  for (let i = 0; i < rockN; i++) {
    const wx = ox + r() * CHUNK, wz = oz + r() * CHUNK;
    const h = terrainHeight(wx, wz);
    if (h < WATER) continue;
    const sc = 0.4 + r() * 1.8;
    _q.setFromEuler(new THREE.Euler(r()*TAU, r()*TAU, r()*TAU));
    _m.compose(_v.set(wx, h + sc*0.3, wz), _q, _s.set(sc, sc*0.8, sc));
    rockM.setMatrixAt(rc++, _m);
    if (sc > 0.8) colliders.push({ x: wx, z: wz, r: sc * 0.7 });   // big rocks block
  }
  rockM.count = rc; rockM.instanceMatrix.needsUpdate = true; if (rc) group.add(rockM);

  // ---- desert scatter: cacti + sandstone boulders (replaces grass/trees) ----
  if (isDesert) {
    // isolated oasis lake with palms — appears on some desert chunks
    if (hash2(cx - 333, cz + 333) > 0.78 && terrainSlope(ox + CHUNK/2, oz + CHUNK/2) < 0.25) {
      buildOasis(ox + CHUNK/2, oz + CHUNK/2, group, colliders);
    }
    const cN = ft === 2 ? 3 : 6;
    const cactM = new THREE.InstancedMesh(GEO.cactus, MAT.cactus, cN);
    cactM.castShadow = cactM.receiveShadow = true;
    let cc = 0;
    for (let i = 0; i < cN; i++) {
      const wx = ox + r() * CHUNK, wz = oz + r() * CHUNK;
      const h = terrainHeight(wx, wz);
      if (h < WATER + 0.6 || terrainSlope(wx, wz) > 0.4) continue;
      const sc = 0.8 + r() * 1.0;
      _q.setFromAxisAngle(_v.set(0,1,0), r() * TAU);
      _m.compose(_v.set(wx, h, wz), _q, _s.set(sc, sc, sc));
      cactM.setMatrixAt(cc++, _m);
      colliders.push({ x: wx, z: wz, r: 0.5 * sc });
    }
    cactM.count = cc; cactM.instanceMatrix.needsUpdate = true; if (cc) group.add(cactM);
    // sandstone boulders
    const dN = 5;
    const drM = new THREE.InstancedMesh(GEO.drock, MAT.drock, dN);
    drM.castShadow = drM.receiveShadow = true;
    let dc = 0;
    for (let i = 0; i < dN; i++) {
      const wx = ox + r() * CHUNK, wz = oz + r() * CHUNK;
      const h = terrainHeight(wx, wz);
      if (h < WATER + 0.3) continue;
      const sc = 0.5 + r() * 1.6;
      _q.setFromEuler(new THREE.Euler(r()*TAU, r()*TAU, r()*TAU));
      _m.compose(_v.set(wx, h + sc*0.25, wz), _q, _s.set(sc, sc*0.7, sc));
      drM.setMatrixAt(dc++, _m);
      if (sc > 0.9) colliders.push({ x: wx, z: wz, r: sc * 0.7 });
    }
    drM.count = dc; drM.instanceMatrix.needsUpdate = true; if (dc) group.add(drM);
  }

  // ---- grass + flowers (skipped in desert; sparse forest = thickest grass) ----
  if (!isDesert && midH > WATER + 0.5 && midH < 36) {
    const grN = ft === 2 ? 340 : ft === 1 ? 300 : 240;
    const grassM = new THREE.InstancedMesh(GEO.grass, MAT.grass, grN);
    const flN = ft === 0 ? 30 : 55;
    const flM = new THREE.InstancedMesh(GEO.flower, MAT.petal, flN);
    let gc = 0, fc = 0;
    for (let i = 0; i < grN; i++) {
      const wx = ox + r() * CHUNK, wz = oz + r() * CHUNK;
      const h = terrainHeight(wx, wz);
      if (h < WATER + 0.4 || h > 34 || terrainSlope(wx, wz) > 0.5) continue;
      _q.setFromAxisAngle(_v.set(0,1,0), r() * TAU);
      const sc = 0.7 + r() * 0.9;
      _m.compose(_v.set(wx, h, wz), _q, _s.set(sc, sc, sc));
      grassM.setMatrixAt(gc++, _m);
      if (fc < flN && r() > 0.82) {
        flM.setColorAt(fc, _c.setHSL(r(), 0.75, 0.6));
        _m.compose(_v.set(wx, h + 0.35, wz), _q.setFromEuler(new THREE.Euler(-Math.PI/2,0,0)), _s.set(1,1,1));
        flM.setMatrixAt(fc++, _m);
      }
    }
    grassM.count = gc; grassM.instanceMatrix.needsUpdate = true; if (gc) group.add(grassM);
    flM.count = fc; flM.instanceMatrix.needsUpdate = true;
    if (flM.instanceColor) flM.instanceColor.needsUpdate = true;
    if (fc) group.add(flM);
  }

  // ---- water plane if chunk dips below water ----
  const cornersLow = [
    terrainHeight(ox, oz), terrainHeight(ox+CHUNK, oz),
    terrainHeight(ox, oz+CHUNK), terrainHeight(ox+CHUNK, oz+CHUNK),
    terrainHeight(ox+CHUNK/2, oz+CHUNK/2),
  ].some(h => h < WATER - 0.3);
  if (cornersLow) {
    const wGeo = new THREE.PlaneGeometry(CHUNK, CHUNK);
    wGeo.rotateX(-Math.PI/2);
    const wMat = new THREE.MeshStandardMaterial({
      color: 0x2b6b8a, transparent: true, opacity: 0.78,
      roughness: 0.15, metalness: 0.2,
    });
    const water = new THREE.Mesh(wGeo, wMat);
    water.position.set(ox + CHUNK/2, WATER, oz + CHUNK/2);
    water.userData.isWater = true;
    group.add(water);
    group.userData.hasWater = true;
    group.userData.waterCenter = { x: ox + CHUNK/2, z: oz + CHUNK/2 };
  }
}

// simple village = cluster of houses (+ a merchant marker post)
function buildVillage(cx, cz, group, colliders) {
  const r = rng((cx | 0) * 40503 ^ (cz | 0) * 1299721);
  const n = 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, dist = 6 + r() * 16;
    const x = cx + Math.cos(a) * dist, z = cz + Math.sin(a) * dist;
    const h = terrainHeight(x, z);
    if (h < WATER + 1) continue;
    const house = new THREE.Group();
    const w = 4 + r() * 2, d = 4 + r() * 2, wallH = 3;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), MAT.wood);
    body.position.y = wallH / 2; body.castShadow = body.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w,d) * 0.8, 2.4, 4), MAT.roof);
    roof.position.y = wallH + 1.2; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
    house.add(body, roof);
    house.position.set(x, h, z);
    house.rotation.y = r() * TAU;
    group.add(house);
    if (colliders) colliders.push({ x, z, r: Math.max(w, d) * 0.55 });   // houses are solid
  }
  // villagers who chat with each other in Arabic
  spawnVillageNPCs(cx, cz, group, group.userData.key);
  // a golden market stall at the village centre (visual merchant spot)
  const hc = terrainHeight(cx, cz);
  const stall = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 2.4),
    new THREE.MeshLambertMaterial({ color: 0xb5892f }));
  stall.position.set(cx, hc + 0.6, cz); stall.castShadow = true;
  const flag = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 4),
    new THREE.MeshLambertMaterial({ color: 0xe6c15a }));
  flag.position.set(cx, hc + 2.2, cz);
  group.add(stall, flag);
}

// a palm tree (trunk + radiating fronds)
function makePalm() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, 4.6, 7), MAT.palm);
  trunk.position.y = 2.3; trunk.rotation.z = rand(0.14, -0.14); trunk.castShadow = true;
  g.add(trunk);
  const frondGeo = new THREE.PlaneGeometry(2.6, 0.7); frondGeo.translate(1.2, 0, 0);
  for (let i = 0; i < 7; i++) {
    const f = new THREE.Mesh(frondGeo, MAT.frond);
    f.position.y = 4.5; f.rotation.y = (i / 7) * TAU; f.rotation.z = -0.5 + rand(0.18, -0.18);
    f.castShadow = true; g.add(f);
  }
  return g;
}

// an isolated desert lake (oasis) with palms + shrubs around it
function buildOasis(cx, cz, group, colliders) {
  const r = rng(((cx*15485863) ^ (cz*32452843)) >>> 0);
  const hc = terrainHeight(cx, cz);
  const rad = 8 + r() * 4;
  // water disc
  const pond = new THREE.Mesh(new THREE.CircleGeometry(rad, 24),
    new THREE.MeshStandardMaterial({ color: 0x2f7f9a, transparent: true, opacity: 0.82, roughness: 0.1, metalness: 0.2 }));
  pond.rotation.x = -Math.PI / 2; pond.position.set(cx, hc - 0.35, cz);
  group.add(pond);
  group.userData.oasis = { x: cx, z: cz, r: rad };
  // damp sand ring
  const ring = new THREE.Mesh(new THREE.RingGeometry(rad, rad + 2.5, 24),
    new THREE.MeshLambertMaterial({ color: 0x8a6a3a }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(cx, hc - 0.05, cz);
  group.add(ring);
  // palms + shrubs around the shoreline
  const nP = 5 + Math.floor(r() * 4);
  for (let i = 0; i < nP; i++) {
    const a = r() * TAU, d = rad + 1.5 + r() * 4;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    const h = terrainHeight(x, z);
    const palm = makePalm(); palm.position.set(x, h, z); palm.scale.setScalar(0.8 + r() * 0.5);
    group.add(palm);
    colliders.push({ x, z, r: 0.4 });
  }
  const nB = 6 + Math.floor(r() * 6);
  for (let i = 0; i < nB; i++) {
    const a = r() * TAU, d = rad + r() * 6;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    const h = terrainHeight(x, z);
    const bush = new THREE.Mesh(new THREE.SphereGeometry(0.5 + r() * 0.6, 6, 5), MAT.bush);
    bush.position.set(x, h + 0.3, z); bush.scale.y = 0.7; bush.castShadow = true;
    group.add(bush);
  }
}

function ensureChunk(cx, cz) {
  const key = chunkKey(cx, cz);
  if (chunks.has(key)) { chunks.get(key).keep = true; return; }
  const group = new THREE.Group();
  group.userData.key = key;
  group.add(buildTerrainMesh(cx, cz));
  buildScatter(cx, cz, group);
  group.keep = true;
  chunkGroup.add(group);
  chunks.set(key, group);
}

function updateChunks(px, pz) {
  const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
  chunks.forEach(c => (c.keep = false));
  for (let dz = -VIEW; dz <= VIEW; dz++)
    for (let dx = -VIEW; dx <= VIEW; dx++) {
      if (dx*dx + dz*dz > (VIEW+0.5)*(VIEW+0.5)) continue;
      ensureChunk(ccx + dx, ccz + dz);
    }
  // unload far chunks
  chunks.forEach((c, key) => {
    if (!c.keep) {
      chunkGroup.remove(c);
      c.traverse(o => { if (o.geometry && o.geometry !== GEO.grass) {} });
      // dispose per-chunk geometries (terrain/water) only
      c.children.forEach(o => {
        if (o.isMesh && (o.material.vertexColors || o.userData.isWater)) o.geometry.dispose();
      });
      if (villages.length) removeNpcsOfChunk(key);
      chunks.delete(key);
    }
  });
}

/* ----------------------------------------------------------------------------
 * 5. Player controller
 * -------------------------------------------------------------------------- */
const player = {
  pos: new THREE.Vector3(0, 20, 0),
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0,
  onGround: false,
  height: 1.7,
  hp: 100, hpMax: 100,
  stamina: 100, staMax: 100,
  gold: 0, kills: 0, xp: 0, level: 1, xpNext: 100,
  weapon: 0,
  owned: [true, false, false, false, false, false, false],   // fists owned; find/buy the rest
  alive: true,
  mounted: null,     // horse entity when riding
};
// start at a decent grass spot
player.pos.y = terrainHeight(0, 0) + player.height + 2;

const keys = {};
let MOUSE_SENS = 0.0016;
let locked = false;

addEventListener('keydown', e => {
  keys[e.code] = true;
  if (state === 'play') {
    if (e.code === 'Digit1') selectWeapon(0);
    if (e.code === 'Digit2') selectWeapon(1);
    if (e.code === 'Digit3') selectWeapon(2);
    if (e.code === 'Digit4') selectWeapon(3);
    if (e.code === 'Digit5') selectWeapon(4);
    if (e.code === 'Digit6') selectWeapon(5);
    if (e.code === 'Digit7') selectWeapon(6);
    if (e.code === 'KeyF') tryInteract();
    if (e.code === 'KeyR') toggleMount();
    if (e.code === 'KeyE') tryShop();
    if (e.code === 'KeyI' || e.code === 'Tab') { e.preventDefault(); openInventory(); }
    if (e.code === 'Escape') pauseGame();
  } else if (state === 'inv' && (e.code === 'KeyI' || e.code === 'Tab' || e.code === 'Escape')) {
    e.preventDefault(); closeInventory();
  } else if (state === 'shop' && e.code === 'Escape') {
    closeShop();
  }
});
addEventListener('keyup', e => { keys[e.code] = false; });

canvas.addEventListener('mousedown', e => {
  if (state !== 'play') return;
  if (!locked) { canvas.requestPointerLock(); return; }
  if (e.button === 0) attack();
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
});
document.addEventListener('mousemove', e => {
  if (!locked || state !== 'play') return;
  player.yaw   -= e.movementX * MOUSE_SENS;
  player.pitch -= e.movementY * MOUSE_SENS;
  player.pitch = clamp(player.pitch, -1.3, 1.3);
});

function updatePlayer(dt) {
  if (!player.alive) return;
  // camera basis from yaw
  const sinY = Math.sin(player.yaw), cosY = Math.cos(player.yaw);
  const fwd = _v.set(-sinY, 0, -cosY);
  const right = new THREE.Vector3(cosY, 0, -sinY);

  const mounted = player.mounted;
  const sprint = keys['ShiftLeft'] && (mounted || player.stamina > 1);
  const speed = mounted ? (sprint ? 24 : 15) : (sprint ? 11 : 6.2);   // horse is fast
  const wish = new THREE.Vector3();
  if (keys['KeyW']) wish.add(fwd);
  if (keys['KeyS']) wish.sub(fwd);
  if (keys['KeyD']) wish.add(right);
  if (keys['KeyA']) wish.sub(right);
  if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);

  // stamina
  if (sprint && wish.lengthSq() > 0) player.stamina = clamp(player.stamina - dt * 22, 0, player.staMax);
  else player.stamina = clamp(player.stamina + dt * 14, 0, player.staMax);

  // horizontal accel
  player.vel.x = lerp(player.vel.x, wish.x, 1 - Math.pow(0.0001, dt));
  player.vel.z = lerp(player.vel.z, wish.z, 1 - Math.pow(0.0001, dt));

  // gravity + jump
  player.vel.y -= 26 * dt;
  if (keys['Space'] && player.onGround) { player.vel.y = 9.2; player.onGround = false; }

  player.pos.addScaledVector(player.vel, dt);

  // obstacle physics — push out of trees, rocks, houses (circle collision in XZ)
  resolveObstacles();

  // terrain collision
  const ground = terrainHeight(player.pos.x, player.pos.z) + player.height;
  if (player.pos.y <= ground) {
    player.pos.y = ground; player.vel.y = 0; player.onGround = true;
  } else player.onGround = false;

  // ride: place the horse under the player, facing travel direction
  if (mounted && mounted.alive) {
    const gy = terrainHeight(player.pos.x, player.pos.z);
    mounted.mesh.position.set(player.pos.x, gy, player.pos.z);
    mounted.mesh.rotation.y = player.yaw;
    const spd = Math.hypot(player.vel.x, player.vel.z);
    walkAnim(mounted, spd, dt);
  } else if (mounted && !mounted.alive) {
    dismount();
  }

  // camera
  camera.position.copy(player.pos);
  const cp = Math.cos(player.pitch);
  camera.lookAt(
    player.pos.x + fwd.x * cp,
    player.pos.y + Math.sin(player.pitch),
    player.pos.z + fwd.z * cp
  );

  // sun / shadow follows player
  sun.position.set(player.pos.x + 90, 150, player.pos.z + 60);
  sun.target.position.set(player.pos.x, 0, player.pos.z);
}

// resolve player vs obstacle colliders from the current + neighbouring chunks
const PLAYER_R = 0.5;
function resolveObstacles() {
  const ccx = Math.floor(player.pos.x / CHUNK), ccz = Math.floor(player.pos.z / CHUNK);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const c = chunks.get(chunkKey(ccx + dx, ccz + dz));
      const cols = c && c.userData.colliders;
      if (!cols) continue;
      for (let i = 0; i < cols.length; i++) {
        const o = cols[i];
        let px = player.pos.x - o.x, pz = player.pos.z - o.z;
        const min = o.r + PLAYER_R;
        const d2 = px * px + pz * pz;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (min - d) / d;
          player.pos.x += px * push;
          player.pos.z += pz * push;
        }
      }
    }
}

// ---- horse riding ----
function toggleMount() {
  if (state !== 'play') return;
  if (player.mounted) { dismount(); return; }
  let best = null, bd = 5;
  for (const e of enemies) {
    if (!e.alive || !e.rideable) continue;
    const d = Math.hypot(e.mesh.position.x - player.pos.x, e.mesh.position.z - player.pos.z);
    if (d < bd) { bd = d; best = e; }
  }
  if (best) mount(best);
}
function mount(e) {
  player.mounted = e; e.state = 'ridden'; player.height = 2.7;
  toast('🐴 امتطيت الحصان — Shift للعدو السريع، R للنزول', '');
  sfx('loot');
}
function dismount() {
  const e = player.mounted; if (!e) return;
  player.mounted = null; e.state = 'idle'; e.wanderT = 1; player.height = 1.7;
  player.pos.x += Math.cos(player.yaw + 1.57) * 1.6;
  player.pos.z += Math.sin(player.yaw + 1.57) * 1.6;
  toast('نزلت عن الحصان', '');
}

/* ----------------------------------------------------------------------------
 * 6. Weapons + viewmodel + combat
 * -------------------------------------------------------------------------- */
const WEAPONS = [
  { id:'fists',  name: 'قبضة',  icon:'👊', dmg: 8,  range: 2.4, arc: 0.5,  cd: 0.4,  knock: 1,  canFish:false, price: 0 },
  { id:'dagger', name: 'خنجر',  icon:'🗡️', dmg: 16, range: 3.2, arc: 0.55, cd: 0.28, knock: 3,  canFish:false, price: 60 },
  { id:'sword',  name: 'سيف',   icon:'⚔️', dmg: 34, range: 4.2, arc: 0.62, cd: 0.5,  knock: 6,  canFish:false, price: 150 },
  { id:'spear',  name: 'رمح',   icon:'🔱', dmg: 46, range: 6.4, arc: 0.42, cd: 0.72, knock: 9,  canFish:true,  price: 110 },
  { id:'axe',    name: 'فأس',   icon:'🪓', dmg: 42, range: 3.9, arc: 0.6,  cd: 0.62, knock: 8,  canFish:false, price: 140 },
  { id:'mace',   name: 'مطرقة', icon:'🔨', dmg: 60, range: 3.5, arc: 0.55, cd: 0.9,  knock: 15, canFish:false, price: 210 },
  { id:'bow',    name: 'قوس',   icon:'🏹', dmg: 30, range: 70,  arc: 0.0,  cd: 0.6,  knock: 4,  canFish:false, price: 180, ranged:true },
];
let attackTimer = 0, swing = 0, fishing = 0;

// viewmodel — a weapon rig attached to the camera
const viewRig = new THREE.Group();
camera.add(viewRig);
scene.add(camera);
const weaponMesh = new THREE.Group();
viewRig.add(weaponMesh);

function buildWeaponModel(idx) {
  weaponMesh.clear();
  const steel = new THREE.MeshStandardMaterial({ color: 0xcfd6dd, metalness: 0.9, roughness: 0.25 });
  const grip  = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.8 });
  const gold  = new THREE.MeshStandardMaterial({ color: 0xe6c15a, metalness: 0.8, roughness: 0.3 });
  if (idx === 0) { // fists — a simple gloved hand
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x9c6b43, roughness: 0.9 }));
    hand.scale.set(1, 0.8, 1.2); hand.position.y = 0.1;
    weaponMesh.add(hand);
  } else if (idx === 1) { // dagger
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.5, 4), steel); blade.position.y = 0.45;
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.2, 8), grip);
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.04), gold); g.position.y = 0.12;
    weaponMesh.add(blade, h, g);
  } else if (idx === 2) { // sword
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.02), steel); blade.position.y = 0.75;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.18, 4), steel); tip.position.y = 1.28;
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.26, 8), grip);
    const g = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.04, 0.06), gold); g.position.y = 0.16;
    weaponMesh.add(blade, tip, h, g);
  } else if (idx === 3) { // spear
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.3, 8), grip); shaft.position.y = 0.45;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.36, 4), steel); head.position.y = 1.25;
    weaponMesh.add(shaft, head);
  } else if (idx === 4) { // axe
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8), grip); handle.position.y = 0.4;
    const headB = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.1), steel); headB.position.set(0, 0.82, 0);
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.26, 0.34, 3), steel);
    blade.rotation.z = Math.PI/2; blade.position.set(0.17, 0.82, 0);
    weaponMesh.add(handle, headB, blade);
  } else if (idx === 5) { // mace / hammer
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.9, 8), grip); handle.position.y = 0.4;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.24, 0.24),
      new THREE.MeshStandardMaterial({ color: 0x8b8b90, metalness: 0.8, roughness: 0.4 }));
    head.position.y = 0.9;
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.26), gold); band.position.y = 0.9;
    weaponMesh.add(handle, head, band);
  } else { // bow
    const b = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.03, 6, 12, Math.PI*1.3),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.7 }));
    b.rotation.z = Math.PI/2; b.position.set(0.1, 0.4, 0);
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.74, 4),
      new THREE.MeshBasicMaterial({ color: 0xdddddd }));
    string.position.set(0.1 - 0.28, 0.4, 0);
    weaponMesh.add(b, string);
  }
  weaponMesh.traverse(o => { if (o.isMesh) o.castShadow = false; });
  weaponMesh.scale.setScalar(0.7);       // keep viewmodel out of the way
  // resting pose (lower-right of view, angled forward)
  weaponMesh.position.set(0.5, -0.62, -0.8);
  weaponMesh.rotation.set(0.9, -0.4, 0.15);
}

function selectWeapon(i) {
  if (!player.owned[i]) { toast('🔒 لا تملك هذا السلاح — ابحث عنه أو اشترِه', ''); return; }
  player.weapon = i;
  buildWeaponModel(i);
  document.querySelectorAll('.wslot').forEach(el =>
    el.classList.toggle('active', +el.dataset.slot === i));
}
// keep the weapon wheel's lock state in sync with ownership
function refreshWeaponWheel() {
  document.querySelectorAll('.wslot').forEach(el => {
    const s = +el.dataset.slot;
    el.classList.toggle('locked', !player.owned[s]);
    el.classList.toggle('active', s === player.weapon);
  });
}
function unlockWeapon(i) {
  if (player.owned[i]) return false;
  player.owned[i] = true;
  refreshWeaponWheel();
  return true;
}

function attack() {
  if (attackTimer > 0 || !player.alive || fishing > 0) return;
  const w = WEAPONS[player.weapon];
  // fishing: spear (or any canFish tool) aimed near water
  if (w.canFish && isNearWater()) { startFishing(); return; }
  // ranged: fire an arrow along the camera direction
  if (w.ranged) { attackTimer = w.cd; swing = 1; shootArrow(w); sfx('swing'); return; }
  attackTimer = w.cd; swing = 1;
  // hit detection: forward arc
  const fwd = _v.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)).normalize();
  let hitAny = false;
  for (const e of enemies) {
    if (!e.alive) continue;
    const to = _s.set(e.mesh.position.x - player.pos.x, 0, e.mesh.position.z - player.pos.z);
    const d = to.length();
    if (d > w.range + e.radius) continue;
    to.normalize();
    if (fwd.dot(to) < 1 - w.arc) continue;
    damageEnemy(e, w.dmg, to, w.knock);
    hitAny = true;
  }
  if (hitAny) { flashCrosshair(); sfx('hit'); } else sfx('swing');
}

function updateWeaponAnim(dt) {
  attackTimer = Math.max(0, attackTimer - dt);
  swing = Math.max(0, swing - dt * 6);
  const bob = Math.sin(walkPhase) * 0.02;
  if (fishing > 0) {
    // spear thrust downward-forward while fishing
    const f = Math.sin((1 - fishing) * Math.PI);
    weaponMesh.rotation.x = 1.4 + f * 0.5;
    weaponMesh.rotation.z = 0.05;
    weaponMesh.position.set(0.28, -0.55 - f * 0.25, -0.7 - f * 0.35);
    return;
  }
  // swing arc + idle bob
  const swingRot = Math.sin(swing * Math.PI);
  weaponMesh.rotation.x = 0.9 - swingRot * 1.7;
  weaponMesh.rotation.z = 0.15 + swingRot * 0.4;
  weaponMesh.position.y = -0.62 + bob - swingRot * 0.12;
  weaponMesh.position.x = 0.5 - swingRot * 0.18;
}

/* ----------------------------------------------------------------------------
 * 6b. Projectiles (arrows from the bow)
 * -------------------------------------------------------------------------- */
const projectiles = [];
const _arrowGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.8, 5);
const _arrowMat = new THREE.MeshStandardMaterial({ color: 0x8a6b3a, metalness: 0.3, roughness: 0.6 });
const _up = new THREE.Vector3(0, 1, 0);
function shootArrow(w) {
  const cp = Math.cos(player.pitch);
  const dir = new THREE.Vector3(-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp).normalize();
  const m = new THREE.Mesh(_arrowGeo, _arrowMat);
  m.quaternion.setFromUnitVectors(_up, dir);
  m.position.copy(player.pos).addScaledVector(dir, 0.8);
  scene.add(m);
  projectiles.push({ mesh: m, dir, vel: dir.clone().multiplyScalar(62), dmg: w.dmg, knock: w.knock, life: 2.6 });
}
function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life -= dt;
    p.vel.y -= 12 * dt;                       // gravity drop
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.quaternion.setFromUnitVectors(_up, p.vel.clone().normalize());
    // enemy hit
    let hit = false;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.mesh.position.x - p.mesh.position.x;
      const dy = e.mesh.position.y + e.radius - p.mesh.position.y;
      const dz = e.mesh.position.z - p.mesh.position.z;
      if (dx*dx + dy*dy + dz*dz < (e.radius + 0.6) * (e.radius + 0.6)) {
        _s.set(dx, 0, dz).normalize();
        damageEnemy(e, p.dmg, _s, p.knock);
        flashCrosshair(); sfx('hit'); hit = true; break;
      }
    }
    // ground / lifetime
    if (hit || p.life <= 0 || p.mesh.position.y < terrainHeight(p.mesh.position.x, p.mesh.position.z)) {
      scene.remove(p.mesh); projectiles.splice(i, 1);
    }
  }
}

/* ----------------------------------------------------------------------------
 * 7. Enemies + AI (deer, wolves, legendary bear)
 * -------------------------------------------------------------------------- */
const enemies = [];
let bear = null;         // the boss reference
let bearSpawned = false;

function makeQuadruped(bodyMatShared, size) {
  const g = new THREE.Group();
  const bodyMat = bodyMatShared.clone();   // per-animal material so hit-flash is isolated
  g.userData.mat = bodyMat;
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(size*0.5, size*1.2, 4, 8), bodyMat);
  body.rotation.z = Math.PI/2; body.position.y = size*1.1;
  const head = new THREE.Mesh(new THREE.SphereGeometry(size*0.5, 8, 8), bodyMat);
  head.position.set(size*1.2, size*1.4, 0);
  const legGeo = new THREE.CylinderGeometry(size*0.14, size*0.12, size*1.1, 6);
  const legs = [];
  [[0.7,0.35],[0.7,-0.35],[-0.7,0.35],[-0.7,-0.35]].forEach(([lx,lz])=>{
    const leg = new THREE.Mesh(legGeo, bodyMat);
    leg.position.set(lx*size, size*0.55, lz*size);
    g.add(leg); legs.push(leg);
  });
  g.add(body, head);
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.legs = legs; g.userData.head = head;
  return g;
}

// a snake: a chain of segments that undulates as it moves
function makeSnake(mat, size) {
  const g = new THREE.Group();
  const m = mat.clone(); g.userData.mat = m;
  const segs = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(size * (0.5 - i * 0.03), 6, 6), m);
    s.position.set(-i * size * 0.7, size * 0.35, 0);
    s.castShadow = true;
    g.add(s); segs.push(s);
  }
  // head bump
  const head = new THREE.Mesh(new THREE.SphereGeometry(size * 0.55, 6, 6), m);
  head.position.set(size * 0.6, size * 0.35, 0); head.scale.set(1.2, 0.8, 1); head.castShadow = true;
  g.add(head);
  g.userData.segs = segs;
  return g;
}

function spawnEnemy(type, x, z) {
  const h = terrainHeight(x, z);
  let mesh, hp, dmg, speed, radius, aggro, xp, name;
  let flees = false, hostile = false, rideable = false;
  if (type === 'deer') {
    mesh = makeQuadruped(MAT.deer, 0.9);
    const ant = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.8, 4), MAT.trunk);
    ant.position.set(1.0, 2.0, 0.2); ant.rotation.z = -0.5; mesh.add(ant);
    hp = 40; dmg = 0; speed = 7; radius = 1.2; xp = 20; name='غزال'; flees = true;
  } else if (type === 'rabbit') {
    mesh = makeQuadruped(MAT.rabbit, 0.32);
    const ear = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.22, 3, 5), MAT.rabbit);
    ear.position.set(0.38, 0.62, 0.08); mesh.add(ear);
    const ear2 = ear.clone(); ear2.position.z = -0.08; mesh.add(ear2);
    hp = 14; dmg = 0; speed = 9; radius = 0.5; xp = 8; name='أرنب'; flees = true;
  } else if (type === 'wolf') {
    mesh = makeQuadruped(MAT.wolf, 0.7);
    hp = 70; dmg = 12; speed = 6.5; radius = 1.1; xp = 40; name='ذئب'; hostile = true;
  } else if (type === 'boar') {
    mesh = makeQuadruped(MAT.boar, 0.78);
    const tusk = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.22, 4), MAT.rabbit);
    tusk.position.set(1.15, 1.05, 0.16); tusk.rotation.z = 1.4; mesh.add(tusk);
    hp = 100; dmg = 16; speed = 6.2; radius = 1.2; xp = 55; name='خنزير بري'; hostile = true;
  } else if (type === 'horse') {
    mesh = makeQuadruped(MAT.horse, 1.15);
    const mane = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.5), MAT.trunk);
    mane.position.set(1.0, 2.0, 0); mesh.add(mane);
    hp = 220; dmg = 0; speed = 8; radius = 1.5; xp = 0; name='حصان'; rideable = true;
  } else if (type === 'camel') {
    mesh = makeQuadruped(MAT.camel, 1.25);
    const hump = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 8), MAT.camel);
    hump.position.set(0, 3.1, 0); hump.scale.y = 0.7; mesh.add(hump);
    hp = 260; dmg = 0; speed = 7.5; radius = 1.6; xp = 0; name='جمل'; rideable = true;
  } else if (type === 'chicken') {
    mesh = makeQuadruped(MAT.chicken, 0.28);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 4), MAT.drock);
    beak.position.set(0.42, 0.5, 0); beak.rotation.z = -1.57; mesh.add(beak);
    hp = 10; dmg = 0; speed = 5; radius = 0.45; xp = 6; name='دجاجة'; flees = true;
  } else if (type === 'cat') {
    mesh = makeQuadruped(MAT.cat, 0.4);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 4), MAT.cat);
    tail.position.set(-0.6, 0.7, 0); tail.rotation.z = 0.7; mesh.add(tail);
    hp = 22; dmg = 0; speed = 5.5; radius = 0.6; xp = 10; name='قط';   // calm
  } else if (type === 'dog') {
    mesh = makeQuadruped(MAT.dog, 0.55);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 4), MAT.dog);
    tail.position.set(-0.75, 1.0, 0); tail.rotation.z = 0.9; mesh.add(tail);
    hp = 40; dmg = 0; speed = 6.5; radius = 0.8; xp = 14; name='كلب';  // calm
  } else if (type === 'snake') {
    mesh = makeSnake(MAT.snake, 0.4);
    hp = 24; dmg = 10; speed = 4.5; radius = 0.6; xp = 18; name='أفعى'; hostile = true;
  } else if (type === 'scorpion') {
    mesh = makeQuadruped(MAT.scorp, 0.3);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.5, 4), MAT.scorp);
    tail.position.set(-0.5, 0.8, 0); tail.rotation.z = -1.0; mesh.add(tail);
    hp = 30; dmg = 12; speed = 4.8; radius = 0.6; xp = 20; name='عقرب'; hostile = true;
  } else { // bear boss
    mesh = makeQuadruped(MAT.fur, 1.8);
    hp = 2600; dmg = 34; speed = 4.6; radius = 2.6; xp = 1000; name='الدب الأسطوري'; hostile = true;
  }
  aggro = false;
  mesh.position.set(x, h, z);
  mesh.rotation.y = rand(TAU);
  scene.add(mesh);
  const e = {
    type, mesh, hp, hpMax: hp, dmg, speed, radius, aggro, xp, name,
    flees, hostile, rideable,
    alive: true, state: 'idle', vel: new THREE.Vector3(),
    wanderT: rand(3), wanderDir: rand(TAU), hitFlash: 0, attackCd: 0,
    baseScale: mesh.scale.x,
  };
  enemies.push(e);
  if (type === 'bear') { bear = e; e.aggro = true; showBossBar(); }
  return e;
}

function damageEnemy(e, dmg, dir, knock) {
  e.hp -= dmg;
  e.hitFlash = 0.12;
  e.aggro = true;
  if (e.type !== 'bear') e.state = e.hostile ? 'chase' : 'flee';
  if (e === player.mounted) dismount();
  // knockback
  e.mesh.position.addScaledVector(dir, knock * 0.25);
  // BEAR SHRINKS with damage
  if (e.type === 'bear') {
    const t = clamp(e.hp / e.hpMax, 0, 1);
    const sc = lerp(0.45, 1.0, t) * e.baseScale; // shrinks toward 45%
    e.mesh.scale.setScalar(sc);
    updateBossBar(t);
  }
  spawnHitParticles(e.mesh.position, e.mesh.position.y + e.radius);
  if (e.hp <= 0) killEnemy(e, dir);
}

function killEnemy(e, dir) {
  e.alive = false;
  player.kills++;
  gainXP(e.xp);
  toast(`قتلت ${e.name}`, e.type === 'bear' ? 'legendary' : '');
  // drop loot
  dropLoot(e.mesh.position, e.type === 'bear' ? 'boss' : e.type === 'wolf' ? 'good' : 'basic');
  if (e.type === 'bear') { hideBossBar(); objectiveText('انتصرت على الدب الأسطوري! انهب الكنز.'); }
  // sink + remove
  e.deathT = 0;
}

function updateEnemies(dt) {
  const pxz = player.pos;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e.alive) {
      e.deathT += dt;
      e.mesh.rotation.z = lerp(e.mesh.rotation.z, Math.PI/2, dt*4);
      e.mesh.position.y = lerp(e.mesh.position.y, terrainHeight(e.mesh.position.x, e.mesh.position.z) - 0.3, dt*3);
      if (e.deathT > 3) { scene.remove(e.mesh); enemies.splice(i,1); }
      continue;
    }
    e.hitFlash = Math.max(0, e.hitFlash - dt);
    e.attackCd = Math.max(0, e.attackCd - dt);

    // the horse the player is riding is driven by updatePlayer, not AI
    if (e === player.mounted) {
      if (e.mesh.userData.mat) e.mesh.userData.mat.emissive.setRGB(0, 0, 0);
      continue;
    }

    const dx = pxz.x - e.mesh.position.x, dz = pxz.z - e.mesh.position.z;
    const dist = Math.hypot(dx, dz);
    const dirToPlayer = _v.set(dx, 0, dz).normalize();

    let move = _s.set(0,0,0);
    // behaviour
    if (e.flees) {
      if (dist < 14 || e.state === 'flee') { // flee
        move.set(-dirToPlayer.x, 0, -dirToPlayer.z);
        e.speedCur = e.speed;
      } else { // wander
        e.wanderT -= dt;
        if (e.wanderT <= 0) { e.wanderT = rand(4,2); e.wanderDir = rand(TAU); }
        move.set(Math.cos(e.wanderDir), 0, Math.sin(e.wanderDir));
        e.speedCur = 2;
      }
    } else if (!e.hostile) { // calm animals (horse) — gentle wander, bolt if attacked
      if (e.state === 'flee' && dist < 22) {
        move.set(-dirToPlayer.x, 0, -dirToPlayer.z); e.speedCur = e.speed;
      } else {
        e.wanderT -= dt;
        if (e.wanderT <= 0) { e.wanderT = rand(6,3); e.wanderDir = rand(TAU); }
        move.set(Math.cos(e.wanderDir), 0, Math.sin(e.wanderDir));
        e.speedCur = 1.6;
      }
    } else { // wolf / boar / bear / snake / scorpion
      const notice = e.radius < 0.8 ? 13 : 40;   // small predators notice up close
      if (dist < notice || e.aggro) {
        e.aggro = true;
        if (dist > (e.radius + 1.6)) {       // chase
          move.copy(dirToPlayer); e.speedCur = e.speed;
        } else {                              // attack
          e.speedCur = 0;
          if (e.attackCd <= 0) { hurtPlayer(e.dmg); e.attackCd = e.type==='bear'?1.4:1.0; lungeEnemy(e, dirToPlayer); }
        }
      } else { // idle wander
        e.wanderT -= dt;
        if (e.wanderT <= 0) { e.wanderT = rand(5,3); e.wanderDir = rand(TAU); }
        move.set(Math.cos(e.wanderDir), 0, Math.sin(e.wanderDir));
        e.speedCur = 1.5;
      }
    }

    // integrate
    if (move.lengthSq() > 0) {
      move.normalize();
      e.mesh.position.x += move.x * e.speedCur * dt;
      e.mesh.position.z += move.z * e.speedCur * dt;
      e.mesh.rotation.y = Math.atan2(move.x, move.z);
    }
    // stick to ground
    e.mesh.position.y = terrainHeight(e.mesh.position.x, e.mesh.position.z);

    // hit-flash tint (only this enemy's cloned material)
    if (e.mesh.userData.mat) e.mesh.userData.mat.emissive.setRGB(e.hitFlash > 0 ? 0.6 : 0, 0, 0);

    // leg animation
    walkAnim(e, e.speedCur, dt);

    // cull far dead-simple: despawn very far non-boss
    if (e.type !== 'bear' && dist > CHUNK * (VIEW + 2)) { scene.remove(e.mesh); enemies.splice(i,1); }
  }
}

function lungeEnemy(e, dir) {
  e.mesh.position.addScaledVector(dir, 0.4);
}
function walkAnim(e, speed, dt) {
  e.walkT = (e.walkT || 0) + dt * speed * 1.4;
  const segs = e.mesh.userData.segs;
  if (segs) {   // snake — undulate the body sideways
    segs.forEach((s, k) => { s.position.z = Math.sin(e.walkT * 0.8 + k * 0.8) * 0.25; });
    return;
  }
  const legs = e.mesh.userData.legs;
  if (!legs) return;
  legs.forEach((leg, k) => {
    leg.rotation.x = Math.sin(e.walkT + (k%2)*Math.PI) * clamp(speed*0.08, 0, 0.6);
  });
}

// spawn management: keep some wildlife around the player
let spawnTimer = 0;
function manageSpawns(dt) {
  spawnTimer -= dt;
  if (spawnTimer > 0) return;
  spawnTimer = 1.8;
  const alive = enemies.filter(e => e.alive && e.type !== 'bear');
  if (alive.length < 20) {
    const a = rand(TAU), d = rand(95, 55);
    const x = player.pos.x + Math.cos(a) * d, z = player.pos.z + Math.sin(a) * d;
    const h = terrainHeight(x, z);
    if (h > WATER + 1 && h < 40) {
      const desert = desertFactor(x, z) > 0.5;
      const mounts = enemies.filter(e => e.alive && e.rideable).length;
      const r = Math.random();
      let t;
      if (desert) {                                                              // desert wildlife
        if (r < 0.28) t = 'scorpion';
        else if (r < 0.48) t = 'snake';
        else if (r < 0.66) t = 'rabbit';
        else if (r < 0.82) t = 'wolf';
        else t = mounts < 2 ? 'camel' : 'boar';                                  // camels to ride
      } else {                                                                   // forest wildlife
        if (r < 0.18) t = 'deer';
        else if (r < 0.32) t = 'rabbit';
        else if (r < 0.44) t = 'chicken';
        else if (r < 0.52) t = 'cat';
        else if (r < 0.60) t = 'dog';
        else if (r < 0.70) t = 'snake';
        else if (r < 0.82) t = 'wolf';
        else if (r < 0.92) t = 'boar';
        else t = mounts < 3 ? 'horse' : 'deer';                                  // keep horses around
      }
      spawnEnemy(t, x, z);
    }
  }
}

/* ----------------------------------------------------------------------------
 * 8. Fish in lakes (decorative, animated)
 * -------------------------------------------------------------------------- */
const fish = [];
function spawnFishNearWater() {
  // find a water chunk near player
  for (const [, c] of chunks) {
    if (c.userData.hasWater && fish.length < 30) {
      const wc = c.userData.waterCenter;
      if (Math.hypot(wc.x - player.pos.x, wc.z - player.pos.z) < CHUNK * 2) {
        for (let i = 0; i < 3 && fish.length < 30; i++) {
          const m = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 4), MAT.fish);
          m.rotation.z = Math.PI/2;
          m.position.set(wc.x + rand(20,-20), WATER - 0.3, wc.z + rand(20,-20));
          scene.add(m);
          fish.push({ mesh: m, ang: rand(TAU), cx: wc.x, cz: wc.z, r: rand(16,4), sp: rand(1.4,0.5), home: wc });
        }
      }
    }
  }
}
let fishTimer = 0;
function updateFish(dt) {
  fishTimer -= dt;
  if (fishTimer <= 0) { fishTimer = 3; spawnFishNearWater(); }
  for (let i = fish.length - 1; i >= 0; i--) {
    const f = fish[i];
    f.ang += dt * f.sp * 0.5;
    f.mesh.position.x = f.cx + Math.cos(f.ang) * f.r;
    f.mesh.position.z = f.cz + Math.sin(f.ang) * f.r;
    f.mesh.position.y = WATER - 0.25 + Math.sin(f.ang*3) * 0.1;
    f.mesh.rotation.y = -f.ang + Math.PI/2;
    if (Math.hypot(f.home.x - player.pos.x, f.home.z - player.pos.z) > CHUNK * 3) {
      scene.remove(f.mesh); fish.splice(i,1);
    }
  }
}

/* ----------------------------------------------------------------------------
 * 9. Loot system
 * -------------------------------------------------------------------------- */
const RARITY = {
  common:    { c: 0x9aa0a6, label: 'عادي', mul: 1 },
  uncommon:  { c: 0x4caf50, label: 'غير مألوف', mul: 1.6, cls: 'rare' },
  rare:      { c: 0x4aa3ff, label: 'نادر', mul: 2.4, cls: 'rare' },
  epic:      { c: 0xb06bff, label: 'ملحمي', mul: 3.6, cls: 'epic' },
  legendary: { c: 0xe6c15a, label: 'أسطوري', mul: 6, cls: 'legendary' },
};
// item registry — everything the player can collect / keep in the bag
const ITEMS = {
  coin:   { id:'coin',   name:'عملات ذهبية', icon:'🪙', type:'currency' },
  herb:   { id:'herb',   name:'عشبة شفاء',   icon:'🌿', type:'food', heal:35 },
  meat:   { id:'meat',   name:'لحم بري',     icon:'🍖', type:'food', heal:22 },
  fishI:  { id:'fishI',  name:'سمكة',        icon:'🐟', type:'food', heal:26 },
  pelt:   { id:'pelt',   name:'فرو',         icon:'🟫', type:'material' },
  gem:    { id:'gem',    name:'جوهرة الغابة',icon:'💎', type:'material' },
  amulet: { id:'amulet', name:'تعويذة الدب', icon:'🧿', type:'material' },
  dagger: { id:'dagger', name:'خنجر فولاذي', icon:'🗡️', type:'weapon', weaponIdx:1 },
  sword:  { id:'sword',  name:'سيف قديم',    icon:'⚔️', type:'weapon', weaponIdx:2 },
  spear:  { id:'spear',  name:'رمح صيد',     icon:'🔱', type:'weapon', weaponIdx:3 },
  axe:    { id:'axe',    name:'فأس قتالي',   icon:'🪓', type:'weapon', weaponIdx:4 },
  mace:   { id:'mace',   name:'مطرقة ثقيلة', icon:'🔨', type:'weapon', weaponIdx:5 },
  bow:    { id:'bow',    name:'قوس',        icon:'🏹', type:'weapon', weaponIdx:6 },
};
// loot tables per source (id → weight)
const LOOT_TABLES = {
  basic: [['meat',5],['pelt',3],['herb',2],['coin',4],['dagger',1]],
  good:  [['pelt',4],['meat',3],['coin',5],['herb',2],['dagger',3],['spear',2],['axe',2],['bow',2],['sword',1],['gem',1]],
  boss:  [['gem',4],['amulet',3],['coin',6],['sword',3],['spear',2],['axe',2],['mace',2],['bow',2],['dagger',1]],
};
function pickFromTable(kind) {
  const table = LOOT_TABLES[kind] || LOOT_TABLES.basic;
  let total = 0; for (const [, w] of table) total += w;
  let r = Math.random() * total;
  for (const [id, w] of table) { r -= w; if (r <= 0) return id; }
  return table[0][0];
}

const loot = [];
const inventory = [];   // the bag: [{ id,name,icon,type,rarity,qty,... }]

function addItem(itemId, qty = 1, rarity = 'common') {
  const def = ITEMS[itemId]; if (!def) return;
  if (def.type === 'currency') { player.gold += qty; updateHUD(); return; }
  let stack = inventory.find(s => s.id === itemId);
  if (stack) stack.qty += qty;
  else inventory.push({ ...def, rarity, qty });
}

function rollRarity(kind) {
  const r = Math.random();
  if (kind === 'boss') return r < 0.6 ? 'legendary' : 'epic';
  if (kind === 'good') { if (r < 0.05) return 'legendary'; if (r < 0.2) return 'epic'; if (r < 0.5) return 'rare'; return 'uncommon'; }
  if (r < 0.02) return 'epic'; if (r < 0.12) return 'rare'; if (r < 0.4) return 'uncommon'; return 'common';
}

function dropLoot(pos, kind) {
  const count = kind === 'boss' ? 5 : 1 + (Math.random() < 0.4 ? 1 : 0);
  for (let i = 0; i < count; i++) {
    const rarity = rollRarity(kind);
    const meta = RARITY[rarity];
    const itemId = pickFromTable(kind);
    const def = ITEMS[itemId];
    const geo = new THREE.OctahedronGeometry(0.35, 0);
    const mat = new THREE.MeshStandardMaterial({ color: meta.c, emissive: meta.c, emissiveIntensity: 0.5, metalness: 0.6, roughness: 0.3 });
    const m = new THREE.Mesh(geo, mat);
    const a = rand(TAU), d = rand(2.2, 0.3);
    const x = pos.x + Math.cos(a)*d, z = pos.z + Math.sin(a)*d;
    m.position.set(x, terrainHeight(x,z) + 0.7, z);
    m.castShadow = true;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.28, 2.2, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: meta.c, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false })
    );
    beam.position.y = 1.1; m.add(beam);
    scene.add(m);
    const qty = def.type === 'currency' ? Math.round(rand(60, 15) * meta.mul) : 1;
    loot.push({ mesh: m, rarity, itemId, name: def.name, icon: def.icon, qty, spin: 0 });
  }
}

function updateLoot(dt) {
  for (const l of loot) {
    l.spin += dt;
    l.mesh.rotation.y = l.spin * 1.6;
    l.mesh.position.y = terrainHeight(l.mesh.position.x, l.mesh.position.z) + 0.7 + Math.sin(l.spin*2)*0.12;
  }
}

function tryInteract() {
  // pick up nearest loot within range
  let best = null, bd = 3.2;
  for (const l of loot) {
    const d = Math.hypot(l.mesh.position.x - player.pos.x, l.mesh.position.z - player.pos.z);
    if (d < bd) { bd = d; best = l; }
  }
  if (best) pickup(best);
}

function pickup(l) {
  const idx = loot.indexOf(l);
  if (idx >= 0) loot.splice(idx, 1);
  scene.remove(l.mesh);
  const def = ITEMS[l.itemId];
  const meta = RARITY[l.rarity];
  if (def.type === 'weapon') {
    const newly = unlockWeapon(def.weaponIdx);
    addItem(l.itemId, 1, l.rarity);
    toast(`${l.icon} ${l.name} <span class="r">(${newly ? 'سلاح جديد!' : meta.label})</span>`, newly ? 'legendary' : (meta.cls||''));
  } else if (def.type === 'currency') {
    player.gold += l.qty;
    toast(`🪙 +${l.qty} ذهب`, meta.cls || '');
  } else {
    addItem(l.itemId, l.qty, l.rarity);
    toast(`${l.icon} + ${l.name} <span class="r">(${meta.label})</span>`, meta.cls || '');
  }
  sfx('loot');
  updateHUD();
  if (state === 'inv') renderInventory();
}

/* ----------------------------------------------------------------------------
 * 9b. Fishing (spear near water)
 * -------------------------------------------------------------------------- */
const FISH_DUR = 1.2;
let fishCatchPending = false;
function isNearWater() {
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  for (const dd of [1.5, 3, 5, 7])
    if (terrainHeight(player.pos.x + fx*dd, player.pos.z + fz*dd) < WATER + 0.3) return true;
  return terrainHeight(player.pos.x, player.pos.z) < WATER + 0.9;
}
function startFishing() { fishing = 1; fishCatchPending = true; sfx('swing'); }
function updateFishing(dt) {
  if (fishing > 0) {
    fishing = Math.max(0, fishing - dt / FISH_DUR);
    if (fishing <= 0 && fishCatchPending) { fishCatchPending = false; resolveFishing(); }
  }
}
function resolveFishing() {
  let caught = Math.random() < 0.7;
  for (let i = fish.length - 1; i >= 0; i--) {
    const f = fish[i];
    if (Math.hypot(f.mesh.position.x - player.pos.x, f.mesh.position.z - player.pos.z) < 28) {
      scene.remove(f.mesh); fish.splice(i, 1); caught = true; break;
    }
  }
  if (caught) { addItem('fishI', 1, 'common'); toast('🎣 اصطدت سمكة!', ''); sfx('loot'); if (state === 'inv') renderInventory(); }
  else toast('🎣 لم تصطد شيئاً…', '');
}

/* ----------------------------------------------------------------------------
 * 9c. Inventory (المحفظة)
 * -------------------------------------------------------------------------- */
function openInventory() {
  if (state !== 'play') return;
  state = 'inv'; document.exitPointerLock?.(); renderInventory(); show('inventory');
}
function closeInventory() {
  if (state !== 'inv') return;
  hide('inventory'); state = 'play'; canvas.requestPointerLock();
}
function renderInventory() {
  $('inv-gold').textContent = player.gold;
  const grid = $('inv-grid'); grid.innerHTML = '';
  const SLOTS = 32;
  for (let i = 0; i < Math.max(SLOTS, inventory.length); i++) {
    const it = inventory[i];
    const cell = document.createElement('div');
    if (!it) { cell.className = 'inv-slot empty'; grid.appendChild(cell); continue; }
    cell.className = 'inv-slot r-' + it.rarity;
    cell.innerHTML = `<span>${it.icon}</span>${it.qty > 1 ? `<span class="qty">${it.qty}</span>` : ''}`;
    cell.onclick = () => useItem(it);
    cell.onmouseenter = () => showItemDetail(it);
    grid.appendChild(cell);
  }
}
function showItemDetail(it) {
  let hint = '';
  if (it.type === 'food') hint = `<span class="hint">انقر للأكل (+${it.heal} صحة)</span>`;
  else if (it.type === 'weapon') hint = `<span class="hint">انقر للتجهيز</span>`;
  else hint = `<span class="hint">مادة — للبيع أو الاستخدام لاحقاً</span>`;
  $('inv-detail').innerHTML = `<b>${it.icon} ${it.name}</b> · ${RARITY[it.rarity].label} · ×${it.qty} — ${hint}`;
}
function useItem(it) {
  if (it.type === 'food') {
    player.hp = clamp(player.hp + it.heal, 0, player.hpMax);
    it.qty--; if (it.qty <= 0) inventory.splice(inventory.indexOf(it), 1);
    toast(`${it.icon} +${it.heal} صحة`, ''); sfx('loot'); updateHUD(); renderInventory();
  } else if (it.type === 'weapon') {
    selectWeapon(it.weaponIdx); toast(`جهّزت ${it.name}`, ''); renderInventory();
  } else showItemDetail(it);
}

/* ----------------------------------------------------------------------------
 * 9d. Village shop (buy weapons / potions)
 * -------------------------------------------------------------------------- */
function nearestVillage() {
  let best = null, bd = 14;
  for (const v of villages) {
    const d = Math.hypot(v.x - player.pos.x, v.z - player.pos.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
function tryShop() { if (state === 'play' && nearestVillage()) openShop(); }
function openShop() { state = 'shop'; document.exitPointerLock?.(); renderShop(); show('shop'); }
function closeShop() { if (state !== 'shop') return; hide('shop'); state = 'play'; canvas.requestPointerLock(); }
function renderShop() {
  $('shop-gold').textContent = player.gold;
  const list = $('shop-list'); list.innerHTML = '';
  [1, 2, 3, 4, 5, 6].forEach(idx => {
    const w = WEAPONS[idx], owned = player.owned[idx];
    const row = document.createElement('div');
    row.className = 'shop-item' + (owned ? ' owned' : '');
    row.innerHTML = `<span class="si-ico">${w.icon}</span><div class="si-info"><div class="si-name">${w.name}</div><div class="si-desc">ضرر ${w.dmg} · مدى ${w.range}${w.canFish ? ' · صيد سمك' : ''}</div></div>`;
    const b = document.createElement('button'); b.className = 'si-buy';
    if (owned) { b.textContent = 'مملوك'; b.disabled = true; }
    else { b.textContent = `🪙 ${w.price}`; b.disabled = player.gold < w.price; b.onclick = () => buyWeapon(idx); }
    row.appendChild(b); list.appendChild(row);
  });
  const row = document.createElement('div'); row.className = 'shop-item';
  row.innerHTML = `<span class="si-ico">🧪</span><div class="si-info"><div class="si-name">جرعة شفاء</div><div class="si-desc">+50 صحة فوراً</div></div>`;
  const b = document.createElement('button'); b.className = 'si-buy'; b.textContent = '🪙 40';
  b.disabled = player.gold < 40; b.onclick = () => buyPotion();
  row.appendChild(b); list.appendChild(row);
}
function buyWeapon(idx) {
  const w = WEAPONS[idx];
  if (player.gold < w.price || player.owned[idx]) return;
  player.gold -= w.price; unlockWeapon(idx); addItem(w.id, 1, 'rare');
  toast(`اشتريت ${w.name}!`, 'epic'); sfx('loot'); updateHUD(); renderShop();
}
function buyPotion() {
  if (player.gold < 40) return;
  player.gold -= 40; player.hp = clamp(player.hp + 50, 0, player.hpMax);
  toast('🧪 +50 صحة', ''); sfx('loot'); updateHUD(); renderShop();
}
$('inv-close') && ($('inv-close').onclick = closeInventory);
$('shop-close') && ($('shop-close').onclick = closeShop);

// contextual on-screen prompt (shop near village / fishing near water)
function nearRideableHorse() {
  if (player.mounted) return false;
  for (const e of enemies)
    if (e.alive && e.rideable &&
        Math.hypot(e.mesh.position.x - player.pos.x, e.mesh.position.z - player.pos.z) < 5) return true;
  return false;
}
function updatePrompt() {
  const p = $('prompt');
  if (player.mounted) {
    $('prompt-key').textContent = 'R'; $('prompt-text').textContent = 'النزول عن الحصان';
    p.classList.remove('hidden');
  } else if (nearRideableHorse()) {
    $('prompt-key').textContent = 'R'; $('prompt-text').textContent = 'امتطاء الحصان';
    p.classList.remove('hidden');
  } else if (nearestVillage()) {
    $('prompt-key').textContent = 'E'; $('prompt-text').textContent = 'فتح المتجر';
    p.classList.remove('hidden');
  } else if (WEAPONS[player.weapon].canFish && isNearWater()) {
    $('prompt-key').textContent = 'زر أيسر'; $('prompt-text').textContent = 'صيد السمك بالرمح';
    p.classList.remove('hidden');
  } else p.classList.add('hidden');
}

/* ----------------------------------------------------------------------------
 * 9e. Weather — morning fog, wind/storm, occasional snow
 * -------------------------------------------------------------------------- */
const weather = { wind:0.2, windTarget:0.2, windDir:0.6, fog:1, fogTarget:0.05, snow:0, snowTarget:0, rain:0, rainTarget:0, mode:'صباح ضبابي', timer:18 };
function resetWeather() {
  Object.assign(weather, { wind:0.2, windTarget:0.2, windDir:0.6, fog:1, fogTarget:0.05, snow:0, snowTarget:0, rain:0, rainTarget:0, lightMul:1, mode:'صباح ضبابي', timer:18 });
  timeOfDay = 0.12;   // start in the morning
}
function pickWeather() {
  const r = Math.random();
  if      (r < 0.24) Object.assign(weather, { mode:'صحو',          windTarget:rand(0.35,0.15), fogTarget:0.05, snowTarget:0,   rainTarget:0,   timer:rand(45,25) });
  else if (r < 0.40) Object.assign(weather, { mode:'رياح عادية',   windTarget:rand(0.55,0.4),  fogTarget:0.05, snowTarget:0,   rainTarget:0,   timer:rand(35,20) });
  else if (r < 0.52) Object.assign(weather, { mode:'رياح قوية',    windTarget:rand(0.95,0.75), fogTarget:0.10, snowTarget:0,   rainTarget:0,   timer:rand(30,18) });
  else if (r < 0.66) Object.assign(weather, { mode:'مطر',          windTarget:rand(0.5,0.3),   fogTarget:0.22, snowTarget:0,   rainTarget:0.6, timer:rand(34,20) });
  else if (r < 0.76) Object.assign(weather, { mode:'عاصفة رعدية',  windTarget:rand(1.2,0.95),  fogTarget:0.35, snowTarget:0,   rainTarget:0.95,timer:rand(26,16) });
  else if (r < 0.84) Object.assign(weather, { mode:'عاصفة',        windTarget:rand(1.3,1.0),   fogTarget:0.32, snowTarget:0.5, rainTarget:0,   timer:rand(26,16) });
  else if (r < 0.94) Object.assign(weather, { mode:'ثلج خفيف',     windTarget:rand(0.4,0.2),   fogTarget:0.15, snowTarget:0.4, rainTarget:0,   timer:rand(34,22) });
  else               Object.assign(weather, { mode:'صباح ضبابي',   windTarget:0.2,             fogTarget:0.9,  snowTarget:0,   rainTarget:0,   timer:rand(30,20) });
  weather.windDir += rand(1.2, -1.2);
}
function updateWeather(dt) {
  weather.timer -= dt;
  if (weather.timer <= 0) pickWeather();
  weather.wind = lerp(weather.wind, weather.windTarget, dt * 0.4);
  weather.fog  = lerp(weather.fog,  weather.fogTarget,  dt * 0.15);
  weather.snow = lerp(weather.snow, weather.snowTarget, dt * 0.3);
  weather.rain = lerp(weather.rain, weather.rainTarget, dt * 0.4);
  windUniform.value.set(Math.cos(weather.windDir) * weather.wind, Math.sin(weather.windDir) * weather.wind);
  scene.fog.near = lerp(CHUNK * 2.2, 6, weather.fog);
  scene.fog.far  = lerp(CHUNK * (VIEW + 0.6), CHUNK * 1.5, weather.fog);
  const stormy = weather.mode === 'عاصفة' || weather.mode === 'عاصفة رعدية';
  const dark = stormy ? 0.5 : weather.rain > 0.3 ? 0.72 : 1;
  weather.lightMul = lerp(weather.lightMul ?? 1, dark, dt * 2);   // day/night applies this
  if (ambientNode) ambientNode.gain.value = 0.03 + weather.wind * 0.06 + weather.rain * 0.05;
  updateSnow(dt);
  updateRain(dt);
  $('w-mode').textContent = weather.mode;
  $('w-windv').textContent = weather.wind < 0.35 ? 'هادئ' : weather.wind < 0.6 ? 'نسيم' : weather.wind < 0.95 ? 'قوي' : 'عاصف';
}

// snow particle field around the player
const SNOW_N = 1400;
let snowPoints = null, snowPos = null;
function initSnow() {
  snowPos = new Float32Array(SNOW_N * 3);
  for (let i = 0; i < SNOW_N; i++) { snowPos[i*3] = rand(80,-80); snowPos[i*3+1] = rand(60,0); snowPos[i*3+2] = rand(80,-80); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 0.45, transparent: true, opacity: 0, depthWrite: false });
  snowPoints = new THREE.Points(g, m); snowPoints.frustumCulled = false; scene.add(snowPoints);
}
function updateSnow(dt) {
  if (!snowPoints) return;
  snowPoints.material.opacity = weather.snow * 0.9;
  snowPoints.visible = weather.snow > 0.02;
  if (!snowPoints.visible) return;
  const wx = windUniform.value.x, wz = windUniform.value.y;
  for (let i = 0; i < SNOW_N; i++) {
    snowPos[i*3]   += wx * 6 * dt + Math.sin((elapsed + i) * 2) * 0.2 * dt;
    snowPos[i*3+1] -= (2.2 + weather.wind) * dt;
    snowPos[i*3+2] += wz * 6 * dt;
    if (snowPos[i*3+1] < -6) { snowPos[i*3+1] = 55; snowPos[i*3] = rand(80,-80); snowPos[i*3+2] = rand(80,-80); }
  }
  snowPoints.geometry.attributes.position.needsUpdate = true;
  snowPoints.position.set(player.pos.x, player.pos.y, player.pos.z);
}

// rain: falling line segments around the player
const RAIN_N = 1600;
let rainLines = null, rainPos = null;
function initRain() {
  rainPos = new Float32Array(RAIN_N * 2 * 3);   // 2 verts per drop
  for (let i = 0; i < RAIN_N; i++) {
    const x = rand(70,-70), y = rand(60,0), z = rand(70,-70);
    rainPos[i*6] = x;     rainPos[i*6+1] = y;       rainPos[i*6+2] = z;
    rainPos[i*6+3] = x;   rainPos[i*6+4] = y - 0.8; rainPos[i*6+5] = z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const m = new THREE.LineBasicMaterial({ color: 0xafc6de, transparent: true, opacity: 0 });
  rainLines = new THREE.LineSegments(g, m); rainLines.frustumCulled = false; scene.add(rainLines);
}
function updateRain(dt) {
  if (!rainLines) return;
  rainLines.material.opacity = weather.rain * 0.55;
  rainLines.visible = weather.rain > 0.02;
  if (!rainLines.visible) return;
  const wx = windUniform.value.x * 3, wz = windUniform.value.y * 3;
  const fall = (26 + weather.wind * 10) * dt;
  for (let i = 0; i < RAIN_N; i++) {
    for (const o of [0, 3]) {
      rainPos[i*6 + o]     += wx * dt;
      rainPos[i*6 + o + 1] -= fall;
      rainPos[i*6 + o + 2] += wz * dt;
    }
    if (rainPos[i*6+1] < -6) {
      const x = rand(70,-70), y = rand(60,40), z = rand(70,-70);
      rainPos[i*6] = x;   rainPos[i*6+1] = y;       rainPos[i*6+2] = z;
      rainPos[i*6+3] = x; rainPos[i*6+4] = y - 0.8; rainPos[i*6+5] = z;
    }
  }
  rainLines.geometry.attributes.position.needsUpdate = true;
  rainLines.position.set(player.pos.x, player.pos.y, player.pos.z);
}

/* ----------------------------------------------------------------------------
 * 9f. Day / night cycle
 * -------------------------------------------------------------------------- */
const DAY_LEN = 200;          // seconds for a full day↔night cycle
let timeOfDay = 0.15;         // 0=dawn, .25=noon, .5=dusk, .75=midnight
const _sunDir = new THREE.Vector3();
// palette anchors
const DAY_TOP = new THREE.Color(0x8ec3e8), DAY_BOT = new THREE.Color(0xcfe0dc);
const NIGHT_TOP = new THREE.Color(0x070c1c), NIGHT_BOT = new THREE.Color(0x121a33);
const DUSK_TOP = new THREE.Color(0x5a4a6a), DUSK_BOT = new THREE.Color(0xe8895a);
const _tmpTop = new THREE.Color(), _tmpBot = new THREE.Color(), _fogC = new THREE.Color();
function updateDayNight(dt) {
  timeOfDay = (timeOfDay + dt / DAY_LEN) % 1;
  const ang = timeOfDay * TAU;                 // sun orbit
  _sunDir.set(Math.cos(ang) * 0.5, Math.sin(ang), 0.32).normalize();
  sun.position.set(player.pos.x + _sunDir.x * 140, _sunDir.y * 150 + 12, player.pos.z + _sunDir.z * 140);
  sun.target.position.set(player.pos.x, 0, player.pos.z);
  skyMat.uniforms.sun.value.copy(_sunDir);

  const day = clamp(_sunDir.y * 2.2 + 0.15, 0, 1);      // 1 midday → 0 night
  const dusk = clamp(1 - Math.abs(_sunDir.y) * 5, 0, 1); // peaks at horizon
  const night = clamp(1 - (_sunDir.y * 3 + 0.5), 0, 1);

  // sky colours: night → dusk → day
  _tmpTop.copy(NIGHT_TOP).lerp(DAY_TOP, day).lerp(DUSK_TOP, dusk * 0.6);
  _tmpBot.copy(NIGHT_BOT).lerp(DAY_BOT, day).lerp(DUSK_BOT, dusk * 0.7);
  skyMat.uniforms.top.value.copy(_tmpTop);
  skyMat.uniforms.bottom.value.copy(_tmpBot);
  skyMat.uniforms.night.value = night;
  scene.background.copy(_tmpTop);
  // fog tracks the sky bottom (dimmer at night), tinted by weather a touch
  _fogC.copy(_tmpBot).multiplyScalar(lerp(0.7, 1, day));
  scene.fog.color.copy(_fogC);

  // lights
  const wm = weather.lightMul ?? 1;
  sun.intensity = lerp(sun.intensity, SUN_MAX * (0.05 + day * 0.95) * wm, dt * 2);
  sun.color.setRGB(1, lerp(0.82, 0.95, day), lerp(0.62, 0.84, day) + dusk * 0.06);
  hemi.intensity = lerp(hemi.intensity, (0.12 + day * 0.73) * wm, dt * 2);
  amb.intensity = lerp(amb.intensity, 0.12 + day * 0.16, dt * 2);
  stars.material.opacity = night;
  stars.position.copy(player.pos);

  // HUD clock
  const hr = Math.floor(((timeOfDay + 0.25) % 1) * 24);
  const icon = day > 0.35 ? '☀️' : night > 0.5 ? '🌙' : '🌆';
  const el = document.getElementById('w-time');
  if (el) el.textContent = `${icon} ${String(hr).padStart(2,'0')}:00`;
}

/* ----------------------------------------------------------------------------
 * 9g. Ambient life — birds, insects
 * -------------------------------------------------------------------------- */
const birds = [];
function makeBird() {
  const g = new THREE.Group();
  const wingGeo = new THREE.PlaneGeometry(0.9, 0.4);
  const lw = new THREE.Mesh(wingGeo, MAT.bird); lw.position.x = -0.45;
  const rw = new THREE.Mesh(wingGeo, MAT.bird); rw.position.x = 0.45;
  g.add(lw, rw); g.userData.lw = lw; g.userData.rw = rw;
  return g;
}
function initBirds() {
  for (let i = 0; i < 7; i++) {
    const m = makeBird(); m.frustumCulled = false; scene.add(m);
    birds.push({ mesh: m, ang: rand(TAU), r: rand(45, 18), h: rand(34, 20), sp: rand(0.5, 0.25), flap: rand(TAU),
                 cx: 0, cz: 0 });
  }
}
function updateBirds(dt) {
  for (const b of birds) {
    // circle centre drifts to follow the player
    b.cx = lerp(b.cx, player.pos.x, dt * 0.3);
    b.cz = lerp(b.cz, player.pos.z, dt * 0.3);
    b.ang += dt * b.sp;
    b.flap += dt * 10;
    const x = b.cx + Math.cos(b.ang) * b.r, z = b.cz + Math.sin(b.ang) * b.r;
    const y = terrainHeight(x, z) + b.h;
    b.mesh.position.set(x, y, z);
    b.mesh.rotation.y = -b.ang;
    const f = Math.sin(b.flap) * 0.6;
    b.mesh.userData.lw.rotation.z = f; b.mesh.userData.rw.rotation.z = -f;
  }
}

// insects: a small jittering point swarm near the player (forest, daytime)
let insectPts = null, insectPos = null;
const INSECT_N = 80;
function initInsects() {
  insectPos = new Float32Array(INSECT_N * 3);
  for (let i = 0; i < INSECT_N; i++) { insectPos[i*3]=rand(3,-3); insectPos[i*3+1]=rand(2.4,0.6); insectPos[i*3+2]=rand(3,-3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(insectPos, 3));
  insectPts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x2a2a1e, size: 0.08, transparent: true, opacity: 0.8, depthWrite: false }));
  insectPts.frustumCulled = false; scene.add(insectPts);
}
function updateInsects(dt) {
  if (!insectPts) return;
  const desert = desertFactor(player.pos.x, player.pos.z) > 0.5;
  const dayl = clamp(_sunDir.y * 2, 0, 1);
  insectPts.visible = !desert && dayl > 0.3;
  if (!insectPts.visible) return;
  for (let i = 0; i < INSECT_N; i++) {
    insectPos[i*3]   += Math.sin((elapsed*3 + i*7)) * dt * 0.6 + rand(0.1,-0.1)*dt;
    insectPos[i*3+1] += Math.cos((elapsed*4 + i*3)) * dt * 0.4;
    insectPos[i*3+2] += Math.cos((elapsed*3 + i*5)) * dt * 0.6;
    // keep within a small box
    for (const o of [0,1,2]) {
      const lo = o===1?0.4:-3.5, hi = o===1?2.6:3.5;
      if (insectPos[i*3+o] < lo) insectPos[i*3+o] = hi;
      if (insectPos[i*3+o] > hi) insectPos[i*3+o] = lo;
    }
  }
  insectPts.geometry.attributes.position.needsUpdate = true;
  insectPts.position.set(player.pos.x, player.pos.y, player.pos.z);
}

/* ----------------------------------------------------------------------------
 * 9h. Village NPCs + Arabic dialogue
 * -------------------------------------------------------------------------- */
const npcs = [];
const NPC_NAMES = ['أبو يوسف', 'سالم', 'مريم', 'خالد', 'فاطمة', 'إدريس', 'العربي', 'زينب'];
const NPC_LINES = [
  'السلام عليكم يا جاري.',
  'وعليكم السلام، كيف حالك اليوم؟',
  'الحمد لله، الحصاد كان وفيراً هذا العام.',
  'احذر، رأيت ذئاباً قرب النهر البارحة.',
  'هل سمعت عن الدب الأسطوري في أعماق الغابة؟',
  'يقولون إن من يهزمه ينال كنزاً عظيماً.',
  'التاجر جلب أسلحة جديدة، مرّ عليه.',
  'الطقس متقلب، قد تمطر الليلة.',
  'الأطفال ذهبوا لصيد السمك في البحيرة.',
  'لا تقترب من الصحراء وحدك، هناك عقارب.',
  'ليلة أمس كانت باردة، الثلج قادم.',
  'بارك الله في يومك يا صديقي.',
  'اشترِ حصاناً، يسهّل التنقل كثيراً.',
  'الغابة تخفي أسراراً كثيرة.',
];
function makeNPC() {
  const g = new THREE.Group();
  const mat = MAT.npc.clone();
  const robe = new THREE.Color().setHSL(rand(1), 0.35, rand(0.55, 0.35));
  mat.color.copy(robe);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 1.4, 8), mat);
  body.position.y = 0.7; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 8), new THREE.MeshLambertMaterial({ color: 0xc9a67e }));
  head.position.y = 1.6; head.castShadow = true;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6, 0, TAU, 0, 1.2), mat.clone());
  cap.position.y = 1.68;
  g.add(body, head, cap);
  return g;
}
function spawnVillageNPCs(cx, cz, group, key) {
  const r = rng(((cx*7919) ^ (cz*104729)) >>> 0);
  const n = 2 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, d = 3 + r() * 9;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    const h = terrainHeight(x, z);
    if (h < WATER + 1) continue;
    const mesh = makeNPC();
    mesh.position.set(x, h, z);
    mesh.rotation.y = r() * TAU;
    group.add(mesh);
    npcs.push({ mesh, key, name: NPC_NAMES[Math.floor(r()*NPC_NAMES.length)],
                homeX: x, homeZ: z, talkT: rand(10, 2), sayUntil: 0, bubble: null,
                wanderT: rand(4), wanderDir: rand(TAU) });
  }
}
function removeNpcsOfChunk(key) {
  for (let i = npcs.length - 1; i >= 0; i--) {
    if (npcs[i].key === key) { if (npcs[i].bubble) npcs[i].bubble.remove(); npcs.splice(i, 1); }
  }
}
function npcSay(npc, line, dur = 3.6) {
  if (!npc.bubble) {
    npc.bubble = document.createElement('div');
    npc.bubble.className = 'npc-bubble';
    document.getElementById('npc-bubbles').appendChild(npc.bubble);
  }
  npc.bubble.innerHTML = `<b>${npc.name}</b>${line}`;
  npc.sayUntil = elapsed + dur;
}
const _np = new THREE.Vector3();
function updateNPCs(dt) {
  camera.updateMatrixWorld();
  for (const npc of npcs) {
    // gentle wander near home
    npc.wanderT -= dt;
    if (npc.wanderT <= 0) { npc.wanderT = rand(5, 2); npc.wanderDir = rand(TAU); }
    const nx = npc.mesh.position.x + Math.cos(npc.wanderDir) * 0.6 * dt;
    const nz = npc.mesh.position.z + Math.sin(npc.wanderDir) * 0.6 * dt;
    if (Math.hypot(nx - npc.homeX, nz - npc.homeZ) < 7) {
      npc.mesh.position.x = nx; npc.mesh.position.z = nz;
      npc.mesh.rotation.y = Math.atan2(Math.cos(npc.wanderDir), Math.sin(npc.wanderDir));
    }
    npc.mesh.position.y = terrainHeight(npc.mesh.position.x, npc.mesh.position.z);

    // conversation: speak on a timer, prompt a nearby neighbour to reply
    npc.talkT -= dt;
    if (npc.talkT <= 0) {
      npc.talkT = rand(14, 7);
      npcSay(npc, NPC_LINES[Math.floor(rand(NPC_LINES.length))]);
      // face and cue nearest neighbour to reply
      let other = null, bd = 8;
      for (const o of npcs) {
        if (o === npc || o.key !== npc.key) continue;
        const d = Math.hypot(o.mesh.position.x - npc.mesh.position.x, o.mesh.position.z - npc.mesh.position.z);
        if (d < bd) { bd = d; other = o; }
      }
      if (other) {
        npc.mesh.lookAt(other.mesh.position.x, npc.mesh.position.y + 1.6, other.mesh.position.z);
        other.talkT = 2.2;   // replies shortly
      }
    }

    // position the speech bubble (project head to screen)
    if (npc.bubble) {
      if (elapsed > npc.sayUntil) { npc.bubble.remove(); npc.bubble = null; continue; }
      _np.set(npc.mesh.position.x, npc.mesh.position.y + 2.3, npc.mesh.position.z);
      const dist = _np.distanceTo(player.pos);
      _np.project(camera);
      if (_np.z < 1 && dist < 38) {
        const sx = (_np.x * 0.5 + 0.5) * innerWidth;
        const sy = (-_np.y * 0.5 + 0.5) * innerHeight;
        npc.bubble.style.display = 'block';
        npc.bubble.style.left = sx + 'px';
        npc.bubble.style.top = sy + 'px';
        npc.bubble.style.opacity = clamp(1 - (dist - 25) / 13, 0, 1);
      } else npc.bubble.style.display = 'none';
    }
  }
}

/* ----------------------------------------------------------------------------
 * 10. Particles (hit sparks)
 * -------------------------------------------------------------------------- */
const particles = [];
const partGeo = new THREE.SphereGeometry(0.08, 4, 4);
function spawnHitParticles(pos, y) {
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(partGeo, new THREE.MeshBasicMaterial({ color: 0xffcc66 }));
    m.position.set(pos.x, y, pos.z);
    scene.add(m);
    particles.push({ mesh: m, vel: new THREE.Vector3(rand(3,-3), rand(4,1), rand(3,-3)), life: 0.5 });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.vel.y -= 12 * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.material.opacity = clamp(p.life*2, 0, 1);
    p.mesh.material.transparent = true;
    if (p.life <= 0) { scene.remove(p.mesh); particles.splice(i,1); }
  }
}

/* ----------------------------------------------------------------------------
 * 11. Player damage / xp / death
 * -------------------------------------------------------------------------- */
let hurtCd = 0;
function hurtPlayer(dmg) {
  if (!player.alive) return;
  player.hp = clamp(player.hp - dmg, 0, player.hpMax);
  showVignette();
  sfx('hurt');
  updateHUD();
  if (player.hp <= 0) diePlayer();
}
function gainXP(x) {
  player.xp += x;
  while (player.xp >= player.xpNext) {
    player.xp -= player.xpNext;
    player.level++;
    player.xpNext = Math.round(player.xpNext * 1.4);
    player.hpMax += 15; player.hp = player.hpMax;
    toast(`ارتقيت إلى المستوى ${player.level}!`, 'epic');
  }
  updateHUD();
}
function diePlayer() {
  player.alive = false;
  document.exitPointerLock?.();
  state = 'dead';
  document.getElementById('death-stats').textContent =
    `الوقت: ${fmtTime(elapsed)} · القتلى: ${player.kills} · الذهب: ${player.gold}`;
  show('death');
}

/* ----------------------------------------------------------------------------
 * 12. Minimap (2D canvas, top-left)
 * -------------------------------------------------------------------------- */
const mm = document.getElementById('minimap');
const mmx = mm.getContext('2d');
const MM_SCALE = 0.5; // world units → px (zoom)
function drawMinimap() {
  const W = mm.width, H = mm.height, cx = W/2, cy = H/2;
  mmx.clearRect(0,0,W,H);
  // rotate map so player faces up
  mmx.save();
  mmx.translate(cx, cy);
  mmx.rotate(player.yaw);
  // sample terrain colours in a grid around player
  const step = 6, span = 110;
  for (let gz = -span; gz <= span; gz += step)
    for (let gx = -span; gx <= span; gx += step) {
      const wx = player.pos.x + gx, wz = player.pos.z + gz;
      const h = terrainHeight(wx, wz);
      let col;
      if (h < WATER) col = '#2b6b8a';
      else if (h > 46) col = '#e8eef5';
      else if (h > 34) col = '#5b564d';
      else if (desertFactor(wx, wz) > 0.5) col = '#cda964';
      else col = h < WATER+1 ? '#b9a86e' : `rgb(${28+h},${70+h},${24})`;
      mmx.fillStyle = col;
      mmx.fillRect(gx*MM_SCALE - step*MM_SCALE/2, gz*MM_SCALE - step*MM_SCALE/2, step*MM_SCALE+1, step*MM_SCALE+1);
    }
  // villages
  for (const v of villages) {
    const rx = (v.x - player.pos.x)*MM_SCALE, rz = (v.z - player.pos.z)*MM_SCALE;
    if (Math.hypot(rx,rz) < W/2) { mmx.fillStyle = '#e6c15a'; mmx.fillRect(rx-2, rz-2, 4, 4); }
  }
  // enemies
  for (const e of enemies) {
    if (!e.alive) continue;
    const rx = (e.mesh.position.x - player.pos.x)*MM_SCALE, rz = (e.mesh.position.z - player.pos.z)*MM_SCALE;
    if (Math.hypot(rx,rz) > W/2) continue;
    mmx.fillStyle = e.type === 'bear' ? '#ff3b3b' : e.type === 'wolf' ? '#ff9a3b' : '#9be08a';
    const s = e.type === 'bear' ? 5 : 3;
    mmx.beginPath(); mmx.arc(rx, rz, s, 0, TAU); mmx.fill();
  }
  // loot
  for (const l of loot) {
    const rx = (l.mesh.position.x - player.pos.x)*MM_SCALE, rz = (l.mesh.position.z - player.pos.z)*MM_SCALE;
    if (Math.hypot(rx,rz) > W/2) continue;
    mmx.fillStyle = '#' + RARITY[l.rarity].c.toString(16).padStart(6,'0');
    mmx.fillRect(rx-1.5, rz-1.5, 3, 3);
  }
  mmx.restore();
  // player arrow (always up/center)
  mmx.fillStyle = '#ffffff';
  mmx.beginPath(); mmx.moveTo(cx, cy-7); mmx.lineTo(cx-5, cy+5); mmx.lineTo(cx+5, cy+5); mmx.closePath(); mmx.fill();
  // coords
  document.getElementById('coords').textContent = `${player.pos.x.toFixed(0)}, ${player.pos.z.toFixed(0)}`;
}

/* ----------------------------------------------------------------------------
 * 13. HUD helpers
 * -------------------------------------------------------------------------- */
function updateHUD() {
  $('hp-fill').style.width = (player.hp / player.hpMax * 100) + '%';
  $('hp-num').textContent = Math.ceil(player.hp);
  $('sta-fill').style.width = (player.stamina / player.staMax * 100) + '%';
  $('stat-gold').textContent = player.gold;
  $('stat-kills').textContent = player.kills;
  $('player-lvl').textContent = player.level;
  $('xp-fill').style.width = (player.xp / player.xpNext * 100) + '%';
}
function objectiveText(t) { $('obj-text').textContent = t; }
let toastList = [];
function toast(html, cls='') {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.innerHTML = html;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.transition='opacity .4s'; el.style.opacity='0'; setTimeout(()=>el.remove(),400); }, 2600);
}
let vigT = 0;
function showVignette() { $('vignette').classList.add('show'); vigT = 0.25; }
function flashCrosshair() { const c=$('crosshair'); c.classList.add('hit'); setTimeout(()=>c.classList.remove('hit'),120); }
function showBossBar() { $('bossbar').classList.remove('hidden'); }
function hideBossBar() { $('bossbar').classList.add('hidden'); }
function updateBossBar(t) { $('boss-fill').style.width = (t*100)+'%'; }
function fmtTime(s){ const m=Math.floor(s/60), ss=Math.floor(s%60); return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`; }

/* ----------------------------------------------------------------------------
 * 14. Audio (tiny WebAudio SFX)
 * -------------------------------------------------------------------------- */
let audioCtx = null, audioOn = true, ambientNode = null;
function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // wind ambience: filtered noise
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i=0;i<data.length;i++) data[i] = (Math.random()*2-1)*0.5;
    const src = audioCtx.createBufferSource(); src.buffer = buf; src.loop = true;
    const flt = audioCtx.createBiquadFilter(); flt.type='lowpass'; flt.frequency.value=380;
    const g = audioCtx.createGain(); g.gain.value = 0.05;
    src.connect(flt); flt.connect(g); g.connect(audioCtx.destination); src.start();
    ambientNode = g;
  } catch(e) {}
}
function sfx(type) {
  if (!audioOn || !audioCtx) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.connect(g); g.connect(audioCtx.destination);
  if (type==='swing'){ o.type='triangle'; o.frequency.setValueAtTime(320,t); o.frequency.exponentialRampToValueAtTime(120,t+0.12); g.gain.setValueAtTime(0.08,t);}
  else if (type==='hit'){ o.type='square'; o.frequency.setValueAtTime(180,t); o.frequency.exponentialRampToValueAtTime(60,t+0.15); g.gain.setValueAtTime(0.14,t);}
  else if (type==='hurt'){ o.type='sawtooth'; o.frequency.setValueAtTime(140,t); o.frequency.exponentialRampToValueAtTime(70,t+0.2); g.gain.setValueAtTime(0.16,t);}
  else if (type==='loot'){ o.type='sine'; o.frequency.setValueAtTime(660,t); o.frequency.exponentialRampToValueAtTime(1200,t+0.12); g.gain.setValueAtTime(0.1,t);}
  g.gain.exponentialRampToValueAtTime(0.001, t+0.25);
  o.start(t); o.stop(t+0.28);
}

/* ----------------------------------------------------------------------------
 * 15. Menu background scene (rotating forest render)
 * -------------------------------------------------------------------------- */
const menuBg = document.getElementById('menu-bg');
const bgRenderer = new THREE.WebGLRenderer({ canvas: menuBg, antialias: true });
bgRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
bgRenderer.setSize(innerWidth, innerHeight);
bgRenderer.toneMapping = THREE.ACESFilmicToneMapping;
const bgScene = new THREE.Scene();
bgScene.fog = new THREE.Fog(0x9fb6ae, 40, 220);
const bgCam = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 3000);
bgScene.add(new THREE.Mesh(skyGeo.clone(), skyMat.clone()));
bgScene.add(new THREE.HemisphereLight(0xbfe0ff, 0x35502a, 1.0));
const bgSun = new THREE.DirectionalLight(0xfff0d0, 1.6); bgSun.position.set(60,80,20); bgScene.add(bgSun);
(function buildMenuForest(){
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600,600,60,60), new THREE.MeshLambertMaterial({ color:0x2f6b34 }));
  ground.rotation.x = -Math.PI/2;
  const pos = ground.geometry.attributes.position;
  for (let i=0;i<pos.count;i++){ pos.setZ(i, terrainHeight(pos.getX(i)*0.6, pos.getY(i)*0.6)*0.4); }
  ground.geometry.computeVertexNormals();
  bgScene.add(ground);
  const r = rng(7);
  const N = 160;
  const trunkM = new THREE.InstancedMesh(GEO.trunk, MAT.trunk, N);
  const pM = new THREE.InstancedMesh(GEO.pine1, MAT.pine, N);
  const p2 = new THREE.InstancedMesh(GEO.pine2, MAT.pineHi, N);
  for (let i=0;i<N;i++){
    const a=r()*TAU, d=r()*260+20;
    const x=Math.cos(a)*d, z=Math.sin(a)*d - 60;
    const y = terrainHeight(x*0.6,z*0.6)*0.4;
    const sc=0.8+r()*1.2;
    _q.setFromAxisAngle(_v.set(0,1,0), r()*TAU);
    _m.compose(_v.set(x,y,z), _q, _s.set(sc,sc,sc));
    trunkM.setMatrixAt(i,_m); pM.setMatrixAt(i,_m); p2.setMatrixAt(i,_m);
  }
  bgScene.add(trunkM, pM, p2);
})();
let bgAngle = 0;

/* ----------------------------------------------------------------------------
 * 16. Game state machine + UI wiring
 * -------------------------------------------------------------------------- */
let state = 'menu';    // menu | loading | play | pause | dead
let elapsed = 0, walkPhase = 0;

function show(id){ $(id).classList.remove('hidden'); }
function hide(id){ $(id).classList.add('hidden'); }

// menu buttons
$('btn-play').onclick = () => startGame();
$('btn-controls').onclick = () => show('panel-controls');
$('btn-settings').onclick = () => show('panel-settings');
document.querySelectorAll('.btn-back').forEach(b => b.onclick = e => e.target.closest('.panel').classList.add('hidden'));

// settings
$('opt-view').oninput = e => { VIEW = +e.target.value; scene.fog.far = CHUNK*(VIEW+0.6); };
$('opt-sens').oninput = e => { MOUSE_SENS = +e.target.value * 0.00016; };
$('opt-shadow').onchange = e => {
  const q = +e.target.value;
  renderer.shadowMap.enabled = q > 0;
  sun.shadow.mapSize.set(q>=2?4096:2048, q>=2?4096:2048);
  sun.castShadow = q > 0;
};
$('opt-audio').onchange = e => { audioOn = e.target.checked; };

// pause
function pauseGame(){ state='pause'; document.exitPointerLock?.(); show('pause'); }
$('btn-resume').onclick = () => { hide('pause'); state='play'; canvas.requestPointerLock(); };
$('btn-quit').onclick = () => backToMenu();
$('btn-respawn').onclick = () => { hide('death'); respawn(); };
$('btn-death-menu').onclick = () => { hide('death'); backToMenu(); };

function backToMenu(){
  state='menu'; hide('hud'); hide('pause'); show('menu');
  document.exitPointerLock?.();
}

function startGame(){
  initAudio();
  hide('menu'); show('loading');
  // progressive world warm-up
  let step = 0;
  const total = 8;
  const warm = () => {
    step++;
    $('loader-fill').style.width = (step/total*100)+'%';
    updateChunks(player.pos.x, player.pos.z);
    if (step < total) { setTimeout(warm, 60); return; }
    finishLoad();
  };
  // reset player
  Object.assign(player, { hp:100, hpMax:100, stamina:100, gold:0, kills:0, xp:0, level:1, xpNext:100, alive:true });
  player.owned = [true, false, false, false, false, false, false];
  player.weapon = 0;
  inventory.length = 0;
  player.pos.set(0, terrainHeight(0,0)+player.height+2, 0);
  player.vel.set(0,0,0); player.yaw=0; player.pitch=0;
  clearEntities();
  resetWeather();
  selectWeapon(0);
  refreshWeaponWheel();
  updateHUD();
  warm();
}
function finishLoad(){
  hide('loading'); show('hud'); state='play';
  objectiveText('لا تملك سلاحاً بعد — ابحث عن الأسلحة في اللوت أو اشترِها من القرى.');
  // seed some wildlife + schedule the bear
  for (let i=0;i<6;i++) manageSpawns(999);
  bearSpawned = false;
  bearTimer = 150;   // the bear appears after you've explored / armed up
  // debug: #boss spawns the legendary bear right away
  if (location.hash.includes('boss')) { bearTimer = 0; maybeSpawnBear(0.01); }
  canvas.requestPointerLock();
}
function respawn(){
  player.hp = player.hpMax; player.alive = true; player.stamina = player.staMax;
  player.pos.set(player.pos.x, terrainHeight(player.pos.x,player.pos.z)+player.height+2, player.pos.z);
  player.vel.set(0,0,0);
  state='play'; show('hud'); updateHUD(); canvas.requestPointerLock();
}
function clearEntities(){
  player.mounted = null; player.height = 1.7;
  enemies.forEach(e => scene.remove(e.mesh)); enemies.length = 0;
  loot.forEach(l => scene.remove(l.mesh)); loot.length = 0;
  fish.forEach(f => scene.remove(f.mesh)); fish.length = 0;
  particles.forEach(p => scene.remove(p.mesh)); particles.length = 0;
  projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
  npcs.forEach(n => { if (n.bubble) { n.bubble.remove(); n.bubble = null; } });
  bear = null; hideBossBar();
}

// spawn the boss bear after a while / when player has explored
let bearTimer = 8;
function maybeSpawnBear(dt){
  if (bearSpawned) return;
  bearTimer -= dt;
  if (bearTimer <= 0 || player.kills >= 8) {
    bearSpawned = true;
    const a = rand(TAU), d = 70;
    let x = player.pos.x + Math.cos(a)*d, z = player.pos.z + Math.sin(a)*d;
    // find non-water ground
    for (let i=0;i<10 && terrainHeight(x,z)<WATER+1;i++){ x+=10; z+=6; }
    spawnEnemy('bear', x, z);
    objectiveText('الدب الأسطوري (المستوى 100) ظهر! اهزمه — يتقلص كلما أصبته.');
    $('boss-lvl').textContent = 'المستوى 100';
    toast('⚠️ ظهر الدب الأسطوري!', 'legendary');
  }
}

/* ----------------------------------------------------------------------------
 * 17. Main loop
 * -------------------------------------------------------------------------- */
buildWeaponModel(0);   // start empty-handed (fists)
initSnow();
initRain();
initBirds();
initInsects();
const clock = new THREE.Clock();

function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state === 'menu'){
    bgAngle += dt * 0.06;
    bgCam.position.set(Math.cos(bgAngle)*120, 34, Math.sin(bgAngle)*120 - 40);
    bgCam.lookAt(0, 18, -60);
    bgRenderer.render(bgScene, bgCam);
    return;
  }
  if (state === 'play'){
    elapsed += dt;
    timeUniform.value = elapsed;
    updatePlayer(dt);
    // walk bob phase
    const moving = (keys['KeyW']||keys['KeyS']||keys['KeyA']||keys['KeyD']) && player.onGround;
    walkPhase += dt * (moving ? (keys['ShiftLeft']?16:10) : 0);
    updateWeaponAnim(dt);
    updateFishing(dt);
    updateWeather(dt);
    updateDayNight(dt);
    updateNPCs(dt);
    updateBirds(dt);
    updateInsects(dt);
    updateChunks(player.pos.x, player.pos.z);
    manageSpawns(dt);
    maybeSpawnBear(dt);
    updateEnemies(dt);
    updateFish(dt);
    updateLoot(dt);
    updateParticles(dt);
    updateProjectiles(dt);
    // vignette fade
    if (vigT > 0){ vigT -= dt; if (vigT <= 0) $('vignette').classList.remove('show'); }
    // village shop prompt
    updatePrompt();
    // stamina/hud tick
    $('sta-fill').style.width = (player.stamina/player.staMax*100)+'%';
    $('stat-time').textContent = fmtTime(elapsed);
    drawMinimap();
    // slight camera bob
    camera.position.y += Math.sin(walkPhase)*0.03;
  }

  composer.render();
}
animate();

/* ----------------------------------------------------------------------------
 * 18. Resize
 * -------------------------------------------------------------------------- */
addEventListener('resize', () => {
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  bgCam.aspect = innerWidth/innerHeight; bgCam.updateProjectionMatrix();
  bgRenderer.setSize(innerWidth, innerHeight);
});

// warm the very first chunks so menu bg has data & play start is instant-ish
updateChunks(0, 0);

// optional debug bridge (append #debug to the URL): quick testing helpers
if (location.hash.includes('debug')) {
  window.__DBG = {
    player, inventory, WEAPONS, villages, weather, enemies,
    gold: (n = 500) => { player.gold += n; updateHUD(); },
    give: (id) => { const d = ITEMS[id]; if (d.type === 'weapon') unlockWeapon(d.weaponIdx); addItem(id, 1, 'rare'); },
    drop: (kind = 'good') => dropLoot(player.pos, kind),
    villageHere: () => villages.push({ x: player.pos.x + 3, z: player.pos.z }),
    setWeather: (m) => { weather.timer = 999; Object.assign(weather, m); },
    spawn: (type = 'horse') => spawnEnemy(type, player.pos.x + 3, player.pos.z + 1),
    setTime: (t) => { timeOfDay = t; },
    npcs, birds,
    mount: () => toggleMount(),
    tp: (x, z) => { player.pos.set(x, terrainHeight(x, z) + player.height + 2, z); updateChunks(x, z); },
    findDesert: () => { for (let d = 200; d < 6000; d += 120) for (let a = 0; a < 6.28; a += 0.5) { const x = Math.cos(a)*d, z = Math.sin(a)*d; if (desertFactor(x, z) > 0.6) return { x: Math.round(x), z: Math.round(z) }; } return null; },
    openShop, openInventory,
  };
}
