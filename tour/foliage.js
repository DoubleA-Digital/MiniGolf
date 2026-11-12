/* ============================================================
   FOLIAGE — procedural geometry for trees, bushes and rocks.
   Every builder is seeded, returns a non-indexed BufferGeometry with
   normals and vertex colours (baked occlusion, and snow where asked),
   and is drawn instanced, so a few variants dress a whole course.
   ============================================================ */
import * as THREE from 'three';
import { mulberry32 } from './noise.js';

const TAU = Math.PI * 2;
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function hash3(i, j, k, s){
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1274126177) ^ Math.imul(s + 1, 1103515245);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// smooth lattice value noise in 3D, 0..1
export function noise3(x, y, z, s = 0){
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = t => t * t * (3 - 2 * t);
  const u = f(x - xi), v = f(y - yi), w = f(z - zi);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
    r += hash3(xi + dx, yi + dy, zi + dz, s) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  return r;
}

function build(pos, nor, col){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
const linear = (h, s, l) => new THREE.Color().setHSL(h, s, l);

/* A broadleaf crown: a central mass with lumps around it, roughened by
   noise. Normals are bent outward so it lights like a soft volume, and
   the inside and underside are darkened like a real canopy. ~unit radius. */
export function canopyGeometry(seed, o = {}){
  const { lumps = 7, seg = 10, rough = 0.3, squash = 0.86, spread = 0.52 } = o;
  const rnd = mulberry32(seed);
  const centres = [{ x: 0, y: 0.04, z: 0, r: 0.68 }];
  for (let i = 1; i < lumps; i++){
    const a = i / (lumps - 1) * TAU + rnd() * 0.9, el = -0.3 + rnd() * 0.95;
    centres.push({ x: Math.cos(a) * Math.cos(el) * spread, y: Math.sin(el) * spread * 0.8,
                   z: Math.sin(a) * Math.cos(el) * spread, r: 0.38 + rnd() * 0.24 });
  }
  const parts = [];
  for (const c of centres){
    const g = new THREE.SphereGeometry(c.r, seg, Math.max(5, seg - 3));
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++){
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const wx = c.x + x, wy = c.y + y, wz = c.z + z;
      const n = noise3(wx * 3.2, wy * 3.2, wz * 3.2, seed) * 0.62 + noise3(wx * 8, wy * 8, wz * 8, seed + 1) * 0.38;
      const k = 1 + (n - 0.5) * 2 * rough;
      p.setXYZ(i, c.x + x * k, (c.y + y * k) * squash, c.z + z * k);
    }
    g.computeVertexNormals();
    parts.push(g.toNonIndexed());
  }
  let maxR = 0, y0 = 1e9, y1 = -1e9;
  for (const g of parts){
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++){
      maxR = Math.max(maxR, Math.hypot(p.getX(i), p.getZ(i)));
      y0 = Math.min(y0, p.getY(i)); y1 = Math.max(y1, p.getY(i));
    }
  }
  const sc = 1.04 / maxR;
  const pos = [], nor = [], col = [];
  const v = new THREE.Vector3(), nv = new THREE.Vector3(), rv = new THREE.Vector3();
  for (const g of parts){
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++){
      v.set(p.getX(i), p.getY(i), p.getZ(i));
      rv.set(v.x, v.y + 0.18, v.z).normalize();
      nv.set(n.getX(i), n.getY(i), n.getZ(i)).lerp(rv, 0.55).normalize();
      const yN = (v.y - y0) / (y1 - y0 || 1);
      const out = sstep(0.3, 0.98, v.length() / (maxR || 1));
      const sp = noise3(v.x * 9, v.y * 9, v.z * 9, seed + 2);
      const ao = (0.48 + 0.52 * Math.pow(yN, 0.8)) * (0.55 + 0.45 * out) * (0.84 + sp * 0.36) * 1.32;
      pos.push(v.x * sc, v.y * sc, v.z * sc);
      nor.push(nv.x, nv.y, nv.z);
      col.push(ao * (1 + (sp - 0.5) * 0.12), ao, ao * (1 - (sp - 0.5) * 0.14));
    }
  }
  return build(pos, nor, col);
}

/* A conifer: drooping, notched tiers of branches, y in [-0.5, 0.5] and
   base radius 1. With snow, the upper faces of each tier carry a white
   blanket (vertex colours are then the real colours, not just shading). */
export function pineGeometry(seed, o = {}){
  const { tiers = 6, seg = 12, snow = false } = o;
  const rnd = mulberry32(seed);
  const pos = [], nor = [], col = [];
  const green = linear(0.4, 0.38, 0.13), greenTip = linear(0.36, 0.36, 0.2), white = new THREE.Color(0.9, 0.93, 0.98);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  const tri = (P, Q, R, cols, wantUp) => {
    a.set(...P); b.set(...Q); c.set(...R);
    fn.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)).normalize();
    if ((fn.y > 0) !== wantUp){ [Q, R] = [R, Q]; [cols[1], cols[2]] = [cols[2], cols[1]]; fn.negate(); }
    for (const [k, V] of [P, Q, R].entries()){
      // bend toward the outward radial so tiers read as soft masses
      const rl = Math.hypot(V[0], V[2]) || 1;
      const nx = fn.x * 0.6 + V[0] / rl * 0.4, ny = fn.y * 0.6 + (wantUp ? 0.25 : -0.2), nz = fn.z * 0.6 + V[2] / rl * 0.4;
      const L = Math.hypot(nx, ny, nz) || 1;
      pos.push(...V); nor.push(nx / L, ny / L, nz / L); col.push(...cols[k]);
    }
  };
  const shade = (k, tip, white01) => {
    if (!snow) return [k, k, k];
    const base = tip ? greenTip : green;
    const r = base.r * k, g = base.g * k, bb = base.b * k;
    return [r + (white.r - r) * white01, g + (white.g - g) * white01, bb + (white.b - bb) * white01];
  };
  for (let t = 0; t < tiers; t++){
    const f = t / (tiers - 1);
    const yb = -0.5 + f * 0.8 + (rnd() - 0.5) * 0.02;
    const R = (1 - f * 0.84) * (0.92 + rnd() * 0.14);
    const yt = t === tiers - 1 ? 0.5 : yb + 0.24 + (1 - f) * 0.06;
    const ring = [];
    const off = rnd() * TAU;
    for (let i = 0; i < seg; i++){
      const ang = off + i / seg * TAU + (rnd() - 0.5) * 0.2;
      const tip = i % 2 === 0;
      const r = R * (tip ? 1 : 0.68) * (0.9 + rnd() * 0.2);
      ring.push({ p: [Math.cos(ang) * r, yb - (tip ? 0.05 + rnd() * 0.03 : 0), Math.sin(ang) * r], tip, snow: rnd() });
    }
    const apex = [0, yt, 0], under = [0, yb + 0.07, 0];
    const kTop = 0.78 + f * 0.32;
    for (let i = 0; i < seg; i++){
      const A = ring[i], B = ring[(i + 1) % seg];
      const sA = snow ? (A.tip ? A.snow * 0.2 : 0.3 + A.snow * 0.35) : 0, sB = snow ? (B.tip ? B.snow * 0.2 : 0.3 + B.snow * 0.35) : 0;
      tri(apex, A.p, B.p, [shade(kTop * 0.8, false, snow ? 0.7 : 0), shade(A.tip ? kTop * 1.18 : kTop * 0.9, A.tip, sA),
                           shade(B.tip ? kTop * 1.18 : kTop * 0.9, B.tip, sB)], true);
      tri(under, A.p, B.p, [shade(0.32, false, 0), shade(0.5, A.tip, 0), shade(0.5, B.tip, 0)], false);
    }
  }
  return build(pos, nor, col);
}

/* A palm frond: an arching spine with leaflets either side, along +x
   from the origin, length 1. Drawn double-sided. */
export function frondGeometry(seed){
  const rnd = mulberry32(seed);
  const pos = [], nor = [], col = [];
  const spine = s => [s, 0.22 * s - 0.62 * s * s, 0];
  const N = 16;
  for (let k = 1; k < N; k++){
    const s0 = k / N, s1 = Math.min(1, s0 + 0.075);
    const P0 = spine(s0), P1 = spine(s1);
    const L = 0.05 + 0.3 * Math.pow(Math.sin(Math.PI * s0), 0.7) * (0.85 + rnd() * 0.3);
    for (const side of [-1, 1]){
      const tip = [P0[0] + L * 0.45, P0[1] - L * (0.35 + rnd() * 0.15), side * L];
      const sh = 0.7 + s0 * 0.4;
      pos.push(...P0, ...P1, ...tip);
      for (let i = 0; i < 3; i++) nor.push(0, 1, 0);
      col.push(sh * 0.75, sh * 0.75, sh * 0.7, sh * 0.85, sh * 0.85, sh * 0.8, sh * 1.12, sh * 1.12, sh * 1.0);
    }
  }
  return build(pos, nor, col);
}

/* A weathered boulder: displaced, flat-bottomed, darker underneath. */
export function rockGeometry(seed){
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++){
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = noise3(x * 1.6 + 5, y * 1.6, z * 1.6, seed) * 0.7 + noise3(x * 4.5, y * 4.5, z * 4.5, seed + 3) * 0.3;
    const k = 0.72 + n * 0.62;
    x *= k; y *= k; z *= k;
    if (y < -0.25) y = -0.25 + (y + 0.25) * 0.15;
    p.setXYZ(i, x, y, z);
    const ao = (0.55 + 0.45 * sstep(-0.3, 0.7, y)) * (0.85 + noise3(x * 7, y * 7, z * 7, seed + 9) * 0.3) * 1.08;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/* Trunks with baked bark colour: 'bark' (darker at the foot), 'birch'
   (white with dark marks) or 'palm' (ringed). Base at y=0, height 1. */
export function trunkGeometry(kind, seed = 1, hi = true){
  const g = new THREE.CylinderGeometry(kind === 'palm' ? 0.2 : 0.15, kind === 'palm' ? 0.25 : 0.27, 1, hi ? 8 : 5, hi ? 6 : 2).translate(0, 0.5, 0);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++){
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    // a slight wander so trunks are not ruler-straight
    if (kind !== 'palm') p.setX(i, x + (noise3(0, y * 2.5, 0, seed) - 0.5) * 0.12);
    let k = 0.8 + 0.3 * sstep(0, 0.6, y) + (noise3(Math.cos(a) * 3, y * 6, Math.sin(a) * 3, seed) - 0.5) * 0.25;
    let r = k, gg = k, b = k;
    if (kind === 'birch'){
      const mark = noise3(Math.cos(a) * 4, y * 14, Math.sin(a) * 4, seed + 4) > 0.68;
      r = gg = b = mark ? 0.18 : 1.0 + (k - 0.95) * 0.3;
    } else if (kind === 'palm'){
      const ring = 0.82 + 0.18 * Math.abs(Math.sin(y * 30));
      r = gg = b = k * ring;
    }
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

