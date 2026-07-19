'use strict';
/* Юнит-тесты семи доменных инвариантов из CLAUDE.md.
   app.js подключается через тестовый хук (ветка module.exports).
   localStorage в Node отсутствует: save()/load() внутри app.js молча
   пропускают запись (try/catch), домен работает в памяти через app.store.
   «Сейчас» подменяется классом FakeDate — каждый тестовый файл
   node --test выполняет в отдельном процессе, глобальная подмена безопасна. */

const test = require('node:test');
const assert = require('node:assert/strict');

const RealDate = Date;
let fixedNow = null; // ms или null (реальное время)

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && fixedNow !== null) super(fixedNow);
    else super(...args);
  }
  static now() { return fixedNow !== null ? fixedNow : RealDate.now(); }
}
global.Date = FakeDate;

const app = require('../app.js');

/* Помощники */

function setNow(y, m, d, hh = 12, mm = 0) {
  fixedNow = new RealDate(y, m - 1, d, hh, mm, 0, 0).getTime();
}

function advanceDays(n) {
  fixedNow += n * 86400000;
}

function freshStore() {
  const s = app.defaultStore();
  app.store = s;
  return s;
}

/* Синтетическая закрытая неделя, в которой пункт отмечен count раз */
function fakeReview(item, count) {
  const marks = Array.from({ length: 7 }, (_, i) => i < count);
  return {
    closedAt: 0, keys: [],
    perItem: { [item.id]: { name: item.name, marks, count } },
    trainings: {}, oneChange: '', raises: []
  };
}

/* Календарная эпоха началась давно: разборы доступны сразу */
function calendarPast(s) {
  s.settings.calendarSince = app.addDays(app.weekStartOf(app.todayKey()), -70);
  return s;
}

/* Отметить пункт в count днях последней завершённой недели */
function markPrevWeek(itemId, count = 6) {
  const prev = app.previousWeekStart();
  for (let i = 0; i < count; i++) app.toggleMark(app.addDays(prev, i), itemId);
}

/* ── Инвариант 1. Логический день ──────────────────────────── */

test('И1: dateKeyShift — время до границы относится к предыдущему дню', () => {
  assert.equal(app.dateKeyShift(new Date(2026, 6, 17, 0, 30), 4), '2026-07-16');
  assert.equal(app.dateKeyShift(new Date(2026, 6, 17, 3, 59), 4), '2026-07-16');
  assert.equal(app.dateKeyShift(new Date(2026, 6, 17, 4, 0), 4), '2026-07-17');
  assert.equal(app.dateKeyShift(new Date(2026, 6, 17, 12, 0), 4), '2026-07-17');
  // граница 0 — календарный день без сдвига
  assert.equal(app.dateKeyShift(new Date(2026, 6, 17, 0, 30), 0), '2026-07-17');
  // переход через границу месяца
  assert.equal(app.dateKeyShift(new Date(2026, 7, 1, 2, 0), 4), '2026-07-31');
});

test('И1: в полночь ничего не сгорает — 23:50 и 00:10 один логический день', () => {
  const before = app.dateKeyShift(new Date(2026, 6, 16, 23, 50), 4);
  const after = app.dateKeyShift(new Date(2026, 6, 17, 0, 10), 4);
  assert.equal(before, after);
  assert.equal(before, '2026-07-16');
});

test('И1: todayKey уважает смену settings.dayBoundary', () => {
  setNow(2026, 7, 17, 0, 30);
  const s = freshStore(); // dayBoundary: 4
  assert.equal(app.todayKey(), '2026-07-16');
  s.settings.dayBoundary = 0;
  assert.equal(app.todayKey(), '2026-07-17');
  s.settings.dayBoundary = 2; // 00:30 < 02:00 — всё ещё вчера
  assert.equal(app.todayKey(), '2026-07-16');
});

test('И1: отметка в 00:30 попадает во вчерашний день', () => {
  setNow(2026, 7, 17, 0, 30);
  const s = freshStore();
  const id = s.items[0].id;
  app.toggleMark(app.todayKey(), id); // как в обработчике: ключ считается в момент события
  assert.equal(app.isMarked('2026-07-16', id), true);
  assert.equal(app.isMarked('2026-07-17', id), false);
});

/* ── Инвариант 2. Календарные недели ───────────────────────── */

test('И2: weekStartOf — понедельник недели логического дня', () => {
  // 2026-01-05 — понедельник, 2026-01-11 — воскресенье
  assert.equal(app.weekStartOf('2026-01-05'), '2026-01-05'); // понедельник — сам себе начало
  assert.equal(app.weekStartOf('2026-01-07'), '2026-01-05'); // среда
  assert.equal(app.weekStartOf('2026-01-11'), '2026-01-05'); // воскресенье — та же неделя
  assert.equal(app.weekStartOf('2026-01-12'), '2026-01-12'); // следующий понедельник
});

test('И2: ночь воскресенья принадлежит неделе по логическому ключу', () => {
  // 00:30 и 02:00 воскресенья (граница 04:00) — логическая суббота → тот же понедельник
  const k1 = app.dateKeyShift(new Date(2026, 0, 11, 0, 30), 4);
  const k2 = app.dateKeyShift(new Date(2026, 0, 11, 2, 0), 4);
  assert.equal(k1, '2026-01-10');
  assert.equal(app.weekStartOf(k1), '2026-01-05');
  assert.equal(app.weekStartOf(k2), '2026-01-05');
  // ночь понедельника — ещё воскресенье прошлой недели
  const k3 = app.dateKeyShift(new Date(2026, 0, 12, 0, 30), 4);
  assert.equal(k3, '2026-01-11');
  assert.equal(app.weekStartOf(k3), '2026-01-05');
  // граница 0 — воскресная ночь остаётся воскресеньем
  const k4 = app.dateKeyShift(new Date(2026, 0, 12, 0, 30), 0);
  assert.equal(app.weekStartOf(k4), '2026-01-12');
});

test('И2: reviewDue — только последняя завершённая неделя, не разобранная ранее', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  // свежий store: calendarSince — ближайший понедельник в будущем либо сегодня
  assert.equal(app.reviewDue(), false);

  calendarPast(s);
  const prev = app.previousWeekStart();
  assert.equal(app.reviewDue(), true); // завершённая неделя есть, разборов нет
  s.reviews.push({ week: prev });
  assert.equal(app.reviewDue(), false); // уже разобрана
  s.reviews.pop();
  s.reviews.push({ weekStart: '2026-06-01' }); // скользящая запись без week
  assert.equal(app.reviewDue(), true); // календарный разбор не блокирует
  // prev раньше calendarSince — разбор недоступен
  s.settings.calendarSince = app.currentWeekStart();
  assert.equal(app.reviewDue(), false);
});

test('И2: windowKeys — ровно завершённая неделя пн–вс, сегодня не входит', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const keys = app.windowKeys();
  const prev = app.previousWeekStart();
  assert.equal(keys.length, 7);
  assert.equal(keys[0], prev);
  assert.equal(keys[6], app.addDays(prev, 6));
  assert.equal(app.weekStartOf(keys[0]), keys[0]); // начинается с понедельника
  assert.equal(keys.includes(app.todayKey()), false); // сегодня в окно не входит
  for (let i = 1; i < 7; i++) assert.equal(app.diffDays(keys[i], keys[i - 1]), 1);
});

test('И2: пропуск недель — разбор только за последнюю завершённую', () => {
  setNow(2026, 7, 6, 12, 0); // 2026-07-06 — понедельник
  const s = freshStore();
  calendarPast(s);
  const firstPrev = app.previousWeekStart();
  advanceDays(14); // две недели тихо прошли без разбора
  assert.equal(app.reviewDue(), true);
  const keys = app.windowKeys();
  assert.equal(keys[0], app.addDays(firstPrev, 14)); // окно — только последняя
  assert.equal(app.diffDays(app.todayKey(), keys[6]) >= 1, true);
});

/* ── Инвариант 3. Закрытие недели ──────────────────────────── */

test('И3: closeWeek пишет срез завершённой недели и чистит черновики', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  const oldWeekStart = s.weekStart;

  const daily = s.items.find(i => i.type === 'daily');
  const weekly = s.items.find(i => i.type === 'weekly');
  markPrevWeek(daily.id, 6);
  // тренировки: две в разобранной неделе, одна — уже в текущей
  s.weekLog.push(
    { itemId: weekly.id, date: app.addDays(prev, 2), ts: 1 },
    { itemId: weekly.id, date: app.addDays(prev, 4), ts: 2 },
    { itemId: weekly.id, date: app.todayKey(), ts: 3 }
  );
  s.draftOneChange = '  раньше ложиться  ';
  s.pendingRaises.push({ itemId: daily.id, name: daily.name, from: 5, to: 6 });

  assert.equal(app.closeWeek(), true);

  assert.equal(s.reviews.length, 1);
  const r = s.reviews[0];
  assert.equal(r.week, prev); // понедельник разобранной недели
  assert.deepEqual(r.keys, [0, 1, 2, 3, 4, 5, 6].map(n => app.addDays(prev, n)));
  assert.equal(r.perItem[daily.id].count, 6);
  assert.equal(r.perItem[daily.id].marks.length, 7);
  assert.equal(r.trainings[weekly.id].count, 2); // только записи разобранной недели
  assert.equal(r.trainings[weekly.id].goal, weekly.goal);
  assert.equal(r.oneChange, 'раньше ложиться');
  assert.deepEqual(r.raises, [{ itemId: daily.id, name: daily.name, from: 5, to: 6 }]);
  // очистка: prune старше текущей недели, черновики; weekStart не трогается
  assert.deepEqual(s.pendingRaises, []);
  assert.equal(s.draftOneChange, '');
  assert.equal(s.weekLog.length, 1); // сегодняшняя запись пережила prune
  assert.equal(app.trainCount(weekly.id), 1); // счётчик — от смены недели, не от закрытия
  assert.equal(s.weekStart, oldWeekStart); // историческое поле не меняется
  assert.equal(app.reviewDue(), false);
});

test('И3: выключенный пункт без отметок в окне не попадает в срез, с отметками — попадает', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  const [a, b] = s.items.filter(i => i.type === 'daily');
  a.active = false;                          // без отметок
  b.active = false;
  app.toggleMark(app.addDays(prev, 2), b.id); // с отметкой в разобранной неделе

  app.closeWeek();

  const r = s.reviews[0];
  assert.equal(a.id in r.perItem, false);
  assert.equal(b.id in r.perItem, true);
  assert.equal(r.perItem[b.id].count, 1);
});

test('И3: undoTrain не достаёт записи прошлой недели', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const weekly = s.items.find(i => i.type === 'weekly');
  const prev = app.previousWeekStart();
  s.weekLog.push({ itemId: weekly.id, date: app.addDays(prev, 1), ts: 1 });
  app.undoTrain(weekly.id); // запись прошлой недели неприкосновенна
  assert.equal(s.weekLog.length, 1);
  app.incTrain(weekly.id);
  app.undoTrain(weekly.id); // текущая — удаляется
  assert.equal(s.weekLog.length, 1);
  assert.equal(s.weekLog[0].date, app.addDays(prev, 1));
});

/* ── Инвариант 4. Повышение планки ─────────────────────────── */

test('И4: полный цикл — три закрытые недели ≥6/7 дают предложение', () => {
  setNow(2026, 7, 1, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания'); // value: 5
  s.reviews.push({ week: app.previousWeekStart() }); // прошлая неделя уже разобрана
  assert.equal(app.raiseEligible(item), false);
  s.reviews = [];

  for (let w = 0; w < 3; w++) {
    markPrevWeek(item.id, 6);
    app.closeWeek();
    advanceDays(7);
  }
  assert.equal(s.reviews.length, 3);
  assert.equal(app.raiseEligible(item), true);
  assert.equal(app.raiseSuggest(item.value), 6); // 5 → 6
});

test('И4: «Не сейчас» сдвигает якорь — отсчёт трёх недель заново', () => {
  setNow(2026, 7, 1, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  for (let w = 0; w < 3; w++) { markPrevWeek(item.id, 6); app.closeWeek(); advanceDays(7); }
  assert.equal(app.raiseEligible(item), true);

  app.resetRaiseCount(item);
  assert.equal(item.raiseAfter, 4); // reviews.length (3) + 1: текущая открытая неделя не в счёт
  assert.equal(app.raiseEligible(item), false);

  // ещё 3 закрытия — рано: нужно ≥ raiseAfter + 3 = 7 закрытых недель
  for (let w = 0; w < 3; w++) { markPrevWeek(item.id, 6); app.closeWeek(); advanceDays(7); }
  assert.equal(s.reviews.length, 6);
  assert.equal(app.raiseEligible(item), false);

  markPrevWeek(item.id, 6); app.closeWeek();
  assert.equal(s.reviews.length, 7);
  assert.equal(app.raiseEligible(item), true);
});

test('И4: неделя с 5 отметками в тройке последних ломает право на повышение', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  s.reviews = [fakeReview(item, 6), fakeReview(item, 7), fakeReview(item, 5)];
  assert.equal(app.raiseEligible(item), false);
  s.reviews = [fakeReview(item, 5), fakeReview(item, 6), fakeReview(item, 7)];
  assert.equal(app.raiseEligible(item), false); // и в середине/начале тройки тоже
  s.reviews = [fakeReview(item, 5), fakeReview(item, 6), fakeReview(item, 6), fakeReview(item, 7)];
  assert.equal(app.raiseEligible(item), true); // считаются 3 ПОСЛЕДНИЕ закрытые
});

test('И4: повышение только для активных дневных пунктов с числовой планкой', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  const noValue = s.items.find(i => i.name === 'Умыться');   // value: null
  const weekly = s.items.find(i => i.type === 'weekly');
  s.reviews = [fakeReview(item, 7), fakeReview(item, 7), fakeReview(item, 7)];
  s.reviews.forEach(r => {
    r.perItem[noValue.id] = { name: noValue.name, marks: [1, 1, 1, 1, 1, 1, 1].map(Boolean), count: 7 };
  });
  assert.equal(app.raiseEligible(noValue), false); // нет числовой планки
  assert.equal(app.raiseEligible(weekly), false);  // недельный тип
  item.active = false;
  assert.equal(app.raiseEligible(item), false);    // выключен
  item.active = true;
  assert.equal(app.raiseEligible(item), true);
});

test('И4: raiseSuggest — +1 до 12 включительно, дальше +10% с округлением', () => {
  assert.equal(app.raiseSuggest(5), 6);
  assert.equal(app.raiseSuggest(12), 13);
  assert.equal(app.raiseSuggest(13), 14);   // round(14.3)
  assert.equal(app.raiseSuggest(20), 22);
  assert.equal(app.raiseSuggest(500), 550);
});

test('И4: accept — history, pendingRaises, новый якорь и попадание в разбор', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  s.reviews = [fakeReview(item, 6), fakeReview(item, 6), fakeReview(item, 6)];
  assert.equal(app.raiseEligible(item), true);

  app.acceptRaise(item, 6);

  assert.equal(item.value, 6);
  assert.deepEqual(item.history[item.history.length - 1], { date: app.todayKey(), value: 6 });
  assert.deepEqual(s.pendingRaises, [{ itemId: item.id, name: item.name, from: 5, to: 6 }]);
  assert.equal(item.raiseAfter, 4); // reviews.length (3) + 1
  assert.equal(app.raiseEligible(item), false); // отсчёт заново

  app.closeWeek(); // повышение попадает в срез закрытой недели
  const r = s.reviews[s.reviews.length - 1];
  assert.deepEqual(r.raises, [{ itemId: item.id, name: item.name, from: 5, to: 6 }]);
  assert.deepEqual(s.pendingRaises, []);
});

/* ── Инвариант 5. История планки ───────────────────────────── */

test('И5: recordBar — повторное изменение в тот же логический день заменяет запись', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const item = s.items.find(i => i.name === 'Пешком'); // history: [{сегодня, 500}]
  const len0 = item.history.length;
  assert.equal(len0, 1);

  app.recordBar(item, 600); // тот же день — замена посеянной записи
  assert.equal(item.history.length, 1);
  assert.deepEqual(item.history[0], { date: app.todayKey(), value: 600 });

  advanceDays(1);
  app.recordBar(item, 700); // новый день — новая запись
  assert.equal(item.history.length, 2);
  assert.deepEqual(item.history[1], { date: app.todayKey(), value: 700 });

  app.recordBar(item, 800); // и снова замена в тот же день
  assert.equal(item.history.length, 2);
  assert.deepEqual(item.history[1], { date: app.todayKey(), value: 800 });
  assert.equal(item.history[0].value, 600); // старые записи не трогаются
});

/* ── Инвариант 6. Миграции и экспорт/импорт ────────────────── */

function v1Store() {
  // Правдоподобный v1-экспорт: нет note/group/history, нет «Принять душ»
  return {
    schemaVersion: 1,
    items: [
      { id: 'a1', name: 'Умыться', value: null, unit: '', type: 'daily', goal: null, active: true, addedAt: '2026-06-01', raiseAfter: 0 },
      { id: 'a2', name: 'Подтягивания + отжимания', value: 5, unit: 'повт.', type: 'daily', goal: null, active: true, addedAt: '2026-06-01', raiseAfter: 0 },
      { id: 'a3', name: 'Тренировка', value: null, unit: '', type: 'weekly', goal: 3, active: true, addedAt: '2026-06-01', raiseAfter: 0 }
    ],
    days: { '2026-06-02': { a1: true } },
    weekLog: [],
    reviews: [],
    pendingRaises: [],
    draftOneChange: '',
    weekStart: '2026-06-01',
    settings: { dayBoundary: 4 }
  };
}

test('И6: migrate v1→v2 — «Принять душ», посев history и модулей, подпись тренировки', () => {
  setNow(2026, 7, 17, 12, 0);
  const m = app.migrate(v1Store());

  assert.equal(m.schemaVersion, 5);
  // «Принять душ» появился сразу после «Умыться»
  const names = m.items.map(i => i.name);
  assert.equal(names.indexOf('Принять душ'), names.indexOf('Умыться') + 1);
  const shower = m.items.find(i => i.name === 'Принять душ');
  assert.equal(shower.type, 'daily');
  assert.equal(shower.group, 'Тело');
  // модули посеяны по известным именам
  assert.equal(m.items.find(i => i.name === 'Умыться').group, 'Тело');
  assert.equal(m.items.find(i => i.name === 'Подтягивания + отжимания').group, 'Тело');
  // история планки посеяна для числовых значений от addedAt
  assert.deepEqual(m.items.find(i => i.id === 'a2').history, [{ date: '2026-06-01', value: 5 }]);
  assert.deepEqual(m.items.find(i => i.id === 'a1').history, []);
  // подпись тренировки
  assert.equal(m.items.find(i => i.name === 'Тренировка').note, 'Полноценная тренировка, 40–50 минут');
  // достройка настроек
  assert.equal('hintShownForItemId' in m.settings, true);
  // данные не потеряны
  assert.deepEqual(m.days, { '2026-06-02': { a1: true } });
});

test('И6: migrate идемпотентна — повторный прогон ничего не меняет', () => {
  setNow(2026, 7, 17, 12, 0);
  const once = app.migrate(v1Store());
  const twice = app.migrate(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once); // ни второго «душа», ни двойного посева истории
});

test('И6: migrate переживает мусор на входе', () => {
  for (const garbage of [null, undefined, [], 'строка', 42]) {
    const m = app.migrate(garbage);
    assert.equal(m.schemaVersion, 5);
    assert.equal(Array.isArray(m.items), true);
    assert.equal(m.items.length, 10); // дефолтный набор: 7 минимум + 3 привычки
    assert.equal(m.items.some(i => i.name === 'Принять душ'), true);
  }
});

test('И6: экспорт → очистка → импорт восстанавливает состояние полностью', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  // наполнить состояние: отметки, тренировки, закрытая неделя, черновик, история
  const t = app.todayKey();
  const daily = s.items.find(i => i.type === 'daily');
  const other = s.items.find(i => i.name === 'Развитие');
  const bar = s.items.find(i => i.name === 'Пешком');
  const weekly = s.items.find(i => i.type === 'weekly');
  markPrevWeek(daily.id, 6);
  app.incTrain(weekly.id);
  app.closeWeek();
  app.toggleMark(t, other.id); // отметка уже в текущей неделе
  app.incTrain(weekly.id);
  app.recordBar(bar, 600);
  s.draftOneChange = 'меньше сахара';
  s.settings.dayBoundary = 3;

  const exported = JSON.stringify(app.store);          // содержимое файла экспорта
  app.store = null;                                    // «очистка localStorage»
  const imported = app.migrate(JSON.parse(exported));  // путь importJSON: migrate(JSON.parse(...))
  app.store = imported;

  assert.deepEqual(imported, JSON.parse(exported));    // эквивалентность до байта данных
  // и домен жив после импорта: обе тренировки записаны в текущую неделю
  assert.equal(app.trainCount(weekly.id), 2);
  assert.equal(app.isMarked(t, other.id), true);
  assert.equal(app.todayKey(), app.dateKeyShift(new Date(), 3));
});

/* ── Задача 2. Устойчивость хранилища и валидация ──────────── */

test('З2: migrate фильтрует мусор в items, достраивает id и addedAt, дедуплицирует id', () => {
  setNow(2026, 7, 17, 12, 0);
  const m = app.migrate({
    schemaVersion: 3,
    items: [
      null, 'строка', 42, [1],
      { name: 'Без полей' },
      { id: 'dup', name: 'Первый', addedAt: '2026-07-01' },
      { id: 'dup', name: 'Второй', addedAt: 'мусор' },
      { id: 77, name: 'Числовой id', value: '5', goal: '2,5', raiseAfter: 'x' }
    ],
    days: {}, weekLog: [], reviews: [], pendingRaises: [],
    draftOneChange: '', weekStart: '2026-07-15',
    settings: { dayBoundary: 4, habitSeeded: true }
  });
  assert.equal(m.items.length, 4); // не-объекты выброшены
  assert.equal(new Set(m.items.map(i => i.id)).size, 4); // id уникальны
  for (const it of m.items) {
    assert.equal(typeof it.id, 'string');
    assert.equal(it.id.length > 0, true);
    assert.equal(app.isDayKey(it.addedAt), true);
    assert.equal(it.type, 'daily');
    assert.equal(Array.isArray(it.history), true);
  }
  assert.equal(m.items[1].addedAt, '2026-07-01'); // валидный addedAt сохранён
  assert.equal(m.items[2].addedAt, '2026-07-17'); // мусорный заменён на сегодня
  const num = m.items[3];
  assert.equal(num.value, 5);      // числовая строка приведена
  assert.equal(num.goal, 3);       // '2,5' → 2.5 → целое ≥1
  assert.equal(num.raiseAfter, 0); // мусор обнулён
});

test('З2: migrate чистит days, weekLog, reviews и мусорный weekStart', () => {
  setNow(2026, 7, 17, 12, 0);
  const m = app.migrate({
    schemaVersion: 3,
    items: [],
    days: {
      '2026-07-01': { a: true, b: false },
      '2026-07-02': 'мусор',
      '2026-07-03': { a: 1 },
      '2026-07-04': [true],
      '2026-07-05': null,
      '2026-07-06': {},          // пустой день toggleMark не оставляет — отбрасывается
      'не-дата': { a: true }     // мусорный ключ отбрасывается
    },
    weekLog: [null, 'x', { itemId: 'a', date: '2026-07-10', ts: 1 }, 5],
    reviews: [null, 'y', { closedAt: 1, weekStart: '2026-07-01', keys: [], perItem: {}, trainings: {}, oneChange: '', raises: [] }],
    pendingRaises: [], draftOneChange: '',
    weekStart: '2026-02-31', // несуществующая дата
    settings: { dayBoundary: 4 }
  });
  assert.deepEqual(Object.keys(m.days), ['2026-07-01']);
  assert.equal(m.weekLog.length, 1);
  assert.equal(m.reviews.length, 1);
  assert.equal(m.weekStart, '2026-07-17');
});

test('З2: migrate не бросает ни на каком мусоре', () => {
  setNow(2026, 7, 17, 12, 0);
  const cases = [
    { items: [null], days: null },
    { items: [{ history: 'мусор' }], days: { d: { a: 'нет' } } },
    { schemaVersion: 3, items: [{ history: [null, { date: 'x', value: 1 }, { date: '2026-07-01', value: 'y' }, { date: '2026-07-02', value: 3 }] }] },
    { items: [], weekLog: {}, reviews: 'мусор', weekStart: 42, settings: 'мусор' }
  ];
  for (const c of cases) assert.doesNotThrow(() => app.migrate(c), JSON.stringify(c));
  // из мусорной истории выживают только валидные записи
  const m = app.migrate(cases[2]);
  assert.deepEqual(m.items[0].history, [{ date: '2026-07-02', value: 3 }]);
});

test('З2: мусорный schemaVersion трактуется как v1 — версионные шаги не пропускаются', () => {
  setNow(2026, 7, 17, 12, 0);
  const src = v1Store();
  src.schemaVersion = 'мусор';
  const m = app.migrate(src);
  assert.equal(m.schemaVersion, 5);
  assert.equal(m.items.some(i => i.name === 'Принять душ'), true); // шаг v1→v2 сработал
  assert.equal(m.reviews.every(r => app.isDayKey(r.weekStart)), true); // и v2→v3 тоже
});

test('З2: isDayKey — формат и существование даты', () => {
  assert.equal(app.isDayKey('2026-07-17'), true);
  assert.equal(app.isDayKey('2026-02-31'), false);
  assert.equal(app.isDayKey('2026-7-1'), false);
  assert.equal(app.isDayKey('мусор'), false);
  assert.equal(app.isDayKey(42), false);
  assert.equal(app.isDayKey(null), false);
});

test('З2: migrate v2→v3 — backfill weekStart из keys[0], идемпотентно', () => {
  setNow(2026, 7, 17, 12, 0);
  const src = {
    schemaVersion: 2,
    items: [{ id: 'a1', name: 'Умыться', addedAt: '2026-06-01' },
      { id: 'a2', name: 'Принять душ', addedAt: '2026-06-01' }],
    days: {}, weekLog: [], pendingRaises: [], draftOneChange: '',
    weekStart: '2026-07-15', settings: { dayBoundary: 4 },
    reviews: [
      { closedAt: 1, keys: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07'], perItem: {}, trainings: {}, oneChange: '', raises: [] },
      { closedAt: 2, keys: 'мусор', perItem: {}, trainings: {}, oneChange: '', raises: [] }
    ]
  };
  const m = app.migrate(src);
  assert.equal(m.schemaVersion, 5);
  assert.equal(m.reviews[0].weekStart, '2026-06-01');
  assert.equal(m.reviews[1].weekStart, '2026-07-17'); // keys[0] невалиден — сегодня
  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again, m); // повторный прогон ничего не меняет
});

test('З2: closeWeek guard — до calendarSince и повторный вызов не пишут срез', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore(); // calendarSince — ближайший понедельник, разбор недоступен
  assert.equal(app.closeWeek(), false);
  assert.equal(s.reviews.length, 0);

  calendarPast(s);
  const prev = app.previousWeekStart();
  assert.equal(app.closeWeek(), true);
  assert.equal(s.reviews.length, 1);
  assert.equal(s.reviews[0].week, prev); // понедельник разобранной недели в срезе

  assert.equal(app.closeWeek(), false); // эта неделя уже разобрана
  assert.equal(s.reviews.length, 1);
});

test('З2: trainings в срезе — активные либо с ненулевым счётом за разобранную неделю', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  const w1 = s.items.find(i => i.type === 'weekly'); // активный, счёт 0
  s.items.push(
    { ...w1, id: 'w2', name: 'Выключенный без счёта', active: false },
    { ...w1, id: 'w3', name: 'Выключенный со счётом', active: false }
  );
  s.weekLog.push({ itemId: 'w3', date: app.addDays(prev, 3), ts: 1 }); // в разобранной неделе
  app.closeWeek();
  const t = s.reviews[0].trainings;
  assert.equal(w1.id in t, true);  // активный с нулём — в срезе
  assert.equal('w2' in t, false);  // выключенный без счёта — нет
  assert.equal('w3' in t, true);   // выключенный со счётом — да
  assert.equal(t.w3.count, 1);
});

test('З2: recordBar — возврат к прежнему значению схлопывает запись, дублей не бывает', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const item = s.items.find(i => i.name === 'Пешком'); // [{2026-07-17, 500}]
  advanceDays(7);
  app.recordBar(item, 600);
  assert.equal(item.history.length, 2);
  app.recordBar(item, 500); // тот же день: вернулись к прежней планке
  assert.equal(item.history.length, 1);
  assert.deepEqual(item.history[0], { date: '2026-07-17', value: 500 });
  advanceDays(7);
  app.recordBar(item, 500); // и межднёвный дубль того же значения не создаётся
  assert.equal(item.history.length, 1);
});

test('З2: parsePositive — матрица входов', () => {
  assert.equal(app.parsePositive('5'), 5);
  assert.equal(app.parsePositive('5,5'), 5.5);
  assert.equal(app.parsePositive(' 7 '), 7);
  assert.equal(app.parsePositive('0.25'), 0.25);
  assert.equal(app.parsePositive(500), 500);
  assert.equal(app.parsePositive('0'), null);
  assert.equal(app.parsePositive('-3'), null);
  assert.equal(app.parsePositive(''), null);
  assert.equal(app.parsePositive('   '), null);
  assert.equal(app.parsePositive('1о'), null); // буква вместо нуля
  assert.equal(app.parsePositive('abc'), null);
  assert.equal(app.parsePositive(null), null);
  assert.equal(app.parsePositive(undefined), null);
});

test('З2: load — битая строка уходит в minimum:data:corrupt, решение о дефолте за init', () => {
  setNow(2026, 7, 17, 12, 0);
  const mem = {};
  global.localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  };
  try {
    mem['minimum:data'] = '{битый json';
    assert.equal(app.load(), null); // не дефолт: дальше init смотрит зеркало (инвариант 9)
    assert.equal(mem['minimum:data:corrupt'], '{битый json');
    // пустой localStorage — тоже null
    delete mem['minimum:data'];
    assert.equal(app.load(), null);
    // валидная строка — store; резервный ключ не тронут
    mem['minimum:data'] = JSON.stringify(app.defaultStore());
    assert.equal(app.load().items.length, 10);
    assert.equal(mem['minimum:data:corrupt'], '{битый json');
  } finally {
    delete global.localStorage;
  }
});

test('З4: миграция v3→v4 — exportedAt с мягким дефолтом null, идемпотентно', () => {
  setNow(2026, 7, 17, 12, 0);
  const src = {
    schemaVersion: 3, items: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], draftOneChange: '', weekStart: '2026-07-15',
    settings: { dayBoundary: 4, hintShownForItemId: null }
  };
  const m = app.migrate(src);
  assert.equal(m.schemaVersion, 5);
  assert.equal(m.settings.exportedAt, null);
  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again, m);
  // существующее значение не перезаписывается
  const withDate = app.migrate({ ...JSON.parse(JSON.stringify(src)), schemaVersion: 3, settings: { dayBoundary: 4, exportedAt: 123 } });
  assert.equal(withDate.settings.exportedAt, 123);
});

test('З4: зеркало без indexedDB — тихие no-op, исключений нет', async () => {
  assert.equal(await app.mirrorRead(), null);
  assert.equal(await app.flushMirror(), false);
  assert.equal(await app.mirrorWrite({ json: '{}', savedAt: 1, schemaVersion: 4 }), false);
});

/* ── Задача 3. Гигиена migrate и uid ───────────────────────── */

test('З3: migrate фильтрует не-объекты в pendingRaises', () => {
  setNow(2026, 7, 17, 12, 0);
  const m = app.migrate({
    schemaVersion: 3, items: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [null, 'мусор', 5, [1], { itemId: 'a', from: 5, to: 6 }],
    draftOneChange: '', weekStart: '2026-07-15', settings: { dayBoundary: 4 }
  });
  assert.deepEqual(m.pendingRaises, [{ itemId: 'a', from: 5, to: 6 }]);
});

test('З3: migrate — value ≤ 0 обнуляется, name и unit приводятся к строке', () => {
  setNow(2026, 7, 17, 12, 0);
  const m = app.migrate({
    schemaVersion: 3,
    items: [
      { id: 'a', name: { x: 1 }, unit: 42, value: -5 },
      { id: 'b', name: 'Ноль', unit: 'м', value: 0 },
      { id: 'c', name: 'Плюс', unit: 'м', value: 3 }
    ],
    days: {}, weekLog: [], reviews: [], pendingRaises: [],
    draftOneChange: '', weekStart: '2026-07-15', settings: { dayBoundary: 4 }
  });
  assert.equal(m.items[0].name, '');
  assert.equal(m.items[0].unit, '');
  assert.equal(m.items[0].value, null);
  assert.equal(m.items[1].value, null);
  assert.equal(m.items[2].value, 3);
});

test('З3: msToNextBoundary — миллисекунды до ближайшей границы дня', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore(); // dayBoundary: 4
  assert.equal(app.msToNextBoundary(), 16 * 3600000); // завтра 04:00
  s.settings.dayBoundary = 0;
  assert.equal(app.msToNextBoundary(), 12 * 3600000); // ближайшая полночь
  setNow(2026, 7, 17, 4, 0);
  s.settings.dayBoundary = 4;
  assert.equal(app.msToNextBoundary(), 24 * 3600000); // ровно на границе — через сутки
  setNow(2026, 7, 17, 3, 59);
  assert.equal(app.msToNextBoundary(), 60000);
});

test('З3: uid — crypto.randomUUID и фолбэк без него', () => {
  // с crypto — UUID
  assert.match(app.defaultStore().items[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  // без crypto — фолбэк на Math.random/Date
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const id = app.defaultStore().items[0].id;
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
    assert.doesNotMatch(id, /-/);
    assert.match(id, /^[a-z0-9]+$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', desc);
  }
});

/* ── Задача 9 (I). Переход на календарные недели ───────────── */

test('З9: миграция v4→v5 — calendarSince: понедельник остаётся, середина недели → следующий', () => {
  const v4 = () => ({
    schemaVersion: 4, items: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], draftOneChange: '', weekStart: '2026-01-01',
    settings: { dayBoundary: 4, hintShownForItemId: null, exportedAt: null }
  });
  setNow(2026, 1, 5, 12, 0); // понедельник
  assert.equal(app.migrate(v4()).settings.calendarSince, '2026-01-05');
  setNow(2026, 1, 7, 12, 0); // среда
  assert.equal(app.migrate(v4()).settings.calendarSince, '2026-01-12');
  setNow(2026, 1, 11, 12, 0); // воскресенье
  assert.equal(app.migrate(v4()).settings.calendarSince, '2026-01-12');
  // идемпотентность: повторный прогон не двигает дату
  setNow(2026, 1, 7, 12, 0);
  const once = app.migrate(v4());
  advanceDays(30);
  const twice = app.migrate(JSON.parse(JSON.stringify(once)));
  assert.equal(twice.settings.calendarSince, once.settings.calendarSince);
  // рукотворный не-понедельник нормализуется вперёд к понедельнику
  const odd = v4();
  odd.schemaVersion = 5;
  odd.settings.calendarSince = '2026-01-07'; // среда
  assert.equal(app.migrate(odd).settings.calendarSince, '2026-01-12');
});

test('З9: переходные дни — разбор недоступен, счётчик доживает от weekStart', () => {
  setNow(2026, 1, 7, 12, 0); // среда; calendarSince будет 2026-01-12
  const s = freshStore();
  s.settings.calendarSince = '2026-01-12';
  s.weekStart = '2026-01-04'; // прежняя скользящая отсечка
  const weekly = s.items.find(i => i.type === 'weekly');
  s.weekLog.push({ itemId: weekly.id, date: '2026-01-05', ts: 1 }); // ≥ weekStart

  assert.equal(app.currentWeekStart(), null);
  assert.equal(app.reviewDue(), false);
  assert.equal(app.closeWeek(), false);
  assert.equal(app.trainCount(weekly.id), 1); // от прежнего weekStart

  advanceDays(5); // первый календарный понедельник, 2026-01-12
  assert.equal(app.currentWeekStart(), '2026-01-12');
  assert.equal(app.reviewDue(), false); // прошлая неделя раньше calendarSince
  assert.equal(app.trainCount(weekly.id), 0); // счётчик считает новую неделю
  app.incTrain(weekly.id);
  assert.equal(app.trainCount(weekly.id), 1);

  advanceDays(7); // второй понедельник — первая календарная неделя завершена
  assert.equal(app.reviewDue(), true);
  const keys = app.windowKeys();
  assert.equal(keys[0], '2026-01-12'); // окно — ровно первая неделя
  assert.equal(keys[6], '2026-01-18');
  assert.equal(keys.includes(app.todayKey()), false);
});

/* ── Задача 9 (II). Две области ────────────────────────────── */

test('З9: миграция v5 — area min всем существующим, посев привычек однократен', () => {
  setNow(2026, 1, 7, 12, 0);
  const v4 = {
    schemaVersion: 4,
    items: [{ id: 'a1', name: 'Умыться', addedAt: '2026-01-01', type: 'daily' }],
    days: {}, weekLog: [], reviews: [], pendingRaises: [], draftOneChange: '',
    weekStart: '2026-01-01',
    settings: { dayBoundary: 4, hintShownForItemId: null, exportedAt: null }
  };
  const m = app.migrate(v4);
  assert.equal(m.items.find(i => i.id === 'a1').area, 'min'); // backfill области
  const habitNames = m.items.filter(i => i.area === 'habit').map(i => i.name).sort();
  assert.deepEqual(habitNames, ['Ловить импульс трат → алгоритм', 'Отбой', 'Перестать грызть ногти'].sort());
  const p = m.items.find(i => i.type === 'param');
  assert.equal(p.pkind, 'time');
  assert.equal(p.pvalue, 0);
  assert.equal(p.pstep, -15);
  assert.deepEqual(p.history, [{ date: '2026-01-07', value: 0 }]);
  assert.equal(m.settings.habitSeeded, true);
  assert.deepEqual(m.paramDecided, {});
  assert.equal(m.settings.calendarSince, '2026-01-12'); // v4-экспорт импортируется целиком
  // повторный прогон не сеет второй раз и ничего не меняет
  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again, m);
  assert.equal(again.items.filter(i => i.area === 'habit').length, 3);
});

test('З9: migrate чистит мусор в param-полях и paramDecided', () => {
  setNow(2026, 7, 17, 12, 0);
  const m = app.migrate({
    schemaVersion: 5,
    items: [
      { id: 'p1', name: 'Порог', type: 'param', area: 'min', pkind: 'мусор', pvalue: '90', pstep: '1.6' },
      { id: 'p2', name: 'Число', type: 'param', pkind: 'number', pvalue: 'abc', pstep: -2, unit: 'мин' }
    ],
    days: {}, weekLog: [], reviews: [], pendingRaises: [],
    paramDecided: { p1: { from: 1, to: 2 }, bad1: 'x', bad2: { from: 'y', to: 3 }, keep: { from: 5, to: null } },
    draftOneChange: '', weekStart: '2026-07-13',
    settings: { dayBoundary: 4, calendarSince: '2026-07-13', habitSeeded: true }
  });
  const p1 = m.items.find(i => i.id === 'p1');
  assert.equal(p1.area, 'habit'); // параметры существуют только в привычках
  assert.equal(p1.pkind, 'time');
  assert.equal(p1.pvalue, 90);    // числовая строка приведена
  assert.equal(p1.pstep, 2);      // округление
  const p2 = m.items.find(i => i.id === 'p2');
  assert.equal(p2.pvalue, 0);     // мусор → 0
  assert.deepEqual(Object.keys(m.paramDecided).sort(), ['keep', 'p1']);
});

test('З9: applyParamStep/keepParam — guard-матрица, одно решение, срез params', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const p = s.items.find(i => i.type === 'param'); // «Отбой»: time, 00:00, −15
  const habit = s.items.find(i => i.type === 'daily' && i.area === 'habit');

  assert.equal(app.applyParamStep('нет-такого'), false); // несуществующий
  assert.equal(app.applyParamStep(habit.id), false);     // не param
  p.active = false;
  assert.equal(app.applyParamStep(p.id), false);         // неактивный
  p.active = true;

  s.settings.calendarSince = app.currentWeekStart();     // разбор недоступен
  assert.equal(app.applyParamStep(p.id), false);
  assert.equal(app.keepParam(p.id), false);
  calendarPast(s);

  assert.equal(app.applyParamStep(p.id), true);          // шаг применяется немедленно
  assert.equal(p.pvalue, 1425);                          // 00:00 − 15 мин = 23:45 (обёртка суток)
  assert.deepEqual(s.paramDecided[p.id], { from: 0, to: 1425 });
  assert.deepEqual(p.history[p.history.length - 1], { date: app.todayKey(), value: 1425 });
  assert.equal(app.applyParamStep(p.id), false);          // второе решение за разбор — нет
  assert.equal(app.keepParam(p.id), false);

  // «оставить» на числовом параметре
  s.items.push({
    id: 'pn', name: 'Шаги', value: null, unit: 'шаг.', type: 'param', area: 'habit',
    pkind: 'number', pvalue: 4000, pstep: 500, goal: null, note: '', group: '', active: true,
    addedAt: app.todayKey(), raiseAfter: 0, history: []
  });
  assert.equal(app.keepParam('pn'), true);
  assert.deepEqual(s.paramDecided.pn, { from: 4000, to: null });
  assert.equal(s.items.find(i => i.id === 'pn').pvalue, 4000); // порог не изменился
  assert.equal(app.applyParamStep('pn'), false); // решение уже принято

  // закрытие: params в срезе, paramDecided очищен
  app.closeWeek();
  const r = s.reviews[s.reviews.length - 1];
  const byId = Object.fromEntries(r.params.map(x => [x.id, x]));
  assert.deepEqual(byId[p.id], { id: p.id, from: 0, to: 1425 });
  assert.deepEqual(byId.pn, { id: 'pn', from: 4000, to: null });
  assert.deepEqual(s.paramDecided, {});
});

test('З9: fmtParam — время и число', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const p = s.items.find(i => i.type === 'param');
  assert.equal(app.fmtParam(p), '00:00');
  assert.equal(app.fmtParam(p, 1425), '23:45');
  assert.equal(app.fmtParam(p, 90), '01:30');
  assert.equal(app.fmtParam({ pkind: 'number', pvalue: 4000, unit: 'шаг.' }), '4000 шаг.');
  assert.equal(app.fmtParam({ pkind: 'number', pvalue: 7, unit: '' }), '7');
});

test('З9: повышение игнорирует привычки; ретро-отметка работает, параметр — нет', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const habit = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  habit.value = 5; // даже с числом и идеальными неделями
  s.reviews = [fakeReview(habit, 7), fakeReview(habit, 7), fakeReview(habit, 7)];
  assert.equal(app.raiseEligible(habit), false); // area habit — повышения нет

  habit.addedAt = app.addDays(app.todayKey(), -5);
  assert.equal(app.markYesterday(habit.id), true); // ретро-отметка привычки
  assert.equal(app.isMarked(app.addDays(app.todayKey(), -1), habit.id), true);

  const p = s.items.find(i => i.type === 'param');
  p.addedAt = app.addDays(app.todayKey(), -5);
  assert.equal(app.markYesterday(p.id), false); // параметр без ежедневных отметок
});

test('З9: habitsSteady — 2 недели все активные привычки ≥6/7', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const [h1, h2] = s.items.filter(i => i.type === 'daily' && i.area === 'habit');
  const wk = (c1, c2) => ({ perItem: { [h1.id]: { count: c1 }, [h2.id]: { count: c2 } } });
  assert.equal(app.habitsSteady(), false); // разборов нет
  s.reviews = [wk(6, 7)];
  assert.equal(app.habitsSteady(), false); // одной недели мало
  s.reviews = [wk(6, 7), wk(7, 6)];
  assert.equal(app.habitsSteady(), true);
  s.reviews = [wk(6, 7), wk(5, 7)];
  assert.equal(app.habitsSteady(), false); // 5/7 ломает готовность
  h2.active = false;
  s.reviews = [wk(6, 0), wk(7, 0)];
  assert.equal(app.habitsSteady(), true);  // выключенная не учитывается
  h1.active = false;
  assert.equal(app.habitsSteady(), false); // активных привычек нет
});

/* ── Задача 7. Ретро-отметка и «одно изменение» ────────────── */

test('З7: markYesterday — матрица guard\'ов, запись ровно во вчера, повтор — false', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const y = app.addDays(t, -1);
  const item = s.items.find(i => i.name === 'Умыться');
  const weekly = s.items.find(i => i.type === 'weekly');
  const inactive = s.items.find(i => i.name === 'Развитие');

  assert.equal(app.markYesterday('нет-такого-id'), false); // несуществующий пункт
  assert.equal(app.markYesterday(item.id), false);         // добавлен сегодня — вчера не существовал

  item.addedAt = y;
  weekly.addedAt = app.addDays(t, -5);
  assert.equal(app.markYesterday(weekly.id), false);       // weekly не отмечается
  inactive.addedAt = app.addDays(t, -5);
  inactive.active = false;
  assert.equal(app.markYesterday(inactive.id), false);     // неактивный

  assert.equal(app.markYesterday(item.id), true);
  assert.equal(app.isMarked(y, item.id), true);            // ровно вчерашний ключ
  assert.equal(app.isMarked(t, item.id), false);
  assert.equal(app.missedYesterday(item, t), false);       // точка исчезнет

  assert.equal(app.markYesterday(item.id), false);         // повторный вызов — false
  assert.equal(app.isMarked(y, item.id), true);            // и отметка не снята
});

test('З7: currentOneChange — null без записей, при пустоте и пробелах; trim', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  assert.equal(app.currentOneChange(), null);          // нет reviews
  s.reviews.push({ oneChange: '' });
  assert.equal(app.currentOneChange(), null);          // пусто
  s.reviews.push({ oneChange: '   ' });
  assert.equal(app.currentOneChange(), null);          // пробелы
  s.reviews.push({});
  assert.equal(app.currentOneChange(), null);          // поля нет
  s.reviews.push({ oneChange: '  меньше сахара  ' });
  assert.equal(app.currentOneChange(), 'меньше сахара'); // trim, берётся последний
});

/* ── Инвариант 7. «Не пропускай дважды» ────────────────────── */

test('И7: точка-маркер — пункт существовал вчера и не был отмечен', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const it = s.items[0]; // addedAt = сегодня

  // добавлен сегодня — точки нет
  assert.equal(app.missedYesterday(it, t), false);

  // существовал вчера и не отмечен — точка есть
  it.addedAt = app.addDays(t, -1);
  assert.equal(app.missedYesterday(it, t), true);

  // давно добавлен — тоже есть (сегодняшняя отметка не влияет)
  it.addedAt = app.addDays(t, -30);
  app.toggleMark(t, it.id);
  assert.equal(app.missedYesterday(it, t), true);

  // отмечен вчера — точки нет
  app.toggleMark(app.addDays(t, -1), it.id);
  assert.equal(app.missedYesterday(it, t), false);
});
