/* Seeded randomness and smooth 2D value noise. */

export function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Value noise on an integer lattice, hashed from a seed so every hole differs.
export function makeNoise(seed){
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--){ const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) vals[i] = rnd() * 2 - 1;

  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  function n2(x, y){
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const a = vals[perm[X + perm[Y]]],     b = vals[perm[X + 1 + perm[Y]]];
    const c = vals[perm[X + perm[Y + 1]]], d = vals[perm[X + 1 + perm[Y + 1]]];
    const u = fade(xf), v = fade(yf);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  }
  function fbm(x, y, oct){
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < (oct || 4); i++){
      s += n2(x * f + i * 17.3, y * f - i * 9.1) * amp;
      norm += amp; amp *= 0.5; f *= 2.03;
    }
    return s / norm;
  }
  return { n2, fbm };
}

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
