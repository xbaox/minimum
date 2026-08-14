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

/* Ровно count отметок в календарной неделе mon (задача 16C: механика
   планки считает по days{}, а не по массиву reviews). Не toggle, а
   установка состояния — вызывать можно повторно с любым count. */
function setWeekMarks(itemId, mon, count) {
  for (let i = 0; i < 7; i++) {
    const k = app.addDays(mon, i);
    if (app.isMarked(k, itemId) !== (i < count)) app.toggleMark(k, itemId);
  }
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

test('И4: три закрытые календарные недели ≥6/7 дают предложение — без единого разбора', () => {
  setNow(2026, 7, 1, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания'); // value: 5
  const W = app.closedWeeks(3);
  assert.equal(W.length, 3);

  setWeekMarks(item.id, W[1], 6);
  setWeekMarks(item.id, W[2], 6);
  assert.equal(app.raiseEligible(item), false, 'двух недель мало');

  setWeekMarks(item.id, W[0], 6);
  assert.equal(app.raiseEligible(item), true);
  // регрессия задачи 16C: механика считает по days{}, массив reviews не
  // участвует — пропущенные разборы её больше не блокируют
  assert.deepEqual(s.reviews, []);
  assert.equal(app.raiseSuggest(item.value), 6); // 5 → 6

  // и наоборот: закрытые разборы права не дают, если недели не набраны
  setWeekMarks(item.id, W[0], 5);
  s.reviews = [{ week: W[0] }, { week: W[1] }, { week: W[2] }];
  assert.equal(app.raiseEligible(item), false);
});

test('И4: якорь — понедельник недели решения; нужны три недели строго после него', () => {
  setNow(2026, 7, 1, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  for (const w of app.closedWeeks(3)) setWeekMarks(item.id, w, 6);
  assert.equal(app.raiseEligible(item), true);

  app.resetRaiseCount(item); // «Не сейчас»
  const anchor = app.currentWeekStart();
  assert.equal(item.raiseAfterWeek, anchor);
  assert.equal(app.raiseEligible(item), false);

  // неделя решения в тройку не годится — нужны три следующие за ней
  for (let i = 0; i < 4; i++) {
    advanceDays(7);
    setWeekMarks(item.id, app.addDays(anchor, 7 * i), 6);
    if (i < 3) assert.equal(app.raiseEligible(item), false, 'неделя решения ещё в тройке');
  }
  assert.equal(app.raiseEligible(item), true);
  assert.equal(app.closedWeeks(3)[0], app.addDays(anchor, 7), 'тройка строго после якоря');
});

test('И4: неделя с 5 отметками в тройке последних ломает право на повышение', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  const W = app.closedWeeks(3);

  setWeekMarks(item.id, W[0], 6);
  setWeekMarks(item.id, W[1], 7);
  setWeekMarks(item.id, W[2], 5);
  assert.equal(app.raiseEligible(item), false, 'провал в последней неделе тройки');

  setWeekMarks(item.id, W[2], 6);
  setWeekMarks(item.id, W[1], 5);
  assert.equal(app.raiseEligible(item), false, 'и в середине тройки');

  setWeekMarks(item.id, W[1], 6);
  assert.equal(app.raiseEligible(item), true);
  // четвёртая неделя назад в счёт не идёт: считаются 3 ПОСЛЕДНИЕ закрытые
  setWeekMarks(item.id, app.addDays(W[0], -7), 0);
  assert.equal(app.raiseEligible(item), true);
});

test('И4: повышение — активный дневной пункт минимума с числовой планкой и без лестницы', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  const noValue = s.items.find(i => i.name === 'Умыться');   // value: null
  const weekly = s.items.find(i => i.type === 'weekly');
  const habit = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  habit.value = 5;
  for (const w of app.closedWeeks(3)) {
    for (const x of [item, noValue, weekly, habit]) setWeekMarks(x.id, w, 7);
  }

  assert.equal(app.raiseEligible(noValue), false); // нет числовой планки
  assert.equal(app.raiseEligible(weekly), false);  // недельный тип
  assert.equal(app.raiseEligible(habit), false);   // область привычек
  item.active = false;
  assert.equal(app.raiseEligible(item), false);    // выключен
  item.active = true;
  assert.equal(app.raiseEligible(item), true);

  // лестница на пункте гасит предложение: шаг ступени и шаг планки в одну
  // неделю — два изменения за раз (C.1.7)
  app.setLadder(item.id, 'первая\nвторая');
  assert.equal(app.raiseEligible(item), false);
  app.clearLadder(item.id);
  assert.equal(app.raiseEligible(item), true);
});

test('И4: raiseSuggest — +1 до 12 включительно, дальше +10% с округлением', () => {
  assert.equal(app.raiseSuggest(5), 6);
  assert.equal(app.raiseSuggest(12), 13);
  assert.equal(app.raiseSuggest(13), 14);   // round(14.3)
  assert.equal(app.raiseSuggest(20), 22);
  assert.equal(app.raiseSuggest(500), 550);
});

test('И4: accept — history, pendingRaises, якорь недели и попадание в разбор', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  for (const w of app.closedWeeks(3)) setWeekMarks(item.id, w, 6);
  assert.equal(app.raiseEligible(item), true);

  app.acceptRaise(item, 6);

  assert.equal(item.value, 6);
  assert.deepEqual(item.history[item.history.length - 1], { date: app.todayKey(), value: 6 });
  assert.deepEqual(s.pendingRaises, [{ itemId: item.id, name: item.name, from: 5, to: 6 }]);
  assert.equal(item.raiseAfterWeek, app.currentWeekStart());
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

  assert.equal(m.schemaVersion, 13);
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
  // мёртвое поле подсказки не достраивается
  assert.equal('hintShownForItemId' in m.settings, false);
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
    assert.equal(m.schemaVersion, 13);
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
  assert.equal(m.schemaVersion, 13);
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
  assert.equal(m.schemaVersion, 13);
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
  assert.equal(m.schemaVersion, 13);
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
    paramDecided: {
      p1: { week: '2026-07-06', from: 1, to: 2 },
      bad1: 'x',
      bad2: { week: '2026-07-06', from: 'y', to: 3 },
      noWeek: { from: 5, to: 6 },                  // решение без привязки к неделе отбрасывается
      badWeek: { week: 'мусор', from: 5, to: 6 },
      keep: { week: '2026-07-06', from: 5, to: null }
    },
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
  const W = app.previousWeekStart(); // разбираемая неделя — привязка решений
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
  assert.deepEqual(s.paramDecided[p.id], { week: W, from: 0, to: 1425 });
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
  assert.deepEqual(s.paramDecided.pn, { week: W, from: 4000, to: null });
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
  for (const w of app.closedWeeks(3)) markWeek(habit.id, w, 7);
  assert.equal(app.raiseEligible(habit), false); // area habit — повышения нет

  habit.addedAt = app.addDays(app.todayKey(), -5);
  assert.equal(app.markYesterday(habit.id), true); // ретро-отметка привычки
  assert.equal(app.isMarked(app.addDays(app.todayKey(), -1), habit.id), true);

  const p = s.items.find(i => i.type === 'param');
  p.addedAt = app.addDays(app.todayKey(), -5);
  assert.equal(app.markYesterday(p.id), false); // параметр без ежедневных отметок
});

test('З9/З11: habitsSteady — 2 недели каждая активная привычка выполнила норму', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const [h1, h2] = s.items.filter(i => i.type === 'daily' && i.area === 'habit');
  const wk = (c1, c2) => ({ perItem: { [h1.id]: { count: c1 }, [h2.id]: { count: c2 } } });
  assert.equal(app.habitsSteady(), false); // разборов нет
  s.reviews = [wk(7, 7)];
  assert.equal(app.habitsSteady(), false); // одной недели мало
  s.reviews = [wk(7, 7), wk(7, 7)];
  assert.equal(app.habitsSteady(), true);  // норма по умолчанию 7
  s.reviews = [wk(6, 7), wk(7, 7)];
  assert.equal(app.habitsSteady(), false); // 6 < норма 7
  h1.normPerWeek = 5;
  assert.equal(app.habitsSteady(), true);  // норма 5: 6 и 7 достаточно
  s.reviews = [wk(4, 7), wk(7, 7)];
  assert.equal(app.habitsSteady(), false); // 4 < 5
  h2.active = false;
  s.reviews = [wk(5, 0), wk(7, 0)];
  assert.equal(app.habitsSteady(), true);  // выключенная не учитывается
  h1.active = false;
  assert.equal(app.habitsSteady(), false); // активных привычек нет
});

/* ── Задача 11. Норма и серия привычек (инвариант 11) ──────── */

/* Отметить привычке первые count дней недели с понедельником mon */
/* Отметить первые count дней недели toggle'ом — от чистого листа.
   Для повторной установки состояния есть setWeekMarks выше. */
function markWeek(id, mon, count) {
  for (let i = 0; i < count; i++) app.toggleMark(app.addDays(mon, i), id);
}

test('З11: серия при ровно норме; провал в середине обрывает счёт', () => {
  setNow(2026, 7, 17, 12, 0); // пятница, текущая неделя — с 2026-07-13
  const s = freshStore();
  calendarPast(s);
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  const prev = app.previousWeekStart();
  markWeek(h.id, prev, 7);                   // W−1: ровно норма
  markWeek(h.id, app.addDays(prev, -7), 7);  // W−2: норма
  markWeek(h.id, app.addDays(prev, -14), 6); // W−3: 6 из 7 — провал при норме 7
  markWeek(h.id, app.addDays(prev, -21), 7); // W−4: норма, но за провалом
  assert.equal(app.habitStreak(h), 2); // первый провал обрывает счёт
  assert.equal(app.habitWeekCount(h, prev), 7);
});

test('З11: текущая неделя не входит — тап сегодня серию не меняет', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  markWeek(h.id, app.previousWeekStart(), 7);
  assert.equal(app.habitStreak(h), 1);
  app.toggleMark(app.todayKey(), h.id); // сегодняшний тап
  assert.equal(app.habitStreak(h), 1);  // серия не изменилась
  assert.equal(app.habitWeekCount(h, app.currentWeekStart()), 1); // а счёт текущей недели — да
  app.toggleMark(app.todayKey(), h.id); // снятие — тоже не меняет серию
  assert.equal(app.habitStreak(h), 1);
});

test('З11: граница недели пн 04:00 — серия прирастает в момент смены недели', () => {
  setNow(2026, 7, 13, 12, 0); // понедельник, неделя 2026-07-13
  const s = freshStore();
  calendarPast(s);
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  const W = app.currentWeekStart();
  markWeek(h.id, W, 7); // вся неделя W отмечена
  assert.equal(app.habitStreak(h), 0); // текущая неделя не в счёт

  setNow(2026, 7, 20, 3, 30); // понедельник 03:30 — логически ещё воскресенье W
  assert.equal(app.currentWeekStart(), W);
  assert.equal(app.habitStreak(h), 0);

  setNow(2026, 7, 20, 4, 0); // 04:00 — новая неделя, W завершена
  assert.equal(app.currentWeekStart(), app.addDays(W, 7));
  assert.equal(app.habitStreak(h), 1);
});

test('З11: норма 5 — 5 из 7 засчитывается; смена нормы ретроактивна', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  const prev = app.previousWeekStart();
  markWeek(h.id, prev, 5);
  markWeek(h.id, app.addDays(prev, -7), 5);
  assert.equal(app.habitStreak(h), 0); // при норме 7 недели не выполнены
  h.normPerWeek = 5;
  assert.equal(app.habitStreak(h), 2); // ретроактивный пересчёт всей истории
  h.normPerWeek = 6;
  assert.equal(app.habitStreak(h), 0);
});

test('З11: серия обрывается на calendarSince — недели до эпохи не считаются', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  // эпоха начинается ровно с недели W−1: недель до неё в серии быть не может
  s.settings.calendarSince = prev;
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  h.normPerWeek = 1;
  // отмечено по обе стороны границы эпохи (по одному дню в каждой из W−1..W−4)
  for (let w = 0; w < 4; w++) app.toggleMark(app.addDays(prev, -7 * w), h.id);
  assert.equal(app.habitStreak(h), 1); // только W−1 внутри эпохи; W−2..W−4 до calendarSince не в счёт
  assert.equal(app.habitStreakFrom(h, prev), 1);
});

test('З11: неполная неделя создания обрывает счёт без спецобработки', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  const prev = app.previousWeekStart();
  h.addedAt = app.addDays(prev, -3); // пятница недели W−2
  markWeek(h.id, prev, 7); // W−1: полная
  for (let i = 4; i < 7; i++) app.toggleMark(app.addDays(prev, -7 + i), h.id); // W−2: пт–вс, 3 отметки
  assert.equal(app.habitStreak(h), 1); // неделя создания просто не набрала норму
});

test('З11: миграция v6 — норма достроена и валидируется, days и reviews не тронуты', () => {
  setNow(2026, 7, 17, 12, 0);
  const days = { '2026-07-10': { h1: true }, '2026-07-11': { h1: true } };
  const reviews = [{ closedAt: 1, week: '2026-07-06', keys: [], perItem: { h1: { count: 2 } }, trainings: {}, oneChange: '', raises: [], params: [] }];
  const v5 = {
    schemaVersion: 5,
    items: [
      { id: 'h1', name: 'Привычка', type: 'daily', area: 'habit', addedAt: '2026-07-01' },
      { id: 'h2', name: 'Норма-мусор', type: 'daily', area: 'habit', addedAt: '2026-07-01', normPerWeek: 'мусор' },
      { id: 'h3', name: 'Ниже диапазона', type: 'daily', area: 'habit', addedAt: '2026-07-01', normPerWeek: 0 },
      { id: 'h4', name: 'Выше диапазона', type: 'daily', area: 'habit', addedAt: '2026-07-01', normPerWeek: 9 },
      { id: 'h5', name: 'Не целое', type: 'daily', area: 'habit', addedAt: '2026-07-01', normPerWeek: 3.6 },
      { id: 'm1', name: 'Минимум', type: 'daily', area: 'min', addedAt: '2026-07-01', normPerWeek: 5 },
      { id: 'p1', name: 'Порог', type: 'param', area: 'habit', pkind: 'time', pvalue: 0, pstep: -15, addedAt: '2026-07-01' }
    ],
    days: JSON.parse(JSON.stringify(days)),
    weekLog: [], reviews: JSON.parse(JSON.stringify(reviews)), pendingRaises: [], paramDecided: {},
    draftOneChange: '', weekStart: '2026-07-01',
    settings: { dayBoundary: 4, calendarSince: '2026-07-06', habitSeeded: true, exportedAt: null }
  };
  const m = app.migrate(v5);
  assert.equal(m.schemaVersion, 13);
  assert.equal(m.items.find(i => i.id === 'h1').normPerWeek, 7); // достроена умолчанием
  assert.equal(m.items.find(i => i.id === 'h2').normPerWeek, 7); // мусор → умолчание
  assert.equal(m.items.find(i => i.id === 'h3').normPerWeek, 1); // к ближайшему допустимому
  assert.equal(m.items.find(i => i.id === 'h4').normPerWeek, 7);
  assert.equal(m.items.find(i => i.id === 'h5').normPerWeek, 4); // округление
  assert.equal('normPerWeek' in m.items.find(i => i.id === 'm1'), false); // норма — только у привычек
  assert.equal('normPerWeek' in m.items.find(i => i.id === 'p1'), false);
  assert.deepEqual(m.days, days);       // отметки не изменены (миграция аддитивна)
  assert.deepEqual(m.reviews, reviews); // срезы не изменены
  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again, m); // идемпотентность
});

/* ── Задача 10. Доводка: привязка решений к неделе, дубли разборов ── */

test('З10: решение по параметру принадлежит неделе — чужое игнорируется, новое возможно', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const p = s.items.find(i => i.type === 'param'); // «Отбой»: time, 00:00, −15
  const W = app.previousWeekStart();
  assert.equal(app.applyParamStep(p.id), true);
  assert.deepEqual(s.paramDecided[p.id], { week: W, from: 0, to: 1425 });
  assert.deepEqual(app.paramDecision(p.id), { week: W, from: 0, to: 1425 });
  assert.equal(app.applyParamStep(p.id), false);  // второе решение той же недели — нет

  advanceDays(7); // неделя W не закрыта — разбирается уже W+7
  assert.equal(app.reviewDue(), true);
  assert.equal(app.paramDecision(p.id), null);    // решение недели W — как отсутствие
  assert.equal(app.keepParam(p.id), true);        // новое решение принимается
  assert.deepEqual(s.paramDecided[p.id], { week: app.addDays(W, 7), from: 1425, to: null });
});

test('З10: closeWeek — решение чужой недели не попадает в срез, paramDecided очищен целиком', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const p = s.items.find(i => i.type === 'param');
  const W = app.previousWeekStart();
  app.applyParamStep(p.id); // решение недели W
  advanceDays(7);           // W не закрыта; решение W осталось лежать в paramDecided
  assert.equal(app.closeWeek(), true);
  const r = s.reviews[s.reviews.length - 1];
  assert.equal(r.week, app.addDays(W, 7));
  assert.deepEqual(r.params, []);       // решение недели W в срез W+7 не попало
  assert.deepEqual(s.paramDecided, {}); // но вычищено закрытием целиком
});

test('З10: reviewDue — week разобранной недели ищется по всем reviews, не только последней', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  // разобранная неделя записана не последним элементом: после неё — скользящая запись
  s.reviews.push({ week: prev }, { weekStart: '2026-06-01' });
  assert.equal(app.reviewDue(), false);
  assert.equal(app.closeWeek(), false); // guard закрытия держит тоже
  assert.equal(s.reviews.length, 2);
});

test('З10: hintShownForItemId мёртв — нет в defaultStore, v5-миграция вычищает', () => {
  setNow(2026, 7, 17, 12, 0);
  assert.equal('hintShownForItemId' in app.defaultStore().settings, false);
  const m = app.migrate({
    schemaVersion: 4, items: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], draftOneChange: '', weekStart: '2026-07-13',
    settings: { dayBoundary: 4, hintShownForItemId: 'x1', exportedAt: null }
  });
  assert.equal(m.schemaVersion, 13);
  assert.equal('hintShownForItemId' in m.settings, false);
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

/* ── Задача 14. Формула и лестница (инвариант 12) ──────────── */

/* Привычка с двумя завершёнными неделями по норме — база для шага вперёд */
function ladderReadyHabit() {
  const s = freshStore();
  calendarPast(s);
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  const prev = app.previousWeekStart();
  markWeek(h.id, prev, 7);
  markWeek(h.id, app.addDays(prev, -7), 7);
  return { s, h };
}

test('З14: activeLadderItem — пусто, вторая лестница невозможна, снятие освобождает слот', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const [a, b] = s.items.filter(i => i.type === 'daily' && i.area === 'min');

  assert.equal(app.activeLadderItem(), null); // свежий store — лестницы нет ни у кого

  assert.equal(app.setLadder(a.id, 'раз\nдва'), true);
  assert.equal(app.activeLadderItem().id, a.id);
  assert.equal(app.ladderBlockedBy(a), null);   // для носителя слот не занят
  assert.equal(app.ladderBlockedBy(b).id, a.id);

  assert.equal(app.setLadder(b.id, 'три'), false); // вторую создать нельзя
  assert.equal(b.ladder, null);
  assert.equal(app.activeLadderItem().id, a.id);

  assert.equal(app.clearLadder(a.id), true);
  assert.equal(app.activeLadderItem(), null);
  assert.equal(app.setLadder(b.id, 'три\nчетыре'), true); // слот освободился
  assert.equal(app.activeLadderItem().id, b.id);
});

test('З14: шаг вперёд — критерий двух недель, одна неделя на шаг, последняя ступень', () => {
  setNow(2026, 7, 17, 12, 0);
  const { s, h } = ladderReadyHabit();
  const prev = app.previousWeekStart();
  app.setLadder(h.id, 'раз\nдва\nтри');

  assert.equal(app.canStepForward(h), true);
  assert.equal(app.ladderStatus(h), 'Ступень держится две недели — можно шагнуть');

  // недобор нормы хотя бы в одной из двух недель закрывает шаг
  app.toggleMark(prev, h.id); // W−1 стала 6 из 7 при норме 7
  assert.equal(app.canStepForward(h), false);
  assert.equal(app.ladderStatus(h), 'Две полные недели нормы ещё не набраны');
  app.toggleMark(prev, h.id);
  app.toggleMark(app.addDays(prev, -7), h.id); // теперь недобор в W−2
  assert.equal(app.canStepForward(h), false);
  app.toggleMark(app.addDays(prev, -7), h.id);
  assert.equal(app.canStepForward(h), true);

  // успешный шаг: индекс вперёд и неделя отмечена
  assert.equal(app.ladderStep(h.id, 'fwd'), true);
  assert.equal(h.ladder.step, 1);
  assert.equal(h.ladder.steppedWeek, app.currentWeekStart());

  // второй шаг на той же неделе недоступен
  assert.equal(app.canStepForward(h), false);
  assert.equal(app.ladderStatus(h), 'Шаг уже сделан на этой неделе');
  assert.equal(app.ladderStep(h.id, 'fwd'), false);
  assert.equal(h.ladder.step, 1);

  // новая неделя открывает шаг снова; на последней ступени шага нет
  advanceDays(7);
  markWeek(h.id, app.previousWeekStart(), 7); // прошедшая неделя тоже по норме
  assert.equal(app.canStepForward(h), true);
  assert.equal(app.ladderStep(h.id, 'fwd'), true);
  assert.equal(h.ladder.step, 2);
  assert.equal(app.canStepForward(h), false);
  assert.equal(app.ladderStatus(h), 'Последняя ступень');
  assert.equal(s.items.find(i => i.id === h.id).ladder.step, 2);
});

test('З14: шаг вперёд у минимума — норма 6 из 7', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const m = s.items.find(i => i.type === 'daily' && i.area === 'min');
  const prev = app.previousWeekStart();
  app.setLadder(m.id, 'раз\nдва');
  assert.equal(app.ladderNorm(m), 6);

  markWeek(m.id, prev, 6);
  markWeek(m.id, app.addDays(prev, -7), 5);
  assert.equal(app.canStepForward(m), false); // 5 из 7 в W−2
  app.toggleMark(app.addDays(prev, -7 + 5), m.id); // добор до 6
  assert.equal(app.canStepForward(m), true);
});

test('З14: шаг назад — всегда при step > 0, steppedWeek не меняется, на нуле недоступен', () => {
  setNow(2026, 7, 17, 12, 0);
  const { h } = ladderReadyHabit();
  app.setLadder(h.id, 'раз\nдва\nтри');
  app.ladderStep(h.id, 'fwd');
  const week = h.ladder.steppedWeek;
  assert.equal(h.ladder.step, 1);

  assert.equal(app.canStepBack(h), true);
  assert.equal(app.ladderStep(h.id, 'back'), true);
  assert.equal(h.ladder.step, 0);
  assert.equal(h.ladder.steppedWeek, week); // шаг назад неделю не тратит

  assert.equal(app.canStepBack(h), false);
  assert.equal(app.ladderStep(h.id, 'back'), false);
  assert.equal(h.ladder.step, 0);

  // критериев у шага назад нет: без единой отметки он всё равно доступен
  const s2 = freshStore();
  const it = s2.items.find(i => i.type === 'daily');
  app.setLadder(it.id, 'а\nб\nв');
  it.ladder.step = 2;
  assert.equal(app.canStepForward(it), false); // недель нет вовсе
  assert.equal(app.ladderStep(it.id, 'back'), true);
  assert.equal(it.ladder.step, 1);
});

test('З14.2: ladderLog — старт при создании, замена в тот же день, старт неприкосновенен', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const it = s.items.find(i => i.type === 'daily');
  const day1 = app.todayKey();

  // создание пишет стартовую запись
  app.setLadder(it.id, 'раз\nдва\nтри\nчетыре');
  assert.deepEqual(it.ladderLog, [{ date: day1, step: 0, text: 'раз', start: true }]);

  // шаг в тот же день не затирает старт — записей становится две
  it.ladder.step = 3;
  app.ladderStep(it.id, 'back'); // → «три»
  assert.equal(it.ladderLog.length, 2);
  assert.deepEqual(it.ladderLog[0], { date: day1, step: 0, text: 'раз', start: true });
  assert.deepEqual(it.ladderLog[1], { date: day1, step: 2, text: 'три' });

  // второй шаг того же дня заменяет уже нестартовую запись
  app.ladderStep(it.id, 'back');
  assert.equal(it.ladderLog.length, 2);
  assert.deepEqual(it.ladderLog[1], { date: day1, step: 1, text: 'два' });

  advanceDays(1);
  app.ladderStep(it.id, 'back'); // новый день: новая запись
  assert.equal(it.ladderLog.length, 3);
  assert.deepEqual(it.ladderLog[2], { date: app.todayKey(), step: 0, text: 'раз' });

  // снятие журнал не изменяет, повторное создание пишет новый старт
  const before = JSON.stringify(it.ladderLog);
  assert.equal(app.clearLadder(it.id), true);
  assert.equal(JSON.stringify(it.ladderLog), before);
  assert.equal(app.setLadder(it.id, 'а\nб'), true);
  assert.equal(it.ladderLog.length, 4);
  assert.deepEqual(it.ladderLog[3], { date: app.todayKey(), step: 0, text: 'а', start: true });
});

test('З14: снятие лестницы не трогает days, history и ladderLog', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const it = s.items.find(i => i.name === 'Пешком'); // несёт history планки
  markWeek(it.id, app.previousWeekStart(), 4);
  app.toggleMark(app.todayKey(), it.id);
  app.setLadder(it.id, 'раз\nдва');
  it.ladder.step = 1;
  app.ladderStep(it.id, 'back');

  const daysBefore = JSON.stringify(s.days);
  const histBefore = JSON.stringify(it.history);
  const logBefore = JSON.stringify(it.ladderLog);

  assert.equal(app.clearLadder(it.id), true);

  assert.equal(it.ladder, null);
  assert.equal(JSON.stringify(s.days), daysBefore);
  assert.equal(JSON.stringify(it.history), histBefore);
  assert.equal(JSON.stringify(it.ladderLog), logBefore);
  assert.equal(app.clearLadder(it.id), false); // снимать нечего
});

test('З14: правка ступеней не сбрасывает step и подтягивает его в границы', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const it = s.items.find(i => i.type === 'daily');
  app.setLadder(it.id, 'а\nб\nв\nг');
  it.ladder.step = 3;

  app.setLadder(it.id, 'а\nб\nв\nг\nд'); // список вырос — индекс на месте
  assert.equal(it.ladder.step, 3);

  app.setLadder(it.id, ' а \n\n б \n'); // пустые строки отбрасываются, список короче
  assert.deepEqual(it.ladder.steps, ['а', 'б']);
  assert.equal(it.ladder.step, 1); // step = steps.length − 1

  app.setLadder(it.id, 'а\nб\nв'); // возврат длины — индекс не сбрасывается
  assert.equal(it.ladder.step, 1);

  // пустой текст — лестницы нет (как пустая формула — null)
  assert.equal(app.setLadder(it.id, '   \n  '), true);
  assert.equal(it.ladder, null);
});

test('З14: closedWeeks — текущая не входит, эпоха ограничивает, при нехватке короче n', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const cur = app.currentWeekStart();

  assert.deepEqual(app.closedWeeks(3),
    [app.addDays(cur, -21), app.addDays(cur, -14), app.addDays(cur, -7)]); // по возрастанию
  assert.equal(app.closedWeeks(3).includes(cur), false); // текущая не входит

  s.settings.calendarSince = app.addDays(cur, -14);
  assert.deepEqual(app.closedWeeks(5), [app.addDays(cur, -14), app.addDays(cur, -7)]); // меньше n
  s.settings.calendarSince = cur;
  assert.deepEqual(app.closedWeeks(3), []); // завершённых недель эпохи ещё нет

  s.settings.calendarSince = app.addDays(cur, 7); // переходные дни: недель нет вовсе
  assert.deepEqual(app.closedWeeks(2), []);
});

test('З14: itemWeekCount — совпадает с habitWeekCount и считает пункты минимума', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  const m = s.items.find(i => i.type === 'daily' && i.area === 'min');

  markWeek(h.id, prev, 5);
  markWeek(m.id, prev, 6);
  assert.equal(app.itemWeekCount(h, prev), app.habitWeekCount(h, prev));
  assert.equal(app.itemWeekCount(h, prev), 5);
  assert.equal(app.itemWeekCount(m, prev), 6);
  assert.equal(app.itemWeekCount(m, app.addDays(prev, -7)), 0); // чужая неделя
  assert.equal(app.itemWeekCount(m, app.currentWeekStart()), 0);
});

test('З14: миграция v6→v7 — поля достроены, лестница одна, days и reviews не тронуты', () => {
  setNow(2026, 7, 17, 12, 0);
  const days = { '2026-07-10': { i1: true }, '2026-07-11': { i1: true } };
  const reviews = [{ closedAt: 1, week: '2026-07-06', keys: [], perItem: { i1: { count: 2 } }, trainings: {}, oneChange: '', raises: [], params: [] }];
  const v6 = {
    schemaVersion: 6,
    items: [
      { id: 'i1', name: 'Без новых полей', type: 'daily', area: 'min', addedAt: '2026-07-01' },
      { id: 'i2', name: 'Мусор в полях', type: 'daily', area: 'min', addedAt: '2026-07-01',
        formula: 'строка', ladder: 42, ladderLog: 'мусор' },
      { id: 'i3', name: 'Пустая формула', type: 'daily', area: 'min', addedAt: '2026-07-01',
        formula: { anchor: '  ', when: '', proof: null } },
      { id: 'i4', name: 'Первая лестница', type: 'daily', area: 'min', addedAt: '2026-07-01',
        formula: { anchor: '  после зарядки  ', junk: 'выкинуть' },
        ladder: { steps: [' раз ', '', 'два', 5], step: '9', steppedWeek: '2026-07-07', startedAt: 'мусор' },
        ladderLog: [null, { date: 'x', step: 1 }, { date: '2026-07-09', step: '2', text: 'два' }] },
      { id: 'i5', name: 'Вторая лестница', type: 'daily', area: 'min', addedAt: '2026-07-01',
        ladder: { steps: ['а', 'б'], step: 1, steppedWeek: null, startedAt: '2026-07-01' },
        ladderLog: [{ date: '2026-07-08', step: 1, text: 'б' }] }
    ],
    days: JSON.parse(JSON.stringify(days)),
    weekLog: [], reviews: JSON.parse(JSON.stringify(reviews)), pendingRaises: [], paramDecided: {},
    draftOneChange: '', weekStart: '2026-07-01',
    settings: { dayBoundary: 4, calendarSince: '2026-07-06', habitSeeded: true, exportedAt: null }
  };
  const m = app.migrate(v6);
  const byId = Object.fromEntries(m.items.map(i => [i.id, i]));

  assert.equal(m.schemaVersion, 13);
  assert.equal(byId.i1.formula, null);           // достроено умолчанием
  assert.equal(byId.i1.ladder, null);
  assert.deepEqual(byId.i1.ladderLog, []);
  assert.equal(byId.i2.formula, null);           // мусор → пусто
  assert.equal(byId.i2.ladder, null);
  assert.deepEqual(byId.i2.ladderLog, []);
  assert.equal(byId.i3.formula, null);           // все поля пусты после trim
  assert.equal(byId.i4.formula.anchor, 'после зарядки'); // trim, лишние ключи выброшены
  assert.equal('junk' in byId.i4.formula, false);
  assert.equal(byId.i4.formula.proof, '');
  assert.deepEqual(byId.i4.ladder.steps, ['раз', 'два']); // пустые и не-строки выброшены
  assert.equal(byId.i4.ladder.step, 1);          // индекс подтянут в границы
  assert.equal(byId.i4.ladder.steppedWeek, '2026-07-06'); // не-понедельник → свой понедельник
  assert.equal(byId.i4.ladder.startedAt, '2026-07-17');   // мусорная дата → сегодня
  assert.deepEqual(byId.i4.ladderLog, [{ date: '2026-07-09', step: 2, text: 'два' }]);
  assert.equal(byId.i5.ladder, null);            // лестница одна: у i4 startedAt позже (мусор → сегодня)
  assert.deepEqual(byId.i5.ladderLog, [{ date: '2026-07-08', step: 1, text: 'б' }]); // журнал цел

  assert.deepEqual(m.days, days);       // отметки не изменены (миграция аддитивна)
  assert.deepEqual(m.reviews, reviews); // срезы не изменены
  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again, m);           // идемпотентность
});

test('З14.1: конфликт лестниц — побеждает начатая позже, при равенстве первая по порядку', () => {
  setNow(2026, 7, 17, 12, 0);
  const mk = (id, startedAt) => ({
    id, name: id, type: 'daily', area: 'min', addedAt: '2026-07-01',
    ladder: { steps: ['а', 'б'], step: 1, steppedWeek: null, startedAt },
    ladderLog: [{ date: '2026-07-08', step: 1, text: 'б' }]
  });
  const base = extra => ({
    schemaVersion: 7, items: extra, days: {}, weekLog: [], reviews: [], pendingRaises: [],
    paramDecided: {}, draftOneChange: '', weekStart: '2026-07-01',
    settings: { dayBoundary: 4, calendarSince: '2026-07-06', habitSeeded: true, exportedAt: null }
  });

  // лестница у второго пункта начата позже — переживает миграцию, у первого снимается
  const later = app.migrate(base([mk('i1', '2026-07-01'), mk('i2', '2026-07-10')]));
  const byId = Object.fromEntries(later.items.map(i => [i.id, i]));
  assert.equal(byId.i1.ladder, null);
  assert.deepEqual(byId.i2.ladder.steps, ['а', 'б']);
  assert.equal(byId.i2.ladder.step, 1);
  // журналы обоих целы: снятие лестницы их не трогает
  assert.deepEqual(byId.i1.ladderLog, [{ date: '2026-07-08', step: 1, text: 'б' }]);
  assert.deepEqual(byId.i2.ladderLog, [{ date: '2026-07-08', step: 1, text: 'б' }]);

  // равные даты — остаётся первая по порядку items[]
  const tie = app.migrate(base([mk('a1', '2026-07-05'), mk('a2', '2026-07-05'), mk('a3', '2026-07-05')]));
  assert.ok(tie.items.find(i => i.id === 'a1').ladder);
  assert.equal(tie.items.find(i => i.id === 'a2').ladder, null);
  assert.equal(tie.items.find(i => i.id === 'a3').ladder, null);

  // мусорный startedAt нормализуется в сегодня — такая лестница и побеждает
  const junk = app.migrate(base([mk('b1', '2026-07-05'), mk('b2', 'мусор')]));
  assert.equal(junk.items.find(i => i.id === 'b1').ladder, null);
  assert.equal(junk.items.find(i => i.id === 'b2').ladder.startedAt, '2026-07-17');

  // идемпотентность: повторный прогон ничего не меняет
  const again = app.migrate(JSON.parse(JSON.stringify(later)));
  assert.deepEqual(again, later);
});

test('З14.2: миграция v7→v8 — пустому журналу живой лестницы дописывается старт', () => {
  setNow(2026, 7, 17, 12, 0);
  const days = { '2026-07-10': { i1: true } };
  const reviews = [{ closedAt: 1, week: '2026-07-06', keys: [], perItem: {}, trainings: {}, oneChange: '', raises: [], params: [] }];
  // migrate мутирует аргумент — источник каждый раз собирается заново
  const mkV7 = () => ({
    schemaVersion: 7,
    items: [
      { id: 'i1', name: 'С пустым журналом', type: 'daily', area: 'min', addedAt: '2026-07-01',
        ladder: { steps: ['раз', 'два', 'три'], step: 1, steppedWeek: null, startedAt: '2026-07-02' },
        ladderLog: [] },
      { id: 'i2', name: 'Без лестницы', type: 'daily', area: 'min', addedAt: '2026-07-01',
        ladder: null, ladderLog: [] }
    ],
    days: JSON.parse(JSON.stringify(days)),
    weekLog: [], reviews: JSON.parse(JSON.stringify(reviews)), pendingRaises: [], paramDecided: {},
    draftOneChange: '', weekStart: '2026-07-01',
    settings: { dayBoundary: 4, calendarSince: '2026-07-06', habitSeeded: true, exportedAt: null }
  });
  const m = app.migrate(mkV7());
  const byId = Object.fromEntries(m.items.map(i => [i.id, i]));

  assert.equal(m.schemaVersion, 13);
  // старт от startedAt, ступень и текст — те, на которых лестница стоит сейчас
  assert.deepEqual(byId.i1.ladderLog, [{ date: '2026-07-02', step: 1, text: 'два', start: true }]);
  assert.deepEqual(byId.i2.ladderLog, []); // без лестницы журнал не заводится
  assert.deepEqual(m.days, days);          // миграция аддитивна
  assert.deepEqual(m.reviews, reviews);

  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again, m); // идемпотентность: второго старта не появляется

  // непустой журнал не трогается — исходная ступень пути неизвестна
  const withLog = mkV7();
  withLog.items[0].ladderLog = [{ date: '2026-07-09', step: 2, text: 'три' }];
  const m2 = app.migrate(withLog);
  assert.deepEqual(m2.items[0].ladderLog, [{ date: '2026-07-09', step: 2, text: 'три' }]);

  // невалидный startedAt нормализуется в сегодня — старт получает эту дату
  const badDate = mkV7();
  badDate.items[0].ladder.startedAt = 'мусор';
  assert.equal(app.migrate(badDate).items[0].ladderLog[0].date, '2026-07-17');

  // снятой при разрешении конфликта лестнице старт не пишется
  const two = mkV7();
  two.items.push({ id: 'i3', name: 'Позже начата', type: 'daily', area: 'min', addedAt: '2026-07-01',
    ladder: { steps: ['x'], step: 0, steppedWeek: null, startedAt: '2026-07-11' }, ladderLog: [] });
  const m3 = app.migrate(two);
  const b3 = Object.fromEntries(m3.items.map(i => [i.id, i]));
  assert.equal(b3.i1.ladder, null);
  assert.deepEqual(b3.i1.ladderLog, []); // лестницы нет — старта тоже
  assert.deepEqual(b3.i3.ladderLog, [{ date: '2026-07-11', step: 0, text: 'x', start: true }]);

  // экспорт → импорт восстанавливает журнал со стартом
  app.store = m;
  const exported = JSON.stringify(app.store);
  app.store = null;
  const imported = app.migrate(JSON.parse(exported));
  assert.deepEqual(imported, JSON.parse(exported));
  assert.deepEqual(imported.items.find(i => i.id === 'i1').ladderLog,
    [{ date: '2026-07-02', step: 1, text: 'два', start: true }]);
});

test('З14: steppedWeek не-понедельник и v6-экспорт — экспорт → импорт возвращает новые поля', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const it = s.items.find(i => i.type === 'daily');
  app.setFormula(it.id, {
    anchor: '  после зарядки  ', when: '23:30, спальня', pair: '', identity: 'я человек, который ложится вовремя',
    twoMin: '', friction: '', proof: ''
  });
  app.setLadder(it.id, 'раз\nдва\nтри');
  it.ladder.step = 2;
  app.ladderStep(it.id, 'back');

  const exported = JSON.stringify(app.store);         // содержимое файла экспорта
  app.store = null;                                   // «очистка localStorage»
  const imported = app.migrate(JSON.parse(exported)); // путь importJSON
  app.store = imported;

  assert.deepEqual(imported, JSON.parse(exported));   // до байта данных
  const back = imported.items.find(i => i.id === it.id);
  assert.equal(back.formula.anchor, 'после зарядки'); // trim при сохранении
  assert.equal(back.formula.pair, '');
  assert.deepEqual(back.ladder.steps, ['раз', 'два', 'три']);
  assert.equal(back.ladder.step, 1);
  // старт создания + шаг того же дня: флаг start переживает экспорт → импорт
  assert.equal(back.ladderLog.length, 2);
  assert.equal(back.ladderLog[0].start, true);
  assert.equal('start' in back.ladderLog[1], false);
  assert.equal(app.activeLadderItem().id, it.id);     // домен жив после импорта
});

test('З14: формула — только текст владельца, пустая сохраняется как null', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const it = s.items.find(i => i.type === 'daily');
  const param = s.items.find(i => i.type === 'param');

  assert.equal(app.setFormula(it.id, { anchor: '  ', when: '', pair: '', identity: '', twoMin: '', friction: '', proof: '   ' }), true);
  assert.equal(it.formula, null); // все поля пусты после trim

  app.setFormula(it.id, { anchor: 'после зарядки' });
  assert.deepEqual(Object.keys(it.formula), ['anchor', 'when', 'pair', 'identity', 'twoMin', 'friction', 'proof']);
  assert.equal(it.formula.anchor, 'после зарядки');
  assert.equal(it.formula.when, '');

  assert.equal(app.setFormula('нет-такого', { anchor: 'x' }), false);
  assert.equal(app.setFormula(param.id, { anchor: 'x' }), false); // формула — у ежедневных
  assert.equal(app.setLadder(param.id, 'раз'), false);
});

/* ── Задача 15. Группы и цепочки (инвариант 13) ────────────── */

test('З15: миграция v8→v9 — группы в порядке первого появления, идемпотентно', () => {
  setNow(2026, 7, 17, 12, 0);
  const days = { '2026-07-10': { a: true }, '2026-07-11': { b: true } };
  const reviews = [{ closedAt: 1, week: '2026-07-06', keys: [], perItem: {}, trainings: {}, oneChange: '', raises: [], params: [] }];
  const mkV8 = () => ({
    schemaVersion: 8,
    items: [
      { id: 'a', name: 'Первый', type: 'daily', area: 'min', addedAt: '2026-07-01', group: 'Сон' },
      { id: 'b', name: 'Второй', type: 'daily', area: 'min', addedAt: '2026-07-01', group: 'Тело' },
      { id: 'c', name: 'Третий', type: 'daily', area: 'min', addedAt: '2026-07-01', group: 'Сон' },
      { id: 'd', name: 'Без группы', type: 'daily', area: 'min', addedAt: '2026-07-01', group: '  ' }
    ],
    days: JSON.parse(JSON.stringify(days)),
    weekLog: [], reviews: JSON.parse(JSON.stringify(reviews)), pendingRaises: [], paramDecided: {},
    draftOneChange: '', weekStart: '2026-07-01',
    settings: { dayBoundary: 4, calendarSince: '2026-07-06', habitSeeded: true, exportedAt: null }
  });

  const m = app.migrate(mkV8());
  assert.equal(m.schemaVersion, 13);
  assert.deepEqual(m.groups, [{ name: 'Сон' }, { name: 'Тело' }]); // порядок первого появления
  assert.deepEqual(m.days, days);       // миграция аддитивна
  assert.deepEqual(m.reviews, reviews);
  assert.deepEqual(m.items.map(i => i.group), ['Сон', 'Тело', 'Сон', '  ']); // items[] не изменены

  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again, m); // дубликатов не появляется

  // существующий groups не перезаписывается: он идёт первым, недостающие имена
  // из items[] дописываются следом
  const withGroups = mkV8();
  withGroups.groups = [{ name: 'Тело', chain: true }];
  const m2 = app.migrate(withGroups);
  assert.deepEqual(m2.groups, [{ name: 'Тело' }, { name: 'Сон' }]);
  assert.equal(m2.groups.every(g => !('chain' in g)), true, 'поле chain снято у всех записей');

  // v9 → v10: у готового списка снимается только chain, имена из items[]
  // не досбираются — на девятой версии список уже полный
  const v9 = mkV8();
  v9.schemaVersion = 9;
  v9.groups = [{ name: 'Тело', chain: true }];
  assert.deepEqual(app.migrate(v9).groups, [{ name: 'Тело' }]);

  // нормализация: мусор, дубликаты и пустые имена
  const dirty = mkV8();
  dirty.schemaVersion = 10;
  dirty.groups = [null, 'строка', { name: '  Сон  ', chain: 'да' }, { name: 'Сон' }, { name: '   ' }, { name: 'Тело', chain: true }];
  const m3 = app.migrate(dirty);
  assert.deepEqual(m3.groups, [{ name: 'Сон' }, { name: 'Тело' }]); // первый дубль побеждает, chain снят

  // идемпотентность шага v9→v10: повторный прогон ничего не возвращает
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(m2))), m2);

  // экспорт → импорт восстанавливает список блоков
  app.store = m;
  const exported = JSON.stringify(app.store);
  app.store = null;
  const imported = app.migrate(JSON.parse(exported));
  assert.deepEqual(imported, JSON.parse(exported));
  assert.deepEqual(imported.groups, [{ name: 'Сон' }, { name: 'Тело' }]);
});

test('З15: groupedItems — порядок из store.groups, безгруппные и чужие последними', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const items = s.items.filter(i => i.area === 'min' && i.type === 'daily');

  // порядок секций следует groups, а не порядку items[]
  assert.deepEqual(s.groups.map(g => g.name), ['Тело', 'Движение', 'Сон', 'Развитие']);
  app.moveGroup('Развитие', 'up'); // Тело, Движение, Развитие, Сон
  let secs = app.groupedItems(items);
  assert.deepEqual(secs.map(x => x.group.name), ['Тело', 'Движение', 'Развитие', 'Сон']);
  assert.deepEqual(secs[0].items.map(i => i.name), ['Умыться', 'Принять душ', 'Подтягивания + отжимания']);

  // пункт без группы и пункт с неизвестной группой — одной секцией без заголовка, в конце
  items[0].group = '';
  items[1].group = 'Неведомая';
  secs = app.groupedItems(items);
  const last = secs[secs.length - 1];
  assert.equal(last.group, null);
  assert.deepEqual(last.items.map(i => i.name), ['Умыться', 'Принять душ']);
  assert.equal(secs.slice(0, -1).every(x => x.group !== null), true);

  // пустых секций не бывает
  assert.equal(secs.every(x => x.items.length > 0), true);
});

test('З15: переименование атомарно, удаление сохраняет пункты и отметки', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const body = s.items.filter(i => i.group === 'Тело');
  const other = s.items.find(i => i.group === 'Сон');
  for (const it of body) app.toggleMark(t, it.id);
  const daysBefore = JSON.stringify(s.days);

  assert.equal(app.renameGroup('Тело', '  Утро  '), true); // trim
  assert.equal(app.findGroup('Тело'), null);
  assert.equal(body.every(i => i.group === 'Утро'), true); // все пункты группы
  assert.equal(other.group, 'Сон');                        // и ни одного чужого
  assert.equal(s.groups[0].name, 'Утро');                  // позиция в списке та же

  assert.equal(app.renameGroup('Утро', '   '), false);     // пустое имя
  assert.equal(app.renameGroup('Утро', 'Сон'), false);     // занятое имя
  assert.equal(app.renameGroup('Нет такой', 'X'), false);
  assert.equal(app.findGroup('Утро').name, 'Утро');

  const n = s.items.length;
  assert.equal(app.deleteGroup('Утро'), true);
  assert.equal(s.items.length, n);                          // пункты остались
  assert.equal(body.every(i => i.group === ''), true);      // имя группы очищено
  assert.equal(app.findGroup('Утро'), null);
  assert.equal(JSON.stringify(s.days), daysBefore);         // отметки не тронуты
  assert.equal(app.deleteGroup('Утро'), false);
});

test('З15: addGroup/moveGroup — границы и уникальность', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const names = () => s.groups.map(g => g.name);

  assert.equal(app.addGroup('  Вечер  '), true);
  assert.deepEqual(names(), ['Тело', 'Движение', 'Сон', 'Развитие', 'Вечер']); // в конец, с trim
  assert.equal(app.addGroup('Вечер'), false); // дубль
  assert.equal(app.addGroup('   '), false);   // пустое
  assert.deepEqual(Object.keys(s.groups[4]), ['name']); // блок — это только имя

  assert.equal(app.moveGroup('Тело', 'up'), false);        // уже первая
  assert.equal(app.moveGroup('Вечер', 'down'), false);     // уже последняя
  assert.equal(app.moveGroup('нет такой', 'up'), false);
  assert.equal(app.moveGroup('Вечер', 'up'), true);
  assert.deepEqual(names(), ['Тело', 'Движение', 'Сон', 'Вечер', 'Развитие']);

  // groupList — источник подсказок поля «Блок»
  assert.deepEqual(app.groupList(), names());
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

/* ── Задача 16, фаза B. Прогресс (инвариант 14) ────────────── */

/* Пункт минимума в канонической форме */
function mkMin(id, addedAt, area = 'min') {
  return {
    id, name: id, value: null, unit: '', type: 'daily', area, normPerWeek: 7,
    goal: null, note: '', group: '', active: true, addedAt, raiseAfter: 0,
    history: [], formula: null, ladder: null, ladderLog: []
  };
}

/* Один пункт минимума, заведённый давно; календарь начался 60 дней назад */
function progressStore() {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  s.items = [mkMin('m1', app.addDays(t, -60))];
  s.days = {};
  s.settings.calendarSince = app.addDays(t, -60);
  return s;
}

test('З16B: «в системе» — от calendarSince до сегодня включительно', () => {
  const s = progressStore();
  const t = app.todayKey();

  s.settings.calendarSince = t;
  assert.equal(app.daysInSystem(), 1, 'сегодня входит');
  s.settings.calendarSince = app.addDays(t, -9);
  assert.equal(app.daysInSystem(), 10);
  // эпоха ещё не наступила (миграция ставит ближайший понедельник) — ноль, не минус
  s.settings.calendarSince = app.addDays(t, 3);
  assert.equal(app.daysInSystem(), 0);
  s.settings.calendarSince = 'не дата';
  assert.equal(app.daysInSystem(), 0);
});

test('З16B: день закрыт по всем активным пунктам минимума, существовавшим в тот день', () => {
  const s = progressStore();
  const t = app.todayKey();
  const y = app.addDays(t, -1);
  s.items.push(mkMin('m2', app.addDays(t, -60)));

  assert.equal(app.minDayClosed(y), false);
  app.toggleMark(y, 'm1');
  assert.deepEqual(app.minDayMarks(y), { done: 1, total: 2 });
  assert.equal(app.minDayClosed(y), false, 'отмечено не всё');
  app.toggleMark(y, 'm2');
  assert.equal(app.minDayClosed(y), true);

  // привычка в планку минимума не входит (инвариант 10)
  s.items.push(mkMin('h1', app.addDays(t, -60), 'habit'));
  assert.equal(app.minDayClosed(y), true);
  // как и недельный счётчик
  s.items.push(Object.assign(mkMin('w1', app.addDays(t, -60)), { type: 'weekly', goal: 3 }));
  assert.equal(app.minDayClosed(y), true);

  // выключенный пункт из расчёта выпадает
  s.items.find(i => i.id === 'm2').active = false;
  assert.deepEqual(app.minDayMarks(y), { done: 1, total: 1 });

  // пунктов нет — день не закрыт: закрывать было нечего
  s.items = [];
  assert.equal(app.minDayClosed(y), false);
  assert.equal(app.dayStreak(), 0, 'пустые данные — ноль');
});

test('З16B: серия — амнистия одного пропуска, обрыв на двух, незакрытый сегодня не рвёт', () => {
  const s = progressStore();
  const t = app.todayKey();
  const mark = n => app.toggleMark(app.addDays(t, -n), 'm1');

  assert.equal(app.dayStreak(), 0);

  mark(1); mark(2);
  assert.equal(app.dayStreak(), 2, 'сегодня не закрыт — пропускается, серию не обрывает');

  mark(0);
  assert.equal(app.dayStreak(), 3, 'закрытый сегодня идёт в счёт');

  // день −3 пуст: амнистия, в счёт не идёт; −4 и −5 закрыты
  mark(4); mark(5);
  assert.equal(app.dayStreak(), 5);

  // −6 и −7 пусты подряд — обрыв: −8 в серию уже не входит
  mark(8);
  assert.equal(app.dayStreak(), 5);

  // дно — calendarSince: дни до эпохи в серию не идут
  s.settings.calendarSince = app.addDays(t, -2);
  assert.equal(app.dayStreak(), 3);
});

test('З16B: серия — пункт, заведённый сегодня, прошлые дни не переписывает', () => {
  const s = progressStore();
  const t = app.todayKey();
  s.items.push(mkMin('m2', t)); // заведён сегодня
  for (let i = 0; i <= 3; i++) app.toggleMark(app.addDays(t, -i), 'm1');

  // вчера и раньше m2 не существовал — те дни закрыты одним m1
  assert.equal(app.dayStreak(), 3, 'сегодня не закрыт (m2 не отмечен) и пропускается');
  app.toggleMark(t, 'm2');
  assert.equal(app.dayStreak(), 4);
});

test('З16B: цепь дней — восемь недель подряд, последняя текущая', () => {
  progressStore();
  const w = app.chainWeeks(8);
  assert.equal(w.length, 8);
  assert.equal(w[7], app.weekStartOf(app.todayKey()), 'последняя строка — текущая неделя');
  assert.equal(w[0], app.addDays(w[7], -49));
  for (let i = 1; i < w.length; i++) assert.equal(app.diffDays(w[i], w[i - 1]), 7);
});

test('З16B: отметки считаются в окне calendarSince…сегодня', () => {
  const s = progressStore();
  const t = app.todayKey();
  const it = s.items[0];

  app.toggleMark(app.addDays(t, -1), 'm1');
  app.toggleMark(t, 'm1');
  assert.equal(app.marksInSystem(it), 2);

  // отметка до начала эпохи и отметка в будущем в окно не попадают
  app.toggleMark(app.addDays(t, -70), 'm1');
  app.toggleMark(app.addDays(t, 1), 'm1');
  assert.equal(app.marksInSystem(it), 2);
});

test('З16B: подъём — ряд от двух записей, ступенька даёт 2N−1 сегментов', () => {
  const s = progressStore();
  const t = app.todayKey();
  const it = s.items[0];

  it.history = [{ date: app.addDays(t, -20), value: 5 }];
  assert.equal(app.riseSeries(it), null, 'одна запись — ряда нет');

  it.history.push({ date: app.addDays(t, -10), value: 8 });
  const ser = app.riseSeries(it);
  assert.equal(ser.kind, 'bar');
  assert.deepEqual(ser.points.map(p => p.value), [5, 8]);
  assert.equal((app.risePath(ser.points).match(/[HV]/g) || []).length, 3); // 2·2−1

  it.history.push({ date: app.addDays(t, -6), value: 6 });
  it.history.push({ date: app.addDays(t, -3), value: 9 });
  it.history.push({ date: t, value: 11 });
  const d = app.risePath(app.riseSeries(it).points);
  assert.equal((d.match(/[HV]/g) || []).length, 9); // 2·5−1
  assert.match(d, /^M0 /, 'первая запись — левый край');
  assert.match(d, /H100$/, 'последнее значение держится до правого края');
  // ось Y в границах поля: 2…42 при высоте 44
  for (const y of d.match(/V([\d.]+)/g).map(v => Number(v.slice(1)))) {
    assert.ok(y >= 2 && y <= 42, 'значение внутри поля: ' + y);
  }

  // лестница даёт ряд только у пункта без истории значений
  const l = mkMin('l1', app.addDays(t, -30));
  l.ladderLog = [
    { date: app.addDays(t, -30), step: 0, text: 'первая', start: true },
    { date: app.addDays(t, -10), step: 1, text: 'вторая' }
  ];
  const ls = app.riseSeries(l);
  assert.equal(ls.kind, 'ladder');
  assert.deepEqual(ls.points.map(p => p.value), [1, 2], 'ступени человеку — с единицы');
  l.history = [{ date: app.addDays(t, -30), value: 1 }, { date: t, value: 3 }];
  assert.equal(app.riseSeries(l).kind, 'bar', 'история планки первична');

  // все записи одним днём: путь строится по индексу, деления на ноль нет
  const same = mkMin('s1', t);
  same.ladderLog = [
    { date: t, step: 0, text: 'а', start: true },
    { date: t, step: 1, text: 'б' }
  ];
  const sd = app.risePath(app.riseSeries(same).points);
  assert.equal((sd.match(/[HV]/g) || []).length, 3);
  assert.doesNotMatch(sd, /NaN|Infinity/);
});

/* ── Задача 16, фаза C. Планка вниз и якоря недель ─────────── */

test('З16C: lowerSuggest — крупная планка на четверть, мелкая на единицу, единице некуда', () => {
  assert.equal(app.lowerSuggest(20), 15);
  assert.equal(app.lowerSuggest(13), 10);   // round(9.75)
  assert.equal(app.lowerSuggest(12), 11);
  assert.equal(app.lowerSuggest(2), 1);
  assert.equal(app.lowerSuggest(1), null);
  assert.equal(app.lowerSuggest(0), null);
  assert.equal(app.lowerSuggest(null), null);
  assert.equal(app.lowerSuggest('12'), null); // строка планкой не считается
});

test('З16C: lowerEligible — две недели по ≤3 из 7, границы 3 и 4', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  const W = app.closedWeeks(2);

  assert.equal(app.lowerEligible(item), true, 'две пустые недели — планка не держится');

  setWeekMarks(item.id, W[0], 3);
  setWeekMarks(item.id, W[1], 3);
  assert.equal(app.lowerEligible(item), true, '3 из 7 — граница включительно');

  setWeekMarks(item.id, W[1], 4);
  assert.equal(app.lowerEligible(item), false, '4 из 7 — уже держится');

  setWeekMarks(item.id, W[1], 3);
  setWeekMarks(item.id, W[0], 4);
  assert.equal(app.lowerEligible(item), false, 'вторая неделя тоже считается');
  setWeekMarks(item.id, W[0], 0);

  // одной закрытой недели мало
  s.settings.calendarSince = W[1];
  assert.equal(app.closedWeeks(2).length, 1);
  assert.equal(app.lowerEligible(item), false);
  calendarPast(s);
  assert.equal(app.lowerEligible(item), true);

  // область привычек и выключённый пункт предложения не получают
  const habit = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  assert.equal(app.lowerEligible(habit), false);
  item.active = false;
  assert.equal(app.lowerEligible(item), false);
  item.active = true;

  // пункт без числовой планки предложение получает — решение сводится
  // к «Оставить», кнопки шага у него нет (lowerSuggest === null)
  const noValue = s.items.find(i => i.name === 'Умыться');
  assert.equal(app.lowerEligible(noValue), true);
  assert.equal(app.lowerSuggest(noValue.value), null);
});

test('З16C: понижение — планка, история, срез недели и якорь; «Оставить» гасит до недели после', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Пешком'); // value 500
  assert.equal(app.lowerEligible(item), true);

  app.acceptLower(item, app.lowerSuggest(item.value));
  assert.equal(item.value, 375);
  assert.deepEqual(item.history[item.history.length - 1], { date: app.todayKey(), value: 375 });
  assert.deepEqual(s.pendingLowers, [{ itemId: item.id, name: item.name, from: 500, to: 375 }]);
  assert.equal(item.lowerAfterWeek, app.currentWeekStart());
  assert.equal(app.lowerEligible(item), false, 'решение недели принято');

  app.closeWeek();
  const r = s.reviews[s.reviews.length - 1];
  assert.deepEqual(r.lowers, [{ itemId: item.id, name: item.name, from: 500, to: 375 }]);
  assert.deepEqual(s.pendingLowers, [], 'pendingLowers очищен закрытием недели');

  // якорь: нужны две недели строго после недели решения — то есть ещё
  // три смены недели (неделя решения закрывается последней из «старых»)
  const anchor = item.lowerAfterWeek;
  advanceDays(7);
  assert.equal(app.lowerEligible(item), false, 'неделя решения ещё не закрыта');
  advanceDays(7);
  assert.equal(app.lowerEligible(item), false, 'неделя решения в паре');
  advanceDays(7);
  assert.equal(app.closedWeeks(2)[0], app.addDays(anchor, 7));
  assert.equal(app.lowerEligible(item), true);

  // «Оставить» ставит тот же якорь, планку не трогая
  const before = item.value;
  app.keepBar(item);
  assert.equal(item.value, before);
  assert.equal(item.lowerAfterWeek, app.currentWeekStart());
  assert.equal(app.lowerEligible(item), false);
});

test('З16C: миграция v10→v11 — якоря недель и pendingLowers, идемпотентно', () => {
  setNow(2026, 7, 17, 12, 0);
  const v10 = app.defaultStore();
  v10.schemaVersion = 10;
  delete v10.pendingLowers;
  for (const it of v10.items) { delete it.raiseAfterWeek; delete it.lowerAfterWeek; }
  v10.items[0].raiseAfterWeek = '2026-07-15';  // рукотворная середина недели
  v10.items[1].lowerAfterWeek = 'мусор';

  const m = app.migrate(JSON.parse(JSON.stringify(v10)));
  assert.equal(m.schemaVersion, 13);
  assert.deepEqual(m.pendingLowers, []);
  assert.equal(m.items[0].raiseAfterWeek, '2026-07-13', 'не-понедельник приведён к своему понедельнику');
  assert.equal(m.items[1].lowerAfterWeek, null);
  assert.equal(m.items.every(i => 'raiseAfterWeek' in i && 'lowerAfterWeek' in i), true);
  assert.equal(m.items.every(i => 'raiseAfter' in i), true, 'историческое поле не удаляется');
  // миграция аддитивна: отметки и разборы не тронуты
  assert.deepEqual(m.days, v10.days);
  assert.deepEqual(m.reviews, v10.reviews);
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(m))), m);

  // мусор в pendingLowers отфильтровывается
  const dirty = JSON.parse(JSON.stringify(m));
  dirty.pendingLowers = [null, 'строка', { itemId: 'x' }];
  assert.deepEqual(app.migrate(dirty).pendingLowers, [{ itemId: 'x' }]);
});

/* ── Задача 16, фаза D. Упражнения и тренировки ────────────── */

test('З16D: сессия — дата дня, entries только с валидными числами, заметка с trim', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const w = s.items.find(i => i.type === 'weekly');
  const a = app.addExercise('Жим', 'кг', 40);
  const b = app.addExercise('Тяга', 'кг', null);
  assert.equal(a.value, 40);
  assert.deepEqual(a.history, [{ date: app.todayKey(), value: 40 }]);
  assert.deepEqual(b.history, [], 'без начальной нагрузки истории нет');
  assert.equal(app.addExercise('   ', 'кг', 5), null, 'безымянное не заводится');

  app.recordSession(w.id, [
    { exId: a.id, value: 42 },
    { exId: b.id, value: null },      // поле пустое — в сессию не идёт
    { exId: 'нет такого', value: 10 } // чужой id отбрасывается
  ], '  лёгкая  ');

  assert.equal(s.sessions.length, 1);
  const ses = s.sessions[0];
  assert.equal(ses.date, app.todayKey());
  assert.deepEqual(ses.entries, [{ exId: a.id, value: 42 }]);
  assert.equal(ses.note, 'лёгкая');
  assert.equal(app.trainCount(w.id), 1, 'недельный счётчик вырос');
});

test('З16D: нагрузка и история пишутся только при изменении', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const w = s.items.find(i => i.type === 'weekly');
  const ex = app.addExercise('Жим', 'кг', 40);

  app.recordSession(w.id, [{ exId: ex.id, value: 40 }], '');
  assert.equal(ex.value, 40);
  assert.equal(ex.history.length, 1, 'то же значение историю не дополняет');

  // изменение в тот же логический день заменяет последнюю запись (инвариант 5:
  // упражнение заведено сегодня, его стартовая запись — сегодняшняя)
  app.recordSession(w.id, [{ exId: ex.id, value: 45 }], '');
  assert.equal(ex.value, 45);
  assert.equal(ex.history.length, 1);
  assert.equal(ex.history[0].value, 45);

  advanceDays(1);
  app.recordSession(w.id, [{ exId: ex.id, value: 50 }], '');
  assert.equal(ex.value, 50);
  assert.equal(ex.history.length, 2);
  assert.deepEqual(ex.history[1], { date: app.todayKey(), value: 50 });
  assert.equal(s.sessions.length, 3, 'сессии при этом все три');
});

test('З16D: «отменить последний» снимает и запись счётчика, и сессию дня; нагрузка не откатывается', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const w = s.items.find(i => i.type === 'weekly');
  const ex = app.addExercise('Жим', 'кг', 40);
  app.recordSession(w.id, [{ exId: ex.id, value: 45 }], 'первая');
  app.recordSession(w.id, [{ exId: ex.id, value: 50 }], 'вторая');
  assert.equal(app.trainCount(w.id), 2);
  assert.equal(s.sessions.length, 2);

  app.undoTrain(w.id);
  assert.equal(app.trainCount(w.id), 1);
  assert.equal(s.sessions.length, 1, 'сессия того же дня ушла вместе с записью');
  assert.equal(s.sessions[0].note, 'первая', 'снята последняя');
  assert.equal(ex.value, 50, 'нагрузка не откатывается — история правдива');
});

test('З16D: упражнения — порядок стрелками, правка имени и единицы', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const a = app.addExercise('Жим', 'кг', 40);
  const b = app.addExercise('Тяга', 'кг', 60);
  const names = () => s.exercises.map(e => e.name);

  assert.equal(app.moveExercise(a.id, 'up'), false); // уже первое
  assert.equal(app.moveExercise(b.id, 'down'), false);
  assert.equal(app.moveExercise(b.id, 'up'), true);
  assert.deepEqual(names(), ['Тяга', 'Жим']);

  assert.equal(app.updateExercise(a.id, '  Жим лёжа  ', '  повт.  '), true);
  assert.equal(a.name, 'Жим лёжа');
  assert.equal(a.unit, 'повт.');
  assert.equal(app.updateExercise(a.id, '   ', 'кг'), false, 'пустое имя не сохраняется');
  assert.equal(app.updateExercise('нет такого', 'x', ''), false);
  assert.deepEqual(app.activeExercises().map(e => e.id), [b.id, a.id]);
  b.active = false;
  assert.deepEqual(app.activeExercises().map(e => e.id), [a.id]);
});

test('З16D: миграция v11→v12 — упражнения и сессии, мусор отброшен, идемпотентно', () => {
  setNow(2026, 8, 13, 12, 0);
  const v11 = app.defaultStore();
  v11.schemaVersion = 11;
  delete v11.exercises;
  delete v11.sessions;

  const m = app.migrate(JSON.parse(JSON.stringify(v11)));
  assert.equal(m.schemaVersion, 13);
  assert.deepEqual(m.exercises, []);
  assert.deepEqual(m.sessions, []);
  assert.deepEqual(m.days, v11.days, 'аддитивность: отметки не тронуты');
  assert.deepEqual(m.reviews, v11.reviews);

  const dirty = JSON.parse(JSON.stringify(m));
  dirty.exercises = [null, 'строка', { name: 'Жим', value: -5, history: [{ date: 'нет', value: 1 }] }];
  dirty.sessions = [
    null,
    { date: 'нет даты', entries: [] },
    { date: '2026-08-10', entries: [{ exId: 'a', value: '12' }, { value: 3 }], note: 5 }
  ];
  const m2 = app.migrate(dirty);
  assert.equal(m2.exercises.length, 1);
  assert.equal(typeof m2.exercises[0].id, 'string');
  assert.equal(m2.exercises[0].value, null, 'нагрузка ≤ 0 обнуляется');
  assert.deepEqual(m2.exercises[0].history, []);
  assert.equal(m2.exercises[0].active, true);
  assert.equal(m2.sessions.length, 1, 'запись без валидной даты отброшена');
  assert.deepEqual(m2.sessions[0].entries, [{ exId: 'a', value: 12 }]);
  assert.equal(m2.sessions[0].note, '');
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(m2))), m2);
});

test('З16D: упражнение с двумя записями истории попадает в «Подъём»', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const w = s.items.find(i => i.type === 'weekly');
  const ex = app.addExercise('Жим', 'кг', 40);
  assert.equal(app.riseSeries(ex), null, 'одна запись — ряда нет');

  advanceDays(7);
  app.recordSession(w.id, [{ exId: ex.id, value: 45 }], '');
  const ser = app.riseSeries(ex);
  assert.equal(ser.kind, 'bar');
  assert.deepEqual(ser.points.map(p => p.value), [40, 45]);
  assert.equal((app.risePath(ser.points).match(/[HV]/g) || []).length, 3);
});

/* ── Задача 16, фаза E. Заметки (инвариант 16) ─────────────── */

test('З16E: заметка — создание, правка, удаление, пустой текст = удаление', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();

  assert.equal(app.addNote('   '), null, 'пустая заметка не заводится');
  const n = app.addNote('  первая мысль  ');
  assert.equal(n.text, 'первая мысль', 'текст с trim');
  assert.equal(n.date, app.todayKey());
  assert.equal(s.notes.length, 1);

  assert.equal(app.updateNote(n.id, ' поправленная '), true);
  assert.equal(n.text, 'поправленная');
  assert.equal(app.updateNote('нет такой', 'x'), false);

  // пустой текст при сохранении удаляет заметку
  assert.equal(app.updateNote(n.id, '    '), true);
  assert.deepEqual(s.notes, []);

  const a = app.addNote('к удалению');
  assert.equal(app.deleteNote(a.id), true);
  assert.equal(app.deleteNote(a.id), false);
  assert.deepEqual(s.notes, []);
});

test('З16E: порядок — от новых к старым, при равном дне по времени правки', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const old = app.addNote('позавчерашняя');
  old.date = app.addDays(app.todayKey(), -2);
  const a = app.addNote('сегодня раньше');
  a.updatedAt = 1000;
  const b = app.addNote('сегодня позже');
  b.updatedAt = 2000;

  assert.deepEqual(app.notesByDate().map(x => x.text),
    ['сегодня позже', 'сегодня раньше', 'позавчерашняя']);
  assert.equal(s.notes[0].text, 'позавчерашняя', 'сортировка не переставляет хранилище');
});

test('З16E: миграция v12→v13 и экспорт → импорт заметок', () => {
  setNow(2026, 8, 13, 12, 0);
  const v12 = app.defaultStore();
  v12.schemaVersion = 12;
  delete v12.notes;

  const m = app.migrate(JSON.parse(JSON.stringify(v12)));
  assert.equal(m.schemaVersion, 13);
  assert.deepEqual(m.notes, []);
  assert.deepEqual(m.days, v12.days, 'аддитивность');

  const dirty = JSON.parse(JSON.stringify(m));
  dirty.notes = [
    null, 'строка', { text: '   ' },                        // мусор и пустые
    { id: 'n1', date: 'не дата', text: '  живая  ', updatedAt: '5' },
    { id: 'n1', date: '2026-08-10', text: 'дубль id' }
  ];
  const m2 = app.migrate(dirty);
  assert.equal(m2.notes.length, 2);
  assert.equal(m2.notes[0].text, 'живая');
  assert.equal(m2.notes[0].date, app.todayKey(), 'битая дата — сегодняшний день');
  assert.equal(m2.notes[0].updatedAt, 5);
  assert.notEqual(m2.notes[1].id, m2.notes[0].id, 'дубль id переписан');
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(m2))), m2);

  // экспорт → импорт: заметки восстанавливаются полностью
  app.store = m2;
  const roundTrip = app.migrate(JSON.parse(JSON.stringify(app.store)));
  assert.deepEqual(roundTrip.notes, m2.notes);
});

/* ── Задача 16, фаза F. Порядок внутри блока ───────────────── */

test('З16F: стрелки двигают пункт только среди соседей по блоку', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const mk = (id, group, area = 'min') => Object.assign(mkMin(id, t, area), { group });
  // блоки перемежаются: A1 A2 B1 A3 — так их и держит store.items
  s.items = [mk('a1', 'A'), mk('a2', 'A'), mk('b1', 'Б'), mk('a3', 'A'), mk('h1', 'A', 'habit')];
  const ids = () => s.items.map(i => i.id);

  assert.equal(app.canMoveItem('a1', 'up'), false, 'первый в блоке');
  assert.equal(app.canMoveItem('a3', 'down'), false, 'последний в блоке');
  assert.equal(app.canMoveItem('b1', 'up'), false, 'единственный в своём блоке');
  assert.equal(app.canMoveItem('b1', 'down'), false);
  assert.equal(app.canMoveItem('h1', 'up'), false, 'другая область — не сосед');

  // «ниже» у a2 меняет местами с a3 через чужой блок, b1 не двигается
  assert.equal(app.moveItem('a2', 'down'), true);
  assert.deepEqual(ids(), ['a1', 'a3', 'b1', 'a2', 'h1']);
  assert.equal(s.items[2].id, 'b1', 'чужой блок остался на месте');

  assert.equal(app.moveItem('b1', 'up'), false, 'двигать некуда — порядок не тронут');
  assert.deepEqual(ids(), ['a1', 'a3', 'b1', 'a2', 'h1']);

  // пункт не покидает блок ни при какой последовательности стрелок
  for (let k = 0; k < 6; k++) app.moveItem('a1', 'down');
  assert.deepEqual(s.items.map(i => i.group), ['A', 'A', 'Б', 'A', 'A']);
  assert.equal(s.items.find(i => i.id === 'a1').group, 'A');
});

test('З16F: перетаскивание ставит пункт на позицию среди соседей блока', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const mk = (id, group) => Object.assign(mkMin(id, t), { group });
  s.items = [mk('a1', 'A'), mk('b1', 'Б'), mk('a2', 'A'), mk('a3', 'A')];
  const ids = () => s.items.map(i => i.id);

  assert.equal(app.reorderItem('a1', 2), true); // первый среди A в конец
  assert.deepEqual(ids(), ['a2', 'b1', 'a3', 'a1']);
  assert.equal(s.items[1].id, 'b1', 'чужой блок на своём месте');

  assert.equal(app.reorderItem('a1', 0), true);
  assert.deepEqual(ids(), ['a1', 'b1', 'a2', 'a3']);

  assert.equal(app.reorderItem('a1', 0), false, 'та же позиция — не изменение');
  assert.equal(app.reorderItem('a1', 5), false, 'за границами блока');
  assert.equal(app.reorderItem('нет такого', 1), false);
  assert.equal(app.reorderItem('b1', 0), false, 'в блоке из одного двигать нечего');
});

test('З16F: перетаскивание блоков и упражнений', () => {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  s.groups = [{ name: 'Раз' }, { name: 'Два' }, { name: 'Три' }];
  assert.equal(app.reorderGroup('Три', 0), true);
  assert.deepEqual(s.groups.map(g => g.name), ['Три', 'Раз', 'Два']);
  assert.equal(app.reorderGroup('Три', 0), false);
  assert.equal(app.reorderGroup('нет такого', 1), false);
  assert.equal(app.reorderGroup('Раз', 9), false);

  const a = app.addExercise('Жим', 'кг', 40);
  const b = app.addExercise('Тяга', 'кг', 60);
  const c = app.addExercise('Присед', 'кг', 80);
  assert.equal(app.reorderExercise(c.id, 0), true);
  assert.deepEqual(s.exercises.map(e => e.name), ['Присед', 'Жим', 'Тяга']);
  assert.equal(app.reorderExercise(a.id, 2), true);
  assert.deepEqual(s.exercises.map(e => e.name), ['Присед', 'Тяга', 'Жим']);
  assert.equal(app.reorderExercise('нет такого', 0), false);
  assert.equal(app.reorderExercise(b.id, -1), false);
});
