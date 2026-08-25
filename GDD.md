# Game Design Document — **ORBITAL SIEGE**
### *Defend the Last Station*

A premium, mobile-first **2D space combat** game built with **Three.js**, featuring
realistic PBR-lit metallic ships, procedural nebula shaders, real-time bloom,
and a signature **Focus (bullet-time deflector)** mechanic.

---

## 1. High Concept

You are the pilot of **LANCE‑7**, the last defense fighter guarding the orbital
station **AEGIS** as it drifts around a dying star. A machine swarm — *the Scourge* —
attacks in escalating waves. Survive, defeat three colossal bosses, and salvage
wreckage to upgrade your ship in the field.

> **One line:** A juicy, realistic 2D space survivor-shooter for phones, where
> slowing time turns your shield into a weapon.

---

## 2. Pillars

1. **Realistic, not cartoon.** 3D metallic ships lit by real lights, volumetric
   nebulae, bloom, sparks, shockwaves, and screen shake. No anime aesthetic.
2. **Made for thumbs.** One-finger drag to fly, auto-fire, and a single Focus
   button. Playable with one hand in portrait.
3. **A signature verb.** *Focus* slows time to 35% and raises a **deflector
   shield** that shreds incoming fire — risk vs. reward around a Focus meter.
4. **Always progressing.** Salvage → upgrades between every wave; 12 curated
   waves + 3 bosses + endless mode; persistent high score & best wave.

---

## 3. Core Loop

Fly & dodge → auto-fire kills enemies → enemies drop **salvage** & **power-ups**
→ clear the wave → spend salvage in the **field workshop** → next, harder wave →
boss every 4th wave → win at Wave 12 → **Endless** for the leaderboard.

Micro-loop: **Move → Shoot → Focus-deflect the dangerous shot → collect drops.**

---

## 4. Controls (mobile-first)

| Action | Touch | Desktop |
|---|---|---|
| Move ship | Drag anywhere | Mouse move / WASD / Arrows |
| Fire | Automatic | Automatic |
| **Focus** (bullet-time + deflector) | Hold the **FOCUS** button (or 2nd finger) | Hold **Space / Shift** |
| Pause | Pause button | **P / Esc** |
| Collect power-up | Fly into it | same |

---

## 5. Signature Mechanic — **FOCUS**

Holding Focus:
- **Time dilates** to 35% for enemies & enemy bullets (you stay responsive).
- A **deflector ring** around LANCE‑7 destroys enemy bullets it touches.
- Your weapon converges into a **concentrated lance beam** (high DPS).
- Drains the **Focus meter**; empties → auto-disengage. Regenerates when idle.

This creates a clutch, skill-expressive out: dive into a bullet storm, slow it,
carve a path, and punish the boss — but manage the meter.

---

## 6. Ship Resources

- **Hull (HP):** no passive regen; restored by *Repair* drops & upgrades.
- **Shield:** absorbs damage; **auto-regenerates** after 4s without a hit.
- **Focus:** fuels the Focus mechanic; regenerates over time.
- **Heat/decay is intentionally omitted** to keep the phone UX clean.

---

## 7. Enemies

| Unit | Behavior |
|---|---|
| **Drone** | Cheap swarmer, drifts in, light shots. |
| **Interceptor** | Fast diagonal dive, brief burst fire. |
| **Gunship** | Tanky, fires a 3-way spread. |
| **Mine** | Floats down, detonates on contact / when shot. |
| **Weaver** | Sine-wave strafer, rapid single shots. |

**Bosses**
- **W4 — Hive Carrier:** spawns drones, sweeping cannon.
- **W8 — Lance Reaver:** dashes, radial bullet bursts.
- **W12 — Scourge Sovereign:** multi-phase; beams, spirals, summons.

---

## 8. Progression & Economy

- **Salvage** earned per kill (scaled by unit value).
- **Field Workshop** (between waves): Damage, Fire Rate, Multi-shot, Max Hull,
  Shield Capacity, Shield Regen, Focus Capacity, Move Speed, Magnet radius.
- Upgrades are **per-run (roguelite)**; **high score & best wave persist**.

**Power-up drops:** Repair, Shield Cell, Overcharge (temp fire-rate), Spread
(temp side guns), Focus Cell (refill).

---

## 9. Waves / Levels

12 hand-tuned waves with rising density & new unit intros; bosses on 4/8/12.
Clearing 12 unlocks **Endless** (procedural scaling) for score chasing.

---

## 10. Art & Audio Direction

- **Look:** deep-space blacks, cyan/amber energy, orange dying star, parallax
  starfields, drifting **procedural nebula** (fbm shader), lens glow, **bloom**.
- **Ships:** procedurally-built low-poly **metallic** meshes, PBR materials,
  a key directional light + engine point-lights → real shading & specular.
- **FX:** GPU point-particle bursts, expanding shockwave rings, hit sparks,
  muzzle flashes, damage flashes, **screen shake**.
- **Audio:** fully **procedural WebAudio** synthesis (no asset downloads):
  lasers, explosions, hits, power-ups, UI, and an ambient drone. Volume mixer.

---

## 11. UX / Screens

Loading → animated **Main Menu** → How-to-Play → gameplay **HUD** (score, wave,
salvage, hull, shield, focus) → **Pause** → **Field Workshop** → **Game Over**
with run stats → Settings (volume, quality, bloom, haptics).

- **Quality toggle** (bloom & particle density) for low-end phones.
- **Responsive** contain-fit arena so play is fair on any screen.
- **Haptics** (vibration) on hits where supported.

---

## 12. Tech

- **Three.js** (ESM via import-map / CDN), orthographic camera on the XY plane
  for true 2D play with 3D-lit objects.
- **EffectComposer + UnrealBloom** post-processing for realistic glow.
- Object pools for bullets/particles; single GPU **Points** system for FX.
- `localStorage` for persistence; graceful WebGL/feature fallbacks.
- Single-origin static files — host anywhere (GitHub Pages, any static host).

---

## 13. Win / Lose

- **Lose:** Hull reaches 0 → Game Over (run stats, retry).
- **Win:** Clear Wave 12 → victory → continue into **Endless**.

---

*This document is implemented by the code in this repository (`index.html`,
`style.css`, `game.js`).*
