// Contrôleur de jeu local : un trou, la balle du joueur, la caméra, la visée,
// et l'affichage des balles des autres joueurs (sans collision).
import * as THREE from 'three';
import { BALL_R, CUP_R, DX, DZ, MAX_STROKES, TILE } from './constants.js';
import { Course } from './course.js';
import { makeBall, placeBall, shootBall, stepBall } from './physics.js';
import { sfx } from './audio.js';

const FIXED = 1 / 120;

class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.42;
    this.dist = 3.6;
    this.target = new THREE.Vector3();
    this.goal = new THREE.Vector3();
    this.overview = false;
    this.ovTarget = new THREE.Vector3();
    this.ovDist = 15;
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
  }
  snap(v) { this.target.copy(v); this.goal.copy(v); }
  update(dt, world, course) {
    const k = 1 - Math.exp(-dt * 6);
    const goal = this.overview ? this.ovTarget : this.goal;
    this.target.lerp(goal, k);
    const dist = this.overview ? Math.max(this.dist, this.ovDist) : this.dist;
    const pitch = this.overview ? Math.max(this.pitch, 0.95) : this.pitch;
    const cp = Math.cos(pitch);
    this._pos.set(
      this.target.x - Math.cos(this.yaw) * cp * dist,
      this.target.y + Math.sin(pitch) * dist,
      this.target.z - Math.sin(this.yaw) * cp * dist,
    );
    // ne pas passer sous le gazon / le sol
    let floor = world.groundHeight ? world.groundHeight(this._pos.x, this._pos.z) : 0;
    if (course) {
      const h = course.height(this._pos.x, this._pos.z);
      if (h != null) floor = Math.max(floor, h + 0.15);
    }
    if (this._pos.y < floor + 0.25) this._pos.y = floor + 0.25;
    this.camera.position.lerp(this._pos, this.overview ? k : 1 - Math.exp(-dt * 14));
    this._look.copy(this.target);
    this._look.y += 0.05;
    this.camera.lookAt(this._look);
  }
}

export class Game {
  constructor(world, canvas, cb) {
    this.world = world;
    this.canvas = canvas;
    this.cb = cb; // { onStroke, onDone, onToast, onAim, onAimEnd, onPos }
    this.rig = new CameraRig(world.camera);
    this.course = null;
    this.ball = makeBall();
    this.state = 'idle';
    this.strokes = 0;
    this.holeTime = 0;
    this.acc = 0;
    this.ghosts = new Map();
    this.labelsEl = document.getElementById('labels');
    this.selfColor = '#ff7a1a';
    this.enabled = false;
    this.attract = false;
    this.aim = null;
    this.keys = new Set();
    this._lastPos = 0;
    this._quat = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this._bindInput();
  }

  // ------------------------------------------------------------------ trou
  loadHole(def, selfColor) {
    this.course = new Course(def);
    this.world.setCourse(this.course);
    this.world.clearBalls();
    this.selfColor = selfColor;
    this.ballMesh = this.world.addBall('self', selfColor, false);
    this.ballMesh.visible = true;
    placeBall(this.course, this.ball, def.tee.x, def.tee.z);
    this.lastRest = { x: def.tee.x, z: def.tee.z };
    this.strokes = 0;
    this.holeTime = 0;
    this.acc = 0;
    this.state = 'ready';
    this.sink = null;
    this.doneSent = false;
    this.attract = false;
    const d = def.cells[0].dout;
    this.rig.yaw = Math.atan2(DZ[d], DX[d]);
    this.rig.pitch = 0.42;
    this.rig.dist = 3.6;
    this.rig.overview = false;
    const b = this.course.bounds;
    this.rig.ovTarget.set((b.minX + b.maxX) / 2, (b.minL + b.maxL) / 2, (b.minZ + b.maxZ) / 2);
    this.rig.ovDist = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.95 + 4;
    const p = new THREE.Vector3(this.ball.x, this.ball.y, this.ball.z);
    // petit survol du trou avant de passer derrière la balle
    this.introT = 2.6;
    this.rig.overview = true;
    this.rig.snap(this.rig.ovTarget);
    this.rig.goal.copy(p);
    this.rig.update(1, this.world, this.course);
    this.world.camera.position.copy(this.rig._pos);
    // les fantômes des autres joueurs repartent du départ
    for (const g of this.ghosts.values()) {
      g.done = false;
      g.cur.set(def.tee.x, this.ball.y, def.tee.z);
      g.goal.copy(g.cur);
      g.mesh = this.world.addBall('g-' + g.id, g.color, true);
      g.mesh.visible = true;
      g.mesh.scale.setScalar(1);
    }
    this.enabled = true;
    this.cancelAim();
  }

  // menu : un trou qui tourne doucement en fond
  loadAttract(def) {
    this.course = new Course(def);
    this.world.setCourse(this.course);
    this.world.clearBalls();
    this.enabled = false;
    this.attract = true;
    this.state = 'idle';
    for (const g of this.ghosts.values()) g.label?.remove();
    this.ghosts.clear();
    const b = this.course.bounds;
    this.rig.overview = true;
    this.rig.ovTarget.set((b.minX + b.maxX) / 2, (b.minL + b.maxL) / 2, (b.minZ + b.maxZ) / 2);
    this.rig.ovDist = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.75 + 5;
    this.rig.pitch = 0.6;
    this.rig.snap(this.rig.ovTarget);
    this.world.hideAim();
    this.world.hideRing();
  }

  get canShoot() {
    return this.enabled && this.state === 'ready';
  }

  // ------------------------------------------------------------------ autres joueurs
  setGhost(id, name, color) {
    let g = this.ghosts.get(id);
    if (!g) {
      g = { id, name, color, cur: new THREE.Vector3(0, -10, 0), goal: new THREE.Vector3(0, -10, 0), done: false, mesh: null, label: null, seen: false };
      const el = document.createElement('div');
      el.className = 'ball-label';
      this.labelsEl.appendChild(el);
      g.label = el;
      this.ghosts.set(id, g);
      if (this.course) {
        g.mesh = this.world.addBall('g-' + id, color, true);
        g.cur.set(this.course.tee.x, this.ball.y, this.course.tee.z);
        g.goal.copy(g.cur);
      }
    }
    g.name = name; g.color = color;
    g.label.innerHTML = `<i style="background:${color}"></i>${escapeHtml(name)}`;
    if (g.mesh) g.mesh.material.color.set(color);
  }
  removeGhost(id) {
    const g = this.ghosts.get(id);
    if (!g) return;
    g.label?.remove();
    this.world.removeBall('g-' + id);
    this.ghosts.delete(id);
  }
  clearGhosts() { for (const id of [...this.ghosts.keys()]) this.removeGhost(id); }
  ghostPos(id, x, y, z) {
    const g = this.ghosts.get(id);
    if (!g) return;
    g.goal.set(x, y, z);
    if (!g.seen) { g.cur.copy(g.goal); g.seen = true; }
  }
  ghostDone(id) {
    const g = this.ghosts.get(id);
    if (g) g.done = true;
  }

  // ------------------------------------------------------------------ entrées
  _bindInput() {
    const cv = this.canvas;
    this.pointers = new Map();
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this._skipIntro();
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button });
      if (this.pointers.size >= 2) { this.cancelAim(); return; }
      if (e.button === 0 && this.canShoot) {
        this.aim = { sx: e.clientX, sy: e.clientY, power: 0, angle: this.rig.yaw, id: e.pointerId };
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (this.pointers.size >= 2) {
        // deux doigts : rotation + zoom
        const pts = [...this.pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this._pinch) this.rig.dist = clamp(this.rig.dist * (this._pinch / d), 1.0, 14);
        this._pinch = d;
        this.rig.yaw -= dx * 0.004;
        return;
      }
      if (this.aim && e.pointerType === 'mouse' && (e.buttons & 2)) { this.cancelAim(); return; }
      if (this.aim && this.aim.id === e.pointerId) this._updateAim(e.clientX, e.clientY);
      else if (!this.aim) {
        this.rig.yaw -= dx * 0.006;
        this.rig.pitch = clamp(this.rig.pitch + dy * 0.004, 0.12, 1.45);
      }
    });
    const up = (e) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this._pinch = null;
      if (!p) return;
      if (this.aim && this.aim.id === e.pointerId) {
        const a = this.aim;
        this.aim = null;
        this.cb.onAimEnd();
        this.world.hideAim();
        if (e.type === 'pointerup' && a.power >= 0.02 && this.canShoot) this.shoot(a.angle, a.power);
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.rig.dist = clamp(this.rig.dist * Math.pow(1.0015, e.deltaY), 1.0, 14);
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      this.keys.add(e.code);
      if (!this.enabled) return;
      this._skipIntro();
      if (e.code === 'Escape') this.cancelAim();
      if (e.code === 'KeyV') this.rig.overview = !this.rig.overview;
      if (e.code === 'KeyC') this.recenter();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  _skipIntro() {
    if (this.introT > 0) { this.introT = 0; this.rig.overview = false; }
  }

  recenter() {
    this.rig.overview = false;
    // orienter la caméra vers le trou (en suivant le chemin)
    const c = this.course?.cellAt(this.ball.x, this.ball.z);
    if (c) {
      const d = c === this.course.cupCell ? null : c.dout;
      const tx = d == null ? this.course.cup.x : c.cx + DX[d] * TILE * 0.5;
      const tz = d == null ? this.course.cup.z : c.cz + DZ[d] * TILE * 0.5;
      this.rig.yaw = Math.atan2(tz - this.ball.z, tx - this.ball.x);
    }
  }

  cancelAim() {
    if (this.aim) { this.aim = null; this.cb.onAimEnd(); }
    this.world.hideAim();
  }

  _updateAim(x, y) {
    const a = this.aim;
    const dx = x - a.sx, dy = y - a.sy;
    const span = Math.min(window.innerWidth, window.innerHeight) * 0.32;
    const power = clamp(Math.hypot(dx, dy) / span, 0, 1);
    // axe caméra projeté au sol
    const cam = this.world.camera;
    const fx = this.rig.target.x - cam.position.x, fz = this.rig.target.z - cam.position.z;
    const fl = Math.hypot(fx, fz) || 1;
    const ux = fx / fl, uz = fz / fl;      // avant
    const rx = -uz, rz = ux;               // droite
    // on tire à l'opposé du glissé (comme un lance-pierre)
    const wx = rx * dx + ux * -dy, wz = rz * dx + uz * -dy;
    if (Math.hypot(dx, dy) > 3) a.angle = Math.atan2(-wz, -wx);
    a.power = power;
    this.cb.onAim(power);
  }

  _notify(type, data) {
    if (this.cb.onGameEvent) this.cb.onGameEvent(type, { x: this.ball.x, z: this.ball.z, ...data });
  }

  shoot(angle, power) {
    if (!this.canShoot) return;
    this._notify('shot', { power });
    this.strokes++;
    this.lastRest = { x: this.ball.x, z: this.ball.z };
    shootBall(this.course, this.ball, angle, power);
    this.state = 'rolling';
    sfx('putt', 0.3 + power * 0.7);
    this.cb.onStroke(this.strokes);
  }

  // ------------------------------------------------------------------ boucle
  update(dt, now) {
    if (!this.course) return;
    this.world.updateFx(dt);
    if (this.attract) {
      this.world.update(now);
      this.rig.yaw += dt * 0.08;
      this.rig.update(dt, this.world, this.course);
      return;
    }
    this.holeTime += dt;
    this.world.update(this.holeTime);
    if (this.introT > 0) {
      this.introT -= dt;
      if (this.introT <= 0) this.rig.overview = false;
    }

    // caméra au clavier
    const rot = (this.keys.has('ArrowLeft') || this.keys.has('KeyA') || this.keys.has('KeyQ') ? 1 : 0)
      - (this.keys.has('ArrowRight') || this.keys.has('KeyD') ? 1 : 0);
    const tilt = (this.keys.has('ArrowUp') || this.keys.has('KeyW') || this.keys.has('KeyZ') ? 1 : 0)
      - (this.keys.has('ArrowDown') || this.keys.has('KeyS') ? 1 : 0);
    if (this.enabled) {
      this.rig.yaw -= rot * dt * 1.6;
      this.rig.pitch = clamp(this.rig.pitch - tilt * dt * 0.9, 0.12, 1.45);
    }

    // physique à pas fixe
    const ev = [];
    if (this.state === 'rolling' || (this.state === 'ready' && this.course.cellAt(this.ball.x, this.ball.z)?.mills.length)) {
      this.acc += Math.min(dt, 0.1);
      while (this.acc >= FIXED) {
        stepBall(this.course, this.ball, FIXED, this.holeTime - this.acc, ev);
        this.acc -= FIXED;
      }
      if (this.state === 'ready' && this.ball.moving) this.state = 'rolling';
    } else this.acc = 0;
    for (const e of ev) this._event(e);

    // balle : rotation de roulement
    const m = this.ballMesh;
    if (m && this.state !== 'sinking' && this.state !== 'done') {
      const dx = this.ball.x - m.position.x, dz = this.ball.z - m.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-5 && d < 1) {
        this._axis.set(dz, 0, -dx).normalize();
        this._quat.setFromAxisAngle(this._axis, d / BALL_R);
        m.quaternion.premultiply(this._quat);
      }
      m.position.set(this.ball.x, this.ball.y, this.ball.z);
    }
    if (this.state === 'sinking') this._updateSink(dt);
    if (this.state === 'oob' || this.state === 'water') {
      this.oobT -= dt;
      if (m) {
        // la balle flotte encore un instant avant de revenir au point de tir
        const bob = this.state === 'water' ? Math.sin(this.holeTime * 7) * 0.006 * Math.min(1, this.oobT) : 0;
        m.position.set(this.ball.x, this.ball.y + bob, this.ball.z);
      }
      if (this.oobT <= 0) this._afterOob();
    }
    // sillage quand la balle glisse sur l'eau
    if (this.state === 'rolling' && this.ball.wet) {
      this.wakeT = (this.wakeT || 0) - dt;
      if (this.wakeT <= 0 && Math.hypot(this.ball.vx, this.ball.vz) > 0.05) {
        this.wakeT = 0.2;
        const c = this.course.cellAt(this.ball.x, this.ball.z);
        if (c) this.world.ripple(this.ball.x, c.level + 0.012, this.ball.z, 0.1);
      }
    }

    // anneau « à toi de jouer »
    if (this.state === 'ready' && !this.aim) this.world.showRing(this.ball.x, this.ball.y, this.ball.z, now);
    else this.world.hideRing();
    if (this.aim && this.aim.power > 0.005) this.world.showAim(this.ball.x, this.ball.y, this.ball.z, this.aim.angle, this.aim.power);
    else this.world.hideAim();

    // drapeau discret quand on est proche
    const dc = Math.hypot(this.ball.x - this.course.cup.x, this.ball.z - this.course.cup.z);
    const camNear = this.rig.dist < 6 && !this.rig.overview;
    this.world.setFlagOpacity(camNear && dc < 2.2 ? 0.25 : 1);

    // fantômes
    for (const g of this.ghosts.values()) {
      if (!g.mesh) continue;
      g.cur.lerp(g.goal, 1 - Math.exp(-dt * 14));
      g.mesh.position.copy(g.cur);
      const nearCup = Math.hypot(g.cur.x - this.course.cup.x, g.cur.z - this.course.cup.z) < CUP_R * 1.5;
      g.mesh.visible = !(g.done && nearCup) && g.seen;
    }

    // caméra
    if (this.state === 'done') {
      this.doneT = (this.doneT || 0) + dt;
      if (this.doneT > 1.8 && !this.rig.overview) this.rig.overview = true;
    } else {
      this.rig.goal.set(this.ball.x, this.ball.y, this.ball.z);
    }
    this.rig.update(dt, this.world, this.course);
    this._updateLabels();

    // position envoyée aux autres (~15 Hz en mouvement)
    if (this.cb.onPos) {
      const moving = this.state === 'rolling' || this.state === 'sinking';
      if (now - this._lastPos > (moving ? 0.066 : 1.0)) {
        this._lastPos = now;
        this.cb.onPos(this.ball.x, this.ball.y, this.ball.z, moving);
      }
    }
  }

  _event(e) {
    switch (e.type) {
      case 'wall': case 'post': case 'mill':
        if (e.speed > 0.15) sfx(e.type, e.speed / 4);
        break;
      case 'bounce':
        sfx('bounce', e.speed / 3);
        break;
      case 'lip':
        sfx('lip');
        this.cb.onToast('Lèvre !', 'small');
        break;
      case 'holed':
        this.state = 'sinking';
        this.sink = { t: 0, x: this.ball.x, y: this.ball.y, z: this.ball.z };
        sfx('cup');
        break;
      case 'oob':
        this.state = 'oob';
        this.oobT = 0.9;
        sfx('oob');
        this.cb.onToast('Hors limites · +1', 'warn');
        this._notify('oob');
        break;
      case 'splash': {
        const c = this.course.cellAt(e.x, e.z);
        const y = c ? c.level + 0.012 : this.ball.y;
        this.world.splash(e.x, y, e.z, e.speed / 2.5);
        sfx('splash', Math.min(1, e.speed / 3));
        if (!e.skip) this._notify('splash');
        break;
      }
      case 'water':
        this.state = 'water';
        this.oobT = 1.4;
        sfx('plouf');
        this.cb.onToast('Plouf ! Retour au point de tir · +1', 'warn');
        this._notify('water');
        break;
      case 'stop':
        if (this.state === 'rolling') this._afterStop();
        break;
      default: break;
    }
  }

  _afterStop() {
    if (this.strokes >= MAX_STROKES) {
      this._finish(false);
      return;
    }
    this.state = 'ready';
  }

  _afterOob() {
    this.strokes++;
    this.cb.onStroke(this.strokes, true);
    placeBall(this.course, this.ball, this.lastRest.x, this.lastRest.z);
    if (this.ballMesh) this.ballMesh.position.set(this.ball.x, this.ball.y, this.ball.z);
    if (this.strokes >= MAX_STROKES) { this._finish(false); return; }
    this.state = 'ready';
  }

  _updateSink(dt) {
    const s = this.sink;
    s.t += dt;
    const k = Math.min(1, s.t / 0.35);
    const cx = this.course.cup.x, cz = this.course.cup.z;
    const h = this.course.heightCell(this.course.cupCell, cx, cz);
    const m = this.ballMesh;
    m.position.set(
      s.x + (cx - s.x) * Math.min(1, k * 1.4),
      s.y + (h - 0.1 - s.y) * k * k,
      s.z + (cz - s.z) * Math.min(1, k * 1.4),
    );
    if (s.t > 0.55) {
      m.visible = false;
      this.ball.x = cx; this.ball.z = cz; this.ball.y = h - 0.1;
      this._finish(true);
    }
  }

  _finish(holed) {
    if (this.doneSent) return;
    this.doneSent = true;
    this.state = 'done';
    this.doneT = 0;
    this.world.hideAim();
    this.world.hideRing();
    if (!holed && this.ballMesh) this.ballMesh.visible = false;
    this.cb.onDone(this.strokes, holed);
  }

  _updateLabels() {
    const cam = this.world.camera;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const v = new THREE.Vector3();
    for (const g of this.ghosts.values()) {
      if (!g.label) continue;
      if (!g.mesh || !g.mesh.visible) { g.label.style.display = 'none'; continue; }
      v.copy(g.cur); v.y += 0.14;
      v.project(cam);
      if (v.z > 1 || v.z < -1) { g.label.style.display = 'none'; continue; }
      g.label.style.display = 'flex';
      g.label.style.transform = `translate(-50%, -100%) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  stop() {
    this.enabled = false;
    this.state = 'idle';
    this.cancelAim();
    this.world.hideRing();
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
