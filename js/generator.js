// Génère un trou jouable (définition sérialisable + PAR estimé)
import { RNG } from './rng.js';
import { buildDef, Course } from './course.js';
import { estimatePar } from './bot.js';

export function heuristicPar(def) {
  const n = def.cells.length;
  let turns = 0, ramps = 0, feats = 0;
  for (const c of def.cells) {
    if (c.din !== c.dout) turns++;
    if (c.ramp) ramps++;
    if (c.feat) feats++;
  }
  const obst = def.posts.length + def.blocks.length / 2 + def.mills.length * 2 + def.sands.length;
  const d = 1.3 + n * 0.17 + turns * 0.25 + ramps * 0.15 + feats * 0.08 + obst * 0.15;
  return Math.max(2, Math.min(6, Math.round(d)));
}

export function generateHole(seed, index, opts = {}) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = new RNG(`${seed}#${index}#${attempt}`);
    const def = buildDef(rng, seed, index);
    if (!def) continue;
    if (opts.skipPar) {
      def.par = heuristicPar(def);
      return def;
    }
    const course = new Course(def);
    const est = estimatePar(course, `${seed}#${index}#${attempt}`, opts.runs || 2);
    if (!est.ok) continue;
    def.par = est.par;
    def.length = +est.length.toFixed(1);
    def.botAvg = est.avg;
    return def;
  }
  // repli très improbable : trou droit simple
  const def = buildDef(new RNG(`${seed}#${index}#fallback`), seed, 0);
  def.par = heuristicPar(def);
  return def;
}
