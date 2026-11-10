import { openMBTiles } from './mbtiles.js';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota/private mode */ } },
};

// ───────────────────────── Archivio mappe (IndexedDB) ─────────────────────────
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('trekmap', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('maps', { keyPath: 'id', autoIncrement: true });
      r.result.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbRun(stores, mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }).catch(rej);
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error || new Error('Operazione sul database fallita'));
  });
}
const reqP = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
const listMaps = () => dbRun(['maps'], 'readonly', (t) => reqP(t.objectStore('maps').getAll()));
const getBlob = (id) => dbRun(['blobs'], 'readonly', (t) => reqP(t.objectStore('blobs').get(id)));
function saveMap(file, info) {
  return dbRun(['maps', 'blobs'], 'readwrite', async (t) => {
    const id = await reqP(t.objectStore('maps').add({
      name: info.name || file.name.replace(/\.mbtiles$/i, ''), file: file.name, size: file.size,
      info, added: Date.now(),
    }));
    t.objectStore('blobs').put(file, id);
    return id;
  });
}
function deleteMap(id) {
  return dbRun(['maps', 'blobs'], 'readwrite', (t) => { t.objectStore('maps').delete(id); t.objectStore('blobs').delete(id); });
}

// ───────────────────────── Geometria ─────────────────────────
const lon2x = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
const lat2y = (lat, z) => {
  const s = Math.sin((clamp(lat, -85, 85) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
};
const x2lon = (x, z) => (x / (256 * 2 ** z)) * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / (256 * 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
function dist(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const totalDist = (pts) => { let d = 0; for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]); return d; };
function elevGain(pts, th = 4) {
  let g = 0, ref = null;
  for (const p of pts) {
    if (p[2] == null) continue;
    if (ref == null) { ref = p[2]; continue; }
    if (p[2] - ref >= th) { g += p[2] - ref; ref = p[2]; } else if (ref - p[2] >= th) ref = p[2];
  }
  return g;
}

// ───────────────────────── Stato ─────────────────────────
let W = 0, H = 0, dpr = 1;
const view = store.get('trekmap.view', { lon: 12.5, lat: 42.5, z: 5 });
let cur = null;            // { id, api, info }
let zoomMin = 0, zoomMax = 18;
let me = null;             // { lat, lon, acc }
let follow = false;
let gpsOn = false, watchId = null;
let recording = false;
let track = store.get('trekmap.track', []);   // [lat, lon, ele, time]
let imported = [];                             // [[ [lat,lon], ... ], ...]
let wake = null;

// ───────────────────────── Cache tile ─────────────────────────
const cache = new Map();
let inflight = 0, gen = 0;
const key = (z, x, y) => `${z}/${x}/${y}`;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function getTile(z, x, y) {
  const k = key(z, x, y);
  const v = cache.get(k);
  if (v === undefined) loadTile(z, x, y);
  return v;
}
async function loadTile(z, x, y) {
  if (!cur || inflight >= 6) return;
  const k = key(z, x, y), g = gen, api = cur.api;
  cache.set(k, 'loading');
  inflight++;
  try {
    const data = await api.getTile(z, x, y);
    let v = null;
    if (data) v = await createImageBitmap(new Blob([data], { type: MIME[api.info.format] || '' }));
    if (g !== gen) { v && v.close(); return; }
    cache.set(k, v);
    if (cache.size > 500) {
      for (const [kk, vv] of cache) {
        if (cache.size <= 400) break;
        if (vv !== 'loading') { vv && vv.close && vv.close(); cache.delete(kk); }
      }
    }
  } catch {
    if (g === gen) cache.set(k, null);
  } finally {
    inflight--;
    if (g === gen) requestDraw();
  }
}

// ───────────────────────── Disegno ─────────────────────────
let pending = false;
function requestDraw() { if (!pending) { pending = true; requestAnimationFrame(draw); } }

function draw() {
  pending = false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(0, 0, W, H);
  if (cur) drawTiles();
  drawOverlays();
}

function drawTiles() {
  const { minzoom, maxzoom } = cur.api.info;
  const tz = clamp(Math.round(view.z), minzoom, maxzoom);
  const scale = 2 ** (view.z - tz), size = 256 * scale;
  const cx = lon2x(view.lon, tz), cy = lat2y(view.lat, tz);
  const n = 2 ** tz;
  const x0 = Math.max(0, Math.floor((cx - W / 2 / scale) / 256)), x1 = Math.min(n - 1, Math.floor((cx + W / 2 / scale) / 256));
  const y0 = Math.max(0, Math.floor((cy - H / 2 / scale) / 256)), y1 = Math.min(n - 1, Math.floor((cy + H / 2 / scale) / 256));
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const sx = (tx * 256 - cx) * scale + W / 2, sy = (ty * 256 - cy) * scale + H / 2;
      const b = getTile(tz, tx, ty);
      if (b instanceof ImageBitmap) { ctx.drawImage(b, sx, sy, size + 0.5, size + 0.5); continue; }
      if (b === null) continue; // fuori dalla zona coperta dalla mappa
      // in caricamento: mostra intanto il tile "genitore" ingrandito
      for (let d = 1; d <= 4 && tz - d >= 0; d++) {
        const pb = cache.get(key(tz - d, tx >> d, ty >> d));
        if (pb instanceof ImageBitmap) {
          const ss = 256 / 2 ** d;
          ctx.drawImage(pb, (tx - ((tx >> d) << d)) * ss, (ty - ((ty >> d) << d)) * ss, ss, ss, sx, sy, size + 0.5, size + 0.5);
          break;
        }
      }
    }
  }
}

function drawOverlays() {
  const z = view.z, cx = lon2x(view.lon, z), cy = lat2y(view.lat, z);
  const sp = (lat, lon) => [lon2x(lon, z) - cx + W / 2, lat2y(lat, z) - cy + H / 2];
  const line = (pts, color, w) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = sp(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff'; ctx.lineWidth = w + 3; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
  };
  for (const seg of imported) line(seg, '#1565c0', 4);
  line(track, '#e53935', 4);
  if (me) {
    const [x, y] = sp(me.lat, me.lon);
    const mpp = (156543.03392 * Math.cos((me.lat * Math.PI) / 180)) / 2 ** z;
    const r = Math.max(10, (me.acc || 0) / mpp);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = 'rgba(33,150,243,.15)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 6.5, 0, 7); ctx.fillStyle = '#1e88e5'; ctx.fill();
  }
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  requestDraw();
}
addEventListener('resize', resize);
resize();

// ───────────────────────── Gesti ─────────────────────────
function setCenterFromWorld(cx, cy) {
  view.lon = clamp(x2lon(cx, view.z), -180, 180);
  view.lat = clamp(y2lat(cy, view.z), -85, 85);
}
function pan(dx, dy) {
  setCenterFromWorld(lon2x(view.lon, view.z) - dx, lat2y(view.lat, view.z) - dy);
}
function zoomAt(px, py, nz) {
  const z0 = view.z;
  const wx = lon2x(view.lon, z0) + (px - W / 2), wy = lat2y(view.lat, z0) + (py - H / 2);
  const lon = x2lon(wx, z0), lat = y2lat(wy, z0);
  view.z = clamp(nz, zoomMin, zoomMax);
  setCenterFromWorld(lon2x(lon, view.z) - (px - W / 2), lat2y(lat, view.z) - (py - H / 2));
}
const ptrs = new Map();
let g = null, lastTap = 0;
const mid = () => { const [a, b] = [...ptrs.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  g = { t: Date.now(), moved: 0, m: ptrs.size === 2 ? mid() : null, n: ptrs.size };
});
canvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p || !g) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  g.moved += Math.abs(dx) + Math.abs(dy);
  if (ptrs.size === 1) pan(dx, dy);
  else if (ptrs.size === 2) {
    const m = mid();
    if (g.m) { pan(m.x - g.m.x, m.y - g.m.y); zoomAt(m.x, m.y, view.z + Math.log2(m.d / g.m.d)); }
    g.m = m;
  }
  if (g.moved > 6 && follow) { follow = false; syncUi(); }
  requestDraw();
});
const endPtr = (e) => {
  ptrs.delete(e.pointerId);
  if (ptrs.size === 1) g.m = null;
  if (ptrs.size === 0 && g) {
    if (g.n === 1 && g.moved < 8 && Date.now() - g.t < 300) {
      if (Date.now() - lastTap < 350) { zoomAt(e.clientX, e.clientY, view.z + 1); lastTap = 0; requestDraw(); }
      else lastTap = Date.now();
    }
    store.set('trekmap.view', view);
    g = null;
  }
};
canvas.addEventListener('pointerup', endPtr);
canvas.addEventListener('pointercancel', endPtr);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, view.z - e.deltaY * 0.0025);
  store.set('trekmap.view', view);
  requestDraw();
}, { passive: false });

// ───────────────────────── Interfaccia ─────────────────────────
function toast(text, ms = 4000) {
  const m = $('msg');
  m.textContent = text; m.classList.add('on');
  clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => m.classList.remove('on'), ms);
}
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const fmtKm = (m) => (m / 1000).toFixed(2);
const fmtMb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function syncUi() {
  $('bGps').classList.toggle('on', gpsOn);
  $('bRec').classList.toggle('on', recording);
  $('bRec').lastChild.textContent = recording ? 'Stop' : 'Registra';
  $('recenter').classList.toggle('on', gpsOn && !follow);
  $('empty').style.display = cur ? 'none' : 'flex';
  const show = recording || track.length > 1;
  $('stats').classList.toggle('on', show);
  if (show) {
    const el = track.length > 1 ? Math.max(0, (track[track.length - 1][3] - track[0][3]) / 1000) : 0;
    const t = `${Math.floor(el / 3600)}:${String(Math.floor((el % 3600) / 60)).padStart(2, '0')}`;
    $('stats').innerHTML = `${recording ? '<span class="rec">●</span>' : ''}${fmtKm(totalDist(track))} km · +${Math.round(elevGain(track))} m · ${t} h`;
  }
}
setInterval(() => { if (recording) syncUi(); }, 5000);

async function openMap(id) {
  const blob = await getBlob(id);
  if (!blob) throw new Error('Mappa non trovata nella memoria dell\'app');
  const api = await openMBTiles(blob);
  gen++; cache.clear();
  cur = { id, api };
  const i = api.info;
  zoomMin = Math.max(0, i.minzoom - 2); zoomMax = Math.min(22, i.maxzoom + 3);
  const inside = i.bounds && view.lon >= i.bounds[0] && view.lon <= i.bounds[2] && view.lat >= i.bounds[1] && view.lat <= i.bounds[3];
  if (!inside) {
    if (i.center) { view.lon = i.center[0]; view.lat = i.center[1]; view.z = i.center[2] ?? i.minzoom; }
    else if (i.bounds) { view.lon = (i.bounds[0] + i.bounds[2]) / 2; view.lat = (i.bounds[1] + i.bounds[3]) / 2; view.z = i.minzoom + 2; }
  }
  view.z = clamp(view.z, i.minzoom, i.maxzoom); // all'apertura mai oltre il dettaglio reale della mappa
  store.set('trekmap.map', id); store.set('trekmap.view', view);
  syncUi(); requestDraw();
}

const sheet = $('sheet'), card = $('card');
const closeSheet = () => sheet.classList.remove('on');
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

async function showMaps() {
  const maps = await listMaps();
  const hint = isIos && !standalone
    ? `<p class="hint"><b>Per usarla offline:</b> in Safari tocca Condividi <b>⎋</b> → <b>Aggiungi alla schermata Home</b>, poi aprila da lì.</p>` : '';
  card.innerHTML = `<h2>Mappe offline <span data-a="close">×</span></h2>
    <button class="primary" data-a="addmap"><span class="i">＋</span> Aggiungi mappa (.mbtiles)</button>
    ${maps.length ? maps.map((m) => `<div class="item ${cur && cur.id === m.id ? 'sel' : ''}" data-a="open" data-id="${m.id}">
        <div class="n"><b>${esc(m.name)}</b><small>${fmtMb(m.size)}${m.info ? ` · zoom ${m.info.minzoom}–${m.info.maxzoom}` : ''}</small></div>
        <button class="del" data-a="del" data-id="${m.id}">🗑️</button></div>`).join('')
      : '<p class="hint">Nessuna mappa salvata. Scegli un file .mbtiles dai File del tuo iPhone: resta salvato nell\'app e funziona senza rete.</p>'}
    <p class="hint">Sono supportate mappe <b>raster</b> (png, jpg, webp).</p>${hint}`;
  sheet.classList.add('on');
}
function showTracks() {
  const n = track.length;
  card.innerHTML = `<h2>Tracce GPX <span data-a="close">×</span></h2>
    <button class="primary" data-a="importgpx"><span class="i">⬇︎</span> Importa un percorso GPX</button>
    ${imported.length ? `<div class="item"><div class="n"><b>Percorso importato</b><small>${fmtKm(imported.reduce((s, x) => s + totalDist(x), 0))} km · in blu sulla mappa</small></div><button class="del" data-a="hidegpx">Nascondi</button></div>` : ''}
    <div class="item"><div class="n"><b>Traccia registrata</b><small>${n > 1 ? `${fmtKm(totalDist(track))} km · +${Math.round(elevGain(track))} m · ${n} punti` : 'Nessuna traccia. Premi Registra per iniziare.'}</small></div></div>
    ${n > 1 ? `<button class="primary" data-a="export"><span class="i">⬆︎</span> Esporta / condividi GPX</button>
    <button class="primary" style="background:var(--red)" data-a="cleartrack">Cancella traccia registrata</button>` : ''}`;
  sheet.classList.add('on');
}

card.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a, id = Number(el.dataset.id);
  if (a === 'close') closeSheet();
  else if (a === 'addmap') $('fileMap').click();
  else if (a === 'importgpx') $('fileGpx').click();
  else if (a === 'open') {
    try { toast('Apro la mappa…', 0); await openMap(id); closeSheet(); toast('Mappa aperta', 1500); }
    catch (err) { toast(err.message, 7000); }
  } else if (a === 'del') {
    e.stopPropagation();
    if (!confirm('Eliminare questa mappa dall\'app?')) return;
    await deleteMap(id);
    if (cur && cur.id === id) { cur = null; gen++; cache.clear(); store.set('trekmap.map', null); syncUi(); requestDraw(); }
    showMaps();
  } else if (a === 'hidegpx') { imported = []; requestDraw(); showTracks(); }
  else if (a === 'export') exportTrack();
  else if (a === 'cleartrack') {
    if (!confirm('Cancellare la traccia registrata? Se non l\'hai esportata la perdi.')) return;
    track = []; store.set('trekmap.track', track); syncUi(); requestDraw(); showTracks();
  }
});

$('fileMap').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    toast('Controllo il file…', 0);
    const api = await openMBTiles(file);            // validazione prima di salvare
    toast(`Salvo la mappa (${fmtMb(file.size)})… può volerci un po'.`, 0);
    try { await navigator.storage?.persist?.(); } catch { /* ignora */ }
    const id = await saveMap(file, api.info);
    await openMap(id);
    closeSheet();
    toast('Mappa pronta: ora funziona anche senza rete.', 4000);
  } catch (err) {
    const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message)));
    toast(quota ? 'Spazio insufficiente: libera memoria sul telefono o usa una mappa più piccola.' : (err.message || String(err)), 9000);
  }
});

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('File GPX non valido');
  const pick = (nodes) => [...nodes].map((n) => [parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon'))]).filter((p) => isFinite(p[0]) && isFinite(p[1]));
  let segs = [...doc.getElementsByTagName('trkseg')].map((s) => pick(s.getElementsByTagName('trkpt')));
  if (!segs.some((s) => s.length > 1)) segs = [...doc.getElementsByTagName('rte')].map((r) => pick(r.getElementsByTagName('rtept')));
  return segs.filter((s) => s.length > 1);
}
$('fileGpx').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const segs = parseGpx(await file.text());
    if (!segs.length) throw new Error('Nel file non ho trovato nessun percorso.');
    imported = segs;
    const all = segs.flat();
    const la = all.map((p) => p[0]), lo = all.map((p) => p[1]);
    const [s, n, w, ea] = [Math.min(...la), Math.max(...la), Math.min(...lo), Math.max(...lo)];
    view.lat = (s + n) / 2; view.lon = (w + ea) / 2;
    let z = zoomMax;
    while (z > zoomMin && (lon2x(ea, z) - lon2x(w, z) > W * 0.8 || lat2y(s, z) - lat2y(n, z) > H * 0.6)) z -= 0.25;
    view.z = z;
    follow = false; closeSheet(); syncUi(); requestDraw();
    toast('Percorso caricato (linea blu).', 3000);
  } catch (err) { toast(err.message || String(err), 6000); }
});

// ───────────────────────── GPS e registrazione ─────────────────────────
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wake) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) { await wake.release(); wake = null; }
  } catch { /* non supportato */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && gpsOn) keepAwake(true);
  if (document.visibilityState === 'hidden') store.set('trekmap.track', track);
});

function onPos(p) {
  const c = p.coords;
  me = { lat: c.latitude, lon: c.longitude, acc: c.accuracy };
  if (follow) { view.lat = me.lat; view.lon = me.lon; }
  if (recording && (c.accuracy == null || c.accuracy <= 50)) {
    const pt = [c.latitude, c.longitude, c.altitude == null ? null : Math.round(c.altitude * 10) / 10, p.timestamp];
    if (!track.length || dist(track[track.length - 1], pt) >= 5) {
      track.push(pt);
      if (track.length % 5 === 0) store.set('trekmap.track', track);
      syncUi();
    }
  }
  requestDraw();
}
function onGpsErr(err) {
  const m = { 1: 'Permesso di posizione negato. Su iPhone: Impostazioni → Privacy → Servizi di localizzazione → Safari/TrekMap.', 2: 'Posizione non disponibile.', 3: 'Il GPS non risponde, riprovo…' };
  toast(m[err.code] || 'Errore GPS', 6000);
  if (err.code === 1) stopGps();
}
function startGps() {
  if (!('geolocation' in navigator)) { toast('Questo dispositivo non ha il GPS.', 5000); return; }
  gpsOn = true; follow = true;
  watchId = navigator.geolocation.watchPosition(onPos, onGpsErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
  if (me) { view.lat = me.lat; view.lon = me.lon; view.z = Math.max(view.z, Math.min(15, zoomMax)); }
  keepAwake(true); syncUi(); requestDraw();
}
function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; gpsOn = false; follow = false; me = null;
  if (recording) { recording = false; }
  keepAwake(false); syncUi(); requestDraw();
}

$('bGps').onclick = () => (gpsOn ? stopGps() : startGps());
$('recenter').onclick = () => {
  follow = true;
  if (me) { view.lat = me.lat; view.lon = me.lon; if (view.z < 13) view.z = Math.min(15, zoomMax); }
  syncUi(); requestDraw();
};
$('bRec').onclick = () => {
  if (recording) {
    recording = false; store.set('trekmap.track', track); syncUi();
    if (track.length > 1) exportTrack(); // aprire il foglio di condivisione dentro il tocco
    return;
  }
  if (track.length > 1 && !confirm('Esiste già una traccia non esportata.\nOK = ricomincia da zero · Annulla = continua quella')) { /* continua */ }
  else track = [];
  recording = true;
  if (!gpsOn) startGps();
  toast('Registrazione avviata. Tieni l\'app aperta: su iPhone il GPS si ferma a schermo spento.', 6000);
  syncUi();
};
$('bMaps').onclick = showMaps;
$('bGpx').onclick = showTracks;

function buildGpx(name) {
  const esc2 = (s) => s.replace(/[<&>]/g, '');
  const pts = track.map((p) => `      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}<time>${new Date(p[3]).toISOString()}</time></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="TrekMap" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk>\n    <name>${esc2(name)}</name>\n    <trkseg>\n${pts}\n    </trkseg>\n  </trk>\n</gpx>\n`;
}
async function exportTrack() {
  if (track.length < 2) return;
  const d = new Date(track[0][3]);
  const name = `traccia-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const file = new File([buildGpx(name)], `${name}.gpx`, { type: 'application/gpx+xml' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (err) { if (err && err.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ───────────────────────── Avvio ─────────────────────────
(async () => {
  try {
    const last = store.get('trekmap.map', null);
    const maps = await listMaps();
    const m = maps.find((x) => x.id === last) || maps[0];
    if (m) await openMap(m.id);
  } catch (err) { toast(err.message || String(err), 6000); }
  syncUi(); requestDraw();
  if (!cur) $('emptyText').innerHTML = 'Nessuna mappa caricata. Tocca <b>Mappe</b> e aggiungi un file <b>.mbtiles</b>.' + (isIos && !standalone ? '<br><br>Consiglio: <b>Condividi → Aggiungi alla schermata Home</b>, così funziona anche senza rete.' : '');
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
