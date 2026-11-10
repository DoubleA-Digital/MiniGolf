/* Builds hole surfaces off the main thread. The hole itself is regenerated
   here from the same seed, so nothing but numbers has to cross over. */
import { genHole } from './course.js';
import { prepareHole, transferables } from './prepare.js';

self.onmessage = e => {
  const { id, seed, par, theme, quality } = e.data;
  try{
    const h = genHole(seed, par, theme);
    const p = prepareHole(h, quality);
    self.postMessage({ id, ok: true, prep: p }, transferables(p));
  }catch(err){
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
