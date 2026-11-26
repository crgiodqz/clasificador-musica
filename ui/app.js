'use strict';
/* Clasificador de música - interfaz. Vanilla JS, sin dependencias. */

// ---------- Tauri / modo prueba ----------
const TAURI = window.__TAURI__;
const MOCK = !TAURI;
let invoke, convertFileSrc, listen;

// ---------- utilidades ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => (n < 10 ? '0' : '') + n;
function fmt(t, tenths) {
  if (!isFinite(t) || t < 0) t = 0;
  if (tenths) t = Math.round(t * 10) / 10;
  const whole = Math.floor(t), frac = t - whole;
  const m = Math.floor(whole / 60), s = whole % 60;
  return m + ':' + pad(s) + (tenths && frac > 0.04 ? '.' + Math.round(frac * 10) : '');
}
function parseT(str) {
  str = String(str).trim().replace(',', '.');
  if (!str) return null;
  const parts = str.split(':');
  if (parts.length > 3 || parts.some(p => p === '' || isNaN(Number(p)))) return NaN;
  return parts.reduce((a, p) => a * 60 + Number(p), 0);
}
function hexRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
  const n = m ? parseInt(m[1], 16) : 0x8f897c;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// color de categoría desaturado: mezcla con gris cálido para no romper carbón/marfil
function mute(h) {
  const [r, g, b] = hexRgb(h), k = 0.45, G = [143, 137, 124];
  return [r, g, b].map((v, i) => Math.round(v * (1 - k) + G[i] * k));
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const round1 = t => Math.round(t * 10) / 10;
const intersects = (arr, set) => !!arr && arr.some(v => set.has(v));
const DPR = () => window.devicePixelRatio || 1;
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const errText = e => String((e && e.message) || e);
const GRIP = '<svg viewBox="0 0 10 14" width="9" height="12"><g fill="currentColor"><circle cx="2.5" cy="2" r="1.3"/><circle cx="7.5" cy="2" r="1.3"/><circle cx="2.5" cy="7" r="1.3"/><circle cx="7.5" cy="7" r="1.3"/><circle cx="2.5" cy="12" r="1.3"/><circle cx="7.5" cy="12" r="1.3"/></g></svg>';
const TICK = '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M2 6.5l2.6 2.6L10 3.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const CHEV = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M3 1l5 4-5 4z" fill="currentColor"/></svg>';
const hasWave = an => !!an && an.duration > 0;
const fbPending = f => !!f.analysis && f.analysis.duration === 0 && !f._fbFail;
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const baseName = p => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);

// ---------- configuración de la interfaz (ui) ----------
const UI_DEFAULTS = { theme: 'dark', tagLayout: 'wrap', skipSilence: true, dragTrimmed: false, coverMode: 'file', askMomentName: false, volMax: 2, vol: 0.4,
  view: 'list', hideAuthor: false, waveH: 182, cropOnPick: true, cueTransition: 'cut', cueFade: 1.5,
  panels: { filters: true, list: true, detail: true, player: true }, cuesOpen: false };
let UI = Object.assign({}, UI_DEFAULTS);
let uiTimer = 0;
function scheduleUISave() { clearTimeout(uiTimer); uiTimer = setTimeout(flushUI, 300); }
function flushUI() {
  if (!uiTimer) return;
  clearTimeout(uiTimer); uiTimer = 0;
  invoke('save_ui_settings', { ui: UI }).catch(e => toast('No se pudo guardar la configuración: ' + errText(e)));
}
function setUI(patch) {
  const prev = UI;
  UI = Object.assign({}, UI, patch);
  if ('volMax' in patch && patch.volMax !== prev.volMax) {
    // mantiene la ganancia al cambiar el máximo
    const g = gainFromPos(prev.vol, prev.volMax);
    UI.vol = posFromGain(Math.min(g, UI.volMax), UI.volMax);
  }
  scheduleUISave();
  applyUI(prev);
}
function applyUI(prev) {
  prev = prev || {};
  if (UI.theme !== prev.theme) applyTheme();
  document.body.dataset.taglayout = UI.tagLayout;
  if (UI.tagLayout !== prev.tagLayout && lib) renderDetail();
  applyVolume();
  if (UI.skipSilence !== prev.skipSilence && lib) { drawWave(); renderDetail(); }
  if (typeof applyLayoutUI === 'function') applyLayoutUI(prev);
}

// ---------- tema ----------
const darkMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let colors = {};
function resolvedTheme() { return UI.theme === 'light' ? 'light' : UI.theme === 'system' ? (darkMQ && !darkMQ.matches ? 'light' : 'dark') : 'dark'; }
function readColors() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  colors = { theme: document.documentElement.dataset.theme, ac: v('--ac'), bg: v('--bgrgb'), wavebg: v('--wavebg'), hi: v('--gold2'), text: v('--text'), mini: v('--mini'), minicur: v('--minicur'), wline: v('--wline') };
}
function applyTheme() {
  const th = resolvedTheme();
  document.documentElement.dataset.theme = th;
  try { localStorage.setItem('clf_theme', UI.theme); } catch (e) { }
  readColors();
  if (typeof buildWaveCache === 'function' && lib) { buildWaveCache(); drawWave(); renderList(true); }
}
if (darkMQ) {
  const onMQ = () => { if (UI.theme === 'system') applyTheme(); };
  if (darkMQ.addEventListener) darkMQ.addEventListener('change', onMQ); else if (darkMQ.addListener) darkMQ.addListener(onMQ);
}
try { const t = localStorage.getItem('clf_theme'); if (t === 'light' || t === 'system') UI.theme = t; } catch (e) { }
document.documentElement.dataset.theme = resolvedTheme();
readColors();

// ---------- estado ----------
let S = { folder: '', files: [], photos: [], library: null, pending: 0, roots: [] };
let lib = null;
const byId = new Map();
let curId = null;          // tema cargado en el reproductor
let selected = new Set();  // temas seleccionados en la lista
let anchorId = null;
const filters = { q: '', fav: false, untagged: false, moments: false, cats: {}, folders: new Set() };
let sortBy = 'name';
let view = [];            // [{f, subs:[moment]}]
let counts = { cats: {}, fav: 0, untagged: 0, moments: 0 };
let folderGroups = [];
let pendingN = 0;
const collapsed = new Set();
const expMoms = new Set();
let selMom = null;         // momento seleccionado en la onda / panel
let pendingIn = null;      // {id, t} inicio marcado con I
const coverVer = {};
let coverClip = null;      // {path}

const DEFAULT_CATS = [
  { id: 'artista', name: 'Artista', color: '#b8a98a', multi: false, values: [] },
  { id: 'tipo', name: 'Tipo', color: '#7f9bb0', multi: true, values: [] },
  { id: 'emocion', name: 'Emoción', color: '#b08590', multi: true, values: [] },
  { id: 'copyright', name: 'Reclamos', color: '#b3906f', multi: true, values: [] },
  { id: 'usado', name: 'Usado en', color: '#9a8fb3', multi: true, values: [] },
];
function normalizeLib(l) {
  l = l || {};
  if (!Array.isArray(l.categories) || !l.categories.length) l.categories = JSON.parse(JSON.stringify(DEFAULT_CATS));
  l.version = 1;
  l.tracks = l.tracks || {};
  for (const id in l.tracks) {
    const t = l.tracks[id];
    t.tags = t.tags || {}; t.notes = t.notes || ''; t.fav = !!t.fav; t.moments = t.moments || [];
    t.moments.forEach(m => { m.tags = m.tags || {}; if (m.end === undefined) m.end = null; });
  }
  const cu = l.cues = (l.cues && typeof l.cues === 'object') ? l.cues : {};
  if (!Array.isArray(cu.sets)) cu.sets = [];
  cu.sets.forEach(st => { st.items = Array.isArray(st.items) ? st.items : []; st.items.forEach(it => { if (it.end === undefined) it.end = null; it.label = it.label || ''; }); });
  if (cu.active === undefined || (cu.active && !cu.sets.some(x => x.id === cu.active))) cu.active = cu.sets.length ? cu.sets[0].id : null;
  return l;
}
// nombre para mostrar: con "Ocultar el autor" se ve solo lo que va después del primer " - "
function dn(f) {
  const n = typeof f === 'string' ? f : (f && f.name) || '';
  if (!UI.hideAuthor) return n;
  const i = n.indexOf(' - '), rest = i >= 0 ? n.slice(i + 3).trim() : '';
  return rest || n;
}
const T = id => lib.tracks[id];
function TW(id) { return lib.tracks[id] || (lib.tracks[id] = { tags: {}, notes: '', fav: false, moments: [] }); }
const catById = id => lib.categories.find(c => c.id === id);
function hasTags(t) { return !!t && Object.values(t.tags).some(a => a && a.length); }

function applyState(st) {
  S = st;
  S.roots = S.roots || (S.folder ? [{ path: S.folder, key: '', excluded: [], exists: true }] : []);
  S.files.forEach(f => { if (f.root === undefined) f.root = ''; if (f.rel === undefined) f.rel = f.id.includes('::') ? f.id.split('::').slice(1).join('::') : f.id; if (f.cover === undefined) f.cover = null; });
  $('#welcome').hidden = !st.needs_folder;
  lib = normalizeLib(st.library);
  S.library = lib;
  if (!uiTimer && st.ui) {
    const had = st.ui.vol !== undefined;
    UI = Object.assign({}, UI_DEFAULTS, st.ui);
    if (!had) { try { const v = parseFloat(localStorage.getItem('clf_vol')); if (isFinite(v) && v > 0 && v <= 1) UI.vol = Math.min(1, v * 0.5); } catch (e) { } }
  }
  byId.clear();
  S.files.forEach(f => byId.set(f.id, f));
  pendingN = S.pending || 0;
  undoStack.length = 0;
  selected = new Set([...selected].filter(id => byId.has(id)));
  if (anchorId && !byId.has(anchorId)) anchorId = null;
  if (curId && !byId.has(curId)) { curId = null; audio.removeAttribute('src'); audio.load(); selMom = null; pendingIn = null; momentPlay = null; }
  if (curId && !selected.size) selected.add(curId);
  if (selMom && !(curId && T(curId) && T(curId).moments.some(m => m.id === selMom))) selMom = null;
  refreshAll();
  applyUI({});
  if (!$('#settings').hidden) renderSettings();
  S.files.forEach(f => { if (f.analysis && f.analysis.duration === 0) queueFallback(f.id); });
}

// ---------- persistencia ----------
let saveTimer = 0;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 400); }
let lastSave = Promise.resolve();
function flushSave() {
  if (!saveTimer) return lastSave;
  clearTimeout(saveTimer); saveTimer = 0;
  lastSave = invoke('save_library', { library: lib }).catch(e => toast('No se pudo guardar: ' + e));
  return lastSave;
}
function dropPendingSave() { clearTimeout(saveTimer); saveTimer = 0; }

// Al volver a la ventana (por ejemplo después de bajar música), reescanea solo si cambió la carpeta.
let lastAutoScan = Date.now(), autoScanning = false;
window.addEventListener('focus', async () => {
  if (MOCK || autoScanning || Date.now() - lastAutoScan < 4000) return;
  autoScanning = true; lastAutoScan = Date.now();
  try {
    await flushSave();
    const st = await invoke('rescan');
    const sig = fs => fs.map(f => f.id + ':' + f.size).join('|');
    if (sig(st.files) !== sig(S.files)) {
      const nuevos = st.files.length - S.files.length;
      applyState(st);
      if (nuevos > 0) toast(nuevos === 1 ? 'Apareció 1 tema nuevo' : 'Aparecieron ' + nuevos + ' temas nuevos');
    }
  } catch (e) { /* silencioso */ } finally { autoScanning = false; }
});
window.addEventListener('pagehide', () => { flushSave(); flushUI(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { flushSave(); flushUI(); } });

function libChanged(opt) {
  opt = opt || {};
  scheduleSave();
  if (opt.light) return;
  computeCounts(); computeView(); renderFilters(); layoutList(); renderList(true);
  if (!opt.skipDetail) renderDetail();
  if (quick.on) renderQuickBar();
  updateRange(); drawWave();
}
function refreshAll() {
  computeCounts(); computeView(); renderFilters(); layoutList(); renderList(true);
  renderDetail(); renderHead(); renderPlayerInfo(); renderQuickBar(); resizeWave(); renderCues();
}

// ---------- deshacer ----------
const undoStack = [];
function pushUndo() {
  if (!lib) return;
  undoStack.push(JSON.stringify(lib.tracks));
  if (undoStack.length > 50) undoStack.shift();
}
function undo() {
  if (!undoStack.length) { toast('No hay nada para deshacer'); return; }
  lib.tracks = JSON.parse(undoStack.pop());
  normalizeLib(lib);
  if (momentPlay && !(curId && T(curId) && T(curId).moments.some(m => m.id === momentPlay.id))) momentPlay = null;
  if (selMom && !(curId && T(curId) && T(curId).moments.some(m => m.id === selMom))) selMom = null;
  libChanged(); toast('Deshecho');
}

// ---------- filtros / vista ----------
function groupOf(f) {
  const top = f.rel && f.rel.includes('/') ? f.rel.split('/')[0] : '';
  return (f.root || '') + '\u0001' + top;
}
function computeCounts() {
  const c = { cats: {}, fav: 0, untagged: 0, moments: 0 };
  lib.categories.forEach(cat => { c.cats[cat.id] = {}; cat.values.forEach(v => c.cats[cat.id][v] = 0); });
  const groups = new Map();
  for (const f of S.files) {
    const gid = groupOf(f);
    if (!groups.has(gid)) groups.set(gid, { id: gid, root: f.root || '', top: gid.split('\u0001')[1], n: 0 });
    groups.get(gid).n++;
    const t = T(f.id);
    if (!t) { c.untagged++; continue; }
    if (t.fav) c.fav++;
    if (!hasTags(t)) c.untagged++;
    if (t.moments.length) c.moments++;
    const seen = {};
    const add = (tags) => { for (const cid in tags) (tags[cid] || []).forEach(v => { const k = cid + '\u0001' + v; if (!seen[k] && c.cats[cid] && v in c.cats[cid]) { seen[k] = 1; c.cats[cid][v]++; } }); };
    add(t.tags); t.moments.forEach(m => add(m.tags));
  }
  counts = c;
  const roots = S.roots || [], multi = roots.length > 1;
  const rootName = key => { const r = roots.find(x => (x.key || '') === key); return r ? baseName(r.path) : (key || 'Principal'); };
  const withSubs = new Set([...groups.values()].filter(g => g.top).map(g => g.root));
  folderGroups = [...groups.values()].map(g => {
    let label;
    if (g.top) label = (multi ? rootName(g.root) + ' / ' : '') + g.top;
    else label = rootName(g.root) + (withSubs.has(g.root) ? ' (suelta)' : '');
    return Object.assign(g, { label });
  }).sort((a, b) => a.label.localeCompare(b.label, 'es', { numeric: true, sensitivity: 'base' }));
  for (const id of [...filters.folders]) if (!groups.has(id)) filters.folders.delete(id);
}
function computeView() {
  const q = fold(filters.q).trim(), qTokens = q.split(/\s+/).filter(Boolean);
  const active = lib.categories.filter(c => filters.cats[c.id] && filters.cats[c.id].size);
  const out = [];
  for (const f of S.files) {
    const t = T(f.id);
    if (filters.folders.size && !filters.folders.has(groupOf(f))) continue;
    if (filters.fav && !(t && t.fav)) continue;
    if (filters.untagged && hasTags(t)) continue;
    if (filters.moments && !(t && t.moments.length)) continue;
    const moms = t ? t.moments : [];
    let subs = [];
    let allTrack = true, momMatch = [];
    if (active.length) {
      const trackOk = c => t && intersects(t.tags[c.id], filters.cats[c.id]);
      allTrack = active.every(trackOk);
      momMatch = moms.filter(m => active.some(c => intersects(m.tags[c.id], filters.cats[c.id])) &&
        active.every(c => intersects(m.tags[c.id], filters.cats[c.id]) || trackOk(c)));
      if (!allTrack && !momMatch.length) continue;
    }
    let trackQ = true, momQ = [];
    if (q) {
      const hay = fold(f.name + ' ' + (t ? t.notes : '') + ' ' + (t ? Object.values(t.tags).flat().join(' ') : ''));
      trackQ = qTokens.every(w => hay.includes(w));
      momQ = moms.filter(m => { const mh = hay + ' ' + fold(m.label + ' ' + Object.values(m.tags).flat().join(' ')); return qTokens.every(w => mh.includes(w)); });
      if (!trackQ && !momQ.length) continue;
    }
    if (active.length && q) {
      if (trackQ) subs = momMatch;
      else if (allTrack) subs = momQ;
      else { subs = momMatch.filter(m => momQ.includes(m)); if (!subs.length) continue; }
    } else if (active.length) subs = momMatch;
    else if (q) subs = trackQ ? [] : momQ;
    out.push({ f, subs: subs.slice().sort((a, b) => a.start - b.start) });
  }
  const nm = (a, b) => a.f.name.localeCompare(b.f.name, 'es', { numeric: true, sensitivity: 'base' });
  const num = (get, dir) => (a, b) => {
    const x = get(a.f), y = get(b.f);
    if (x == null && y == null) return nm(a, b);
    if (x == null) return 1; if (y == null) return -1;
    return (x - y) * dir || nm(a, b);
  };
  if (sortBy === 'name') out.sort(nm);
  else if (sortBy === 'dur') out.sort(num(f => f.analysis && f.analysis.duration, -1));
  else if (sortBy === 'bpm') out.sort(num(f => f.analysis && f.analysis.bpm, 1));
  else out.sort(num(f => f.mtime, -1));
  view = out;
  renderHead();
}
function filtersActive() {
  return filters.q || filters.fav || filters.untagged || filters.moments || filters.folders.size || Object.values(filters.cats).some(s => s.size);
}

// ---------- panel izquierdo ----------
function chipHTML(cat, v, on, n) {
  const c = mute(cat.color);
  const st = on ? `background:${rgba(c, .5)};border-color:${rgba(c, 1)}` : `background:${rgba(c, .13)};border-color:${rgba(c, .4)}`;
  return `<button class="chip${on ? ' on' : ''}${n === 0 ? ' zero' : ''}" data-cat="${esc(cat.id)}" data-val="${esc(v)}" style="${st}">${esc(v)}<i>${n}</i></button>`;
}
function renderFilters() {
  const q = $('#f-quick');
  const onSt = 'background:rgba(var(--ac),.28);border-color:var(--gold)';
  const qc = (k, label, n) => `<button class="chip${filters[k] ? ' on' : ''}" data-quick="${k}" style="${filters[k] ? onSt : ''}">${label}<i>${n}</i></button>`;
  q.innerHTML = `<div class="chips">${qc('fav', 'Favoritos', counts.fav)}${qc('untagged', 'Sin etiquetar', counts.untagged)}${qc('moments', 'Con momentos', counts.moments)}</div>`;
  const sc = $('#f-scroll').scrollTop;
  let html = '';
  if (folderGroups.length > 1) {
    const col = collapsed.has('__folder'), n = filters.folders.size;
    html += `<div class="fsec"><h4 data-collapse="__folder">Carpeta${n ? ' (' + n + ')' : ''}<span class="car">${col ? '+' : '-'}</span></h4>${col ? '' : '<div class="chips">' + folderGroups.map(g => { const on = filters.folders.has(g.id); return `<button class="chip${on ? ' on' : ''}" data-fold="${esc(g.id)}" style="${on ? onSt : ''}">${esc(g.label)}<i>${g.n}</i></button>`; }).join('') + '</div>'}</div>`;
  }
  html += lib.categories.map(cat => {
    const sel = filters.cats[cat.id] || new Set();
    const col = collapsed.has(cat.id);
    const body = col ? '' : `<div class="chips">${cat.values.length ? cat.values.map(v => chipHTML(cat, v, sel.has(v), (counts.cats[cat.id] || {})[v] || 0)).join('') : '<span style="color:var(--dim2);font-size:12px">Sin valores</span>'}</div>`;
    return `<div class="fsec"><h4 data-collapse="${esc(cat.id)}"><span class="dot" style="background:${rgba(mute(cat.color), 1)}"></span>${esc(cat.name)}${sel.size ? ' (' + sel.size + ')' : ''}<span class="car">${col ? '+' : '-'}</span></h4>${body}</div>`;
  }).join('');
  $('#f-cats').innerHTML = html;
  $('#f-scroll').scrollTop = sc;
}
$('#f-scroll').addEventListener('click', e => {
  const ch = e.target.closest('.chip'), h = e.target.closest('h4');
  if (ch && ch.dataset.quick) { filters[ch.dataset.quick] = !filters[ch.dataset.quick]; }
  else if (ch && ch.dataset.fold) { const s = filters.folders; s.has(ch.dataset.fold) ? s.delete(ch.dataset.fold) : s.add(ch.dataset.fold); }
  else if (ch) {
    const id = ch.dataset.cat, v = ch.dataset.val;
    const s = filters.cats[id] || (filters.cats[id] = new Set());
    s.has(v) ? s.delete(v) : s.add(v);
  } else if (h) { const id = h.dataset.collapse; collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); renderFilters(); return; }
  else return;
  computeView(); renderFilters(); layoutList(); $('#list').scrollTop = 0; renderList(true);
});
let qTimer = 0;
$('#q').addEventListener('input', e => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { filters.q = e.target.value; computeView(); layoutList(); $('#list').scrollTop = 0; renderList(true); }, 120);
});
$('#btn-clear').onclick = () => {
  filters.q = ''; filters.fav = filters.untagged = filters.moments = false; filters.cats = {}; filters.folders = new Set();
  $('#q').value = '';
  computeView(); renderFilters(); layoutList(); renderList(true);
};
async function pickMainFolder() {
  try { await flushSave(); const st = await invoke('pick_folder'); if (st) { subCache = {}; applyState(st); } } catch (e) { toast('Error: ' + errText(e)); }
}
$('#w-pick').onclick = pickMainFolder;
$('#btn-rescan').onclick = async () => {
  toast('Reescaneando...');
  try { await flushSave(); applyState(await invoke('rescan')); toast('Listo'); } catch (e) { toast('Error: ' + errText(e)); }
};
$('#sort').onchange = e => { sortBy = e.target.value; computeView(); layoutList(); renderList(true); e.target.blur(); };
function randomTrack() {
  if (!view.length) { toast('No hay temas en la lista'); return; }
  let pool = view.filter(v => v.f.id !== curId); if (!pool.length) pool = view;
  const f = pool[Math.floor(Math.random() * pool.length)].f;
  selectTrack(f.id, { play: true });
}
$('#btn-rand').onclick = randomTrack;

// ---------- cabecera centro ----------
function renderHead() {
  $('#count').textContent = view.length + (view.length === 1 ? ' tema' : ' temas');
  const p = $('#pending');
  const n = pendingN + fbLeft();
  p.hidden = !(n > 0);
  p.textContent = 'Analizando ondas: ' + n + ' restantes';
}

// ---------- portadas ----------
function coverPath(f) {
  if (f.cover) return f.cover;
  const ph = findPhoto(f);
  return ph ? ph.path : '';
}
function coverURL(f) {
  const p = coverPath(f); if (!p) return '';
  let u = convertFileSrc(p);
  if (!/^data:/.test(u)) u += (u.includes('?') ? '&' : '?') + 'v=' + (coverVer[f.id] || f.mtime || 0);
  return u;
}
function releaseAudio() {
  const k = { t: audio.currentTime || 0, playing: !audio.paused };
  audio.pause(); audio.removeAttribute('src'); audio.load();
  return k;
}
function restoreAudio(k) {
  const f = curFile(); if (!f || !k) return;
  audio.src = convertFileSrc(f.path);
  pendingSeek = k.t;
  if (k.playing) audio.play().catch(() => { });
  updateTime();
}
function softRefresh() {
  computeCounts(); computeView(); renderFilters(); layoutList(); renderList(true); renderDetail(); updateRange(); drawWave();
}
const targetIds = () => selected.size ? [...selected].filter(id => byId.has(id)) : (curId ? [curId] : []);
async function setCoverFor(ids, src) {
  ids = ids.filter(id => byId.has(id));
  if (!ids.length) { toast('Elegí un tema primero'); return; }
  try { await flushSave(); } catch (e) { }
  let n = 0, warn = null;
  for (const id of ids) {
    const keep = (id === curId && UI.coverMode === 'file') ? releaseAudio() : null;
    try {
      const r = await invoke('set_cover', Object.assign({ id, mode: UI.coverMode }, src));
      if (r && r.library) { lib = normalizeLib(r.library); S.library = lib; }
      if (r && r.file) {
        const old = byId.get(id), i = S.files.findIndex(x => x.id === id);
        const nf = Object.assign({ root: old.root, rel: old.rel }, r.file);
        if (!nf.analysis && old.analysis) nf.analysis = old.analysis;
        if (i >= 0) S.files[i] = nf;
        byId.set(id, nf);
      }
      coverVer[id] = Date.now();
      if (r && r.warning) warn = r.warning;
      n++;
    } catch (e) { toast('No se pudo cambiar la portada: ' + errText(e), 3500); }
    finally { if (keep) restoreAudio(keep); }
  }
  undoStack.length = 0;
  softRefresh();
  if (n) toast(warn ? warn : (n > 1 ? 'Portada puesta en ' + n + ' temas' : 'Portada actualizada'), warn ? 4500 : 2200);
}
const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };
function readB64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}
async function blobToCover(blob, name) {
  let ext = EXT_BY_TYPE[blob.type];
  if (!ext && name) { const m = /\.(jpe?g|png|webp)$/i.exec(name); if (m) ext = m[1].toLowerCase().replace('jpeg', 'jpg'); }
  if (ext) return { data: await readB64(blob), ext };
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const png = await new Promise(r => c.toBlob(r, 'image/png'));
  return { data: await readB64(png), ext: 'png' };
}
function pickCoverImage() {
  const dlg = window.__TAURI__ && window.__TAURI__.dialog;
  if (dlg && dlg.open) {
    return dlg.open({ multiple: false, filters: [{ name: 'Imagen', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] })
      .then(p => { if (Array.isArray(p)) p = p[0]; if (p && typeof p === 'object') p = p.path; return p ? { path: p } : null; });
  }
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => { const f = inp.files && inp.files[0]; if (!f) return res(null); try { res(await blobToCover(f, f.name)); } catch (e) { toast('No se pudo leer la imagen'); res(null); } };
    inp.addEventListener('cancel', () => res(null));
    inp.click();
  });
}
async function changeCover() {
  const src = await pickCoverImage();
  if (src) coverWithCrop(targetIds(), src);
}
function copyCover() {
  const f = curFile(); if (!f) return;
  const p = coverPath(f);
  if (!p) { toast('Este tema no tiene portada'); return; }
  coverClip = { path: p }; toast('Portada copiada'); renderDetail();
}
function pasteCover() {
  if (!coverClip) return;
  setCoverFor(targetIds(), { path: coverClip.path });
}
document.addEventListener('paste', async e => {
  if (isTextEntry(e.target)) return;
  if (!$('#crop').hidden) return;
  const items = [...((e.clipboardData && e.clipboardData.items) || [])].filter(i => i.kind === 'file' && /^image\//.test(i.type));
  if (!items.length) return;
  e.preventDefault();
  if (!targetIds().length) { toast('Elegí un tema primero para pegarle la portada'); return; }
  try {
    const file = items[0].getAsFile();
    coverWithCrop(targetIds(), await blobToCover(file, file.name));
  } catch (err) { toast('No se pudo leer la imagen del portapapeles'); }
});
document.addEventListener('error', e => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.closest('.cover,.rcov')) t.remove();
}, true);

// ---------- lista virtual ----------
const ROW_H = 40, SUB_H = 24;
let offsets = [], totalH = 0, lastKey = '', renderVer = 0;
const listEl = $('#list'), inner = $('#list-inner');
const GRID_GAP = 14, GRID_PAD = 14, GRID_MINW = 150, GRID_INFO = 58;
let gridCols = 1, gridCW = 150, gridRH = 0;
function layoutList() {
  if (UI.view === 'grid') {
    const W = Math.max(200, listEl.clientWidth);
    gridCols = Math.max(1, Math.floor((W - GRID_PAD * 2 + GRID_GAP) / (GRID_MINW + GRID_GAP)));
    gridCW = Math.floor((W - GRID_PAD * 2 - GRID_GAP * (gridCols - 1)) / gridCols);
    gridRH = gridCW + GRID_INFO + GRID_GAP;
    totalH = Math.ceil(view.length / gridCols) * gridRH + GRID_PAD; inner.style.height = totalH + 'px'; lastKey = '';
    return;
  }
  offsets = []; let y = 0;
  for (const it of view) { offsets.push(y); y += ROW_H + it.subs.length * SUB_H; }
  totalH = y; inner.style.height = y + 'px'; lastKey = '';
}
function tagsChips(t, max) {
  if (!t) return '';
  const parts = [];
  lib.categories.forEach(cat => (t.tags[cat.id] || []).forEach(v => parts.push([cat, v])));
  let h = parts.slice(0, max).map(([cat, v]) => { const c = mute(cat.color); return `<span class="tg" style="background:${rgba(c, .15)};border-color:${rgba(c, .5)}">${esc(v)}</span>`; }).join('');
  if (parts.length > max) h += `<span class="tg more">+${parts.length - max}</span>`;
  return h;
}
const trackHas = (id, cat, val) => { const t = T(id); return !!t && (t.tags[cat] || []).includes(val); };
function renderList(force) {
  if (renaming === 'list') return;
  if (!view.length) {
    inner.innerHTML = S.files.length ? '<div class="empty">Ningún tema coincide con los filtros.</div>' : '<div class="empty">No hay temas en la carpeta.<br><button class="btn" id="e-folder">Elegir carpeta</button></div>';
    inner.style.height = 'auto'; lastKey = '';
    const b = $('#e-folder'); if (b) b.onclick = pickMainFolder;
    return;
  }
  if (UI.view === 'grid') { renderGrid(force); return; }
  inner.style.height = totalH + 'px';
  const st = listEl.scrollTop, h = listEl.clientHeight;
  let lo = 0, hi = view.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] + ROW_H + view[mid].subs.length * SUB_H > st) hi = mid; else lo = mid + 1; }
  const a = Math.max(0, lo - 3);
  let b = lo; while (b < view.length && offsets[b] < st + h) b++;
  b = Math.min(view.length, b + 3);
  const key = a + '-' + b;
  if (!force && key === lastKey) return;
  lastKey = key;
  const qk = quick.on && quick.cat && quick.val;
  let html = '';
  for (let i = a; i < b; i++) {
    const { f, subs } = view[i], t = T(f.id), an = f.analysis;
    const cu = coverURL(f);
    const cls = (selected.has(f.id) ? ' sel' : '') + (f.id === curId ? ' cur' : '') + (qk && trackHas(f.id, quick.cat, quick.val) ? ' has' : '');
    html += `<div class="row${cls}" data-id="${esc(f.id)}" draggable="false" style="top:${offsets[i]}px;height:${ROW_H + subs.length * SUB_H}px">
      <div class="rmain">${quick.on ? `<span class="qind">${TICK}</span><button class="qplay" data-act="qplay" title="Escuchar este tema"><svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 2l10 6-10 6z" fill="currentColor"/></svg></button>` : ''}<span class="star${t && t.fav ? ' on' : ''}" data-act="fav">${t && t.fav ? '★' : '☆'}</span>
      <span class="rcov">${cu ? `<img loading="lazy" decoding="async" draggable="false" alt="" src="${esc(cu)}">` : ''}</span>
      <span class="rname" title="${esc(f.name)}">${esc(dn(f))}</span><span class="rtags">${tagsChips(t, 4)}</span>
      <span class="rdur">${hasWave(an) ? fmt(an.duration) : ''}</span><span class="rbpm">${an && an.bpm ? '~' + Math.round(an.bpm) : ''}</span>
      <span class="rmom">${t && t.moments.length ? '<b>' + t.moments.length + '</b>' : ''}</span>
      <span class="rwave" data-id="${esc(f.id)}">${hasWave(an) ? `<canvas data-w="${esc(f.id)}"></canvas><i class="wl"></i>` : (!an || fbPending(f) ? '<em>analizando...</em>' : '<em>sin onda</em>')}</span></div>
      ${subs.map(m => `<div class="sub" data-id="${esc(f.id)}" data-mid="${esc(m.id)}" draggable="false"><span class="stime">${fmt(Math.round(m.start))}${m.end != null ? '–' + fmt(Math.round(m.end)) : ''}</span><span>${esc(m.label)}</span>${tagsChips(m, 3)}<span class="dh" data-id="${esc(f.id)}" data-start="${m.start}" data-end="${m.end != null ? m.end : ''}" title="Arrastrar este fragmento afuera">${GRIP}Arrastrar</span></div>`).join('')}
    </div>`;
  }
  inner.innerHTML = html;
  inner.querySelectorAll('canvas[data-w]').forEach(c => drawMini(c, byId.get(c.dataset.w)));
}
function renderGrid(force) {
  inner.style.height = totalH + 'px';
  const st = listEl.scrollTop, h = listEl.clientHeight, nRows = Math.ceil(view.length / gridCols);
  const r0 = Math.max(0, Math.floor((st - GRID_PAD) / gridRH) - 1), r1 = Math.min(nRows, Math.ceil((st + h) / gridRH) + 1);
  const key = 'g' + r0 + '-' + r1 + '-' + gridCols + '-' + gridCW;
  if (!force && key === lastKey) return;
  lastKey = key;
  const qk = quick.on && quick.cat && quick.val;
  let html = '';
  for (let i = r0 * gridCols; i < Math.min(view.length, r1 * gridCols); i++) {
    const f = view[i].f, t = T(f.id), an = f.analysis, cu = coverURL(f);
    const x = GRID_PAD + (i % gridCols) * (gridCW + GRID_GAP), y = GRID_PAD + Math.floor(i / gridCols) * gridRH;
    const cls = (selected.has(f.id) ? ' sel' : '') + (f.id === curId ? ' cur' : '') + (qk && trackHas(f.id, quick.cat, quick.val) ? ' has' : '');
    const meta = [hasWave(an) ? fmt(an.duration) : '', an && an.bpm ? '~' + Math.round(an.bpm) + ' BPM' : '', t && t.moments.length ? t.moments.length + (t.moments.length === 1 ? ' momento' : ' momentos') : ''].filter(Boolean).join(' · ');
    html += `<div class="row gcard${cls}" data-id="${esc(f.id)}" draggable="false" style="left:${x}px;top:${y}px;width:${gridCW}px;height:${gridCW + GRID_INFO}px">
      <div class="gcov" style="height:${gridCW}px">${cu ? `<img loading="lazy" decoding="async" draggable="false" alt="" src="${esc(cu)}">` : '<span class="gnone">♪</span>'}<span class="star${t && t.fav ? ' on' : ''}" data-act="fav">${t && t.fav ? '★' : '☆'}</span>${f.id === curId && !audio.paused ? '<span class="gplay">▶</span>' : ''}</div>
      <div class="rname gname" title="${esc(f.name)}">${esc(dn(f))}</div><div class="gmeta">${esc(meta)}</div></div>`;
  }
  inner.innerHTML = html;
}
function drawMini(c, f) {
  const an = f && f.analysis; if (!hasWave(an)) return;
  const d = DPR(), W = 96, H = 26;
  c.width = W * d; c.height = H * d;
  const g = c.getContext('2d'); g.scale(d, d);
  const N = 48, L = an.peaks.length, bw = W / N;
  g.fillStyle = f.id === curId ? colors.minicur : colors.mini;
  for (let i = 0; i < N; i++) {
    let m = 0; const s = Math.floor(i * L / N), e = Math.max(s + 1, Math.floor((i + 1) * L / N));
    for (let k = s; k < e; k++) if (an.peaks[k] > m) m = an.peaks[k];
    const h = Math.max(1, (m / 255) * (H - 2));
    g.fillRect(i * bw, (H - h) / 2, Math.max(1, bw - 1), h);
  }
}
let scrollRaf = 0;
listEl.addEventListener('scroll', () => { if (scrollRaf) return; scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; renderList(false); }); });
function scrollToId(id) {
  const i = view.findIndex(v => v.f.id === id); if (i < 0) return;
  if (UI.view === 'grid') {
    const top = GRID_PAD + Math.floor(i / gridCols) * gridRH, bot = top + gridCW + GRID_INFO;
    if (top - GRID_PAD < listEl.scrollTop) listEl.scrollTop = Math.max(0, top - GRID_PAD);
    else if (bot + GRID_PAD > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = bot + GRID_PAD - listEl.clientHeight;
    return;
  }
  const top = offsets[i], bot = top + ROW_H;
  if (top < listEl.scrollTop) listEl.scrollTop = top;
  else if (bot > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = bot - listEl.clientHeight;
}
listEl.addEventListener('mousemove', e => {
  const rw = e.target.closest && e.target.closest('.rwave'); if (!rw) return;
  const wl = rw.querySelector('.wl'); if (!wl) return;
  const r = rw.getBoundingClientRect();
  wl.style.left = Math.max(0, Math.min(r.width - 1, e.clientX - r.left)) + 'px';
});

// selección múltiple
function afterSelection() { renderList(true); renderDetail(); }
function toggleSel(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  anchorId = id;
  if (!selected.size && curId) selected.add(curId);
  if (selected.size === 1) { const only = [...selected][0]; if (only !== curId) { selectTrack(only, { play: !audio.paused, keepSel: true }); return; } }
  afterSelection();
}
function rangeSelect(id) {
  const a = view.findIndex(v => v.f.id === (anchorId || curId)), b = view.findIndex(v => v.f.id === id);
  if (b < 0) return;
  if (a < 0) { toggleSel(id); return; }
  selected = new Set(view.slice(Math.min(a, b), Math.max(a, b) + 1).map(v => v.f.id));
  if (selected.size === 1 && id !== curId) { selectTrack(id, { play: !audio.paused, keepSel: true }); return; }
  afterSelection();
}

// etiquetado rápido
const quick = { on: false, cat: null, val: null };
function toggleQuick(on) {
  quick.on = on === undefined ? !quick.on : on;
  if (quick.on && (!quick.cat || !catById(quick.cat))) { quick.cat = lib.categories[0] && lib.categories[0].id; quick.val = null; }
  document.body.classList.toggle('quick', quick.on);
  $('#btn-quick').classList.toggle('on', quick.on);
  renderQuickBar(); renderList(true);
}
function renderQuickBar() {
  const bar = $('#qbar'); bar.hidden = !quick.on;
  if (!quick.on || !lib) return;
  if (!catById(quick.cat)) { quick.cat = lib.categories[0] && lib.categories[0].id; quick.val = null; }
  let cat = catById(quick.cat);
  if (cat && quick.val && !cat.values.includes(quick.val)) quick.val = null;
  const col = cat ? mute(cat.color) : [143, 137, 124];
  bar.innerHTML = `<span class="ql">Etiquetado rápido</span>
    <select id="q-cat" title="Categoría">${lib.categories.map(c => `<option value="${esc(c.id)}"${c.id === quick.cat ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <div class="qvals">${cat && cat.values.length ? cat.values.map((v, i) => `<button class="chip${quick.val === v ? ' on' : ''}" data-qv="${esc(v)}" style="${quick.val === v ? `background:${rgba(col, .5)};border-color:${rgba(col, 1)}` : `background:${rgba(col, .13)};border-color:${rgba(col, .4)}`}">${i < 9 ? '<kbd>' + (i + 1) + '</kbd>' : ''}${esc(v)}</button>`).join('') : '<span style="color:var(--dim2);font-size:12px">Esta categoría no tiene valores todavía</span>'}</div>
    <button class="btn" data-q="exit">Salir</button>
    <span class="qh">${quick.val ? `Tocá un tema para ponerle o sacarle "${esc(quick.val)}". Enter lo aplica a todos los seleccionados. Para escuchar: botón de play de la fila o doble clic. Esc sale.` : 'Elegí un valor (o apretá su número) y después tocá los temas.'}</span>`;
}
$('#qbar').addEventListener('click', e => {
  const v = e.target.closest('[data-qv]'), x = e.target.closest('[data-q="exit"]');
  if (x) { toggleQuick(false); return; }
  if (v) { quick.val = quick.val === v.dataset.qv ? null : v.dataset.qv; renderQuickBar(); renderList(true); }
});
$('#qbar').addEventListener('change', e => {
  if (e.target.id === 'q-cat') { quick.cat = e.target.value; quick.val = null; renderQuickBar(); renderList(true); e.target.blur(); }
});
function quickPick(i) {
  const cat = catById(quick.cat); if (!cat || !cat.values[i]) return;
  quick.val = cat.values[i]; renderQuickBar(); renderList(true);
}
function quickToggle(id) {
  if (!quick.cat || !quick.val) { toast('Elegí primero un valor arriba'); return; }
  bulkTag([id], quick.cat, quick.val);
}
function quickApplySelected() {
  if (!quick.cat || !quick.val) { toast('Elegí primero un valor arriba'); return; }
  const ids = [...selected];
  if (!ids.length) { toast('No hay temas seleccionados'); return; }
  bulkTag(ids, quick.cat, quick.val);
  toast('"' + quick.val + '" aplicado a ' + ids.length + (ids.length === 1 ? ' tema' : ' temas'));
}
$('#btn-quick').onclick = () => toggleQuick();

// etiquetas sobre varios destinos
function applyToTargets(targets, cat, val) {
  const all = targets.length > 0 && targets.every(t => (t[cat.id] || []).includes(val));
  for (const tags of targets) {
    const arr = tags[cat.id] || [];
    if (all) { const n = arr.filter(x => x !== val); if (n.length) tags[cat.id] = n; else delete tags[cat.id]; }
    else if (cat.multi) { if (!arr.includes(val)) tags[cat.id] = arr.concat(val); }
    else tags[cat.id] = [val];
  }
}
function bulkTag(ids, catId, val) {
  const cat = catById(catId); if (!cat || !ids.length) return;
  pushUndo();
  applyToTargets(ids.map(id => TW(id).tags), cat, val);
  libChanged();
}

// clics en la lista
let clickTimer = 0;
listEl.addEventListener('click', e => {
  if (dragFired) { dragFired = false; return; }
  if (e.target.closest('.dh')) return;
  if (e.target.closest('.rname-in')) return;
  const row = e.target.closest('.row'); if (!row) return;
  if (e.detail > 1) return; // el segundo clic de un doble clic lo maneja dblclick
  const id = row.dataset.id;
  const sub = e.target.closest('.sub');
  if (e.target.closest('.star')) { toggleFav(id); return; }
  if (e.ctrlKey || e.metaKey) { toggleSel(id); return; }
  if (e.shiftKey) { rangeSelect(id); return; }
  if (e.target.closest('.qplay')) { selectTrack(id, { play: true }); return; }
  const rw = e.target.closest('.rwave');
  if (rw && rw.querySelector('canvas')) {
    const r = rw.getBoundingClientRect(), f = byId.get(id);
    if (f && hasWave(f.analysis)) {
      const fr = Math.max(0, Math.min(0.995, (e.clientX - r.left) / r.width));
      selectTrack(f.id, { play: true, start: fr * f.analysis.duration });
      return;
    }
  }
  if (sub) { playMoment(sub.dataset.id, sub.dataset.mid); return; }
  if (quick.on) { quickToggle(id); return; }
  selectTrack(id, { play: true });
});
listEl.addEventListener('dblclick', e => {
  const row = e.target.closest('.row'); if (!row || e.target.closest('.dh,.star,.rwave,.sub,.rname-in')) return;
  const id = row.dataset.id;
  if (quick.on) { if (!e.target.closest('.qplay')) { quickToggle(id); selectTrack(id, { play: true }); } return; }
  if (e.target.closest('.rname')) startRename(id, 'list');
});

// ---------- renombrar ----------
let renaming = null;
function startRename(id, where) {
  const f = byId.get(id); if (!f || renaming) return;
  const host = where === 'list'
    ? inner.querySelector('.row[data-id="' + CSS.escape(id) + '"] .rname')
    : $('#detail h2');
  if (!host) return;
  renaming = where;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = f.name; inp.className = where === 'list' ? 'rname-in' : 'h2-in';
  host.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async ok => {
    if (done) return; done = true;
    const nv = inp.value.trim(); renaming = null;
    if (ok && nv && nv !== f.name) await doRename(id, nv);
    else { renderList(true); renderDetail(); }
  };
  inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
  ['mousedown', 'click', 'dblclick'].forEach(n => inp.addEventListener(n, ev => ev.stopPropagation()));
}
async function doRename(id, name) {
  const wasCur = id === curId;
  const keep = wasCur ? releaseAudio() : null;
  try {
    await flushSave();
    const r = await invoke('rename_track', { id, name });
    if (selected.has(id)) { selected.delete(id); selected.add(r.id); }
    if (anchorId === id) anchorId = r.id;
    if (wasCur) curId = r.id;
    const oldCues = lib.cues;
    applyState(r.state);
    remapCues(id, r.id, oldCues);
    if (keep) restoreAudio(keep);
    toast('Renombrado');
  } catch (e) {
    toast(errText(e), 3500);
    if (keep) restoreAudio(keep);
    renderList(true); renderDetail();
  }
}
document.addEventListener('dblclick', e => {
  if (e.target.closest && e.target.closest('#detail h2.ren') && curId) startRename(curId, 'detail');
});

// ---------- arrastre nativo ----------
let dragCand = null, dragFired = false;
function effectiveStart(f) {
  const t = f && T(f.id);
  if (t && typeof t.start === 'number') return t.start;
  const an = f && f.analysis;
  if (UI.skipSilence && an && an.lead > 0) return an.lead;
  return 0;
}
function startTrackDrag(id) {
  const f = byId.get(id); if (!f) return;
  const st = effectiveStart(f);
  if (UI.dragTrimmed && st > 0.3) dragFragment(id, st, null);
  else invoke('start_drag', { path: f.path }).catch(err => toast('No se pudo arrastrar: ' + errText(err)));
}
function playerFragment() {
  if (!curId) return null;
  if (rangeSel && Math.abs(rangeSel.a - rangeSel.b) > 0.3) {
    const a = Math.min(rangeSel.a, rangeSel.b), b = Math.max(rangeSel.a, rangeSel.b);
    return { id: curId, start: Math.round(a * 100) / 100, end: Math.round(b * 100) / 100, label: 'Arrastrar selección' };
  }
  if (momentPlay) return { id: curId, start: momentPlay.start, end: momentPlay.end, label: 'Arrastrar momento' };
  return null;
}
let pdKey = '';
function updatePDrag() {
  const fr = playerFragment(), el = $('#p-drag');
  const key = (fr ? fr.label : '') + '|' + curId;
  if (key === pdKey) return; pdKey = key;
  el.hidden = !fr;
  el.innerHTML = fr ? GRIP + fr.label : '';
  el.title = 'Arrastrá este fragmento afuera';
}
document.addEventListener('mousedown', e => {
  dragFired = false; dragCand = null;
  if (e.button !== 0) return;
  const dh = e.target.closest('.dh');
  if (dh) {
    let fr;
    if (dh.id === 'p-drag') fr = playerFragment();
    else fr = { id: dh.dataset.id, start: +dh.dataset.start, end: dh.dataset.end === '' ? null : +dh.dataset.end };
    if (fr && byId.has(fr.id)) dragCand = { x: e.clientX, y: e.clientY, frag: fr };
    e.preventDefault();
    return;
  }
  if (e.target.closest('.star,input,textarea,button,select,.qind')) return;
  if (e.ctrlKey || e.shiftKey || e.metaKey) return;
  if (quick.on && e.target.closest('.row,.sub')) return;
  const h = e.target.closest('#drag'), r = e.target.closest('.row,.sub');
  const id = h ? curId : (r ? r.dataset.id : null);
  if (id && byId.has(id)) dragCand = { x: e.clientX, y: e.clientY, id };
});
document.addEventListener('mousemove', e => {
  if (!dragCand) return;
  if (!(e.buttons & 1)) { dragCand = null; return; }
  if (Math.hypot(e.clientX - dragCand.x, e.clientY - dragCand.y) > 5) {
    const c = dragCand; dragCand = null; dragFired = true;
    if (c.frag) { dragFragment(c.frag.id, c.frag.start, c.frag.end); return; }
    startTrackDrag(c.id);
  }
});
document.addEventListener('mouseup', () => { dragCand = null; });
document.addEventListener('dragstart', e => e.preventDefault());

async function dragFragment(id, start, end) {
  try { await invoke('drag_fragment', { id, start, end }); }
  catch (err) {
    if (errText(err).includes('NEEDS_WAV')) prepareWav(id, start, end);
    else toast('No se pudo arrastrar: ' + errText(err));
  }
}
function wavRate(ab) {
  try {
    const v = new DataView(ab);
    if (ab.byteLength > 28 && v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57415645) return v.getUint32(24, true);
  } catch (e) { }
  return 0;
}
async function decodeFile(f) {
  const ab = await (await fetch(convertFileSrc(f.path))).arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const rate = wavRate(ab);
  let ctx;
  try { ctx = rate ? new Ctx({ sampleRate: rate }) : new Ctx(); } catch (e) { ctx = new Ctx(); }
  try { return await ctx.decodeAudioData(ab); } finally { try { ctx.close(); } catch (e) { } }
}
function encodeWav(buf, start, end) {
  const sr = buf.sampleRate, ch = Math.min(2, buf.numberOfChannels);
  const i0 = Math.max(0, Math.min(buf.length - 1, Math.floor(start * sr)));
  const i1 = end == null ? buf.length : Math.max(i0 + 1, Math.min(buf.length, Math.ceil(end * sr)));
  const n = i1 - i0, bytes = new Uint8Array(44 + n * ch * 2), v = new DataView(bytes.buffer);
  const w = (o, t) => { for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = i0; i < i1; i++) for (let c = 0; c < ch; c++) {
    const x = Math.max(-1, Math.min(1, data[c][i]));
    v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); o += 2;
  }
  return bytes;
}
function toB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x6000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x6000));
  return btoa(out);
}
let preparing = false;
async function prepareWav(id, start, end) {
  const f = byId.get(id); if (!f) return;
  if (preparing) { toast('Ya se está preparando otro fragmento'); return; }
  preparing = true; toast('Preparando fragmento…', 60000);
  try {
    const buf = await decodeFile(f);
    const data = toB64(encodeWav(buf, start, end));
    await invoke('save_fragment_wav', { id, start, end, data });
    toast('Fragmento listo: arrastralo de nuevo');
  } catch (err) { toast('No se pudo preparar el fragmento: ' + errText(err)); }
  finally { preparing = false; }
}

// ---------- análisis de respaldo ----------
const fbQueue = []; let fbRunning = false, fbActive = 0;
const fbLeft = () => fbQueue.length + fbActive;
function queueFallback(id) {
  const f = byId.get(id); if (!f || f._fb) return;
  f._fb = 1; fbQueue.push(id); renderHead();
  if (!fbRunning) { fbRunning = true; setTimeout(runFallback, 50); }
}
async function runFallback() {
  while (fbQueue.length) {
    const id = fbQueue.shift(), f = byId.get(id);
    if (!f || !f.analysis || f.analysis.duration !== 0) continue;
    fbActive = 1; renderHead();
    try {
      const buf = await decodeFile(f);
      const an = analyzeBuffer(buf);
      await invoke('save_analysis', { id, analysis: an });
      if (byId.get(id) === f) { f.analysis = an; afterFallback(id); }
    } catch (err) {
      console.warn('analisis de respaldo fallo', id, err);
      f._fbFail = true; afterFallback(id);
    }
    fbActive = 0; renderHead();
    await new Promise(r => setTimeout(r, 30));
  }
  fbRunning = false;
}
function afterFallback(id) {
  if (id === curId) { buildWaveCache(); updateDetailMeta(); updateTime(); scheduleDraw(); }
  if (sortBy === 'dur' || sortBy === 'bpm') { computeView(); layoutList(); }
  renderList(true);
}
function analyzeBuffer(buf) {
  const N = 800, n = buf.length, ch = buf.numberOfChannels;
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  const pk = new Float64Array(N), rm = new Float64Array(N);
  for (let b = 0; b < N; b++) {
    const s = Math.floor(b * n / N), e = Math.max(s + 1, Math.floor((b + 1) * n / N));
    let m = 0, sq = 0;
    for (let i = s; i < e && i < n; i++) {
      let x = 0; for (let c = 0; c < ch; c++) x += chans[c][i]; x /= ch;
      const a = Math.abs(x); if (a > m) m = a; sq += x * x;
    }
    pk[b] = m; rm[b] = Math.sqrt(sq / (e - s));
  }
  let mp = 0, mr = 0; for (let b = 0; b < N; b++) { if (pk[b] > mp) mp = pk[b]; if (rm[b] > mr) mr = rm[b]; }
  // silencio del principio: primer bloque de 10 ms cuyo pico supere max(0.003, 2% del pico global)
  let lead = 0;
  {
    const blk = Math.max(1, Math.floor(buf.sampleRate * 0.01)); let gp = 0;
    for (let c = 0; c < ch; c++) { const d = chans[c]; for (let i = 0; i < n; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > gp) gp = a; } }
    const thr = Math.max(0.003, 0.02 * gp);
    scan: for (let s = 0; s < n; s += blk) {
      const e = Math.min(n, s + blk);
      for (let c = 0; c < ch; c++) { const d = chans[c]; for (let i = s; i < e; i++) if ((d[i] < 0 ? -d[i] : d[i]) > thr) { lead = Math.max(0, s / buf.sampleRate - 0.05); break scan; } }
    }
    if (lead < 0.3) lead = 0;
  }
  mp = mp || 1; mr = mr || 1;
  const peaks = [], rms = [];
  for (let b = 0; b < N; b++) { peaks.push(Math.round(pk[b] / mp * 255)); rms.push(Math.round(Math.pow(rm[b] / mr, 0.6) * 255)); }
  return { duration: buf.duration, bpm: null, peaks, rms, lead: Math.round(lead * 100) / 100 };
}

// ---------- favoritos ----------
function toggleFav(id) {
  if (!id) return; pushUndo(); const t = TW(id); t.fav = !t.fav;
  libChanged({ skipDetail: id !== curId });
}

// ---------- panel derecho ----------
const nk = s => fold(s).replace(/['’]s\b/g, '').replace(/[^a-z0-9]/g, '');
function findPhoto(f) {
  if (!S.photos || !S.photos.length) return null;
  const cat = lib.categories.find(c => c.id === 'artista') || lib.categories.find(c => c.name.toLowerCase() === 'artista');
  const t = T(f.id); const v = cat && t && t.tags[cat.id] && t.tags[cat.id][0];
  const ak = v ? nk(v) : '';
  const first = nk(String(f.name).trim().split(/[\s\-_–.]+/).filter(Boolean)[0] || '');
  const ph = S.photos.map(p => ({ p, k: nk(p.key) })).filter(x => x.k);
  if (ak) {
    const hit = ph.find(x => x.k === ak) || ph.find(x => (x.k.length >= 3 && ak.includes(x.k)) || (ak.length >= 4 && x.k.includes(ak)));
    if (hit) return hit.p;
  }
  if (first.length >= 2) { const hit = ph.find(x => x.k === first); if (hit) return hit.p; }
  return null;
}
const BIG_CAT = 12;
const expCats = new Set();
// destinos de etiquetas: 't' = tema actual, 'sel' = temas seleccionados, 'm:<id>' = momento del tema actual
function tagTargets(scope, write) {
  if (scope === 't') return curId ? [write ? TW(curId).tags : (T(curId) || { tags: {} }).tags] : [];
  if (scope === 'sel') return targetIds().map(id => write ? TW(id).tags : (T(id) || { tags: {} }).tags);
  const t = curId && T(curId), m = t && t.moments.find(x => x.id === scope.slice(2));
  return m ? [m.tags] : [];
}
function tagEditor(cat, scope) {
  const tg = tagTargets(scope, false), n = tg.length, col = mute(cat.color);
  const cnt = v => tg.filter(t => (t[cat.id] || []).includes(v)).length;
  const chip = (v, x) => {
    const c = cnt(v), on = n > 0 && c === n, half = c > 0 && c < n;
    const st = on ? `background:${rgba(col, .5)};border-color:${rgba(col, 1)}` : half ? `background:${rgba(col, .26)};border-color:${rgba(col, 1)}` : `background:${rgba(col, .1)};border-color:${rgba(col, .35)}`;
    return `<button class="chip${on ? ' on' : ''}${half ? ' half' : ''}" data-tt="1" data-scope="${esc(scope)}" data-cat="${esc(cat.id)}" data-val="${esc(v)}" style="${st}"${half ? ' title="Lo tienen algunos de los temas"' : ''}>${esc(v)}${x && on ? ' ×' : ''}</button>`;
  };
  const big = cat.values.length > BIG_CAT, key = scope + '|' + cat.id, all = expCats.has(key);
  const head = `<div class="te-l"><span class="dot" style="background:${rgba(mute(cat.color), 1)}"></span>${esc(cat.name)}<small>${cat.multi ? '' : 'uno solo'}</small></div>`;
  const assigned = cat.values.filter(v => cnt(v) > 0);
  if (!big) {
    let vals = cat.values;
    if (UI.tagLayout === 'list') vals = assigned.concat(cat.values.filter(v => cnt(v) === 0));
    return `<div class="te">${head}<div class="chips">${vals.map(v => chip(v)).join('')}<span class="chip add"><input type="text" data-add="1" data-scope="${esc(scope)}" data-cat="${esc(cat.id)}" placeholder="+ nuevo" autocomplete="off"></span></div></div>`;
  }
  const input = `<span class="chip add"><input type="text" data-add="1" data-ac="1" data-scope="${esc(scope)}" data-cat="${esc(cat.id)}" placeholder="+ agregar…" autocomplete="off"></span>`;
  const link = `<a class="vall" data-all="${esc(key)}">${all ? 'ocultar' : 'ver todos (' + cat.values.length + ')'}</a>`;
  let chips;
  if (all) chips = (UI.tagLayout === 'list' ? assigned.concat(cat.values.filter(v => cnt(v) === 0)) : cat.values).map(v => chip(v)).join('');
  else chips = assigned.map(v => chip(v, true)).join('');
  return `<div class="te">${head}<div class="chips">${chips}${input}${link}</div></div>`;
}

// autocompletado liviano
const acBox = document.createElement('div'); acBox.id = 'ac'; acBox.hidden = true; document.body.appendChild(acBox);
let ac = { inp: null, items: [], idx: -1 };
function showAC(inp) {
  const cat = catById(inp.dataset.cat), tg = tagTargets(inp.dataset.scope, false); if (!cat || !tg.length) return hideAC();
  const q = fold(inp.value).trim();
  ac = { inp, idx: -1, items: cat.values.filter(v => !tg.every(t => (t[cat.id] || []).includes(v)) && fold(v).includes(q)) };
  drawAC();
}
function drawAC() {
  const { inp, items, idx } = ac;
  if (!inp || !items.length) { acBox.hidden = true; return; }
  acBox.innerHTML = items.map((v, i) => `<div class="aci${i === idx ? ' on' : ''}" data-i="${i}">${esc(v)}</div>`).join('');
  acBox.hidden = false;
  const r = inp.getBoundingClientRect(), w = Math.max(160, r.width);
  acBox.style.minWidth = w + 'px';
  acBox.style.left = Math.max(4, Math.min(window.innerWidth - w - 12, r.left)) + 'px';
  acBox.style.top = (r.bottom + 2) + 'px';
  const on = acBox.querySelector('.aci.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}
function hideAC() { acBox.hidden = true; ac = { inp: null, items: [], idx: -1 }; }
acBox.addEventListener('mousedown', e => {
  e.preventDefault();
  const it = e.target.closest('.aci'); if (!it || !ac.inp) return;
  const inp = ac.inp, v = ac.items[+it.dataset.i]; hideAC();
  addValue(inp.dataset.scope, inp.dataset.cat, v);
});
function addValue(scope, catId, text) {
  const v = String(text).trim(); if (!v) return;
  const cat = catById(catId); if (!cat) return;
  const ex = cat.values.find(x => fold(x) === fold(v));
  const val = ex || v; if (!ex) cat.values.push(val);
  pushUndo();
  for (const tags of tagTargets(scope, true)) {
    const arr = tags[cat.id] || [];
    if (cat.multi) { if (!arr.includes(val)) tags[cat.id] = arr.concat(val); } else tags[cat.id] = [val];
  }
  libChanged();
  const again = document.querySelector(`#detail [data-add][data-scope="${scope}"][data-cat="${cat.id}"]`); if (again) again.focus();
}
function momentRow(m, active) {
  const open = expMoms.has(m.id);
  let tagsHTML;
  if (open) tagsHTML = lib.categories.map(c => tagEditor(c, 'm:' + m.id)).join('');
  else tagsHTML = tagsChips(m, 8);
  return `<div class="mom${active ? ' active' : ''}${selMom === m.id ? ' sel' : ''}" data-mid="${esc(m.id)}">
    <div class="mom-top">
      <button class="ib" data-act="mplay" title="Reproducir"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 2l10 6-10 6z" fill="currentColor"/></svg></button>
      <input class="tin" data-f="start" value="${fmt(m.start, true)}" title="Inicio (m:ss)">
      <span>–</span>
      <input class="tin" data-f="end" value="${m.end != null ? fmt(m.end, true) : ''}" placeholder="fin" title="Fin (m:ss)">
      <span class="mlab" data-f="label" title="Doble clic para renombrar">${esc(m.label)}</span>
      <button class="ib txt" data-act="mcue" title="Agregar este momento al guion">Al guion</button>
      <button class="ib txt" data-act="mtags">${open ? 'Listo' : 'Etiq.'}</button>
      <button class="ib" data-act="mdel" title="Borrar">×</button>
    </div>
    <div class="mom-drag"><span class="dh" data-id="${esc(curId)}" data-start="${m.start}" data-end="${m.end != null ? m.end : ''}" title="Arrastrar este fragmento afuera">${GRIP}Arrastrar</span></div>
    <div class="mom-tags">${tagsHTML}</div></div>`;
}
function renderDetail() {
  if (renaming === 'detail' || renaming === 'mom') return;
  const d = $('#detail'), sc = d.scrollTop;
  hideAC();
  if (selected.size >= 2) { renderMulti(d); d.scrollTop = sc; return; }
  const f = curId && byId.get(curId);
  if (!f) { d.innerHTML = '<div class="d-empty">Elegí un tema de la lista</div>'; return; }
  const t = T(f.id) || { tags: {}, notes: '', fav: false, moments: [] };
  const an = f.analysis, cu = coverURL(f);
  const moms = t.moments.slice().sort((a, b) => a.start - b.start);
  const manual = typeof t.start === 'number', st = effectiveStart(f);
  const pend = pendingIn && pendingIn.id === f.id ? pendingIn.t : null;
  d.innerHTML = `
    <div class="cover">${cu ? `<img class="cv-bg" draggable="false" alt="" src="${esc(cu)}"><img class="cv-fg" draggable="false" alt="" src="${esc(cu)}">` : '<div class="cv-none">Sin portada</div>'}
      <div class="cv-act"><button class="btn" data-act="cvchange">Cambiar portada</button>${cu ? '<button class="btn" data-act="cvcrop">Recortar portada</button><button class="btn" data-act="cvcopy">Copiar portada</button>' : ''}${coverClip ? '<button class="btn" data-act="cvpaste">Pegar portada</button>' : ''}</div></div>
    <h2 class="ren" title="${esc(f.name)} (doble clic para renombrar)">${esc(dn(f))}</h2>
    <div class="d-meta" id="d-meta">${esc(f.ext.toUpperCase())}${hasWave(an) ? ' · ' + fmt(an.duration) : ''}${an && an.bpm ? ' · ~' + Math.round(an.bpm) + ' BPM' : ''}</div>
    <div class="d-start">Empieza en <b>${fmt(st, true)}</b> (${manual ? 'a mano' : 'auto'})<span class="ds-b"><button class="btn" data-act="setstart" title="Usar el momento actual de reproducción como inicio (S)">Marcar acá</button><button class="btn" data-act="autostart"${manual ? '' : ' disabled style="opacity:.5;cursor:default"'}>Automático</button></span></div>
    <div class="d-btns"><button class="btn" data-act="reveal">Mostrar en carpeta</button><button class="btn${t.fav ? ' on' : ''}" data-act="dfav">${t.fav ? '★ Favorito' : '☆ Favorito'}</button></div>
    <div id="drag" draggable="false"><span class="t">${GRIP}Arrastrar tema afuera</span><small>Para un fragmento, usá el asa de cada momento</small></div>
    <div class="dsec">Momentos${pend != null ? `<span class="pend">inicio en ${fmt(pend, true)}</span>` : ''}<span class="grow"></span><button class="btn" data-act="addmom" style="text-transform:none;letter-spacing:0">Inicio (I)</button><button class="btn" data-act="outmom" style="text-transform:none;letter-spacing:0">Fin (O)</button></div>
    ${moms.length ? '<div class="hint">Elegí un momento para ajustarlo con los tiradores de la onda. Doble clic en el nombre para renombrarlo.</div>' : ''}
    ${moms.length ? moms.map(m => momentRow(m, momentPlay && momentPlay.id === m.id)).join('') : '<div class="mom-add">Sin momentos. Marcá el inicio con I y el fin con O mientras suena, o shift + arrastrar sobre la onda.</div>'}
    <div class="dsec">Etiquetas</div>
    ${lib.categories.map(c => tagEditor(c, 't')).join('')}
    <div class="dsec">Notas</div>
    <textarea id="notes" placeholder="Notas del tema">${esc(t.notes)}</textarea>`;
  d.scrollTop = sc;
  if (focusMom) {
    const fm = focusMom; focusMom = null;
    const row = d.querySelector(`.mom[data-mid="${fm.id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}
function renderMulti(d) {
  const ids = targetIds(), n = ids.length;
  const names = ids.slice(0, 3).map(id => dn(byId.get(id))).join(', ') + (n > 3 ? '…' : '');
  d.innerHTML = `<h2>${n} temas seleccionados</h2><div class="d-meta">${esc(names)}</div>
    <div class="d-btns"><button class="btn" data-act="clearsel">Quitar selección</button>${coverClip ? '<button class="btn" data-act="cvpaste">Pegar portada</button>' : ''}</div>
    <div class="dsec">Etiquetas<small>se aplican a los ${n}</small></div>
    ${lib.categories.map(c => tagEditor(c, 'sel')).join('')}`;
}
let focusMom = null;
function updateDetailMeta() {
  const el = $('#d-meta'), f = curId && byId.get(curId);
  if (!el || !f) return; const an = f.analysis;
  el.textContent = f.ext.toUpperCase() + (hasWave(an) ? ' · ' + fmt(an.duration) : '') + (an && an.bpm ? ' · ~' + Math.round(an.bpm) + ' BPM' : '');
}
function selectMoment(id, o) {
  o = o || {};
  selMom = id || null;
  $('#detail').querySelectorAll('.mom').forEach(el => el.classList.toggle('sel', !!id && el.dataset.mid === id));
  if (id && o.scroll) { const el = $('#detail').querySelector(`.mom[data-mid="${CSS.escape(id)}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }
  drawWave();
}
$('#detail').addEventListener('click', e => {
  const al = e.target.closest('[data-all]');
  if (al) { const k = al.dataset.all; expCats.has(k) ? expCats.delete(k) : expCats.add(k); renderDetail(); return; }
  const tt = e.target.closest('[data-tt]');
  if (tt) {
    const cat = catById(tt.dataset.cat); if (!cat) return;
    pushUndo(); applyToTargets(tagTargets(tt.dataset.scope, true), cat, tt.dataset.val); libChanged(); return;
  }
  const mrow = e.target.closest('.mom');
  if (mrow && !e.target.closest('[data-act="mdel"],.mom-tags') && selMom !== mrow.dataset.mid) selectMoment(mrow.dataset.mid);
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const act = b.dataset.act, mid = mrow && mrow.dataset.mid;
  if (act === 'reveal') invoke('reveal', { path: byId.get(curId).path }).catch(err => toast('Error: ' + err));
  else if (act === 'dfav') toggleFav(curId);
  else if (act === 'addmom') markIn();
  else if (act === 'outmom') markOut();
  else if (act === 'mplay') playMoment(curId, mid);
  else if (act === 'mtags') { expMoms.has(mid) ? expMoms.delete(mid) : expMoms.add(mid); renderDetail(); }
  else if (act === 'mdel') confirmBtn(b, () => {
    pushUndo();
    const t = TW(curId); t.moments = t.moments.filter(m => m.id !== mid);
    if (momentPlay && momentPlay.id === mid) momentPlay = null;
    if (selMom === mid) selMom = null;
    libChanged();
  }, '¿Seguro?');
  else if (act === 'setstart') markStartHere();
  else if (act === 'autostart') { const t = T(curId); if (t && typeof t.start === 'number') { pushUndo(); delete t.start; libChanged(); drawWave(); toast('Inicio automático'); } }
  else if (act === 'cvchange') changeCover();
  else if (act === 'cvcopy') copyCover();
  else if (act === 'cvcrop') cropCurrentCover();
  else if (act === 'mcue') { const m = momById(mid); if (m) addCue(curId, m.start, m.end, m.label); }
  else if (act === 'cvpaste') pasteCover();
  else if (act === 'clearsel') { selected = new Set(curId ? [curId] : []); anchorId = curId; afterSelection(); }
});
function markStartHere() {
  const f = curFile(); if (!f) { toast('Elegí un tema primero'); return; }
  pushUndo(); TW(f.id).start = round1(audio.currentTime || 0);
  libChanged(); toast('El tema empieza en ' + fmt(TW(f.id).start, true));
}
$('#detail').addEventListener('keydown', e => {
  const inp = e.target.closest('[data-add]');
  if (inp && inp.dataset.ac && !acBox.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); const n = ac.items.length, d = e.key === 'ArrowDown' ? 1 : -1;
      ac.idx = ac.idx < 0 ? (d > 0 ? 0 : n - 1) : (ac.idx + d + n) % n; drawAC(); return;
    }
    if (e.key === 'Enter' && ac.idx >= 0) { e.preventDefault(); const v = ac.items[ac.idx]; hideAC(); addValue(inp.dataset.scope, inp.dataset.cat, v); return; }
    if (e.key === 'Escape') hideAC();
  }
  if (inp && e.key === 'Enter') { hideAC(); addValue(inp.dataset.scope, inp.dataset.cat, inp.value); }
  else if (e.target.matches('.tin') && e.key === 'Enter') e.target.blur();
});
$('#detail').addEventListener('focusin', e => { if (e.target.dataset && e.target.dataset.ac) showAC(e.target); });
$('#detail').addEventListener('focusout', e => { if (e.target.dataset && e.target.dataset.ac) hideAC(); });
$('#detail').addEventListener('scroll', hideAC);
$('#detail').addEventListener('input', e => {
  if (e.target.dataset && e.target.dataset.ac) showAC(e.target);
  if (e.target.id === 'notes' && curId) { TW(curId).notes = e.target.value; libChanged({ light: true }); }
});
$('#detail').addEventListener('change', e => {
  const el = e.target, row = el.closest('.mom'); if (!row || !el.dataset.f) return;
  const m = TW(curId).moments.find(x => x.id === row.dataset.mid); if (!m) return;
  pushUndo();
  const v = parseT(el.value);
  if (el.dataset.f === 'start') { if (v == null || isNaN(v)) { toast('Tiempo inválido'); } else m.start = round1(v); }
  else if (v == null) m.end = null;
  else if (isNaN(v)) toast('Tiempo inválido');
  else m.end = round1(v);
  if (m.end != null && m.end <= m.start) m.end = null;
  libChanged();
});
// renombrar un momento (panel derecho o etiqueta de la onda): doble clic
function commitMomLabel(mid, value) {
  const t = curId && T(curId), m = t && t.moments.find(x => x.id === mid);
  const v = String(value).trim();
  if (m && v && v !== m.label) { pushUndo(); m.label = v; libChanged(); }
}
$('#detail').addEventListener('dblclick', e => {
  const host = e.target.closest('.mlab'); if (!host || renaming) return;
  const mid = host.closest('.mom').dataset.mid, t = T(curId), m = t && t.moments.find(x => x.id === mid); if (!m) return;
  renaming = 'mom';
  const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'lab'; inp.value = m.label; inp.style.flex = '1';
  host.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = ok => { if (done) return; done = true; renaming = null; const v = inp.value.trim(); if (ok && v && v !== m.label) commitMomLabel(mid, v); else renderDetail(); };
  inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
});
function confirmBtn(btn, fn, label) {
  if (btn.dataset.armed) { clearTimeout(+btn.dataset.armed); fn(); return; }
  const orig = btn.innerHTML; btn.classList.add('armed'); btn.innerHTML = label || 'Confirmar';
  btn.dataset.armed = setTimeout(() => { btn.classList.remove('armed'); btn.innerHTML = orig; delete btn.dataset.armed; }, 2500);
}

// ---------- toast ----------
let toastT = 0;
function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms || 2200);
}

// ---------- reproductor ----------
const audio = $('#audio');
audio.crossOrigin = 'anonymous'; // antes de cualquier src: hace falta para pasar el audio por Web Audio
const wave = $('#wave'), wbox = $('#wavebox'), wctx = wave.getContext('2d');
const ICON_PLAY = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 2l10 6-10 6z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3 2h4v12H3zM9 2h4v12H9z" fill="currentColor"/></svg>';
let momentPlay = null;     // {id,start,end}
let loopOn = false;
let pendingSeek = null;
let rangeSel = null;       // {a,b}
let hoverX = null;
let cache = null;          // {on, off, W, H, id}
let Z = { z: 1, t0: 0, free: 0 };   // zoom horizontal de la onda (free: hasta cuándo no se sigue al cursor)
let cuePlay = null, cueFiring = false, cueFadeObj = null;

// volumen: mitad del deslizador = 100%, extremo derecho = volMax
function gainFromPos(p, vm) { vm = vm || UI.volMax; if (vm <= 1) return p; return p <= 0.5 ? p * 2 : 1 + (p - 0.5) * 2 * (vm - 1); }
function posFromGain(g, vm) { vm = vm || UI.volMax; if (vm <= 1) return Math.min(1, g); return g <= 1 ? g / 2 : Math.min(1, 0.5 + (g - 1) / (2 * (vm - 1))); }
let actx = null, agraph = null, waFailed = false;
let fadeMul = 1;           // multiplicador de fundidos (modo guion)
function ensureAudioGraph() {
  if (agraph || waFailed) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    actx = new Ctx();
    const src = actx.createMediaElementSource(audio), gain = actx.createGain(), comp = actx.createDynamicsCompressor();
    comp.threshold.value = -1.5; comp.knee.value = 0; comp.ratio.value = 20; comp.attack.value = 0.002; comp.release.value = 0.12;
    src.connect(gain); gain.connect(comp); comp.connect(actx.destination);
    agraph = { gain, comp };
  } catch (e) { waFailed = true; agraph = null; console.warn('Web Audio no disponible, uso audio.volume', e); }
  applyVolume();
}
['pointerdown', 'keydown'].forEach(n => document.addEventListener(n, ensureAudioGraph, true));
function applyVolume() {
  const g = gainFromPos(UI.vol, UI.volMax) * fadeMul, vol = $('#vol');
  if (+vol.value !== UI.vol) vol.value = UI.vol;
  $('#vol-n').textContent = Math.round(gainFromPos(UI.vol, UI.volMax) * 100) + '%';
  $('.vmark').hidden = UI.volMax <= 1;
  if (agraph) { agraph.gain.gain.value = g; audio.volume = 1; } else audio.volume = Math.min(1, g);
}
$('#vol').oninput = e => {
  let p = +e.target.value;
  if (UI.volMax > 1 && Math.abs(p - 0.5) < 0.015) p = 0.5;
  UI.vol = p; scheduleUISave(); applyVolume();
};
$('#vol').addEventListener('change', e => e.target.blur());
audio.addEventListener('play', () => { if (actx && actx.state === 'suspended') actx.resume(); });
// Plan B: si el audio no carga por CORS, se reproduce sin Web Audio (volumen hasta 100%).
audio.addEventListener('error', () => {
  if (!audio.crossOrigin || agraph || !audio.src) return;
  waFailed = true; audio.removeAttribute('crossorigin');
  const s = audio.src; audio.src = s; audio.load(); applyVolume();
});
$('#b-play').innerHTML = ICON_PLAY;

function curFile() { return curId && byId.get(curId); }
function curDur() {
  if (isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  const f = curFile(); return f && f.analysis ? f.analysis.duration : 0;
}
function selectTrack(id, o) {
  o = o || {};
  const f = byId.get(id); if (!f) return;
  const changed = id !== curId;
  curId = id;
  if (!o.keepSel) { selected = new Set([id]); anchorId = id; } else selected.add(id);
  if (changed) {
    if (!cueFiring && cuePlay) { cuePlay = null; renderCuesLight(); }
    Z.z = 1; Z.t0 = 0; updateZoomUI();
    momentPlay = null; rangeSel = null; cache = null; selMom = null; pendingIn = null;
    const st = o.start != null ? o.start : effectiveStart(f);
    pendingSeek = st > 0 ? st : null;
    audio.src = convertFileSrc(f.path);
    buildWaveCache();
  } else if (o.start != null) audio.currentTime = o.start;
  else if (o.play !== false && (audio.currentTime || 0) < 0.05) { const st = effectiveStart(f); if (st > 0) audio.currentTime = st; }
  if (o.play !== false) audio.play().catch(() => { });
  renderPlayerInfo(); renderList(true); renderDetail(); updateRange(); scrollToId(id); drawWave();
  ensureLoop();
}
function renderPlayerInfo() {
  const f = curFile();
  const pt = (f ? dn(f) : '') + (cuePlay ? '  ·  Cue ' + cuePlay.n : '');
  $('#p-title').textContent = pt; $('#p-title2').textContent = pt;
  const we = $('#wave-empty'); we.hidden = !!f; we.style.display = f ? 'none' : ''; we.textContent = f ? '' : 'Elegí un tema para escucharlo';
  updateTime();
}
function updateTime() {
  const d = curDur();
  $('#p-time').textContent = fmt(audio.currentTime || 0) + ' / ' + fmt(d);
  const anyPlay = !audio.paused || (cueFadeObj && cueFadeObj.running);
  $('#b-play').innerHTML = anyPlay ? ICON_PAUSE : ICON_PLAY;
  $('#b-play2').innerHTML = anyPlay ? ICON_PAUSE : ICON_PLAY;
  $('#p-time2').textContent = $('#p-time').textContent;
  updatePDrag();
}
function playMoment(id, mid) {
  const t = T(id), m = t && t.moments.find(x => x.id === mid); if (!m) return;
  if (cuePlay) { cuePlay = null; renderCuesLight(); }
  if (id !== curId) selectTrack(id, { play: true, start: m.start });
  else { audio.currentTime = m.start; audio.play().catch(() => { }); ensureLoop(); }
  momentPlay = { id: m.id, start: m.start, end: m.end };
  renderDetail(); drawWave();
}
function tickMoment() {
  if (!momentPlay || momentPlay.end == null || audio.paused) return;
  if (audio.currentTime >= momentPlay.end) {
    if (loopOn) audio.currentTime = momentPlay.start;
    else { audio.pause(); audio.currentTime = momentPlay.end; }
  }
}
function neighbor(dir) {
  if (!view.length) return;
  let i = view.findIndex(v => v.f.id === curId);
  i = i < 0 ? (dir > 0 ? 0 : view.length - 1) : (i + dir + view.length) % view.length;
  selectTrack(view[i].f.id, { play: true });
}
// Play/pausa: SIEMPRE alterna. Si quedó pausado al final de un momento, se descarta el tope del momento para que no se vuelva a pausar solo.
function togglePlay() {
  if (cueFadeObj) { cuePauseAll(); return; }
  if (!curId) { if (view.length) selectTrack(view[0].f.id, { play: true }); return; }
  if (!audio.paused) { audio.pause(); return; }
  const f = curFile();
  if (momentPlay && momentPlay.end != null && audio.currentTime >= momentPlay.end - 0.05) {
    if (loopOn) audio.currentTime = momentPlay.start; else { momentPlay = null; renderDetail(); }
  } else if (audio.ended) { audio.currentTime = effectiveStart(f); }
  else if ((audio.currentTime || 0) < 0.05) { const st = effectiveStart(f); if (st > 0) audio.currentTime = st; }
  audio.play().catch(() => { }); ensureLoop();
}
function seekTo(t, play) {
  const d = curDur(); if (!d) return;
  t = Math.max(0, Math.min(d - 0.05, t));
  audio.currentTime = t;
  if (momentPlay && (t < momentPlay.start || (momentPlay.end != null && t > momentPlay.end))) { momentPlay = null; renderDetail(); }
  if (play && audio.paused) audio.play().catch(() => { });
  ensureVisible(t);
  updateTime(); drawWave(); ensureLoop();
}
$('#b-play').onclick = togglePlay;
$('#b-prev').onclick = () => neighbor(-1);
$('#b-next').onclick = () => neighbor(1);
$('#b-loop').onclick = e => { loopOn = !loopOn; e.currentTarget.classList.toggle('on', loopOn); };
$('#b-in').onclick = markIn;
$('#b-out').onclick = markOut;
$('#b-save-range').onclick = () => {
  if (!rangeSel || !curId) return;
  const a = Math.min(rangeSel.a, rangeSel.b), b = Math.max(rangeSel.a, rangeSel.b);
  addMoment(a, b); rangeSel = null; updateRange(); drawWave();
};
function updateRange() { const ok = !!(rangeSel && Math.abs(rangeSel.a - rangeSel.b) > 0.3); $('#b-save-range').hidden = !ok; $('#b-cue-range').hidden = !ok; updatePDrag(); }

// ---- momentos ----
function addMoment(start, end, label) {
  pushUndo();
  const t = TW(curId);
  const m = { id: uid(), start: round1(start), end: end == null ? null : round1(end), label: label || 'Momento ' + (t.moments.length + 1), tags: {} };
  t.moments.push(m); t.moments.sort((a, b) => a.start - b.start);
  focusMom = { id: m.id };
  libChanged();
  return m;
}
function markIn() {
  if (!curId) { toast('Elegí un tema primero'); return; }
  pendingIn = { id: curId, t: round1(audio.currentTime || 0) };
  toast('Inicio en ' + fmt(pendingIn.t, true) + '. Marcá el fin con O');
  renderDetail(); drawWave();
}
async function markOut() {
  if (!curId) return;
  const id = curId;
  if (!pendingIn || pendingIn.id !== id) { toast('Marcá un inicio primero (I)'); return; }
  const now = round1(audio.currentTime || 0), s = pendingIn.t;
  if (now <= s + 0.2) { toast('El fin tiene que ir después del inicio'); return; }
  let name = 'Momento ' + (TW(id).moments.length + 1);
  if (UI.askMomentName) { const r = await askName(name); if (r == null) return; name = r || name; }
  if (id !== curId) return;
  const m = addMoment(s, now, name);
  pendingIn = { id, t: now };
  toast(m.label + ' creado');
  renderDetail(); drawWave();
}
function askName(def) {
  return new Promise(res => {
    const box = $('#ask');
    box.innerHTML = `<div class="abox"><h3>Nombre del momento</h3><input type="text" value="${esc(def)}" autocomplete="off"><div class="abtn"><button class="btn" data-a="no">Cancelar</button><button class="btn gold" data-a="ok">Crear</button></div></div>`;
    box.hidden = false;
    const inp = box.querySelector('input'); inp.focus(); inp.select();
    const done = v => { box.hidden = true; box.innerHTML = ''; res(v); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(inp.value.trim()); else if (e.key === 'Escape') done(null); });
    box.onclick = e => { const b = e.target.closest('[data-a]'); if (b) done(b.dataset.a === 'ok' ? inp.value.trim() : null); else if (e.target === box) done(null); };
  });
}

audio.addEventListener('play', () => { updateTime(); ensureLoop(); });
audio.addEventListener('pause', () => { updateTime(); drawWave(); });
audio.addEventListener('timeupdate', () => { tickMoment(); tickCue(); if (audio.paused) { updateTime(); drawWave(); } });
audio.addEventListener('durationchange', () => { updateTime(); drawWave(); });
audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek != null) { audio.currentTime = pendingSeek; pendingSeek = null; }
  updateTime(); drawWave();
});
audio.addEventListener('ended', () => { if (cuePlay) { cuePlay = null; renderCuesLight(); renderPlayerInfo(); return; } if (!momentPlay || !loopOn) neighbor(1); });
audio.addEventListener('error', () => { if (audio.getAttribute('src')) toast('No se pudo reproducir este archivo'); });

let raf = 0, lastFrame = 0;
function loop(ts) {
  raf = 0;
  if (audio.paused) { updateTime(); drawWave(); return; }
  if (ts - lastFrame >= 30) { lastFrame = ts; tickMoment(); tickCue(); updateTime(); drawWave(); }
  raf = requestAnimationFrame(loop);
}
function ensureLoop() { if (!raf) raf = requestAnimationFrame(loop); }
let drawRaf = 0;
function scheduleDraw() { if (drawRaf) return; drawRaf = requestAnimationFrame(() => { drawRaf = 0; drawWave(); }); }

// ---- onda ----
const LABEL_H = 14, LANE_H = 12, HANDLE = 6; // css px
function resizeWave() {
  const d = DPR(), r = wbox.getBoundingClientRect();
  const w = Math.max(10, Math.floor(r.width * d)), h = Math.max(10, Math.floor(r.height * d));
  if (wave.width !== w || wave.height !== h) { wave.width = w; wave.height = h; }
  buildWaveCache(); drawWave();
}
new ResizeObserver(() => resizeWave()).observe(wbox);
window.addEventListener('resize', resizeWave);

function buildWaveCache() {
  cache = null;
  const f = curFile(), an = f && f.analysis;
  if (!hasWave(an) || !an.peaks || !an.peaks.length) return;
  const d = DPR(), W = wave.width, H = wave.height, light = colors.theme === 'light';
  const step = 3 * d, bw = 2 * d, N = Math.floor(W / step), L = an.peaks.length;
  const rms = an.rms && an.rms.length ? an.rms : an.peaks;
  const pct = (arr, q) => { const a = Array.from(arr).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * q))] || 0; };
  const ref = Math.max(20, pct(rms, 0.92)), refPk = Math.max(30, pct(an.peaks, 0.97));
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const on = mk(), off = mk(), gOn = on.getContext('2d'), gOff = off.getContext('2d');
  const top = LABEL_H * d, mid = top + (H - top) / 2, maxH = (H - top) / 2 - 3 * d;
  for (let i = 0; i < N; i++) {
    const s = Math.floor(i * L / N), e = Math.max(s + 1, Math.floor((i + 1) * L / N));
    let pk = 0, rs = 0;
    for (let k = s; k < e && k < L; k++) { if (an.peaks[k] > pk) pk = an.peaks[k]; rs += rms[k]; }
    rs /= (e - s);
    const tl = Math.pow(Math.min(1, rs / ref), 1.7);
    const h = Math.max(1.5 * d, Math.pow(Math.min(1, pk / refPk), 1.15) * maxH), x = i * step;
    if (light) {
      // fuerte: carbón; suave: casi del color del fondo. Lo que falta por sonar queda más claro.
      gOn.fillStyle = `hsl(40,${6 + 8 * tl}%,${74 - 62 * tl}%)`;
      gOff.fillStyle = `hsl(40,${8 + 6 * tl}%,${84 - 30 * tl}%)`;
    } else {
      gOn.fillStyle = `hsl(43,${8 + 36 * tl}%,${24 + 72 * tl}%)`;
      gOff.fillStyle = `hsl(40,${3 + 7 * tl}%,${11 + 27 * tl}%)`;
    }
    gOn.fillRect(x, mid - h, bw, h * 2); gOff.fillRect(x, mid - h, bw, h * 2);
  }
  cache = { on, off, W, H, id: curId, ref, refPk };
}
// ---- zoom horizontal ----
const ZMAX = 40;
function vspan() { const d = curDur(); return d ? d / Z.z : 1; }
function clampView() {
  if (Z.z <= 1.0001) { Z.z = 1; Z.t0 = 0; return; }
  const d = curDur(), sp = vspan();
  Z.t0 = Math.max(0, Math.min(Math.max(0, d - sp), Z.t0));
}
const t2x = (t, W) => (t - Z.t0) / vspan() * W;
function setZoom(nz, fx) {
  const d = curDur(); if (!d) return;
  fx = fx == null ? 0.5 : fx;
  const tp = Z.t0 + fx * vspan();
  Z.z = Math.max(1, Math.min(ZMAX, nz));
  Z.t0 = tp - fx * vspan();
  clampView(); Z.free = performance.now() + 2500;
  updateZoomUI(); scheduleDraw();
}
function panBy(dt) { if (Z.z <= 1) return; Z.t0 += dt; clampView(); Z.free = performance.now() + 2500; updateZoomUI(); scheduleDraw(); }
function ensureVisible(t) {
  if (Z.z <= 1) return;
  const sp = vspan();
  if (t < Z.t0 || t > Z.t0 + sp) { Z.t0 = t - sp * 0.2; clampView(); updateZoomUI(); }
}
function updateZoomUI() {
  const zl = $('#zl'); if (!zl) return;
  zl.textContent = (Z.z >= 10 ? Math.round(Z.z) : Math.round(Z.z * 10) / 10) + '×';
  $('#b-fit').disabled = Z.z <= 1;
  const ws = $('#wscroll'), d = curDur();
  ws.classList.toggle('on', Z.z > 1 && d > 0);
  if (Z.z > 1 && d) { const th = ws.firstElementChild; th.style.left = (Z.t0 / d * 100) + '%'; th.style.width = (100 / Z.z) + '%'; }
}
$('#b-fit').onclick = () => { Z.z = 1; Z.t0 = 0; updateZoomUI(); drawWave(); };
$('#z-in').onclick = () => zoomAtCursor(1.6);
$('#z-out').onclick = () => zoomAtCursor(1 / 1.6);
function zoomAtCursor(fac) {
  const d = curDur(); if (!d) return;
  const cur = audio.currentTime || 0, sp = vspan();
  const fx = Z.z > 1 && cur >= Z.t0 && cur <= Z.t0 + sp ? (cur - Z.t0) / sp : (Z.z > 1 ? 0.5 : cur / d);
  setZoom(Z.z * fac, fx);
}
wbox.addEventListener('wheel', e => {
  e.preventDefault();
  if (!curId || !curDur()) return;
  const r = wbox.getBoundingClientRect(), fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= r.width; dy *= r.width; }
  if (e.ctrlKey || e.metaKey) {
    const notch = Math.abs(dy) >= 40 && Number.isInteger(dy);
    const fac = notch ? (dy < 0 ? 1.3 : 1 / 1.3) : Math.max(0.6, Math.min(1.6, Math.exp(-dy * 0.015)));
    setZoom(Z.z * fac, fx);
  } else if (Z.z > 1) {
    const dd = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    panBy(dd / r.width * vspan());
  }
}, { passive: false });
document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
// barra de desplazamiento mini
{
  const ws = $('#wscroll'); let sd = null;
  ws.addEventListener('mousedown', e => {
    if (Z.z <= 1 || e.button !== 0) return;
    e.preventDefault();
    const r = ws.getBoundingClientRect(), d = curDur(), th = ws.firstElementChild.getBoundingClientRect();
    if (e.clientX >= th.left && e.clientX <= th.right) sd = { x: e.clientX, t0: Z.t0 };
    else { Z.t0 = (e.clientX - r.left) / r.width * d - vspan() / 2; clampView(); updateZoomUI(); scheduleDraw(); sd = { x: e.clientX, t0: Z.t0 }; }
    Z.free = performance.now() + 2500;
  });
  window.addEventListener('mousemove', e => {
    if (!sd) return;
    const r = ws.getBoundingClientRect(), d = curDur();
    Z.t0 = sd.t0 + (e.clientX - sd.x) / r.width * d; clampView(); Z.free = performance.now() + 2500; updateZoomUI(); scheduleDraw();
  });
  window.addEventListener('mouseup', () => { sd = null; });
}
// carriles de momentos (px css)
function momLayout() {
  const f = curFile(), t = f && T(f.id), dur = curDur();
  if (!t || !dur || !t.moments.length) return { items: [], lanes: 0, bot: 0 };
  const W = wbox.clientWidth, sp = vspan(), ends = [], items = [];
  for (const m of t.moments.slice().sort((a, b) => a.start - b.start)) {
    const e = m.end != null ? m.end : Math.min(dur, m.start + sp * 0.03);
    let lane = 0; while (lane < ends.length && ends[lane] > m.start + 1e-6) lane++;
    ends[lane] = e;
    items.push({ m, lane: Math.min(lane, 2), x1: (m.start - Z.t0) / sp * W, x2: (e - Z.t0) / sp * W });
  }
  const lanes = Math.min(3, ends.length);
  return { items, lanes, bot: lanes * (LANE_H + 1) + 3 };
}
const momById = id => { const t = curId && T(curId); return t && t.moments.find(m => m.id === id); };
function rr(g, x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); g.fill(); }
function drawZoomBars(g, W, wTop, wH, dur, cur, d) {
  const an = curFile().analysis, peaks = an.peaks, L = peaks.length, rms = an.rms && an.rms.length ? an.rms : peaks;
  const ref = cache.ref, refPk = cache.refPk, light = colors.theme === 'light';
  const step = 3 * d, bw = 2 * d, N = Math.ceil(W / step), mid = wTop + wH / 2, maxH = wH / 2 - 3 * d, sp = vspan(), pps = L / dur;
  for (let i = 0; i < N; i++) {
    const ta = Z.t0 + (i * step) / W * sp, tb = Z.t0 + ((i + 1) * step) / W * sp, tc = (ta + tb) / 2;
    if (tc < 0 || tc > dur) continue;
    const pa = ta * pps, pb = tb * pps; let pk, rs;
    if (pb - pa > 1) {
      const s0 = Math.max(0, Math.floor(pa)), e0 = Math.min(L, Math.ceil(pb)); pk = 0; rs = 0;
      for (let k = s0; k < e0; k++) { if (peaks[k] > pk) pk = peaks[k]; rs += rms[k]; }
      rs /= Math.max(1, e0 - s0);
    } else {
      const a = Math.max(0, Math.min(L - 1, (pa + pb) / 2 - 0.5)), lo = Math.floor(a), hi = Math.min(L - 1, lo + 1), fr = a - lo;
      pk = peaks[lo] * (1 - fr) + peaks[hi] * fr; rs = rms[lo] * (1 - fr) + rms[hi] * fr;
    }
    const tl = Math.pow(Math.min(1, rs / ref), 1.7), h = Math.max(1.5 * d, Math.pow(Math.min(1, pk / refPk), 1.15) * maxH);
    const on = tc <= cur;
    if (light) g.fillStyle = on ? `hsl(40,${6 + 8 * tl}%,${74 - 62 * tl}%)` : `hsl(40,${8 + 6 * tl}%,${84 - 30 * tl}%)`;
    else g.fillStyle = on ? `hsl(43,${8 + 36 * tl}%,${24 + 72 * tl}%)` : `hsl(40,${3 + 7 * tl}%,${11 + 27 * tl}%)`;
    g.fillRect(i * step, mid - h, bw, h * 2);
  }
}
function drawWave() {
  const W = wave.width, H = wave.height, d = DPR(), g = wctx, ac = colors.ac;
  g.clearRect(0, 0, W, H);
  const f = curFile(); if (!f) return;
  g.fillStyle = colors.wavebg; g.fillRect(0, 0, W, H);
  const dur = curDur(), top = LABEL_H * d, cur = audio.currentTime || 0;
  if (dur && Z.z > 1 && !audio.paused && !wdrag && performance.now() > Z.free) {
    const sp = vspan();
    if (cur < Z.t0 || cur > Z.t0 + sp * 0.98) { Z.t0 = cur - sp * 0.1; clampView(); updateZoomUI(); }
  }
  const L = momLayout(), botPx = L.bot * d, wTop = top, wH = H - top - botPx, mid = wTop + wH / 2;
  const tx = t => t2x(t, W);
  const px = dur ? tx(cur) : 0, pxc = Math.max(0, Math.min(W, px));
  if (Z.z > 1 && cache && cache.W === W && cache.H === H && dur) drawZoomBars(g, W, wTop, wH, dur, cur, d);
  else if (cache && cache.W === W && cache.H === H) {
    g.drawImage(cache.off, 0, top, W, H - top, 0, wTop, W, wH);
    if (pxc > 0) g.drawImage(cache.on, 0, top, pxc, H - top, 0, wTop, pxc, wH);
  } else {
    g.fillStyle = colors.wline; g.fillRect(0, mid - d, W, 2 * d);
    g.fillStyle = colors.text; g.fillRect(0, mid - d, pxc, 2 * d);
  }
  // zona antes del inicio efectivo: atenuada
  const es = dur ? effectiveStart(f) : 0;
  if (es > 0) {
    const xs = tx(es);
    if (xs > 0) { g.fillStyle = `rgba(${colors.bg},.66)`; g.fillRect(0, wTop, Math.min(W, xs), wH); }
    if (xs >= 0 && xs <= W) { g.fillStyle = `rgba(${ac},.6)`; g.fillRect(xs, wTop, d, wH); }
  }
  if (dur && L.items.length) {
    const hasSel = !!selMom && L.items.some(i => i.m.id === selMom);
    g.font = `500 ${10.5 * d}px "Host Grotesk",system-ui,sans-serif`; g.textBaseline = 'middle';
    for (const it of L.items) {
      const m = it.m, sel = m.id === selMom, act = momentPlay && momentPlay.id === m.id;
      const x1 = it.x1 * d, x2 = it.x2 * d, w = Math.max(2 * d, x2 - x1);
      if (x2 < -4 * d || x1 > W + 4 * d) continue;
      g.fillStyle = `rgba(${ac},${sel ? .22 : hasSel ? .05 : act ? .22 : .11})`;
      g.fillRect(x1, 0, w, H - botPx);
      g.fillStyle = `rgba(${ac},${sel ? .95 : hasSel ? .25 : .6})`; g.fillRect(x1, 0, d, H - botPx);
      if (m.end != null) g.fillRect(x2 - d, 0, d, H - botPx);
      const lx = Math.max(x1, 0);
      g.save(); g.beginPath(); g.rect(lx, 0, Math.max(40 * d, x2 - lx), top); g.clip();
      g.globalAlpha = sel ? 1 : hasSel ? .45 : .95; g.fillStyle = colors.text;
      g.fillText(m.label, lx + 4 * d, top / 2 + d); g.restore();
      // franja (agarradera)
      const fy = H - botPx + 2 * d + it.lane * (LANE_H + 1) * d;
      g.fillStyle = `rgba(${ac},${sel ? .95 : hasSel ? .26 : act ? .8 : .55})`;
      rr(g, x1, fy, Math.max(4 * d, w - d), LANE_H * d, 3 * d);
    }
    // tiradores del momento seleccionado
    const si = hasSel && L.items.find(i => i.m.id === selMom);
    if (si) {
      const hw = 5 * d, edges = si.m.end != null ? [si.x1, si.x2] : [si.x1];
      for (const ex of edges) {
        const x = ex * d - hw / 2;
        g.fillStyle = `rgba(${ac},.96)`; rr(g, x, 0, hw, H, 2 * d);
        g.fillStyle = `rgba(${colors.bg},.85)`; g.fillRect(x + 1.5 * d, H / 2 - 7 * d, d, 14 * d); g.fillRect(x + 3 * d, H / 2 - 7 * d, d, 14 * d);
      }
    }
  }
  // cue activo del modo guion
  if (cuePlay && cuePlay.track === curId && dur) {
    const x1 = tx(cuePlay.start), x2 = cuePlay.end != null ? tx(cuePlay.end) : W;
    if (x2 >= 0 && x1 <= W) {
      const a = Math.max(0, x1), b = Math.min(W, x2);
      g.fillStyle = `rgba(${ac},.07)`; g.fillRect(a, top, b - a, H - top - botPx);
      g.fillStyle = `rgba(${ac},.9)`; g.fillRect(a, top, b - a, 2 * d);
      const lab = String(cuePlay.n), bwid = (8 + lab.length * 7) * d;
      if (x1 >= 0) { g.fillStyle = `rgba(${ac},.95)`; rr(g, x1, top + 2 * d, bwid, 14 * d, 3 * d); g.fillStyle = `rgb(${colors.bg})`; g.font = `800 ${10 * d}px "Host Grotesk",system-ui,sans-serif`; g.textBaseline = 'middle'; g.fillText(lab, x1 + 4 * d, top + 9.5 * d); }
      if (cuePlay.end != null && x2 <= W) { g.fillStyle = `rgba(${ac},.9)`; g.fillRect(x2 - d, top, d, H - top - botPx); }
    }
  }
  if (pendingIn && pendingIn.id === curId && dur) {
    const x = tx(pendingIn.t);
    if (x >= 0 && x <= W) {
      g.save(); g.strokeStyle = `rgba(${ac},.95)`; g.lineWidth = d; g.setLineDash([4 * d, 3 * d]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - botPx); g.stroke(); g.restore();
      g.fillStyle = `rgba(${ac},.95)`; g.fillRect(x, 0, 12 * d, 12 * d);
      g.fillStyle = `rgb(${colors.bg})`; g.font = `800 ${9 * d}px "Host Grotesk",system-ui,sans-serif`; g.textBaseline = 'middle'; g.fillText('I', x + 4 * d, 6.5 * d);
    }
  }
  if (rangeSel && dur) {
    const a = tx(Math.min(rangeSel.a, rangeSel.b)), b = tx(Math.max(rangeSel.a, rangeSel.b));
    g.fillStyle = `rgba(${ac},.2)`; g.fillRect(a, 0, b - a, H);
    g.fillStyle = `rgba(${ac},.9)`; g.fillRect(a, 0, d, H); g.fillRect(b - d, 0, d, H);
  }
  if (hoverX != null) { g.fillStyle = `rgba(${ac},.35)`; g.fillRect(hoverX * d, 0, d, H); }
  if (dur && px >= -d && px <= W + d) { g.fillStyle = colors.hi; g.fillRect(px - d, 0, 2 * d, H); }
}
function xToTime(clientX) {
  const r = wbox.getBoundingClientRect();
  return Z.t0 + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * vspan();
}
// qué hay bajo el mouse en la onda (x, y en px css relativos a la caja)
function waveHit(x, y) {
  const L = momLayout(), H = wbox.clientHeight, laneY = it => H - L.bot + 2 + it.lane * (LANE_H + 1);
  if (selMom) {
    const it = L.items.find(i => i.m.id === selMom);
    if (it) {
      const d1 = Math.abs(x - it.x1), d2 = it.m.end != null ? Math.abs(x - it.x2) : 1e9;
      if (Math.min(d1, d2) <= HANDLE) return { type: d1 <= d2 ? 'hs' : 'he', id: it.m.id };
      const y0 = laneY(it);
      if (L.lanes && y >= y0 - 1 && y <= y0 + LANE_H + 1 && x >= it.x1 && x <= Math.max(it.x2, it.x1 + 4)) return { type: 'mv', id: it.m.id };
    }
  }
  for (let i = L.items.length - 1; i >= 0; i--) {
    const it = L.items[i], y0 = laneY(it);
    if (y >= y0 - 1 && y <= y0 + LANE_H + 1 && x >= it.x1 - 1 && x <= Math.max(it.x2, it.x1 + 4) + 1) return { type: 'fr', id: it.m.id };
  }
  if (y < LABEL_H) for (const it of L.items) if (x >= it.x1 && x <= Math.max(it.x2, it.x1 + 40)) return { type: 'label', id: it.m.id };
  if (L.lanes && y >= H - L.bot) return { type: 'lane' };
  return { type: 'wave' };
}
let wdrag = null;
function syncMomInputs(m) {
  const row = $('#detail').querySelector(`.mom[data-mid="${CSS.escape(m.id)}"]`); if (!row) return;
  const s = row.querySelector('[data-f="start"]'), e = row.querySelector('[data-f="end"]');
  if (s) s.value = fmt(m.start, true); if (e) e.value = m.end != null ? fmt(m.end, true) : '';
}
wbox.addEventListener('mousedown', e => {
  if (e.button !== 0 || !curId || !curDur()) return;
  if (e.target.closest('input')) return;
  e.preventDefault();
  const r = wbox.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = e.shiftKey ? { type: 'wave' } : waveHit(x, y);
  if (hit.type === 'hs' || hit.type === 'he') wdrag = { mode: hit.type, id: hit.id, x0: e.clientX, moved: false };
  else if (hit.type === 'mv') { const m = momById(hit.id); wdrag = { mode: 'mv', id: hit.id, x0: e.clientX, t0: xToTime(e.clientX), s0: m.start, e0: m.end, moved: false }; }
  else if (hit.type === 'fr' || hit.type === 'label') selectMoment(hit.id, { scroll: true });
  else if (hit.type === 'lane') selectMoment(null);
  else {
    const t = xToTime(e.clientX);
    if (e.shiftKey) { wdrag = { mode: 'range', a: t }; rangeSel = { a: t, b: t }; }
    else { wdrag = { mode: 'scrub' }; rangeSel = null; seekTo(t, true); }
  }
  updateRange(); drawWave();
});
function dragMomentTo(e) {
  const w = wdrag, m = momById(w.id), dur = curDur(); if (!m) return;
  if (!w.moved) { if (Math.abs(e.clientX - w.x0) < 3) return; pushUndo(); w.moved = true; }
  const t = xToTime(e.clientX), cl = (v, a, b) => Math.max(a, Math.min(b, v));
  if (w.mode === 'hs') m.start = round1(cl(t, 0, m.end != null ? m.end - 0.2 : dur));
  else if (w.mode === 'he') m.end = round1(cl(t, m.start + 0.2, dur));
  else {
    const len = w.e0 != null ? w.e0 - w.s0 : 0, ns = cl(w.s0 + (t - w.t0), 0, Math.max(0, dur - len));
    m.start = round1(ns); if (w.e0 != null) m.end = round1(ns + len);
  }
  if (momentPlay && momentPlay.id === m.id) { momentPlay.start = m.start; momentPlay.end = m.end; }
  syncMomInputs(m);
  const tip = $('#tip'); tip.hidden = false;
  tip.textContent = w.mode === 'hs' ? fmt(m.start, true) : w.mode === 'he' ? fmt(m.end, true) : fmt(m.start, true) + ' – ' + (m.end != null ? fmt(m.end, true) : '');
  scheduleDraw();
}
window.addEventListener('mousemove', e => {
  if (wdrag) {
    if (wdrag.mode === 'hs' || wdrag.mode === 'he' || wdrag.mode === 'mv') { dragMomentTo(e); wbox.style.cursor = wdrag.mode === 'mv' ? 'grabbing' : 'ew-resize'; return; }
    if (Z.z > 1) { const rb = wbox.getBoundingClientRect(), sp = vspan(); if (e.clientX < rb.left) panBy(-sp * 0.02); else if (e.clientX > rb.right) panBy(sp * 0.02); }
    const t = xToTime(e.clientX);
    if (wdrag.mode === 'scrub') seekTo(t, false); else { rangeSel.b = t; updateRange(); scheduleDraw(); }
  }
  const r = wbox.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  const tip = $('#tip');
  if ((inside || wdrag) && curDur()) {
    hoverX = Math.max(0, Math.min(r.width, e.clientX - r.left));
    tip.hidden = false; tip.style.left = Math.max(24, Math.min(r.width - 24, hoverX)) + 'px';
    tip.textContent = fmt(xToTime(e.clientX), true);
    if (inside && !wdrag) {
      const h = waveHit(e.clientX - r.left, e.clientY - r.top);
      wbox.style.cursor = h.type === 'hs' || h.type === 'he' ? 'ew-resize' : h.type === 'mv' ? 'grab' : h.type === 'lane' ? 'default' : 'pointer';
    }
    if (audio.paused || wdrag) scheduleDraw();
  } else if (hoverX != null) { hoverX = null; tip.hidden = true; scheduleDraw(); }
});
window.addEventListener('mouseup', () => {
  if (!wdrag) return;
  const w = wdrag; wdrag = null;
  if (w.mode === 'range' && rangeSel && Math.abs(rangeSel.a - rangeSel.b) <= 0.3) rangeSel = null;
  if ((w.mode === 'hs' || w.mode === 'he' || w.mode === 'mv') && w.moved) {
    const m = momById(w.id);
    libChanged();
    if (m && w.mode === 'hs') seekTo(m.start, true);
    else if (m && w.mode === 'he') seekTo(Math.max(0, m.end - 2), true);
    $('#tip').hidden = true;
  }
  updateRange(); drawWave();
});
// renombrar un momento desde su etiqueta sobre la onda
wbox.addEventListener('dblclick', e => {
  if (e.target.closest('input') || !curId) return;
  const r = wbox.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (y >= LABEL_H + 4) return;
  const it = momLayout().items.find(i => x >= i.x1 && x <= Math.max(i.x2, i.x1 + 40)); if (!it) return;
  selectMoment(it.m.id, { scroll: true });
  const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'wave-ren'; inp.value = it.m.label;
  inp.style.left = Math.max(0, Math.min(r.width - 154, it.x1)) + 'px';
  wbox.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const finish = ok => { if (done) return; done = true; const v = inp.value; inp.remove(); if (ok) commitMomLabel(it.m.id, v); };
  inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
  ['mousedown', 'click', 'dblclick'].forEach(n => inp.addEventListener(n, ev => ev.stopPropagation()));
});

// ---------- teclado ----------
function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes((el.type || 'text').toLowerCase());
  return false;
}
const overlaysClosed = () => $('#crop').hidden && $('#help').hidden && $('#settings').hidden && $('#modal').hidden && $('#ask').hidden;
document.addEventListener('keydown', e => {
  if (!$('#crop').hidden) { cropKey(e); return; }
  if (!$('#help').hidden) { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); closeHelp(); } return; }
  if (!$('#ask').hidden) return;
  if (!$('#settings').hidden) { if (e.key === 'Escape' && !isTextEntry(e.target)) closeSettings(); return; }
  if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(); return; }
  const el = e.target;
  if (isTextEntry(el)) { if (e.key === 'Escape') el.blur(); return; }
  const k = e.key, code = e.code || '';
  if ((e.ctrlKey || e.metaKey) && e.altKey && /^Digit[1-5]$/.test(code)) { e.preventDefault(); if (!e.repeat) togglePanel(['filters', 'list', 'detail', 'player', 'cues'][+code.slice(5) - 1]); return; }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (code === 'Space') { e.preventDefault(); if (!e.repeat) cuePauseAll(); return; }
    const mm = /^(?:Digit|Numpad)(\d)$/.exec(code);
    if (mm) { e.preventDefault(); if (!e.repeat) { let n = +mm[1]; if (n === 0) n = 10; if (e.shiftKey) n += 10; fireCueNumber(n); } return; }
  }
  // Espacio = play/pausa SIEMPRE (sin importar qué botón o deslizador tenga el foco). No se repite al mantenerlo apretado.
  if (k === ' ' || e.code === 'Space') { e.preventDefault(); if (!e.repeat) togglePlay(); return; }
  if (e.ctrlKey || e.metaKey) { if ((k === 'z' || k === 'Z') && !e.shiftKey) { e.preventDefault(); undo(); } return; }
  if (e.altKey) return;
  if (el && el.tagName === 'SELECT') return;
  if (k === 'ArrowLeft') { e.preventDefault(); seekTo(audio.currentTime - 5, false); }
  else if (k === 'ArrowRight') { e.preventDefault(); seekTo(audio.currentTime + 5, false); }
  else if (k === 'ArrowUp') { e.preventDefault(); neighbor(-1); }
  else if (k === 'ArrowDown') { e.preventDefault(); neighbor(1); }
  else if (k === '?') { e.preventDefault(); openHelp(); }
  else if (k === 'Escape') {
    if (quick.on) toggleQuick(false);
    else if (selMom) selectMoment(null);
    else if (selected.size > 1) { selected = new Set(curId ? [curId] : []); anchorId = curId; afterSelection(); }
  }
  else if (k === 'Enter' && quick.on) { e.preventDefault(); quickApplySelected(); }
  else if (k === 'g' || k === 'G') { e.preventDefault(); toggleCues(); }
  else if (k === 'c' || k === 'C') { e.preventDefault(); addCueHere(); }
  else if (k === '+' || k === '=') { e.preventDefault(); zoomAtCursor(1.6); }
  else if (k === '-' || k === '_') { e.preventDefault(); zoomAtCursor(1 / 1.6); }
  else if (k === 'r' || k === 'R') randomTrack();
  else if (k === 'f' || k === 'F') { toggleFav(curId); }
  else if (k === 'e' || k === 'E') { e.preventDefault(); toggleQuick(); }
  else if (k === 's' || k === 'S') { e.preventDefault(); markStartHere(); }
  else if (k === 'i' || k === 'I') { e.preventDefault(); markIn(); }
  else if (k === 'o' || k === 'O') { e.preventDefault(); markOut(); }
  else if (/^[1-9]$/.test(k)) {
    if (quick.on) quickPick(+k - 1);
    else { const d = curDur(); if (d) seekTo(d * (+k) / 10, false); }
  }
});
// El espacio al soltarse "aprieta" el botón que tenga el foco: se anula para que no vuelva a alternar.
document.addEventListener('keyup', e => {
  if ((e.key === ' ' || e.code === 'Space') && !isTextEntry(e.target) && overlaysClosed()) e.preventDefault();
});
// Después de usar un botón, se le saca el foco para que no capture teclas.
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('button');
  if (b) setTimeout(() => { if (document.activeElement === b) b.blur(); }, 0);
}, true);

// ---------- ayuda de atajos ----------
const SHORTCUTS = [
  ['Espacio', 'Reproducir / pausa (siempre)'], ['← →', 'Retroceder / adelantar 5 s'], ['↑ ↓', 'Tema anterior / siguiente'],
  ['1 a 9', 'Saltar al 10% a 90% del tema (en etiquetado rápido: elegir valor)'], ['R', 'Tema al azar de la lista actual'], ['F', 'Marcar favorito'],
  ['I', 'Marcar inicio de momento'], ['O', 'Marcar fin: crea el momento. O otra vez encadena el siguiente'],
  ['S', 'Marcar acá el inicio real del tema'], ['E', 'Etiquetado rápido (Enter aplica a los seleccionados, Esc sale)'],
  ['Ctrl + Z', 'Deshacer el último cambio'], ['Ctrl + V', 'Pegar una imagen como portada del tema'],
  ['Ctrl + clic', 'Sumar o quitar un tema de la selección'], ['Shift + clic', 'Seleccionar un rango de temas'],
  ['Shift + arrastrar', 'Elegir un rango en la onda'], ['Clic en franja', 'Elegir un momento para ajustarlo con los tiradores'],
  ['Doble clic', 'Renombrar tema o momento'], ['Clic en mini-onda', 'Reproducir desde ese punto'],
  ['Arrastrar (asa)', 'Llevar tema o fragmento afuera'],
  ['G', 'Abrir / cerrar el Modo guion'], ['C', 'Agregar cue al guion (en la posición actual, o el rango marcado)'],
  ['Ctrl + 1…9, Ctrl + 0', 'Disparar el cue 1…9 y 10 del guion (también con el teclado numérico)'], ['Ctrl + Shift + 1…0', 'Disparar los cues 11…20'],
  ['Ctrl + Espacio', 'Pausar / reanudar todo el guion (incluye un fundido en curso)'],
  ['Ctrl + Alt + 1…4', 'Mostrar / ocultar: filtros, lista, tema, onda (Ctrl + Alt + 5: guion)'],
  ['Ctrl + rueda, pellizco', 'Zoom horizontal de la onda (centrado en el puntero)'], ['Dos dedos / rueda con zoom', 'Mover la onda hacia los costados'],
  ['+  −', 'Acercar / alejar la onda'], ['?', 'Abrir / cerrar esta ayuda'], ['Esc', 'Deseleccionar / salir / cerrar paneles']];
function openHelp() {
  $('#help').innerHTML = `<div class="hbox"><h3>Atajos</h3><dl>${SHORTCUTS.map(([k, d]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(d)}</dd>`).join('')}</dl><div class="hf">Esc o clic afuera para cerrar</div></div>`;
  $('#help').hidden = false;
}
function closeHelp() { $('#help').hidden = true; }
$('#help').addEventListener('mousedown', e => { if (e.target.id === 'help') closeHelp(); });
$('#btn-help').onclick = openHelp;

// ---------- soltar archivos ----------
const normPath = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
async function onDrop(p) {
  $('#dropov').hidden = true;
  const paths = (p && p.paths) || []; if (!paths.length) return;
  if (paths.every(x => IMG_RE.test(x))) {
    const ids = targetIds();
    if (!ids.length) { toast('Elegí un tema primero para ponerle la portada'); return; }
    coverWithCrop(ids, { path: paths[0] }); return;
  }
  if (!S.folder) { toast('Primero elegí la carpeta de tu música'); return; }
  const roots = (S.roots || []).map(r => normPath(r.path) + '/');
  if (roots.length && paths.every(x => roots.some(r => (normPath(x) + '/').startsWith(r)))) { toast('Ese tema ya está en tu carpeta'); return; }
  try {
    const r = await invoke('import_files', { paths });
    if (r && r.state) applyState(r.state);
    toast('Agregados: ' + (r ? r.added : 0) + (r && r.skipped > 0 ? ' · ya estaban: ' + r.skipped : ''));
  } catch (err) { toast('No se pudo importar: ' + errText(err)); }
}

// ---------- eventos del motor ----------
let analysisQueued = false;
function onAnalysis(p) {
  const f = byId.get(p.id); if (!f) return;
  if (!f.analysis && pendingN > 0) pendingN--;
  f.analysis = p.analysis;
  if (p.analysis && p.analysis.duration === 0) queueFallback(p.id);
  renderHead();
  if (p.id === curId && hasWave(p.analysis)) { buildWaveCache(); updateDetailMeta(); updateTime(); scheduleDraw(); }
  if (!analysisQueued) {
    analysisQueued = true;
    requestAnimationFrame(() => { analysisQueued = false; if (sortBy === 'dur' || sortBy === 'bpm') { computeView(); layoutList(); } renderList(true); });
  }
}

// ---------- configuración ----------
let subCache = {};          // key -> {loading, data, err}
const openRoots = new Set();
let exclChain = Promise.resolve();
const SEG = [
  ['Apariencia', [
    ['Ocultar el autor en los nombres', 'Muestra solo lo que va después del primer " - ". No renombra nada: es solo visual.', 'hideAuthor', [[true, 'Sí'], [false, 'No']]],
    ['Tema', '', 'theme', [['dark', 'Oscuro'], ['light', 'Claro'], ['system', 'Como Windows']]],
    ['Distribución de etiquetas', 'En renglón: varias por renglón. En lista: una por renglón, con las asignadas primero.', 'tagLayout', [['wrap', 'En renglón'], ['list', 'En lista']]]]],
  ['Reproducción', [
    ['Saltar el silencio del principio', 'Arranca donde empieza el sonido de verdad.', 'skipSilence', [[true, 'Sí'], [false, 'No']]],
    ['Volumen máximo', 'La marca del medio del deslizador es el 100%.', 'volMax', [[1, '100%'], [2, '200%']]]]],
  ['Momentos', [
    ['Pedir nombre al crear un momento', 'Si no, se llama "Momento 1", "Momento 2"… y lo renombrás con doble clic.', 'askMomentName', [[true, 'Sí'], [false, 'No']]]]],
  ['Arrastrar tema afuera', [
    ['Qué se lleva al arrastrar', '', 'dragTrimmed', [[false, 'Archivo original completo'], [true, 'Sin el silencio del principio']]]]],
  ['Modo guion', [
    ['Transición entre cues', 'Corte seco, o el tema que suena baja mientras el nuevo sube.', 'cueTransition', [['cut', 'Corte seco'], ['fade', 'Fundido cruzado']]],
    ['Duración del fundido', 'Solo para el fundido cruzado.', 'cueFade', [[0.5, '0,5 s'], [1, '1 s'], [1.5, '1,5 s'], [2, '2 s'], [3, '3 s'], [4, '4 s']]]]],
  ['Portadas', [
    ['Ofrecer recortar al elegir una portada nueva', 'Si la imagen no es cuadrada, se abre el recorte (podés saltearlo).', 'cropOnPick', [[true, 'Sí'], [false, 'No']]],
    ['Dónde se guarda la portada', '', 'coverMode', [['file', 'Dentro del archivo de audio'], ['app', 'Solo en la app']]]]],
];
function openSettings() { renderSettings(); $('#settings').hidden = false; }
function closeSettings() { $('#settings').hidden = true; }
function treeHTML(r) {
  const key = r.key || '', c = subCache[key];
  if (!r.exists) return '<div class="tree"><div class="note">Esta carpeta no está en el disco ahora.</div></div>';
  if (!c || c.loading) return '<div class="tree"><div class="note">Leyendo subcarpetas…</div></div>';
  if (c.err) return `<div class="tree"><div class="note">No se pudieron leer las subcarpetas: ${esc(c.err)}</div></div>`;
  if (!c.data.length) return '<div class="tree"><div class="note">No tiene subcarpetas.</div></div>';
  const ex = r.excluded || [], isEx = rel => ex.some(x => rel === x || rel.startsWith(x + '/'));
  return '<div class="tree">' + c.data.map(s => {
    const own = ex.includes(s.rel), anc = !own && isEx(s.rel);
    return `<label class="trow${anc ? ' dis' : ''}" style="padding-left:${10 + s.depth * 18}px"><input type="checkbox" data-s="chk" data-rel="${esc(s.rel)}"${isEx(s.rel) ? '' : ' checked'}${anc ? ' disabled' : ''}><span class="tn">${esc(s.rel.split('/').pop())}</span><span class="tc" title="Audios en esta subcarpeta">${s.audio}</span></label>`;
  }).join('') + '</div>';
}
function renderSettings() {
  const m = $('#settings'), sc = m.querySelector('.mbody') ? m.querySelector('.mbody').scrollTop : 0;
  const trees = {}; m.querySelectorAll('.root').forEach(el => { const t = el.querySelector('.tree'); if (t) trees[el.dataset.key] = t.scrollTop; });
  const roots = S.roots || [];
  const rootHTML = roots.map((r, i) => {
    const key = r.key || '', open = openRoots.has(key), n = S.files.filter(f => (f.root || '') === key).length;
    return `<div class="root${open ? ' open' : ''}${r.exists === false ? ' bad' : ''}" data-key="${esc(key)}"><div class="root-h">
      <button class="ib car" data-s="toggle" title="Ver subcarpetas">${CHEV}</button><span class="root-p" title="${esc(r.path)}">${esc(r.path)}</span>
      ${i === 0 ? '<span class="bdg">Principal</span>' : ''}${r.exists === false ? '<span class="bdg red">No se encuentra</span>' : ''}
      <span class="root-n">${n} ${n === 1 ? 'tema' : 'temas'}</span>${i > 0 ? '<button class="btn" data-s="rmroot">Quitar</button>' : ''}</div>${open ? treeHTML(r) : ''}</div>`;
  }).join('') || '<div class="hint">Todavía no hay carpetas.</div>';
  const segHTML = SEG.map(([title, rows]) => `<section class="ssec"><h3>${esc(title)}</h3>${rows.map(([label, desc, key, opts]) =>
    `<div class="srow"><div class="sl">${esc(label)}${desc ? `<small>${esc(desc)}</small>` : ''}</div><div class="seg">${opts.map(([v, t]) => `<button data-set="${key}" data-v="${v}" class="${UI[key] === v ? 'on' : ''}">${esc(t)}</button>`).join('')}</div></div>`).join('')}</section>`).join('');
  m.innerHTML = `<div class="mbox sbox"><div class="mhead"><span class="grow">Configuración</span><button class="btn" data-s="close">Cerrar</button></div><div class="mbody">
    <section class="ssec"><h3>Carpetas</h3>
      <div class="hint">Tildada = la app la lee. Destildá las subcarpetas que no querés ver. Los números son los audios de cada una.</div>
      ${rootHTML}
      <div class="sbtns"><button class="btn" data-s="addroot">Agregar carpeta</button><button class="btn" data-s="pickmain">Cambiar carpeta principal</button></div></section>
    ${segHTML}</div></div>`;
  m.querySelector('.mbody').scrollTop = sc;
  m.querySelectorAll('.root').forEach(el => { const t = el.querySelector('.tree'); if (t && trees[el.dataset.key]) t.scrollTop = trees[el.dataset.key]; });
}
async function loadSubs(key) {
  subCache[key] = { loading: true }; renderSettings();
  try { subCache[key] = { data: await invoke('list_subfolders', { key }) }; }
  catch (e) { subCache[key] = { err: errText(e), data: [] }; }
  renderSettings();
}
const parseV = s => s === 'true' ? true : s === 'false' ? false : /^\d+(\.\d+)?$/.test(s) ? Number(s) : s;
$('#btn-settings').onclick = openSettings;
$('#settings').addEventListener('mousedown', e => { if (e.target.id === 'settings') closeSettings(); });
$('#settings').addEventListener('click', async e => {
  const set = e.target.closest('[data-set]');
  if (set) { setUI({ [set.dataset.set]: parseV(set.dataset.v) }); renderSettings(); return; }
  const b = e.target.closest('[data-s]'); if (!b || b.dataset.s === 'chk') return;
  const k = b.dataset.s, rootEl = b.closest('.root'), key = rootEl ? rootEl.dataset.key : null;
  if (k === 'close') closeSettings();
  else if (k === 'toggle') {
    if (openRoots.has(key)) openRoots.delete(key); else { openRoots.add(key); if (!subCache[key]) { loadSubs(key); return; } }
    renderSettings();
  }
  else if (k === 'addroot') { try { await flushSave(); const st = await invoke('add_root'); if (st) applyState(st); } catch (err) { toast('Error: ' + errText(err)); } }
  else if (k === 'pickmain') pickMainFolder();
  else if (k === 'rmroot') confirmBtn(b, async () => {
    try { await flushSave(); const st = await invoke('remove_root', { key }); openRoots.delete(key); delete subCache[key]; applyState(st); } catch (err) { toast('Error: ' + errText(err)); }
  }, '¿Seguro?');
});
$('#settings').addEventListener('change', e => {
  const c = e.target.closest('[data-s="chk"]'); if (!c) return;
  const rootEl = c.closest('.root'), key = rootEl.dataset.key, r = S.roots.find(x => (x.key || '') === key); if (!r) return;
  const ex = new Set(r.excluded || []), rel = c.dataset.rel;
  if (c.checked) ex.delete(rel); else ex.add(rel);
  r.excluded = [...ex]; renderSettings();
  const list = r.excluded.slice();
  exclChain = exclChain.then(() => invoke('set_excluded', { key, excluded: list })).then(st => { if (st) applyState(st); }).catch(err => toast('Error: ' + errText(err)));
});

// ---------- gestor de categorías ----------
let modalConfirm = null;
function openModal() { renderModal(); $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; libChanged(); }
function renderModal() {
  const m = $('#modal'), sc = m.querySelector('.mbody') ? m.querySelector('.mbody').scrollTop : 0;
  m.innerHTML = `<div class="mbox"><div class="mhead"><span class="grow">Categorías</span><button class="btn" data-m="close">Cerrar</button></div><div class="mbody">
  ${lib.categories.map(c => `<div class="mcat" data-cid="${esc(c.id)}">
    <div class="mcat-h"><input type="text" data-m="name" value="${esc(c.name)}"><input type="color" data-m="color" value="${/^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#8f897c'}" title="Color">
      <label><input type="checkbox" data-m="multi" ${c.multi ? 'checked' : ''}>Varios valores</label>
      <button class="btn" data-m="delcat">Borrar categoría</button></div>
    <div class="mvals">${c.values.map(v => `<span class="mval"><span class="mval-t" data-m="renval" data-val="${esc(v)}" title="Doble clic para renombrar">${esc(v)}</span><button data-m="delval" data-val="${esc(v)}" title="Borrar valor">×</button></span>`).join('') || '<span style="color:var(--dim2)">Sin valores</span>'}</div>
    <div class="madd"><input type="text" data-m="addval" placeholder="Nuevo valor (Enter)"></div></div>`).join('')}
  <div class="mnew"><input type="text" id="newcat" placeholder="Nombre de categoría nueva"><button class="btn gold" data-m="newcat">Crear</button></div>
  </div></div>`;
  m.querySelector('.mbody').scrollTop = sc;
}
$('#btn-cats').onclick = openModal;
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
$('#modal').addEventListener('click', e => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  const k = b.dataset.m, box = b.closest('.mcat'), cat = box && catById(box.dataset.cid);
  if (k === 'close') closeModal();
  else if (k === 'newcat') createCat();
  else if (k === 'delval') confirmBtn(b, () => {
    cat.values = cat.values.filter(v => v !== b.dataset.val); stripTag(cat.id, b.dataset.val);
    if (filters.cats[cat.id]) filters.cats[cat.id].delete(b.dataset.val);
    scheduleSave(); renderModal();
  }, '¿Borrar?');
  else if (k === 'delcat') confirmBtn(b, () => {
    lib.categories = lib.categories.filter(c => c.id !== cat.id); stripTag(cat.id); delete filters.cats[cat.id];
    scheduleSave(); renderModal();
  }, 'Confirmar: se borran sus etiquetas');
});
// Renombrar un valor: doble clic sobre su nombre. Si el nombre nuevo ya existe, se fusionan.
$('#modal').addEventListener('dblclick', e => {
  const t = e.target.closest('[data-m="renval"]'); if (!t) return;
  const box = t.closest('.mcat'), cat = catById(box.dataset.cid), old = t.dataset.val;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = old; inp.className = 'mval-in';
  t.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = ok => {
    if (done) return; done = true;
    const nv = inp.value.trim();
    if (ok && nv && nv !== old) renameValue(cat, old, nv);
    renderModal();
  };
  inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') commit(true); else if (ev.key === 'Escape') commit(false); });
  inp.addEventListener('blur', () => commit(true));
});
function renameValue(cat, old, nv) {
  const existing = cat.values.find(v => v.toLowerCase() === nv.toLowerCase() && v !== old);
  const target = existing || nv;
  cat.values = existing ? cat.values.filter(v => v !== old) : cat.values.map(v => v === old ? nv : v);
  const fix = tags => {
    if (!tags || !tags[cat.id]) return;
    const arr = tags[cat.id].map(v => v === old ? target : v);
    tags[cat.id] = arr.filter((v, i) => arr.indexOf(v) === i);
  };
  for (const id in lib.tracks) { fix(lib.tracks[id].tags); (lib.tracks[id].moments || []).forEach(m => fix(m.tags)); }
  const fs = filters.cats[cat.id];
  if (fs && fs.has(old)) { fs.delete(old); fs.add(target); }
  if (quick.val === old && quick.cat === cat.id) quick.val = target;
  scheduleSave();
  toast(existing ? `"${old}" se fusionó con "${target}"` : `Renombrado a "${target}"`);
}
$('#modal').addEventListener('change', e => {
  const k = e.target.dataset.m, box = e.target.closest('.mcat'), cat = box && catById(box.dataset.cid); if (!cat) return;
  if (k === 'name') cat.name = e.target.value.trim() || cat.name;
  else if (k === 'color') cat.color = e.target.value;
  else if (k === 'multi') cat.multi = e.target.checked;
  scheduleSave();
});
$('#modal').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'newcat') createCat();
  else if (e.target.dataset.m === 'addval') {
    const box = e.target.closest('.mcat'), cat = catById(box.dataset.cid), v = e.target.value.trim();
    if (v && !cat.values.some(x => x.toLowerCase() === v.toLowerCase())) { cat.values.push(v); scheduleSave(); renderModal(); const i = $(`.mcat[data-cid="${cat.id}"] [data-m="addval"]`); if (i) i.focus(); }
  }
});
function createCat() {
  const inp = $('#newcat'), name = inp.value.trim(); if (!name) return;
  let id = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '') || 'cat';
  if (catById(id)) id += uid().slice(-3);
  const pal = ['#b8a98a', '#7f9bb0', '#b08590', '#8aa586', '#b3906f', '#9a8fb3', '#8fa8a3'];
  lib.categories.push({ id, name, color: pal[lib.categories.length % pal.length], multi: true, values: [] });
  scheduleSave(); renderModal();
}
function stripTag(catId, val) {
  const strip = tags => { if (!tags || !tags[catId]) return; if (val == null) delete tags[catId]; else { tags[catId] = tags[catId].filter(v => v !== val); if (!tags[catId].length) delete tags[catId]; } };
  for (const id in lib.tracks) { strip(lib.tracks[id].tags); lib.tracks[id].moments.forEach(m => strip(m.tags)); }
}

// ======================================================================
// ---------- paneles, vista en cuadrícula, altura de la onda ----------
// ======================================================================
const PANEL_LIST = [['filters', 'Filtros y etiquetas'], ['list', 'Lista de temas'], ['detail', 'Tema seleccionado'], ['player', 'Onda y reproductor']];
const PANEL_SVG = {
  filters: '<rect x="2" y="2" width="5" height="12" fill="currentColor"/>',
  list: '<rect x="6" y="2" width="6" height="12" fill="currentColor"/>',
  detail: '<rect x="11" y="2" width="5" height="12" fill="currentColor"/>',
  player: '<rect x="2" y="10" width="14" height="4" fill="currentColor"/>',
};
function panelsState() { return Object.assign({ filters: true, list: true, detail: true, player: true }, UI.panels || {}); }
function renderPanelBtns() {
  const P = panelsState();
  const html = PANEL_LIST.map(([k, t], i) => `<button class="ib pb${P[k] ? ' on' : ''}" data-panel="${k}" title="${t} (Ctrl+Alt+${i + 1})"><svg viewBox="0 0 18 16" width="18" height="16"><rect x="1.5" y="1.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/>${PANEL_SVG[k]}</svg></button>`).join('')
    + `<button class="ib pb${UI.cuesOpen ? ' on' : ''}" data-panel="cues" title="Modo guion (G)"><svg viewBox="0 0 18 16" width="18" height="16"><path d="M4 4h10M4 8h10M4 12h6" stroke="currentColor" stroke-width="1.6" fill="none"/></svg></button>`;
  document.querySelectorAll('.pnl').forEach(el => { el.innerHTML = html; });
}
function togglePanel(name) {
  if (name === 'cues') { toggleCues(); return; }
  const P = panelsState(), on = !P[name];
  if (!on && name !== 'player') {
    const others = ['filters', 'list', 'detail'].filter(n => n !== name && P[n]);
    if (!others.length) { toast('Tiene que quedar a la vista al menos uno de los tres paneles de arriba'); return; }
  }
  setUI({ panels: Object.assign({}, P, { [name]: on }) });
}
const waveHClamp = h => Math.max(150, Math.min(Math.max(150, Math.floor(window.innerHeight * 0.7)), Math.round(h || 182)));
function setGridRows(h) { $('#app').style.gridTemplateRows = panelsState().player ? 'minmax(0,1fr) ' + h + 'px' : 'minmax(0,1fr) auto'; }
function applyLayoutUI(prev) {
  prev = prev || {};
  const P = panelsState(), co = !!UI.cuesOpen;
  $('#filters').hidden = !P.filters; $('#center').hidden = !P.list; $('#detail').hidden = !P.detail; $('#cues').hidden = !co;
  $('#player').hidden = !P.player; $('#pmini').hidden = P.player;
  const flex = P.list ? 'list' : P.detail ? 'detail' : co ? 'cues' : 'filters';
  const cols = [];
  if (P.filters) cols.push(flex === 'filters' ? 'minmax(0,1fr)' : '240px');
  if (P.list) cols.push('minmax(0,1fr)');
  if (co) cols.push(flex === 'cues' ? 'minmax(0,1fr)' : '320px');
  if (P.detail) cols.push(flex === 'detail' ? 'minmax(0,1fr)' : '330px');
  $('#app').style.gridTemplateColumns = cols.join(' ');
  setGridRows(waveHClamp(UI.waveH));
  document.querySelectorAll('[data-wh]').forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.wh - waveHClamp(UI.waveH)) < 30 && ((+b.dataset.wh <= 150 && waveHClamp(UI.waveH) < 165) || (+b.dataset.wh === 182 && waveHClamp(UI.waveH) >= 165 && waveHClamp(UI.waveH) < 250) || (+b.dataset.wh >= 300 && waveHClamp(UI.waveH) >= 250))));
  $('#btn-view').textContent = UI.view === 'grid' ? 'Lista' : 'Cuadrícula';
  $('#btn-view').classList.toggle('on', UI.view === 'grid');
  $('#btn-cueopen').classList.toggle('on', co);
  document.body.dataset.view = UI.view === 'grid' ? 'grid' : 'list';
  renderPanelBtns();
  if (lib) {
    if (prev.view !== UI.view || prev.hideAuthor !== UI.hideAuthor || prev.panels !== UI.panels) { layoutList(); renderList(true); }
    if (prev.hideAuthor !== UI.hideAuthor) { renderDetail(); renderPlayerInfo(); }
    if (prev.hideAuthor !== UI.hideAuthor || prev.cueTransition !== UI.cueTransition || prev.cueFade !== UI.cueFade || prev.cuesOpen !== UI.cuesOpen) renderCues();
  }
}
new ResizeObserver(() => { if (lib && UI.view === 'grid' && !$('#center').hidden) { layoutList(); renderList(true); } }).observe(listEl);
$('#btn-view').onclick = () => setUI({ view: UI.view === 'grid' ? 'list' : 'grid' });
$('#btn-cueopen').onclick = () => toggleCues();
$('#b-play2').onclick = togglePlay;
$('#b-showplayer').onclick = () => togglePanel('player');
document.addEventListener('click', e => {
  const pb = e.target.closest && e.target.closest('[data-panel]'); if (pb) { togglePanel(pb.dataset.panel); return; }
  const wh = e.target.closest && e.target.closest('[data-wh]'); if (wh) setUI({ waveH: +wh.dataset.wh });
});
// arrastrar el borde superior del reproductor para cambiar la altura
{
  let rs = null;
  $('#p-resize').addEventListener('mousedown', e => { if (e.button !== 0) return; e.preventDefault(); rs = { y: e.clientY, h: $('#player').getBoundingClientRect().height }; document.body.classList.add('resizing'); });
  window.addEventListener('mousemove', e => { if (!rs) return; const h = waveHClamp(rs.h + (rs.y - e.clientY)); rs.cur = h; setGridRows(h); });
  window.addEventListener('mouseup', () => { if (!rs) return; const h = rs.cur; rs = null; document.body.classList.remove('resizing'); if (h) setUI({ waveH: h }); });
}

// ======================================================================
// ---------- recortar portada ----------
// ======================================================================
function loadImg(url) {
  return new Promise((res, rej) => {
    const viaBlob = async () => {
      try {
        const r = await fetch(url), b = await r.blob(), u = URL.createObjectURL(b), i2 = new Image();
        i2.onload = () => res(i2); i2.onerror = () => rej(new Error('No se pudo leer la imagen')); i2.src = u;
      } catch (e) { rej(e); }
    };
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => {
      try { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(im, 0, 0, 1, 1); g.getImageData(0, 0, 1, 1); res(im); }
      catch (e) { viaBlob(); }
    };
    im.onerror = () => viaBlob();
    im.src = url;
  });
}
let cropS = null;
const cropEl = $('#crop');
function detectBars(img) {
  const sc = Math.min(1, 600 / img.naturalWidth), w = Math.max(2, Math.round(img.naturalWidth * sc)), h = Math.max(2, Math.round(img.naturalHeight * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  const dat = g.getImageData(0, 0, w, h).data, tol = 30;
  const colOK = (x, ref) => { let bad = 0; for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; if (Math.abs(dat[i] - ref[0]) + Math.abs(dat[i + 1] - ref[1]) + Math.abs(dat[i + 2] - ref[2]) > tol) bad++; } return bad <= h * 0.015; };
  const px = x => { const i = ((h >> 1) * w + x) * 4; return [dat[i], dat[i + 1], dat[i + 2]]; };
  let l = 0, r = 0;
  const rl = px(0); if (colOK(0, rl)) { l = 1; while (l < w && colOK(l, rl)) l++; }
  const rr0 = px(w - 1); if (colOK(w - 1, rr0)) { r = 1; while (r < w && colOK(w - 1 - r, rr0)) r++; }
  if (l + r < w * 0.04 || l + r > w * 0.9) return null;
  const ins = l ? 1.5 : 0, ins2 = r ? 1.5 : 0;
  const cx0 = (l + ins) / sc, cx1 = (w - r - ins2) / sc, W = img.naturalWidth, H = img.naturalHeight, cw = cx1 - cx0;
  let s, x, y;
  if (cw >= H) { s = H; y = 0; x = (cx0 + cx1) / 2 - s / 2; } else { s = cw; x = cx0; y = (H - s) / 2; }
  x = Math.max(0, Math.min(W - s, x));
  return { x, y, s };
}
function openCrop(o) {
  const img = o.img, W = img.naturalWidth, H = img.naturalHeight;
  const k = Math.min(620 / W, 400 / H), dw = Math.round(W * k), dh = Math.round(H * k);
  const s0 = Math.min(W, H);
  cropS = { img, W, H, k, box: { x: (W - s0) / 2, y: (H - s0) / 2, s: s0 }, o };
  cropEl.innerHTML = `<div class="cbox"><div class="mhead"><span class="grow">${esc(o.title || 'Recortar portada')}</span></div>
    <div class="crbody"><div class="cstage" style="width:${dw}px;height:${dh}px"><img src="${esc(img.src)}" draggable="false" alt="" style="width:${dw}px;height:${dh}px"><div class="cbx"><i class="chd" data-h="nw"></i><i class="chd" data-h="ne"></i><i class="chd" data-h="sw"></i><i class="chd" data-h="se"></i></div></div>
    <div class="cinfo" id="cinfo"></div>
    <div class="cbtns2"><button class="btn" data-k="center">Centrar</button><button class="btn" data-k="bars" title="Detecta franjas de color liso a los costados y ajusta el cuadrado al contenido">Quitar franjas</button><span class="grow"></span>
    <button class="btn" data-k="cancel">Cancelar</button>${o.onSkip ? '<button class="btn" data-k="skip">Usar sin recortar</button>' : ''}<button class="btn gold" data-k="ok">${o.onSkip ? 'Recortar y usar' : 'Aplicar recorte'}</button></div></div></div>`;
  cropEl.hidden = false; cropPaint();
}
function cropPaint() {
  const s = cropS; if (!s) return;
  const b = $('.cbx', cropEl); if (!b) return;
  b.style.left = s.box.x * s.k + 'px'; b.style.top = s.box.y * s.k + 'px'; b.style.width = s.box.s * s.k + 'px'; b.style.height = s.box.s * s.k + 'px';
  $('#cinfo').textContent = 'Recorte cuadrado: ' + Math.round(s.box.s) + ' × ' + Math.round(s.box.s) + ' px (imagen de ' + s.W + ' × ' + s.H + ')';
}
function closeCrop() { cropEl.hidden = true; cropEl.innerHTML = ''; cropS = null; }
async function cropExport() {
  const s = cropS, bx = Math.round(s.box.x), by = Math.round(s.box.y), bs = Math.max(1, Math.round(Math.min(s.box.s, s.W - bx, s.H - by)));
  const out = Math.min(1200, bs), c = document.createElement('canvas'); c.width = c.height = out;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, out, out); g.imageSmoothingQuality = 'high';
  g.drawImage(s.img, bx, by, bs, bs, 0, 0, out, out);
  const blob = await new Promise((res, rej) => { try { c.toBlob(b => b ? res(b) : rej(new Error('vacío')), 'image/jpeg', 0.92); } catch (e) { rej(e); } });
  return { data: await readB64(blob), ext: 'jpg' };
}
async function cropApply() {
  const s = cropS; if (!s) return;
  try { const res = await cropExport(); const o = s.o; closeCrop(); o.onApply(res); }
  catch (e) { toast('No se pudo recortar esta imagen: ' + errText(e), 3500); }
}
{
  let cd = null;
  cropEl.addEventListener('mousedown', e => {
    const s = cropS; if (!s) return;
    if (e.target === cropEl) { return; }
    const hd = e.target.closest('.chd'), bx = e.target.closest('.cbx');
    if (!bx) return;
    e.preventDefault();
    const b = s.box;
    if (hd) {
      const h = hd.dataset.h, east = h[1] === 'e', south = h[0] === 's';
      cd = { mode: 'rs', east, south, ox: east ? b.x : b.x + b.s, oy: south ? b.y : b.y + b.s };
    } else cd = { mode: 'mv', mx: e.clientX, my: e.clientY, x0: b.x, y0: b.y };
  });
  window.addEventListener('mousemove', e => {
    const s = cropS; if (!s || !cd) return;
    const r = $('.cstage', cropEl).getBoundingClientRect();
    if (cd.mode === 'mv') {
      s.box.x = Math.max(0, Math.min(s.W - s.box.s, cd.x0 + (e.clientX - cd.mx) / s.k));
      s.box.y = Math.max(0, Math.min(s.H - s.box.s, cd.y0 + (e.clientY - cd.my) / s.k));
    } else {
      const px = (e.clientX - r.left) / s.k, py = (e.clientY - r.top) / s.k;
      const dx = cd.east ? px - cd.ox : cd.ox - px, dy = cd.south ? py - cd.oy : cd.oy - py;
      const roomX = cd.east ? s.W - cd.ox : cd.ox, roomY = cd.south ? s.H - cd.oy : cd.oy;
      const sz = Math.max(24 / s.k, Math.min(dx, dy, roomX, roomY));
      s.box.s = sz; s.box.x = cd.east ? cd.ox : cd.ox - sz; s.box.y = cd.south ? cd.oy : cd.oy - sz;
    }
    cropPaint();
  });
  window.addEventListener('mouseup', () => { cd = null; });
}
cropEl.addEventListener('click', e => {
  const b = e.target.closest('[data-k]'); if (!b || !cropS) return;
  const k = b.dataset.k, s = cropS;
  if (k === 'cancel') closeCrop();
  else if (k === 'ok') cropApply();
  else if (k === 'skip') { const o = s.o; closeCrop(); o.onSkip(); }
  else if (k === 'center') { const m = Math.min(s.W, s.H); s.box = { x: (s.W - m) / 2, y: (s.H - m) / 2, s: m }; cropPaint(); }
  else if (k === 'bars') {
    let r = null; try { r = detectBars(s.img); } catch (err) { toast('No se pudo analizar la imagen'); return; }
    if (!r) { toast('No encontré franjas de color liso a los costados'); return; }
    s.box = r; cropPaint(); toast('Listo: ajustado al contenido');
  }
});
function cropKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeCrop(); }
  else if (e.key === 'Enter') { e.preventDefault(); cropApply(); }
}
async function cropCurrentCover() {
  const f = curFile(); if (!f) return;
  const cu = coverURL(f); if (!cu) { toast('Este tema no tiene portada'); return; }
  let img; try { img = await loadImg(cu); } catch (e) { toast('No se pudo abrir la portada para recortarla'); return; }
  const id = f.id;
  openCrop({ img, title: 'Recortar portada', onApply: res => setCoverFor([id], res) });
}
async function coverWithCrop(ids, src) {
  if (!UI.cropOnPick) { setCoverFor(ids, src); return; }
  const url = src.path ? convertFileSrc(src.path) : 'data:image/' + (src.ext === 'jpg' ? 'jpeg' : src.ext) + ';base64,' + src.data;
  let img; try { img = await loadImg(url); } catch (e) { setCoverFor(ids, src); return; }
  const ratio = img.naturalWidth / img.naturalHeight;
  if (Math.abs(ratio - 1) < 0.02) { setCoverFor(ids, src); return; }
  openCrop({ img, title: 'Recortar la portada nueva', onApply: res => setCoverFor(ids, res), onSkip: () => setCoverFor(ids, src) });
}

// ======================================================================
// ---------- modo guion ----------
// ======================================================================
const cuesEl = $('#cues');
let cueEdit = null, stopFade = null, fadeInMul = 1, stopMul = 1;
const curSet = () => (lib && lib.cues) ? (lib.cues.sets.find(x => x.id === lib.cues.active) || null) : null;
function ensureSet() {
  let st = curSet();
  if (!st) { st = { id: uid(), name: 'Guion ' + (lib.cues.sets.length + 1), items: [] }; lib.cues.sets.push(st); lib.cues.active = st.id; }
  return st;
}
function nextFreeN(st) { for (let n = 1; n <= 20; n++) if (!st.items.some(i => i.n === n)) return n; return 0; }
function recalcFade() { fadeMul = fadeInMul * stopMul; }
function addCue(track, start, end, label) {
  if (!lib || !track) { toast('Elegí un tema primero'); return null; }
  const st = ensureSet(), n = nextFreeN(st);
  if (!n) { toast('El guion ya tiene 20 cues, que es el máximo'); return null; }
  const it = { id: uid(), n, track, start: round1(start), end: end == null ? null : round1(end), label: label || '' };
  st.items.push(it); scheduleSave(); renderCues();
  toast('Cue ' + n + ' agregado' + (st.name ? ' a "' + st.name + '"' : ''));
  return it;
}
function addCueHere() {
  if (!curId) { toast('Elegí un tema primero'); return; }
  if (rangeSel && Math.abs(rangeSel.a - rangeSel.b) > 0.3) {
    const a = Math.min(rangeSel.a, rangeSel.b), b = Math.max(rangeSel.a, rangeSel.b);
    if (addCue(curId, a, b, '')) { rangeSel = null; updateRange(); drawWave(); }
  } else addCue(curId, audio.currentTime || 0, null, '');
}
$('#b-cue-range').onclick = addCueHere;
function remapCues(oldId, newId, oldCues) {
  if (oldCues && oldCues.sets && oldCues.sets.length && (!lib.cues.sets.length)) lib.cues = oldCues;
  lib.cues.sets.forEach(st => st.items.forEach(it => { if (it.track === oldId) it.track = newId; }));
  if (cuePlay && cuePlay.track === oldId) cuePlay.track = newId;
  scheduleSave(); renderCues();
}
function toggleCues() { setUI({ cuesOpen: !UI.cuesOpen }); }
const trackLabel = id => { const f = byId.get(id); return f ? dn(f) : '(tema no encontrado)'; };
const rangeTxt = it => it.end != null ? fmt(it.start, true) + ' – ' + fmt(it.end, true) : 'desde ' + fmt(it.start, true);
function renderCues() {
  if (!lib || cuesEl.hidden) return;
  const sc = cuesEl.querySelector('.clist') ? cuesEl.querySelector('.clist').scrollTop : 0;
  const sets = lib.cues.sets, st = curSet(), fade = UI.cueTransition === 'fade';
  const items = st ? st.items.slice().sort((a, b) => a.n - b.n) : [];
  const rangeOK = !!(rangeSel && Math.abs(rangeSel.a - rangeSel.b) > 0.3);
  cuesEl.innerHTML = `<div class="ch"><b>Modo guion</b><span class="grow"></span><button class="ib" data-c="close" title="Cerrar (G)">×</button></div>
    <div class="cset"><label>Guion <select data-c="set">${sets.length ? sets.map(x => `<option value="${esc(x.id)}"${st && x.id === st.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('') : '<option value="">(ninguno todavía)</option>'}</select></label></div>
    <div class="cbtns"><button class="btn" data-c="new">Nuevo</button><button class="btn" data-c="ren"${st ? '' : ' disabled'}>Renombrar</button><button class="btn" data-c="dup"${st ? '' : ' disabled'}>Duplicar</button><button class="btn" data-c="delset"${st ? '' : ' disabled'}>Borrar</button></div>
    <div class="ctrans"><span>Transición</span><div class="seg"><button data-c="tr" data-v="cut" class="${fade ? '' : 'on'}">Corte seco</button><button data-c="tr" data-v="fade" class="${fade ? 'on' : ''}">Fundido cruzado</button></div>
      ${fade ? `<input type="range" min="0.5" max="4" step="0.5" value="${UI.cueFade}" data-c="fd" title="Duración del fundido"><span class="fdn">${String(UI.cueFade).replace('.', ',')} s</span>` : ''}</div>
    <div class="cadd"><button class="btn gold" data-c="addhere">Agregar cue aquí <kbd>C</kbd></button>${rangeOK ? '<button class="btn" data-c="addrange">Con el rango marcado</button>' : ''}</div>
    <div class="clist">${items.length ? items.map(it => {
      const run = cuePlay && cuePlay.id === it.id, miss = !byId.has(it.track), ed = cueEdit === it.id;
      return `<div class="cue${run ? ' run' : ''}${miss ? ' miss' : ''}" data-iid="${esc(it.id)}">
        <div class="cmain"><span class="cgrip" data-c="grip" title="Arrastrá para reordenar">${GRIP}</span>
        <input class="cnum" type="text" inputmode="numeric" value="${it.n}" data-c="num" title="Número de disparo (1 a 20)">
        <div class="cbody"><div class="ctrk" title="${esc(trackLabel(it.track))}">${esc(trackLabel(it.track))}</div><div class="csub"><span class="crng">${esc(rangeTxt(it))}</span>
        <input class="clab" type="text" placeholder="Etiqueta (opcional)" value="${esc(it.label)}" data-c="lab" autocomplete="off" spellcheck="false"></div></div>
        <div class="cact"><button class="ib cplay" data-c="play" title="Disparar (Ctrl + ${it.n > 10 ? 'Shift + ' : ''}${it.n % 10})">${ICON_PLAY}</button><button class="ib txt" data-c="edit">${ed ? 'Listo' : 'Editar'}</button><button class="ib" data-c="delcue" title="Quitar del guion">×</button></div></div>
        ${ed ? `<div class="cedit"><label>Inicio <input class="tin" data-c="s" value="${fmt(it.start, true)}"></label><button class="btn" data-c="hs" title="Usar la posición actual del reproductor">Posición actual</button>
          <label>Fin <input class="tin" data-c="e" value="${it.end != null ? fmt(it.end, true) : ''}" placeholder="sin fin"></label><button class="btn" data-c="he" title="Usar la posición actual del reproductor">Posición actual</button><button class="btn" data-c="goto">Ver el tema</button></div>` : ''}
        <div class="cprog"><i></i></div></div>`;
    }).join('') : `<div class="cempty">${st ? 'Este guion todavía no tiene cues. Con un tema sonando, apretá C (o el botón de arriba) para guardar la posición actual como cue.' : 'Creá un guion con "Nuevo" para empezar.'}</div>`}</div>
    <div class="chint">Disparar: Ctrl + 1…9, Ctrl + 0 (es el 10). Del 11 al 20: Ctrl + Shift + 1…0. Ctrl + Espacio pausa todo.</div>`;
  const nl = cuesEl.querySelector('.clist'); if (nl) nl.scrollTop = sc;
  updateCueProgress();
}
function renderCuesLight() {
  if (cuesEl.hidden) return;
  cuesEl.querySelectorAll('.cue').forEach(r => r.classList.toggle('run', !!cuePlay && r.dataset.iid === cuePlay.id));
  updateCueProgress();
}
function updateCueProgress() {
  if (cuesEl.hidden) return;
  const bar = cuesEl.querySelector('.cue.run .cprog i'); if (!bar || !cuePlay) return;
  const cur = audio.currentTime || 0, end = cuePlay.end != null ? cuePlay.end : curDur() || cuePlay.start + 1;
  bar.style.width = Math.max(0, Math.min(100, (cur - cuePlay.start) / Math.max(0.1, end - cuePlay.start) * 100)) + '%';
}
function askText(title, def, okLabel) {
  return new Promise(res => {
    const box = $('#ask');
    box.innerHTML = `<div class="abox"><h3>${esc(title)}</h3><input type="text" value="${esc(def)}" autocomplete="off"><div class="abtn"><button class="btn" data-a="no">Cancelar</button><button class="btn gold" data-a="ok">${esc(okLabel || 'Aceptar')}</button></div></div>`;
    box.hidden = false;
    const inp = box.querySelector('input'); inp.focus(); inp.select();
    const done = v => { box.hidden = true; box.innerHTML = ''; res(v); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(inp.value.trim()); else if (e.key === 'Escape') done(null); });
    box.onclick = e => { const b = e.target.closest('[data-a]'); if (b) done(b.dataset.a === 'ok' ? inp.value.trim() : null); else if (e.target === box) done(null); };
  });
}
cuesEl.addEventListener('click', async e => {
  const b = e.target.closest('[data-c]'); if (!b || b.disabled) return;
  const c = b.dataset.c, row = b.closest('.cue'), st = curSet(), it = row && st && st.items.find(x => x.id === row.dataset.iid);
  if (c === 'close') toggleCues();
  else if (c === 'new') { const nm = await askText('Nombre del guion', 'Guion ' + (lib.cues.sets.length + 1), 'Crear'); if (nm == null) return; const s = { id: uid(), name: nm || 'Guion ' + (lib.cues.sets.length + 1), items: [] }; lib.cues.sets.push(s); lib.cues.active = s.id; scheduleSave(); renderCues(); }
  else if (c === 'ren' && st) { const nm = await askText('Nuevo nombre del guion', st.name, 'Guardar'); if (nm) { st.name = nm; scheduleSave(); renderCues(); } }
  else if (c === 'dup' && st) { const s = { id: uid(), name: st.name + ' (copia)', items: st.items.map(x => Object.assign({}, x, { id: uid() })) }; lib.cues.sets.push(s); lib.cues.active = s.id; scheduleSave(); renderCues(); toast('Guion duplicado'); }
  else if (c === 'delset' && st) confirmBtn(b, () => { lib.cues.sets = lib.cues.sets.filter(x => x.id !== st.id); lib.cues.active = lib.cues.sets.length ? lib.cues.sets[0].id : null; if (cuePlay && cuePlay.setId === st.id) cuePlay = null; scheduleSave(); renderCues(); renderPlayerInfo(); }, '¿Seguro?');
  else if (c === 'tr') setUI({ cueTransition: b.dataset.v });
  else if (c === 'addhere') addCueHere();
  else if (c === 'addrange') addCueHere();
  else if (c === 'play' && it) fireCue(it);
  else if (c === 'edit' && it) { cueEdit = cueEdit === it.id ? null : it.id; renderCues(); }
  else if (c === 'delcue' && it) { st.items = st.items.filter(x => x !== it); if (cueEdit === it.id) cueEdit = null; scheduleSave(); renderCues(); }
  else if ((c === 'hs' || c === 'he') && it) {
    if (it.track !== curId) { toast('Para tomar la posición, primero cargá ese tema (botón "Ver el tema")'); return; }
    const t = round1(audio.currentTime || 0);
    if (c === 'hs') { it.start = t; if (it.end != null && it.end <= t) it.end = null; } else if (t > it.start + 0.2) it.end = t; else { toast('El fin tiene que ir después del inicio'); return; }
    scheduleSave(); renderCues();
  }
  else if (c === 'goto' && it) { if (byId.has(it.track)) selectTrack(it.track, { play: false, start: it.start }); else toast('El tema ya no está'); }
});
cuesEl.addEventListener('change', e => {
  const el = e.target, c = el.dataset && el.dataset.c, st = curSet(); if (!c) return;
  if (c === 'set') { lib.cues.active = el.value || null; scheduleSave(); renderCues(); return; }
  if (c === 'fd') { setUI({ cueFade: +el.value }); return; }
  const row = el.closest('.cue'), it = row && st && st.items.find(x => x.id === row.dataset.iid); if (!it) return;
  if (c === 'lab') { it.label = el.value.trim(); scheduleSave(); }
  else if (c === 'num') {
    const n = parseInt(el.value, 10);
    if (!(n >= 1 && n <= 20)) { toast('El número va de 1 a 20'); renderCues(); return; }
    const other = st.items.find(x => x !== it && x.n === n);
    if (other) { other.n = it.n; toast('El cue ' + n + ' pasó al número ' + other.n); }
    it.n = n; scheduleSave(); renderCues();
  }
  else if (c === 's' || c === 'e') {
    const v = parseT(el.value);
    if (c === 'e' && (v == null || el.value.trim() === '')) it.end = null;
    else if (v == null || isNaN(v)) toast('Tiempo inválido');
    else if (c === 's') { it.start = round1(v); if (it.end != null && it.end <= it.start) it.end = null; }
    else if (v > it.start + 0.2) it.end = round1(v); else toast('El fin tiene que ir después del inicio');
    scheduleSave(); renderCues();
  }
});
cuesEl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input[type=text],.tin')) e.target.blur(); });
// reordenar arrastrando el asa: los números existentes se reparten en el nuevo orden
{
  let dg = null;
  cuesEl.addEventListener('mousedown', e => {
    const gp = e.target.closest('[data-c="grip"]'); if (!gp || e.button !== 0) return;
    e.preventDefault();
    const row = gp.closest('.cue'); dg = { id: row.dataset.iid, row, to: null };
    row.classList.add('dragging');
  });
  window.addEventListener('mousemove', e => {
    if (!dg) return;
    const rows = [...cuesEl.querySelectorAll('.cue')]; let to = rows.length;
    for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { to = i; break; } }
    dg.to = to;
    rows.forEach((r, i) => { r.classList.toggle('dropbefore', i === to); r.classList.toggle('dropafter', to === rows.length && i === rows.length - 1); });
  });
  window.addEventListener('mouseup', () => {
    if (!dg) return;
    const d = dg; dg = null; d.row.classList.remove('dragging');
    cuesEl.querySelectorAll('.dropbefore,.dropafter').forEach(r => r.classList.remove('dropbefore', 'dropafter'));
    const st = curSet(); if (!st || d.to == null) return;
    const arr = st.items.slice().sort((a, b) => a.n - b.n), ns = arr.map(i => i.n), from = arr.findIndex(i => i.id === d.id);
    if (from < 0) return;
    const [mv] = arr.splice(from, 1); arr.splice(d.to > from ? d.to - 1 : d.to, 0, mv);
    arr.forEach((it, i) => { it.n = ns[i]; });
    scheduleSave(); renderCues();
  });
}

// ---- disparar ----
function fireCueNumber(n) {
  const st = curSet(), it = st && st.items.find(i => i.n === n);
  if (!it) { toast(st ? 'No hay un cue ' + n + ' en "' + st.name + '"' : 'Todavía no hay un guion armado'); return; }
  fireCue(it);
}
function cueBaseGain() { return gainFromPos(UI.vol, UI.volMax); }
function spawnOld() {
  const src = audio.currentSrc || audio.src; if (!src) return null;
  const tmp = new Audio(); if (audio.getAttribute('crossorigin') !== null) tmp.crossOrigin = 'anonymous';
  tmp.preload = 'auto'; tmp.src = src;
  const t0 = audio.currentTime || 0;
  const o = { tmp, gainNode: null, dur: Math.max(0.5, Math.min(4, +UI.cueFade || 1.5)), p: 0, last: performance.now(), running: true, raf: 0 };
  if (agraph && actx) {
    try { const ms = actx.createMediaElementSource(tmp), gn = actx.createGain(); ms.connect(gn); gn.connect(agraph.comp); gn.gain.value = cueBaseGain(); o.gainNode = gn; o.ms = ms; } catch (e) { o.gainNode = null; }
  }
  if (!o.gainNode) tmp.volume = Math.min(1, cueBaseGain());
  const go = () => { try { tmp.currentTime = t0; } catch (e) { } tmp.play().catch(() => { }); };
  if (tmp.readyState >= 1) go(); else tmp.addEventListener('loadedmetadata', go, { once: true });
  return o;
}
function finishFade() {
  const o = cueFadeObj; if (!o) return;
  if (o.raf) cancelAnimationFrame(o.raf);
  try { o.tmp.pause(); o.tmp.removeAttribute('src'); o.tmp.load(); } catch (e) { }
  try { if (o.gainNode) o.gainNode.disconnect(); if (o.ms) o.ms.disconnect(); } catch (e) { }
  cueFadeObj = null; fadeInMul = 1; recalcFade(); applyVolume(); updateTime();
}
function fadeTick(now) {
  const o = cueFadeObj; if (!o) return;
  o.raf = 0;
  if (o.running) o.p = Math.min(1, o.p + (now - o.last) / (o.dur * 1000));
  o.last = now;
  fadeInMul = Math.sin(o.p * Math.PI / 2); recalcFade(); applyVolume();
  const og = Math.cos(o.p * Math.PI / 2) * cueBaseGain();
  if (o.gainNode) o.gainNode.gain.value = og; else o.tmp.volume = Math.max(0, Math.min(1, og));
  if (o.p >= 1) { finishFade(); return; }
  if (o.running) o.raf = requestAnimationFrame(fadeTick);
}
function fireCue(it) {
  const f = byId.get(it.track); if (!f) { toast('El tema de este cue ya no está en la carpeta'); return; }
  const wasPlaying = !audio.paused && !!audio.getAttribute('src') && !!curId;
  if (cueFadeObj) finishFade();
  stopFade = null; stopMul = 1;
  let old = null;
  if (UI.cueTransition === 'fade' && wasPlaying) old = spawnOld();
  const st = it.start > 0 ? it.start : effectiveStart(f);   // saltar silencio solo si el cue arranca en 0
  const set = curSet();
  cueFiring = true;
  try {
    cuePlay = { setId: set ? set.id : null, id: it.id, n: it.n, track: it.track, start: st, end: it.end };
    fadeInMul = old ? 0 : 1; recalcFade(); applyVolume();
    momentPlay = null; loopOn = false; $('#b-loop').classList.remove('on');
    selectTrack(it.track, { play: true, start: st });
    if (old) { cueFadeObj = old; old.last = performance.now(); old.raf = requestAnimationFrame(fadeTick); }
  } finally { cueFiring = false; }
  renderCues(); renderPlayerInfo(); ensureLoop(); drawWave();
}
function tickCue() {
  if (!cuePlay) return;
  updateCueProgress();
  const cur = audio.currentTime || 0;
  if (cuePlay.end == null || audio.paused) return;
  if (!stopFade && cur >= cuePlay.end - 0.3) stopFade = { t: performance.now() };
  if (stopFade) {
    const p = Math.min(1, (performance.now() - stopFade.t) / 300);
    stopMul = Math.cos(p * Math.PI / 2); recalcFade(); applyVolume();
    if (p >= 1 || cur >= cuePlay.end + 0.05) {
      audio.pause(); stopFade = null; stopMul = 1; recalcFade(); applyVolume();
      cuePlay = null; renderCuesLight(); renderPlayerInfo(); updateTime(); drawWave();
    }
  }
}
function cuePauseAll() {
  const o = cueFadeObj;
  if (!o) { togglePlay(); return; }
  const playing = !audio.paused || o.running;
  if (playing) {
    audio.pause(); o.running = false; try { o.tmp.pause(); } catch (e) { }
    if (o.raf) { cancelAnimationFrame(o.raf); o.raf = 0; }
    stopFade = null; stopMul = 1; recalcFade(); applyVolume();
  } else {
    if (curId) audio.play().catch(() => { });
    try { o.tmp.play().catch(() => { }); } catch (e) { }
    o.running = true; o.last = performance.now(); o.raf = requestAnimationFrame(fadeTick); ensureLoop();
  }
  updateTime();
}

// ---------- arranque ----------
if (MOCK) {
  const m = makeMock();
  invoke = m.invoke; convertFileSrc = m.convertFileSrc; listen = m.listen;
} else {
  invoke = TAURI.core.invoke; convertFileSrc = TAURI.core.convertFileSrc; listen = TAURI.event.listen;
}
(async function init() {
  if (MOCK) { const b = document.createElement('div'); b.className = 'badge-test'; b.textContent = 'MODO PRUEBA'; document.body.appendChild(b); }
  try {
    await listen('app-closing', async () => {
      try { await Promise.race([Promise.all([flushSave(), flushUI()]), new Promise(r => setTimeout(r, 1200))]); } catch (e) { }
      invoke('quit');
    });
    await listen('analysis', ev => onAnalysis(ev.payload));
    await listen('analysis_done', () => { pendingN = 0; renderHead(); });
    await listen('tauri://drag-enter', () => { $('#dropov').hidden = false; });
    await listen('tauri://drag-leave', () => { $('#dropov').hidden = true; });
    await listen('tauri://drag-drop', ev => onDrop(ev.payload));
    applyState(await invoke('get_state'));
  } catch (e) { toast('Error al iniciar: ' + e); console.error(e); }
  resizeWave();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { buildWaveCache(); drawWave(); });
})();

// ---------- mock (solo navegador comun) ----------
function makeMock() {
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const listeners = {};
  const emit = (n, p) => (listeners[n] || []).forEach(cb => cb({ payload: p }));
  function gen(dur, lead) {
    const N = 800, peaks = [], rms = [];
    const segs = []; let x = 0;
    while (x < N) { const l = 40 + Math.floor(rnd() * 160); segs.push([x, x + l, 0.12 + rnd() * 0.88]); x += l; }
    let env = 0.3;
    const z = lead ? Math.floor(lead / dur * N) : 0;
    for (let i = 0; i < N; i++) {
      const s = segs.find(s => i >= s[0] && i < s[1]) || segs[segs.length - 1];
      env += (s[2] - env) * 0.06;
      const wob = 0.75 + 0.25 * Math.sin(i * 0.9) * rnd();
      const r = i < z ? 0.01 : Math.max(0.03, env * wob);
      rms.push(Math.min(255, Math.round(r * 230)));
      peaks.push(Math.min(255, Math.round(Math.min(1, r * (1.15 + rnd() * 0.5)) * 255)));
    }
    return { duration: dur, bpm: rnd() > 0.2 ? Math.round(70 + rnd() * 90) : null, peaks, rms, lead: lead || 0 };
  }
  const names = ['Overture of Storms', "Death Note - L's Theme", 'Bach - Preludio Suite 1 Cello', 'Mahler - Adagietto Sinfonía 5', 'Chopin - Nocturno Op.9 No.2', 'Libertango', 'Type Beat Dark Trap 140', 'FMAB - Brothers', 'Zelda - Gerudo Valley', 'Persona 5 - Beneath the Mask', 'Zimmer - Time', 'Oblivion Main Theme', 'Sakura Reflection', 'Beethoven - Claro de Luna', 'Adiós Nonino', 'Cyberpunk Type Beat', 'NieR - Weight of the World', 'Ghibli - Merry-go-round', 'Satie - Gymnopédie 1', "Bloodborne - Hunter's Dream"];
  const artists = ['Death Note', 'Bach', 'Mahler', 'Chopin', 'Piazzolla', 'Nier', 'Zimmer', 'Beethoven', 'Satie', 'Ravel', 'Debussy', 'Vivaldi', 'Hisaishi', 'Uematsu', 'Yoko Kanno', 'Sakamoto', 'Williams'];
  const svg = (c, w, h) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${c}"/><circle cx="${w / 2}" cy="${h * .42}" r="${h * .2}" fill="#2b2b2e"/><rect x="${w * .28}" y="${h * .68}" width="${w * .44}" height="${h * .4}" rx="40" fill="#2b2b2e"/></svg>`);
  const mkFile = (i, root, rel, dur) => ({ id: root ? root + '::' + rel : rel, root, rel, path: 'mock://' + i + '?d=' + dur, name: rel.split('/').pop().replace(/\.mp3$/, ''), ext: 'mp3', size: 4e6, mtime: 1700000000 + i * 5000, cover: null, _dur: dur,
    analysis: i % 4 === 3 ? null : (i === 5 ? { duration: 0, bpm: null, peaks: new Array(800).fill(0), rms: new Array(800).fill(0), lead: 0 } : gen(dur, i % 5 === 1 ? 3.4 : 0)) });
  const allFiles = names.map((n, i) => {
    const dur = 90 + Math.floor(rnd() * 200);
    const rel = (i % 3 === 0 ? 'GI/' : i % 3 === 1 ? 'Beats/' : '') + n + '.mp3';
    return mkFile(i, '', i % 7 === 0 ? 'GI/Sub/' + n + '.mp3' : rel, dur);
  });
  ['Lo-fi 1', 'Lo-fi 2', 'Épica 3'].forEach((n, k) => allFiles.push(mkFile(100 + k, 'k3f9', 'Otros/' + n + '.mp3', 100 + k * 30)));
  allFiles[0].cover = svg('#c9bfa6', 300, 300);
  allFiles[1].cover = svg('#9d9788', 400, 220);
  allFiles[2].cover = svg('#7f9bb0', 220, 400);
  const lib0 = { version: 1, categories: JSON.parse(JSON.stringify(DEFAULT_CATS)), tracks: {} };
  lib0.categories[0].values = artists;
  lib0.categories[1].values = ['OST anime', 'OST videojuego', 'Académica', 'Tango', 'Type beat'];
  lib0.categories[2].values = ['Tensión', 'Épico', 'Melancolía', 'Calma', 'Misterio', 'Triunfo'];
  lib0.categories[3].values = ['Sin reclamo', 'Reclamo TikTok'];
  lib0.categories[4].values = ['Reel político', 'Comercial'];
  allFiles.forEach((f, i) => {
    if (i % 3 === 2) return;
    const tags = { artista: [artists[i % artists.length]], tipo: [lib0.categories[1].values[i % 5]], emocion: [lib0.categories[2].values[i % 6]] };
    if (i % 4 === 0) tags.copyright = ['Reclamo TikTok'];
    lib0.tracks[f.id] = { tags, notes: i === 0 ? 'Arranca suave, explota a los 2:00' : '', fav: i % 5 === 0, moments: [] };
  });
  const f1 = allFiles[1], f7 = allFiles[7];
  lib0.tracks[f1.id] = lib0.tracks[f1.id] || { tags: {}, notes: '', fav: false, moments: [] };
  lib0.tracks[f1.id].moments = [
    { id: 'a1', start: 42, end: 70.5, label: 'tensión', tags: { emocion: ['Tensión'] } },
    { id: 'a2', start: 60, end: 90, label: 'se pisa con el anterior', tags: {} },
    { id: 'a3', start: 100, end: 140, label: 'clímax', tags: { emocion: ['Épico'] } }];
  lib0.tracks[f7.id] = lib0.tracks[f7.id] || { tags: {}, notes: '', fav: false, moments: [] };
  lib0.tracks[f7.id].moments = [{ id: 'b1', start: 192, end: 220, label: 'clímax', tags: { emocion: ['Épico', 'Triunfo'] } }];
  const st = {
    roots: [{ path: 'C:\\Musica (prueba)', key: '', excluded: [] }, { path: 'D:\\Otra (prueba)', key: 'k3f9', excluded: [] }, { path: 'E:\\Vieja (prueba)', key: 'z9z9', excluded: [], missing: true }],
    ui: {}, library: lib0, photos: [{ key: 'death note', path: svg('#c9bfa6', 300, 200) }, { key: 'bach', path: svg('#9d9788', 300, 200) }],
  };
  const dirOf = f => f.rel.includes('/') ? f.rel.split('/').slice(0, -1).join('/') : '';
  function buildState() {
    const files = allFiles.filter(f => {
      const r = st.roots.find(x => x.key === f.root), d = dirOf(f);
      return !(r.excluded || []).some(x => d === x || d.startsWith(x + '/'));
    });
    return JSON.parse(JSON.stringify({
      folder: st.roots[0].path, needs_folder: false, roots: st.roots.map(r => Object.assign({}, r, { exists: !r.missing })), ui: st.ui, files, photos: st.photos, library: st.library,
      pending: files.filter(f => !f.analysis).length,
    }));
  }
  const wavCache = {};
  function wavURL(d) {
    if (wavCache[d]) return wavCache[d];
    const sr = 8000, n = sr * d, buf = new Uint8Array(44 + n).fill(128), v = new DataView(buf.buffer);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) buf[o + i] = t.charCodeAt(i); };
    s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true);
    return (wavCache[d] = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  }
  setTimeout(() => {
    allFiles.filter(f => !f.analysis).forEach((f, k) => setTimeout(() => { const a = gen(f._dur, 0); f.analysis = a; emit('analysis', { id: f.id, analysis: a }); }, 1500 + k * 1200));
    setTimeout(() => emit('analysis_done', {}), 1500 + 6 * 1200 + 300);
  }, 100);
  const subs = key => {
    const out = [], seen = new Set();
    allFiles.filter(f => f.root === key).forEach(f => { const parts = dirOf(f).split('/').filter(Boolean); parts.forEach((p, i) => { const rel = parts.slice(0, i + 1).join('/'); if (!seen.has(rel)) { seen.add(rel); out.push({ rel, depth: i, audio: 0 }); } }); });
    out.forEach(o => { o.audio = allFiles.filter(f => f.root === key && dirOf(f) === o.rel).length; });
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  };
  const log = (...a) => console.log('[mock]', ...a);
  return {
    invoke: async (cmd, args) => {
      args = args || {};
      if (cmd === 'get_state' || cmd === 'rescan' || cmd === 'pick_folder') return buildState();
      if (cmd === 'save_library') { st.library = JSON.parse(JSON.stringify(args.library)); log('save_library', Object.keys(args.library.tracks).length, 'tracks'); return null; }
      if (cmd === 'save_ui_settings') { st.ui = JSON.parse(JSON.stringify(args.ui)); log('save_ui_settings', JSON.stringify(args.ui)); return null; }
      if (cmd === 'start_drag') { log('start_drag', args.path); return null; }
      if (cmd === 'drag_fragment') { log('drag_fragment', args.id, args.start, args.end); if (args.id === f1.id) throw 'NEEDS_WAV'; return null; }
      if (cmd === 'save_fragment_wav') { log('save_fragment_wav', args.id, args.start, args.end, 'b64 len', args.data.length); return null; }
      if (cmd === 'save_analysis') { log('save_analysis', args.id, args.analysis.duration, args.analysis.peaks.length, 'lead', args.analysis.lead); return null; }
      if (cmd === 'reveal') { log('reveal', args.path); return null; }
      if (cmd === 'add_root') { st.roots.push({ path: 'F:\\Nueva (prueba)', key: 'n' + st.roots.length + 'x1', excluded: [] }); log('add_root'); return buildState(); }
      if (cmd === 'remove_root') { if (!args.key) throw 'La carpeta principal no se quita: cambiala con "Cambiar carpeta principal".'; st.roots = st.roots.filter(r => r.key !== args.key); log('remove_root', args.key); return buildState(); }
      if (cmd === 'set_excluded') { st.roots.find(r => r.key === args.key).excluded = args.excluded; log('set_excluded', args.key, JSON.stringify(args.excluded)); return buildState(); }
      if (cmd === 'list_subfolders') { log('list_subfolders', args.key); return subs(args.key); }
      if (cmd === 'set_cover') {
        const f = allFiles.find(x => x.id === args.id); if (!f) throw 'No existe el tema';
        f.cover = args.data ? 'data:image/' + (args.ext === 'jpg' ? 'jpeg' : args.ext) + ';base64,' + args.data : args.path;
        f.mtime += 1;
        log('set_cover', args.id, args.mode, args.path ? 'path' : 'data(' + args.ext + ')');
        const fi = JSON.parse(JSON.stringify(f)); delete fi._dur;
        return { file: fi, mode: args.mode, warning: args.mode === 'file' && f.name.includes('Libertango') ? 'Este archivo no admite portada interna: se guardó solo en la app.' : undefined, library: JSON.parse(JSON.stringify(st.library)) };
      }
      if (cmd === 'rename_track') {
        if (/[\\/:*?"<>|]/.test(args.name)) throw 'El nombre tiene caracteres que Windows no permite: \\ / : * ? " < > |';
        const f = allFiles.find(x => x.id === args.id); if (!f) throw 'No existe el tema';
        const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/') + 1) : '';
        const nrel = dir + args.name + '.mp3', nid = f.root ? f.root + '::' + nrel : nrel;
        if (allFiles.some(x => x.id === nid)) throw 'Ya existe un tema con ese nombre';
        st.library.tracks[nid] = st.library.tracks[f.id]; delete st.library.tracks[f.id];
        f.id = nid; f.rel = nrel; f.name = args.name;
        log('rename_track', args.id, '->', nid);
        return { state: buildState(), id: nid };
      }
      throw new Error('comando desconocido ' + cmd);
    },
    convertFileSrc: p => { const m = /^mock:.*d=(\d+)/.exec(p); return m ? wavURL(+m[1]) : p; },
    listen: async (n, cb) => { (listeners[n] = listeners[n] || []).push(cb); return () => { }; },
  };
}
