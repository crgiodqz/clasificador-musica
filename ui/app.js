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
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const errText = e => String((e && e.message) || e);
const GRIP = '<svg viewBox="0 0 10 14" width="9" height="12"><g fill="currentColor"><circle cx="2.5" cy="2" r="1.3"/><circle cx="7.5" cy="2" r="1.3"/><circle cx="2.5" cy="7" r="1.3"/><circle cx="7.5" cy="7" r="1.3"/><circle cx="2.5" cy="12" r="1.3"/><circle cx="7.5" cy="12" r="1.3"/></g></svg>';
const hasWave = an => !!an && an.duration > 0;
const fbPending = f => !!f.analysis && f.analysis.duration === 0 && !f._fbFail;

// ---------- estado ----------
let S = { folder: '', files: [], photos: [], library: null, pending: 0 };
let lib = null;
const byId = new Map();
let curId = null;
const filters = { q: '', fav: false, untagged: false, moments: false, cats: {} };
let sortBy = 'name';
let view = [];            // [{f, subs:[moment]}]
let counts = { cats: {}, fav: 0, untagged: 0, moments: 0 };
let pendingN = 0;
const collapsed = new Set();
const expMoms = new Set();
let lastOpenMoment = null;

const DEFAULT_CATS = [
  { id: 'artista', name: 'Artista', color: '#b8a98a', multi: false, values: [] },
  { id: 'tipo', name: 'Tipo', color: '#7f9bb0', multi: true, values: [] },
  { id: 'emocion', name: 'Emoción', color: '#b08590', multi: true, values: [] },
  { id: 'copy', name: 'Tendencia de copy', color: '#8aa586', multi: true, values: [] },
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
  return l;
}
const T = id => lib.tracks[id];
function TW(id) { return lib.tracks[id] || (lib.tracks[id] = { tags: {}, notes: '', fav: false, moments: [] }); }
const catById = id => lib.categories.find(c => c.id === id);
function hasTags(t) { return !!t && Object.values(t.tags).some(a => a && a.length); }

function applyState(st) {
  S = st;
  lib = normalizeLib(st.library);
  S.library = lib;
  byId.clear();
  S.files.forEach(f => byId.set(f.id, f));
  pendingN = S.pending || 0;
  if (curId && !byId.has(curId)) { curId = null; audio.removeAttribute('src'); audio.load(); }
  refreshAll();
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
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

function libChanged(opt) {
  opt = opt || {};
  scheduleSave();
  if (opt.light) return;
  computeCounts(); computeView(); renderFilters(); layoutList(); renderList(true);
  if (!opt.skipDetail) renderDetail();
  updateRange(); drawWave();
}
function refreshAll() {
  computeCounts(); computeView(); renderFilters(); layoutList(); renderList(true);
  renderDetail(); renderHead(); renderPlayerInfo(); resizeWave();
}

// ---------- filtros / vista ----------
function computeCounts() {
  const c = { cats: {}, fav: 0, untagged: 0, moments: 0 };
  lib.categories.forEach(cat => { c.cats[cat.id] = {}; cat.values.forEach(v => c.cats[cat.id][v] = 0); });
  for (const f of S.files) {
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
}
function computeView() {
  const q = fold(filters.q).trim(), qTokens = q.split(/\s+/).filter(Boolean);
  const active = lib.categories.filter(c => filters.cats[c.id] && filters.cats[c.id].size);
  const out = [];
  for (const f of S.files) {
    const t = T(f.id);
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
  return filters.q || filters.fav || filters.untagged || filters.moments || Object.values(filters.cats).some(s => s.size);
}

// ---------- panel izquierdo ----------
function chipHTML(cat, v, on, n) {
  const c = mute(cat.color);
  const st = on ? `background:${rgba(c, .5)};border-color:${rgba(c, 1)}` : `background:${rgba(c, .13)};border-color:${rgba(c, .4)}`;
  return `<button class="chip${on ? ' on' : ''}${n === 0 ? ' zero' : ''}" data-cat="${esc(cat.id)}" data-val="${esc(v)}" style="${st}">${esc(v)}<i>${n}</i></button>`;
}
function renderFilters() {
  const q = $('#f-quick');
  const qc = (k, label, n) => `<button class="chip${filters[k] ? ' on' : ''}" data-quick="${k}" style="${filters[k] ? 'background:rgba(242,234,216,.28);border-color:#f2ead8' : ''}">${label}<i>${n}</i></button>`;
  q.innerHTML = `<div class="chips">${qc('fav', 'Favoritos', counts.fav)}${qc('untagged', 'Sin etiquetar', counts.untagged)}${qc('moments', 'Con momentos', counts.moments)}</div>`;
  const sc = $('#f-scroll').scrollTop;
  $('#f-cats').innerHTML = lib.categories.map(cat => {
    const sel = filters.cats[cat.id] || new Set();
    const col = collapsed.has(cat.id);
    const body = col ? '' : `<div class="chips">${cat.values.length ? cat.values.map(v => chipHTML(cat, v, sel.has(v), (counts.cats[cat.id] || {})[v] || 0)).join('') : '<span style="color:var(--dim2);font-size:12px">Sin valores</span>'}</div>`;
    return `<div class="fsec"><h4 data-collapse="${esc(cat.id)}"><span class="dot" style="background:${rgba(mute(cat.color), 1)}"></span>${esc(cat.name)}${sel.size ? ' (' + sel.size + ')' : ''}<span class="car">${col ? '+' : '-'}</span></h4>${body}</div>`;
  }).join('');
  $('#f-scroll').scrollTop = sc;
}
$('#f-scroll').addEventListener('click', e => {
  const ch = e.target.closest('.chip'), h = e.target.closest('h4');
  if (ch && ch.dataset.quick) { filters[ch.dataset.quick] = !filters[ch.dataset.quick]; }
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
  filters.q = ''; filters.fav = filters.untagged = filters.moments = false; filters.cats = {};
  $('#q').value = '';
  computeView(); renderFilters(); layoutList(); renderList(true);
};
$('#btn-folder').onclick = async () => {
  try { const st = await invoke('pick_folder'); if (st) applyState(st); } catch (e) { toast('Error: ' + e); }
};
$('#btn-rescan').onclick = async () => {
  toast('Reescaneando...');
  try { await flushSave(); applyState(await invoke('rescan')); toast('Listo'); } catch (e) { toast('Error: ' + e); }
};
$('#sort').onchange = e => { sortBy = e.target.value; computeView(); layoutList(); renderList(true); };
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

// ---------- lista virtual ----------
const ROW_H = 40, SUB_H = 24;
let offsets = [], totalH = 0, lastKey = '', renderVer = 0;
const listEl = $('#list'), inner = $('#list-inner');
function layoutList() {
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
function renderList(force) {
  if (!view.length) {
    inner.innerHTML = S.files.length ? '<div class="empty">Ningún tema coincide con los filtros.</div>' : '<div class="empty">No hay temas en la carpeta.<br><button class="btn" id="e-folder">Elegir carpeta</button></div>';
    inner.style.height = 'auto'; lastKey = '';
    const b = $('#e-folder'); if (b) b.onclick = () => $('#btn-folder').click();
    return;
  }
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
  let html = '';
  for (let i = a; i < b; i++) {
    const { f, subs } = view[i], t = T(f.id), an = f.analysis;
    html += `<div class="row${f.id === curId ? ' sel' : ''}" data-id="${esc(f.id)}" draggable="false" style="top:${offsets[i]}px;height:${ROW_H + subs.length * SUB_H}px">
      <div class="rmain"><span class="star${t && t.fav ? ' on' : ''}" data-act="fav">${t && t.fav ? '\u2605' : '\u2606'}</span>
      <span class="rname" title="${esc(f.name)}">${esc(f.name)}</span><span class="rtags">${tagsChips(t, 4)}</span>
      <span class="rdur">${hasWave(an) ? fmt(an.duration) : ''}</span><span class="rbpm">${an && an.bpm ? '~' + Math.round(an.bpm) : ''}</span>
      <span class="rmom">${t && t.moments.length ? '<b>' + t.moments.length + '</b>' : ''}</span>
      <span class="rwave" data-id="${esc(f.id)}">${hasWave(an) ? `<canvas data-w="${esc(f.id)}"></canvas><i class="wl"></i>` : (!an || fbPending(f) ? '<em>analizando...</em>' : '<em>sin onda</em>')}</span></div>
      ${subs.map(m => `<div class="sub" data-id="${esc(f.id)}" data-mid="${esc(m.id)}" draggable="false"><span class="stime">${fmt(Math.round(m.start))}${m.end != null ? '\u2013' + fmt(Math.round(m.end)) : ''}</span><span>${esc(m.label)}</span>${tagsChips(m, 3)}<span class="dh" data-id="${esc(f.id)}" data-start="${m.start}" data-end="${m.end != null ? m.end : ''}" title="Arrastrar este fragmento a CapCut">${GRIP}Arrastrar</span></div>`).join('')}
    </div>`;
  }
  inner.innerHTML = html;
  inner.querySelectorAll('canvas[data-w]').forEach(c => drawMini(c, byId.get(c.dataset.w)));
}
function drawMini(c, f) {
  const an = f && f.analysis; if (!hasWave(an)) return;
  const d = DPR(), W = 96, H = 26;
  c.width = W * d; c.height = H * d;
  const g = c.getContext('2d'); g.scale(d, d);
  const N = 48, L = an.peaks.length, bw = W / N;
  g.fillStyle = f.id === curId ? '#f2ead8' : '#9d9788';
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
listEl.addEventListener('click', e => {
  if (dragFired) { dragFired = false; return; }
  if (e.target.closest('.dh')) return;
  const star = e.target.closest('.star');
  const sub = e.target.closest('.sub'), row = e.target.closest('.row');
  if (star && row) { toggleFav(row.dataset.id); return; }
  const rw = e.target.closest('.rwave');
  if (rw && row && rw.querySelector('canvas')) {
    const r = rw.getBoundingClientRect(), f = byId.get(row.dataset.id);
    if (f && hasWave(f.analysis)) {
      const fr = Math.max(0, Math.min(0.995, (e.clientX - r.left) / r.width));
      selectTrack(f.id, { play: true, start: fr * f.analysis.duration });
      return;
    }
  }
  if (sub) { playMoment(sub.dataset.id, sub.dataset.mid); return; }
  if (row) selectTrack(row.dataset.id, { play: true });
});

// ---------- arrastre nativo ----------
let dragCand = null, dragFired = false;
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
  el.title = 'Arrastrá este fragmento a CapCut';
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
  if (e.target.closest('.star,input,textarea,button,select')) return;
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
    const f = byId.get(c.id);
    if (f) invoke('start_drag', { path: f.path }).catch(err => toast('No se pudo arrastrar: ' + errText(err)));
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
  mp = mp || 1; mr = mr || 1;
  const peaks = [], rms = [];
  for (let b = 0; b < N; b++) { peaks.push(Math.round(pk[b] / mp * 255)); rms.push(Math.round(Math.pow(rm[b] / mr, 0.6) * 255)); }
  return { duration: buf.duration, bpm: null, peaks, rms };
}

// ---------- favoritos ----------
function toggleFav(id) {
  if (!id) return; const t = TW(id); t.fav = !t.fav;
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
function tagEditor(cat, tags, scope) {
  const sel = tags[cat.id] || [], col = mute(cat.color);
  const chip = (v, on, x) => {
    const st = on ? `background:${rgba(col, .5)};border-color:${rgba(col, 1)}` : `background:${rgba(col, .1)};border-color:${rgba(col, .35)}`;
    return `<button class="chip${on ? ' on' : ''}" data-tt="1" data-scope="${esc(scope)}" data-cat="${esc(cat.id)}" data-val="${esc(v)}" style="${st}">${esc(v)}${x ? ' ×' : ''}</button>`;
  };
  const big = cat.values.length > BIG_CAT, key = scope + '|' + cat.id, all = expCats.has(key);
  const head = `<div class="te-l"><span class="dot" style="background:${rgba(mute(cat.color), 1)}"></span>${esc(cat.name)}<small>${cat.multi ? '' : 'uno solo'}</small></div>`;
  if (!big) {
    return `<div class="te">${head}<div class="chips">${cat.values.map(v => chip(v, sel.includes(v))).join('')}<span class="chip add"><input type="text" data-add="1" data-scope="${esc(scope)}" data-cat="${esc(cat.id)}" placeholder="+ nuevo" autocomplete="off"></span></div></div>`;
  }
  const input = `<span class="chip add"><input type="text" data-add="1" data-ac="1" data-scope="${esc(scope)}" data-cat="${esc(cat.id)}" placeholder="+ agregar…" autocomplete="off"></span>`;
  const link = `<a class="vall" data-all="${esc(key)}">${all ? 'ocultar' : 'ver todos (' + cat.values.length + ')'}</a>`;
  const chips = all ? cat.values.map(v => chip(v, sel.includes(v))).join('') : sel.map(v => chip(v, true, true)).join('');
  return `<div class="te">${head}<div class="chips">${chips}${input}${link}</div></div>`;
}

// autocompletado liviano
const acBox = document.createElement('div'); acBox.id = 'ac'; acBox.hidden = true; document.body.appendChild(acBox);
let ac = { inp: null, items: [], idx: -1 };
function showAC(inp) {
  const cat = catById(inp.dataset.cat), tags = scopeTags(inp.dataset.scope); if (!cat || !tags) return hideAC();
  const sel = tags[cat.id] || [], q = fold(inp.value).trim();
  ac = { inp, idx: -1, items: cat.values.filter(v => !sel.includes(v) && fold(v).includes(q)) };
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
  const tags = scopeTags(scope); if (!tags) return;
  const arr = tags[cat.id] || [];
  if (cat.multi) { if (!arr.includes(val)) tags[cat.id] = arr.concat(val); } else tags[cat.id] = [val];
  libChanged();
  const again = document.querySelector(`#detail [data-add][data-scope="${scope}"][data-cat="${cat.id}"]`); if (again) again.focus();
}
function momentRow(m, active) {
  const open = expMoms.has(m.id);
  let tagsHTML;
  if (open) tagsHTML = lib.categories.map(c => tagEditor(c, m.tags, 'm:' + m.id)).join('');
  else tagsHTML = tagsChips(m, 8);
  return `<div class="mom${active ? ' active' : ''}" data-mid="${esc(m.id)}">
    <div class="mom-top">
      <button class="ib" data-act="mplay" title="Reproducir"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 2l10 6-10 6z" fill="currentColor"/></svg></button>
      <input class="tin" data-f="start" value="${fmt(m.start, true)}" title="Inicio (m:ss)">
      <span>\u2013</span>
      <input class="tin" data-f="end" value="${m.end != null ? fmt(m.end, true) : ''}" placeholder="fin" title="Fin (m:ss)">
      <input class="lab" data-f="label" value="${esc(m.label)}" placeholder="nombre">
      <button class="ib txt" data-act="mtags">${open ? 'Listo' : 'Etiq.'}</button>
      <button class="ib" data-act="mdel" title="Borrar">\u00d7</button>
    </div>
    <div class="mom-drag"><span class="dh" data-id="${esc(curId)}" data-start="${m.start}" data-end="${m.end != null ? m.end : ''}" title="Arrastrar este fragmento a CapCut">${GRIP}Arrastrar</span></div>
    <div class="mom-tags">${tagsHTML}</div></div>`;
}
function renderDetail() {
  const d = $('#detail'), sc = d.scrollTop;
  const f = curId && byId.get(curId);
  if (!f) { d.innerHTML = '<div class="d-empty">Elegí un tema de la lista</div>'; return; }
  const t = T(f.id) || { tags: {}, notes: '', fav: false, moments: [] };
  const ph = findPhoto(f), an = f.analysis;
  const moms = t.moments.slice().sort((a, b) => a.start - b.start);
  d.innerHTML = `
    ${ph ? `<div class="photo"><img draggable="false" src="${esc(convertFileSrc(ph.path))}" alt=""></div>` : ''}
    <h2>${esc(f.name)}</h2>
    <div class="d-meta" id="d-meta">${esc(f.ext.toUpperCase())}${hasWave(an) ? ' \u00b7 ' + fmt(an.duration) : ''}${an && an.bpm ? ' \u00b7 ~' + Math.round(an.bpm) + ' BPM' : ''}</div>
    <div class="d-btns"><button class="btn" data-act="reveal">Mostrar en carpeta</button><button class="btn${t.fav ? ' on' : ''}" data-act="dfav">${t.fav ? '\u2605 Favorito' : '\u2606 Favorito'}</button></div>
    <div id="drag" draggable="false"><span class="t">${GRIP}Arrastrar tema entero a CapCut</span><small>Para un fragmento, usá el asa de cada momento</small></div>
    <div class="dsec">Momentos<small>fragmentos</small><span class="grow"></span><button class="btn" data-act="addmom" style="text-transform:none;letter-spacing:0">Marcar inicio (I)</button></div>
    ${moms.length ? '<div class="hint">Cada momento tiene su asa Arrastrar para llevar solo ese fragmento.</div>' : ''}
    ${moms.length ? moms.map(m => momentRow(m, momentPlay && momentPlay.id === m.id)).join('') : '<div class="mom-add">Sin momentos. Usá I / O mientras suena, o shift + arrastrar sobre la onda.</div>'}
    <div class="dsec">Etiquetas</div>
    ${lib.categories.map(c => tagEditor(c, t.tags, 't')).join('')}
    <div class="dsec">Notas</div>
    <textarea id="notes" placeholder="Notas del tema">${esc(t.notes)}</textarea>`;
  d.scrollTop = sc;
  if (focusMom) {
    const fm = focusMom; focusMom = null;
    const row = d.querySelector(`.mom[data-mid="${fm.id}"]`);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      if (fm.focus) { const lab = row.querySelector('.lab'); if (lab) { lab.focus(); lab.select(); } }
    }
  }
}
let focusMom = null;
function updateDetailMeta() {
  const el = $('#d-meta'), f = curId && byId.get(curId);
  if (!el || !f) return; const an = f.analysis;
  el.textContent = f.ext.toUpperCase() + (hasWave(an) ? ' \u00b7 ' + fmt(an.duration) : '') + (an && an.bpm ? ' \u00b7 ~' + Math.round(an.bpm) + ' BPM' : '');
}
function scopeTags(scope) {
  if (scope === 't') return TW(curId).tags;
  const m = TW(curId).moments.find(x => x.id === scope.slice(2));
  return m ? m.tags : null;
}
function applyTag(scope, catId, val, toggle) {
  const cat = catById(catId), tags = scopeTags(scope); if (!cat || !tags) return;
  const arr = tags[catId] || [];
  const has = arr.includes(val);
  if (cat.multi) tags[catId] = has ? arr.filter(x => x !== val) : (toggle || !has ? (has ? arr : arr.concat(val)) : arr);
  else tags[catId] = has && toggle ? [] : [val];
  if (!tags[catId].length) delete tags[catId];
}
$('#detail').addEventListener('click', e => {
  const al = e.target.closest('[data-all]');
  if (al) { const k = al.dataset.all; expCats.has(k) ? expCats.delete(k) : expCats.add(k); renderDetail(); return; }
  const tt = e.target.closest('[data-tt]');
  if (tt) { applyTag(tt.dataset.scope, tt.dataset.cat, tt.dataset.val, true); libChanged(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, mid = b.closest('.mom') && b.closest('.mom').dataset.mid;
  if (act === 'reveal') invoke('reveal', { path: byId.get(curId).path }).catch(err => toast('Error: ' + err));
  else if (act === 'dfav') toggleFav(curId);
  else if (act === 'addmom') markIn();
  else if (act === 'mplay') playMoment(curId, mid);
  else if (act === 'mtags') { expMoms.has(mid) ? expMoms.delete(mid) : expMoms.add(mid); renderDetail(); }
  else if (act === 'mdel') confirmBtn(b, () => {
    const t = TW(curId); t.moments = t.moments.filter(m => m.id !== mid);
    if (momentPlay && momentPlay.id === mid) momentPlay = null;
    libChanged();
  }, '\u00bfSeguro?');
});
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
  else if (e.target.matches('.tin,.lab') && e.key === 'Enter') e.target.blur();
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
  if (el.dataset.f === 'label') m.label = el.value.trim() || 'Momento';
  else {
    const v = parseT(el.value);
    if (el.dataset.f === 'start') { if (v == null || isNaN(v)) { toast('Tiempo inválido'); } else m.start = round1(v); }
    else if (v == null) m.end = null;
    else if (isNaN(v)) toast('Tiempo inválido');
    else m.end = round1(v);
    if (m.end != null && m.end <= m.start) m.end = null;
  }
  libChanged();
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
const wave = $('#wave'), wbox = $('#wavebox'), wctx = wave.getContext('2d');
const ICON_PLAY = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 2l10 6-10 6z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3 2h4v12H3zM9 2h4v12H9z" fill="currentColor"/></svg>';
let momentPlay = null;     // {id,start,end}
let loopOn = false;
let pendingSeek = null;
let rangeSel = null;       // {a,b}
let hoverX = null;
let cache = null;          // {on, off, W, H, id}

let savedVol = 0.9;
try { const v = parseFloat(localStorage.getItem('clf_vol')); if (isFinite(v) && v > 0 && v <= 1) savedVol = v; else if (v === 0) savedVol = 0.8; } catch (e) { }
audio.volume = savedVol;
$('#vol').value = savedVol;
$('#vol').oninput = e => { audio.volume = +e.target.value; try { localStorage.setItem('clf_vol', e.target.value); } catch (er) { } };
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
  if (changed) {
    momentPlay = null; rangeSel = null; cache = null; lastOpenMoment = null;
    pendingSeek = o.start || null;
    audio.src = convertFileSrc(f.path);
    buildWaveCache();
  } else if (o.start != null) audio.currentTime = o.start;
  if (o.play !== false) audio.play().catch(() => {});
  renderPlayerInfo(); renderList(true); renderDetail(); updateRange(); scrollToId(id); drawWave();
  ensureLoop();
}
function renderPlayerInfo() {
  const f = curFile();
  $('#p-title').textContent = f ? f.name : '';
  const we = $('#wave-empty'); we.hidden = !!f; we.style.display = f ? 'none' : ''; we.textContent = f ? '' : 'Elegí un tema para escucharlo';
  updateTime();
}
function updateTime() {
  const d = curDur();
  $('#p-time').textContent = fmt(audio.currentTime || 0) + ' / ' + fmt(d);
  $('#b-play').innerHTML = audio.paused ? ICON_PLAY : ICON_PAUSE;
  updatePDrag();
}
function playMoment(id, mid) {
  const t = T(id), m = t && t.moments.find(x => x.id === mid); if (!m) return;
  if (id !== curId) selectTrack(id, { play: true, start: m.start });
  else { audio.currentTime = m.start; audio.play().catch(() => {}); ensureLoop(); }
  momentPlay = { id: m.id, start: m.start, end: m.end };
  renderDetail(); drawWave();
}
function tickMoment() {
  if (!momentPlay || momentPlay.end == null) return;
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
function togglePlay() {
  if (!curId) { if (view.length) selectTrack(view[0].f.id, { play: true }); return; }
  if (audio.paused) { audio.play().catch(() => {}); ensureLoop(); } else audio.pause();
}
function seekTo(t, play) {
  const d = curDur(); if (!d) return;
  t = Math.max(0, Math.min(d - 0.05, t));
  audio.currentTime = t;
  if (momentPlay && (t < momentPlay.start || (momentPlay.end != null && t > momentPlay.end))) { momentPlay = null; renderDetail(); }
  if (play && audio.paused) audio.play().catch(() => {});
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
function updateRange() { $('#b-save-range').hidden = !(rangeSel && Math.abs(rangeSel.a - rangeSel.b) > 0.3); updatePDrag(); }
function addMoment(start, end) {
  const t = TW(curId);
  const m = { id: uid(), start: round1(start), end: end == null ? null : round1(end), label: 'Momento ' + (t.moments.length + 1), tags: {} };
  t.moments.push(m); t.moments.sort((a, b) => a.start - b.start);
  focusMom = { id: m.id, focus: end != null };
  libChanged();
  return m;
}
function markIn() {
  if (!curId) { toast('Elegí un tema primero'); return; }
  const m = addMoment(audio.currentTime, null);
  lastOpenMoment = m.id; // addMoment ya lo muestra en el detalle sin robar el foco (para poder marcar el fin con O)
  toast('Inicio en ' + fmt(m.start, true) + '. Marcá el fin con O');
}
function markOut() {
  if (!curId) return;
  const t = TW(curId), now = audio.currentTime;
  let m = t.moments.find(x => x.id === lastOpenMoment && x.end == null) ||
    t.moments.filter(x => x.end == null && x.start < now).sort((a, b) => b.start - a.start)[0];
  if (!m) { toast('Marcá un inicio primero (I)'); return; }
  if (now <= m.start + 0.2) { toast('El fin tiene que ir después del inicio'); return; }
  m.end = round1(now); lastOpenMoment = null; focusMom = { id: m.id, focus: true };
  libChanged(); toast('Momento guardado ' + fmt(m.start, true) + '\u2013' + fmt(m.end, true));
}

audio.addEventListener('play', () => { updateTime(); ensureLoop(); });
audio.addEventListener('pause', () => { updateTime(); drawWave(); });
audio.addEventListener('timeupdate', () => { tickMoment(); if (audio.paused) { updateTime(); drawWave(); } });
audio.addEventListener('durationchange', () => { updateTime(); drawWave(); });
audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek != null) { audio.currentTime = pendingSeek; pendingSeek = null; }
  updateTime(); drawWave();
});
audio.addEventListener('ended', () => { if (!momentPlay || !loopOn) neighbor(1); });
audio.addEventListener('error', () => { if (audio.getAttribute('src')) toast('No se pudo reproducir este archivo'); });

let raf = 0, lastFrame = 0;
function loop(ts) {
  raf = 0;
  if (audio.paused) { updateTime(); drawWave(); return; }
  if (ts - lastFrame >= 30) { lastFrame = ts; tickMoment(); updateTime(); drawWave(); }
  raf = requestAnimationFrame(loop);
}
function ensureLoop() { if (!raf) raf = requestAnimationFrame(loop); }
let drawRaf = 0;
function scheduleDraw() { if (drawRaf) return; drawRaf = requestAnimationFrame(() => { drawRaf = 0; drawWave(); }); }

// ---- onda ----
const LABEL_H = 14; // css px reservados arriba para nombres de momentos
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
  const d = DPR(), W = wave.width, H = wave.height;
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
    // fuerte: marfil brillante; suave: casi apagado. Lo que falta por sonar queda mas oscuro.
    gOn.fillStyle = `hsl(43,${8 + 36 * tl}%,${24 + 72 * tl}%)`;
    gOff.fillStyle = `hsl(40,${3 + 7 * tl}%,${11 + 27 * tl}%)`;
    gOn.fillRect(x, mid - h, bw, h * 2); gOff.fillRect(x, mid - h, bw, h * 2);
  }
  cache = { on, off, W, H, id: curId };
}
function drawWave() {
  const W = wave.width, H = wave.height, d = DPR(), g = wctx;
  g.clearRect(0, 0, W, H);
  const f = curFile(); if (!f) return;
  g.fillStyle = '#131315'; g.fillRect(0, 0, W, H);
  const dur = curDur(), top = LABEL_H * d, mid = top + (H - top) / 2;
  const px = dur ? Math.min(W, (audio.currentTime / dur) * W) : 0;
  if (cache && cache.W === W && cache.H === H) {
    g.drawImage(cache.off, 0, 0);
    if (px > 0) g.drawImage(cache.on, 0, 0, px, H, 0, 0, px, H);
  } else {
    g.fillStyle = '#4a4740'; g.fillRect(0, mid - d, W, 2 * d);
    g.fillStyle = '#f2ead8'; g.fillRect(0, mid - d, px, 2 * d);
  }
  const t = T(f.id);
  if (dur && t) {
    g.font = `500 ${10.5 * d}px "Host Grotesk",system-ui,sans-serif`; g.textBaseline = 'middle';
    for (const m of t.moments) {
      const x1 = (m.start / dur) * W, x2 = m.end != null ? (m.end / dur) * W : x1 + 2 * d;
      const act = momentPlay && momentPlay.id === m.id;
      g.fillStyle = act ? 'rgba(242,234,216,.26)' : 'rgba(242,234,216,.13)';
      g.fillRect(x1, 0, Math.max(2 * d, x2 - x1), H);
      g.fillStyle = 'rgba(242,234,216,.7)'; g.fillRect(x1, 0, d, H);
      if (m.end != null) g.fillRect(x2 - d, 0, d, H);
      g.save(); g.beginPath(); g.rect(x1, 0, Math.max(40 * d, x2 - x1), top); g.clip();
      g.fillStyle = '#f2ead8'; g.fillText(m.label, x1 + 4 * d, top / 2 + d); g.restore();
    }
  }
  if (rangeSel && dur) {
    const a = Math.min(rangeSel.a, rangeSel.b) / dur * W, b = Math.max(rangeSel.a, rangeSel.b) / dur * W;
    g.fillStyle = 'rgba(255,246,223,.22)'; g.fillRect(a, 0, b - a, H);
    g.fillStyle = 'rgba(255,246,223,.9)'; g.fillRect(a, 0, d, H); g.fillRect(b - d, 0, d, H);
  }
  if (hoverX != null) { g.fillStyle = 'rgba(242,234,216,.35)'; g.fillRect(hoverX * d, 0, d, H); }
  if (dur) { g.fillStyle = '#fff6df'; g.fillRect(px - d, 0, 2 * d, H); }
}
function xToTime(clientX) {
  const r = wbox.getBoundingClientRect(), d = curDur();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * d;
}
let wdrag = null;
wbox.addEventListener('mousedown', e => {
  if (e.button !== 0 || !curId || !curDur()) return;
  e.preventDefault();
  const t = xToTime(e.clientX);
  if (e.shiftKey) { wdrag = { mode: 'range', a: t }; rangeSel = { a: t, b: t }; }
  else { wdrag = { mode: 'scrub' }; rangeSel = null; seekTo(t, true); }
  updateRange(); drawWave();
});
window.addEventListener('mousemove', e => {
  if (wdrag) {
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
    if (audio.paused || wdrag) scheduleDraw();
  } else if (hoverX != null) { hoverX = null; tip.hidden = true; scheduleDraw(); }
});
window.addEventListener('mouseup', () => {
  if (!wdrag) return;
  if (wdrag.mode === 'range' && rangeSel && Math.abs(rangeSel.a - rangeSel.b) <= 0.3) rangeSel = null;
  wdrag = null; updateRange(); drawWave();
});

// ---------- atajos ----------
document.addEventListener('keydown', e => {
  if (!$('#help').hidden) { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); closeHelp(); } return; }
  if (!$('#modal').hidden) { if (e.key === 'Escape') closeModal(); return; }
  const el = e.target;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) {
    if (e.key === 'Escape') el.blur(); return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); seekTo(audio.currentTime - 5, false); }
  else if (k === 'ArrowRight') { e.preventDefault(); seekTo(audio.currentTime + 5, false); }
  else if (k === 'ArrowUp') { e.preventDefault(); neighbor(-1); }
  else if (k === 'ArrowDown') { e.preventDefault(); neighbor(1); }
  else if (k === '?') { e.preventDefault(); openHelp(); }
  else if (k === 'r' || k === 'R') randomTrack();
  else if (k === 'f' || k === 'F') { toggleFav(curId); }
  else if (k === 'i' || k === 'I') { e.preventDefault(); markIn(); }
  else if (k === 'o' || k === 'O') { e.preventDefault(); markOut(); }
  else if (/^[1-9]$/.test(k)) { const d = curDur(); if (d) seekTo(d * (+k) / 10, false); }
});

// ---------- ayuda de atajos ----------
const SHORTCUTS = [
  ['Espacio', 'Reproducir / pausa'], ['← →', 'Retroceder / adelantar 5 s'], ['↑ ↓', 'Tema anterior / siguiente'],
  ['1 a 9', 'Saltar al 10% a 90% del tema'], ['R', 'Tema al azar de la lista actual'], ['F', 'Marcar favorito'],
  ['I', 'Marcar inicio de momento'], ['O', 'Marcar fin de momento'], ['Shift + arrastrar', 'Elegir un rango en la onda'],
  ['Clic en mini-onda', 'Reproducir desde ese punto'], ['Arrastrar (asa)', 'Llevar tema o fragmento a CapCut'], ['?', 'Abrir / cerrar esta ayuda'], ['Esc', 'Cerrar paneles']];
function openHelp() {
  $('#help').innerHTML = `<div class="hbox"><h3>Atajos</h3><dl>${SHORTCUTS.map(([k, d]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(d)}</dd>`).join('')}</dl><div class="hf">Esc o clic afuera para cerrar</div></div>`;
  $('#help').hidden = false;
}
function closeHelp() { $('#help').hidden = true; }
$('#help').addEventListener('mousedown', e => { if (e.target.id === 'help') closeHelp(); });
$('#btn-help').onclick = openHelp;

// ---------- soltar archivos para importar ----------
const normPath = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
async function onDrop(p) {
  $('#dropov').hidden = true;
  const paths = (p && p.paths) || []; if (!paths.length) return;
  const root = normPath(S.folder || '') + '/';
  if (S.folder && paths.every(x => (normPath(x) + '/').startsWith(root))) { toast('Ese tema ya está en tu carpeta'); return; }
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
    <div class="mvals">${c.values.map(v => `<span class="mval"><span class="mval-t" data-m="renval" data-val="${esc(v)}" title="Doble clic para renombrar">${esc(v)}</span><button data-m="delval" data-val="${esc(v)}" title="Borrar valor">\u00d7</button></span>`).join('') || '<span style="color:var(--dim2)">Sin valores</span>'}</div>
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
  }, '\u00bfBorrar?');
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
  let id = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '') || 'cat';
  if (catById(id)) id += uid().slice(-3);
  const pal = ['#b8a98a', '#7f9bb0', '#b08590', '#8aa586', '#b3906f', '#9a8fb3', '#8fa8a3'];
  lib.categories.push({ id, name, color: pal[lib.categories.length % pal.length], multi: true, values: [] });
  scheduleSave(); renderModal();
}
function stripTag(catId, val) {
  const strip = tags => { if (!tags || !tags[catId]) return; if (val == null) delete tags[catId]; else { tags[catId] = tags[catId].filter(v => v !== val); if (!tags[catId].length) delete tags[catId]; } };
  for (const id in lib.tracks) { strip(lib.tracks[id].tags); lib.tracks[id].moments.forEach(m => strip(m.tags)); }
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
      try { await Promise.race([flushSave(), new Promise(r => setTimeout(r, 1200))]); } catch (e) { }
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
  function gen(dur) {
    const N = 800, peaks = [], rms = [];
    const segs = []; let x = 0;
    while (x < N) { const l = 40 + Math.floor(rnd() * 160); segs.push([x, x + l, 0.12 + rnd() * 0.88]); x += l; }
    let env = 0.3;
    for (let i = 0; i < N; i++) {
      const s = segs.find(s => i >= s[0] && i < s[1]) || segs[segs.length - 1];
      env += (s[2] - env) * 0.06;
      const wob = 0.75 + 0.25 * Math.sin(i * 0.9) * rnd();
      const r = Math.max(0.03, env * wob);
      rms.push(Math.min(255, Math.round(r * 230)));
      peaks.push(Math.min(255, Math.round(Math.min(1, r * (1.15 + rnd() * 0.5)) * 255)));
    }
    return { duration: dur, bpm: rnd() > 0.2 ? Math.round(70 + rnd() * 90) : null, peaks, rms };
  }
  const names = ['Overture of Storms', "Death Note - L's Theme", 'Bach - Preludio Suite 1 Cello', 'Mahler - Adagietto Sinfonía 5', 'Chopin - Nocturno Op.9 No.2', 'Libertango', 'Type Beat Dark Trap 140', 'FMAB - Brothers', 'Zelda - Gerudo Valley', 'Persona 5 - Beneath the Mask', 'Zimmer - Time', 'Oblivion Main Theme', 'Sakura Reflection', 'Beethoven - Claro de Luna', 'Adiós Nonino', 'Cyberpunk Type Beat', 'NieR - Weight of the World', 'Ghibli - Merry-go-round', 'Satie - Gymnopédie 1', "Bloodborne - Hunter's Dream"];
  const artists = ['Death Note', 'Bach', 'Mahler', 'Chopin', 'Piazzolla', 'Nier', 'Zimmer', 'Beethoven', 'Satie', 'Ravel', 'Debussy', 'Vivaldi', 'Hisaishi', 'Uematsu', 'Yoko Kanno', 'Sakamoto', 'Williams'];
  const files = names.map((n, i) => {
    const dur = 90 + Math.floor(rnd() * 200);
    return { id: 'Carpeta/' + n + '.mp3', path: 'mock://' + i + '?d=' + dur, name: n, ext: 'mp3', size: 4e6, mtime: 1700000000 + i * 5000, analysis: i % 4 === 3 ? null : (i === 5 ? { duration: 0, bpm: null, peaks: new Array(800).fill(0), rms: new Array(800).fill(0) } : gen(dur)), _dur: dur };
  });
  const svg = c => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="${c}"/><circle cx="150" cy="85" r="42" fill="#2b2b2e"/><rect x="85" y="135" width="130" height="80" rx="40" fill="#2b2b2e"/></svg>`);
  const lib0 = { version: 1, categories: JSON.parse(JSON.stringify(DEFAULT_CATS)), tracks: {} };
  lib0.categories[0].values = artists;
  lib0.categories[1].values = ['OST anime', 'OST videojuego', 'Académica', 'Tango', 'Type beat'];
  lib0.categories[2].values = ['Tensión', 'Épico', 'Melancolía', 'Calma', 'Misterio', 'Triunfo'];
  lib0.categories[3].values = ['Dramático', 'Motivacional', 'Nostálgico'];
  lib0.categories[4].values = ['Sin reclamo', 'Reclamo TikTok'];
  lib0.categories[5].values = ['Reel político', 'Comercial'];
  files.forEach((f, i) => {
    if (i % 3 === 2) return;
    const tags = { artista: [artists[i % artists.length]], tipo: [lib0.categories[1].values[i % 5]], emocion: [lib0.categories[2].values[i % 6]] };
    if (i % 4 === 0) tags.copyright = ['Reclamo TikTok'];
    lib0.tracks[f.id] = { tags, notes: i === 0 ? 'Arranca suave, explota a los 2:00' : '', fav: i % 5 === 0, moments: [] };
  });
  lib0.tracks[files[1].id].moments = [
    { id: 'a1', start: 42, end: 70.5, label: 'tensión', tags: { emocion: ['Tensión'] } },
    { id: 'a2', start: 100, end: 140, label: 'clímax', tags: { emocion: ['Épico'] } }];
  lib0.tracks[files[3].id] = { tags: {}, notes: '', fav: false, moments: [] };
  lib0.tracks[files[7].id].moments = [{ id: 'b1', start: 192, end: 220, label: 'clímax', tags: { emocion: ['Épico', 'Triunfo'] } }];
  const st = { folder: 'C:\\Musica (prueba)', files, photos: [{ key: 'death note', path: svg('#c9bfa6') }, { key: 'bach', path: svg('#9d9788') }], library: lib0, pending: files.filter(f => !f.analysis).length };
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
    files.filter(f => !f.analysis).forEach((f, k) => setTimeout(() => { const a = gen(f._dur); f.analysis = a; emit('analysis', { id: f.id, analysis: a }); }, 1500 + k * 1200));
    setTimeout(() => emit('analysis_done', {}), 1500 + 5 * 1200 + 300);
  }, 100);
  return {
    invoke: async (cmd, args) => {
      if (cmd === 'get_state' || cmd === 'rescan' || cmd === 'pick_folder') return JSON.parse(JSON.stringify(st));
      if (cmd === 'save_library') { console.log('[mock] save_library', Object.keys(args.library.tracks).length, 'tracks'); return null; }
      if (cmd === 'start_drag') { console.log('[mock] start_drag', args.path); return null; }
      if (cmd === 'drag_fragment') { console.log('[mock] drag_fragment', args.id, args.start, args.end); if (args.id === files[1].id) throw 'NEEDS_WAV'; return null; }
      if (cmd === 'save_fragment_wav') { console.log('[mock] save_fragment_wav', args.id, args.start, args.end, 'b64 len', args.data.length); return null; }
      if (cmd === 'save_analysis') { console.log('[mock] save_analysis', args.id, args.analysis.duration, args.analysis.peaks.length); return null; }
      if (cmd === 'reveal') { console.log('[mock] reveal', args.path); return null; }
      throw new Error('comando desconocido ' + cmd);
    },
    convertFileSrc: p => { const m = /d=(\d+)/.exec(p); return m ? wavURL(+m[1]) : p; },
    listen: async (n, cb) => { (listeners[n] = listeners[n] || []).push(cb); return () => { }; },
  };
}
