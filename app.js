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
    title: 'Блоки',
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
const SCHEMA_VERSION = 15;

let store = null;
let saveFailed = false; // хранилище недоступно — «Сегодня» показывает тихий баннер

const uid = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* Блок по умолчанию для стартовых пунктов (и для миграции v1-данных) */
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
    goal: null, note: '', group: '', active: true, addedAt: today, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  });
  return [
    { id: uid(), name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
      pkind: 'time', pvalue: 0, pstep: -15, goal: null, note: '', group: '',
      active: true, addedAt: today, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [{ date: today, value: 0 }],
      formula: null, ladder: null, ladderLog: [] },
    habit('Перестать грызть ногти'),
    habit('Ловить импульс трат → алгоритм')
  ];
}

/* ── Посев программы (задача 17) ───────────────────────────────
   Одноразовый и идемпотентный: migrate заводит программу владельца
   только на пустом store (items[] пуст) и только пока не стоит флаг
   settings.seed17. Непустые данные посев не трогает и флага не ставит.

   Чистка ставит флаг сама (emptyStore): «Начать с чистого листа»
   обязано оставаться чистым и после перезапуска — иначе следующий
   старт прогнал бы стёртый store через migrate и вернул программу
   (инвариант 18, «ни одного стартового пункта»). */

const SEED_GROUPS = ['Утро', 'Подряд', 'Движение'];

/* [название, значение, единица, блок, тип, цель, подпись, добавка] */
const SEED_ITEMS = [
  ['Умыться', null, '', 'Утро', 'daily', null, ''],
  ['Принять душ', null, '', 'Утро', 'daily', null, ''],
  ['Подтягивания + отжимания', 5, 'повт.', 'Подряд', 'daily', null, ''],
  ['Английский', 5, 'мин', 'Подряд', 'daily', null, ''],
  ['Развитие', 10, 'мин', 'Подряд', 'daily', null, ''],
  ['Пешком', 500, 'м', 'Движение', 'daily', null, ''],
  ['Тренировка', null, '', '', 'weekly', 3, TRAIN_NOTE],
  ['Телефон вне кровати', null, '', '', 'daily', null, '', { area: 'habit', normPerWeek: 7 }],
  ['Отбой', null, '', '', 'param', null, '',
    { area: 'habit', pkind: 'time', pvalue: 0, pstep: -15 }]
];

/* Выписки посева: текст и источник дословно (инвариант 16) */
const SEED_QUOTES = [
  ['Капля точит камень не силой, а частым падением.', 'Овидий'],
  ['Путь в тысячу ли начинается под ногами.', 'Лао-цзы'],
  ['Начал — половину сделал.', 'Гораций'],
  ['Кто везде — тот нигде.', 'Сенека'],
  ['Делай каждое дело так, будто оно последнее.', 'Марк Аврелий']
];

/* Пункты программы. Единственная фабрика на два пути — посев в migrate
   и defaultStore: наборы обязаны совпадать, поэтому собираются здесь. */
function programItems(today) {
  return SEED_ITEMS.map(([name, value, unit, group, type, goal, note, extra]) => {
    const it = {
      id: uid(), name, value, unit, type, area: 'min', goal, note, group,
      active: true, addedAt: today, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
      // числовому пункту — стартовая запись истории планки (инвариант 5)
      history: (typeof value === 'number') ? [{ date: today, value }] : [],
      formula: null, ladder: null, ladderLog: []
    };
    Object.assign(it, extra);
    // порог параметра — такая же планка: своя стартовая запись истории
    if (it.type === 'param') it.history = [{ date: today, value: it.pvalue }];
    return it;
  });
}

/* Выписки программы идут в общий список заметок; updatedAt задаёт
   порядок сверху вниз (notesByDate: день, при равенстве — правка) */
function programQuotes(today) {
  return SEED_QUOTES.map(([text, source], i) => ({
    id: uid(), date: today, text, source, kind: 'quote',
    updatedAt: SEED_QUOTES.length - i
  }));
}

const programGroups = () => SEED_GROUPS.map(name => ({ name }));

function seedProgram(s, today) {
  s.groups = programGroups();
  s.items = programItems(today);
  s.notes = programQuotes(today);
  s.settings.seed17 = true;
  s.settings.habitSeeded = true; // привычки программы уже здесь — посев v5 не нужен
}

function defaultStore() {
  const today = dateKeyShift(new Date(), 4);
  return {
    schemaVersion: SCHEMA_VERSION,
    items: programItems(today),
    // порядок блоков на экранах (инвариант 13); блок из двух и более
    // активных пунктов сам по себе рисует линию — отдельного признака нет
    groups: programGroups(),
    days: {},          // "YYYY-MM-DD" -> { itemId: true }
    weekLog: [],       // инкременты недельных счётчиков текущей календарной недели
    reviews: [],       // закрытые недели
    pendingRaises: [], // принятые повышения, ещё не записанные в разбор
    pendingLowers: [], // принятые понижения, ещё не записанные в разбор
    exercises: [],     // упражнения тренировки: рабочая нагрузка и её история
    sessions: [],      // записанные тренировки: день, значения упражнений, заметка
    notes: programQuotes(today), // выписки программы; дальше — заметки владельца
    paramDecided: {},  // itemId -> {week, from, to|null}: решения по параметрам, привязанные к разбираемой неделе
    draftOneChange: '',
    weekStart: today,  // историческая отсечка скользящей эпохи
    settings: {
      dayBoundary: 4,
      dayThreshold: 0.8,
      exportedAt: null,
      calendarSince: nextCalendarMonday(today),
      habitSeeded: true,
      seed17: true     // программа уже здесь: migrate не станет сеять её повторно
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

/* ── Формула и лестница: нормализация полей (инвариант 12) ──── */

/* Четыре закона в порядке отображения; на логику не влияют — только текст */
const FORMULA_KEYS = ['anchor', 'when', 'pair', 'identity', 'twoMin', 'friction', 'proof'];

/* Формула из внешних данных: объект из семи строк либо null.
   Пустая (все поля пусты после trim) — это null, а не объект пустышек.

   v14 → v15 (задача 20): формула несёт режим. Отдельного шага миграции не
   нужно — mode достраивается этой же безусловной нормализацией, как в своё
   время normPerWeek (v5→v6) и сама formula (v6→v7); шаг аддитивен и
   идемпотентен, days{} и reviews[] не трогает. */
function normFormula(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const out = {};
  let any = false;
  for (const k of FORMULA_KEYS) {
    const v = typeof f[k] === 'string' ? f[k].trim() : '';
    out[k] = v;
    if (v) any = true;
  }
  // режим описывает, КАК читать те же семь полей, и сам формулы не создаёт:
  // пустая формула с одним лишь mode остаётся null. Неизвестное — 'build'.
  out.mode = f.mode === 'break' ? 'break' : 'build';
  return any ? out : null;
}

/* Режим формулы — свойство формулы, а не пункта: у пункта без формулы
   режима нет вовсе (инвариант 12). */
const formulaMode = f => (f && f.mode === 'break') ? 'break' : 'build';

/* Лестница из внешних данных: непустой список ступеней, индекс в границах,
   неделя последнего шага — понедельник или null. Без ступеней лестницы нет. */
function normLadder(l, today) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  const steps = Array.isArray(l.steps)
    ? l.steps.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean)
    : [];
  if (!steps.length) return null;
  let step = Math.round(numOr(l.step, 0));
  if (!(step > 0)) step = 0;
  if (step > steps.length - 1) step = steps.length - 1;
  // рукотворный не-понедельник приводится к своему понедельнику, а не
  // обнуляется: иначе правка данных открывала бы лишний шаг на неделе
  const wk = l.steppedWeek;
  return {
    steps,
    step,
    steppedWeek: isDayKey(wk) ? weekStartOf(wk) : null,
    startedAt: isDayKey(l.startedAt) ? l.startedAt : today
  };
}

/* Журнал шагов: записи с валидным днём, неотрицательной ступенью и текстом.
   Флаг start (стартовая запись создания лестницы) сохраняется, если он есть,
   и только в виде true — иначе поле не появляется вовсе. */
function normLadderLog(log) {
  if (!Array.isArray(log)) return [];
  return log
    .filter(e => e && typeof e === 'object' && !Array.isArray(e) && isDayKey(e.date))
    .map(e => {
      const out = {
        date: e.date,
        step: Math.max(0, Math.round(numOr(e.step, 0))),
        text: typeof e.text === 'string' ? e.text : ''
      };
      if (e.start === true) out.start = true;
      return out;
    });
}

/* Миграции схемы. При изменении структуры: поднять SCHEMA_VERSION
   и добавить шаг вида if (s.schemaVersion < N) { ...; }.
   Толерантна к мусору: не-объекты отбрасываются, обязательные поля
   достраиваются, числовые приводятся или обнуляются — импортированный
   или повреждённый store не должен ронять ни migrate, ни рендер. */
/* opts.external — данные пришли извне (импорт файла, возврат стёртой
   копии). Стартовая программа принадлежит ПЕРВОМУ ЗАПУСКУ, а не всякому
   пустому store: файл, снятый версией без флага seed17, приносил пустой
   items[] и получал девять чужих пунктов (аудит, находка 3). */
function migrate(s, opts) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return defaultStore();
  s.schemaVersion = numOr(s.schemaVersion, 0) || 1; // мусорная версия = v1, шаги миграций не пропускаются

  // настройки — первыми: от dayBoundary зависит «сегодня» для достройки дат
  if (!s.settings || typeof s.settings !== 'object' || Array.isArray(s.settings)) s.settings = {};
  // граница дня — час суток: целое 0..23. Без рамки импортированное
  // значение вроде 1e6 уводило логический день на десятилетия назад и
  // currentWeekStart навсегда становился null (аудит, находка 28).
  s.settings.dayBoundary = (typeof s.settings.dayBoundary === 'number' && isFinite(s.settings.dayBoundary))
    ? Math.min(23, Math.max(0, Math.round(s.settings.dayBoundary)))
    : 4;
  // v13 → v14 (задача 17): порог зачёта дня — доля отмеченного, шаг 0,1
  s.settings.dayThreshold = clampThreshold(s.settings.dayThreshold);
  const today = dateKeyShift(new Date(), s.settings.dayBoundary);

  // пункты: только объекты; id и addedAt достраиваются, id дедуплицируются
  if (!Array.isArray(s.items)) s.items = [];
  s.items = s.items.filter(it => it && typeof it === 'object' && !Array.isArray(it));
  // Пустота, пришедшая извне, — намеренная: посев ей не адресован
  // независимо от schemaVersion и наличия флагов (A.2.1). Флаги ставятся
  // сразу и переживают сохранение: иначе следующий старт прогнал бы этот
  // же store через migrate уже как «первый запуск» и всё-таки засеял.
  if (opts && opts.external && !s.items.length) {
    s.settings.seed17 = true;
    s.settings.habitSeeded = true; // и посев привычек шага v4→v5
  }
  // посев программы (задача 17): только пустой store и только один раз
  let seeded = false;
  if (!s.items.length && s.settings.seed17 !== true) { seedProgram(s, today); seeded = true; }
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
    // v10 → v11 (задача 16C): якоря обеих механик планки — понедельник недели
    // последнего решения либо null. raiseAfter остаётся историческим полем:
    // счёт по массиву reviews пропущенные разборы блокировали навсегда.
    // Рукотворный не-понедельник приводится к своему понедельнику, как steppedWeek.
    it.raiseAfterWeek = isDayKey(it.raiseAfterWeek) ? weekStartOf(it.raiseAfterWeek) : null;
    it.lowerAfterWeek = isDayKey(it.lowerAfterWeek) ? weekStartOf(it.lowerAfterWeek) : null;
    if (!Array.isArray(it.history)) it.history = [];
    it.history = it.history
      .filter(h => h && typeof h === 'object' && !Array.isArray(h) && isDayKey(h.date))
      .map(h => ({ date: h.date, value: numOr(h.value, null) }))
      .filter(h => h.value !== null);
    // v6 → v7 (инвариант 12): формула, лестница и журнал шагов — аддитивно.
    // Лестницу несёт только ежедневный пункт: на weekly или param она
    // занимала единственный слот и снять её было нечем — лист детали
    // открывается только для daily (аудит, находка 4). Журнал не трогаем:
    // снятие лестницы ladderLog не изменяет (инвариант 12).
    it.formula = normFormula(it.formula);
    it.ladder = it.type === 'daily' ? normLadder(it.ladder, today) : null;
    it.ladderLog = normLadderLog(it.ladderLog);
  }
  // лестница в приложении одна: побеждает начатая позже (строгое сравнение —
  // при равенстве и отсутствии startedAt остаётся первая по порядку items[]),
  // у прочих снимается; журналы, отметки и история не трогаются
  let keeper = null;
  for (const it of s.items) {
    if (!it.ladder) continue;
    if (!keeper || it.ladder.startedAt > keeper.ladder.startedAt) keeper = it;
  }
  for (const it of s.items) if (it.ladder && it !== keeper) it.ladder = null;

  // v7 → v8: живой лестнице с пустым журналом дописывается стартовая запись
  // от startedAt. Непустой журнал не трогается: исходная ступень пути в нём
  // неизвестна, домысливать её нельзя. Идёт после разрешения конфликта —
  // снятой лестнице старт не пишется.
  if (s.schemaVersion < 8) {
    for (const it of s.items) {
      if (!it.ladder || it.ladderLog.length) continue;
      it.ladderLog.push({
        date: isDayKey(it.ladder.startedAt) ? it.ladder.startedAt : today,
        step: it.ladder.step,
        text: it.ladder.steps[it.ladder.step] || '',
        start: true
      });
    }
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

  // блоки (инвариант 13): имена уникальны и непусты, дубликаты схлопываются
  // в первый; порядок массива — это порядок блоков на экранах. Пересборка
  // списка заодно снимает поле chain (шаг v9→v10) — блок и есть цепочка
  if (!Array.isArray(s.groups)) s.groups = [];
  {
    const out = [];
    const seen = new Set();
    for (const g of s.groups) {
      if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
      const name = typeof g.name === 'string' ? g.name.trim() : '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name });
    }
    s.groups = out;
  }

  if (!Array.isArray(s.weekLog)) s.weekLog = [];
  s.weekLog = s.weekLog.filter(e => e && typeof e === 'object' && !Array.isArray(e));
  if (!Array.isArray(s.reviews)) s.reviews = [];
  s.reviews = s.reviews.filter(r => r && typeof r === 'object' && !Array.isArray(r));
  if (!Array.isArray(s.pendingRaises)) s.pendingRaises = [];
  s.pendingRaises = s.pendingRaises.filter(e => e && typeof e === 'object' && !Array.isArray(e));
  if (!Array.isArray(s.pendingLowers)) s.pendingLowers = [];
  s.pendingLowers = s.pendingLowers.filter(e => e && typeof e === 'object' && !Array.isArray(e));

  // v11 → v12 (задача 16D): упражнения и записанные тренировки. Шаг
  // аддитивен и идемпотентен: days{}, reviews[] и items[] не трогает.
  // Форма упражнения — как у пункта: имя, единица, рабочая нагрузка и
  // её история по тем же правилам (recordBar общий).
  if (!Array.isArray(s.exercises)) s.exercises = [];
  {
    const exIds = new Set();
    s.exercises = s.exercises.filter(e => e && typeof e === 'object' && !Array.isArray(e));
    for (const ex of s.exercises) {
      if (typeof ex.id !== 'string' || !ex.id || exIds.has(ex.id)) ex.id = uid();
      exIds.add(ex.id);
      if (typeof ex.name !== 'string') ex.name = '';
      if (typeof ex.unit !== 'string') ex.unit = '';
      if (typeof ex.active !== 'boolean') ex.active = true;
      if (!isDayKey(ex.addedAt)) ex.addedAt = today;
      ex.value = numOr(ex.value, null);
      if (ex.value !== null && ex.value <= 0) ex.value = null; // нагрузка всегда > 0
      if (!Array.isArray(ex.history)) ex.history = [];
      ex.history = ex.history
        .filter(h => h && typeof h === 'object' && !Array.isArray(h) && isDayKey(h.date))
        .map(h => ({ date: h.date, value: numOr(h.value, null) }))
        .filter(h => h.value !== null);
    }
  }
  // v12 → v13 (задача 16E): свободные заметки. Пустая по тексту заметка
  // не существует — в интерфейсе пустое сохранение удаляет её, поэтому
  // и на входе такие записи отбрасываются: данных в них нет.
  // v13 → v14 (задача 17): вид записи и источник. Существующим —
  // 'note' и пустой source; источник живёт только у выписки.
  if (!Array.isArray(s.notes)) s.notes = [];
  {
    const nIds = new Set();
    s.notes = s.notes
      .filter(n => n && typeof n === 'object' && !Array.isArray(n) &&
        typeof n.text === 'string' && n.text.trim())
      .map(n => {
        let id = typeof n.id === 'string' && n.id && !nIds.has(n.id) ? n.id : uid();
        nIds.add(id);
        const kind = n.kind === 'quote' ? 'quote' : 'note';
        return {
          id,
          date: isDayKey(n.date) ? n.date : today,
          text: n.text.trim(),
          kind,
          source: kind === 'quote' && typeof n.source === 'string' ? n.source.trim() : '',
          updatedAt: Math.max(0, Math.round(numOr(n.updatedAt, 0)))
        };
      });
  }

  if (!Array.isArray(s.sessions)) s.sessions = [];
  s.sessions = s.sessions
    .filter(x => x && typeof x === 'object' && !Array.isArray(x) && isDayKey(x.date))
    .map(x => ({
      id: typeof x.id === 'string' && x.id ? x.id : uid(),
      date: x.date,
      entries: (Array.isArray(x.entries) ? x.entries : [])
        .filter(e => e && typeof e === 'object' && !Array.isArray(e) && typeof e.exId === 'string')
        .map(e => ({ exId: e.exId, value: numOr(e.value, null) }))
        .filter(e => e.value !== null),
      note: typeof x.note === 'string' ? x.note : ''
    }));
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

  // v1 → v2: «Принять душ», подпись тренировки, блоки, посев истории планки.
  // Только что засеянной программе шаг не адресован: он переписал бы блоки
  // по именам старого набора («Тренировка» → «Тело»).
  if (s.schemaVersion < 2 && !seeded) {
    for (const it of s.items) {
      if (!it.group && DEFAULT_GROUPS[it.name]) it.group = DEFAULT_GROUPS[it.name];
      if (it.name === 'Тренировка' && !it.note) it.note = TRAIN_NOTE;
      if (typeof it.value === 'number' && isFinite(it.value) && !it.history.length) {
        it.history.push({ date: it.addedAt || dateKeyShift(new Date(), s.settings.dayBoundary), value: it.value });
      }
    }
    // в ПУСТОЙ список душ не дописывается: пустота здесь либо намеренная
    // (внешний файл, A.2), либо уже засеяна выше — оба случая не про v1
    if (s.items.length && !s.items.some(i => i.name === 'Принять душ')) {
      const shower = {
        id: uid(), name: 'Принять душ', value: null, unit: '', type: 'daily', area: 'min',
        goal: null, note: '', group: 'Тело', active: true,
        addedAt: dateKeyShift(new Date(), s.settings.dayBoundary), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
        // вставка идёт после валидации пунктов — каноническая форма задаётся здесь
        formula: null, ladder: null, ladderLog: []
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

  // v9 → v10: признак цепочки упразднён — линию рисует сам блок. Поле снято
  // безусловной пересборкой списка выше, отдельный шаг не нужен; items[],
  // days{} и reviews[] не изменяются

  // v8 → v9: список блоков собирается из item.group в порядке первого появления
  // в items[]. Существующий store.groups не перезаписывается; items[], days{}
  // и reviews[] не изменяются — группа остаётся именем в пункте (инвариант 13)
  if (s.schemaVersion < 9) {
    const seen = new Set(s.groups.map(g => g.name));
    for (const it of s.items) {
      const name = (it.group || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      s.groups.push({ name });
    }
  }

  // v5 → v6: недельная норма привычек (normPerWeek = 7) — достраивается
  // безусловной валидацией пунктов выше, отдельный шаг не нужен; миграция
  // аддитивна: days{} и reviews[] не изменяются (решение владельца 19.07.2026)
  // v6 → v7: formula/ladder/ladderLog — тем же способом (там же, инвариант 12);
  // ничего не сеется: стартовый текст лестницы живёт только в форме
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
const MIRROR_PROBE_MS = 1500; // сколько ждать зеркало на старте, не задерживая первый рендер

let mirrorTimer = null;
let mirrorDirty = false; // есть изменения, не доехавшие до зеркала
let mirrorReady = false; // стартовая проверка init() завершена — писать можно
let mirrorUnverified = false; // чтение зеркала не завершилось: что там лежит — неизвестно

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

/* Чтение зеркала с РАЗЛИЧЕНИЕМ трёх исходов (задача 19, A.1):
     'read'   — снапшот прочитан;
     'empty'  — база открылась, ключа нет (зеркала ещё не было);
     'failed' — чтение не завершилось: ошибка открытия, ошибка запроса
                или таймаут.
   Различать обязательно. Раньше все три сводились к null, и init(),
   не дождавшись медленного IndexedDB, писал поверх снапшота дефолтный
   store — единственная страховка от исчезновения localStorage
   уничтожалась ровно в тот момент, когда была нужна (аудит, находка 1).
   timeoutMs = 0 — ждать сколько угодно (строка «Резервная копия»). */
function mirrorProbe(timeoutMs) {
  // IndexedDB нет вовсе — терять нечего, это не «не дочитали»
  if (typeof indexedDB === 'undefined') return Promise.resolve({ status: 'empty', snap: null });
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const fail = () => finish({ status: 'failed', snap: null });
    if (timeoutMs > 0) setTimeout(fail, timeoutMs);
    idbOpen().then(db => {
      if (!db) { fail(); return; }
      try {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = () => {
          finish(req.result ? { status: 'read', snap: req.result } : { status: 'empty', snap: null });
          db.close();
        };
        req.onerror = () => { fail(); db.close(); };
      } catch (e) { fail(); try { db.close(); } catch (e2) {} }
    }).catch(fail);
  });
}

/* Снапшот или null — прежний контракт поверх mirrorProbe */
function mirrorRead() {
  return mirrorProbe(0).then(r => r.snap);
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

/* Отмена — только записей текущей недели (прошлое неизменяемо). Вместе с
   записью счётчика уходит и сессия того же дня; рабочая нагрузка
   упражнений при этом НЕ откатывается — история планки правдива
   (задача 16D, «Принятые ограничения»). */
function undoTrain(itemId) {
  const since = trainSince();
  for (let i = store.weekLog.length - 1; i >= 0; i--) {
    const e = store.weekLog[i];
    if (e.itemId !== itemId || e.date < since) continue;
    store.weekLog.splice(i, 1);
    for (let j = store.sessions.length - 1; j >= 0; j--) {
      if (store.sessions[j].date === e.date) { store.sessions.splice(j, 1); break; }
    }
    save();
    return;
  }
}

/* ── Упражнения и тренировки (инвариант 15) ───────────────────
   Упражнение — имя, единица и рабочая нагрузка с историей по общим
   правилам планки (recordBar). Сессия — факт тренировки: день,
   значения упражнений и заметка. */

const activeExercises = () => store.exercises.filter(e => e.active);

function findExercise(id) {
  return store.exercises.find(e => e.id === id) || null;
}

function addExercise(name, unit, value) {
  const nm = (name || '').trim();
  if (!nm) return null;
  const v = (typeof value === 'number' && isFinite(value) && value > 0) ? value : null;
  const ex = {
    id: uid(), name: nm, unit: (unit || '').trim(), value: v,
    history: v === null ? [] : [{ date: todayKey(), value: v }],
    active: true, addedAt: todayKey()
  };
  store.exercises.push(ex);
  save();
  return ex;
}

function updateExercise(id, name, unit) {
  const ex = findExercise(id);
  if (!ex) return false;
  const nm = (name || '').trim();
  if (!nm) return false; // безымянное упражнение не сохраняется — как у пунктов
  ex.name = nm;
  ex.unit = (unit || '').trim();
  save();
  return true;
}

function moveExercise(id, dir) {
  const i = store.exercises.findIndex(e => e.id === id);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= store.exercises.length) return false;
  const t = store.exercises[i];
  store.exercises[i] = store.exercises[j];
  store.exercises[j] = t;
  save();
  return true;
}

/* ── Заметки (инвариант 16) ────────────────────────────────────
   Свободный текст владельца: день записи, текст, время правки.
   Ни поиска, ни тегов, ни связей с пунктами — только запись. */

function addNote(text, kind, source) {
  const t = (text || '').trim();
  if (!t) return null; // пустая заметка не заводится
  const k = kind === 'quote' ? 'quote' : 'note';
  const n = {
    id: uid(), date: todayKey(), text: t, kind: k,
    source: k === 'quote' ? (source || '').trim() : '',
    updatedAt: Date.now()
  };
  store.notes.push(n);
  save();
  return n;
}

/* Пустой текст при сохранении удаляет заметку — отдельной кнопки для
   этого не нужно, но явная «Удалить» тоже есть. Вид записи задаётся
   при создании и не меняется: источник правится только у выписки. */
function updateNote(id, text, source) {
  const n = store.notes.find(x => x.id === id);
  if (!n) return false;
  const t = (text || '').trim();
  if (!t) return deleteNote(id);
  n.text = t;
  if (n.kind === 'quote' && source !== undefined) n.source = (source || '').trim();
  n.updatedAt = Date.now();
  save();
  return true;
}

/* Выписки — подмножество заметок; порядок общий (notesByDate). */
function quotes() {
  return store.notes.filter(n => n.kind === 'quote');
}

/* Выписка дня: детерминированный выбор по номеру логического дня —
   не случайный, чтобы один и тот же день давал одну и ту же строку. */
function quoteOfDay() {
  const list = quotes();
  if (!list.length) return null;
  return list[daysInSystem() % list.length];
}

function deleteNote(id) {
  const i = store.notes.findIndex(x => x.id === id);
  if (i < 0) return false;
  store.notes.splice(i, 1);
  save();
  return true;
}

/* От новых к старым: день записи, при равенстве — время правки */
function notesByDate() {
  return store.notes.slice().sort((a, b) =>
    a.date === b.date ? b.updatedAt - a.updatedAt : (a.date < b.date ? 1 : -1));
}

/* Запись тренировки: сессия дня, обновление нагрузок (история — только
   при изменении) и инкремент недельного счётчика, как раньше. */
function recordSession(weeklyId, entries, note) {
  const list = (Array.isArray(entries) ? entries : [])
    .map(e => ({ exId: e.exId, value: e.value }))
    .filter(e => findExercise(e.exId) && typeof e.value === 'number' && isFinite(e.value) && e.value > 0);
  store.sessions.push({ id: uid(), date: todayKey(), entries: list, note: (note || '').trim() });
  for (const e of list) {
    const ex = findExercise(e.exId);
    if (ex.value === e.value) continue; // нагрузка не менялась — истории нечего писать
    ex.value = e.value;
    recordBar(ex, e.value);
  }
  incTrain(weeklyId); // save() внутри
  return true;
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

/* ── Планка: повышение и понижение (инвариант 4) ─────────────
   Обе механики считают по КАЛЕНДАРНЫМ неделям и отметкам в days{},
   а не по массиву reviews: пропущенный разбор недели не съедает —
   она просто проходит тихо (инвариант 2), а механика продолжает
   работать. Якорь решения — понедельник недели, в которую оно
   принято; следующее предложение возможно, когда все нужные недели
   строго позже якоря. */

/* Критерий повышения: 3 последние закрытые недели, в каждой ≥6 из 7 */
function raiseEligible(item) {
  if (item.type !== 'daily' || !item.active || item.area !== 'min') return false; // повышение — только минимум
  if (!(typeof item.value === 'number' && isFinite(item.value) && item.value > 0)) return false;
  // пункт с лестницей повышения не получает: шаг ступени и шаг планки в одну
  // неделю — два изменения за раз (инвариант 4, задача 16C)
  if (item.ladder) return false;
  const W = closedWeeks(3);
  if (W.length < 3) return false;
  if (!W.every(w => itemWeekCount(item, w) >= 6)) return false;
  return item.raiseAfterWeek === null || W[0] > item.raiseAfterWeek;
}

/* Критерий понижения: 2 последние закрытые недели, в каждой ≤3 из 7.
   Значения планки критерий не требует: пункт без числа тоже может
   не держаться — решение по нему сводится к «Оставить». */
function lowerEligible(item) {
  if (item.type !== 'daily' || !item.active || item.area !== 'min') return false;
  const W = closedWeeks(2);
  if (W.length < 2) return false;
  // пункт должен существовать во ВСЕХ рассматриваемых неделях (A.4.1):
  // иначе «0 и 0 из 7» у заведённого сегодня пункта проходило как
  // «не держится» и разбор предлагал облегчить планку за недели, в
  // которые пункта не было (аудит, находка 6). Повышению такая защита
  // не нужна: там критерий требует ≥6 отметок, а у нового пункта их нет.
  if (!(item.addedAt <= W[0])) return false;
  if (!W.every(w => itemWeekCount(item, w) <= 3)) return false;
  return item.lowerAfterWeek === null || W[0] > item.lowerAfterWeek;
}

function raiseSuggest(v) {
  return v <= 12 ? v + 1 : Math.round(v * 1.1);
}

/* Насколько легче: крупная планка — на четверть, мелкая — на единицу,
   единице и ниже облегчать нечего (null — кнопки шага нет) */
function lowerSuggest(v) {
  if (!(typeof v === 'number' && isFinite(v))) return null;
  if (v > 12) return Math.round(v * 0.75);
  if (v >= 2) return v - 1;
  return null;
}

/* Якорь недели решения: и «Принять», и «Не сейчас» ставят его одинаково —
   отсчёт трёх недель начинается заново, с недели строго после текущей */
function resetRaiseCount(item) {
  item.raiseAfterWeek = currentWeekStart();
  save();
}

/* Понижение: планка меняется немедленно и попадает в срез разбора */
function acceptLower(item, newValue) {
  const from = item.value;
  item.value = newValue;
  recordBar(item, newValue);
  store.pendingLowers.push({ itemId: item.id, name: item.name, from, to: newValue });
  item.lowerAfterWeek = currentWeekStart();
  save();
}

/* «Оставить»: планка не меняется, решение по неделе зафиксировано */
function keepBar(item) {
  item.lowerAfterWeek = currentWeekStart();
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
  item.raiseAfterWeek = currentWeekStart();
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

/* Отметки ежедневного пункта в календарной неделе с понедельником mon —
   общая функция для обеих областей (инвариант 12) */
function itemWeekCount(item, mon) {
  let n = 0;
  for (let i = 0; i < 7; i++) if (isMarked(addDays(mon, i), item.id)) n++;
  return n;
}

/* Отметки привычки в той же неделе — тонкая обёртка (инвариант 11) */
function habitWeekCount(item, mon) {
  return itemWeekCount(item, mon);
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

/* Информационная готовность: 2 последние ЗАВЕРШЁННЫЕ календарные недели
   каждая активная привычка выполнила норму (≥ normPerWeek; норма
   ретроактивна — берётся текущая).
   Считает по days{} и календарю, как и всё остальное в программе роста.
   Раньше читала два последних элемента reviews — и тогда десять идеальных
   недель без единого разбора готовности не давали, а два разбора
   полугодовой давности давали её при пустых последних неделях
   (аудит, находка 5). reviews — архив, а не источник. */
function habitsSteady() {
  const habits = store.items.filter(i => i.type === 'daily' && i.area === 'habit' && i.active);
  if (!habits.length) return false;
  const W = closedWeeks(2);
  if (W.length < 2) return false;
  return W.every(w => habits.every(h => habitWeekCount(h, w) >= (h.normPerWeek || 7)));
}

/* ── Формула и лестница (инвариант 12) ──────────────────────
   Формула — только текст владельца, на логику не влияет. Лестница —
   ручная прогрессия: шаг вперёд по критерию двух недель, шаг назад
   всегда. Автоматических шагов нет. */

/* Единственный пункт с лестницей — или null, если её нет ни у кого */
function activeLadderItem() {
  return store.items.find(i => i.ladder) || null;
}

/* До n понедельников последних ЗАВЕРШЁННЫХ календарных недель, по
   возрастанию; текущая не входит, недели до calendarSince не существуют
   (инвариант 2) — при нехватке список короче n. */
function closedWeeks(n) {
  const out = [];
  const cur = currentWeekStart();
  const since = store.settings.calendarSince;
  if (!cur || !isDayKey(since)) return out;
  for (let i = 1; i <= n; i++) {
    const w = addDays(cur, -7 * i);
    if (w < since) break;
    out.unshift(w);
  }
  return out;
}

/* Норма недели для шага лестницы: у привычки — своя, у минимума — 6 из 7 */
function ladderNorm(item) {
  return item.area === 'habit' ? (item.normPerWeek || 7) : 6;
}

/* Критерий шага вперёд: обе последние завершённые недели набрали норму */
function ladderWeeksReady(item) {
  const weeks = closedWeeks(2);
  if (weeks.length < 2) return false;
  return weeks.every(w => itemWeekCount(item, w) >= ladderNorm(item));
}

function canStepForward(item) {
  const L = item && item.ladder;
  if (!L || L.step >= L.steps.length - 1) return false;
  if (L.steppedWeek && L.steppedWeek === currentWeekStart()) return false;
  return ladderWeeksReady(item);
}

/* Шаг назад доступен всегда при step > 0 — критериев не имеет */
function canStepBack(item) {
  return !!(item && item.ladder && item.ladder.step > 0);
}

/* Состояние лестницы одной строкой — ровно один из четырёх текстов */
function ladderStatus(item) {
  const L = item && item.ladder;
  if (!L) return '';
  if (L.step >= L.steps.length - 1) return 'Последняя ступень';
  if (L.steppedWeek && L.steppedWeek === currentWeekStart()) return 'Шаг уже сделан на этой неделе';
  if (ladderWeeksReady(item)) return 'Ступень держится две недели — можно шагнуть';
  return 'Две полные недели нормы ещё не набраны';
}

/* Запись в журнал: повторное изменение в тот же логический день заменяет
   последнюю запись (как в recordBar). Схлопывания «туда-обратно» здесь нет —
   журнал фиксирует движение, а не значение планки. Стартовая запись
   (start: true, создание лестницы) неприкосновенна: иначе создание и первый
   шаг в один день схлопнулись бы и путь читался бы с середины. */
function recordLadderStep(item, start) {
  if (!Array.isArray(item.ladderLog)) item.ladderLog = [];
  const L = item.ladder;
  const entry = { date: todayKey(), step: L.step, text: L.steps[L.step] || '' };
  if (start) entry.start = true;
  const last = item.ladderLog[item.ladderLog.length - 1];
  // замена — только между двумя нестартовыми записями одного дня: стартовую
  // нельзя ни затереть, ни затереть ею (повторное создание в день последнего
  // шага съело бы конец прошлого пути)
  if (last && last.date === entry.date && !last.start && !start) item.ladderLog[item.ladderLog.length - 1] = entry;
  else item.ladderLog.push(entry);
}

/* Единственный путь смены ступени; guard'ы внутри, возвращает boolean.
   Вперёд — по критерию и с отметкой недели, назад — без условий. */
function ladderStep(itemId, dir) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || !item.ladder) return false;
  const L = item.ladder;
  if (dir === 'back') {
    if (!canStepBack(item)) return false;
    L.step -= 1; // steppedWeek не меняется: шаг назад не тратит неделю
  } else {
    if (!canStepForward(item)) return false;
    L.step += 1;
    L.steppedWeek = currentWeekStart();
  }
  recordLadderStep(item);
  save();
  return true;
}

/* Пункт, занявший единственный слот лестницы, — или null, если слот свободен
   (для самого носителя лестницы слот не занят) */
function ladderBlockedBy(item) {
  if (!item || item.ladder) return null;
  return activeLadderItem();
}

/* Сохранение лестницы из формы: ступени по одной на строку, пустые строки
   отбрасываются. Пустой список — лестницы нет (как пустая формула — null).
   Правка не сбрасывает step, только подтягивает его в новые границы. */
function setLadder(itemId, text) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || item.type !== 'daily') return false;
  if (ladderBlockedBy(item)) return false; // слот занят другим пунктом
  const steps = String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!steps.length) {
    item.ladder = null;
    save();
    return true;
  }
  if (item.ladder) {
    item.ladder.steps = steps;
    if (item.ladder.step > steps.length - 1) item.ladder.step = steps.length - 1;
  } else {
    item.ladder = { steps, step: 0, steppedWeek: null, startedAt: todayKey() };
    recordLadderStep(item, true); // старт пути: путь читается с первой ступени
  }
  save();
  return true;
}

/* Снятие лестницы: days{}, history и ladderLog не трогаются */
function clearLadder(itemId) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || !item.ladder) return false;
  item.ladder = null;
  save();
  return true;
}

/* Сохранение формулы: пустая (все поля пусты после trim) — null */
function setFormula(itemId, values) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || item.type !== 'daily') return false;
  item.formula = normFormula(values);
  save();
  return true;
}

/* ── Блоки (инвариант 13) ──────────────────────────────────
   Блок — запись в store.groups: одно имя. Пункт хранит имя блока строкой;
   неизвестное имя не ошибка — такой пункт просто идёт без заголовка
   последним. Блок из двух и более активных пунктов и есть цепочка. */

const groupNameOf = it => (it.group || '').trim();

function findGroup(name) {
  const n = String(name ?? '').trim();
  return store.groups.find(g => g.name === n) || null;
}

function addGroup(name) {
  const n = String(name ?? '').trim();
  if (!n || findGroup(n)) return false;
  store.groups.push({ name: n });
  save();
  return true;
}

function moveGroup(name, dir) {
  const i = store.groups.findIndex(g => g.name === String(name ?? '').trim());
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= store.groups.length) return false;
  const t = store.groups[i];
  store.groups[i] = store.groups[j];
  store.groups[j] = t;
  save();
  return true;
}

/* Переименование атомарно: имя в списке и item.group всех пунктов блока
   меняются вместе. Пустое имя и столкновение с чужим именем не проходят. */
function renameGroup(oldName, newName) {
  const from = String(oldName ?? '').trim();
  const to = String(newName ?? '').trim();
  const g = findGroup(from);
  if (!g || !to) return false;
  if (to !== from && findGroup(to)) return false; // имена уникальны
  g.name = to;
  for (const it of store.items) if (groupNameOf(it) === from) it.group = to;
  save();
  return true;
}

/* Удаление блока: пункты остаются и отметки не трогаются — очищается
   только имя блока у них */
function deleteGroup(name) {
  const n = String(name ?? '').trim();
  const i = store.groups.findIndex(g => g.name === n);
  if (i < 0) return false;
  store.groups.splice(i, 1);
  for (const it of store.items) if (groupNameOf(it) === n) it.group = '';
  save();
  return true;
}

/* Раскладка дневного экрана: сначала блоки в порядке store.groups, затем
   пункты без блока или с неизвестным — одной секцией без заголовка */
function groupedItems(items) {
  const out = [];
  const known = new Set();
  for (const g of store.groups) {
    known.add(g.name);
    const inGroup = items.filter(it => groupNameOf(it) === g.name);
    if (inGroup.length) out.push({ group: g, items: inGroup });
  }
  const loose = items.filter(it => !known.has(groupNameOf(it)));
  if (loose.length) out.push({ group: null, items: loose });
  return out;
}

/* Соседи пункта по перестановке — пункты того же блока и той же области
   (задача 16F). Блок пункт меняет полем «Блок» в форме правки, а не
   стрелками и не перетаскиванием: порядок и принадлежность — разные
   решения. Возвращает индексы в store.items по возрастанию. */
function siblingIndexes(item) {
  const g = groupNameOf(item);
  const out = [];
  store.items.forEach((x, i) => {
    if (x.area === item.area && groupNameOf(x) === g) out.push(i);
  });
  return out;
}

/* Перестановка пункта в пределах своего блока: обмен с ближайшим
   соседом. Границы блока — первый и последний его пункт. */
function moveItem(id, dir) {
  const i = store.items.findIndex(x => x.id === id);
  if (i < 0) return false;
  const idxs = siblingIndexes(store.items[i]);
  const at = idxs.indexOf(i);
  const j = idxs[at + (dir === 'up' ? -1 : 1)];
  if (j === undefined) return false;
  const t = store.items[i];
  store.items[i] = store.items[j];
  store.items[j] = t;
  save();
  return true;
}

/* Есть ли куда двигать — тем же правилом рисуется disabled у стрелок */
function canMoveItem(id, dir) {
  const i = store.items.findIndex(x => x.id === id);
  if (i < 0) return false;
  const idxs = siblingIndexes(store.items[i]);
  return idxs[idxs.indexOf(i) + (dir === 'up' ? -1 : 1)] !== undefined;
}

/* Перестановка перетаскиванием: пункт встаёт на позицию to среди своих
   соседей по блоку, порядок остальных не меняется. */
function reorderItem(id, to) {
  const item = store.items.find(x => x.id === id);
  if (!item) return false;
  const idxs = siblingIndexes(item);
  const list = idxs.map(i => store.items[i]);
  const from = list.indexOf(item);
  if (from < 0 || to < 0 || to >= list.length || to === from) return false;
  list.splice(from, 1);
  list.splice(to, 0, item);
  idxs.forEach((pos, k) => { store.items[pos] = list[k]; });
  save();
  return true;
}

function reorderGroup(name, to) {
  const from = store.groups.findIndex(g => g.name === name);
  if (from < 0 || to < 0 || to >= store.groups.length || to === from) return false;
  const [g] = store.groups.splice(from, 1);
  store.groups.splice(to, 0, g);
  save();
  return true;
}

function reorderExercise(id, to) {
  const from = store.exercises.findIndex(e => e.id === id);
  if (from < 0 || to < 0 || to >= store.exercises.length || to === from) return false;
  const [e] = store.exercises.splice(from, 1);
  store.exercises.splice(to, 0, e);
  save();
  return true;
}

/* ── Прогресс (инвариант 14) ───────────────────────────────────
   Чистые функции от days{}, items[] и календаря. Ни разборы, ни
   закрытие недели на них не влияют: прошлое читается по фактам
   отметок, а не по срезам. Всё это живёт только на «Прогрессе» —
   экране, который открывают намеренно. */

/* Пункты минимума, существовавшие в этот день: активные сейчас и
   заведённые не позже дня (addedAt ≤ день). Пункт, добавленный
   сегодня, прошлые дни не переписывает. */
function minDayItems(dayKey) {
  return store.items.filter(i =>
    i.type === 'daily' && i.area === 'min' && i.active && i.addedAt <= dayKey);
}

/* Сколько таких пунктов отмечено: 0 — день пуст, меньше всех —
   частичный, все — закрыт. Один проход для серии и для цепи дней. */
function minDayMarks(dayKey) {
  const items = minDayItems(dayKey);
  return { done: items.filter(i => isMarked(dayKey, i.id)).length, total: items.length };
}

/* «День закрыт» — отмечены ВСЕ применимые пункты. Понятие принадлежит
   экрану «Сегодня» и планке дня; серия и цепь дней им не пользуются:
   у них своё понятие «день зачтён» (доля ≥ порога, задача 17).
   Пустой список пунктов днём закрытым не делает: закрывать было
   нечего. Иначе вакуумная истина дала бы серию до начала календаря. */
function minDayClosed(dayKey) {
  const m = minDayMarks(dayKey);
  return m.total > 0 && m.done === m.total;
}

/* ── Доля дня и порог зачёта (задача 17) ───────────────────────
   «День зачтён» — не «день закрыт»: планке дня нужны все пункты,
   серии довольно доли. Порог живёт в настройках, шаг 0,1. */

const THRESHOLD_MIN = 0.3, THRESHOLD_MAX = 1, THRESHOLD_STEP = 0.1;

/* Порог из внешних данных: доля в [0,3..1,0], округлённая до десятой */
function clampThreshold(v) {
  const n = Math.round(numOr(v, 0.8) * 10) / 10;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, n));
}

function dayThreshold() {
  return clampThreshold(store.settings.dayThreshold);
}

/* Доля отмеченного среди применимых пунктов дня. Пунктов не было —
   null: день выпадает из счёта и серию не обрывает. */
function dayScore(dayKey) {
  const m = minDayMarks(dayKey);
  return m.total > 0 ? m.done / m.total : null;
}

/* Сравнение доли с порогом идёт с допуском: 0,1 и деления вроде 4/5
   не представимы в двоичной дроби точно, и 0,8 ≥ 0,8 могло бы не
   выполниться после нескольких шагов степпера. */
const EPS = 1e-9;

/* Сколько отметок из total даёт зачёт при текущем пороге — число для
   подписи степпера: минимальное done, при котором done/total ≥ порога */
function dayNeed(total) {
  return total > 0 ? Math.ceil(total * dayThreshold() - EPS) : 0;
}

/* «В системе N дней»: логические дни от calendarSince до сегодня
   включительно. Не прерывается никогда — пропуски на неё не влияют.
   Ноль до наступления calendarSince (миграция ставит его в ближайший
   понедельник, который может быть впереди). */
function daysInSystem() {
  const since = store.settings.calendarSince;
  const t = todayKey();
  if (!isDayKey(since) || t < since) return 0;
  return diffDays(t, since) + 1;
}

/* Амнистия одна на неделю: следующий незачтённый день прощается,
   только если предыдущий прощённый дальше этого срока (задача 17).
   Два незачтённых подряд — частный случай: расстояние 1 ≤ 7. */
const AMNESTY_GAP = 7;

/* Серия зачтённых дней, считая назад от дня end (инвариант 14).
   Сегодня незачтённым пропускается — день ещё не кончился, и амнистию
   он не тратит. Дальше назад: зачтённый +1; незачтённый прощается,
   если прошлая амнистия дальше AMNESTY_GAP, иначе обрыв; день без
   применимых пунктов проходит мимо счёта. Дно — calendarSince.

   score — как читать долю дня; отдельным параметром ради bestStreak,
   который прогоняет ту же логику по всей эпохе с готовой таблицей. */
function streakBack(end, score) {
  const t = todayKey();
  const since = store.settings.calendarSince;
  const floor = isDayKey(since) ? since : end;
  if (end < floor) return 0;
  const th = dayThreshold() - EPS;
  let n = 0;
  let k = end;
  if (k === t) { // сегодня: зачтённый идёт в счёт, незачтённый просто пропускается
    const s = score(k);
    if (s !== null && s >= th) n = 1;
    k = addDays(k, -1);
  }
  let amnesty = null; // день последней амнистии (он позже текущего k)
  for (; k >= floor; k = addDays(k, -1)) {
    const s = score(k);
    if (s === null) continue;
    if (s >= th) { n++; continue; }
    if (amnesty !== null && diffDays(amnesty, k) <= AMNESTY_GAP) break;
    amnesty = k; // прощён: серию не рвёт и в счёт не идёт
  }
  return n;
}

function dayStreak() {
  return streakBack(todayKey(), dayScore);
}

/* Рекорд — максимальная серия за всю историю по тем же правилам:
   в store не хранится, считается по days{} при каждом показе.

   Считается ОДНИМ проходом (задача 19, B.1). Раньше здесь стоял
   streakBack для каждого дня эпохи, и каждый уходил назад до
   calendarSince: квадратично по дням. Замер аудита — 100 мс на годе,
   940 мс на трёх годах, и «Прогресс» замирал вместе с ним.

   Наблюдение, которое делает проход линейным: куда упрётся счёт,
   зависит не от дня, которым он кончается, а от ЦЕПОЧКИ незачтённых
   дней под ним. Счёт, начатый выше незачтённого дня u, прощает u,
   потом следующий незачтённый v — если v дальше AMNESTY_GAP, иначе
   обрывается на нём. Значит для каждого незачтённого дня можно один
   раз вычислить день обрыва (breakAt) по предыдущему такому же, а
   длину серии, кончающейся днём i, взять как разность префиксных
   сумм зачтённых дней. Дни без применимых пунктов (доля null) в
   обеих суммах прозрачны — как и в streakBack. */
function bestStreak() {
  const t = todayKey();
  const since = store.settings.calendarSince;
  if (!isDayKey(since) || t < since) return 0;
  const th = dayThreshold() - EPS;

  // проход первый: доли дней, префикс зачтённых, список незачтённых
  const days = [];       // дни эпохи по возрастанию
  const scored = [];     // scored[i] — зачтённых дней в days[0..i]
  const unscored = [];   // индексы дней с долей ниже порога (null — не сюда)
  let acc = 0;
  for (let k = since; k <= t; k = addDays(k, 1)) {
    const s = dayScore(k);
    if (s !== null) {
      if (s >= th) acc++;
      else unscored.push(days.length);
    }
    days.push(k);
    scored.push(acc);
  }

  // проход второй: цепочка амнистий. breakAt[j] — индекс дня, на котором
  // оборвётся счёт, спустившийся ниже j-го незачтённого дня; −1 — обрыва
  // нет, счёт доходит до начала эпохи.
  const breakAt = new Array(unscored.length);
  for (let j = 0; j < unscored.length; j++) {
    if (j === 0) { breakAt[j] = -1; continue; }
    const u = days[unscored[j]], v = days[unscored[j - 1]];
    breakAt[j] = diffDays(u, v) <= AMNESTY_GAP ? unscored[j - 1] : breakAt[j - 1];
  }

  // длина серии, кончающейся днём i (правило «сегодня» сюда не входит)
  const upto = (i, j) => {
    if (i < 0) return 0;
    if (j < 0) return scored[i];              // незачтённых под ним не было
    const b = breakAt[j];
    return scored[i] - (b < 0 ? 0 : scored[b]);
  };

  // проход третий: максимум. j идёт вместе с i — последний незачтённый ≤ i
  const last = days.length - 1;
  let best = 0, j = -1;
  for (let i = 0; i < last; i++) {
    if (j + 1 < unscored.length && unscored[j + 1] === i) j++;
    const n = upto(i, j);
    if (n > best) best = n;
  }
  // сегодня по особому правилу: незачтённый пропускается, а не амнистируется,
  // поэтому счёт за сегодня — это счёт за вчера плюс сам сегодняшний день
  const todayScored = scored[last] - (last > 0 ? scored[last - 1] : 0);
  const nToday = (last > 0 ? upto(last - 1, j) : 0) + todayScored;
  return nToday > best ? nToday : best;
}

/* Понедельники последних n календарных недель по возрастанию, включая
   текущую. Опирается на weekStartOf, а не на currentWeekStart: сетка
   рисуется и до наступления calendarSince. */
function chainWeeks(n) {
  const mon = weekStartOf(todayKey());
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(mon, -7 * i));
  return out;
}

/* Знаменатель строки «Отметки»: дни от позднейшей из двух дат —
   когда пункт заведён и когда началась эпоха — до сегодня включительно.
   Пункт, заведённый вчера, показывает «1 из 2», а не «1 из 32»:
   иначе новый пункт выглядел бы провалом с первого дня. */
function marksWindow(item) {
  const since = store.settings.calendarSince;
  const t = todayKey();
  if (!isDayKey(since)) return 0;
  const from = (isDayKey(item.addedAt) && item.addedAt > since) ? item.addedAt : since;
  return t < from ? 0 : diffDays(t, from) + 1;
}

/* Отметок пункта за время в системе — числитель строки «Отметки» */
function marksInSystem(item) {
  const since = store.settings.calendarSince;
  const t = todayKey();
  if (!isDayKey(since)) return 0;
  let n = 0;
  for (const k of Object.keys(store.days)) {
    if (k >= since && k <= t && store.days[k][item.id]) n++;
  }
  return n;
}

/* Ряд «Подъёма» — точки {date, value} и вид ряда. Планка первична:
   лестница даёт ряд только у пункта без истории значений (не больше
   одного визуала на пункт). Меньше двух записей — ряда нет. */
function riseSeries(item) {
  const hist = Array.isArray(item.history) ? item.history : [];
  if (hist.length >= 2) {
    return { kind: 'bar', points: hist.map(x => ({ date: x.date, value: x.value })) };
  }
  const log = Array.isArray(item.ladderLog) ? item.ladderLog : [];
  if (log.length >= 2) {
    return { kind: 'ladder', points: log.map(x => ({ date: x.date, value: x.step + 1 })) };
  }
  return null;
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
    lowers: [...store.pendingLowers],
    // в срез идут только решения разобранной недели; чистится paramDecided целиком
    params: Object.entries(store.paramDecided)
      .filter(([, d]) => d.week === week)
      .map(([id, d]) => ({ id, from: d.from, to: d.to }))
  });
  store.pendingRaises = [];
  store.pendingLowers = [];
  store.draftOneChange = '';
  store.paramDecided = {};
  // счётчик «Сегодня» обнуляется сменой недели, не закрытием: чистим только прошлое
  const cur = currentWeekStart();
  store.weekLog = store.weekLog.filter(e => e.date >= cur);
  save();
  return true;
}

/* ── Чистка и её отмена (задача 16.1) ──────────────────────────
   Стирание данных — не исключение из правила «необратимых операций
   нет», а его применение: прежний store целиком ложится в отдельный
   ключ и живёт там, пока владелец не уберёт копию вторым решением.
   Копия — не часть store: ни в экспорт, ни в импорт она не входит. */

const WIPE_KEY = NS + ':wiped';

/* Числа для строки предупреждения и для строки возврата */
function wipeStats(s) {
  return {
    items: s.items.length,
    groups: s.groups.length,
    days: Object.keys(s.days).length,
    reviews: s.reviews.length,
    ladders: s.items.filter(i => i.ladder).length,
    exercises: s.exercises.length,
    sessions: s.sessions.length,
    notes: s.notes.length
  };
}

function wipedCopy() {
  try {
    const raw = localStorage.getItem(WIPE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return (c && typeof c === 'object' && c.store && typeof c.store === 'object') ? c : null;
  } catch (e) { return null; } // нечитаемая копия — как её отсутствие
}

function dropWiped() {
  try { localStorage.removeItem(WIPE_KEY); } catch (e) { /* нечего убирать */ }
}

/* Пустое хранилище: ни одного стартового пункта. Граница дня и порог
   зачёта — настройки того, как считается день, а не данные: обе
   переживают чистку (инвариант 18). */
function emptyStore(boundary, threshold) {
  const b = (typeof boundary === 'number' && isFinite(boundary)) ? boundary : 4;
  const today = dateKeyShift(new Date(), b);
  return {
    schemaVersion: SCHEMA_VERSION,
    items: [], groups: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {},
    draftOneChange: '',
    weekStart: today,
    settings: {
      dayBoundary: b,
      dayThreshold: clampThreshold(threshold),
      exportedAt: null,
      calendarSince: nextCalendarMonday(today),
      habitSeeded: true, // посев привычек уже состоялся: чистый лист остаётся чистым
      seed17: true       // и посев программы: перезапуск не вернёт стёртое (инвариант 18)
    }
  };
}

/* Копия пишется ПЕРЕД заменой store: если её некуда положить, чистка
   не выполняется вовсе — необратимо стирать нельзя. Зеркало сбрасывается
   немедленно: с дебаунсом следующий запуск при пустом localStorage
   восстановил бы стёртое из старого снапшота. */
function wipeAll() {
  const prev = store;
  try {
    localStorage.setItem(WIPE_KEY, JSON.stringify({
      store: prev, wipedAt: Date.now(), stats: wipeStats(prev)
    }));
  } catch (e) {
    return false;
  }
  store = emptyStore(
    prev.settings && prev.settings.dayBoundary,
    prev.settings && prev.settings.dayThreshold);
  save();
  flushMirror();
  return true;
}

/* Возврат: копия проходит migrate (как и импорт, инвариант 6 — она
   могла быть снята прежней версией), ключ убирается. */
function restoreWiped() {
  const c = wipedCopy();
  if (!c) return false;
  let restored;
  // external: копия — данные извне, посев ей не адресован (A.2.1)
  try { restored = migrate(c.store, { external: true }); } catch (e) { return false; }
  store = restored;
  save();
  flushMirror();
  dropWiped();
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
      incoming = migrate(data, { external: true }); // файл извне — без посева (A.2.1)
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
    ui.groupRename = null;
    ui.groupDelete = null;
    ui.groupAdd = false;
    ui.groupPick = null;
    ui.groupNew = false;
    // заметки принадлежали прежним данным — форма, подтверждение и черновик
    ui.noteAdd = false;
    ui.noteEditingId = null;
    ui.noteDelete = null;
    ui.noteDraft = null;
    ui.exEditingId = null;
    ui.exAddOpen = false;
    closeDetail(); // лист детали принадлежал прежним данным (и чистит свой черновик)
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
  renderedTab: null,    // последний отрисованный вид (вкладка или лист) — скролл сбрасывается только при его смене
  formDraft: null,      // черновик открытой формы: значения, фокус, каретка
  detailId: null,       // открытый лист детали пункта (поверх вкладки)
  detailForm: null,     // форма в листе: 'formula' | 'ladder' | null
  detailScroll: 0,      // позиция скролла вкладки, с которой открыт лист
  ladderConfirm: false, // «Снять лестницу» ждёт подтверждения вторым тапом
  formulaMode: null,    // режим в открытой форме формулы (null — как у самой формулы)
  detailDraft: null,    // черновик формы листа — отдельный слот от «Пунктов» (14.2, вопрос 2)
  groupRename: null,    // имя блока с раскрытой правкой
  groupDelete: null,    // блок ждёт подтверждения удаления вторым тапом
  groupAdd: false,      // открыто поле «Добавить блок»
  groupPick: null,      // выбор в поле «Блок» открытой формы (null — как у пункта)
  groupNew: false,      // в поле «Блок» выбран «+ Новый блок…»: раскрыто имя
  weekOpen: false,      // свёртка «Показать неделю» в разборе (задача 16C)
  ladderStay: false,    // «Остаться»: решение по ступени принято, карточка уступает строке состояния
  reviewOpen: false,    // разбор открыт поверх вкладки (с таб-бара он ушёл, задача 16B)
  reviewFrom: null,     // вкладка, на которую вернёт «Готово»
  reviewScroll: 0,      // её скролл — возвращается вместе с ней
  trainOpen: false,     // лист «Тренировка» поверх вкладки (задача 16D)
  trainId: null,        // недельный пункт, чей счётчик растёт записью
  trainFrom: null,      // вкладка возврата и её скролл
  trainScroll: 0,
  trainNote: '',        // черновик заметки листа — переживает перерисовку
  exEditingId: null,    // упражнение с раскрытой правкой
  exAddOpen: false,     // открыта форма «Добавить упражнение»
  noteAdd: false,       // открыта форма новой заметки (задача 16E)
  noteKind: 'note',     // вид новой записи: 'note' | 'quote' (задача 17)
  noteEditingId: null,  // заметка с раскрытой правкой
  noteDelete: null,     // заметка ждёт подтверждения удаления вторым тапом
  noteDraft: null,      // черновик формы заметки — свой слот, как у листа детали
  wipeOpen: false,      // раскрыто предупреждение «Начать с чистого листа» (16.1)
  wipeFailed: false,    // копию некуда положить — чистка не выполнена (19, C.6.4)
  wipeConfirm: false,   // «Стереть» ждёт подтверждения вторым тапом
  wipeDropConfirm: false, // «Убрать копию» — тоже вторым тапом
  // свёрнутые секции «Настроек»: по умолчанию раскрыты только «Пункты»
  settingsOpen: { groups: false, items: true, exercises: false, data: false, system: false }
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

const MOTION_MS = 240; // потолок движения (12.1); fallback ухода карточки — сверх него

function prefersReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { return false; }
}

/* Короткий scale-отклик на тап (класс-триггер .pop с рестартом анимации).
   Только в горячих путях отметки — при первичном рендере класса нет.
   При reduced-motion не навешивается (и CSS animation:none подстрахует). */
function tapPop(node) {
  if (!node || prefersReducedMotion()) return;
  node.classList.remove('pop');
  void node.offsetWidth; // рефлоу — чтобы повторный тап перезапустил анимацию
  node.classList.add('pop');
}

/* Пометить узел уходящим, затем выполнить done() — перерисовку, реально
   убирающую узел. Триггер — transitionend, но он ненадёжен (jsdom его не
   шлёт, reduced-motion отключает переход), поэтому done гарантирован
   fallback-таймаутом и вызывается ровно один раз. При reduced-motion —
   сразу, без ожидания: конечное состояние достижимо мгновенно. */
/* Тихое подтверждение «Сохранено» обычно гаснет ключевыми кадрами. При
   reduced-motion анимация выключена глобальным блоком, и узел остался бы
   невидимым (opacity: 0) — CSS показывает его статично, а убрать его после
   паузы может только JS: конечное состояние должно быть достижимо и здесь
   (задача 19, C.6.3). */
const FLASH_MS = 1200;

function armFlash() {
  if (!prefersReducedMotion()) return;
  const n = document.querySelector('.flash');
  if (!n) return;
  setTimeout(() => { if (n.isConnected) n.remove(); }, FLASH_MS);
}

function motionLeave(node, done) {
  if (!node || prefersReducedMotion()) { done(); return; }
  // зафиксировать текущую высоту как старт схлопывания (в конце — max-height:0)
  node.style.maxHeight = node.scrollHeight + 'px';
  void node.offsetHeight; // рефлоу, чтобы стартовое значение применилось до перехода
  node.classList.add('leaving');
  node.style.maxHeight = '0px';
  let fired = false;
  // done ровно один раз; если узел уже убран (напр. соседним решением,
  // перерисовавшим весь разбор) — повторная перерисовка не нужна
  const fin = () => { if (fired) return; fired = true; if (node.isConnected) done(); };
  node.addEventListener('transitionend', fin, { once: true });
  setTimeout(fin, MOTION_MS + 60);
}

/* Пять вкладок плюс два листа поверх них: лист детали пункта и разбор
   недели. Разбор с таб-бара ушёл (задача 16B) — открывается баннером
   «Сегодня» и строкой «Прогресса», закрывается «Готово» на ту вкладку,
   с которой открыт. Лист детали главнее: он открывается и из разбора. */
function renderAll() {
  const map = {
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    notes: 'scr-notes', settings: 'scr-settings'
  };
  // исчезнувший пункт (импорт) закрывает лист детали
  const detail = ui.detailId ? store.items.find(i => i.id === ui.detailId) : null;
  if (ui.detailId && !detail) closeDetail();
  // исчезнувший недельный пункт закрывает лист тренировки — как и лист детали
  if (ui.trainOpen && !store.items.some(i => i.id === ui.trainId)) closeTrain();
  const sheet = detail ? 'detail' : (ui.reviewOpen ? 'review' : (ui.trainOpen ? 'train' : null));
  for (const [tab, id] of Object.entries(map)) el(id).hidden = sheet ? true : tab !== ui.tab;
  el('scr-detail').hidden = sheet !== 'detail';
  el('scr-review').hidden = sheet !== 'review';
  el('scr-train').hidden = sheet !== 'train';
  document.querySelectorAll('#tabs button').forEach(b => {
    // вкладка возврата остаётся текущей и при открытом листе
    if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (detail) renderDetail(detail);
  else if (ui.reviewOpen) renderReview();
  else if (ui.trainOpen) renderTrain();
  else {
    if (ui.tab === 'today') renderToday();
    if (ui.tab === 'habits') renderHabits();
    if (ui.tab === 'progress') renderProgress();
    if (ui.tab === 'notes') renderNotes();
    if (ui.tab === 'settings') renderSettings();
  }
  const view = sheet || ui.tab;
  if (ui.renderedTab !== view) window.scrollTo(0, 0); // скролл — только при фактической смене вида
  ui.renderedTab = view;
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

  // пустой список — как на «Привычках»: планка дня без пунктов ничего не
  // измеряет, поэтому её нет вовсе (задача 16.1, состояние после чистки)
  if (total) {
    h += `
    <div class="dayline">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="bar-note${closed ? ' ok' : ''}" aria-live="polite">${closed ? 'День закрыт' : `<b>${done}</b>&nbsp;из&nbsp;${total}`}</p>
    </div>`;
    h += `<div class="list">` + groupSections(items, t, false) + `</div>`;
  } else {
    h += `<p class="muted">Пунктов пока нет — добавить можно в «Пунктах».</p>`;
  }

  // area у недельного счётчика не проверяется: migrate принудительно ставит
  // ему min (инвариант 10), другого значения в данных не бывает (C.5.4)
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
          <button class="btn icon plus" data-act="train-inc" data-id="${esc(w.id)}" aria-label="записать тренировку: «${esc(w.name)}»">+</button>
        </span>
      </div>
      ${n ? `<button class="undo" data-act="train-undo" data-id="${esc(w.id)}" aria-label="отменить последний: «${esc(w.name)}»">отменить последний</button>` : ''}`;
  }

  h += `<p class="creed">Минимум выполняется даже в худший день.</p>`;

  el('scr-today').innerHTML = h;
}

/* Секции дневного экрана: заголовок блока плюс его строки. Блок из двух и
   более активных пунктов заворачивается в .chain и рисует линию; блок из
   одного пункта и пункты без блока — нет (инвариант 13). Крайние половинки
   линии гасит CSS по :first-child/:last-child — считать соседей не нужно. */
function groupSections(items, t, habit) {
  let h = '';
  for (const sec of groupedItems(items)) {
    if (sec.group) h += `<p class="g-label">${esc(sec.group.name)}</p>`;
    const chained = !!sec.group && sec.items.length > 1;
    if (chained) h += `<div class="chain">`;
    for (const it of sec.items) h += dailyRow(it, t, habit, chained);
    if (chained) h += `</div>`;
  }
  return h;
}

/* Строка ежедневного пункта: чекбокс, точка-маркер, ретро-отметка —
   общая для «Сегодня» (area min) и «Привычек» (habit: true добавляет
   серию у названия и полосу текущей недели под строкой). У пункта с
   лестницей подписью идёт текущая ступень (инвариант 12).
   Название снова внутри label: тап по всей строке, кроме хвоста,
   переключает отметку. Лист детали открывает хвостовая кнопка — она
   есть только у пунктов с лестницей или формулой, поэтому строка
   обычного пункта совпадает с версией до задачи 14 попиксельно.
   Имя чекбоксу даёт содержимое label — aria-label его только затёр бы. */
function dailyRow(it, t, habit, chain) {
  const on = isMarked(t, it.id);
  const miss = missedYesterday(it, t);
  const vu = valUnit(it);
  const streak = habit ? habitStreak(it) : 0; // при нуле справка скрыта
  const L = it.ladder;
  const sub = L ? L.steps[L.step] : it.note;  // ступень вместо подписи
  // половинки линии блока: верхняя идёт к предыдущему пункту, нижняя — к
  // следующему; у крайних строк лишнюю гасит CSS. Идут первыми в разметке —
  // круг отметки закрывает линию собой.
  const segs = chain
    ? `<span class="cseg up" aria-hidden="true"></span><span class="cseg down" aria-hidden="true"></span>`
    : '';
  return `
      <div class="rowwrap${habit ? ' hrow' : ''}">
        ${segs}
        <label class="row check${on ? ' on' : ''}">
          <input type="checkbox" data-act="mark" data-id="${esc(it.id)}"${on ? ' checked' : ''}>
          <span class="box" aria-hidden="true"></span>
          <span class="txt">
            <span class="tname">${esc(it.name)}${vu ? ` <span class="val">${esc(vu)}</span>` : ''}${streak ? ` <span class="streak">серия ${streak} нед</span>` : ''}</span>
            ${sub ? `<span class="note">${esc(sub)}</span>` : ''}
          </span>
        </label>
        ${detailTail(it)}
        ${miss ? `<button type="button" class="dot" data-act="miss-note" data-id="${esc(it.id)}" aria-expanded="${ui.missOpen[it.id] ? 'true' : 'false'}" aria-label="вчера — пропуск"><i></i></button>` : ''}
        ${miss && ui.missOpen[it.id] ? `<p class="miss-note">вчера — пропуск<button type="button" class="undo" data-act="mark-yesterday" data-id="${esc(it.id)}" aria-label="отметить вчера: «${esc(it.name)}»">отметить</button></p>` : ''}
        ${habit ? habitWeekRow(it, t) : ''}
      </div>`;
}

/* Хвостовая кнопка строки дня — вход в лист детали. Существует только у
   пунктов, которым есть что показать (лестница или формула): иначе строка
   не должна отличаться от прежней ни на пиксель. Несёт метку положения на
   лестнице (muted, без акцента — инвариант 12) и шеврон, как у баннера. */
function detailTail(it) {
  if (!it.ladder && !it.formula) return '';
  const L = it.ladder;
  return `<button type="button" class="idetail" data-act="item-detail" data-id="${esc(it.id)}" aria-label="подробно: «${esc(it.name)}»">` +
    (L ? `<span class="lstep">${L.step + 1}/${L.steps.length}</span>` : '') +
    `<span class="chev" aria-hidden="true">&rsaquo;</span></button>`;
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
    <div class="list">` + groupSections(habits, t, true) + `</div>`;
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

/* ── Экран 3 — «Прогресс» (инвариант 14) ───────────────────────
   Единственное место, где приложение показывает прошлое: экран
   открывают намеренно, дневные экраны остаются без истории. */

const RISE_W = 100, RISE_H = 44, RISE_PAD = 2; // система координат ступеньки

/* Ступенчатый путь: ось X — даты от первой записи до сегодня, ось Y —
   значения. Последнее значение держится до правого края, поэтому
   сегментов ровно 2N−1: N−1 горизонталей, N−1 вертикалей и финальная
   горизонталь. Ни осей, ни сетки, ни точек — только линия. */
function risePath(points) {
  const r = n => Math.round(n * 100) / 100;
  const first = points[0].date;
  const last = points[points.length - 1].date;
  const t = todayKey();
  const end = last > t ? last : t;
  const span = diffDays(end, first);
  // все записи одним днём (стартовая запись лестницы и шаг того же дня) —
  // раскладываем по индексу: дат для пропорции не хватает
  const x = (p, i) => span > 0
    ? r(RISE_W * diffDays(p.date, first) / span)
    : r(points.length > 1 ? RISE_W * i / (points.length - 1) : 0);
  const vals = points.map(p => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const y = v => hi === lo
    ? RISE_H / 2 // ряд без размаха — ровная линия посередине
    : r(RISE_H - RISE_PAD - (v - lo) / (hi - lo) * (RISE_H - RISE_PAD * 2));
  let d = `M${x(points[0], 0)} ${y(vals[0])}`;
  for (let i = 1; i < points.length; i++) d += `H${x(points[i], i)}V${y(vals[i])}`;
  return d + `H${RISE_W}`;
}

/* Значение ряда словами владельца: у параметра — через fmtParam
   (time читается как 23:30), у остальных — числом */
function riseValue(it, v) {
  return it.type === 'param' ? fmtParam(it, v) : String(v);
}

function riseBlocks() {
  let h = '';
  // упражнения идут после пунктов и по тем же правилам: у них та же
  // история нагрузки, что и планка у пункта (задача 16D)
  for (const it of store.items.concat(store.exercises)) {
    const s = riseSeries(it);
    if (!s) continue;
    const a = s.points[0].value, b = s.points[s.points.length - 1].value;
    const label = s.kind === 'ladder'
      ? `Ступень ${a} → ${b}`
      : `${riseValue(it, a)} → ${riseValue(it, b)}${it.type !== 'param' && it.unit ? ' ' + it.unit : ''}`;
    h += `
      <div class="rise-b">
        <p class="rise-h"><span class="rise-n">${esc(it.name)}</span><span class="rise-v">${esc(label)}</span></p>
        <svg class="rise" viewBox="0 0 ${RISE_W} ${RISE_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="${risePath(s.points)}"/></svg>
      </div>`;
  }
  return h;
}

/* Цепь дней: 8 календарных недель, строка — неделя, ячейка — день.
   Три состояния (задача 17): доля ≥ порога — заливка --accent, доля
   между нулём и порогом — контур --accent, ноль — пустая ячейка.
   --chain здесь не участвует: тёплый тон закреплён за связкой блока,
   сетка дней — про выполнение. Будущие дни текущей недели и дни до
   начала эпохи не рисуются. */
function chainGrid() {
  const t = todayKey();
  const since = store.settings.calendarSince;
  const weeks = chainWeeks(8);
  const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  let cells = '';
  let drawn = 0; // ячеек с отметками: пустая цепь показывает свою строку
  const sr = [];
  for (const mon of weeks) {
    let hit = 0;
    for (let i = 0; i < 7; i++) {
      const k = addDays(mon, i);
      if (k > t) { cells += `<i class="cd fut"></i>`; continue; }
      if (isDayKey(since) && k < since) { cells += `<i class="cd pre"></i>`; continue; }
      const s = dayScore(k);
      const full = s !== null && s >= dayThreshold() - EPS;
      if (full) hit++;
      if (s) drawn++;
      cells += `<i class="cd${full ? ' full' : (s ? ' part' : '')}"></i>`;
    }
    sr.push(`Неделя с ${fmtShort(mon)}: зачтено ${hit} из 7`);
  }
  return `<p class="sr-only">${esc(sr.join('. '))}</p>` +
    `<div class="cdays" aria-hidden="true">` +
    names.map(d => `<span class="cd-head">${d}</span>`).join('') + cells + `</div>` +
    (drawn ? '' : `<p class="muted">Первые отметки появятся здесь.</p>`);
}

/* Блок «Прогресса» — карточка на --surface: заголовок и содержимое */
function pcard(title, body) {
  return `<section class="pcard"><h2>${title}</h2>${body}</section>`;
}

/* Полоса сегодняшнего дня под числом серии: заполнение — доля дня.
   Единственный градиент в приложении (задача 17, п. 4.4). */
function dayBar() {
  const t = todayKey();
  const m = minDayMarks(t);
  if (!m.total) return ''; // нечего измерять — полосы нет, как и на «Сегодня»
  const pct = Math.round(m.done / m.total * 100);
  const closed = m.done === m.total;
  return `
    <div class="dbar" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <p class="muted dbar-note">${closed ? 'День закрыт' : `${m.done} из ${m.total} сегодня`}</p>`;
}

function renderProgress() {
  const t = todayKey();
  ui.renderedDayKey = t;
  const since = store.settings.calendarSince;
  const days = daysInSystem();
  const streak = dayStreak();
  const best = bestStreak();

  let h = `
    <header class="page">
      <p class="overline">Накопленное</p>
      <h1>Прогресс</h1>
    </header>`;

  // 1. В системе — счёт, который не прерывается никогда
  h += pcard('В системе',
    `<p class="stat">${days} ${plural(days, 'день', 'дня', 'дней')}</p>` +
    (isDayKey(since)
      ? `<p class="muted">${days ? 'с ' + esc(fmtDay(since)) : `Отсчёт идёт с ${esc(fmtDay(since))}.`}</p>`
      : ''));

  // 2. Серия — число, рекорд справа, полоса сегодняшнего дня под ним
  h += pcard('Серия',
    `<p class="statrow">
      <span class="stat">${streak} ${plural(streak, 'день', 'дня', 'дней')}</span>
      ${best ? `<span class="muted rec">рекорд ${best} ${plural(best, 'день', 'дня', 'дней')}</span>` : ''}
    </p>` + dayBar() +
    (streak || best
      // правда о правиле, а не приблизительная (задача 19, C.7.1): прощается
      // пропуск, если предыдущий прощённый был БОЛЬШЕ недели назад; ровно
      // через неделю — уже обрыв. «Раз в неделю» звучало мягче, чем работает.
      ? `<p class="muted">Пропуск прощается, если прошлый был больше недели назад. Иначе счёт начинается заново.</p>`
      : `<p class="muted">Серия начнётся с первого зачтённого дня.</p>`));

  h += pcard('Цепь дней', chainGrid());

  const rise = riseBlocks();
  h += pcard('Подъём', rise || `<p class="muted">Появится, когда планка изменится во второй раз.</p>`);

  const inOrder = area => groupedItems(activeDaily().filter(i => i.area === area))
    .reduce((acc, sec) => acc.concat(sec.items), []);
  const listed = inOrder('min').concat(inOrder('habit'));
  let marks = '';
  for (const it of listed) {
    marks += `<p class="line muted">${esc(it.name)} · ${marksInSystem(it)} из ${marksWindow(it)}</p>`;
  }
  h += pcard('Отметки', marks || `<p class="muted">Пунктов пока нет.</p>`);

  h += reviewDue()
    ? `<button class="banner rev" data-act="goto-review"><span>Разбор недели</span><span class="chev" aria-hidden="true">&rsaquo;</span></button>`
    : `<p class="muted rev">Следующий разбор — в понедельник</p>`;

  // последней строкой — выписка дня; выписок нет — строки нет
  const q = quoteOfDay();
  if (q) {
    h += `<p class="quote">&laquo;${esc(q.text)}&raquo;</p>`;
    if (q.source) h += `<p class="qsrc">${esc(q.source)}</p>`;
  }

  el('scr-progress').innerHTML = h;
}

/* ── Лист «Тренировка» (задача 16D) ────────────────────────────
   Открывается кнопкой «+» недельного счётчика вместо немедленного
   инкремента: сначала записывается, что сделано, потом растёт счёт.
   «Отмена» не пишет ничего. */
function renderTrain() {
  const w = store.items.find(i => i.id === ui.trainId);
  let h = `
    <header class="page">
      <p class="overline">${esc(w ? w.name : 'Тренировка')}</p>
      <h1>Тренировка</h1>
    </header>`;

  const list = activeExercises();
  if (!list.length) {
    h += `<p class="muted">Упражнений пока нет — добавить можно в «Настройках».</p>`;
  }
  for (const ex of list) {
    const v = (typeof ex.value === 'number' && isFinite(ex.value)) ? String(ex.value) : '';
    h += `
      <div class="exline">
        <span class="txt">
          <span class="tname">${esc(ex.name)}</span>
          ${ex.unit ? `<span class="note">${esc(ex.unit)}</span>` : ''}
        </span>
        <span class="exctl">
          <button class="btn icon quiet" data-act="ex-step" data-id="${esc(ex.id)}" data-dir="down" aria-label="меньше: «${esc(ex.name)}»">&minus;</button>
          <input class="num" id="ex-${esc(ex.id)}" type="text" inputmode="decimal" value="${esc(v)}" aria-label="${esc(ex.name)}">
          <button class="btn icon quiet" data-act="ex-step" data-id="${esc(ex.id)}" data-dir="up" aria-label="больше: «${esc(ex.name)}»">+</button>
        </span>
      </div>`;
  }

  h += `
    <label class="field">
      <span>Заметка</span>
      <input type="text" id="tr-note" value="${esc(ui.trainNote)}" placeholder="необязательно">
    </label>
    <button class="btn primary wide" data-act="train-save">Записать</button>
    <button class="btn wide" data-act="train-cancel">Отмена</button>`;

  el('scr-train').innerHTML = h;
}

/* Экран 4 — «Заметки» (инвариант 16): список от новых к старым, тап по
   карточке открывает правку. Ни поиска, ни тегов, ни форматирования. */
function noteForm(n) {
  const id = n ? n.id : 'new';
  // вид записи задаётся при создании: у правки он берётся из самой записи
  const quote = n ? n.kind === 'quote' : ui.noteKind === 'quote';
  return `
    <div class="card form" data-form="note" data-id="${esc(id)}">
      <label class="field"><span>${quote ? 'Выписка' : 'Заметка'}</span>
        <textarea id="n-text" rows="6">${esc(n ? n.text : '')}</textarea></label>
      ${quote ? `<label class="field"><span>Источник</span>
        <input type="text" id="n-source" value="${esc(n ? n.source : '')}" placeholder="необязательно"></label>` : ''}
      <div class="btns">
        <button class="btn primary" data-act="note-save" data-id="${esc(id)}">Сохранить</button>
        <button class="btn quiet" data-act="note-cancel">Отмена</button>
        ${n ? `<button class="btn quiet" data-act="note-del" data-id="${esc(n.id)}">${ui.noteDelete === n.id ? 'Подтвердить удаление' : 'Удалить'}</button>` : ''}
      </div>
    </div>`;
}

function renderNotes() {
  snapshotOpenForm();
  let h = `
    <header class="page">
      <p class="overline">Своими словами</p>
      <h1>Заметки</h1>
    </header>`;
  if (ui.savedFlash) { // тихое подтверждение сохранения, как в «Настройках»
    h += `<p class="flash" role="status">Сохранено</p>`;
    ui.savedFlash = false;
  }

  h += ui.noteAdd
    ? noteForm(null)
    : `<div class="nadd">
        <button class="btn" data-act="note-add-open" data-kind="note">Новая заметка</button>
        <button class="btn" data-act="note-add-open" data-kind="quote">Новая выписка</button>
      </div>`;

  const list = notesByDate();
  if (!list.length && !ui.noteAdd) h += `<p class="muted">Пока пусто</p>`;
  for (const n of list) {
    const quote = n.kind === 'quote';
    h += ui.noteEditingId === n.id
      ? noteForm(n)
      : `
      <button type="button" class="card note" data-act="note-open" data-id="${esc(n.id)}">
        <span class="ndate">${esc(fmtDay(n.date))}</span>
        <span class="ntext">${quote ? '&laquo;' + esc(n.text) + '&raquo;' : esc(n.text)}</span>
        ${quote && n.source ? `<span class="nsrc">${esc(n.source)}</span>` : ''}
      </button>`;
  }

  el('scr-notes').innerHTML = h;
  restoreOpenForm();
  armFlash();
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
    note.innerHTML = closed ? 'День закрыт' : `<b>${done}</b>&nbsp;из&nbsp;${total}`;
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
    note.innerHTML = allDone ? 'Все отмечены' : `сегодня <b>${done}</b>&nbsp;из&nbsp;${total}`;
  }
}

/* Точечное обновление полосы недели привычки: сегодняшняя ячейка и «X из N».
   Серия не пересчитывается — текущая неделя в неё не входит (инвариант 11). */
function updateHabitWeekRow(input) {
  const wrap = input.closest('.rowwrap');
  if (!wrap) return;
  const t = todayKey();
  const cell = wrap.querySelector('.hstrip i.today');
  if (cell) { cell.classList.toggle('on', isMarked(t, input.dataset.id)); tapPop(cell); } // scale-отклик ячейки (12.1)
  const hc = wrap.querySelector('.hcount');
  const it = store.items.find(x => x.id === input.dataset.id);
  if (hc && it) hc.textContent = `${habitWeekCount(it, weekStartOf(t))} из ${it.normPerWeek || 7}`;
}

/* Точечная отметка: обновляется планка того экрана, где стоит чекбокс.
   Линия блока постоянна и от отметок не зависит — пересчитывать нечего. */
function updateTodayMark(input) {
  const on = isMarked(todayKey(), input.dataset.id);
  input.checked = on;
  const label = input.closest('label.check');
  if (label) { label.classList.toggle('on', on); tapPop(label.querySelector('.box')); } // scale-отклик круга (12.1)
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

/* ── Лист детали пункта (инвариант 12) ─────────────────────────
   Экран поверх вкладки: формула, лестница и их формы. Закрывается
   «Готово» — возврат на прежнюю вкладку с прежним скроллом. */

/* Четыре закона: порядок секций, поля и подписи полей */
const FORMULA_GROUPS = [
  { law: 'Очевидно', fields: [['anchor', 'Якорь'], ['when', 'Время и место']] },
  { law: 'Привлекательно', fields: [['pair', 'Сразу после'], ['identity', 'Кем становлюсь']] },
  { law: 'Легко', fields: [['twoMin', 'Версия на 2 минуты'], ['friction', 'Что уберу с пути']] },
  { law: 'Приятно', fields: [['proof', 'Что подтвердит день']] }
];

/* Те же четыре закона для режима «избавляюсь от привычки» (задача 20).
   Ключи полей — те же семь: меняются только заголовки законов и подписи,
   поэтому текст, введённый в одном режиме, виден и в другом. */
const FORMULA_GROUPS_BREAK = [
  { law: 'Невидимо', fields: [['anchor', 'Что перехватываю'], ['when', 'Время и место']] },
  { law: 'Непривлекательно', fields: [['pair', 'Что я на самом деле получаю'], ['identity', 'Кем становлюсь']] },
  { law: 'Трудно', fields: [['twoMin', 'Действие-замена'], ['friction', 'Что поставлю на пути']] },
  { law: 'Приятно', fields: [['proof', 'Что подтвердит день']] }
];

/* Подсказки по заполнению — только в форме (анти-требование задачи 14) */
const FORMULA_HINTS = {
  anchor: 'То, что уже происходит каждый день само. „После того как поставлю телефон на зарядку“ — якорь. „Вечером“ — не якорь.',
  when: 'Одно время, одно место. Чем конкретнее, тем меньше решений вечером.',
  pair: 'Что приятного идёт следом, чтобы вечер не был про запрет. Не еда и не покупка.',
  identity: 'От лица человека, а не результата. Не „хочу высыпаться“, а „я человек, который ложится вовремя“. Каждая отметка — голос за это.',
  twoMin: 'Урежь до того, что стыдно не сделать. Не „уснуть в 23:30“, а „в 23:30 быть в кровати“. Уснуть — не твоё дело, лечь — твоё.',
  friction: 'Одно физическое препятствие. Зарядка в коридоре работает сильнее любого намерения.',
  proof: 'Одно наблюдаемое действие, не ощущение. Отметка в приложении уже считается — допиши, если нужно ещё.'
};

/* Подсказки режима «избавляюсь»: приложение по-прежнему фиксирует только
   сделанное — отметка ставится за действие-замену (twoMin), а не за
   воздержание: отсутствие события отметить нельзя (инвариант 12). */
const FORMULA_HINTS_BREAK = {
  anchor: 'Назови момент, а не состояние. „Когда нервничаю“ — не момент. „Когда рука пошла ко рту“ — момент, его можно заметить.',
  when: 'Где и когда это обычно случается. Знаешь опасную зону — можешь менять обстановку именно там.',
  pair: 'Не абстрактный вред, а конкретное последствие с прошлой недели. Награда приходит сразу, расплата потом — записанная цена подтягивает расплату ближе.',
  identity: '„Я бросаю“ — человек, который борется. „Я не грызу“ — человек, который не грызёт. Разные предложения, разный результат.',
  twoMin: 'За это будет ставиться отметка. Короткое, физическое, выполнимое прямо в момент срыва. Не „взять себя в руки“, а конкретное движение.',
  friction: 'Физическая преграда, не намерение. Каждая лишняя секунда между желанием и действием — секунда, чтобы опомниться. Преграда должна работать, когда ты устал.',
  proof: 'Наблюдаемый результат, а не „не сорвался“. Целая кожа. Пустой список желаний. Баланс не изменился.'
};

/* Наборы по режиму: ключи полей общие, расходятся только слова */
const formulaGroups = mode => mode === 'break' ? FORMULA_GROUPS_BREAK : FORMULA_GROUPS;
const formulaHints = mode => mode === 'break' ? FORMULA_HINTS_BREAK : FORMULA_HINTS;

/* Два режима для переключателя формы: подписи — словами владельца */
const FORMULA_MODES = [['build', 'Завожу привычку'], ['break', 'Избавляюсь от привычки']];

/* Стартовый текст лестницы: только предзаполнение формы, в migrate не сеется */
const LADDER_START = [
  'В 23:30 быть в кровати. Телефон — на зарядке вне спальни.',
  '+ 10 минут без экрана до отбоя.',
  '+ отбой на 15 минут раньше.',
  '+ вечерний ритуал 10 минут: свет приглушён, душ или растяжка.',
  '+ подъём в одно время, включая выходные.'
].join('\n');

/* Журнал шагов типографской строкой по образцу barHistory: «Ступень: 1 → 2
   → 3 · с <дата>». Показываются последние 6 переходов (более ранние — «…»),
   дата — первой записи журнала: она отмечает начало пути целиком, а не
   начало показанного отрезка. Без записей строки нет; только в листе. */
function ladderHistory(it) {
  if (!Array.isArray(it.ladderLog) || !it.ladderLog.length) return '';
  const nums = it.ladderLog.map(e => String(e.step + 1)); // ступени человеку — с единицы
  const shown = nums.length > 6 ? ['…'].concat(nums.slice(-6)) : nums;
  return `<p class="lhist">Ступень: ${shown.map(esc).join(' → ')} · с ${esc(fmtShort(it.ladderLog[0].date))}</p>`;
}

function renderDetail(it) {
  snapshotOpenForm();
  const meta = [valUnit(it), (it.group || '').trim()].filter(Boolean).join(' · ');
  let h = `
    <header class="page">
      <h1 class="dtitle">${esc(it.name)}</h1>
      ${meta ? `<p class="muted">${esc(meta)}</p>` : ''}
      ${it.note ? `<p class="muted">${esc(it.note)}</p>` : ''}
    </header>`;

  const L = it.ladder;
  if (L) {
    h += `<h2>Лестница</h2>`;
    h += `<ol class="ladder">` + L.steps.map((s, i) =>
      `<li${i === L.step ? ' class="cur"' : ''}>${esc(s)}${i === L.step ? `<span class="sr-only"> — текущая ступень</span>` : ''}</li>`).join('') + `</ol>`;
    h += `
      <div class="btns">
        <button class="btn primary" data-act="ladder-fwd" data-id="${esc(it.id)}"${canStepForward(it) ? '' : ' disabled'}>Шагнуть</button>
        <button class="btn quiet" data-act="ladder-back" data-id="${esc(it.id)}"${canStepBack(it) ? '' : ' disabled'}>Назад</button>
      </div>
      <p class="muted">${esc(ladderStatus(it))}</p>${ladderHistory(it)}`;
  }

  // форма формулы правит те же поля — читаемый список на это время уступает ей место
  h += `<h2>Формула</h2>`;
  if (ui.detailForm === 'formula') {
    h += formulaForm(it);
  } else {
    const F = it.formula;
    // режим виден заголовками законов — отдельной пометки нет (задача 20, A.2.3)
    for (const g of formulaGroups(formulaMode(F))) {
      h += `<p class="overline">${g.law}</p>`;
      for (const [key, label] of g.fields) {
        const v = F && F[key] ? F[key] : '';
        h += `<p class="fline"><span class="fkey">${label}</span>` +
          (v ? `<span class="fval">${esc(v)}</span>` : `<span class="fval empty">— не заполнено</span>`) + `</p>`;
      }
    }
    h += `<div class="btns"><button class="btn quiet" data-act="formula-open" data-id="${esc(it.id)}">Изменить</button></div>`;
  }

  h += ui.detailForm === 'ladder'
    ? ladderForm(it)
    : `<div class="btns dfoot"><button class="btn quiet" data-act="ladder-open" data-id="${esc(it.id)}">Настроить лестницу</button></div>`;

  h += `<button class="btn primary wide" data-act="detail-done">Готово</button>`;

  el('scr-detail').innerHTML = h;
  restoreOpenForm();
}

function formulaForm(it) {
  const F = it.formula || {};
  // режим открытой формы: черновик ui, пока не сохранили; иначе — режим формулы
  const mode = ui.formulaMode || formulaMode(it.formula);
  const hints = formulaHints(mode);
  let h = `<div class="card form formula" data-form="formula" data-id="${esc(it.id)}">`;
  // переключатель первой строкой; идиома существующая — тот же select, что у
  // «Типа» и «Вида». data-act отдаёт его ui-состоянию: в черновик формы он не
  // попадает (snapshotOpenForm пропускает управляемые контролы).
  h += `
      <label class="field"><span>Режим</span>
        <select id="fx-mode" data-act="formula-mode">${FORMULA_MODES.map(([v, label]) =>
          `<option value="${v}"${v === mode ? ' selected' : ''}>${label}</option>`).join('')}</select></label>`;
  for (const g of formulaGroups(mode)) {
    h += `<p class="overline">${g.law}</p>`;
    for (const [key, label] of g.fields) {
      h += `
      <label class="field"><span>${label}</span><input type="text" id="fx-${key}" value="${esc(F[key] || '')}"></label>
      <p class="hint">${esc(hints[key])}</p>`;
    }
  }
  return h + `
      <div class="btns">
        <button class="btn primary" data-act="formula-save" data-id="${esc(it.id)}">Сохранить</button>
        <button class="btn quiet" data-act="formula-cancel">Отмена</button>
      </div>
    </div>`;
}

function ladderForm(it) {
  const busy = ladderBlockedBy(it); // слот занят другим пунктом
  const text = it.ladder ? it.ladder.steps.join('\n') : (busy ? '' : LADDER_START);
  return `
    <div class="card form ladder-form" data-form="ladder" data-id="${esc(it.id)}">
      ${busy ? `<p class="muted">Лестница уже есть у пункта «${esc(busy.name)}». Снимите её там, чтобы начать здесь.</p>` : ''}
      <label class="field"><span>Ступени — по одной на строку</span>
        <textarea id="fx-steps" rows="6"${busy ? ' disabled' : ''}>${esc(text)}</textarea></label>
      <div class="btns">
        <button class="btn primary" data-act="ladder-save" data-id="${esc(it.id)}"${busy ? ' disabled' : ''}>Сохранить</button>
        <button class="btn quiet" data-act="ladder-cancel">Отмена</button>
        ${it.ladder ? `<button class="btn quiet" data-act="ladder-clear" data-id="${esc(it.id)}">${ui.ladderConfirm ? 'Подтвердить снятие' : 'Снять лестницу'}</button>` : ''}
      </div>
    </div>`;
}

/* Лист «Разбор недели»: открывается баннером «Сегодня» и строкой
   «Прогресса», возвращает на прежнюю вкладку (задача 16B) */
const REVIEW_DONE = `<button class="btn wide" data-act="review-done">Готово</button>`;

function renderReview() {
  let h = `<header class="page"><p class="overline">Раз в неделю</p><h1>Разбор недели</h1></header>`;

  if (!reviewDue()) {
    if (ui.justClosed) h += `<p class="lead" role="status">Неделя закрыта.</p>`;
    const cur = currentWeekStart();
    if (!cur) {
      // Эпоха ещё не наступила: переходные дни скользящей эпохи — и чистый
      // лист (задача 16.1: чистка ставит calendarSince в ближайший
      // понедельник, то есть в будущее во все дни, кроме понедельника).
      // fmtDay (полный месяц) — дата умещается целиком, без «сент..» (отделка, задача 13)
      h += `<p class="muted">Разбор откроется в понедельник, ${esc(fmtDay(addDays(store.settings.calendarSince, 7)))}.</p>`;
    } else {
      h += `<p class="muted">Идёт ${diffDays(todayKey(), cur) + 1}-й день недели. Разбор откроется в понедельник, ${esc(fmtDay(addDays(cur, 7)))}.</p>`;
    }
    const ocWait = currentOneChange();
    if (ocWait) h += `<p class="muted">Изменение этой недели: „${esc(ocWait)}“</p>`;
    h += REVIEW_DONE;
    el('scr-review').innerHTML = h;
    ui.justClosed = false; // «Неделя закрыта.» показывается ровно один раз
    return;
  }

  const keys = windowKeys();
  const inWeek = it => it.active || keys.some(k => isMarked(k, it.id));
  const minItems = store.items.filter(it => it.type === 'daily' && it.area === 'min' && inWeek(it));
  const habitItems = store.items.filter(it => it.type === 'daily' && it.area === 'habit' && inWeek(it));

  h += `<p class="muted">Неделя ${esc(fmtShort(keys[0]))} — ${esc(fmtShort(keys[6]))}</p>`;
  // одна строка итога вместо чтения сетки: закрытых дней минимума за неделю
  h += `<p class="lead">Минимум закрыт ${keys.filter(k => minDayClosed(k)).length} из 7 дней</p>`;

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

  // Консистентность за 3 последние ЗАВЕРШЁННЫЕ календарные недели.
  // Заголовок «Три закрытые недели» стоял над тремя последними РАЗБОРАМИ,
  // которые после пропусков относились к несмежным и не последним неделям
  // (аудит, находка 13). Теперь счёт по days{} — заголовок стал правдой.
  const consist = (items) => {
    const W = closedWeeks(3);
    if (!W.length) return `<p class="muted">Закрытых недель пока нет.</p>`;
    let c = `<div class="consist">`;
    for (const it of items) {
      const counts = W.map(w => itemWeekCount(it, w));
      c += `<span class="c-name">${esc(it.name)}</span><span class="c-val">${counts.map(x => esc(x)).join(' · ')} из 7</span>`;
    }
    return c + `</div>`;
  };

  // ── Решение 1: планка. Повышение и понижение — карточки, больше
  // ничего; если предложений нет, решение сводится к одной строке.
  h += `<h2>Решение 1 · Планка</h2>`;
  let bar = '';
  for (const it of minItems) {
    if (!raiseEligible(it)) continue;
    const sug = raiseSuggest(it.value);
    const editing = ui.raiseEdit[it.id];
    bar += `
      <div class="card raise" data-raise="${esc(it.id)}">
        <p>${esc(it.name)}: три недели подряд не меньше 6 из 7.</p>
        <p class="raise-line">Повысить ${esc(String(it.value))} →
          ${editing
            ? `<input class="num" id="raise-${esc(it.id)}" type="text" inputmode="decimal" value="${esc(String(sug))}" aria-label="новая планка: «${esc(it.name)}»${it.unit ? ', ' + esc(it.unit) : ''}">`
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
  const lowW = closedWeeks(2);
  for (const it of minItems) {
    if (!lowerEligible(it)) continue;
    const to = lowerSuggest(it.value);
    const counts = lowW.map(w => itemWeekCount(it, w)).join(' и ');
    bar += `
      <div class="card lower" data-lower="${esc(it.id)}">
        <p>Сделать легче</p>
        <p class="muted">${esc(it.name)} — ${counts} из 7 за две недели</p>
        <div class="btns">
          ${to === null ? '' : `<button class="btn" data-act="lower-ok" data-id="${esc(it.id)}">Сделать легче ${esc(String(it.value))} → ${esc(String(to))}${it.unit ? ' ' + esc(it.unit) : ''}</button>`}
          <button class="btn quiet" data-act="lower-keep" data-id="${esc(it.id)}">Оставить</button>
        </div>
      </div>`;
  }
  h += bar || `<p class="muted">Планка держится, менять нечего</p>`;

  // ── Решение 2: ступень. Кнопки — только когда шаг доступен; иначе
  // та же строка состояния, что в листе детали.
  h += `<h2>Решение 2 · Ступень</h2>`;
  const L = activeLadderItem();
  if (!L) {
    h += `<p class="muted">Лестницы сейчас нет</p>`;
  } else if (canStepForward(L) && !ui.ladderStay) {
    const ld = L.ladder;
    h += `
      <div class="card step" data-step="${esc(L.id)}">
        <p>${esc(L.name)}: ${esc(ld.steps[ld.step])}</p>
        <p class="muted">Следующая ступень: ${esc(ld.steps[ld.step + 1])}</p>
        <div class="btns">
          <button class="btn" data-act="ladder-fwd" data-id="${esc(L.id)}">Шагнуть</button>
          <button class="btn quiet" data-act="ladder-stay">Остаться</button>
        </div>
      </div>`;
  } else {
    h += `<p class="muted">${esc(L.name)} · ${esc(ladderStatus(L))}</p>`;
  }

  // ── Решение 3: одно изменение на следующую неделю
  h += `<h2>Решение 3 · Одно изменение</h2>`;
  const oc = currentOneChange();
  if (oc) h += `<p class="muted">Изменение этой недели: „${esc(oc)}“</p>`;
  h += `
    <label class="field">
      <span>Одно изменение на следующую неделю</span>
      <input type="text" data-bind="one-change" value="${esc(store.draftOneChange)}" placeholder="необязательно">
    </label>`;

  // ── Неделя целиком: сетки, счётчики, параметры и готовность — под
  // свёрткой. Решения выше не требуют её открывать.
  let wk = `<h2>Минимум</h2>`;
  wk += weekGrid(minItems);
  for (const w of store.items.filter(i => i.type === 'weekly' && i.active)) {
    // счёт разбираемой недели — тот же интервал, что уйдёт в срез closeWeek
    const n = store.weekLog.filter(e => e.itemId === w.id && e.date >= keys[0] && e.date <= keys[6]).length;
    wk += `<p class="line">${esc(w.name)}: ${n} из ${w.goal || 0}</p>`;
  }
  wk += `<h2>Три закрытые недели</h2>`;
  wk += consist(minItems);

  wk += `<h2>Привычки</h2>`;
  if (habitItems.length) {
    wk += weekGrid(habitItems);
    // норма и серия разбираемой недели: read-only справка, закрытие данных не меняет
    for (const hb of habitItems) {
      const x = habitWeekCount(hb, keys[0]);
      const norm = hb.normPerWeek || 7;
      // строка прерывания серии упразднена (задача 15): невыполненная неделя
      // сообщается счётом «x из normPerWeek» и молчанием, без тона и оценки
      const tail = x >= norm ? ` · серия ${habitStreakFrom(hb, keys[0])} нед` : '';
      wk += `<p class="muted">${esc(hb.name)}: ${x} из ${norm}${tail}</p>`;
    }
    wk += consist(habitItems);
  } else {
    wk += `<p class="muted">Привычек пока нет — добавить можно в «Пунктах».</p>`;
  }

  for (const p of store.items.filter(i => i.type === 'param' && i.active)) {
    const decided = paramDecision(p.id); // решение чужой недели карточку не гасит
    if (decided) {
      wk += `<p class="muted">${esc(p.name)}: ${decided.to === null
        ? `${esc(fmtParam(p, decided.from))}, без шага`
        : `${esc(fmtParam(p, decided.from))} → ${esc(fmtParam(p, decided.to))}`}</p>`;
    } else {
      wk += `
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
    wk += `<p class="muted">Привычки устойчивы 2 недели — можно добавить новую</p>`;
  }

  h += `
    <details class="sect week"${ui.weekOpen ? ' open' : ''}>
      <summary data-act="week-fold">Показать неделю<span class="chev" aria-hidden="true">&rsaquo;</span></summary>
      <div class="sect-b">${wk}</div>
    </details>`;

  h += `<button class="btn primary wide" data-act="close-week">Закрыть неделю</button>` + REVIEW_DONE;

  el('scr-review').innerHTML = h;
}

/* Экран 3 — «Пункты и настройки» */
/* Подсказки поля «Блок» — из списка блоков (инвариант 13): он же задаёт
   порядок на экранах, поэтому другого источника имён у формы нет */
function groupList() {
  return store.groups.map(g => g.name);
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
   поле и позиция каретки. Восстанавливается при каждом renderSettings,
   пока открыта та же форма. */
function currentFormKey() {
  if (ui.detailId !== null && ui.detailForm) return ui.detailForm + ':' + ui.detailId; // формы листа детали
  // форма заметки принадлежит своей вкладке: на других экранах ключ не её
  if (ui.tab === 'notes' && ui.detailId === null) {
    if (ui.noteAdd) return 'note:new';
    if (ui.noteEditingId !== null) return 'note:' + ui.noteEditingId;
  }
  if (ui.addOpen) return 'add';
  if (ui.editingId !== null) return 'edit:' + ui.editingId;
  return null;
}

/* Два слота черновика (задача 15, п. 6): формы листа детали и формы
   «Пунктов» больше не делят один. Иначе уход в лист стирал бы начатую
   правку названия, а возврат — черновик формы листа. */
const isDetailKey = key => key.startsWith('formula:') || key.startsWith('ladder:');
const isNoteKey = key => key.startsWith('note:');
const draftSlot = key => (isDetailKey(key) ? 'detailDraft' : (isNoteKey(key) ? 'noteDraft' : 'formDraft'));
/* Экран, на котором живёт форма ключа: снимок ищет её именно там */
const formScope = key => (isDetailKey(key) ? '#scr-detail' : (isNoteKey(key) ? '#scr-notes' : '#scr-settings'));

function snapshotOpenForm() {
  const key = currentFormKey();
  if (!key) return; // ничего не открыто — оба слота живут до смены своей формы
  const slot = draftSlot(key);
  // форма ищется на том экране, которому принадлежит ключ: лист открывается
  // поверх «Пунктов», где форма правки остаётся в DOM и стоит в разметке выше
  // формы блока черновиком не считаются — одно поле и один тап
  const form = document.querySelector(formScope(key) + ' .card.form:not([data-form="group-add"])');
  const domKey = form ? (form.dataset.form === 'add' ? 'add' : form.dataset.form + ':' + form.dataset.id) : null;
  if (domKey !== key) {
    if (ui[slot] && ui[slot].key !== key) ui[slot] = null; // открыли другую форму
    return;
  }
  const fields = {};
  for (const inp of form.querySelectorAll('input[id], select[id], textarea[id]')) {
    if (inp.dataset.act) continue; // управляемые ui-состоянием контролы (select типа) — не черновик
    fields[inp.id] = inp.value;
  }
  const ae = document.activeElement;
  const focus = (ae && form.contains(ae) && ae.id)
    ? { id: ae.id, start: ae.selectionStart ?? null, end: ae.selectionEnd ?? null }
    : null;
  const base = (ui[slot] && ui[slot].key === key) ? ui[slot].fields : null;
  ui[slot] = { key, fields: Object.assign({}, base, fields), focus };
}

function restoreOpenForm() {
  const key = currentFormKey();
  if (!key) return;
  const draft = ui[draftSlot(key)];
  if (!draft || draft.key !== key) return;
  for (const [fid, v] of Object.entries(draft.fields)) {
    const inp = el(fid);
    if (inp) inp.value = v;
  }
  const f = draft.focus;
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

/* Редактор блоков: строка — имя и стрелки, правка раскрывается тапом по
   имени (механика формы правки пункта). Перетаскивание — отдельная задача. */
function groupEditor() {
  let h = '';
  if (!store.groups.length) {
    h += `<p class="muted">Блоков пока нет — пункты идут одним списком.</p>`;
  }
  store.groups.forEach((g, i) => {
    h += `
      <div class="rowwrap drag-row" data-drag="group" data-drag-id="${esc(g.name)}">
        <div class="row item">
          <button class="itxt" data-act="group-open" data-name="${esc(g.name)}" aria-label="изменить «${esc(g.name)}»">
            <span class="tname">${esc(g.name)}</span>
          </button>
          <span class="ictl">
            <button class="btn icon quiet" data-act="group-up" data-name="${esc(g.name)}"${i === 0 ? ' disabled' : ''} aria-label="выше: «${esc(g.name)}»">&uarr;</button>
            <button class="btn icon quiet" data-act="group-down" data-name="${esc(g.name)}"${i === store.groups.length - 1 ? ' disabled' : ''} aria-label="ниже: «${esc(g.name)}»">&darr;</button>
          </span>
        </div>
        ${ui.groupRename === g.name ? `
        <div class="card form" data-form="group-edit" data-id="${esc(g.name)}">
          <label class="field"><span>Название</span><input type="text" id="g-name" value="${esc(g.name)}"></label>
          <div class="btns">
            <button class="btn primary" data-act="group-save" data-name="${esc(g.name)}">Сохранить</button>
            <button class="btn quiet" data-act="group-cancel">Отмена</button>
            <button class="btn quiet" data-act="group-del" data-name="${esc(g.name)}">${ui.groupDelete === g.name ? 'Подтвердить удаление' : 'Удалить'}</button>
          </div>
        </div>` : ''}
      </div>`;
  });
  h += ui.groupAdd
    ? `<div class="card form" data-form="group-add">
        <label class="field"><span>Название блока</span><input type="text" id="g-add" placeholder="Например: Вечер"></label>
        <div class="btns">
          <button class="btn primary" data-act="group-add-save">Добавить</button>
          <button class="btn quiet" data-act="group-add-cancel">Отмена</button>
        </div>
      </div>`
    : `<button class="btn wide" data-act="group-add-open">Добавить блок</button>`;
  return h;
}

/* Редактор упражнений (задача 16D): та же механика, что у пунктов —
   строка с именем раскрывает правку, стрелки задают порядок, тумблер
   выключает. Нагрузку правит запись тренировки, не форма. */
function exerciseEditor() {
  let h = '';
  if (!store.exercises.length) {
    h += `<p class="muted">Упражнений пока нет.</p>`;
  }
  store.exercises.forEach((ex, i) => {
    const meta = [valUnit(ex)].filter(Boolean).join(' · ');
    h += `
      <div class="rowwrap drag-row${ex.active ? '' : ' off'}" data-drag="ex" data-drag-id="${esc(ex.id)}">
        <div class="row item">
          <button class="itxt" data-act="ex-open" data-id="${esc(ex.id)}" aria-label="изменить «${esc(ex.name)}»">
            <span class="tname">${esc(ex.name)}</span>
            ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
            ${barHistory(ex)}
          </button>
          <span class="ictl">
            <button class="btn icon quiet" data-act="ex-up" data-id="${esc(ex.id)}"${i === 0 ? ' disabled' : ''} aria-label="выше">&uarr;</button>
            <button class="btn icon quiet" data-act="ex-down" data-id="${esc(ex.id)}"${i === store.exercises.length - 1 ? ' disabled' : ''} aria-label="ниже">&darr;</button>
            <label class="switch" aria-label="включено: «${esc(ex.name)}»">
              <input type="checkbox" data-act="ex-active" data-id="${esc(ex.id)}"${ex.active ? ' checked' : ''}>
              <span></span>
            </label>
          </span>
        </div>
        ${ui.exEditingId === ex.id ? `
        <div class="card form" data-form="ex-edit" data-id="${esc(ex.id)}">
          <label class="field"><span>Название</span><input type="text" id="x-name" value="${esc(ex.name)}"></label>
          <label class="field"><span>Единица</span><input type="text" id="x-unit" value="${esc(ex.unit)}" placeholder="кг, повт."></label>
          <div class="btns">
            <button class="btn primary" data-act="ex-save" data-id="${esc(ex.id)}">Сохранить</button>
            <button class="btn quiet" data-act="ex-cancel">Отмена</button>
          </div>
        </div>` : ''}
      </div>`;
  });
  h += ui.exAddOpen
    ? `<div class="card form" data-form="ex-add">
        <label class="field"><span>Название</span><input type="text" id="x-add-name" placeholder="Например: Жим лёжа"></label>
        <label class="field"><span>Единица</span><input type="text" id="x-add-unit" placeholder="кг, повт."></label>
        <label class="field"><span>Рабочая нагрузка</span><input type="text" id="x-add-value" inputmode="decimal" placeholder="необязательно"></label>
        <div class="btns">
          <button class="btn primary" data-act="ex-add-save">Добавить</button>
          <button class="btn quiet" data-act="ex-add-cancel">Отмена</button>
        </div>
      </div>`
    : `<button class="btn wide" data-act="ex-add-open">Добавить упражнение</button>`;
  return h;
}

/* Сворачиваемая секция «Настроек» на нативном details: раскрытие —
   дело браузера, ui хранит только состояние, чтобы перерисовка после
   действия внутри секции её не захлопнула. */
function sect(key, title, body) {
  return `
    <details class="sect"${ui.settingsOpen[key] ? ' open' : ''}>
      <summary data-act="sect" data-sect="${key}">${title}<span class="chev" aria-hidden="true">&rsaquo;</span></summary>
      <div class="sect-b">${body}</div>
    </details>`;
}

/* Строка возврата — первой в «Данных», пока копия существует */
function restoreLine() {
  const c = wipedCopy();
  if (!c) return '';
  const st = c.stats || {};
  const when = (typeof c.wipedAt === 'number' && isFinite(c.wipedAt))
    ? fmtDay(dateKeyShift(new Date(c.wipedAt), store.settings.dayBoundary))
    : '';
  const n = Number(st.items) || 0;
  const d = Number(st.days) || 0;
  return `
    <div class="restore">
      <p class="muted">Стёрто${when ? ' ' + esc(when) : ''} · ${n} ${plural(n, 'пункт', 'пункта', 'пунктов')}, ${d} ${plural(d, 'день', 'дня', 'дней')} отметок</p>
      <div class="btns">
        <button class="btn" data-act="wipe-undo">Вернуть</button>
        <button class="btn quiet" data-act="wipe-drop">${ui.wipeDropConfirm ? 'Подтвердить: убрать копию' : 'Убрать копию'}</button>
      </div>
    </div>`;
}

/* «Начать с чистого листа» — внизу «Данных», отделено линией.
   Предупреждение перечисляет стираемое числами: решение принимается
   с открытыми глазами, а не по памяти. */
function wipeBlock() {
  if (!ui.wipeOpen) {
    return `<div class="danger"><button class="btn quiet" data-act="wipe-open">Начать с чистого листа</button></div>`;
  }
  const s = wipeStats(store);
  const line = [
    `${s.items} ${plural(s.items, 'пункт', 'пункта', 'пунктов')}`,
    `${s.groups} ${plural(s.groups, 'блок', 'блока', 'блоков')}`,
    `${s.days} ${plural(s.days, 'день', 'дня', 'дней')} отметок`,
    `${s.reviews} ${plural(s.reviews, 'разбор', 'разбора', 'разборов')}`,
    `${s.ladders} ${plural(s.ladders, 'лестница', 'лестницы', 'лестниц')}`,
    `${s.exercises} ${plural(s.exercises, 'упражнение', 'упражнения', 'упражнений')}`,
    `${s.sessions} ${plural(s.sessions, 'тренировка', 'тренировки', 'тренировок')}`,
    `${s.notes} ${plural(s.notes, 'заметка', 'заметки', 'заметок')}`
  ].join(', ');
  return `
    <div class="danger">
      <p class="lead">Начать с чистого листа</p>
      ${ui.wipeFailed ? `<p class="muted" role="status">Не удалось сохранить копию — чистка отменена</p>` : ''}
      <p class="muted">Будут стёрты: ${line}.</p>
      <p class="muted">Копия останется в приложении — вернуть можно, пока она не убрана.${wipedCopy() ? ' Прежняя копия будет заменена новой: хранится одна, последняя.' : ''}</p>
      <div class="btns">
        <button class="btn" data-act="export">Сначала скачать копию</button>
        <button class="btn quiet" data-act="wipe-do">${ui.wipeConfirm ? 'Подтвердить: стереть' : 'Стереть'}</button>
        <button class="btn quiet" data-act="wipe-cancel">Отмена</button>
      </div>
    </div>`;
}

/* Экран 5 — «Настройки»: секции по порядку (задачи 16B, 16D) */
function renderSettings() {
  snapshotOpenForm();
  let h = `<header class="page"><p class="overline">Устройство приложения</p><h1>Настройки</h1></header>`;
  if (ui.savedFlash) { // тихое подтверждение сохранения — гаснет само (CSS), показывается один раз
    h += `<p class="flash" role="status">Сохранено</p>`;
    ui.savedFlash = false;
  }

  h += sect('groups', 'Блоки', groupEditor());

  // две группы: минимум и привычки, у каждой своя кнопка добавления
  const groups = [
    ['Минимум', 'min', 'Добавить пункт'],
    ['Привычки', 'habit', 'Добавить привычку']
  ];
  let body = '';
  for (const [title, area, addLabel] of groups) {
    const items = store.items.filter(i => i.area === area);
    body += `<h2>${title}</h2>`;
    body += `<div class="list">`;
    items.forEach((it) => {
      const vu = it.type === 'param' ? `порог ${fmtParam(it)}` : valUnit(it);
      const meta = [vu, it.type === 'weekly' ? `цель ${it.goal || 0} / нед.` : '', (it.group || '').trim()]
        .filter(Boolean).join(' · ');
      body += `
      <div class="rowwrap drag-row${it.active ? '' : ' off'}" data-drag="item" data-drag-id="${esc(it.id)}" data-dgroup="${esc((it.group || '').trim())}">
        <div class="row item">
          <button class="itxt" data-act="edit-open" data-id="${esc(it.id)}" aria-label="изменить «${esc(it.name)}»">
            <span class="tname">${esc(it.name)}</span>
            ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
            ${it.note ? `<span class="note">${esc(it.note)}</span>` : ''}
            ${it.type === 'param' ? paramHistory(it) : barHistory(it)}
          </button>
          <span class="ictl">
            <button class="btn icon quiet" data-act="move-up" data-id="${esc(it.id)}"${canMoveItem(it.id, 'up') ? '' : ' disabled'} aria-label="выше">&uarr;</button>
            <button class="btn icon quiet" data-act="move-down" data-id="${esc(it.id)}"${canMoveItem(it.id, 'down') ? '' : ' disabled'} aria-label="ниже">&darr;</button>
            <label class="switch" aria-label="включён: «${esc(it.name)}»">
              <input type="checkbox" data-act="toggle-active" data-id="${esc(it.id)}"${it.active ? ' checked' : ''}>
              <span></span>
            </label>
          </span>
        </div>
        ${ui.editingId === it.id ? editForm(it) : ''}
      </div>`;
    });
    body += `</div>`;
    body += (ui.addOpen && ui.addArea === area)
      ? addForm()
      : `<button class="btn wide" data-act="add-open" data-area="${area}">${addLabel}</button>`;
  }

  // граница дня — механика самих пунктов, поэтому живёт в их секции
  const hours = [];
  for (let i = 0; i <= 8; i++) hours.push(`<option value="${i}"${store.settings.dayBoundary === i ? ' selected' : ''}>${pad2(i)}:00</option>`);
  body += `
    <h2>Граница дня</h2>
    <label class="field inline">
      <span>Смена дня в</span>
      <select data-act="boundary">${hours.join('')}</select>
    </label>
    <p class="muted">Отметки до этого часа относятся к предыдущему дню.</p>`;

  // порог зачёта дня (задача 17): «день зачтён» — доля, а не всё подряд.
  // Живёт рядом с границей дня: обе настройки — про то, как считается день.
  const th = dayThreshold();
  const total = minDayItems(todayKey()).length;
  body += `
    <h2>Зачёт дня</h2>
    <div class="field inline norm">
      <span>Отмечено не меньше <b>${Math.round(th * 100)}%</b></span>
      <span class="btns">
        <button type="button" class="btn icon quiet" data-act="thr-dec"${th <= THRESHOLD_MIN + EPS ? ' disabled' : ''} aria-label="ниже порог">&minus;</button>
        <button type="button" class="btn icon quiet" data-act="thr-inc"${th >= THRESHOLD_MAX - EPS ? ' disabled' : ''} aria-label="выше порог">+</button>
      </span>
    </div>` +
    (total ? `<p class="muted">День зачтён, если отмечено не меньше ${dayNeed(total)} из ${total}.</p>` : '');

  h += sect('items', 'Пункты', body);
  h += sect('exercises', 'Упражнения', exerciseEditor());

  const exp = (typeof store.settings.exportedAt === 'number' && isFinite(store.settings.exportedAt))
    // логический день — как в имени файла экспорта (инвариант 1)
    ? `Последний экспорт: ${esc(fmtShort(dateKeyShift(new Date(store.settings.exportedAt), store.settings.dayBoundary)))}`
    : 'Экспорта ещё не было';
  h += sect('data', 'Данные', restoreLine() + `
    <div class="btns">
      <button class="btn" data-act="export">Экспорт JSON</button>
      <button class="btn" data-act="import">Импорт JSON</button>
    </div>
    ${ui.importNote ? `<p class="muted" role="status">${esc(ui.importNote)}</p>` : ''}
    <p class="muted">${exp}</p>
    <p class="muted" id="mirror-note" hidden></p>
    <input type="file" id="import-file" accept="application/json,.json" hidden>
    <p class="muted">Все данные — на этом устройстве: рабочая копия и автоматическая резервная. Экспорт — способ сохранить их вне приложения.</p>
    <h2>Начало отсчёта</h2>
    <label class="field">
      <span>Первый день в системе</span>
      <input type="date" id="since" data-act="since" max="${esc(todayKey())}" value="${esc(isDayKey(store.settings.calendarSince) ? store.settings.calendarSince : '')}">
    </label>
    <p class="muted">Меняет счёт дней в системе, серию и доступность разбора. Отметки не затрагивает.</p>` + wipeBlock());

  h += sect('system', 'Система', systemSection());

  el('scr-settings').innerHTML = h;
  restoreOpenForm();
  armFlash();
  updateMirrorNote();
}

/* Строка «Резервная копия: …» — асинхронно и точечно после рендера
   «Пунктов»; при недоступном зеркале не показывается вовсе.
   Стартовое чтение не завершилось — так и сказано: не «ошибка» и не
   тревога, а честное «неизвестно» тем же muted (A.1.4). */
function updateMirrorNote() {
  const p = el('mirror-note');
  if (!p) return;
  if (mirrorUnverified) {
    p.textContent = 'Резервная копия не проверена';
    p.hidden = false;
    return;
  }
  if (typeof indexedDB === 'undefined') return;
  mirrorRead().then(snap => {
    if (!snap || typeof snap.savedAt !== 'number') return;
    p.textContent = 'Резервная копия: ' + fmtStamp(snap.savedAt);
    p.hidden = false;
  });
}

/* Поле «Блок» — выбор из заведённых (задача 17). Свободного ввода нет:
   опечатка заводила блок-двойник. «+ Новый блок…» всегда последний
   вариант — значение-маркер могло бы совпасть с именем блока, индекс
   не может; отсюда isNewGroupPick. */
const isNewGroupPick = sel => !!sel && sel.selectedIndex === sel.options.length - 1;

function groupField(idPrefix, value) {
  const cur = ui.groupPick !== null ? ui.groupPick : (value || '').trim();
  const names = groupList();
  let opts = `<option value=""${cur ? '' : ' selected'}>— без блока</option>`;
  for (const g of names) {
    opts += `<option value="${esc(g)}"${g === cur ? ' selected' : ''}>${esc(g)}</option>`;
  }
  // имя из импорта, которого нет в списке блоков: вариант виден и выбран,
  // чтобы правка формы не сбрасывала принадлежность молча (инвариант 13)
  if (cur && !names.includes(cur)) {
    opts += `<option value="${esc(cur)}" selected>${esc(cur)} (нет в списке)</option>`;
  }
  opts += `<option value=""${ui.groupNew ? ' selected' : ''}>+ Новый блок…</option>`;
  return `
    <label class="field"><span>Блок</span>
      <select id="${idPrefix}-group" data-act="group-pick">${opts}</select>
    </label>
    ${ui.groupNew ? `<label class="field"><span>Имя блока</span>
      <input type="text" id="${idPrefix}-gnew" placeholder="Например: Утро"></label>` : ''}`;
}

/* Значение поля «Блок» при сохранении формы: имя из списка либо новое
   имя из раскрытого поля. Пустое имя блока не заводит и принадлежность
   пункта не меняет — прежняя возвращается как fallback. */
function readGroupField(idPrefix, fallback) {
  const sel = el(idPrefix + '-group');
  if (!sel) return fallback;
  if (!isNewGroupPick(sel)) return sel.value;
  const inp = el(idPrefix + '-gnew');
  const name = inp ? inp.value.trim() : '';
  if (!name) return fallback;
  addGroup(name); // в конец списка (инвариант 13)
  return name;
}

function editForm(it) {
  const head = `
    <div class="card form" data-form="edit" data-id="${esc(it.id)}">
      <label class="field"><span>Название</span><input type="text" id="e-name" value="${esc(it.name)}"></label>
      <label class="field"><span>Подпись</span><input type="text" id="e-note" value="${esc(it.note || '')}" placeholder="необязательная строка под названием"></label>
      ${it.ladder ? `<p class="hint">Пока у пункта есть лестница, на дневных экранах вместо подписи показывается текущая ступень. Подпись видна в листе пункта.</p>` : ''}`;
  // вход в лист детали — из формы правки, а не из строки списка: кнопка в
  // строке сужала текстовую колонку и переносила длинные названия (14.2)
  const detail = it.type === 'daily'
    ? `<div class="btns dfoot"><button class="btn quiet" data-act="item-detail" data-id="${esc(it.id)}">Формула и лестница &rsaquo;</button></div>`
    : '';
  const foot = detail + `
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
      <label class="field"><span>Шаг (со знаком)</span><input class="num" type="text" inputmode="decimal" id="e-pstep" value="${esc(it.pstep)}"></label>
      ${groupField('e', it.group)}` + foot;
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
      </div>
      ${groupField('e', it.group)}` + foot;
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
      <label class="field"><span>Шаг (со знаком)</span><input class="num" type="text" inputmode="decimal" id="f-pstep" placeholder="-15"></label>` : ''}
      ${groupField('f', '')}` + foot;
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
/* Тексты «Системы» — секция «Настроек» (задача 16B), не отдельный экран */
function systemSection() {
  let h = '';
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
  return h;
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

/* Лист детали: открытие запоминает позицию вкладки, закрытие её возвращает */
function openDetail(id) {
  ui.detailScroll = window.scrollY || 0;
  ui.detailId = id;
  ui.detailForm = null;
  ui.ladderConfirm = false;
  ui.detailDraft = null;
  ui.missOpen = {}; // раскрытая подпись «вчера» принадлежит дневному экрану
  renderAll();
}

function closeDetail() {
  ui.detailId = null;
  ui.detailForm = null;
  ui.ladderConfirm = false;
  ui.detailDraft = null;
  ui.formulaMode = null;
}

/* Лист разбора закрывается и таб-баром — как лист детали */
function closeReview() {
  ui.reviewOpen = false;
  ui.reviewFrom = null;
}

function closeTrain() {
  ui.trainOpen = false;
  ui.trainId = null;
  ui.trainFrom = null;
  ui.trainNote = '';
}

/* ── Перетаскивание (задача 16F) ───────────────────────────────
   Pointer Events без библиотек. Захват — долгим нажатием (250 мс):
   до него любое движение считается скроллом. Соседи раздвигаются
   CSS-переходом (при reduced-motion — мгновенно, глобальный блок).
   Стрелки ↑↓ остаются: перетаскивание их не заменяет, а дополняет.
   Пункт двигается только среди соседей по блоку — как и стрелками. */

const DRAG_HOLD = 250;   // мс удержания до захвата
const DRAG_SLOP = 8;     // px до захвата: это скролл, а не перетаскивание
const DRAG_EDGE = 64;    // px от края экрана, где включается автоскролл
const DRAG_SPEED = 12;   // px за кадр автоскролла
const DRAG_OUT = 60;     // px вбок от списка — отмена

let drag = null;
let dragSuppressClick = false; // тап после перетаскивания не открывает форму
let dragClickTimer = null;     // страховка: флаг снимается, если клика не последовало

function dragSiblings(row) {
  const kind = row.dataset.drag;
  const g = row.dataset.dgroup;
  return [...row.parentElement.children].filter(n =>
    n.dataset && n.dataset.drag === kind && (kind !== 'item' || n.dataset.dgroup === g));
}

function dragDown(e) {
  if (drag || (typeof e.button === 'number' && e.button > 0)) return;
  const row = e.target.closest ? e.target.closest('[data-drag]') : null;
  if (!row) return;
  // стрелки, тумблер и открытая форма живут своей жизнью
  if (e.target.closest('.ictl, .card.form, input, textarea, select')) return;
  drag = {
    row, kind: row.dataset.drag, id: row.dataset.dragId || '',
    x: e.clientX, y: e.clientY, startY: e.clientY, startX: e.clientX,
    active: false, from: -1, to: -1, sibs: [], mids: [], h: 0, listRect: null,
    raf: null,
    timer: setTimeout(dragActivate, DRAG_HOLD)
  };
  document.addEventListener('pointermove', dragMove, { passive: false });
  document.addEventListener('pointerup', dragUp);
  document.addEventListener('pointercancel', dragStop);
  document.addEventListener('keydown', dragKey);
}

/* Захват: замер соседей в координатах документа — автоскролл во время
   перетаскивания не должен сбивать расчёт позиции */
function dragActivate() {
  if (!drag) return;
  const sc = window.scrollY || 0;
  drag.sibs = dragSiblings(drag.row);
  drag.from = drag.sibs.indexOf(drag.row);
  if (drag.sibs.length < 2 || drag.from < 0) { dragStop(); return; }
  drag.mids = drag.sibs.map(n => {
    const r = n.getBoundingClientRect();
    return r.top + r.height / 2 + sc;
  });
  const own = drag.row.getBoundingClientRect();
  drag.h = own.height || 56;
  // смещение центра строки относительно пальца в момент захвата
  drag.offset = drag.mids[drag.from] - (drag.y + sc);
  drag.listRect = drag.row.parentElement.getBoundingClientRect();
  drag.active = true;
  drag.to = drag.from;
  drag.row.classList.add('drag-live');
  document.body.classList.add('dragging');
  // iOS: скролл страницы во время перетаскивания глушится непассивным touchmove
  document.addEventListener('touchmove', dragTouch, { passive: false });
  dragFrame();
}

function dragTouch(e) { if (drag && drag.active) e.preventDefault(); }

/* Автоскролл у краёв экрана — отдельным кадром, чтобы работал и когда
   палец стоит на месте у края */
function dragFrame() {
  if (!drag || !drag.active) return;
  const vh = window.innerHeight || 812;
  let d = 0;
  if (drag.y < DRAG_EDGE) d = -DRAG_SPEED;
  else if (drag.y > vh - DRAG_EDGE) d = DRAG_SPEED;
  if (d) { window.scrollBy(0, d); dragApply(); }
  drag.raf = (window.requestAnimationFrame || setTimeout)(dragFrame, 16);
}

/* Положение перетаскиваемой строки и раздвижение соседей */
function dragApply() {
  if (!drag || !drag.active) return;
  const center = drag.y + (window.scrollY || 0) + drag.offset;
  let to = 0;
  drag.mids.forEach((m, k) => { if (k !== drag.from && m < center) to++; });
  drag.to = to;
  drag.row.style.transform = `translateY(${center - drag.mids[drag.from]}px) scale(1.03)`;
  drag.sibs.forEach((n, k) => {
    if (k === drag.from) return;
    let dy = 0;
    if (to > drag.from && k > drag.from && k <= to) dy = -drag.h;
    else if (to < drag.from && k >= to && k < drag.from) dy = drag.h;
    n.style.transform = dy ? `translateY(${dy}px)` : '';
  });
}

function dragMove(e) {
  if (!drag) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.active) {
    // движение до захвата — это скролл: удержание отменяется
    if (Math.abs(e.clientY - drag.startY) > DRAG_SLOP || Math.abs(e.clientX - drag.startX) > DRAG_SLOP) dragStop();
    return;
  }
  e.preventDefault();
  // уход пальца за пределы списка вбок — отмена без записи
  if (drag.listRect && (e.clientX < drag.listRect.left - DRAG_OUT || e.clientX > drag.listRect.right + DRAG_OUT)) {
    dragStop();
    return;
  }
  dragApply();
}

function dragKey(e) { if (e.key === 'Escape') dragStop(); } // отмена с клавиатуры

function dragUp() {
  if (!drag) return;
  const { active, kind, id, from, to } = drag;
  dragStop();
  if (!active || to === from || to < 0) return;
  const ok = kind === 'item' ? reorderItem(id, to)
    : kind === 'group' ? reorderGroup(id, to)
      : reorderExercise(id, to);
  if (ok) renderSettings(); // перестановка — структурное изменение
}

/* Снятие захвата: стили сняты, слушатели убраны, модель не тронута */
function dragStop() {
  if (!drag) return;
  clearTimeout(drag.timer);
  if (drag.raf !== null) (window.cancelAnimationFrame || clearTimeout)(drag.raf);
  if (drag.active) {
    dragSuppressClick = true;
    // клик приходит сразу за отпусканием пальца; если его не будет вовсе
    // (pointercancel, отмена с клавиатуры), флаг снимается сам и не глотает
    // следующий, уже не связанный с перетаскиванием тап (аудит, находка 29)
    clearTimeout(dragClickTimer);
    dragClickTimer = setTimeout(() => { dragSuppressClick = false; }, 300);
    drag.row.classList.remove('drag-live');
    drag.row.style.transform = '';
    drag.sibs.forEach(n => { n.style.transform = ''; });
    document.body.classList.remove('dragging');
    document.removeEventListener('touchmove', dragTouch);
  }
  document.removeEventListener('pointermove', dragMove);
  document.removeEventListener('pointerup', dragUp);
  document.removeEventListener('pointercancel', dragStop);
  document.removeEventListener('keydown', dragKey);
  drag = null;
}

function onClick(e) {
  // клик, родившийся из перетаскивания, форму не открывает
  if (dragSuppressClick) { dragSuppressClick = false; return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (syncDay()) return; // stale-экран: действие не применяется (инвариант 8)
  const hadImportNote = ui.importNote !== null;
  ui.importNote = null; // строка «Импортировано…» живёт до следующего действия
  const act = b.dataset.act;
  const id = b.dataset.id;
  const item = id ? store.items.find(i => i.id === id) : null;

  switch (act) {
    // разбор — лист поверх вкладки: помним, откуда открыт и с каким скроллом
    case 'goto-review':
      ui.missOpen = {}; // уход с дневного экрана — как в таб-баре
      ui.raiseEdit = {};
      ui.reviewScroll = window.scrollY || 0;
      ui.reviewFrom = ui.tab;
      ui.reviewOpen = true;
      renderAll();
      break;

    case 'review-done': {
      const back = ui.reviewFrom, y = ui.reviewScroll;
      ui.reviewOpen = false;
      ui.reviewFrom = null;
      if (back) ui.tab = back;
      renderAll();
      window.scrollTo(0, y); // прежняя вкладка с прежним скроллом
      break;
    }

    // сворачивание секции «Настроек»: раскрытие делает сам details,
    // здесь только запоминается состояние — перерисовка его не теряет
    case 'sect':
      if (b.dataset.sect in ui.settingsOpen) ui.settingsOpen[b.dataset.sect] = !ui.settingsOpen[b.dataset.sect];
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

    case 'item-detail':
      if (item && item.type === 'daily') openDetail(id);
      break;

    case 'detail-done': {
      const y = ui.detailScroll;
      closeDetail();
      renderAll();
      window.scrollTo(0, y); // прежняя вкладка с прежним скроллом
      break;
    }

    case 'ladder-fwd':
    case 'ladder-back':
      if (ladderStep(id, act === 'ladder-back' ? 'back' : 'fwd')) renderAll();
      break;

    case 'formula-open': ui.detailForm = 'formula'; ui.detailDraft = null; ui.formulaMode = null; renderAll(); break;
    case 'formula-cancel': ui.detailForm = null; ui.detailDraft = null; ui.formulaMode = null; renderAll(); break;
    case 'formula-save': {
      const values = {};
      for (const k of FORMULA_KEYS) values[k] = el('fx-' + k) ? el('fx-' + k).value : '';
      values.mode = ui.formulaMode || formulaMode(item && item.formula);
      setFormula(id, values);
      ui.detailForm = null;
      ui.detailDraft = null;
      ui.formulaMode = null;
      renderAll();
      break;
    }

    case 'ladder-open': ui.detailForm = 'ladder'; ui.ladderConfirm = false; ui.detailDraft = null; renderAll(); break;
    case 'ladder-cancel': ui.detailForm = null; ui.ladderConfirm = false; ui.detailDraft = null; renderAll(); break;
    case 'ladder-save': {
      setLadder(id, el('fx-steps') ? el('fx-steps').value : '');
      ui.detailForm = null;
      ui.ladderConfirm = false; // незавершённое подтверждение не переживает форму
      ui.detailDraft = null;
      renderAll();
      break;
    }
    case 'ladder-clear': {
      if (!ui.ladderConfirm) { ui.ladderConfirm = true; renderAll(); break; } // подтверждение вторым тапом
      clearLadder(id);
      ui.ladderConfirm = false;
      ui.detailForm = null;
      ui.detailDraft = null;
      renderAll();
      break;
    }

    // «+» открывает лист тренировки: сначала записывается, что сделано
    case 'train-inc':
      ui.trainScroll = window.scrollY || 0;
      ui.trainFrom = ui.tab;
      ui.trainId = id;
      ui.trainNote = '';
      ui.trainOpen = true;
      renderAll();
      break;

    case 'train-save': {
      const entries = activeExercises().map(ex => {
        const inp = el('ex-' + ex.id);
        return { exId: ex.id, value: inp ? parsePositive(inp.value) : null };
      });
      const note = el('tr-note') ? el('tr-note').value : '';
      const back = ui.trainFrom, y = ui.trainScroll, weekly = ui.trainId;
      recordSession(weekly, entries, note);
      closeTrain();
      if (back) ui.tab = back;
      renderAll();
      window.scrollTo(0, y);
      break;
    }

    case 'train-cancel': { // ничего не пишет
      const back = ui.trainFrom, y = ui.trainScroll;
      closeTrain();
      if (back) ui.tab = back;
      renderAll();
      window.scrollTo(0, y);
      break;
    }

    // шаг ±1 правит поле на месте: перерисовка листа сбросила бы соседние
    case 'ex-step': {
      const inp = el('ex-' + id);
      if (!inp) break;
      const cur = parseNum(inp.value);
      const next = (cur === null ? 0 : cur) + (b.dataset.dir === 'up' ? 1 : -1);
      inp.value = String(Math.max(0, Math.round(next * 100) / 100));
      break;
    }

    // заметки: форма новой и правка существующей взаимно исключают друг друга
    case 'note-add-open':
      ui.noteAdd = true;
      ui.noteKind = b.dataset.kind === 'quote' ? 'quote' : 'note';
      ui.noteEditingId = null;
      ui.noteDelete = null;
      ui.noteDraft = null;
      renderNotes();
      break;

    case 'note-open':
      ui.noteEditingId = id;
      ui.noteAdd = false;
      ui.noteDelete = null;
      ui.noteDraft = null;
      renderNotes();
      break;

    case 'note-cancel':
      ui.noteAdd = false;
      ui.noteEditingId = null;
      ui.noteDelete = null;
      ui.noteDraft = null;
      renderNotes();
      break;

    case 'note-save': {
      const text = el('n-text') ? el('n-text').value : '';
      const src = el('n-source') ? el('n-source').value : undefined;
      if (id === 'new') { if (addNote(text, ui.noteKind, src)) ui.savedFlash = true; }
      else if (updateNote(id, text, src)) ui.savedFlash = true; // пустой текст удаляет заметку
      ui.noteAdd = false;
      ui.noteEditingId = null;
      ui.noteDelete = null;
      ui.noteDraft = null;
      renderNotes();
      break;
    }

    case 'note-del':
      if (ui.noteDelete !== id) { ui.noteDelete = id; renderNotes(); break; }
      deleteNote(id);
      ui.noteDelete = null;
      ui.noteEditingId = null;
      ui.noteDraft = null;
      renderNotes();
      break;

    case 'ex-add-open': ui.exAddOpen = true; ui.exEditingId = null; renderSettings(); break;
    case 'ex-add-cancel': ui.exAddOpen = false; renderSettings(); break;
    case 'ex-add-save': {
      const name = el('x-add-name') ? el('x-add-name').value : '';
      if (!name.trim()) break; // безымянное упражнение не заводится
      addExercise(name, el('x-add-unit') ? el('x-add-unit').value : '',
        el('x-add-value') ? parsePositive(el('x-add-value').value) : null);
      ui.exAddOpen = false;
      ui.savedFlash = true;
      renderSettings();
      break;
    }
    case 'ex-open': ui.exEditingId = id; ui.exAddOpen = false; renderSettings(); break;
    case 'ex-cancel': ui.exEditingId = null; renderSettings(); break;
    case 'ex-save':
      if (updateExercise(id, el('x-name') ? el('x-name').value : '', el('x-unit') ? el('x-unit').value : '')) {
        ui.exEditingId = null;
        ui.savedFlash = true;
      }
      renderSettings();
      break;
    case 'ex-up':
    case 'ex-down': {
      if (!moveExercise(id, act === 'ex-up' ? 'up' : 'down')) break;
      renderSettings();
      // фокус — той же кнопке пересозданной строки, как у пунктов
      const find = a => [...el('scr-settings').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.id === id);
      const same = find(act);
      const pair = find(act === 'ex-up' ? 'ex-down' : 'ex-up');
      if (same && !same.disabled) same.focus();
      else if (pair) pair.focus();
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
    // понижение планки: шаг применяется немедленно и уходит в срез недели,
    // «Оставить» просто фиксирует решение — обе кнопки ставят якорь недели
    case 'lower-ok': {
      if (!item) break;
      const to = lowerSuggest(item.value);
      if (to === null) break;
      acceptLower(item, to);
      motionLeave(b.closest('.card'), renderReview);
      break;
    }

    case 'lower-keep':
      if (item) { keepBar(item); motionLeave(b.closest('.card'), renderReview); }
      break;

    // «Остаться»: ступень не двигается, карточка уступает место строке
    // состояния до конца сеанса — в данных решение не отражается
    case 'ladder-stay':
      ui.ladderStay = true;
      renderReview();
      break;

    case 'week-fold': // раскрытие свёртки делает сам details, здесь — только память
      ui.weekOpen = !ui.weekOpen;
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
      renderSettings();
      // вернуть фокус кнопке того же действия и пункта; на краю списка — парной
      const find = a => [...el('scr-settings').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.id === id);
      let btn = find(act);
      if (!btn || btn.disabled) btn = find(act === 'move-up' ? 'move-down' : 'move-up');
      if (btn && !btn.disabled) btn.focus();
      break;
    }

    case 'group-up':
    case 'group-down': {
      if (!moveGroup(b.dataset.name, act === 'group-up' ? 'up' : 'down')) break;
      ui.groupDelete = null;
      renderSettings();
      // фокус на кнопке того же действия и той же группы; на краю — парной
      const find = a => [...el('scr-settings').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.name === b.dataset.name);
      let btn = find(act);
      if (!btn || btn.disabled) btn = find(act === 'group-up' ? 'group-down' : 'group-up');
      if (btn && !btn.disabled) btn.focus();
      break;
    }
    case 'group-open':
      ui.groupRename = ui.groupRename === b.dataset.name ? null : b.dataset.name; // раскрыт один
      ui.groupDelete = null;
      renderSettings();
      break;
    case 'group-cancel': ui.groupRename = null; ui.groupDelete = null; renderSettings(); break;
    case 'group-save': {
      const inp = el('g-name');
      if (inp) renameGroup(b.dataset.name, inp.value); // пустое или занятое имя — тихий отказ
      ui.groupRename = null;
      ui.groupDelete = null;
      renderSettings();
      break;
    }
    case 'group-del': {
      if (ui.groupDelete !== b.dataset.name) { ui.groupDelete = b.dataset.name; renderSettings(); break; }
      deleteGroup(b.dataset.name); // пункты остаются, отметки не трогаются
      ui.groupDelete = null;
      ui.groupRename = null;
      renderSettings();
      break;
    }
    case 'group-add-open': ui.groupAdd = true; ui.groupDelete = null; renderSettings(); break;
    case 'group-add-cancel': ui.groupAdd = false; renderSettings(); break;
    case 'group-add-save': {
      const inp = el('g-add');
      if (inp && !addGroup(inp.value)) { inp.focus(); break; } // пустое или дубль — форма остаётся
      ui.groupAdd = false;
      renderSettings();
      break;
    }

    case 'edit-open':
      ui.editingId = id; ui.addOpen = false; ui.editNorm = null; ui.groupDelete = null;
      ui.groupPick = null; ui.groupNew = false; // поле «Блок» открывается на значении пункта
      renderSettings();
      break;
    case 'edit-cancel':
      ui.editingId = null; ui.editNorm = null; ui.groupPick = null; ui.groupNew = false;
      renderSettings();
      break;

    case 'norm-dec':
    case 'norm-inc': {
      if (!item) break;
      const cur = ui.editNorm !== null ? ui.editNorm : (item.normPerWeek || 7);
      const next = Math.max(1, Math.min(7, cur + (act === 'norm-inc' ? 1 : -1)));
      if (next === cur) break;
      ui.editNorm = next;
      renderSettings();
      // вернуть фокус кнопке того же действия; на границе — парной (как у «выше/ниже»)
      const find = a => [...el('scr-settings').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.id === id);
      let btn = find(act);
      if (!btn || btn.disabled) btn = find(act === 'norm-inc' ? 'norm-dec' : 'norm-inc');
      if (btn && !btn.disabled) btn.focus();
      break;
    }
    case 'thr-dec':
    case 'thr-inc': {
      const cur = dayThreshold();
      const next = clampThreshold(cur + (act === 'thr-inc' ? THRESHOLD_STEP : -THRESHOLD_STEP));
      if (next === cur) break;
      store.settings.dayThreshold = next;
      save();
      renderSettings();
      // фокус — той же кнопке; на границе диапазона парной (как у нормы недели)
      let btn = el('scr-settings').querySelector(`[data-act="${act}"]`);
      if (!btn || btn.disabled) {
        btn = el('scr-settings').querySelector(`[data-act="${act === 'thr-inc' ? 'thr-dec' : 'thr-inc'}"]`);
      }
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
        if (item.type === 'weekly') {
          const g = parsePositive(el('e-goal') ? el('e-goal').value : null);
          if (g !== null && Math.round(g) >= 1) item.goal = Math.round(g); // невалид — старая цель
        }
      } else if (ui.editNorm !== null) {
        item.normPerWeek = Math.max(1, Math.min(7, ui.editNorm)); // ежедневная привычка: норма недели
      }
      // блок — поле всех форм, а не только минимума (задача 19, B.3): блоки
      // работали на «Привычках», но назначить их привычке и параметру было
      // нечем. Без поля в форме readGroupField возвращает прежнее значение.
      item.group = readGroupField('e', item.group);
      save();
      ui.editingId = null;
      ui.editNorm = null;
      ui.groupPick = null;
      ui.groupNew = false;
      ui.savedFlash = true; // тихое подтверждение (движение, задача 12)
      renderSettings();
      break;
    }

    case 'add-open': {
      ui.addOpen = true; ui.editingId = null; ui.addType = 'daily';
      ui.addArea = b.dataset.area === 'habit' ? 'habit' : 'min';
      ui.addPkind = 'time';
      ui.groupPick = null; ui.groupNew = false;
      // Подсказка «одна новая привычка за раз» видима все 14 дней после добавления пункта
      const newest = store.items.reduce((a, x) => (!a || x.addedAt > a.addedAt) ? x : a, null);
      ui.addHint = !!(newest && diffDays(todayKey(), newest.addedAt) < 14);
      renderSettings();
      break;
    }
    case 'add-cancel':
      ui.addOpen = false; ui.addHint = false; ui.groupPick = null; ui.groupNew = false;
      renderSettings();
      break;
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
          note, group: readGroupField('f', ''),
          type: 'param', area: 'habit', pkind, pvalue,
          pstep: st !== null ? Math.round(st) : 0,
          goal: null, active: true, addedAt: todayKey(), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
          history: [{ date: todayKey(), value: pvalue }]
        };
      } else if (ui.addArea === 'habit') {
        item = {
          id: uid(), name, value: null, unit: '', note, group: readGroupField('f', ''),
          type: 'daily', area: 'habit', normPerWeek: 7, // каноническая форма привычки (инвариант 11)
          goal: null, active: true, addedAt: todayKey(), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: []
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
          group: readGroupField('f', ''),
          type, area: 'min', goal,
          active: true, addedAt: todayKey(), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
          history: (typeof value === 'number') ? [{ date: todayKey(), value }] : []
        };
      }
      store.items.push(item);
      save();
      ui.addOpen = false;
      ui.groupPick = null;
      ui.groupNew = false;
      ui.savedFlash = true; // тихое подтверждение (движение, задача 12)
      renderSettings();
      break;
    }

    case 'export':
      exportJSON();
      renderSettings(); // обновить строку «Последний экспорт» (и погасить строку импорта)
      break;

    // ── чистка и её отмена (задача 16.1) ──────────────────────
    case 'wipe-open': ui.wipeOpen = true; ui.wipeConfirm = false; renderSettings(); break;
    case 'wipe-cancel': ui.wipeOpen = false; ui.wipeConfirm = false; renderSettings(); break;

    case 'wipe-do': {
      if (!ui.wipeConfirm) { ui.wipeConfirm = true; renderSettings(); break; } // второй тап
      // копию некуда положить — чистка не выполнена; молчать об этом нельзя:
      // владелец видел бы, что «Стереть» ничего не сделало (аудит, находка 20)
      if (!wipeAll()) { ui.wipeConfirm = false; ui.wipeFailed = true; renderSettings(); break; }
      ui.wipeFailed = false;
      // экран после чистки — «Сегодня» с пустым списком; ui-состояние,
      // указывавшее на исчезнувшие записи, снимается целиком
      ui.wipeOpen = false;
      ui.wipeConfirm = false;
      ui.wipeDropConfirm = false;
      ui.editingId = null;
      ui.addOpen = false;
      ui.exEditingId = null;
      ui.exAddOpen = false;
      ui.noteAdd = false;
      ui.noteEditingId = null;
      ui.formDraft = null;
      ui.detailDraft = null;
      ui.noteDraft = null;
      ui.missOpen = {};
      ui.raiseEdit = {};
      closeDetail();
      closeReview();
      closeTrain();
      ui.tab = 'today';
      renderAll();
      break;
    }

    case 'wipe-undo':
      if (restoreWiped()) {
        ui.wipeDropConfirm = false;
        ui.tab = 'settings';
        renderAll(); // вернулось всё сразу, включая дневные экраны
      }
      break;

    case 'wipe-drop':
      if (!ui.wipeDropConfirm) { ui.wipeDropConfirm = true; renderSettings(); break; }
      dropWiped();
      ui.wipeDropConfirm = false;
      renderSettings();
      break;
    case 'import':
      if (hadImportNote) renderSettings(); // до открытия диалога: file-input должен остаться в живом DOM
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
  } else if (act === 'ex-active') {
    const ex = findExercise(t.dataset.id);
    if (ex) {
      ex.active = t.checked;
      save();
      const wrap = t.closest('.rowwrap');
      if (wrap) wrap.classList.toggle('off', !ex.active);
    }
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
  } else if (act === 'since') {
    // начало отсчёта: приводится к понедельнику своей недели, будущее не берётся
    const v = t.value;
    if (isDayKey(v) && v <= todayKey()) {
      store.settings.calendarSince = weekStartOf(v);
      save();
    }
    t.value = store.settings.calendarSince; // поле показывает принятое значение
  } else if (act === 'group-pick') {
    // «+ Новый блок…» — последний вариант: раскрывает поле имени в форме
    ui.groupNew = isNewGroupPick(t);
    if (!ui.groupNew) ui.groupPick = t.value;
    renderSettings();
  } else if (act === 'add-type') {
    ui.addType = t.value;
    renderSettings(); // снимок/восстановление формы — внутри renderSettings, цель не сбрасывается
  } else if (act === 'formula-mode') {
    // смена режима перерисовывает форму: подписи и подсказки другие, а
    // значения полей остаются — их снимает и возвращает черновик формы
    ui.formulaMode = t.value === 'break' ? 'break' : 'build';
    renderAll();
  } else if (act === 'add-pkind') {
    ui.addPkind = t.value === 'number' ? 'number' : 'time';
    renderSettings();
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
    const probe = await mirrorProbe(MIRROR_PROBE_MS);
    if (probe.snap && typeof probe.snap.json === 'string') {
      try { store = migrate(JSON.parse(probe.snap.json)); } catch (e) { store = null; }
    }
    // 'failed' — под недочитанным зеркалом может лежать живой снапшот.
    // Писать туда в этой сессии нельзя вовсе: дефолтный store затёр бы
    // его безвозвратно (A.1.2). Приложение при этом работает как обычно.
    mirrorReady = probe.status !== 'failed';
    mirrorUnverified = probe.status === 'failed';
    if (!store) store = defaultStore();
    // и в localStorage дефолт тоже не пишется: непустой localStorage на
    // следующем старте стал бы источником истины, зеркало перестали бы
    // читать — и всё равно затёрли бы. Пустой localStorage оставляет
    // перезапуску шанс дочитать зеркало и восстановить данные (A.1.5).
    // Первое же действие владельца сохранится обычным save().
    if (probe.status !== 'failed') save();
  }
  navigator.storage?.persist?.()?.catch?.(() => {}); // fire-and-forget: просим не вычищать localStorage
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('pointerdown', dragDown); // перетаскивание (задача 16F)
  document.querySelectorAll('#tabs button').forEach(b =>
    b.addEventListener('click', () => {
      ui.importNote = null;
      if (b.dataset.tab !== ui.tab) { ui.missOpen = {}; ui.raiseEdit = {}; }
      closeDetail(); // таб-бар уводит с листов, черновик формы не переносится
      closeReview();
      closeTrain();
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
    SCHEMA_VERSION,
    defaultStore, migrate, dateKeyShift, dateKeyFromDate, addDays, diffDays,
    todayKey, msToNextBoundary, weekStartOf, currentWeekStart, previousWeekStart,
    toggleMark, isMarked, incTrain, undoTrain, trainCount,
    reviewDue, windowKeys, currentOneChange, raiseEligible, raiseSuggest, resetRaiseCount,
    acceptRaise, closeWeek, missedYesterday, markYesterday, plural, parseNum,
    // планка вниз (задача 16C)
    lowerEligible, lowerSuggest, acceptLower, keepBar,
    // упражнения и тренировки (задача 16D)
    activeExercises, findExercise, addExercise, updateExercise, moveExercise, recordSession,
    // заметки и выписки (задача 16E, инвариант 16 + задача 17)
    addNote, updateNote, deleteNote, notesByDate, quotes, quoteOfDay,
    // чистка и её отмена (задача 16.1)
    WIPE_KEY, emptyStore, wipeStats, wipedCopy, wipeAll, restoreWiped, dropWiped,
    fmtParam, paramDecision, applyParamStep, keepParam, habitsSteady,
    habitWeekCount, habitStreakFrom, habitStreak,
    moveItem, canMoveItem, reorderItem, reorderGroup, reorderExercise,
    recordBar, parsePositive, isDayKey, load,
    mirrorRead, mirrorWrite, flushMirror,
    // формула и лестница (инвариант 12)
    activeLadderItem, closedWeeks, itemWeekCount, ladderNorm, ladderWeeksReady,
    canStepForward, canStepBack, ladderStatus, ladderStep, ladderBlockedBy,
    setLadder, clearLadder, setFormula, normFormula, normLadder,
    // блоки (инвариант 13)
    findGroup, addGroup, moveGroup, renameGroup,
    deleteGroup, groupedItems, groupList,
    // прогресс (инвариант 14)
    minDayItems, minDayMarks, minDayClosed, daysInSystem, dayStreak,
    chainWeeks, marksInSystem, riseSeries, risePath,
    // доля дня, порог и рекорд (задача 17)
    dayScore, dayNeed, dayThreshold, clampThreshold, bestStreak,
    marksWindow, seedProgram, SEED_QUOTES
  };
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
