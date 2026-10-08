// Réseau sans serveur de jeu. Topologie en étoile : l'hôte relaie les messages.
//
// 1) Connexion directe WebRTC entre navigateurs (PeerJS sert seulement d'annuaire).
// 2) Si la connexion directe échoue (pare-feu, 4G, réseau d'entreprise…), repli
//    automatique sur un relais public MQTT (broker gratuit, sans inscription).
import { PEER_PREFIX } from './constants.js';
import { randomCode } from './rng.js';

const RELAY_DELAY = 5000;    // ms avant d'essayer le relais si la connexion directe tarde
const JOIN_TIMEOUT = 24000;  // ms max pour rejoindre un salon
const TOPIC = 'chiboukgolf/v1/';

const DEFAULT_BROKERS = [
  'wss://test.mosquitto.org:8081',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

// Messages qu'on peut perdre sans souci (envoyés en continu)
const UNRELIABLE = new Set(['pos', 'ping', 'pong']);

// Fiabilité au-dessus du relais (les brokers publics peuvent perdre des messages) :
// numéro de séquence, accusé de réception cumulatif et renvoi automatique.
class RelLink {
  constructor(sendRaw) {
    this.sendRaw = sendRaw;
    this.next = 1;
    this.pending = new Map();
    this.expect = 1;
    this.buf = new Map();
  }

  send(msg) {
    if (UNRELIABLE.has(msg.t)) { this.sendRaw({ m: msg }); return; }
    const s = this.next++;
    const item = { obj: { s, m: msg }, t: performance.now() };
    this.pending.set(s, item);
    this.sendRaw(item.obj);
  }

  // renvoie les messages à traiter, dans l'ordre
  receive(o) {
    if (typeof o.a === 'number') {
      for (const s of [...this.pending.keys()]) if (s <= o.a) this.pending.delete(s);
      return [];
    }
    if (typeof o.s !== 'number') return o.m ? [o.m] : [];
    const out = [];
    if (o.s >= this.expect) this.buf.set(o.s, o.m);
    while (this.buf.has(this.expect)) {
      out.push(this.buf.get(this.expect));
      this.buf.delete(this.expect);
      this.expect++;
    }
    this.sendRaw({ a: this.expect - 1 });
    return out;
  }

  tick(now) {
    for (const it of this.pending.values()) {
      if (now - it.t > 900) { it.t = now; this.sendRaw(it.obj); }
    }
  }
}

const params = () => new URLSearchParams(location.search);
const LOSS = +(params().get('relayloss') || 0);

function brokers() {
  const q = params().get('mqtt');
  return q ? q.split(',').filter(Boolean) : DEFAULT_BROKERS;
}

// 'rtc' = direct seulement, 'relay' = relais seulement, sinon les deux
const transportMode = () => params().get('transport') || 'auto';

function peerOptions() {
  const q = params();
  const opts = {
    debug: +(q.get('peerdebug') || 0),
    config: {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
    },
  };
  if (q.get('peerhost')) {
    opts.host = q.get('peerhost');
    opts.port = +(q.get('peerport') || 9000);
    opts.path = q.get('peerpath') || '/';
    opts.secure = q.get('peersecure') === '1';
  }
  return opts;
}

function randomId(n = 12) {
  const a = 'abcdefghijkmnopqrstuvwxyz23456789';
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < n; i++) s += a[buf[i] % a.length];
  return s;
}

const ERRORS = {
  'browser-incompatible': 'Ton navigateur ne gère pas WebRTC.',
  'network': 'Impossible de joindre le service de mise en relation.',
  'server-error': 'Le service de mise en relation ne répond pas.',
  'socket-error': 'Connexion au service de mise en relation perdue.',
  'socket-closed': 'Connexion au service de mise en relation fermée.',
  'peer-unavailable': 'Salon introuvable. Vérifie le code.',
  'unavailable-id': 'Ce code de salon est déjà pris.',
  'webrtc': 'La connexion directe entre joueurs a échoué.',
};
export const errorText = (err) => ERRORS[err?.type] || err?.message || 'Erreur réseau.';

// ---------------------------------------------------------------------------
// Client MQTT minimal (3.1.1, QoS 0) sur WebSocket
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();

function mqStr(s) {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8; out[1] = b.length & 255;
  out.set(b, 2);
  return out;
}

function mqPacket(head, ...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const lb = [];
  let x = len;
  do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 128; lb.push(d); } while (x > 0);
  const out = new Uint8Array(1 + lb.length + len);
  out[0] = head;
  out.set(lb, 1);
  let o = 1 + lb.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export class MiniMqtt {
  constructor(url) {
    this.url = url;
    this.buf = new Uint8Array(0);
    this.pid = 1;
    this.connected = false;
    this.onMessage = null;
    this.onClose = null;
  }

  connect(clientId, timeout = 6000) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url, 'mqtt'); } catch (e) { reject(e); return; }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        if (err) { try { ws.close(); } catch (e) { /* rien */ } reject(err); } else resolve(this);
      };
      const to = setTimeout(() => done(new Error('délai dépassé')), timeout);
      ws.onopen = () => {
        // CONNECT : protocole MQTT 3.1.1, session propre, keepalive 30 s
        ws.send(mqPacket(0x10, new Uint8Array([0, 4, 77, 81, 84, 84, 4, 0x02, 0, 30]), mqStr(clientId)));
      };
      ws.onmessage = (ev) => this._data(new Uint8Array(ev.data), done);
      ws.onerror = () => done(new Error('relais injoignable'));
      ws.onclose = () => {
        clearInterval(this.ka);
        const was = this.connected;
        this.connected = false;
        done(new Error('relais fermé'));
        if (was && this.onClose) this.onClose();
      };
    });
  }

  _data(chunk, done) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf); b.set(chunk, this.buf.length);
    this.buf = b;
    for (;;) {
      if (this.buf.length < 2) return;
      let mult = 1, len = 0, i = 1, byte;
      do {
        if (i >= this.buf.length) return;
        byte = this.buf[i++];
        len += (byte & 127) * mult;
        mult *= 128;
      } while (byte & 128);
      if (this.buf.length < i + len) return;
      const head = this.buf[0];
      const body = this.buf.slice(i, i + len);
      this.buf = this.buf.slice(i + len);
      const type = head >> 4;
      if (type === 2) { // CONNACK
        if (body[1] === 0) {
          this.connected = true;
          this.ka = setInterval(() => this._send(new Uint8Array([0xc0, 0])), 20000);
          done(null);
        } else done(new Error('relais refusé'));
      } else if (type === 3) { // PUBLISH
        const qos = (head >> 1) & 3;
        const tl = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tl));
        const off = 2 + tl + (qos ? 2 : 0);
        if (this.onMessage) {
          try { this.onMessage(topic, dec.decode(body.subarray(off))); } catch (e) { console.warn('relais', e); }
        }
      }
    }
  }

  _send(bytes) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
  }

  subscribe(topic) {
    const id = this.pid++ & 0xffff || 1;
    this._send(mqPacket(0x82, new Uint8Array([id >> 8, id & 255]), mqStr(topic), new Uint8Array([0])));
  }

  publish(topic, text) {
    if (!this.connected) return false;
    if (LOSS && Math.random() < LOSS) return true; // test : simulation de pertes (?relayloss=0.3)
    this._send(mqPacket(0x30, mqStr(topic), enc.encode(text)));
    return true;
  }

  close() {
    clearInterval(this.ka);
    this.onClose = null;
    try { this._send(new Uint8Array([0xe0, 0])); } catch (e) { /* rien */ }
    try { this.ws && this.ws.close(); } catch (e) { /* rien */ }
    this.connected = false;
  }
}

// ---------------------------------------------------------------------------
// Hôte
// ---------------------------------------------------------------------------
const toCid = (peerId) => (peerId.startsWith(PEER_PREFIX + 'c-') ? peerId.slice(PEER_PREFIX.length + 2) : peerId);

export class HostNet {
  constructor(handlers) {
    this.h = handlers; // { onMessage(msg, id), onJoin(id), onLeave(id), onError(err) }
    this.routes = new Map();
    this.dropped = new Set(); // joueurs partis : on ignore leurs messages tardifs
    this.relays = [];
    this.peer = null;
    this.code = null;
    this.closed = false;
  }

  // Résout avec le code du salon dès qu'au moins un canal (direct ou relais) est prêt
  async start() {
    const mode = transportMode();
    this.code = randomCode(5);
    const relayReady = mode === 'rtc' ? Promise.reject(new Error('relais désactivé')) : this._startRelays();
    relayReady.catch(() => {});
    if (mode === 'relay') { await relayReady; this._startPing(); return this.code; }
    try {
      await this._startPeer();
    } catch (err) {
      // pas d'annuaire PeerJS : on continue en relais seul si possible
      try { await relayReady; } catch (e) { throw err; }
      console.warn('PeerJS indisponible, relais seul', err);
    }
    this._startPing();
    return this.code;
  }

  _startPeer() {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const peer = new window.Peer(PEER_PREFIX + this.code, peerOptions());
        let opened = false;
        const to = setTimeout(() => { if (!opened) { peer.destroy(); reject({ type: 'network' }); } }, 10000);
        peer.on('open', () => {
          opened = true;
          clearTimeout(to);
          this.peer = peer;
          this._setupPeer(peer);
          resolve();
        });
        peer.on('error', (err) => {
          if (!opened) {
            clearTimeout(to);
            peer.destroy();
            if (err.type === 'unavailable-id' && tries++ < 4) {
              this.code = randomCode(5);
              this._resubscribe();
              attempt();
            } else reject(err);
          } else if (err.type !== 'peer-unavailable' && this.h.onError) this.h.onError(err);
        });
      };
      attempt();
    });
  }

  _setupPeer(peer) {
    peer.on('connection', (conn) => {
      const cid = toCid(conn.peer);
      if (this.dropped.has(cid)) { try { conn.close(); } catch (e) { /* rien */ } return; }
      const r = this._route(cid);
      if (r.rtc && r.rtc !== conn) { try { r.rtc.close(); } catch (e) { /* rien */ } }
      r.rtc = conn;
      conn.on('open', () => { r.lastSeen = performance.now(); });
      conn.on('data', (msg) => { if (r.rtc === conn) this._recv(cid, msg); });
      const gone = () => {
        if (r.rtc !== conn) return;
        r.rtc = null;
        if (!r.relay) this._drop(cid);
      };
      conn.on('close', gone);
      conn.on('error', gone);
    });
    peer.on('disconnected', () => {
      // perte de l'annuaire : les connexions établies continuent
      if (!peer.destroyed && !this.closed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* rien */ } }, 1500);
    });
  }

  _startRelays() {
    const urls = brokers();
    return new Promise((resolve, reject) => {
      let failed = 0;
      for (const url of urls) {
        const relay = { url, mq: null };
        this.relays.push(relay);
        const connect = (first) => {
          if (this.closed) return;
          const mq = new MiniMqtt(url);
          mq.connect('cgh' + randomId(11)).then(() => {
            if (this.closed) { mq.close(); return; }
            relay.mq = mq;
            mq.subscribe(TOPIC + this.code + '/h');
            mq.onMessage = (topic, text) => this._relayIn(relay, text);
            mq.onClose = () => { relay.mq = null; setTimeout(() => connect(false), 2000); };
            resolve();
          }).catch(() => {
            if (first && ++failed === urls.length) reject(new Error('Aucun relais joignable.'));
            setTimeout(() => connect(false), first ? 15000 : 5000);
          });
        };
        connect(true);
      }
    });
  }

  _resubscribe() {
    for (const r of this.relays) if (r.mq) r.mq.subscribe(TOPIC + this.code + '/h');
  }

  _relayIn(relay, text) {
    let o;
    try { o = JSON.parse(text); } catch (e) { return; }
    if (!o || typeof o.f !== 'string' || this.dropped.has(o.f)) return;
    const r = this._route(o.f);
    // On répond par le relais qu'utilise le joueur. Les « hello » répétés avant son choix
    // arrivent parfois par d'autres relais : ils ne changent pas le chemin déjà établi.
    const isHello = typeof o.s !== 'number' && o.m && o.m.t === 'hello';
    if (!r.relay || !isHello) r.relay = relay;
    r.lastSeen = performance.now(); // tout message (même un accusé) prouve que le joueur est là
    if (!r.link) {
      r.link = new RelLink((obj) => {
        if (r.relay && r.relay.mq) r.relay.mq.publish(TOPIC + this.code + '/c/' + r.cid, JSON.stringify(obj));
      });
    }
    for (const m of r.link.receive(o)) this._recv(o.f, m);
  }

  _route(cid) {
    let r = this.routes.get(cid);
    if (!r) {
      r = { cid, rtc: null, relay: null, lastSeen: performance.now(), known: false };
      this.routes.set(cid, r);
    }
    return r;
  }

  _recv(cid, msg) {
    const r = this._route(cid);
    r.lastSeen = performance.now();
    if (!msg || typeof msg !== 'object') return;
    if (!r.known) { r.known = true; this.h.onJoin(cid); }
    if (msg.t === 'pong') return;
    this.h.onMessage(msg, cid);
  }

  _startPing() {
    clearInterval(this.pingTimer);
    clearInterval(this.linkTimer);
    this.linkTimer = setInterval(() => {
      const now = performance.now();
      for (const r of this.routes.values()) if (r.link && !(r.rtc && r.rtc.open)) r.link.tick(now);
    }, 300);
    this.pingTimer = setInterval(() => {
      const now = performance.now();
      for (const [cid, r] of this.routes) {
        if (now - r.lastSeen > (r.known ? 12000 : 25000)) { this._drop(cid); continue; }
        if (r.known) this.sendTo(cid, { t: 'ping' });
      }
    }, 2000);
  }

  _drop(cid) {
    const r = this.routes.get(cid);
    if (!r) return;
    this.routes.delete(cid);
    if (r.known) this.dropped.add(cid);
    if (r.rtc) { try { r.rtc.close(); } catch (e) { /* rien */ } }
    if (r.known) this.h.onLeave(cid);
  }

  routeKind(cid) {
    const r = this.routes.get(cid);
    if (!r) return null;
    return r.rtc && r.rtc.open ? 'rtc' : r.relay ? 'relay' : null;
  }

  kick(cid, msg) {
    this.sendTo(cid, msg);
    setTimeout(() => this._drop(cid), 300);
  }

  sendTo(cid, msg) {
    const r = this.routes.get(cid);
    if (!r) return;
    if (r.rtc && r.rtc.open) {
      try { r.rtc.send(msg); } catch (e) { /* rien */ }
    } else if (r.link) {
      r.link.send(msg);
    }
  }

  broadcast(msg, except = null) {
    const lossy = UNRELIABLE.has(msg.t);
    const viaRelay = new Set();
    for (const [cid, r] of this.routes) {
      if (!r.known || cid === except) continue;
      if (r.rtc && r.rtc.open) { try { r.rtc.send(msg); } catch (e) { /* rien */ } }
      else if (r.link && r.relay && r.relay.mq) {
        // positions : un seul envoi par relais ; le reste : envoi fiable à chacun
        if (lossy) viaRelay.add(r.relay.mq);
        else r.link.send(msg);
      }
    }
    if (viaRelay.size) {
      const text = JSON.stringify({ m: msg });
      for (const mq of viaRelay) mq.publish(TOPIC + this.code + '/b', text);
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearInterval(this.linkTimer);
    for (const r of this.routes.values()) if (r.rtc) { try { r.rtc.close(); } catch (e) { /* rien */ } }
    this.routes.clear();
    for (const r of this.relays) if (r.mq) r.mq.close();
    this.relays = [];
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* rien */ } }
    this.peer = null;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export class ClientNet {
  constructor(handlers) {
    this.h = handlers; // { onMessage(msg), onClose(reason), onStatus(text) }
    this.cid = randomId(12);
    this.peer = null;
    this.conn = null;
    this.relays = [];
    this.chosen = null;   // { kind: 'rtc' } ou { kind: 'relay', mq }
    this.closed = false;
    // lien fiable unique (les accusés partent par le relais qui a apporté le message)
    this.link = new RelLink((obj) => {
      const mq = (this.chosen && this.chosen.mq) || this._ackMq;
      if (mq && mq.connected) mq.publish(TOPIC + this.code + '/h', JSON.stringify({ f: this.cid, ...obj }));
    });
    this.diag = { peerOpen: false, peerUnavailable: false, rtcOpen: false, relayUp: 0, relayTried: false };
  }

  get kind() { return this.chosen ? this.chosen.kind : null; }

  // Résout quand l'hôte a répondu (message « welcome »)
  join(code, hello) {
    this.code = code.toUpperCase();
    this.hello = hello;
    const mode = transportMode();
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      if (mode !== 'relay') this._startRtc();
      if (mode !== 'rtc') {
        this.relayTimer = setTimeout(() => {
          if (!this.chosen) {
            if (mode !== 'relay' && this.h.onStatus) this.h.onStatus('Connexion directe difficile, passage par le relais…');
            this._startRelays();
          }
        }, mode === 'relay' ? 0 : RELAY_DELAY);
      }
      this.helloTimer = setInterval(() => this._sendHello(), 1500);
      this.linkTimer = setInterval(() => {
        if (this.chosen && this.chosen.kind === 'relay') this.link.tick(performance.now());
      }, 300);
      this.failTimer = setTimeout(() => this._fail(), JOIN_TIMEOUT);
    });
  }

  _sendHello() {
    if (this.chosen || this.closed) return;
    if (this.conn && this.conn.open) { try { this.conn.send(this.hello); } catch (e) { /* rien */ } }
    for (const mq of this.relays) if (mq.connected) mq.publish(TOPIC + this.code + '/h', JSON.stringify({ f: this.cid, m: this.hello }));
  }

  _startRtc() {
    let peer;
    try { peer = new window.Peer(PEER_PREFIX + 'c-' + this.cid, peerOptions()); } catch (e) { return; }
    this.peer = peer;
    peer.on('open', () => {
      this.diag.peerOpen = true;
      const conn = peer.connect(PEER_PREFIX + this.code, { reliable: true });
      this.conn = conn;
      conn.on('open', () => { this.diag.rtcOpen = true; this._sendHello(); });
      conn.on('data', (msg) => this._in('rtc', null, msg));
      const gone = () => {
        if (this.chosen && this.chosen.kind === 'rtc') this._lost('Connexion à l\'hôte perdue.');
      };
      conn.on('close', gone);
      conn.on('error', gone);
    });
    peer.on('error', (err) => {
      const dead = ['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible', 'unavailable-id'];
      if (!this.chosen && dead.includes(err.type) && transportMode() !== 'rtc') {
        // annuaire PeerJS injoignable : relais tout de suite
        clearTimeout(this.relayTimer);
        this._startRelays();
        try { peer.destroy(); } catch (e) { /* rien */ }
        return;
      }
      if (err.type === 'peer-unavailable') {
        this.diag.peerUnavailable = true;
        // salon absent de l'annuaire : on laisse quelques secondes au relais, puis on abandonne
        clearTimeout(this.failTimer);
        this.failTimer = setTimeout(() => this._fail(), 5000);
        // l'hôte n'est pas dans l'annuaire : on tente tout de suite le relais
        if (!this.chosen && transportMode() !== 'rtc' && !this.diag.relayTried) { clearTimeout(this.relayTimer); this._startRelays(); }
      } else if (this.chosen && this.chosen.kind === 'rtc' && (err.type === 'network' || err.type === 'webrtc')) {
        this._lost('Connexion à l\'hôte perdue.');
      }
    });
    peer.on('disconnected', () => {
      if (!peer.destroyed && !this.closed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* rien */ } }, 1500);
    });
  }

  _startRelays() {
    if (this.diag.relayTried || this.closed) return;
    this.diag.relayTried = true;
    for (const url of brokers()) {
      const mq = new MiniMqtt(url);
      mq.connect('cgc' + randomId(11)).then(() => {
        if (this.closed || this.chosen) { mq.close(); return; }
        this.diag.relayUp++;
        this.relays.push(mq);
        mq.subscribe(TOPIC + this.code + '/c/' + this.cid);
        mq.subscribe(TOPIC + this.code + '/b');
        mq.onMessage = (topic, text) => this._relayIn(mq, text);
        mq.onClose = () => {
          if (this.chosen && this.chosen.mq === mq) this._reconnectRelay(mq.url, 0);
        };
        // petite pause pour laisser l'abonnement s'établir
        setTimeout(() => this._sendHello(), 150);
      }).catch(() => {});
    }
  }

  _reconnectRelay(url, n) {
    if (this.closed) return;
    if (n > 3) { this._lost('Connexion au relais perdue.'); return; }
    const mq = new MiniMqtt(url);
    mq.connect('cgc' + randomId(11)).then(() => {
      if (this.closed) { mq.close(); return; }
      mq.subscribe(TOPIC + this.code + '/c/' + this.cid);
      mq.subscribe(TOPIC + this.code + '/b');
      mq.onMessage = (topic, text) => this._relayIn(mq, text);
      mq.onClose = () => this._reconnectRelay(url, 0);
      this.chosen = { kind: 'relay', mq };
      this.relays = [mq];
      this.send({ t: 'pong' }); // l'hôte réapprend notre chemin
    }).catch(() => setTimeout(() => this._reconnectRelay(url, n + 1), 1500));
  }

  _relayIn(mq, text) {
    let o;
    try { o = JSON.parse(text); } catch (e) { return; }
    if (!o || typeof o !== 'object') return;
    if (this.chosen && this.chosen.mq !== mq) return;
    this._ackMq = mq;
    if (this.chosen) this.lastSeen = performance.now();
    for (const msg of this.link.receive(o)) this._in('relay', mq, msg);
  }

  _in(kind, mq, msg) {
    if (this.closed || !msg || typeof msg !== 'object') return;
    if (!this.chosen) {
      if (msg.t !== 'welcome' && msg.t !== 'refuse') return;
      // premier canal qui répond : on garde celui-là, on ferme les autres
      this.chosen = kind === 'rtc' ? { kind } : { kind, mq };
      this._cleanupOthers();
      this.lastSeen = performance.now();
      this.watch = setInterval(() => {
        if (performance.now() - this.lastSeen > 12000) this._lost('L\'hôte ne répond plus.');
      }, 2000);
      this.h.onMessage(msg);
      if (this._resolve) this._resolve();
      this._resolve = this._reject = null;
      if (kind === 'relay') this.send({ t: 'pong' }); // l'hôte apprend par quel relais nous répondre
      return;
    }
    if (kind !== this.chosen.kind || (kind === 'relay' && mq !== this.chosen.mq)) return;
    this.lastSeen = performance.now();
    if (msg.t === 'ping') { this.send({ t: 'pong' }); return; }
    this.h.onMessage(msg);
  }

  _cleanupOthers() {
    clearTimeout(this.relayTimer);
    clearTimeout(this.failTimer);
    clearInterval(this.helloTimer);
    if (this.chosen.kind === 'relay') {
      if (this.conn) { try { this.conn.close(); } catch (e) { /* rien */ } this.conn = null; }
      if (this.peer) { try { this.peer.destroy(); } catch (e) { /* rien */ } this.peer = null; }
      for (const mq of this.relays) if (mq !== this.chosen.mq) mq.close();
      this.relays = [this.chosen.mq];
    } else {
      for (const mq of this.relays) mq.close();
      this.relays = [];
      this.diag.relayTried = true;
    }
  }

  _fail() {
    if (this.chosen || this.closed) return;
    const d = this.diag;
    let message;
    if (d.peerUnavailable && !d.relayUp) message = 'Salon introuvable. Vérifie le code, et que l\'hôte a toujours la page ouverte.';
    else if (d.peerUnavailable) message = 'Salon introuvable (ou l\'hôte a fermé la page). Vérifie le code.';
    else if (!d.relayUp && d.relayTried) message = 'Impossible de joindre l\'hôte : la connexion directe est bloquée et le relais est injoignable depuis ce réseau.';
    else message = 'L\'hôte ne répond pas. Vérifie le code, et que l\'hôte a toujours la page ouverte.';
    const reject = this._reject;
    this.close();
    if (reject) reject({ type: 'join', message });
  }

  _lost(reason) {
    if (this.closed) return;
    this.close();
    this.h.onClose(reason);
  }

  send(msg) {
    if (!this.chosen || this.closed) return;
    if (this.chosen.kind === 'rtc') {
      try { if (this.conn && this.conn.open) this.conn.send(msg); } catch (e) { /* rien */ }
    } else {
      this.link.send(msg);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.relayTimer);
    clearTimeout(this.failTimer);
    clearInterval(this.helloTimer);
    clearInterval(this.watch);
    clearInterval(this.linkTimer);
    try { this.conn && this.conn.close(); } catch (e) { /* rien */ }
    try { this.peer && this.peer.destroy(); } catch (e) { /* rien */ }
    for (const mq of this.relays) mq.close();
    this.relays = [];
    this.conn = null; this.peer = null;
  }
}
