// Parcours : génération procédurale de la définition (sérialisable) et
// structure d'exécution (hauteurs, murs, obstacles) utilisée par la physique et le rendu.
import {
  TILE, BALL_R, CUP_R, WALL_H, WALL_RESTITUTION, POST_RESTITUTION, DX, DZ,
} from './constants.js';

const HALF = TILE / 2;
const CHAMFER = 0.62;
export const THEMES = ['prairie', 'automne', 'desert', 'neige', 'crepuscule'];

const key = (i, j) => ((i + 512) << 10) | (j + 512);
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ---------------------------------------------------------------------------
// Génération de la définition d'un trou
// ---------------------------------------------------------------------------

function genPath(rng, n) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const cells = [{ i: 0, j: 0 }];
    const occ = new Set([key(0, 0)]);
    let dir = rng.int(0, 3);
    let run = 0;
    let ok = true;
    for (let k = 1; k < n; k++) {
      const last = cells[cells.length - 1];
      const straightW = k === 1 ? 3 : run >= 3 ? 0.15 : 1.1;
      const cand = [
        [dir, straightW],
        [(dir + 1) % 4, 0.75],
        [(dir + 3) % 4, 0.75],
      ];
      // tirage pondéré sans remise
      let chosen = -1;
      const pool = cand.slice();
      while (pool.length) {
        let total = 0;
        for (const [, w] of pool) total += w;
        let r = rng.next() * total, idx = 0;
        for (; idx < pool.length - 1; idx++) { if ((r -= pool[idx][1]) <= 0) break; }
        const d = pool[idx][0];
        pool.splice(idx, 1);
        const ni = last.i + DX[d], nj = last.j + DZ[d];
        if (occ.has(key(ni, nj))) continue;
        // pas de contact latéral avec une case non consécutive
        let touches = false;
        for (let s = 0; s < 4; s++) {
          const ai = ni + DX[s], aj = nj + DZ[s];
          if (ai === last.i && aj === last.j) continue;
          if (occ.has(key(ai, aj))) { touches = true; break; }
        }
        if (touches) continue;
        chosen = d;
        break;
      }
      if (chosen < 0) { ok = false; break; }
      run = chosen === dir ? run + 1 : 0;
      dir = chosen;
      const c = { i: last.i + DX[dir], j: last.j + DZ[dir] };
      cells.push(c);
      occ.add(key(c.i, c.j));
    }
    if (!ok) continue;
    // directions d'entrée / sortie
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      if (k < n - 1) {
        const nx = cells[k + 1];
        c.dout = DX.findIndex((dx, d) => dx === nx.i - c.i && DZ[d] === nx.j - c.j);
      }
      if (k > 0) {
        const pv = cells[k - 1];
        c.din = DX.findIndex((dx, d) => dx === c.i - pv.i && DZ[d] === c.j - pv.j);
      }
    }
    cells[0].din = cells[0].dout;
    cells[n - 1].dout = cells[n - 1].din;
    return cells;
  }
  return null;
}

export function buildDef(rng, seed, index) {
  const diff = Math.min(1, 0.25 + index / 10 + rng.float(-0.1, 0.25)); // difficulté 0..1
  const n = Math.max(4, Math.min(12, Math.round(3.5 + diff * 3.5 + rng.float(0, 4))));
  const cells = genPath(rng, n);
  if (!cells) return null;

  // --- relief : rampes -------------------------------------------------------
  let level = 0.3;
  let lastRamp = -5;
  for (let k = 0; k < n; k++) {
    const c = cells[k];
    c.level = +level.toFixed(3);
    c.ramp = 0;
    c.feat = null;
    const straight = c.din === c.dout;
    if (straight && k > 0 && k < n - 1 && k - lastRamp > 1 && rng.chance(0.18 + diff * 0.22)) {
      let dh = rng.pick([0.25, 0.35, 0.45]);
      let up = level < 0.5 ? true : level > 1.1 ? false : rng.chance(0.5);
      dh = up ? dh : -dh;
      if (level + dh < 0.25) dh = Math.abs(dh);
      c.ramp = dh;
      level += dh;
      lastRamp = k;
    }
  }

  // --- reliefs locaux ----------------------------------------------------------
  for (let k = 1; k < n - 1; k++) {
    const c = cells[k];
    if (c.ramp) continue;
    const straight = c.din === c.dout;
    if (!rng.chance(0.3 + diff * 0.3)) continue;
    const opts = straight
      ? [['bump', 3], ['dip', 1.5], ['camber', 3], ['wave', 2]]
      : [['bump', 3], ['dip', 2]];
    const t = rng.weighted(opts);
    if (t === 'bump') c.feat = { type: 'bump', a: +rng.float(0.08, 0.2).toFixed(3) };
    else if (t === 'dip') c.feat = { type: 'bump', a: -rng.float(0.06, 0.14).toFixed(3) };
    else if (t === 'camber') c.feat = { type: 'camber', a: +(rng.sign() * rng.float(0.07, 0.15)).toFixed(3) };
    else c.feat = { type: 'wave', a: +rng.float(0.05, 0.1).toFixed(3) };
  }

  // --- coins biseautés -------------------------------------------------------------
  for (let k = 1; k < n - 1; k++) {
    const c = cells[k];
    if (c.din !== c.dout && rng.chance(0.6)) c.chamfer = 1;
  }

  // --- départ et trou ------------------------------------------------------------
  const first = cells[0], last = cells[n - 1];
  const fcx = first.i * TILE, fcz = first.j * TILE;
  const tee = { x: +(fcx - DX[first.dout] * 0.5).toFixed(3), z: +(fcz - DZ[first.dout] * 0.5).toFixed(3) };
  const lcx = last.i * TILE, lcz = last.j * TILE;
  const d = last.din;
  const along = rng.float(-0.05, 0.4);
  const lat = rng.float(-0.35, 0.35);
  const cup = {
    x: +(lcx + DX[d] * along - DZ[d] * lat).toFixed(3),
    z: +(lcz + DZ[d] * along + DX[d] * lat).toFixed(3),
  };
  const edgeDist = Math.min(
    HALF - Math.abs(cup.x - lcx),
    HALF - Math.abs(cup.z - lcz),
  );
  const cupType = rng.weighted([['flat', 4], ['funnel', 3], ['volcano', 1 + diff * 2]]);
  if (cupType !== 'flat') {
    const rf = Math.min(0.95, edgeDist - 0.03);
    const a = cupType === 'funnel' ? -rf * rng.float(0.07, 0.13) : rf * rng.float(0.08, 0.14);
    last.cupFeat = { a: +a.toFixed(3), rf: +rf.toFixed(3) };
  }

  // --- obstacles -------------------------------------------------------------------
  const posts = [], blocks = [], mills = [], sands = [];
  let millCount = 0;
  const budget = 1 + Math.round(diff * 4);
  let used = 0;
  const middle = [];
  for (let k = 1; k < n - 1; k++) middle.push(k);
  // ordre aléatoire
  for (let k = middle.length - 1; k > 0; k--) {
    const r = Math.floor(rng.next() * (k + 1));
    [middle[k], middle[r]] = [middle[r], middle[k]];
  }
  for (const k of middle) {
    if (used >= budget) break;
    const c = cells[k];
    if (c.ramp) continue;
    const cx = c.i * TILE, cz = c.j * TILE;
    const straight = c.din === c.dout;
    const dd = c.dout;
    const ax = DX[dd], az = DZ[dd];       // axe de progression
    const lx = -DZ[dd], lz = DX[dd];      // axe latéral
    const flat = !c.feat;
    const opts = [['none', 2.2], ['posts', 2.5]];
    if (straight && flat) opts.push(['gate', 1.6], ['block', 1.3]);
    if (straight && flat && millCount === 0) opts.push(['mill', 1.2 + diff]);
    if (flat) opts.push(['sand', 1.2]);
    const t = rng.weighted(opts);
    if (t === 'none') continue;
    used++;
    if (t === 'posts') {
      const count = rng.chance(0.4 + diff * 0.3) ? 2 : 1;
      const placed = [];
      for (let p = 0; p < count; p++) {
        for (let tries = 0; tries < 20; tries++) {
          const r = rng.float(0.09, 0.17);
          let u = rng.float(-0.45, 0.45), v = rng.float(-0.45, 0.45);
          if (!straight) {
            // dans un virage, éviter le coin extérieur biseauté
            u *= 0.8; v *= 0.8;
          }
          const x = cx + u, z = cz + v;
          if (placed.some((q) => Math.hypot(q.x - x, q.z - z) < q.r + r + 0.5)) continue;
          placed.push({ x: +x.toFixed(3), z: +z.toFixed(3), r: +r.toFixed(3), h: 0.3 });
          break;
        }
      }
      posts.push(...placed);
    } else if (t === 'gate') {
      // barrière transversale avec une ouverture
      const gap = rng.float(0.42, 0.65);
      const off = rng.float(-(HALF - gap / 2 - 0.12), HALF - gap / 2 - 0.12);
      const thick = 0.07;
      const along = rng.float(-0.3, 0.3);
      const segA = [-HALF, off - gap / 2];
      const segB = [off + gap / 2, HALF];
      for (const [l0, l1] of [segA, segB]) {
        if (l1 - l0 < 0.05) continue;
        const lm = (l0 + l1) / 2, lh = (l1 - l0) / 2;
        const x = cx + ax * along + lx * lm, z = cz + az * along + lz * lm;
        blocks.push({
          x: +x.toFixed(3), z: +z.toFixed(3),
          hx: +(Math.abs(ax) * thick + Math.abs(lx) * lh).toFixed(3),
          hz: +(Math.abs(az) * thick + Math.abs(lz) * lh).toFixed(3),
          h: 0.16,
        });
      }
    } else if (t === 'block') {
      const hw = rng.float(0.22, 0.38);
      const hl = rng.float(0.15, 0.35);
      const off = rng.float(-0.2, 0.2);
      const x = cx + lx * off, z = cz + lz * off;
      blocks.push({
        x: +x.toFixed(3), z: +z.toFixed(3),
        hx: +(Math.abs(ax) * hl + Math.abs(lx) * hw).toFixed(3),
        hz: +(Math.abs(az) * hl + Math.abs(lz) * hw).toFixed(3),
        h: 0.22,
      });
    } else if (t === 'mill') {
      millCount++;
      mills.push({
        x: cx, z: cz, half: 0.72,
        omega: +(rng.sign() * rng.float(1.0, 1.9)).toFixed(3),
        phase: +rng.float(0, Math.PI).toFixed(3),
      });
    } else if (t === 'sand') {
      const r = rng.float(0.32, 0.5);
      const u = rng.float(-0.35, 0.35), v = rng.float(-0.35, 0.35);
      sands.push({ x: +(cx + u).toFixed(3), z: +(cz + v).toFixed(3), r: +r.toFixed(3) });
    }
  }

  // --- thème -------------------------------------------------------------------------
  const theme = THEMES[(index + Math.floor(rng.float(0, 1) * 2)) % THEMES.length];

  const def = {
    v: 1,
    seed,
    index,
    theme,
    cells: cells.map((c) => {
      const o = { i: c.i, j: c.j, din: c.din, dout: c.dout, level: c.level };
      if (c.ramp) o.ramp = +c.ramp.toFixed(3);
      if (c.feat) o.feat = c.feat;
      if (c.chamfer) o.chamfer = 1;
      if (c.cupFeat) o.cupFeat = c.cupFeat;
      return o;
    }),
    tee, cup, posts, blocks, mills, sands,
    decorSeed: Math.floor(rng.next() * 1e9),
    par: 3,
  };
  return def;
}

// ---------------------------------------------------------------------------
// Structure d'exécution
// ---------------------------------------------------------------------------

export class Course {
  constructor(def) {
    this.def = def;
    this.cup = def.cup;
    this.tee = def.tee;
    this.map = new Map();
    this.cells = def.cells.map((c, idx) => {
      const cell = {
        ...c,
        idx,
        ramp: c.ramp || 0,
        feat: c.feat || null,
        cupFeat: c.cupFeat || null,
        cx: c.i * TILE,
        cz: c.j * TILE,
        segs: [], posts: [], mills: [], sands: [],
        walls: [],
      };
      this.map.set(key(c.i, c.j), cell);
      return cell;
    });
    const N = this.cells.length;
    this.cupCell = this.cells[N - 1];
    this.teeCell = this.cells[0];

    // bornes
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minL = Infinity, maxL = -Infinity;
    for (const c of this.cells) {
      minX = Math.min(minX, c.cx - HALF); maxX = Math.max(maxX, c.cx + HALF);
      minZ = Math.min(minZ, c.cz - HALF); maxZ = Math.max(maxZ, c.cz + HALF);
      minL = Math.min(minL, c.level, c.level + c.ramp);
      maxL = Math.max(maxL, c.level, c.level + c.ramp);
    }
    this.bounds = { minX, maxX, minZ, maxZ, minL, maxL };

    // murs
    const allSegs = [];
    this.wallList = [];
    for (let k = 0; k < N; k++) {
      const c = this.cells[k];
      const open = new Set();
      if (k > 0) open.add((c.din + 2) % 4);
      if (k < N - 1) open.add(c.dout);
      for (let s = 0; s < 4; s++) {
        if (open.has(s)) continue;
        const ex = c.cx + DX[s] * HALF, ez = c.cz + DZ[s] * HALF;
        const p = (s + 1) % 4;
        const px = DX[p] * HALF, pz = DZ[p] * HALF;
        const seg = {
          ax: ex - px, az: ez - pz, bx: ex + px, bz: ez + pz,
          cell: c, h: WALL_H, e: WALL_RESTITUTION, rad: 0, kind: 'wall', side: s,
        };
        allSegs.push(seg);
        c.walls.push(s);
        this.wallList.push(seg);
      }
      if (c.chamfer && c.din !== c.dout) {
        const b = (c.dout + 2) % 4;
        const ox = c.cx + (DX[c.din] + DX[b]) * HALF;
        const oz = c.cz + (DZ[c.din] + DZ[b]) * HALF;
        const seg = {
          ax: ox + DX[c.dout] * CHAMFER, az: oz + DZ[c.dout] * CHAMFER,
          bx: ox - DX[c.din] * CHAMFER, bz: oz - DZ[c.din] * CHAMFER,
          cell: c, h: WALL_H, e: WALL_RESTITUTION, rad: 0, kind: 'chamfer',
        };
        allSegs.push(seg);
        c.chamferSeg = seg;
        this.wallList.push(seg);
      }
    }

    // blocs (rectangles alignés sur les axes)
    this.blocks = (def.blocks || []).map((b) => {
      const cell = this.cellAt(b.x, b.z);
      const x0 = b.x - b.hx, x1 = b.x + b.hx, z0 = b.z - b.hz, z1 = b.z + b.hz;
      const pts = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
      for (let q = 0; q < 4; q++) {
        const [axp, azp] = pts[q], [bxp, bzp] = pts[(q + 1) % 4];
        allSegs.push({ ax: axp, az: azp, bx: bxp, bz: bzp, cell, h: b.h, e: WALL_RESTITUTION, rad: 0, kind: 'block' });
      }
      return { ...b, cell };
    });

    this.posts = (def.posts || []).map((p) => ({ ...p, cell: this.cellAt(p.x, p.z), e: POST_RESTITUTION }));
    this.mills = (def.mills || []).map((m) => ({ ...m, cell: this.cellAt(m.x, m.z), rad: 0.04, h: 0.16, kind: 'mill', e: 0.6 }));
    for (const m of this.mills) this.posts.push({ x: m.x, z: m.z, r: 0.07, h: 0.3, cell: m.cell, e: POST_RESTITUTION, hub: true });
    this.sands = (def.sands || []).map((s) => ({ ...s, cell: this.cellAt(s.x, s.z) }));

    // répartition par case (détection large)
    const M = BALL_R * 2 + 0.05;
    const inCell = (c, x0, z0, x1, z1) =>
      x1 >= c.cx - HALF - M && x0 <= c.cx + HALF + M && z1 >= c.cz - HALF - M && z0 <= c.cz + HALF + M;
    for (const c of this.cells) {
      for (const s of allSegs) {
        if (inCell(c, Math.min(s.ax, s.bx), Math.min(s.az, s.bz), Math.max(s.ax, s.bx), Math.max(s.az, s.bz))) c.segs.push(s);
      }
      for (const p of this.posts) if (inCell(c, p.x - p.r, p.z - p.r, p.x + p.r, p.z + p.r)) c.posts.push(p);
      for (const m of this.mills) if (inCell(c, m.x - m.half, m.z - m.half, m.x + m.half, m.z + m.half)) c.mills.push(m);
      for (const s of this.sands) if (s.cell === c) c.sands.push(s);
    }
    this.allSegs = allSegs;
  }

  cellAt(x, z) {
    return this.map.get(key(Math.round(x / TILE), Math.round(z / TILE))) || null;
  }

  heightCell(c, x, z) {
    const u = x - c.cx, v = z - c.cz;
    let h = c.level;
    const d = c.dout;
    if (c.ramp) {
      const t = (u * DX[d] + v * DZ[d]) / TILE + 0.5;
      h += c.ramp * smooth(t);
    }
    const f = c.feat;
    if (f) {
      if (f.type === 'bump') {
        const cu = Math.cos(Math.PI * u / TILE), cv = Math.cos(Math.PI * v / TILE);
        h += f.a * cu * cu * cv * cv;
      } else {
        let t = (u * DX[d] + v * DZ[d]) / TILE + 0.5;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (f.type === 'camber') {
          const lat = (-u * DZ[d] + v * DX[d]) / HALF;
          const s = Math.sin(Math.PI * t);
          h += f.a * lat * s * s;
        } else if (f.type === 'wave') {
          const s = Math.sin(2 * Math.PI * t);
          h += f.a * s * s;
        }
      }
    }
    if (c.cupFeat) {
      const dx = x - this.cup.x, dz = z - this.cup.z;
      const q = (dx * dx + dz * dz) / (c.cupFeat.rf * c.cupFeat.rf);
      if (q < 1) { const w = 1 - q; h += c.cupFeat.a * w * w; }
    }
    return h;
  }

  height(x, z) {
    const c = this.cellAt(x, z);
    return c ? this.heightCell(c, x, z) : null;
  }

  // normale de surface (différences centrées dans la même case)
  normalCell(c, x, z, out) {
    const e = 0.01;
    const hx = this.heightCell(c, x + e, z) - this.heightCell(c, x - e, z);
    const hz = this.heightCell(c, x, z + e) - this.heightCell(c, x, z - e);
    const nx = -hx / (2 * e), nz = -hz / (2 * e);
    const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
    out.x = nx * inv; out.y = inv; out.z = nz * inv;
    return out;
  }

  isSand(c, x, z) {
    for (const s of c.sands) {
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz < s.r * s.r) return true;
    }
    return false;
  }
}
