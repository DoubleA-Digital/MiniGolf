/* ============================================================
   NET — online parties of 2 to 4 over PeerJS, in a star: the host owns
   the room code and relays everything a guest sends to the others.
   Every client builds the same holes from the shared seed and plays its
   own ball; the owner of a ball is the only authority on where it went.
   Same signalling setup (and saved custom server) as Mini Golf.
   ============================================================ */
export const MAX_PLAYERS = 4;
const PREFIX = 'tgolf-';
// WebRTC can take minutes to notice a closed tab, so everyone sends a
// heartbeat and anyone silent this long is treated as gone
const BEAT_MS = 3000, SILENT_MS = 25000;

function customPeerServer(){
  try{
    const q = new URLSearchParams(location.search).get('peer');
    if (q !== null){
      if (q) localStorage.setItem('mg_peer', q); else localStorage.removeItem('mg_peer');
      return q;
    }
    return localStorage.getItem('mg_peer') || '';
  }catch(e){ return ''; }
}
function peerOpts(){
  const raw = customPeerServer();
  if (!raw) return { debug: 0 };                       // PeerJS cloud
  const m = String(raw).trim().replace(/^https?:\/\//, '').match(/^([^:/]+)(?::(\d+))?(\/.*)?$/);
  if (!m) return { debug: 0 };
  const o = { debug: 0, host: m[1], secure: !/^(localhost|127\.)/.test(m[1]), path: m[3] || '/' };   // plain http only for local testing
  if (m[2]) o.port = +m[2];
  return o;
}

// A failure to join is not the same as a wrong code: don't send people retyping it.
export function peerError(err){
  const t = (err && err.type) || String((err && err.message) || err || '');
  if (t === 'peer-unavailable') return { kind: 'code', msg: 'No room with that code. Check it, or ask the host to open a new one.' };
  if (t === 'unavailable-id') return { kind: 'id', msg: 'That code is taken — trying another.' };
  if (t === 'full') return { kind: 'full', msg: 'That room is full (4 players).' };
  if (t === 'started') return { kind: 'full', msg: 'That round has already started.' };
  if (t === 'browser-incompatible') return { kind: 'browser', msg: 'This browser cannot make the connection this game needs.' };
  if (t === 'invalid-id' || t === 'invalid-key') return { kind: 'code', msg: 'That code is not valid.' };
  if (t === 'nopeer') return { kind: 'net', msg: 'The online library did not load. Check your connection and reload.' };
  return { kind: 'net', msg: 'Cannot reach the matchmaking server. This network may be blocking it — try mobile data or a hotspot.' };
}

const randCode = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
  let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
};
const newPid = () => Math.random().toString(36).slice(2, 10);

export const net = {
  online: false, isHost: false, code: null, myPid: newPid(),
  roster: [], started: false,
  peer: null, conns: [], host: null,
  handlers: {},                  // type -> fn(msg)
  onRoster: null, onGone: null,  // lobby repaint, connection lost

  on(type, fn){ this.handlers[type] = fn; },
  emit(m){ const fn = this.handlers[m.t]; if (fn) fn(m); },

  /* ---- host ---- */
  async host(me){
    if (typeof Peer !== 'function') throw { type: 'nopeer' };
    this.reset();
    this.online = true; this.isHost = true;
    this.roster = [{ ...me, pid: this.myPid }];
    for (let attempt = 0; attempt < 4; attempt++){
      const code = randCode();
      try{
        await new Promise((resolve, reject) => {
          const peer = new Peer(PREFIX + code, peerOpts());
          this.peer = peer;
          peer.on('open', () => resolve());
          peer.on('error', err => reject(err));
          peer.on('connection', conn => this.accept(conn));
        });
        this.code = code;
        this.beat();
        // after opening, a dropped signalling link must not kill the room
        this.peer.on('error', () => {});
        this.peer.on('disconnected', () => { try{ this.peer.reconnect(); }catch(e){} });
        return code;
      }catch(err){
        try{ this.peer && this.peer.destroy(); }catch(e){}
        this.peer = null;
        if (peerError(err).kind !== 'id') throw err;
      }
    }
    throw { type: 'unavailable-id' };
  },
  accept(conn){
    conn.on('open', () => {
      if (this.started){ try{ conn.send({ t: 'refuse', why: 'started' }); }catch(e){} setTimeout(() => conn.close(), 300); return; }
      if (this.roster.length >= MAX_PLAYERS){ try{ conn.send({ t: 'refuse', why: 'full' }); }catch(e){} setTimeout(() => conn.close(), 300); return; }
      conn.seen = Date.now();
      this.conns.push(conn);
      conn.on('data', m => this.fromGuest(conn, m));
      conn.on('close', () => this.guestLeft(conn));
      conn.on('error', () => this.guestLeft(conn));
    });
  },
  fromGuest(conn, m){
    conn.seen = Date.now();
    if (!m || !m.t || m.t === 'hb') return;
    if (m.t === 'hello'){
      conn.pid = m.pid;
      if (!this.roster.some(r => r.pid === m.pid) && this.roster.length < MAX_PLAYERS)
        this.roster.push({ pid: m.pid, name: String(m.name || 'Player').slice(0, 16), avatar: m.avatar, avatarImg: m.avatarImg });
      this.broadcast({ t: 'roster', roster: this.roster });
      if (this.onRoster) this.onRoster();
      return;
    }
    m.pid = conn.pid;              // a guest can only speak for itself
    this.relay(conn, m);
    this.emit(m);
  },
  relay(from, m){
    for (const c of this.conns) if (c !== from){ try{ c.send(m); }catch(e){} }
  },
  guestLeft(conn){
    if (!this.conns.includes(conn)) return;
    this.conns = this.conns.filter(c => c !== conn);
    if (!conn.pid) return;
    this.roster = this.roster.filter(r => r.pid !== conn.pid);
    const m = { t: 'left', pid: conn.pid, roster: this.roster };
    this.broadcast(m);
    this.emit(m);
    if (this.onRoster) this.onRoster();
  },

  /* ---- guest ---- */
  join(code, me){
    if (typeof Peer !== 'function') return Promise.reject({ type: 'nopeer' });
    this.reset();
    this.online = true; this.isHost = false;
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerOpts());
      this.peer = peer;
      let settled = false;
      const fail = err => { if (settled) return; settled = true; clearTimeout(timer); reject(err); };
      const timer = setTimeout(() => fail(new Error('timeout')), 15000);
      peer.on('error', fail);
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true });
        this.host = conn;
        conn.on('open', () => {
          this.code = code;
          conn.send({ t: 'hello', pid: this.myPid, name: me.name, avatar: me.avatar, avatarImg: me.avatarImg });
          this.hostSeen = Date.now();
          this.beat();
        });
        conn.on('data', m => {
          this.hostSeen = Date.now();
          if (!m || !m.t || m.t === 'hb') return;
          if (m.t === 'refuse'){ fail({ type: m.why }); return; }
          if (m.t === 'roster'){
            this.roster = m.roster || [];
            if (!settled){ settled = true; clearTimeout(timer); resolve(); }
            if (this.onRoster) this.onRoster();
            return;
          }
          this.emit(m);
        });
        // only the live session may end things: a stale conn closing after reset() must not kill a newer room
        conn.on('close', () => { if (!settled) fail({ type: 'peer-unavailable' }); else if (this.host === conn) this.lost(); });
        conn.on('error', err => { if (!settled) fail(err); });
      });
    });
  },
  lost(){
    if (!this.online) return;
    const was = this.online;
    this.reset();
    if (was && this.onGone) this.onGone();
  },

  /* ---- both ---- */
  beat(){
    this.stopBeat();
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      // our own clock stalled (throttled tab, long frame): nobody else was silent, we were asleep
      if (now - last > BEAT_MS * 3){
        for (const c of this.conns) c.seen = now;
        this.hostSeen = now;
      }
      last = now;
      if (this.isHost){
        for (const c of this.conns.slice()){
          if (now - c.seen > SILENT_MS){ this.guestLeft(c); try{ c.close(); }catch(e){} }
          else { try{ c.send({ t: 'hb' }); }catch(e){} }
        }
      } else if (this.host){
        if (now - this.hostSeen > SILENT_MS){ this.lost(); return; }
        try{ this.host.send({ t: 'hb' }); }catch(e){}
      }
    };
    // background tabs throttle main-thread timers to ~1/min, which starves the heartbeat;
    // a worker's timer keeps running, so drive the beat from one when we can
    try{
      const src = `setInterval(() => postMessage(0), ${BEAT_MS});`;
      this.beatWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.beatWorker.onmessage = tick;
    }catch(e){
      this.beatWorker = null;
      this.beatTimer = setInterval(tick, BEAT_MS);
    }
  },
  stopBeat(){
    clearInterval(this.beatTimer);
    if (this.beatWorker){ try{ this.beatWorker.terminate(); }catch(e){} this.beatWorker = null; }
  },
  // host fans out; a guest sends up to the host, which relays
  broadcast(m){
    if (this.isHost){ for (const c of this.conns){ try{ c.send(m); }catch(e){} } }
    else if (this.host){ try{ this.host.send(m); }catch(e){} }
  },
  send(m){ m.pid = m.pid || this.myPid; this.broadcast(m); },

  reset(){
    this.stopBeat();
    try{ this.peer && this.peer.destroy(); }catch(e){}
    this.peer = null; this.conns = []; this.host = null;
    this.online = false; this.isHost = false; this.code = null; this.started = false; this.roster = [];
  },
  leave(){ this.reset(); }
};

// closing the tab says goodbye at once instead of waiting out the heartbeat
window.addEventListener('pagehide', () => { if (net.online) net.leave(); });
