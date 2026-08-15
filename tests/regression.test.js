'use strict';
/* Задача 23, п. 7: дыры покрытия, найденные аудитом QA.
   Каждый тест здесь закрывает ровно одну и написан от мутанта: правка,
   которую действовавшие тесты пропускали молча. Уровень доменный —
   без jsdom, через тестовый хук app.js; те дыры, где предмет проверки
   рендер (полоса дня «Прогресса», ячейка цепи на пороге, черновик
   заметки против черновика формы, таймер границы дня), живут в
   dom.test.js: их нечем проверить, не построив экран.

   Файл держится в долях секунды намеренно: доменный уровень должен
   быть дешёвым, иначе новый тест перестают писать. */

const test = require('node:test');
const assert = require('node:assert/strict');

const RealDate = Date;
let fixedNow = null;

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && fixedNow !== null) super(fixedNow);
    else super(...args);
  }
  static now() { return fixedNow !== null ? fixedNow : RealDate.now(); }
}
global.Date = FakeDate;

const app = require('../app.js');

function setNow(y, m, d, hh = 12, mm = 0) {
  fixedNow = new RealDate(y, m - 1, d, hh, mm, 0, 0).getTime();
}
function advanceDays(n) { fixedNow += n * 86400000; }

function freshStore() {
  const s = app.defaultStore();
  app.store = s;
  return s;
}

/* Календарная эпоха давно началась, пункты существуют с её начала */
function calendarPast(s) {
  s.settings.calendarSince = app.addDays(app.weekStartOf(app.todayKey()), -70);
  s.items.forEach(i => { i.addedAt = s.settings.calendarSince; });
  return s;
}

/* localStorage в Node нет, а копия чистки обязана куда-то лечь */
function fakeLocalStorage() {
  const mem = {};
  global.localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  };
  return mem;
}
function clearLocalStorage() { delete global.localStorage; }

/* Отметить пункт n раз подряд начиная с понедельника mon */
function fillWeek(s, id, mon, n) {
  for (let i = 0; i < n; i++) {
    const k = app.addDays(mon, i);
    (s.days[k] || (s.days[k] = {}))[id] = true;
  }
}

/* ── 1. Отмена тренировки трогает сессию своего дня ───────────
   Мутант: убрать сверку дня — «отменить последний» сносит последнюю
   сессию в массиве, чья бы она ни была. Прежние тесты держали случай,
   в котором сессия дня и последняя сессия — одна и та же запись. */
test('З23/7.1: «отменить последний» снимает сессию ТОГО ЖЕ дня, а не последнюю в списке', () => {
  setNow(2026, 8, 13, 12, 0);            // четверг
  const s = calendarPast(freshStore());
  const weekly = s.items.find(i => i.type === 'weekly');
  const t = app.todayKey();
  const earlier = app.addDays(t, -2);    // вторник той же недели

  // счётчик помнит вторник; сессий две, сессия вторника — НЕ последняя
  s.weekLog = [{ itemId: weekly.id, date: earlier, ts: 1 }];
  s.sessions = [
    { id: 'ses-вт', date: earlier, entries: [], note: '' },
    { id: 'ses-чт', date: t, entries: [], note: '' }
  ];

  app.undoTrain(weekly.id);
  assert.deepEqual(s.weekLog, [], 'запись счётчика снята');
  assert.deepEqual(s.sessions.map(x => x.id), ['ses-чт'],
    'ушла сессия вторника — того же дня, что и снятая запись, а не последняя в списке');
});

/* ── 2. Возврат стёртого не запускает посев ───────────────────
   Мутант: migrate(c.store) без { external: true }. Копия, снятая
   сразу после чистки, приносит пустой items[] — и посев дописал бы
   в неё девять чужих пунктов (инвариант 19). */
test('З23/7.2: restoreWiped проводит копию как данные извне — посев не запускается', () => {
  setNow(2026, 8, 13, 12, 0);
  fakeLocalStorage();
  try {
    freshStore();
    // копия, снятая версией до задачи 17 сразу после чистки: пустой items,
    // старая схема и без флагов посева — ровно тот случай из инварианта 19
    const naked = {
      schemaVersion: 3, items: [], groups: [], days: {}, weekLog: [], reviews: [],
      pendingRaises: [], exercises: [], sessions: [], notes: [], paramDecided: {},
      draftOneChange: '', weekStart: null,
      settings: { dayBoundary: 4 }
    };
    localStorage.setItem(app.WIPE_KEY, JSON.stringify({ store: naked, wipedAt: 1, stats: {} }));

    assert.equal(app.restoreWiped(), true, 'копия вернулась');
    assert.deepEqual(app.store.items, [], 'посев не добавил ни одного пункта');
    assert.deepEqual(app.store.notes, [], 'и ни одной выписки');
    // и следующий старт не засеет её уже как «первый запуск»
    assert.equal(app.store.settings.seed17, true, 'флаг посева проставлен пустому внешнему store');
    assert.equal(app.store.settings.habitSeeded, true);
    assert.equal(app.wipedCopy(), null, 'ключ копии убран');
  } finally { clearLocalStorage(); }
});

/* ── 3–5. Лестница: закрытие, статус, слот ─────────────────── */

/* Пункт-привычка с лестницей на последней ступени и двумя выдержанными
   завершёнными неделями — состояние ladderSettled (инвариант 12). */
function settledLadder() {
  setNow(2026, 8, 13, 12, 0);
  const s = calendarPast(freshStore());
  const it = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  it.normPerWeek = 7;
  it.ladder = { steps: ['шаг 1', 'шаг 2'], step: 1, steppedWeek: null, startedAt: s.settings.calendarSince, done: false };
  it.ladderLog = [{ date: s.settings.calendarSince, step: 0, text: 'шаг 1', start: true }];
  const cur = app.currentWeekStart();
  fillWeek(s, it.id, app.addDays(cur, -7), 7);
  fillWeek(s, it.id, app.addDays(cur, -14), 7);
  // остальные лестницы снять: слот один (инвариант 12)
  s.items.forEach(x => { if (x !== it && x.ladder) x.ladder = null; });
  return { s, it };
}

test('З23/7.3: ladderClosedAt — дата ПОСЛЕДНЕГО закрытия, а не первого', () => {
  const { it } = settledLadder();
  assert.equal(app.ladderSettled(it), true, 'условие «встала» выполнено');

  assert.equal(app.closeLadder(it.id), true);
  const first = app.todayKey();
  assert.equal(app.ladderClosedAt(it), first);

  assert.equal(app.reopenLadder(it.id), true);
  advanceDays(3);
  assert.equal(app.closeLadder(it.id), true);
  const second = app.todayKey();

  assert.notEqual(second, first, 'дни закрытия действительно разные');
  assert.equal(app.ladderClosedAt(it), second,
    'журнал читается с конца: закрыл → открыл → закрыл даёт последнюю дату');
  assert.equal(it.ladderLog.filter(e => e.closed).length, 2, 'обе вехи закрытия в журнале');
});

test('З23/7.4: у закрытой лестницы статус не говорит «привычка встала»', () => {
  const { it } = settledLadder();
  assert.equal(app.ladderStatus(it), 'Последняя ступень держится две недели — привычка встала.',
    'пока открыта — предложение закрыть');

  app.closeLadder(it.id);
  assert.equal(app.ladderStatus(it), 'Последняя ступень',
    'закрыта — работа здесь закончена, звать закрывать нечего');

  app.reopenLadder(it.id);
  assert.equal(app.ladderStatus(it), 'Последняя ступень держится две недели — привычка встала.',
    'открыли заново — предложение вернулось');
});

test('З23/7.5: closedLadderItem отличает закрытую лестницу от живой', () => {
  const { it } = settledLadder();
  assert.equal(app.closedLadderItem(), null, 'живая лестница закрытой не считается');
  assert.equal(app.activeLadderItem(), it, 'и занимает слот');

  app.closeLadder(it.id);
  assert.equal(app.closedLadderItem(), it, 'закрытая нашлась');
  assert.equal(app.activeLadderItem(), null, 'и слот освободила (инвариант 12)');
});

/* ── 6. Шаг назад не тратит неделю ────────────────────────── */
test('З23/7.6: шаг назад не расходует неделю — шаг вперёд остаётся доступен', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = calendarPast(freshStore());
  const it = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  it.normPerWeek = 7;
  it.ladder = { steps: ['1', '2', '3'], step: 1, steppedWeek: null, startedAt: s.settings.calendarSince, done: false };
  it.ladderLog = [];
  s.items.forEach(x => { if (x !== it && x.ladder) x.ladder = null; });
  const cur = app.currentWeekStart();
  fillWeek(s, it.id, app.addDays(cur, -7), 7);
  fillWeek(s, it.id, app.addDays(cur, -14), 7);

  assert.equal(app.canStepForward(it), true, 'до шага назад вперёд можно');
  assert.equal(app.ladderStep(it.id, 'back'), true);
  assert.equal(it.ladder.step, 0);
  assert.equal(it.ladder.steppedWeek, null,
    'шаг назад критериев не имеет и неделю не помечает');
  assert.equal(app.canStepForward(it), true,
    'вернуться на прежнюю ступень можно в ту же неделю: назад — не «одно изменение»');
});

/* ── 7. Нулевая нагрузка в сессию не идёт ─────────────────── */
test('З23/7.7: нулевая нагрузка отбрасывается — ни в сессию, ни в историю', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = calendarPast(freshStore());
  const weekly = s.items.find(i => i.type === 'weekly');
  s.exercises = [{ id: 'ex1', name: 'Жим', unit: 'кг', value: 60, history: [], active: true, addedAt: s.settings.calendarSince }];

  app.recordSession(weekly.id, [{ exId: 'ex1', value: 0 }], '');
  const ses = s.sessions[s.sessions.length - 1];
  assert.deepEqual(ses.entries, [], 'нулевая запись в сессию не попала');
  assert.equal(s.exercises[0].value, 60, 'рабочая нагрузка не обнулилась');
  assert.deepEqual(s.exercises[0].history, [], 'истории тоже не появилось');
  assert.equal(app.trainCount(weekly.id), 1, 'сама тренировка при этом засчитана');

  // отрицательная — тем же путём
  app.recordSession(weekly.id, [{ exId: 'ex1', value: -5 }], '');
  assert.deepEqual(s.sessions[s.sessions.length - 1].entries, []);
  assert.equal(s.exercises[0].value, 60);
});

/* ── 8. Перестановка за границей списка ───────────────────── */
test('З23/7.8: reorderItem за границей списка отказывает и порядка не меняет', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = calendarPast(freshStore());
  const g = s.items.filter(i => i.type === 'daily' && i.area === 'min' && i.group === s.items[0].group);
  assert.ok(g.length >= 2, 'в блоке есть соседи');
  const before = s.items.map(i => i.id);
  const first = g[0].id;

  assert.equal(app.reorderItem(first, g.length), false, 'позиция за последней — отказ');
  assert.deepEqual(s.items.map(i => i.id), before, 'порядок не тронут');
  assert.equal(app.reorderItem(first, g.length + 3), false, 'далеко за границей — тоже отказ');
  assert.equal(app.reorderItem(first, -1), false, 'до первой — отказ');
  assert.deepEqual(s.items.map(i => i.id), before);

  // а внутри границ — работает, иначе тест доказывал бы только отказы
  assert.equal(app.reorderItem(first, g.length - 1), true);
  assert.notDeepEqual(s.items.map(i => i.id), before, 'законная перестановка прошла');
});
