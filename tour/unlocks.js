/* ============================================================
   UNLOCKS — club sets are earned, never bought. Lifetime stats, the
   conditions that turn them into sets, and the saved bag.
   ============================================================ */
import { SETS, SET_BY_ID, SLOTS, DEFAULT_SET } from './clubsets.js';

// What counts, in one place.
export const RULES = {
  driveYards: 300,      // total yards (carry + roll) for Aarush's Clubs
  winMargin: 3,         // strokes ahead of second place for a "big win"
  soloWinToPar: 0,      // a solo round is a win at this score to par or better
  stars: { three: -1, twoPer9: 3 }   // 3★ at -1 or better; 2★ within +3 per nine holes; else 1★
};

// Lifetime stats the conditions can use, with how to show them.
export const METRICS = {
  wins:         { label: 'Wins' },
  bigWins:      { label: `Wins by ${RULES.winMargin}+` },
  fairwayRun:   { label: 'Best fairway streak' },
  birdiesRound: { label: 'Most birdies in a round' },
  longestDrive: { label: 'Longest drive', unit: 'y' },
  underPar:     { label: 'Under-par rounds' },
  rounds:       { label: 'Rounds played' },
  stars:        { label: 'Stars earned' }
};

// Each set needs every part of its list.
export const UNLOCKS = {
  woods:      { text: 'Win 3 rounds', need: [{ m: 'wins', n: 3 }] },
  aiden:      { text: 'Win 5 rounds', need: [{ m: 'wins', n: 5 }] },
  ram:        { text: `Win 3 rounds by ${RULES.winMargin}+ strokes`, need: [{ m: 'bigWins', n: 3 }] },
  mateen:     { text: 'Hit 5 fairways in a row in one round', need: [{ m: 'fairwayRun', n: 5 }] },
  ajay:       { text: 'Make 3 birdies in one round', need: [{ m: 'birdiesRound', n: 3 }] },
  aarush:     { text: `Hit a drive ${RULES.driveYards}+ yards`, need: [{ m: 'longestDrive', n: RULES.driveYards }] },
  dechambeau: { text: 'Win 10 rounds and finish a round under par', need: [{ m: 'wins', n: 10 }, { m: 'underPar', n: 1 }] }
};

/* ---------- save data ---------- */
const KEY = 'tour_clubs';
export const SAVE_VERSION = 1;

function fresh(){
  return {
    v: SAVE_VERSION,
    unlocked: [DEFAULT_SET],
    bag: Object.fromEntries(SLOTS.map(s => [s.id, DEFAULT_SET])),
    stats: Object.fromEntries(Object.keys(METRICS).map(k => [k, 0]))
  };
}
// any save, from any version or none, becomes a valid current one
function migrate(raw){
  const d = fresh();
  if (!raw || typeof raw !== 'object') return d;
  // (v1 is the first version: future versions convert older fields here before the copy below)
  if (Array.isArray(raw.unlocked)) d.unlocked = [...new Set([DEFAULT_SET, ...raw.unlocked.filter(id => SET_BY_ID[id])])];
  if (raw.stats && typeof raw.stats === 'object')
    for (const k in d.stats) if (Number.isFinite(raw.stats[k])) d.stats[k] = Math.max(0, raw.stats[k]);
  if (raw.bag && typeof raw.bag === 'object')
    for (const s of SLOTS) if (d.unlocked.includes(raw.bag[s.id])) d.bag[s.id] = raw.bag[s.id];
  return d;
}

export const clubs = migrate(read());
function read(){ try{ return JSON.parse(localStorage.getItem(KEY) || 'null'); }catch(e){ return null; } }
export function save(){ try{ localStorage.setItem(KEY, JSON.stringify(clubs)); }catch(e){} }
save();

export const isUnlocked = id => clubs.unlocked.includes(id);

/* ---------- equipping ---------- */
export function equipSet(id){
  if (!isUnlocked(id)) return false;
  for (const s of SLOTS) clubs.bag[s.id] = id;
  save();
  return true;
}
export function equipSlot(slot, id){
  if (!isUnlocked(id) || !(slot in clubs.bag)) return false;
  clubs.bag[slot] = id;
  save();
  return true;
}
// the one set the whole bag is, or null for a mix
export function bagSet(){
  const ids = new Set(Object.values(clubs.bag));
  return ids.size === 1 ? [...ids][0] : null;
}

/* ---------- progress ---------- */
export function progress(id, stats = clubs.stats){
  const u = UNLOCKS[id];
  if (!u) return { done: true, frac: 1, parts: [] };
  const parts = u.need.map(({ m, n }) => ({ m, label: METRICS[m].label, unit: METRICS[m].unit || '', have: Math.min(n, stats[m] || 0), need: n }));
  const frac = parts.reduce((a, p) => a + p.have / p.need, 0) / parts.length;
  return { done: parts.every(p => p.have >= p.need), frac, parts };
}
export const progressText = pr => pr.parts.map(p => `${p.label}: ${p.have}${p.unit}/${p.need}${p.unit}`).join(' · ');

export function starsFor(toPar, holes){
  const R = RULES.stars;
  if (toPar <= R.three) return 3;
  if (toPar * 9 / holes <= R.twoPer9) return 2;
  return 1;
}

/* A finished round. r: { win, bigWin, toPar, holes, birdies, fairwayRun, longest }
   Returns what it changed so the scorecard can show it. */
export function recordRound(r){
  const before = { ...clubs.stats };
  const s = clubs.stats;
  const stars = starsFor(r.toPar, r.holes);
  s.rounds++;
  s.stars += stars;
  if (r.win) s.wins++;
  if (r.bigWin) s.bigWins++;
  if (r.toPar < 0) s.underPar++;
  s.fairwayRun = Math.max(s.fairwayRun, r.fairwayRun || 0);
  s.birdiesRound = Math.max(s.birdiesRound, r.birdies || 0);
  s.longestDrive = Math.max(s.longestDrive, r.longest || 0);
  const gained = [], added = [];
  for (const set of SETS){
    if (isUnlocked(set.id)) continue;
    const a = progress(set.id, before), b = progress(set.id, s);
    if (b.done){ clubs.unlocked.push(set.id); added.push(set.id); }
    if (b.frac > a.frac || b.done) gained.push({ id: set.id, before: a, after: b });
  }
  save();
  return { stars, gained, unlocked: added };
}

// dev: everything open (Ctrl/Cmd + Shift + U)
export function unlockAll(){
  const added = SETS.map(s => s.id).filter(id => !isUnlocked(id));
  clubs.unlocked.push(...added);
  save();
  return added;
}
