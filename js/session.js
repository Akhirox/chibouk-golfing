// Logique d'hôte : salon, enchaînement des trous, scores.
// Tourne chez l'hôte (multijoueur) ou localement (solo).
import { HOLES, MAX_PLAYERS } from './constants.js';
import { FAIL_SCORE } from './score.js';
import { randomCode } from './rng.js';

export const HOST_ID = 'host';
const HOLE_END_DELAY = 1.3;   // s avant d'afficher le récap du trou
const NEXT_DELAY = 9;         // s avant le trou suivant

export class HostSession {
  constructor({ net, self, deliver }) {
    this.net = net;           // HostNet ou null (solo)
    this.deliver = deliver;   // message vers le client local
    this.players = new Map();
    this.phase = 'lobby';
    this.holes = [];
    this.pars = [];
    this.current = -1;
    this.job = 0;
    this.code = net ? net.code : null;
    this.addPlayer(HOST_ID, self.name, self.color, true);
  }

  addPlayer(id, name, color, host = false) {
    this.players.set(id, {
      id, name: cleanName(name), color: cleanColor(color), host,
      scores: new Array(HOLES).fill(null), strokes: 0, done: false, connected: true,
    });
  }

  pub() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, host: p.host,
      scores: p.scores, strokes: p.strokes, done: p.done, connected: p.connected,
      relay: !!(this.net && !p.host && this.net.routeKind(p.id) === 'relay'),
    }));
  }

  send(msg) {
    if (this.net) this.net.broadcast(msg);
    this.deliver(msg);
  }
  relay(msg, except) {
    if (this.net) this.net.broadcast(msg, except);
    if (except !== HOST_ID) this.deliver(msg);
  }

  sendLobby() { this.send({ t: 'lobby', code: this.code, players: this.pub(), phase: this.phase }); }
  sendState() { this.send({ t: 'state', players: this.pub(), pars: this.pars }); }

  // ------------------------------------------------------------ connexions
  onJoin(id) { /* on attend le « hello » */ void id; }

  onLeave(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players.delete(id);
      this.sendLobby();
    } else {
      p.connected = false;
      p.done = true;
      this.sendState();
      this.checkHoleDone();
    }
    this.send({ t: 'notice', text: `${p.name} a quitté la partie` });
  }

  // ------------------------------------------------------------ messages
  receive(msg, from) {
    if (!msg || typeof msg !== 'object') return;
    const p = this.players.get(from);
    switch (msg.t) {
      case 'hello': {
        if (from === HOST_ID) return;
        if (p) {
          // « hello » répété (le client insiste tant qu'il n'a pas de réponse) : on renvoie l'accueil
          p.connected = true;
          this.net?.sendTo(from, { t: 'welcome', id: from });
          if (this.phase === 'lobby') this.sendLobby();
          else this.sendState();
          return;
        }
        if (this.phase !== 'lobby') { this.net?.kick(from, { t: 'refuse', reason: 'Partie déjà en cours. Attends la prochaine !' }); return; }
        if (this.players.size >= MAX_PLAYERS) { this.net?.kick(from, { t: 'refuse', reason: 'Salon complet (8 joueurs max).' }); return; }
        this.addPlayer(from, msg.name, msg.color);
        this.net?.sendTo(from, { t: 'welcome', id: from });
        this.sendLobby();
        this.send({ t: 'notice', text: `${cleanName(msg.name)} a rejoint le salon`, sound: 'join' });
        break;
      }
      case 'profile':
        if (!p || this.phase !== 'lobby') return;
        p.name = cleanName(msg.name);
        p.color = cleanColor(msg.color);
        this.sendLobby();
        break;
      case 'pos':
        if (!p || this.phase !== 'playing') return;
        this.relay({ t: 'pos', id: from, x: +msg.x, y: +msg.y, z: +msg.z, m: !!msg.m }, from);
        break;
      case 'stroke':
        if (!p || this.phase !== 'playing' || msg.index !== this.current || p.done) return;
        p.strokes = Math.max(0, Math.min(FAIL_SCORE, msg.strokes | 0));
        this.sendState();
        break;
      case 'done':
        if (!p || this.phase !== 'playing' || msg.index !== this.current || p.done) return;
        p.strokes = Math.max(1, Math.min(FAIL_SCORE, msg.strokes | 0));
        p.done = true;
        p.scores[this.current] = msg.holed ? p.strokes : FAIL_SCORE;
        this.send({ t: 'holed', id: from, strokes: p.scores[this.current], holed: !!msg.holed, index: this.current });
        this.sendState();
        this.checkHoleDone();
        break;
      default: break;
    }
  }

  // ------------------------------------------------------------ déroulé
  startGame() {
    if (this.phase !== 'lobby' && this.phase !== 'final') return;
    this.seed = randomCode(6);
    this.holes = [];
    this.pars = new Array(HOLES).fill(null);
    this.current = -1;
    for (const p of this.players.values()) {
      p.scores = new Array(HOLES).fill(null);
      p.strokes = 0; p.done = false;
    }
    // les joueurs déconnectés ne sont pas repris
    for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
    this.phase = 'loading';
    this.send({ t: 'loading', ready: 0, total: HOLES, seed: this.seed });
    this._generate();
  }

  _generate() {
    const job = ++this.job;
    const onHole = (index, def) => {
      if (job !== this.job) return;
      this.holes[index] = def;
      this.pars[index] = def.par;
      if (this.phase === 'loading' && this.waitingFor === index) this.startHole(index);
      else if (this.phase === 'loading' && index === 0 && this.current === -1) this.startHole(0);
    };
    this.waitingFor = 0;
    try {
      if (this.worker) this.worker.terminate();
      this.worker = new Worker(new URL('./gen-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => { if (e.data.job === job) onHole(e.data.index, e.data.def); };
      this.worker.onerror = () => { this.worker.terminate(); this.worker = null; this._generateInline(job, onHole); };
      this.worker.postMessage({ seed: this.seed, count: HOLES, job });
    } catch (e) {
      this._generateInline(job, onHole);
    }
  }

  async _generateInline(job, onHole) {
    const { generateHole } = await import('./generator.js');
    for (let k = 0; k < HOLES; k++) {
      if (job !== this.job) return;
      if (this.holes[k]) continue;
      await new Promise((r) => setTimeout(r, 30));
      onHole(k, generateHole(this.seed, k));
    }
  }

  startHole(index) {
    clearTimeout(this.timer);
    if (!this.holes[index]) {
      this.phase = 'loading';
      this.waitingFor = index;
      this.send({ t: 'loading', ready: this.holes.filter(Boolean).length, total: HOLES, seed: this.seed });
      return;
    }
    this.phase = 'playing';
    this.current = index;
    for (const p of this.players.values()) {
      p.strokes = 0;
      p.done = !p.connected;
    }
    this.send({ t: 'hole', index, def: this.holes[index], pars: this.pars, players: this.pub(), seed: this.seed });
  }

  checkHoleDone() {
    if (this.phase !== 'playing') return;
    const active = [...this.players.values()].filter((p) => p.connected);
    if (active.length && active.some((p) => !p.done)) return;
    this.phase = 'holeEnd';
    const index = this.current;
    this.timer = setTimeout(() => {
      const last = index >= HOLES - 1;
      const delay = this.net ? NEXT_DELAY : 6;
      this.send({ t: 'holeEnd', index, players: this.pub(), pars: this.pars, last, delay: last ? 0 : delay });
      if (last) {
        this.timer = setTimeout(() => this.finish(), 3500);
      } else {
        this.timer = setTimeout(() => this.next(), delay * 1000);
      }
    }, HOLE_END_DELAY * 1000);
  }

  next() {
    if (this.phase !== 'holeEnd') return;
    clearTimeout(this.timer);
    if (this.current >= HOLES - 1) { this.finish(); return; }
    this.startHole(this.current + 1);
  }

  finish() {
    clearTimeout(this.timer);
    this.phase = 'final';
    this.send({ t: 'final', players: this.pub(), pars: this.pars, seed: this.seed });
  }

  backToLobby() {
    clearTimeout(this.timer);
    this.job++;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
    this.phase = 'lobby';
    this.current = -1;
    this.sendLobby();
  }

  close() {
    clearTimeout(this.timer);
    this.job++;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
  }
}

export function cleanName(n) {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return s || 'Joueur';
}
export function cleanColor(c) {
  return /^#[0-9a-fA-F]{6}$/.test(String(c)) ? String(c) : '#ff7a1a';
}
