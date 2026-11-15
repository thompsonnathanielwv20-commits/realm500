// Realm500 game server
// Phase 1: one Durable Object ("Realm") per room keeps every player's live WebSocket,
// passes positions, chat and tribe commands between players instantly.
// Phase 2: the room also stores the surface map changes (trees cut, rocks mined,
// walls built) in its own SQLite table and sends them to everyone, so the world is shared.
// Phase 3: the room also stores shared world objects as small documents:
//   c:<key> chest contents, n:<key> trading counters, t:<key> tribe doors, d:<z>:<x>:<y>:<item> items on the ground
// Phase 4: accounts. One special room ("__accounts") keeps player names, salted password hashes,
// login tokens and each player's saved character, reached through /acct/register, /acct/login, /acct/save, /acct/load
// Phase 5a: shared bosses. The room keeps each boss's health ("pharaoh:17", "skking:9", "snake:6", ...).
// Phones report the damage they deal, the room subtracts it and tells everyone, and when health hits 0
// everyone in the fight gets the kill and the boss stays down for 30 minutes.
// Phase 5b: shared regular monsters. Where players are close together, the one with the lowest id runs the
// monsters ("host") and shares them; the others show the same monsters, send their hits to the host,
// and the host sends back the hits its monsters land on them. The room just passes these messages on.
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

// salted password hash (PBKDF2), so the server never stores a readable password
async function hashPass(pass, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 10000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class Realm extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // k = tile key (x * 500 + y), v = tile id that replaces the natural tile
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS tiles (k INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS docs (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }

  // ---------- accounts (only used by the "__accounts" room) ----------
  async acct(request, action) {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS accounts (name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, token TEXT NOT NULL, created INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS saves (name TEXT PRIMARY KEY, data TEXT NOT NULL, t INTEGER NOT NULL)');
    const reply = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } });
    if (request.method !== 'POST') return reply({ ok: false, err: 'Use POST' }, 405);
    const raw = await request.text();
    if (raw.length > 3000000) return reply({ ok: false, err: 'Save is too large' }, 413);
    let b;
    try { b = JSON.parse(raw); } catch (e) { return reply({ ok: false, err: 'Bad request' }, 400); }
    const name = String(b.name || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(name)) return reply({ ok: false, err: 'Names are 3-16 letters, numbers or _' });
    const row = sql.exec('SELECT name, salt, hash, token FROM accounts WHERE name = ?', name).toArray()[0];
    const saveRow = () => sql.exec('SELECT t, length(data) AS n FROM saves WHERE name = ?', name).toArray()[0];
    const newToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('');

    if (action === 'register' || action === 'login') {
      const pass = String(b.pass || '');
      if (pass.length < 6 || pass.length > 64) return reply({ ok: false, err: 'Passwords are 6-64 characters' });
      if (action === 'register') {
        if (row) return reply({ ok: false, err: 'That name is already taken' });
        const salt = newToken().slice(0, 32), hash = await hashPass(pass, salt), token = newToken();
        sql.exec('INSERT INTO accounts (name, salt, hash, token, created) VALUES (?, ?, ?, ?, ?)', name, salt, hash, token, Date.now());
        return reply({ ok: true, name, token, hasSave: false, savedAt: 0 });
      }
      if (!row || (await hashPass(pass, row.salt)) !== row.hash) return reply({ ok: false, err: 'Wrong name or password' });
      const token = newToken();
      sql.exec('UPDATE accounts SET token = ? WHERE name = ?', token, name);
      const sv = saveRow();
      return reply({ ok: true, name, token, hasSave: !!sv, savedAt: sv ? sv.t : 0 });
    }

    // save and load need the token from the last login
    if (!row || !b.token || String(b.token) !== row.token) return reply({ ok: false, err: 'Please log in again', relog: true });
    if (action === 'save') {
      const data = String(b.data || '');
      if (!data || data.length > 2500000) return reply({ ok: false, err: 'Save is empty or too large' });
      const t = Date.now();
      sql.exec('INSERT INTO saves (name, data, t) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data, t = excluded.t', name, data, t);
      return reply({ ok: true, t });
    }
    if (action === 'load') {
      const r = sql.exec('SELECT data, t FROM saves WHERE name = ?', name).toArray()[0];
      return reply(r ? { ok: true, data: r.data, t: r.t } : { ok: false, err: 'No saved character yet' });
    }
    return reply({ ok: false, err: 'Unknown action' }, 404);
  }

  // ---------- shared bosses ----------
  async bossLoad() {
    if (!this.bosses) this.bosses = (await this.ctx.storage.get('bosses')) || {};
    return this.bosses;
  }

  async bossDamage(ws, key, dmg, max) {
    if (!/^[a-z]{3,12}:-?\d{1,3}$/.test(key)) return;
    const B = await this.bossLoad(), now = Date.now(), me = ws.deserializeAttachment() || {};
    let b = B[key];
    if (b && b.until && now < b.until) return;
    max = Math.max(1, Math.min(10000000, Math.round(Number(max) || 1)));
    if (!b || (b.until && now >= b.until)) b = B[key] = { hp: max, max };
    b.hp -= Math.max(0, Math.min(1000000, Math.round(Number(dmg) || 0)));
    if (b.hp <= 0) {
      b.hp = 0; b.until = now + 1800000; b.by = String(me.name || 'someone').slice(0, 16);
      await this.ctx.storage.put('bosses', B);
      this.broadcast(null, { type: 'boss', key, hp: 0, max: b.max, until: b.until, by: b.by });
    } else {
      this.broadcast(null, { type: 'boss', key, hp: b.hp, max: b.max });
    }
  }

  allDocs() {
    const t = {};
    for (const r of this.ctx.storage.sql.exec('SELECT k, v FROM docs')) t[r.k] = r.v;
    return t;
  }

  // keeps only sensible documents: known kinds, short keys, values up to 4000 characters or null (= removed)
  cleanDocs(t) {
    const out = {};
    let n = 0;
    if (!t || typeof t !== 'object') return out;
    for (const k of Object.keys(t)) {
      if (n >= 500) break;
      if (k.length > 80 || !/^[cntd]:[-\w:~.]+$/.test(k)) continue;
      const v = t[k];
      if (v === null) { out[k] = null; n++; continue; }
      if (typeof v !== 'string' || v.length > 4000) continue;
      out[k] = v; n++;
    }
    return out;
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
    const path = new URL(request.url).pathname;
    if (path.startsWith('/acct/')) return this.acct(request, path.slice(6));
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
        this.send(ws, { type: 'docs', full: true, t: this.allDocs() });
        this.send(ws, { type: 'bosses', t: await this.bossLoad(), now: Date.now() });
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

    if (d.type === 'docs') {
      if (!ws.deserializeAttachment()) return;
      const t = this.cleanDocs(d.t);
      const ks = Object.keys(t);
      if (!ks.length) return;
      for (const k of ks) {
        if (t[k] === null) this.ctx.storage.sql.exec('DELETE FROM docs WHERE k = ?', k);
        else this.ctx.storage.sql.exec('INSERT INTO docs (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, t[k]);
      }
      this.broadcast(ws, { type: 'docs', t });
      return;
    }

    if (d.type === 'bdmg') {
      if (!ws.deserializeAttachment()) return;
      await this.bossDamage(ws, String(d.key || ''), d.dmg, d.max);
      return;
    }

    // the player whose phone runs a boss shares where it is, so everyone sees it in the same spot
    if (d.type === 'bpos') {
      if (!ws.deserializeAttachment() || !/^[a-z]{3,12}:-?\d{1,3}$/.test(String(d.key || ''))) return;
      this.broadcast(ws, { type: 'bpos', key: String(d.key), x: Number(d.x) || 0, y: Number(d.y) || 0 });
      return;
    }

    // mons = the host's monster list, mhit = a player's hit on a host monster, mhurt = a host monster's hit on a player
    if (d.type === 'mons' || d.type === 'mhit' || d.type === 'mhurt') {
      const me = ws.deserializeAttachment();
      if (!me) return;
      if (d.type === 'mons' && !Array.isArray(d.list)) return;
      if (d.type === 'mons' && d.list.length > 80) d.list = d.list.slice(0, 80);
      this.broadcast(ws, Object.assign({}, d, { from: me.id }));
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
    if (url.pathname.startsWith('/acct/')) {
      return env.REALM.get(env.REALM.idFromName('__accounts')).fetch(request);
    }
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
