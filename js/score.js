// Score façon golf : termes classiques et totaux par rapport au par
import { MAX_STROKES } from './constants.js';

export const FAIL_SCORE = MAX_STROKES + 1;

export function termFor(strokes, par, holed = true) {
  if (!holed) return { label: 'Limite atteinte', tier: 'bad' };
  if (strokes === 1) return { label: 'Trou en un !', tier: 'ace' };
  const d = strokes - par;
  if (d <= -4) return { label: 'Condor !', tier: 'great' };
  if (d === -3) return { label: 'Albatros !', tier: 'great' };
  if (d === -2) return { label: 'Eagle !', tier: 'great' };
  if (d === -1) return { label: 'Birdie !', tier: 'good' };
  if (d === 0) return { label: 'Par', tier: 'par' };
  if (d === 1) return { label: 'Bogey', tier: 'meh' };
  if (d === 2) return { label: 'Double bogey', tier: 'bad' };
  if (d === 3) return { label: 'Triple bogey', tier: 'bad' };
  return { label: `+${d}`, tier: 'bad' };
}

export function formatToPar(n) {
  if (n === 0) return '±0';
  return n > 0 ? `+${n}` : `${n}`;
}

// totaux d'un joueur sur les trous joués
export function totals(scores, pars) {
  let strokes = 0, par = 0, played = 0;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] == null || pars[i] == null) continue;
    strokes += scores[i];
    par += pars[i];
    played++;
  }
  return { strokes, par, toPar: strokes - par, played };
}

export function rankPlayers(players, pars) {
  return players
    .map((p) => ({ ...p, tot: totals(p.scores || [], pars) }))
    .sort((a, b) => (b.tot.played - a.tot.played) || (a.tot.strokes - b.tot.strokes));
}

export function tierClass(strokes, par) {
  if (strokes == null || par == null) return '';
  const d = strokes - par;
  if (strokes === 1) return 'sc-ace';
  if (d <= -2) return 'sc-eagle';
  if (d === -1) return 'sc-birdie';
  if (d === 0) return 'sc-par';
  if (d === 1) return 'sc-bogey';
  return 'sc-double';
}
