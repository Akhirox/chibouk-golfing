// Réseau pair-à-pair (WebRTC via PeerJS). Topologie en étoile :
// l'hôte relaie les messages, aucun serveur de jeu.
import { PEER_PREFIX } from './constants.js';
import { randomCode } from './rng.js';

function peerOptions() {
  const q = new URLSearchParams(location.search);
  const opts = { debug: +(q.get('peerdebug') || 0) };
  if (q.get('peerhost')) {
    opts.host = q.get('peerhost');
    opts.port = +(q.get('peerport') || 9000);
    opts.path = q.get('peerpath') || '/';
    opts.secure = q.get('peersecure') === '1';
  }
  return opts;
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

export class HostNet {
  constructor(handlers) {
    this.h = handlers; // { onMessage(msg, id), onJoin(id), onLeave(id) }
    this.conns = new Map();
    this.lastSeen = new Map();
    this.peer = null;
    this.code = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const code = randomCode(5);
        const peer = new window.Peer(PEER_PREFIX + code, peerOptions());
        let opened = false;
        peer.on('open', () => {
          opened = true;
          this.peer = peer;
          this.code = code;
          this._setup(peer);
          resolve(code);
        });
        peer.on('error', (err) => {
          if (!opened) {
            peer.destroy();
            if (err.type === 'unavailable-id' && tries++ < 4) attempt();
            else reject(err);
          } else if (this.h.onError) this.h.onError(err);
        });
      };
      attempt();
    });
  }

  _setup(peer) {
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        this.conns.set(conn.peer, conn);
        this.lastSeen.set(conn.peer, performance.now());
        this.h.onJoin(conn.peer);
      });
      conn.on('data', (msg) => {
        this.lastSeen.set(conn.peer, performance.now());
        if (msg && msg.t === 'pong') return;
        this.h.onMessage(msg, conn.peer);
      });
      const gone = () => this._drop(conn.peer);
      conn.on('close', gone);
      conn.on('error', gone);
    });
    peer.on('disconnected', () => {
      // perte du service de mise en relation : les connexions établies continuent
      if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* rien */ } }, 1500);
    });
    this.pingTimer = setInterval(() => {
      const now = performance.now();
      for (const [id, conn] of this.conns) {
        if (now - (this.lastSeen.get(id) || now) > 12000) { this._drop(id); continue; }
        this._send(conn, { t: 'ping' });
      }
    }, 2000);
  }

  _drop(id) {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    this.lastSeen.delete(id);
    try { conn.close(); } catch (e) { /* rien */ }
    this.h.onLeave(id);
  }

  kick(id, msg) {
    const conn = this.conns.get(id);
    if (!conn) return;
    this._send(conn, msg);
    setTimeout(() => this._drop(id), 300);
  }

  _send(conn, msg) {
    try { if (conn.open) conn.send(msg); } catch (e) { /* rien */ }
  }

  sendTo(id, msg) {
    const conn = this.conns.get(id);
    if (conn) this._send(conn, msg);
  }

  broadcast(msg, except = null) {
    for (const [id, conn] of this.conns) if (id !== except) this._send(conn, msg);
  }

  close() {
    clearInterval(this.pingTimer);
    for (const conn of this.conns.values()) { try { conn.close(); } catch (e) { /* rien */ } }
    this.conns.clear();
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* rien */ } }
    this.peer = null;
  }
}

export class ClientNet {
  constructor(handlers) {
    this.h = handlers; // { onMessage(msg), onClose(reason) }
    this.peer = null;
    this.conn = null;
    this.closed = false;
  }

  join(code) {
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(undefined, peerOptions());
      this.peer = peer;
      let done = false;
      const fail = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.close();
        reject(err);
      };
      const timer = setTimeout(() => fail({ type: 'timeout', message: 'Le salon ne répond pas (délai dépassé).' }), 25000);
      peer.on('error', (err) => {
        if (!done) fail(err);
        else if (err.type === 'peer-unavailable' || err.type === 'network') this._lost('Connexion à l\'hôte perdue.');
      });
      peer.on('open', () => {
        const conn = peer.connect(PEER_PREFIX + code.toUpperCase(), { reliable: true });
        this.conn = conn;
        conn.on('open', () => {
          done = true;
          clearTimeout(timer);
          this.lastSeen = performance.now();
          this.watch = setInterval(() => {
            if (performance.now() - this.lastSeen > 12000) this._lost('L\'hôte ne répond plus.');
          }, 2000);
          resolve();
        });
        conn.on('data', (msg) => {
          this.lastSeen = performance.now();
          if (msg && msg.t === 'ping') { this.send({ t: 'pong' }); return; }
          this.h.onMessage(msg);
        });
        conn.on('close', () => this._lost('L\'hôte a quitté la partie.'));
        conn.on('error', () => this._lost('Connexion à l\'hôte perdue.'));
      });
      peer.on('disconnected', () => {
        if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* rien */ } }, 1500);
      });
    });
  }

  _lost(reason) {
    if (this.closed) return;
    this.close();
    this.h.onClose(reason);
  }

  send(msg) {
    try { if (this.conn && this.conn.open) this.conn.send(msg); } catch (e) { /* rien */ }
  }

  close() {
    this.closed = true;
    clearInterval(this.watch);
    try { this.conn && this.conn.close(); } catch (e) { /* rien */ }
    try { this.peer && this.peer.destroy(); } catch (e) { /* rien */ }
    this.conn = null; this.peer = null;
  }
}
