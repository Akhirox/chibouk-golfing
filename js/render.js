// Rendu Three.js : parcours low poly, décor, balles, flèche de visée.
import * as THREE from 'three';
import { TILE, BALL_R, CUP_R, WALL_H, WALL_T, DX, DZ, GROUND_Y } from './constants.js';
import { RNG } from './rng.js';

const HALF = TILE / 2;

export const THEME_STYLES = {
  prairie: {
    skyTop: 0x5fb4ff, skyBottom: 0xd8f0ff, fog: 0xcde9ff,
    ground: 0x7cc35e, ground2: 0x68b24f, carpet: 0x2fa052, wall: 0xf1e6cf, base: 0xb98b5a, trim: 0xff7a1a,
    sun: 0xfff1d8, sunI: 2.3, hemiSky: 0xd6ecff, hemiGround: 0x62904a, hemiI: 1.5, clouds: true,
    water: 0x3aa6df,
  },
  automne: {
    skyTop: 0xf0a25e, skyBottom: 0xffe2b8, fog: 0xf6d3a6,
    ground: 0xb6a050, ground2: 0xa48c3f, carpet: 0x3b9a4c, wall: 0x6f4b33, base: 0x4f3424, trim: 0xff7a1a,
    sun: 0xffd9a8, sunI: 2.2, hemiSky: 0xffe0bd, hemiGround: 0x8a6a3a, hemiI: 1.45, clouds: true,
    water: 0x3b8fc4,
  },
  desert: {
    skyTop: 0x6fb8e8, skyBottom: 0xffe7c2, fog: 0xf7dfb8,
    ground: 0xe6c487, ground2: 0xd8b170, carpet: 0x23927a, wall: 0xc8693a, base: 0x9a4c2b, trim: 0xfff0d6,
    sun: 0xfff0d0, sunI: 2.5, hemiSky: 0xfff3dc, hemiGround: 0xc2965a, hemiI: 1.4, clouds: false,
    water: 0x22b5c2,
  },
  neige: {
    skyTop: 0x8ec5f2, skyBottom: 0xeef6ff, fog: 0xe4f0fb,
    ground: 0xf4f8fc, ground2: 0xe2ebf3, carpet: 0x2d7fd0, wall: 0x8b5a3c, base: 0x5d3c28, trim: 0xff7a1a,
    sun: 0xffffff, sunI: 2.0, hemiSky: 0xeaf4ff, hemiGround: 0xb9c8d6, hemiI: 1.6, clouds: true,
    water: 0x6fd3e6,
  },
  crepuscule: {
    skyTop: 0x1d1233, skyBottom: 0xa8524e, fog: 0x4a2c44,
    ground: 0x3a5a45, ground2: 0x2f4c3a, carpet: 0x34a066, wall: 0x1c1c1f, base: 0x111113, trim: 0xff7a1a,
    sun: 0xffb27a, sunI: 2.1, hemiSky: 0xb79ad0, hemiGround: 0x3a3a46, hemiI: 1.5, clouds: false, stars: true, lamps: true,
    water: 0x2d6aa6,
  },
};

const _c = new THREE.Color();
function col(hex, jitter = 0, rng = null) {
  _c.set(hex);
  if (jitter && rng) {
    const k = 1 + rng.float(-jitter, jitter);
    return [_c.r * k, _c.g * k, _c.b * k];
  }
  return [_c.r, _c.g, _c.b];
}

// Petit constructeur de géométrie non indexée avec couleurs par sommet
class Geo {
  constructor() { this.p = []; this.c = []; }
  tri(a, b, c, color, hint) {
    if (hint) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { const t = b; b = c; c = t; }
    }
    this.p.push(...a, ...b, ...c);
    this.c.push(...color, ...color, ...color);
  }
  quad(a, b, c, d, color, hint, color2) {
    this.tri(a, b, c, color, hint);
    this.tri(a, c, d, color2 || color, hint);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    return g;
  }
}

// Bruit de valeur simple pour le relief du décor
function makeNoise(seed) {
  const rng = new RNG(seed);
  const perm = new Float32Array(512);
  for (let i = 0; i < 512; i++) perm[i] = rng.next();
  const h = (i, j) => perm[((i * 73856093) ^ (j * 19349663)) & 511];
  return (x, z) => {
    const i = Math.floor(x), j = Math.floor(z);
    const fx = x - i, fz = z - j;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
}

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.03, 400);
    this.camera.position.set(4, 4, 4);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.4);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.sky = this._makeSky();
    this.scene.add(this.sky);

    this.courseGroup = null;
    this.animated = [];
    this.balls = new Map();
    this._makeAim();
    this._makeRing();

    this.ballGeo = new THREE.IcosahedronGeometry(BALL_R, 2);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _makeSky() {
    const g = new THREE.SphereGeometry(180, 24, 12);
    const colors = new Float32Array(g.attributes.position.count * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = -10;
    return mesh;
  }

  _paintSky(top, bottom) {
    const g = this.sky.geometry;
    const pos = g.attributes.position, colAttr = g.attributes.color;
    const a = new THREE.Color(top), b = new THREE.Color(bottom), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 180;
      const t = Math.pow(Math.max(0, y), 0.6);
      c.copy(b).lerp(a, t);
      colAttr.setXYZ(i, c.r, c.g, c.b);
    }
    colAttr.needsUpdate = true;
  }

  _makeAim() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 });
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.045), mat);
    shaft.rotation.x = -Math.PI / 2;
    shaft.position.x = 0.5;
    const shaftWrap = new THREE.Group();
    shaftWrap.add(shaft);
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.085); shape.lineTo(0.16, 0); shape.lineTo(0, 0.085); shape.lineTo(0, -0.085);
    const head = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
    head.rotation.x = -Math.PI / 2;
    g.add(shaftWrap, head);
    g.renderOrder = 10;
    shaft.renderOrder = 10; head.renderOrder = 10;
    g.visible = false;
    this.aim = { group: g, shaftWrap, head, mat };
    this.scene.add(g);
  }

  _makeRing() {
    const m = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.8, depthTest: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(BALL_R * 1.7, BALL_R * 2.1, 32), m);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 9;
    ring.visible = false;
    this.ring = ring;
    this.scene.add(ring);
  }

  showAim(x, y, z, angle, power) {
    const a = this.aim;
    a.group.visible = true;
    a.group.position.set(x, y - BALL_R + 0.012, z);
    a.group.rotation.y = -angle;
    const len = 0.18 + power * 1.7;
    a.shaftWrap.scale.set(len, 1, 1);
    a.shaftWrap.position.x = BALL_R * 1.4;
    a.head.position.x = BALL_R * 1.4 + len;
    const c = new THREE.Color(0xffffff);
    if (power < 0.6) c.lerp(new THREE.Color(0xff7a1a), power / 0.6);
    else c.set(0xff7a1a).lerp(new THREE.Color(0xe02b20), (power - 0.6) / 0.4);
    a.mat.color.copy(c);
  }

  hideAim() { this.aim.group.visible = false; }

  showRing(x, y, z, t) {
    this.ring.visible = true;
    this.ring.position.set(x, y - BALL_R + 0.008, z);
    const s = 1 + 0.15 * Math.sin(t * 4);
    this.ring.scale.set(s, s, s);
  }
  hideRing() { this.ring.visible = false; }

  // ---------------------------------------------------------------- balles
  addBall(id, color, ghost = false) {
    this.removeBall(id);
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.38, metalness: 0.05, flatShading: true,
      transparent: ghost, opacity: ghost ? 0.62 : 1,
    });
    const mesh = new THREE.Mesh(this.ballGeo, mat);
    mesh.castShadow = !ghost;
    this.scene.add(mesh);
    this.balls.set(id, mesh);
    return mesh;
  }
  setBallColor(id, color) {
    const m = this.balls.get(id);
    if (m) m.material.color.set(color);
  }
  removeBall(id) {
    const m = this.balls.get(id);
    if (m) { this.scene.remove(m); m.material.dispose(); this.balls.delete(id); }
  }
  clearBalls() { for (const id of [...this.balls.keys()]) this.removeBall(id); }

  // ---------------------------------------------------------------- parcours
  setCourse(course) {
    if (this.courseGroup) {
      this.scene.remove(this.courseGroup);
      this.courseGroup.traverse((o) => {
        if (o.geometry && o.geometry !== this.ballGeo) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
    }
    this.animated = [];
    this.course = course;
    const def = course.def;
    const st = THEME_STYLES[def.theme] || THEME_STYLES.prairie;
    this.style = st;
    const rng = new RNG(def.decorSeed || 1);
    const group = new THREE.Group();
    this.courseGroup = group;

    // ambiance
    this._paintSky(st.skyTop, st.skyBottom);
    this.scene.fog = new THREE.Fog(st.fog, 30, 110);
    this.hemi.color.set(st.hemiSky); this.hemi.groundColor.set(st.hemiGround); this.hemi.intensity = st.hemiI;
    this.sun.color.set(st.sun); this.sun.intensity = st.sunI;

    const b = course.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const ext = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 4;
    this.center = new THREE.Vector3(cx, (b.minL + b.maxL) / 2, cz);
    this.extent = ext;
    this.sun.position.set(cx - 10, 18, cz + 7);
    this.sun.target.position.set(cx, 0, cz);
    const sc = this.sun.shadow.camera;
    sc.left = -ext - 6; sc.right = ext + 6; sc.top = ext + 6; sc.bottom = -ext - 6;
    sc.near = 1; sc.far = 60;
    sc.updateProjectionMatrix();

    const lambert = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const decalMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

    // --- surface de jeu
    const surf = new Geo();
    const S = 8;
    for (const c of course.cells) {
      if (c === course.cupCell) { this._cupSurface(course, c, surf, st, rng); continue; }
      for (let a = 0; a < S; a++) {
        for (let k = 0; k < S; k++) {
          const x0 = c.cx - HALF + (a / S) * TILE, x1 = c.cx - HALF + ((a + 1) / S) * TILE;
          const z0 = c.cz - HALF + (k / S) * TILE, z1 = c.cz - HALF + ((k + 1) / S) * TILE;
          const p00 = [x0, course.heightCell(c, x0, z0), z0];
          const p01 = [x0, course.heightCell(c, x0, z1), z1];
          const p11 = [x1, course.heightCell(c, x1, z1), z1];
          const p10 = [x1, course.heightCell(c, x1, z0), z0];
          const tint = this._heightTint((p00[1] + p11[1]) / 2);
          surf.quad(p00, p01, p11, p10, col(st.carpet, 0.05, rng).map((v) => v * tint), [0, 1, 0], col(st.carpet, 0.05, rng).map((v) => v * tint));
        }
      }
    }
    const surfMesh = new THREE.Mesh(surf.build(), lambert);
    surfMesh.receiveShadow = true;
    group.add(surfMesh);

    // --- bordures
    const walls = new Geo();
    for (const s of course.wallList) this._wall(course, s, walls, st, rng);
    // piliers aux angles saillants
    for (const c of course.cells) {
      for (let s = 0; s < 4; s++) {
        const s2 = (s + 1) % 4;
        if (!c.walls.includes(s) || !c.walls.includes(s2)) continue;
        const di = DX[s] + DX[s2], dj = DZ[s] + DZ[s2];
        if (course.map.has(((c.i + di + 512) << 10) | (c.j + dj + 512))) continue;
        const ox = c.cx + di * HALF, oz = c.cz + dj * HALF;
        const top = course.heightCell(c, ox - di * 0.01, oz - dj * 0.01) + WALL_H;
        this._box(walls, ox + di * WALL_T / 2, oz + dj * WALL_T / 2, WALL_T / 2, WALL_T / 2, GROUND_Y - 0.05, top, st, rng);
      }
    }
    const wallMesh = new THREE.Mesh(walls.build(), lambert);
    wallMesh.castShadow = true; wallMesh.receiveShadow = true;
    group.add(wallMesh);

    // --- obstacles
    const obs = new Geo();
    for (const bl of course.blocks) {
      const base = course.heightCell(bl.cell, bl.x, bl.z) - 0.05;
      this._box(obs, bl.x, bl.z, bl.hx, bl.hz, base, base + 0.05 + bl.h, st, rng);
    }
    const obsMesh = new THREE.Mesh(obs.build(), lambert);
    obsMesh.castShadow = true; obsMesh.receiveShadow = true;
    group.add(obsMesh);

    const postMat = new THREE.MeshLambertMaterial({ color: 0xf5f5f0, flatShading: true });
    const capMat = new THREE.MeshLambertMaterial({ color: st.trim, flatShading: true });
    for (const p of course.posts) {
      if (p.hub) continue;
      const base = course.heightCell(p.cell, p.x, p.z) - 0.08;
      const h = p.h + 0.08;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 1.06, h, 9), postMat);
      m.position.set(p.x, base + h / 2, p.z);
      m.castShadow = true; m.receiveShadow = true;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.75, p.r, 0.06, 9), capMat);
      cap.position.set(p.x, base + h + 0.03, p.z);
      cap.castShadow = true;
      group.add(m, cap);
    }

    // moulinets
    for (const m of course.mills) {
      const base = course.heightCell(m.cell, m.x, m.z);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.32, 8), new THREE.MeshLambertMaterial({ color: st.wall === 0x1c1c1f ? 0x333338 : st.wall, flatShading: true }));
      hub.position.set(m.x, base + 0.16, m.z);
      hub.castShadow = true;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.18, 6), capMat);
      roof.position.set(m.x, base + 0.41, m.z);
      roof.castShadow = true;
      const arm = new THREE.Group();
      const bar = new THREE.Mesh(new THREE.BoxGeometry(m.half * 2, 0.07, 0.07), capMat);
      bar.position.y = 0.075;
      bar.castShadow = true;
      const bar2 = new THREE.Mesh(new THREE.BoxGeometry(m.half * 2 - 0.05, 0.02, 0.09), postMat);
      bar2.position.y = 0.12;
      arm.add(bar, bar2);
      arm.position.set(m.x, base, m.z);
      group.add(hub, roof, arm);
      this.animated.push((t) => { arm.rotation.y = -(m.phase + m.omega * t); });
    }

    // sable
    if (course.sands.length) {
      const sg = new Geo();
      for (const s of course.sands) this._disc(course, s.cell, s.x, s.z, s.r, sg, 0xe9d29a, rng, 0.004);
      const sm = new THREE.Mesh(sg.build(), decalMat);
      sm.receiveShadow = true;
      group.add(sm);
    }

    // eau sur le parcours
    this.waterAnims = [];
    if (course.waters.length) this._courseWater(course, group, st);

    // tapis de départ
    {
      const tg = new Geo();
      const c = course.teeCell;
      const d = c.dout;
      const t = course.tee;
      const pts = [[-0.28, -0.28], [0.28, -0.28], [0.28, 0.28], [-0.28, 0.28]].map(([u, v]) => {
        const x = t.x + DX[d] * u - DZ[d] * v, z = t.z + DZ[d] * u + DX[d] * v;
        return [x, course.heightCell(c, x, z) + 0.004, z];
      });
      tg.quad(pts[0], pts[1], pts[2], pts[3], col(st.carpet, 0, null).map((v) => v * 0.6), [0, 1, 0]);
      const tm = new THREE.Mesh(tg.build(), decalMat);
      tm.receiveShadow = true;
      group.add(tm);
    }

    // trou + drapeau
    this._cup(course, group, st);

    // sol et décor
    this._ground(course, group, st, rng);
    this._decor(course, group, st, rng);

    this.scene.add(group);
  }

  // le gazon s'éclaircit avec l'altitude : les rampes se lisent mieux
  _heightTint(h) {
    return 0.9 + Math.max(0, Math.min(1.4, h - 0.2)) * 0.22;
  }

  _cupSurface(course, c, geo, st, rng) {
    const cu = course.cup.x - c.cx, cv = course.cup.z - c.cz;
    // angles réguliers + angles exacts des coins de la case
    const angles = [];
    const K = 40;
    for (let k = 0; k < K; k++) angles.push((k / K) * Math.PI * 2);
    for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      let a = Math.atan2(sz * HALF - cv, sx * HALF - cu);
      if (a < 0) a += Math.PI * 2;
      angles.push(a);
    }
    angles.sort((a, b) => a - b);
    const boundR = (a) => {
      const ca = Math.cos(a), sa = Math.sin(a);
      let t = Infinity;
      if (ca > 1e-9) t = Math.min(t, (HALF - cu) / ca);
      if (ca < -1e-9) t = Math.min(t, (-HALF - cu) / ca);
      if (sa > 1e-9) t = Math.min(t, (HALF - cv) / sa);
      if (sa < -1e-9) t = Math.min(t, (-HALF - cv) / sa);
      return t;
    };
    const M = 7;
    const ring = (a, m) => {
      const R = boundR(a);
      const r = CUP_R + (R - CUP_R) * Math.pow(m / M, 1.6);
      const x = course.cup.x + Math.cos(a) * r, z = course.cup.z + Math.sin(a) * r;
      return [x, course.heightCell(c, x, z), z];
    };
    for (let k = 0; k < angles.length; k++) {
      const a0 = angles[k], a1 = angles[(k + 1) % angles.length] + (k + 1 === angles.length ? Math.PI * 2 : 0);
      if (a1 - a0 < 1e-6) continue;
      for (let m = 0; m < M; m++) {
        const tint = this._heightTint(ring(a0, m)[1]);
        geo.quad(ring(a0, m), ring(a0, m + 1), ring(a1, m + 1), ring(a1, m), col(st.carpet, 0.05, rng).map((v) => v * tint), [0, 1, 0], col(st.carpet, 0.05, rng).map((v) => v * tint));
      }
    }
  }

  _cup(course, group, st) {
    const { x, z } = course.cup;
    const h = course.heightCell(course.cupCell, x, z);
    const depth = 0.14;
    const inner = new THREE.Mesh(
      new THREE.CylinderGeometry(CUP_R, CUP_R, depth, 28, 1, true),
      new THREE.MeshLambertMaterial({ color: 0x2a2a2a, side: THREE.BackSide }),
    );
    inner.position.set(x, h - depth / 2 + 0.002, z);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(CUP_R, 28), new THREE.MeshBasicMaterial({ color: 0x0b0b0b }));
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.set(x, h - depth + 0.002, z);
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(CUP_R, CUP_R + 0.014, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(x, h + 0.003, z);
    group.add(inner, bottom, rim);

    // drapeau
    const flag = new THREE.Group();
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xfafafa, transparent: true });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 1.1, 6), poleMat);
    pole.position.y = 0.55 - depth + 0.02;
    pole.castShadow = true;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(0.34, -0.1); shape.lineTo(0, -0.2); shape.lineTo(0, 0);
    const flagMat = new THREE.MeshLambertMaterial({ color: st.trim === 0xfff0d6 ? 0xff7a1a : st.trim, side: THREE.DoubleSide, transparent: true });
    const cloth = new THREE.Mesh(new THREE.ShapeGeometry(shape), flagMat);
    cloth.position.y = 1.1 - depth + 0.02;
    cloth.castShadow = true;
    flag.add(pole, cloth);
    flag.position.set(x, h, z);
    group.add(flag);
    this.flag = { group: flag, cloth, mats: [poleMat, flagMat] };
    this.animated.push((t) => { cloth.rotation.y = Math.sin(t * 2.1) * 0.35 + 0.4; });
  }

  // --------------------------------------------------------------- eau
  _courseWater(course, group, st) {
    const bedCol = new THREE.Color(st.water).multiplyScalar(0.42);
    const bedMat = new THREE.MeshLambertMaterial({ color: bedCol, flatShading: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const bankMat = new THREE.MeshLambertMaterial({ color: 0xd9cdb4, flatShading: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const waterMat = new THREE.MeshStandardMaterial({
      color: st.water, transparent: true, opacity: 0.78, roughness: 0.14, metalness: 0.05, flatShading: true, depthWrite: false,
    });
    for (const w of course.waters) {
      const c = w.cell;
      const H = c.level;
      // points de la forme (grille) dans le repère local
      const pts = [];
      let nu, nv;
      if (w.type === 'pond') {
        nu = 22; nv = 3;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
          const a = (i / nu) * Math.PI * 2, rr = (w.r * j) / nv;
          pts.push([w.x + Math.cos(a) * rr, w.z + Math.sin(a) * rr, j === nv]);
        }
      } else {
        nu = 4; nv = 10;
        const lx = -w.az, lz = w.ax;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
          const u = -w.ha + (2 * w.ha * i) / nu, v = -TILE / 2 + (TILE * j) / nv;
          pts.push([w.x + w.ax * u + lx * v, w.z + w.az * u + lz * v, i === 0 || i === nu]);
        }
      }
      const mk = (y) => {
        const gb = new Geo();
        const P = (i, j) => { const q = pts[j * (nu + 1) + i]; return [q[0], y, q[1]]; };
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
          gb.quad(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), [1, 1, 1], [0, 1, 0]);
        }
        const g = gb.build();
        g.deleteAttribute('color');
        return g;
      };
      const bed = new THREE.Mesh(mk(H + 0.002), bedMat);
      bed.receiveShadow = true;
      const geo = mk(H + 0.008);
      const surf = new THREE.Mesh(geo, waterMat);
      surf.renderOrder = 2;
      group.add(bed, surf);
      // berges en pierres claires
      const bank = new Geo();
      if (w.type === 'pond') {
        const K = 26;
        for (let k = 0; k < K; k++) {
          const a0 = (k / K) * Math.PI * 2, a1 = ((k + 1) / K) * Math.PI * 2;
          const P = (a, rr, y) => [w.x + Math.cos(a) * rr, y, w.z + Math.sin(a) * rr];
          bank.quad(P(a0, w.r - 0.01, H + 0.012), P(a0, w.r + 0.05, H + 0.012), P(a1, w.r + 0.05, H + 0.012), P(a1, w.r - 0.01, H + 0.012), [0.85, 0.8, 0.7], [0, 1, 0]);
        }
      } else {
        const lx = -w.az, lz = w.ax;
        for (const sgn of [-1, 1]) {
          const u0 = sgn * (w.ha - 0.01), u1 = sgn * (w.ha + 0.05);
          const P = (u, v) => [w.x + w.ax * u + lx * v, H + 0.012, w.z + w.az * u + lz * v];
          bank.quad(P(u0, -TILE / 2), P(u1, -TILE / 2), P(u1, TILE / 2), P(u0, TILE / 2), [0.85, 0.8, 0.7], [0, 1, 0]);
        }
      }
      const bm = new THREE.Mesh(bank.build(), bankMat);
      bm.receiveShadow = true;
      group.add(bm);
      // vagues : on anime les sommets de la surface
      const pos = geo.attributes.position;
      const base = Float32Array.from(pos.array);
      this.waterAnims.push((t) => {
        for (let k = 0; k < pos.count; k++) {
          const x = base[k * 3], z = base[k * 3 + 2];
          pos.array[k * 3 + 1] = base[k * 3 + 1] + 0.0035 * (Math.sin(x * 9 + t * 2.3) + Math.sin(z * 11 - t * 1.9));
        }
        pos.needsUpdate = true;
      });
    }
  }

  _decorPond(p, group, st, theme) {
    const frozen = theme === 'neige';
    const K = 28, M = 4;
    const geo = new Geo();
    const rng = new RNG(Math.floor(p.x * 1000 + p.z * 7));
    const wob = Array.from({ length: K }, () => 1 + rng.float(-0.06, 0.06));
    const P = (k, m) => {
      const a = ((k % K) / K) * Math.PI * 2, rr = (p.r * m) / M * wob[k % K];
      return [p.x + Math.cos(a) * rr, p.level, p.z + Math.sin(a) * rr];
    };
    const c = col(frozen ? 0xcfeaf7 : st.water);
    for (let k = 0; k < K; k++) for (let m = 0; m < M; m++) {
      if (m === 0) geo.tri(P(k, 0), P(k, 1), P(k + 1, 1), c, [0, 1, 0]);
      else geo.quad(P(k, m), P(k, m + 1), P(k + 1, m + 1), P(k + 1, m), c, [0, 1, 0]);
    }
    const mat = frozen
      ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.1, flatShading: true })
      : new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.85, roughness: 0.12, flatShading: true, depthWrite: false });
    const g = geo.build();
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    group.add(mesh);
    if (!frozen) {
      const pos = g.attributes.position, base = Float32Array.from(pos.array);
      this.animated.push((t) => {
        for (let k = 0; k < pos.count; k++) {
          const x = base[k * 3], z = base[k * 3 + 2];
          pos.array[k * 3 + 1] = base[k * 3 + 1] + 0.012 * (Math.sin(x * 2.1 + t * 1.3) + Math.sin(z * 2.7 - t * 1.1));
        }
        pos.needsUpdate = true;
      });
      // nénuphars et roseaux
      const pad = new THREE.MeshLambertMaterial({ color: 0x4f9a3f, flatShading: true });
      const reed = new THREE.MeshLambertMaterial({ color: theme === 'automne' ? 0x9a7a3a : 0x3f7a35, flatShading: true });
      const flower = new THREE.MeshLambertMaterial({ color: 0xff9ac4, flatShading: true });
      for (let k = 0; k < rng.int(3, 6); k++) {
        const a = rng.float(0, Math.PI * 2), rr = rng.float(0.2, 0.75) * p.r, s = rng.float(0.16, 0.28);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(s, s, 0.015, 9, 1, false, 0.3, Math.PI * 1.8), pad);
        m.position.set(p.x + Math.cos(a) * rr, p.level + 0.02, p.z + Math.sin(a) * rr);
        m.rotation.y = rng.float(0, Math.PI * 2);
        group.add(m);
        if (rng.chance(0.4)) {
          const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), flower);
          f.position.set(m.position.x, p.level + 0.06, m.position.z);
          group.add(f);
        }
      }
      for (let k = 0; k < rng.int(2, 4); k++) {
        const a = rng.float(0, Math.PI * 2);
        for (let q = 0; q < 5; q++) {
          const rr = p.r * rng.float(0.9, 1.05), aa = a + rng.float(-0.2, 0.2), hgt = rng.float(0.4, 0.8);
          const m = new THREE.Mesh(new THREE.ConeGeometry(0.025, hgt, 4), reed);
          m.position.set(p.x + Math.cos(aa) * rr, p.level + hgt / 2 - 0.05, p.z + Math.sin(aa) * rr);
          m.rotation.z = rng.float(-0.15, 0.15);
          m.castShadow = true;
          group.add(m);
        }
      }
    }
  }

  // --------------------------------------------------------------- éclaboussures
  _initFx() {
    const n = 90;
    this.drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xeaf8ff, transparent: true, opacity: 0.9 }), n);
    this.drops.frustumCulled = false;
    this.drops.count = 0;
    this.dropData = [];
    this.scene.add(this.drops);
    this.ripples = [];
    const rg = new THREE.RingGeometry(0.8, 1, 24);
    rg.rotateX(-Math.PI / 2);
    for (let k = 0; k < 10; k++) {
      const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false;
      m.renderOrder = 3;
      this.scene.add(m);
      this.ripples.push({ m, t: 1, life: 1, size: 0.3 });
    }
    this._dummy = new THREE.Object3D();
  }

  splash(x, y, z, strength = 1) {
    if (!this.drops) this._initFx();
    const k = Math.min(1.6, Math.max(0.25, strength));
    const count = Math.round(6 + 10 * k);
    for (let i = 0; i < count && this.dropData.length < 90; i++) {
      const a = Math.random() * Math.PI * 2, sp = (0.3 + Math.random() * 0.8) * k;
      this.dropData.push({
        x, y, z, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: (1.0 + Math.random() * 1.4) * k,
        s: 0.005 + Math.random() * 0.008, life: 0.45 + Math.random() * 0.35,
      });
    }
    this.ripple(x, y, z, 0.25 + 0.25 * k);
  }

  ripple(x, y, z, size = 0.2) {
    if (!this.drops) this._initFx();
    const r = this.ripples.find((q) => q.t >= q.life) || this.ripples[0];
    r.t = 0; r.life = 0.9; r.size = size;
    r.m.position.set(x, y, z);
    r.m.visible = true;
  }

  updateFx(dt) {
    if (!this.drops) return;
    const d = this._dummy;
    let n = 0;
    this.dropData = this.dropData.filter((p) => (p.life -= dt) > 0);
    for (const p of this.dropData) {
      p.vy -= 9.81 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      d.position.set(p.x, p.y, p.z);
      d.scale.setScalar(p.s * Math.min(1, p.life * 3));
      d.updateMatrix();
      this.drops.setMatrixAt(n++, d.matrix);
    }
    this.drops.count = n;
    this.drops.instanceMatrix.needsUpdate = true;
    for (const r of this.ripples) {
      if (r.t >= r.life) { r.m.visible = false; continue; }
      r.t += dt;
      const k = r.t / r.life;
      const s = r.size * (0.3 + k * 1.4);
      r.m.scale.set(s, 1, s);
      r.m.material.opacity = 0.55 * (1 - k);
    }
  }

  setFlagOpacity(o) {
    if (!this.flag) return;
    for (const m of this.flag.mats) { m.opacity = o; m.depthWrite = o > 0.9; }
  }

  _wall(course, s, geo, st, rng) {
    const c = s.cell;
    const ex = s.bx - s.ax, ez = s.bz - s.az;
    const len = Math.hypot(ex, ez);
    // normale vers l'extérieur de la case
    let nx = -ez / len, nz = ex / len;
    const mx = (s.ax + s.bx) / 2, mz = (s.az + s.bz) / 2;
    if ((mx - c.cx) * nx + (mz - c.cz) * nz < 0) { nx = -nx; nz = -nz; }
    const chamfer = s.kind === 'chamfer';
    const n = Math.max(2, Math.ceil(len / 0.25));
    const wallC = col(st.wall, 0.04, rng), baseC = col(st.base, 0.05, rng), trimC = col(st.trim, 0.03, rng);
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = s.ax + ex * t, z = s.az + ez * t;
      const hs = course.heightCell(c, x - nx * 0.002, z - nz * 0.002);
      pts.push({ x, z, hs, top: hs + WALL_H, bot: chamfer ? hs - 0.05 : GROUND_Y - 0.05 });
    }
    const T = chamfer ? WALL_T * 0.8 : WALL_T;
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[k + 1];
      const ai = (y) => [a.x, y, a.z], bi = (y) => [b.x, y, b.z];
      const ao = (y) => [a.x + nx * T, y, a.z + nz * T], bo = (y) => [b.x + nx * T, y, b.z + nz * T];
      // face intérieure (au-dessus du gazon)
      geo.quad(ai(a.hs - 0.02), bi(b.hs - 0.02), bi(b.top), ai(a.top), wallC, [-nx, 0, -nz]);
      // dessus
      geo.quad(ai(a.top), bi(b.top), bo(b.top), ao(a.top), trimC, [0, 1, 0]);
      // face extérieure : soubassement + bordure
      if (!chamfer) {
        geo.quad(ao(a.bot), bo(b.bot), bo(b.hs), ao(a.hs), baseC, [nx, 0, nz]);
        geo.quad(ao(a.hs), bo(b.hs), bo(b.top), ao(a.top), wallC, [nx, 0, nz]);
      } else {
        geo.quad(ao(a.bot), bo(b.bot), bo(b.top), ao(a.top), wallC, [nx, 0, nz]);
      }
    }
    // embouts
    const ends = [[pts[0], [-ex / len, -ez / len]], [pts[n], [ex / len, ez / len]]];
    for (const [p, [dx, dz]] of ends) {
      const i0 = [p.x, p.bot, p.z], i1 = [p.x, p.top, p.z];
      const o0 = [p.x + nx * T, p.bot, p.z + nz * T], o1 = [p.x + nx * T, p.top, p.z + nz * T];
      geo.quad(i0, o0, o1, i1, baseC, [dx, 0, dz]);
    }
  }

  _box(geo, x, z, hx, hz, y0, y1, st, rng) {
    const wallC = col(st.wall, 0.04, rng), trimC = col(st.trim, 0.03, rng), baseC = col(st.base, 0.04, rng);
    const P = (sx, y, sz) => [x + sx * hx, y, z + sz * hz];
    geo.quad(P(-1, y1, -1), P(1, y1, -1), P(1, y1, 1), P(-1, y1, 1), trimC, [0, 1, 0]);
    const ym = Math.max(y0, y1 - WALL_H - 0.05);
    const sides = [
      [[1, -1], [1, 1], [1, 0]], [[-1, 1], [-1, -1], [-1, 0]],
      [[1, 1], [-1, 1], [0, 1]], [[-1, -1], [1, -1], [0, -1]],
    ];
    for (const [[ax, az], [bx, bz], [nx, nz]] of sides) {
      geo.quad(P(ax, y0, az), P(bx, y0, bz), P(bx, ym, bz), P(ax, ym, az), baseC, [nx, 0, nz]);
      geo.quad(P(ax, ym, az), P(bx, ym, bz), P(bx, y1, bz), P(ax, y1, az), wallC, [nx, 0, nz]);
    }
  }

  _disc(course, cell, x, z, r, geo, color, rng, lift) {
    const K = 14, M = 3;
    const pt = (a, m) => {
      const rr = (r * m) / M;
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      return [px, course.heightCell(cell, px, pz) + lift, pz];
    };
    for (let k = 0; k < K; k++) {
      const a0 = (k / K) * Math.PI * 2, a1 = ((k + 1) / K) * Math.PI * 2;
      for (let m = 0; m < M; m++) {
        if (m === 0) geo.tri(pt(a0, 0), pt(a0, 1), pt(a1, 1), col(color, 0.05, rng), [0, 1, 0]);
        else geo.quad(pt(a0, m), pt(a0, m + 1), pt(a1, m + 1), pt(a1, m), col(color, 0.05, rng), [0, 1, 0]);
      }
    }
  }

  // distance d'un point au parcours (cases), utile pour le décor
  _courseDist(course, x, z) {
    let best = Infinity;
    for (const c of course.cells) {
      const dx = Math.max(0, Math.abs(x - c.cx) - HALF), dz = Math.max(0, Math.abs(z - c.cz) - HALF);
      const d = Math.hypot(dx, dz);
      if (d < best) best = d;
    }
    return best;
  }

  _ground(course, group, st, rng) {
    const b = course.bounds;
    const M = 26;
    const x0 = b.minX - M, x1 = b.maxX + M, z0 = b.minZ - M, z1 = b.maxZ + M;
    const noise = makeNoise((course.def.decorSeed || 7) + 11);
    const amp = course.def.theme === 'desert' ? 1.1 : 0.7;
    const baseHeight = (x, z) => {
      const d = this._courseDist(course, x, z);
      const fade = Math.min(1, Math.max(0, (d - 1.2) / 5));
      const n = noise(x * 0.12, z * 0.12) * 0.7 + noise(x * 0.35 + 9, z * 0.35 - 4) * 0.3;
      return GROUND_Y - 0.03 + (n - 0.35) * amp * fade + fade * fade * 0.4;
    };
    // mares décoratives autour du parcours
    const prng = new RNG((course.def.decorSeed || 7) + 99);
    this.ponds = [];
    const nPonds = prng.int(1, course.def.theme === 'desert' ? 1 : 2);
    for (let k = 0, tries = 0; k < nPonds && tries < 60; tries++) {
      const r = prng.float(1.6, 2.8);
      const x = prng.float(b.minX - 12, b.maxX + 12), z = prng.float(b.minZ - 12, b.maxZ + 12);
      if (this._courseDist(course, x, z) < r + 2.2) continue;
      if (this.ponds.some((q) => Math.hypot(q.x - x, q.z - z) < q.r + r + 2)) continue;
      let rim = Infinity;
      for (let a = 0; a < 16; a++) rim = Math.min(rim, baseHeight(x + Math.cos(a / 16 * Math.PI * 2) * r * 1.1, z + Math.sin(a / 16 * Math.PI * 2) * r * 1.1));
      this.ponds.push({ x, z, r, level: rim - 0.05, bottom: rim - 0.4 });
      k++;
    }
    this.groundHeight = (x, z) => {
      let h = baseHeight(x, z);
      for (const p of this.ponds) {
        const d = Math.hypot(x - p.x, z - p.z) / p.r;
        if (d < 1.25) {
          const t = Math.min(1, Math.max(0, (d - 0.55) / 0.6));
          h = Math.min(h, p.bottom + (h - p.bottom) * t * t * (3 - 2 * t));
        }
      }
      return h;
    };
    const step = 1.2;
    const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
    const geo = new Geo();
    const H = [];
    for (let j = 0; j <= nz; j++) {
      H.push([]);
      for (let i = 0; i <= nx; i++) {
        const x = x0 + i * step + (j % 2 ? step / 2 : 0), z = z0 + j * step;
        H[j].push([x, this.groundHeight(x, z), z]);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = H[j][i], bb = H[j][i + 1], c = H[j + 1][i], d = H[j + 1][i + 1];
        const c1 = col(rng.chance(0.5) ? st.ground : st.ground2, 0.05, rng);
        const c2 = col(rng.chance(0.5) ? st.ground : st.ground2, 0.05, rng);
        if (j % 2 === 0) { geo.tri(a, bb, c, c1, [0, 1, 0]); geo.tri(bb, d, c, c2, [0, 1, 0]); }
        else { geo.tri(a, bb, d, c1, [0, 1, 0]); geo.tri(a, d, c, c2, [0, 1, 0]); }
      }
    }
    const mesh = new THREE.Mesh(geo.build(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.receiveShadow = true;
    group.add(mesh);

    for (const p of this.ponds) this._decorPond(p, group, st, course.def.theme);

    // horizon : grand disque au-delà de la zone détaillée
    const far = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(x1 - x0, z1 - z0) * 0.45, 170, 24, 1),
      new THREE.MeshLambertMaterial({ color: st.ground2 }),
    );
    far.rotation.x = -Math.PI / 2;
    far.position.set((x0 + x1) / 2, GROUND_Y - 0.25, (z0 + z1) / 2);
    group.add(far);
  }

  _decor(course, group, st, rng) {
    const theme = course.def.theme;
    const b = course.bounds;
    const lam = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    const M = {
      trunk: lam(0x7a5133), rock: lam(theme === 'desert' ? 0xb4654a : theme === 'neige' ? 0xb8c4cf : 0x9a9a92),
      leafs: theme === 'automne' ? [lam(0xe8752a), lam(0xc8442b), lam(0xf2b134), lam(0xd9622b)]
        : theme === 'crepuscule' ? [lam(0x1f4a35), lam(0x1a3d2c)]
          : [lam(0x3f9b47), lam(0x5bb04e), lam(0x2f8a3e)],
      pine: lam(theme === 'neige' ? 0x2c6b4a : 0x24593b), snow: lam(0xffffff),
      cactus: lam(0x4f9a4a), flowers: [lam(0xff7a1a), lam(0xffd23f), lam(0xff5fa2), lam(0xffffff)],
      pumpkin: lam(0xff7a1a), lampPost: lam(0x1b1b1b),
      lampGlow: new THREE.MeshBasicMaterial({ color: 0xffa043 }),
      cloud: new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    };
    const G = {
      cone: new THREE.ConeGeometry(1, 1, 6), cyl: new THREE.CylinderGeometry(1, 1, 1, 6),
      ico: new THREE.IcosahedronGeometry(1, 0), dode: new THREE.DodecahedronGeometry(1, 0),
      sphere: new THREE.IcosahedronGeometry(1, 1),
    };
    this.obstacles = [];
    const block = (x, z, r) => this.obstacles.push({ x, z, r });
    const add = (geo, mat, x, y, z, sx, sy, sz, shadow = true, ry = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      m.rotation.y = ry;
      m.castShadow = shadow;
      m.receiveShadow = true;
      group.add(m);
      return m;
    };
    const area = (b.maxX - b.minX + 30) * (b.maxZ - b.minZ + 30);
    const count = Math.min(170, Math.floor(area / 9));
    for (let k = 0; k < count; k++) {
      const x = rng.float(b.minX - 15, b.maxX + 15), z = rng.float(b.minZ - 15, b.maxZ + 15);
      const d = this._courseDist(course, x, z);
      if (d < 0.9) continue;
      if (this.ponds.some((p) => Math.hypot(x - p.x, z - p.z) < p.r + 0.5)) continue;
      const y = this.groundHeight(x, z);
      const big = d > 2.6;
      if (big) block(x, z, 0.55);
      const r = rng.next();
      const ry = rng.float(0, Math.PI * 2);
      if (theme === 'prairie' || theme === 'automne') {
        if (big && r < 0.45) { // arbre rond
          const s = rng.float(0.8, 1.5);
          add(G.cyl, M.trunk, x, y + 0.6 * s, z, 0.12 * s, 1.2 * s, 0.12 * s);
          add(G.ico, rng.pick(M.leafs), x, y + 1.6 * s, z, 0.8 * s, 0.9 * s, 0.8 * s, true, ry);
        } else if (big && r < 0.6) { // sapin
          const s = rng.float(0.9, 1.6);
          add(G.cyl, M.trunk, x, y + 0.3 * s, z, 0.1 * s, 0.6 * s, 0.1 * s);
          add(G.cone, theme === 'automne' ? rng.pick(M.leafs) : M.pine, x, y + 1.2 * s, z, 0.6 * s, 1.5 * s, 0.6 * s, true, ry);
        } else if (r < 0.75) {
          const s = rng.float(0.15, 0.4);
          add(G.dode, M.rock, x, y + s * 0.3, z, s, s * 0.7, s * 1.1, true, ry);
        } else if (r < 0.88) {
          const s = rng.float(0.25, 0.5);
          add(G.ico, rng.pick(M.leafs), x, y + s * 0.5, z, s, s * 0.8, s, true, ry);
        } else if (theme === 'automne') {
          const s = rng.float(0.12, 0.22);
          add(G.sphere, M.pumpkin, x, y + s * 0.6, z, s * 1.2, s * 0.85, s * 1.2, true, ry);
        } else {
          for (let f = 0; f < 3; f++) {
            add(G.cone, rng.pick(M.flowers), x + rng.float(-0.2, 0.2), y + 0.06, z + rng.float(-0.2, 0.2), 0.04, 0.12, 0.04, false);
          }
        }
      } else if (theme === 'desert') {
        if (big && r < 0.35) {
          const s = rng.float(0.7, 1.3);
          add(G.cyl, M.cactus, x, y + 0.7 * s, z, 0.14 * s, 1.4 * s, 0.14 * s);
          add(G.sphere, M.cactus, x, y + 1.4 * s, z, 0.14 * s, 0.14 * s, 0.14 * s);
          const side = rng.sign();
          add(G.cyl, M.cactus, x + side * 0.25 * s, y + 0.95 * s, z, 0.09 * s, 0.45 * s, 0.09 * s);
          add(G.cyl, M.cactus, x + side * 0.14 * s, y + 0.72 * s, z, 0.07 * s, 0.07 * s, 0.07 * s);
        } else if (r < 0.75) {
          const s = rng.float(0.15, 0.7) * (big ? 1.4 : 0.6);
          add(G.dode, M.rock, x, y + s * 0.3, z, s, s * 0.6, s * 1.2, true, ry);
        } else if (r < 0.85) {
          const s = rng.float(0.2, 0.35);
          add(G.ico, M.cactus, x, y + s * 0.4, z, s, s * 0.7, s, true, ry);
        }
      } else if (theme === 'neige') {
        if (big && r < 0.55) {
          const s = rng.float(0.9, 1.7);
          add(G.cyl, M.trunk, x, y + 0.25 * s, z, 0.1 * s, 0.5 * s, 0.1 * s);
          add(G.cone, M.pine, x, y + 0.9 * s, z, 0.65 * s, 1.0 * s, 0.65 * s, true, ry);
          add(G.cone, M.pine, x, y + 1.45 * s, z, 0.48 * s, 0.85 * s, 0.48 * s, true, ry);
          add(G.cone, M.snow, x, y + 1.85 * s, z, 0.26 * s, 0.4 * s, 0.26 * s, true, ry);
        } else if (big && r < 0.62) { // bonhomme de neige
          const s = rng.float(0.8, 1.1);
          add(G.sphere, M.snow, x, y + 0.3 * s, z, 0.32 * s, 0.3 * s, 0.32 * s);
          add(G.sphere, M.snow, x, y + 0.75 * s, z, 0.22 * s, 0.21 * s, 0.22 * s);
          add(G.cone, M.pumpkin, x, y + 0.76 * s, z + 0.2 * s, 0.035 * s, 0.14 * s, 0.035 * s, false).rotation.x = Math.PI / 2;
        } else if (r < 0.85) {
          const s = rng.float(0.15, 0.45);
          add(G.dode, M.snow, x, y + s * 0.2, z, s, s * 0.5, s * 1.2, true, ry);
        }
      } else { // crépuscule
        if (big && r < 0.5) {
          const s = rng.float(1.0, 1.8);
          add(G.cyl, M.trunk, x, y + 0.3 * s, z, 0.1 * s, 0.6 * s, 0.1 * s);
          add(G.cone, rng.pick(M.leafs), x, y + 1.3 * s, z, 0.62 * s, 1.7 * s, 0.62 * s, true, ry);
        } else if (r < 0.75) {
          const s = rng.float(0.15, 0.4);
          add(G.dode, M.rock, x, y + s * 0.3, z, s, s * 0.7, s * 1.1, true, ry);
        } else if (r < 0.8) {
          const s = rng.float(0.12, 0.2);
          add(G.sphere, M.pumpkin, x, y + s * 0.6, z, s * 1.2, s * 0.85, s * 1.2, true, ry);
        }
      }
    }

    // lampadaires le long du parcours (crépuscule)
    if (st.lamps) {
      let k = 0;
      for (const s of course.wallList) {
        if (s.kind !== 'wall' || k++ % 3 !== 0) continue;
        const ex = s.bx - s.ax, ez = s.bz - s.az, len = Math.hypot(ex, ez);
        let nx = -ez / len, nz = ex / len;
        const mx = (s.ax + s.bx) / 2, mz = (s.az + s.bz) / 2;
        if ((mx - s.cell.cx) * nx + (mz - s.cell.cz) * nz < 0) { nx = -nx; nz = -nz; }
        const x = mx + nx * 0.45, z = mz + nz * 0.45;
        if (course.cellAt(x, z)) continue;
        const y = this.groundHeight(x, z);
        const top = Math.max(y + 1.4, s.cell.level + 1.0);
        add(G.cyl, M.lampPost, x, (y + top) / 2, z, 0.035, top - y, 0.035);
        block(x, z, 0.25);
        add(G.ico, M.lampGlow, x, top + 0.08, z, 0.1, 0.12, 0.1, false);
      }
    }

    // nuages
    if (st.clouds) {
      for (let k = 0; k < 7; k++) {
        const cl = new THREE.Group();
        const n = rng.int(3, 5);
        for (let q = 0; q < n; q++) {
          const s = rng.float(1.2, 2.4);
          const m = new THREE.Mesh(G.ico, M.cloud);
          m.position.set(q * 1.6 - n * 0.8, rng.float(-0.3, 0.3), rng.float(-0.6, 0.6));
          m.scale.set(s, s * 0.7, s);
          cl.add(m);
        }
        const ang = rng.float(0, Math.PI * 2), dist = rng.float(25, 60);
        cl.position.set(this.center.x + Math.cos(ang) * dist, rng.float(14, 24), this.center.z + Math.sin(ang) * dist);
        const speed = rng.float(0.2, 0.5);
        const bx = cl.position.x;
        group.add(cl);
        this.animated.push((t) => { cl.position.x = bx + Math.sin(t * speed * 0.05) * 8; });
      }
    }
    // étoiles
    if (st.stars) {
      const n = 400;
      const pos = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        const th = rng.float(0, Math.PI * 2), ph = rng.float(0.15, 1.4);
        pos[k * 3] = Math.cos(th) * Math.cos(ph) * 160;
        pos[k * 3 + 1] = Math.sin(ph) * 160;
        pos[k * 3 + 2] = Math.sin(th) * Math.cos(ph) * 160;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, sizeAttenuation: true, fog: false }));
      pts.position.copy(this.center);
      group.add(pts);
    }
  }

  update(t) {
    for (const f of this.animated) f(t);
    if (this.waterAnims) for (const f of this.waterAnims) f(t);
    this.sky.position.copy(this.camera.position);
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
