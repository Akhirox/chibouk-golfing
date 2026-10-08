// Personnages 3D qui vivent autour du parcours : singes et combattants de Chibouk Fighting.
// Ils se baladent, font des animations au hasard, interagissent entre eux
// (danse, discussion, bagarre amicale) et réagissent aux coups des joueurs.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';

const BASE = 'assets/characters/';
export const FIGHTERS = [
  { id: 'arnaud', name: 'Arnaud' },
  { id: 'louis', name: 'Louis' },
  { id: 'niels', name: 'Niels' },
  { id: 'rioky', name: 'Rioky' },
  { id: 'thomas', name: 'Thomas' },
];

// animations de la bibliothèque partagée (anims.glb)
const LIB = {
  idle: 'Idle', walk: 'Walk', run: 'Sprint', dance: 'Dance', celebrate: 'Celebration', yes: 'Yes',
  punch: 'Punch Cross', kick: 'Kick', uppercut: 'Melee Uppercut', hit: 'Hit Knockback',
  hitHead: 'Hit Head', hitChest: 'Hit Chest', hitStomach: 'Hit Stomach', dodgeL: 'Dodge Left', dodgeR: 'Dodge Right',
};
// animations propres au singe (prioritaires)
const MONKEY_OWN = { idle: 'Idle', run: 'Sprint', celebrate: 'Celebration', cry: 'Crying', dance: 'Dance', surprise: 'Surprise' };
// Les clips bouclent sur leur première image : on coupe un peu avant pour les gestes uniques
const END = {
  dodgeL: 0.8, dodgeR: 0.8, hitHead: 0.82, hitChest: 0.8, hitStomach: 0.82, hit: 0.9,
  yes: 0.95, celebrate: 0.95, punch: 0.92, kick: 0.92, uppercut: 0.92, surprise: 0.95, cry: 0.97,
};
// instant de l'impact dans les coups (fraction du clip)
const IMPACT = { punch: 0.38, kick: 0.45, uppercut: 0.42 };

const KINDS = {
  monkey: { height: 1.15, walk: 0.68, run: 1.9, radius: 0.32 },
  fighter: { height: 1.76, walk: 1.04, run: 2.9, radius: 0.36 },
};

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

// --------------------------------------------------------------------------- chargement

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const loadGLB = (path) => new Promise((res, rej) => loader.load(path, res, undefined, rej));

// textures réduites à 1024 px : largement suffisant à cette distance et 4× moins de mémoire
function shrinkTextures(root, max = 1024) {
  const done = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
      const t = o.material[key];
      if (!t || done.has(t) || !t.image) continue;
      done.add(t);
      const img = t.image;
      const w = img.width, h = img.height;
      if (!w || Math.max(w, h) <= max) continue;
      const k = max / Math.max(w, h);
      const c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      t.image = c;
      t.needsUpdate = true;
      if (img.close) img.close();
    }
  });
}

// adapte les clips humains au squelette du singe (mêmes os, proportions différentes)
function retargetToMonkey(clip, libHips, monkeyHips) {
  const c = clip.clone();
  c.tracks = c.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === 'mixamorigHips.position');
  for (const t of c.tracks) {
    if (t.name !== 'mixamorigHips.position') continue;
    const v = t.values;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = monkeyHips.x + (v[i] - libHips.x);
      v[i + 1] = monkeyHips.y + (v[i + 1] - libHips.y);
      v[i + 2] = monkeyHips.z + (v[i + 2] - libHips.z);
    }
  }
  return c;
}

// --------------------------------------------------------------------------- un personnage

class Character {
  constructor(kind, name, gltf, clips) {
    this.kind = kind;
    this.name = name;
    this.spec = KINDS[kind];
    this.root = new THREE.Group();
    this.model = skClone(gltf.scene);
    this.root.add(this.model);
    this.mats = [];
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = false;
      o.frustumCulled = false;
      o.material = o.material.clone();
      o.material.transparent = true; // fondu quand le personnage gêne la vue
      o.material.depthWrite = true;
      o.material.side = THREE.FrontSide;
      this.mats.push(o.material);
      this.mesh = o;
    });
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const [key, clip] of Object.entries(clips)) this.actions[key] = this.mixer.clipAction(clip);

    // pieds au sol (pose de repos animée) et taille voulue
    this.actions.idle.play();
    this.mixer.update(0);
    this.model.updateMatrixWorld(true);
    this.mesh.skeleton.update();
    const v = new THREE.Vector3();
    const n = this.mesh.geometry.attributes.position.count;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i += 3) {
      this.mesh.getVertexPosition(i, v);
      v.applyMatrix4(this.mesh.matrixWorld);
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
    this.model.position.y -= minY;
    this.scale = this.spec.height / (maxY - minY) * rnd(0.94, 1.06);
    this.root.scale.setScalar(this.scale);
    this.actions.idle.stop();

    this.cur = null;
    this.curKey = null;
    this.yaw = 0;
    this.yawGoal = 0;
    this.opacity = 1;
    this.active = false;
  }

  has(key) { return !!this.actions[key]; }

  // joue une animation ; once = geste unique qui rend la main ensuite
  play(key, { once = false, fade = 0.25, rate = 1, offset = 0 } = {}) {
    const a = this.actions[key] || this.actions.idle;
    if (!once && this.cur === a && this.cur.isRunning()) { a.timeScale = rate; return 0; }
    a.reset();
    a.timeScale = rate;
    a.time = offset;
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.enabled = true;
    if (this.cur && this.cur !== a) { this.cur.fadeOut(fade); a.fadeIn(fade); }
    a.play();
    this.cur = a;
    this.curKey = this.actions[key] ? key : 'idle';
    const dur = a.getClip().duration;
    return once ? (dur * (END[key] || 0.95)) / rate : dur / rate;
  }

  get x() { return this.root.position.x; }
  get z() { return this.root.position.z; }
}

// --------------------------------------------------------------------------- la troupe

export class Characters {
  constructor(world) {
    this.world = world;
    this.scene = world.scene;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.monkeys = [];
    this.fighters = [];
    this.list = [];       // personnages présents sur le trou
    this.course = null;
    this.interactions = [];
    this.loaded = false;
    this.enabled = true;
    try { this.enabled = localStorage.getItem('cg-chars') !== '0'; } catch (e) { /* rien */ }
    this.group.visible = this.enabled;
    // écrans tactiles (souvent moins puissants) : troupe plus petite
    this.small = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
    try { localStorage.setItem('cg-chars', on ? '1' : '0'); } catch (e) { /* rien */ }
  }

  async load() {
    try {
      const [lib, monkey] = await Promise.all([loadGLB(BASE + 'anims.glb'), loadGLB(BASE + 'monkey.glb')]);
      this.lib = lib;
      const libClips = Object.fromEntries(lib.animations.map((c) => [c.name, c]));
      // singes
      const libHips = lib.scene.getObjectByName('mixamorigHips').position.clone();
      const mHips = monkey.scene.getObjectByName('mixamorigHips').position.clone();
      const own = Object.fromEntries(monkey.animations.map((c) => [c.name, c]));
      const mClips = {};
      for (const [k, n] of Object.entries(LIB)) if (libClips[n]) mClips[k] = retargetToMonkey(libClips[n], libHips, mHips);
      for (const [k, n] of Object.entries(MONKEY_OWN)) if (own[n]) mClips[k] = own[n];
      for (let i = 0; i < 5; i++) this.monkeys.push(new Character('monkey', 'Singe', monkey, mClips));
      this.loaded = true;
      this._fill();
      // combattants, un par un en arrière-plan
      const fClips = {};
      for (const [k, n] of Object.entries(LIB)) if (libClips[n]) fClips[k] = libClips[n];
      const order = [...FIGHTERS].sort(() => Math.random() - 0.5);
      for (const f of order) {
        try {
          const g = await loadGLB(`${BASE}${f.id}.glb`);
          shrinkTextures(g.scene);
          this.fighters.push(new Character('fighter', f.name, g, fClips));
          this._fill();
        } catch (e) { console.warn('personnage', f.id, e); }
      }
    } catch (e) {
      console.warn('Personnages indisponibles', e);
    }
  }

  // nouveau trou : on replace la troupe autour
  setCourse(course, { attract = false } = {}) {
    this.course = course;
    this.attract = attract;
    for (const c of this.list) this._remove(c);
    this.list = [];
    this.interactions = [];
    this.want = attract || this.small ? { fighter: 2, monkey: 3 } : { fighter: 3, monkey: 4 };
    this._fill();
  }

  _remove(c) {
    c.active = false;
    c.inter = null;
    this.group.remove(c.root);
    c.mixer.stopAllAction();
    c.cur = null;
  }

  _fill() {
    if (!this.course || !this.loaded || !this.world.groundHeight) return;
    for (const kind of ['fighter', 'monkey']) {
      const pool = (kind === 'fighter' ? this.fighters : this.monkeys).filter((c) => !c.active);
      const have = this.list.filter((c) => c.kind === kind).length;
      const n = Math.min(pool.length, this.want[kind] - have);
      const choice = pool.sort(() => Math.random() - 0.5).slice(0, Math.max(0, n));
      for (const c of choice) this._spawn(c);
    }
  }

  _spawn(c) {
    const p = this._randomSpot(null, 40);
    if (!p) return;
    c.active = true;
    c.root.position.set(p.x, this.world.groundHeight(p.x, p.z), p.z);
    c.yaw = c.yawGoal = rnd(-Math.PI, Math.PI);
    c.root.rotation.y = c.yaw;
    c.opacity = 1;
    for (const m of c.mats) m.opacity = 1;
    this.group.add(c.root);
    this.list.push(c);
    this._idle(c, rnd(0.5, 4));
    c.play('idle', { offset: rnd(0, 2), rate: rnd(0.9, 1.1), fade: 0 });
  }

  // ------------------------------------------------------------------ navigation
  _blocked(x, z, margin = 0) {
    const w = this.world;
    if (w._courseDist(this.course, x, z) < 0.75 + margin) return true;
    for (const p of w.ponds || []) if (Math.hypot(x - p.x, z - p.z) < p.r + 0.35 + margin) return true;
    for (const o of w.obstacles || []) if (Math.hypot(x - o.x, z - o.z) < o.r + 0.2 + margin) return true;
    return false;
  }

  _segmentClear(x0, z0, x1, z1) {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.3);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (this._blocked(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false;
    }
    return true;
  }

  _randomSpot(from, tries = 20) {
    const b = this.course.bounds;
    const tee = this.course.tee;
    for (let k = 0; k < tries; k++) {
      let x, z;
      if (from) {
        const a = rnd(0, Math.PI * 2), d = rnd(2, 8);
        x = from.x + Math.cos(a) * d; z = from.z + Math.sin(a) * d;
      } else {
        x = rnd(b.minX - 6, b.maxX + 6); z = rnd(b.minZ - 6, b.maxZ + 6);
      }
      if (x < b.minX - 8 || x > b.maxX + 8 || z < b.minZ - 8 || z > b.maxZ + 8) continue;
      if (this._blocked(x, z, 0.1)) continue;
      if (!from && Math.hypot(x - tee.x, z - tee.z) < 2.2) continue;
      if (this.list.some((o) => o.active && Math.hypot(o.x - x, o.z - z) < 1.2)) continue;
      if (from && !this._segmentClear(from.x, from.z, x, z)) continue;
      return { x, z };
    }
    return null;
  }

  // ------------------------------------------------------------------ états
  _idle(c, t = rnd(2, 6)) {
    c.state = 'idle';
    c.timer = t;
    c.target = null;
    c.play('idle', { rate: rnd(0.9, 1.1) });
  }

  _walkTo(c, x, z, run = false) {
    c.state = 'walk';
    c.target = { x, z };
    c.run = run;
    c.timer = 25;
    c.play(run ? 'run' : 'walk', { rate: run ? 0.9 : 1 });
  }

  _gesture(c, key, next = null, opts = {}) {
    c.state = 'gesture';
    c.timer = c.play(key, { once: !opts.loop, rate: opts.rate || 1, fade: 0.2 });
    if (opts.loop) c.timer = opts.duration || rnd(3, 6);
    c.next = next;
  }

  _decide(c) {
    const r = Math.random();
    if (r < 0.42) {
      const p = this._randomSpot(c, 14);
      if (p) { this._walkTo(c, p.x, p.z, c.kind === 'monkey' ? Math.random() < 0.25 : Math.random() < 0.08); return; }
    } else if (r < 0.62) {
      const opts = c.kind === 'monkey'
        ? [['dance', true], ['celebrate', false], ['surprise', false], ['yes', false], ['cry', true]]
        : [['dance', true], ['yes', false], ['celebrate', false], ['kick', false], ['punch', false]];
      const [key, loop] = pick(opts);
      this._gesture(c, key, null, { loop, duration: rnd(2.5, 5) });
      return;
    } else if (r < 0.9 && this._startInteraction(c)) {
      return;
    } else if (r < 0.95 && this._ballPos) {
      // regarde où en est la balle
      c.yawGoal = Math.atan2(this._ballPos.x - c.x, this._ballPos.z - c.z);
    }
    this._idle(c);
  }

  // ------------------------------------------------------------------ interactions
  _startInteraction(a) {
    const others = this.list.filter((o) => o !== a && o.active && !o.inter && (o.state === 'idle' || o.state === 'walk')
      && Math.hypot(o.x - a.x, o.z - a.z) < 9);
    if (!others.length) return false;
    others.sort((u, v) => Math.hypot(u.x - a.x, u.z - a.z) - Math.hypot(v.x - a.x, v.z - a.z));
    const b = others[0];
    // point de rencontre devant le partenaire
    const gap = 0.42 * (a.spec.height + b.spec.height) / 1.76 + 0.32;
    const dx = a.x - b.x, dz = a.z - b.z, d = Math.hypot(dx, dz) || 1;
    let mx = b.x + (dx / d) * gap, mz = b.z + (dz / d) * gap;
    if (this._blocked(mx, mz)) {
      // autre côté
      mx = b.x - (dx / d) * gap; mz = b.z - (dz / d) * gap;
      if (this._blocked(mx, mz)) return false;
    }
    if (!this._segmentClear(a.x, a.z, mx, mz) && d > gap + 0.5) return false;
    const it = { a, b, phase: 'meet', t: 0, steps: [], type: null };
    a.inter = it; b.inter = it;
    this.interactions.push(it);
    if (Math.hypot(mx - a.x, mz - a.z) > 0.15) this._walkTo(a, mx, mz, Math.hypot(mx - a.x, mz - a.z) > 5 && a.kind === 'monkey');
    else a.state = 'wait';
    b.state = 'wait';
    b.timer = 12;
    b.target = null;
    b.play('idle');
    return true;
  }

  _beginScene(it) {
    const { a, b } = it;
    a.state = 'scene'; b.state = 'scene';
    it.phase = 'scene';
    it.t = 0;
    const face = (u, v) => { u.yawGoal = Math.atan2(v.x - u.x, v.z - u.z); };
    face(a, b); face(b, a);
    const type = pick(['fight', 'fight', 'fight', 'dance', 'dance', 'chat', 'chat', 'cheer']);
    it.type = type;
    const steps = [];
    let t = 0.4;
    const add = (who, key, opts = {}) => steps.push({ at: t, who, key, ...opts });
    const dur = (c, key, once = true) => {
      const a2 = c.actions[key];
      if (!a2) return 1;
      return a2.getClip().duration * (once ? (END[key] || 0.95) : 1);
    };
    if (type === 'fight') {
      let att = Math.random() < 0.5 ? 'a' : 'b';
      const rounds = 2 + Math.floor(Math.random() * 3);
      for (let r = 0; r < rounds; r++) {
        const A = att === 'a' ? a : b, D = att === 'a' ? b : a;
        const move = pick(['punch', 'punch', 'kick', 'uppercut']);
        add(att, move, { once: true });
        const impact = t + dur(A, move) * IMPACT[move];
        const dodge = Math.random() < 0.3;
        const react = dodge ? pick(['dodgeL', 'dodgeR']) : (move === 'kick' ? pick(['hitStomach', 'hit']) : move === 'uppercut' ? 'hit' : pick(['hitHead', 'hitChest']));
        steps.push({ at: dodge ? impact - 0.25 : impact, who: att === 'a' ? 'b' : 'a', key: react, once: true });
        t += Math.max(dur(A, move), 0.4 + dur(D, react) * 0.6) + rnd(0.15, 0.5);
        if (Math.random() < 0.6) att = att === 'a' ? 'b' : 'a';
      }
      // fin : l'un fête, l'autre boude (ou pleure s'il est singe)
      const win = Math.random() < 0.5 ? 'a' : 'b', lose = win === 'a' ? 'b' : 'a';
      const W = win === 'a' ? a : b, L = lose === 'a' ? a : b;
      add(win, pick(['celebrate', 'yes', 'dance']), { once: true });
      if (L.has('cry')) add(lose, 'cry', { once: true });
      else add(lose, 'hitStomach', { once: true });
      t += Math.max(dur(W, 'celebrate'), 2.5);
    } else if (type === 'dance') {
      const d = rnd(4, 7);
      add('a', 'dance', { loop: true });
      add('b', 'dance', { loop: true });
      t += d;
    } else if (type === 'chat') {
      for (let k = 0; k < 3; k++) {
        const who = k % 2 ? 'b' : 'a';
        add(who, 'yes', { once: true });
        t += dur(who === 'a' ? a : b, 'yes') * 0.9 + rnd(0.2, 0.8);
      }
    } else { // cheer
      add('a', 'celebrate', { once: true });
      t += 0.6;
      add('b', pick(['dance', 'yes']), { once: true, loop: false });
      t += Math.max(dur(a, 'celebrate'), 3);
    }
    it.steps = steps.sort((u, v) => u.at - v.at);
    it.end = t + 0.3;
  }

  _updateInteraction(it, dt) {
    const { a, b } = it;
    if (!a.active || !b.active) { this._endInteraction(it); return; }
    if (it.phase === 'meet') {
      b.yawGoal = Math.atan2(a.x - b.x, a.z - b.z);
      if (a.state === 'wait' || (a.state === 'idle')) {
        if (Math.hypot(a.x - b.x, a.z - b.z) < 2.2) this._beginScene(it);
        else this._endInteraction(it);
      } else if (b.timer <= 0) this._endInteraction(it);
      return;
    }
    it.t += dt;
    // garder le regard l'un vers l'autre
    a.yawGoal = Math.atan2(b.x - a.x, b.z - a.z);
    b.yawGoal = Math.atan2(a.x - b.x, a.z - b.z);
    while (it.steps.length && it.steps[0].at <= it.t) {
      const s = it.steps.shift();
      const c = s.who === 'a' ? a : b;
      c.play(s.key, { once: !s.loop, fade: 0.15, rate: s.rate || 1 });
      c.sceneUntil = it.t + (s.loop ? 99 : c.actions[s.key] ? c.actions[s.key].getClip().duration * (END[s.key] || 0.95) : 1);
    }
    for (const c of [a, b]) {
      if (c.sceneUntil && it.t > c.sceneUntil) { c.sceneUntil = 0; c.play('idle', { fade: 0.3 }); }
    }
    if (it.t > it.end) this._endInteraction(it);
  }

  _endInteraction(it) {
    this.interactions = this.interactions.filter((q) => q !== it);
    for (const c of [it.a, it.b]) {
      c.inter = null;
      c.sceneUntil = 0;
      if (c.active) this._idle(c, rnd(1.5, 4));
    }
  }

  // ------------------------------------------------------------------ réactions au jeu
  react(type, data = {}) {
    if (!this.list.length || !this.enabled) return;
    const pos = data.x != null ? data : this._ballPos;
    for (const c of this.list) {
      if (!c.active) continue;
      const d = pos ? Math.hypot(c.x - pos.x, c.z - pos.z) : 0;
      let key = null, p = 0;
      if (type === 'holed') {
        const tier = data.tier;
        if (tier === 'ace' || tier === 'great') { key = c.kind === 'monkey' ? pick(['celebrate', 'dance']) : pick(['celebrate', 'dance', 'yes']); p = 0.95; }
        else if (tier === 'good') { key = pick(['celebrate', 'yes', 'dance']); p = 0.75; }
        else if (tier === 'par') { key = 'yes'; p = 0.4; }
        else { key = c.kind === 'monkey' ? pick(['cry', 'surprise']) : 'hitHead'; p = 0.45; }
        if (d > 25) p *= 0.5;
      } else if (type === 'water' || type === 'splash') {
        if (d < 9) { key = c.kind === 'monkey' ? 'surprise' : pick(['hitHead', 'dodgeL', 'dodgeR']); p = type === 'water' ? 0.8 : 0.35; }
      } else if (type === 'oob') {
        if (d < 12) { key = c.kind === 'monkey' ? pick(['surprise', 'cry']) : 'hitHead'; p = 0.7; }
      } else if (type === 'shot') {
        if (d < 7 && (c.state === 'idle' || c.state === 'wait')) c.yawGoal = Math.atan2(pos.x - c.x, pos.z - c.z);
        continue;
      }
      if (!key || Math.random() > p) continue;
      if (c.inter) this._endInteraction(c.inter);
      if (pos) c.yawGoal = Math.atan2(pos.x - c.x, pos.z - c.z);
      const delay = rnd(0, 0.35);
      c.state = 'react';
      c.timer = delay;
      c.pending = key;
    }
  }

  // ------------------------------------------------------------------ boucle
  update(dt, ctx) {
    if (!this.list.length || !this.enabled) return;
    this._ballPos = ctx.ball;
    const cam = this.world.camera.position;
    const tgt = ctx.target;

    for (const it of [...this.interactions]) this._updateInteraction(it, dt);

    for (const c of this.list) {
      if (!c.active) continue;
      c.timer -= dt;
      switch (c.state) {
        case 'idle':
          if (c.timer <= 0) this._decide(c);
          break;
        case 'gesture':
          if (c.timer <= 0) { if (c.next) this._gesture(c, c.next); else this._idle(c); }
          break;
        case 'react':
          if (c.pending && c.timer <= 0) {
            const key = c.pending;
            c.pending = null;
            const loop = key === 'dance' || key === 'cry';
            this._gesture(c, key, null, { loop, duration: rnd(2.5, 4) });
          }
          break;
        case 'walk': {
          const t = c.target;
          const dx = t.x - c.x, dz = t.z - c.z, d = Math.hypot(dx, dz);
          const sp = (c.run ? c.spec.run : c.spec.walk) * (c.scale * 1.95 / c.spec.height);
          if (d < 0.12 || c.timer <= 0) {
            if (c.inter && c.inter.a === c) { c.state = 'wait'; c.play('idle'); }
            else this._idle(c);
            break;
          }
          c.yawGoal = Math.atan2(dx, dz);
          // avance seulement quand le personnage est à peu près tourné dans la bonne direction
          const facing = Math.cos(wrap(c.yawGoal - c.yaw));
          const step = Math.min(d, sp * dt * Math.max(0, facing));
          let nx = c.x + (dx / d) * step, nz = c.z + (dz / d) * step;
          // écart avec les autres
          for (const o of this.list) {
            if (o === c || !o.active || (c.inter && (c.inter.a === o || c.inter.b === o))) continue;
            const ox = nx - o.x, oz = nz - o.z, od = Math.hypot(ox, oz);
            const min = c.spec.radius + o.spec.radius;
            if (od < min && od > 1e-4) { nx += (ox / od) * (min - od) * 0.5; nz += (oz / od) * (min - od) * 0.5; }
          }
          if (!this._blocked(nx, nz, -0.15)) { c.root.position.x = nx; c.root.position.z = nz; }
          else if (!c.inter) this._idle(c, rnd(0.5, 1.5));
          break;
        }
        default: break;
      }

      // orientation
      const dy = wrap(c.yawGoal - c.yaw);
      c.yaw += Math.sign(dy) * Math.min(Math.abs(dy), dt * 5);
      c.root.rotation.y = c.yaw;
      c.root.position.y = this.world.groundHeight(c.x, c.z);

      // fondu si le personnage cache la balle ou colle à la caméra
      let o = 1;
      if (tgt) {
        const hx = c.x, hy = c.root.position.y + c.spec.height * 0.55, hz = c.z;
        const sx = tgt.x - cam.x, sy = tgt.y - cam.y, sz = tgt.z - cam.z;
        const l2 = sx * sx + sy * sy + sz * sz || 1;
        let u = ((hx - cam.x) * sx + (hy - cam.y) * sy + (hz - cam.z) * sz) / l2;
        u = Math.max(0, Math.min(1, u));
        const px = cam.x + sx * u - hx, py = cam.y + sy * u - hy, pz = cam.z + sz * u - hz;
        const dist = Math.sqrt(px * px + py * py + pz * pz);
        if (u > 0.02 && u < 0.97 && dist < c.spec.radius + c.spec.height * 0.35) o = 0.22;
        if (Math.hypot(cam.x - hx, cam.z - hz) < 1.1) o = 0.15;
      }
      c.opacity += (o - c.opacity) * Math.min(1, dt * 6);
      for (const m of c.mats) m.opacity = c.opacity;

      c.mixer.update(dt);
    }
  }
}

