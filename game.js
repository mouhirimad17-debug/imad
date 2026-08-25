/* ============================================================================
 * ORBITAL SIEGE — game.js
 * A realistic 2D space combat game for mobile, built with Three.js.
 * Orthographic camera on the XY plane → true 2D play with 3D-lit objects,
 * bloom post-processing, GPU particles, procedural nebula & audio.
 * ========================================================================== */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ----------------------------------------------------------------------------
 * 0. Small utilities
 * -------------------------------------------------------------------------- */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp  = (a, b, t) => a + (b - a) * t;
const rand  = (a = 1, b = 0) => b + Math.random() * (a - b);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const pick  = arr => arr[(Math.random() * arr.length) | 0];
const TAU   = Math.PI * 2;
const now   = () => performance.now() / 1000;
const $     = id => document.getElementById(id);

/* ----------------------------------------------------------------------------
 * 1. Persistence
 * -------------------------------------------------------------------------- */
const Save = {
  data: { best: 0, bestWave: 0, vol: 0.8, music: 0.55, bloom: true, particles: true, haptics: true },
  load() {
    try { const s = JSON.parse(localStorage.getItem('orbital_siege') || '{}'); Object.assign(this.data, s); }
    catch (e) {}
  },
  save() { try { localStorage.setItem('orbital_siege', JSON.stringify(this.data)); } catch (e) {} }
};
Save.load();

/* ----------------------------------------------------------------------------
 * 2. Audio — fully procedural WebAudio (no downloads)
 * -------------------------------------------------------------------------- */
class AudioEngine {
  constructor() { this.ctx = null; this.ready = false; this.musicNodes = null; }
  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain(); this.master.gain.value = Save.data.vol;
    this.sfx = this.ctx.createGain(); this.sfx.gain.value = 1;
    this.mus = this.ctx.createGain(); this.mus.gain.value = Save.data.music;
    this.sfx.connect(this.master); this.mus.connect(this.master); this.master.connect(this.ctx.destination);
    this.ready = true;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setVol(v) { if (this.master) this.master.gain.value = v; }
  setMusic(v) { if (this.mus) this.mus.gain.value = v; }

  _tone({ f = 440, f2 = null, type = 'sine', dur = 0.2, vol = 0.3, attack = 0.005, dest = null }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2 != null) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.sfx); o.start(t); o.stop(t + dur + 0.02);
  }
  _noise({ dur = 0.3, vol = 0.4, lp = 1200, dest = null }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(dest || this.sfx); src.start(t);
  }
  laser()      { this._tone({ f: 900, f2: 380, type: 'square',   dur: 0.12, vol: 0.10 }); }
  beam()       { this._tone({ f: 220, f2: 260, type: 'sawtooth', dur: 0.08, vol: 0.05 }); }
  enemyLaser() { this._tone({ f: 300, f2: 140, type: 'sawtooth', dur: 0.16, vol: 0.07 }); }
  hit()        { this._noise({ dur: 0.10, vol: 0.18, lp: 2600 }); }
  explosion(s = 1) {
    this._noise({ dur: 0.35 * s, vol: 0.5, lp: 900 });
    this._tone({ f: 160, f2: 40, type: 'sine', dur: 0.4 * s, vol: 0.35 });
  }
  playerHit()  { this._noise({ dur: 0.25, vol: 0.4, lp: 700 }); this._tone({ f: 120, f2: 60, dur: 0.3, vol: 0.3 }); }
  pickup()     { this._tone({ f: 660, f2: 1320, type: 'triangle', dur: 0.18, vol: 0.2 }); }
  ui()         { this._tone({ f: 520, f2: 720, type: 'triangle', dur: 0.08, vol: 0.12 }); }
  bossWarn()   { this._tone({ f: 90, f2: 200, type: 'sawtooth', dur: 0.8, vol: 0.25 }); }

  startMusic() {
    if (!this.ready || this.musicNodes) return;
    const t = this.ctx.currentTime;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 2;
    lp.connect(this.mus);
    const lfo = this.ctx.createOscillator(); const lfoG = this.ctx.createGain();
    lfo.frequency.value = 0.06; lfoG.gain.value = 240; lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start();
    const freqs = [55, 82.4, 110, 164.8];
    const oscs = freqs.map((f, i) => {
      const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
      o.type = i % 2 ? 'sine' : 'triangle'; o.frequency.value = f;
      g.gain.value = 0.06 / (i + 1); o.connect(g); g.connect(lp); o.start(t); return o;
    });
    this.musicNodes = { oscs, lfo, lp };
  }
}
const AUDIO = new AudioEngine();

/* ----------------------------------------------------------------------------
 * 3. Upgrades (roguelite, per-run) + derived player stats
 * -------------------------------------------------------------------------- */
const UPGRADES = [
  { id: 'damage',     name: 'Damage',      desc: '+18% projectile & beam damage', max: 6, base: 60,  growth: 1.5 },
  { id: 'firerate',   name: 'Fire Rate',   desc: 'Faster auto-fire cadence',      max: 6, base: 60,  growth: 1.5 },
  { id: 'multishot',  name: 'Multi-shot',  desc: '+1 forward projectile',         max: 3, base: 130, growth: 1.9 },
  { id: 'hull',       name: 'Max Hull',    desc: '+25 max hull (also repairs)',   max: 6, base: 70,  growth: 1.5 },
  { id: 'shieldcap',  name: 'Shield Cap',  desc: '+20 shield capacity',           max: 6, base: 70,  growth: 1.5 },
  { id: 'shieldregen',name: 'Shield Regen',desc: 'Recharges shields sooner',      max: 5, base: 70,  growth: 1.6 },
  { id: 'focuscap',   name: 'Focus Core',  desc: '+Focus capacity & regen',       max: 5, base: 80,  growth: 1.6 },
  { id: 'speed',      name: 'Thrusters',   desc: '+Manoeuvring speed',            max: 5, base: 55,  growth: 1.5 },
  { id: 'magnet',     name: 'Magnet',      desc: '+Pickup attraction radius',     max: 4, base: 55,  growth: 1.6 },
];
const upCost = (u, lvl) => Math.round(u.base * Math.pow(u.growth, lvl));

/* ----------------------------------------------------------------------------
 * 4. World: renderer, camera, background, post-processing
 * -------------------------------------------------------------------------- */
const WORLD_HALF_H = 11;               // fixed vertical half-extent (world units)
let HALF_W = 6, HALF_H = WORLD_HALF_H; // horizontal computed from aspect

class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060c, 0.006);

    this.camera = new THREE.OrthographicCamera(-6, 6, 11, -11, 0.1, 400);
    this.camera.position.set(0, 0, 60);
    this.camera.lookAt(0, 0, 0);

    this._buildLights();
    this._buildBackground();
    this._buildComposer();

    this.shake = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _buildLights() {
    this.scene.add(new THREE.AmbientLight(0x22303f, 1.1));
    const hemi = new THREE.HemisphereLight(0x88bbff, 0x1a1030, 0.5); this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xdfefff, 2.2); key.position.set(6, 9, 20); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x2c6cff, 1.0); rim.position.set(-8, -4, 12); this.scene.add(rim);
    // warm light from the dying star (upper-left)
    const star = new THREE.PointLight(0xff8a3c, 1.4, 120, 2); star.position.set(-18, 16, 24); this.scene.add(star);
  }

  _buildBackground() {
    const bg = new THREE.Group(); this.bg = bg; this.scene.add(bg);

    // Procedural nebula (fbm) on a big plane
    this.nebUniforms = { uTime: { value: 0 }, uAspect: { value: 1 } };
    const neb = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        depthWrite: false, depthTest: false, transparent: false,
        uniforms: this.nebUniforms,
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy*2.0,0.999,1.0);} `,
        fragmentShader: `
          precision highp float; varying vec2 vUv; uniform float uTime; uniform float uAspect;
          float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
          float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
            float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
            return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
          float fbm(vec2 p){ float v=0.0,a=0.5; mat2 m=mat2(1.6,1.2,-1.2,1.6);
            for(int i=0;i<6;i++){ v+=a*noise(p); p=m*p; a*=0.5; } return v; }
          void main(){
            vec2 uv=vUv; uv.x*=uAspect;
            vec2 p=uv*3.0 + vec2(0.0, uTime*0.02);
            float f=fbm(p + fbm(p*0.5+uTime*0.01));
            float f2=fbm(p*1.8 - uTime*0.015);
            vec3 base=vec3(0.010,0.016,0.030);
            vec3 col=base;
            col += vec3(0.05,0.09,0.19)*smoothstep(0.45,0.95,f);
            col += vec3(0.17,0.05,0.09)*smoothstep(0.62,1.0,f2)*0.6;
            col += vec3(0.20,0.12,0.05)*pow(smoothstep(0.7,1.0,f*f2),2.0)*0.5;
            // dying star glow upper-left corner (subtle, tight)
            vec2 sp=vec2(0.10, 0.92); float d=distance(vUv*vec2(uAspect,1.0), sp*vec2(uAspect,1.0));
            col += vec3(0.50,0.27,0.11)*smoothstep(0.26,0.0,d);
            col += vec3(0.9,0.6,0.32)*smoothstep(0.045,0.0,d);
            // faint grain
            col *= 0.94 + 0.06*noise(uv*160.0);
            gl_FragColor=vec4(col,1.0);
          }`
      })
    );
    neb.frustumCulled = false; neb.renderOrder = -10; this.scene.add(neb);

    // Distant planet (crescent-lit sphere)
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(6, 48, 48),
      new THREE.MeshStandardMaterial({ color: 0x24405f, roughness: 1, metalness: 0.0, emissive: 0x0a1830, emissiveIntensity: 0.4 })
    );
    planet.position.set(9, -16, -30); this.scene.add(planet);
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(6.5, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x2f6cff, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, side: THREE.BackSide })
    );
    atmo.position.copy(planet.position); this.scene.add(atmo);

    // Parallax starfields (3 layers)
    this.starLayers = [];
    const layerCfg = [
      { n: 260, spread: 70, size: 0.06, color: 0x9fc8ff, speed: 0.4, depth: -18 },
      { n: 180, spread: 70, size: 0.10, color: 0xffffff, speed: 0.9, depth: -12 },
      { n: 90,  spread: 70, size: 0.16, color: 0xfff2d8, speed: 1.7, depth: -6  },
    ];
    for (const c of layerCfg) {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(c.n * 3);
      for (let i = 0; i < c.n; i++) {
        pos[i*3]   = rand(-c.spread/2, c.spread/2);
        pos[i*3+1] = rand(-40, 40);
        pos[i*3+2] = c.depth;
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({ color: c.color, size: c.size, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false });
      const pts = new THREE.Points(g, m); pts.frustumCulled = false;
      pts.userData = c; this.scene.add(pts); this.starLayers.push(pts);
    }
  }

  _buildComposer() {
    const size = new THREE.Vector2(window.innerWidth, window.innerHeight);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(size, 0.65, 0.55, 0.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.bloomEnabled = Save.data.bloom;
    this.bloom.enabled = this.bloomEnabled;
  }

  setBloom(on) { this.bloomEnabled = on; if (this.bloom) this.bloom.enabled = on; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight, aspect = w / h;
    HALF_H = WORLD_HALF_H; HALF_W = WORLD_HALF_H * aspect;
    this.camera.left = -HALF_W; this.camera.right = HALF_W;
    this.camera.top = HALF_H; this.camera.bottom = -HALF_H;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    if (this.nebUniforms) this.nebUniforms.uAspect.value = aspect;
  }

  addShake(v) { this.shake = Math.min(1.2, this.shake + v); }

  update(dt, t) {
    if (this.nebUniforms) this.nebUniforms.uTime.value = t;
    for (const layer of this.starLayers) {
      const c = layer.userData; const pos = layer.geometry.attributes.position;
      for (let i = 0; i < c.n; i++) {
        let y = pos.array[i*3+1] - c.speed * dt;
        if (y < -42) { y = 42; pos.array[i*3] = rand(-c.spread/2, c.spread/2); }
        pos.array[i*3+1] = y;
      }
      pos.needsUpdate = true;
    }
    // screen shake
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.shake * this.shake;
    const sx = rand(-1, 1) * s * 0.7, sy = rand(-1, 1) * s * 0.7;
    this.camera.position.x = sx; this.camera.position.y = sy;
    this.camera.lookAt(sx, sy, 0);
  }

  render() { if (this.bloomEnabled) this.composer.render(); else this.renderer.render(this.scene, this.camera); }
}

/* ----------------------------------------------------------------------------
 * 5. Mesh factories (procedural, PBR-lit metallic look)
 * -------------------------------------------------------------------------- */
const MAT = {
  hull:  () => new THREE.MeshStandardMaterial({ color: 0xb7c4d4, metalness: 0.95, roughness: 0.35 }),
  darkhull:() => new THREE.MeshStandardMaterial({ color: 0x53617a, metalness: 0.9, roughness: 0.45 }),
  glowCyan:  () => new THREE.MeshStandardMaterial({ color: 0x0a2a33, emissive: 0x35e8ff, emissiveIntensity: 2.2, metalness: 0.5, roughness: 0.3 }),
  glowAmber: () => new THREE.MeshStandardMaterial({ color: 0x2a1a08, emissive: 0xffb547, emissiveIntensity: 2.0, metalness: 0.5, roughness: 0.3 }),
  glowRed:   () => new THREE.MeshStandardMaterial({ color: 0x2a0a0e, emissive: 0xff3550, emissiveIntensity: 2.2, metalness: 0.5, roughness: 0.3 }),
  glowPurp:  () => new THREE.MeshStandardMaterial({ color: 0x1a0a2a, emissive: 0xb46bff, emissiveIntensity: 2.2, metalness: 0.5, roughness: 0.3 }),
  enemy: (c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.85, roughness: 0.45 }),
};

function buildPlayer() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.7, 18), MAT.hull());
  body.position.y = 0.1; g.add(body);
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.28, 1.4, 0.3), MAT.darkhull());
  spine.position.y = -0.15; g.add(spine);
  // wings
  const wingGeo = new THREE.BoxGeometry(1.5, 0.5, 0.14);
  const wing = new THREE.Mesh(wingGeo, MAT.darkhull());
  wing.position.set(0, -0.35, 0); g.add(wing);
  const wingTipL = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.7, 8), MAT.glowCyan());
  wingTipL.rotation.z = Math.PI / 2; wingTipL.position.set(-0.9, -0.35, 0); g.add(wingTipL);
  const wingTipR = wingTipL.clone(); wingTipR.rotation.z = -Math.PI / 2; wingTipR.position.x = 0.9; g.add(wingTipR);
  // cockpit
  const cock = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), MAT.glowCyan());
  cock.position.set(0, 0.35, 0.18); g.add(cock);
  // engines
  const eGeo = new THREE.CylinderGeometry(0.16, 0.20, 0.5, 12);
  const eL = new THREE.Mesh(eGeo, MAT.darkhull()); eL.position.set(-0.32, -0.85, 0); g.add(eL);
  const eR = eL.clone(); eR.position.x = 0.32; g.add(eR);
  const glowGeo = new THREE.SphereGeometry(0.15, 12, 12);
  const gL = new THREE.Mesh(glowGeo, MAT.glowCyan()); gL.position.set(-0.32, -1.05, 0); g.add(gL);
  const gR = gL.clone(); gR.position.x = 0.32; g.add(gR);
  const eLight = new THREE.PointLight(0x35e8ff, 2, 6, 2); eLight.position.set(0, -1.1, 0.5); g.add(eLight);
  g.userData.engines = [gL, gR]; g.userData.eLight = eLight;
  g.scale.setScalar(0.92);
  return g;
}

function buildEnemy(type) {
  const g = new THREE.Group();
  if (type === 'drone') {
    const b = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), MAT.enemy(0x6a2b3a));
    g.add(b);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), MAT.glowRed()); core.position.z = 0.2; g.add(core);
  } else if (type === 'interceptor') {
    const b = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.4, 14), MAT.enemy(0x7a3a2a));
    b.rotation.x = Math.PI; g.add(b);
    const w = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.36, 0.12), MAT.darkhull()); w.position.y = 0.25; g.add(w);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), MAT.glowAmber()); core.position.y = -0.2; g.add(core);
  } else if (type === 'gunship') {
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 0.6), MAT.enemy(0x55405a)); g.add(b);
    const podGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.9, 12);
    const pL = new THREE.Mesh(podGeo, MAT.darkhull()); pL.rotation.x = Math.PI/2; pL.position.set(-0.85, 0, 0); g.add(pL);
    const pR = pL.clone(); pR.position.x = 0.85; g.add(pR);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), MAT.glowPurp()); core.position.z = 0.35; g.add(core);
  } else if (type === 'mine') {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), MAT.enemy(0x5a5a2a)); g.add(b);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 12), MAT.glowRed()); g.add(core);
    g.userData.core = core;
  } else if (type === 'weaver') {
    const b = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), MAT.enemy(0x2a5a55)); b.scale.set(0.7,1.3,0.7); g.add(b);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), MAT.glowCyan()); g.add(core);
  }
  return g;
}

function buildBoss(kind) {
  const g = new THREE.Group();
  if (kind === 1) { // Hive Carrier
    const b = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.0, 1.0), MAT.enemy(0x5a2b3a)); g.add(b);
    const bay = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.8, 1.2), MAT.darkhull()); bay.position.y = -0.7; g.add(bay);
    for (const x of [-1.6, 1.6]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.4,1.6,14), MAT.darkhull()); p.rotation.x=Math.PI/2; p.position.set(x,0.4,0); g.add(p); }
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.6,20,20), MAT.glowRed()); core.position.z=0.5; g.add(core); g.userData.core=core;
  } else if (kind === 2) { // Lance Reaver
    const b = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.4, 6), MAT.enemy(0x7a3320)); b.rotation.x=Math.PI; g.add(b);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6,0.22,10,28), MAT.glowAmber()); ring.rotation.x=Math.PI/2; g.add(ring);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.5,20,20), MAT.glowAmber()); core.position.y=-0.4; g.add(core); g.userData.core=core;
  } else { // Scourge Sovereign
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(2.0, 1), MAT.enemy(0x3a2b5a)); g.add(b);
    const shell = new THREE.Mesh(new THREE.TorusKnotGeometry(2.2,0.18,80,10,2,3), MAT.glowPurp()); g.add(shell); g.userData.shell=shell;
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.8,24,24), MAT.glowPurp()); core.position.z=0.4; g.add(core); g.userData.core=core;
  }
  return g;
}

/* ----------------------------------------------------------------------------
 * 6. Bullet / pickup shared glow meshes (pooled)
 * -------------------------------------------------------------------------- */
function bulletMesh(color, len = 0.7, rad = 0.12) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(rad, rad * 0.6, len, 8),
    new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false })
  );
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(rad * 2.0, 8, 8),
    new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.35, depthWrite: false })
  );
  m.add(halo);
  return m;
}

/* ----------------------------------------------------------------------------
 * 7. GPU particle system
 * -------------------------------------------------------------------------- */
class Particles {
  constructor(scene, capacity) {
    this.N = capacity; this.head = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.N * 3);
    this.col = new Float32Array(this.N * 3);
    this.size = new Float32Array(this.N);
    this.alpha = new Float32Array(this.N);
    this.vx = new Float32Array(this.N); this.vy = new Float32Array(this.N);
    this.life = new Float32Array(this.N); this.mlife = new Float32Array(this.N);
    this.drag = new Float32Array(this.N); this.grow = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.pos[i*3+2] = 0.5;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aColor',  new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('size',    new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('alpha',   new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: Math.min(window.devicePixelRatio || 1, 2) } },
      vertexShader: `
        attribute vec3 aColor; attribute float size; attribute float alpha;
        varying vec3 vC; varying float vA; uniform float uScale;
        void main(){ vC=aColor; vA=alpha;
          vec4 mv=modelViewMatrix*vec4(position,1.0);
          gl_Position=projectionMatrix*mv;
          gl_PointSize=size*uScale; }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main(){ vec2 c=gl_PointCoord-0.5; float d=length(c);
          float a=smoothstep(0.5,0.0,d); gl_FragColor=vec4(vC, a*vA); }`
    });
    this.points = new THREE.Points(g, mat); this.points.frustumCulled = false;
    this.points.renderOrder = 5; scene.add(this.points);
    this.geo = g;
  }
  emit(x, y, color, { count = 8, speed = 6, spread = TAU, dir = 0, size = 18, life = 0.6, drag = 3, grow = 0 } = {}) {
    const c = new THREE.Color(color);
    for (let k = 0; k < count; k++) {
      const i = this.head; this.head = (this.head + 1) % this.N;
      const a = dir + rand(-spread/2, spread/2); const sp = speed * rand(0.4, 1);
      this.pos[i*3] = x; this.pos[i*3+1] = y;
      this.vx[i] = Math.cos(a) * sp; this.vy[i] = Math.sin(a) * sp;
      this.col[i*3] = c.r; this.col[i*3+1] = c.g; this.col[i*3+2] = c.b;
      this.size[i] = size * rand(0.6, 1.2); this.alpha[i] = 1;
      this.life[i] = this.mlife[i] = life * rand(0.6, 1.1);
      this.drag[i] = drag; this.grow[i] = grow;
    }
  }
  update(dt) {
    for (let i = 0; i < this.N; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const f = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= f; this.vy[i] *= f;
      this.pos[i*3] += this.vx[i] * dt; this.pos[i*3+1] += this.vy[i] * dt;
      const lr = clamp(this.life[i] / this.mlife[i], 0, 1);
      this.alpha[i] = lr; this.size[i] += this.grow[i] * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
}

/* ----------------------------------------------------------------------------
 * 8. Shockwave rings (pooled)
 * -------------------------------------------------------------------------- */
class Rings {
  constructor(scene) { this.scene = scene; this.pool = []; this.active = []; }
  spawn(x, y, color, maxR = 3, dur = 0.5) {
    let r = this.pool.pop();
    if (!r) {
      r = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      this.scene.add(r);
    }
    r.material.color.set(color); r.position.set(x, y, 0.4); r.scale.setScalar(0.1); r.visible = true;
    r.userData = { t: 0, dur, maxR }; this.active.push(r);
  }
  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const r = this.active[i]; const u = r.userData; u.t += dt;
      const k = u.t / u.dur;
      if (k >= 1) { r.visible = false; this.active.splice(i, 1); this.pool.push(r); continue; }
      r.scale.setScalar(0.1 + k * u.maxR); r.material.opacity = (1 - k) * 0.8;
    }
  }
}

/* ----------------------------------------------------------------------------
 * 9. Wave definitions
 * -------------------------------------------------------------------------- */
// group: { type, count, every, delay, from ('top'|'left'|'right'), pattern }
const WAVES = [
  { name: 'RECON SWARM',     groups: [ { type:'drone', count:8, every:0.6, delay:0.5 } ] },
  { name: 'FLANKERS',        groups: [ { type:'drone', count:6, every:0.5 }, { type:'interceptor', count:3, every:1.2, delay:2 } ] },
  { name: 'GUN LINE',        groups: [ { type:'gunship', count:2, every:2.0, delay:0.5 }, { type:'drone', count:6, every:0.6, delay:1 } ] },
  { boss: 1, name: 'HIVE CARRIER' },
  { name: 'MINEFIELD',       groups: [ { type:'mine', count:6, every:0.9 }, { type:'weaver', count:4, every:1.1, delay:1.5 } ] },
  { name: 'INTERCEPT WING',  groups: [ { type:'interceptor', count:8, every:0.7 }, { type:'gunship', count:2, every:2.5, delay:2 } ] },
  { name: 'HEAVY ASSAULT',   groups: [ { type:'gunship', count:3, every:1.6 }, { type:'weaver', count:5, every:0.8, delay:1 }, { type:'drone', count:8, every:0.5, delay:2 } ] },
  { boss: 2, name: 'LANCE REAVER' },
  { name: 'STORM FRONT',     groups: [ { type:'weaver', count:8, every:0.55 }, { type:'mine', count:6, every:1.0, delay:1 } ] },
  { name: 'VANGUARD',        groups: [ { type:'interceptor', count:10, every:0.55 }, { type:'gunship', count:3, every:2.0, delay:2 } ] },
  { name: 'FINAL LEGION',    groups: [ { type:'gunship', count:4, every:1.4 }, { type:'weaver', count:8, every:0.6, delay:1 }, { type:'interceptor', count:8, every:0.6, delay:2 }, { type:'mine', count:6, every:1.2, delay:3 } ] },
  { boss: 3, name: 'SCOURGE SOVEREIGN' },
];

const ENEMY_BASE = {
  drone:       { hp: 12, r: 0.55, value: 10,  score: 60,  speed: 3.4, fire: 2.6, contact: 12 },
  interceptor: { hp: 16, r: 0.55, value: 16,  score: 100, speed: 8.0, fire: 1.8, contact: 14 },
  gunship:     { hp: 52, r: 0.95, value: 34,  score: 200, speed: 2.0, fire: 1.5, contact: 18 },
  mine:        { hp: 8,  r: 0.6,  value: 12,  score: 80,  speed: 2.6, fire: 0,   contact: 26 },
  weaver:      { hp: 20, r: 0.6,  value: 20,  score: 130, speed: 4.2, fire: 0.9, contact: 12 },
};

/* ----------------------------------------------------------------------------
 * 10. The Game
 * -------------------------------------------------------------------------- */
class Game {
  constructor() {
    this.world = new World($('scene'));
    this.particles = new Particles(this.world.scene, Save.data.particles ? 1300 : 500);
    this.rings = new Rings(this.world.scene);

    // pools
    this.pbullets = []; this.ebullets = []; this.enemies = []; this.pickups = [];
    this.pbulletPool = []; this.ebulletPool = [];

    // player
    this.playerMesh = buildPlayer(); this.playerMesh.visible = false; this.world.scene.add(this.playerMesh);
    // focus visuals
    this.deflector = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.10, 12, 40),
      new THREE.MeshBasicMaterial({ color: 0xb46bff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.deflector.position.z = 0.1; this.world.scene.add(this.deflector);
    this.beamMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 40),
      new THREE.MeshBasicMaterial({ color: 0xc86bff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.beamMesh.position.z = 0.3; this.world.scene.add(this.beamMesh);

    this.state = 'loading';
    this.run = null;
    this.input = { targetX: 0, targetY: -7, dragging: false, lastX: 0, lastY: 0, keys: {}, focusHeld: false };
    this.boss = null; this.bossBar = null;

    this._bindUI();
    this._bindInput();
    this._loop = this._loop.bind(this);
    this.lastT = now();
    requestAnimationFrame(this._loop);
    this._fakeLoad();
  }

  /* ---------- boot / loading ---------- */
  _fakeLoad() {
    const msgs = ['Calibrating thrusters…', 'Charging deflector core…', 'Mapping the Scourge…', 'Spooling weapons…', 'Linking to AEGIS…'];
    let p = 0;
    const bar = $('loadBar'), msg = $('loadMsg');
    const tick = () => {
      p = Math.min(100, p + rand(8, 22));
      bar.style.width = p + '%';
      msg.textContent = msgs[Math.min(msgs.length - 1, Math.floor(p / 22))];
      if (p < 100) setTimeout(tick, rand(120, 300));
      else setTimeout(() => this._toMenu(), 350);
    };
    setTimeout(tick, 300);
  }

  _toMenu() {
    this.state = 'menu';
    $('loading').classList.add('hidden');
    $('menu').classList.remove('hidden');
    $('menuBest').textContent = Save.data.best;
    $('menuWave').textContent = Save.data.bestWave;
  }

  /* ---------- UI wiring ---------- */
  _bindUI() {
    const click = (el, fn) => { if (el) el.addEventListener('click', () => { AUDIO.init(); AUDIO.resume(); AUDIO.ui(); fn(); }); };
    click($('btnPlay'), () => this.startRun());
    click($('btnHow'), () => $('how').classList.remove('hidden'));
    document.querySelectorAll('.close-how').forEach(b => click(b, () => $('how').classList.add('hidden')));
    click($('btnSettings'), () => this._openSettings());
    document.querySelectorAll('.close-settings').forEach(b => click(b, () => $('settings').classList.add('hidden')));
    click($('btnPause'), () => this.pause());
    click($('btnResume'), () => this.resume());
    click($('btnPauseSettings'), () => this._openSettings());
    click($('btnQuit'), () => this.endRun(false, true));
    click($('btnLaunch'), () => this._launchNextWave());
    click($('btnRetry'), () => { $('over').classList.add('hidden'); this.startRun(); });
    click($('btnMenu'), () => { $('over').classList.add('hidden'); this._toMenu(); });

    // settings controls
    const vol = $('setVol'), mus = $('setMusic');
    vol.value = Save.data.vol * 100; mus.value = Save.data.music * 100;
    vol.addEventListener('input', () => { Save.data.vol = vol.value / 100; AUDIO.setVol(Save.data.vol); Save.save(); });
    mus.addEventListener('input', () => { Save.data.music = mus.value / 100; AUDIO.setMusic(Save.data.music); Save.save(); });
    const tgl = (el, key, after) => {
      if (!el) return;
      const set = () => { el.classList.toggle('on', Save.data[key]); el.textContent = Save.data[key] ? 'ON' : 'OFF'; };
      set();
      el.addEventListener('click', () => { AUDIO.ui(); Save.data[key] = !Save.data[key]; set(); Save.save(); if (after) after(); });
    };
    tgl($('setBloom'), 'bloom', () => this.world.setBloom(Save.data.bloom));
    tgl($('setParticles'), 'particles');
    tgl($('setHaptics'), 'haptics');
  }
  _openSettings() { $('settings').classList.remove('hidden'); }

  /* ---------- input ---------- */
  _bindInput() {
    const interactive = t => t && t.closest && t.closest('button,input,.btn,.up-card,.focus-btn,.panel');
    const screenToWorldDelta = (dx, dy) => ({ x: dx / window.innerWidth * (2 * HALF_W), y: -dy / window.innerHeight * (2 * HALF_H) });

    window.addEventListener('pointerdown', e => {
      if (this.state !== 'playing') return;
      if (interactive(e.target)) return;
      this.input.dragging = true; this.input.lastX = e.clientX; this.input.lastY = e.clientY;
    });
    window.addEventListener('pointermove', e => {
      if (!this.input.dragging || this.state !== 'playing') return;
      const d = screenToWorldDelta(e.clientX - this.input.lastX, e.clientY - this.input.lastY);
      this.input.targetX = clamp(this.input.targetX + d.x, -HALF_W + 0.6, HALF_W - 0.6);
      this.input.targetY = clamp(this.input.targetY + d.y, -HALF_H + 1.0, HALF_H * 0.5);
      this.input.lastX = e.clientX; this.input.lastY = e.clientY;
    });
    const stop = () => { this.input.dragging = false; };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);

    // Focus button (pointer hold)
    const fb = $('btnFocus');
    const fon = e => { e.preventDefault(); AUDIO.init(); this.input.focusHeld = true; fb.classList.add('active'); };
    const foff = e => { if (e) e.preventDefault(); this.input.focusHeld = false; fb.classList.remove('active'); };
    fb.addEventListener('pointerdown', fon);
    fb.addEventListener('pointerup', foff);
    fb.addEventListener('pointerleave', foff);
    fb.addEventListener('pointercancel', foff);

    // keyboard
    window.addEventListener('keydown', e => {
      this.input.keys[e.key.toLowerCase()] = true;
      if (e.key === ' ' || e.key === 'Shift') this.input.focusHeld = true;
      if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
        if (this.state === 'playing') this.pause(); else if (this.state === 'paused') this.resume();
      }
    });
    window.addEventListener('keyup', e => {
      this.input.keys[e.key.toLowerCase()] = false;
      if (e.key === ' ' || e.key === 'Shift') this.input.focusHeld = false;
    });
  }

  /* ---------- run lifecycle ---------- */
  startRun() {
    AUDIO.init(); AUDIO.resume(); AUDIO.startMusic();
    this.runId = (this.runId || 0) + 1;
    this.run = {
      score: 0, salvage: 0, kills: 0, wave: 0, endless: false,
      upgrades: {},
      hull: 100, maxHull: 100, shield: 60, maxShield: 60, focus: 100, focusMax: 100,
      lastHit: -99, invuln: 0,
      overcharge: 0, spread: 0,
      fireT: 0,
    };
    this._applyStats(true);
    this.input.targetX = 0; this.input.targetY = -7;
    this.playerMesh.position.set(0, -7, 0); this.playerMesh.visible = true;
    this._clearEntities();
    ['menu','how','settings','pause','shop','over'].forEach(id => $(id).classList.add('hidden'));
    $('hud').classList.remove('hidden');
    this.state = 'playing';
    this._startWave(1);
  }

  _applyStats(resetPools = false) {
    const r = this.run; const L = id => r.upgrades[id] || 0;
    r.maxHull = 100 + 25 * L('hull');
    r.maxShield = 60 + 20 * L('shieldcap');
    r.focusMax = 100 + 20 * L('focuscap');
    r.shieldRegenDelay = 4 - 0.5 * L('shieldregen');
    r.shieldRegenRate = 18 + 6 * L('shieldregen');
    r.focusRegen = 12 + 3 * L('focuscap');
    r.damageMul = 1 + 0.18 * L('damage');
    r.fireInterval = 0.24 / (1 + 0.16 * L('firerate'));
    r.multishot = L('multishot');
    r.moveSpeed = 22 + 4 * L('speed');
    r.magnet = 2.4 + 1.2 * L('magnet');
    if (resetPools) { r.hull = r.maxHull; r.shield = r.maxShield; r.focus = r.focusMax; }
    else { r.hull = Math.min(r.maxHull, r.hull + (r._hullBonus || 0)); r._hullBonus = 0; }
  }

  endRun(victory, abandoned = false) {
    this.state = 'over';
    this.playerMesh.visible = false;
    if (this.run.score > Save.data.best) { Save.data.best = this.run.score; }
    if (this.run.wave > Save.data.bestWave) { Save.data.bestWave = this.run.wave; }
    Save.save();
    $('hud').classList.add('hidden');
    $('over').classList.remove('hidden');
    $('overTitle').textContent = abandoned ? 'RUN ABANDONED' : (victory ? 'STATION SECURED' : 'LANCE-7 DOWN');
    $('ovScore').textContent = this.run.score;
    $('ovWave').textContent = this.run.wave;
    $('ovKills').textContent = this.run.kills;
    $('ovBest').textContent = Save.data.best;
    const newRec = this.run.score >= Save.data.best && this.run.score > 0;
    $('ovNew').classList.toggle('hidden', !newRec);
  }

  pause() { if (this.state !== 'playing') return; this.state = 'paused'; $('pause').classList.remove('hidden'); }
  resume() { if (this.state !== 'paused') return; $('pause').classList.add('hidden'); $('settings').classList.add('hidden'); this.state = 'playing'; this.lastT = now(); }

  /* ---------- waves ---------- */
  _startWave(n) {
    this.run.wave = n;
    $('hudWave').textContent = n;
    const def = this._waveDef(n);
    this.waveDone = false;
    this.spawnQueue = [];
    this.boss = null;
    this.awaitingBoss = false;
    this.spawnedAll = false;
    this.waveClock = 0;
    if (def.boss) {
      this.awaitingBoss = true;
      AUDIO.bossWarn();
      this._banner(def.name, 'BOSS', 0xff4d5e);
      const rid = this.runId, wv = n;
      setTimeout(() => {
        if (this.runId !== rid || this.run.wave !== wv || this.state === 'over') return;
        this.awaitingBoss = false;
        this._spawnBoss(def.boss, def.name);
      }, 1600);
    } else {
      this._banner('WAVE ' + n, def.name, 0x38e6ff);
      // schedule spawns
      let base = 1.6;
      for (const grp of def.groups) {
        const gd = grp.delay || 0;
        for (let i = 0; i < grp.count; i++) {
          this.spawnQueue.push({ t: base + gd + i * (grp.every || 0.6), type: grp.type });
        }
      }
      this.spawnQueue.sort((a, b) => a.t - b.t);
      this.waveClock = 0;
      this.spawnedAll = false;
    }
  }

  _waveDef(n) {
    if (n <= WAVES.length) return WAVES[n - 1];
    // endless: procedurally scale
    const types = ['drone','interceptor','gunship','weaver','mine'];
    if (n % 4 === 0) return { boss: ((n / 4) % 3) + 1 || 3, name: 'ENDLESS TERROR' };
    const groups = [];
    const kinds = randi(2, 3);
    for (let i = 0; i < kinds; i++) groups.push({ type: pick(types), count: randi(6, 12), every: rand(0.4, 0.8), delay: i * 1.4 });
    return { name: 'ENDLESS ' + (n - WAVES.length), groups };
  }

  _diffMul() { const n = this.run.wave; return 1 + (n - 1) * 0.13 + (this.run.endless ? (n - WAVES.length) * 0.05 : 0); }

  _updateSpawns(dt) {
    if (this.boss || this.awaitingBoss) return; // boss waves handled by boss
    this.waveClock += dt;
    while (this.spawnQueue.length && this.spawnQueue[0].t <= this.waveClock) {
      const s = this.spawnQueue.shift();
      this._spawnEnemy(s.type);
    }
    if (!this.spawnQueue.length) this.spawnedAll = true;
    if (this.spawnedAll && this.enemies.length === 0 && !this.waveDone) {
      this.waveDone = true;
      const rid = this.runId, wv = this.run.wave;
      setTimeout(() => { if (this.runId === rid && this.run.wave === wv && this.state === 'playing') this._waveCleared(); }, 700);
    }
  }

  _waveCleared() {
    if (this.state === 'over') return;
    if (this.run.wave >= WAVES.length && !this.run.endless) {
      // victory → go endless
      this.run.endless = true;
      this._banner('STATION SECURED', 'ENDLESS UNLOCKED', 0x57e08a);
      this._openShop();
    } else {
      this._openShop();
    }
  }

  /* ---------- shop ---------- */
  _openShop() {
    this.state = 'shop';
    $('hud').classList.add('hidden');
    $('shop').classList.remove('hidden');
    $('shopNextWave').textContent = this.run.wave + 1;
    this._renderShop();
  }
  _renderShop() {
    $('shopSalvage').textContent = this.run.salvage;
    const grid = $('shopGrid'); grid.innerHTML = '';
    for (const u of UPGRADES) {
      const lvl = this.run.upgrades[u.id] || 0;
      const maxed = lvl >= u.max;
      const cost = upCost(u, lvl);
      const can = !maxed && this.run.salvage >= cost;
      const card = document.createElement('div');
      card.className = 'up-card' + (maxed ? ' max' : '');
      let pips = '';
      for (let i = 0; i < u.max; i++) pips += `<span class="pip ${i < lvl ? 'on' : ''}"></span>`;
      card.innerHTML = `
        <div class="up-name">${u.name}<span>${lvl}/${u.max}</span></div>
        <div class="up-desc">${u.desc}</div>
        <div class="up-foot"><div class="up-pips">${pips}</div>
          <div class="up-cost ${maxed ? '' : (can ? 'can' : 'cant')}">${maxed ? 'MAX' : cost + ' ⬡'}</div></div>`;
      if (!maxed) card.addEventListener('click', () => {
        const c = upCost(u, this.run.upgrades[u.id] || 0);
        if (this.run.salvage >= c) {
          this.run.salvage -= c;
          this.run.upgrades[u.id] = (this.run.upgrades[u.id] || 0) + 1;
          if (u.id === 'hull') this.run._hullBonus = (this.run._hullBonus || 0) + 25;
          AUDIO.pickup(); this._applyStats(false); this._renderShop();
        } else { AUDIO.hit(); }
      });
      grid.appendChild(card);
    }
  }
  _launchNextWave() {
    $('shop').classList.add('hidden');
    $('hud').classList.remove('hidden');
    this.state = 'playing'; this.lastT = now();
    this._startWave(this.run.wave + 1);
  }

  /* ---------- spawning enemies ---------- */
  _spawnEnemy(type) {
    const base = ENEMY_BASE[type];
    const mesh = buildEnemy(type);
    const x = rand(-HALF_W + 1, HALF_W - 1);
    mesh.position.set(x, HALF_H + 1.5, 0);
    this.world.scene.add(mesh);
    const mul = this._diffMul();
    const e = {
      type, mesh, x, y: HALF_H + 1.5, r: base.r,
      hp: base.hp * mul, maxhp: base.hp * mul, value: base.value, score: base.score,
      speed: base.speed, fireRate: base.fire, contact: base.contact,
      fireT: rand(0.6, base.fire || 1.5), phase: rand(0, TAU), enterY: rand(HALF_H - 3, HALF_H - 6),
      baseX: x, alive: true, boss: false, hitFlash: 0,
    };
    this.enemies.push(e);
    return e;
  }

  _spawnBoss(kind, name) {
    const mesh = buildBoss(kind);
    mesh.position.set(0, HALF_H + 3, 0); this.world.scene.add(mesh);
    const mul = this._diffMul();
    const hp = [900, 1500, 2400][kind - 1] * (this.run.endless ? this._diffMul() : 1);
    const b = {
      kind, name, mesh, x: 0, y: HALF_H + 3, r: [2.4, 2.0, 2.6][kind - 1],
      hp, maxhp: hp, value: 260 * kind, score: 2500 * kind, boss: true, alive: true,
      phase: 0, t: 0, fireT: 1.2, dir: 1, contact: 30, hitFlash: 0, spawnT: 0, sub: 0,
    };
    this.boss = b; this.enemies.push(b);
    this._makeBossBar(name);
  }

  _makeBossBar(name) {
    if (!this.bossBar) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:absolute;top:calc(env(safe-area-inset-top,0) + 62px);left:8%;right:8%;pointer-events:none;';
      wrap.innerHTML = `<div style="text-align:center;letter-spacing:.24em;color:#ff8a9a;font-size:12px;margin-bottom:4px" id="bossName"></div>
        <div style="height:10px;border-radius:6px;background:rgba(255,255,255,.08);border:1px solid rgba(255,80,100,.4);overflow:hidden">
        <div id="bossFill" style="height:100%;width:100%;background:linear-gradient(90deg,#ff4d5e,#ffb547);box-shadow:0 0 12px rgba(255,80,90,.6)"></div></div>`;
      $('hud').appendChild(wrap); this.bossBar = wrap;
    }
    this.bossBar.style.display = 'block';
    $('bossName').textContent = name;
    $('bossFill').style.width = '100%';
  }
  _hideBossBar() { if (this.bossBar) this.bossBar.style.display = 'none'; }

  /* ---------- projectiles ---------- */
  _getPB() { let m = this.pbulletPool.pop(); if (!m) { m = bulletMesh(0x9ff4ff, 0.8, 0.11); this.world.scene.add(m); } m.visible = true; return m; }
  _getEB(color) { let m = this.ebulletPool.pop(); if (!m) { m = bulletMesh(color, 0.5, 0.14); this.world.scene.add(m); } m.material.color.set(color); m.children[0].material.color.set(color); m.visible = true; return m; }

  _firePlayer() {
    const r = this.run; const px = this.playerMesh.position.x, py = this.playerMesh.position.y;
    const dmg = 9 * r.damageMul;
    const shots = [];
    shots.push({ ax: 0 });
    for (let i = 1; i <= r.multishot; i++) { shots.push({ ax: -i * 0.16 }); shots.push({ ax: i * 0.16 }); }
    if (r.spread > 0) { shots.push({ ax: -0.34 }); shots.push({ ax: 0.34 }); }
    for (const s of shots) {
      const m = this._getPB(); m.position.set(px + s.ax * 2, py + 0.8, 0.2); m.rotation.z = -s.ax;
      this.pbullets.push({ mesh: m, x: m.position.x, y: m.position.y, vx: s.ax * 10, vy: 34, dmg, r: 0.25 });
    }
    AUDIO.laser();
    this.particles.emit(px, py + 0.9, 0x9ff4ff, { count: 2, speed: 3, size: 10, life: 0.2, dir: Math.PI/2, spread: 0.6 });
  }

  _spawnEB(x, y, angle, speed, color = 0xff7a3c, dmg = 10) {
    const m = this._getEB(color); m.position.set(x, y, 0.2); m.rotation.z = angle - Math.PI/2;
    this.ebullets.push({ mesh: m, x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, dmg, r: 0.22 });
  }

  /* ---------- explosions & damage ---------- */
  _explode(x, y, color, scale = 1) {
    this.particles.emit(x, y, color, { count: Math.floor(18 * scale), speed: 9 * scale, size: 26 * scale, life: 0.7, drag: 3, grow: 6 });
    this.particles.emit(x, y, 0xffffff, { count: 6, speed: 5, size: 16, life: 0.3 });
    this.rings.spawn(x, y, color, 2.6 * scale, 0.5);
    this.world.addShake(0.28 * scale);
    AUDIO.explosion(scale);
    this._flash(0.3 * scale);
  }
  _flash(a) { const f = $('flash'); f.style.opacity = Math.min(0.8, a); setTimeout(() => f.style.opacity = 0, 60); }

  _damageEnemy(e, dmg) {
    e.hp -= dmg; e.hitFlash = 0.08;
    if (e.hp <= 0 && e.alive) this._killEnemy(e);
  }
  _killEnemy(e) {
    e.alive = false;
    const color = e.boss ? 0xff4d5e : (e.type === 'weaver' ? 0x38e6ff : 0xff7a3c);
    this._explode(e.x, e.y, color, e.boss ? 2.4 : (e.type === 'gunship' ? 1.3 : 0.9));
    this.run.kills++; this.run.score += e.score; this.run.salvage += e.value;
    if (Math.random() < (e.boss ? 1 : (e.type === 'gunship' ? 0.35 : 0.12))) this._dropPickup(e.x, e.y, e.boss);
    if (e.boss) {
      this.boss = null; this._hideBossBar();
      // multiple secondary blasts
      for (let i = 0; i < 6; i++) setTimeout(() => { if (this.state === 'playing') this._explode(e.x + rand(-2,2), e.y + rand(-2,2), 0xffb547, 1.2); }, i * 90);
      this.waveDone = true;
      const rid = this.runId, wv = this.run.wave;
      setTimeout(() => { if (this.runId === rid && this.run.wave === wv && this.state === 'playing') this._waveCleared(); }, 1400);
    }
    this._removeEnemy(e);
  }
  _removeEnemy(e) {
    this.world.scene.remove(e.mesh);
    e.mesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { Array.isArray(o.material) ? o.material.forEach(m => m.dispose()) : o.material.dispose(); }
    });
    const i = this.enemies.indexOf(e); if (i >= 0) this.enemies.splice(i, 1);
  }

  _damagePlayer(dmg) {
    const r = this.run;
    if (r.invuln > 0) return;
    r.lastHit = now();
    if (r.shield > 0) {
      r.shield -= dmg;
      if (r.shield < 0) { r.hull += r.shield; r.shield = 0; }
      this.particles.emit(this.playerMesh.position.x, this.playerMesh.position.y, 0x38e6ff, { count: 10, speed: 7, size: 18, life: 0.4 });
    } else {
      r.hull -= dmg;
      this.particles.emit(this.playerMesh.position.x, this.playerMesh.position.y, 0xff6a5f, { count: 12, speed: 8, size: 20, life: 0.45 });
    }
    r.invuln = 0.5;
    this.world.addShake(0.4); this._flash(0.4); AUDIO.playerHit();
    if (Save.data.haptics && navigator.vibrate) navigator.vibrate(40);
    if (r.hull <= 0) { r.hull = 0; this._explode(this.playerMesh.position.x, this.playerMesh.position.y, 0x38e6ff, 2.2); this.endRun(false); }
  }

  _dropPickup(x, y, boss) {
    const kinds = boss
      ? ['repair','shield','overcharge','spread','focus']
      : ['repair','shield','overcharge','spread','focus'];
    const kind = pick(kinds);
    const colors = { repair: 0x57e08a, shield: 0x38e6ff, overcharge: 0xffb547, spread: 0xff7ad0, focus: 0xb46bff };
    const glyphMat = new THREE.MeshStandardMaterial({ color: 0x111820, emissive: colors[kind], emissiveIntensity: 2.0, metalness: 0.4, roughness: 0.3 });
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), glyphMat);
    mesh.position.set(x, y, 0.2); this.world.scene.add(mesh);
    this.pickups.push({ kind, mesh, x, y, vy: -2.2, r: 0.5, color: colors[kind], spin: rand(1, 3) });
  }
  _collectPickup(p) {
    const r = this.run; let label = '';
    if (p.kind === 'repair') { r.hull = Math.min(r.maxHull, r.hull + 30); label = '+30 HULL'; }
    else if (p.kind === 'shield') { r.shield = r.maxShield; label = 'SHIELD RESTORED'; }
    else if (p.kind === 'overcharge') { r.overcharge = 8; label = 'OVERCHARGE'; }
    else if (p.kind === 'spread') { r.spread = 8; label = 'SPREAD GUNS'; }
    else if (p.kind === 'focus') { r.focus = r.focusMax; label = 'FOCUS FULL'; }
    this._toast(label, p.color);
    this.particles.emit(p.x, p.y, p.color, { count: 14, speed: 8, size: 20, life: 0.5 });
    AUDIO.pickup();
    this.world.scene.remove(p.mesh); p.mesh.geometry.dispose();
    const i = this.pickups.indexOf(p); if (i >= 0) this.pickups.splice(i, 1);
  }

  /* ---------- UI helpers ---------- */
  _banner(main, sub, color) {
    const b = $('banner');
    b.innerHTML = `${main}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    b.style.color = '#eafaff';
    b.classList.remove('hidden'); b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }
  _toast(text, color) {
    const wrap = $('toast'); const t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
    if (color) t.style.borderColor = '#' + new THREE.Color(color).getHexString();
    wrap.appendChild(t); setTimeout(() => t.remove(), 1500);
  }

  _clearEntities() {
    for (const e of this.enemies.slice()) this._removeEnemy(e);
    for (const b of this.pbullets) { b.mesh.visible = false; this.pbulletPool.push(b.mesh); }
    for (const b of this.ebullets) { b.mesh.visible = false; this.ebulletPool.push(b.mesh); }
    for (const p of this.pickups) { this.world.scene.remove(p.mesh); }
    this.enemies.length = 0; this.pbullets.length = 0; this.ebullets.length = 0; this.pickups.length = 0;
    this.boss = null; this._hideBossBar();
  }

  /* ---------- main loop ---------- */
  _loop() {
    requestAnimationFrame(this._loop);
    const t = now();
    let dt = t - this.lastT; this.lastT = t;
    dt = Math.min(dt, 0.05); // clamp

    if (this.state === 'playing') this._step(dt, t);

    // world visuals always animate a bit (menu/loading nice)
    this.world.update(dt, t);
    // idle animation for focus visuals
    this.deflector.position.copy(this.playerMesh.position);
    this.world.render();
  }

  _step(dt, t) {
    const r = this.run;
    // focus logic
    const wantFocus = this.input.focusHeld && r.focus > 1;
    const focusing = wantFocus;
    const eScale = focusing ? 0.35 : 1;      // enemy/bullet time scale
    const edt = dt * eScale;

    // resource regen
    if (focusing) { r.focus = Math.max(0, r.focus - 34 * dt); }
    else { r.focus = Math.min(r.focusMax, r.focus + r.focusRegen * dt); }
    if (t - r.lastHit > r.shieldRegenDelay) r.shield = Math.min(r.maxShield, r.shield + r.shieldRegenRate * dt);
    if (r.invuln > 0) r.invuln -= dt;
    if (r.overcharge > 0) r.overcharge -= dt;
    if (r.spread > 0) r.spread -= dt;
    $('btnFocus').classList.toggle('empty', r.focus <= 1);

    // player movement
    let tx = this.input.targetX, ty = this.input.targetY;
    const k = this.input.keys;
    const kv = r.moveSpeed;
    if (k['a'] || k['arrowleft'])  { tx -= kv * dt; }
    if (k['d'] || k['arrowright']) { tx += kv * dt; }
    if (k['w'] || k['arrowup'])    { ty += kv * dt; }
    if (k['s'] || k['arrowdown'])  { ty -= kv * dt; }
    tx = clamp(tx, -HALF_W + 0.6, HALF_W - 0.6);
    ty = clamp(ty, -HALF_H + 1.0, HALF_H * 0.5);
    this.input.targetX = tx; this.input.targetY = ty;
    const pm = this.playerMesh;
    pm.position.x = lerp(pm.position.x, tx, Math.min(1, dt * 14));
    pm.position.y = lerp(pm.position.y, ty, Math.min(1, dt * 14));
    // bank/tilt
    const vx = tx - pm.position.x;
    pm.rotation.z = clamp(-vx * 0.6, -0.5, 0.5);
    pm.rotation.y = clamp(vx * 0.3, -0.3, 0.3);
    // engine flicker
    const flick = 0.8 + Math.sin(t * 40) * 0.2;
    if (pm.userData.eLight) pm.userData.eLight.intensity = 2 * flick;
    pm.userData.engines.forEach(e => e.scale.setScalar(flick));
    this.particles.emit(pm.position.x, pm.position.y - 1.0, 0x35e8ff, { count: 1, speed: 4, dir: -Math.PI/2, spread: 0.4, size: 12, life: 0.25 });

    // FOCUS: deflector + beam
    if (focusing) {
      this.deflector.material.opacity = lerp(this.deflector.material.opacity, 0.85, dt * 10);
      this.deflector.scale.setScalar(1 + Math.sin(t * 12) * 0.05);
      this.deflector.rotation.z += dt * 3;
      // beam
      this.beamMesh.material.opacity = lerp(this.beamMesh.material.opacity, 0.7, dt * 12);
      this.beamMesh.position.set(pm.position.x, pm.position.y + 20, 0.3);
      this.beamMesh.scale.x = 1 + Math.sin(t * 30) * 0.2;
      // beam damage: enemies within column
      const beamDPS = 60 * r.damageMul;
      for (const e of this.enemies) {
        if (Math.abs(e.x - pm.position.x) < 0.6 + e.r && e.y > pm.position.y) {
          this._damageEnemy(e, beamDPS * dt);
          if (Math.random() < 0.3) this.particles.emit(e.x, e.y, 0xc86bff, { count: 2, speed: 6, size: 16, life: 0.3 });
        }
      }
      if (Math.random() < 0.14) AUDIO.beam();
    } else {
      this.deflector.material.opacity = lerp(this.deflector.material.opacity, 0, dt * 12);
      this.beamMesh.material.opacity = lerp(this.beamMesh.material.opacity, 0, dt * 14);
      // normal auto-fire
      r.fireT -= dt;
      const interval = r.fireInterval * (r.overcharge > 0 ? 0.5 : 1);
      if (r.fireT <= 0) { r.fireT = interval; this._firePlayer(); }
    }

    // deflector destroys enemy bullets
    if (focusing) {
      const dr = 1.6 * this.deflector.scale.x;
      for (let i = this.ebullets.length - 1; i >= 0; i--) {
        const b = this.ebullets[i];
        const dx = b.x - pm.position.x, dy = b.y - pm.position.y;
        if (dx*dx + dy*dy < (dr + b.r) * (dr + b.r)) {
          this.particles.emit(b.x, b.y, 0xb46bff, { count: 4, speed: 6, size: 14, life: 0.25 });
          b.mesh.visible = false; this.ebulletPool.push(b.mesh); this.ebullets.splice(i, 1);
        }
      }
    }

    // update spawns / boss
    if (this.boss) this._updateBoss(this.boss, edt, dt, t);
    else this._updateSpawns(edt);

    // update enemies
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]; if (e.boss) continue;
      this._updateEnemy(e, edt, dt, t);
    }

    // update player bullets (real dt)
    for (let i = this.pbullets.length - 1; i >= 0; i--) {
      const b = this.pbullets[i]; b.x += b.vx * dt; b.y += b.vy * dt;
      b.mesh.position.set(b.x, b.y, 0.2);
      if (b.y > HALF_H + 2) { b.mesh.visible = false; this.pbulletPool.push(b.mesh); this.pbullets.splice(i, 1); continue; }
      // collide with enemies
      for (const e of this.enemies) {
        const dx = b.x - e.x, dy = b.y - e.y; const rr = e.r + b.r;
        if (dx*dx + dy*dy < rr*rr) {
          this._damageEnemy(e, b.dmg);
          this.particles.emit(b.x, b.y, 0xffffff, { count: 3, speed: 5, size: 12, life: 0.2 });
          AUDIO.hit();
          b.mesh.visible = false; this.pbulletPool.push(b.mesh); this.pbullets.splice(i, 1);
          break;
        }
      }
    }

    // update enemy bullets (scaled dt)
    for (let i = this.ebullets.length - 1; i >= 0; i--) {
      const b = this.ebullets[i]; b.x += b.vx * edt; b.y += b.vy * edt;
      b.mesh.position.set(b.x, b.y, 0.2);
      if (b.y < -HALF_H - 2 || b.y > HALF_H + 4 || b.x < -HALF_W - 3 || b.x > HALF_W + 3) {
        b.mesh.visible = false; this.ebulletPool.push(b.mesh); this.ebullets.splice(i, 1); continue;
      }
      const dx = b.x - pm.position.x, dy = b.y - pm.position.y; const rr = 0.5 + b.r;
      if (dx*dx + dy*dy < rr*rr) {
        this._damagePlayer(b.dmg);
        b.mesh.visible = false; this.ebulletPool.push(b.mesh); this.ebullets.splice(i, 1);
      }
    }

    // pickups
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      const dx = pm.position.x - p.x, dy = pm.position.y - p.y; const dist = Math.hypot(dx, dy);
      if (dist < r.magnet) { const s = (r.magnet - dist) / r.magnet; p.x += dx / dist * 12 * s * dt; p.y += dy / dist * 12 * s * dt; }
      p.y += p.vy * dt * (dist < r.magnet ? 0.2 : 1);
      p.mesh.position.set(p.x, p.y, 0.2); p.mesh.rotation.x += p.spin * dt; p.mesh.rotation.y += p.spin * dt;
      if (dist < 0.7) { this._collectPickup(p); continue; }
      if (p.y < -HALF_H - 2) { this.world.scene.remove(p.mesh); p.mesh.geometry.dispose(); this.pickups.splice(i, 1); }
    }

    this.rings.update(dt);
    this.particles.update(dt);
    this._updateHUD();
  }

  _updateEnemy(e, edt, dt, t) {
    const pm = this.playerMesh;
    // entry then behavior
    if (e.y > e.enterY) { e.y -= e.speed * edt * 1.2; }
    else {
      if (e.type === 'drone') {
        e.y -= e.speed * 0.5 * edt;
        e.x = e.baseX + Math.sin(t * 1.5 + e.phase) * 1.2;
      } else if (e.type === 'interceptor') {
        // dive toward player
        const ang = Math.atan2(pm.position.y - e.y, pm.position.x - e.x);
        e.x += Math.cos(ang) * e.speed * edt; e.y += Math.sin(ang) * e.speed * edt;
      } else if (e.type === 'gunship') {
        e.x = e.baseX + Math.sin(t * 0.8 + e.phase) * 2.5; e.y -= e.speed * 0.15 * edt;
      } else if (e.type === 'mine') {
        e.y -= e.speed * edt; e.x = e.baseX + Math.sin(t * 3 + e.phase) * 0.4;
        if (e.mesh.userData.core) e.mesh.userData.core.scale.setScalar(1 + Math.sin(t * 8) * 0.3);
      } else if (e.type === 'weaver') {
        e.y -= e.speed * 0.4 * edt; e.x = e.baseX + Math.sin(t * 2.4 + e.phase) * 3.0;
      }
    }
    e.mesh.position.set(e.x, e.y, 0);
    e.mesh.rotation.z += edt * (e.type === 'mine' ? 1.2 : 0.4);

    // firing
    if (e.fireRate > 0 && e.y < HALF_H - 1) {
      e.fireT -= edt;
      if (e.fireT <= 0) {
        e.fireT = e.fireRate * rand(0.8, 1.2);
        const ang = Math.atan2(pm.position.y - e.y, pm.position.x - e.x);
        if (e.type === 'gunship') { for (const off of [-0.28, 0, 0.28]) this._spawnEB(e.x, e.y - 0.5, ang + off, 9, 0xb46bff, 12); }
        else if (e.type === 'weaver') { this._spawnEB(e.x, e.y - 0.5, -Math.PI/2, 12, 0x38e6ff, 8); }
        else { this._spawnEB(e.x, e.y - 0.5, ang, 8, 0xff7a3c, 10); }
        AUDIO.enemyLaser();
      }
    }

    // hit flash (brighten emissive parts briefly, then restore to base 2.1)
    if (e.hitFlash > 0) {
      e.hitFlash -= dt;
      e.mesh.traverse(o => { if (o.material && o.material.emissive) o.material.emissiveIntensity = 4.5; });
    } else {
      e.mesh.traverse(o => { if (o.material && o.material.emissive && o.material.emissiveIntensity !== 2.1) o.material.emissiveIntensity = 2.1; });
    }

    // contact with player
    const dx = e.x - pm.position.x, dy = e.y - pm.position.y; const rr = e.r + 0.55;
    if (dx*dx + dy*dy < rr*rr) { this._damagePlayer(e.contact); this._killEnemy(e); return; }

    // off bottom
    if (e.y < -HALF_H - 2) this._removeEnemy(e);
  }

  _updateBoss(b, edt, dt, t) {
    const pm = this.playerMesh;
    b.t += edt; b.spawnT += edt;
    // entry
    const targetY = HALF_H - 3.2;
    if (b.y > targetY) { b.y -= 3 * edt; }
    else {
      // strafe
      b.x += b.dir * (b.kind === 2 ? 3.2 : 1.6) * edt;
      if (b.x > HALF_W - 2) b.dir = -1; if (b.x < -HALF_W + 2) b.dir = 1;
    }
    b.mesh.position.set(b.x, b.y, 0);
    if (b.mesh.userData.shell) b.mesh.userData.shell.rotation.z += dt * 0.6;
    if (b.mesh.userData.core) b.mesh.userData.core.scale.setScalar(1 + Math.sin(t*6)*0.1);
    b.mesh.rotation.z = Math.sin(t*0.6) * 0.1;

    // attacks per boss
    b.fireT -= edt;
    if (b.y <= targetY + 0.2 && b.fireT <= 0) {
      const hpFrac = b.hp / b.maxhp;
      if (b.kind === 1) {
        b.fireT = 1.1;
        const ang = Math.atan2(pm.position.y - b.y, pm.position.x - b.x);
        for (const off of [-0.5,-0.25,0,0.25,0.5]) this._spawnEB(b.x, b.y - 1, ang + off, 8, 0xff7a3c, 12);
        if (this.enemies.length < 8 && Math.random() < 0.6) this._spawnEnemy('drone');
        AUDIO.enemyLaser();
      } else if (b.kind === 2) {
        b.fireT = hpFrac < 0.5 ? 0.9 : 1.3;
        const n = 14; const base = t * 1.5;
        for (let i = 0; i < n; i++) this._spawnEB(b.x, b.y, base + i / n * TAU, 7, 0xffb547, 12);
        AUDIO.enemyLaser();
      } else {
        // sovereign multi-phase
        b.sub = (b.sub + 1) % 3;
        b.fireT = hpFrac < 0.35 ? 0.7 : 1.0;
        if (b.sub === 0) { const n = 18, base = t * 2; for (let i=0;i<n;i++) this._spawnEB(b.x, b.y, base + i/n*TAU, 6.5, 0xb46bff, 12); }
        else if (b.sub === 1) { const ang = Math.atan2(pm.position.y - b.y, pm.position.x - b.x); for (const off of [-0.4,-0.2,0,0.2,0.4]) this._spawnEB(b.x, b.y-1, ang+off, 10, 0xc86bff, 14); if (this.enemies.length<9) this._spawnEnemy('weaver'); }
        else { for (let i=0;i<10;i++) this._spawnEB(b.x, b.y, -Math.PI/2 + (i-4.5)*0.12, 9, 0xff4d5e, 12); }
        AUDIO.enemyLaser();
      }
    }

    // contact
    const dx = b.x - pm.position.x, dy = b.y - pm.position.y; const rr = b.r + 0.55;
    if (dx*dx + dy*dy < rr*rr) this._damagePlayer(b.contact);

    // hit flash / bar
    if (b.hitFlash > 0) b.hitFlash -= dt;
    if (this.bossBar) $('bossFill').style.width = Math.max(0, b.hp / b.maxhp * 100) + '%';
  }

  _updateHUD() {
    const r = this.run;
    $('hudScore').textContent = r.score;
    $('hudSalvage').textContent = r.salvage;
    $('barHull').style.width = clamp(r.hull / r.maxHull * 100, 0, 100) + '%';
    $('barShield').style.width = clamp(r.shield / r.maxShield * 100, 0, 100) + '%';
    $('barFocus').style.width = clamp(r.focus / r.focusMax * 100, 0, 100) + '%';
  }
}

/* ----------------------------------------------------------------------------
 * 11. Boot
 * -------------------------------------------------------------------------- */
function supportsWebGL() {
  try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl'))); }
  catch (e) { return false; }
}

if (!supportsWebGL()) {
  $('loading').classList.add('hidden');
  $('nowebgl').classList.remove('hidden');
} else {
  try {
    window.__GAME = new Game();
  } catch (err) {
    console.error(err);
    $('loading').classList.add('hidden');
    const nw = $('nowebgl'); nw.classList.remove('hidden');
    nw.querySelector('p').textContent = 'Startup error: ' + (err && err.message ? err.message : err);
  }
}
