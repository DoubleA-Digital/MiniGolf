/* ============================================================
   PAINT — bake the course surface into a canvas, pixel by pixel, from
   the same surfaceAt() the physics uses. Stripes, grain, bunker lips and
   tree shadows are all painted here so the GPU only has to sample it.
   ============================================================ */
import { makeNoise, smooth, clamp } from './noise.js';

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function paintRegion(h, region, ppy, opts = {}){
  const T = h.T;
  const W = Math.max(8, Math.round((region.maxX - region.minX) * ppy));
  const D = Math.max(8, Math.round((region.maxZ - region.minZ) * ppy));
  const cv = Object.assign(document.createElement('canvas'), { width: W, height: D });
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, D);
  const px = img.data;
  const nz = makeNoise(h.seed * 13 + 5);

  const C = {
    fairway: hex(T.fairway), fairway2: hex(T.fairway2), green: hex(T.green), green2: hex(T.green2),
    fringe: hex(T.fringe), rough: hex(T.rough), deep: hex(T.deep), outer: hex(T.outer),
    sand: hex(T.sand), water: hex(T.water), tee: hex(T.tee), waste: T.waste ? hex(T.waste) : null
  };
  const gRot = Math.atan2(h.approach.z, h.approach.x);
  const gc = Math.cos(gRot), gs = Math.sin(gRot);
  const edgeFade = opts.edgeFade || 0;          // alpha fade at the border (green patch)

  let o = 0;
  for (let j = 0; j < D; j++){
    const z = region.minZ + (j + 0.5) / ppy;
    for (let i = 0; i < W; i++, o += 4){
      const x = region.minX + (i + 0.5) / ppy;
      const surf = h.surfaceAt(x, z);
      const grain = (hash(i * 7 + (opts.salt || 0), j * 13) - 0.5);
      const mott = nz.n2(x / 7, z / 7) * 0.5 + nz.n2(x / 23, z / 23) * 0.5;
      let r, g, b;
      let base, k = 1;
      switch (surf){
        case 'green': {
          const u = (x - h.greenC.x) * gc + (z - h.greenC.z) * gs;
          const stripe = Math.floor(u / 2.4) & 1;
          base = stripe ? C.green : C.green2;
          k = 1 + mott * 0.035 + grain * 0.03;
          // collar shading just inside the edge
          const sd = h.greenSD(x, z);
          k *= 1 - 0.06 * (1 - smooth(-1.2, 0, sd));
          break;
        }
        case 'fringe': base = C.fringe; k = 1 + mott * 0.05 + grain * 0.05; break;
        case 'fairway': case 'tee': {
          const q = h.closest(x, z);
          const s = surf === 'tee' ? z : q.s;
          const stripe = Math.floor(s / 9.5) & 1;
          const cross = Math.floor((q.d * q.side + 200) / 9.5) & 1;
          base = stripe ? C.fairway : C.fairway2;
          if (surf === 'tee') base = C.tee;
          k = 1 + mott * 0.06 + grain * 0.045 + (cross ? 0.012 : -0.012);
          // slightly darker toward the edge of the cut
          const fw = h.fairW(q.s);
          k *= 1 - 0.07 * smooth(fw - 3, fw, q.d);
          break;
        }
        case 'rough': base = C.rough; k = 1 + mott * 0.11 + grain * 0.09; break;
        case 'deep':  base = C.deep;  k = 1 + mott * 0.14 + grain * 0.12; break;
        case 'waste': base = C.waste; k = 1 + mott * 0.10 + grain * 0.16 + (hash(i, j * 3) > 0.985 ? -0.25 : 0); break;
        case 'bunker': {
          base = C.sand;
          let sd = 1e9;
          for (const bk of h.bunkers){ const d = h.blobSD(bk.circles, x, z); if (d < sd) sd = d; }
          k = 1 + grain * 0.07 + mott * 0.04;
          k *= 1 - 0.16 * (1 - smooth(-1.4, 0, sd));             // shaded lip
          k *= 1 + 0.03 * Math.sin((x + z) * 3.1);                // rake marks
          break;
        }
        case 'water': base = C.water; k = 1 + mott * 0.05; break;
        default: {                                                 // ob / scenery
          const q = h.closest(x, z);
          const far = smooth(0, 60, q.d - (h.widths.w0 + h.widths.r1 + h.widths.r2 + h.widths.obExtra));
          base = T.waste ? C.waste : C.deep;
          const ob = C.outer;
          r = base[0] + (ob[0] - base[0]) * far; g = base[1] + (ob[1] - base[1]) * far; b = base[2] + (ob[2] - base[2]) * far;
          k = 1 + mott * 0.14 + grain * 0.1;
          px[o] = clamp(r * k, 0, 255); px[o + 1] = clamp(g * k, 0, 255); px[o + 2] = clamp(b * k, 0, 255);
          px[o + 3] = 255;
          continue;
        }
      }
      px[o] = clamp(base[0] * k, 0, 255);
      px[o + 1] = clamp(base[1] * k, 0, 255);
      px[o + 2] = clamp(base[2] * k, 0, 255);
      px[o + 3] = 255;
    }
  }
  if (edgeFade){
    o = 0;
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++, o += 4){
      const e = Math.min(i, j, W - 1 - i, D - 1 - j) / (edgeFade * ppy);
      px[o + 3] = Math.round(255 * clamp(e, 0, 1));
    }
  }
  ctx.putImageData(img, 0, 0);

  // baked tree shadows (soft, offset away from the sun)
  if (!opts.noShadows){
    const sun = T.sun;
    const sl = Math.hypot(sun[0], sun[2]) / Math.max(0.25, sun[1]);
    const sx = -sun[0] / Math.hypot(sun[0], sun[2]) * sl, sz = -sun[2] / Math.hypot(sun[0], sun[2]) * sl;
    ctx.globalCompositeOperation = 'multiply';
    for (const t of h.trees){
      const off = t.h * 0.9;
      const cx = (t.x + sx * off - region.minX) * ppy, cz = (t.z + sz * off - region.minZ) * ppy;
      const rad = (t.kind === 'cactus' ? 0.8 : t.r * 1.05) * ppy;
      if (cx < -rad * 3 || cz < -rad * 3 || cx > W + rad * 3 || cz > D + rad * 3) continue;
      const grd = ctx.createRadialGradient(cx, cz, rad * 0.15, cx, cz, rad * 1.35);
      grd.addColorStop(0, 'rgba(40,60,40,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(cx, cz, rad * 1.35, rad * 1.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  return { canvas: cv, W, D };
}

function hash(x, y){
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* A small tileable grass-grain texture used as a detail layer up close. */
export function detailCanvas(size = 256){
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const nz = makeNoise(77);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++){
    // tileable: sample noise on a torus
    const a = i / size * Math.PI * 2, b = j / size * Math.PI * 2;
    const n = nz.n2(Math.cos(a) * 6 + 20, Math.sin(a) * 6 + Math.cos(b) * 6) * 0.5
            + nz.n2(Math.cos(a) * 18, Math.sin(b) * 18 + 40) * 0.3;
    const g = hash(i, j) - 0.5;
    const v = 128 + n * 40 + g * 70;
    const o = (j * size + i) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = clamp(v, 0, 255);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
