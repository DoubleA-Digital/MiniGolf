/* ============================================================
   COURSE — analytic hole generation.
   A hole is a smoothed centreline with a width profile, plus blobs for
   the green, bunkers and ponds. Everything (surface, height, trees) is a
   pure function of the seed, so the physics and the renderer agree to the
   inch and every player sees the same hole.
   ============================================================ */
import { THEMES } from './config.js';
import { mulberry32, makeNoise, clamp, lerp, smooth } from './noise.js';

const TAU = Math.PI * 2;

export function genHole(seed, par, themeKey, opts = {}){
  const T = THEMES[themeKey] || THEMES.pines;
  const rnd = mulberry32(seed >>> 0);
  const rr = (a, b) => a + rnd() * (b - a);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const noise = makeNoise(seed * 31 + 7);

  /* ---------- routing: control points of the centreline ---------- */
  const target = par === 3 ? rr(140, 212) : par === 4 ? rr(345, 452) : rr(520, 600);
  const ctrl = [{ x: 0, z: 0 }];
  let heading = 0;                                   // radians, 0 = straight up (-z)
  const push = (d, ang) => {
    const last = ctrl[ctrl.length - 1];
    ctrl.push({ x: last.x + Math.sin(ang) * d, z: last.z - Math.cos(ang) * d });
  };
  if (par === 3){
    heading = rr(-0.12, 0.12);
    push(target, heading);
  } else if (par === 4){
    const dog = rnd() < 0.62 ? (rnd() < 0.5 ? -1 : 1) : 0;
    heading = rr(-0.08, 0.08);
    const d1 = dog ? Math.min(target * 0.64, rr(232, 262)) : target * 0.5;
    push(d1, heading);
    const turn = dog ? dog * rr(0.32, 0.6) : rr(-0.12, 0.12);
    push(target - d1, heading + turn);
  } else {
    const shape = rnd();
    heading = rr(-0.08, 0.08);
    const d1 = rr(248, 272);
    const d2 = rr(165, 205);
    const s1 = rnd() < 0.5 ? -1 : 1;
    push(d1, heading);
    const t1 = shape < 0.4 ? s1 * rr(0.25, 0.45) : rr(-0.1, 0.1);
    push(d2, heading + t1);
    const t2 = shape < 0.4 ? t1 + (rnd() < 0.6 ? -s1 : s1) * rr(0.2, 0.45) : s1 * rr(0.25, 0.5);
    push(Math.max(60, target - d1 - d2), heading + t2);
  }

  // Catmull-Rom through the control points, sampled every ~6 yds
  const poly = { x: [], z: [], s: [] };
  {
    const P = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
    for (let i = 1; i < P.length - 2; i++){
      const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
      const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      const n = Math.max(4, Math.ceil(segLen / 6));
      for (let k = 0; k < n; k++){
        const t = k / n, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        poly.x.push(f(p0.x, p1.x, p2.x, p3.x));
        poly.z.push(f(p0.z, p1.z, p2.z, p3.z));
      }
    }
    const last = ctrl[ctrl.length - 1];
    poly.x.push(last.x); poly.z.push(last.z);
    let s = 0;
    for (let i = 0; i < poly.x.length; i++){
      if (i) s += Math.hypot(poly.x[i] - poly.x[i - 1], poly.z[i] - poly.z[i - 1]);
      poly.s.push(s);
    }
  }
  const N = poly.x.length;
  const length = Math.round(poly.s[N - 1]);
  const greenC = { x: poly.x[N - 1], z: poly.z[N - 1] };

  /* ---------- widths ---------- */
  const w0 = rr(T.fairW[0], T.fairW[1]);
  const r1 = rr(T.rough1[0], T.rough1[1]);
  const r2 = rr(T.deepW[0], T.deepW[1]);
  const obExtra = rr(18, 28);
  const fairStart = par === 3 ? length - 34 : (T.potBunkers ? rr(18, 34) : rr(32, 58));
  const wPhase = rnd() * TAU, wPhase2 = rnd() * TAU;
  function fairW(s){
    let w = w0 * (1 + 0.13 * Math.sin(s / 41 + wPhase) + 0.08 * Math.sin(s / 17 + wPhase2));
    // the approach narrows into the green
    const toGreen = length - s;
    if (toGreen < 45) w = lerp(Math.min(w, 13), w, smooth(8, 45, toGreen));
    if (par === 3) w = Math.min(w, 12);
    return w;
  }

  /* ---------- the green ---------- */
  const gBase = par === 3 ? rr(10.5, 13) : rr(12, 15.5);
  const gAsp = 1 + rr(0, 0.38);
  const gRot = rnd() * TAU;
  const gH2 = rr(0.02, 0.08), gP2 = rnd() * TAU, gH3 = rr(0.02, 0.07), gP3 = rnd() * TAU;
  const grx = gBase * Math.sqrt(gAsp), grz = gBase / Math.sqrt(gAsp);
  function greenR(theta){
    const a = theta - gRot;
    const re = grx * grz / Math.hypot(grz * Math.cos(a), grx * Math.sin(a));
    return re * (1 + gH2 * Math.cos(2 * theta + gP2) + gH3 * Math.cos(3 * theta + gP3));
  }
  function greenSD(x, z){
    const dx = x - greenC.x, dz = z - greenC.z;
    return Math.hypot(dx, dz) - greenR(Math.atan2(dz, dx));
  }
  const greenRmax = Math.max(grx, grz) * 1.16;

  // approach direction (into the green)
  const ax = poly.x[N - 1] - poly.x[N - 4], az = poly.z[N - 1] - poly.z[N - 4];
  const aL = Math.hypot(ax, az) || 1;
  const approach = { x: ax / aL, z: az / aL };

  // Green contours: a tilt rising away from the approach, plus a few humps.
  const tiltAng = Math.atan2(approach.z, approach.x) + rr(-0.9, 0.9);
  const tiltMag = rr(0.004, 0.013);
  const tilt = { x: Math.cos(tiltAng) * tiltMag, z: Math.sin(tiltAng) * tiltMag };
  const humps = [];
  const nh = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < nh; i++){
    const th = rnd() * TAU, rho = greenR(th) * rr(0, 0.85);
    const sig = rr(3.5, 7);
    const amp = (rnd() < 0.5 ? -1 : 1) * Math.min(rr(0.08, 0.24), sig * 0.032);
    humps.push({ x: greenC.x + Math.cos(th) * rho, z: greenC.z + Math.sin(th) * rho, amp, sig });
  }

  /* ---------- base terrain ---------- */
  const elevDelta = rr(T.elev[0], T.elev[1]);
  function baseH(x, z){
    const t = clamp(-z / length, -0.2, 1.2);
    return T.amp * 2 * noise.fbm(x / 120 + 3.1, z / 120 - 1.7, 3) + elevDelta * t;
  }

  /* ---------- hazards ---------- */
  const bunkers = [];                 // { circles:[{x,z,r}], depth, kind }
  const ponds = [];                   // { circles:[{x,z,r}], level }
  const atS = s => {                  // point on the centreline at distance s
    s = clamp(s, 0, length);
    let i = 0;
    while (i < N - 2 && poly.s[i + 1] < s) i++;
    const f = (s - poly.s[i]) / ((poly.s[i + 1] - poly.s[i]) || 1);
    const x = lerp(poly.x[i], poly.x[i + 1], f), z = lerp(poly.z[i], poly.z[i + 1], f);
    const dx = poly.x[i + 1] - poly.x[i], dz = poly.z[i + 1] - poly.z[i];
    const L = Math.hypot(dx, dz) || 1;
    return { x, z, nx: -dz / L, nz: dx / L, tx: dx / L, tz: dz / L };   // n = left normal
  };
  const blob = (cx, cz, r, k, spread) => {
    const circles = [{ x: cx, z: cz, r }];
    for (let i = 1; i < k; i++){
      const a = rnd() * TAU, d = r * rr(0.35, spread);
      circles.push({ x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d, r: r * rr(0.55, 0.85) });
    }
    return circles;
  };

  // greenside bunkers hug the green perimeter, mostly short and to the sides
  const nGB = Math.round((par === 3 ? rr(1.6, 3.4) : rr(1, 3)) * Math.min(1.4, T.bunkerMul));
  const appAng = Math.atan2(approach.z, approach.x);
  for (let i = 0; i < nGB; i++){
    const side = rnd() < 0.5 ? -1 : 1;
    const th = appAng + Math.PI + side * rr(0.55, 1.9);
    const r = T.potBunkers ? rr(2.6, 4) : rr(3.5, 6.5);
    const d = greenR(th) + 1.6 + r * 0.85 + rr(0.5, 2);
    bunkers.push({ circles: blob(greenC.x + Math.cos(th) * d, greenC.z + Math.sin(th) * d, r,
                   T.potBunkers ? 1 : 2 + Math.floor(rnd() * 2), 1.0),
                   depth: T.potBunkers ? 1.25 : 0.75, kind: 'green' });
  }
  // fairway bunkers in the driving zone (and the lay-up zone on a par 5)
  if (par !== 3){
    const zones = par === 5 ? [rr(225, 280), length - rr(95, 125)] : [rr(220, 275)];
    for (const zs of zones){
      const n = Math.round(rr(1, 2.6) * T.bunkerMul);
      for (let i = 0; i < n; i++){
        const s = zs + rr(-18, 18);
        const c = atS(s);
        const side = rnd() < 0.5 ? -1 : 1;
        const pot = T.potBunkers && rnd() < 0.7;
        const r = pot ? rr(2.4, 3.6) : rr(5, 9);
        const off = pot ? rr(-0.8, 0.9) * fairW(s) : side * (fairW(s) + rr(-r * 0.6, r * 0.6));
        bunkers.push({ circles: blob(c.x + c.nx * off, c.z + c.nz * off, r, pot ? 1 : 3, 1.3),
                       depth: pot ? 1.25 : 0.6, kind: 'fairway' });
      }
    }
  }
  // water
  if (rnd() < T.waterChance){
    const kind = par === 3 ? (rnd() < 0.6 ? 'front' : 'side') : (rnd() < 0.7 ? 'side' : 'greenside');
    if (kind === 'front'){
      const s = length * rr(0.42, 0.62);
      const c = atS(s);
      const r = Math.min(length * 0.2, rr(18, 28));
      ponds.push({ circles: blob(c.x + c.nx * rr(-8, 8), c.z + c.nz * rr(-8, 8), r, 3, 1.1) });
    } else if (kind === 'side'){
      const s = par === 3 ? length * 0.7 : rr(150, length - 140);
      const c = atS(s);
      const side = rnd() < 0.5 ? -1 : 1;
      const r = rr(16, 28);
      const off = side * (fairW(s) + r * rr(0.9, 1.3));
      ponds.push({ circles: blob(c.x + c.nx * off, c.z + c.nz * off, r, 3, 1.4) });
    } else {
      const side = rnd() < 0.5 ? -1 : 1;
      const th = appAng + Math.PI + side * rr(1.2, 1.9);
      const r = rr(12, 18);
      const d = greenR(th) + 1.6 + r + rr(2, 5);
      ponds.push({ circles: blob(greenC.x + Math.cos(th) * d, greenC.z + Math.sin(th) * d, r, 3, 1.1) });
    }
  }
  const blobSD = (circles, x, z) => {
    let m = 1e9;
    for (const c of circles){ const d = Math.hypot(x - c.x, z - c.z) - c.r; if (d < m) m = d; }
    return m;
  };
  for (const p of ponds){
    const c = p.circles[0];
    p.flat = baseH(c.x, c.z);
    p.level = p.flat - 0.45;
    let R = 0;
    for (const q of p.circles) R = Math.max(R, Math.hypot(q.x - c.x, q.z - c.z) + q.r);
    p.bound = { x: c.x, z: c.z, r: R + 20 };
  }
  // a bunker that ended up in a pond is just confusing
  for (let i = bunkers.length - 1; i >= 0; i--){
    const c = bunkers[i].circles[0];
    if (ponds.some(p => blobSD(p.circles, c.x, c.z) < 4) || greenSD(c.x, c.z) < 1.5) bunkers.splice(i, 1);
  }

  /* ---------- centreline queries ---------- */
  // z decreases monotonically along the hole, so binary-search the segment by z
  // and refine within a small window.
  function closest(x, z){
    let lo = 0, hi = N - 1;
    while (hi - lo > 1){
      const mid = (lo + hi) >> 1;
      if (poly.z[mid] > z) lo = mid; else hi = mid;
    }
    let best = 1e18, bs = 0, bside = 1;
    const a0 = Math.max(0, lo - 7), a1 = Math.min(N - 2, lo + 7);
    for (let i = a0; i <= a1; i++){
      const ax = poly.x[i], az = poly.z[i];
      const vx = poly.x[i + 1] - ax, vz = poly.z[i + 1] - az;
      const L2 = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + vx * t), dz = z - (az + vz * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < best){
        best = d2; bs = poly.s[i] + Math.sqrt(L2) * t;
        bside = (vx * dz - vz * dx) > 0 ? 1 : -1;
      }
    }
    return { d: Math.sqrt(best), s: bs, side: bside };
  }

  const teeBox = { x: 0, z: 3, hw: 5.5, hl: 8, rot: -heading };
  function teeSD(x, z){
    const c = Math.cos(teeBox.rot), s = Math.sin(teeBox.rot);
    const dx = x - teeBox.x, dz = z - teeBox.z;
    const u = dx * c - dz * s, v = dx * s + dz * c;
    const qx = Math.abs(u) - teeBox.hw, qz = Math.abs(v) - teeBox.hl;
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
  }
  const teeH = baseH(0, 0) + 0.45;
  const greenBaseH = baseH(greenC.x, greenC.z) + 0.6;

  function greenSurfH(x, z){
    let h = greenBaseH + tilt.x * (x - greenC.x) + tilt.z * (z - greenC.z);
    for (const m of humps){
      const dx = x - m.x, dz = z - m.z;
      h += m.amp * Math.exp(-(dx * dx + dz * dz) / (2 * m.sig * m.sig));
    }
    return h;
  }

  /* ---------- height ---------- */
  function heightAt(x, z){
    let h = baseH(x, z);
    // undulation away from the short grass
    const q = closest(x, z);
    const fw = fairW(q.s);
    const roughMask = smooth(fw - 3, fw + 8, q.d);
    h += T.bump * (0.35 + 0.65 * roughMask) * noise.fbm(x / 15, z / 15, 2) * 1.6;
    // ponds flatten their surroundings, then dish below the water line
    for (const p of ponds){
      const dd = Math.hypot(x - p.bound.x, z - p.bound.z);
      if (dd > p.bound.r + 2) continue;
      const sd = blobSD(p.circles, x, z);
      h = lerp(h, p.flat, 1 - smooth(4, 18, sd));
      h -= 2.4 * smooth(0.5, -7, sd);
    }
    // green plateau
    const gsd = greenSD(x, z);
    if (gsd < 14){
      const w = 1 - smooth(1.6, 12, gsd);
      h = lerp(h, greenSurfH(x, z), w);
    }
    // tee box
    const tsd = teeSD(x, z);
    if (tsd < 5) h = lerp(h, teeH, 1 - smooth(0, 4, tsd));
    // bunkers dish down with a little lip
    for (const b of bunkers){
      const sd = blobSD(b.circles, x, z);
      if (sd > 2) continue;
      if (sd < 0) h -= b.depth * smooth(0, -2.2, sd);
      else h += 0.14 * (1 - smooth(0, 1.6, sd));
    }
    return h;
  }

  /* ---------- surface ---------- */
  function surfaceAt(x, z, hgt){
    const gsd = greenSD(x, z);
    if (gsd < 0) return 'green';
    for (const p of ponds){
      if (Math.hypot(x - p.bound.x, z - p.bound.z) > p.bound.r) continue;
      if (blobSD(p.circles, x, z) < 0){
        const hh = hgt === undefined ? heightAt(x, z) : hgt;
        if (hh < p.level + 0.02) return 'water';
      }
    }
    for (const b of bunkers) if (blobSD(b.circles, x, z) < 0) return 'bunker';
    if (gsd < 1.6) return 'fringe';
    if (teeSD(x, z) < 0) return 'tee';
    const q = closest(x, z);
    const fw = fairW(q.s);
    if (q.s < 0.5 && z > 14) return 'ob';
    const obD = fw + r1 + r2 + obExtra;
    if (q.d > obD) return 'ob';
    if (q.d < fw && q.s >= fairStart) return 'fairway';
    if (q.d < fw + r1) return 'rough';
    return T.waste ? 'waste' : 'deep';
  }

  // The water line has to sit below every bit of bank around the pond, or a
  // nearby green or tee would end up under water.
  for (const p of ponds){
    let low = p.flat - 0.45;
    for (const c of p.circles){
      for (let a = 0; a < TAU; a += TAU / 36){
        const x = c.x + Math.cos(a) * (c.r + 2.5), z = c.z + Math.sin(a) * (c.r + 2.5);
        if (blobSD(p.circles, x, z) < 2) continue;
        low = Math.min(low, heightAt(x, z) - 0.3);
      }
    }
    p.level = low;
  }

  /* ---------- trees & scenery objects ---------- */
  const trees = [];
  const okForTree = (x, z, margin) => {
    if (greenSD(x, z) < 7 + margin) return false;
    if (teeSD(x, z) < 6) return false;
    for (const b of bunkers) if (blobSD(b.circles, x, z) < 2 + margin) return false;
    for (const p of ponds) if (blobSD(p.circles, x, z) < 3 + margin) return false;
    const q = closest(x, z);
    if (q.d < fairW(q.s) + 2 + margin) return false;
    return true;
  };
  const addTree = (x, z, kindOverride) => {
    const kind = kindOverride || pick(T.treeKinds);
    let r, h, trunk;
    if (kind === 'oak'){ r = rr(4.5, 7); trunk = rr(2.4, 3.6); h = trunk + r * 0.75; }
    else if (kind === 'pine'){ r = rr(3, 4.4); trunk = rr(1.8, 2.6); h = trunk + r * 1.5; }
    else if (kind === 'birch'){ r = rr(2.8, 4); trunk = rr(3, 4); h = trunk + r * 0.9; }
    else if (kind === 'gorse'){ r = rr(1.2, 2.3); trunk = 0; h = r * 0.55; }
    else if (kind === 'cactus'){ r = 0.42; trunk = rr(2.6, 4.2); h = trunk * 0.5; }
    else if (kind === 'rock'){ r = rr(1.2, 3.2); trunk = 0; h = r * 0.35; }
    else { r = rr(2.6, 3.6); trunk = rr(1.4, 2); h = trunk + r * 0.6; }   // palo verde
    if (!okForTree(x, z, kind === 'gorse' || kind === 'rock' ? 0 : r * 0.4)) return;
    trees.push({ x, z, kind, r, h, trunk, rot: rnd() * TAU, tint: rnd(), y: 0 });
  };
  const density = T.trees;
  if (density > 0){
    // lines along both sides of the corridor
    for (let s = -10; s < length + 40; s += rr(5, 11) / Math.max(0.35, density)){
      const c = atS(s);
      for (const side of [-1, 1]){
        if (rnd() > 0.55 + density * 0.4) continue;
        const fw = fairW(s);
        const off = side * (fw + r1 + rr(-3, r2 + 22));
        addTree(c.x + c.nx * off + rr(-3, 3), c.z + c.nz * off + rr(-3, 3));
      }
    }
    // defend the inside of a dogleg
    if (par !== 3 && ctrl.length > 2){
      const corner = ctrl[1];
      const nxt = ctrl[2];
      const turnSide = Math.sign((nxt.x - corner.x)) || 1;
      const sC = Math.hypot(corner.x, corner.z);
      const c = atS(sC - 25);
      for (let i = 0; i < Math.round(5 * density) + 1; i++){
        const off = turnSide * (fairW(sC) + rr(4, 20));
        addTree(c.x + c.nx * off + rr(-12, 12), c.z + c.nz * off + rr(-12, 12));
      }
    }
    // a frame behind the green
    for (let i = 0; i < Math.round(8 * density); i++){
      const th = appAng + rr(-1.2, 1.2);
      const d = greenR(th) + rr(16, 40);
      addTree(greenC.x + Math.cos(th) * d, greenC.z + Math.sin(th) * d);
    }
  }
  for (const t of trees) t.y = heightAt(t.x, t.z);

  // boundary stakes along the out-of-bounds line
  const stakes = [];
  for (let s = 0; s < length + 30; s += 22){
    const c = atS(s);
    const fw = fairW(s);
    for (const side of [-1, 1]){
      const off = side * (fw + r1 + r2 + obExtra);
      const x = c.x + c.nx * off, z = c.z + c.nz * off;
      stakes.push({ x, z, y: heightAt(x, z) });
    }
  }

  /* ---------- pin ---------- */
  const slopeAt = (x, z) => {
    const e = 0.15;
    return { x: (greenSurfH(x + e, z) - greenSurfH(x - e, z)) / (2 * e),
             z: (greenSurfH(x, z + e) - greenSurfH(x, z - e)) / (2 * e) };
  };
  let pin = null;
  for (let i = 0; i < 60 && !pin; i++){
    const th = rnd() * TAU;
    const rho = greenR(th) * rr(0.15, 0.66);
    const x = greenC.x + Math.cos(th) * rho, z = greenC.z + Math.sin(th) * rho;
    const g = slopeAt(x, z);
    if (Math.hypot(g.x, g.z) < 0.017) pin = { x, z };
  }
  if (!pin) pin = { x: greenC.x, z: greenC.z };
  pin.y = heightAt(pin.x, pin.z);

  /* ---------- wind ---------- */
  const windMph = Math.round(rr(T.wind[0], T.wind[1]));
  const windDir = rnd() * TAU;           // direction the wind blows TOWARD

  /* ---------- bounds for rendering ---------- */
  let minX = 1e9, maxX = -1e9;
  for (let i = 0; i < N; i++){ minX = Math.min(minX, poly.x[i]); maxX = Math.max(maxX, poly.x[i]); }
  const lat = w0 * 1.3 + r1 + r2 + obExtra + 34;
  const bounds = { minX: Math.floor(minX - lat), maxX: Math.ceil(maxX + lat),
                   minZ: Math.floor(Math.min(...poly.z) - 70), maxZ: 46 };

  const tee = { x: 0, z: 0, y: teeH };

  return {
    seed, par, theme: themeKey, T, length, poly, ctrl, tee, teeBox, greenC, greenRmax, pin,
    approach, bunkers, ponds, trees, stakes, bounds, fairStart, elevDelta,
    wind: { mph: windMph, dir: windDir },
    fairW, greenR, greenSD, teeSD, closest, atS, blobSD,
    heightAt, surfaceAt, greenSurfH,
    get widths(){ return { w0, r1, r2, obExtra }; }
  };
}

/* Gradient of the terrain (dh/dx, dh/dz) by central differences. */
export function gradAt(h, x, z, e = 0.12){
  return { x: (h.heightAt(x + e, z) - h.heightAt(x - e, z)) / (2 * e),
           z: (h.heightAt(x, z + e) - h.heightAt(x, z - e)) / (2 * e) };
}

/* Is the ball sitting under a canopy? Then only a punch is possible. */
export function underTree(h, x, z){
  for (const t of h.trees){
    if (t.kind === 'gorse' || t.kind === 'rock' || t.kind === 'cactus') continue;
    const d = Math.hypot(x - t.x, z - t.z);
    if (d < t.r * 0.85) return t;
  }
  return null;
}

/* Where a sensible player would aim from here: the pin if it is in reach,
   otherwise a point down the centreline (so doglegs aim at the fairway). */
export function defaultAim(h, ball, reach){
  const dPin = Math.hypot(h.pin.x - ball.x, h.pin.z - ball.z);
  if (dPin <= reach * 1.08) return { x: h.pin.x, z: h.pin.z };
  const q = h.closest(ball.x, ball.z);
  const p = h.atS(Math.min(h.length, q.s + reach * 0.97));
  return { x: p.x, z: p.z };
}
