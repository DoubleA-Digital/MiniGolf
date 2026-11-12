/* ============================================================
   TOUR GOLF — game flow, the three shot mechanics, camera, HUD.
   ============================================================ */
import * as THREE from 'three';
import { CLUBS, PUTTER, SHOTS, LIES, SURF, DIFFICULTY, THEMES, PARS_18, STROKE_CAP, SCORE_NAMES,
         PLAYER_COLORS, G as GRAV, MPH } from './config.js';
import { genHole, gradAt, underTree, defaultAim } from './course.js';
import { launch, rollStart, simulate, speedFor, solveRising, windVec, samplePath, pathDuration } from './physics.js';
import { World } from './render.js';
import { createGolfer, clubKind } from './golfer.js';
import { sfx, unlock, setMuted, isMuted, startAmbience, stopAmbience } from './audio.js';
import { clamp, lerp, smooth } from './noise.js';
import { net, peerError, MAX_PLAYERS } from './net.js';

const $ = id => document.getElementById(id);
const YD_FT = 3;
const TAU = Math.PI * 2;
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); };
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (a, b) => Math.atan2(b.x - a.x, -(b.z - a.z));
const fmtPar = r => r === 0 ? 'E' : r > 0 ? '+' + r : String(r);

/* ============================================================
   PROFILE — shared with Mini Golf (same storage key and RPCs)
   ============================================================ */
const SUPA_URL = 'https://esogrnjilzxcmvgpieib.supabase.co';
const SUPA_KEY = 'sb_publishable__QUefxDt7tRi9Y943QK7yw_ivbRt71u';
async function rpc(fn, args, timeoutMs){
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 9000);
  try{
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, { method: 'POST', signal: ac.signal,
      headers: { 'apikey': SUPA_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
    if (!r.ok) throw new Error(fn + ' ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const profile = { id: null, token: null, name: 'Player', avatar: 'golf', avatarImg: null, points: 0, online: false };
function loadProfile(){ try{ const raw = localStorage.getItem('mg_profile'); if (raw) Object.assign(profile, JSON.parse(raw)); }catch(e){} }
function saveProfile(){
  try{
    const raw = localStorage.getItem('mg_profile'); const cur = raw ? JSON.parse(raw) : {};
    localStorage.setItem('mg_profile', JSON.stringify(Object.assign(cur, { id: profile.id, token: profile.token,
      name: profile.name, avatar: profile.avatar, avatarImg: profile.avatarImg, points: profile.points })));
  }catch(e){}
}
async function refreshProfile(){
  loadProfile();
  try{
    if (profile.id && profile.token){
      const rows = await rpc('mg_get_profile', { p_id: profile.id, p_token: profile.token });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row){ profile.name = row.name; profile.avatar = row.avatar; profile.avatarImg = row.avatar_img; profile.points = row.points; }
      profile.online = true;
    }
  }catch(e){ profile.online = false; }
  saveProfile(); paintChip();
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function avatarHTML(r){
  if (r && r.avatarImg) return `<img src="${esc(r.avatarImg)}" alt="">`;
  const a = r && r.avatar;
  if (!a || a === 'golf') return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#fff"/><circle cx="9" cy="9" r="1.4" fill="rgba(0,0,0,.12)"/><circle cx="14" cy="8" r="1.4" fill="rgba(0,0,0,.12)"/><circle cx="12" cy="13" r="1.4" fill="rgba(0,0,0,.12)"/><circle cx="8" cy="14" r="1.4" fill="rgba(0,0,0,.12)"/><circle cx="16" cy="13" r="1.4" fill="rgba(0,0,0,.12)"/></svg>';
  return esc(a);
}
function paintChip(){
  $('meChip').innerHTML = `<span class="av">${avatarHTML(profile)}</span><div><b>${esc(profile.name)}</b>
    <span>${profile.points} pts${profile.online ? '' : ' · offline'}</span></div>`;
}

/* ============================================================
   SETTINGS
   ============================================================ */
const settings = { theme: 'pines', holes: 9, diff: 'pro', names: [], sound: true, quality: 'high' };
try{ Object.assign(settings, JSON.parse(localStorage.getItem('tour_settings') || '{}')); }catch(e){}
if (!THEMES[settings.theme]) settings.theme = 'pines';
if (!DIFFICULTY[settings.diff]) settings.diff = 'pro';
const saveSettings = () => { try{ localStorage.setItem('tour_settings', JSON.stringify(settings)); }catch(e){} };
setMuted(!settings.sound);

/* ============================================================
   STATE
   ============================================================ */
const S = {
  phase: 'boot',
  theme: settings.theme, D: DIFFICULTY[settings.diff], diffKey: settings.diff,
  online: false, meIdx: 0,     // online: every client plays its own ball at the same time
  pars: [], holeIdx: 0, h: null, seed: 0,
  players: [], cur: 0, order: [],
  mode: 'full', allowed: { full: true, chip: false, putt: false },
  club: 0, shotType: 'pitch',
  aimYaw: 0, strike: { u: 0, v: 0 },
  chipTarget: 20, puttPace: 3,
  meter: { phase: 'idle', m: 0, power: 0, flash: 0, label: '' },
  hold: { on: false, t: 0, g: 0 },
  down: null,                 // a short downswing animation that fires the shot on impact
  follow: null,               // follow-through animation
  shot: null,                 // playback
  overview: false, read: false,
  preview: null, previewDirty: true,
  t: 0
};
const me = () => S.players[S.cur];

// game-time timers: they stop while the game is paused and vanish with the round
const timers = [];
function later(fn, ms){ timers.push({ t: ms / 1000, fn }); }
function stepTimers(dt){
  for (let i = 0; i < timers.length; i++){
    const tm = timers[i];
    tm.t -= dt;
    if (tm.t <= 0){ timers.splice(i--, 1); tm.fn(); }
  }
}

/* ============================================================
   WORLD
   ============================================================ */
const world = new World($('gl'));
world.setQuality(settings.quality);
const cam = { pos: new THREE.Vector3(0, 30, 60), look: new THREE.Vector3(0, 0, 0),
              tPos: new THREE.Vector3(), tLook: new THREE.Vector3(), k: 4, fov: 50, tFov: 50, cut: false, shake: 0 };
const otherBallGeo = new THREE.SphereGeometry(0.0233, 14, 10);

/* Hole surfaces are painted in a worker, and the next hole is prepared
   while the current one is being played. */
const prepWorker = (() => {
  try{ return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); }catch(e){ return null; }
})();
const prepWaiting = new Map(), prepCache = new Map();
let prepId = 0;
if (prepWorker){
  prepWorker.onmessage = e => {
    const res = prepWaiting.get(e.data.id);
    if (res){ prepWaiting.delete(e.data.id); res(e.data.ok ? e.data.prep : null); }
  };
  prepWorker.onerror = () => { for (const res of prepWaiting.values()) res(null); prepWaiting.clear(); };
}
function requestPrep(seed, par, theme){
  const key = `${seed}|${par}|${theme}|${settings.quality}`;
  if (prepCache.has(key)) return prepCache.get(key);
  const pr = !prepWorker ? Promise.resolve(null) : new Promise(res => {
    const id = ++prepId;
    prepWaiting.set(id, res);
    prepWorker.postMessage({ id, seed, par, theme, quality: settings.quality });
    setTimeout(() => { if (prepWaiting.has(id)){ prepWaiting.delete(id); res(null); } }, 25000);
  });
  prepCache.set(key, pr);
  return pr;
}
function takePrep(seed, par, theme){
  const pr = requestPrep(seed, par, theme);
  prepCache.delete(`${seed}|${par}|${theme}|${settings.quality}`);
  return pr;
}
const holeSeed = i => S.seed + i * 7919 + 13;

/* speed solving is the expensive bit, so remember the answers */
const speedCache = new Map();
function cachedSpeed(carry, launchDeg, spin){
  const key = `${Math.round(carry * 4)}|${launchDeg.toFixed(1)}|${Math.round(spin / 50)}`;
  let v = speedCache.get(key);
  if (v === undefined){ v = speedFor(Math.round(carry * 4) / 4, launchDeg, spin); speedCache.set(key, v); }
  return v;
}

/* ============================================================
   ROUND FLOW
   ============================================================ */
// opts (online): { seed, theme, holes, diff, roster } shared by the host
function startRound(opts){
  unlock();
  const online = !!opts;
  S.online = online;
  const roster = online ? opts.roster : playerNames().map(name => ({ name }));
  S.theme = online ? opts.theme : settings.theme;
  S.diffKey = online ? opts.diff : settings.diff;
  S.D = DIFFICULTY[S.diffKey];
  S.pars = PARS_18.slice(0, online ? opts.holes : settings.holes);
  S.seed = online ? opts.seed : (Math.random() * 1e9) | 0;
  timers.length = 0;
  S.players = roster.map((r, i) => {
    const n = r.name;
    const color = PLAYER_COLORS[i];
    const g = createGolfer(color, ['#d9a57e', '#8d5a3b', '#f0c8a0', '#b97a50'][i]);
    g.setGround((x, z) => world.groundAt(x, z));
    g.group.visible = false;
    world.scene.add(g.group);
    const ob = new THREE.Mesh(otherBallGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35,
      emissive: new THREE.Color(color), emissiveIntensity: 0.25 }));
    ob.visible = false;
    world.scene.add(ob);
    return {
      name: n, color, isMe: online ? r.pid === net.myPid : i === 0, pid: r.pid || null, gone: false, remote: null, stateHole: -1,
      avatar: online ? r.avatar : i === 0 ? profile.avatar : ['🦊', '🐼', '🐧'][i - 1],
      avatarImg: online ? r.avatarImg : i === 0 ? profile.avatarImg : null,
      scores: new Array(S.pars.length).fill(null), putts: new Array(S.pars.length).fill(0),
      strokes: 0, ball: { x: 0, y: 0, z: 0 }, lie: 'tee', under: null, holed: false, prev: null,
      stats: { fir: 0, firN: 0, gir: 0, longest: 0, birdies: 0 }, girDone: false,
      golfer: g, marker: ob
    };
  });
  S.meIdx = Math.max(0, S.players.findIndex(p => p.isMe));
  S.order = S.players.map((_, i) => i);
  requestPrep(holeSeed(0), S.pars[0], S.theme);
  $('onlineOv').classList.add('hidden');
  $('cardOv').classList.add('hidden');
  $('holeOv').classList.add('hidden');
  $('menu').classList.add('hidden');
  $('meChip').classList.add('hidden');
  loadHole(0);
}

function cleanupPlayers(){
  for (const p of S.players){
    world.scene.remove(p.golfer.group);
    world.scene.remove(p.marker);
    p.golfer.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
}

let introTimer = null;
function loadHole(i){
  S.holeIdx = i;
  S.phase = 'loading';
  timers.length = 0;
  hideHUD();
  fade(true);
  const round = S.seed;
  const prepP = takePrep(holeSeed(i), S.pars[i], S.theme);
  // let the fade land, and the worker finish, before building
  Promise.all([prepP, new Promise(r => setTimeout(r, 330))]).then(([prep]) => {
    if (S.seed !== round || S.phase !== 'loading') return;
    const h = genHole(holeSeed(i), S.pars[i], S.theme);
    h.wind.mph = Math.round(h.wind.mph * S.D.wind);
    S.h = h;
    world.buildHole(h, prep);
    world.warm();
    if (i + 1 < S.pars.length) requestPrep(holeSeed(i + 1), S.pars[i + 1], S.theme);
    buildMinimap();
    for (const p of S.players){
      p.marker.visible = false;
      // a faster friend may already have played this hole: keep what they sent
      if (p.stateHole === i) continue;
      p.strokes = 0; p.holed = false; p.lie = 'tee'; p.under = null; p.prev = null; p.girDone = false; p.remote = null;
      p.ball = { x: h.tee.x, y: h.tee.y + 0.03, z: h.tee.z };
      if (p.gone){ p.holed = true; p.scores[i] = STROKE_CAP; }
    }
    // honours: best score on the last hole tees off first
    if (i > 0 && !S.online){
      S.order = S.players.map((_, k) => k).sort((a, b) =>
        (S.players[a].scores[i - 1] - S.players[b].scores[i - 1]) || (a - b));
    }
    S.cur = S.online ? S.meIdx : S.order[0];
    S.shot = null;
    world.setTracer(null);
    startAmbience(h.wind.mph);
    startFlyover();
    // the first frame of a new hole uploads its textures: let it land behind the fade
    requestAnimationFrame(() => requestAnimationFrame(() => { if (S.seed === round) fade(false); }));
  });
}

function startFlyover(){
  const h = S.h;
  S.phase = 'intro';
  $('iNum').textContent = S.holeIdx + 1;
  $('iCourse').textContent = `${THEMES[S.theme].name} · ${S.holeIdx + 1} of ${S.pars.length}`;
  $('iPar').textContent = `PAR ${h.par}`;
  $('iYds').innerHTML = `<b>${h.length}</b> yards · wind ${h.wind.mph} mph`;
  const p = me();
  $('iWho').innerHTML = S.online
    ? `${S.players.map(q => `<span class="av" style="--pc:${q.color}">${avatarHTML(q)}</span>`).join('')}Everyone tees off together`
    : `<span class="av" style="--pc:${p.color}">${avatarHTML(p)}</span>${esc(p.name)} on the tee`;
  $('intro').classList.add('on');
  S.fly = { t: 0, dur: reduceMotion ? 0.01 : clamp(2.6 + h.length / 140, 3.4, 6.6) };
  cam.cut = true;
  clearTimeout(introTimer);
}
function endFlyover(){
  if (S.phase !== 'intro') return;
  $('intro').classList.remove('on');
  S.fly = null;
  cam.cut = true;
  beginTurn();
}

/* ---------- a player's turn ---------- */
function beginTurn(){
  const p = me(), h = S.h;
  S.phase = 'address';
  S.overview = false; S.read = false;
  world.setGreenRead(false);
  const d = hdist(p.ball, h.pin);
  const lie = p.lie;
  S.allowed = {
    full: lie !== 'green',
    chip: lie !== 'green' && lie !== 'tee' && d <= 105,
    putt: lie === 'green' || ((lie === 'fringe' || lie === 'fairway' || lie === 'tee') && d <= 32)
  };
  if (lie === 'green' || (lie === 'fringe' && d < 14)) S.mode = 'putt';
  else if (S.allowed.chip && d <= 78) S.mode = 'chip';
  else S.mode = 'full';
  S.shotType = lie === 'bunker' ? 'splash' : ((lie === 'fringe' || lie === 'fairway') && d < 28 ? 'bump' : 'pitch');
  if (S.shotType !== 'splash' && d > 55) S.shotType = 'pitch';
  S.strike = { u: 0, v: 0 };
  S.meter = { phase: 'idle', m: 0, power: 0, flash: 0, label: '' };
  S.hold = { on: false, t: 0, g: 0 };
  S.down = null; S.follow = null;
  S.club = suggestClub();
  aimDefault();
  if (S.mode === 'chip') planChip();
  if (S.mode === 'putt') S.puttPace = suggestPace();
  for (const q of S.players){
    q.golfer.group.visible = q === p;
    q.marker.visible = q !== p && !q.holed;
    if (q !== p && !q.remote) q.marker.position.set(q.ball.x, world.visualY(q.ball), q.ball.z);
  }
  placeGolfer();
  S.previewDirty = true;
  world.setTracer(null);
  world.peg.visible = false;
  $('skipHint').classList.add('hidden');
  $('shotCard').classList.remove('on');
  showHUD();
  refreshHUD();
}

function aimDefault(){
  const p = me(), h = S.h;
  if (S.mode === 'putt' || S.mode === 'chip'){ S.aimYaw = yawTo(p.ball, h.pin); return; }
  const lie = LIES[p.lie];
  const reach = CLUBS[S.club].carry * lie.power + rollGuess(S.club);
  S.aimYaw = yawTo(p.ball, defaultAim(h, p.ball, reach));
}
const rollGuess = i => [26, 20, 15, 11, 9, 8, 7, 6, 5, 4, 3, 2, 2, 0][i] || 0;

function playsLike(dist, yaw, fromY, toY){
  const h = S.h;
  const along = Math.cos(h.wind.dir - yaw) * h.wind.mph;      // + tailwind
  const windK = along >= 0 ? -0.0045 * along : -0.0095 * along;
  return dist * (1 + windK) + (toY - fromY);
}

function suggestClub(){
  const p = me(), h = S.h;
  if (p.lie === 'green') return PUTTER;
  const d = hdist(p.ball, h.pin);
  const target = playsLike(d, yawTo(p.ball, h.pin), p.ball.y, h.pin.y);
  const lie = LIES[p.lie];
  let best = p.lie === 'tee' ? 0 : 1, bestGap = 1e9;
  for (let i = p.lie === 'tee' ? 0 : 1; i < PUTTER; i++){
    const reach = CLUBS[i].carry * lie.power + rollGuess(i) * 0.6;
    const gap = Math.abs(reach - target) + (reach < target ? 0 : 3);
    if (gap < bestGap){ bestGap = gap; best = i; }
  }
  return best;
}

function suggestPace(){
  const p = me(), h = S.h;
  const d = hdist(p.ball, h.pin);
  // uphill needs more, downhill less — a rough read, the player still decides
  const rise = h.pin.y - p.ball.y;
  // and a good putt finishes about a foot and a half past if it misses
  return clamp(d + 0.35 + rise * 7, 0.3, 30);
}

function placeGolfer(){
  const p = me();
  const g = p.golfer;
  const kind = S.mode === 'putt' ? 'putter' : S.mode === 'chip' ? (S.shotType === 'bump' ? 'iron' : 'wedge') : clubKind(CLUBS[S.club].id);
  g.setClub(kind);
  g.state.style = S.mode === 'putt' ? 'putt' : S.mode === 'chip' ? 'chip' : 'full';
  g.pose(0, g.state.style);
  g.group.position.set(p.ball.x, world.groundAt(p.ball.x, p.ball.z), p.ball.z);
  g.group.rotation.set(0, -S.aimYaw, 0);
}

/* ============================================================
   SHOT BUILDING
   ============================================================ */
function ballStart(){
  const p = me();
  return { x: p.ball.x, y: S.h.heightAt(p.ball.x, p.ball.z) + 0.0233 + (p.lie === 'tee' && S.mode === 'full' ? 0.03 : 0), z: p.ball.z };
}

// error > 0 slices (starts right, curves right); < 0 hooks
function buildFull(power, err){
  const p = me(), club = CLUBS[S.club], lie = LIES[p.lie];
  let carry = club.carry * power * lie.power * (1 - 0.16 * Math.pow(Math.min(1, Math.abs(err)), 1.3));
  let launchDeg = club.launch + lie.launch - S.strike.v * 3.2;
  let spin = club.spin * lie.spin * (1 - 0.32 * S.strike.v);
  if (p.under){ carry *= 0.72; launchDeg = Math.min(launchDeg, 6.5); spin *= 0.5; }
  const speed = cachedSpeed(Math.max(1, carry), launchDeg, spin);
  const yaw = S.aimYaw - S.strike.u * 0.026 + err * 0.034;
  const tilt = S.strike.u * -0.1 * (club.err + 0.2) - err * 0.17;
  return launch(ballStart(), yaw, speed, launchDeg, spin, tilt);
}

// The landing distance of a chip is solved on the real terrain so the
// ghost ball means exactly what it shows.
const chipCache = new Map();
function chipSpeed(carry, launchDeg, spin){
  const p = me(), h = S.h;
  const key = `${S.holeIdx}|${p.ball.x.toFixed(2)}|${p.ball.z.toFixed(2)}|${S.aimYaw.toFixed(3)}|${launchDeg}|${Math.round(spin)}|${carry.toFixed(1)}`;
  if (chipCache.has(key)) return chipCache.get(key);
  const from = ballStart();
  // solved to a few millimetres of carry, finer than the simulation's own step
  const v = solveRising(sp => {
    const r = simulate(h, launch(from, S.aimYaw, sp, launchDeg, spin, 0), { airOnly: true, maxT: 8 });
    return r.carryPt ? hdist(r.carryPt, from) : 999;
  }, carry, 0.5, 70, 0.004, 0.003);
  if (chipCache.size > 4000) chipCache.clear();
  chipCache.set(key, v);
  return v;
}
function chipParams(){
  const p = me(), sh = SHOTS[S.shotType], lie = LIES[p.lie];
  let launchDeg = sh.launch, spin = sh.spin;
  if (p.lie === 'rough'){ launchDeg -= 2; spin *= 0.55; }
  else if (p.lie === 'deep'){ launchDeg -= 4; spin *= 0.35; }
  else if (p.lie === 'bunker' && S.shotType !== 'splash'){ spin *= 0.6; }
  else if (p.lie === 'waste'){ spin *= 0.7; }
  if (p.under) launchDeg = Math.min(launchDeg, 8);
  return { launchDeg, spin, lie };
}
function buildChip(carry, yawErr = 0){
  const { launchDeg, spin } = chipParams();
  const v = chipSpeed(carry, launchDeg, spin);
  return launch(ballStart(), S.aimYaw + yawErr, v, launchDeg, spin, 0);
}
function planChip(){
  // land it where it will release to the hole (calm air)
  const p = me(), h = S.h, sh = SHOTS[S.shotType];
  const dPin = hdist(p.ball, h.pin);
  if (S.diffKey === 'tour'){
    S.chipTarget = clamp(dPin * (S.shotType === 'bump' ? 0.4 : S.shotType === 'flop' ? 0.92 : 0.75), 0.8, sh.maxCarry);
    return;
  }
  let lo = 0.8, hi = Math.min(sh.maxCarry, dPin + 2);
  for (let i = 0; i < 11; i++){
    const mid = (lo + hi) / 2;
    const r = simulate(h, buildChip(mid), { maxT: 14 });
    const fx = Math.sin(S.aimYaw), fz = -Math.cos(S.aimYaw);
    const along = (r.rest.x - p.ball.x) * fx + (r.rest.z - p.ball.z) * fz;
    if (along < dPin) lo = mid; else hi = mid;
  }
  let t = (lo + hi) / 2;
  if (S.diffKey === 'pro') t = Math.round(t / 2) * 2;
  else if (S.diffKey === 'tour') t = dPin * (S.shotType === 'bump' ? 0.4 : S.shotType === 'flop' ? 0.92 : 0.75);
  S.chipTarget = clamp(t, 0.8, sh.maxCarry);
}

function puttSpeed(pace){ return Math.sqrt(2 * SURF.green.roll * GRAV * Math.max(0.05, pace)); }

/* ============================================================
   FIRING
   ============================================================ */
function meterClick(){
  if (S.phase !== 'address' || S.mode !== 'full' || S.down) return;
  const M = S.meter;
  unlock();
  if (M.phase === 'idle'){ M.phase = 'power'; M.m = 0; M.label = ''; sfx.tick(); }
  else if (M.phase === 'power'){ M.power = Math.max(0.05, M.m); M.phase = 'return'; sfx.tick(); }
  else if (M.phase === 'return'){ fireFull(M.m); }
}
function stepMeter(dt){
  const M = S.meter;
  const rate = S.D.meter;
  if (M.phase === 'power'){
    M.m += dt * 0.84 * rate;
    if (M.m >= 1.1){ M.m = 1.1; M.power = 1.1; M.phase = 'return'; }
    me().golfer.pose(-Math.min(1.05, M.m), 'full');
  } else if (M.phase === 'return'){
    const prev = M.m;
    M.m -= dt * 1.32 * rate;
    if (prev > 0.3 && M.m <= 0.3) sfx.whoosh(Math.min(1, M.power));
    const u = clamp(M.m / Math.max(0.05, M.power), 0, 1);
    me().golfer.pose(-Math.min(1.05, M.power) * Math.pow(u, 0.6), 'full', { down: true, top: Math.min(1.05, M.power) });
    if (M.m <= -0.17){ M.m = -0.17; fireFull(-0.17); }
  }
  if (M.flash > 0) M.flash -= dt;
}
function fireFull(mAt){
  const M = S.meter, D = S.D, p = me();
  M.phase = 'done';
  const perfect = Math.abs(mAt) <= D.perfect;
  let acc = perfect ? 0 : mAt / D.window;            // + early (slice), - late (hook)
  const over = Math.max(0, M.power - 1);
  const lie = LIES[p.lie];
  let err = acc * (1 + over * 5) * CLUBS[S.club].err * lie.err;
  const calm = p.lie === 'tee' || p.lie === 'fairway';
  err += gauss() * 0.05 * lie.err * (calm ? 0.5 : 1);
  M.label = perfect ? 'PERFECT' : Math.abs(acc) < 0.35 ? 'GOOD' : acc > 0 ? (acc > 0.9 ? 'SLICE' : 'PUSH') : (acc < -0.9 ? 'HOOK' : 'PULL');
  if (over > 0.03 && Math.abs(acc) < 0.35) M.label = 'POWER';
  M.flash = 1.4;
  M.quality = perfect ? 1 : Math.max(0, 1 - Math.abs(acc));
  const st = buildFull(M.power, err);
  const club = CLUBS[S.club];
  const v0 = Math.hypot(st.v.x, st.v.y, st.v.z);       // simulate() consumes the state
  const shot = simulate(S.h, st, { wind: windVec(S.h), trees: true });
  S.follow = { t: 0, dur: 0.75, style: 'full' };
  launchShot(shot, 'full', { club: club.name, power: M.power, tag: M.label, quality: M.quality,
                             kind: clubKind(club.id), speed: v0 });
}

function holdStart(){
  if (S.phase !== 'address' || S.mode !== 'chip' || S.hold.on || S.down) return;
  unlock();
  S.hold = { on: true, t: 0, g: 0 };
  $('holdBtn').classList.add('on');
  sfx.tick();
}
function stepHold(dt){
  const H = S.hold;
  if (!H.on) return;
  const sh = SHOTS[S.shotType];
  const T = 1.7 / S.D.chipSpeed;
  H.t += dt;
  H.g = sh.maxCarry * Math.min(1.04, Math.pow(H.t / T, 1.45));
  me().golfer.pose(-Math.min(1, H.g / sh.maxCarry) * 0.95, 'chip');
}
function holdRelease(){
  const H = S.hold;
  if (!H.on) return;
  H.on = false;
  $('holdBtn').classList.remove('on');
  if (H.g < 0.4){ me().golfer.pose(0, 'chip'); return; }        // a tap is not a swing
  const p = me(), sh = SHOTS[S.shotType], lie = LIES[p.lie];
  let carry = H.g;
  // the lie adds its own uncertainty on top of your timing
  const spread = { fairway: 0.015, fringe: 0.015, tee: 0.015, rough: 0.05, deep: 0.1, bunker: 0.08, waste: 0.06 }[p.lie] ?? 0.04;
  carry *= 1 + gauss() * spread;
  if (p.lie === 'deep') carry *= 0.9;
  const yawErr = gauss() * 0.012 * sh.err * lie.err;
  const diff = H.g - S.chipTarget;
  const tol = Math.max(0.6, S.chipTarget * 0.045);
  const tag = Math.abs(diff) <= tol * 0.5 ? 'PERFECT' : Math.abs(diff) <= tol ? 'GOOD' : diff < 0 ? 'SHORT' : 'LONG';
  const s0 = -Math.min(1, H.g / sh.maxCarry) * 0.95;
  S.down = { t: 0, dur: 0.17, from: s0, style: 'chip', fire: () => {
    const st = buildChip(Math.max(0.5, carry), yawErr);
    const v0 = Math.hypot(st.v.x, st.v.y, st.v.z);
    const shot = simulate(S.h, st, { wind: windVec(S.h), trees: true });
    S.follow = { t: 0, dur: 0.55, style: 'chip', to: 0.6 };
    launchShot(shot, 'chip', { club: sh.name, tag, quality: tag === 'PERFECT' ? 1 : 0.7,
                               kind: S.shotType === 'bump' ? 'iron' : 'wedge', speed: v0 });
  } };
}

function strokePutt(){
  if (S.phase !== 'address' || S.mode !== 'putt' || S.down) return;
  if (S.puttPace < 0.1) return;
  unlock();
  const pace = S.puttPace;
  const s0 = -Math.min(1, Math.sqrt(pace / 30)) * 1.0;
  const D = S.D;
  S.down = { t: 0, dur: 0.26, from: s0, style: 'putt', fire: () => {
    const yawErr = gauss() * D.puttErr * (Math.PI / 180) * (0.6 + pace / 15);
    const v = puttSpeed(pace) * (1 + gauss() * 0.012 * D.puttErr);
    const st = rollStart(ballStart(), S.aimYaw + yawErr, v);
    const shot = simulate(S.h, st, {});
    S.follow = { t: 0, dur: 0.5, style: 'putt', to: 0.5 };
    launchShot(shot, 'putt', { club: 'Putter', tag: '', kind: 'putter', speed: v });
  } };
}

function launchShot(sim, kind, info){
  const p = me(), h = S.h;
  p.prev = { ball: { ...p.ball }, lie: p.lie, under: p.under };
  p.strokes++;
  if (kind === 'putt') p.putts[S.holeIdx]++;
  S.phase = 'flight';
  S.overview = false; S.read = false;
  world.setGreenRead(false);
  const from = { ...sim.samples ? { x: sim.samples[0], y: sim.samples[1], z: sim.samples[2] } : p.ball };
  const yaw = S.aimYaw;
  S.shot = { sim, t: 0, dur: pathDuration(sim), kind, info, ev: 0, from, yaw, fromLie: p.lie,
             landT: sim.carryPt ? sim.carryPt.t : 0, cut: false, speed: 1, done: false, landCam: null,
             side: Math.random() < 0.5 ? -1 : 1, holedAt: null };
  sfx.hit(info.kind, info.quality ?? 1);
  if (S.online) sendShot(sim);
  if (kind === 'full'){
    const big = info.kind === 'driver' || info.kind === 'wood';
    cam.shake = big ? 0.09 : 0.05;
    cam.fov += big ? 4 : 2.5;
  }
  // impact debris
  const dir = { x: Math.sin(yaw), z: -Math.cos(yaw) };
  const bp = { x: p.ball.x, y: h.heightAt(p.ball.x, p.ball.z), z: p.ball.z };
  if (kind !== 'putt'){
    if (p.lie === 'bunker'){ world.burst(bp, 70, h.T.sand, { up: 5, speed: 2.5, life: 1.1, size: 4, dir, push: 2.5 }); sfx.sand(); }
    else if (p.lie === 'deep' && h.T.snow) world.burst(bp, 60, '#ffffff', { up: 4.5, speed: 2.5, life: 1.1, size: 4, dir, push: 2.5 });
    else if (p.lie === 'fairway' || p.lie === 'rough' || p.lie === 'deep' || p.lie === 'fringe')
      world.burst(bp, p.lie === 'fairway' ? 26 : 40, p.lie === 'fairway' ? '#5d4630' : h.T.rough, { up: 4, speed: 2, life: 0.8, size: 4, dir, push: 3 });
    else if (p.lie === 'waste') world.burst(bp, 40, h.T.waste || '#cfa' , { up: 3.5, speed: 2.5, life: 0.9, size: 4, dir, push: 2 });
    else world.burst(bp, 10, '#ffffff', { up: 2, speed: 1.5, life: 0.5, size: 3, dir, push: 2 });
  }
  hideControls();
  $('skipHint').textContent = matchMedia('(pointer: coarse)').matches ? 'Tap to speed up' : 'Click or Space to speed up';
  $('skipHint').classList.toggle('hidden', kind === 'putt');
  refreshHUD();
}

/* ============================================================
   PLAYBACK
   ============================================================ */
const tmpP = { x: 0, y: 0, z: 0 };
function stepShot(dt){
  const sh = S.shot;
  if (!sh || sh.done) return;
  const sim = sh.sim, h = S.h;
  let rate = sh.speed;
  // the flight plays in real time, the run-out a little quicker
  if (sh.kind !== 'putt' && sim.carryPt && sh.t > sh.landT + 0.4) rate *= 1.7;
  if (sim.result === 'holed' && sh.kind !== 'full' && !reduceMotion){
    const left = sh.dur - sh.t;
    if (left < 0.9 && left > 0) rate = Math.min(rate, 0.45);
  }
  sh.t = Math.min(sh.dur, sh.t + dt * rate);
  samplePath(sim, sh.t, tmpP);
  // events
  while (sh.ev < sim.events.length && sim.events[sh.ev].t <= sh.t){
    const e = sim.events[sh.ev++];
    if (e.type === 'bounce'){
      if (e.speed > 1.2) sfx.land(e.surf, e.speed);
      const c = e.surf === 'bunker' ? h.T.sand : e.surf === 'waste' ? (h.T.waste || '#d3a676') : e.surf === 'deep' && h.T.snow ? '#ffffff' :
                e.surf === 'green' ? h.T.green : e.surf === 'fairway' ? h.T.fairway : h.T.rough;
      if (e.speed > 3) world.burst(e, e.surf === 'bunker' ? 40 : 12, c, { up: 2 + e.speed * 0.08, speed: 1.2, life: 0.7, size: 3.5 });
    } else if (e.type === 'tree'){
      sfx.tree();
      world.burst(e, 30, '#3f7a35', { up: 1, speed: 3, life: 1.4, size: 4, grav: 3 });
      toast('Timber!', '');
    } else if (e.type === 'splash'){
      sfx.splash();
      world.burst(e, 90, '#d9f0ff', { up: 7, speed: 2.4, life: 1.1, size: 4.5 });
    } else if (e.type === 'lip'){
      sfx.lip(); setTimeout(() => sfx.ooh(), 120);
    } else if (e.type === 'holed'){
      sfx.cup();
      sh.holedAt = sh.t;
    }
  }
  world.placeBall(tmpP);
  // tracer: draw the flight, fade it once the ball is on the ground
  if (sh.kind !== 'putt'){
    const landIdx = sh.landT / sim.sampleDt;
    const upto = Math.min(sh.t / sim.sampleDt, sim.carryPt ? landIdx : 1e9);
    world.setTracer(sim, upto, me().color, 1);
  }
  cameraFlight(dt);
  if (sh.t >= sh.dur){
    sh.done = true;
    $('skipHint').classList.add('hidden');
    later(finishShot, sim.result === 'holed' ? 250 : 650);
  }
}

function finishShot(){
  const sh = S.shot, p = me(), h = S.h;
  if (!sh) return;
  const sim = sh.sim;
  let tag = sh.info.tag, tagClass = tag === 'PERFECT' ? 'great' : tag === 'GOOD' || tag === 'POWER' ? 'good' : tag ? 'bad' : '';
  let restLie;
  if (sim.result === 'holed'){
    p.ball = { x: h.pin.x, y: h.pin.y, z: h.pin.z };
    holeOut(sh);
    return;
  }
  if (sim.result === 'water'){
    p.strokes++;
    const drop = findDrop(sim.entry || sim.rest, sh.from);
    p.ball = drop;
    banner('Water', '+1 penalty stroke', false);
    sfx.groan();
    tag = 'PENALTY'; tagClass = 'bad';
  } else if (sim.result === 'ob'){
    p.strokes++;
    p.ball = { ...p.prev.ball };
    banner('Out of bounds', 'Stroke and distance', false);
    sfx.groan();
    tag = 'PENALTY'; tagClass = 'bad';
  } else {
    p.ball = { ...sim.rest };
  }
  restLie = h.surfaceAt(p.ball.x, p.ball.z);
  if (sim.result === 'ob') restLie = p.prev.lie;
  p.lie = restLie;
  p.under = (restLie !== 'green' && restLie !== 'fringe') ? underTree(h, p.ball.x, p.ball.z) : null;

  // stats
  if (sh.fromLie === 'tee' && h.par > 3 && p.strokes <= 2){
    p.stats.firN++;
    if (restLie === 'fairway' && sim.result === 'rest') p.stats.fir++;
    if (CLUBS[S.club] && CLUBS[S.club].id === 'D' && sim.result === 'rest') p.stats.longest = Math.max(p.stats.longest, Math.round(sim.total));
  }
  if (restLie === 'green' && !p.girDone){
    p.girDone = true;
    if (p.strokes <= h.par - 2) p.stats.gir++;
  }

  const dPin = hdist(p.ball, h.pin);
  // gimme on the easy setting
  if (S.D.gimme && restLie === 'green' && dPin <= S.D.gimme){
    shotCard(sh, sim, tag, tagClass, dPin);
    later(() => { p.strokes++; p.putts[S.holeIdx]++; toast('Gimme', 'Inside two feet'); holeOut(sh, true); }, 700);
    return;
  }
  if (p.strokes >= STROKE_CAP){ pickUp(); return; }

  if (sim.result === 'rest'){
    if (restLie === 'bunker') toast('In the bunker', '');
    else if (p.under) toast('Under the trees', 'Punch it out');
    else if (restLie === 'green' && sh.kind !== 'putt') toast(dPin * YD_FT < 12 ? 'Stuck it close' : 'On the green', `${Math.round(dPin * YD_FT)} ft`);
  }
  shotCard(sh, sim, tag, tagClass, dPin);
  S.phase = 'result';
  later(nextTurn, sim.result === 'rest' ? 1500 : 1900);
}

// back along the line of flight until the ground is playable
function findDrop(entry, from){
  const h = S.h;
  const dx = from.x - entry.x, dz = from.z - entry.z;
  const L = Math.hypot(dx, dz) || 1;
  const ok = (x, z) => { const s = h.surfaceAt(x, z); return s !== 'water' && s !== 'ob' && s !== 'bunker'; };
  // need two clear yards in a row, then drop in the middle of them
  let run = 0;
  for (let d = 0.5; d < L; d += 0.5){
    const x = entry.x + dx / L * d, z = entry.z + dz / L * d;
    run = ok(x, z) ? run + 0.5 : 0;
    if (run >= 2.5){
      const x2 = entry.x + dx / L * (d - 1), z2 = entry.z + dz / L * (d - 1);
      if (ok(x2, z2)) return { x: x2, y: h.heightAt(x2, z2) + 0.0233, z: z2 };
    }
  }
  return { ...from };
}

function holeOut(sh, gimme){
  const p = me(), h = S.h;
  p.holed = true;
  p.scores[S.holeIdx] = p.strokes;
  p.marker.visible = false;
  const rel = p.strokes - h.par;
  let title = p.strokes === 1 ? 'Hole in one' : (SCORE_NAMES[rel] || (rel > 0 ? `+${rel}` : `${rel}`));
  const good = rel < 0 || p.strokes === 1;
  if (rel < 0) p.stats.birdies++;
  const dPutt = sh && sh.kind === 'putt' ? hdist(sh.from, h.pin) * YD_FT : 0;
  const sub = gimme ? `${p.name} · ${p.strokes} strokes` :
              sh && sh.kind === 'putt' && dPutt > 15 ? `${Math.round(dPutt)} ft putt · ${p.name}` :
              sh && sh.kind !== 'putt' ? `Holed from ${Math.round(hdist(sh.from, h.pin))} yards!` : `${p.name} · ${p.strokes} stroke${p.strokes > 1 ? 's' : ''}`;
  banner(title, sub, good);
  if (p.strokes === 1 || rel <= -2){ sfx.crowd(1.6, 4); sfx.fanfare(); world.confetti({ x: h.pin.x, y: h.pin.y + 0.3, z: h.pin.z }, 260); }
  else if (rel === -1){ sfx.crowd(1.1, 3); world.confetti({ x: h.pin.x, y: h.pin.y + 0.3, z: h.pin.z }, 120); }
  else if (rel === 0) sfx.crowd(0.55, 2);
  else if (sh && sh.kind === 'putt' && dPutt > 20) sfx.crowd(0.7, 2);
  S.phase = 'result';
  hideControls();
  later(nextTurn, 2600);
  refreshHUD();
}
function pickUp(){
  const p = me();
  p.holed = true;
  p.scores[S.holeIdx] = STROKE_CAP;
  p.marker.visible = false;
  banner('Picked up', `${p.name} · ${STROKE_CAP}`, false);
  S.phase = 'result';
  later(nextTurn, 1800);
}

function nextTurn(){
  if (S.phase === 'menu') return;
  if (S.online){ onlineNextTurn(); return; }
  const left = S.players.filter(p => !p.holed);
  if (!left.length){ endHole(); return; }
  let next;
  const notTeed = S.order.map(i => S.players[i]).filter(p => !p.holed && p.strokes === 0);
  if (notTeed.length) next = notTeed[0];
  else next = left.reduce((a, b) => hdist(a.ball, S.h.pin) >= hdist(b.ball, S.h.pin) ? a : b);
  const idx = S.players.indexOf(next);
  const switching = idx !== S.cur;
  S.cur = idx;
  world.setTracer(null);
  if (switching && S.players.length > 1){
    fade(true);
    later(() => { cam.cut = true; beginTurn(); fade(false); toast(`${next.name} is up`, `${Math.round(hdist(next.ball, S.h.pin))} yards out`); }, 300);
  } else {
    cam.cut = S.shot && S.shot.kind !== 'putt' && hdist(S.shot.from, next.ball) > 25;
    beginTurn();
  }
}

function onlineNextTurn(){
  sendState();
  const mine = S.players[S.meIdx];
  if (S.players.every(p => p.holed)){ endHole(); return; }
  world.setTracer(null);
  if (!mine.holed){
    S.cur = S.meIdx;
    cam.cut = S.shot && S.shot.kind !== 'putt' && hdist(S.shot.from, mine.ball) > 25;
    beginTurn();
    return;
  }
  // done: watch the others finish
  S.phase = 'waiting';
  mine.golfer.group.visible = false;
  hideControls();
  for (const q of S.players) q.marker.visible = q !== mine && !q.holed;
  waitToast();
}
function waitToast(){
  const left = S.players.filter(p => !p.holed).map(p => p.name);
  if (left.length) toast('Waiting for ' + left.join(', '), 'they are still playing');
}

function endHole(){
  if (S.phase === 'holeEnd') return;
  S.phase = 'holeEnd';
  hideHUD();
  const h = S.h, i = S.holeIdx;
  $('hoSub').textContent = `Hole ${i + 1} · Par ${h.par} · ${h.length} yds`;
  const rows = S.players.slice().sort((a, b) => toPar(a) - toPar(b));
  $('hoList').innerHTML = rows.map(p => {
    const s = p.scores[i], rel = s - h.par;
    const name = s === 1 ? 'Ace' : SCORE_NAMES[rel] || (rel > 0 ? `+${rel}` : rel);
    const tp = toPar(p);
    return `<div class="hs-row"><span class="av" style="--pc:${p.color}">${avatarHTML(p)}</span>
      <div class="n">${esc(p.name)}<div class="r">${name} · ${p.putts[i]} putt${p.putts[i] === 1 ? '' : 's'}</div></div>
      <div class="st">${s}</div><div class="tp ${tp < 0 ? 'u' : tp > 0 ? 'o' : ''}">${fmtPar(tp)}</div></div>`;
  }).join('');
  $('hoNext').textContent = i >= S.pars.length - 1 ? 'Final results' : `Hole ${i + 2}`;
  // online, the host walks the group to the next tee
  const wait = S.online && !net.isHost;
  $('hoNext').disabled = wait;
  if (wait) $('hoNext').textContent = 'Waiting for the host…';
  $('holeOv').classList.remove('hidden');
}
function nextHole(){
  if (S.online){
    if (!net.isHost || S.phase !== 'holeEnd') return;
    net.send({ t: 'next', hole: S.holeIdx + 1 });
  }
  goNextHole();
}
function goNextHole(){
  $('holeOv').classList.add('hidden');
  if (S.holeIdx >= S.pars.length - 1){ endRound(); return; }
  loadHole(S.holeIdx + 1);
}

function toPar(p){
  let r = 0;
  p.scores.forEach((s, i) => { if (s !== null) r += s - S.pars[i]; });
  return r;
}
function totalStrokes(p){ return p.scores.reduce((a, b) => a + (b || 0), 0); }

const bestKey = () => `${S.theme}|${S.pars.length}|${S.diffKey}`;
function loadBests(){ try{ return JSON.parse(localStorage.getItem('tour_best') || '{}'); }catch(e){ return {}; } }
function recordBest(){
  const p0 = S.players[S.meIdx];
  if (p0.scores.some(x => x === null)) return false;
  const bests = loadBests(), k = bestKey(), tp = toPar(p0);
  const prev = bests[k];
  if (prev && prev.toPar <= tp) return false;
  bests[k] = { toPar: tp, strokes: totalStrokes(p0), date: Date.now() };
  try{ localStorage.setItem('tour_best', JSON.stringify(bests)); }catch(e){}
  return true;
}

function endRound(){
  S.phase = 'over';
  S.newBest = recordBest();
  stopAmbience();
  awardPoints().finally(() => { if (S.phase === 'over' && !$('cardOv').classList.contains('hidden')) showCard(true); });
  showCard(true);
}

async function awardPoints(){
  const board = S.players.slice().sort((a, b) => toPar(a) - toPar(b));
  const mine = S.players[S.meIdx];
  const rank = board.indexOf(mine), n = board.length;
  const placement = n > 1 ? Math.round(100 * (n - 1 - rank) / (n - 1)) : 60;
  const under = mine.scores.reduce((a, s, i) => a + (s !== null && s < S.pars[i] ? 1 : 0), 0);
  const gained = Math.round((25 + placement + under * 8) * (S.pars.length === 18 ? 1.5 : 1));
  S.lastPoints = gained;
  profile.points += gained;
  saveProfile(); paintChip();
  if (profile.online && profile.id){
    try{
      const pts = await rpc('mg_award_points', { p_id: profile.id, p_token: profile.token, p_points: gained, p_won: rank === 0 && n > 1 });
      if (typeof pts === 'number' && pts >= 0){ profile.points = pts; saveProfile(); paintChip(); }
    }catch(e){}
  }
}

/* ============================================================
   CAMERA
   ============================================================ */
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
function groundY(x, z){ return S.h ? S.h.heightAt(x, z) : 0; }

function cameraAddress(){
  const p = me(), h = S.h;
  const b = p.ball;
  const a = S.aimYaw;
  const f = V3(Math.sin(a), 0, -Math.cos(a)), r = V3(Math.cos(a), 0, Math.sin(a));
  const bv = V3(b.x, groundY(b.x, b.z), b.z);
  let pos, look, fov = 50;
  if (S.read){
    const mid = V3((b.x + h.pin.x) / 2, 0, (b.z + h.pin.z) / 2);
    const d = hdist(b, h.pin);
    const hgt = Math.max(5, d * 0.95 + 3);
    pos = mid.clone().addScaledVector(f, -hgt * 0.35); pos.y = groundY(mid.x, mid.z) + hgt;
    look = mid.clone(); look.y = groundY(mid.x, mid.z);
    fov = 48;
  } else if (S.overview){
    const tgt = S.mode === 'full' && S.preview && S.preview.land ? S.preview.land : h.pin;
    const mid = V3((b.x + tgt.x) / 2, 0, (b.z + tgt.z) / 2);
    const d = Math.max(30, hdist(b, tgt));
    pos = mid.clone().addScaledVector(f, -d * 0.28); pos.y = groundY(mid.x, mid.z) + d * 0.95 + 10;
    look = mid.clone(); look.y = groundY(mid.x, mid.z);
    fov = 50;
  } else if (S.mode === 'putt'){
    const d = Math.min(28, hdist(b, h.pin));
    pos = bv.clone().addScaledVector(f, -(3.1 + d * 0.13)).addScaledVector(r, 0.78);
    pos.y = bv.y + 1.2 + d * 0.07;
    look = bv.clone().addScaledVector(f, Math.max(1.5, d * 0.6)).addScaledVector(r, 0.2);
    look.y = groundY(look.x, look.z) + 0.05;
    fov = 46;
  } else if (S.mode === 'chip'){
    const d = Math.min(45, Math.max(8, S.chipTarget * 1.3));
    pos = bv.clone().addScaledVector(f, -4.6).addScaledVector(r, 0.75);
    pos.y = bv.y + 1.85;
    look = bv.clone().addScaledVector(f, d * 0.75);
    look.y = groundY(look.x, look.z) + 0.6;
    fov = 50;
  } else {
    pos = bv.clone().addScaledVector(f, -5.4).addScaledVector(r, 0.85);
    pos.y = bv.y + 2.25;
    look = bv.clone().addScaledVector(f, 45);
    look.y = bv.y + 1.9;
    fov = 52;
  }
  // tall screens: tilt down so the ball sits clear of the control dock
  if (innerWidth < innerHeight && !S.read && !S.overview) look.y -= 0.9 + (S.mode === 'putt' ? -0.5 : 0);
  // never park the camera inside a tree canopy
  if (!S.read && !S.overview){
    const inTree = q => h.trees.some(t => {
      if (t.kind === 'gorse' || t.kind === 'rock') return false;
      const rr = t.kind === 'cactus' ? 0.7 : t.r * 1.1;
      return Math.hypot(q.x - t.x, q.z - t.z) < rr && q.y > t.y + t.trunk * 0.7 && q.y < t.y + t.h + t.r * 1.6;
    });
    for (const [back, up] of [[3.4, 1.6], [2.2, 1.35], [1.4, 1.2]]){
      if (!inTree(pos)) break;
      pos = bv.clone().addScaledVector(f, -back).addScaledVector(r, 0.6);
      pos.y = bv.y + up;
    }
  }
  const gy = groundY(pos.x, pos.z);
  if (pos.y < gy + 0.6) pos.y = gy + 0.6;
  cam.tPos.copy(pos); cam.tLook.copy(look); cam.tFov = portraitFov(fov);
  cam.k = S.read || S.overview ? 3 : 5;
}

function cameraFlight(dt){
  const sh = S.shot, sim = sh.sim, h = S.h;
  const b = V3(tmpP.x, tmpP.y, tmpP.z);
  const f = V3(Math.sin(sh.yaw), 0, -Math.cos(sh.yaw)), r = V3(Math.cos(sh.yaw), 0, Math.sin(sh.yaw));
  if (sh.kind === 'putt'){
    const start = V3(sh.from.x, sh.from.y, sh.from.z);
    const d = hdist(sh.from, h.pin);
    const along = b.clone().sub(start).dot(f);
    const base = start.clone().addScaledVector(f, -(3.1 + Math.min(28, d) * 0.13) + Math.max(0, along - 3) * 0.6).addScaledVector(r, 0.78);
    base.y = start.y + 1.2 + Math.min(28, d) * 0.07;
    cam.tPos.copy(base);
    cam.tLook.copy(b);
    cam.k = 3; cam.tFov = portraitFov(46);
    return;
  }
  const carry = sim.carry;
  const landCut = sh.kind === 'full' && carry > 85;
  const tCut = sh.landT * 0.52;
  if (landCut && sh.t > tCut){
    if (!sh.landCam){
      const L = sim.carryPt;
      // stand off to the side and beyond the landing spot, looking back up the line
      let side = sh.side;
      const mk = s => {
        const p = V3(L.x, 0, L.z).addScaledVector(f, 26 + carry * 0.05).addScaledVector(r, s * (16 + carry * 0.03));
        p.y = Math.max(groundY(p.x, p.z) + 5.5, L.y + 4);
        return p;
      };
      let pos = mk(side);
      // avoid parking inside a tree
      if (h.trees.some(t => Math.hypot(t.x - pos.x, t.z - pos.z) < t.r + 2)) pos = mk(-side);
      sh.landCam = pos;
      cam.cut = true;
    }
    cam.tPos.copy(sh.landCam);
    cam.tLook.copy(b);
    cam.k = 8; cam.tFov = portraitFov(42);
    // ease the camera forward if the ball runs a long way
    const toBall = hdist(sh.landCam, b);
    if (toBall > 45) cam.tPos.lerp(V3(b.x, sh.landCam.y, b.z), 0.02);
  } else {
    if (sh.kind === 'chip'){
      const start = V3(sh.from.x, sh.from.y, sh.from.z);
      const along = Math.max(0, b.clone().sub(start).dot(f));
      const want = start.clone().addScaledVector(f, along * 0.5 - 5.5).addScaledVector(r, 0.8);
      want.y = Math.max(start.y, groundY(want.x, want.z)) + 2.6 + along * 0.06;
      cam.tPos.copy(want);
      cam.tLook.copy(b).lerp(V3(h.pin.x, h.pin.y, h.pin.z), 0.3);
      cam.k = 3; cam.tFov = portraitFov(50);
      return;
    }
    // chase from behind and above
    const fromTee = V3(sh.from.x, sh.from.y, sh.from.z);
    const back = sh.kind === 'chip' ? 5 : 9;
    const want = b.clone().addScaledVector(f, -back);
    want.y = Math.max(b.y + (sh.kind === 'chip' ? 2.4 : 3.2), groundY(want.x, want.z) + 1.6);
    if (sh.t < 0.35){ want.lerp(fromTee.clone().addScaledVector(f, -5).add(V3(0, 2, 0)), 1 - sh.t / 0.35); }
    cam.tPos.copy(want);
    cam.tLook.copy(b);
    cam.k = sh.kind === 'chip' ? 3.5 : 6; cam.tFov = portraitFov(52);
    if (sh.kind === 'chip'){
      // keep the pin in frame on short shots
      cam.tLook.lerp(V3(h.pin.x, h.pin.y, h.pin.z), 0.25);
    }
  }
}

function cameraFlyover(dt){
  const h = S.h, F = S.fly;
  F.t += dt;
  const u = smooth(0, 1, F.t / F.dur);
  const s = lerp(-30, h.length + 10, u);
  const P = h.atS(Math.max(0, s));
  const ahead = h.atS(Math.min(h.length, Math.max(0, s) + 90));
  const pos = V3(P.x, 0, P.z);
  if (s < 0){ pos.x += P.tx * s; pos.z += P.tz * s; }
  pos.addScaledVector(V3(P.tx, 0, P.tz), -36);
  pos.y = groundY(pos.x, pos.z) + lerp(46, 20, u);
  const look = V3(lerp(ahead.x, h.pin.x, u * u), 0, lerp(ahead.z, h.pin.z, u * u));
  look.y = groundY(look.x, look.z);
  cam.tPos.copy(pos); cam.tLook.copy(look); cam.tFov = portraitFov(55); cam.k = 6;
  if (F.t >= F.dur) endFlyover();
}

function cameraMenu(){
  const h = S.h; if (!h) return;
  const t = S.t * 0.045;
  const c = V3(h.greenC.x, 0, h.greenC.z);
  const R = 62;
  cam.tPos.set(c.x + Math.cos(t) * R, groundY(h.greenC.x, h.greenC.z) + 22, c.z + Math.sin(t) * R);
  cam.tLook.set(h.pin.x, h.pin.y + 2, h.pin.z);
  cam.tFov = portraitFov(50); cam.k = 2;
}

// tall screens need a wider vertical field of view to see the golfer and the target
function portraitFov(f){
  const asp = innerWidth / innerHeight;
  return asp < 1 ? Math.min(82, f + (1 - asp) * 34) : f;
}

function applyCamera(dt){
  if (cam.cut){ cam.pos.copy(cam.tPos); cam.look.copy(cam.tLook); cam.fov = cam.tFov; cam.cut = false; }
  else {
    const k = 1 - Math.exp(-cam.k * dt);
    cam.pos.lerp(cam.tPos, k);
    cam.look.lerp(cam.tLook, Math.min(1, k * 1.4));
    cam.fov += (cam.tFov - cam.fov) * k;
  }
  const c = world.camera;
  if (S.h && S.phase !== 'menu'){
    const gy = world.groundAt(cam.pos.x, cam.pos.z) + 0.35;
    if (cam.pos.y < gy) cam.pos.y = gy;
  }
  c.position.copy(cam.pos);
  if (cam.shake > 0.001 && !reduceMotion){
    c.position.x += (Math.random() - 0.5) * cam.shake;
    c.position.y += (Math.random() - 0.5) * cam.shake;
    cam.shake *= Math.exp(-dt * 9);
  }
  c.lookAt(cam.look);
  if (Math.abs(c.fov - cam.fov) > 0.01){ c.fov = cam.fov; c.updateProjectionMatrix(); }
}

/* ============================================================
   PREVIEWS (arc, landing ring, rollout, putt line)
   ============================================================ */
function updatePreview(){
  const p = me(), h = S.h, D = S.D;
  world.dots.clear(); world.groundDots.clear();
  S.preview = null;
  if (S.phase !== 'address'){ world.dots.commit(); world.groundDots.commit(); world.setRing(world.target, null); world.setRing(world.ghost, null); return; }
  if (S.mode === 'full'){
    const M = S.meter;
    const power = M.phase === 'power' ? Math.max(0.05, M.m) : M.phase === 'return' || M.phase === 'done' ? M.power : 1;
    const st = buildFull(power, 0);
    const r = simulate(h, st, { airOnly: true, maxT: 12 });
    const land = r.carryPt || r.rest;
    // arc as dots
    const n = r.samples.length / 3;
    const stepI = Math.max(1, Math.floor(n / 46));
    for (let i = stepI; i < n; i += stepI){
      const k = i / n;
      world.dots.push(r.samples[i * 3], r.samples[i * 3 + 1], r.samples[i * 3 + 2], 1, 1, 1, 0.55 + 0.35 * k, 4.5);
    }
    S.preview = { land, carry: r.carry };
    const rad = Math.max(1.6, r.carry * 0.028);
    world.setRing(world.target, land, rad, Math.max(0.25, rad * 0.16), M.phase === 'idle' ? '#ffffff' : '#ffcf4a', 0.95);
    world.setRing(world.ghost, null);
  } else if (S.mode === 'chip'){
    const sh = SHOTS[S.shotType];
    const st = buildChip(S.chipTarget);
    const r = simulate(h, st, { maxT: 14 });
    const n = r.samples.length / 3;
    const landI = r.carryPt ? Math.round(r.carryPt.t / r.sampleDt) : n;
    const stepA = Math.max(1, Math.floor(landI / 22));
    for (let i = stepA; i < Math.min(landI, n); i += stepA)
      world.dots.push(r.samples[i * 3], r.samples[i * 3 + 1], r.samples[i * 3 + 2], 1, 1, 1, 0.75, 4.5);
    // rollout, faded according to difficulty
    const show = D.rollPreview;
    if (show > 0){
      const end = landI + Math.floor((n - landI) * show);
      for (let i = landI; i < end; i += 6){
        const a = 0.85 * (1 - (i - landI) / Math.max(1, n - landI) * 0.6);
        groundDot(r.samples[i * 3], r.samples[i * 3 + 2], 1, 0.82, 0.3, a);
      }
    }
    const land = r.carryPt || r.rest;
    S.preview = { land, rest: r.rest };
    const rad = Math.max(0.55, S.chipTarget * 0.045);
    world.setRing(world.target, land, rad, Math.max(0.1, rad * 0.22), '#ffffff', 0.95);
    if (S.hold.on){
      const g = S.hold.g;
      const gp = { x: p.ball.x + Math.sin(S.aimYaw) * g, z: p.ball.z - Math.cos(S.aimYaw) * g };
      gp.y = h.heightAt(gp.x, gp.z);
      const on = Math.abs(g - S.chipTarget) <= Math.max(0.6, S.chipTarget * 0.045);
      world.setRing(world.ghost, gp, rad * 0.75, Math.max(0.12, rad * 0.3), on ? '#43d17a' : '#ffcf4a', 0.95);
      S.preview.ghost = gp; S.preview.ghostOn = on;
    } else world.setRing(world.ghost, null);
  } else {
    // putting: optional read of the first part of the line
    const st = rollStart(ballStart(), S.aimYaw, puttSpeed(S.puttPace));
    const r = simulate(h, st, { maxT: 14 });
    const n = r.samples.length / 3;
    const frac = D.puttPreview;
    const flatEnd = { x: p.ball.x + Math.sin(S.aimYaw) * S.puttPace, z: p.ball.z - Math.cos(S.aimYaw) * S.puttPace };
    flatEnd.y = h.heightAt(flatEnd.x, flatEnd.z);
    if (frac > 0){
      const end = Math.max(2, Math.floor(n * frac));
      for (let i = 2; i < end; i += 2){
        const a = 0.9 * (1 - i / end * 0.7);
        groundDot(r.samples[i * 3], r.samples[i * 3 + 2], 1, 1, 1, a);
      }
    } else {
      // with no read, just the start line
      for (let k = 0.3; k < Math.min(1.6, S.puttPace); k += 0.3){
        const x = p.ball.x + Math.sin(S.aimYaw) * k, z = p.ball.z - Math.cos(S.aimYaw) * k;
        groundDot(x, z, 1, 1, 1, 0.8 - k * 0.4);
      }
    }
    S.preview = { land: flatEnd, putt: r };
    world.setRing(world.target, flatEnd, 0.18, 0.05, '#ffffff', 0.7);
    world.setRing(world.ghost, null);
  }
  world.dots.commit(); world.groundDots.commit();
}
// a dot on the drawn mesh, not the analytic surface (they differ by a few cm, enough to bury it)
function groundDot(x, z, r, g, b, a){ world.groundDots.push(x, world.groundAt(x, z) + 0.02, z, r, g, b, a, 4); }

/* ============================================================
   HUD
   ============================================================ */
function showHUD(){ $('hud').classList.remove('hidden'); }
function hideHUD(){ $('hud').classList.add('hidden'); $('labels').innerHTML = ''; labelEls.clear(); }
function hideControls(){
  for (const id of ['modes', 'clubSel', 'shotTypes', 'strike', 'meter', 'holdBtn', 'pace', 'actHint', 'bRead', 'shotInfo'])
    $(id).classList.add('hidden');
  world.setRing(world.target, null); world.setRing(world.ghost, null);
  world.dots.clear(); world.dots.commit();
  world.groundDots.clear(); world.groundDots.commit();
}

const LIE_COLORS = { tee: '#7fd16a', fairway: '#7fd16a', fringe: '#9be08a', green: '#b6f09a', rough: '#4f9a3f',
                     deep: '#c9a95f', bunker: '#efdcab', waste: '#d3a676', water: '#4aa3d8', ob: '#ffffff' };

function refreshHUD(){
  const p = me(), h = S.h;
  if (!p || !h) return;
  $('hNum').textContent = S.holeIdx + 1;
  $('hCourse').textContent = THEMES[S.theme].name.toUpperCase();
  $('hPar').textContent = `PAR ${h.par}`;
  $('hYds').textContent = `${h.length} YDS`;
  const pips = $('hPips');
  if (pips.children.length !== S.pars.length) pips.innerHTML = S.pars.map(() => '<i></i>').join('');
  [...pips.children].forEach((el, i) => el.className = i < S.holeIdx ? 'd' : i === S.holeIdx ? 'n' : '');

  const tag = $('pTag');
  tag.querySelector('.av').innerHTML = avatarHTML(p);
  tag.querySelector('.av').style.setProperty('--pc', p.color);
  tag.querySelector('.nm').textContent = p.name;
  const tp = toPar(p);
  const tpEl = tag.querySelector('.topar');
  tpEl.textContent = fmtPar(tp);
  tpEl.className = 'topar ' + (tp < 0 ? 'u' : tp > 0 ? 'o' : '');
  let pos = '';
  if (S.players.length > 1){
    const rank = S.players.filter(q => toPar(q) < tp).length + 1;
    pos = ` · ${rank}${['st', 'nd', 'rd', 'th'][Math.min(3, rank - 1)]}`;
  }
  tag.querySelector('.stk').textContent = (p.holed ? 'Holed' : `Stroke ${p.strokes + 1}`) + pos;

  // multiplayer board
  const board = $('board');
  if (S.players.length > 1){
    board.classList.remove('hidden');
    board.innerHTML = S.players.slice().sort((a, b) => toPar(a) - toPar(b)).map(q => {
      const t = toPar(q);
      return `<div class="row ${q === p ? 'on' : ''}"><i style="background:${q.color}"></i><span class="n">${esc(q.name)}</span>
        <span class="t">${q.holed ? 'F' : q.strokes ? '(' + q.strokes + ')' : ''}</span><span class="s ${t < 0 ? 'u' : ''}">${fmtPar(t)}</span></div>`;
    }).join('');
  } else board.classList.add('hidden');

  $('windMph').textContent = h.wind.mph;

  // shot info
  const d = hdist(p.ball, h.pin);
  const onGreen = S.mode === 'putt';
  $('siLab').textContent = onGreen ? 'TO HOLE' : 'TO PIN';
  $('siDist').innerHTML = onGreen ? `${(d * YD_FT).toFixed(d * YD_FT < 10 ? 1 : 0)}<small>ft</small>` : `${Math.round(d)}<small>y</small>`;
  const elev = h.pin.y - p.ball.y;
  if (onGreen){
    const g = gradAt(h, (p.ball.x + h.pin.x) / 2, (p.ball.z + h.pin.z) / 2);
    const a = S.aimYaw;
    const fx = Math.sin(a), fz = -Math.cos(a);
    const along = -(g.x * fx + g.z * fz) * 100;       // + downhill
    const cross = (g.x * Math.cos(a) + g.z * Math.sin(a)) * 100;
    $('siPlays').textContent = `${elev > 0.03 ? 'Uphill' : elev < -0.03 ? 'Downhill' : 'Flat'} ${Math.abs(elev * 36).toFixed(0)} in · breaks ${Math.abs(cross) < 0.25 ? 'straight' : cross > 0 ? 'left' : 'right'}`;
  } else {
    const pl = playsLike(d, yawTo(p.ball, h.pin), p.ball.y, h.pin.y);
    $('siPlays').textContent = `Plays ${Math.round(pl)}y`;
  }
  const lie = LIES[p.lie] || LIES.rough;
  const lc = (h.T.lieColors || {})[p.lie] || LIE_COLORS[p.lie] || '#fff';
  $('siLie').innerHTML = `<span class="lie-dot" style="background:${lc}"></span>${p.under ? 'Trees' : (h.T.lieNames || {})[p.lie] || lie.name}`;
  $('siLiePct').textContent = p.under ? 'Punch only' : lie.pct;
  $('siElev').textContent = Math.abs(elev) < 0.6 ? 'Level' : `${elev > 0 ? '▲' : '▼'} ${Math.abs(elev).toFixed(0)}y`;

  // controls
  const address = S.phase === 'address';
  $('modes').classList.toggle('hidden', !address);
  for (const b of $('modes').querySelectorAll('button')){
    b.disabled = !S.allowed[b.dataset.m];
    b.classList.toggle('on', b.dataset.m === S.mode);
  }
  $('clubSel').classList.toggle('hidden', !address || S.mode !== 'full');
  $('shotTypes').classList.toggle('hidden', !address || S.mode !== 'chip');
  $('strike').classList.toggle('hidden', !address || S.mode !== 'full');
  $('meter').classList.toggle('hidden', !address || S.mode !== 'full');
  $('holdBtn').classList.toggle('hidden', !address || S.mode !== 'chip');
  $('pace').classList.toggle('hidden', !address || S.mode !== 'putt');
  $('actHint').classList.toggle('hidden', !address);
  $('shotInfo').classList.toggle('hidden', !address);
  $('bRead').classList.toggle('hidden', !address || S.mode !== 'putt');
  $('bRead').classList.toggle('on', S.read);
  $('bMap').classList.toggle('on', S.overview);

  if (S.mode === 'full'){
    const c = CLUBS[S.club];
    $('clubName').textContent = c.name;
    const eff = Math.round(c.carry * lie.power * (p.under ? 0.72 : 1));
    $('clubCarry').innerHTML = `Carry <b>${eff}y</b>${lie.power < 1 ? ` <span style="opacity:.6">(${c.carry})</span>` : ''}`;
    $('clubStrip').innerHTML = CLUBS.slice(0, PUTTER).map((_, i) => `<i class="${i === S.club ? 'on' : ''}"></i>`).join('');
    const u = S.strike.u, v = S.strike.v;
    $('strikeDot').style.left = (50 + u * 34) + '%';
    $('strikeDot').style.top = (50 + v * 34) + '%';
    $('strikeTxt').textContent = (Math.abs(u) < 0.15 && Math.abs(v) < 0.15) ? 'Stock' :
      [v < -0.15 ? 'High' : v > 0.15 ? 'Low' : '', u < -0.15 ? 'Draw' : u > 0.15 ? 'Fade' : ''].filter(Boolean).join(' ');
    $('actHint').textContent = S.meter.phase === 'idle' ? (matchMedia('(pointer: coarse)').matches ? 'Tap the meter to swing' : 'Space or click the meter')
      : S.meter.phase === 'power' ? 'Tap to set power' : S.meter.phase === 'return' ? 'Tap on the line!' : '';
  } else if (S.mode === 'chip'){
    const box = $('shotTypes');
    const types = p.lie === 'bunker' ? ['splash', 'pitch'] : ['bump', 'pitch', 'flop'];
    box.innerHTML = types.map((k, i) => `<button data-t="${k}" class="${k === S.shotType ? 'on' : ''}"><b>${i + 1} · ${SHOTS[k].name}</b><span>${SHOTS[k].desc}</span></button>`).join('');
    box.querySelectorAll('button').forEach(b => b.onclick = () => setShotType(b.dataset.t));
    $('actHint').textContent = `Land it ${S.chipTarget.toFixed(1)}y · drag up/down to adjust`;
  } else {
    $('paceVal').innerHTML = `${(S.puttPace * YD_FT).toFixed(S.puttPace * YD_FT < 10 ? 1 : 0)}<small>ft</small>`;
    $('paceBar').style.width = Math.min(100, S.puttPace / 30 * 100) + '%';
    $('actHint').textContent = matchMedia('(pointer: coarse)').matches ? 'Drag down & release to putt' : 'Drag down & release · or ↑↓ + Space';
  }
  S.previewDirty = true;
}

/* ---------- swing meter (canvas) ---------- */
const meterCv = $('meter'), mctx = meterCv.getContext('2d');
// the meter's size, kept by an observer so drawing never forces a layout
const meterBox = { width: 0, height: 0 };
if (window.ResizeObserver) new ResizeObserver(es => { for (const e of es){ meterBox.width = e.contentRect.width; meterBox.height = e.contentRect.height; } }).observe(meterCv);
function drawMeter(){
  if (meterCv.classList.contains('hidden')) return;
  const r = meterBox.width ? meterBox : meterCv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (meterCv.width !== Math.round(r.width * dpr)){ meterCv.width = Math.round(r.width * dpr); meterCv.height = Math.round(r.height * dpr); }
  const W = r.width, H = r.height;
  const g = mctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = W * 0.4, th = W * 0.085;
  const M = S.meter, D = S.D;
  const MIN = -0.17, MAX = 1.1, A0 = Math.PI * 0.75, SW = Math.PI * 1.5;
  const ang = m => A0 + (m - MIN) / (MAX - MIN) * SW;

  // backing disc
  g.beginPath(); g.arc(cx, cy, R + th * 0.9, 0, TAU);
  g.fillStyle = 'rgba(9,17,13,.66)'; g.fill();
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1; g.stroke();
  // track
  g.lineCap = 'round';
  g.beginPath(); g.arc(cx, cy, R, ang(MIN), ang(MAX));
  g.strokeStyle = 'rgba(255,255,255,.1)'; g.lineWidth = th; g.stroke();
  // overpower zone
  g.beginPath(); g.arc(cx, cy, R, ang(1), ang(MAX));
  g.strokeStyle = 'rgba(255,90,79,.35)'; g.lineWidth = th; g.lineCap = 'butt'; g.stroke();
  // accuracy window and perfect zone around the line
  g.beginPath(); g.arc(cx, cy, R, ang(-D.window), ang(D.window));
  g.strokeStyle = 'rgba(67,209,122,.45)'; g.lineWidth = th; g.stroke();
  g.beginPath(); g.arc(cx, cy, R, ang(-D.perfect), ang(D.perfect));
  g.strokeStyle = 'rgba(255,207,74,.95)'; g.lineWidth = th; g.stroke();
  // power fill
  const fillTo = M.phase === 'power' ? M.m : (M.phase === 'return' || M.phase === 'done') ? M.power : 0;
  if (fillTo > 0.005){
    const grd = g.createConicGradient ? g.createConicGradient(A0, cx, cy) : null;
    if (grd){
      grd.addColorStop(0.1, '#43d17a'); grd.addColorStop(0.55, '#ffcf4a'); grd.addColorStop(0.72, '#ff8a3d'); grd.addColorStop(0.75, '#ff5a4f');
      g.strokeStyle = grd;
    } else g.strokeStyle = '#ffcf4a';
    g.beginPath(); g.arc(cx, cy, R, ang(0), ang(fillTo));
    g.lineWidth = th * 0.62; g.lineCap = 'round'; g.stroke();
  }
  // ticks
  g.lineCap = 'butt';
  for (const t of [0.25, 0.5, 0.75, 1]){
    const a = ang(t);
    g.beginPath(); g.moveTo(cx + Math.cos(a) * (R - th * 0.7), cy + Math.sin(a) * (R - th * 0.7));
    g.lineTo(cx + Math.cos(a) * (R - th * 0.5), cy + Math.sin(a) * (R - th * 0.5));
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 2; g.stroke();
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.font = `700 ${Math.round(W * 0.042)}px "Barlow Semi Condensed", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t === 1 ? '100' : String(t * 100), cx + Math.cos(a) * (R - th * 1.25), cy + Math.sin(a) * (R - th * 1.25));
  }
  // the snap line
  const a0 = ang(0);
  g.beginPath(); g.moveTo(cx + Math.cos(a0) * (R - th * 0.75), cy + Math.sin(a0) * (R - th * 0.75));
  g.lineTo(cx + Math.cos(a0) * (R + th * 0.75), cy + Math.sin(a0) * (R + th * 0.75));
  g.strokeStyle = '#ffffff'; g.lineWidth = 3; g.stroke();
  // marker
  if (M.phase === 'power' || M.phase === 'return'){
    const a = ang(M.m);
    g.save();
    g.shadowColor = 'rgba(255,255,255,.9)'; g.shadowBlur = 12;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * (R - th * 0.95), cy + Math.sin(a) * (R - th * 0.95));
    g.lineTo(cx + Math.cos(a) * (R + th * 0.95), cy + Math.sin(a) * (R + th * 0.95));
    g.strokeStyle = '#ffffff'; g.lineWidth = 4.5; g.lineCap = 'round'; g.stroke();
    g.restore();
  }
  // centre read-out
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const club = CLUBS[S.club], lie = LIES[me().lie];
  if (M.phase === 'idle'){
    g.fillStyle = '#fff'; g.font = `900 ${Math.round(W * 0.13)}px "Barlow Semi Condensed", sans-serif`;
    g.fillText(club.short, cx, cy - W * 0.03);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.font = `700 ${Math.round(W * 0.05)}px "Barlow Semi Condensed", sans-serif`;
    g.fillText('SWING', cx, cy + W * 0.08);
  } else if (M.phase === 'done' && M.flash > 0){
    const lbl = M.label;
    g.fillStyle = lbl === 'PERFECT' ? '#ffcf4a' : lbl === 'GOOD' || lbl === 'POWER' ? '#43d17a' : '#ff8a80';
    g.font = `900 ${Math.round(W * (lbl.length > 5 ? 0.1 : 0.12))}px "Barlow Semi Condensed", sans-serif`;
    g.fillText(lbl, cx, cy);
  } else {
    const pw = M.phase === 'power' ? M.m : M.power;
    const yds = Math.round(club.carry * pw * lie.power * (me().under ? 0.72 : 1));
    g.fillStyle = pw > 1 ? '#ff8a80' : '#fff';
    g.font = `900 ${Math.round(W * 0.15)}px "Barlow Semi Condensed", sans-serif`;
    g.fillText(yds + 'y', cx, cy - W * 0.03);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.font = `700 ${Math.round(W * 0.05)}px "Barlow Semi Condensed", sans-serif`;
    g.fillText(Math.round(pw * 100) + '% POWER', cx, cy + W * 0.09);
  }
}

/* ---------- hold ring for chips ---------- */
let holdRingHTML = '';
function drawHoldRing(){
  const svg = $('holdRing');
  if ($('holdBtn').classList.contains('hidden')) return;
  const sh = SHOTS[S.shotType];
  const tf = Math.min(1, S.chipTarget / sh.maxCarry), gf = Math.min(1.04, S.hold.g / sh.maxCarry);
  const C = 2 * Math.PI * 68;
  const arc = (f, col, w, op) => `<circle cx="75" cy="75" r="68" fill="none" stroke="${col}" stroke-width="${w}" stroke-opacity="${op}"
    stroke-dasharray="${C * f} ${C}" transform="rotate(-90 75 75)" stroke-linecap="round"/>`;
  const tol = Math.max(0.6, S.chipTarget * 0.045) / sh.maxCarry;
  const ta = (tf - tol) * 360 - 90, tb = (tf + tol) * 360 - 90;
  const pt = d => [75 + Math.cos(d * Math.PI / 180) * 68, 75 + Math.sin(d * Math.PI / 180) * 68];
  const [x1, y1] = pt(ta), [x2, y2] = pt(tb);
  const html = `<circle cx="75" cy="75" r="68" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="9"/>
    <path d="M${x1.toFixed(2)} ${y1.toFixed(2)} A68 68 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" stroke="#43d17a" stroke-width="13" stroke-linecap="round"/>
    ${S.hold.on ? arc(gf, S.preview && S.preview.ghostOn ? '#43d17a' : '#ffcf4a', 9, 1) : ''}`;
  if (html !== holdRingHTML){ svg.innerHTML = html; holdRingHTML = html; }
}

/* ---------- floating labels ---------- */
const labelEls = new Map();
function label(key, cls, html, p, show = true){
  let el = labelEls.get(key);
  if (!el){ el = document.createElement('div'); el.className = 'wl ' + cls; el.style.left = el.style.top = '0px'; $('labels').appendChild(el); labelEls.set(key, el); }
  const hide = () => { if (el._hid !== true){ el.style.display = 'none'; el._hid = true; } };
  if (!show || !p) return hide();
  const s = world.project(p);
  if (s.behind || s.x < -50 || s.x > innerWidth + 50 || s.y < -20 || s.y > innerHeight + 40) return hide();
  if (el._hid !== false){ el.style.display = ''; el._hid = false; }
  if (el._h !== html){ el.innerHTML = html; el._h = html; }
  const m = 34;
  // `translate` composites on its own and leaves the class's transform offset alone
  const t = `${Math.round(Math.max(m, Math.min(innerWidth - m, s.x)))}px ${Math.round(Math.max(m, s.y))}px`;
  if (el._t !== t){ el.style.translate = t; el._t = t; }
}
function updateLabels(){
  const h = S.h, p = me();
  if (!h || !p || S.phase === 'menu' || S.phase === 'holeEnd' || S.phase === 'over' || S.phase === 'loading'){
    for (const el of labelEls.values()) if (el._hid !== true){ el.style.display = 'none'; el._hid = true; }
    return;
  }
  const address = S.phase === 'address';
  const d = hdist(p.ball, h.pin);
  const pinTop = { x: h.pin.x, y: h.pin.y + 2.33 * world.flag.group.scale.x + 0.3, z: h.pin.z };
  const pinTxt = address && S.mode === 'putt' ? `${(d * YD_FT).toFixed(0)} ft` : `${Math.round(d)}<small>y</small>`;
  label('pin', 'pin', pinTxt, pinTop, (address || S.phase === 'intro') && !S.read);
  if (address && S.preview && S.preview.land && S.mode !== 'putt'){
    const lp = { ...S.preview.land }; lp.y += 0.3;
    const txt = S.mode === 'full' ? `${Math.round(S.preview.carry)}<small>y carry</small>` : `${S.chipTarget.toFixed(1)}<small>y</small>`;
    label('tgt', 'tgt', txt, lp, true);
  } else label('tgt', 'tgt', '', null, false);
  if (address && S.mode === 'chip' && S.hold.on && S.preview && S.preview.ghost){
    label('ghost', 'ghost', `${S.hold.g.toFixed(1)}<small>y</small>`, { ...S.preview.ghost, y: S.preview.ghost.y + 0.3 }, true);
  } else label('ghost', 'ghost', '', null, false);
  // live yardage on the ball in flight, like a broadcast tracer
  if (S.phase === 'flight' && S.shot && !S.shot.done && S.shot.kind !== 'putt'){
    const dd = hdist(S.shot.from, tmpP);
    label('live', 'live', `${Math.round(dd)}<small>y</small>`, { x: tmpP.x, y: tmpP.y + 0.4, z: tmpP.z }, dd > 3);
  } else label('live', 'live', '', null, false);
  for (const q of S.players){
    const show = q !== p && !q.holed && S.phase !== 'intro';
    const at = q.remote ? q.marker.position : q.ball;
    label('pl' + S.players.indexOf(q), 'pl', `<i style="background:${q.color}"></i>${esc(q.name)}`, { x: at.x, y: at.y + 0.35, z: at.z }, show);
    if (show){
      const dd = world.camera.position.distanceTo(q.marker.position);
      q.marker.scale.setScalar(Math.max(1, Math.min(12, dd / 11)));
    }
  }
}

/* ---------- wind dial ---------- */
function updateWind(){
  if (!S.h) return;
  const c = world.camera;
  const dir = new THREE.Vector3(); c.getWorldDirection(dir);
  const camYaw = Math.atan2(dir.x, -dir.z);
  const rel = (S.h.wind.dir - camYaw) * 180 / Math.PI;
  $('windArrow').style.transform = `rotate(${rel.toFixed(1)}deg)`;
}

/* ---------- minimap ---------- */
const mm = { cv: $('minimap'), base: null, rot: 0, scale: 1, cx: 0, cz: 0 };
function buildMinimap(){
  const h = S.h;
  const r = mm.cv.getBoundingClientRect();
  const W = Math.max(60, r.width || 118), Hh = Math.max(100, r.height || 196);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  mm.cv.width = Math.round(W * dpr); mm.cv.height = Math.round(Hh * dpr);
  mm.W = W; mm.H = Hh; mm.dpr = dpr;
  // rotate so the hole runs straight up
  const g = h.greenC;
  mm.rot = Math.atan2(g.x - h.tee.x, -(g.z - h.tee.z));
  mm.cx = (g.x + h.tee.x) / 2; mm.cz = (g.z + h.tee.z) / 2;
  let maxLat = 0;
  for (let i = 0; i < h.poly.x.length; i++){
    const q = toMap0(h.poly.x[i], h.poly.z[i]);
    maxLat = Math.max(maxLat, Math.abs(q.x));
  }
  const spanY = h.length + 60, spanX = (maxLat + h.fairW(h.length / 2) + 40) * 2;
  mm.scale = Math.min(Hh / spanY, W / spanX);
  // bake the base image
  const base = document.createElement('canvas');
  base.width = mm.cv.width; base.height = mm.cv.height;
  const b = base.getContext('2d');
  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  b.save();
  b.beginPath(); b.roundRect(0, 0, W, Hh, 14); b.clip();
  b.translate(W / 2, Hh / 2);
  b.scale(mm.scale, mm.scale);
  b.rotate(-mm.rot);
  b.translate(-mm.cx, -mm.cz);
  const bd = h.bounds;
  b.imageSmoothingQuality = 'high';
  b.drawImage(world.surfaceCanvas, bd.minX, bd.minZ, bd.maxX - bd.minX, bd.maxZ - bd.minZ);
  // trees as dots
  b.fillStyle = 'rgba(20,50,25,.75)';
  for (const t of h.trees){ b.beginPath(); b.arc(t.x, t.z, Math.max(1.5, t.r * 0.8), 0, TAU); b.fill(); }
  b.restore();
  mm.base = base;
}
function toMap0(x, z){
  const dx = x - mm.cx, dz = z - mm.cz;
  const c = Math.cos(-mm.rot), s = Math.sin(-mm.rot);
  return { x: dx * c - dz * s, y: dx * s + dz * c };
}
function toMap(x, z){
  const q = toMap0(x, z);
  return { x: mm.W / 2 + q.x * mm.scale, y: mm.H / 2 + q.y * mm.scale };
}
function fromMap(px, py){
  const qx = (px - mm.W / 2) / mm.scale, qy = (py - mm.H / 2) / mm.scale;
  const c = Math.cos(mm.rot), s = Math.sin(mm.rot);
  return { x: mm.cx + qx * c - qy * s, z: mm.cz + qx * s + qy * c };
}
function drawMinimap(){
  if (!mm.base || $('hud').classList.contains('hidden')) return;
  const g = mm.cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, mm.cv.width, mm.cv.height);
  g.drawImage(mm.base, 0, 0);
  g.setTransform(mm.dpr, 0, 0, mm.dpr, 0, 0);
  const h = S.h, p = me();
  const pin = toMap(h.pin.x, h.pin.z);
  // aim line and landing point
  if (S.phase === 'address' && S.preview && S.preview.land){
    const b = toMap(p.ball.x, p.ball.z), l = toMap(S.preview.land.x, S.preview.land.z);
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1.5; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(l.x, l.y); g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(l.x, l.y, 4, 0, TAU); g.stroke();
  }
  // the live shot
  if (S.shot && !S.shot.done){
    const sim = S.shot.sim;
    const n = Math.min(sim.samples.length / 3, Math.floor(S.shot.t / sim.sampleDt));
    g.strokeStyle = me().color; g.lineWidth = 1.8; g.beginPath();
    for (let i = 0; i < n; i += 3){ const q = toMap(sim.samples[i * 3], sim.samples[i * 3 + 2]); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); }
    g.stroke();
  }
  // flag
  g.fillStyle = '#fff'; g.fillRect(pin.x - 0.75, pin.y - 9, 1.5, 9);
  g.fillStyle = '#ffcf4a'; g.beginPath(); g.moveTo(pin.x + 0.75, pin.y - 9); g.lineTo(pin.x + 7, pin.y - 7); g.lineTo(pin.x + 0.75, pin.y - 5); g.fill();
  // balls
  for (const q of S.players){
    if (q.holed) continue;
    const pos = q === p && S.shot && !S.shot.done ? tmpP : q.remote ? q.marker.position : q.ball;
    const m = toMap(pos.x, pos.z);
    g.fillStyle = q.color; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(m.x, m.y, q === p ? 4 : 3, 0, TAU); g.fill(); g.stroke();
  }
}

/* ---------- banners, toasts, shot card ---------- */
let bannerT = null, toastT = null, cardT = null;
function banner(t, sub, gold){
  $('bannerT').textContent = t;
  $('bannerT').className = 'bt' + (gold ? ' gold' : '');
  $('bannerS').textContent = sub || '';
  $('banner').classList.add('on');
  clearTimeout(bannerT);
  bannerT = setTimeout(() => $('banner').classList.remove('on'), 2300);
}
function toast(t, sub){
  $('toast').innerHTML = esc(t) + (sub ? ` <span style="opacity:.6;font-weight:700">· ${esc(sub)}</span>` : '');
  $('toast').classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => $('toast').classList.remove('on'), 2000);
}
function shotCard(sh, sim, tag, tagClass, dPin){
  const lieName = (S.h.T.lieNames || {})[me().lie] || (LIES[me().lie] || {}).name || '';
  const stats = sh.kind === 'putt'
    ? [[`${Math.round(sim.total * YD_FT)}`, 'FT ROLLED'], [`${dPin * YD_FT < 10 ? (dPin * YD_FT).toFixed(1) : Math.round(dPin * YD_FT)}`, 'FT LEFT']]
    : [...(sh.kind === 'full' ? [[`${Math.round(sh.info.speed / MPH)}`, 'BALL MPH']] : []),
       [`${Math.round(sim.carry)}`, 'CARRY'], [`${Math.round(sim.total)}`, 'TOTAL'], [`${Math.round(sim.apex)}`, 'APEX'],
       [dPin < 30 ? `${Math.round(dPin * YD_FT)}'` : `${Math.round(dPin)}`, dPin < 30 ? 'TO PIN FT' : 'TO PIN']];
  $('shotCard').innerHTML = (tag ? `<div class="sc-tag ${tagClass}">${tag}</div>` : '') +
    `<div class="sc-stat"><b style="font-size:15px">${esc(sh.info.club)}</b><span>${esc(lieName.toUpperCase())}</span></div>` +
    stats.map(([v, l]) => `<div class="sc-stat"><b>${v}</b><span>${l}</span></div>`).join('');
  $('shotCard').classList.add('on');
  clearTimeout(cardT);
  cardT = setTimeout(() => $('shotCard').classList.remove('on'), 2600);
}
function fade(on){ $('fade').classList.toggle('on', on); }

/* ---------- scorecard ---------- */
function showCard(final){
  const pars = S.pars, n = pars.length;
  const half = n === 18;
  const sumPar = (a, b) => pars.slice(a, b).reduce((x, y) => x + y, 0);
  const sumP = (p, a, b) => p.scores.slice(a, b).reduce((x, y) => x + (y || 0), 0);
  const cell = (s, par) => {
    if (s === null) return '<td>·</td>';
    const r = s - par;
    const cls = s === 1 || r <= -2 ? 'e' : r === -1 ? 'b' : r === 1 ? 'g' : r >= 2 ? 'd' : '';
    return `<td><span class="sc ${cls}">${s}</span></td>`;
  };
  let head = '<tr><th>Hole</th>';
  for (let i = 0; i < n; i++){ head += `<th>${i + 1}</th>`; if (half && i === 8) head += '<th>OUT</th>'; }
  head += (half ? '<th>IN</th>' : '') + '<th>TOT</th><th>±</th></tr>';
  let parRow = '<tr class="par"><td>Par</td>';
  for (let i = 0; i < n; i++){ parRow += `<td>${pars[i]}</td>`; if (half && i === 8) parRow += `<td class="t">${sumPar(0, 9)}</td>`; }
  parRow += (half ? `<td class="t">${sumPar(9, 18)}</td>` : '') + `<td class="t">${sumPar(0, n)}</td><td></td></tr>`;
  const rows = S.players.slice().sort((a, b) => toPar(a) - toPar(b)).map(p => {
    let r = `<tr><td style="color:${p.color}">${esc(p.name)}</td>`;
    for (let i = 0; i < n; i++){ r += cell(p.scores[i], pars[i]); if (half && i === 8) r += `<td class="t">${sumP(p, 0, 9) || '·'}</td>`; }
    const tp = toPar(p);
    r += (half ? `<td class="t">${sumP(p, 9, 18) || '·'}</td>` : '') + `<td class="t">${totalStrokes(p) || '·'}</td><td class="t">${fmtPar(tp)}</td></tr>`;
    return r;
  }).join('');
  $('cardTable').innerHTML = head + parRow + rows;
  const p0 = S.players[S.meIdx];
  const played = p0.scores.filter(s => s !== null).length;
  const putts = p0.putts.reduce((a, b) => a + b, 0);
  $('cardStats').innerHTML = [
    [p0.stats.firN ? `${p0.stats.fir}/${p0.stats.firN}` : '–', 'Fairways'],
    [played ? `${p0.stats.gir}/${played}` : '–', 'Greens in reg'],
    [played ? (putts / played).toFixed(1) : '–', 'Putts / hole'],
    [p0.stats.longest ? p0.stats.longest + 'y' : '–', 'Longest drive']
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  if (final){
    const board = S.players.slice().sort((a, b) => toPar(a) - toPar(b));
    const w = board[0];
    const tied = board.filter(p => toPar(p) === toPar(w)).length > 1;
    $('cardTitle').innerHTML = S.players.length > 1
      ? (tied ? 'A tie at the top' : `${esc(w.name)} wins`)
      : `${totalStrokes(p0)} · ${fmtPar(toPar(p0))}`;
    $('cardSub').textContent = `${THEMES[S.theme].name} · ${S.D.name}` + (S.lastPoints ? ` · +${S.lastPoints} points` : '') +
      (S.newBest ? ' · New personal best!' : '');
    if (S.newBest){ sfx.fanfare(); }
    const guest = S.online && !net.isHost;
    $('cardBtns').innerHTML = `<button class="btn primary" id="cbAgain" ${guest ? 'disabled' : ''}>${guest ? 'Waiting for the host…' : 'Play again'}</button>` +
      `<button class="btn ghost" id="cbMenu">${S.online ? 'Leave' : 'Main menu'}</button>`;
    $('cbAgain').onclick = () => {
      if (guest) return;
      $('cardOv').classList.add('hidden'); timers.length = 0; cleanupPlayers();
      if (S.online) hostStart(); else startRound();
    };
    $('cbMenu').onclick = () => { $('cardOv').classList.add('hidden'); toMenu(); };
  } else {
    $('cardTitle').textContent = 'Scorecard';
    $('cardSub').textContent = `${THEMES[S.theme].name} · Hole ${S.holeIdx + 1} of ${n}`;
    $('cardBtns').innerHTML = '<button class="btn primary" id="cbClose">Close</button>';
    $('cbClose').onclick = () => $('cardOv').classList.add('hidden');
  }
  $('cardOv').classList.remove('hidden');
}

/* ============================================================
   INPUT
   ============================================================ */
function setMode(m){
  if (S.phase !== 'address' || !S.allowed[m] || S.meter.phase !== 'idle' || S.hold.on || S.down) return;
  S.mode = m;
  sfx.ui();
  if (m === 'chip'){ if (me().lie === 'bunker') S.shotType = 'splash'; planChip(); }
  if (m === 'putt') S.puttPace = suggestPace();
  if (m === 'full') S.club = suggestClub();
  aimDefault();
  S.read = false; world.setGreenRead(false);
  placeGolfer();
  refreshHUD();
}
function setShotType(t){
  if (S.phase !== 'address' || S.mode !== 'chip' || S.hold.on) return;
  const types = me().lie === 'bunker' ? ['splash', 'pitch'] : ['bump', 'pitch', 'flop'];
  if (!types.includes(t)) return;
  S.shotType = t;
  sfx.select();
  planChip();
  placeGolfer();
  refreshHUD();
}
function changeClub(d){
  if (S.phase !== 'address' || S.mode !== 'full' || S.meter.phase !== 'idle') return;
  const min = me().lie === 'tee' ? 0 : 1;
  const n = clamp(S.club + d, min, PUTTER - 1);
  if (n === S.club) return;
  S.club = n;
  sfx.tick();
  placeGolfer();
  refreshHUD();
}
function nudgeAim(rad){
  if (S.phase !== 'address' || S.hold.on || S.meter.phase !== 'idle') return;
  S.aimYaw += rad;
  S.previewDirty = true;
  me().golfer.group.rotation.y = -S.aimYaw;
}

$('modes').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); });
$('clubPrev').onclick = () => changeClub(-1);
$('clubNext').onclick = () => changeClub(1);
$('meter').addEventListener('pointerdown', e => { e.preventDefault(); meterClick(); });
$('holdBtn').addEventListener('pointerdown', e => { e.preventDefault(); $('holdBtn').setPointerCapture(e.pointerId); holdStart(); });
$('holdBtn').addEventListener('pointerup', () => holdRelease());
$('holdBtn').addEventListener('pointercancel', () => holdRelease());

// strike point: drag the dot on the ball
{
  const ball = $('strikeBall');
  let on = false;
  const set = e => {
    const r = ball.getBoundingClientRect();
    let u = ((e.clientX - r.left) / r.width - 0.5) / 0.34, v = ((e.clientY - r.top) / r.height - 0.5) / 0.34;
    const L = Math.hypot(u, v); if (L > 1){ u /= L; v /= L; }
    if (Math.hypot(u, v) < 0.14){ u = 0; v = 0; }
    S.strike = { u, v };
    refreshHUD();
  };
  ball.addEventListener('pointerdown', e => {
    if (S.phase !== 'address' || S.meter.phase !== 'idle') return;
    on = true; ball.setPointerCapture(e.pointerId); set(e);
  });
  ball.addEventListener('pointermove', e => { if (on) set(e); });
  ball.addEventListener('pointerup', () => { on = false; });
  ball.addEventListener('dblclick', () => { S.strike = { u: 0, v: 0 }; refreshHUD(); });
}

// minimap: tap to aim
$('minimap').addEventListener('pointerdown', e => {
  if (S.phase !== 'address' || S.mode === 'putt' || S.meter.phase !== 'idle') return;
  const r = $('minimap').getBoundingClientRect();
  const w = fromMap(e.clientX - r.left, e.clientY - r.top);
  const p = me();
  S.aimYaw = yawTo(p.ball, w);
  if (S.mode === 'chip'){
    S.chipTarget = clamp(hdist(p.ball, w), 0.8, SHOTS[S.shotType].maxCarry);
  }
  me().golfer.group.rotation.y = -S.aimYaw;
  S.previewDirty = true;
  refreshHUD();
  sfx.tick();
});

// the course itself: drag to aim; in putt mode, pull back to stroke
const drag = { on: false, id: null, x0: 0, y0: 0, x: 0, y: 0, axis: null, aim0: 0, tgt0: 0 };
const gl = $('gl');
gl.addEventListener('pointerdown', e => {
  unlock();
  if (S.phase === 'intro'){ endFlyover(); return; }
  if (S.phase === 'flight' && S.shot && S.shot.kind !== 'putt'){ S.shot.speed = 4; return; }
  if (S.phase !== 'address' || S.meter.phase !== 'idle' || S.hold.on || S.down) return;
  drag.on = true; drag.id = e.pointerId; drag.x0 = drag.x = e.clientX; drag.y0 = drag.y = e.clientY;
  drag.axis = null; drag.aim0 = S.aimYaw; drag.tgt0 = S.chipTarget; drag.pace0 = S.puttPace;
  gl.setPointerCapture(e.pointerId);
});
gl.addEventListener('pointermove', e => {
  if (!drag.on || e.pointerId !== drag.id) return;
  drag.x = e.clientX; drag.y = e.clientY;
  const dx = drag.x - drag.x0, dy = drag.y - drag.y0;
  if (!drag.axis && Math.hypot(dx, dy) > 9) drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  if (!drag.axis) return;
  const fine = e.shiftKey ? 0.25 : 1;
  if (S.mode === 'putt'){
    if (drag.axis === 'x'){
      S.aimYaw = drag.aim0 + dx * 0.0011 * fine;
    } else {
      // pulling down sets the pace; sideways while pulling fine-tunes the line
      const k = clamp(dy / (innerHeight * 0.42), 0, 1);
      S.puttPace = Math.max(0, 30 * Math.pow(k, 1.75));
      S.aimYaw = drag.aim0 + dx * 0.0004;
      me().golfer.pose(-Math.min(1, Math.sqrt(S.puttPace / 30)), 'putt');
    }
  } else if (S.mode === 'chip' && drag.axis === 'y'){
    S.chipTarget = clamp(drag.tgt0 - dy * 0.06 * fine, 0.8, SHOTS[S.shotType].maxCarry);
  } else if (drag.axis === 'x'){
    const sens = S.mode === 'chip' ? 0.0022 : 0.0026;
    S.aimYaw = drag.aim0 + dx * sens * fine * (S.overview ? 0.6 : 1);
  }
  me().golfer.group.rotation.y = -S.aimYaw;
  S.previewDirty = true;
  refreshHUDLight();
});
const endDrag = e => {
  if (!drag.on) return;
  drag.on = false;
  if (S.mode === 'putt' && drag.axis === 'y' && S.phase === 'address'){
    if (S.puttPace >= 0.15) strokePutt();
    else { S.puttPace = drag.pace0; me().golfer.pose(0, 'putt'); refreshHUD(); }
  } else if (S.mode === 'chip' && drag.axis === 'y'){
    refreshHUD();
  }
};
gl.addEventListener('pointerup', endDrag);
gl.addEventListener('pointercancel', endDrag);
gl.addEventListener('wheel', e => {
  if (S.phase !== 'address') return;
  if (S.mode === 'chip'){ S.chipTarget = clamp(S.chipTarget - Math.sign(e.deltaY) * 0.5, 0.8, SHOTS[S.shotType].maxCarry); S.previewDirty = true; refreshHUDLight(); }
  else if (S.mode === 'putt'){ S.puttPace = clamp(S.puttPace - Math.sign(e.deltaY) / 3, 0, 30); S.previewDirty = true; refreshHUDLight(); }
  else changeClub(Math.sign(e.deltaY));
}, { passive: true });

// cheaper refresh for continuous drags
function refreshHUDLight(){
  if (S.mode === 'putt'){
    $('paceVal').innerHTML = `${(S.puttPace * YD_FT).toFixed(S.puttPace * YD_FT < 10 ? 1 : 0)}<small>ft</small>`;
    $('paceBar').style.width = Math.min(100, S.puttPace / 30 * 100) + '%';
  } else if (S.mode === 'chip'){
    $('actHint').textContent = `Land it ${S.chipTarget.toFixed(1)}y · drag up/down to adjust`;
  }
}

const keys = new Set();
window.addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  const k = e.code;
  if (k === 'Escape'){ togglePause(); return; }
  if (!$('pause').classList.contains('hidden')) return;
  if (k === 'Tab'){ e.preventDefault(); if (S.phase !== 'menu' && S.h){ if ($('cardOv').classList.contains('hidden')) showCard(S.phase === 'over'); else if (S.phase !== 'over') $('cardOv').classList.add('hidden'); } return; }
  if (k === 'KeyM'){ settings.sound = !settings.sound; setMuted(!settings.sound); saveSettings(); paintToggles(); return; }
  if (S.phase === 'holeEnd' && (k === 'Space' || k === 'Enter')){ e.preventDefault(); nextHole(); return; }
  if (S.phase === 'intro' && (k === 'Space' || k === 'Enter')){ e.preventDefault(); endFlyover(); return; }
  if (S.phase === 'flight' && (k === 'Space' || k === 'Enter')){ e.preventDefault(); if (S.shot && S.shot.kind !== 'putt') S.shot.speed = 4; return; }
  if (S.phase !== 'address') return;
  keys.add(k);
  if (k === 'Space' || k === 'Enter'){
    e.preventDefault();
    if (e.repeat) return;
    if (S.mode === 'full') meterClick();
    else if (S.mode === 'chip') holdStart();
    else strokePutt();
    return;
  }
  if (k === 'ArrowUp' || k === 'ArrowDown'){
    e.preventDefault();
    const d = k === 'ArrowUp' ? -1 : 1;
    if (S.mode === 'full'){ if (!e.repeat) changeClub(d); }
    else if (S.mode === 'putt'){ S.puttPace = clamp(S.puttPace - d / 3, 0, 30); S.previewDirty = true; refreshHUDLight();
      me().golfer.pose(-Math.min(1, Math.sqrt(S.puttPace / 30)) * 0.4, 'putt'); }
    else { S.chipTarget = clamp(S.chipTarget - d * 0.25, 0.8, SHOTS[S.shotType].maxCarry); S.previewDirty = true; refreshHUDLight(); }
    return;
  }
  if (k === 'KeyV'){ S.overview = !S.overview; S.read = false; world.setGreenRead(false); refreshHUD(); return; }
  if (k === 'KeyR' && S.mode === 'putt'){ S.read = !S.read; S.overview = false; world.setGreenRead(S.read); refreshHUD(); return; }
  if (k === 'Digit1' || k === 'Digit2' || k === 'Digit3'){
    const types = me().lie === 'bunker' ? ['splash', 'pitch'] : ['bump', 'pitch', 'flop'];
    const t = types[+k.slice(-1) - 1];
    if (S.mode === 'chip' && t) setShotType(t);
    return;
  }
  if (S.mode === 'full' && S.meter.phase === 'idle' && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(k)){
    const st = S.strike;
    if (k === 'KeyW') st.v = clamp(st.v - 0.25, -1, 1);
    if (k === 'KeyS') st.v = clamp(st.v + 0.25, -1, 1);
    if (k === 'KeyA') st.u = clamp(st.u - 0.25, -1, 1);
    if (k === 'KeyD') st.u = clamp(st.u + 0.25, -1, 1);
    refreshHUD();
  }
});
window.addEventListener('keyup', e => {
  keys.delete(e.code);
  if ((e.code === 'Space' || e.code === 'Enter') && S.mode === 'chip') holdRelease();
});
window.addEventListener('blur', () => { keys.clear(); if (S.hold.on) holdRelease(); });
function stepKeys(dt){
  if (S.phase !== 'address') return;
  const L = keys.has('ArrowLeft') || keys.has('KeyQ'), R = keys.has('ArrowRight') || keys.has('KeyE');
  if (L === R) return;
  const fine = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 0.25 : 1;
  const rate = (S.mode === 'putt' ? 0.1 : S.mode === 'chip' ? 0.25 : 0.32) * fine;
  nudgeAim((R ? 1 : -1) * rate * dt);
}

$('bMap').onclick = () => { if (S.phase !== 'address') return; S.overview = !S.overview; S.read = false; world.setGreenRead(false); refreshHUD(); };
$('bRead').onclick = () => { if (S.phase !== 'address' || S.mode !== 'putt') return; S.read = !S.read; S.overview = false; world.setGreenRead(S.read); refreshHUD(); };
$('bCard').onclick = () => { if (S.h) showCard(false); };
$('bMenu').onclick = () => togglePause();
$('hoNext').onclick = () => nextHole();

/* ---------- pause ---------- */
function togglePause(){
  if (S.phase === 'menu' || S.phase === 'boot'){ $('helpOv').classList.add('hidden'); return; }
  const pv = $('pause');
  if (!$('helpOv').classList.contains('hidden')){ $('helpOv').classList.add('hidden'); return; }
  if (!$('cardOv').classList.contains('hidden') && S.phase !== 'over'){ $('cardOv').classList.add('hidden'); return; }
  if (pv.classList.contains('hidden')){
    $('pauseSub').textContent = `${THEMES[S.theme].name} · Hole ${S.holeIdx + 1} of ${S.pars.length}`;
    pv.classList.remove('hidden');
    S.paused = true;
  } else { pv.classList.add('hidden'); S.paused = false; }
}
$('pResume').onclick = () => togglePause();
$('pCard').onclick = () => { $('pause').classList.add('hidden'); S.paused = false; showCard(false); };
$('pHelp').onclick = () => { $('helpOv').classList.remove('hidden'); };
$('pQuit').onclick = () => { $('pause').classList.add('hidden'); S.paused = false; toMenu(); };
$('helpClose').onclick = () => $('helpOv').classList.add('hidden');

/* ============================================================
   MENU
   ============================================================ */
const COURSE_ART = {
  pines: `<svg viewBox="0 0 120 64" preserveAspectRatio="none"><defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ea8e6"/><stop offset="1" stop-color="#cfe8f7"/></linearGradient></defs>
    <rect width="120" height="64" fill="url(#ga)"/><path d="M0 40 Q30 30 60 38 T120 34 V64 H0Z" fill="#3d8a32"/><path d="M0 50 Q40 42 70 48 T120 46 V64 H0Z" fill="#5daa44"/>
    <path d="M10 40 l6-16 6 16z M20 42 l5-13 5 13z M96 38 l6-18 6 18z M106 40 l5-13 5 13z" fill="#1f5a2a"/><ellipse cx="64" cy="49" rx="12" ry="3" fill="#79d05f"/>
    <path d="M66 49 V36" stroke="#fff" stroke-width="1"/><path d="M66 36 l6 2 -6 2z" fill="#ffd21f"/></svg>`,
  links: `<svg viewBox="0 0 120 64" preserveAspectRatio="none"><defs><linearGradient id="gb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7d9fbb"/><stop offset="1" stop-color="#dfe7ea"/></linearGradient></defs>
    <rect width="120" height="64" fill="url(#gb)"/><rect y="34" width="120" height="6" fill="#55828f"/><path d="M0 40 Q20 34 45 40 T90 38 T120 40 V64 H0Z" fill="#b9a865"/>
    <path d="M0 50 Q35 44 70 50 T120 48 V64 H0Z" fill="#7fae4f"/><ellipse cx="40" cy="52" rx="5" ry="2" fill="#e3d2a0"/><ellipse cx="70" cy="49" rx="11" ry="3" fill="#84c95f"/>
    <path d="M72 49 V36" stroke="#fff" stroke-width="1"/><path d="M72 36 l6 2 -6 2z" fill="#e63b2e"/></svg>`,
  mesa: `<svg viewBox="0 0 120 64" preserveAspectRatio="none"><defs><linearGradient id="gc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f86c9"/><stop offset="1" stop-color="#f3d9b5"/></linearGradient></defs>
    <rect width="120" height="64" fill="url(#gc)"/><path d="M8 40 V26 h22 l4 14z M78 40 V22 h26 l6 18z" fill="#b8613f"/><rect y="40" width="120" height="24" fill="#d3a676"/>
    <path d="M10 64 Q40 46 70 50 T120 52 V64Z" fill="#6bb44c"/><ellipse cx="78" cy="51" rx="10" ry="2.6" fill="#75cb5a"/>
    <path d="M24 46 v-9 M24 41 h-3 v-3 M24 43 h3 v-4" stroke="#3f6b35" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M80 51 V38" stroke="#fff" stroke-width="1"/><path d="M80 38 l6 2 -6 2z" fill="#fff"/></svg>`,
  maple: `<svg viewBox="0 0 120 64" preserveAspectRatio="none"><defs><linearGradient id="gd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f97da"/><stop offset="1" stop-color="#e3eef5"/></linearGradient></defs>
    <rect width="120" height="64" fill="url(#gd)"/><path d="M0 36 Q30 24 60 32 T120 28 V64 H0Z" fill="#b8642a"/><path d="M0 48 Q40 38 70 45 T120 42 V64 H0Z" fill="#63a641"/>
    <circle cx="14" cy="34" r="8" fill="#d6452a"/><circle cx="26" cy="36" r="6" fill="#e8902e"/><circle cx="100" cy="30" r="9" fill="#e0a83a"/><circle cx="111" cy="34" r="6" fill="#c5381f"/>
    <path d="M0 55 Q30 50 60 56 T120 54" stroke="#4f8ea3" stroke-width="3" fill="none"/><ellipse cx="66" cy="46" rx="11" ry="2.8" fill="#78cc5b"/>
    <path d="M68 46 V33" stroke="#fff" stroke-width="1"/><path d="M68 33 l6 2 -6 2z" fill="#e8562a"/></svg>`,
  cay: `<svg viewBox="0 0 120 64" preserveAspectRatio="none"><defs><linearGradient id="ge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f9be0"/><stop offset="1" stop-color="#d8f1f7"/></linearGradient></defs>
    <rect width="120" height="64" fill="url(#ge)"/><rect y="36" width="120" height="28" fill="#1f8fa6"/><path d="M0 44 Q30 38 64 42 T120 40 V64 H0Z" fill="#e9dfbf"/>
    <path d="M0 52 Q40 46 76 51 T120 50 V64 H0Z" fill="#5cb84a"/><ellipse cx="72" cy="52" rx="10" ry="2.6" fill="#79d662"/>
    <path d="M20 46 Q22 36 18 26" stroke="#9a7d5a" stroke-width="2" fill="none"/><path d="M18 26 q-8 -2 -12 4 M18 26 q8 -3 12 3 M18 26 q-3 -6 -9 -6 M18 26 q4 -6 10 -5" stroke="#3f8a3a" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path d="M74 52 V39" stroke="#fff" stroke-width="1"/><path d="M74 39 l6 2 -6 2z" fill="#ff4f8b"/></svg>`,
  frost: `<svg viewBox="0 0 120 64" preserveAspectRatio="none"><defs><linearGradient id="gf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a8fc4"/><stop offset="1" stop-color="#e6eef5"/></linearGradient></defs>
    <rect width="120" height="64" fill="url(#gf)"/><path d="M0 40 L22 10 L36 26 L54 6 L78 34 L96 16 L120 38 V64 H0Z" fill="#7d8ea6"/>
    <path d="M17 17 L22 10 L27 16 L24 15 L21 18Z M49 12 L54 6 L60 13 L56 12 L53 15Z M92 21 L96 16 L101 21 L98 20Z" fill="#f4f7fa"/>
    <path d="M0 46 Q40 38 80 44 T120 42 V64 H0Z" fill="#eef3f7"/><path d="M14 64 Q44 48 74 52 T120 54 V64Z" fill="#5c9e48"/>
    <path d="M10 46 l5-13 5 13z M100 44 l5-14 5 14z" fill="#24443a"/><ellipse cx="78" cy="54" rx="10" ry="2.6" fill="#73c260"/>
    <path d="M80 54 V41" stroke="#fff" stroke-width="1"/><path d="M80 41 l6 2 -6 2z" fill="#1e6fff"/></svg>`
};
function paintMenu(){
  const bests = loadBests();
  $('courses').innerHTML = Object.entries(THEMES).map(([k, t]) => {
    const b = bests[`${k}|${settings.holes}|${settings.diff}`];
    return `<button class="course ${k === settings.theme ? 'on' : ''}" data-k="${k}">
    <div class="art">${COURSE_ART[k]}${b ? `<em class="best">BEST ${fmtPar(b.toPar)}</em>` : ''}</div>
    <div class="cinfo"><b>${t.name}</b><span>${t.tag}</span></div></button>`;
  }).join('');
  $('courseDesc').textContent = THEMES[settings.theme].desc;
  $('courses').querySelectorAll('.course').forEach(b => b.onclick = () => {
    if (settings.theme === b.dataset.k) return;
    settings.theme = b.dataset.k; saveSettings(); sfx.select(); paintMenu(); buildAttract();
  });
  for (const b of $('holesSeg').querySelectorAll('button')){
    b.classList.toggle('on', +b.dataset.v === settings.holes);
    b.onclick = () => { settings.holes = +b.dataset.v; saveSettings(); sfx.ui(); paintMenu(); };
  }
  for (const b of $('diffSeg').querySelectorAll('button')){
    b.classList.toggle('on', b.dataset.v === settings.diff);
    b.onclick = () => { settings.diff = b.dataset.v; saveSettings(); sfx.ui(); paintMenu(); };
  }
  $('diffDesc').textContent = DIFFICULTY[settings.diff].desc;
  paintPlayers();
  paintToggles();
}
function playerNames(){
  const names = settings.names.length ? settings.names.slice(0, 4) : [profile.name || 'You'];
  return names.map((n, i) => (n || '').trim() || (i === 0 ? (profile.name || 'You') : `Player ${i + 1}`));
}
function paintPlayers(){
  if (!settings.names.length) settings.names = [profile.name || 'You'];
  const box = $('players');
  box.innerHTML = settings.names.map((n, i) => `<div class="pin"><i style="background:${PLAYER_COLORS[i]}"></i>
    <input maxlength="16" value="${esc(n)}" data-i="${i}" aria-label="Player ${i + 1} name">
    ${i > 0 ? `<button class="x" data-i="${i}" aria-label="Remove">✕</button>` : ''}</div>`).join('') +
    (settings.names.length < 4 ? '<button class="addp" id="addP">+ Add player (pass and play)</button>' : '');
  box.querySelectorAll('input').forEach(inp => inp.oninput = () => { settings.names[+inp.dataset.i] = inp.value; saveSettings(); });
  box.querySelectorAll('.x').forEach(b => b.onclick = () => { settings.names.splice(+b.dataset.i, 1); saveSettings(); paintPlayers(); });
  const add = $('addP');
  if (add) add.onclick = () => { settings.names.push(`Player ${settings.names.length + 1}`); saveSettings(); sfx.ui(); paintPlayers(); };
}
function paintToggles(){
  for (const id of ['tSound', 'pSound']) $(id).classList.toggle('on', settings.sound);
  for (const id of ['tQuality', 'pQuality']) $(id).classList.toggle('on', settings.quality === 'high');
}
for (const id of ['tSound', 'pSound']) $(id).onclick = () => { settings.sound = !settings.sound; setMuted(!settings.sound); saveSettings(); paintToggles(); if (settings.sound) sfx.ui(); };
for (const id of ['tQuality', 'pQuality']) $(id).onclick = () => {
  settings.quality = settings.quality === 'high' ? 'low' : 'high'; saveSettings(); paintToggles(); world.setQuality(settings.quality);
  toast('Graphics', settings.quality === 'high' ? 'High' : 'Performance');
};
$('bTeeOff').onclick = () => { sfx.select(); startRound(); };
$('bHelp').onclick = () => $('helpOv').classList.remove('hidden');
$('bBack').onclick = () => { location.href = 'index.html'; };

let attractFor = null;
function buildAttract(){
  const theme = settings.theme;
  const seed = 4242 + Object.keys(THEMES).indexOf(theme) * 101;
  attractFor = theme;
  return takePrep(seed, 4, theme).then(prep => {
    if (S.phase !== 'menu' || attractFor !== theme) return;
    const h = genHole(seed, 4, theme);
    S.h = h;
    S.theme = theme;
    world.buildHole(h, prep);
    world.warm();
    world.placeBall({ x: h.pin.x + 1.2, y: h.heightAt(h.pin.x + 1.2, h.pin.z + 0.8) + 0.0233, z: h.pin.z + 0.8 });
    cam.cut = true;
  });
}
function toMenu(){
  if (net.online) net.leave();
  S.online = false; S.meIdx = 0;
  timers.length = 0;
  cleanupPlayers();
  S.players = [];
  S.phase = 'menu';
  S.shot = null;
  world.setTracer(null);
  hideHUD();
  stopAmbience();
  $('holeOv').classList.add('hidden');
  $('intro').classList.remove('on');
  $('menu').classList.remove('hidden');
  $('meChip').classList.remove('hidden');
  paintMenu();
  return buildAttract();
}

/* ============================================================
   ONLINE — a party of up to four, each playing their own ball at once
   ============================================================ */
const findPid = pid => S.players.find(p => p.pid === pid);

// my shot, as a light path the others replay (30 Hz, centimetre precision)
function sendShot(sim){
  const s = sim.samples, path = [];
  for (let i = 0; i < s.length; i += 6) path.push(Math.round(s[i] * 100) / 100, Math.round(s[i + 1] * 100) / 100, Math.round(s[i + 2] * 100) / 100);
  const n = s.length;
  path.push(Math.round(s[n - 3] * 100) / 100, Math.round(s[n - 2] * 100) / 100, Math.round(s[n - 1] * 100) / 100);
  net.send({ t: 'shot', hole: S.holeIdx, path, dt: sim.sampleDt * 2 });
}
// where my ball ended up, and my card: the owner of a ball is its only authority
function sendState(){
  const p = S.players[S.meIdx];
  if (!S.online || !p) return;
  net.send({ t: 'state', hole: S.holeIdx, ball: p.ball, lie: p.lie, strokes: p.strokes, holed: p.holed,
             scores: p.scores, putts: p.putts });
}

net.on('shot', m => {
  const q = findPid(m.pid);
  if (!q || q.isMe || !S.online || m.hole !== S.holeIdx || S.phase === 'loading' || !Array.isArray(m.path)) return;
  q.remote = { path: m.path, dt: m.dt || 1 / 30, t: 0 };
  q.marker.visible = !q.holed;
});
net.on('state', m => {
  const q = findPid(m.pid);
  if (!q || q.isMe || !S.online || m.hole !== S.holeIdx) return;
  const wasHoled = q.holed;
  q.stateHole = m.hole;
  q.ball = m.ball; q.lie = m.lie; q.strokes = m.strokes; q.holed = !!m.holed;
  if (Array.isArray(m.scores)) q.scores = m.scores.slice(0, S.pars.length);
  if (Array.isArray(m.putts)) q.putts = m.putts.slice(0, S.pars.length);
  q.remote = null;
  if (S.h){
    q.marker.position.set(q.ball.x, world.visualY(q.ball), q.ball.z);
    q.marker.visible = !q.holed && S.phase !== 'loading' && S.phase !== 'intro';
  }
  if (q.holed && !wasHoled && S.h){
    const sc = q.scores[S.holeIdx], rel = sc - S.h.par;
    toast(`${q.name} · ${sc === 1 ? 'Hole in one!' : SCORE_NAMES[rel] || (rel > 0 ? '+' + rel : rel)}`, `${sc} stroke${sc === 1 ? '' : 's'}`);
    if (rel < 0) sfx.crowd(0.6, 2);
  }
  if (S.phase === 'address' || S.phase === 'flight' || S.phase === 'result' || S.phase === 'waiting') refreshHUD();
  if (S.phase === 'waiting'){ if (S.players.every(p => p.holed)) endHole(); else if (q.holed && !wasHoled) later(waitToast, 2200); }
});
net.on('next', m => {
  if (!S.online || m.hole !== S.holeIdx + 1) return;
  if (S.phase !== 'holeEnd'){
    // got ahead of us (a lost message): settle this hole as it stands
    for (const q of S.players) if (!q.holed){ q.holed = true; if (q.scores[S.holeIdx] === null) q.scores[S.holeIdx] = STROKE_CAP; }
  }
  goNextHole();
});
net.on('start', m => {
  if (net.isHost) return;
  net.started = true;
  if (S.players.length) cleanupPlayers();
  startRound(m);
});
net.on('left', m => {
  if (!S.online) return;
  const q = findPid(m.pid);
  if (!q || q.gone) return;
  q.gone = true; q.remote = null; q.marker.visible = false;
  if (!q.holed){ q.holed = true; if (q.scores[S.holeIdx] === null) q.scores[S.holeIdx] = STROKE_CAP; }
  toast(`${q.name} left the round`, '');
  if (S.phase === 'address' || S.phase === 'waiting') refreshHUD();
  if (S.phase === 'waiting' && S.players.every(p => p.holed)) endHole();
});
net.onGone = () => {
  if (S.online && S.phase !== 'menu'){
    banner('Host left', 'Back to the clubhouse', false);
    setTimeout(() => { $('cardOv').classList.add('hidden'); toMenu(); }, 2400);
  } else lobbyMsg('The host closed the room.', false);
  paintLobby();
};

// a friend's ball replays their shot; their state message then pins it down
function stepRemote(dt){
  for (const q of S.players){
    const R = q.remote;
    if (!R || q.isMe) continue;
    R.t += dt;
    const n = R.path.length / 3, f = Math.min(n - 1, R.t / R.dt);
    const i = Math.floor(f), j = Math.min(n - 1, i + 1), k = f - i, P = R.path;
    const pt = { x: P[i * 3] + (P[j * 3] - P[i * 3]) * k, y: P[i * 3 + 1] + (P[j * 3 + 1] - P[i * 3 + 1]) * k, z: P[i * 3 + 2] + (P[j * 3 + 2] - P[i * 3 + 2]) * k };
    q.marker.position.set(pt.x, world.visualY(pt), pt.z);
    const dd = world.camera.position.distanceTo(q.marker.position);
    q.marker.scale.setScalar(Math.max(1, Math.min(12, dd / 11)));
    if (f >= n - 1) q.remote = null;
  }
}

/* ---------- lobby ---------- */
const myEntry = () => ({ name: playerNames()[0] || profile.name || 'Player', avatar: profile.avatar, avatarImg: profile.avatarImg });
function lobbyMsg(t, ok){
  const el = $('olLobby').classList.contains('hidden') ? $('olMsg') : $('olMsg2');
  el.textContent = t || ''; el.className = 'olmsg' + (ok ? ' ok' : '');
}
function lobbyView(lobby){
  $('olChoose').classList.toggle('hidden', lobby);
  $('olLobby').classList.toggle('hidden', !lobby);
}
function openOnline(code){
  $('onlineOv').classList.remove('hidden');
  lobbyView(false);
  $('olSetup').textContent = `Hosting uses your setup: ${THEMES[settings.theme].name} · ${settings.holes} holes · ${DIFFICULTY[settings.diff].name}. Everyone plays the hole at the same time on their own screen.`;
  $('olMsg').textContent = '';
  $('olHost').disabled = false; $('olJoin').disabled = false;
  if (code){ $('olCode').value = code; joinRoom(); }
}
function paintLobby(){
  if ($('onlineOv').classList.contains('hidden')) return;
  const R = net.roster;
  $('olShow').textContent = net.code || '····';
  $('olRole').textContent = net.isHost ? 'YOUR ROOM CODE' : 'ROOM';
  $('olList').innerHTML = R.map((r, i) => `<div class="hs-row"><span class="av" style="--pc:${PLAYER_COLORS[i]}">${avatarHTML(r)}</span>
    <div class="n">${esc(r.name)}${r.pid === net.myPid ? '<span class="you">YOU</span>' : ''}</div>${i === 0 ? '<span class="hostTag">HOST</span>' : ''}</div>`).join('') +
    Array.from({ length: Math.max(0, MAX_PLAYERS - R.length) }, () => '<div class="hs-row" style="opacity:.35"><div class="n">Open seat</div></div>').join('');
  const st = $('olStart');
  st.classList.toggle('hidden', !net.isHost);
  st.disabled = R.length < 2;
  if (net.isHost) $('olInfo').textContent = R.length < 2 ? 'Share the code. Start once a friend joins.' :
    `${R.length} players · ${THEMES[settings.theme].name} · ${settings.holes} holes · ${DIFFICULTY[settings.diff].name}`;
  else $('olInfo').textContent = net.online ? 'You are in. The host will start the round.' : '';
}
net.onRoster = paintLobby;

async function hostRoom(){
  unlock(); sfx.ui();
  $('olHost').disabled = true;
  lobbyMsg('Opening a room…', true);
  try{
    await net.host(myEntry());
    lobbyView(true);
    lobbyMsg('', true);
    paintLobby();
  }catch(e){
    net.leave();
    lobbyMsg(peerError(e).msg, false);
    $('olHost').disabled = false;
  }
}
async function joinRoom(){
  unlock();
  const code = $('olCode').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)){ lobbyMsg('Enter the 4-character code from the host.', false); return; }
  $('olJoin').disabled = true;
  lobbyMsg('Connecting…', true);
  try{
    await net.join(code, myEntry());
    lobbyView(true);
    lobbyMsg('', true);
    paintLobby();
    sfx.select();
  }catch(e){
    net.leave();
    lobbyMsg(peerError(e).msg, false);
    $('olJoin').disabled = false;
  }
}
function hostStart(){
  if (!net.isHost) return;
  if (net.roster.length < 2){
    toast('Everyone else left', 'Back to the lobby');
    toMenuKeepRoom();
    return;
  }
  net.started = true;
  const opts = { t: 'start', seed: (Math.random() * 1e9) | 0, theme: settings.theme, holes: settings.holes, diff: settings.diff,
                 roster: net.roster.map(r => ({ ...r })) };
  net.send(opts);
  startRound(opts);
}
// back to the lobby with the room still open
function toMenuKeepRoom(){
  timers.length = 0; cleanupPlayers(); S.players = []; S.online = false; S.phase = 'menu'; S.shot = null;
  net.started = false;
  hideHUD(); stopAmbience();
  $('menu').classList.remove('hidden'); $('meChip').classList.remove('hidden');
  paintMenu(); buildAttract();
  $('onlineOv').classList.remove('hidden'); lobbyView(true); paintLobby();
}

$('bOnline').onclick = () => { sfx.ui(); openOnline(); };
$('olHost').onclick = hostRoom;
$('olJoin').onclick = joinRoom;
$('olCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('olCode').addEventListener('input', () => { $('olCode').value = $('olCode').value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('olClose').onclick = () => { $('onlineOv').classList.add('hidden'); };
$('olLeave').onclick = () => { net.leave(); lobbyView(false); $('olHost').disabled = false; $('olJoin').disabled = false; lobbyMsg('', false); };
$('olStart').onclick = () => { if (net.roster.length >= 2){ sfx.select(); hostStart(); } };
$('olShare').onclick = async () => {
  const link = location.origin + location.pathname + '?room=' + net.code;
  const btn = $('olShare');
  try{
    if (navigator.share && matchMedia('(pointer: coarse)').matches){ await navigator.share({ title: 'Tour Golf', text: 'Join my round', url: link }); return; }
    await navigator.clipboard.writeText(link);
    btn.textContent = 'Link copied!';
  }catch(e){ btn.textContent = link; }
  setTimeout(() => { btn.textContent = 'Copy invite link'; }, 2200);
};

/* ============================================================
   MAIN LOOP
   ============================================================ */
let last = performance.now();
function frame(now){
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  S.t += dt;
  if (S.paused){ world.render(); return; }
  stepTimers(dt);
  const p = me();

  if (S.online) stepRemote(dt);
  if (S.phase === 'menu' || S.phase === 'holeEnd' || S.phase === 'over' || S.phase === 'waiting') cameraMenu();
  else if (S.phase === 'intro' && S.fly) cameraFlyover(dt);
  else if (S.phase === 'address' || S.phase === 'result'){
    if (S.phase === 'address'){
      stepKeys(dt);
      if (S.mode === 'full') stepMeter(dt);
      if (S.mode === 'chip'){ stepHold(dt); if (S.hold.on) S.previewDirty = true; }
      if (S.mode === 'full' && (S.meter.phase === 'power')) S.previewDirty = true;
      if (S.previewDirty){ S.previewDirty = false; updatePreview(); }
      cameraAddress();
      world.placeBall(p.ball);
      const onTee = p.lie === 'tee' && S.mode === 'full';
      world.peg.visible = onTee;
      if (onTee) world.peg.position.set(p.ball.x, world.groundAt(p.ball.x, p.ball.z) + 0.02, p.ball.z);
    }
  } else if (S.phase === 'flight') stepShot(dt);

  // swing animations
  if (p && S.down){
    const d = S.down;
    d.t += dt;
    const k = Math.min(1, d.t / d.dur);
    p.golfer.pose(d.from * (1 - k * k), d.style, { down: true, top: -d.from });
    if (k >= 1){ const fire = d.fire; S.down = null; fire(); }
  }
  if (p && S.follow){
    const f = S.follow;
    f.t += dt;
    const k = Math.min(1, f.t / f.dur);
    p.golfer.pose((f.to || 1) * (1 - Math.pow(1 - k, 3)), f.style);
    if (k >= 1) S.follow = null;
  }
  if (p && S.phase === 'address' && S.meter.phase === 'idle' && !S.hold.on && !S.down && !drag.on) p.golfer.update(dt, true);
  if (world.target.visible) world.target.material.opacity = 0.7 + 0.25 * Math.sin(S.t * 4.5);

  if (S.h){
    world.update(dt, S.h.wind.mph);
    applyCamera(dt);
    if (p){
      updateLabels();
      updateWind();
      drawMinimap();
      drawMeter();
      drawHoldRing();
    }
  }
  world.render();
}

/* ============================================================
   BOOT
   ============================================================ */
window.addEventListener('resize', () => { world.resize(); if (S.h && S.phase !== 'menu') buildMinimap(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && S.hold.on) holdRelease(); });

async function boot(){
  loadProfile();
  paintChip();
  refreshProfile();
  try{ await document.fonts.ready; }catch(e){}
  requestAnimationFrame(t => { last = t; frame(t); });
  await toMenu();
  $('loading').classList.add('fade');
  try{
    const room = new URLSearchParams(location.search).get('room');
    if (room && /^[A-Za-z2-9]{4}$/.test(room)){
      history.replaceState(null, '', location.pathname);
      // the PeerJS script is deferred: wait for it before joining
      const go = () => openOnline(room.toUpperCase());
      if (typeof Peer === 'function') go(); else window.addEventListener('load', go, { once: true });
    }
  }catch(e){}
  setTimeout(() => $('loading').remove(), 700);
  // pre-warm the speed solver for every club at full power
  setTimeout(() => { for (const c of CLUBS.slice(0, PUTTER)) cachedSpeed(c.carry, c.launch, c.spin); }, 400);
}
// test hook (used by the automated play-tests)
window.__tour = { S, world, beginTurn, cam };
boot();
