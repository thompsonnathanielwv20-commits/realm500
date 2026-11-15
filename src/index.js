// Realm500 game server
// Phase 1: one Durable Object ("Realm") per room keeps every player's live WebSocket,
// passes positions, chat and tribe commands between players instantly.
// Phase 2: the room also stores the surface map changes (trees cut, rocks mined,
// walls built) in its own SQLite table and sends them to everyone, so the world is shared.
import { DurableObject } from 'cloudflare:workers';

const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// keeps only the fields the game uses, so a modified phone can't send junk
const cleanPlayer = (m) => ({
  id: str(m.id, 24).replace(/[^a-z0-9]/gi, ''),
  name: str(m.name || 'Player', 16),
  z: num(m.z), x: num(m.x), y: num(m.y), dx: num(m.dx), dy: num(m.dy),
  hp: num(m.hp), mh: num(m.mh), sp: str(m.sp, 80),
  tr: str(m.tr, 40), rk: num(m.rk), rn: str(m.rn, 16), trk: str(m.trk, 600),
});
const cleanMsg = (m) => ({
  k: str(m.k, 40), t: str(m.t, 120), at: num(m.at),
  c: str(m.c || 'g', 1), tr: str(m.tr, 40), to: str(m.to, 16),
  a: str(m.a, 5), r: num(m.r), tn: str(m.tn, 20), rn: str(m.rn, 16),
});

export class Realm extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // k = tile key (x * 500 + y), v = tile id that replaces the natural tile
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS tiles (k INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
  }

  allTiles() {
    const t = {};
    for (const r of this.ctx.storage.sql.exec('SELECT k, v FROM tiles')) t[r.k] = r.v;
    return t;
  }

  // keeps only sensible tile changes: integer keys, tile ids 0-255 or null (= back to natural)
  cleanTiles(t) {
    const out = {};
    let n = 0;
    if (!t || typeof t !== 'object') return out;
    for (const ks of Object.keys(t)) {
      if (n >= 3000) break;
      const k = Number(ks), v = t[ks];
      if (!Number.isInteger(k) || k < -2000000 || k > 2000000) continue;
      if (v === null) { out[k] = null; n++; continue; }
      if (!Number.isInteger(v) || v < 0 || v > 255) continue;
      out[k] = v; n++;
    }
    return out;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // hibernation-friendly: the object can sleep between messages without dropping players
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  players(except) {
    const out = [];
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      const a = w.deserializeAttachment();
      if (a && a.id) out.push(a);
    }
    return out;
  }

  // ---- Echo Bot: a test player for when you only have one phone ----
  // type !bot in chat to summon it next to you, !bot off to send it away.
  // It walks in a little square and repeats what people say. Leaves after 3 minutes.
  botPlayer(b) {
    const path = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
    const p = path[b.step % path.length];
    const q = path[(b.step + path.length - 1) % path.length];
    return { id: 'echobot', name: 'Echo Bot', z: b.z, x: b.x + p[0], y: b.y + p[1], dx: Math.sign(p[0] - q[0]), dy: Math.sign(p[1] - q[1]), hp: 100, mh: 100, sp: b.sp || '', tr: '', rk: 0, rn: '', trk: '' };
  }

  async botStart(me) {
    const b = { z: me.z, x: me.x + 2, y: me.y, step: 0, until: Date.now() + 180000, sp: 'Hi ' + me.name + '! Say something and I will repeat it' };
    await this.ctx.storage.put('bot', b);
    this.broadcast(null, { type: 'state', p: this.botPlayer(b) });
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async botStop() {
    await this.ctx.storage.delete('bot');
    this.broadcast(null, { type: 'leave', id: 'echobot' });
  }

  async alarm() {
    const b = await this.ctx.storage.get('bot');
    if (!b) return;
    if (Date.now() > b.until || this.ctx.getWebSockets().length === 0) { await this.botStop(); return; }
    b.step++;
    if (b.step % 6 === 0) b.sp = '';
    await this.ctx.storage.put('bot', b);
    this.broadcast(null, { type: 'state', p: this.botPlayer(b) });
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket already gone */ }
  }

  broadcast(from, obj) {
    const s = JSON.stringify(obj);
    for (const w of this.ctx.getWebSockets()) {
      if (w === from) continue;
      try { w.send(s); } catch (e) { /* skip dead sockets */ }
    }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 400000) return;
    let d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || typeof d !== 'object') return;

    if (d.type === 'hello' || d.type === 'state') {
      const me = cleanPlayer(d.me || {});
      if (!me.id) return;
      const first = !ws.deserializeAttachment();
      ws.serializeAttachment(me);
      if (first) {
        const list = this.players(ws);
        const b = await this.ctx.storage.get('bot');
        if (b) list.push(this.botPlayer(b));
        this.send(ws, { type: 'welcome', players: list, t: Date.now() });
        this.send(ws, { type: 'tiles', full: true, t: this.allTiles() });
      }
      this.broadcast(ws, { type: 'state', p: me });
      return;
    }

    if (d.type === 'chat') {
      const me = ws.deserializeAttachment();
      if (!me) return;
      const m = cleanMsg(d.m || {});
      // stamp who sent it and where they were, so phones can filter Local and Tribe chat
      const cmd = m.t.trim().toLowerCase();
      if (cmd === '!bot') { await this.botStart(me); return; }
      if (cmd === '!bot off') { await this.botStop(); return; }
      this.broadcast(ws, { type: 'chat', from: me.id, n: me.name, z: me.z, x: me.x, y: me.y, ptr: me.tr, prk: me.rk, m });
      const b = await this.ctx.storage.get('bot');
      if (b && m.c !== 'x' && m.c !== 't' && m.t) {
        const bp = this.botPlayer(b);
        b.sp = 'Echo: ' + m.t.slice(0, 60);
        await this.ctx.storage.put('bot', b);
        this.broadcast(null, { type: 'chat', from: 'echobot', n: 'Echo Bot', z: bp.z, x: bp.x, y: bp.y, ptr: '', prk: 0, m: { k: 'echo-' + Date.now().toString(36), t: 'Echo: ' + m.t, at: Date.now(), c: m.c === 'l' ? 'l' : 'g', tr: '', to: '', a: '', r: 0, tn: '', rn: '' } });
      }
      return;
    }

    if (d.type === 'tiles') {
      if (!ws.deserializeAttachment()) return;
      const t = this.cleanTiles(d.t);
      const ks = Object.keys(t);
      if (!ks.length) return;
      for (const k of ks) {
        if (t[k] === null) this.ctx.storage.sql.exec('DELETE FROM tiles WHERE k = ?', Number(k));
        else this.ctx.storage.sql.exec('INSERT INTO tiles (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', Number(k), t[k]);
      }
      this.broadcast(ws, { type: 'tiles', t });
      return;
    }

    if (d.type === 'ping') this.send(ws, { type: 'pong', t: Date.now() });
  }

  async webSocketClose(ws, code) {
    const a = ws.deserializeAttachment();
    if (a && a.id) this.broadcast(ws, { type: 'leave', id: a.id });
    try { ws.close(code || 1000, 'bye'); } catch (e) { /* already closed */ }
  }

  async webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.id) this.broadcast(ws, { type: 'leave', id: a.id });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const room = str(url.searchParams.get('room') || 'world', 20).toLowerCase();
      const stub = env.REALM.get(env.REALM.idFromName(room));
      return stub.fetch(request);
    }
    return new Response('Realm500 server is running. Connect the game to /ws?room=world', {
      headers: { 'content-type': 'text/plain' },
    });
  },
};
