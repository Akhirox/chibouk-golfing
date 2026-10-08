// Physique de la balle : roulement sur relief, rebonds, obstacles, trou.
import {
  BALL_R, CUP_R, GRAVITY, ROLL_DECEL, SAND_DECEL, LIN_DAMP, GROUND_RESTITUTION, GROUND_Y,
  powerToSpeed,
} from './constants.js';

const ROLL_FACTOR = 2 / 7; // une sphère pleine qui roule accélère à 5/7 de g·sinθ
const CAPTURE_DROP = 1.6 * BALL_R;

export function makeBall() {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    moving: false, still: 0, time: 0,
    inCup: false, lipOff: 0, holed: false, oob: false,
    nx: 0, ny: 1, nz: 0, // normale courante (cache)
  };
}

export function placeBall(course, b, x, z) {
  const c = course.cellAt(x, z);
  b.x = x; b.z = z;
  b.y = (c ? course.heightCell(c, x, z) : 0) + BALL_R;
  b.vx = b.vy = b.vz = 0;
  b.moving = false; b.still = 0; b.time = 0;
  b.inCup = false; b.holed = false; b.oob = false;
  if (c) {
    const n = course.normalCell(c, x, z, {});
    b.y = course.heightCell(c, x, z) + BALL_R / n.y;
    b.nx = n.x; b.ny = n.y; b.nz = n.z;
  } else { b.nx = 0; b.ny = 1; b.nz = 0; }
}

export function shootBall(course, b, angle, power) {
  const s = powerToSpeed(power);
  let vx = Math.cos(angle) * s, vz = Math.sin(angle) * s, vy = 0;
  const c = course.cellAt(b.x, b.z);
  if (c) {
    // départ tangent à la pente
    const n = course.normalCell(c, b.x, b.z, {});
    const vn = vx * n.x + vy * n.y + vz * n.z;
    vx -= vn * n.x; vy -= vn * n.y; vz -= vn * n.z;
    const k = s / (Math.hypot(vx, vy, vz) || 1);
    vx *= k; vy *= k; vz *= k;
  }
  b.vx = vx; b.vy = vy; b.vz = vz;
  b.moving = true; b.still = 0; b.time = 0; b.inCup = false;
}

const N = { x: 0, y: 1, z: 0 };

function collideSegment(course, b, s, ev, ax, az, bx, bz, vbx, vbz, omega, mx, mz) {
  const ex = bx - ax, ez = bz - az;
  const l2 = ex * ex + ez * ez;
  let t = ((b.x - ax) * ex + (b.z - az) * ez) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * ex, qz = az + t * ez;
  const dx = b.x - qx, dz = b.z - qz;
  const rr = BALL_R + s.rad;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return false;
  const top = (s.cell ? course.heightCell(s.cell, qx, qz) : 0) + s.h;
  if (b.y - BALL_R * 0.5 > top) return false; // la balle passe au-dessus
  let nx, nz;
  const d = Math.sqrt(d2);
  if (d < 1e-9) {
    const l = Math.sqrt(l2);
    nx = -ez / l; nz = ex / l;
  } else { nx = dx / d; nz = dz / d; }
  b.x = qx + nx * rr;
  b.z = qz + nz * rr;
  // vitesse du point de contact (obstacle tournant)
  let vqx = 0, vqz = 0;
  if (omega) { vqx = -omega * (qz - mz); vqz = omega * (qx - mx); }
  const rvx = b.vx - vqx, rvz = b.vz - vqz;
  const vn = rvx * nx + rvz * nz;
  if (vn < 0) {
    const e = s.e;
    b.vx -= (1 + e) * vn * nx;
    b.vz -= (1 + e) * vn * nz;
    // frottement tangentiel léger
    const tvx = rvx - vn * nx, tvz = rvz - vn * nz;
    b.vx -= tvx * 0.05; b.vz -= tvz * 0.05;
    if (ev) ev.push({ type: s.kind === 'mill' ? 'mill' : 'wall', speed: -vn });
    return true;
  }
  return false;
}

function collidePost(course, b, p, ev) {
  const dx = b.x - p.x, dz = b.z - p.z;
  const rr = BALL_R + p.r;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return;
  const top = (p.cell ? course.heightCell(p.cell, p.x, p.z) : 0) + p.h;
  if (b.y - BALL_R * 0.5 > top) return;
  const d = Math.sqrt(d2) || 1e-6;
  const nx = dx / d, nz = dz / d;
  b.x = p.x + nx * rr; b.z = p.z + nz * rr;
  const vn = b.vx * nx + b.vz * nz;
  if (vn < 0) {
    b.vx -= (1 + p.e) * vn * nx;
    b.vz -= (1 + p.e) * vn * nz;
    if (ev) ev.push({ type: 'post', speed: -vn });
  }
}

function collideMills(course, b, c, t, ev) {
  let hit = false;
  for (const m of c.mills) {
    const th = m.phase + m.omega * t;
    const ux = Math.cos(th) * m.half, uz = Math.sin(th) * m.half;
    if (collideSegment(course, b, m, ev, m.x - ux, m.z - uz, m.x + ux, m.z + uz, 0, 0, m.omega, m.x, m.z)) hit = true;
  }
  return hit;
}

function collideAll(course, b, c, t, ev) {
  for (const s of c.segs) collideSegment(course, b, s, ev, s.ax, s.az, s.bx, s.bz, 0, 0, 0, 0, 0);
  for (const p of c.posts) collidePost(course, b, p, ev);
  if (c.mills.length) collideMills(course, b, c, t, ev);
}

function substep(course, b, h, t, ev) {
  let c = course.cellAt(b.x, b.z);
  if (!c) {
    // hors du parcours : chute libre jusqu'au sol
    b.vy -= GRAVITY * h;
    b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
    if (b.y < GROUND_Y + BALL_R) {
      b.y = GROUND_Y + BALL_R;
      b.oob = true; b.moving = false;
      if (ev) ev.push({ type: 'oob' });
    }
    return;
  }
  const nx = b.nx, ny = b.ny, nz = b.nz;
  const H = course.heightCell(c, b.x, b.z);
  const gap = (b.y - H) * ny - BALL_R;
  const contact = gap < 0.004;

  // gravité (réduite tangentiellement pour le roulement)
  let ax = 0, ay = -GRAVITY, az = 0;
  if (contact) {
    const gn = -GRAVITY * ny;
    ax -= ROLL_FACTOR * (-gn * nx);
    ay -= ROLL_FACTOR * (-GRAVITY - gn * ny);
    az -= ROLL_FACTOR * (-gn * nz);
  }
  b.vx += ax * h; b.vy += ay * h; b.vz += az * h;

  let sand = false;
  if (contact) {
    sand = c.sands.length > 0 && course.isSand(c, b.x, b.z);
    const vn = b.vx * nx + b.vy * ny + b.vz * nz;
    const tx = b.vx - vn * nx, ty = b.vy - vn * ny, tz = b.vz - vn * nz;
    const ts = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const dv = ((sand ? SAND_DECEL : ROLL_DECEL) * ny + LIN_DAMP * ts) * h;
    if (ts <= dv) { b.vx -= tx; b.vy -= ty; b.vz -= tz; }
    else { const f = dv / ts; b.vx -= tx * f; b.vy -= ty * f; b.vz -= tz * f; }
  } else {
    const f = 1 - 0.02 * h;
    b.vx *= f; b.vz *= f;
  }

  b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;

  // murs et obstacles
  collideAll(course, b, c, t, ev);

  // sol
  c = course.cellAt(b.x, b.z);
  if (!c) return;
  course.normalCell(c, b.x, b.z, N);
  b.nx = N.x; b.ny = N.y; b.nz = N.z;
  const H2 = course.heightCell(c, b.x, b.z);
  const pen = BALL_R - (b.y - H2) * N.y;
  if (pen > 0) {
    b.y += pen / N.y;
    const vn = b.vx * N.x + b.vy * N.y + b.vz * N.z;
    if (vn < 0) {
      const bounce = vn < -0.9;
      const e = bounce ? GROUND_RESTITUTION : 0;
      b.vx -= (1 + e) * vn * N.x; b.vy -= (1 + e) * vn * N.y; b.vz -= (1 + e) * vn * N.z;
      if (bounce && ev) ev.push({ type: 'bounce', speed: -vn });
    }
  }

  // trou
  if (c === course.cupCell) {
    const dx = b.x - course.cup.x, dz = b.z - course.cup.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < CUP_R * CUP_R) {
      if (!b.inCup) {
        b.inCup = true;
        const sp = Math.hypot(b.vx, b.vz);
        let captured = sp < 0.35;
        if (!captured && b.y - H2 < BALL_R * 2.5) {
          const ux = b.vx / sp, uz = b.vz / sp;
          const pd = dx * ux + dz * uz;
          const L = -pd + Math.sqrt(Math.max(0, pd * pd - (d2 - CUP_R * CUP_R)));
          const tt = L / sp;
          captured = 0.5 * GRAVITY * tt * tt > CAPTURE_DROP;
          b.lipOff = dx * -uz + dz * ux;
        }
        if (captured) {
          b.holed = true; b.moving = false;
          b.vx = b.vy = b.vz = 0;
          if (ev) ev.push({ type: 'holed' });
          return;
        }
      }
    } else if (b.inCup) {
      // la balle ressort : effet de lèvre
      b.inCup = false;
      const sp = Math.hypot(b.vx, b.vz);
      if (sp > 0.01) {
        const phi = (b.lipOff / CUP_R) * 0.55;
        const cs = Math.cos(phi), sn = Math.sin(phi);
        const vx = b.vx * cs - b.vz * sn, vz = b.vx * sn + b.vz * cs;
        b.vx = vx * 0.72; b.vz = vz * 0.72;
        b.vy += 0.25;
        if (ev) ev.push({ type: 'lip', speed: sp });
      }
    }
  }

  // arrêt
  const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  if (contact && spd < 0.045) {
    const sinT = Math.sqrt(Math.max(0, 1 - N.y * N.y));
    const slopeAcc = (5 / 7) * GRAVITY * sinT;
    const fric = (sand ? SAND_DECEL : ROLL_DECEL) * N.y;
    if (slopeAcc < fric) {
      b.still += h;
      if (b.still > 0.1) {
        b.vx = b.vy = b.vz = 0;
        b.moving = false;
        if (ev) ev.push({ type: 'stop' });
      }
    } else b.still = 0;
  } else b.still = 0;
}

// Avance la simulation de dt secondes. t = horloge du trou (obstacles mobiles).
export function stepBall(course, b, dt, t, ev) {
  if (b.holed || b.oob) return;
  if (!b.moving) {
    // un obstacle mobile peut pousser une balle à l'arrêt
    const c = course.cellAt(b.x, b.z);
    if (c && c.mills.length) {
      const vx = b.vx, vz = b.vz;
      if (collideMills(course, b, c, t, ev)) {
        b.moving = true; b.still = 0;
        if (Math.hypot(b.vx, b.vz) < 0.2) { const k = 0.2 / (Math.hypot(b.vx, b.vz) || 1); b.vx *= k; b.vz *= k; }
      } else { b.vx = vx; b.vz = vz; }
    }
    if (!b.moving) return;
  }
  const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  const n = Math.min(60, Math.max(1, Math.ceil((sp * dt) / (BALL_R * 0.45))));
  const h = dt / n;
  for (let k = 0; k < n && b.moving; k++) substep(course, b, h, t + k * h, ev);
  b.time += dt;
  if (b.moving && b.time > 25) { // sécurité : balle coincée dans une oscillation
    b.vx = b.vy = b.vz = 0; b.moving = false;
    if (ev) ev.push({ type: 'stop' });
  }
}

// Met à jour la normale en cache (à appeler après placement)
export function refreshNormal(course, b) {
  const c = course.cellAt(b.x, b.z);
  if (!c) { b.nx = 0; b.ny = 1; b.nz = 0; return; }
  course.normalCell(c, b.x, b.z, N);
  b.nx = N.x; b.ny = N.y; b.nz = N.z;
}
