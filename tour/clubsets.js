/* ============================================================
   CLUB SETS — eight full bags. A set's stats (1-100, 50 = Starter)
   scale the base clubs in config.js, so a Driver stays longer than a
   wedge in every set. Every number worth rebalancing is at the top.
   ============================================================ */

// How one stat point turns into gameplay. Each effect is a multiplier
// that is exactly 1 at 50 (the Starter Set).
export const STAT_FX = {
  power:       { perPt: 0.0024 },             // full-swing carry ×(1 + (P-50)·k): 95 ≈ +11%, 25 ≈ -6%
  accuracy:    { perPt: 0.009,  min: 0.35 },  // direction miss and scatter ×(1 - (A-50)·k): 90 ≈ 0.64
  spin:        { perPt: 0.009,  min: 0.4 },   // backspin ×(1 + (S-50)·k): more bite and check on landing
  forgiveness: { perPt: 0.012,  min: 0.3 },   // mishit distance loss and lie penalties ×(1 - (F-50)·k)
  control:     { perPt: 0.008,  min: 0.4 }    // wind push and mishit curve ×(1 - (C-50)·k)
};

export const STAT_KEYS = ['power', 'accuracy', 'spin', 'forgiveness', 'control'];
export const STAT_NAMES = { power: 'Power', accuracy: 'Accuracy', spin: 'Spin', forgiveness: 'Forgiveness', control: 'Control' };

// The bag: six slots covering the fourteen clubs. Chips use the wedges.
export const SLOTS = [
  { id: 'D',  name: 'Driver',     clubs: ['D'] },
  { id: 'W',  name: 'Woods',      clubs: ['3W', '5W'] },
  { id: 'LI', name: 'Long Irons', clubs: ['4H', '5i', '6i'] },
  { id: 'SI', name: 'Short Irons', clubs: ['7i', '8i', '9i'] },
  { id: 'WG', name: 'Wedges',     clubs: ['PW', 'GW', 'SW', 'LW'] },
  { id: 'PT', name: 'Putter',     clubs: ['P'] }
];
const SLOT_OF = {};
for (const s of SLOTS) for (const c of s.clubs) SLOT_OF[c] = s.id;
export const slotOf = clubId => SLOT_OF[clubId] || 'SI';

export const RARITY = {
  common:    { name: 'Common',    color: '#b9c4bd' },
  rare:      { name: 'Rare',      color: '#5ba8ff' },
  epic:      { name: 'Epic',      color: '#c07bff' },
  legendary: { name: 'Legendary', color: '#ffcf4a' }
};

// stats: the set's headline numbers. tweak: small per-slot changes on top.
export const SETS = [
  { id: 'starter', name: 'Starter Set', rarity: 'common', color: '#c9d1cc',
    desc: 'Fifty across the board. Nothing to fix, nothing to lean on.',
    stats: { power: 50, accuracy: 50, spin: 50, forgiveness: 50, control: 50 }, tweak: {} },
  { id: 'woods', name: 'Woods', rarity: 'rare', color: '#e0473c',
    desc: 'Tight, high-spinning and steady in the wind. Precision over raw length.',
    stats: { power: 70, accuracy: 85, spin: 75, forgiveness: 60, control: 80 },
    tweak: { D: { power: -2, accuracy: 3 }, WG: { spin: 5 }, PT: { accuracy: 4 } } },
  { id: 'dechambeau', name: 'DeChambeau', rarity: 'legendary', color: '#4fb3ff',
    desc: 'The longest bag in the shop. Misses go wide and the wind still moves it.',
    stats: { power: 95, accuracy: 55, spin: 65, forgiveness: 45, control: 50 },
    tweak: { D: { power: 3, accuracy: -4 }, W: { power: 2 }, WG: { spin: -3, accuracy: 3 }, PT: { accuracy: 2 } } },
  { id: 'aarush', name: "Aarush's Clubs", rarity: 'epic', color: '#ff8a3d',
    desc: 'Long and easy to hit from anywhere, but the ball will not check up on the greens.',
    stats: { power: 88, accuracy: 60, spin: 25, forgiveness: 85, control: 67 },
    tweak: { D: { power: 4 }, SI: { forgiveness: 3 }, WG: { spin: -5 }, PT: { accuracy: -3 } } },
  { id: 'ajay', name: "Ajay's Clubs", rarity: 'epic', color: '#b45cff',
    desc: 'Darts that stop on a dime. Catch one thin or from the rough and it bites back.',
    stats: { power: 65, accuracy: 90, spin: 92, forgiveness: 30, control: 60 },
    tweak: { D: { power: -3, accuracy: -4 }, SI: { accuracy: 3 }, WG: { spin: 4 }, PT: { accuracy: 3 } } },
  { id: 'mateen', name: "Mateen's Clubs", rarity: 'epic', color: '#2fd3c0',
    desc: 'A low, boring flight that shrugs off the wind and keeps running after it lands.',
    stats: { power: 75, accuracy: 70, spin: 40, forgiveness: 55, control: 85 },
    tweak: { D: { power: 3 }, LI: { control: 3 }, WG: { spin: 5 }, PT: { forgiveness: 3 } } },
  { id: 'aiden', name: "Aiden's Clubs", rarity: 'rare', color: '#7ddc5a',
    desc: 'Soft landings and kind faces on every club. A breeze will push it around.',
    stats: { power: 55, accuracy: 65, spin: 80, forgiveness: 80, control: 45 },
    tweak: { D: { forgiveness: 4 }, W: { forgiveness: 3 }, WG: { spin: 3 }, PT: { forgiveness: 4 } } },
  { id: 'ram', name: "Ram's Clubs", rarity: 'epic', color: '#ff5fa2',
    desc: 'Dead straight off a pure strike. Mishits and bad lies cost you dearly.',
    stats: { power: 65, accuracy: 80, spin: 50, forgiveness: 35, control: 70 },
    tweak: { D: { accuracy: -3 }, SI: { accuracy: 4 }, WG: { forgiveness: -3 }, PT: { accuracy: 4 } } }
];
export const SET_BY_ID = Object.fromEntries(SETS.map(s => [s.id, s]));
export const DEFAULT_SET = 'starter';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// a set's numbers for one slot of the bag
export function slotStats(setId, slot){
  const s = SET_BY_ID[setId] || SET_BY_ID[DEFAULT_SET];
  const t = (s.tweak && s.tweak[slot]) || {};
  const out = {};
  for (const k of STAT_KEYS) out[k] = clamp(s.stats[k] + (t[k] || 0), 1, 100);
  return out;
}

// stats -> the multipliers the shot code uses
export function fxFrom(st){
  const F = STAT_FX;
  return {
    power:   1 + (st.power - 50) * F.power.perPt,
    acc:     Math.max(F.accuracy.min, 1 - (st.accuracy - 50) * F.accuracy.perPt),
    spin:    Math.max(F.spin.min, 1 + (st.spin - 50) * F.spin.perPt),
    forgive: Math.max(F.forgiveness.min, 1 - (st.forgiveness - 50) * F.forgiveness.perPt),
    control: Math.max(F.control.min, 1 - (st.control - 50) * F.control.perPt)
  };
}
export const clubFx = (setId, slot) => fxFrom(slotStats(setId, slot));

// the average of a bag's slots, for comparing a mixed bag with a set
export function bagStats(bag){
  const out = {};
  for (const k of STAT_KEYS) out[k] = Math.round(SLOTS.reduce((a, s) => a + slotStats(bag[s.id], s.id)[k], 0) / SLOTS.length);
  return out;
}

// A short plain-language read of a set, worked out from its final numbers
// against the Starter Set: its two biggest strengths and its biggest weakness.
export function summarize(setId, driverCarry = 268){
  const st = SET_BY_ID[setId].stats;
  const f = fxFrom(st), dPow = fxFrom(slotStats(setId, 'D')).power;
  const pct = x => Math.round(Math.abs(x) * 100);
  // ranked by stat points away from 50, worded by what they do on the course
  const effects = [
    { k: 'power', d: f.power - 1, up: () => `Driver carries about ${Math.round(driverCarry * dPow)} yards (Starter ${driverCarry})`,
      down: () => `Shorter: the driver carries about ${Math.round(driverCarry * dPow)} yards` },
    { k: 'accuracy', d: 1 - f.acc, up: d => `Misses stray ${pct(d)}% less offline`, down: d => `Misses stray ${pct(d)}% further offline` },
    { k: 'spin', d: f.spin - 1, up: d => `${pct(d)}% more backspin, so approaches stop quickly on the green`,
      down: d => `${pct(d)}% less backspin, so approaches release and roll out` },
    { k: 'forgiveness', d: 1 - f.forgive, up: d => `Rough, sand and mishits cost ${pct(d)}% less`,
      down: d => `Rough, sand and mishits cost ${pct(d)}% more` },
    { k: 'control', d: 1 - f.control, up: d => `Wind and curve move it ${pct(d)}% less`, down: d => `Wind and curve move it ${pct(d)}% more` }
  ].map(e => ({ ...e, pts: st[e.k] - 50 }));
  if (effects.every(e => e.pts === 0)) return ['The baseline every other set is measured against.', 'No strengths, no weaknesses.'];
  const lines = effects.filter(e => e.pts > 2).sort((a, b) => b.pts - a.pts).slice(0, 2).map(e => e.up(e.d));
  const weak = effects.filter(e => e.pts < -2).sort((a, b) => a.pts - b.pts)[0];
  lines.push(weak ? weak.down(weak.d) : 'No weak spots against the Starter Set');
  return lines;
}
