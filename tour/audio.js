/* ============================================================
   AUDIO — everything is synthesized, nothing to download.
   ============================================================ */
let AC = null, master = null, ambGain = null, windGain = null;
let muted = false;
let noiseBuf = null;

function ctx(){
  if (!AC){
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    AC = new C();
    master = AC.createGain();
    master.gain.value = muted ? 0 : 0.9;
    const comp = AC.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp); comp.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}

export function unlock(){ ctx(); }
export function setMuted(m){
  muted = m;
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.9, AC.currentTime, 0.05);
}
export const isMuted = () => muted;

function noise(dur, { type = 'bandpass', f = 1000, q = 1, vol = 0.3, attack = 0.002, decay, f2, when = 0 } = {}){
  const a = ctx(); if (!a) return;
  vol = Math.max(0.0005, vol || 0);
  const t = a.currentTime + when;
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const filt = a.createBiquadFilter();
  filt.type = type; filt.frequency.setValueAtTime(f, t); filt.Q.value = q;
  if (f2) filt.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (decay || dur));
  src.connect(filt); filt.connect(g); g.connect(master);
  src.start(t, Math.random()); src.stop(t + dur + 0.05);
}
function tone(freq, dur, { type = 'sine', vol = 0.2, attack = 0.002, f2, when = 0 } = {}){
  const a = ctx(); if (!a) return;
  vol = Math.max(0.0005, vol || 0);
  const t = a.currentTime + when;
  const o = a.createOscillator();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}

export const sfx = {
  ui(){ tone(880, 0.05, { vol: 0.05, type: 'triangle' }); },
  tick(){ tone(1400, 0.025, { vol: 0.035, type: 'square' }); },
  select(){ tone(660, 0.06, { vol: 0.06, type: 'triangle' }); tone(990, 0.08, { vol: 0.05, type: 'triangle', when: 0.05 }); },
  whoosh(power = 1){
    noise(0.32, { type: 'bandpass', f: 300, f2: 2600, q: 1.2, vol: 0.18 * power, attack: 0.18, decay: 0.32 });
  },
  // the strike itself: a crack for woods, a crisp click for irons
  hit(kind, quality = 1){
    if (kind === 'driver' || kind === 'wood'){
      noise(0.09, { type: 'highpass', f: 2200, vol: 0.55, decay: 0.08 });
      tone(1750, 0.12, { vol: 0.16, type: 'triangle', f2: 1500 });
      tone(220, 0.09, { vol: 0.2 });
    } else if (kind === 'putter'){
      tone(1150, 0.07, { vol: 0.14, type: 'triangle' });
      noise(0.04, { type: 'bandpass', f: 3000, vol: 0.12 });
    } else {
      noise(0.07, { type: 'bandpass', f: 3600, q: 0.8, vol: 0.5, decay: 0.06 });
      tone(2300, 0.06, { vol: 0.08, type: 'triangle' });
      tone(160, 0.08, { vol: 0.16 });
      noise(0.16, { type: 'lowpass', f: 900, vol: 0.12 * quality, attack: 0.01, decay: 0.15, when: 0.01 });  // turf
    }
    if (quality > 0.95) tone(3200, 0.18, { vol: 0.035, when: 0.02 });   // the pure ring
  },
  sand(){ noise(0.35, { type: 'bandpass', f: 1400, q: 0.6, vol: 0.35, attack: 0.01, decay: 0.3 }); },
  land(surf, speed){
    const v = Math.min(1, speed / 25);
    if (surf === 'bunker'){ noise(0.15, { type: 'lowpass', f: 700, vol: 0.18 * v + 0.04 }); return; }
    if (surf === 'green' || surf === 'fringe'){ tone(140, 0.07, { vol: 0.12 * v + 0.03 }); noise(0.05, { type: 'lowpass', f: 500, vol: 0.08 * v }); return; }
    noise(0.1, { type: 'lowpass', f: 450, vol: 0.14 * v + 0.03 });
  },
  tree(){
    for (let i = 0; i < 4; i++) noise(0.12, { type: 'bandpass', f: 1800 + i * 500, q: 2, vol: 0.12, when: i * 0.05 });
    tone(320, 0.05, { vol: 0.12, type: 'square', when: 0.03 });
  },
  splash(){
    noise(0.7, { type: 'lowpass', f: 1800, f2: 300, vol: 0.4, attack: 0.01, decay: 0.7 });
    for (let i = 0; i < 6; i++) tone(500 + Math.random() * 700, 0.08, { vol: 0.04, when: 0.1 + i * 0.07, f2: 900 });
  },
  cup(){
    // rattle then the drop
    tone(1900, 0.05, { vol: 0.1, type: 'triangle' });
    tone(1500, 0.05, { vol: 0.09, type: 'triangle', when: 0.08 });
    tone(1250, 0.06, { vol: 0.08, type: 'triangle', when: 0.15 });
    tone(320, 0.18, { vol: 0.2, when: 0.22, f2: 180 });
  },
  lip(){ tone(1700, 0.06, { vol: 0.1, type: 'triangle' }); tone(1300, 0.05, { vol: 0.06, type: 'triangle', when: 0.06 }); },
  crowd(intensity = 1, dur = 2.6){
    // a swell of claps and cheers
    noise(dur, { type: 'bandpass', f: 1100, q: 0.5, vol: 0.12 * intensity, attack: 0.35, decay: dur });
    const claps = Math.round(40 * intensity);
    for (let i = 0; i < claps; i++){
      noise(0.03, { type: 'bandpass', f: 1500 + Math.random() * 1500, q: 1.5, vol: 0.05 + Math.random() * 0.05,
                    when: 0.15 + Math.random() * dur * 0.75 });
    }
  },
  groan(){ noise(1.2, { type: 'bandpass', f: 500, f2: 260, q: 1.4, vol: 0.12, attack: 0.15, decay: 1.2 }); },
  ooh(){ noise(1.0, { type: 'bandpass', f: 420, f2: 700, q: 3, vol: 0.12, attack: 0.15, decay: 1.0 }); },
  fanfare(){
    [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, { vol: 0.07, type: 'triangle', when: i * 0.1 }));
  }
};

/* Ambience: wind bed + occasional birdsong. */
let birdTimer = null;
export function startAmbience(windMph = 5){
  const a = ctx(); if (!a) return;
  if (!ambGain){
    ambGain = a.createGain(); ambGain.gain.value = 0; ambGain.connect(master);
    const src = a.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
    windGain = a.createGain(); windGain.gain.value = 0.04;
    src.connect(f); f.connect(windGain); windGain.connect(ambGain);
    src.start();
  }
  ambGain.gain.setTargetAtTime(1, a.currentTime, 1.5);
  windGain.gain.setTargetAtTime(0.02 + Math.min(0.12, windMph * 0.007), a.currentTime, 1.5);
  clearInterval(birdTimer);
  birdTimer = setInterval(() => { if (Math.random() < 0.45) bird(); }, 2600);
}
export function stopAmbience(){
  if (ambGain && AC) ambGain.gain.setTargetAtTime(0, AC.currentTime, 0.5);
  clearInterval(birdTimer);
}
function bird(){
  const base = 2200 + Math.random() * 1800;
  const n = 2 + Math.floor(Math.random() * 4);
  for (let i = 0; i < n; i++){
    tone(base * (1 + Math.random() * 0.2), 0.08, { vol: 0.018, f2: base * (1.3 + Math.random() * 0.4), when: i * 0.11 });
  }
}
