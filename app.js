'use strict';

/* ================= IndexedDB ================= */
const DB_NAME = 'saibai-log';
const DB_VER = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      d.createObjectStore('seasons', { keyPath: 'id' });
      d.createObjectStore('crops', { keyPath: 'id' });
      d.createObjectStore('varieties', { keyPath: 'id' });
      d.createObjectStore('locations', { keyPath: 'id' });
      d.createObjectStore('plantings', { keyPath: 'id' });
      const rec = d.createObjectStore('records', { keyPath: 'id' });
      rec.createIndex('plantingId', 'plantingId');
      rec.createIndex('recordedAt', 'recordedAt');
      const ph = d.createObjectStore('photos', { keyPath: 'id' });
      ph.createIndex('recordId', 'recordId');
      d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const res = fn(s);
    t.oncomplete = () => resolve(res && res.result !== undefined ? res.result : res);
    t.onerror = () => reject(t.error);
  });
}
const dbPut = (store, obj) => tx(store, 'readwrite', s => { s.put(obj); return obj; });
const dbDel = (store, key) => tx(store, 'readwrite', s => { s.delete(key); });
const dbGet = (store, key) => new Promise((resolve, reject) => {
  const r = db.transaction(store).objectStore(store).get(key);
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});
const dbAll = (store) => new Promise((resolve, reject) => {
  const r = db.transaction(store).objectStore(store).getAll();
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});
const dbByIndex = (store, idx, val) => new Promise((resolve, reject) => {
  const r = db.transaction(store).objectStore(store).index(idx).getAll(val);
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
const now = () => new Date().toISOString();

/* ================= seed =================
   固定IDでシードする（複数端末で同期したとき同一マスタとして扱うため） */
async function seedIfNeeded() {
  const seeded = await dbGet('settings', 'seeded');
  if (!seeded) {
    const y = new Date().getFullYear();
    const t = now();
    await dbPut('seasons', { id: `seed-season-${y}`, name: `${y}シーズン`, startDate: `${y}-01-01`, endDate: null, updatedAt: t, dirty: 1 });
    await dbPut('settings', { key: 'currentSeasonId', value: `seed-season-${y}` });
    await dbPut('crops', { id: 'seed-crop-tomato', name: 'トマト', trackIndividually: true, updatedAt: t, dirty: 1 });
    await dbPut('crops', { id: 'seed-crop-ensai', name: 'エンサイ', trackIndividually: false, updatedAt: t, dirty: 1 });
    await dbPut('crops', { id: 'seed-crop-moroheiya', name: 'モロヘイヤ', trackIndividually: false, updatedAt: t, dirty: 1 });
    await dbPut('varieties', { id: 'seed-var-pinky', cropId: 'seed-crop-tomato', name: 'ピンキー', source: '購入', updatedAt: t, dirty: 1 });
    const locIds = { 'engawa': 'seed-loc-engawa', 'ガレージ': 'seed-loc-garage', '2階': 'seed-loc-2f' };
    for (const [name, id] of Object.entries(locIds)) {
      await dbPut('locations', { id, name, orientation: '', sunHours: null, roofed: false, notes: '', updatedAt: t, dirty: 1 });
    }
    await dbPut('settings', { key: 'seeded', value: true });
  }
  await migrateSeedIds();
}

/* v1.0でランダムIDでシードされた端末を固定IDへ移行する（1回だけ実行） */
async function migrateSeedIds() {
  if (await dbGet('settings', 'fixedSeedIds')) return;
  const idMap = {};
  const nameMaps = [
    ['crops', { 'トマト': 'seed-crop-tomato', 'エンサイ': 'seed-crop-ensai', 'モロヘイヤ': 'seed-crop-moroheiya' }],
    ['locations', { 'engawa': 'seed-loc-engawa', 'ガレージ': 'seed-loc-garage', '2階': 'seed-loc-2f' }],
  ];
  for (const [store, nameMap] of nameMaps) {
    for (const obj of await dbAll(store)) {
      const fixed = nameMap[obj.name];
      if (fixed && obj.id !== fixed && !(await dbGet(store, fixed))) {
        idMap[obj.id] = fixed;
        await dbDel(store, obj.id);
        await dbPut(store, { ...obj, id: fixed, updatedAt: obj.updatedAt || now(), dirty: 1 });
      }
    }
  }
  for (const v of await dbAll('varieties')) {
    const nv = { ...v };
    let changed = false;
    if (idMap[nv.cropId]) { nv.cropId = idMap[nv.cropId]; changed = true; }
    if (nv.name === 'ピンキー' && nv.id !== 'seed-var-pinky' && !(await dbGet('varieties', 'seed-var-pinky'))) {
      idMap[nv.id] = 'seed-var-pinky';
      await dbDel('varieties', nv.id);
      nv.id = 'seed-var-pinky';
      changed = true;
    }
    if (changed) await dbPut('varieties', { ...nv, updatedAt: nv.updatedAt || now(), dirty: 1 });
  }
  for (const s of await dbAll('seasons')) {
    const m = /^(\d{4})シーズン$/.exec(s.name);
    const fixed = m && `seed-season-${m[1]}`;
    if (fixed && s.id !== fixed && !(await dbGet('seasons', fixed))) {
      idMap[s.id] = fixed;
      await dbDel('seasons', s.id);
      await dbPut('seasons', { ...s, id: fixed, updatedAt: s.updatedAt || now(), dirty: 1 });
    }
  }
  for (const p of await dbAll('plantings')) {
    const np = { ...p };
    let changed = false;
    for (const k of ['varietyId', 'locationId', 'seasonId', 'parentPlantingId']) {
      if (np[k] && idMap[np[k]]) { np[k] = idMap[np[k]]; changed = true; }
    }
    if (changed) await dbPut('plantings', { ...np, updatedAt: now(), dirty: 1 });
  }
  const cs = await dbGet('settings', 'currentSeasonId');
  if (cs && idMap[cs.value]) await dbPut('settings', { key: 'currentSeasonId', value: idMap[cs.value] });
  await dbPut('settings', { key: 'fixedSeedIds', value: true });
}

/* ================= state / helpers ================= */
const M = { seasons: [], crops: [], varieties: [], locations: [], plantings: [] };
const REC_TYPES = ['観察', '作業', '収穫', '失敗', '施肥', '環境'];
const PRESET_TAGS = {
  '観察': ['開花', '着果', '発芽', '色づき', '脇芽'],
  '作業': ['芽かき', '誘引', '摘心', '挿し芽', '定植', 'ずりおろし', '水替え'],
  '収穫': ['初収穫'],
  '失敗': ['裂果', '病気', '虫害', '尻腐れ', '水切れ', '徒長', '枯れ'],
  '施肥': ['液肥', '追肥', 'EC調整'],
  '環境': ['猛暑', '長雨', '強風', '低温'],
};
const STATUS_LABEL = { active: '育成中', done: '終了', dead: '枯死' };

async function reloadMasters() {
  const stores = ['seasons', 'crops', 'varieties', 'locations', 'plantings'];
  const data = await Promise.all(stores.map(dbAll));
  stores.forEach((s, i) => { M[s] = data[i].filter(r => !r.deleted); });
}

/* ユーザーデータの保存はすべてここを通す（updatedAt付与+同期対象マーク） */
async function putUserData(store, obj) {
  obj.updatedAt = now();
  obj.dirty = 1;
  await dbPut(store, obj);
  scheduleAutoSync();
  return obj;
}
const varietyOf = (p) => M.varieties.find(v => v.id === p.varietyId);
const cropOfVariety = (v) => v && M.crops.find(c => c.id === v.cropId);
const locationOf = (p) => M.locations.find(l => l.id === p.locationId);
const plantingById = (id) => M.plantings.find(p => p.id === id);

function daysFromSowing(p, dateStr) {
  if (!p.sownOn) return null;
  const [y, m, dd] = p.sownOn.split('-').map(Number);
  const sown = new Date(y, m - 1, dd);
  const t = dateStr ? new Date(dateStr) : new Date();
  const target = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const diff = Math.round((target - sown) / 86400000);
  return diff >= 0 ? diff : null;
}
function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtDateFull(iso) {
  const d = new Date(iso);
  const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${w})`;
}
function fmtTime(iso) {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

/* photo blob URL cache */
const urlCache = new Map();
function photoURL(photo) {
  if (!urlCache.has(photo.id)) urlCache.set(photo.id, URL.createObjectURL(photo.blob));
  return urlCache.get(photo.id);
}

/* compress an image File -> {blob, width, height} */
function compressImage(file, maxEdge = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cv.toBlob(b => b ? resolve({ blob: b, width: w, height: h }) : reject(new Error('toBlob failed')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

/* recent-use ordering for plantings */
async function plantingsByRecentUse() {
  const records = await dbAll('records');
  const lastUse = {};
  for (const r of records) {
    if (!lastUse[r.plantingId] || r.recordedAt > lastUse[r.plantingId]) lastUse[r.plantingId] = r.recordedAt;
  }
  const active = M.plantings.filter(p => p.status === 'active');
  active.sort((a, b) => (lastUse[b.id] || b.updatedAt || '').localeCompare(lastUse[a.id] || a.updatedAt || ''));
  return active;
}

/* ================= router ================= */
const app = document.getElementById('app');
let inputPrefill = null; // plantingId to preselect on input view

function navigate(view, param) {
  location.hash = param ? `#${view}/${param}` : `#${view}`;
}
window.addEventListener('hashchange', render);

function currentRoute() {
  const h = location.hash.replace(/^#/, '') || 'home';
  const [view, param] = h.split('/');
  return { view, param };
}

async function render() {
  const { view, param } = currentRoute();
  document.querySelectorAll('#nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  await reloadMasters();
  if (view === 'home') renderHome();
  else if (view === 'list') renderList();
  else if (view === 'input') renderInput();
  else if (view === 'settings') renderSettings();
  else if (view === 'p') renderDetail(param);
  else renderHome();
  window.scrollTo(0, 0);
}

document.getElementById('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) { inputPrefill = null; navigate(b.dataset.view); }
});

/* ================= home ================= */
async function renderHome() {
  const records = (await dbAll('records')).filter(r => !r.deleted);
  records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const todayStr = new Date().toDateString();
  const todayRecs = records.filter(r => new Date(r.recordedAt).toDateString() === todayStr);
  const recent = await plantingsByRecentUse();

  let html = `<h1>🌱 栽培記録</h1>`;
  html += `<button class="primary" id="btn-quick">✚ 記録する</button>`;

  html += `<h2>今日の記録（${todayRecs.length}件）</h2>`;
  if (todayRecs.length === 0) {
    html += `<div class="empty">今日はまだ記録がありません</div>`;
  } else {
    for (const r of todayRecs.slice(0, 10)) html += recCard(r);
  }

  html += `<h2>栽培単位（最近使った順）</h2>`;
  if (recent.length === 0) {
    html += `<div class="empty">栽培単位がありません。<br>「一覧」から追加してください。</div>`;
  } else {
    for (const p of recent.slice(0, 6)) html += plCard(p);
  }
  app.innerHTML = html;
  document.getElementById('btn-quick').onclick = () => { inputPrefill = null; navigate('input'); };
  bindPlCards();
  bindRecCards();
}

function recCard(r) {
  const p = plantingById(r.plantingId);
  const metrics = metricsLine(r);
  return `<div class="card rec-card" data-id="${r.id}" data-pid="${r.plantingId}">
    <div class="row">
      <span class="badge ${r.type}">${r.type}</span>
      <span class="grow" style="font-size:0.85rem;font-weight:700;">${esc(p ? p.label : '?')}</span>
      <span class="sub">${fmtDate(r.recordedAt)} ${fmtTime(r.recordedAt)}</span>
    </div>
    ${r.body ? `<div style="margin-top:6px;font-size:0.9rem;">${esc(r.body)}</div>` : ''}
    ${metrics}
    ${tagsLine(r)}
  </div>`;
}
function metricsLine(r) {
  const m = r.metrics || {};
  const parts = [];
  if (m.weightG) parts.push(`${m.weightG}g`);
  if (m.count) parts.push(`${m.count}個`);
  return parts.length ? `<div class="metrics-line">🍅 ${parts.join(' / ')}</div>` : '';
}
function tagsLine(r) {
  if (!r.tags || !r.tags.length) return '';
  return `<div class="tags-line">${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
}
function bindRecCards() {
  document.querySelectorAll('.rec-card').forEach(el => {
    el.classList.add('tappable');
    el.onclick = () => navigate('p', el.dataset.pid);
  });
}

function plCard(p) {
  const v = varietyOf(p), c = cropOfVariety(v), l = locationOf(p);
  const days = daysFromSowing(p);
  return `<div class="card pl-card tappable" data-id="${p.id}">
    <span class="pl-status ${p.status}">${STATUS_LABEL[p.status] || p.status}</span>
    <div class="label">${esc(p.label)}</div>
    <div class="meta">${esc(c ? c.name : '')} / ${esc(v ? v.name : '')}　📍${esc(l ? l.name : '')}${days !== null ? `　播種から${days}日` : ''}</div>
  </div>`;
}
function bindPlCards() {
  document.querySelectorAll('.pl-card').forEach(el => {
    el.onclick = () => navigate('p', el.dataset.id);
  });
}

/* ================= quick input ================= */
const inputState = { photos: [], plantingId: null, type: '観察', tags: new Set(), weightG: 0, count: 0 };

async function renderInput() {
  const recent = await plantingsByRecentUse();
  if (inputPrefill && !recent.some(p => p.id === inputPrefill)) {
    const p = plantingById(inputPrefill);
    if (p) recent.unshift(p);
  }
  if (recent.length === 0) {
    app.innerHTML = `<h1>記録する</h1><div class="empty">先に栽培単位を追加してください。</div>
      <button class="primary" id="btn-goto-add">栽培単位を追加する</button>`;
    document.getElementById('btn-goto-add').onclick = () => openPlantingForm();
    return;
  }
  // reset state
  inputState.photos = [];
  inputState.plantingId = inputPrefill || recent[0].id;
  inputState.type = '観察';
  inputState.tags = new Set();
  inputState.weightG = 0;
  inputState.count = 0;

  let html = `<h1>記録する</h1>`;
  html += `<input type="file" id="photo-input" accept="image/*" capture="environment" multiple hidden>
    <button class="photo-btn" id="btn-photo">📷 写真を撮る / 選ぶ</button>
    <div class="photo-previews" id="photo-previews"></div>`;

  html += `<label class="field">栽培単位</label><div class="chips" id="pl-chips">`;
  for (const p of recent) {
    html += `<span class="chip${p.id === inputState.plantingId ? ' selected' : ''}" data-id="${p.id}">${esc(p.label)}</span>`;
  }
  html += `</div>`;

  html += `<label class="field">記録の種類</label><div class="chips" id="type-chips">`;
  for (const t of REC_TYPES) {
    html += `<span class="chip${t === inputState.type ? ' selected' : ''}" data-t="${t}">${t}</span>`;
  }
  html += `</div>`;

  html += `<div id="harvest-panel" style="display:none;">
    <label class="field">重量（g）</label>
    <div class="stepper" id="weight-stepper">
      <div class="val" id="weight-val">0 g</div>
      <button data-add="10">+10</button><button data-add="50">+50</button>
      <button data-add="100">+100</button><button data-add="-10">-10</button>
      <button data-add="0" id="weight-clear">C</button>
    </div>
    <label class="field">果数（個）</label>
    <div class="stepper" id="count-stepper">
      <div class="val" id="count-val">0 個</div>
      <button data-add="1">+1</button><button data-add="5">+5</button>
      <button data-add="10">+10</button><button data-add="-1">-1</button>
      <button data-add="0" id="count-clear">C</button>
    </div>
  </div>`;

  html += `<label class="field">タグ</label><div class="chips" id="tag-chips"></div>`;
  html += `<label class="field">メモ（任意）</label><textarea id="memo" placeholder="気づいたことをメモ"></textarea>`;
  html += `<label class="field">日時（変更する場合のみ）</label><input type="datetime-local" id="rec-dt">`;
  html += `<div style="margin-top:16px;"><button class="primary" id="btn-save">保存する</button></div>`;
  app.innerHTML = html;

  // datetime default
  const dtInput = document.getElementById('rec-dt');
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  dtInput.value = d.toISOString().slice(0, 16);

  // photos
  const photoInput = document.getElementById('photo-input');
  document.getElementById('btn-photo').onclick = () => photoInput.click();
  photoInput.onchange = async () => {
    for (const f of photoInput.files) {
      try {
        const c = await compressImage(f);
        inputState.photos.push(c);
      } catch (e) { toast('写真の読み込みに失敗しました'); }
    }
    photoInput.value = '';
    renderPhotoPreviews();
  };

  // planting chips
  document.getElementById('pl-chips').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    inputState.plantingId = chip.dataset.id;
    document.querySelectorAll('#pl-chips .chip').forEach(c => c.classList.toggle('selected', c === chip));
  };

  // type chips
  document.getElementById('type-chips').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    inputState.type = chip.dataset.t;
    inputState.tags = new Set();
    document.querySelectorAll('#type-chips .chip').forEach(c => c.classList.toggle('selected', c === chip));
    document.getElementById('harvest-panel').style.display = inputState.type === '収穫' ? '' : 'none';
    renderTagChips();
  };

  // steppers
  bindStepper('weight-stepper', 'weightG', 'weight-val', 'g');
  bindStepper('count-stepper', 'count', 'count-val', '個');

  renderTagChips();

  document.getElementById('btn-save').onclick = saveRecord;
}

function bindStepper(stepperId, key, valId, unit) {
  document.getElementById(stepperId).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const add = Number(b.dataset.add);
    if (add === 0) inputState[key] = 0;
    else inputState[key] = Math.max(0, inputState[key] + add);
    document.getElementById(valId).textContent = `${inputState[key]} ${unit}`;
  };
}

function renderTagChips() {
  const el = document.getElementById('tag-chips');
  const presets = PRESET_TAGS[inputState.type] || [];
  el.innerHTML = presets.map(t =>
    `<span class="chip small${inputState.tags.has(t) ? ' selected' : ''}" data-tag="${t}">${t}</span>`).join('');
  el.onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const t = chip.dataset.tag;
    if (inputState.tags.has(t)) inputState.tags.delete(t); else inputState.tags.add(t);
    chip.classList.toggle('selected');
  };
}

function renderPhotoPreviews() {
  const el = document.getElementById('photo-previews');
  el.innerHTML = inputState.photos.map((p, i) =>
    `<div class="thumb"><img src="${URL.createObjectURL(p.blob)}"><button class="del" data-i="${i}">✕</button></div>`).join('');
  el.querySelectorAll('.del').forEach(b => b.onclick = () => {
    inputState.photos.splice(Number(b.dataset.i), 1);
    renderPhotoPreviews();
  });
}

async function saveRecord() {
  if (!inputState.plantingId) { toast('栽培単位を選んでください'); return; }
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  const dtVal = document.getElementById('rec-dt').value;
  const recordedAt = dtVal ? new Date(dtVal).toISOString() : now();
  const metrics = {};
  if (inputState.type === '収穫') {
    if (inputState.weightG > 0) metrics.weightG = inputState.weightG;
    if (inputState.count > 0) metrics.count = inputState.count;
  }
  const rec = {
    id: uid(),
    plantingId: inputState.plantingId,
    recordedAt,
    type: inputState.type,
    body: document.getElementById('memo').value.trim(),
    tags: [...inputState.tags],
    metrics,
  };
  await putUserData('records', rec);
  for (const p of inputState.photos) {
    await putUserData('photos', {
      id: uid(), recordId: rec.id, blob: p.blob,
      takenAt: recordedAt, width: p.width, height: p.height,
    });
  }
  toast('保存しました 🌱');
  inputPrefill = null;
  navigate('home');
}

/* ================= list ================= */
const listFilter = { locationId: null, cropId: null, status: 'active' };

async function renderList() {
  let html = `<h1>栽培単位一覧</h1>`;
  html += `<button class="primary" id="btn-add-pl" style="margin-bottom:12px;">＋ 栽培単位を追加</button>`;

  // filters
  html += `<div class="chips" id="f-status">`;
  for (const [k, label] of [['active', '育成中'], ['all', 'すべて'], ['done', '終了'], ['dead', '枯死']]) {
    html += `<span class="chip small${listFilter.status === k ? ' selected' : ''}" data-k="${k}">${label}</span>`;
  }
  html += `</div>`;
  html += `<div class="chips" id="f-loc"><span class="chip small${!listFilter.locationId ? ' selected' : ''}" data-id="">📍全て</span>`;
  for (const l of M.locations) {
    html += `<span class="chip small${listFilter.locationId === l.id ? ' selected' : ''}" data-id="${l.id}">📍${esc(l.name)}</span>`;
  }
  html += `</div>`;
  html += `<div class="chips" id="f-crop"><span class="chip small${!listFilter.cropId ? ' selected' : ''}" data-id="">全作物</span>`;
  for (const c of M.crops) {
    html += `<span class="chip small${listFilter.cropId === c.id ? ' selected' : ''}" data-id="${c.id}">${esc(c.name)}</span>`;
  }
  html += `</div>`;

  let items = [...M.plantings];
  if (listFilter.status !== 'all') items = items.filter(p => p.status === listFilter.status);
  if (listFilter.locationId) items = items.filter(p => p.locationId === listFilter.locationId);
  if (listFilter.cropId) items = items.filter(p => {
    const v = varietyOf(p); return v && v.cropId === listFilter.cropId;
  });
  items.sort((a, b) => (b.sownOn || '').localeCompare(a.sownOn || ''));

  if (items.length === 0) html += `<div class="empty">該当する栽培単位がありません</div>`;
  else for (const p of items) html += plCard(p);

  app.innerHTML = html;
  document.getElementById('btn-add-pl').onclick = () => openPlantingForm();
  bindPlCards();
  bindFilterChips('f-status', 'k', v => { listFilter.status = v; renderList(); });
  bindFilterChips('f-loc', 'id', v => { listFilter.locationId = v || null; renderList(); });
  bindFilterChips('f-crop', 'id', v => { listFilter.cropId = v || null; renderList(); });
}

function bindFilterChips(elId, dataKey, cb) {
  document.getElementById(elId).onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (chip) cb(chip.dataset[dataKey]);
  };
}

/* ================= planting form (overlay) ================= */
function openPlantingForm(existing) {
  const p = existing || {};
  const sheet = `
    <h1>${existing ? '栽培単位を編集' : '栽培単位を追加'}</h1>
    <label class="field">品種</label>
    <select id="pf-variety">${M.varieties.map(v => {
      const c = cropOfVariety(v);
      return `<option value="${v.id}"${v.id === p.varietyId ? ' selected' : ''}>${esc(c ? c.name : '')} / ${esc(v.name)}</option>`;
    }).join('')}</select>
    <label class="field">場所</label>
    <select id="pf-loc">${M.locations.map(l =>
      `<option value="${l.id}"${l.id === p.locationId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
    <label class="field">ラベル（空欄なら自動生成）</label>
    <input type="text" id="pf-label" value="${esc(p.label || '')}" placeholder="例: ピンキー engawa 3株目">
    <label class="field">播種日</label>
    <input type="date" id="pf-sown" value="${p.sownOn || ''}">
    <label class="field">定植日（任意）</label>
    <input type="date" id="pf-trans" value="${p.transplantedOn || ''}">
    <label class="field">親株（挿し芽の場合・任意）</label>
    <select id="pf-parent"><option value="">なし</option>${M.plantings.filter(x => x.id !== p.id).map(x =>
      `<option value="${x.id}"${x.id === p.parentPlantingId ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
    ${existing ? `<label class="field">状態</label>
    <select id="pf-status">${Object.entries(STATUS_LABEL).map(([k, l]) =>
      `<option value="${k}"${k === p.status ? ' selected' : ''}>${l}</option>`).join('')}</select>` : ''}
    <div style="margin-top:16px;" class="row">
      <button class="secondary" id="pf-cancel">キャンセル</button>
      <button class="primary grow" id="pf-save">保存</button>
    </div>`;
  openOverlay(sheet);

  document.getElementById('pf-cancel').onclick = closeOverlay;
  document.getElementById('pf-save').onclick = async () => {
    const varietyId = document.getElementById('pf-variety').value;
    const locationId = document.getElementById('pf-loc').value;
    if (!varietyId || !locationId) { toast('品種と場所は必須です'); return; }
    let label = document.getElementById('pf-label').value.trim();
    if (!label) {
      const v = M.varieties.find(x => x.id === varietyId);
      const l = M.locations.find(x => x.id === locationId);
      const count = M.plantings.filter(x => x.varietyId === varietyId && x.locationId === locationId && x.id !== p.id).length;
      label = `${v.name} ${l.name}${count > 0 ? ` ${count + 1}株目` : ''}`;
    }
    const settings = await dbGet('settings', 'currentSeasonId');
    const obj = {
      id: p.id || uid(),
      seasonId: p.seasonId || (settings ? settings.value : (M.seasons[0] && M.seasons[0].id)),
      varietyId, locationId, label,
      parentPlantingId: document.getElementById('pf-parent').value || null,
      sownOn: document.getElementById('pf-sown').value || null,
      transplantedOn: document.getElementById('pf-trans').value || null,
      status: existing ? document.getElementById('pf-status').value : 'active',
      supportId: p.supportId || null,
    };
    await putUserData('plantings', obj);
    closeOverlay();
    toast('保存しました');
    render();
  };
}

/* ================= detail ================= */
async function renderDetail(id) {
  const p = plantingById(id);
  if (!p) { navigate('list'); return; }
  const v = varietyOf(p), c = cropOfVariety(v), l = locationOf(p);
  const records = (await dbByIndex('records', 'plantingId', id)).filter(r => !r.deleted);
  records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  for (const r of records) {
    r._photos = (await dbByIndex('photos', 'recordId', r.id)).filter(p => !p.deleted && p.blob);
  }
  const totalW = records.reduce((s, r) => s + ((r.metrics || {}).weightG || 0), 0);
  const totalC = records.reduce((s, r) => s + ((r.metrics || {}).count || 0), 0);
  const days = daysFromSowing(p);

  let html = `<button class="back-btn" id="btn-back">← 戻る</button>`;
  html += `<div class="detail-head">
    <span class="pl-status ${p.status}">${STATUS_LABEL[p.status]}</span>
    <div class="label">${esc(p.label)}</div>
    <div class="sub" style="margin-top:4px;">
      ${esc(c ? c.name : '')} / ${esc(v ? v.name : '')}　📍${esc(l ? l.name : '')}<br>
      ${p.sownOn ? `播種 ${p.sownOn}（${days}日目）` : '播種日未設定'}
      ${p.transplantedOn ? `　定植 ${p.transplantedOn}` : ''}
      ${p.parentPlantingId ? `　親株: ${esc((plantingById(p.parentPlantingId) || {}).label || '?')}` : ''}
    </div>
  </div>`;

  if (totalW || totalC) {
    html += `<div class="harvest-sum">
      <div class="box"><div class="num">${totalW}g</div><div class="cap">収穫累計 重量</div></div>
      <div class="box"><div class="num">${totalC}個</div><div class="cap">収穫累計 果数</div></div>
    </div>`;
  }

  html += `<div class="row" style="margin:10px 0;">
    <button class="primary grow" id="btn-add-rec">✚ この株に記録</button>
    <button class="secondary" id="btn-edit-pl">編集</button>
  </div>`;

  if (records.length === 0) {
    html += `<div class="empty">まだ記録がありません</div>`;
  } else {
    let lastDate = '';
    for (const r of records) {
      const dstr = fmtDateFull(r.recordedAt);
      if (dstr !== lastDate) {
        const d = daysFromSowing(p, r.recordedAt);
        html += `<div class="tl-date">${dstr}${d !== null ? `　<span style="font-weight:400;">播種から${d}日</span>` : ''}</div>`;
        lastDate = dstr;
      }
      html += `<div class="tl-rec"><div class="time">${fmtTime(r.recordedAt)}</div>
        <div class="tl-body"><div class="card" style="margin-bottom:8px;">
          <div class="row">
            <span class="badge ${r.type}">${r.type}</span>
            <span class="grow"></span>
            <button class="icon-btn rec-del" data-id="${r.id}">🗑</button>
          </div>
          ${r.body ? `<div style="margin-top:6px;font-size:0.9rem;white-space:pre-wrap;">${esc(r.body)}</div>` : ''}
          ${metricsLine(r)}
          ${tagsLine(r)}
          ${r._photos.length ? `<div class="rec-photos">${r._photos.map(ph =>
            `<img src="${photoURL(ph)}" data-pid="${ph.id}">`).join('')}</div>` : ''}
        </div></div></div>`;
    }
  }
  app.innerHTML = html;

  document.getElementById('btn-back').onclick = () => history.back();
  document.getElementById('btn-add-rec').onclick = () => { inputPrefill = id; navigate('input'); };
  document.getElementById('btn-edit-pl').onclick = () => openPlantingForm(p);
  document.querySelectorAll('.rec-del').forEach(b => b.onclick = async () => {
    if (!confirm('この記録を削除しますか？')) return;
    const photos = await dbByIndex('photos', 'recordId', b.dataset.id);
    for (const ph of photos) await putUserData('photos', { ...ph, blob: null, deleted: 1 });
    const rec = await dbGet('records', b.dataset.id);
    if (rec) await putUserData('records', { ...rec, deleted: 1 });
    toast('削除しました');
    renderDetail(id);
  });
  document.querySelectorAll('.rec-photos img').forEach(img => img.onclick = () => {
    openOverlay(`<img class="full" src="${img.src}">`, true);
  });
}

/* ================= settings ================= */
async function renderSettings() {
  let html = `<h1>設定</h1>`;

  html += masterSection('作物', 'crops', M.crops.map(c =>
    `${esc(c.name)}${c.trackIndividually ? ' <span class="sub">(株別管理)</span>' : ''}`));
  html += masterSection('品種', 'varieties', M.varieties.map(v => {
    const c = cropOfVariety(v);
    return `${esc(c ? c.name : '?')} / ${esc(v.name)}${v.source ? ` <span class="sub">(${esc(v.source)})</span>` : ''}`;
  }));
  html += masterSection('場所', 'locations', M.locations.map(l =>
    `${esc(l.name)}${l.orientation ? ` <span class="sub">${esc(l.orientation)}向き</span>` : ''}${l.sunHours ? ` <span class="sub">日照${l.sunHours}h</span>` : ''}`));
  html += masterSection('シーズン', 'seasons', M.seasons.map(s => `${esc(s.name)} <span class="sub">${s.startDate || ''}〜${s.endDate || ''}</span>`));

  const syncCfg = await getSyncCfg();
  const dirtyN = await countDirty();
  const syncStatus = !syncCfg.url
    ? '未設定（下のURLとトークンを入力してください）'
    : (syncCfg.lastSyncedAt
      ? `最終同期: ${fmtDateFull(syncCfg.lastSyncedAt)} ${fmtTime(syncCfg.lastSyncedAt)}`
      : 'まだ同期していません');
  html += `<h2>同期（Googleドライブ）</h2><div class="card">
    <div class="sub">${syncStatus}${dirtyN ? `　/ 未送信 ${dirtyN}件` : ''}</div>
    <label class="field">GASウェブアプリURL</label>
    <input type="text" id="sync-url" value="${esc(syncCfg.url || '')}" placeholder="https://script.google.com/macros/s/…/exec">
    <label class="field">トークン</label>
    <input type="text" id="sync-token" value="${esc(syncCfg.token || '')}" placeholder="Code.gs の TOKEN と同じ文字列">
    <div class="row" style="margin-top:12px;">
      <button class="secondary" id="btn-sync-save">保存して接続テスト</button>
      <button class="primary grow" id="btn-sync-now">今すぐ同期</button>
    </div>
  </div>`;

  html += `<h2>データ管理</h2><div class="card">
    <button class="secondary" id="btn-export" style="width:100%;margin-bottom:8px;">📤 バックアップを書き出す（JSON）</button>
    <button class="secondary" id="btn-import" style="width:100%;">📥 バックアップを読み込む</button>
    <input type="file" id="import-file" accept=".json,application/json" hidden>
    <div class="sub" style="margin-top:8px;">同期設定済みなら通常は不要。読み込みは「新しい方を採用」でマージされます。</div>
  </div>`;

  html += `<div class="sub center" style="margin-top:20px;">栽培記録 v1.1.1 (Phase 2)</div>`;
  app.innerHTML = html;

  document.getElementById('btn-sync-save').onclick = async () => {
    const cfg = await getSyncCfg();
    cfg.url = document.getElementById('sync-url').value.trim();
    cfg.token = document.getElementById('sync-token').value.trim();
    await dbPut('settings', { key: 'sync', value: cfg });
    if (!cfg.url || !cfg.token) { toast('URLとトークンを入力してください'); return; }
    toast('接続テスト中…');
    try {
      const r = await gasPost(cfg, { action: 'ping' });
      toast(r.ok ? '接続OK ✓ 「今すぐ同期」を押してください' : `接続NG: ${r.error || '不明なエラー'}`);
    } catch (e) {
      toast('接続できません（URLを確認してください）');
    }
  };
  document.getElementById('btn-sync-now').onclick = () => doSync(false);

  bindMasterSection('crops', openCropForm);
  bindMasterSection('varieties', openVarietyForm);
  bindMasterSection('locations', openLocationForm);
  bindMasterSection('seasons', openSeasonForm);

  document.getElementById('btn-export').onclick = exportData;
  const importFile = document.getElementById('import-file');
  document.getElementById('btn-import').onclick = () => importFile.click();
  importFile.onchange = () => { if (importFile.files[0]) importData(importFile.files[0]); };
}

function masterSection(title, store, items) {
  let html = `<h2>${title} <button class="icon-btn m-add" data-store="${store}" style="color:var(--green);font-weight:700;">＋追加</button></h2><div class="card">`;
  if (items.length === 0) html += `<div class="sub">未登録</div>`;
  else html += M[store].map((obj, i) =>
    `<div class="list-item"><span class="grow" style="font-size:0.9rem;">${items[i]}</span>
     <button class="icon-btn m-edit" data-store="${store}" data-id="${obj.id}">✏️</button></div>`).join('');
  html += `</div>`;
  return html;
}
function bindMasterSection(store, formFn) {
  document.querySelectorAll(`.m-add[data-store=${store}]`).forEach(b => b.onclick = () => formFn());
  document.querySelectorAll(`.m-edit[data-store=${store}]`).forEach(b =>
    b.onclick = () => formFn(M[store].find(x => x.id === b.dataset.id)));
}

function masterForm(title, fieldsHtml, onSave, existing, store) {
  let html = `<h1>${title}</h1>${fieldsHtml}
    <div style="margin-top:16px;" class="row">
      <button class="secondary" id="mf-cancel">キャンセル</button>
      ${existing ? `<button class="secondary danger-btn" id="mf-del">削除</button>` : ''}
      <button class="primary grow" id="mf-save">保存</button>
    </div>`;
  openOverlay(html);
  document.getElementById('mf-cancel').onclick = closeOverlay;
  if (existing) {
    document.getElementById('mf-del').onclick = async () => {
      if (!confirm('削除しますか？（この項目を使っている記録があると表示が壊れます）')) return;
      await putUserData(store, { ...existing, deleted: 1 });
      closeOverlay(); toast('削除しました'); render();
    };
  }
  document.getElementById('mf-save').onclick = onSave;
}

function openCropForm(existing) {
  const c = existing || {};
  masterForm(existing ? '作物を編集' : '作物を追加', `
    <label class="field">作物名</label><input type="text" id="cf-name" value="${esc(c.name || '')}">
    <label class="field"><input type="checkbox" id="cf-track" style="width:auto;" ${c.trackIndividually ? 'checked' : ''}> 株ごとに管理する</label>`,
    async () => {
      const name = document.getElementById('cf-name').value.trim();
      if (!name) { toast('作物名は必須です'); return; }
      await putUserData('crops', { id: c.id || uid(), name, trackIndividually: document.getElementById('cf-track').checked });
      closeOverlay(); toast('保存しました'); render();
    }, existing, 'crops');
}

function openVarietyForm(existing) {
  const v = existing || {};
  masterForm(existing ? '品種を編集' : '品種を追加', `
    <label class="field">作物</label>
    <select id="vf-crop">${M.crops.map(c => `<option value="${c.id}"${c.id === v.cropId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <label class="field">品種名</label><input type="text" id="vf-name" value="${esc(v.name || '')}">
    <label class="field">入手元</label>
    <select id="vf-source">${['購入', '挿し芽', '自家採種'].map(s => `<option${s === v.source ? ' selected' : ''}>${s}</option>`).join('')}</select>`,
    async () => {
      const name = document.getElementById('vf-name').value.trim();
      if (!name) { toast('品種名は必須です'); return; }
      await putUserData('varieties', {
        id: v.id || uid(), cropId: document.getElementById('vf-crop').value,
        name, source: document.getElementById('vf-source').value,
      });
      closeOverlay(); toast('保存しました'); render();
    }, existing, 'varieties');
}

function openLocationForm(existing) {
  const l = existing || {};
  masterForm(existing ? '場所を編集' : '場所を追加', `
    <label class="field">場所名</label><input type="text" id="lf-name" value="${esc(l.name || '')}">
    <label class="field">方位</label>
    <select id="lf-ori"><option value="">-</option>${['南', '南東', '南西', '東', '西', '北東', '北西', '北'].map(o =>
      `<option${o === l.orientation ? ' selected' : ''}>${o}</option>`).join('')}</select>
    <label class="field">日照目安（時間）</label><input type="number" id="lf-sun" value="${l.sunHours ?? ''}" step="0.5" min="0" max="24">
    <label class="field"><input type="checkbox" id="lf-roof" style="width:auto;" ${l.roofed ? 'checked' : ''}> 屋根あり</label>
    <label class="field">メモ</label><input type="text" id="lf-notes" value="${esc(l.notes || '')}">`,
    async () => {
      const name = document.getElementById('lf-name').value.trim();
      if (!name) { toast('場所名は必須です'); return; }
      await putUserData('locations', {
        id: l.id || uid(), name,
        orientation: document.getElementById('lf-ori').value,
        sunHours: Number(document.getElementById('lf-sun').value) || null,
        roofed: document.getElementById('lf-roof').checked,
        notes: document.getElementById('lf-notes').value.trim(),
      });
      closeOverlay(); toast('保存しました'); render();
    }, existing, 'locations');
}

function openSeasonForm(existing) {
  const s = existing || {};
  masterForm(existing ? 'シーズンを編集' : 'シーズンを追加', `
    <label class="field">名前</label><input type="text" id="sf-name" value="${esc(s.name || '')}" placeholder="例: 2026シーズン">
    <label class="field">開始日</label><input type="date" id="sf-start" value="${s.startDate || ''}">
    <label class="field">終了日（任意）</label><input type="date" id="sf-end" value="${s.endDate || ''}">`,
    async () => {
      const name = document.getElementById('sf-name').value.trim();
      if (!name) { toast('名前は必須です'); return; }
      await putUserData('seasons', {
        id: s.id || uid(), name,
        startDate: document.getElementById('sf-start').value || null,
        endDate: document.getElementById('sf-end').value || null,
      });
      closeOverlay(); toast('保存しました'); render();
    }, existing, 'seasons');
}

/* ================= sync (GAS -> Sheets + Drive) ================= */
const SYNC_STORES = ['seasons', 'crops', 'varieties', 'locations', 'plantings', 'records'];
let syncing = false;
let autoSyncTimer = null;

function scheduleAutoSync() {
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => { autoSyncTimer = null; doSync(true).catch(() => {}); }, 4000);
}

async function getSyncCfg() {
  const row = await dbGet('settings', 'sync');
  return (row && row.value) || {};
}

async function gasPost(cfg, payload) {
  // Content-Type: text/plain にすることでCORSプリフライトを回避（GAS定番パターン）
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: cfg.token, ...payload }),
  });
  return res.json();
}

function photoMetaToLocal(meta, blob) {
  return {
    id: meta.id, recordId: meta.recordId, takenAt: meta.takenAt,
    width: meta.width, height: meta.height,
    deleted: meta.deleted ? 1 : 0, updatedAt: meta.updatedAt, blob,
  };
}

async function countDirty() {
  let n = 0;
  for (const store of [...SYNC_STORES, 'photos']) {
    n += (await dbAll(store)).filter(r => r.dirty).length;
  }
  return n;
}

async function doSync(silent) {
  if (syncing) return;
  const cfg = await getSyncCfg();
  if (!cfg.url || !cfg.token) { if (!silent) toast('同期が未設定です'); return; }
  if (!navigator.onLine) { if (!silent) toast('オフラインです（復帰後に同期されます）'); return; }
  syncing = true;
  if (!silent) toast('同期中…');
  try {
    // push: dirtyな行だけ送る
    const changes = {};
    const pushed = [];
    for (const store of SYNC_STORES) {
      const rows = (await dbAll(store)).filter(r => r.dirty);
      changes[store] = rows.map(r => { const o = { ...r }; delete o.dirty; return o; });
      for (const r of rows) pushed.push([store, r.id, r.updatedAt]);
    }
    const photosPush = [];
    for (const p of (await dbAll('photos')).filter(p => p.dirty)) {
      photosPush.push({
        id: p.id, recordId: p.recordId, takenAt: p.takenAt,
        width: p.width, height: p.height,
        deleted: p.deleted ? 1 : 0, updatedAt: p.updatedAt,
        dataB64: p.blob && !p.deleted ? await blobToB64(p.blob) : null,
      });
      pushed.push(['photos', p.id, p.updatedAt]);
    }

    const data = await gasPost(cfg, { action: 'sync', sinceRev: cfg.lastRev || 0, changes, photos: photosPush });
    if (!data.ok) throw new Error(data.error || 'sync failed');

    // pull: サーバー側で新しい行をマージ（updatedAtが新しい方を採用）
    for (const store of SYNC_STORES) {
      for (const obj of data.changes[store] || []) {
        const cur = await dbGet(store, obj.id);
        if (!cur || (obj.updatedAt || '') > (cur.updatedAt || '')) await dbPut(store, obj);
      }
    }
    // 写真メタのマージ + 不足バイナリの取得
    const needFetch = [];
    for (const meta of data.photoMeta || []) {
      const cur = await dbGet('photos', meta.id);
      if (!cur) {
        if (meta.deleted) await dbPut('photos', photoMetaToLocal(meta, null));
        else needFetch.push(meta);
      } else if ((meta.updatedAt || '') > (cur.updatedAt || '')) {
        await dbPut('photos', photoMetaToLocal(meta, meta.deleted ? null : cur.blob));
      }
    }
    for (let i = 0; i < needFetch.length; i += 8) {
      const chunk = needFetch.slice(i, i + 8);
      const r2 = await gasPost(cfg, { action: 'getPhotos', ids: chunk.map(m => m.id) });
      if (r2.ok) {
        for (const ph of r2.photos) {
          const meta = chunk.find(m => m.id === ph.id);
          if (meta) await dbPut('photos', photoMetaToLocal(meta, b64ToBlob(ph.dataB64)));
        }
      }
    }
    // push済みの行のdirtyを外す（同期中に再編集された行は残す）
    for (const [store, id, u] of pushed) {
      const cur = await dbGet(store, id);
      if (cur && cur.dirty && cur.updatedAt === u) {
        const o = { ...cur }; delete o.dirty;
        await dbPut(store, o);
      }
    }
    cfg.lastRev = data.maxRev;
    cfg.lastSyncedAt = now();
    await dbPut('settings', { key: 'sync', value: cfg });
    if (!silent) toast('同期しました ✓');
    const v = currentRoute().view;
    if (v !== 'input') render(); // 入力中の画面は壊さない
  } catch (e) {
    console.error('sync failed', e);
    if (!silent) toast('同期に失敗しました');
  } finally {
    syncing = false;
  }
}

/* ================= export / import ================= */
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
function b64ToBlob(b64, type = 'image/jpeg') {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

async function exportData() {
  toast('書き出し中…');
  const [seasons, crops, varieties, locations, plantings, records, photos] = await Promise.all(
    ['seasons', 'crops', 'varieties', 'locations', 'plantings', 'records', 'photos'].map(dbAll));
  const photosOut = [];
  for (const p of photos) {
    photosOut.push({
      id: p.id, recordId: p.recordId, takenAt: p.takenAt,
      width: p.width, height: p.height,
      deleted: p.deleted ? 1 : 0, updatedAt: p.updatedAt || null,
      dataB64: p.blob && !p.deleted ? await blobToB64(p.blob) : null,
    });
  }
  const data = {
    app: 'saibai-log', version: 1, exportedAt: now(),
    seasons, crops, varieties, locations, plantings, records, photos: photosOut,
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `saibai-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('書き出しました 📤');
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'saibai-log') { toast('このアプリのバックアップではありません'); return; }
    let added = 0, updated = 0;
    for (const store of ['seasons', 'crops', 'varieties', 'locations', 'plantings', 'records']) {
      for (const obj of data[store] || []) {
        const existing = await dbGet(store, obj.id);
        if (!existing) { await dbPut(store, obj); added++; }
        else if ((obj.updatedAt || '') > (existing.updatedAt || '')) { await dbPut(store, obj); updated++; }
      }
    }
    for (const p of data.photos || []) {
      const existing = await dbGet('photos', p.id);
      if (!existing) {
        await dbPut('photos', {
          id: p.id, recordId: p.recordId, takenAt: p.takenAt,
          width: p.width, height: p.height,
          deleted: p.deleted ? 1 : 0, updatedAt: p.updatedAt || null,
          blob: p.dataB64 ? b64ToBlob(p.dataB64) : null,
        });
        added++;
      }
    }
    toast(`読み込みました（追加${added} / 更新${updated}）`);
    render();
  } catch (e) {
    console.error(e);
    toast('読み込みに失敗しました');
  }
}

/* ================= overlay ================= */
const overlay = document.getElementById('overlay');
// CSSキャッシュが古くても幕が残らないよう、表示制御はインラインstyleで確定させる
overlay.style.display = 'none';
function openOverlay(html, bare) {
  overlay.innerHTML = bare ? html : `<div class="sheet">${html}</div>`;
  overlay.hidden = false;
  overlay.style.display = 'flex';
}
function closeOverlay() { overlay.hidden = true; overlay.style.display = 'none'; overlay.innerHTML = ''; }
overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.classList.contains('full')) closeOverlay(); });

/* ================= boot ================= */
(async function boot() {
  db = await openDB();
  await seedIfNeeded();
  await render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('online', scheduleAutoSync);
  doSync(true).catch(() => {});
})();
