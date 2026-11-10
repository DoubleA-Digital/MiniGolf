/* ============================================================
   PREPARE — the heavy, pure part of building a hole: surface pixels and
   terrain heights. Runs in a worker (worker.js) so a new hole costs the
   main thread almost nothing, with a synchronous fallback.
   ============================================================ */
import { paintPixels } from './paint.js';

export function terrainStep(quality){ return quality === 'high' ? 1.5 : 2.2; }
export function surfacePPY(quality){ return quality === 'high' ? 2.6 : 1.8; }

export function greenRegion(h){
  const gr = h.greenRmax + 9;
  return { minX: h.greenC.x - gr, maxX: h.greenC.x + gr, minZ: h.greenC.z - gr, maxZ: h.greenC.z + gr, r: gr };
}

export function prepareHole(h, quality){
  const b = h.bounds;
  const main = paintPixels(h, b, surfacePPY(quality));

  // inner terrain grid heights (the skirt is added by the renderer)
  const step = terrainStep(quality);
  const nx = Math.ceil((b.maxX - b.minX) / step) + 1;
  const nz = Math.ceil((b.maxZ - b.minZ) / step) + 1;
  const heights = new Float32Array(nx * nz);
  for (let r = 0; r < nz; r++){
    const z = Math.min(b.maxZ, b.minZ + r * step);
    for (let c = 0; c < nx; c++) heights[r * nx + c] = h.heightAt(Math.min(b.maxX, b.minX + c * step), z);
  }

  // high-resolution green patch
  const gReg = greenRegion(h);
  const green = paintPixels(h, gReg, 14, { edgeFade: 3, salt: 3 });
  const gs = 0.33;
  const gn = Math.ceil(gReg.r * 2 / gs) + 1;
  const gHeights = new Float32Array(gn * gn);
  for (let r = 0; r < gn; r++){
    const z = gReg.minZ + Math.min(gReg.r * 2, r * gs);
    for (let c = 0; c < gn; c++) gHeights[r * gn + c] = h.heightAt(gReg.minX + Math.min(gReg.r * 2, c * gs), z);
  }

  // grid lines for reading putts
  const pts = [];
  const on = (x, z) => { const s = h.surfaceAt(x, z); return s === 'green' || s === 'fringe'; };
  const sub = 0.25;
  for (let gx = Math.ceil(gReg.minX); gx <= gReg.maxX; gx += 1){
    for (let z = gReg.minZ; z < gReg.maxZ - sub; z += sub)
      if (on(gx, z) && on(gx, z + sub)) pts.push(gx, h.heightAt(gx, z) + 0.02, z, gx, h.heightAt(gx, z + sub) + 0.02, z + sub);
  }
  for (let gz = Math.ceil(gReg.minZ); gz <= gReg.maxZ; gz += 1){
    for (let x = gReg.minX; x < gReg.maxX - sub; x += sub)
      if (on(x, gz) && on(x + sub, gz)) pts.push(x, h.heightAt(x, gz) + 0.02, gz, x + sub, h.heightAt(x + sub, gz) + 0.02, gz);
  }

  return { quality, main, terr: { nx, nz, step, heights }, gReg, green, gpatch: { gn, gs, heights: gHeights },
           grid: new Float32Array(pts) };
}

export function transferables(p){
  return [p.main.data.buffer, p.terr.heights.buffer, p.green.data.buffer, p.gpatch.heights.buffer, p.grid.buffer];
}
