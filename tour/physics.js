/* ============================================================
   PHYSICS — one ball model for every shot.
   Flight uses drag and Magnus lift from the spin axis; landing bounces off
   the true terrain normal with surface-dependent restitution and spin bite;
   rolling feels the slope (5/7 g for a rolling sphere) and the surface's
   rolling resistance. Shots are simulated to completion up front and then
   played back, so the camera knows where the ball will land.
   ============================================================ */
import { G, BALL_R, CUP_R, AIR_K, CD, SPIN_DECAY, SURF, MPH } from './config.js';
import { gradAt } from './course.js';

const DT = 1 / 240;
const SAMPLE = 1 / 60;
const ROLL_K = 5 / 7;

export function windVec(hole, scale = 1){
  const s = hole.wind.mph * MPH * scale;
  return { x: Math.sin(hole.wind.dir) * s, z: -Math.cos(hole.wind.dir) * s };
}

/* Build the initial state of a struck ball.
   yaw: 0 = toward -z. tilt > 0 tilts the spin axis to curve the ball left. */
export function launch(pos, yaw, speed, launchDeg, spinRpm, tilt = 0){
  const la = launchDeg * Math.PI / 180;
  const fx = Math.sin(yaw), fz = -Math.cos(yaw);
  const v = { x: fx * Math.cos(la) * speed, y: Math.sin(la) * speed, z: fz * Math.cos(la) * speed };
  // pure backspin axis is the golfer's right; tilting it toward up curves left
  const rx = -fz, rz = fx;               // right = cross(f, up)
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const axis = { x: rx * c, y: s, z: rz * c };
  return { p: { x: pos.x, y: pos.y, z: pos.z }, v, spin: spinRpm, axis, mode: 'air' };
}

/* A putt (or any shot that starts on the ground). */
export function rollStart(pos, yaw, speed){
  return { p: { x: pos.x, y: pos.y, z: pos.z },
           v: { x: Math.sin(yaw) * speed, y: 0, z: -Math.cos(yaw) * speed },
           spin: 0, axis: { x: 1, y: 0, z: 0 }, mode: 'roll' };
}

function airAccel(st, wind, out){
  const vx = st.v.x - wind.x, vy = st.v.y, vz = st.v.z - wind.z;
  const sp = Math.hypot(vx, vy, vz) || 1e-6;
  const omega = st.spin * Math.PI / 30;
  const S = BALL_R * omega / sp;
  const CL = Math.min(0.38, 0.54 * Math.pow(S, 0.4));
  const Cd = CD + 0.22 * Math.min(S, 0.5);
  // lift direction = axis x v
  const a = st.axis;
  let lx = a.y * vz - a.z * vy, ly = a.z * vx - a.x * vz, lz = a.x * vy - a.y * vx;
  const lL = Math.hypot(lx, ly, lz) || 1;
  lx /= lL; ly /= lL; lz /= lL;
  const kd = AIR_K * Cd * sp;
  const kl = AIR_K * CL * sp * sp;
  out.x = -kd * vx + kl * lx;
  out.y = -kd * vy + kl * ly - G;
  out.z = -kd * vz + kl * lz;
}

/* Air-only flight against flat ground at height `floor` (used to calibrate
   clubs and solve for launch speed). Returns carry and apex. */
export function flatCarry(speed, launchDeg, spin, floor = 0){
  const st = launch({ x: 0, y: floor, z: 0 }, 0, speed, launchDeg, spin, 0);
  const acc = { x: 0, y: 0, z: 0 }, wind = { x: 0, z: 0 };
  let apex = 0, t = 0;
  const dt = 1 / 120;
  while (t < 20){
    airAccel(st, wind, acc);
    st.v.x += acc.x * dt; st.v.y += acc.y * dt; st.v.z += acc.z * dt;
    st.p.x += st.v.x * dt; st.p.y += st.v.y * dt; st.p.z += st.v.z * dt;
    st.spin *= Math.exp(-dt / SPIN_DECAY);
    t += dt;
    if (st.p.y > apex) apex = st.p.y;
    if (st.p.y < floor && st.v.y < 0) break;
  }
  return { carry: Math.hypot(st.p.x, st.p.z), apex, time: t };
}

/* Launch speed that carries `carry` yards (calm, flat) for this launch/spin. */
export function speedFor(carry, launchDeg, spin){
  if (carry <= 0.2) return 0.5;
  let lo = 1, hi = 140;
  for (let i = 0; i < 28; i++){
    const mid = (lo + hi) / 2;
    if (flatCarry(mid, launchDeg, spin).carry < carry) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/* Simulate a shot to completion.
   opts: wind {x,z}, trees (bool), airOnly (stop at first landing), rng */
export function simulate(hole, st, opts = {}){
  const wind = opts.wind || { x: 0, z: 0 };
  const rng = opts.rng || Math.random;
  const pin = hole.pin;
  const samples = [];                // [x,y,z, x,y,z, ...] at 60 Hz
  const events = [];
  let t = 0, nextSample = 0, apex = st.p.y, start = { ...st.p };
  let carryPt = null, result = 'rest', entry = null;
  const hitTrees = new Set();
  const acc = { x: 0, y: 0, z: 0 };
  let cupCooldown = false;
  let lastSurf = hole.surfaceAt(st.p.x, st.p.z);
  const maxT = opts.maxT || 32;
  const rec = () => { samples.push(st.p.x, st.p.y, st.p.z); };
  rec();

  while (t < maxT){
    t += DT;
    if (st.mode === 'air'){
      airAccel(st, wind, acc);
      st.v.x += acc.x * DT; st.v.y += acc.y * DT; st.v.z += acc.z * DT;
      st.p.x += st.v.x * DT; st.p.y += st.v.y * DT; st.p.z += st.v.z * DT;
      st.spin *= Math.exp(-DT / SPIN_DECAY);
      if (st.p.y > apex) apex = st.p.y;

      // trees: canopies swallow pace and spit the ball out at random
      if (opts.trees){
        for (let i = 0; i < hole.trees.length; i++){
          const tr = hole.trees[i];
          const dx = st.p.x - tr.x, dz = st.p.z - tr.z;
          const rad = tr.kind === 'cactus' ? 0.55 : tr.r;
          if (dx * dx + dz * dz > (rad + 0.5) * (rad + 0.5)) continue;
          if (hitTrees.has(i)) continue;
          let inside = false;
          const yy = st.p.y - tr.y;
          if (tr.kind === 'cactus') inside = yy < tr.trunk && Math.hypot(dx, dz) < 0.55;
          else if (tr.kind === 'rock' || tr.kind === 'gorse') inside = yy < tr.h * 2 && Math.hypot(dx, dz) < tr.r;
          else {
            const cy = tr.h, ry = tr.kind === 'pine' ? tr.r * 1.6 : tr.r * 0.9;
            const ex = dx / tr.r, ey = (yy - cy) / ry, ez = dz / tr.r;
            inside = ex * ex + ey * ey + ez * ez < 1 || (yy < tr.trunk && Math.hypot(dx, dz) < 0.35);
          }
          if (inside){
            hitTrees.add(i);
            const keep = tr.kind === 'gorse' ? 0.12 : 0.18 + rng() * 0.25;
            const a = rng() * Math.PI * 2;
            const sp = Math.hypot(st.v.x, st.v.z) * keep;
            st.v.x = st.v.x * keep * 0.6 + Math.cos(a) * sp * 0.6;
            st.v.z = st.v.z * keep * 0.6 + Math.sin(a) * sp * 0.6;
            st.v.y = Math.min(st.v.y * keep, 1.5);
            st.spin *= 0.2;
            events.push({ type: 'tree', t, x: st.p.x, y: st.p.y, z: st.p.z });
          }
        }
      }

      const gh = hole.heightAt(st.p.x, st.p.z);
      if (st.p.y <= gh + BALL_R && st.v.y < 0){
        st.p.y = gh + BALL_R;
        const surf = hole.surfaceAt(st.p.x, st.p.z, gh);
        if (!carryPt){ carryPt = { x: st.p.x, y: st.p.y, z: st.p.z, t }; }
        if (opts.airOnly){ rec(); break; }
        if (surf === 'water'){
          entry = { x: st.p.x, y: st.p.y, z: st.p.z };
          events.push({ type: 'splash', t, ...entry });
          result = 'water'; rec(); break;
        }
        // straight into the cup
        const dPin = Math.hypot(st.p.x - pin.x, st.p.z - pin.z);
        if (surf === 'green' && dPin < CUP_R + BALL_R * 0.5 && Math.hypot(st.v.x, st.v.z) < 12){
          st.p.x = pin.x; st.p.z = pin.z; st.p.y = pin.y - 0.06;
          events.push({ type: 'holed', t, x: pin.x, y: pin.y, z: pin.z, dunk: true });
          result = 'holed'; rec(); break;
        }
        bounce(hole, st, surf);
        events.push({ type: 'bounce', t, x: st.p.x, y: st.p.y, z: st.p.z, surf,
                      speed: Math.hypot(st.v.x, st.v.y, st.v.z) });
        lastSurf = surf;
      }
    } else {
      // ---------- rolling ----------
      const g = gradAt(hole, st.p.x, st.p.z);
      const surf = hole.surfaceAt(st.p.x, st.p.z);
      if (surf === 'water'){
        entry = { x: st.p.x, y: st.p.y, z: st.p.z };
        events.push({ type: 'splash', t, ...entry });
        result = 'water'; rec(); break;
      }
      if (surf !== lastSurf){ events.push({ type: 'surface', t, surf }); lastSurf = surf; }
      const mu = SURF[surf].roll;
      const ax = -ROLL_K * G * g.x, az = -ROLL_K * G * g.z;
      let vx = st.v.x + ax * DT, vz = st.v.z + az * DT;
      let sp = Math.hypot(vx, vz);
      const drop = mu * G * DT;
      if (sp <= drop){
        // friction wins: the ball stops unless the slope is steeper than it can hold
        if (Math.hypot(ax, az) < mu * G * 0.98){
          st.v.x = 0; st.v.z = 0; rec(); break;
        }
        vx = 0; vz = 0;
      } else {
        vx -= vx / sp * drop; vz -= vz / sp * drop;
      }
      const ox = st.p.x, oz = st.p.z;
      st.p.x += vx * DT; st.p.z += vz * DT;
      st.v.x = vx; st.v.z = vz; st.v.y = 0;
      st.p.y = hole.heightAt(st.p.x, st.p.z) + BALL_R;
      sp = Math.hypot(vx, vz);

      // the cup: closest approach of this step's segment to the pin
      if (surf === 'green' || surf === 'fringe'){
        const sx = st.p.x - ox, sz = st.p.z - oz;
        const L2 = sx * sx + sz * sz || 1e-9;
        let k = ((pin.x - ox) * sx + (pin.z - oz) * sz) / L2;
        k = k < 0 ? 0 : k > 1 ? 1 : k;
        const d = Math.hypot(ox + sx * k - pin.x, oz + sz * k - pin.z);
        if (d < CUP_R){
          if (!cupCooldown){
            const f = d / CUP_R;
            const vmax = 1.9 * (1 - 0.65 * f * f);
            if (sp < vmax){
              st.p.x = pin.x; st.p.z = pin.z; st.p.y = pin.y - 0.06;
              events.push({ type: 'holed', t, x: pin.x, y: pin.y, z: pin.z });
              result = 'holed'; rec(); break;
            }
            // too firm: it catches the lip and kicks off line
            if (sp < 4.5){
              const side = ((pin.x - ox) * sz - (pin.z - oz) * sx) > 0 ? 1 : -1;
              const ang = side * (0.15 + 0.5 * (1 - f)) * Math.min(1, 2.2 / sp);
              const c = Math.cos(ang), s = Math.sin(ang);
              const nx = st.v.x * c - st.v.z * s, nz = st.v.x * s + st.v.z * c;
              st.v.x = nx * 0.72; st.v.z = nz * 0.72;
              events.push({ type: 'lip', t, x: st.p.x, y: st.p.y, z: st.p.z });
            }
            cupCooldown = true;
          }
        } else if (d > CUP_R * 2.5) cupCooldown = false;
      }
    }
    if (t >= nextSample){ rec(); nextSample += SAMPLE; }
  }
  if (result === 'rest'){
    const surf = hole.surfaceAt(st.p.x, st.p.z);
    if (surf === 'ob') result = 'ob';
  }
  const rest = { x: st.p.x, y: st.p.y, z: st.p.z };
  const carry = carryPt ? Math.hypot(carryPt.x - start.x, carryPt.z - start.z) : 0;
  const total = Math.hypot(rest.x - start.x, rest.z - start.z);
  return { samples: new Float32Array(samples), sampleDt: SAMPLE, events, rest, result,
           carryPt, carry, total, apex: apex - start.y, entry, duration: t };
}

function bounce(hole, st, surf){
  const S = SURF[surf] || SURF.rough;
  const g = gradAt(hole, st.p.x, st.p.z);
  let nx = -g.x, ny = 1, nz = -g.z;
  const nL = Math.hypot(nx, ny, nz); nx /= nL; ny /= nL; nz /= nL;
  const vn = st.v.x * nx + st.v.y * ny + st.v.z * nz;          // negative: incoming
  let tx = st.v.x - vn * nx, ty = st.v.y - vn * ny, tz = st.v.z - vn * nz;
  const vt = Math.hypot(tx, ty, tz);
  const steep = Math.min(2, Math.abs(vn) / (vt + 0.01));
  const bite = (st.spin / 4000) * S.grip;
  let keep = 1 - S.fric * (1 + bite * steep);
  keep = Math.max(-0.25, Math.min(0.95, keep));
  // a big hit can't reverse the ball, only a soft spinning landing can
  if (keep < 0 && vt > 22) keep = 0.05;
  tx *= keep; ty *= keep; tz *= keep;
  let out = -vn * S.e;
  if (out < 0.9) out = 0;
  st.v.x = tx + nx * out; st.v.y = ty + ny * out; st.v.z = tz + nz * out;
  st.spin *= 0.4;
  if (out === 0){
    st.mode = 'roll';
    st.v.y = 0;
  }
}

/* Sample the stored path at time t (seconds). */
export function samplePath(shot, t, out){
  const n = shot.samples.length / 3;
  const f = Math.min(n - 1, Math.max(0, t / shot.sampleDt));
  const i = Math.floor(f), k = f - i, j = Math.min(n - 1, i + 1);
  const s = shot.samples;
  out.x = s[i * 3] + (s[j * 3] - s[i * 3]) * k;
  out.y = s[i * 3 + 1] + (s[j * 3 + 1] - s[i * 3 + 1]) * k;
  out.z = s[i * 3 + 2] + (s[j * 3 + 2] - s[i * 3 + 2]) * k;
  return out;
}
export const pathDuration = shot => (shot.samples.length / 3 - 1) * shot.sampleDt;
