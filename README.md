# 🚀 ORBITAL SIEGE — *Defend the Last Station*

A **premium, mobile-first 2D space-combat game** built with **Three.js**.
Realistic PBR-lit metallic ships, a procedural nebula shader, real-time bloom,
GPU particle FX, fully procedural WebAudio, and a signature **Focus
(bullet-time deflector)** mechanic — all in a self-contained static web app.

> Pilot **LANCE-7**, the last fighter guarding station **AEGIS** around a dying
> star. Survive 12 waves, defeat 3 colossal bosses, salvage wreckage to upgrade
> your ship, then go **Endless**.

---

## ▶️ Play it

It's a static site — **no build step, no server-side code**.

**Locally** (ES modules need `http://`, not `file://`):

```bash
# from the repo root
python3 -m http.server 8080
# then open http://localhost:8080 on your phone or desktop
```

**Host it** on any static host (GitHub Pages, Netlify, Vercel, S3…): just serve
the repository root. Everything — including Three.js — is vendored under
`vendor/`, so there are **zero external network dependencies**.

---

## 🎮 Controls

| Action | Touch (mobile) | Desktop |
|---|---|---|
| Fly | **Drag** anywhere | Mouse drag · **WASD** · Arrows |
| Fire | Automatic | Automatic |
| **FOCUS** (bullet-time + deflector + beam) | Hold the **◈ FOCUS** button | Hold **Space / Shift** |
| Pause | Pause (II) button | **P / Esc** |
| Collect power-up | Fly into it | same |

---

## ✨ Features

- **Signature FOCUS mechanic** — slow time to 35%, raise a **deflector ring**
  that destroys incoming bullets, and fire a concentrated lance beam. Managed by
  a Focus meter (risk/reward).
- **Realistic look** — procedurally-built **metallic PBR ships** under real
  lights, drifting **fbm nebula**, dying-star glow, parallax starfields, a
  distant planet, **UnrealBloom** glow, GPU point-particle explosions,
  expanding shockwaves, muzzle flashes, damage flashes, **screen shake**.
- **12 hand-tuned waves + 3 multi-phase bosses** (Hive Carrier, Lance Reaver,
  Scourge Sovereign) + procedural **Endless** mode.
- **5 enemy types** with distinct behaviours (drone, interceptor, gunship,
  mine, weaver).
- **Roguelite progression** — earn Salvage, spend it in the **Field Workshop**
  on 9 upgrade tracks between waves. Power-up drops (repair, shield, overcharge,
  spread, focus).
- **Full UX** — animated menu, how-to, settings (volume, music, bloom,
  particles, haptics), pause, boss health bar, wave banners, toasts, game-over
  stats, persistent high score & best wave (`localStorage`).
- **Procedural audio** — lasers, explosions, hits, pickups, UI, and an ambient
  music pad, all synthesized in WebAudio (no audio files).
- **Mobile-first & responsive** — safe-area insets, one-handed play, quality
  toggles for low-end phones, graceful WebGL fallback, capped pixel ratio.

---

## 🗂️ Project structure

```
index.html      # markup, import-map, all UI overlays
style.css       # sci-fi UI (mobile-first, responsive, themable)
game.js         # engine: world, entities, waves, bosses, audio, UI wiring
vendor/         # vendored Three.js r160 (module + only the addons used)
GDD.md          # the Game Design Document this implements
```

## 🛠️ Tech

Three.js (orthographic camera on the XY plane → true 2D with 3D-lit objects),
`EffectComposer` + `UnrealBloomPass` + `OutputPass`, ACES tone-mapping, custom
GLSL nebula & particle shaders, object pooling, WebAudio, `localStorage`.

---

*Built as a complete, distinctive, realistic mobile game. Full design rationale
in [`GDD.md`](./GDD.md).*
