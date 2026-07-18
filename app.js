'use strict';
/* ============================================================
   МИНИМУМ — трекер ежедневного минимума
   Без зависимостей. Данные — localStorage, схема версионируется.
   ============================================================ */

/* ── ТЕКСТЫ РАЗДЕЛА «СИСТЕМА» ────────────────────────────────
   Правятся только здесь. kind: 'leads' — абзацы с жирным
   зачином, 'rules' — нумерованный канон, 'note' — врезка. */
const SYSTEM_TEXTS = [
  {
    kind: 'leads',
    title: 'Архитектура — три решения',
    items: [
      { lead: 'Минимум отделён от нормы.', text: 'Минимум — неснижаемая планка, которая выполняется даже в худший день. Норма — обычный объём. Приложение видит только минимум.' },
      { lead: 'Единица самооценки — неделя.', text: 'День фиксируется, но не оценивается; картина складывается раз в неделю на разборе.' },
      { lead: 'Инициатива у человека.', text: 'Система не напоминает, не повышает планку сама и ничего не решает за владельца.' }
    ]
  },
  {
    kind: 'rules',
    title: 'Пять правил',
    items: [
      'Минимум выполняется даже в худший день.',
      'Не пропускай дважды: пропуск — событие, два подряд — начало новой привычки.',
      'Одно изменение за раз.',
      'Самооценка раз в неделю, не ежедневно.',
      'Планка повышается только вручную и только после устойчивых трёх недель.'
    ]
  },
  {
    kind: 'leads',
    title: 'Модули',
    items: [
      { lead: 'Тело:', text: 'гигиена, короткая силовая связка.' },
      { lead: 'Движение:', text: 'минимальная дистанция пешком.' },
      { lead: 'Сон:', text: 'телефон вне кровати до отбоя.' },
      { lead: 'Развитие:', text: 'десять минут в день.' }
    ]
  },
  {
    kind: 'note',
    title: 'Заметка',
    text: 'Привычка держится минимум 2–3 недели, пока не покажется лёгкой. Начинай всегда с маленьких шагов: +0,01% всё равно лучше, чем ничего.'
  }
];

/* ── Хранилище ─────────────────────────────────────────────── */

const NS = 'minimum:data';
const SCHEMA_VERSION = 2;

let store = null;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* Модуль по умолчанию для стартовых пунктов (и для миграции v1-данных) */
const DEFAULT_GROUPS = {
  'Умыться': 'Тело',
  'Принять душ': 'Тело',
  'Подтягивания + отжимания': 'Тело',
  'Пешком': 'Движение',
  'Телефон вне кровати': 'Сон',
  'Развитие': 'Развитие',
  'Тренировка': 'Тело'
};
const TRAIN_NOTE = 'Полноценная тренировка, 40–50 минут';

function defaultStore() {
  const today = dateKeyShift(new Date(), 4);
  const mk = (name, value, unit, type, goal, note) => ({
    id: uid(), name, value, unit, type,
    goal: goal || null, note: note || '', group: DEFAULT_GROUPS[name] || '',
    active: true, addedAt: today, raiseAfter: 0,
    history: (typeof value === 'number') ? [{ date: today, value }] : []
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    items: [
      mk('Умыться', null, '', 'daily'),
      mk('Принять душ', null, '', 'daily'),
      mk('Подтягивания + отжимания', 5, 'повт.', 'daily'),
      mk('Пешком', 500, 'м', 'daily'),
      mk('Телефон вне кровати', 30, 'мин до сна', 'daily'),
      mk('Развитие', 10, 'мин', 'daily'),
      mk('Тренировка', null, '', 'weekly', 3, TRAIN_NOTE)
    ],
    days: {},          // "YYYY-MM-DD" -> { itemId: true }
    weekLog: [],       // инкременты недельных счётчиков текущей открытой недели
    reviews: [],       // закрытые недели
    pendingRaises: [], // принятые повышения, ещё не записанные в разбор
    draftOneChange: '',
    weekStart: today,  // логическая дата последнего закрытия (или первого запуска)
    settings: { dayBoundary: 4, hintShownForItemId: null }
  };
}

/* Миграции схемы. При изменении структуры: поднять SCHEMA_VERSION
   и добавить шаг вида if (s.schemaVersion < N) { ...; }. */
function migrate(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return defaultStore();
  if (!s.schemaVersion) s.schemaVersion = 1;

  // мягкая достройка полей (защита от частичных/старых экспортов)
  if (!Array.isArray(s.items)) s.items = [];
  if (!s.days || typeof s.days !== 'object') s.days = {};
  if (!Array.isArray(s.weekLog)) s.weekLog = [];
  if (!Array.isArray(s.reviews)) s.reviews = [];
  if (!Array.isArray(s.pendingRaises)) s.pendingRaises = [];
  if (typeof s.draftOneChange !== 'string') s.draftOneChange = '';
  if (!s.settings || typeof s.settings !== 'object') s.settings = {};
  if (typeof s.settings.dayBoundary !== 'number') s.settings.dayBoundary = 4;
  if (!('hintShownForItemId' in s.settings)) s.settings.hintShownForItemId = null;
  if (!s.weekStart) s.weekStart = dateKeyShift(new Date(), s.settings.dayBoundary);
  for (const it of s.items) {
    if (typeof it.raiseAfter !== 'number') it.raiseAfter = 0;
    if (typeof it.active !== 'boolean') it.active = true;
    if (!it.type) it.type = 'daily';
    if (typeof it.note !== 'string') it.note = '';
    if (typeof it.group !== 'string') it.group = '';
    if (!Array.isArray(it.history)) it.history = [];
  }

  // v1 → v2: «Принять душ», подпись тренировки, модули, посев истории планки
  if (s.schemaVersion < 2) {
    for (const it of s.items) {
      if (!it.group && DEFAULT_GROUPS[it.name]) it.group = DEFAULT_GROUPS[it.name];
      if (it.name === 'Тренировка' && !it.note) it.note = TRAIN_NOTE;
      if (typeof it.value === 'number' && isFinite(it.value) && !it.history.length) {
        it.history.push({ date: it.addedAt || dateKeyShift(new Date(), s.settings.dayBoundary), value: it.value });
      }
    }
    if (!s.items.some(i => i.name === 'Принять душ')) {
      const shower = {
        id: uid(), name: 'Принять душ', value: null, unit: '', type: 'daily',
        goal: null, note: '', group: 'Тело', active: true,
        addedAt: dateKeyShift(new Date(), s.settings.dayBoundary), raiseAfter: 0, history: []
      };
      const at = s.items.findIndex(i => i.name === 'Умыться');
      s.items.splice(at >= 0 ? at + 1 : 0, 0, shower);
    }
  }

  s.schemaVersion = SCHEMA_VERSION;
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(NS);
    if (!raw) return defaultStore();
    return migrate(JSON.parse(raw));
  } catch (e) {
    return defaultStore();
  }
}

function save() {
  try { localStorage.setItem(NS, JSON.stringify(store)); } catch (e) { /* приватный режим / переполнение */ }
}

/* ── Даты и граница дня ────────────────────────────────────── */

const pad2 = n => String(n).padStart(2, '0');

function dateKeyFromDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* Логическая дата: время до boundaryHours относится к предыдущему дню. */
function dateKeyShift(d, boundaryHours) {
  return dateKeyFromDate(new Date(d.getTime() - boundaryHours * 3600000));
}

function todayKey() {
  return dateKeyShift(new Date(), store.settings.dayBoundary);
}

function keyToDate(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0); // полдень — вне зоны перевода часов
}

function addDays(k, n) {
  const d = keyToDate(k);
  d.setDate(d.getDate() + n);
  return dateKeyFromDate(d);
}

function diffDays(a, b) {
  return Math.round((keyToDate(a) - keyToDate(b)) / 86400000);
}

function fmtLong(k) {
  const s = keyToDate(k).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtWeekday(k) {
  return keyToDate(k).toLocaleDateString('ru-RU', { weekday: 'long' });
}

function fmtDay(k) {
  return keyToDate(k).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function fmtShort(k) {
  return keyToDate(k).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ── Домены: отметки, счётчики, недели ─────────────────────── */

const activeDaily = () => store.items.filter(i => i.active && i.type === 'daily');
const activeWeekly = () => store.items.filter(i => i.active && i.type === 'weekly');

function isMarked(dayKey, itemId) {
  return !!(store.days[dayKey] && store.days[dayKey][itemId]);
}

function toggleMark(dayKey, itemId) {
  const day = store.days[dayKey] || (store.days[dayKey] = {});
  if (day[itemId]) {
    delete day[itemId];
    if (!Object.keys(day).length) delete store.days[dayKey];
  } else {
    day[itemId] = true;
  }
  save();
}

/* «Не пропускай дважды»: пункт существовал вчера и не был отмечен. */
function missedYesterday(item, tKey) {
  const y = addDays(tKey, -1);
  return item.addedAt <= y && !isMarked(y, item.id);
}

function trainCount(itemId) {
  return store.weekLog.reduce((n, e) => n + (e.itemId === itemId ? 1 : 0), 0);
}

function incTrain(itemId) {
  store.weekLog.push({ itemId, date: todayKey(), ts: Date.now() });
  save();
}

function undoTrain(itemId) {
  for (let i = store.weekLog.length - 1; i >= 0; i--) {
    if (store.weekLog[i].itemId === itemId) { store.weekLog.splice(i, 1); save(); return; }
  }
}

/* Недели скользящие: разбор доступен, когда с последнего закрытия прошло ≥7 дней. */
function reviewDue() {
  return diffDays(todayKey(), store.weekStart) >= 7;
}

/* Окно разбора — последние 7 логических дней, включая сегодня. */
function windowKeys() {
  const t = todayKey();
  const keys = [];
  for (let i = 6; i >= 0; i--) keys.push(addDays(t, -i));
  return keys;
}

/* ── Повышение минимума ────────────────────────────────────── */

/* Критерий: в каждой из 3 последних закрытых недель пункт отмечен ≥6/7,
   и с момента якоря (raiseAfter) закрыто не меньше 3 недель.
   «Не сейчас» и «Принять» сдвигают якорь — отсчёт трёх недель начинается заново. */
function raiseEligible(item) {
  if (item.type !== 'daily' || !item.active) return false;
  if (!(typeof item.value === 'number' && isFinite(item.value) && item.value > 0)) return false;
  const R = store.reviews;
  if (R.length < (item.raiseAfter || 0) + 3) return false;
  return R.slice(-3).every(r => {
    const p = r.perItem && r.perItem[item.id];
    return p && p.count >= 6;
  });
}

function raiseSuggest(v) {
  return v <= 12 ? v + 1 : Math.round(v * 1.1);
}

function resetRaiseCount(item) {
  item.raiseAfter = store.reviews.length + 1; // ждать 3 закрытий после текущей (ещё не закрытой) недели
  save();
}

/* Запись изменения планки в историю пункта.
   Повторное изменение в тот же день заменяет последнюю запись —
   в истории остаётся движение по неделям, а не правки. */
function recordBar(item, newValue) {
  if (!Array.isArray(item.history)) item.history = [];
  const last = item.history[item.history.length - 1];
  if (last && last.date === todayKey()) last.value = newValue;
  else item.history.push({ date: todayKey(), value: newValue });
}

function acceptRaise(item, newValue) {
  const from = item.value;
  item.value = newValue;
  recordBar(item, newValue);
  store.pendingRaises.push({ itemId: item.id, name: item.name, from, to: newValue });
  item.raiseAfter = store.reviews.length + 1;
  save();
}

/* Перестановка пункта в списке (универсальная настройка блоков) */
function moveItem(id, dir) {
  const i = store.items.findIndex(x => x.id === id);
  if (i < 0) return false;
  const j = i + (dir === 'up' ? -1 : 1);
  if (j < 0 || j >= store.items.length) return false;
  const t = store.items[i];
  store.items[i] = store.items[j];
  store.items[j] = t;
  save();
  return true;
}

/* ── Закрытие недели ───────────────────────────────────────── */

function closeWeek() {
  const keys = windowKeys();
  const perItem = {};
  for (const it of store.items) {
    if (it.type !== 'daily') continue;
    const marks = keys.map(k => isMarked(k, it.id));
    if (!it.active && !marks.some(Boolean)) continue; // выключенные без отметок в окне не попадают в срез
    perItem[it.id] = { name: it.name, marks, count: marks.filter(Boolean).length };
  }
  const trainings = {};
  for (const w of store.items.filter(i => i.type === 'weekly')) {
    trainings[w.id] = { name: w.name, count: trainCount(w.id), goal: w.goal };
  }
  store.reviews.push({
    closedAt: Date.now(),
    keys,
    perItem,
    trainings,
    oneChange: (store.draftOneChange || '').trim(),
    raises: store.pendingRaises
  });
  store.pendingRaises = [];
  store.draftOneChange = '';
  store.weekLog = [];        // счётчик тренировок обнуляется
  store.weekStart = todayKey(); // открывается новая неделя
  save();
}

/* ── Экспорт / импорт ──────────────────────────────────────── */

function exportJSON() {
  const blob = new Blob([JSON.stringify(store, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'minimum-' + todayKey() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function importJSON(file) {
  const r = new FileReader();
  r.onload = () => {
    let data;
    try { data = JSON.parse(r.result); } catch (e) { alert('Файл не читается как JSON.'); return; }
    if (!data || !Array.isArray(data.items) || typeof data.days !== 'object') {
      alert('Файл не похож на экспорт «Минимума».');
      return;
    }
    if (!confirm('Заменить текущие данные данными из файла?')) return;
    store = migrate(data);
    save();
    renderAll();
  };
  r.readAsText(file);
}

/* ── Интерфейс ─────────────────────────────────────────────── */

const ui = {
  tab: 'today',
  editingId: null,
  addOpen: false,
  addType: 'daily',
  raiseEdit: {},   // itemId -> true, когда открыт ввод своего значения
  missOpen: {},    // itemId -> true, когда показана подпись «вчера — пропуск»
  justClosed: false
};

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function valUnit(it) {
  const parts = [];
  if (typeof it.value === 'number' && isFinite(it.value)) parts.push(String(it.value));
  if (it.unit) parts.push(it.unit);
  return parts.join(' ');
}

function el(id) { return document.getElementById(id); }

function renderAll() {
  const map = { today: 'scr-today', review: 'scr-review', items: 'scr-items', system: 'scr-system' };
  for (const [tab, id] of Object.entries(map)) el(id).hidden = tab !== ui.tab;
  document.querySelectorAll('#tabs button').forEach(b => {
    if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (ui.tab === 'today') renderToday();
  if (ui.tab === 'review') renderReview();
  if (ui.tab === 'items') renderItems();
  if (ui.tab === 'system') renderSystem();
  window.scrollTo(0, 0);
}

/* Экран 1 — «Сегодня» */
function renderToday() {
  const t = todayKey();
  const items = activeDaily();
  const done = items.filter(i => isMarked(t, i.id)).length;
  const total = items.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const closed = total > 0 && done === total;

  let h = `
    <header class="page">
      <p class="overline">${esc(fmtWeekday(t))}</p>
      <h1>${esc(fmtDay(t))}</h1>
    </header>`;

  if (reviewDue()) {
    h += `<button class="banner" data-act="goto-review"><span>Доступен разбор недели</span><span class="chev" aria-hidden="true">&rsaquo;</span></button>`;
  }

  h += `
    <div class="dayline">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="bar-note${closed ? ' ok' : ''}">${closed ? 'День закрыт' : (total ? `<b>${done}</b>&nbsp;из&nbsp;${total}` : 'Нет активных пунктов')}</p>
    </div>`;

  h += `<div class="list">`;
  let curGroup = null;
  for (const it of items) {
    const g = (it.group || '').trim();
    if (g !== curGroup) {
      if (g) h += `<p class="g-label">${esc(g)}</p>`;
      curGroup = g;
    }
    const on = isMarked(t, it.id);
    const miss = missedYesterday(it, t);
    const vu = valUnit(it);
    h += `
      <div class="rowwrap">
        <label class="row check${on ? ' on' : ''}">
          <input type="checkbox" data-act="mark" data-id="${it.id}"${on ? ' checked' : ''}>
          <span class="box" aria-hidden="true"></span>
          <span class="txt">
            <span class="tname">${esc(it.name)}${vu ? ` <span class="val">${esc(vu)}</span>` : ''}</span>
            ${it.note ? `<span class="note">${esc(it.note)}</span>` : ''}
          </span>
          ${miss ? `<button type="button" class="dot" data-act="miss-note" data-id="${it.id}" aria-label="вчера — пропуск"><i></i></button>` : ''}
        </label>
        ${miss && ui.missOpen[it.id] ? `<p class="miss-note">вчера — пропуск</p>` : ''}
      </div>`;
  }
  h += `</div>`;

  for (const w of activeWeekly()) {
    const n = trainCount(w.id);
    h += `
      <div class="weekcount">
        <span class="txt">
          <span class="tname">${esc(w.name)}</span>
          ${w.note ? `<span class="note">${esc(w.note)}</span>` : ''}
        </span>
        <span class="wctl">
          <span class="wnum"><b>${n}</b>&thinsp;/&thinsp;${w.goal || 0}</span>
          <button class="btn icon plus" data-act="train-inc" data-id="${w.id}" aria-label="плюс один">+</button>
        </span>
      </div>
      ${n ? `<button class="undo" data-act="train-undo" data-id="${w.id}">отменить последний</button>` : ''}`;
  }

  h += `<p class="creed">Минимум выполняется даже в худший день.</p>`;

  el('scr-today').innerHTML = h;
}

/* Экран 2 — «Разбор недели» */
function renderReview() {
  let h = `<header class="page"><p class="overline">Раз в неделю</p><h1>Разбор недели</h1></header>`;

  if (!reviewDue()) {
    const passed = diffDays(todayKey(), store.weekStart);
    const left = 7 - passed;
    if (ui.justClosed) h += `<p class="lead">Неделя закрыта.</p>`;
    h += `<p class="muted">Идёт ${passed + 1}-й день недели. Разбор откроется через ${left} ${plural(left, 'день', 'дня', 'дней')}.</p>`;
    h += `<p class="muted">Неделя началась ${esc(fmtShort(store.weekStart))}.</p>`;
    el('scr-review').innerHTML = h;
    return;
  }
  ui.justClosed = false;

  const keys = windowKeys();
  const gridItems = store.items.filter(it =>
    it.type === 'daily' && (it.active || keys.some(k => isMarked(k, it.id))));

  h += `<p class="muted">${esc(fmtShort(keys[0]))} — ${esc(fmtShort(keys[6]))}</p>`;

  // Сетка 7 дней × пункты
  h += `<div class="grid" style="--cols:${keys.length}">`;
  h += `<span class="g-head"></span>` + keys.map(k => `<span class="g-head">${Number(k.slice(8))}</span>`).join('');
  for (const it of gridItems) {
    h += `<span class="g-name">${esc(it.name)}</span>`;
    h += keys.map(k => `<i class="c${isMarked(k, it.id) ? ' on' : ''}"></i>`).join('');
  }
  h += `</div>`;

  // Итог тренировок
  for (const w of store.items.filter(i => i.type === 'weekly' && i.active)) {
    h += `<p class="line">${esc(w.name)}: ${trainCount(w.id)} из ${w.goal || 0}</p>`;
  }

  // Консистентность за 3 последних закрытых недели
  h += `<h2>Три закрытые недели</h2>`;
  if (!store.reviews.length) {
    h += `<p class="muted">Закрытых недель пока нет.</p>`;
  } else {
    const last3 = store.reviews.slice(-3);
    h += `<div class="consist">`;
    for (const it of gridItems) {
      const counts = last3.map(r => (r.perItem && r.perItem[it.id]) ? r.perItem[it.id].count : '—');
      h += `<span class="c-name">${esc(it.name)}</span><span class="c-val">${counts.join(' · ')} из 7</span>`;
    }
    h += `</div>`;
  }

  // Предложения повышения
  for (const it of gridItems) {
    if (!raiseEligible(it)) continue;
    const sug = raiseSuggest(it.value);
    const editing = ui.raiseEdit[it.id];
    h += `
      <div class="card raise" data-raise="${it.id}">
        <p>${esc(it.name)}: три недели подряд не меньше 6 из 7.</p>
        <p class="raise-line">Повысить ${esc(String(it.value))} →
          ${editing
            ? `<input class="num" id="raise-${it.id}" type="text" inputmode="decimal" value="${esc(String(sug))}">`
            : `<b>${esc(String(sug))}</b>`}
          ${it.unit ? esc(it.unit) : ''}?</p>
        <div class="btns">
          <button class="btn" data-act="raise-ok" data-id="${it.id}">Принять</button>
          ${editing ? '' : `<button class="btn quiet" data-act="raise-edit" data-id="${it.id}">Изменить</button>`}
          <button class="btn quiet" data-act="raise-later" data-id="${it.id}">Не сейчас</button>
        </div>
      </div>`;
  }

  // Одно изменение
  h += `
    <label class="field">
      <span>Одно изменение на следующую неделю</span>
      <input type="text" data-bind="one-change" value="${esc(store.draftOneChange)}" placeholder="необязательно">
    </label>
    <button class="btn primary wide" data-act="close-week">Закрыть неделю</button>`;

  el('scr-review').innerHTML = h;
}

/* Экран 3 — «Пункты и настройки» */
function groupList() {
  const canon = ['Тело', 'Движение', 'Сон', 'Развитие'];
  const seen = [];
  for (const it of store.items) {
    const g = (it.group || '').trim();
    if (g && !seen.includes(g)) seen.push(g);
  }
  for (const g of canon) if (!seen.includes(g)) seen.push(g);
  return seen;
}

function barHistory(it) {
  if (!Array.isArray(it.history) || it.history.length < 2) return '';
  const vals = it.history.map(x => String(x.value));
  const shown = vals.length > 6 ? ['…'].concat(vals.slice(-6)) : vals;
  const last = it.history[it.history.length - 1];
  return `<span class="hist">Планка: ${shown.map(esc).join(' → ')}${it.unit ? ' ' + esc(it.unit) : ''} · с ${esc(fmtShort(last.date))}</span>`;
}

function renderItems() {
  let h = `<header class="page"><p class="overline">Настройка блоков</p><h1>Пункты</h1></header>`;

  h += `<div class="list">`;
  store.items.forEach((it, idx) => {
    const vu = valUnit(it);
    const meta = [vu, it.type === 'weekly' ? `цель ${it.goal || 0} / нед.` : '', (it.group || '').trim()]
      .filter(Boolean).join(' · ');
    h += `
      <div class="rowwrap${it.active ? '' : ' off'}">
        <div class="row item">
          <button class="itxt" data-act="edit-open" data-id="${it.id}" aria-label="изменить «${esc(it.name)}»">
            <span class="tname">${esc(it.name)}</span>
            ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
            ${it.note ? `<span class="note">${esc(it.note)}</span>` : ''}
            ${barHistory(it)}
          </button>
          <span class="ictl">
            <button class="btn icon quiet" data-act="move-up" data-id="${it.id}"${idx === 0 ? ' disabled' : ''} aria-label="выше">&uarr;</button>
            <button class="btn icon quiet" data-act="move-down" data-id="${it.id}"${idx === store.items.length - 1 ? ' disabled' : ''} aria-label="ниже">&darr;</button>
            <label class="switch" aria-label="включён">
              <input type="checkbox" data-act="toggle-active" data-id="${it.id}"${it.active ? ' checked' : ''}>
              <span></span>
            </label>
          </span>
        </div>
        ${ui.editingId === it.id ? editForm(it) : ''}
      </div>`;
  });
  h += `</div>`;

  h += ui.addOpen ? addForm() : `<button class="btn wide" data-act="add-open">Добавить пункт</button>`;

  const hours = [];
  for (let i = 0; i <= 8; i++) hours.push(`<option value="${i}"${store.settings.dayBoundary === i ? ' selected' : ''}>${pad2(i)}:00</option>`);
  h += `
    <h2>Граница дня</h2>
    <label class="field inline">
      <span>Смена дня в</span>
      <select data-act="boundary">${hours.join('')}</select>
    </label>
    <p class="muted">Отметки до этого часа относятся к предыдущему дню.</p>`;

  h += `
    <h2>Данные</h2>
    <div class="btns">
      <button class="btn" data-act="export">Экспорт JSON</button>
      <button class="btn" data-act="import">Импорт JSON</button>
    </div>
    <input type="file" id="import-file" accept="application/json,.json" hidden>
    <p class="muted">Экспортируйте данные время от времени: localStorage может быть очищен системой.</p>`;

  el('scr-items').innerHTML = h;
}

function groupField(idPrefix, value) {
  const opts = groupList().map(g => `<option value="${esc(g)}"></option>`).join('');
  return `
    <label class="field"><span>Модуль</span>
      <input type="text" id="${idPrefix}-group" list="groups-dl" value="${esc(value || '')}" placeholder="Тело">
      <datalist id="groups-dl">${opts}</datalist>
    </label>`;
}

function editForm(it) {
  return `
    <div class="card form" data-form="edit" data-id="${it.id}">
      <label class="field"><span>Название</span><input type="text" id="e-name" value="${esc(it.name)}"></label>
      <label class="field"><span>Подпись</span><input type="text" id="e-note" value="${esc(it.note || '')}" placeholder="необязательная строка под названием"></label>
      <div class="pair">
        <label class="field"><span>Значение</span><input class="num" type="text" inputmode="decimal" id="e-value" value="${it.value ?? ''}"></label>
        <label class="field"><span>Единица</span><input type="text" id="e-unit" value="${esc(it.unit || '')}"></label>
      </div>
      ${groupField('e', it.group)}
      ${it.type === 'weekly' ? `<label class="field"><span>Цель за неделю</span><input class="num" type="text" inputmode="numeric" id="e-goal" value="${it.goal ?? ''}"></label>` : ''}
      <div class="btns">
        <button class="btn primary" data-act="edit-save" data-id="${it.id}">Сохранить</button>
        <button class="btn quiet" data-act="edit-cancel">Отмена</button>
      </div>
    </div>`;
}

function addForm() {
  const hint = ui.addHint
    ? `<p class="hint">Правило системы: одна новая привычка за раз. Последний пункт добавлен меньше 14 дней назад.</p>`
    : '';
  return `
    <div class="card form" data-form="add">
      ${hint}
      <label class="field"><span>Название</span><input type="text" id="f-name" placeholder="Например: чтение"></label>
      <label class="field"><span>Подпись</span><input type="text" id="f-note" placeholder="необязательная строка под названием"></label>
      <div class="pair">
        <label class="field"><span>Значение</span><input class="num" type="text" inputmode="decimal" id="f-value" placeholder="10"></label>
        <label class="field"><span>Единица</span><input type="text" id="f-unit" placeholder="мин"></label>
      </div>
      ${groupField('f', '')}
      <label class="field"><span>Тип</span>
        <select id="f-type" data-act="add-type">
          <option value="daily"${ui.addType === 'daily' ? ' selected' : ''}>ежедневный чекбокс</option>
          <option value="weekly"${ui.addType === 'weekly' ? ' selected' : ''}>недельный счётчик с целью</option>
        </select>
      </label>
      ${ui.addType === 'weekly' ? `<label class="field"><span>Цель за неделю</span><input class="num" type="text" inputmode="numeric" id="f-goal" value="3"></label>` : ''}
      <div class="btns">
        <button class="btn primary" data-act="add-save">Добавить</button>
        <button class="btn quiet" data-act="add-cancel">Отмена</button>
      </div>
    </div>`;
}

/* Экран 4 — «Система» */
function renderSystem() {
  let h = `<header class="page"><p class="overline">Как это устроено</p><h1>Система</h1></header>`;
  for (const s of SYSTEM_TEXTS) {
    h += `<section class="sys"><h2>${esc(s.title)}</h2>`;
    if (s.kind === 'rules') {
      h += `<ol class="rules">` + s.items.map(r => `<li>${esc(r)}</li>`).join('') + `</ol>`;
    } else if (s.kind === 'leads') {
      h += s.items.map(x => `<p class="lead-p"><strong>${esc(x.lead)}</strong> ${esc(x.text)}</p>`).join('');
    } else if (s.kind === 'note') {
      h += `<p class="note-block">${esc(s.text)}</p>`;
    }
    h += `</section>`;
  }
  el('scr-system').innerHTML = h;
}

/* ── Обработчики ───────────────────────────────────────────── */

function parseNum(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const id = b.dataset.id;
  const item = id ? store.items.find(i => i.id === id) : null;

  switch (act) {
    case 'goto-review': ui.tab = 'review'; renderAll(); break;

    case 'miss-note':
      e.preventDefault();
      ui.missOpen[id] = !ui.missOpen[id];
      renderToday();
      break;

    case 'train-inc': incTrain(id); renderToday(); break;
    case 'train-undo': undoTrain(id); renderToday(); break;

    case 'raise-edit': ui.raiseEdit[id] = true; renderReview(); break;
    case 'raise-later':
      if (item) { resetRaiseCount(item); delete ui.raiseEdit[id]; renderReview(); }
      break;
    case 'raise-ok': {
      if (!item) break;
      const input = el('raise-' + id);
      const v = input ? parseNum(input.value) : raiseSuggest(item.value);
      if (v === null || v <= 0) break;
      acceptRaise(item, v);
      delete ui.raiseEdit[id];
      renderReview();
      break;
    }

    case 'close-week':
      closeWeek();
      ui.justClosed = true;
      renderReview();
      break;

    case 'move-up': if (moveItem(id, 'up')) renderItems(); break;
    case 'move-down': if (moveItem(id, 'down')) renderItems(); break;

    case 'edit-open': ui.editingId = id; ui.addOpen = false; renderItems(); break;
    case 'edit-cancel': ui.editingId = null; renderItems(); break;
    case 'edit-save': {
      if (!item) break;
      const name = el('e-name').value.trim();
      if (name) item.name = name;
      const oldV = item.value;
      item.value = parseNum(el('e-value').value);
      item.unit = el('e-unit').value.trim();
      item.note = el('e-note').value.trim();
      item.group = el('e-group').value.trim();
      if (typeof item.value === 'number' && item.value !== oldV) recordBar(item, item.value);
      if (item.type === 'weekly') {
        const g = parseNum(el('e-goal') ? el('e-goal').value : null);
        item.goal = g && g > 0 ? Math.round(g) : item.goal;
      }
      save();
      ui.editingId = null;
      renderItems();
      break;
    }

    case 'add-open': {
      ui.addOpen = true; ui.editingId = null; ui.addType = 'daily';
      // Подсказка «одна новая привычка за раз» — один раз, если последний пункт моложе 14 дней
      const newest = store.items.reduce((a, b) => (!a || b.addedAt > a.addedAt) ? b : a, null);
      ui.addHint = !!(newest && diffDays(todayKey(), newest.addedAt) < 14 &&
        store.settings.hintShownForItemId !== newest.id);
      if (ui.addHint) { store.settings.hintShownForItemId = newest.id; save(); }
      renderItems();
      break;
    }
    case 'add-cancel': ui.addOpen = false; ui.addHint = false; renderItems(); break;
    case 'add-save': {
      const name = el('f-name').value.trim();
      if (!name) { el('f-name').focus(); break; }
      const type = el('f-type').value === 'weekly' ? 'weekly' : 'daily';
      const goalEl = el('f-goal');
      const g = type === 'weekly' ? (parseNum(goalEl ? goalEl.value : '3') || 3) : null;
      const value = parseNum(el('f-value').value);
      store.items.push({
        id: uid(), name, value,
        unit: el('f-unit').value.trim(),
        note: el('f-note').value.trim(),
        group: el('f-group').value.trim(),
        type, goal: g ? Math.round(g) : null,
        active: true, addedAt: todayKey(), raiseAfter: 0,
        history: (typeof value === 'number') ? [{ date: todayKey(), value }] : []
      });
      save();
      ui.addOpen = false;
      renderItems();
      break;
    }

    case 'export': exportJSON(); break;
    case 'import': el('import-file').click(); break;
  }
}

function onChange(e) {
  const t = e.target;
  const act = t.dataset.act;
  if (act === 'mark') {
    toggleMark(todayKey(), t.dataset.id);
    renderToday();
  } else if (act === 'toggle-active') {
    const item = store.items.find(i => i.id === t.dataset.id);
    if (item) { item.active = t.checked; save(); renderItems(); }
  } else if (act === 'boundary') {
    store.settings.dayBoundary = Number(t.value) || 0;
    save();
    renderItems();
  } else if (act === 'add-type') {
    ui.addType = t.value;
    const keep = { name: el('f-name').value, value: el('f-value').value, unit: el('f-unit').value,
      note: el('f-note').value, group: el('f-group').value };
    renderItems();
    el('f-name').value = keep.name; el('f-value').value = keep.value; el('f-unit').value = keep.unit;
    el('f-note').value = keep.note; el('f-group').value = keep.group;
  } else if (t.id === 'import-file') {
    if (t.files && t.files[0]) importJSON(t.files[0]);
    t.value = '';
  }
}

function onInput(e) {
  if (e.target.dataset.bind === 'one-change') {
    store.draftOneChange = e.target.value;
    save();
  }
}

/* ── Запуск ────────────────────────────────────────────────── */

function init() {
  store = load();
  save();
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.querySelectorAll('#tabs button').forEach(b =>
    b.addEventListener('click', () => { ui.tab = b.dataset.tab; renderAll(); }));
  renderAll();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

/* Тестовый хук для Node; в браузере — обычный запуск. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    get store() { return store; }, set store(v) { store = v; },
    defaultStore, migrate, dateKeyShift, dateKeyFromDate, addDays, diffDays,
    todayKey, toggleMark, isMarked, incTrain, undoTrain, trainCount,
    reviewDue, windowKeys, raiseEligible, raiseSuggest, resetRaiseCount,
    acceptRaise, closeWeek, missedYesterday, plural, parseNum,
    moveItem, recordBar
  };
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
