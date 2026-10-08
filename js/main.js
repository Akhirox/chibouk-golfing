// Chibouk Golf — interface, salon et liaison réseau ↔ jeu
import { World } from './render.js';
import { Game, escapeHtml } from './game.js';
import { HostSession, HOST_ID, cleanName, cleanColor } from './session.js';
import { HostNet, ClientNet, errorText } from './net.js';
import { BALL_COLORS, HOLES } from './constants.js';
import { termFor, formatToPar, totals, rankPlayers, tierClass } from './score.js';
import { generateHole } from './generator.js';
import { sfx, unlockAudio, isMuted, setMuted } from './audio.js';
import { Characters } from './characters.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ état
const S = {
  mode: null,          // 'solo' | 'host' | 'client'
  selfId: null,
  session: null,       // HostSession (solo / hôte)
  hostNet: null,
  client: null,        // ClientNet
  code: null,
  players: [],
  pars: new Array(HOLES).fill(null),
  index: -1,
  def: null,
  myStrokes: 0,
  myDone: false,
  phase: 'menu',
  boardTimer: null,
  tabHeld: false,
  boardMode: null,     // 'hole' | 'final' | 'peek'
};

const profile = loadProfile();

// ------------------------------------------------------------------ 3D
const canvas = $('scene');
const world = new World(canvas);
const game = new Game(world, canvas, {
  onStroke(strokes, penalty) {
    S.myStrokes = strokes;
    updateHud();
    toHost({ t: 'stroke', index: S.index, strokes });
    if (!penalty) fadeHint();
  },
  onDone(strokes, holed) {
    S.myDone = true;
    S.myStrokes = strokes;
    const par = S.def?.par ?? 3;
    const term = termFor(strokes, par, holed);
    if (S.def) chars.react('holed', { tier: holed ? term.tier : 'bad', x: S.def.cup.x, z: S.def.cup.z });
    showBigTerm(term, holed ? `${strokes} coup${strokes > 1 ? 's' : ''} · par ${par}` : `${strokes} coups comptés`);
    sfx(term.tier === 'ace' || term.tier === 'great' ? 'great' : term.tier === 'good' ? 'good' : term.tier === 'par' ? 'good' : 'meh');
    toHost({ t: 'done', index: S.index, strokes, holed });
    updateHud();
    if (S.mode !== 'solo') setTimeout(() => { if (S.phase === 'playing' && S.myDone) setStatus('Bien joué ! En attente des autres joueurs…'); }, 1800);
  },
  onToast(text, kind) { notice(text, kind === 'warn' ? 'warn' : ''); },
  onAim(power) {
    $('power').classList.add('on');
    $('power-fill').style.width = `${Math.round(power * 100)}%`;
    $('power-val').textContent = `${Math.round(power * 100)} %`;
  },
  onAimEnd() { $('power').classList.remove('on'); },
  onGameEvent(type, data) { chars.react(type, data); },
  onPos(x, y, z, m) {
    if (S.mode === 'solo' || S.phase !== 'playing') return;
    toHost({ t: 'pos', x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3), m });
  },
});

// personnages autour du parcours (chargés en arrière-plan)
const chars = new Characters(world);
chars.load();

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt, now / 1000);
  chars.update(dt, { ball: game.attract ? null : game.ball, target: game.rig.target });
  world.render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function attract() {
  const seed = Math.random().toString(36).slice(2, 8);
  const def = generateHole(seed, 2 + Math.floor(Math.random() * 6), { skipPar: true });
  game.loadAttract(def);
  chars.setCourse(game.course, { attract: true });
}
attract();

// ------------------------------------------------------------------ écrans
function show(id) {
  for (const s of ['menu', 'lobby', 'loading']) $(s).classList.toggle('hidden', s !== id);
  $('hud').classList.toggle('hidden', id !== 'hud');
  if (id !== 'hud') hideBoard();
  S.phase = id === 'hud' ? 'playing' : id;
}

function menuError(text) { $('menu-error').textContent = text || ''; }

function resetSession() {
  clearInterval(S.boardTimer);
  if (S.session) S.session.close();
  if (S.hostNet) S.hostNet.close();
  if (S.client) S.client.close();
  S.session = null; S.hostNet = null; S.client = null;
  S.mode = null; S.selfId = null; S.code = null; S.players = [];
  S.index = -1; S.def = null;
  game.stop();
  game.clearGhosts();
  setStatus('');
}

function backToMenu(error) {
  resetSession();
  show('menu');
  menuError(error || '');
  attract();
  history.replaceState(null, '', location.pathname + keepParams());
}

function keepParams() {
  // conserve les paramètres de test (serveur PeerJS local)
  const q = new URLSearchParams(location.search);
  const out = new URLSearchParams();
  for (const k of ['peerhost', 'peerport', 'peerpath', 'peersecure']) if (q.get(k)) out.set(k, q.get(k));
  const s = out.toString();
  return s ? `?${s}` : '';
}

// ------------------------------------------------------------------ messages
function toHost(msg) {
  if (S.session) S.session.receive(msg, HOST_ID);
  else if (S.client) S.client.send(msg);
}

function onServer(msg) {
  switch (msg.t) {
    case 'welcome':
      S.selfId = msg.id;
      break;
    case 'refuse':
      backToMenu(msg.reason);
      break;
    case 'lobby':
      S.players = msg.players;
      S.code = msg.code;
      if (S.phase !== 'lobby') enterLobby();
      renderLobby();
      break;
    case 'loading':
      game.stop();
      hideBoard();
      show('loading');
      $('loading-text').textContent = msg.ready > 0 ? 'Préparation du trou suivant…' : 'Génération du parcours…';
      break;
    case 'hole':
      startHole(msg);
      break;
    case 'state':
      S.players = msg.players;
      S.pars = msg.pars;
      renderHudPlayers();
      updateHud();
      for (const p of S.players) {
        if (p.id === S.selfId) continue;
        if (!p.connected) game.removeGhost(p.id);
      }
      if (S.boardMode === 'peek') renderBoard('peek');
      break;
    case 'pos':
      if (msg.id !== S.selfId) game.ghostPos(msg.id, msg.x, msg.y, msg.z);
      break;
    case 'holed':
      if (msg.id !== S.selfId) {
        game.ghostDone(msg.id);
        const p = S.players.find((q) => q.id === msg.id);
        if (p && S.def) {
          const t = termFor(msg.strokes, S.def.par, msg.holed);
          if (msg.holed && (t.tier === 'ace' || t.tier === 'great' || t.tier === 'good')) chars.react('holed', { tier: t.tier, x: S.def.cup.x, z: S.def.cup.z });
          notice(`${p.name} · ${t.label.replace(/ !$/, '')}${msg.holed ? ` (${msg.strokes})` : ''}`);
        }
      }
      break;
    case 'holeEnd':
      S.players = msg.players;
      S.pars = msg.pars;
      setStatus('');
      showHoleEnd(msg);
      break;
    case 'final':
      S.players = msg.players;
      S.pars = msg.pars;
      showFinal(msg);
      break;
    case 'notice':
      notice(msg.text);
      if (msg.sound) sfx(msg.sound);
      break;
    default: break;
  }
}

// ------------------------------------------------------------------ menu
$('btn-solo').addEventListener('click', () => {
  unlockAudio(); sfx('ui');
  resetSession();
  S.mode = 'solo';
  S.selfId = HOST_ID;
  S.session = new HostSession({ net: null, self: profile, deliver: onServer });
  S.session.sendLobby();
});

$('btn-host').addEventListener('click', async () => {
  unlockAudio(); sfx('ui');
  resetSession();
  menuError('');
  setBusy(true, 'Création du salon…');
  S.mode = 'host';
  S.selfId = HOST_ID;
  const net = new HostNet({
    onJoin: (id) => S.session?.onJoin(id),
    onLeave: (id) => S.session?.onLeave(id),
    onMessage: (msg, id) => S.session?.receive(msg, id),
    onError: (err) => notice(errorText(err), 'warn'),
  });
  try {
    await net.start();
  } catch (err) {
    setBusy(false);
    backToMenu(errorText(err));
    return;
  }
  setBusy(false);
  S.hostNet = net;
  S.session = new HostSession({ net, self: profile, deliver: onServer });
  history.replaceState(null, '', `${location.pathname}${withSalon(net.code)}`);
  S.session.sendLobby();
});

async function joinRoom(code) {
  code = (code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(code)) { menuError('Entre le code du salon (5 caractères).'); return; }
  resetSession();
  menuError('');
  setBusy(true, 'Connexion au salon…');
  S.mode = 'client';
  const client = new ClientNet({
    onMessage: onServer,
    onClose: (reason) => { if (S.client === client) backToMenu(reason); },
  });
  S.client = client;
  try {
    await client.join(code);
  } catch (err) {
    setBusy(false);
    if (S.client === client) backToMenu(errorText(err));
    return;
  }
  setBusy(false);
  S.code = code;
  history.replaceState(null, '', `${location.pathname}${withSalon(code)}`);
  client.send({ t: 'hello', name: profile.name, color: profile.color });
}

function withSalon(code) {
  const kp = keepParams();
  return kp ? `${kp}&salon=${code}` : `?salon=${code}`;
}

$('btn-join').addEventListener('click', () => { unlockAudio(); joinRoom($('join-code').value); });
window.addEventListener('pointerdown', () => unlockAudio(), { once: true });
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom($('join-code').value); });
$('join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

function setBusy(on, text) {
  for (const id of ['btn-solo', 'btn-host', 'btn-join']) $(id).disabled = on;
  if (on) menuError(''), ($('menu-error').textContent = text || '');
}

// ------------------------------------------------------------------ salon
function enterLobby() {
  show('lobby');
  if (!game.attract) attract();
  $('pseudo').value = profile.name;
  renderSwatches();
  updatePreview();
}

function renderLobby() {
  const solo = S.mode === 'solo';
  $('lobby-kicker').textContent = solo ? 'Partie solo' : 'Salon · code à partager';
  $('lobby-code').textContent = solo ? 'SOLO' : (S.code || '—');
  $('btn-copy').classList.toggle('hidden', solo);
  const isHost = S.mode !== 'client';
  $('btn-start').classList.toggle('hidden', !isHost);
  $('lobby-wait').classList.toggle('hidden', isHost);
  $('lobby-wait').textContent = 'En attente du lancement par l\'hôte…';
  $('player-count').textContent = solo ? '' : `· ${S.players.length}/8`;
  const ul = $('player-list');
  ul.innerHTML = '';
  for (const p of S.players) {
    const li = document.createElement('li');
    if (p.id === S.selfId) li.classList.add('me');
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span><span>${escapeHtml(p.name)}</span>`
      + `${p.host && !solo ? '<span class="tag">Hôte</span>' : p.id === S.selfId ? '<span class="tag">Toi</span>' : ''}`;
    ul.appendChild(li);
  }
  if (!solo && S.players.length === 1 && isHost) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.style.fontWeight = '400';
    li.style.fontSize = '15px';
    li.textContent = 'Partage le code ou le lien pour inviter tes amis.';
    ul.appendChild(li);
  }
}

function renderSwatches() {
  const box = $('swatches');
  box.innerHTML = '';
  for (const c of BALL_COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c.toLowerCase() === profile.color.toLowerCase() ? ' on' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => { setColor(c); sfx('ui'); });
    box.appendChild(b);
  }
  const custom = document.createElement('label');
  custom.className = 'swatch custom' + (BALL_COLORS.some((c) => c.toLowerCase() === profile.color.toLowerCase()) ? '' : ' on');
  custom.title = 'Couleur personnalisée';
  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = profile.color;
  inp.addEventListener('input', () => setColor(inp.value, false));
  inp.addEventListener('change', () => setColor(inp.value));
  custom.appendChild(inp);
  box.appendChild(custom);
}

function setColor(c, rerender = true) {
  profile.color = cleanColor(c);
  saveProfile();
  updatePreview();
  if (rerender) renderSwatches();
  sendProfile();
}

function updatePreview() { $('ball-preview').style.setProperty('--ball', profile.color); }

$('pseudo').addEventListener('input', (e) => {
  profile.name = cleanName(e.target.value);
  saveProfile();
  sendProfile();
});

let profileTimer = null;
function sendProfile() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(() => toHost({ t: 'profile', name: profile.name, color: profile.color }), 200);
}

$('btn-copy').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?salon=${S.code}`;
  try {
    await navigator.clipboard.writeText(url);
    notice('Lien copié !');
  } catch (e) {
    window.prompt('Copie ce lien :', url);
  }
});

$('btn-start').addEventListener('click', () => { sfx('ui'); S.session?.startGame(); });
$('btn-leave').addEventListener('click', () => backToMenu());

// ------------------------------------------------------------------ partie
function startHole(msg) {
  hideBoard();
  clearInterval(S.boardTimer);
  S.index = msg.index;
  S.def = msg.def;
  S.pars = msg.pars;
  S.players = msg.players;
  S.myStrokes = 0;
  S.myDone = false;
  show('hud');
  setStatus('');
  // fantômes des autres joueurs
  const ids = new Set();
  for (const p of S.players) {
    if (p.id === S.selfId || !p.connected) continue;
    ids.add(p.id);
    game.setGhost(p.id, p.name, p.color);
  }
  for (const id of [...game.ghosts.keys()]) if (!ids.has(id)) game.removeGhost(id);
  const me = S.players.find((p) => p.id === S.selfId);
  game.loadHole(msg.def, me ? me.color : profile.color);
  chars.setCourse(game.course);
  renderHudPlayers();
  updateHud();
  notice(`Trou ${msg.index + 1} · Par ${msg.def.par}${msg.def.length ? ` · ${Math.round(msg.def.length)} m` : ''}`);
}

function updateHud() {
  if (!S.def) return;
  $('hud-hole').textContent = S.index + 1;
  $('hud-of').textContent = `/ ${HOLES}`;
  $('hud-par').textContent = S.def.par;
  $('hud-strokes').textContent = S.myStrokes;
  const me = S.players.find((p) => p.id === S.selfId);
  if (me) {
    const t = totals(me.scores, S.pars);
    $('hud-total').textContent = t.played ? formatToPar(t.toPar) : '±0';
  }
}

function renderHudPlayers() {
  const box = $('hud-players');
  if (S.mode === 'solo') { box.innerHTML = ''; return; }
  const ranked = rankPlayers(S.players, S.pars);
  box.innerHTML = ranked.map((p) => {
    const cur = p.done ? (p.scores[S.index] != null ? `✓ ${p.scores[S.index]}` : '—') : `${p.strokes}`;
    return `<div class="hp-row${p.id === S.selfId ? ' me' : ''}${p.connected ? '' : ' off'}">`
      + `<span class="dot" style="background:${p.color}"></span>`
      + `<span class="nm">${escapeHtml(p.name)}</span>`
      + `<span class="cur${p.done ? ' ok' : ''}">${cur}</span>`
      + `<span class="tot">${p.tot.played ? formatToPar(p.tot.toPar) : '±0'}</span></div>`;
  }).join('');
}

function setStatus(text) {
  $('status').textContent = text;
  $('status').classList.toggle('on', !!text);
}

let termTimer = null;
function showBigTerm(term, sub) {
  const el = $('big-term');
  el.className = `big-term on t-${term.tier}`;
  el.querySelector('b').textContent = term.label;
  el.querySelector('small').textContent = sub;
  clearTimeout(termTimer);
  termTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

let hintFaded = false;
function fadeHint() {
  if (hintFaded) return;
  hintFaded = true;
  setTimeout(() => $('hint').classList.add('fade'), 4000);
}

function notice(text, kind = '') {
  const el = document.createElement('div');
  el.className = `notice ${kind}`;
  el.textContent = text;
  $('notices').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3100);
  while ($('notices').children.length > 4) $('notices').firstChild.remove();
}

// ------------------------------------------------------------------ carte de score
function scoreTable() {
  const pars = S.pars;
  const ranked = rankPlayers(S.players, pars);
  let html = '<thead><tr><th class="name">Trou</th>';
  for (let k = 0; k < HOLES; k++) html += `<th class="${k === S.index ? 'cur' : ''}">${k + 1}</th>`;
  html += '<th>Coups</th><th>Score</th></tr></thead><tbody>';
  html += '<tr class="par"><td class="name">Par</td>';
  let parSum = 0;
  for (let k = 0; k < HOLES; k++) { html += `<td class="${k === S.index ? 'cur' : ''}">${pars[k] ?? '·'}</td>`; parSum += pars[k] || 0; }
  html += `<td>${parSum || ''}</td><td></td></tr>`;
  for (const p of ranked) {
    html += `<tr class="${p.id === S.selfId ? 'me' : ''}${p.connected ? '' : ' off'}"><td class="name"><i style="background:${p.color}"></i>${escapeHtml(p.name)}</td>`;
    for (let k = 0; k < HOLES; k++) {
      const s = p.scores[k];
      html += `<td class="${k === S.index ? 'cur' : ''}">${s == null ? '<span class="muted">·</span>' : `<span class="sc ${tierClass(s, pars[k])}">${s}</span>`}</td>`;
    }
    html += `<td class="tot">${p.tot.played ? p.tot.strokes : '·'}</td><td class="tot">${p.tot.played ? formatToPar(p.tot.toPar) : '·'}</td></tr>`;
  }
  html += '</tbody>';
  return html;
}

function renderBoard(mode) {
  S.boardMode = mode;
  $('board').classList.remove('hidden');
  $('board-table').innerHTML = scoreTable();
  if (mode === 'peek') {
    $('board-kicker').textContent = `Trou ${S.index + 1} / ${HOLES}`;
    $('board-title').textContent = 'Carte de score';
    $('board-timer').textContent = '';
    $('podium').innerHTML = '';
    $('board-foot').innerHTML = '';
    const close = mkBtn('Fermer', 'btn', hideBoard);
    $('board-foot').appendChild(close);
  }
}

function hideBoard() {
  $('board').classList.add('hidden');
  S.boardMode = null;
}

function mkBtn(text, cls, fn) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', () => { sfx('ui'); fn(); });
  return b;
}

function showHoleEnd(msg) {
  renderBoard('hole');
  $('board-kicker').textContent = `Trou ${msg.index + 1} / ${HOLES} terminé`;
  $('board-title').textContent = msg.last ? 'Dernier trou bouclé !' : 'Récapitulatif';
  // résultats du trou
  const par = msg.pars[msg.index];
  const rows = rankPlayers(msg.players, msg.pars).map((p) => {
    const s = p.scores[msg.index];
    if (s == null) return '';
    const t = termFor(s, par, s <= 10);
    return `<div class="pod${p.id === S.selfId ? ' first' : ''}"><span class="dot" style="background:${p.color}"></span>`
      + `<div class="who"><b>${escapeHtml(p.name)}</b><small>${s} coup${s > 1 ? 's' : ''} · <span class="board-term ${t.tier === 'good' || t.tier === 'great' || t.tier === 'ace' ? 'good' : ''}">${t.label}</span></small></div></div>`;
  }).join('');
  $('podium').innerHTML = S.mode === 'solo' ? '' : rows;
  $('podium').style.flexWrap = 'wrap';
  const foot = $('board-foot');
  foot.innerHTML = '';
  clearInterval(S.boardTimer);
  if (!msg.last) {
    let left = msg.delay;
    const tick = () => {
      $('board-timer').textContent = left > 0 ? `Trou suivant dans ${left} s` : '';
      left--;
    };
    tick();
    S.boardTimer = setInterval(tick, 1000);
    if (S.session) foot.appendChild(mkBtn('Trou suivant', 'btn primary', () => S.session.next()));
  } else {
    $('board-timer').textContent = 'Résultats…';
  }
}

function showFinal(msg) {
  clearInterval(S.boardTimer);
  game.stop();
  S.index = -1;
  for (const id of ['menu', 'lobby', 'loading', 'hud']) $(id).classList.add('hidden');
  S.phase = 'final';
  setStatus('');
  renderBoard('final');
  const ranked = rankPlayers(msg.players, msg.pars);
  const totalPar = msg.pars.reduce((a, b) => a + (b || 0), 0);
  $('board-kicker').textContent = `Parcours #${msg.seed} · par ${totalPar}`;
  const winner = ranked[0];
  $('board-title').textContent = S.mode === 'solo'
    ? `${winner.tot.strokes} coups · ${formatToPar(winner.tot.toPar)}`
    : `${winner.name} remporte la partie !`;
  $('board-timer').textContent = '';
  $('podium').style.flexWrap = '';
  $('podium').innerHTML = ranked.slice(0, 3).map((p, i) =>
    `<div class="pod${i === 0 ? ' first' : ''}"><span class="rank">${i + 1}</span><span class="dot" style="background:${p.color}"></span>`
    + `<div class="who"><b>${escapeHtml(p.name)}</b><small>${p.tot.strokes} coups · ${formatToPar(p.tot.toPar)}</small></div></div>`).join('');
  const foot = $('board-foot');
  foot.innerHTML = '';
  if (S.session) {
    foot.appendChild(mkBtn('Menu', 'btn ghost', () => backToMenu()));
    if (S.mode === 'host') foot.appendChild(mkBtn('Retour au salon', 'btn', () => S.session.backToLobby()));
    foot.appendChild(mkBtn('Nouveau parcours', 'btn primary', () => S.session.startGame()));
  } else {
    foot.appendChild(mkBtn('Quitter', 'btn ghost', () => backToMenu()));
    const w = document.createElement('span');
    w.className = 'muted';
    w.style.alignSelf = 'center';
    w.textContent = 'L\'hôte peut relancer une partie.';
    foot.appendChild(w);
  }
  const me = ranked.findIndex((p) => p.id === S.selfId);
  sfx(me === 0 ? 'great' : 'good');
}

// ------------------------------------------------------------------ boutons HUD
$('btn-card').addEventListener('click', () => {
  if (S.boardMode === 'peek') hideBoard();
  else if (!S.boardMode) renderBoard('peek');
});
$('btn-view').addEventListener('click', () => { game.rig.overview = !game.rig.overview; });
$('btn-quit').addEventListener('click', () => {
  if (window.confirm('Quitter la partie en cours ?')) backToMenu();
});
function renderMute() {
  $('btn-mute').innerHTML = isMuted()
    ? '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
}
$('btn-mute').addEventListener('click', () => { setMuted(!isMuted()); renderMute(); });
renderMute();
function renderChars() {
  const person = '<circle cx="12" cy="6" r="3" fill="currentColor"/><path d="M6 21v-5a6 6 0 0112 0v5" fill="currentColor"/>';
  $('btn-chars').innerHTML = `<svg viewBox="0 0 24 24">${person}${chars.enabled ? '' : '<path d="M4 4l16 16" stroke="#0c0c0d" stroke-width="4"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2"/>'}</svg>`;
  $('btn-chars').style.opacity = chars.enabled ? '1' : '0.6';
}
$('btn-chars').addEventListener('click', () => { chars.setEnabled(!chars.enabled); renderChars(); });
renderChars();

window.addEventListener('keydown', (e) => {
  if (e.code === 'Tab' && S.phase === 'playing' && S.index >= 0) {
    e.preventDefault();
    if (!S.boardMode) { renderBoard('peek'); S.tabHeld = true; }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab' && S.tabHeld) { S.tabHeld = false; if (S.boardMode === 'peek') hideBoard(); }
});
window.addEventListener('beforeunload', () => { try { S.hostNet?.close(); S.client?.close(); } catch (er) { /* rien */ } });

// ------------------------------------------------------------------ profil
function loadProfile() {
  let name = '', color = '';
  try { name = localStorage.getItem('cg-name') || ''; color = localStorage.getItem('cg-color') || ''; } catch (e) { /* rien */ }
  return {
    name: cleanName(name || `Golfeur ${Math.floor(10 + Math.random() * 90)}`),
    color: cleanColor(color || BALL_COLORS[Math.floor(Math.random() * 5)]),
  };
}
function saveProfile() {
  try { localStorage.setItem('cg-name', profile.name); localStorage.setItem('cg-color', profile.color); } catch (e) { /* rien */ }
}

// ------------------------------------------------------------------ lien d'invitation
const salon = new URLSearchParams(location.search).get('salon');
if (salon) {
  $('join-code').value = salon.toUpperCase();
  joinRoom(salon);
}

// accès debug pour les tests
window.__cg = { S, game, world, chars };
