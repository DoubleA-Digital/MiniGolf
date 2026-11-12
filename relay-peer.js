/* ============================================================
   RELAY PEER — a stand-in for PeerJS that carries the same messages
   over Supabase Realtime instead of WebRTC.

   The PeerJS cloud broker is blocked on a lot of school and office
   networks, and even where it is reachable, WebRTC without a TURN server
   fails between many phones. Supabase is a plain websocket on 443 that
   the profile and leaderboard already depend on, so it gets through
   wherever the rest of the game does.

   It implements only the slice of the PeerJS API the two games use:
   new Peer([id]), on('open'|'error'|'connection'|'disconnected'),
   connect(id), reconnect(), destroy(); and on each connection
   on('open'|'data'|'close'|'error'), send(), close().

   A peer with an id (a host) owns the channel "pj:<id>". A guest joins
   that channel to talk to it. Every message names its sender and
   recipient; everyone else on the channel ignores it. Presence tells
   each side when the other's tab has gone, and lets a host see that
   its code is already in use.

   Setting a custom PeerServer (?peer=… or the saved mg_peer) keeps the
   real PeerJS, for anyone who runs their own.
   ============================================================ */
(function(){
  const SUPA_URL = 'https://esogrnjilzxcmvgpieib.supabase.co';
  const SUPA_KEY = 'sb_publishable__QUefxDt7tRi9Y943QK7yw_ivbRt71u';
  const ACK_MS = 6000;

  function customServer(){
    try{
      const q = new URLSearchParams(location.search).get('peer');
      if (q !== null) return q;
      return localStorage.getItem('mg_peer') || '';
    }catch(e){ return ''; }
  }

  let client = null;
  function sb(){
    if (!client) client = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 40 } }
    });
    return client;
  }

  const rid = () => Math.random().toString(36).slice(2, 12);

  class Emitter {
    constructor(){ this._h = {}; }
    on(ev, fn){ (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    off(ev){ delete this._h[ev]; return this; }
    _emit(ev, ...a){ for (const fn of (this._h[ev] || []).slice()){ try{ fn(...a); }catch(e){ console.error(e); } } }
  }

  // join a channel; resolves once subscribed and our presence is tracked
  function openChannel(name, me){
    return new Promise((resolve, reject) => {
      const ch = sb().channel(name, { config: { broadcast: { self: false }, presence: { key: me.key } } });
      let done = false;
      // never leave anyone stuck on "Connecting…"
      const guard = setTimeout(() => {
        if (done) return;
        done = true;
        try{ sb().removeChannel(ch); }catch(e){}
        reject({ type: 'network' });
      }, 10000);
      ch.subscribe(async status => {
        if (status === 'SUBSCRIBED' && !done){
          done = true; clearTimeout(guard);
          try{ await ch.track(me.meta); }catch(e){}
          resolve(ch);
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !done){
          done = true; clearTimeout(guard);
          try{ sb().removeChannel(ch); }catch(e){}
          reject({ type: 'network' });
        }
      });
    });
  }
  // everyone present on a channel, as a flat list of their tracked meta
  function present(ch){
    const out = [], st = ch.presenceState();
    for (const k in st) for (const m of st[k]) out.push({ key: k, ...m });
    return out;
  }

  class RelayConn extends Emitter {
    constructor(peer, remote, ch){
      super();
      this.peer = remote;            // PeerJS names the remote id .peer
      this._local = peer; this._ch = ch; this.open = false;
    }
    send(d){
      if (!this.open) return;
      this._ch.send({ type: 'broadcast', event: 'm', payload: { k: 'd', f: this._local.id, to: this.peer, d } });
    }
    close(){
      if (!this.open) return;
      try{ this._ch.send({ type: 'broadcast', event: 'm', payload: { k: 'fin', f: this._local.id, to: this.peer } }); }catch(e){}
      this._closed();
    }
    _opened(){ if (this.open) return; this.open = true; this._emit('open'); }
    _closed(){
      if (this._dead) return;
      this._dead = true; this.open = false;
      this._local._drop(this);
      this._emit('close');
    }
  }

  class RelayPeer extends Emitter {
    constructor(id, opts){
      super();
      if (typeof id !== 'string'){ opts = id; id = null; }
      this.id = id || ('g-' + rid());
      this._host = !!id;
      this._key = rid();             // this tab's presence key
      this._conns = [];              // live connections
      this._chans = [];              // channels we joined
      this.destroyed = false;
      setTimeout(() => this._start(), 0);
    }
    async _start(){
      if (!window.supabase || !window.supabase.createClient){ this._emit('error', { type: 'network' }); return; }
      try{
        const ch = await openChannel('pj:' + this.id, { key: this._key, meta: { id: this.id, host: this._host } });
        if (this.destroyed){ sb().removeChannel(ch); return; }
        this._own = ch;
        this._chans.push(ch);
        this._wire(ch, true);
        if (this._host){
          // let presence settle, then refuse a code someone else is already hosting
          await new Promise(r => setTimeout(r, 700));
          if (present(ch).some(p => p.host && p.key !== this._key)){
            this._emit('error', { type: 'unavailable-id' });
            this.destroy();
            return;
          }
        }
        this._emit('open', this.id);
      }catch(err){
        if (!this.destroyed) this._emit('error', err && err.type ? err : { type: 'network' });
      }
    }
    // route messages on a channel to our connections
    _wire(ch, own){
      ch.on('broadcast', { event: 'm' }, ({ payload: m }) => {
        if (!m || m.to !== this.id || this.destroyed) return;
        let c = this._conns.find(x => x.peer === m.f && x._ch === ch);
        if (m.k === 'syn'){
          if (!own || !this._host) return;
          if (!c){
            c = new RelayConn(this, m.f, ch);
            this._conns.push(c);
            this._emit('connection', c);
          }
          ch.send({ type: 'broadcast', event: 'm', payload: { k: 'ack', f: this.id, to: m.f } });
          setTimeout(() => c._opened(), 0);   // after the app has attached its handlers
        } else if (m.k === 'ack'){
          if (c){ clearTimeout(c._ackTimer); c._opened(); }
        } else if (m.k === 'd'){
          if (c && c.open) c._emit('data', m.d);
        } else if (m.k === 'fin'){
          if (c) c._closed();
        }
      });
      // a tab that vanishes without saying goodbye still drops out of presence
      ch.on('presence', { event: 'leave' }, ({ leftPresences }) => {
        for (const p of leftPresences || []){
          if (!p.id || p.id === this.id) continue;
          const still = present(ch).some(q => q.id === p.id);
          if (still) continue;
          for (const c of this._conns.slice()) if (c.peer === p.id && c._ch === ch) c._closed();
        }
      });
    }
    connect(remote){
      const conn = new RelayConn(this, remote, null);
      this._conns.push(conn);
      (async () => {
        try{
          const ch = await openChannel('pj:' + remote, { key: this._key, meta: { id: this.id, host: false } });
          if (this.destroyed || conn._dead){ sb().removeChannel(ch); return; }
          this._chans.push(ch);
          conn._ch = ch;
          this._wire(ch, false);
          conn._ackTimer = setTimeout(() => {
            if (conn.open || conn._dead) return;
            conn._dead = true;
            this._drop(conn);
            this._emit('error', { type: 'peer-unavailable' });
          }, ACK_MS);
          ch.send({ type: 'broadcast', event: 'm', payload: { k: 'syn', f: this.id, to: remote } });
        }catch(err){
          conn._dead = true;
          this._drop(conn);
          this._emit('error', err && err.type ? err : { type: 'network' });
        }
      })();
      return conn;
    }
    _drop(c){ this._conns = this._conns.filter(x => x !== c); }
    reconnect(){}                    // supabase-js reconnects its socket by itself
    disconnect(){ this.destroy(); }
    destroy(){
      if (this.destroyed) return;
      for (const c of this._conns.slice()){ try{ c.close(); }catch(e){} }
      this.destroyed = true;
      for (const ch of this._chans){ try{ ch.untrack(); }catch(e){} try{ sb().removeChannel(ch); }catch(e){} }
      this._chans = [];
    }
  }

  window.PeerJS = window.Peer;
  window.RelayPeer = RelayPeer;
  if (!customServer()) window.Peer = RelayPeer;
})();
