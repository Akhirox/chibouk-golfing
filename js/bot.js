// Joueur virtuel : sert à vérifier qu'un trou généré est jouable et à estimer son PAR.
import { BALL_R, MAX_STROKES } from './constants.js';
import { makeBall, placeBall, shootBall, stepBall } from './physics.js';
import { RNG } from './rng.js';

// ---------------------------------------------------------------------------
// Carte des distances « à pied » jusqu'au trou (contourne murs et obstacles)
// ---------------------------------------------------------------------------

function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1x = bx - ax, d1z = bz - az, d2x = dx - cx, d2z = dz - cz;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-12) return false;
  const t = ((cx - ax) * d2z - (cz - az) * d2x) / den;
  const u = ((cx - ax) * d1z - (cz - az) * d1x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function distPointSeg(px, pz, s) {
  const ex = s.bx - s.ax, ez = s.bz - s.az;
  let t = ((px - s.ax) * ex + (pz - s.az) * ez) / (ex * ex + ez * ez);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (s.ax + t * ex), pz - (s.az + t * ez));
}

export function buildDistanceField(course, res = 0.2) {
  const { minX, maxX, minZ, maxZ } = course.bounds;
  const nx = Math.ceil((maxX - minX) / res), nz = Math.ceil((maxZ - minZ) / res);
  const cells = new Array(nx * nz).fill(null);
  const walk = new Uint8Array(nx * nz);
  const dist = new Float64Array(nx * nz).fill(Infinity);
  const X = (i) => minX + (i + 0.5) * res, Z = (j) => minZ + (j + 0.5) * res;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = X(i), z = Z(j);
      const c = course.cellAt(x, z);
      if (!c) continue;
      let ok = true;
      for (const s of c.segs) { if (distPointSeg(x, z, s) < BALL_R * 0.9) { ok = false; break; } }
      if (ok) for (const p of c.posts) { if (Math.hypot(x - p.x, z - p.z) < p.r + BALL_R * 0.9) { ok = false; break; } }
      if (!ok) continue;
      walk[j * nx + i] = 1;
      cells[j * nx + i] = c;
    }
  }
  // Dijkstra depuis le trou (tas binaire)
  const ci = Math.floor((course.cup.x - minX) / res), cj = Math.floor((course.cup.z - minZ) / res);
  const heap = [];
  const push = (d, idx) => {
    heap.push([d, idx]);
    let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
      }
    }
    return top;
  };
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= nx || j >= nz || !walk[j * nx + i]) continue;
    const d = Math.hypot(X(i) - course.cup.x, Z(j) - course.cup.z);
    dist[j * nx + i] = d; push(d, j * nx + i);
  }
  const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.length) {
    const [d, idx] = pop();
    if (d > dist[idx]) continue;
    const i = idx % nx, j = (idx / nx) | 0;
    const x0 = X(i), z0 = Z(j);
    for (const [di, dj, w] of nb) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const nidx = b * nx + a;
      if (!walk[nidx]) continue;
      const nd = d + w * res;
      if (nd >= dist[nidx]) continue;
      const x1 = X(a), z1 = Z(b);
      let blocked = false;
      const c0 = cells[idx], c1 = cells[nidx];
      for (const s of c0.segs) if (segIntersect(x0, z0, x1, z1, s.ax, s.az, s.bx, s.bz)) { blocked = true; break; }
      if (!blocked && c1 !== c0) for (const s of c1.segs) if (segIntersect(x0, z0, x1, z1, s.ax, s.az, s.bx, s.bz)) { blocked = true; break; }
      if (blocked) continue;
      dist[nidx] = nd; push(nd, nidx);
    }
  }
  const query = (x, z) => {
    const dc = Math.hypot(x - course.cup.x, z - course.cup.z);
    if (dc < 0.4) return dc;
    const fi = (x - minX) / res - 0.5, fj = (z - minZ) / res - 0.5;
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    let best = Infinity;
    for (let rad = 1; rad <= 3 && best === Infinity; rad++) {
      for (let j = j0 - rad + 1; j <= j0 + rad; j++) {
        for (let i = i0 - rad + 1; i <= i0 + rad; i++) {
          if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
          const v = dist[j * nx + i];
          if (v === Infinity) continue;
          const e = v + Math.hypot(x - X(i), z - Z(j));
          if (e < best) best = e;
        }
      }
    }
    return best;
  };
  return { query, nx, nz, res, dist, minX, minZ };
}

// ---------------------------------------------------------------------------
// Estimation du PAR par simulation
// ---------------------------------------------------------------------------

const DT = 1 / 90;
// imprécision d'un joueur humain correct (visée en radians, dosage relatif)
const NOISE_ANG = 0.032;
const NOISE_POW = 0.06;

function simulate(course, sx, sz, angle, power, t0) {
  const b = makeBall();
  placeBall(course, b, sx, sz);
  shootBall(course, b, angle, power);
  let t = t0;
  for (let i = 0; i < 90 * 22 && b.moving; i++) { stepBall(course, b, DT, t, null); t += DT; }
  return b;
}

// Coups restants espérés depuis une distance d au trou
function expectRemaining(d) {
  if (d === Infinity) return 9;
  return 1 + 0.95 * (1 - Math.exp(-d / 2.6)) + d * 0.035;
}

function shotCost(course, df, b, startCost) {
  if (b.holed) return 0;
  if (b.oob) return 1 + startCost;
  let c = expectRemaining(df.query(b.x, b.z));
  if (course.cellAt(b.x, b.z) && course.isSand(course.cellAt(b.x, b.z), b.x, b.z)) c += 0.15;
  return c;
}

const POWERS = [0.1, 0.16, 0.22, 0.29, 0.36, 0.44, 0.53, 0.63, 0.75, 0.88, 1.0];

function chooseShot(course, df, x, z, rng, t0) {
  const startCost = expectRemaining(df.query(x, z));
  const cands = [];
  const ANG = 40;
  // 1) balayage grossier
  for (let a = 0; a < ANG; a++) {
    const ang = (a / ANG) * Math.PI * 2;
    for (const p of POWERS) {
      const b = simulate(course, x, z, ang, p, t0);
      cands.push({ ang, p, cost: shotCost(course, df, b, startCost) });
    }
  }
  cands.sort((u, v) => u.cost - v.cost);
  // 2) affinage autour des meilleurs
  const refined = [];
  const step = (Math.PI * 2) / ANG;
  for (const c of cands.slice(0, 5)) {
    for (let da = -2; da <= 2; da++) {
      for (const dp of [-0.035, 0, 0.035]) {
        const ang = c.ang + (da * step) / 4.5, p = Math.min(1, Math.max(0.05, c.p + dp));
        const b = simulate(course, x, z, ang, p, t0);
        refined.push({ ang, p, cost: shotCost(course, df, b, startCost) });
      }
    }
  }
  refined.sort((u, v) => u.cost - v.cost);
  // 3) robustesse : moyenne sur des coups légèrement imprécis
  let best = refined[0], bestScore = Infinity;
  for (const c of refined.slice(0, 6)) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const b = simulate(course, x, z, c.ang + rng.gauss() * NOISE_ANG, Math.min(1, c.p * (1 + rng.gauss() * NOISE_POW)), t0);
      sum += shotCost(course, df, b, startCost);
    }
    const score = sum / 4 + c.cost * 0.2;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}

function playHole(course, df, rng) {
  let x = course.tee.x, z = course.tee.z;
  let strokes = 0;
  let t = 0;
  while (strokes < MAX_STROKES) {
    const shot = chooseShot(course, df, x, z, rng, t);
    strokes++;
    // exécution avec une petite imprécision « humaine »
    const ang = shot.ang + rng.gauss() * NOISE_ANG;
    const p = Math.min(1, shot.p * (1 + rng.gauss() * NOISE_POW));
    const b = simulate(course, x, z, ang, p, t);
    t += 7.3;
    if (b.holed) return { strokes, holed: true };
    if (b.oob) { strokes++; continue; }
    x = b.x; z = b.z;
  }
  return { strokes, holed: false };
}

export const PAR_BIAS = 0.35;

export function estimatePar(course, seedStr, runs = 2) {
  const df = buildDistanceField(course);
  const teeDist = df.query(course.tee.x, course.tee.z);
  if (teeDist === Infinity) return { ok: false };
  const rng = new RNG(seedStr + '#bot');
  let total = 0;
  const results = [];
  for (let r = 0; r < runs; r++) {
    const res = playHole(course, df, rng);
    if (!res.holed) return { ok: false };
    total += res.strokes;
    results.push(res.strokes);
  }
  const avg = total / runs;
  const par = Math.max(2, Math.min(6, Math.round(avg + PAR_BIAS)));
  return { ok: true, par, avg, results, length: teeDist };
}

export { simulate, expectRemaining, chooseShot };
