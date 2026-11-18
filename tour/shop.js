/* ============================================================
   CLUB SHOP — every set as a card, a detail view that compares it with
   what is in the bag, a My Bag screen for mixing slots, and the
   UNLOCKED popup. Sets are earned in unlocks.js; this only shows them.
   ============================================================ */
import { SETS, SET_BY_ID, SLOTS, STAT_KEYS, STAT_NAMES, RARITY, slotStats, bagStats, summarize } from './clubsets.js';
import { clubs, UNLOCKS, isUnlocked, equipSet, equipSlot, bagSet, progress, progressText, unlockAll } from './unlocks.js';
import { sfx } from './audio.js';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SHORT = { power: 'PWR', accuracy: 'ACC', spin: 'SPN', forgiveness: 'FRG', control: 'CTL' };
const LOCK = '<svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

let opts = { onChange: () => {}, toast: () => {} };
let tab = 'sets', detail = null;
const queue = [];

export const bagName = () => { const id = bagSet(); return id ? SET_BY_ID[id].name : 'Mixed bag'; };
export const bagColor = () => { const id = bagSet(); return id ? SET_BY_ID[id].color : '#ffffff'; };
export const shopOpen = () => !$('shopOv').classList.contains('hidden') || !$('unlockOv').classList.contains('hidden');

function changed(){ opts.onChange(); }

// five bars that grow in once they are on the page
function bars(stats, color){
  return `<div class="cbars">${STAT_KEYS.map(k => `<div class="cbar"><span>${SHORT[k]}</span><i><b data-w="${stats[k]}" style="background:${color}"></b></i><em>${stats[k]}</em></div>`).join('')}</div>`;
}
function grow(root){
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const b of root.querySelectorAll('[data-w]')) b.style.width = b.dataset.w + '%';
  }));
}
const rarityTag = s => `<span class="crar" style="--rc:${RARITY[s.rarity].color}">${RARITY[s.rarity].name}</span>`;
function equipLabel(id){
  if (bagSet() === id) return ['EQUIPPED', 'on'];
  if (Object.values(clubs.bag).includes(id)) return ['IN BAG · EQUIP ALL', ''];
  return ['EQUIP', ''];
}

/* ---------- sets ---------- */
function paintSets(){
  const body = $('shopBody');
  body.innerHTML = `<div class="cgrid">${SETS.map(s => {
    const open = isUnlocked(s.id);
    let foot;
    if (open){
      const [t, cls] = equipLabel(s.id);
      foot = `<button class="ceq ${cls}" data-eq="${s.id}">${t}</button>`;
    } else {
      const pr = progress(s.id);
      foot = `<div class="creq">${LOCK}${esc(UNLOCKS[s.id].text)}</div>
        <div class="cprog"><i data-w="${Math.round(pr.frac * 100)}"></i></div><div class="cpt">${esc(progressText(pr))}</div>`;
    }
    return `<div class="ccard ${open ? '' : 'locked'}" data-id="${s.id}" role="button" tabindex="0" style="--ac:${s.color}">
      <div class="ctop">${rarityTag(s)}${open ? '' : LOCK}</div>
      <div class="cname">${esc(s.name)}</div><div class="cdesc2">${esc(s.desc)}</div>
      ${bars(s.stats, s.color)}${foot}</div>`;
  }).join('')}</div>`;
  body.querySelectorAll('.ccard').forEach(c => {
    c.onclick = e => { if (e.target.closest('[data-eq]')) return; sfx.ui(); showDetail(c.dataset.id); };
    c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); showDetail(c.dataset.id); } };
  });
  body.querySelectorAll('[data-eq]').forEach(b => b.onclick = () => {
    if (equipSet(b.dataset.eq)){ sfx.select(); changed(); paint(); }
  });
  grow(body);
}

/* ---------- detail: this set against the bag ---------- */
function showDetail(id){ detail = id; paint(); }
function paintDetail(){
  const s = SET_BY_ID[detail], open = isUnlocked(s.id);
  const mine = bagSet();
  const cur = mine ? SET_BY_ID[mine].stats : bagStats(clubs.bag);
  const curName = mine ? SET_BY_ID[mine].name : 'your mixed bag';
  const same = mine === s.id;
  const rows = STAT_KEYS.map(k => {
    const a = s.stats[k], b = cur[k], d = a - b;
    return `<div class="cmp"><span class="cl">${STAT_NAMES[k]}</span>
      <div class="ctrack"><b data-w="${a}" style="background:${s.color}"></b><u style="left:${b}%" title="${esc(curName)}: ${b}"></u></div>
      <em>${a}</em><strong class="${same || !d ? '' : d > 0 ? 'up' : 'down'}">${same || !d ? '–' : (d > 0 ? '+' : '') + d}</strong></div>`;
  }).join('');
  let foot;
  if (!open){
    const pr = progress(s.id);
    foot = `<div class="dreq">${LOCK}<div><b>${esc(UNLOCKS[s.id].text)}</b><div class="cprog"><i data-w="${Math.round(pr.frac * 100)}"></i></div>
      <span>${esc(progressText(pr))}</span></div></div>`;
  } else {
    const [t, cls] = equipLabel(s.id);
    foot = `<div class="btns"><button class="btn ${cls === 'on' ? 'ghost' : 'primary'}" id="dEquip" ${cls === 'on' ? 'disabled' : ''}>${cls === 'on' ? 'Equipped' : 'Equip now'}</button></div>`;
  }
  $('shopBody').innerHTML = `<button class="dback" id="dBack">‹ All sets</button>
    <div class="dhead" style="--ac:${s.color}"><div><div class="ctop">${rarityTag(s)}${open ? '' : LOCK}</div><h3>${esc(s.name)}</h3>
      <p>${esc(s.desc)}</p></div></div>
    <ul class="dsum">${summarize(s.id).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="dcmp-h"><span>${same ? 'This is what you play' : `Against ${esc(curName)}`}</span>
      <span class="key"><i style="background:${s.color}"></i>${esc(s.name)}${same ? '' : `<u></u>${esc(curName)}`}</span></div>
    ${rows}${foot}`;
  $('dBack').onclick = () => { sfx.ui(); detail = null; paint(); };
  const eq = $('dEquip');
  if (eq) eq.onclick = () => { if (equipSet(s.id)){ sfx.select(); changed(); paint(); } };
  grow($('shopBody'));
}

/* ---------- my bag: one set per slot ---------- */
function paintBag(){
  const open = SETS.filter(s => isUnlocked(s.id));
  const avg = bagStats(clubs.bag);
  $('shopBody').innerHTML = `<p class="olnote">Mix and match: each part of the bag can come from a different set you have unlocked.
    Short-game shots use the wedges.</p>
    <div class="bag">${SLOTS.map(sl => {
      const id = clubs.bag[sl.id], st = slotStats(id, sl.id), set = SET_BY_ID[id];
      return `<div class="bslot" style="--ac:${set.color}"><div class="bn"><b>${sl.name}</b><span>${sl.id === 'PT' ? 'Putting' : sl.clubs.join(' · ')}</span></div>
        <select data-slot="${sl.id}" aria-label="${sl.name} set">${open.map(s => `<option value="${s.id}" ${s.id === id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <div class="bst">${STAT_KEYS.map(k => `<span>${SHORT[k]} <b>${st[k]}</b></span>`).join('')}</div></div>`;
    }).join('')}</div>
    <div class="dcmp-h"><span>Bag average</span></div>${bars(avg, '#ffcf4a')}
    ${open.length < 2 ? '<p class="olnote" style="margin-top:12px">Unlock more sets by winning rounds to start mixing.</p>' : ''}`;
  $('shopBody').querySelectorAll('select').forEach(sel => sel.onchange = () => {
    if (equipSlot(sel.dataset.slot, sel.value)){ sfx.tick(); changed(); paint(); }
  });
  grow($('shopBody'));
}

function paint(){
  $('shopSub').textContent = `${clubs.unlocked.length} of ${SETS.length} sets unlocked · playing ${bagName()}`;
  for (const b of $('shopTabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === tab);
  $('shopTabs').classList.toggle('hidden', !!detail);
  if (detail) paintDetail();
  else if (tab === 'bag') paintBag();
  else paintSets();
}

export function openShop(){
  tab = 'sets'; detail = null;
  paint();
  $('shopOv').classList.remove('hidden');
  $('shopBody').scrollTop = 0;
}
export function closeShop(){ $('shopOv').classList.add('hidden'); }

/* ---------- unlocked popup ---------- */
export function announceUnlocks(ids){
  queue.push(...ids);
  if ($('unlockOv').classList.contains('hidden')) nextUnlock();
}
function nextUnlock(){
  const id = queue.shift();
  if (!id){ $('unlockOv').classList.add('hidden'); return; }
  const s = SET_BY_ID[id];
  $('unlockBox').style.setProperty('--ac', s.color);
  $('unlockBox').innerHTML = `<div class="uglow"></div><div class="sub">Unlocked</div><h2>${esc(s.name)}</h2>
    <div class="ctop" style="justify-content:center">${rarityTag(s)}</div><p class="udesc">${esc(s.desc)}</p>
    ${bars(s.stats, s.color)}
    <div class="btns"><button class="btn ghost" id="uLater">${queue.length ? 'Next' : 'Later'}</button><button class="btn primary" id="uEquip">Equip now</button></div>`;
  $('unlockOv').classList.remove('hidden');
  sfx.fanfare(); sfx.crowd(0.8, 2.5);
  $('uEquip').onclick = () => { equipSet(id); sfx.select(); changed(); opts.toast(`${s.name} equipped`, 'every club in the bag'); nextUnlock(); };
  $('uLater').onclick = () => { sfx.ui(); nextUnlock(); };
  grow($('unlockBox'));
}

export function initShop(o){
  Object.assign(opts, o);
  document.body.insertAdjacentHTML('beforeend', `
<div class="overlay hidden" id="shopOv"><div class="panel shop">
  <div class="shophead"><div><h2>Club Shop</h2><div class="sub" id="shopSub"></div></div>
    <button class="ib" id="shopX" aria-label="Close" title="Close (Esc)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <div class="seg" id="shopTabs"><button data-tab="sets">CLUB SETS</button><button data-tab="bag">MY BAG</button></div>
  <div id="shopBody"></div>
</div></div>
<div class="overlay hidden" id="unlockOv"><div class="panel unlock" id="unlockBox"></div></div>`);
  $('shopX').onclick = () => { sfx.ui(); closeShop(); };
  $('shopTabs').querySelectorAll('button').forEach(b => b.onclick = () => { tab = b.dataset.tab; sfx.ui(); paint(); });
  // registered before the game's own key handler, so it can keep keys away from the game
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyU' && e.shiftKey && (e.ctrlKey || e.metaKey)){
      e.preventDefault(); e.stopImmediatePropagation();
      const added = unlockAll();
      opts.toast('Dev: all club sets unlocked', added.length ? `${added.length} new` : 'already open');
      if (!$('shopOv').classList.contains('hidden')) paint();
      changed();
      return;
    }
    if (!shopOpen()) return;
    if (e.target && e.target.tagName === 'SELECT') return;
    e.stopImmediatePropagation();
    if (e.code === 'Escape'){
      if (!$('unlockOv').classList.contains('hidden')) nextUnlock();
      else if (detail){ detail = null; paint(); }
      else closeShop();
    }
  });
}
