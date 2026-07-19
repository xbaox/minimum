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
const SCHEMA_VERSION = 6;

let store = null;
let saveFailed = false; // хранилище недоступно — «Сегодня» показывает тихий баннер

const uid = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

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

/* Понедельник дня k, если k — понедельник, иначе ближайший следующий */
function nextCalendarMonday(k) {
  const mon = weekStartOf(k);
  return mon === k ? k : addDays(mon, 7);
}

/* Стартовая программа привычек — тот же посев идёт миграцией v5 */
function seedHabits(today) {
  const habit = (name) => ({
    id: uid(), name, value: null, unit: '', type: 'daily', area: 'habit', normPerWeek: 7,
    goal: null, note: '', group: '', active: true, addedAt: today, raiseAfter: 0, history: []
  });
  return [
    { id: uid(), name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
      pkind: 'time', pvalue: 0, pstep: -15, goal: null, note: '', group: '',
      active: true, addedAt: today, raiseAfter: 0, history: [{ date: today, value: 0 }] },
    habit('Перестать грызть ногти'),
    habit('Ловить импульс трат → алгоритм')
  ];
}

function defaultStore() {
  const today = dateKeyShift(new Date(), 4);
  const mk = (name, value, unit, type, goal, note) => ({
    id: uid(), name, value, unit, type, area: 'min',
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
      mk('Тренировка', null, '', 'weekly', 3, TRAIN_NOTE),
      ...seedHabits(today)
    ],
    days: {},          // "YYYY-MM-DD" -> { itemId: true }
    weekLog: [],       // инкременты недельных счётчиков текущей календарной недели
    reviews: [],       // закрытые недели
    pendingRaises: [], // принятые повышения, ещё не записанные в разбор
    paramDecided: {},  // itemId -> {week, from, to|null}: решения по параметрам, привязанные к разбираемой неделе
    draftOneChange: '',
    weekStart: today,  // историческая отсечка скользящей эпохи
    settings: {
      dayBoundary: 4,
      exportedAt: null,
      calendarSince: nextCalendarMonday(today),
      habitSeeded: true
    }
  };
}

/* Числовое поле из внешних данных: число или числовая строка
   (запятая как точка); всё остальное — fallback. */
function numOr(v, fallback) {
  if (typeof v === 'number') return isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(',', '.'));
    return isFinite(n) ? n : fallback;
  }
  return fallback;
}

/* Миграции схемы. При изменении структуры: поднять SCHEMA_VERSION
   и добавить шаг вида if (s.schemaVersion < N) { ...; }.
   Толерантна к мусору: не-объекты отбрасываются, обязательные поля
   достраиваются, числовые приводятся или обнуляются — импортированный
   или повреждённый store не должен ронять ни migrate, ни рендер. */
function migrate(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return defaultStore();
  s.schemaVersion = numOr(s.schemaVersion, 0) || 1; // мусорная версия = v1, шаги миграций не пропускаются

  // настройки — первыми: от dayBoundary зависит «сегодня» для достройки дат
  if (!s.settings || typeof s.settings !== 'object' || Array.isArray(s.settings)) s.settings = {};
  if (typeof s.settings.dayBoundary !== 'number' || !isFinite(s.settings.dayBoundary)) s.settings.dayBoundary = 4;
  const today = dateKeyShift(new Date(), s.settings.dayBoundary);

  // пункты: только объекты; id и addedAt достраиваются, id дедуплицируются
  if (!Array.isArray(s.items)) s.items = [];
  s.items = s.items.filter(it => it && typeof it === 'object' && !Array.isArray(it));
  const ids = new Set();
  for (const it of s.items) {
    if (typeof it.id !== 'string' || !it.id || ids.has(it.id)) it.id = uid();
    ids.add(it.id);
    if (!isDayKey(it.addedAt)) it.addedAt = today;
    it.type = it.type === 'weekly' ? 'weekly' : (it.type === 'param' ? 'param' : 'daily');
    it.area = it.area === 'habit' ? 'habit' : 'min';
    if (it.type === 'weekly') it.area = 'min'; // недельный счётчик принадлежит только минимуму (инвариант 10)
    if (typeof it.active !== 'boolean') it.active = true;
    if (typeof it.name !== 'string') it.name = '';
    if (typeof it.unit !== 'string') it.unit = '';
    if (typeof it.note !== 'string') it.note = '';
    if (typeof it.group !== 'string') it.group = '';
    it.value = numOr(it.value, null);
    if (it.value !== null && it.value <= 0) it.value = null; // планка всегда > 0, как и в формах
    if (it.type === 'param') {
      it.area = 'habit'; // параметры существуют только в области привычек
      it.value = null;   // и не несут планку минимума
      it.pkind = it.pkind === 'number' ? 'number' : 'time';
      let pv = numOr(it.pvalue, 0);
      if (it.pkind === 'time') pv = ((Math.round(pv) % 1440) + 1440) % 1440; // минуты суток
      it.pvalue = pv; // числовой порог может быть дробным — формы его не округляют
      it.pstep = Math.round(numOr(it.pstep, 0));
    }
    if (it.type === 'daily' && it.area === 'habit') {
      // норма недели (инвариант 11): целое 1–7, невалид — к ближайшему допустимому
      it.normPerWeek = Math.max(1, Math.min(7, Math.round(numOr(it.normPerWeek, 7))));
    } else {
      delete it.normPerWeek; // норма — только у привычек
    }
    const g = numOr(it.goal, null);
    it.goal = g !== null && Math.round(g) >= 1 ? Math.round(g) : null;
    it.raiseAfter = Math.max(0, Math.round(numOr(it.raiseAfter, 0)));
    if (!Array.isArray(it.history)) it.history = [];
    it.history = it.history
      .filter(h => h && typeof h === 'object' && !Array.isArray(h) && isDayKey(h.date))
      .map(h => ({ date: h.date, value: numOr(h.value, null) }))
      .filter(h => h.value !== null);
  }

  // отметки: ключ — валидный день, значение — непустой объект с булевыми
  // полями (как их оставляет toggleMark); иначе запись отбрасывается
  if (!s.days || typeof s.days !== 'object' || Array.isArray(s.days)) s.days = {};
  for (const k of Object.keys(s.days)) {
    const day = s.days[k];
    const ok = isDayKey(k) && day && typeof day === 'object' && !Array.isArray(day) &&
      Object.keys(day).length > 0 &&
      Object.values(day).every(v => typeof v === 'boolean');
    if (!ok) delete s.days[k];
  }

  if (!Array.isArray(s.weekLog)) s.weekLog = [];
  s.weekLog = s.weekLog.filter(e => e && typeof e === 'object' && !Array.isArray(e));
  if (!Array.isArray(s.reviews)) s.reviews = [];
  s.reviews = s.reviews.filter(r => r && typeof r === 'object' && !Array.isArray(r));
  if (!Array.isArray(s.pendingRaises)) s.pendingRaises = [];
  s.pendingRaises = s.pendingRaises.filter(e => e && typeof e === 'object' && !Array.isArray(e));
  if (!s.paramDecided || typeof s.paramDecided !== 'object' || Array.isArray(s.paramDecided)) s.paramDecided = {};
  for (const k of Object.keys(s.paramDecided)) {
    const d = s.paramDecided[k];
    const ok = d && typeof d === 'object' && !Array.isArray(d) && isDayKey(d.week) &&
      typeof d.from === 'number' && (d.to === null || typeof d.to === 'number');
    if (!ok) delete s.paramDecided[k];
  }
  if (typeof s.settings.habitSeeded !== 'boolean') s.settings.habitSeeded = false;
  if (typeof s.draftOneChange !== 'string') s.draftOneChange = '';
  if (!isDayKey(s.weekStart)) s.weekStart = today;

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
        id: uid(), name: 'Принять душ', value: null, unit: '', type: 'daily', area: 'min',
        goal: null, note: '', group: 'Тело', active: true,
        addedAt: dateKeyShift(new Date(), s.settings.dayBoundary), raiseAfter: 0, history: []
      };
      const at = s.items.findIndex(i => i.name === 'Умыться');
      s.items.splice(at >= 0 ? at + 1 : 0, 0, shower);
    }
  }

  // v2 → v3: срез недели получает weekStart — период счёта тренировок
  if (s.schemaVersion < 3) {
    for (const r of s.reviews) {
      if (!isDayKey(r.weekStart)) {
        r.weekStart = (Array.isArray(r.keys) && isDayKey(r.keys[0])) ? r.keys[0] : today;
      }
    }
  }

  // v3 → v4: отметка последнего экспорта — мягкий дефолт
  if (s.schemaVersion < 4) {
    if (!('exportedAt' in s.settings)) s.settings.exportedAt = null;
  }

  // v4 → v5: календарные недели и программа привычек; мёртвое поле подсказки вычищается
  if (s.schemaVersion < 5) {
    if (!isDayKey(s.settings.calendarSince)) {
      s.settings.calendarSince = nextCalendarMonday(dateKeyShift(new Date(), s.settings.dayBoundary));
    }
    if (!s.settings.habitSeeded) { // однократность посева — по флагу, не по именам
      s.items.push(...seedHabits(dateKeyShift(new Date(), s.settings.dayBoundary)));
      s.settings.habitSeeded = true;
    }
    delete s.settings.hintShownForItemId;
  }

  // v5 → v6: недельная норма привычек (normPerWeek = 7) — достраивается
  // безусловной валидацией пунктов выше, отдельный шаг не нужен; миграция
  // аддитивна: days{} и reviews[] не изменяются (решение владельца 19.07.2026)
  // рукотворный/битый calendarSince приводится тем же правилом; не-понедельник
  // нормализуется вперёд — недели существуют только целиком
  if (!isDayKey(s.settings.calendarSince)) {
    s.settings.calendarSince = nextCalendarMonday(dateKeyShift(new Date(), s.settings.dayBoundary));
  } else if (weekStartOf(s.settings.calendarSince) !== s.settings.calendarSince) {
    s.settings.calendarSince = nextCalendarMonday(s.settings.calendarSince);
  }

  s.schemaVersion = SCHEMA_VERSION;
  return s;
}

/* Чтение localStorage: store при валидной строке, null при пустой или битой —
   дальше решает стартовая проверка init() (зеркало или дефолт, инвариант 9).
   Битая строка сохраняется в corrupt-ключ до любого восстановления. */
function load() {
  let raw = null;
  try { raw = localStorage.getItem(NS); } catch (e) { return null; }
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw));
  } catch (e) {
    // нечитаемые данные не уничтожаются: сырая строка уходит в резервный ключ
    try { localStorage.setItem(NS + ':corrupt', raw); } catch (e2) { /* некуда сохранить */ }
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(NS, JSON.stringify(store));
    saveFailed = false; // первый успешный save снимает флаг
    scheduleMirror();   // успешное сохранение дублируется в зеркало (инвариант 9)
  } catch (e) {
    saveFailed = true; // приватный режим / переполнение — баннер на «Сегодня» при следующем рендере
  }
}

/* ── Зеркало в IndexedDB (инвариант 9) ─────────────────────────
   Тонкая обёртка: open/get/put, все ошибки глушатся — недоступность
   IndexedDB не меняет поведение приложения. */

const IDB_NAME = 'minimum';
const IDB_STORE = 'mirror';
const IDB_KEY = 'snapshot';

let mirrorTimer = null;
let mirrorDirty = false; // есть изменения, не доехавшие до зеркала
let mirrorReady = false; // стартовая проверка init() завершена — писать можно

function idbOpen() {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(IDB_STORE); } catch (e) { /* уже есть */ }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

function mirrorRead() {
  return idbOpen().then(db => new Promise(resolve => {
    if (!db) { resolve(null); return; }
    try {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => { resolve(req.result || null); db.close(); };
      req.onerror = () => { resolve(null); db.close(); };
    } catch (e) { resolve(null); try { db.close(); } catch (e2) {} }
  })).catch(() => null);
}

function mirrorWrite(snapshot) {
  return idbOpen().then(db => new Promise(resolve => {
    if (!db) { resolve(false); return; }
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(snapshot, IDB_KEY);
      tx.oncomplete = () => { resolve(true); db.close(); };
      tx.onerror = () => { resolve(false); db.close(); };
      tx.onabort = () => { resolve(false); db.close(); };
    } catch (e) { resolve(false); try { db.close(); } catch (e2) {} }
  })).catch(() => false);
}

/* Дебаунс ~500 мс: частые отметки не молотят IndexedDB */
function scheduleMirror() {
  if (!mirrorReady || typeof indexedDB === 'undefined') return;
  mirrorDirty = true;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(flushMirror, 500);
}

/* Немедленный сброс незаписанного снапшота (pagehide, уход в фон, тесты) */
function flushMirror() {
  if (!mirrorReady || !mirrorDirty) return Promise.resolve(false);
  mirrorDirty = false;
  clearTimeout(mirrorTimer);
  return mirrorWrite({
    json: JSON.stringify(store),
    savedAt: Date.now(),
    schemaVersion: store.schemaVersion
  }).then(ok => {
    if (!ok) mirrorDirty = true; // сбой записи — изменения не потеряны, доедут со следующим flush
    return ok;
  });
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

/* Валидный ключ логического дня: формат YYYY-MM-DD и существующая дата */
function isDayKey(k) {
  return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) &&
    dateKeyFromDate(keyToDate(k)) === k;
}

/* Понедельник календарной недели, которой принадлежит логический день */
function weekStartOf(dayKey) {
  const dow = (keyToDate(dayKey).getDay() + 6) % 7; // 0 — понедельник
  return addDays(dayKey, -dow);
}

/* Миллисекунды до ближайшего момента границы дня */
function msToNextBoundary() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    store.settings.dayBoundary, 0, 0, 0);
  while (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
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

/* Дата и время из миллисекунд — для строки резервной копии */
function fmtStamp(ms) {
  return new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

/* Единственная допустимая правка прошлого (инвариант 7): установить отметку
   за вчера через точку-маркер. Только вчера, только установка — не снятие. */
function markYesterday(itemId) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || !item.active || item.type !== 'daily') return false;
  const y = addDays(todayKey(), -1);
  if (!(item.addedAt <= y)) return false;
  if (isMarked(y, item.id)) return false;
  const day = store.days[y] || (store.days[y] = {});
  day[item.id] = true;
  save();
  return true;
}

/* Начало текущего периода счёта тренировок: календарная неделя, а в
   переходные дни до calendarSince — прежняя скользящая отсечка weekStart */
function trainSince() {
  return currentWeekStart() || store.weekStart;
}

function trainCount(itemId) {
  const since = trainSince();
  return store.weekLog.reduce((n, e) => n + (e.itemId === itemId && e.date >= since ? 1 : 0), 0);
}

function incTrain(itemId) {
  store.weekLog.push({ itemId, date: todayKey(), ts: Date.now() });
  save();
}

/* Отмена — только записей текущей недели (прошлое неизменяемо) */
function undoTrain(itemId) {
  const since = trainSince();
  for (let i = store.weekLog.length - 1; i >= 0; i--) {
    const e = store.weekLog[i];
    if (e.itemId === itemId && e.date >= since) { store.weekLog.splice(i, 1); save(); return; }
  }
}

/* Календарные недели (инвариант 2): понедельник–воскресенье в логических днях */
function currentWeekStart() {
  const t = todayKey();
  const since = store.settings.calendarSince;
  if (!isDayKey(since) || t < since) return null; // переходные дни до calendarSince
  return weekStartOf(t);
}

function previousWeekStart() {
  const cur = currentWeekStart();
  return cur ? addDays(cur, -7) : null;
}

/* Разбор предлагается только за последнюю завершённую календарную неделю.
   Пропущенные недели тихо проходят; скользящие записи reviews (без week)
   первый календарный разбор не блокируют. Уже разобранная неделя не
   разбирается повторно, где бы её запись ни стояла в reviews. */
function reviewDue() {
  const prev = previousWeekStart();
  if (!prev || prev < store.settings.calendarSince) return false;
  return !store.reviews.some(r => r.week === prev);
}

/* Окно разбора — ровно последняя завершённая неделя; сегодня не входит */
function windowKeys() {
  const prev = previousWeekStart();
  const keys = [];
  if (!prev) return keys;
  for (let i = 0; i < 7; i++) keys.push(addDays(prev, i));
  return keys;
}

/* Последнее записанное «одно изменение» — тихая строка на разборе (инвариант 3) */
function currentOneChange() {
  const last = store.reviews[store.reviews.length - 1];
  const s = (last && typeof last.oneChange === 'string') ? last.oneChange.trim() : '';
  return s || null;
}

/* ── Повышение минимума ────────────────────────────────────── */

/* Критерий: в каждой из 3 последних закрытых недель пункт отмечен ≥6/7,
   и с момента якоря (raiseAfter) закрыто не меньше 3 недель.
   «Не сейчас» и «Принять» сдвигают якорь — отсчёт трёх недель начинается заново. */
function raiseEligible(item) {
  if (item.type !== 'daily' || !item.active || item.area !== 'min') return false; // повышение — только минимум
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
   Повторное изменение в тот же день заменяет последнюю запись,
   возврат к прежнему значению схлопывает её — в истории остаётся
   движение по неделям без правок и дублей («5 → 5» не бывает). */
function recordBar(item, newValue) {
  if (!Array.isArray(item.history)) item.history = [];
  const last = item.history[item.history.length - 1];
  if (last && last.date === todayKey()) {
    const prev = item.history[item.history.length - 2];
    if (prev && prev.value === newValue) item.history.pop();
    else last.value = newValue;
  } else if (!last || last.value !== newValue) {
    item.history.push({ date: todayKey(), value: newValue });
  }
}

function acceptRaise(item, newValue) {
  const from = item.value;
  item.value = newValue;
  recordBar(item, newValue);
  store.pendingRaises.push({ itemId: item.id, name: item.name, from, to: newValue });
  item.raiseAfter = store.reviews.length + 1;
  save();
}

/* ── Параметры недели и готовность к новой привычке (area habit) ── */

function fmtParam(item, v) {
  const val = (v === undefined) ? item.pvalue : v;
  if (item.pkind === 'time') {
    const m = ((Math.round(val) % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  return item.unit ? `${val} ${item.unit}` : String(val);
}

function paramStepTarget(item) {
  if (item.pkind === 'time') return (((item.pvalue + item.pstep) % 1440) + 1440) % 1440;
  return item.pvalue + item.pstep;
}

/* Решение по параметру, принадлежащее разбираемой неделе;
   решение чужой недели — как отсутствие решения */
function paramDecision(itemId) {
  const d = store.paramDecided[itemId];
  return (d && d.week === previousWeekStart()) ? d : null;
}

/* Одно решение на параметр за разбор (инвариант 10); шаг применяется немедленно */
function applyParamStep(itemId) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || item.type !== 'param' || !item.active) return false;
  if (!reviewDue() || paramDecision(itemId)) return false;
  const from = item.pvalue;
  item.pvalue = paramStepTarget(item);
  recordBar(item, item.pvalue); // история порога — по общим правилам истории планки
  store.paramDecided[itemId] = { week: previousWeekStart(), from, to: item.pvalue };
  save();
  return true;
}

function keepParam(itemId) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || item.type !== 'param' || !item.active) return false;
  if (!reviewDue() || paramDecision(itemId)) return false;
  store.paramDecided[itemId] = { week: previousWeekStart(), from: item.pvalue, to: null };
  save();
  return true;
}

/* ── Норма и серия привычки (инвариант 11) ──────────────────
   Чистые функции от days{}, normPerWeek и календаря: разбор и
   closeWeek на них не влияют, смена нормы ретроактивна. */

/* Отметки привычки в календарной неделе с понедельником mon */
function habitWeekCount(item, mon) {
  let n = 0;
  for (let i = 0; i < 7; i++) if (isMarked(addDays(mon, i), item.id)) n++;
  return n;
}

/* Серия, считая назад от недели lastWeek включительно; недели существуют
   только с calendarSince (инвариант 2). Неделя без нормы обрывает счёт,
   поэтому цикл конечен: пустых недель норма (≥1) не набирает. */
function habitStreakFrom(item, lastWeek) {
  const since = store.settings.calendarSince;
  if (!isDayKey(since)) return 0;
  let n = 0;
  for (let w = lastWeek; w >= since; w = addDays(w, -7)) {
    if (habitWeekCount(item, w) < (item.normPerWeek || 7)) break;
    n++;
  }
  return n;
}

/* Серия на сегодня: от последней завершённой недели; текущая не входит —
   сегодняшние тапы серию не меняют */
function habitStreak(item) {
  const cur = currentWeekStart();
  return cur ? habitStreakFrom(item, addDays(cur, -7)) : 0;
}

/* Информационная готовность: 2 закрытые недели каждая активная привычка
   выполнила норму (≥ normPerWeek; норма ретроактивна — берётся текущая) */
function habitsSteady() {
  const habits = store.items.filter(i => i.type === 'daily' && i.area === 'habit' && i.active);
  if (!habits.length || store.reviews.length < 2) return false;
  return store.reviews.slice(-2).every(r => habits.every(h => {
    const p = r.perItem && r.perItem[h.id];
    return p && p.count >= (h.normPerWeek || 7);
  }));
}

/* Перестановка пункта в пределах своей области (группы экрана «Пункты») */
function moveItem(id, dir) {
  const i = store.items.findIndex(x => x.id === id);
  if (i < 0) return false;
  const step = dir === 'up' ? -1 : 1;
  let j = i + step;
  while (j >= 0 && j < store.items.length && store.items[j].area !== store.items[i].area) j += step;
  if (j < 0 || j >= store.items.length) return false;
  const t = store.items[i];
  store.items[i] = store.items[j];
  store.items[j] = t;
  save();
  return true;
}

/* ── Закрытие недели ───────────────────────────────────────── */

function closeWeek() {
  if (!reviewDue()) return false; // guard: завершённой неразобранной недели нет
  const week = previousWeekStart();
  const keys = windowKeys();
  const perItem = {};
  for (const it of store.items) {
    if (it.type !== 'daily') continue;
    const marks = keys.map(k => isMarked(k, it.id));
    if (!it.active && !marks.some(Boolean)) continue; // выключенные без отметок в окне не попадают в срез
    perItem[it.id] = { name: it.name, marks, count: marks.filter(Boolean).length };
  }
  const weekEnd = keys[6];
  const trainings = {};
  for (const w of store.items.filter(i => i.type === 'weekly')) {
    const count = store.weekLog.filter(e => e.itemId === w.id && e.date >= week && e.date <= weekEnd).length;
    if (!w.active && !count) continue; // как и в perItem: выключенные без счёта не попадают
    trainings[w.id] = { name: w.name, count, goal: w.goal };
  }
  store.reviews.push({
    closedAt: Date.now(),
    week, // понедельник разобранной недели
    keys,
    perItem,
    trainings,
    oneChange: (store.draftOneChange || '').trim(),
    raises: store.pendingRaises,
    // в срез идут только решения разобранной недели; чистится paramDecided целиком
    params: Object.entries(store.paramDecided)
      .filter(([, d]) => d.week === week)
      .map(([id, d]) => ({ id, from: d.from, to: d.to }))
  });
  store.pendingRaises = [];
  store.draftOneChange = '';
  store.paramDecided = {};
  // счётчик «Сегодня» обнуляется сменой недели, не закрытием: чистим только прошлое
  const cur = currentWeekStart();
  store.weekLog = store.weekLog.filter(e => e.date >= cur);
  save();
  return true;
}

/* ── Экспорт / импорт ──────────────────────────────────────── */

function exportJSON() {
  store.settings.exportedAt = Date.now(); // дата попадает и в сам файл
  save();
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
    let incoming;
    try {
      incoming = migrate(data);
    } catch (e) {
      alert('Импорт не выполнен: файл повреждён. Текущие данные не изменены.');
      return;
    }
    // сводка из файла — перед подтверждением (после migrate все ключи days валидны)
    const dayCount = Object.keys(incoming.days).length;
    const range = Object.keys(incoming.days).sort();
    const parts = [
      `пунктов: ${incoming.items.length}`,
      `дней с отметками: ${dayCount}`,
      `закрытых недель: ${incoming.reviews.length}`
    ];
    if (range.length) parts.push(`отметки: ${fmtShort(range[0])} — ${fmtShort(range[range.length - 1])}`);
    if (!confirm(`Заменить текущие данные данными из файла?\n\nВ файле: ${parts.join(', ')}.`)) return;
    store = incoming;
    save();
    // импорт заменил состояние целиком: черновики форм и дневное ui-состояние
    // не переносятся, граница дня могла смениться — таймер и день заново
    ui.editingId = null;
    ui.editNorm = null;
    ui.addOpen = false;
    ui.formDraft = null;
    ui.missOpen = {};
    ui.raiseEdit = {};
    ui.renderedDayKey = todayKey();
    armDayTimer();
    const n = store.items.length;
    ui.importNote = `Импортировано: ${n} ${plural(n, 'пункт', 'пункта', 'пунктов')}, ` +
      `${dayCount} ${plural(dayCount, 'день', 'дня', 'дней')}`;
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
  addHint: false,
  raiseEdit: {},   // itemId -> true, когда открыт ввод своего значения
  missOpen: {},    // itemId -> true, когда показана подпись «вчера — пропуск»
  justClosed: false,
  addArea: 'min',       // область формы добавления: 'min' | 'habit'
  addPkind: 'time',     // вид параметра в форме добавления; после создания вид не меняется
  editNorm: null,       // черновик нормы недели в открытой форме привычки (null — как у пункта)
  savedFlash: false,    // разовое тихое подтверждение сохранения формы (движение, задача 12)
  importNote: null,     // строка «Импортировано: …», исчезает при следующем действии
  renderedDayKey: null, // логический день, для которого отрисован интерфейс (инвариант 8)
  renderedTab: null,    // последняя отрисованная вкладка — скролл сбрасывается только при её смене
  formDraft: null       // черновик открытой формы «Пунктов»: значения, фокус, каретка
};

let dayTimer = null; // таймер на ближайшую границу дня

/* Инвариант 8: экран мог устареть (смена логического дня в открытом
   приложении). При расхождении — чистка дневного ui-состояния и полная
   перерисовка текущей вкладки; true = действие применять нельзя. */
function syncDay() {
  if (ui.renderedDayKey === null || todayKey() === ui.renderedDayKey) return false;
  ui.missOpen = {};
  ui.raiseEdit = {};
  ui.renderedDayKey = todayKey(); // фиксируем новый день и для не-«Сегодня» вкладок
  renderAll();
  return true;
}

function armDayTimer() {
  clearTimeout(dayTimer);
  // +1 c запаса: таймеры iOS могут срабатывать на самой границе
  dayTimer = setTimeout(() => { syncDay(); armDayTimer(); }, msToNextBoundary() + 1000);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function valUnit(it) {
  const parts = [];
  if (typeof it.value === 'number' && isFinite(it.value)) parts.push(String(it.value));
  if (it.unit) parts.push(it.unit);
  return parts.join(' ');
}

function el(id) { return document.getElementById(id); }

/* ── Движение (задача 12): короткая функциональная обратная связь ──
   Заполнение круга и ячейки полосы, fade экрана и flash сохранения —
   на CSS (transition/@keyframes). Уходу карточки разбора нужен JS:
   класс-триггер, затем удаление узла перерисовкой. */

const MOTION_MS = 160;

function prefersReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { return false; }
}

/* Пометить узел уходящим, затем выполнить done() — перерисовку, реально
   убирающую узел. Триггер — transitionend, но он ненадёжен (jsdom его не
   шлёт, reduced-motion отключает переход), поэтому done гарантирован
   fallback-таймаутом и вызывается ровно один раз. При reduced-motion —
   сразу, без ожидания: конечное состояние достижимо мгновенно. */
function motionLeave(node, done) {
  if (!node || prefersReducedMotion()) { done(); return; }
  node.classList.add('leaving');
  let fired = false;
  // done ровно один раз; если узел уже убран (напр. соседним решением,
  // перерисовавшим весь разбор) — повторная перерисовка не нужна
  const fin = () => { if (fired) return; fired = true; if (node.isConnected) done(); };
  node.addEventListener('transitionend', fin, { once: true });
  setTimeout(fin, MOTION_MS + 60);
}

function renderAll() {
  const map = { today: 'scr-today', habits: 'scr-habits', review: 'scr-review', items: 'scr-items', system: 'scr-system' };
  for (const [tab, id] of Object.entries(map)) el(id).hidden = tab !== ui.tab;
  document.querySelectorAll('#tabs button').forEach(b => {
    if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (ui.tab === 'today') renderToday();
  if (ui.tab === 'habits') renderHabits();
  if (ui.tab === 'review') renderReview();
  if (ui.tab === 'items') renderItems();
  if (ui.tab === 'system') renderSystem();
  if (ui.renderedTab !== ui.tab) window.scrollTo(0, 0); // скролл — только при фактической смене вкладки
  ui.renderedTab = ui.tab;
}

/* Экран 1 — «Сегодня»: только область min (инвариант 10) */
function renderToday() {
  const t = todayKey();
  ui.renderedDayKey = t;
  const items = activeDaily().filter(i => i.area === 'min');
  const done = items.filter(i => isMarked(t, i.id)).length;
  const total = items.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const closed = total > 0 && done === total;

  let h = `
    <header class="page">
      <p class="overline">${esc(fmtWeekday(t))}</p>
      <h1>${esc(fmtDay(t))}</h1>
    </header>`;

  if (saveFailed) {
    h += `<p class="banner static" role="status">Хранилище недоступно — отметки сейчас не сохраняются</p>`;
  }

  if (reviewDue()) {
    h += `<button class="banner" data-act="goto-review"><span>Доступен разбор недели</span><span class="chev" aria-hidden="true">&rsaquo;</span></button>`;
  }

  h += `
    <div class="dayline">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="bar-note${closed ? ' ok' : ''}" aria-live="polite">${closed ? 'День закрыт' : (total ? `<b>${done}</b>&nbsp;из&nbsp;${total}` : 'Нет активных пунктов')}</p>
    </div>`;

  h += `<div class="list">`;
  let curGroup = null;
  for (const it of items) {
    const g = (it.group || '').trim();
    if (g !== curGroup) {
      if (g) h += `<p class="g-label">${esc(g)}</p>`;
      curGroup = g;
    }
    h += dailyRow(it, t);
  }
  h += `</div>`;

  for (const w of activeWeekly().filter(i => i.area === 'min')) {
    const n = trainCount(w.id);
    h += `
      <div class="weekcount">
        <span class="txt">
          <span class="tname">${esc(w.name)}</span>
          ${w.note ? `<span class="note">${esc(w.note)}</span>` : ''}
        </span>
        <span class="wctl">
          <span class="wnum"><b>${n}</b>&thinsp;/&thinsp;${w.goal || 0}</span>
          <button class="btn icon plus" data-act="train-inc" data-id="${esc(w.id)}" aria-label="+1 к «${esc(w.name)}»">+</button>
        </span>
      </div>
      ${n ? `<button class="undo" data-act="train-undo" data-id="${esc(w.id)}" aria-label="отменить последний: «${esc(w.name)}»">отменить последний</button>` : ''}`;
  }

  h += `<p class="creed">Минимум выполняется даже в худший день.</p>`;

  el('scr-today').innerHTML = h;
}

/* Строка ежедневного пункта: чекбокс, точка-маркер, ретро-отметка —
   общая для «Сегодня» (area min) и «Привычек» (habit: true добавляет
   серию у названия и полосу текущей недели под строкой) */
function dailyRow(it, t, habit) {
  const on = isMarked(t, it.id);
  const miss = missedYesterday(it, t);
  const vu = valUnit(it);
  const streak = habit ? habitStreak(it) : 0; // при нуле справка скрыта
  return `
      <div class="rowwrap${habit ? ' hrow' : ''}">
        <label class="row check${on ? ' on' : ''}">
          <input type="checkbox" data-act="mark" data-id="${esc(it.id)}"${on ? ' checked' : ''}>
          <span class="box" aria-hidden="true"></span>
          <span class="txt">
            <span class="tname">${esc(it.name)}${vu ? ` <span class="val">${esc(vu)}</span>` : ''}${streak ? ` <span class="streak">серия ${streak} нед</span>` : ''}</span>
            ${it.note ? `<span class="note">${esc(it.note)}</span>` : ''}
          </span>
        </label>
        ${miss ? `<button type="button" class="dot" data-act="miss-note" data-id="${esc(it.id)}" aria-expanded="${ui.missOpen[it.id] ? 'true' : 'false'}" aria-label="вчера — пропуск"><i></i></button>` : ''}
        ${miss && ui.missOpen[it.id] ? `<p class="miss-note">вчера — пропуск<button type="button" class="undo" data-act="mark-yesterday" data-id="${esc(it.id)}" aria-label="отметить вчера: «${esc(it.name)}»">отметить</button></p>` : ''}
        ${habit ? habitWeekRow(it, t) : ''}
      </div>`;
}

/* Полоса текущей недели привычки: визуальный язык сетки разбора (подписи
   дней, кружки), пассивна — тапов не принимает; рядом «X из N». Сама
   полоса скрыта от AT — счёт недели даёт видимый текст «X из N». */
function habitWeekRow(it, t) {
  const mon = weekStartOf(t);
  const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  let cells = '';
  for (let i = 0; i < 7; i++) {
    const k = addDays(mon, i);
    const today = k === t;
    cells += `<span class="hday${today ? ' today' : ''}"><span class="hd">${names[i]}</span>` +
      `<i class="c${isMarked(k, it.id) ? ' on' : ''}${today ? ' today' : ''}${k > t ? ' fut' : ''}"></i></span>`;
  }
  return `
        <div class="hweek">
          <span class="hstrip" aria-hidden="true">${cells}</span>
          <span class="hcount">${habitWeekCount(it, mon)} из ${it.normPerWeek || 7}</span>
        </div>`;
}

/* Экран 2 — «Привычки»: только сегодняшний день программы роста */
function renderHabits() {
  const t = todayKey();
  ui.renderedDayKey = t;
  const habits = activeDaily().filter(i => i.area === 'habit');
  const done = habits.filter(i => isMarked(t, i.id)).length;
  const total = habits.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const allDone = total > 0 && done === total;

  let h = `
    <header class="page">
      <p class="overline">Программа роста</p>
      <h1>Привычки</h1>
    </header>`;

  if (saveFailed) {
    h += `<p class="banner static" role="status">Хранилище недоступно — отметки сейчас не сохраняются</p>`;
  }

  if (total) {
    h += `
    <div class="dayline">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="bar-note${allDone ? ' ok' : ''}" aria-live="polite">${allDone ? 'Все отмечены' : `сегодня <b>${done}</b>&nbsp;из&nbsp;${total}`}</p>
    </div>
    <div class="list">`;
    for (const it of habits) h += dailyRow(it, t, true);
    h += `</div>`;
  } else {
    h += `<p class="muted">Привычек пока нет — добавить можно в «Пунктах».</p>`;
  }

  const params = store.items.filter(i => i.type === 'param' && i.active);
  if (params.length) {
    h += `<p class="g-label">Порог недели</p>`;
    for (const p of params) {
      h += `<p class="line muted">${esc(p.name)} · ${esc(fmtParam(p))}</p>`;
    }
  }

  h += `<p class="creed">Не спеши — доверься накопительному эффекту.</p>`;

  el('scr-habits').innerHTML = h;
}

/* ── Точечные обновления «Сегодня» и «Привычек» (горячие пути) ──
   Существующие узлы не пересоздаются — CSS-переходы чекбокса и
   планки дня реально проигрываются. Структурные изменения идут
   через полную перерисовку экрана. */

function updateDayline() {
  const t = todayKey();
  const items = activeDaily().filter(i => i.area === 'min');
  const done = items.filter(i => isMarked(t, i.id)).length;
  const total = items.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const closed = total > 0 && done === total;
  const bar = document.querySelector('#scr-today .bar i');
  if (bar) bar.style.width = pct + '%';
  const note = document.querySelector('#scr-today .bar-note');
  if (note) {
    note.classList.toggle('ok', closed);
    note.innerHTML = closed ? 'День закрыт' : (total ? `<b>${done}</b>&nbsp;из&nbsp;${total}` : 'Нет активных пунктов');
  }
}

function updateHabitsDayline() {
  const t = todayKey();
  const habits = activeDaily().filter(i => i.area === 'habit');
  const done = habits.filter(i => isMarked(t, i.id)).length;
  const total = habits.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const allDone = total > 0 && done === total;
  const bar = document.querySelector('#scr-habits .bar i');
  if (bar) bar.style.width = pct + '%';
  const note = document.querySelector('#scr-habits .bar-note');
  if (note) {
    note.classList.toggle('ok', allDone);
    note.innerHTML = allDone ? 'Все отмечены' : (total ? `сегодня <b>${done}</b>&nbsp;из&nbsp;${total}` : '');
  }
}

/* Точечное обновление полосы недели привычки: сегодняшняя ячейка и «X из N».
   Серия не пересчитывается — текущая неделя в неё не входит (инвариант 11). */
function updateHabitWeekRow(input) {
  const wrap = input.closest('.rowwrap');
  if (!wrap) return;
  const t = todayKey();
  const cell = wrap.querySelector('.hstrip i.today');
  if (cell) cell.classList.toggle('on', isMarked(t, input.dataset.id));
  const hc = wrap.querySelector('.hcount');
  const it = store.items.find(x => x.id === input.dataset.id);
  if (hc && it) hc.textContent = `${habitWeekCount(it, weekStartOf(t))} из ${it.normPerWeek || 7}`;
}

/* Точечная отметка: обновляется планка того экрана, где стоит чекбокс */
function updateTodayMark(input) {
  const on = isMarked(todayKey(), input.dataset.id);
  input.checked = on;
  const label = input.closest('label.check');
  if (label) label.classList.toggle('on', on);
  const scr = input.closest('section.screen');
  if (scr && scr.id === 'scr-habits') { updateHabitsDayline(); updateHabitWeekRow(input); }
  else updateDayline();
}

/* Дневные экраны: перерисовка и контейнер по активной вкладке */
function renderDayScreen() {
  if (ui.tab === 'habits') renderHabits();
  else renderToday();
}

function dayScreenEl() {
  return el(ui.tab === 'habits' ? 'scr-habits' : 'scr-today');
}

function updateWeekCount(id) {
  const scr = el('scr-today');
  const plus = [...scr.querySelectorAll('[data-act="train-inc"]')].find(x => x.dataset.id === id);
  if (!plus) { renderToday(); return; }
  const n = trainCount(id);
  const wc = plus.closest('.weekcount');
  const num = wc.querySelector('.wnum b');
  if (num) num.textContent = n;
  const next = wc.nextElementSibling;
  const hasUndo = !!(next && next.classList.contains('undo') && next.dataset.id === id);
  if (n && !hasUndo) {
    const it = store.items.find(x => x.id === id);
    const btn = document.createElement('button');
    btn.className = 'undo';
    btn.dataset.act = 'train-undo';
    btn.dataset.id = id;
    btn.textContent = 'отменить последний';
    btn.setAttribute('aria-label', `отменить последний: «${it ? it.name : ''}»`);
    wc.after(btn);
  } else if (!n && hasUndo) {
    next.remove();
  }
}

/* Экран 2 — «Разбор недели» */
function renderReview() {
  let h = `<header class="page"><p class="overline">Раз в неделю</p><h1>Разбор недели</h1></header>`;

  if (!reviewDue()) {
    if (ui.justClosed) h += `<p class="lead" role="status">Неделя закрыта.</p>`;
    const cur = currentWeekStart();
    if (!cur) {
      // переходные дни скользящей эпохи: первый разбор — после первой целой календарной недели
      h += `<p class="muted">Разбор откроется в понедельник, ${esc(fmtShort(addDays(store.settings.calendarSince, 7)))}.</p>`;
    } else {
      h += `<p class="muted">Идёт ${diffDays(todayKey(), cur) + 1}-й день недели. Разбор откроется в понедельник, ${esc(fmtShort(addDays(cur, 7)))}.</p>`;
    }
    const ocWait = currentOneChange();
    if (ocWait) h += `<p class="muted">Изменение этой недели: „${esc(ocWait)}“</p>`;
    el('scr-review').innerHTML = h;
    ui.justClosed = false; // «Неделя закрыта.» показывается ровно один раз
    return;
  }

  const keys = windowKeys();
  const inWeek = it => it.active || keys.some(k => isMarked(k, it.id));
  const minItems = store.items.filter(it => it.type === 'daily' && it.area === 'min' && inWeek(it));
  const habitItems = store.items.filter(it => it.type === 'daily' && it.area === 'habit' && inWeek(it));

  h += `<p class="muted">Неделя ${esc(fmtShort(keys[0]))} — ${esc(fmtShort(keys[6]))}</p>`;
  const oc = currentOneChange();
  if (oc) h += `<p class="muted">Изменение этой недели: „${esc(oc)}“</p>`;

  // Сетка 7 дней × пункты: кружки и числа скрыты от AT (aria-hidden-обёртки
  // с display:contents), итог строки — визуально скрытым счётчиком в имени
  const weekGrid = (items) => {
    let g = `<div class="grid" style="--cols:${keys.length}">`;
    g += `<span class="g-vis" aria-hidden="true"><span class="g-head"></span>` +
      ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<span class="g-head">${d}</span>`).join('') + `</span>`;
    for (const it of items) {
      const n = keys.filter(k => isMarked(k, it.id)).length;
      g += `<span class="g-name">${esc(it.name)}<span class="sr-only">, отмечено ${n} из 7</span></span>`;
      g += `<span class="g-vis" aria-hidden="true">` +
        keys.map(k => `<i class="c${isMarked(k, it.id) ? ' on' : ''}"></i>`).join('') + `</span>`;
    }
    return g + `</div>`;
  };

  // Консистентность за 3 последних закрытых недели
  const consist = (items) => {
    if (!store.reviews.length) return `<p class="muted">Закрытых недель пока нет.</p>`;
    const last3 = store.reviews.slice(-3);
    let c = `<div class="consist">`;
    for (const it of items) {
      const counts = last3.map(r => (r.perItem && r.perItem[it.id]) ? r.perItem[it.id].count : '—');
      c += `<span class="c-name">${esc(it.name)}</span><span class="c-val">${counts.map(x => esc(x)).join(' · ')} из 7</span>`;
    }
    return c + `</div>`;
  };

  // Секция «Минимум»: сетка, тренировки, консистентность, повышения
  h += `<h2>Минимум</h2>`;
  h += weekGrid(minItems);
  for (const w of store.items.filter(i => i.type === 'weekly' && i.active)) {
    // счёт разбираемой недели — тот же интервал, что уйдёт в срез closeWeek
    const n = store.weekLog.filter(e => e.itemId === w.id && e.date >= keys[0] && e.date <= keys[6]).length;
    h += `<p class="line">${esc(w.name)}: ${n} из ${w.goal || 0}</p>`;
  }
  h += `<h2>Три закрытые недели</h2>`;
  h += consist(minItems);

  for (const it of minItems) {
    if (!raiseEligible(it)) continue;
    const sug = raiseSuggest(it.value);
    const editing = ui.raiseEdit[it.id];
    h += `
      <div class="card raise" data-raise="${esc(it.id)}">
        <p>${esc(it.name)}: три недели подряд не меньше 6 из 7.</p>
        <p class="raise-line">Повысить ${esc(String(it.value))} →
          ${editing
            ? `<input class="num" id="raise-${esc(it.id)}" type="text" inputmode="decimal" value="${esc(String(sug))}">`
            : `<b>${esc(String(sug))}</b>`}
          ${it.unit ? esc(it.unit) : ''}?</p>
        <p class="muted">Только если стало легко</p>
        <div class="btns">
          <button class="btn" data-act="raise-ok" data-id="${esc(it.id)}">Принять</button>
          ${editing ? '' : `<button class="btn quiet" data-act="raise-edit" data-id="${esc(it.id)}">Изменить</button>`}
          <button class="btn quiet" data-act="raise-later" data-id="${esc(it.id)}">Не сейчас</button>
        </div>
      </div>`;
  }

  // Секция «Привычки»: сетка той же недели, консистентность, параметры, готовность
  h += `<h2>Привычки</h2>`;
  if (habitItems.length) {
    h += weekGrid(habitItems);
    // норма и серия разбираемой недели: read-only справка, закрытие данных не меняет
    for (const hb of habitItems) {
      const x = habitWeekCount(hb, keys[0]);
      const norm = hb.normPerWeek || 7;
      let tail = '';
      if (x >= norm) tail = ` · серия ${habitStreakFrom(hb, keys[0])} нед`;
      else if (habitStreakFrom(hb, addDays(keys[0], -7)) > 0) tail = ' · серия прервана';
      h += `<p class="muted">${esc(hb.name)}: ${x} из ${norm}${tail}</p>`;
    }
    h += consist(habitItems);
  } else {
    h += `<p class="muted">Привычек пока нет — добавить можно в «Пунктах».</p>`;
  }

  for (const p of store.items.filter(i => i.type === 'param' && i.active)) {
    const decided = paramDecision(p.id); // решение чужой недели карточку не гасит
    if (decided) {
      h += `<p class="muted">${esc(p.name)}: ${decided.to === null
        ? `${esc(fmtParam(p, decided.from))}, без шага`
        : `${esc(fmtParam(p, decided.from))} → ${esc(fmtParam(p, decided.to))}`}</p>`;
    } else {
      h += `
      <div class="card param">
        <p>«${esc(p.name)} · ${esc(fmtParam(p))}» — как прошла неделя?</p>
        <div class="btns">
          <button class="btn" data-act="param-step" data-id="${esc(p.id)}">Шаг: → ${esc(fmtParam(p, paramStepTarget(p)))}</button>
          <button class="btn quiet" data-act="param-keep" data-id="${esc(p.id)}">Оставить</button>
        </div>
      </div>`;
    }
  }

  if (habitsSteady()) {
    h += `<p class="muted">Привычки устойчивы 2 недели — можно добавить новую</p>`;
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
  if (typeof it.value !== 'number' || !isFinite(it.value)) return ''; // после очистки значения строка не показывается
  if (!Array.isArray(it.history) || it.history.length < 2) return '';
  const vals = it.history.map(x => String(x.value));
  const shown = vals.length > 6 ? ['…'].concat(vals.slice(-6)) : vals;
  const last = it.history[it.history.length - 1];
  return `<span class="hist">Планка: ${shown.map(esc).join(' → ')}${it.unit ? ' ' + esc(it.unit) : ''} · с ${esc(fmtShort(last.date))}</span>`;
}

/* История порога параметра: «Отбой: 00:00 → 23:45 · с <дата>» */
function paramHistory(it) {
  if (!Array.isArray(it.history) || it.history.length < 2) return '';
  const last = it.history[it.history.length - 1];
  const vals = it.history.map(x => fmtParam(it, x.value));
  const shown = vals.length > 6 ? ['…'].concat(vals.slice(-6)) : vals;
  return `<span class="hist">${esc(it.name)}: ${shown.map(esc).join(' → ')} · с ${esc(fmtShort(last.date))}</span>`;
}

/* Черновик открытой формы «Пунктов»: значения всех полей (сливаются
   с прежним черновиком — цель переживает смену типа), сфокусированное
   поле и позиция каретки. Восстанавливается при каждом renderItems,
   пока открыта та же форма. */
function currentFormKey() {
  if (ui.addOpen) return 'add';
  if (ui.editingId !== null) return 'edit:' + ui.editingId;
  return null;
}

function snapshotOpenForm() {
  const key = currentFormKey();
  if (!key) { ui.formDraft = null; return; }
  const form = document.querySelector('#scr-items .card.form');
  const domKey = form ? (form.dataset.form === 'add' ? 'add' : 'edit:' + form.dataset.id) : null;
  if (domKey !== key) {
    if (ui.formDraft && ui.formDraft.key !== key) ui.formDraft = null; // открыли другую форму
    return;
  }
  const fields = {};
  for (const inp of form.querySelectorAll('input[id], select[id]')) {
    if (inp.dataset.act) continue; // управляемые ui-состоянием контролы (select типа) — не черновик
    fields[inp.id] = inp.value;
  }
  const ae = document.activeElement;
  const focus = (ae && form.contains(ae) && ae.id)
    ? { id: ae.id, start: ae.selectionStart ?? null, end: ae.selectionEnd ?? null }
    : null;
  const base = (ui.formDraft && ui.formDraft.key === key) ? ui.formDraft.fields : null;
  ui.formDraft = { key, fields: Object.assign({}, base, fields), focus };
}

function restoreOpenForm() {
  const key = currentFormKey();
  if (!key || !ui.formDraft || ui.formDraft.key !== key) return;
  for (const [fid, v] of Object.entries(ui.formDraft.fields)) {
    const inp = el(fid);
    if (inp) inp.value = v;
  }
  const f = ui.formDraft.focus;
  if (f) {
    const inp = el(f.id);
    if (inp) {
      inp.focus();
      if (f.start !== null && typeof inp.setSelectionRange === 'function') {
        try { inp.setSelectionRange(f.start, f.end); } catch (e) { /* select и др. */ }
      }
    }
  }
}

function renderItems() {
  snapshotOpenForm();
  let h = `<header class="page"><p class="overline">Настройка блоков</p><h1>Пункты</h1></header>`;
  if (ui.savedFlash) { // тихое подтверждение сохранения — гаснет само (CSS), показывается один раз
    h += `<p class="flash" role="status">Сохранено</p>`;
    ui.savedFlash = false;
  }

  // две группы: минимум и привычки, у каждой своя кнопка добавления
  const groups = [
    ['Минимум', 'min', 'Добавить пункт'],
    ['Привычки', 'habit', 'Добавить привычку']
  ];
  for (const [title, area, addLabel] of groups) {
    const items = store.items.filter(i => i.area === area);
    h += `<h2>${title}</h2>`;
    h += `<div class="list">`;
    items.forEach((it, gi) => {
      const vu = it.type === 'param' ? `порог ${fmtParam(it)}` : valUnit(it);
      const meta = [vu, it.type === 'weekly' ? `цель ${it.goal || 0} / нед.` : '', (it.group || '').trim()]
        .filter(Boolean).join(' · ');
      h += `
      <div class="rowwrap${it.active ? '' : ' off'}">
        <div class="row item">
          <button class="itxt" data-act="edit-open" data-id="${esc(it.id)}" aria-label="изменить «${esc(it.name)}»">
            <span class="tname">${esc(it.name)}</span>
            ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
            ${it.note ? `<span class="note">${esc(it.note)}</span>` : ''}
            ${it.type === 'param' ? paramHistory(it) : barHistory(it)}
          </button>
          <span class="ictl">
            <button class="btn icon quiet" data-act="move-up" data-id="${esc(it.id)}"${gi === 0 ? ' disabled' : ''} aria-label="выше">&uarr;</button>
            <button class="btn icon quiet" data-act="move-down" data-id="${esc(it.id)}"${gi === items.length - 1 ? ' disabled' : ''} aria-label="ниже">&darr;</button>
            <label class="switch" aria-label="включён: «${esc(it.name)}»">
              <input type="checkbox" data-act="toggle-active" data-id="${esc(it.id)}"${it.active ? ' checked' : ''}>
              <span></span>
            </label>
          </span>
        </div>
        ${ui.editingId === it.id ? editForm(it) : ''}
      </div>`;
    });
    h += `</div>`;
    h += (ui.addOpen && ui.addArea === area)
      ? addForm()
      : `<button class="btn wide" data-act="add-open" data-area="${area}">${addLabel}</button>`;
  }

  const hours = [];
  for (let i = 0; i <= 8; i++) hours.push(`<option value="${i}"${store.settings.dayBoundary === i ? ' selected' : ''}>${pad2(i)}:00</option>`);
  h += `
    <h2>Граница дня</h2>
    <label class="field inline">
      <span>Смена дня в</span>
      <select data-act="boundary">${hours.join('')}</select>
    </label>
    <p class="muted">Отметки до этого часа относятся к предыдущему дню.</p>`;

  const exp = (typeof store.settings.exportedAt === 'number' && isFinite(store.settings.exportedAt))
    // логический день — как в имени файла экспорта (инвариант 1)
    ? `Последний экспорт: ${esc(fmtShort(dateKeyShift(new Date(store.settings.exportedAt), store.settings.dayBoundary)))}`
    : 'Экспорта ещё не было';
  h += `
    <h2>Данные</h2>
    <div class="btns">
      <button class="btn" data-act="export">Экспорт JSON</button>
      <button class="btn" data-act="import">Импорт JSON</button>
    </div>
    ${ui.importNote ? `<p class="muted" role="status">${esc(ui.importNote)}</p>` : ''}
    <p class="muted">${exp}</p>
    <p class="muted" id="mirror-note" hidden></p>
    <input type="file" id="import-file" accept="application/json,.json" hidden>
    <p class="muted">Все данные — на этом устройстве: рабочая копия и автоматическая резервная. Экспорт — способ сохранить их вне приложения.</p>`;

  el('scr-items').innerHTML = h;
  restoreOpenForm();
  updateMirrorNote();
}

/* Строка «Резервная копия: …» — асинхронно и точечно после рендера
   «Пунктов»; при недоступном зеркале не показывается вовсе */
function updateMirrorNote() {
  if (typeof indexedDB === 'undefined') return;
  mirrorRead().then(snap => {
    const p = el('mirror-note');
    if (!p || !snap || typeof snap.savedAt !== 'number') return;
    p.textContent = 'Резервная копия: ' + fmtStamp(snap.savedAt);
    p.hidden = false;
  });
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
  const head = `
    <div class="card form" data-form="edit" data-id="${esc(it.id)}">
      <label class="field"><span>Название</span><input type="text" id="e-name" value="${esc(it.name)}"></label>
      <label class="field"><span>Подпись</span><input type="text" id="e-note" value="${esc(it.note || '')}" placeholder="необязательная строка под названием"></label>`;
  const foot = `
      <div class="btns">
        <button class="btn primary" data-act="edit-save" data-id="${esc(it.id)}">Сохранить</button>
        <button class="btn quiet" data-act="edit-cancel">Отмена</button>
      </div>
    </div>`;
  if (it.type === 'param') {
    // вид фиксируется при создании (инвариант 10) — не селект, а тихая строка
    return head + `
      <p class="muted">Вид: ${it.pkind === 'number' ? 'число' : 'время'}</p>
      ${it.pkind === 'number'
        ? `<div class="pair">
            <label class="field"><span>Порог</span><input class="num" type="text" inputmode="decimal" id="e-pvalue" value="${esc(it.pvalue)}"></label>
            <label class="field"><span>Единица</span><input type="text" id="e-punit" value="${esc(it.unit || '')}"></label>
          </div>`
        : `<label class="field"><span>Порог</span><input id="e-ptime" type="time" value="${esc(fmtParam(it))}"></label>`}
      <label class="field"><span>Шаг (со знаком)</span><input class="num" type="text" inputmode="decimal" id="e-pstep" value="${esc(it.pstep)}"></label>` + foot;
  }
  if (it.area === 'habit') {
    // привычка: название, подпись и норма недели степпером (границы 1–7)
    const n = ui.editNorm !== null ? ui.editNorm : (it.normPerWeek || 7);
    return head + `
      <div class="field inline norm">
        <span>Норма в неделю: <b>${n}</b></span>
        <span class="btns">
          <button type="button" class="btn icon quiet" data-act="norm-dec" data-id="${esc(it.id)}"${n <= 1 ? ' disabled' : ''} aria-label="уменьшить норму">&minus;</button>
          <button type="button" class="btn icon quiet" data-act="norm-inc" data-id="${esc(it.id)}"${n >= 7 ? ' disabled' : ''} aria-label="увеличить норму">+</button>
        </span>
      </div>` + foot;
  }
  return head + `
      <div class="pair">
        <label class="field"><span>Значение</span><input class="num" type="text" inputmode="decimal" id="e-value" value="${esc(it.value)}"></label>
        <label class="field"><span>Единица</span><input type="text" id="e-unit" value="${esc(it.unit || '')}"></label>
      </div>
      ${groupField('e', it.group)}
      ${it.type === 'weekly' ? `<label class="field"><span>Цель за неделю</span><input class="num" type="text" inputmode="numeric" id="e-goal" value="${esc(it.goal)}"></label>` : ''}` + foot;
}

function addForm() {
  const hint = ui.addHint
    ? `<p class="hint">Правило системы: одна новая привычка за раз. Последний пункт добавлен меньше 14 дней назад.</p>`
    : '';
  const head = `
    <div class="card form" data-form="add">
      ${hint}
      <label class="field"><span>Название</span><input type="text" id="f-name" placeholder="Например: чтение"></label>
      <label class="field"><span>Подпись</span><input type="text" id="f-note" placeholder="необязательная строка под названием"></label>`;
  const foot = `
      <div class="btns">
        <button class="btn primary" data-act="add-save">Добавить</button>
        <button class="btn quiet" data-act="add-cancel">Отмена</button>
      </div>
    </div>`;
  if (ui.addArea === 'habit') {
    const isParam = ui.addType === 'param';
    return head + `
      <label class="field"><span>Тип</span>
        <select id="f-type" data-act="add-type">
          <option value="daily"${isParam ? '' : ' selected'}>привычка (ежедневная)</option>
          <option value="param"${isParam ? ' selected' : ''}>параметр (порог недели)</option>
        </select>
      </label>
      ${isParam ? `
      <label class="field"><span>Вид</span>
        <select id="f-pkind" data-act="add-pkind">
          <option value="time"${ui.addPkind === 'number' ? '' : ' selected'}>время</option>
          <option value="number"${ui.addPkind === 'number' ? ' selected' : ''}>число</option>
        </select>
      </label>
      ${ui.addPkind === 'number'
        ? `<div class="pair">
            <label class="field"><span>Порог</span><input class="num" type="text" inputmode="decimal" id="f-pvalue" placeholder="4000"></label>
            <label class="field"><span>Единица</span><input type="text" id="f-punit" placeholder="шаг."></label>
          </div>`
        : `<label class="field"><span>Порог</span><input id="f-ptime" type="time" value="00:00"></label>`}
      <label class="field"><span>Шаг (со знаком)</span><input class="num" type="text" inputmode="decimal" id="f-pstep" placeholder="-15"></label>` : ''}` + foot;
  }
  return head + `
      <div class="pair">
        <label class="field"><span>Значение</span><input class="num" type="text" inputmode="decimal" id="f-value" placeholder="10"></label>
        <label class="field"><span>Единица</span><input type="text" id="f-unit" placeholder="мин"></label>
      </div>
      ${groupField('f', '')}
      <label class="field"><span>Тип</span>
        <select id="f-type" data-act="add-type">
          <option value="daily"${ui.addType === 'weekly' ? '' : ' selected'}>ежедневный чекбокс</option>
          <option value="weekly"${ui.addType === 'weekly' ? ' selected' : ''}>недельный счётчик с целью</option>
        </select>
      </label>
      ${ui.addType === 'weekly' ? `<label class="field"><span>Цель за неделю</span><input class="num" type="text" inputmode="numeric" id="f-goal" value="3"></label>` : ''}` + foot;
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

/* Единая валидация пользовательского ввода чисел: только > 0, иначе null */
function parsePositive(v) {
  const n = parseNum(v);
  return n !== null && n > 0 ? n : null;
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (syncDay()) return; // stale-экран: действие не применяется (инвариант 8)
  const hadImportNote = ui.importNote !== null;
  ui.importNote = null; // строка «Импортировано…» живёт до следующего действия
  const act = b.dataset.act;
  const id = b.dataset.id;
  const item = id ? store.items.find(i => i.id === id) : null;

  switch (act) {
    case 'goto-review':
      ui.missOpen = {}; // смена вкладки — как в таб-баре
      ui.raiseEdit = {};
      ui.tab = 'review';
      renderAll();
      break;

    case 'miss-note': {
      ui.missOpen[id] = !ui.missOpen[id];
      renderDayScreen();
      // вернуть фокус пересозданной кнопке — disclosure-паттерн остаётся рабочим для AT
      const dot = [...dayScreenEl().querySelectorAll('[data-act="miss-note"]')].find(d => d.dataset.id === id);
      if (dot) dot.focus();
      break;
    }

    case 'mark-yesterday': {
      markYesterday(id); // guard'ы внутри; «вчера» актуален — stale-guard уже отработал
      delete ui.missOpen[id];
      renderDayScreen(); // структурный путь: точка исчезает
      const cb = [...dayScreenEl().querySelectorAll('input[data-act="mark"]')].find(i => i.dataset.id === id);
      if (cb) cb.focus();
      break;
    }

    case 'train-inc': {
      const hadFail = saveFailed;
      incTrain(id);
      if (saveFailed !== hadFail) renderToday(); // баннер хранилища — редкий структурный путь
      else updateWeekCount(id);
      break;
    }
    case 'train-undo': {
      const hadFail = saveFailed;
      undoTrain(id);
      if (saveFailed !== hadFail) renderToday();
      else updateWeekCount(id);
      break;
    }

    case 'raise-edit': ui.raiseEdit[id] = true; renderReview(); break;
    case 'raise-later':
      if (item) { resetRaiseCount(item); delete ui.raiseEdit[id]; motionLeave(b.closest('.card'), renderReview); }
      break;
    case 'raise-ok': {
      if (!item) break;
      const input = el('raise-' + id);
      const v = input ? parsePositive(input.value) : raiseSuggest(item.value);
      if (v === null) break; // осознанный тихий no-op: карточка остаётся
      acceptRaise(item, v);
      delete ui.raiseEdit[id];
      motionLeave(b.closest('.card'), renderReview); // карточка уходит, затем перерисовка
      break;
    }

    case 'param-step': if (applyParamStep(id)) motionLeave(b.closest('.card'), renderReview); break;
    case 'param-keep': if (keepParam(id)) motionLeave(b.closest('.card'), renderReview); break;

    case 'close-week':
      if (closeWeek()) ui.justClosed = true;
      renderReview();
      window.scrollTo(0, 0); // длинный экран разбора схлопывается — наверх
      break;

    case 'move-up':
    case 'move-down': {
      if (!moveItem(id, act === 'move-up' ? 'up' : 'down')) break;
      renderItems();
      // вернуть фокус кнопке того же действия и пункта; на краю списка — парной
      const find = a => [...el('scr-items').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.id === id);
      let btn = find(act);
      if (!btn || btn.disabled) btn = find(act === 'move-up' ? 'move-down' : 'move-up');
      if (btn && !btn.disabled) btn.focus();
      break;
    }

    case 'edit-open': ui.editingId = id; ui.addOpen = false; ui.editNorm = null; renderItems(); break;
    case 'edit-cancel': ui.editingId = null; ui.editNorm = null; renderItems(); break;

    case 'norm-dec':
    case 'norm-inc': {
      if (!item) break;
      const cur = ui.editNorm !== null ? ui.editNorm : (item.normPerWeek || 7);
      const next = Math.max(1, Math.min(7, cur + (act === 'norm-inc' ? 1 : -1)));
      if (next === cur) break;
      ui.editNorm = next;
      renderItems();
      // вернуть фокус кнопке того же действия; на границе — парной (как у «выше/ниже»)
      const find = a => [...el('scr-items').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.id === id);
      let btn = find(act);
      if (!btn || btn.disabled) btn = find(act === 'norm-inc' ? 'norm-dec' : 'norm-inc');
      if (btn && !btn.disabled) btn.focus();
      break;
    }
    case 'edit-save': {
      if (!item) break;
      const name = el('e-name').value.trim();
      if (name) item.name = name;
      item.note = el('e-note').value.trim();
      if (item.type === 'param') {
        // pkind фиксирован при создании — правятся только порог, единица и шаг
        const oldPv = item.pvalue;
        let pv = oldPv;
        if (item.pkind === 'number') {
          const n = parseNum(el('e-pvalue') ? el('e-pvalue').value : '');
          if (n !== null) pv = n; // невалид — старый порог
          if (el('e-punit')) item.unit = el('e-punit').value.trim();
        } else {
          const m = /^(\d{1,2}):(\d{2})$/.exec((el('e-ptime') ? el('e-ptime').value : '') || '');
          if (m) pv = Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
        }
        if (pv !== oldPv) { item.pvalue = pv; recordBar(item, pv); } // история — по общим правилам
        const st = parseNum(el('e-pstep') ? el('e-pstep').value : '');
        if (st !== null) item.pstep = Math.round(st);
      } else if (item.area !== 'habit') {
        const rawValue = el('e-value').value;
        if (!String(rawValue).trim()) {
          item.value = null; // осознанная очистка: пункт остаётся чекбоксом без числа, история не трогается
        } else {
          const v = parsePositive(rawValue);
          if (v !== null && v !== item.value) { item.value = v; recordBar(item, v); }
          // невалидный ввод — старое значение сохраняется
        }
        item.unit = el('e-unit').value.trim();
        item.group = el('e-group').value.trim();
        if (item.type === 'weekly') {
          const g = parsePositive(el('e-goal') ? el('e-goal').value : null);
          if (g !== null && Math.round(g) >= 1) item.goal = Math.round(g); // невалид — старая цель
        }
      } else if (ui.editNorm !== null) {
        item.normPerWeek = Math.max(1, Math.min(7, ui.editNorm)); // ежедневная привычка: норма недели
      }
      save();
      ui.editingId = null;
      ui.editNorm = null;
      ui.savedFlash = true; // тихое подтверждение (движение, задача 12)
      renderItems();
      break;
    }

    case 'add-open': {
      ui.addOpen = true; ui.editingId = null; ui.addType = 'daily';
      ui.addArea = b.dataset.area === 'habit' ? 'habit' : 'min';
      ui.addPkind = 'time';
      // Подсказка «одна новая привычка за раз» видима все 14 дней после добавления пункта
      const newest = store.items.reduce((a, x) => (!a || x.addedAt > a.addedAt) ? x : a, null);
      ui.addHint = !!(newest && diffDays(todayKey(), newest.addedAt) < 14);
      renderItems();
      break;
    }
    case 'add-cancel': ui.addOpen = false; ui.addHint = false; renderItems(); break;
    case 'add-save': {
      const name = el('f-name').value.trim();
      if (!name) { el('f-name').focus(); break; }
      const note = el('f-note').value.trim();
      let item;
      if (ui.addArea === 'habit' && ui.addType === 'param') {
        const pkind = el('f-pkind') && el('f-pkind').value === 'number' ? 'number' : 'time';
        let pvalue = 0;
        if (pkind === 'time') {
          const m = /^(\d{1,2}):(\d{2})$/.exec((el('f-ptime') ? el('f-ptime').value : '') || '');
          if (m) pvalue = Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
        } else {
          const n = parseNum(el('f-pvalue') ? el('f-pvalue').value : '');
          if (n !== null) pvalue = n;
        }
        const st = parseNum(el('f-pstep') ? el('f-pstep').value : '');
        item = {
          id: uid(), name, value: null,
          unit: pkind === 'number' && el('f-punit') ? el('f-punit').value.trim() : '',
          note, group: '',
          type: 'param', area: 'habit', pkind, pvalue,
          pstep: st !== null ? Math.round(st) : 0,
          goal: null, active: true, addedAt: todayKey(), raiseAfter: 0,
          history: [{ date: todayKey(), value: pvalue }]
        };
      } else if (ui.addArea === 'habit') {
        item = {
          id: uid(), name, value: null, unit: '', note, group: '',
          type: 'daily', area: 'habit', normPerWeek: 7, // каноническая форма привычки (инвариант 11)
          goal: null, active: true, addedAt: todayKey(), raiseAfter: 0, history: []
        };
      } else {
        const type = el('f-type').value === 'weekly' ? 'weekly' : 'daily';
        let goal = null;
        if (type === 'weekly') {
          const g = parsePositive(el('f-goal') ? el('f-goal').value : null);
          goal = g !== null && Math.round(g) >= 1 ? Math.round(g) : 3; // невалид — цель по умолчанию
        }
        const value = parsePositive(el('f-value').value); // невалид/пусто — пункт без числа
        item = {
          id: uid(), name, value,
          unit: el('f-unit').value.trim(),
          note,
          group: el('f-group').value.trim(),
          type, area: 'min', goal,
          active: true, addedAt: todayKey(), raiseAfter: 0,
          history: (typeof value === 'number') ? [{ date: todayKey(), value }] : []
        };
      }
      store.items.push(item);
      save();
      ui.addOpen = false;
      ui.savedFlash = true; // тихое подтверждение (движение, задача 12)
      renderItems();
      break;
    }

    case 'export':
      exportJSON();
      renderItems(); // обновить строку «Последний экспорт» (и погасить строку импорта)
      break;
    case 'import':
      if (hadImportNote) renderItems(); // до открытия диалога: file-input должен остаться в живом DOM
      el('import-file').click();
      break;
  }
}

function onChange(e) {
  const t = e.target;
  if (syncDay()) return; // stale-экран: действие не применяется (инвариант 8)
  ui.importNote = null;
  const act = t.dataset.act;
  if (act === 'mark') {
    const hadFail = saveFailed;
    toggleMark(todayKey(), t.dataset.id);
    if (saveFailed !== hadFail) renderAll(); // баннер хранилища — редкий структурный путь
    else updateTodayMark(t);
  } else if (act === 'toggle-active') {
    const item = store.items.find(i => i.id === t.dataset.id);
    if (item) {
      item.active = t.checked;
      save();
      const wrap = t.closest('.rowwrap');
      if (wrap) wrap.classList.toggle('off', !item.active); // переход тумблера играет
    }
  } else if (act === 'boundary') {
    store.settings.dayBoundary = Number(t.value) || 0;
    save();
    armDayTimer(); // граница сместилась — таймер на новую; экран «Пункты» от неё не зависит, select держит фокус
    if (todayKey() !== ui.renderedDayKey) {
      // новая граница сдвинула логический день прямо сейчас — фиксируем без
      // перерисовки, иначе guard молча проглотит следующее действие
      ui.missOpen = {};
      ui.raiseEdit = {};
      ui.renderedDayKey = todayKey();
    }
  } else if (act === 'add-type') {
    ui.addType = t.value;
    renderItems(); // снимок/восстановление формы — внутри renderItems, цель не сбрасывается
  } else if (act === 'add-pkind') {
    ui.addPkind = t.value === 'number' ? 'number' : 'time';
    renderItems();
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

async function init() {
  // Стартовая проверка (инвариант 9): зеркало не пишется, пока она не завершена
  store = load();
  if (store) {
    mirrorReady = true; // localStorage валиден — источник истины
    save();             // рендер сразу, зеркало обновится асинхронно через дебаунс
  } else {
    // localStorage пуст или бит (corrupt-ключ уже записан) — пробуем зеркало;
    // зависший IndexedDB (WebKit) не должен блокировать первый рендер
    const snap = await Promise.race([
      mirrorRead(),
      new Promise(r => setTimeout(() => r(null), 1500))
    ]);
    if (snap && typeof snap.json === 'string') {
      try { store = migrate(JSON.parse(snap.json)); } catch (e) { store = null; }
    }
    mirrorReady = true;
    if (!store) store = defaultStore();
    save(); // тихое восстановление в localStorage либо первый mirror-write дефолта
  }
  navigator.storage?.persist?.()?.catch?.(() => {}); // fire-and-forget: просим не вычищать localStorage
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.querySelectorAll('#tabs button').forEach(b =>
    b.addEventListener('click', () => {
      ui.importNote = null;
      if (b.dataset.tab !== ui.tab) { ui.missOpen = {}; ui.raiseEdit = {}; }
      ui.tab = b.dataset.tab;
      if (!syncDay()) renderAll(); // при смене дня syncDay уже перерисовал новую вкладку
    }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { syncDay(); armDayTimer(); }
    else flushMirror(); // уход в фон — немедленный сброс незаписанного зеркала
  });
  window.addEventListener('focus', syncDay);
  window.addEventListener('pagehide', flushMirror);
  renderAll();
  armDayTimer();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

/* Тестовый хук для Node; в браузере — обычный запуск. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    get store() { return store; }, set store(v) { store = v; },
    defaultStore, migrate, dateKeyShift, dateKeyFromDate, addDays, diffDays,
    todayKey, msToNextBoundary, weekStartOf, currentWeekStart, previousWeekStart,
    toggleMark, isMarked, incTrain, undoTrain, trainCount,
    reviewDue, windowKeys, currentOneChange, raiseEligible, raiseSuggest, resetRaiseCount,
    acceptRaise, closeWeek, missedYesterday, markYesterday, plural, parseNum,
    fmtParam, paramDecision, applyParamStep, keepParam, habitsSteady,
    habitWeekCount, habitStreakFrom, habitStreak,
    moveItem, recordBar, parsePositive, isDayKey, load,
    mirrorRead, mirrorWrite, flushMirror
  };
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
