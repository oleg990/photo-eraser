'use strict';
/* Фото-Ластик v2: улучшение света/цвета + удаление предметов (LaMa) прямо в браузере телефона. */

const MAX_EDGE = 2560;               // длинная сторона рабочего фото (хватает для Авито/ЦИАН/VK)
const MODEL_URL = 'models/lama_fp32.onnx';
const LAMA = 512;                    // вход модели 512x512
const Q = new URLSearchParams(location.search);
const MOCK = Q.has('mock');          // режим проверки без модели
const AUTO_ERASE_DELAY = 900;        // мс после последнего мазка
const DET_URL = 'models/detector.onnx', DET_CLASSES_URL = 'models/detector_classes.json', DET = 640;
// группы для авто-уборки; слова — классы детектора (setup.py --auto экспортирует модель с ними)
const GROUPS = [
  { id: 'people', ru: 'Люди', words: ['person'] },
  { id: 'shoes', ru: 'Обувь', words: ['shoes', 'slippers', 'boots'] },
  { id: 'clothes', ru: 'Одежда, полотенца', words: ['clothes', 'towel', 'laundry', 'jacket'] },
  { id: 'bags', ru: 'Сумки, пакеты', words: ['bag', 'backpack', 'plastic bag', 'suitcase'] },
  { id: 'bottles', ru: 'Бутылки, посуда, косметика', words: ['bottle', 'cup', 'dish', 'shampoo bottle', 'cosmetics'] },
  { id: 'boxes', ru: 'Коробки, мусор', words: ['box', 'cardboard box', 'trash', 'garbage bag'] },
  { id: 'misc', ru: 'Провода, игрушки, уборка', words: ['cable', 'toy', 'broom', 'bucket', 'mop'] },
];

const $ = (id) => document.getElementById(id);
const stage = $('stage'), wrap = $('wrap'), maskCv = $('mask'), origImg = $('orig'), detCv = $('dets');
const manCv = document.createElement('canvas');   // ручные мазки (маска = мазки + включённые рамки)

/* ---------- настройки (запоминаются) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('pe_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pe_' + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
};
const S = {
  photos: [], cur: -1, mode: 'view', zoom: 1, px: 0, py: 0, fit: 1, ox: 0, oy: 0, busy: false,
  sess: null, sessP: null, engine: '',
  brush: store.get('brush', 40), autoEnh: store.get('autoEnh', true), autoErase: store.get('autoErase', true), gpu: store.get('gpu', false) || Q.has('gpu'),
  fullAuto: store.get('fullAuto', false), groups: store.get('groups', GROUPS.map((g) => g.id)), det: null, detP: null, cancel: false,
};

/* ---------- служебное ---------- */
function log(...a) { const el = $('log'); el.classList.add('on'); el.textContent += a.join(' ') + '\n'; el.scrollTop = 1e9; }
function status(t, cls) { const s = $('status'); s.textContent = t; s.className = cls || ''; }
function progress(p) { document.querySelector('#progress i').style.width = (clamp(p, 0, 1) * 100) + '%'; }
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let busyTimer = null;
function busy(on, text, stoppable) {
  S.busy = on; $('busy').classList.toggle('on', on);
  if (!on) $('stop').classList.remove('on'); else if (stoppable !== undefined) $('stop').classList.toggle('on', !!stoppable);
  clearInterval(busyTimer);
  if (on && text) {
    const t0 = Date.now(); $('busyText').textContent = text;
    busyTimer = setInterval(() => { const s = ((Date.now() - t0) / 1000) | 0; if (s >= 2) $('busyText').textContent = `${text} ${s} с`; }, 500);
  }
  updateButtons();
}
window.addEventListener('error', (e) => { status('Ошибка: ' + e.message, 'err'); log('ERR', e.message, (e.filename || '') + ':' + (e.lineno || '')); busy(false); });
window.addEventListener('unhandledrejection', (e) => { const m = (e.reason && e.reason.message) || String(e.reason); status('Ошибка: ' + m, 'err'); log('REJ', m); busy(false); });
const cur = () => S.photos[S.cur];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ctx2d = (cv) => cv.getContext('2d', { willReadFrequently: true });
const toBlob = (cv, q = 0.92) => new Promise((r) => cv.toBlob(r, 'image/jpeg', q));

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Не найден файл ' + src + '. Запустите setup.py (см. README)')); document.head.appendChild(s); });
}

/* ---------- загрузка фото ---------- */
async function readImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* старые Safari */ }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
  if (!list.length) return;
  const first = S.photos.length;
  busy(true, 'Загружаю фото…');
  for (let i = 0; i < list.length; i++) {
    $('busyText').textContent = `Загружаю ${i + 1} из ${list.length}…`; await tick();
    const bmp = await readImage(list[i]);
    const w0 = bmp.width, h0 = bmp.height, k = Math.min(1, MAX_EDGE / Math.max(w0, h0));
    const cv = document.createElement('canvas');
    cv.width = Math.round(w0 * k); cv.height = Math.round(h0 * k);
    const c = ctx2d(cv); c.imageSmoothingQuality = 'high'; c.drawImage(bmp, 0, 0, cv.width, cv.height);
    if (bmp.close) bmp.close();
    const p = { name: (list[i].name || 'photo').replace(/\.[^.]+$/, ''), canvas: cv, undo: [], enhanced: false, origURL: '' };
    p.origURL = URL.createObjectURL(await toBlob(cv, 0.9));   // оригинал для «До/после», почти не занимает памяти
    if (S.autoEnh) { $('busyText').textContent = `Улучшаю ${i + 1} из ${list.length}…`; await tick(); enhanceCanvas(cv); p.enhanced = true; }
    S.photos.push(p);
  }
  busy(false);
  select(first);
  status(S.autoEnh ? `Фото: ${S.photos.length}. Свет и цвет улучшены` : `Фото: ${S.photos.length}`, S.autoEnh ? 'ok' : '');
  if (S.fullAuto) await autoCleanMany(S.photos.slice(first));
  else warmup();
}

function thumb(p) {
  const t = document.createElement('canvas'), k = 108 / Math.max(p.canvas.width, p.canvas.height);
  t.width = Math.round(p.canvas.width * k); t.height = Math.round(p.canvas.height * k);
  t.getContext('2d').drawImage(p.canvas, 0, 0, t.width, t.height);
  p.thumb = t.toDataURL('image/jpeg', 0.7);
}
function renderStrip(changed) {
  if (changed) thumb(changed);
  const st = $('strip'); st.innerHTML = '';
  S.photos.forEach((p, i) => {
    if (!p.thumb) thumb(p);
    const b = document.createElement('button');
    b.style.backgroundImage = `url(${p.thumb})`;
    if (i === S.cur) b.classList.add('cur');
    if (p.enhanced) b.classList.add('done');
    b.onclick = () => { if (!S.busy) select(i); };
    st.appendChild(b);
  });
  const cb = st.children[S.cur]; if (cb && cb.scrollIntoView) cb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function select(i) {
  if (i < 0 || i >= S.photos.length) return;
  cancelAutoErase();
  S.cur = i;
  const p = cur();
  [...wrap.querySelectorAll('canvas:not(#mask):not(#dets)')].forEach((c) => c.remove());
  wrap.insertBefore(p.canvas, origImg);
  origImg.src = p.origURL;
  maskCv.width = manCv.width = detCv.width = p.canvas.width; maskCv.height = manCv.height = detCv.height = p.canvas.height;
  renderMask();
  $('empty').style.display = 'none';
  fitView(); renderStrip(); updateButtons();
}

/* ---------- масштаб/перемещение ---------- */
function fitView() {
  const p = cur(); if (!p) return;
  const sw = stage.clientWidth, sh = stage.clientHeight, W = p.canvas.width, H = p.canvas.height;
  S.fit = Math.min(sw / W, sh / H);
  wrap.style.width = W * S.fit + 'px'; wrap.style.height = H * S.fit + 'px';
  S.ox = (sw - W * S.fit) / 2; S.oy = (sh - H * S.fit) / 2;
  S.zoom = 1; S.px = S.ox; S.py = S.oy; applyView();
}
function applyView() { wrap.style.transform = `translate(${S.px}px,${S.py}px) scale(${S.zoom})`; }
function zoomAt(mx, my, nz) {
  nz = clamp(nz, 1, 8);
  S.px = mx - (mx - S.px) * (nz / S.zoom); S.py = my - (my - S.py) * (nz / S.zoom); S.zoom = nz;
  if (nz === 1) { S.px = S.ox; S.py = S.oy; }
  applyView();
}
window.addEventListener('resize', () => { if (cur()) fitView(); });

/* ---------- кисть ---------- */
const ptrs = new Map(); let stroke = null, pinch = null, eraseTimer = null, lastTap = 0;
function toImg(e) {
  const r = wrap.getBoundingClientRect(), p = cur();
  return { x: (e.clientX - r.left) / r.width * p.canvas.width, y: (e.clientY - r.top) / r.height * p.canvas.height, k: p.canvas.width / r.width };
}
function cancelAutoErase() { clearTimeout(eraseTimer); eraseTimer = null; }
stage.addEventListener('pointerdown', (e) => {
  if (!cur() || S.busy) return;
  cancelAutoErase();
  stage.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2) { stroke = null; pinch = null; return; }
  if (ptrs.size === 1 && S.mode === 'brush') {
    const q = toImg(e), hit = detAt(q.x, q.y);
    if (hit) { stroke = { toggle: hit, moved: false, x: q.x, y: q.y, lx: q.x, ly: q.y, r: 0, t: Date.now() }; return; }
    stroke = { lx: q.x, ly: q.y, x: q.x, y: q.y, r: S.brush / 2 * q.k, moved: false, t: Date.now() };
    for (const c of [maskCv.getContext('2d'), manCv.getContext('2d')]) { c.fillStyle = '#ff2d2d'; c.beginPath(); c.arc(q.x, q.y, S.brush / 2 * q.k, 0, 7); c.fill(); }
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const sr = stage.getBoundingClientRect();
    if (pinch) { S.px += mx - pinch.mx; S.py += my - pinch.my; zoomAt(mx - sr.left, my - sr.top, S.zoom * d / pinch.d); }
    pinch = { d, mx, my }; return;
  }
  if (stroke && stroke.toggle) {
    const q = toImg(e); if (Math.hypot(q.x - stroke.x, q.y - stroke.y) > 12 * q.k) stroke.moved = true;
  } else if (stroke) {
    const q = toImg(e);
    for (const c of [maskCv.getContext('2d'), manCv.getContext('2d')]) {
      c.strokeStyle = '#ff2d2d'; c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = S.brush * q.k;
      c.beginPath(); c.moveTo(stroke.lx, stroke.ly); c.lineTo(q.x, q.y); c.stroke();
    }
    stroke.lx = q.x; stroke.ly = q.y; stroke.moved = true;
  } else if (S.mode === 'view' && ptrs.size === 1 && S.zoom > 1 && e.movementX !== undefined) {
    S.px += e.movementX; S.py += e.movementY; applyView();
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  const wasPinch = ptrs.size >= 2;
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (!ptrs.size) {
    const now = Date.now();
    // двойной тап — вернуть весь кадр (точку от первого тапа стираем)
    if (stroke && stroke.toggle) {   // тап по рамке: убирать / не убирать этот предмет
      if (!stroke.moved) { stroke.toggle.on = !stroke.toggle.on; renderMask(); detStatus(); }
      stroke = null; lastTap = 0; return;
    }
    const isDot = !stroke || !stroke.moved;
    if (stroke && !stroke.moved) { dots.push(stroke); if (dots.length > 2) dots.shift(); }
    if (!wasPinch && isDot && now - lastTap < 320) { lastTap = 0; eraseDots(); fitView(); stroke = null; return; }
    lastTap = isDot && !wasPinch ? now : 0;
    if (stroke) scheduleAutoErase();
    stroke = null;
  }
}
stage.addEventListener('pointerup', endPtr); stage.addEventListener('pointercancel', endPtr);
stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, S.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });

// точки от двойного тапа (тап-тап = «весь кадр») убираем из маски
let dots = [];
function eraseDots() {
  const c = manCv.getContext('2d'); c.save(); c.globalCompositeOperation = 'destination-out';
  const now = Date.now();
  for (const d of dots) { if (now - d.t > 1000) continue; c.beginPath(); c.arc(d.x, d.y, d.r + 2, 0, 7); c.fill(); }
  c.restore(); dots = []; renderMask();
}
function scheduleAutoErase() {
  if (!S.autoErase || S.mode !== 'brush') return;
  if (cur() && cur().dets && cur().dets.length) return;   // пока проверяют найденное — ждём кнопку «Стереть»
  cancelAutoErase();
  eraseTimer = setTimeout(() => { eraseTimer = null; if (!ptrs.size && !S.busy) runErase(); }, AUTO_ERASE_DELAY);
}

function setMode(m) {
  S.mode = m; $('brush').classList.toggle('on', m === 'brush');
  $('brushTools').classList.toggle('on', m === 'brush');
  syncEraseBtn();
  if (m === 'brush') { if (!(cur() && cur().dets && cur().dets.length)) status(S.autoErase ? 'Закрасьте лишнее — сотрётся само' : 'Закрасьте лишнее и нажмите «Стереть»'); warmup(); }
  else { clearMask(); cancelAutoErase(); }
  setTimeout(() => { if (cur()) fitView(); }, 0);
}
function clearMask() {
  manCv.getContext('2d').clearRect(0, 0, manCv.width, manCv.height); dots = [];
  if (cur()) cur().dets = [];
  renderMask();
}
function syncEraseBtn() { const hasDets = !!(cur() && cur().dets && cur().dets.length); $('doErase').style.display = S.autoErase && !hasDets ? 'none' : ''; }

/* ---------- маска и рамки найденного ---------- */
function detRect(d, W, H) {   // рамка с запасом, чтобы край предмета точно попал в маску
  const px = Math.max(6, d.w * 0.1), py = Math.max(6, d.h * 0.1);
  const x = clamp(d.x - px, 0, W), y = clamp(d.y - py, 0, H);
  return { x, y, w: clamp(d.x + d.w + px, 0, W) - x, h: clamp(d.y + d.h + py, 0, H) - y };
}
function roundRect(c, r) { const rad = Math.min(r.w, r.h) * 0.25; c.beginPath(); if (c.roundRect) c.roundRect(r.x, r.y, r.w, r.h, rad); else c.rect(r.x, r.y, r.w, r.h); }
function renderMask() {
  const p = cur(), c = maskCv.getContext('2d'), dc = detCv.getContext('2d');
  c.clearRect(0, 0, maskCv.width, maskCv.height); dc.clearRect(0, 0, detCv.width, detCv.height);
  if (!p) return;
  c.drawImage(manCv, 0, 0);
  const k = Math.max(1, p.canvas.width / 1000);
  for (const d of p.dets || []) {
    const r = detRect(d, p.canvas.width, p.canvas.height);
    if (d.on) { c.fillStyle = '#ff2d2d'; roundRect(c, r); c.fill(); }
    dc.lineWidth = 3 * k; dc.setLineDash(d.on ? [] : [10 * k, 8 * k]); dc.strokeStyle = d.on ? '#ff6b5e' : 'rgba(255,255,255,.85)';
    roundRect(dc, r); dc.stroke();
    dc.setLineDash([]); dc.font = `600 ${15 * k}px -apple-system,sans-serif`;
    const label = (d.on ? '' : 'оставить · ') + d.label, tw = dc.measureText(label).width + 10 * k;
    dc.fillStyle = d.on ? 'rgba(200,30,30,.85)' : 'rgba(0,0,0,.7)'; dc.fillRect(r.x, Math.max(0, r.y - 22 * k), tw, 22 * k);
    dc.fillStyle = '#fff'; dc.fillText(label, r.x + 5 * k, Math.max(0, r.y - 22 * k) + 16 * k);
  }
}
function detAt(x, y) {
  const p = cur(); if (!p || !p.dets) return null;
  let best = null;
  for (const d of p.dets) { const r = detRect(d, p.canvas.width, p.canvas.height); if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && (!best || r.w * r.h < best.a)) best = { d, a: r.w * r.h }; }
  return best && best.d;
}
function detStatus() {
  const p = cur(); if (!p || !p.dets) return;
  const on = p.dets.filter((d) => d.on).length;
  status(on ? `Найдено: ${p.dets.length}, уберу: ${on}. Тап по рамке — оставить. Затем «Стереть»` : 'Всё отмечено «оставить». Можно закрасить кистью или выйти');
}

/* ---------- улучшение света и цвета ---------- */
function lowBlur(Y, W, H, f, rad) {
  const w = Math.ceil(W / f), h = Math.ceil(H / f), a = new Float32Array(w * h), c = new Float32Array(w * h);
  for (let y = 0; y < H; y++) { const ry = Math.min(h - 1, (y / f) | 0); for (let x = 0; x < W; x++) { const i = ry * w + Math.min(w - 1, (x / f) | 0); a[i] += Y[y * W + x]; c[i]++; } }
  for (let i = 0; i < a.length; i++) a[i] /= c[i] || 1;
  const t = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -rad; k <= rad; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += a[y * w + xx]; n++; } } t[y * w + x] = s / n; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -rad; k <= rad; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += t[yy * w + x]; n++; } } a[y * w + x] = s / n; }
  }
  return { a, w, h, f };
}
function sampleLow(L, x, y) {
  const fx = clamp(x / L.f - 0.5, 0, L.w - 1), fy = clamp(y / L.f - 0.5, 0, L.h - 1);
  const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(L.w - 1, x0 + 1), y1 = Math.min(L.h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
  const A = L.a, w = L.w;
  return (A[y0 * w + x0] * (1 - tx) + A[y0 * w + x1] * tx) * (1 - ty) + (A[y1 * w + x0] * (1 - tx) + A[y1 * w + x1] * tx) * ty;
}

function enhanceCanvas(cv) {
  const W = cv.width, H = cv.height, n = W * H, c = ctx2d(cv);
  const img = c.getImageData(0, 0, W, H), d = img.data;
  // 1) мягкий баланс белого по средним тонам
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let i = 0; i < n; i += 7) { const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], m = (r + g + b) / 3; if (m > 40 && m < 215) { sr += r; sg += g; sb += b; cnt++; } }
  if (cnt < 1000) { sr = sg = sb = 1; cnt = 1; for (let i = 0; i < n; i += 7) { sr += d[i * 4]; sg += d[i * 4 + 1]; sb += d[i * 4 + 2]; cnt++; } }
  const mr = sr / cnt, mg = sg / cnt, mb = sb / cnt, avg = (mr + mg + mb) / 3, ST = 0.8;
  const gr = clamp(1 + (avg / mr - 1) * ST, 0.75, 1.35), gg = clamp(1 + (avg / mg - 1) * ST, 0.75, 1.35), gb = clamp(1 + (avg / mb - 1) * ST, 0.75, 1.35);
  const Y = new Float32Array(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const r = Math.min(255, d[i * 4] * gr), g = Math.min(255, d[i * 4 + 1] * gg), b = Math.min(255, d[i * 4 + 2] * gb);
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b;
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; Y[i] = y; hist[Math.min(255, (y * 255) | 0)]++;
  }
  // 2) экспозиция к целевой по медиане
  let acc = 0, med = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) { med = v; break; } }
  const gamma = clamp(Math.log(135 / 255) / Math.log(Math.max(med, 1) / 255), 0.6, 1.25);
  // 3) тоновая кривая: гамма → подсветка теней → S-кривая
  const lut = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const y = i / 1023; let t = Math.pow(y, gamma); t = t + 0.18 * Math.pow(1 - t, 2.2); lut[i] = t + 0.22 * t * (1 - t) * (2 * t - 1) * 2; }
  const T = new Float32Array(n); for (let i = 0; i < n; i++) T[i] = lut[(Y[i] * 1023) | 0];
  // 4) локальный контраст: разница с сильно размытой версией
  const L = lowBlur(T, W, H, 8, 4);
  const Yo = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, t = T[i], loc = clamp(0.35 * (t - sampleLow(L, x, y)), -0.1, 0.1);
    Yo[i] = clamp(t + loc, 0, 1);
  }
  // 5) яркость → цвет, насыщенность не раздуваем при осветлении
  for (let i = 0; i < n; i++) {
    const y0 = Math.max(Y[i], 0.004), s = Math.min(3.2, Yo[i] / y0), yo = Yo[i] * 255, k = i * 4, sat = 0.9 + 0.1 / Math.max(1, s);
    let r = d[k] * s, g = d[k + 1] * s, b = d[k + 2] * s;
    d[k] = yo + (r - yo) * sat; d[k + 1] = yo + (g - yo) * sat; d[k + 2] = yo + (b - yo) * sat;
  }
  // 6) мягкая резкость по яркости
  const tmp = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; tmp[i] = (Yo[y * W + Math.max(0, x - 1)] + Yo[i] + Yo[y * W + Math.min(W - 1, x + 1)]) / 3; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, bl = (tmp[Math.max(0, y - 1) * W + x] + tmp[i] + tmp[Math.min(H - 1, y + 1) * W + x]) / 3, add = 0.4 * (Yo[i] - bl) * 255, k = i * 4;
    d[k] += add; d[k + 1] += add; d[k + 2] += add;
  }
  c.putImageData(img, 0, 0);
}

/* ---------- отмена ---------- */
async function pushUndoFull(p) {   // целый кадр храним как JPEG (~1 МБ вместо 20)
  p.undo.push({ blob: await toBlob(p.canvas, 0.95), enh: p.enhanced });
  trimUndo(p);
}
function pushUndoRect(p, x, y, w, h) {
  p.undo.push({ x, y, data: ctx2d(p.canvas).getImageData(x, y, w, h), enh: p.enhanced });
  trimUndo(p);
}
function trimUndo(p) {
  const budget = 60e6; let sum = 0;
  for (let i = p.undo.length - 1; i >= 0; i--) { const u = p.undo[i]; sum += u.data ? u.data.data.length : u.blob.size; if (sum > budget && i > 0) { p.undo.splice(0, i); break; } }
  if (p.undo.length > 30) p.undo.splice(0, p.undo.length - 30);
}
async function undo() {
  const p = cur(); if (!p || !p.undo.length) return;
  const u = p.undo.pop();
  if (u.data) ctx2d(p.canvas).putImageData(u.data, u.x, u.y);
  else { const bmp = await readImage(u.blob); ctx2d(p.canvas).drawImage(bmp, 0, 0, p.canvas.width, p.canvas.height); if (bmp.close) bmp.close(); }
  p.enhanced = u.enh; renderStrip(p); updateButtons(); status('Отменено');
}

/* ---------- LaMa ---------- */
// модель больше лимита GitHub (100 МБ), поэтому лежит частями: models/lama_fp32.onnx.json + .partNN
async function fetchModel(onProgress) {
  let man = null;
  try { const mr = await fetch(MODEL_URL + '.json', { cache: 'no-cache' }); if (mr.ok) man = await mr.json(); } catch (e) { /* частей нет */ }
  if (man && man.parts) {
    const buf = new Uint8Array(man.size); let got = 0;
    for (let i = 0; i < man.parts; i++) {
      const pr = await fetch(`${MODEL_URL}.part${String(i).padStart(2, '0')}`);
      if (!pr.ok) throw new Error(`Не найдена часть модели ${i + 1} из ${man.parts} (${pr.status}). Запустите setup.py ещё раз`);
      const rd = pr.body && pr.body.getReader ? pr.body.getReader() : null;
      if (!rd) { const b = new Uint8Array(await pr.arrayBuffer()); buf.set(b, got); got += b.length; onProgress(got, man.size); continue; }
      for (;;) { const { done, value } = await rd.read(); if (done) break; buf.set(value, got); got += value.length; onProgress(got, man.size); }
    }
    if (got !== man.size) throw new Error(`Модель скачалась не полностью (${got} из ${man.size}). Обновите страницу`);
    return buf;
  }
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error('Модель не найдена (' + r.status + '). Положите lama_fp32.onnx в папку models (см. README)');
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
  const rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; if (total) onProgress(got, total); }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function mockSession() {
  return {
    inputNames: ['image', 'mask'], outputNames: ['output'],
    async run(f) {
      const im = f.image.data, mk = f.mask.data, N = LAMA * LAMA, out = new Float32Array(3 * N); let r = 0, g = 0, b = 0, c = 0;
      for (let i = 0; i < N; i++) if (!mk[i]) { r += im[i]; g += im[N + i]; b += im[2 * N + i]; c++; }
      r /= c; g /= c; b /= c;
      for (let i = 0; i < N; i++) { const m = mk[i]; out[i] = (m ? r : im[i]) * 255; out[N + i] = (m ? g : im[N + i]) * 255; out[2 * N + i] = (m ? b : im[2 * N + i]) * 255; }
      await tick(300);
      return { output: { data: out } };
    },
  };
}
function setEngine(t) { S.engine = t; $('engine').textContent = 'Движок: ' + t; }
async function ensureOrt() {
  if (self.ort && S.threads) return;
  await loadScript('vendor/ort.min.js');
  S.threads = self.crossOriginIsolated ? clamp(navigator.hardwareConcurrency || 2, 1, 4) : 1;
  ort.env.wasm.wasmPaths = 'vendor/'; ort.env.wasm.numThreads = S.threads; ort.env.wasm.proxy = false;
}
async function createSession() {
  if (MOCK) { setEngine('заглушка (режим проверки)'); return mockSession(); }
  await ensureOrt();
  const threads = S.threads;
  const buf = await fetchModel((got, total) => { progress(got / total); status(`Готовлю модель: ${(got / 1e6) | 0} из ${(total / 1e6) | 0} МБ`); if (S.busy) $('busyText').textContent = `Загружаю модель: ${(got / 1e6) | 0} из ${(total / 1e6) | 0} МБ (только в первый раз)`; });
  progress(0);
  const opts = { graphOptimizationLevel: 'all' };
  let sess = null;
  if (S.gpu && navigator.gpu) {
    try { sess = await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['webgpu'] }); setEngine('видеокарта (WebGPU)'); }
    catch (e) { log('WebGPU не запустился:', e.message); }
  }
  if (!sess) { sess = await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['wasm'] }); setEngine(`процессор, потоков: ${threads}`); }
  log('модель готова', sess.inputNames.join(','), '->', sess.outputNames.join(','), S.engine);
  return sess;
}
function getSession() {
  if (S.sess) return Promise.resolve(S.sess);
  if (!S.sessP) S.sessP = createSession().then((s) => { S.sess = s; if (!S.busy) status('Модель готова', 'ok'); return s; }).catch((e) => { S.sessP = null; progress(0); throw e; });
  return S.sessP;
}
function warmup() { if (!S.sess && !S.sessP && S.photos.length) getSession().catch((e) => { status('Ошибка: ' + e.message, 'err'); log(e.message); }); }

function boxBlur(A, side, fr) {
  const B = new Float32Array(A.length), n = 2 * fr + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < side; y++) { let s = 0; const row = y * side; for (let x = -fr; x <= fr; x++) s += A[row + clamp(x, 0, side - 1)]; for (let x = 0; x < side; x++) { B[row + x] = s / n; s += A[row + clamp(x + fr + 1, 0, side - 1)] - A[row + clamp(x - fr, 0, side - 1)]; } }
    for (let x = 0; x < side; x++) { let s = 0; for (let y = -fr; y <= fr; y++) s += B[clamp(y, 0, side - 1) * side + x]; for (let y = 0; y < side; y++) { A[y * side + x] = s / n; s += B[clamp(y + fr + 1, 0, side - 1) * side + x] - B[clamp(y - fr, 0, side - 1) * side + x]; } }
  }
  return A;
}

async function eraseCore(src, label) {
  const p = cur(); if (!p) return null;
  const W = p.canvas.width, H = p.canvas.height;
  const md = ctx2d(src).getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) { const row = y * W; for (let x = 0; x < W; x++) if (md[(row + x) * 4 + 3] > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  if (x1 < 0) return null;
  const t0 = performance.now();
  busy(true, S.sess ? label : 'Готовлю модель…', true); await tick();
  // квадратное окно вокруг закрашенного с запасом контекста
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, minWH = Math.min(W, H);
  const side = clamp(Math.round(Math.max(bw, bh) * 1.8), Math.min(LAMA, minWH), minWH);
  const sx = clamp(Math.round((x0 + x1) / 2 - side / 2), 0, W - side), sy = clamp(Math.round((y0 + y1) / 2 - side / 2), 0, H - side);
  const cut = x0 < sx || y0 < sy || x1 >= sx + side || y1 >= sy + side;
  // маска окна, слегка расширенная, чтобы не оставались края предмета
  const mc = document.createElement('canvas'); mc.width = mc.height = side; const mcx = ctx2d(mc);
  const grow = Math.max(2, Math.round(side / LAMA * 3));
  for (const [dx, dy] of [[0, 0], [grow, 0], [-grow, 0], [0, grow], [0, -grow], [grow, grow], [-grow, -grow], [grow, -grow], [-grow, grow]]) mcx.drawImage(src, sx, sy, side, side, dx, dy, side, side);
  const mA = mcx.getImageData(0, 0, side, side).data;
  // вход модели 512x512
  const ic = document.createElement('canvas'); ic.width = ic.height = LAMA; const ictx = ctx2d(ic);
  ictx.imageSmoothingQuality = 'high'; ictx.drawImage(p.canvas, sx, sy, side, side, 0, 0, LAMA, LAMA);
  const mk = document.createElement('canvas'); mk.width = mk.height = LAMA; const mkx = ctx2d(mk);
  mkx.drawImage(mc, 0, 0, LAMA, LAMA);
  const id = ictx.getImageData(0, 0, LAMA, LAMA).data, mdata = mkx.getImageData(0, 0, LAMA, LAMA).data, N = LAMA * LAMA;
  const imgT = new Float32Array(3 * N), mskT = new Float32Array(N);
  for (let i = 0; i < N; i++) { imgT[i] = id[i * 4] / 255; imgT[N + i] = id[i * 4 + 1] / 255; imgT[2 * N + i] = id[i * 4 + 2] / 255; mskT[i] = mdata[i * 4 + 3] > 60 ? 1 : 0; }
  const sess = await getSession();
  busy(true, label, true); await tick(40);
  const feeds = {};
  const nIm = sess.inputNames.find((s) => /im/i.test(s)) || sess.inputNames[0], nMk = sess.inputNames.find((s) => /mask/i.test(s)) || sess.inputNames[1];
  if (MOCK) { feeds[nIm] = { data: imgT }; feeds[nMk] = { data: mskT }; }
  else { feeds[nIm] = new ort.Tensor('float32', imgT, [1, 3, LAMA, LAMA]); feeds[nMk] = new ort.Tensor('float32', mskT, [1, 1, LAMA, LAMA]); }
  const tRun = performance.now();
  const res = await sess.run(feeds);
  const runSec = (performance.now() - tRun) / 1000;
  const out = (res[sess.outputNames[0]] || Object.values(res)[0]).data;
  // если модель вернула 0..1, приводим к 0..255
  let mx = 0; for (let i = 0; i < 3 * N; i += 97) if (out[i] > mx) mx = out[i];
  const sc = mx <= 1.5 ? 255 : 1;
  const rc = document.createElement('canvas'); rc.width = rc.height = LAMA; const rctx = rc.getContext('2d');
  const rd = rctx.createImageData(LAMA, LAMA);
  for (let i = 0; i < N; i++) { rd.data[i * 4] = out[i] * sc; rd.data[i * 4 + 1] = out[N + i] * sc; rd.data[i * 4 + 2] = out[2 * N + i] * sc; rd.data[i * 4 + 3] = 255; }
  rctx.putImageData(rd, 0, 0);
  const fc = document.createElement('canvas'); fc.width = fc.height = side; const fctx = ctx2d(fc);
  fctx.imageSmoothingQuality = 'high'; fctx.drawImage(rc, 0, 0, side, side);
  const fd = fctx.getImageData(0, 0, side, side).data;
  // мягкая маска смешивания: в кадр попадает только закрашенное, край размыт
  const A = new Float32Array(side * side);
  for (let i = 0; i < A.length; i++) A[i] = mA[i * 4 + 3] > 60 ? 1 : 0;
  boxBlur(A, side, Math.max(1, Math.round(side / LAMA * 2)));
  pushUndoRect(p, sx, sy, side, side);
  const pctx = ctx2d(p.canvas), od = pctx.getImageData(sx, sy, side, side), o = od.data;
  // подгонка тона: средняя разница оригинала и результата на кольце вокруг области
  let dr = 0, dg = 0, db = 0, dc = 0;
  for (let i = 0; i < A.length; i++) { const a = A[i]; if (a > 0.02 && a < 0.5) { const k = i * 4; dr += o[k] - fd[k]; dg += o[k + 1] - fd[k + 1]; db += o[k + 2] - fd[k + 2]; dc++; } }
  if (dc > 50) { dr = clamp(dr / dc, -20, 20); dg = clamp(dg / dc, -20, 20); db = clamp(db / dc, -20, 20); } else { dr = dg = db = 0; }
  for (let i = 0; i < A.length; i++) { const a = A[i]; if (a > 0.003) { const k = i * 4; o[k] = o[k] * (1 - a) + (fd[k] + dr) * a; o[k + 1] = o[k + 1] * (1 - a) + (fd[k + 1] + dg) * a; o[k + 2] = o[k + 2] * (1 - a) + (fd[k + 2] + db) * a; } }
  pctx.putImageData(od, sx, sy);
  const sec = (performance.now() - t0) / 1000;
  log(`стирание: окно ${side}px, модель ${runSec.toFixed(1)} с, всего ${sec.toFixed(1)} с`);
  return { sec, cut };
}

// стирает всё отмеченное: каждый найденный предмет отдельно (так качественнее), затем ручные мазки
async function eraseAll() {
  const p = cur(); if (!p) return 0;
  cancelAutoErase();
  const W = p.canvas.width, H = p.canvas.height;
  const jobs = (p.dets || []).filter((d) => d.on).map((d) => ({ rect: detRect(d, W, H), label: d.label }));
  jobs.push({ label: 'закрашенное' });
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
  let done = 0, tot = 0, cutAny = false; const n = jobs.length;
  for (let i = 0; i < n; i++) {
    if (S.cancel) break;
    let src = manCv;
    if (jobs[i].rect) { const c = tmp.getContext('2d'); c.clearRect(0, 0, W, H); c.fillStyle = '#f00'; roundRect(c, jobs[i].rect); c.fill(); src = tmp; }
    const r = await eraseCore(src, n > 2 ? `Убираю ${i + 1} из ${n - 1}: ${jobs[i].label}…` : 'Убираю…');
    if (r) { done++; tot += r.sec; cutAny = cutAny || r.cut; }
  }
  clearMask(); busy(false); renderStrip(p); syncEraseBtn(); updateButtons();
  if (!done) { status(S.cancel ? 'Остановлено' : 'Сначала закрасьте то, что нужно убрать'); return 0; }
  status(`Готово: убрано ${done} за ${tot.toFixed(1)} с` + (cutAny ? '. Часть закрашенного не поместилась — закрасьте остаток ещё раз' : ''), 'ok');
  return done;
}
function runErase() { return eraseAll().catch((e) => { busy(false); status('Ошибка: ' + e.message, 'err'); log(e.stack || e.message); }); }

/* ---------- авто-поиск лишнего (детектор) ---------- */
const WORD_RU = { person: 'человек', shoes: 'обувь', slippers: 'тапки', boots: 'обувь', clothes: 'одежда', towel: 'полотенце', laundry: 'бельё', jacket: 'куртка',
  bag: 'сумка', backpack: 'рюкзак', 'plastic bag': 'пакет', suitcase: 'чемодан', bottle: 'бутылка', cup: 'кружка', dish: 'посуда', 'shampoo bottle': 'флакон', cosmetics: 'косметика',
  box: 'коробка', 'cardboard box': 'коробка', trash: 'мусор', 'garbage bag': 'мешок', cable: 'провод', toy: 'игрушка', broom: 'веник', bucket: 'ведро', mop: 'швабра' };
const groupOf = (w) => GROUPS.find((g) => g.words.includes(w));
async function createDetector() {
  if (MOCK) return { mock: true };
  await ensureOrt();
  const [cr, mr] = await Promise.all([fetch(DET_CLASSES_URL), fetch(DET_URL)]);
  if (!cr.ok || !mr.ok) throw new Error('Авто-уборка не установлена: на компьютере запустите  python setup.py --auto  (см. README)');
  const classes = await cr.json();
  const sess = await ort.InferenceSession.create(new Uint8Array(await mr.arrayBuffer()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  log('детектор готов, классов:', classes.length);
  return { sess, classes };
}
function getDetector() {
  if (S.det) return Promise.resolve(S.det);
  if (!S.detP) S.detP = createDetector().then((d) => (S.det = d)).catch((e) => { S.detP = null; throw e; });
  return S.detP;
}
function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i + 1e-6);
}
// разбор выхода YOLO (ultralytics): [1, 4+классы, N] или [1, N, 4+классы]
function parseYolo(out, nc, thr, map) {
  const a = out.data, dims = out.dims, C = 4 + nc;
  const N = dims[1] === C ? dims[2] : dims[1], T = dims[1] !== C;   // T: транспонированный вывод
  const at = T ? (r, j) => a[j * C + r] : (r, j) => a[r * N + j];
  const res = [];
  for (let j = 0; j < N; j++) {
    let best = 0, bi = -1;
    for (let c = 0; c < nc; c++) { const v = at(4 + c, j); if (v > best) { best = v; bi = c; } }
    if (best < thr) continue;
    const cx = at(0, j), cy = at(1, j), w = at(2, j), h = at(3, j);
    res.push({ ...map(cx - w / 2, cy - h / 2, w, h), score: best, ci: bi });
  }
  res.sort((p, q) => q.score - p.score);
  const keep = [];
  for (const r of res) if (keep.every((k) => iou(k, r) < 0.5)) keep.push(r);
  return keep;
}
async function detect(p, thr) {
  const D = await getDetector(), W = p.canvas.width, H = p.canvas.height;
  let raw;
  if (D.mock) {
    await tick(200);
    raw = [{ x: W * 0.12, y: H * 0.64, w: W * 0.11, h: H * 0.06, score: 0.8, word: 'shoes' }, { x: W * 0.55, y: H * 0.05, w: W * 0.12, h: H * 0.1, score: 0.5, word: 'cable' }];
  } else {
    const r = Math.min(DET / W, DET / H), nw = Math.round(W * r), nh = Math.round(H * r), padX = ((DET - nw) / 2) | 0, padY = ((DET - nh) / 2) | 0;
    const lc = document.createElement('canvas'); lc.width = lc.height = DET; const lctx = ctx2d(lc);
    lctx.fillStyle = 'rgb(114,114,114)'; lctx.fillRect(0, 0, DET, DET); lctx.imageSmoothingQuality = 'high'; lctx.drawImage(p.canvas, padX, padY, nw, nh);
    const id = lctx.getImageData(0, 0, DET, DET).data, N = DET * DET, t = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) { t[i] = id[i * 4] / 255; t[N + i] = id[i * 4 + 1] / 255; t[2 * N + i] = id[i * 4 + 2] / 255; }
    const res = await D.sess.run({ [D.sess.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, DET, DET]) });
    const out = res[D.sess.outputNames[0]];
    raw = parseYolo(out, D.classes.length, thr, (x, y, w, h) => {
      const X = clamp((x - padX) / r, 0, W), Y = clamp((y - padY) / r, 0, H);
      return { x: X, y: Y, w: clamp((x + w - padX) / r, 0, W) - X, h: clamp((y + h - padY) / r, 0, H) - Y };
    }).map((d) => ({ ...d, word: D.classes[d.ci] }));
  }
  // отбрасываем крошечные и огромные (скорее всего ошибка: «одежда» на всю кровать и т.п.)
  return raw.filter((d) => groupOf(d.word) && d.w * d.h > W * H * 0.0008 && d.w * d.h < W * H * 0.35)
    .map((d) => { const g = groupOf(d.word); return { x: d.x, y: d.y, w: d.w, h: d.h, score: d.score, group: g.id, label: WORD_RU[d.word] || d.word }; });
}
async function autoClean(p, review) {
  busy(true, 'Ищу лишнее…', true); await tick();
  const dets = await detect(p, review ? 0.2 : 0.3);
  p.dets = dets.map((d) => ({ ...d, on: S.groups.includes(d.group) }));
  busy(false);
  if (review) {
    if (S.mode !== 'brush') setMode('brush');
    renderMask(); syncEraseBtn();
    if (!p.dets.length) status('Ничего лишнего не нашёл. Можно закрасить кистью'); else detStatus();
    warmup(); return 0;
  }
  p.dets = p.dets.filter((d) => d.on); renderMask();
  if (!p.dets.length) return 0;
  return eraseAll();
}
async function autoCleanMany(list) {
  S.cancel = false; let total = 0;
  for (let i = 0; i < list.length; i++) {
    if (S.cancel) break;
    select(S.photos.indexOf(list[i]));
    status(`Авто-уборка: фото ${i + 1} из ${list.length}`);
    try { total += (await autoClean(list[i], false)) || 0; } catch (e) { busy(false); status('Ошибка: ' + e.message, 'err'); log(e.message); return; }
  }
  busy(false);
  status(S.cancel ? `Остановлено. Убрано предметов: ${total}` : `Авто-уборка готова: убрано предметов ${total}. Проверьте через «До/после»`, 'ok');
}

/* ---------- сохранение ---------- */
async function toFile(p) { return new File([await toBlob(p.canvas, 0.92)], p.name + '_edit.jpg', { type: 'image/jpeg' }); }
async function saveFiles(list) {
  busy(true, 'Готовлю файлы…'); await tick();
  const files = []; for (const p of list) files.push(await toFile(p));
  busy(false);
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); status('Сохранено', 'ok'); return; } catch (e) { if (e.name === 'AbortError') return; log('share:', e.message); }
  }
  for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); await tick(200); }
  status('Файлы скачаны', 'ok');
}

/* ---------- До/после (удерживать) ---------- */
function showOrig(on) {
  if (!cur()) return;
  origImg.classList.toggle('on', on); $('origTag').classList.toggle('on', on);
  maskCv.style.visibility = on ? 'hidden' : '';
}
const cmp = $('cmp');
cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); showOrig(true); });
['pointerup', 'pointercancel'].forEach((ev) => window.addEventListener(ev, () => { if (origImg.classList.contains('on')) showOrig(false); }));
cmp.addEventListener('pointerleave', () => showOrig(false));
cmp.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------- кнопки и настройки ---------- */
function updateButtons() {
  const p = cur(), has = !!p, b = S.busy;
  $('brush').disabled = !has || b; $('cmp').disabled = !has; $('undo').disabled = !has || b || !p.undo.length;
  $('enh').disabled = !has || b || p.enhanced; $('enh').textContent = has && p.enhanced ? 'Улучшено ✓' : 'Улучшить';
  $('save').disabled = !has || b; $('saveAll').disabled = S.photos.length < 2 || b;
  $('doErase').disabled = b; $('clearMask').disabled = b; $('add').disabled = b;
  $('auto').disabled = !has || b; $('autoAll').disabled = !S.photos.length || b;
}
$('add').onclick = $('pick0').onclick = () => $('file').click();
$('file').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
$('enh').onclick = async () => { const p = cur(); busy(true, 'Улучшаю свет и цвет…'); await tick(); await pushUndoFull(p); enhanceCanvas(p.canvas); p.enhanced = true; busy(false); renderStrip(p); status('Свет и цвет улучшены', 'ok'); };
$('brush').onclick = () => setMode(S.mode === 'brush' ? 'view' : 'brush');
$('size').value = S.brush; $('sizeVal').textContent = S.brush;
$('size').oninput = (e) => { S.brush = +e.target.value; $('sizeVal').textContent = S.brush; store.set('brush', S.brush); };
$('clearMask').onclick = () => { cancelAutoErase(); clearMask(); };
$('doErase').onclick = () => { S.cancel = false; runErase(); };
$('auto').onclick = () => { S.cancel = false; autoClean(cur(), true).catch((e) => { busy(false); status('Ошибка: ' + e.message, 'err'); log(e.message); }); };
$('autoAll').onclick = () => { $('settings').classList.remove('on'); autoCleanMany(S.photos.slice()); };
$('stop').onclick = () => { S.cancel = true; $('busyText').textContent = 'Останавливаю после текущего шага…'; };
$('undo').onclick = () => { cancelAutoErase(); undo(); };
$('save').onclick = () => saveFiles([cur()]);
$('saveAll').onclick = () => saveFiles(S.photos);
$('gear').onclick = () => $('settings').classList.toggle('on');
$('groups').innerHTML = GROUPS.map((g) => `<label><input type="checkbox" value="${g.id}"${S.groups.includes(g.id) ? ' checked' : ''}>${g.ru}</label>`).join('');
$('groups').onchange = () => { S.groups = [...$('groups').querySelectorAll('input:checked')].map((i) => i.value); store.set('groups', S.groups); };
[['optEnh', 'autoEnh'], ['optErase', 'autoErase'], ['optGpu', 'gpu'], ['optFull', 'fullAuto']].forEach(([id, key]) => {
  const el = $(id); el.checked = !!S[key];
  el.onchange = () => {
    S[key] = el.checked; store.set(key, el.checked);
    if (key === 'autoErase') { syncEraseBtn(); cancelAutoErase(); }
    if (key === 'gpu' && (S.sess || S.sessP)) status('Перезапустите приложение, чтобы сменить движок');
  };
});
syncEraseBtn();
updateButtons();

window.__app = { fetchModel, S, addFiles, enhanceCanvas, erase: runErase, select, undo, getSession, parseYolo, autoClean };   // для проверки

/* ---------- офлайн и многопоточность ---------- */
if ('serviceWorker' in navigator && window.isSecureContext && !MOCK) {
  navigator.serviceWorker.register('sw.js').then(() => {
    // заголовки изоляции появляются только у страниц под управлением SW: один раз перезагружаемся
    if (!self.crossOriginIsolated) {
      let done = false;
      const go = () => { if (done) return; done = true; try { if (sessionStorage.getItem('pe_coi')) return; sessionStorage.setItem('pe_coi', '1'); } catch (e) { return; } location.reload(); };
      if (navigator.serviceWorker.controller) go(); else navigator.serviceWorker.addEventListener('controllerchange', go);
    } else { try { sessionStorage.removeItem('pe_coi'); } catch (e) { /* ничего */ } }
  }).catch((e) => log('SW:', e.message));
}
