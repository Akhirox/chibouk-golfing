// Sons synthétisés (WebAudio), aucun fichier à charger
let ctx = null;
let master = null;
let muted = false;
try { muted = localStorage.getItem('cg-muted') === '1'; } catch (e) { /* stockage indisponible */ }

function ensure() {
  if (!ctx) {
    // pas de contexte audio avant une première interaction (règle des navigateurs)
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function unlockAudio() { ensure(); }
export function isMuted() { return muted; }
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('cg-muted', m ? '1' : '0'); } catch (e) { /* rien */ }
}

function noiseBuffer(c, dur) {
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function tone(c, t, freq, dur, gain, type = 'sine', slide = 0) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function click(c, t, freq, dur, gain, q = 2) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur);
  const f = c.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t);
}

const last = {};
export function sfx(type, intensity = 1) {
  if (muted) return;
  const c = ensure();
  if (!c) return;
  const now = c.currentTime;
  if (last[type] && now - last[type] < 0.045) return;
  last[type] = now;
  const k = Math.max(0.05, Math.min(1, intensity));
  switch (type) {
    case 'putt':
      click(c, now, 2400, 0.05, 0.5 * k + 0.15, 1.5);
      tone(c, now, 420, 0.07, 0.25 * k + 0.08, 'triangle', 0.6);
      break;
    case 'wall':
      tone(c, now, 180 + 60 * k, 0.12, 0.35 * k, 'triangle', 0.7);
      click(c, now, 900, 0.04, 0.25 * k, 3);
      break;
    case 'post':
    case 'mill':
      tone(c, now, 520, 0.1, 0.3 * k, 'square', 0.5);
      click(c, now, 1800, 0.03, 0.2 * k, 4);
      break;
    case 'bounce':
      tone(c, now, 260, 0.08, 0.2 * k, 'sine', 0.6);
      break;
    case 'lip':
      tone(c, now, 700, 0.06, 0.25, 'triangle', 0.8);
      tone(c, now + 0.07, 600, 0.06, 0.2, 'triangle', 0.8);
      break;
    case 'cup':
      for (let i = 0; i < 4; i++) click(c, now + i * 0.07 * (1 + i * 0.3), 1400 - i * 200, 0.04, 0.35 / (i + 1), 5);
      tone(c, now + 0.33, 140, 0.18, 0.4, 'sine', 0.6);
      break;
    case 'great':
      [523, 659, 784, 1047].forEach((f, i) => tone(c, now + 0.55 + i * 0.09, f, 0.3, 0.18, 'triangle'));
      break;
    case 'good':
      [523, 784].forEach((f, i) => tone(c, now + 0.55 + i * 0.12, f, 0.28, 0.16, 'triangle'));
      break;
    case 'meh':
      [392, 330].forEach((f, i) => tone(c, now + 0.55 + i * 0.14, f, 0.3, 0.13, 'triangle'));
      break;
    case 'oob':
      tone(c, now, 400, 0.45, 0.2, 'sawtooth', 0.35);
      break;
    case 'ui':
      tone(c, now, 880, 0.05, 0.12, 'triangle');
      break;
    case 'join':
      tone(c, now, 660, 0.1, 0.14, 'triangle');
      tone(c, now + 0.1, 990, 0.14, 0.14, 'triangle');
      break;
    default:
      break;
  }
}
