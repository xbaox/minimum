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

/* Календарная эпоха началась давно: разборы доступны сразу.
   Пункты существуют с её начала — иначе механика понижения их не видит
   (A.4.1: пункт должен существовать во всех рассматриваемых неделях).
   Тесту, которому нужен свежезаведённый пункт, addedAt задаёт сам. */
function calendarPast(s) {
  s.settings.calendarSince = app.addDays(app.weekStartOf(app.todayKey()), -70);
  s.items.forEach(i => { i.addedAt = s.settings.calendarSince; });
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
  // якорь недели ставит acceptRaise вместе с записью — он и служит датой
  // решения (задача 27.1, п. 10.2): в срез идут решения ТЕКУЩЕЙ недели
  s.pendingRaises.push({ itemId: daily.id, name: daily.name, from: 5, to: 6 });
  daily.raiseAfterWeek = app.currentWeekStart();

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

test('И3: убранный пункт без отметок в окне не попадает в срез, с отметками — попадает', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  const [a, b] = s.items.filter(i => i.type === 'daily');
  a.removedAt = a.addedAt;                   // без отметок
  b.removedAt = b.addedAt;
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

test('И4: повышение — живой дневной пункт минимума с числовой планкой', () => {
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
  item.removedAt = app.todayKey();
  assert.equal(app.raiseEligible(item), false);    // убран
  item.removedAt = null;
  assert.equal(app.raiseEligible(item), true);
});

/* Задача 28.D, п. 5: guard живой лестницы снят. Прежде поле ladder гасило
   предложение — шаг ступени и шаг планки в одну неделю были бы двумя
   изменениями за раз. Ступени в приложении не осталось, и поле, которого
   владелец не видит и снять не может, права на повышение не отнимает. */
test('З28D/5: поле ladder в данных повышению не мешает — критерий один', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  for (const w of app.closedWeeks(3)) setWeekMarks(item.id, w, 6);
  assert.equal(app.raiseEligible(item), true, 'три недели по 6 из 7 — предложение есть');

  // ЖИВАЯ лестница в данных: прежде гасила предложение
  item.ladder = { steps: ['первая', 'вторая'], step: 0, steppedWeek: null, startedAt: app.todayKey(), done: false };
  assert.equal(app.raiseEligible(item), true, 'живая лестница больше не блокирует');
  assert.equal(app.raiseOffer(), item, 'и карточку получает именно он');

  // закрытая — тоже (она не блокировала и до задачи 28.D)
  item.ladder.done = true;
  assert.equal(app.raiseEligible(item), true);

  // критерий остался ЕДИНСТВЕННЫМ: недобор одной недели гасит предложение
  item.ladder = null;
  setWeekMarks(item.id, app.closedWeeks(3)[1], 5);
  assert.equal(app.raiseEligible(item), false, '5 из 7 в средней неделе — предложения нет');
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

  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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
    assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
    assert.equal(Array.isArray(m.items), true);
    assert.equal(m.items.length, 9); // дефолтный набор — программа посева (задача 17)
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
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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

test('З2: trainings в срезе — живые либо с ненулевым счётом за разобранную неделю', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  const w1 = s.items.find(i => i.type === 'weekly'); // активный, счёт 0
  s.items.push(
    { ...w1, id: 'w2', name: 'Убранный без счёта', removedAt: w1.addedAt },
    { ...w1, id: 'w3', name: 'Убранный со счётом', removedAt: w1.addedAt }
  );
  s.weekLog.push({ itemId: 'w3', date: app.addDays(prev, 3), ts: 1 }); // в разобранной неделе
  app.closeWeek();
  const t = s.reviews[0].trainings;
  assert.equal(w1.id in t, true);  // живой с нулём — в срезе
  assert.equal('w2' in t, false);  // убранный без счёта — нет
  assert.equal('w3' in t, true);   // убранный со счётом — да
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
    // задача 25, п. 6: к сырой строке добавлена дата — без неё строка
    // «Данных» не может сказать владельцу, что именно там лежит.
    // Сама строка при этом сохраняется дословно, ни байта не теряя.
    const kept = JSON.parse(mem['minimum:data:corrupt']);
    assert.equal(kept.raw, '{битый json');
    assert.equal(typeof kept.at, 'number');
    // пустой localStorage — тоже null
    delete mem['minimum:data'];
    assert.equal(app.load(), null);
    // валидная строка — store; резервный ключ не тронут
    mem['minimum:data'] = JSON.stringify(app.defaultStore());
    assert.equal(app.load().items.length, 9);
    assert.deepEqual(JSON.parse(mem['minimum:data:corrupt']), kept);
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
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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
  p.removedAt = app.todayKey();
  assert.equal(app.applyParamStep(p.id), false);         // убранный
  p.removedAt = null;

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

test('З9/З11: habitsSteady — 2 последние КАЛЕНДАРНЫЕ недели по норме, reviews не читается', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  // в стартовой программе ежедневная привычка одна — вторую тест заводит сам
  const h1 = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  const h2 = Object.assign(JSON.parse(JSON.stringify(h1)), { id: 'h2', name: 'Вторая привычка' });
  s.items.push(h2);
  s.items.forEach(i => { i.addedAt = s.settings.calendarSince; });
  const W = app.closedWeeks(2); // [позапрошлая, прошлая]
  const wk = (c1, c2) => {
    setWeekMarks(h1.id, W[0], c1[0]); setWeekMarks(h1.id, W[1], c1[1]);
    setWeekMarks(h2.id, W[0], c2[0]); setWeekMarks(h2.id, W[1], c2[1]);
  };
  assert.equal(app.habitsSteady(), false); // отметок нет
  wk([7, 7], [7, 7]);
  assert.equal(app.habitsSteady(), true);  // норма по умолчанию 7
  wk([6, 7], [7, 7]);
  assert.equal(app.habitsSteady(), false); // 6 < норма 7
  h1.normPerWeek = 5;
  assert.equal(app.habitsSteady(), true);  // норма 5: 6 и 7 достаточно
  wk([4, 7], [7, 7]);
  assert.equal(app.habitsSteady(), false); // 4 < 5
  h2.removedAt = app.todayKey();
  wk([5, 7], [0, 0]);
  assert.equal(app.habitsSteady(), true);  // убранная не учитывается
  h1.removedAt = app.todayKey();
  assert.equal(app.habitsSteady(), false); // живых привычек нет

  // A.5.5: reviews на результат не влияет ни в одну сторону
  h1.removedAt = null;
  wk([5, 7], [0, 0]);
  s.reviews = [];
  assert.equal(app.habitsSteady(), true, 'пустой reviews готовности не мешает');
  s.reviews = [{ perItem: { [h1.id]: { count: 0 } } }, { perItem: { [h1.id]: { count: 0 } } }];
  assert.equal(app.habitsSteady(), true, 'разборы с нулями её не гасят');
  wk([0, 0], [0, 0]);
  s.reviews = [{ perItem: { [h1.id]: { count: 7 } } }, { perItem: { [h1.id]: { count: 7 } } }];
  assert.equal(app.habitsSteady(), false, 'идеальные разборы при пустых неделях её не дают');
});

test('З19/A.5.5: готовность — десять идеальных недель без единого разбора', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  s.settings.calendarSince = app.addDays(app.weekStartOf(app.todayKey()), -7 * 12);
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  s.items.forEach(i => { i.addedAt = s.settings.calendarSince; });
  for (let w = 1; w <= 10; w++) setWeekMarks(h.id, app.addDays(app.currentWeekStart(), -7 * w), 7);
  s.reviews = [];
  assert.equal(app.habitsSteady(), true, 'разбор ни разу не закрывался — готовность всё равно видна');

  // и обратное: два разбора полугодовой давности при пустых последних неделях
  for (let w = 1; w <= 10; w++) setWeekMarks(h.id, app.addDays(app.currentWeekStart(), -7 * w), 0);
  s.reviews = [
    { closedAt: 1, week: '2026-01-05', perItem: { [h.id]: { name: h.name, count: 7 } } },
    { closedAt: 2, week: '2026-01-12', perItem: { [h.id]: { name: h.name, count: 7 } } }
  ];
  assert.equal(app.habitsSteady(), false, 'старые разборы готовность не держат');
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
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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
  const gone = s.items.find(i => i.name === 'Развитие');

  assert.equal(app.markYesterday('нет-такого-id'), false); // несуществующий пункт
  assert.equal(app.markYesterday(item.id), false);         // добавлен сегодня — вчера не существовал

  item.addedAt = y;
  weekly.addedAt = app.addDays(t, -5);
  assert.equal(app.markYesterday(weekly.id), false);       // weekly не отмечается
  gone.addedAt = app.addDays(t, -5);
  gone.removedAt = t;
  assert.equal(app.markYesterday(gone.id), false);         // убранный

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

/* ── Задача 14. Формула и лестница (инвариант 16) ──────────── */

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

  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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

  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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

/* Задача 28.D, п. 6.2–6.3: механики нет, ДАННЫЕ ЕСТЬ. Заводить формулу и
   лестницу в интерфейсе больше нечем — кладём их прямо в store, ровно так
   они и лежат у владельца, — и требуем, чтобы экспорт → импорт вернул их
   до байта. Прежде тот же путь проверялся через setFormula/setLadder. */
test('З28D/6: формула и лестница переживают экспорт → импорт до байта', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const it = s.items.find(i => i.type === 'daily');
  it.formula = {
    anchor: 'после зарядки', when: '23:30, спальня', pair: '', identity: 'я человек, который ложится вовремя',
    twoMin: '', friction: '', proof: '', mode: 'build'
  };
  it.ladder = { steps: ['раз', 'два', 'три'], step: 1, steppedWeek: '2026-07-13', startedAt: '2026-07-02', done: false };
  it.ladderLog = [
    { date: '2026-07-02', step: 0, text: 'раз', start: true },
    { date: '2026-07-13', step: 1, text: 'два' }
  ];

  const exported = JSON.stringify(app.store);         // содержимое файла экспорта
  app.store = null;                                   // «очистка localStorage»
  const imported = app.migrate(JSON.parse(exported), { external: true }); // путь importJSON
  app.store = imported;

  assert.deepEqual(imported, JSON.parse(exported));   // до байта данных
  const back = imported.items.find(i => i.id === it.id);
  assert.equal(back.formula.anchor, 'после зарядки');
  assert.equal(back.formula.pair, '');
  assert.equal(back.formula.mode, 'build');
  assert.deepEqual(back.ladder.steps, ['раз', 'два', 'три']);
  assert.equal(back.ladder.step, 1);
  assert.equal(back.ladder.steppedWeek, '2026-07-13'); // понедельник — как был
  assert.equal(back.ladder.done, false);
  // флаг start переживает экспорт → импорт, у второй записи его нет
  assert.equal(back.ladderLog.length, 2);
  assert.equal(back.ladderLog[0].start, true);
  assert.equal('start' in back.ladderLog[1], false);
});

/* Задача 28.D, п. 6.4: повторный прогон migrate ничего не меняет. Это и
   есть гарантия «ни байта не потеряется ни при одном запуске»: миграция
   идёт при КАЖДОМ старте, и невыдержанная идемпотентность съедала бы поля
   постепенно, а не разом. */
test('З28D/6: двойной прогон migrate по формуле и лестнице побайтово совпадает', () => {
  setNow(2026, 7, 17, 12, 0);
  const raw = () => ({
    schemaVersion: 16,
    items: [{
      id: 'i1', name: 'Пункт', value: null, unit: '', type: 'daily', area: 'min',
      goal: null, note: '', group: '', active: true, addedAt: '2026-07-01',
      raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
      formula: { anchor: 'якорь', when: '', pair: '', identity: '', twoMin: 'две минуты', friction: '', proof: '', mode: 'break' },
      ladder: { steps: ['раз', 'два'], step: 1, steppedWeek: '2026-07-13', startedAt: '2026-07-01', done: true },
      ladderLog: [
        { date: '2026-07-01', step: 0, text: 'раз', start: true },
        { date: '2026-07-13', step: 1, text: 'два' },
        { date: '2026-07-14', step: 1, text: 'два', closed: true }
      ]
    }],
    groups: [], days: {}, weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [],
    exercises: [], sessions: [], notes: [], paramDecided: {}, draftOneChange: '',
    weekStart: '2026-07-13',
    settings: { dayBoundary: 4, dayThreshold: 0.8, calendarSince: '2026-05-04', exportedAt: null, habitSeeded: true, seed17: true }
  });
  const once = JSON.stringify(app.migrate(raw()));
  const twice = JSON.stringify(app.migrate(app.migrate(raw())));
  assert.equal(twice, once, 'второй прогон ничего не изменил');
  const back = JSON.parse(once).items[0];
  assert.equal(back.formula.mode, 'break', 'режим сохранён');
  assert.equal(back.formula.twoMin, 'две минуты');
  assert.equal(back.ladder.done, true, 'закрытая лестница осталась закрытой');
  assert.equal(back.ladderLog.length, 3, 'все три записи журнала на месте');
  assert.equal(back.ladderLog[2].closed, true, 'веха закрытия сохранена');
});

/* Задача 28.D, п. 6.6: дедуп двух ЖИВЫХ лестниц — последний рубеж. Завести
   вторую в интерфейсе больше нечем, а принести её может импорт файла,
   снятого прежней версией. */
test('З28D/6: дедуп двух живых лестниц в migrate работает и после снятия механики', () => {
  setNow(2026, 7, 17, 12, 0);
  const L = (startedAt, done) => ({ steps: ['раз', 'два'], step: 0, steppedWeek: null, startedAt, done });
  const mk = (id, ladder) => ({
    id, name: id, value: null, unit: '', type: 'daily', area: 'min', goal: null, note: '',
    group: '', active: true, addedAt: '2026-06-01', raiseAfter: 0, raiseAfterWeek: null,
    lowerAfterWeek: null, history: [], formula: null, ladder, ladderLog: []
  });
  const s = app.migrate({
    schemaVersion: 16,
    items: [mk('a', L('2026-06-10', false)), mk('b', L('2026-07-01', false)), mk('c', L('2026-06-20', true))],
    groups: [], days: {}, weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [],
    exercises: [], sessions: [], notes: [], paramDecided: {}, draftOneChange: '', weekStart: '2026-07-13',
    settings: { dayBoundary: 4, dayThreshold: 0.8, calendarSince: '2026-05-04', exportedAt: null, habitSeeded: true, seed17: true }
  }, { external: true });
  const by = id => s.items.find(i => i.id === id);
  assert.equal(by('a').ladder, null, 'начатая раньше снята');
  assert.ok(by('b').ladder, 'побеждает начатая позже');
  assert.ok(by('c').ladder, 'ЗАКРЫТАЯ в конфликте не участвует и не снимается');
  assert.equal(by('c').ladder.done, true);
  assert.equal(s.items.filter(i => i.ladder && !i.ladder.done).length, 1, 'живая осталась одна');
});

/* Задача 28.D, п. 6.3: файл с формулой и лестницей импортируется без потерь
   И БЕЗ СТРОКИ ПОТЕРЬ. Счёт «было» берётся по СЫРОМУ распарсенному файлу и
   обязательно ДО migrate (инвариант 6) — тем же путём, что в importJSON. */
test('З28D/6: импорт файла с формулой и лестницей потерей их не называет', () => {
  setNow(2026, 7, 17, 12, 0);
  const file = {
    schemaVersion: 16,
    items: [{
      id: 'i1', name: 'Пункт', value: 10, unit: 'мин', type: 'daily', area: 'min',
      goal: null, note: 'подпись', group: '', active: true, addedAt: '2026-06-01',
      raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
      history: [{ date: '2026-06-01', value: 8 }, { date: '2026-06-20', value: 10 }],
      formula: { anchor: 'после зарядки', when: 'утро', pair: '', identity: '', twoMin: '', friction: '', proof: '', mode: 'build' },
      ladder: { steps: ['раз', 'два', 'три'], step: 1, steppedWeek: '2026-07-06', startedAt: '2026-06-01', done: false },
      ladderLog: [
        { date: '2026-06-01', step: 0, text: 'раз', start: true },
        { date: '2026-07-06', step: 1, text: 'два' }
      ]
    }],
    groups: [], days: { '2026-07-06': { i1: true } }, weekLog: [], reviews: [],
    pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: '2026-07-13',
    settings: { dayBoundary: 4, dayThreshold: 0.8, calendarSince: '2026-05-04', exportedAt: null, habitSeeded: true, seed17: true }
  };
  const raw = JSON.parse(JSON.stringify(file));
  const was = app.dataCounts(raw);              // ДО migrate: он мутирует объект
  const incoming = app.migrate(raw, { external: true });
  const lost = app.droppedLine(was, app.dataCounts(incoming));
  assert.equal(lost, '', 'строки потерь нет — терять нечего');

  const back = incoming.items[0];
  assert.equal(back.formula.anchor, 'после зарядки');
  assert.equal(back.formula.when, 'утро');
  assert.deepEqual(back.ladder.steps, ['раз', 'два', 'три']);
  assert.equal(back.ladder.step, 1);
  assert.equal(back.ladderLog.length, 2);
  assert.equal(back.ladderLog[0].start, true);
  // и сам счёт совпадает по всем категориям, кроме расписания и режимов: их
  // migrate ДОСТРАИВАЕТ — отрезок живому пункту (задача 29/B) и основной
  // режим файлу без режимов (задача Р2), — и это прибавка, а не потеря
  const after = app.dataCounts(incoming);
  assert.equal(app.droppedLine(was, after), '', 'ни одна категория не потеряла');
  assert.deepEqual(Object.assign({}, after, { schedule: was.schedule, modes: was.modes }), was);
  assert.ok(after.schedule >= was.schedule, 'отрезки расписания только достраиваются');
  assert.ok(after.modes >= was.modes, 'режимы только достраиваются');
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

  // v19: блок в канонической форме — без подписи, дни «все семь», не убран;
  // досборка v8→v9 обязана заводить его сразу такой (второго прогона у неё нет).
  // v20: и в основном режиме — у данных до v9 режимов не было
  const blk = name => ({ name, caption: '', days: [], removedAt: null, mode: 'main' });
  const m = app.migrate(mkV8());
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
  assert.deepEqual(m.groups, [blk('Сон'), blk('Тело')]); // порядок первого появления
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
  assert.deepEqual(m2.groups, [blk('Тело'), blk('Сон')]);
  assert.equal(m2.groups.every(g => !('chain' in g)), true, 'поле chain снято у всех записей');

  // v9 → v10: у готового списка снимается только chain, имена из items[]
  // не досбираются — на девятой версии список уже полный
  const v9 = mkV8();
  v9.schemaVersion = 9;
  v9.groups = [{ name: 'Тело', chain: true }];
  assert.deepEqual(app.migrate(v9).groups, [blk('Тело')]);

  // нормализация: мусор, дубликаты и пустые имена
  const dirty = mkV8();
  dirty.schemaVersion = 10;
  dirty.groups = [null, 'строка', { name: '  Сон  ', chain: 'да' }, { name: 'Сон' }, { name: '   ' }, { name: 'Тело', chain: true }];
  const m3 = app.migrate(dirty);
  assert.deepEqual(m3.groups, [blk('Сон'), blk('Тело')]); // первый дубль побеждает, chain снят

  // идемпотентность шага v9→v10: повторный прогон ничего не возвращает
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(m2))), m2);

  // экспорт → импорт восстанавливает список блоков
  app.store = m;
  const exported = JSON.stringify(app.store);
  app.store = null;
  const imported = app.migrate(JSON.parse(exported));
  assert.deepEqual(imported, JSON.parse(exported));
  assert.deepEqual(imported.groups, [blk('Сон'), blk('Тело')]);
});

test('З15: groupedItems — порядок из store.groups, безгруппные и чужие последними', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const items = s.items.filter(i => i.area === 'min' && i.type === 'daily');

  // порядок секций следует groups, а не порядку items[]
  // (задача 17: стартовый набор — программа посева, блоки Утро · Подряд · Движение)
  assert.deepEqual(s.groups.map(g => g.name), ['Утро', 'Подряд', 'Движение']);
  app.moveGroup('Движение', 'up'); // Утро, Движение, Подряд
  let secs = app.groupedItems(items);
  assert.deepEqual(secs.map(x => x.group.name), ['Утро', 'Движение', 'Подряд']);
  assert.deepEqual(secs[0].items.map(i => i.name), ['Умыться', 'Принять душ']);

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

/* «Удаление» блока снято интерфейсным этапом «Расписания 1/3» (п. 1.4): блок
   несёт дни и теперь убирается. Предмет второй половины теста прежний —
   операция над блоком не теряет ни пунктов, ни отметок, — только сама
   операция другая: пункты остаются в store при своём блоке, уходят из виду
   вместе с ним, отметки не трогаются. */
test('З15: переименование атомарно, уход блока сохраняет пункты и отметки', () => {
  fakeLocalStorage(); // уход проверяет запись и при отказе откатывается — хранилище нужно живое
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const body = s.items.filter(i => i.group === 'Утро');
  const other = s.items.find(i => i.group === 'Движение');
  for (const it of body) app.toggleMark(t, it.id);
  const daysBefore = JSON.stringify(s.days);

  assert.equal(app.renameGroup('Утро', '  Вечер  '), true); // trim
  assert.equal(app.findGroup('Утро'), null);
  assert.equal(body.every(i => i.group === 'Вечер'), true); // все пункты группы
  assert.equal(other.group, 'Движение');                    // и ни одного чужого
  assert.equal(s.groups[0].name, 'Вечер');                  // позиция в списке та же

  assert.equal(app.renameGroup('Вечер', '   '), false);     // пустое имя
  assert.equal(app.renameGroup('Вечер', 'Подряд'), false);  // занятое имя
  assert.equal(app.renameGroup('Нет такой', 'X'), false);
  assert.equal(app.findGroup('Вечер').name, 'Вечер');

  const n = s.items.length;
  assert.equal(app.deleteGroup, undefined, 'удаления блока в хуке нет');
  assert.equal(app.removeGroup('Вечер'), true);
  assert.equal(s.items.length, n);                          // пункты остались
  assert.equal(body.every(i => i.group === 'Вечер'), true); // при своём блоке
  assert.equal(body.every(i => i.removedAt === t), true);   // и ушли из виду вместе с ним
  assert.equal(other.removedAt, null);                      // чужие — на месте
  assert.equal(app.findGroup('Вечер').removedAt, t);        // блок убран, а не стёрт
  assert.equal(JSON.stringify(s.days), daysBefore);         // отметки не тронуты
  assert.equal(app.removeGroup('Вечер'), false);            // убранный второй раз не уходит
  clearLocalStorage();
});

test('З15: addGroup/moveGroup — границы и уникальность', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const names = () => s.groups.map(g => g.name);

  assert.equal(app.addGroup('  Вечер  '), true);
  assert.deepEqual(names(), ['Утро', 'Подряд', 'Движение', 'Вечер']); // в конец, с trim
  assert.equal(app.addGroup('Вечер'), false); // дубль
  assert.equal(app.addGroup('   '), false);   // пустое
  // v19: блок — имя, подпись, дни и день ухода; addGroup(name) даёт канон.
  // v20: и режим — активный, в свежем store это основной
  assert.deepEqual(s.groups[3], { name: 'Вечер', caption: '', days: [], removedAt: null, mode: 'main' });

  assert.equal(app.moveGroup('Утро', 'up'), false);        // уже первая
  assert.equal(app.moveGroup('Вечер', 'down'), false);     // уже последняя
  assert.equal(app.moveGroup('нет такой', 'up'), false);
  assert.equal(app.moveGroup('Вечер', 'up'), true);
  assert.deepEqual(names(), ['Утро', 'Подряд', 'Вечер', 'Движение']);

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

  // существовал вчера, не отмечен, но и НИ РАЗУ не отмечался — точки нет
  // (задача 22, п. 2): пропустить можно только начатое
  it.addedAt = app.addDays(t, -1);
  assert.equal(app.missedYesterday(it, t), false, 'до первой отметки точки нет');

  // первая отметка была когда-то раньше — точка появляется
  app.toggleMark(app.addDays(t, -5), it.id);
  assert.equal(app.missedYesterday(it, t), true);

  // давно добавлен — тоже есть (сегодняшняя отметка не влияет)
  it.addedAt = app.addDays(t, -30);
  app.toggleMark(t, it.id);
  assert.equal(app.missedYesterday(it, t), true);

  // отмечен вчера — точки нет
  app.toggleMark(app.addDays(t, -1), it.id);
  assert.equal(app.missedYesterday(it, t), false);

  // единственная отметка — сегодняшняя: пункт начат ТОЛЬКО СЕГОДНЯ, и
  // вчерашний пропуск задним числом «начатым» не становится (задача 24,
  // п. 7): точка появится назавтра обычным путём. Прежде тут стояло
  // true — расхождение с точечным путём, решённое в пользу последнего.
  const fresh = s.items[1];
  fresh.addedAt = app.addDays(t, -30);
  assert.equal(app.missedYesterday(fresh, t), false, 'ни одной отметки — точки нет');
  app.toggleMark(t, fresh.id);
  assert.equal(app.missedYesterday(fresh, t), false, 'первая отметка сегодня — вчера ещё не «пропуск»');
  // назавтра «вчера» — это сегодняшний отмеченный день, пропуска нет;
  // а первый настоящий пропуск (день t+1) точку даёт обычным путём
  assert.equal(app.missedYesterday(fresh, app.addDays(t, 1)), false, 'вчера был отмечен');
  assert.equal(app.missedYesterday(fresh, app.addDays(t, 2)), true, 'первый пропуск после начала — точка');
});

/* Задача 27, п. 3.2. Проверка `addedAt <= вчера` до задачи 27 не сторожилась
   ничем: у пункта, заведённого сегодня, отметок раньше сегодняшнего дня через
   интерфейс не бывает (круг ставит только сегодня, точка требует того самого
   addedAt), и everMarked гасил точку сам собой. Мутант «проверка снята» на
   этом и выжил. Состояние достижимо импортом файла или правкой руками — а
   импорт проходит через migrate, который отметки за дни до addedAt не чистит
   (инвариант 6: данные владельца первичны). Проверяем именно этот вход. */
test('И7: пункт, заведённый сегодня, точки не получает даже при отметках в прошлом', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const it = s.items[0];
  it.addedAt = t;                                   // заведён сегодня
  s.days[app.addDays(t, -2)] = { [it.id]: true };   // а в файле — отметка позавчера

  assert.equal(app.everMarked(it, app.addDays(t, -1)), true, 'отметка до вчера в данных есть');
  assert.equal(app.missedYesterday(it, t), false, 'вчера пункта ещё не было — пропуска нет');

  // сдвинем addedAt на вчера — та же отметка теперь даёт точку обычным путём
  it.addedAt = app.addDays(t, -1);
  assert.equal(app.missedYesterday(it, t), true, 'существовал вчера, начат раньше — точка есть');
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
  assert.deepEqual(app.minDayMarks(y), { done: 1, total: 2, skipped: 0, planned: 2 }); // Р2: пропусков нет — знаменатель равен плану
  assert.equal(app.minDayClosed(y), false, 'отмечено не всё');
  app.toggleMark(y, 'm2');
  assert.equal(app.minDayClosed(y), true);

  // привычка в планку минимума не входит (инвариант 10)
  s.items.push(mkMin('h1', app.addDays(t, -60), 'habit'));
  assert.equal(app.minDayClosed(y), true);
  // как и недельный счётчик
  s.items.push(Object.assign(mkMin('w1', app.addDays(t, -60)), { type: 'weekly', goal: 3 }));
  assert.equal(app.minDayClosed(y), true);

  // пункт, убранный СЕГОДНЯ, из вчерашнего расчёта не выпадает: уход
  // действует с сегодняшнего дня включительно (инвариант 12)
  const m2 = s.items.find(i => i.id === 'm2');
  m2.removedAt = t;
  assert.deepEqual(app.minDayMarks(y), { done: 2, total: 2, skipped: 0, planned: 2 }, 'вчера не сдвинулось');
  assert.deepEqual(app.minDayMarks(t), { done: 0, total: 1, skipped: 0, planned: 1 }, 'а сегодня пункта уже нет');
  // убранный в день заведения не попадает в знаменатель ни одного дня
  m2.removedAt = m2.addedAt;
  assert.deepEqual(app.minDayMarks(y), { done: 1, total: 1, skipped: 0, planned: 1 });

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

  // Источник ряда ОДИН — история планки. Вторым был ladderLog: пункт без
  // истории значений получал ступеньку по журналу лестницы. Лестница снята
  // задачей 28.D, и журнал в «Подъём» больше не идёт — сколько бы записей
  // в нём ни лежало.
  const l = mkMin('l1', app.addDays(t, -30));
  l.ladderLog = [
    { date: app.addDays(t, -30), step: 0, text: 'первая', start: true },
    { date: app.addDays(t, -10), step: 1, text: 'вторая' },
    { date: app.addDays(t, -5), step: 2, text: 'третья' }
  ];
  assert.equal(app.riseSeries(l), null, 'журнал лестницы визуала не даёт');
  l.history = [{ date: app.addDays(t, -30), value: 1 }, { date: t, value: 3 }];
  assert.equal(app.riseSeries(l).kind, 'bar', 'а история планки — даёт');

  // все записи одним днём: путь строится по индексу, деления на ноль нет
  const same = mkMin('s1', t);
  same.history = [{ date: t, value: 1 }, { date: t, value: 2 }];
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

  // задача 22, п. 1: две пустые недели у пункта, которого НЕ НАЧИНАЛИ,
  // предложения не дают — облегчать нечего, планка ещё не проверялась
  assert.equal(app.lowerEligible(item), false, 'ни одной отметки за всё время — предложения нет');

  // тот же пункт, но однажды отмеченный: две пустые недели — не держится
  app.toggleMark(app.addDays(W[0], -7), item.id);
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

  // область привычек и убранный пункт предложения не получают
  const habit = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  assert.equal(app.lowerEligible(habit), false);
  item.removedAt = app.todayKey();
  assert.equal(app.lowerEligible(item), false);
  item.removedAt = null;

  // пункт без числовой планки предложение получает — решение сводится
  // к «Оставить», кнопки шага у него нет (lowerSuggest === null)
  const noValue = s.items.find(i => i.name === 'Умыться');
  assert.equal(app.lowerEligible(noValue), false, 'и он должен быть начат');
  app.toggleMark(app.addDays(W[0], -7), noValue.id);
  assert.equal(app.lowerEligible(noValue), true);
  assert.equal(app.lowerSuggest(noValue.value), null);

  // граница окна: отметка ПОСЛЕ последнего дня разбираемых недель пункт
  // начатым не делает — окно смотрит только назад (задача 22, п. 1.1)
  const late = s.items.find(i => i.name === 'Пешком');
  app.toggleMark(app.addDays(W[1], 7), late.id); // понедельник текущей недели
  assert.equal(app.lowerEligible(late), false, 'отметка за пределами окна не считается');
  app.toggleMark(app.addDays(W[1], 6), late.id); // последний день окна
  assert.equal(app.lowerEligible(late), true, 'последний день окна входит');
});

test('З16C: понижение — планка, история, срез недели и якорь; «Оставить» гасит до недели после', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Пешком'); // value 500
  // пункт начат: без единой отметки предложения не бывает (задача 22, п. 1)
  app.toggleMark(app.addDays(app.closedWeeks(2)[0], -7), item.id);
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
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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
  assert.deepEqual(app.liveExercises().map(e => e.id), [b.id, a.id]);
  b.removedAt = app.todayKey();
  assert.deepEqual(app.liveExercises().map(e => e.id), [a.id]);
});

test('З16D: миграция v11→v12 — упражнения и сессии, мусор отброшен, идемпотентно', () => {
  setNow(2026, 8, 13, 12, 0);
  const v11 = app.defaultStore();
  v11.schemaVersion = 11;
  delete v11.exercises;
  delete v11.sessions;

  const m = app.migrate(JSON.parse(JSON.stringify(v11)));
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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
  assert.equal(m2.exercises[0].removedAt, null);
  assert.equal('active' in m2.exercises[0], false, 'поле active снято миграцией');
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

/* ── Задача 16, фаза E. Заметки: экрана нет, данные есть ────
   Экран снят задачей 28.C — доменные функции работы с заметками ушли
   вместе с ним. Осталась нормализация в migrate: она и есть гарантия,
   что заметки владельца переживут снятие экрана и любое обновление. */

test('З16E: миграция v12→v13 и экспорт → импорт заметок', () => {
  setNow(2026, 8, 13, 12, 0);
  const v12 = app.defaultStore();
  v12.schemaVersion = 12;
  delete v12.notes;

  const m = app.migrate(JSON.parse(JSON.stringify(v12)));
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
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

/* Главный тест задачи 28.C: экран снят, ДАННЫЕ ЦЕЛЫ. Store владельца
   с заметками обоих видов проходит migrate без единой потери, дважды
   подряд даёт побайтово тот же результат и не теряет ничего на пути
   «внешний файл → migrate». Схема при этом остаётся 16: снятие поля —
   отдельное решение, и до него ни один байт не пропадает. */
test('З28C: снятие экрана не трогает данные — notes переживает migrate байт в байт', () => {
  setNow(2026, 8, 13, 12, 0);
  const t = app.todayKey();
  const owner = app.defaultStore();
  assert.deepEqual(owner.notes, [], 'новый store выписок посева не несёт');

  // реалистичный store владельца: пять посевных выписок прежних версий
  // плюс собственные заметки — ровно то, что лежит у него сейчас
  owner.notes = [
    { id: 'q1', date: '2026-07-18', text: 'Капля точит камень не силой, а частым падением.', kind: 'quote', source: 'Овидий', updatedAt: 5 },
    { id: 'q2', date: '2026-07-18', text: 'Путь в тысячу ли начинается под ногами.', kind: 'quote', source: 'Лао-цзы', updatedAt: 4 },
    { id: 'q3', date: '2026-07-18', text: 'Начал — половину сделал.', kind: 'quote', source: 'Гораций', updatedAt: 3 },
    { id: 'q4', date: '2026-07-18', text: 'Кто везде — тот нигде.', kind: 'quote', source: 'Сенека', updatedAt: 2 },
    { id: 'q5', date: '2026-07-18', text: 'Делай каждое дело так, будто оно последнее.', kind: 'quote', source: 'Марк Аврелий', updatedAt: 1 },
    { id: 'n1', date: '2026-08-01', text: 'своя мысль', kind: 'note', source: '', updatedAt: 100 },
    { id: 'n2', date: t, text: 'вторая своя', kind: 'note', source: '', updatedAt: 200 }
  ];
  const before = JSON.parse(JSON.stringify(owner.notes));

  // 1) migrate ничего не теряет и не переписывает
  const m = app.migrate(JSON.parse(JSON.stringify(owner)));
  // Схема поднялась до текущей — но не заметками: их снятие схему не
  // трогало и не тронет (28.C), номер сдвинула другая задача (уход пункта,
  // v17). Сторож здесь не про число, а про сохранность записей ниже.
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
  assert.equal(m.notes.length, 7, 'все семь записей на месте');
  assert.deepEqual(m.notes, before, 'ни одно поле не изменилось');
  assert.deepEqual(m.notes.filter(n => n.kind === 'quote').map(n => n.source),
    ['Овидий', 'Лао-цзы', 'Гораций', 'Сенека', 'Марк Аврелий'], 'источники выписок целы');

  // 2) двойной прогон побайтово совпадает
  const once = JSON.stringify(m);
  const twice = JSON.stringify(app.migrate(JSON.parse(once)));
  assert.equal(twice, once, 'migrate идемпотентна побайтово');

  // 3) тот же файл как ВНЕШНИЙ (импорт, возврат копии) — посев не запускается,
  //    заметки не теряются, счёт потерь их не называет
  const ext = app.migrate(JSON.parse(once), { external: true });
  assert.deepEqual(ext.notes, before, 'внешний путь заметок не теряет');
  const was = app.dataCounts(JSON.parse(once));
  const now = app.dataCounts(ext);
  assert.equal(was.notes, 7, 'категория заметок в счёте потерь жива');
  assert.equal(app.droppedLine(was, now), '', 'потерь нет — строки нет');
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

/* ── Задача 16.1. Обратимая чистка ─────────────────────────── */

/* localStorage в Node нет: домен работает в памяти, а чистка обязана
   писать копию. Подставляем минимальную реализацию на объекте. */
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

/* Наполненное хранилище: пункт с лестницей, отметки, разбор, упражнение,
   тренировка и заметка — чтобы было чему исчезать */
function filledStore() {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  s.settings.dayBoundary = 6;         // не дефолтная граница: должна пережить чистку
  s.settings.dayThreshold = 0.5;      // и не дефолтный порог зачёта дня (задача 17, п. 5)
  s.settings.calendarSince = app.addDays(app.weekStartOf(t), -70);
  app.toggleMark(t, s.items[0].id);
  app.toggleMark(app.addDays(t, -1), s.items[0].id);
  s.reviews.push({ closedAt: 1, week: app.addDays(app.weekStartOf(t), -7), keys: [], perItem: {}, trainings: {}, oneChange: '', raises: [], lowers: [], params: [] });
  // Лестницу в интерфейсе больше не заводят (механика снята задачей 28.D),
  // но поле живёт в store и в счёт чистки идёт — кладём его прямо, ровно
  // так оно и лежит у владельца (тот же приём, что с заметкой ниже)
  s.items[0].ladder = { steps: ['первая', 'вторая'], step: 0, steppedWeek: null, startedAt: app.todayKey(), done: false };
  s.items[0].ladderLog = [{ date: app.todayKey(), step: 0, text: 'первая', start: true }];
  const ex = app.addExercise('Жим', 'кг', 40);
  app.recordSession(s.items.find(i => i.type === 'weekly').id, [{ exId: ex.id, value: 42 }], 'заметка тренировки');
  // Заводить заметку через UI больше нечем (экран снят задачей 28.C),
  // но данные живут: кладём запись прямо в store — ровно так она и лежит
  // у владельца, и чистка обязана считать её наравне с остальным
  s.notes.push({ id: 'n-мысль', date: t, text: 'мысль', kind: 'note', source: '', updatedAt: 1 });
  return s;
}

test('З16.1: чистка обнуляет всё, граница дня остаётся, эпоха — понедельник не в прошлом', () => {
  fakeLocalStorage();
  const before = filledStore();
  const t = app.todayKey();
  assert.ok(before.items.length > 0 && Object.keys(before.days).length > 0);

  assert.equal(app.wipeAll(), true);
  const s = app.store;

  assert.deepEqual(s.items, []);
  assert.deepEqual(s.groups, []);
  assert.deepEqual(s.days, {});
  assert.deepEqual(s.weekLog, []);
  assert.deepEqual(s.reviews, []);
  assert.deepEqual(s.notes, []);
  assert.deepEqual(s.exercises, []);
  assert.deepEqual(s.sessions, []);
  assert.deepEqual(s.pendingRaises, []);
  assert.deepEqual(s.pendingLowers, []);
  assert.deepEqual(s.paramDecided, {});
  assert.equal(s.draftOneChange, '');
  assert.equal(s.schemaVersion, app.SCHEMA_VERSION, 'схема не меняется');

  assert.equal(s.settings.dayBoundary, 6, 'граница дня — настройка устройства, не данные');
  assert.equal(s.settings.exportedAt, null);
  assert.equal(s.settings.habitSeeded, true, 'стартовых привычек не появляется');
  assert.equal(s.settings.calendarSince, app.weekStartOf(s.settings.calendarSince), 'понедельник');
  assert.ok(s.settings.calendarSince >= t, 'эпоха начинается не в прошлом');
  assert.ok(app.diffDays(s.settings.calendarSince, t) <= 6);

  // пустая эпоха: домен не падает и молчит
  assert.equal(app.daysInSystem(), 0);
  assert.equal(app.dayStreak(), 0);
  assert.equal(app.reviewDue(), false);
  assert.equal(app.currentWeekStart(), null);
  clearLocalStorage();
});

test('З16.1: копия пишется целиком, «Вернуть» возвращает состояние побайтово', () => {
  const mem = fakeLocalStorage();
  const before = filledStore();
  const snapshot = JSON.parse(JSON.stringify(before));
  const stats = app.wipeStats(before);

  app.wipeAll();
  const copy = app.wipedCopy();
  assert.ok(copy, 'копия на месте');
  assert.deepEqual(copy.store, snapshot, 'прежний store целиком');
  assert.deepEqual(copy.stats, stats);
  assert.equal(typeof copy.wipedAt, 'number');
  assert.deepEqual(Object.keys(stats).sort(),
    ['days', 'exercises', 'groups', 'items', 'ladders', 'modeLog', 'modes', 'notes', 'reviews', 'sessions']);
  assert.equal(stats.ladders, 1);
  assert.equal(stats.notes, 1);
  assert.equal(stats.sessions, 1);

  assert.equal(app.restoreWiped(), true);
  assert.deepEqual(app.store, snapshot, 'состояние вернулось побайтово');
  assert.equal(app.wipedCopy(), null, 'после возврата копии нет');
  assert.equal(mem[app.WIPE_KEY], undefined);
  assert.equal(app.restoreWiped(), false, 'возвращать больше нечего');
  clearLocalStorage();
});

test('З16.1: «Стереть копию» удаляет ключ, повторная чистка заменяет копию', () => {
  const mem = fakeLocalStorage();
  filledStore();

  app.wipeAll();
  assert.ok(mem[app.WIPE_KEY]);
  app.dropWiped();
  assert.equal(app.wipedCopy(), null);
  app.dropWiped(); // повтор не падает

  // копия — одна, последняя: вторая чистка перезаписывает первую
  const first = filledStore();
  app.wipeAll();
  const one = app.wipedCopy();
  assert.equal(one.store.items.length, first.items.length);

  // пустой store чуть наполнился (запись кладём прямо в него: экран снят)
  app.store.notes.push({ id: 'n-после', date: app.todayKey(), text: 'после первой чистки', kind: 'note', source: '', updatedAt: 1 });
  const second = JSON.parse(JSON.stringify(app.store));
  app.wipeAll();
  const two = app.wipedCopy();
  assert.deepEqual(two.store, second, 'в копии — состояние перед последней чисткой');
  assert.equal(two.store.items.length, 0);
  assert.notDeepEqual(two.store, one.store);
  clearLocalStorage();
});

test('З16.1: чистка идемпотентна, экспортируется текущий store, копия ему чужая', () => {
  fakeLocalStorage();
  filledStore();
  assert.equal(app.wipeAll(), true);
  assert.equal(app.wipeAll(), true, 'повторная чистка не падает');
  assert.deepEqual(app.store.items, []);

  // экспорт и импорт живут только текущим store: копия к ним не относится
  const copy = app.wipedCopy();
  assert.ok(copy);
  const exported = JSON.parse(JSON.stringify(app.store));
  assert.deepEqual(exported.items, [], 'экспорт после чистки — пустой store');
  assert.equal('wiped' in exported, false);
  const imported = app.migrate(exported);
  assert.deepEqual(imported.items, []);
  assert.ok(app.wipedCopy(), 'импорт копию не трогает');
  clearLocalStorage();
});

test('З16.1: без места под копию чистка не выполняется — данные остаются', () => {
  fakeLocalStorage();
  const before = filledStore();
  const snapshot = JSON.parse(JSON.stringify(before));
  const real = global.localStorage.setItem;
  global.localStorage.setItem = (k) => { if (k === app.WIPE_KEY) throw new Error('quota'); };

  assert.equal(app.wipeAll(), false);
  assert.deepEqual(app.store, snapshot, 'store не тронут');

  global.localStorage.setItem = real;
  clearLocalStorage();
});

/* ── Задача 17. Посев, доля дня, серия ─────────────────────── */

/* Пустой store схемы v14 без флага посева — вход migrate для п. 1 */
function seedInput(extra) {
  return Object.assign({
    schemaVersion: 14, items: [], groups: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: '2026-08-13',
    settings: { dayBoundary: 4, exportedAt: null, calendarSince: '2026-08-10', habitSeeded: true }
  }, extra);
}

test('З17: посев — пустой store получает программу, блоки и флаг, но не выписки', () => {
  setNow(2026, 8, 13, 12, 0);
  const m = app.migrate(seedInput());
  const t = app.todayKey();

  assert.equal(m.items.length, 9);
  assert.deepEqual(m.groups.map(g => g.name), ['Утро', 'Подряд', 'Движение']);
  assert.deepEqual(m.items.map(i => i.name), [
    'Умыться', 'Принять душ', 'Подтягивания + отжимания', 'Английский',
    'Развитие', 'Пешком', 'Тренировка', 'Телефон вне кровати', 'Отбой']);
  assert.equal(m.items.every(i => i.addedAt === t), true, 'всё заведено сегодня');
  assert.deepEqual(m.items.map(i => (i.group || '')), [
    'Утро', 'Утро', 'Подряд', 'Подряд', 'Подряд', 'Движение', '', '', '']);

  // числовые пункты несут стартовую запись истории (п. 1.4)
  const byName = n => m.items.find(i => i.name === n);
  assert.deepEqual(byName('Подтягивания + отжимания').history, [{ date: t, value: 5 }]);
  assert.equal(byName('Английский').value, 5);
  assert.equal(byName('Английский').unit, 'мин');
  assert.equal(byName('Пешком').value, 500);
  assert.equal(byName('Пешком').unit, 'м');
  assert.deepEqual(byName('Умыться').history, [], 'пункт без числа истории не получает');

  // недельный счётчик, привычка и параметр
  const tr = byName('Тренировка');
  assert.equal(tr.type, 'weekly');
  assert.equal(tr.goal, 3);
  assert.equal(tr.note, 'Полноценная тренировка, 40–50 минут');
  const ph = byName('Телефон вне кровати');
  assert.equal(ph.area, 'habit');
  assert.equal(ph.type, 'daily');
  assert.equal(ph.normPerWeek, 7);
  const ot = byName('Отбой');
  assert.equal(ot.type, 'param');
  assert.equal(ot.area, 'habit');
  assert.equal(ot.pkind, 'time');
  assert.equal(ot.pvalue, 0);
  assert.equal(ot.pstep, -15);

  // выписок посев больше не заводит: экран «Заметки» снят задачей 28.C,
  // а сеять записи в экран, которого нет, значило бы прятать их от владельца
  assert.deepEqual(m.notes, [], 'ни одной посевной выписки');
  assert.equal(m.settings.seed17, true);
});

test('З17: посев одноразов — непустые данные не трогает, повтор не дублирует', () => {
  setNow(2026, 8, 13, 12, 0);
  // непустой store: ни программы, ни выписок, ни флага
  const busy = app.migrate(seedInput({
    items: [{ id: 'x1', name: 'Своё', addedAt: '2026-08-01', type: 'daily', area: 'min' }]
  }));
  assert.equal(busy.items.length, 1);
  assert.deepEqual(busy.notes, []);
  assert.equal('seed17' in busy.settings, false, 'на непустых данных флаг не ставится');

  // повторный прогон migrate засеянного store ничего не добавляет
  const once = app.migrate(seedInput());
  const twice = app.migrate(JSON.parse(JSON.stringify(once)));
  assert.equal(twice.items.length, 9);
  assert.deepEqual(twice.notes, []);
  assert.deepEqual(twice, once, 'migrate идемпотентна и после посева');

  // импорт чужих данных посев не запускает
  const foreign = app.migrate({
    schemaVersion: 5, items: [{ id: 'f1', name: 'Чужой', addedAt: '2026-07-01' }],
    days: {}, settings: { dayBoundary: 4 }
  });
  assert.deepEqual(foreign.items.map(i => i.name), ['Чужой']);
  assert.deepEqual(foreign.notes, []);
});

test('З17: чистка ставит флаг посева — пустой лист остаётся пустым после перезапуска', () => {
  setNow(2026, 8, 13, 12, 0);
  const empty = app.emptyStore(4);
  assert.equal(empty.settings.seed17, true);
  const reloaded = app.migrate(JSON.parse(JSON.stringify(empty)));
  assert.deepEqual(reloaded.items, [], 'следующий старт программу не возвращает');
  assert.deepEqual(reloaded.notes, []);
});

/* Пять пунктов минимума, заведённых до начала эпохи */
function scoreStore(n = 5) {
  setNow(2026, 8, 13, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const old = app.addDays(t, -60);
  s.items = Array.from({ length: n }, (_, i) => mkMin('m' + i, old));
  s.days = {};
  s.settings.calendarSince = old;
  s.settings.dayThreshold = 0.8;
  return s;
}

/* Отметить в дне ровно count первых пунктов (повторяемо) */
function setScore(dayKey, count) {
  app.store.items.forEach((it, i) => {
    if (app.isMarked(dayKey, it.id) !== (i < count)) app.toggleMark(dayKey, it.id);
  });
}

test('З17: dayScore — доля по существовавшим в тот день пунктам, без них null', () => {
  const s = scoreStore(4);
  const t = app.todayKey();
  const y = app.addDays(t, -1);

  assert.equal(app.dayScore(y), 0);
  setScore(y, 3);
  assert.equal(app.dayScore(y), 0.75);
  setScore(y, 4);
  assert.equal(app.dayScore(y), 1);

  // пункт, добавленный сегодня, прошлые дни не портит
  s.items.push(mkMin('later', t));
  assert.equal(app.dayScore(y), 1, 'вчера его не существовало');
  assert.equal(app.dayScore(t), 0, 'а сегодня он в знаменателе');
  assert.deepEqual(app.minDayMarks(t), { done: 0, total: 5, skipped: 0, planned: 5 }); // Р2: без пропусков знаменатель — весь план

  // применимых пунктов нет — null, и день выпадает из счёта серии
  s.items = [];
  assert.equal(app.dayScore(y), null);
  assert.equal(app.dayStreak(), 0);
});

test('З17: dayNeed и порог — сколько отметок даёт зачёт', () => {
  const s = scoreStore(5);
  assert.equal(app.dayThreshold(), 0.8);
  assert.equal(app.dayNeed(5), 4);
  assert.equal(app.dayNeed(6), 5);
  assert.equal(app.dayNeed(0), 0);

  s.settings.dayThreshold = 0.5;
  assert.equal(app.dayNeed(5), 3);
  s.settings.dayThreshold = 1;
  assert.equal(app.dayNeed(5), 5);
  s.settings.dayThreshold = 0.3;
  assert.equal(app.dayNeed(5), 2);

  // порог из внешних данных зажимается в [0,3..1,0] и округляется до десятой
  assert.equal(app.clampThreshold(0.84), 0.8);
  assert.equal(app.clampThreshold(0), 0.3);
  assert.equal(app.clampThreshold(5), 1);
  assert.equal(app.clampThreshold('мусор'), 0.8);
});

test('З17: серия — зачтённый +1, амнистия раз в неделю, два подряд обрывают', () => {
  const s = scoreStore(5);
  const t = app.todayKey();
  const day = n => app.addDays(t, -n);

  assert.equal(app.dayStreak(), 0);

  // 4 из 5 — зачёт при пороге 0,8; 3 из 5 — нет
  setScore(day(1), 4); setScore(day(2), 5);
  assert.equal(app.dayStreak(), 2, 'незачтённый сегодня пропускается');
  setScore(day(0), 4);
  assert.equal(app.dayStreak(), 3, 'зачтённый сегодня идёт в счёт');

  // день −3 незачтён (3 из 5): первая амнистия, в счёт не идёт
  setScore(day(3), 3);
  setScore(day(4), 5); setScore(day(5), 5);
  assert.equal(app.dayStreak(), 5);

  // −6 незачтён: до прошлой амнистии 3 дня — обрыв, дальше не считаем
  for (let n = 7; n <= 12; n++) setScore(day(n), 5);
  assert.equal(app.dayStreak(), 5, 'вторая амнистия ближе недели — обрыв');

  // отодвинем вторую амнистию за неделю: −6 зачтён, незачтён −11
  setScore(day(6), 5); setScore(day(11), 0);
  for (let n = 13; n <= 16; n++) setScore(day(n), 5);
  assert.equal(app.dayStreak(), 15, 'между амнистиями 8 дней — прощается');

  // два незачтённых подряд обрывают всегда
  setScore(day(12), 0);
  assert.equal(app.dayStreak(), 10);
});

test('З17: серия — дни до calendarSince в счёт не идут, порог меняет результат', () => {
  const s = scoreStore(5);
  const t = app.todayKey();
  for (let n = 0; n <= 6; n++) setScore(app.addDays(t, -n), 4); // ровно 4 из 5 каждый день

  assert.equal(app.dayStreak(), 7);
  s.settings.calendarSince = app.addDays(t, -3);
  assert.equal(app.dayStreak(), 4, 'дно счёта — начало эпохи');

  s.settings.calendarSince = app.addDays(t, -60);
  s.settings.dayThreshold = 1;
  assert.equal(app.dayStreak(), 0, 'при пороге 1,0 те же дни не зачтены');
  s.settings.dayThreshold = 0.3;
  assert.equal(app.dayStreak(), 7, 'при пороге 0,3 — зачтены все');
});

test('З17: bestStreak — максимум по всей истории, два разрыва', () => {
  const s = scoreStore(5);
  const t = app.todayKey();
  const day = n => app.addDays(t, -n);
  s.settings.calendarSince = day(20);

  // −20…−15 зачтены (6 дней), −14 и −13 подряд пусты — разрыв
  for (let n = 15; n <= 20; n++) setScore(day(n), 5);
  // −12…−10 зачтены (3), −9 и −8 подряд пусты — второй разрыв
  for (let n = 10; n <= 12; n++) setScore(day(n), 5);
  // −7…−1 зачтены (7), сегодня пуст
  for (let n = 1; n <= 7; n++) setScore(day(n), 5);

  assert.equal(app.dayStreak(), 7, 'текущая серия — последний отрезок');
  assert.equal(app.bestStreak(), 7);

  // удлиним первый отрезок до девяти — рекорд уходит в прошлое
  s.settings.calendarSince = day(23);
  for (let n = 21; n <= 23; n++) setScore(day(n), 5);
  assert.equal(app.dayStreak(), 7);
  assert.equal(app.bestStreak(), 9);
});

test('З17: «Отметки» — знаменатель по позднейшей из дат заведения и эпохи', () => {
  const s = scoreStore(1);
  const t = app.todayKey();
  s.settings.calendarSince = app.addDays(t, -30);

  const old = s.items[0];
  assert.equal(app.marksWindow(old), 31, 'пункт старше эпохи — вся эпоха');

  const fresh = mkMin('fresh', app.addDays(t, -1));
  s.items.push(fresh);
  assert.equal(app.marksWindow(fresh), 2, 'заведён вчера — «из 2», а не «из 31»');
  app.toggleMark(app.addDays(t, -1), 'fresh');
  assert.equal(app.marksInSystem(fresh), 1);

  // пункт, заведённый в будущем (рукотворные данные), окна не имеет
  s.items.push(mkMin('future', app.addDays(t, 3)));
  assert.equal(app.marksWindow(s.items[2]), 0);
});

test('З17: выписки — kind и source достраиваются миграцией, вид не теряется', () => {
  setNow(2026, 8, 13, 12, 0);
  const m = app.migrate(seedInput({
    settings: { dayBoundary: 4, exportedAt: null, calendarSince: '2026-08-10', habitSeeded: true, seed17: true },
    items: [{ id: 'x1', name: 'Своё', addedAt: '2026-08-01' }],
    notes: [
      { id: 'n1', date: '2026-08-12', text: '  мысль  ', updatedAt: 5 },
      { id: 'n2', date: '2026-08-11', text: 'цитата', kind: 'quote', source: '  Сенека  ', updatedAt: 4 },
      { id: 'n3', date: '2026-08-10', text: 'заметка', kind: 'quote' },
      { id: 'n4', date: '2026-08-09', text: 'чужой source', source: 'кто-то', updatedAt: 1 }
    ]
  }));

  assert.deepEqual(m.notes.map(n => [n.kind, n.text, n.source]), [
    ['note', 'мысль', ''],
    ['quote', 'цитата', 'Сенека'],
    ['quote', 'заметка', ''],
    ['note', 'чужой source', ''] // источник живёт только у выписки
  ]);
  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again.notes, m.notes);
});

test('З17: начало отсчёта — понедельник недели, пересчёт «в системе» и серии', () => {
  const s = scoreStore(5);
  const t = app.todayKey(); // 2026-08-13, четверг
  for (let n = 0; n <= 10; n++) setScore(app.addDays(t, -n), 5);

  s.settings.calendarSince = app.weekStartOf('2026-08-13');
  assert.equal(s.settings.calendarSince, '2026-08-10');
  assert.equal(app.daysInSystem(), 4);
  assert.equal(app.dayStreak(), 4);

  s.settings.calendarSince = app.weekStartOf('2026-08-05'); // среда → её понедельник
  assert.equal(s.settings.calendarSince, '2026-08-03');
  assert.equal(app.daysInSystem(), 11);
  assert.equal(app.dayStreak(), 11);

  // migrate приводит рукотворный не-понедельник к понедельнику (вперёд)
  const m = app.migrate(seedInput({
    items: [{ id: 'x1', name: 'Своё', addedAt: '2026-08-01' }],
    settings: { dayBoundary: 4, calendarSince: '2026-08-05', habitSeeded: true }
  }));
  assert.equal(app.weekStartOf(m.settings.calendarSince), m.settings.calendarSince);
});

/* ── Задача 17, доводка: посев и defaultStore — один набор ──── */

/* Сравнимая форма набора: id генерируются, всё остальное обязано совпасть */
function shape(store) {
  const strip = o => { const c = Object.assign({}, o); delete c.id; return c; };
  return {
    groups: store.groups.map(g => Object.assign({}, g)),
    items: store.items.map(strip),
    notes: store.notes.map(strip)
  };
}

test('З17: defaultStore и посев дают один и тот же стартовый набор', () => {
  setNow(2026, 8, 13, 12, 0);
  const def = app.defaultStore();
  const seeded = app.migrate(seedInput());

  assert.deepEqual(shape(def), shape(seeded), 'наборы разошлись — фабрика одна');
  assert.equal(def.items.length, 9);
  assert.equal(def.groups.length, 3);
  // выписок нет ни у одной из двух фабрик — вырез симметричен (задача 28.C);
  // ключ notes остаётся в shape() и сторожит именно эту симметрию
  assert.deepEqual(def.notes, []);
  assert.equal(def.settings.seed17, true, 'программа уже здесь — migrate не сеет повторно');

  // id всё же уникальны: фабрика зовётся дважды, а не отдаёт один объект
  const ids = def.items.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(def.items[0].id === seeded.items[0].id, false);

  // прогон дефолта через migrate ничего не добавляет и не меняет
  const again = app.migrate(JSON.parse(JSON.stringify(def)));
  assert.deepEqual(shape(again), shape(def));
  assert.equal(again.items.length, 9);
});

test('З17: порог зачёта дня переживает чистку наравне с границей дня', () => {
  fakeLocalStorage();
  const s = filledStore(); // граница 6, порог 0,5
  assert.equal(s.settings.dayBoundary, 6);
  assert.equal(s.settings.dayThreshold, 0.5);

  assert.equal(app.wipeAll(), true);
  assert.equal(app.store.settings.dayBoundary, 6, 'граница дня выжила');
  assert.equal(app.store.settings.dayThreshold, 0.5, 'порог зачёта тоже');
  assert.deepEqual(app.store.items, [], 'но данных не осталось');

  // мусорный порог в прежнем store приводится к допустимому, а не переносится
  assert.equal(app.emptyStore(4, 'мусор').settings.dayThreshold, 0.8);
  assert.equal(app.emptyStore(4, 5).settings.dayThreshold, 1);
  assert.equal(app.emptyStore(4).settings.dayThreshold, 0.8);
  clearLocalStorage();
});

/* ── Задача 19, фаза A. Ремонт по аудиту ───────────────────── */

test('З19/A.2.2: пустой файл старой схемы импортируется пустым — посева нет', () => {
  setNow(2026, 7, 17, 12, 0);
  // экспорт версии до задачи 17, снятый сразу после чистки: items пуст,
  // флага seed17 в той схеме ещё не существовало (аудит, находка 3)
  const file = {
    schemaVersion: 13, items: [], groups: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    draftOneChange: '', weekStart: '2026-06-01',
    settings: { dayBoundary: 4, exportedAt: null, calendarSince: '2026-06-01', habitSeeded: true }
  };
  const imported = app.migrate(JSON.parse(JSON.stringify(file)), { external: true });
  assert.equal(imported.items.length, 0, 'ни одного пункта');
  assert.equal(imported.groups.length, 0, 'ни одного блока');
  assert.equal(imported.notes.length, 0, 'ни одной выписки');

  // флаги проставлены — следующий старт (уже как «первый запуск») тоже не сеет
  assert.equal(imported.settings.seed17, true);
  assert.equal(imported.settings.habitSeeded, true);
  const restart = app.migrate(JSON.parse(JSON.stringify(imported)));
  assert.equal(restart.items.length, 0, 'перезапуск пустой лист не засевает');

  // тот же файл БЕЗ external — путь первого запуска, посев на месте
  const first = app.migrate(JSON.parse(JSON.stringify(file)));
  assert.equal(first.items.length, 9, 'первый запуск программу получает');

  // и самая старая схема: v1 с пустым списком тоже остаётся пустой
  const v1 = app.migrate({ schemaVersion: 1, items: [], settings: {} }, { external: true });
  assert.equal(v1.items.length, 0, 'ни посева, ни «Принять душ», ни привычек v5');
});

test('З19/A.3.2: лестница на weekly и param снимается миграцией, у daily остаётся', () => {
  setNow(2026, 7, 17, 12, 0);
  const ladder = () => ({ steps: ['а', 'б', 'в'], step: 1, steppedWeek: null, startedAt: '2026-06-01' });
  const s = app.migrate({
    schemaVersion: 14, settings: { seed17: true }, items: [
      { id: 'w1', name: 'Тренировка', type: 'weekly', area: 'min', goal: 3, addedAt: '2026-01-01',
        ladder: ladder(), ladderLog: [{ date: '2026-06-01', step: 0, text: 'а', start: true }] },
      { id: 'p1', name: 'Отбой', type: 'param', area: 'habit', pkind: 'time', pvalue: 0, pstep: -15,
        addedAt: '2026-01-01', ladder: ladder(), ladderLog: [] },
      { id: 'd1', name: 'Английский', type: 'daily', area: 'min', value: 5, addedAt: '2026-01-01',
        ladder: ladder(), ladderLog: [] }
    ]
  });
  app.store = s;
  const [w, p, d] = s.items;
  assert.equal(w.ladder, null, 'у недельного счётчика лестницы нет');
  assert.equal(p.ladder, null, 'у параметра тоже');
  assert.ok(d.ladder, 'у ежедневного пункта осталась');
  assert.deepEqual(d.ladder.steps, ['а', 'б', 'в'], 'и осталась целиком');
  // журнал не тронут: снятие лестницы ladderLog не изменяет
  assert.equal(w.ladderLog.length, 1);
  assert.deepEqual(w.ladderLog[0], { date: '2026-06-01', step: 0, text: 'а', start: true });
});

test('З19/A.4.3: пункт, заведённый сегодня, предложения «Сделать легче» не получает', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const t = app.todayKey();
  const fresh = {
    id: 'new1', name: 'Новый пункт', value: 10, unit: 'мин', type: 'daily', area: 'min',
    goal: null, note: '', group: '', active: true, addedAt: t, raiseAfter: 0,
    raiseAfterWeek: null, lowerAfterWeek: null, history: [{ date: t, value: 10 }],
    formula: null, ladder: null, ladderLog: []
  };
  s.items.push(fresh);
  const W = app.closedWeeks(2);
  assert.ok(W[0] < t, 'обе разбираемые недели раньше заведения пункта');
  assert.equal(app.itemWeekCount(fresh, W[0]), 0);
  assert.equal(app.lowerEligible(fresh), false, 'пункта в этих неделях не было — предложения нет');

  // границу addedAt проверяем на НАЧАТОМ пункте: без отметок её съел бы
  // второй guard задачи 22 (п. 1), и тест перестал бы проверять своё
  app.toggleMark(W[0], fresh.id);
  // граница: заведён ровно в понедельник самой ранней недели — уже считается
  fresh.addedAt = W[0];
  assert.equal(app.lowerEligible(fresh), true, 'существовал с первого дня окна — предложение есть');
  fresh.addedAt = app.addDays(W[0], 1);
  assert.equal(app.lowerEligible(fresh), false, 'на день позже — уже нет');

  // повышению симметричная защита не нужна: критерий требует ≥6 отметок,
  // а у пункта, которого в тех неделях не было, отметок нет вовсе
  fresh.addedAt = t;
  assert.equal(app.raiseEligible(fresh), false);
});

test('З19/A.5.3: механики планки и привычек не читают reviews', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Подтягивания + отжимания');
  app.closedWeeks(3).forEach(w => setWeekMarks(item.id, w, 7));
  // разборов нет вовсе — повышение всё равно предлагается
  s.reviews = [];
  assert.equal(app.raiseEligible(item), true, 'пропуск разборов повышение не блокирует');
  // мусор в архиве на механику не влияет
  s.reviews = [{ perItem: { [item.id]: { count: 0 } } }, { perItem: { [item.id]: { count: 0 } } }];
  assert.equal(app.raiseEligible(item), true);
  setWeekMarks(item.id, app.closedWeeks(2)[0], 1);
  setWeekMarks(item.id, app.closedWeeks(2)[1], 1);
  assert.equal(app.lowerEligible(item), true, 'понижение тоже считает по days{}');
});

/* ── Задача 19, фаза B.1: рекорд считается линейно ─────────── */

/* ПРЕЖНЯЯ реализация bestStreak — эталон для дифференциального теста.
   Дословный квадратичный алгоритм: streakBack от каждого дня эпохи.
   Живёт только здесь: новая реализация обязана совпадать с ним всюду. */
function bestStreakRef() {
  const t = app.todayKey();
  const since = app.store.settings.calendarSince;
  if (!app.isDayKey(since) || t < since) return 0;
  // ключи и доли эпохи — один раз; дальше обход по индексам вместо
  // addDays. Порядок и решения ровно те же, что были в app.js: экономится
  // только конструирование Date в горячем цикле, семантика не меняется.
  const keys = [], tab = [];
  for (let k = since; k <= t; k = app.addDays(k, 1)) { keys.push(k); tab.push(app.dayScore(k)); }
  const EPSR = 1e-9, GAP = 7;
  const th = app.dayThreshold() - EPSR;
  const streakBackRef = (endIdx) => {
    let n = 0, i = endIdx;
    if (keys[i] === t) { // сегодня: незачтённое пропускается, амнистию не тратит
      const s = tab[i];
      if (s !== null && s >= th) n = 1;
      i--;
    }
    let amnesty = -1; // индекс дня последней амнистии (он позже текущего i)
    for (; i >= 0; i--) {
      const s = tab[i];
      if (s === null) continue;
      if (s >= th) { n++; continue; }
      if (amnesty >= 0 && app.diffDays(keys[amnesty], keys[i]) <= GAP) break;
      amnesty = i;
    }
    return n;
  };
  let best = 0;
  for (let i = 0; i < keys.length; i++) {
    const n = streakBackRef(i);
    if (n > best) best = n;
  }
  return best;
}

/* Детерминированный ГПСЧ: провалившийся случай воспроизводим по номеру */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('З19/B.1.2: bestStreak — 1000 случайных историй совпадают с прежней реализацией', () => {
  setNow(2026, 7, 17, 12, 0);
  const THS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  let checked = 0, maxLen = 0, sawNull = false, sawAmnesty = false;

  for (let seed = 1; seed <= 1000; seed++) {
    const rnd = mulberry32(seed);
    // длина эпохи 1–1200 дней со смещением к коротким: эталон квадратичный,
    // длинные случаи дороги, но несколько десятков их всё равно попадает
    const L = 1 + Math.floor(Math.pow(rnd(), 3) * 1200);
    const p = rnd();                       // плотность отметок 0–100 %
    const th = THS[Math.floor(rnd() * THS.length)];
    const nItems = 1 + Math.floor(rnd() * 4);

    const s = app.defaultStore();
    app.store = s;
    const t = app.todayKey();
    s.settings.dayThreshold = th;
    s.settings.calendarSince = app.addDays(t, -(L - 1));
    // пункты появляются не сразу: часть первых дней остаётся без применимых
    // пунктов, их доля null — эти дни обе реализации обязаны пропускать
    s.items = [];
    for (let n = 0; n < nItems; n++) {
      s.items.push({
        id: 'i' + n, name: 'П' + n, value: null, unit: '', type: 'daily', area: 'min',
        goal: null, note: '', group: '', active: true,
        addedAt: app.addDays(s.settings.calendarSince, Math.floor(rnd() * Math.min(L, 40))),
        raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
        formula: null, ladder: null, ladderLog: []
      });
    }
    s.days = {};
    for (let d = 0; d < L; d++) {
      const k = app.addDays(s.settings.calendarSince, d);
      const rec = {};
      for (const it of s.items) if (it.addedAt <= k && rnd() < p) rec[it.id] = true;
      if (Object.keys(rec).length) s.days[k] = rec;
    }

    const ref = bestStreakRef();
    const got = app.bestStreak();
    assert.equal(got, ref,
      `расхождение на seed=${seed}: длина ${L}, плотность ${p.toFixed(2)}, порог ${th}, пунктов ${nItems} — новая ${got}, эталон ${ref}`);
    // серия текущего дня считается тем же правилом — сверяем и её
    assert.ok(app.dayStreak() <= got, `dayStreak > bestStreak на seed=${seed}`);

    checked++;
    if (L > maxLen) maxLen = L;
    if (app.dayScore(s.settings.calendarSince) === null) sawNull = true;
    if (got > 8) sawAmnesty = true;
  }
  assert.equal(checked, 1000);
  assert.ok(maxLen > 600, `в выборке есть длинные эпохи (максимум ${maxLen})`);
  assert.ok(sawNull, 'в выборке есть дни без применимых пунктов (доля null)');
  assert.ok(sawAmnesty, 'в выборке есть серии длиннее недели — амнистия задействована');
});

test('З19/B.1: рекорд на вырожденных историях', () => {
  setNow(2026, 7, 17, 12, 0);
  const mk = (L) => {
    const s = app.defaultStore();
    app.store = s;
    s.settings.calendarSince = app.addDays(app.todayKey(), -(L - 1));
    s.items = [{
      id: 'i1', name: 'П', value: null, unit: '', type: 'daily', area: 'min',
      goal: null, note: '', group: '', active: true, addedAt: s.settings.calendarSince,
      raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
      formula: null, ladder: null, ladderLog: []
    }];
    s.days = {};
    return s;
  };
  // эпоха в один день, ничего не отмечено
  let s = mk(1);
  assert.equal(app.bestStreak(), 0);
  // эпоха в один день, отмечен
  s.days[app.todayKey()] = { i1: true };
  assert.equal(app.bestStreak(), 1);
  // пунктов нет вовсе — все доли null
  s = mk(30); s.items = [];
  assert.equal(app.bestStreak(), 0);
  // всё отмечено — рекорд равен длине эпохи
  s = mk(30);
  for (let d = 0; d < 30; d++) s.days[app.addDays(s.settings.calendarSince, d)] = { i1: true };
  assert.equal(app.bestStreak(), 30);
  assert.equal(app.dayStreak(), 30);
  // ничего не отмечено: одна амнистия в начале, дальше обрыв
  s = mk(30);
  assert.equal(app.bestStreak(), 0);
});

/* ── Задача 19, фаза C: выжившие мутанты и непокрытые инварианты ── */

test('З19/C.1.1 (И10): migrate принуждает weekly к area min', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = app.migrate({
    schemaVersion: 14, settings: { seed17: true }, items: [
      { id: 'w1', name: 'Тренировка', type: 'weekly', area: 'habit', goal: 3, addedAt: '2026-01-01' },
      { id: 'w2', name: 'Вторая', type: 'weekly', area: 'min', goal: 2, addedAt: '2026-01-01' },
      { id: 'h1', name: 'Привычка', type: 'daily', area: 'habit', addedAt: '2026-01-01' }
    ]
  });
  assert.equal(s.items[0].area, 'min', 'недельный счётчик принадлежит только минимуму');
  assert.equal(s.items[1].area, 'min');
  assert.equal(s.items[2].area, 'habit', 'ежедневную привычку это не трогает');
  assert.equal('normPerWeek' in s.items[0], false, 'норма недели — только у привычек');
});

test('З19/C.1.3 (И18): «Вернуть» проводит копию через migrate', () => {
  fakeLocalStorage();
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  s.items[0].name = 'Свой пункт';
  assert.equal(app.wipeAll(), true);

  // подменяем копию на устаревшую и мусорную: не пройди она migrate,
  // в store оказалась бы битая структура
  const c = JSON.parse(localStorage.getItem(app.WIPE_KEY));
  c.store.schemaVersion = 5;
  c.store.notes = [{ id: 'n1', text: '  выписка  ', kind: 'quote', source: 5, date: 'не-день' }];
  c.store.days['не-день'] = { x: true };
  c.store.items.push(null, { id: 'bad', type: 'weekly', area: 'habit', ladder: { steps: ['а'] } });
  c.store.settings.dayThreshold = 99;
  localStorage.setItem(app.WIPE_KEY, JSON.stringify(c));

  assert.equal(app.restoreWiped(), true);
  const r = app.store;
  assert.equal(r.schemaVersion, app.SCHEMA_VERSION, 'схема поднята — копия прошла migrate');
  assert.equal(r.settings.dayThreshold, 1, 'мусорный порог приведён к допустимому');
  assert.equal(r.items.some(i => i === null), false, 'не-объекты отброшены');
  assert.equal(r.items.find(i => i.id === 'bad').area, 'min', 'weekly приведён к минимуму');
  assert.equal(r.items.find(i => i.id === 'bad').ladder, null, 'лестница снята с не-daily');
  assert.equal('не-день' in r.days, false, 'невалидный день отброшен');
  assert.equal(r.notes[0].text, 'выписка', 'текст заметки с trim');
  assert.equal(r.notes[0].source, '', 'нестроковый источник обнулён');
  assert.ok(app.isDayKey(r.notes[0].date), 'битая дата достроена');
  clearLocalStorage();
});

test('З19/C.2 (И14): разрыв РОВНО 7 дней обрывает серию, 8 — прощается', () => {
  setNow(2026, 7, 17, 12, 0);
  const mk = () => {
    const s = app.defaultStore();
    app.store = s;
    s.settings.dayThreshold = 1;
    s.settings.calendarSince = app.addDays(app.todayKey(), -40);
    s.items = [{
      id: 'i1', name: 'П', value: null, unit: '', type: 'daily', area: 'min',
      goal: null, note: '', group: '', active: true, addedAt: s.settings.calendarSince,
      raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
      formula: null, ladder: null, ladderLog: []
    }];
    s.days = {};
    for (let n = 0; n <= 40; n++) s.days[app.addDays(app.todayKey(), -n)] = { i1: true };
    return s;
  };
  // Прощённый день серию не рвёт и в счёт не идёт: счёт продолжается сквозь
  // него и упирается в СЛЕДУЮЩИЙ пропуск, если тот ближе AMNESTY_GAP.
  // Эпоха 41 день (−40…0), пропуски −3 и −(3+gap).

  // разрыв РОВНО 7 дней: diffDays == AMNESTY_GAP → обрыв на втором пропуске.
  // Счёт: сегодня, −1, −2, затем сквозь прощённый −3 и дальше −4…−9 = 9
  let s = mk();
  delete s.days[app.addDays(app.todayKey(), -3)];
  delete s.days[app.addDays(app.todayKey(), -10)];
  assert.equal(app.dayStreak(), 9,
    'разрыв ровно 7 дней обрывает: сравнение <=, а не <');

  // 8 дней — второй пропуск тоже прощается, счёт доходит до начала эпохи:
  // 41 день минус два непрощённых-в-счёт пропуска = 39
  s = mk();
  delete s.days[app.addDays(app.todayKey(), -3)];
  delete s.days[app.addDays(app.todayKey(), -11)];
  assert.equal(app.dayStreak(), 39, 'разрыв 8 дней: счёт идёт до начала эпохи');

  // 6 дней — обрыв тем более, на день раньше
  s = mk();
  delete s.days[app.addDays(app.todayKey(), -3)];
  delete s.days[app.addDays(app.todayKey(), -9)];
  assert.equal(app.dayStreak(), 8, 'разрыв 6 дней — обрыв');

  // рекорд считает по тем же правилам: при обрыве он не меньше серии
  s = mk();
  delete s.days[app.addDays(app.todayKey(), -3)];
  delete s.days[app.addDays(app.todayKey(), -10)];
  assert.ok(app.bestStreak() >= app.dayStreak(), 'рекорд не меньше текущей серии');
});

test('З19/C.2 (И11): разбор и closeWeek на серию привычки не влияют', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  for (let w = 1; w <= 5; w++) setWeekMarks(h.id, app.addDays(app.currentWeekStart(), -7 * w), 7);
  const before = app.habitStreak(h);
  assert.equal(before, 5, 'пять недель по норме');

  assert.equal(app.closeWeek(), true);
  assert.equal(app.habitStreak(h), before, 'закрытие недели серию не изменило');
  s.reviews.push({ closedAt: 1, week: '2026-01-05', perItem: { [h.id]: { count: 0 } } });
  assert.equal(app.habitStreak(h), before, 'запись разбора серию не изменила');
  h.normPerWeek = 1;
  assert.ok(app.habitStreak(h) >= before, 'смена нормы пересчитывает серию по всей истории');
});

test('З19/C.2 (И19): пустой store старой схемы засевается один раз и правильно', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = app.migrate({ schemaVersion: 1, items: [], settings: {} });
  assert.equal(s.items.length, 9, 'программа засеяна');
  assert.equal(s.groups.map(g => g.name).join('/'), 'Утро/Подряд/Движение',
    'блоки посева, а не имена прежнего набора');
  assert.equal(s.items.some(i => i.group === 'Тело'), false, 'шаг v1→v2 блоки не переписал');
  assert.equal(s.items.filter(i => i.name === 'Принять душ').length, 1, 'душ не задвоен');
  assert.equal(s.settings.seed17, true);
  assert.equal(s.settings.habitSeeded, true, 'посев привычек v5 тоже отключён');
  const again = app.migrate(JSON.parse(JSON.stringify(s)));
  assert.equal(again.items.length, 9, 'повторный прогон ничего не добавляет');

  // непустой v1-store свои шаги получает как раньше
  const legacy = app.migrate({
    schemaVersion: 1, settings: {},
    items: [{ id: 'a', name: 'Умыться', type: 'daily', addedAt: '2026-01-01' }]
  });
  assert.ok(legacy.items.find(i => i.name === 'Принять душ'), 'душ дописывается');
  assert.equal(legacy.items.find(i => i.name === 'Умыться').group, 'Тело', 'и блоки прежнего набора');
});

test('З19/C.6.5: граница дня из внешних данных — целый час 0..23', () => {
  setNow(2026, 7, 17, 12, 0);
  const b = v => app.migrate({ schemaVersion: 14, items: [{ id: 'a', type: 'daily', addedAt: '2026-01-01' }], settings: { seed17: true, dayBoundary: v } }).settings.dayBoundary;
  assert.equal(b(4), 4);
  assert.equal(b(0), 0);
  assert.equal(b(23), 23);
  assert.equal(b(1e6), 23, 'запредельное значение прижимается к суткам');
  assert.equal(b(-5), 0, 'отрицательное тоже');
  assert.equal(b(26.5), 23);
  assert.equal(b(4.4), 4, 'дробное округляется');
  assert.equal(b('нет'), 4, 'нечисло — по умолчанию');
  assert.equal(b(NaN), 4);
  assert.equal(b(Infinity), 4);
});

/* ── Задача 20. Режим формулы (инвариант 16) ───────────────── */

test('З20/C.1: миграция v14→v15 — mode проставлен, аддитивна и идемпотентна', () => {
  setNow(2026, 7, 17, 12, 0);
  const v14 = () => ({
    schemaVersion: 14,
    items: [
      { id: 'a', name: 'С формулой', type: 'daily', area: 'min', addedAt: '2026-01-01',
        formula: { anchor: 'после зарядки', when: '', pair: '', identity: '', twoMin: '', friction: '', proof: '' } },
      { id: 'b', name: 'Без формулы', type: 'daily', area: 'min', addedAt: '2026-01-01', formula: null },
      { id: 'c', name: 'Мусор в режиме', type: 'daily', area: 'min', addedAt: '2026-01-01',
        formula: { anchor: 'x', mode: 'что-то' } }
    ],
    days: { '2026-07-10': { a: true }, '2026-07-11': { a: true, b: true } },
    reviews: [{ closedAt: 1, week: '2026-07-06', keys: ['2026-07-06'], perItem: { a: { name: 'С формулой', marks: [], count: 3 } }, trainings: {}, oneChange: 'спать раньше', raises: [], lowers: [], params: [] }],
    groups: [], weekLog: [], pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: '2026-07-13',
    settings: { dayBoundary: 4, dayThreshold: 0.8, calendarSince: '2026-06-01', habitSeeded: true, seed17: true }
  });

  const m = app.migrate(v14());
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
  assert.equal(m.items[0].formula.mode, 'build', 'существующей формуле проставлен build');
  assert.equal(m.items[1].formula, null, 'у пункта без формулы режима нет вовсе');
  assert.equal(m.items[2].formula.mode, 'build', 'неизвестный режим приводится к build');
  // ключи семи полей не изменились
  assert.deepEqual(Object.keys(m.items[0].formula),
    ['anchor', 'when', 'pair', 'identity', 'twoMin', 'friction', 'proof', 'mode']);

  // аддитивность: days{} и reviews[] не тронуты
  const src = v14();
  assert.deepEqual(m.days, src.days, 'days{} миграция не изменяет');
  assert.deepEqual(m.reviews[0].perItem, src.reviews[0].perItem, 'срезы разборов не изменяет');
  assert.equal(m.reviews[0].oneChange, 'спать раньше');

  // идемпотентность — побайтово
  const once = JSON.stringify(m);
  const twice = JSON.stringify(app.migrate(JSON.parse(once)));
  assert.equal(once, twice, 'двойной прогон даёт тот же результат');

  // режим break переживает миграцию
  const brk = v14();
  brk.items[0].formula.mode = 'break';
  assert.equal(app.migrate(brk).items[0].formula.mode, 'break');
});

test('З20/C.1: экспорт → очистка → импорт сохраняет режим', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const it = s.items.find(i => i.type === 'daily' && i.area === 'min');
  // Заводить формулу в интерфейсе больше нечем (механика снята задачей
  // 28.D) — кладём её прямо в store через нормализатор, ровно так она и
  // лежит у владельца. Экспорт и импорт при этом обязаны её сохранить.
  it.formula = app.normFormula({ anchor: 'рука пошла ко рту', twoMin: 'сжать кулак', mode: 'break' });
  assert.equal(it.formula.mode, 'break');

  const exported = JSON.stringify(app.store);          // экспорт отдаёт текущий store
  const reimported = app.migrate(JSON.parse(exported), { external: true });
  // Сравнение по значению, а не побайтово: defaultStore через migrate не
  // проходит (инвариант 19), и совпадение порядка ключей им обоим никто не
  // обещает. Сама формула сверяется байт в байт ниже.
  assert.deepEqual(reimported, JSON.parse(exported), 'состояние восстановлено полностью');
  const back = reimported.items.find(i => i.id === it.id);
  assert.equal(JSON.stringify(back.formula), JSON.stringify(it.formula), 'формула побайтово та же');
  assert.equal(back.formula.mode, 'break', 'режим пережил импорт');
  assert.equal(back.formula.anchor, 'рука пошла ко рту');
  assert.equal(back.formula.twoMin, 'сжать кулак');
});

test('З20/A.1.3: режим — свойство формулы, а не пункта', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const it = s.items.find(i => i.type === 'daily' && i.area === 'min');
  assert.equal(it.formula, null, 'формулы ещё нет');
  // Задача Р2 завела у действия поле mode — но это РЕЖИМ РАСПИСАНИЯ (id
  // режима), а не режим формулы. Предмет теста прежний: режим формулы живёт
  // в формуле и на пункт не выходит — поле пункта им не пишется и не читается
  assert.equal(it.mode, 'main', 'у пункта mode — режим расписания, а не формулы');

  it.formula = app.normFormula({ anchor: 'x', mode: 'break' });
  assert.equal(it.mode, 'main', 'нормализация формулы поле пункта не трогает');
  assert.equal(it.formula.mode, 'break');

  // пустая формула — null, режим уходит вместе с ней
  it.formula = app.normFormula({ anchor: '', when: '', pair: '', identity: '', twoMin: '', friction: '', proof: '', mode: 'break' });
  assert.equal(it.formula, null, 'пустая формула — null, режим вместе с ней');
});

/* ── Задача 21. Поле done лестницы ─────────────────────────────
   От задачи 21 здесь остался один тест — миграционный. Прочие шесть
   проверяли механику «привычка встала» (условие, закрытие, возврат, слот,
   веха журнала) и сняты вместе с ней задачей 28.D. Этот остаётся, потому
   что предмет у него другой: НОРМАЛИЗАЦИЯ поля, которое живёт в данных
   владельца и обязано пережить любой запуск. Вместе с ним ушёл и помощник
   settledLadder — строить «вставшую» лестницу больше незачем. */

test('З21/7.6: миграция v15→v16 — done проставлен, идемпотентна, экспорт → импорт', () => {
  setNow(2026, 7, 17, 12, 0);
  const v15 = () => ({
    schemaVersion: 15,
    items: [
      { id: 'a', name: 'С лестницей', type: 'daily', area: 'min', addedAt: '2026-01-01',
        ladder: { steps: ['раз', 'два'], step: 1, steppedWeek: null, startedAt: '2026-06-01' },
        ladderLog: [{ date: '2026-06-01', step: 0, text: 'раз', start: true }] },
      { id: 'b', name: 'Без лестницы', type: 'daily', area: 'min', addedAt: '2026-01-01', ladder: null }
    ],
    days: { '2026-07-10': { a: true } },
    reviews: [{ closedAt: 1, week: '2026-07-06', keys: [], perItem: {}, trainings: {}, oneChange: 'x' }],
    groups: [], weekLog: [], pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: '2026-07-13',
    settings: { dayBoundary: 4, dayThreshold: 0.8, calendarSince: '2026-06-01', habitSeeded: true, seed17: true }
  });

  const m = app.migrate(v15());
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
  assert.equal(m.items[0].ladder.done, false, 'существующей лестнице проставлен false');
  assert.equal(m.items[1].ladder, null, 'у пункта без лестницы поля нет');

  // аддитивность
  const src = v15();
  assert.deepEqual(m.days, src.days, 'days{} не изменяются');
  assert.deepEqual(m.reviews[0], src.reviews[0], 'reviews[] не изменяются');
  assert.deepEqual(m.items[0].ladderLog, src.items[0].ladderLog, 'журнал не изменяется');

  // идемпотентность — побайтово
  const once = JSON.stringify(m);
  assert.equal(JSON.stringify(app.migrate(JSON.parse(once))), once);

  // done: true переживает миграцию, а мусор приводится к false
  const closed = v15(); closed.items[0].ladder.done = true;
  assert.equal(app.migrate(closed).items[0].ladder.done, true);
  const junk = v15(); junk.items[0].ladder.done = 'да';
  assert.equal(app.migrate(junk).items[0].ladder.done, false, 'не-true — это false');

  // экспорт → импорт. Закрыть лестницу в интерфейсе больше нечем (механика
  // снята задачей 28.D) — done ставится прямо в данных, как он и лежит
  const s = app.migrate(v15());
  s.items[0].ladder.done = true;
  app.store = s;
  const exported = JSON.stringify(app.store);
  const back = app.migrate(JSON.parse(exported), { external: true });
  assert.deepEqual(back, JSON.parse(exported), 'состояние восстановлено');
  const bl = back.items.find(i => i.id === 'a').ladder;
  assert.equal(bl.done, true, 'закрытость пережила импорт');
  assert.equal(JSON.stringify(bl), JSON.stringify(s.items[0].ladder), 'лестница побайтово та же');
});

/* ── Задача 22. Первая неделя ──────────────────────────────── */

test('З22/1: everMarked — чистая функция от days{}, окно смотрит только назад', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const it = s.items[0];

  assert.equal(app.everMarked(it), false, 'ни одной отметки');
  app.toggleMark(app.addDays(t, -3), it.id);
  assert.equal(app.everMarked(it), true);
  assert.equal(app.everMarked(it, app.addDays(t, -3)), true, 'граница включительно');
  assert.equal(app.everMarked(it, app.addDays(t, -4)), false, 'до отметки — ещё нет');

  // отметка соседа своей не делает
  assert.equal(app.everMarked(s.items[1]), false);
  // reviews не читаются (инвариант 4): архив на ответ не влияет
  s.reviews = [{ perItem: { [s.items[1].id]: { count: 7 } } }];
  assert.equal(app.everMarked(s.items[1]), false);
});

test('З22/1: понижение адресуется только начатому пункту', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const item = s.items.find(i => i.name === 'Развитие');
  const W = app.closedWeeks(2);

  // засеянная программа без единой отметки: две пустые недели, но урезать нечего
  assert.equal(app.lowerEligible(item), false);
  for (const it of s.items) assert.equal(app.lowerEligible(it), false, it.name);

  // одна отметка когда-то в прошлом — предложение появляется
  app.toggleMark(app.addDays(W[0], -30), item.id);
  assert.equal(app.lowerEligible(item), true);

  // повышения эта дыра не касалась: его критерий требует ≥6 отметок в неделю
  assert.equal(app.raiseEligible(item), false);
});

test('З22/7.2: подсказка считает пункты владельца, посев в счёт не идёт', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore(); // посев: девять пунктов одной датой, seed17 стоит
  const t = app.todayKey();

  assert.equal(s.settings.seed17, true);
  assert.equal(app.seedDayKey(), t, 'девять пунктов одной датой — день посева');
  assert.equal(app.ownerNewestItem(), null, 'владелец не заводил ничего');

  // пункт, заведённый владельцем на следующий день, считается
  advanceDays(1);
  const own = { ...s.items[0], id: 'own1', name: 'Своё', addedAt: app.todayKey() };
  s.items.push(own);
  assert.equal(app.seedDayKey(), t, 'день посева прежний');
  assert.equal(app.ownerNewestItem().id, 'own1');

  // стёртый store: seed17 стоит намеренно (инвариант 18), пунктов нет —
  // первый же пункт владельца одинок и посевным не считается никогда
  s.items = [];
  assert.equal(app.seedDayKey(), null, 'пустой store дня посева не имеет');
  const first = { ...own, id: 'w1', addedAt: app.todayKey() };
  s.items.push(first);
  assert.equal(app.seedDayKey(), null, 'одиночный пункт — не посев');
  assert.equal(app.ownerNewestItem().id, 'w1');

  // не засеянный store (импорт): правило не применяется вовсе
  s.settings.seed17 = false;
  s.items = [{ ...own, id: 'a', addedAt: t }, { ...own, id: 'b', addedAt: t }];
  assert.equal(app.seedDayKey(), null);
  assert.ok(app.ownerNewestItem());
});

test('З22/5: подпись зачёта дня — от числа применимых пунктов', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  assert.match(app.thresholdNote(), /не меньше 5 из 6\./);

  const t = app.todayKey();
  s.items.filter(i => i.type === 'daily' && i.area === 'min').slice(0, 3)
    .forEach(i => { i.removedAt = t; });
  assert.match(app.thresholdNote(), /не меньше 3 из 3\./);

  s.items.forEach(i => { i.removedAt = t; });
  assert.equal(app.thresholdNote(), '', 'применимых пунктов нет — подписи нет');
});

test('З22/8: будущее начало отсчёта — законная пустая эпоха', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  s.settings.calendarSince = app.addDays(app.weekStartOf(app.todayKey()), 14);

  assert.equal(app.currentWeekStart(), null, 'как после чистки');
  assert.equal(app.previousWeekStart(), null);
  assert.equal(app.reviewDue(), false);
  assert.deepEqual(app.closedWeeks(2), []);
  assert.equal(app.daysInSystem(), 0);
  assert.equal(app.dayStreak(), 0);
  assert.equal(app.bestStreak(), 0);
  assert.equal(app.marksWindow(s.items[0]), 0);
  assert.equal(app.marksInSystem(s.items[0]), 0);
  // механики планки в пустой эпохе молчат, а не падают
  for (const it of s.items) {
    assert.equal(app.raiseEligible(it), false);
    assert.equal(app.lowerEligible(it), false);
  }
});

/* ── Задача 23, п. 4: бюджет времени как тест ─────────────────
   Инвариант 14 требовал считать рекорд «одним проходом по эпохе» —
   единственное предписание реализации во всей конституции, и проверить
   его было нечем: любой корректный алгоритм даёт тот же ответ, и
   квадратичный возврат не ронял ни одного теста. Проверяемо не «как
   считает», а «сколько считает»: здесь и стоят пороги.

   Стабильность (п. 4.3): история строится детерминированно (узор по
   остатку от деления, никакого Math.random), перед замером идёт
   прогревочный вызов — первый платит за компиляцию, — а из нескольких
   замеров берётся МИНИМУМ. Минимум устойчив к шуму по построению: GC и
   планировщик умеют только добавлять время, но не отнимать. */

const PERF_YEARS = 3;
const PERF_DAYS = PERF_YEARS * 365;

/* Три года отметок. Узор выбран так, чтобы серия НЕ обрывалась (пропуск
   реже амнистии, AMNESTY_GAP = 7): это худший случай и для рекорда, и для
   dayStreak — счёт доходит до начала эпохи, а не упирается в обрыв рядом. */
function perfStore() {
  setNow(2026, 8, 14, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  s.settings.calendarSince = app.weekStartOf(app.addDays(t, -PERF_DAYS));
  s.items.forEach(i => { i.addedAt = s.settings.calendarSince; });
  const min = s.items.filter(i => i.type === 'daily' && i.area === 'min');
  let k = s.settings.calendarSince, n = 0;
  while (k <= t) {
    const day = {};
    if (n % 11 !== 0) {                       // каждый 11-й — пропуск (амнистируется)
      for (let j = 0; j < min.length; j++) {
        if (n % 7 === 0 && j === 0) continue; // каждый 7-й — неполный день
        day[min[j].id] = true;
      }
    }
    if (Object.keys(day).length) s.days[k] = day;
    k = app.addDays(k, 1);
    n++;
  }
  return { store: s, days: n };
}

/* Минимум из best замеров, прогрев отдельно. reps — вызовов внутри одного
   замера: для дешёвых функций один вызов тонет в разрешении таймера. */
function measureMs(fn, { reps = 1, best = 5 } = {}) {
  for (let i = 0; i < reps; i++) fn();
  let lo = Infinity;
  for (let b = 0; b < best; b++) {
    const a = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) fn();
    const ms = Number(process.hrtime.bigint() - a) / 1e6;
    if (ms < lo) lo = ms;
  }
  return lo;
}

test('З23/4: bestStreak на трёх годах истории укладывается в 50 мс', () => {
  const { days } = perfStore();
  assert.ok(days >= PERF_DAYS, `эпоха действительно длинная: ${days} дней`);
  // ответ сначала, время потом: сторож скорости не должен разрешать неверный счёт
  assert.equal(app.bestStreak(), app.dayStreak(), 'узор без обрывов: рекорд равен текущей серии');

  const ms = measureMs(() => app.bestStreak());
  // замер разведки (задача 23): линейный проход — 1,6 мс, квадратичный
  // возврат (streakBack от каждого дня эпохи) — 717 мс. Порог 50 мс даёт
  // тридцатикратный запас линейному и на порядок с лишним ниже квадратичного
  assert.ok(ms < 50, `bestStreak на ${days} днях: ${ms.toFixed(1)} мс ≥ 50 мс`);
});

test('З23/4.2: dayStreak на трёх годах истории укладывается в 30 мс', () => {
  const { days } = perfStore();
  const ms = measureMs(() => app.dayStreak());
  // замер разведки: 1,5 мс. Порог 30 мс — двадцатикратный запас; dayStreak
  // и так линеен, сторож держит его таким (например, от пересчёта dayScore
  // по всем пунктам за каждый день вместо применимых)
  assert.ok(ms < 30, `dayStreak на ${days} днях: ${ms.toFixed(1)} мс ≥ 30 мс`);
});

test('З23/4.2: chainWeeks(8) не зависит от длины эпохи', () => {
  const { days } = perfStore();
  assert.equal(app.chainWeeks(8).length, 8);
  // 500 вызовов за один замер: один вызов (0,01 мс) тонет в разрешении
  // таймера. Порог 100 мс на 500 вызовов — это 0,2 мс на вызов при
  // измеренных 0,01: двадцатикратный запас. Сторож ловит именно
  // зависимость от эпохи — проход по трём годам стоил бы ~0,5 мс на вызов
  // (250 мс на замер), то есть порог был бы пробит вдвое с половиной
  const ms = measureMs(() => app.chainWeeks(8), { reps: 500 });
  assert.ok(ms < 100, `chainWeeks(8) ×500 на ${days} днях: ${ms.toFixed(1)} мс ≥ 100 мс`);
});

/* ── Задача 23, п. 1.4: рантайм констант времени неприкосновенен ──
   dom.test.js укорачивает константы, чтобы прогон не стоял в паузах.
   Гарантия, что укорочение осталось в тестах, — здесь: этот файл
   грузит app.js без globalThis.MINIMUM_TIMING и потому видит рантайм.
   Тронул значение в app.js — тест падает и требует объяснения. */
test('З23/1.4: значения по умолчанию — рантайм приложения, подмене не подверженный', () => {
  assert.deepEqual(app.TIMING_DEFAULTS, {
    MIRROR_PROBE_MS: 1500,     // ждать зеркало на старте, не задерживая первый рендер
    MIRROR_FLUSH_MS: 500,      // дебаунс записи зеркала
    DAY_TIMER_SLACK_MS: 1000,  // запас таймера границы дня: iOS срабатывает на самой границе
    MOTION_MS: 240,            // потолок движения (12.1)
    MOTION_TAIL_MS: 60,        // запас fallback'а ухода карточки сверх перехода
    FLASH_MS: 1200,            // сколько держится «Сохранено» при reduced-motion
    DRAG_HOLD: 250,            // удержание до захвата
    DRAG_CLICK_MS: 300,        // подавление клика после перетаскивания
    DAY_CLOSE_MS: 360,         // вся сцена закрытия дня (задача 28.E/C)
    UPDATE_CHECK_MS: 600000,   // автопроверка обновления — не чаще раза в 10 минут (задача Р3)
    VERSION_ASK_MS: 1000       // сколько ждать номер версии у воркера (задача Р3)
  });
  // без подмены значения этой загрузки равны умолчаниям
  assert.deepEqual(app.TIMING, app.TIMING_DEFAULTS);
  // окно движения из конституции: 180–260 мс, выше нельзя
  assert.ok(app.TIMING_DEFAULTS.MOTION_MS >= 180 && app.TIMING_DEFAULTS.MOTION_MS <= 260,
    `MOTION_MS ${app.TIMING_DEFAULTS.MOTION_MS} вне окна 180–260 мс (CLAUDE.md, «Движение»)`);
  // fallback ухода карточки обязан быть СВЕРХ перехода, иначе узел
  // удалялся бы посреди движения
  assert.ok(app.TIMING_DEFAULTS.MOTION_TAIL_MS > 0);
  // сцена закрытия дня — не «движение», а раскадровка из трёх фаз, и её
  // потолок 360 мс легализован решением архитектора отдельно от окна
  assert.equal(app.TIMING_DEFAULTS.DAY_CLOSE_MS, 360);
  assert.ok(app.TIMING_DEFAULTS.DAY_CLOSE_MS > app.TIMING_DEFAULTS.MOTION_MS,
    'сцена длиннее одного движения — она из фаз');
});

/* ── Задача 24. Разбор ─────────────────────────────────────── */

/* Три идеальные закрытые недели у всех числовых пунктов минимума:
   к повышению готовы все четверо (замер разведки 0.5) */
function threePerfectWeeks() {
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  for (const it of s.items.filter(i => i.type === 'daily')) {
    for (let w = 0; w < 3; w++) markWeek(it.id, app.addDays(prev, -7 * w), 7);
  }
  return s;
}

/* Задача 24 различала лестницы живую и закрытую: первая гасила повышение,
   вторая нет. Задача 28.D сняла различение целиком — ни одна не гасит.
   Тест оставлен на прежнем месте под прежним номером: он сторожит, что
   guard не вернулся ни в одном из двух видов. */
test('З24/5: ни живая, ни закрытая лестница повышение не блокируют', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = threePerfectWeeks();
  const it = s.items.find(i => i.type === 'daily' && i.area === 'min' && typeof i.value === 'number');
  assert.equal(app.raiseEligible(it), true, 'без лестницы право есть');

  it.ladder = { steps: ['раз', 'два'], step: 0, steppedWeek: null, startedAt: null, done: false };
  assert.equal(app.raiseEligible(it), true, 'живая лестница права не отнимает');

  it.ladder.done = true;
  assert.equal(app.raiseEligible(it), true, 'закрытая — тем более');
});

test('З24/6: одно предложение повышения за разбор — первое по порядку items[]', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = threePerfectWeeks();
  const ready = app.raiseReady();
  assert.equal(ready.length, 4, 'на трёх идеальных неделях готовы все числовые пункты посева');

  const offer = app.raiseOffer();
  assert.equal(offer.id, ready[0].id, 'предложение получает первый по порядку items[]');
  assert.equal(offer.id, s.items.find(i => app.raiseEligible(i)).id);

  // «Не сейчас» — решение по планке вверх принято, второго за разбор нет
  app.resetRaiseCount(offer);
  assert.equal(app.raiseOffer(), null, 'после решения предложений в этом разборе нет');
  assert.equal(app.raiseReady().length, 3, 'остальные по-прежнему готовы — просто ждут');

  // и «Принять» ставит тот же якорь: механика одна
  const s2 = threePerfectWeeks();
  const first = app.raiseOffer();
  app.acceptRaise(first, app.raiseSuggest(first.value));
  assert.equal(app.raiseOffer(), null);
  assert.equal(s2.items.filter(i => i.raiseAfterWeek === app.currentWeekStart()).length, 1);
});

test('З24/6.5: отложенные возвращаются на следующей неделе прежним путём — якоря не тронуты', () => {
  setNow(2026, 7, 17, 12, 0); // пятница
  const s = threePerfectWeeks();
  const [first, second] = app.raiseReady();
  app.resetRaiseCount(first);              // якорь — понедельник текущей недели
  assert.equal(app.raiseOffer(), null, 'в этом разборе второго предложения нет');

  // следующая неделя: у отложенных якоря не ставились — предложение их
  const nextWeek = () => {
    advanceDays(7);
    for (const it of s.items.filter(i => i.type === 'daily')) markWeek(it.id, app.previousWeekStart(), 7);
  };
  nextWeek();
  assert.equal(app.raiseOffer().id, second.id, 'предложение перешло следующему готовому');

  // а решённый возвращается прежним путём — когда ВСЕ три недели строго
  // позже якоря (инвариант 4), то есть на четвёртой неделе после решения;
  // задача 24 этот срок не трогала
  assert.equal(app.raiseEligible(first), false);
  nextWeek();
  assert.equal(app.raiseEligible(first), false, 'две недели после якоря — рано');
  nextWeek(); nextWeek();
  assert.equal(app.raiseEligible(first), true, 'все три недели позже якоря — право вернулось');
});

test('З24/6.4: повышение и понижение одному пункту в один разбор несовместимы', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const it = s.items.find(i => i.type === 'daily' && i.area === 'min' && typeof i.value === 'number');
  const prev = app.previousWeekStart();
  // критерии взаимоисключающи по построению: ≥6 из 7 три недели против
  // ≤3 из 7 две недели, и вторые две недели — подмножество первых трёх
  for (let n = 0; n <= 7; n++) {
    s.days = {};
    for (let w = 0; w < 3; w++) markWeek(it.id, app.addDays(prev, -7 * w), n);
    assert.equal(app.raiseEligible(it) && app.lowerEligible(it), false, `${n} из 7`);
  }
});

test('З24/9.2: reviewActionable — решения есть или их нет', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const prev = app.previousWeekStart();
  // параметр посева не решён — это уже решение
  assert.equal(app.pendingParams().length, 1);
  assert.equal(app.reviewActionable(), true, 'нерешённый параметр');

  app.keepParam(app.pendingParams()[0].id);
  assert.equal(app.pendingParams().length, 0);
  assert.equal(app.reviewActionable(), false, 'решать больше нечего');

  // повышение возвращает действенность
  const s2 = threePerfectWeeks();
  app.keepParam(app.pendingParams()[0].id);
  assert.equal(app.reviewActionable(), true, 'есть предложение повышения');
  app.resetRaiseCount(app.raiseOffer());
  assert.equal(app.reviewActionable(), false, 'решение принято — карточек нет');

  // Шаг лестницы был четвёртым поводом действенности; он снят задачей 28.D.
  // Поле ladder в данных на свёртку больше не влияет никак — ни в ту сторону,
  // ни в другую: решать по нему нечем.
  const m = s2.items.find(i => i.type === 'daily' && i.area === 'min');
  m.ladder = { steps: ['раз', 'два'], step: 0, steppedWeek: null, startedAt: null, done: false };
  assert.equal(app.reviewActionable(), false, 'лестница в данных решением не считается');
  assert.equal(prev < app.currentWeekStart(), true);
});

/* ── Задача 25. Данные без потерь ───────────────────────────── */

test('З25/4: посторонний флаг не убивает валидные отметки того же дня', () => {
  setNow(2026, 8, 14, 12, 0);
  // день с четырьмя валидными отметками и одним посторонним значением:
  // прежнее правило «весь день целиком» уносило все четыре
  const s = app.migrate({
    schemaVersion: 16, items: [], settings: {},
    days: {
      '2026-08-10': { a: true, b: true, c: true, d: true, e: 1 },
      '2026-08-11': { a: true, b: false },
      '2026-08-12': { a: 'да', b: null },   // валидных не остаётся — дня нет
      '2026-08-13': {},                      // пустой день не существует и раньше
      'мусор': { a: true },                  // ключ не день — прежнее правило
      '2026-08-09': 'не объект'
    }
  }, { external: true });

  assert.deepEqual(s.days['2026-08-10'], { a: true, b: true, c: true, d: true },
    'валидные отметки уцелели, посторонняя отброшена поимённо');
  assert.deepEqual(s.days['2026-08-11'], { a: true, b: false }, 'false — валидное значение');
  assert.equal('2026-08-12' in s.days, false, 'день без валидных отметок удаляется');
  assert.equal('2026-08-13' in s.days, false);
  assert.equal('мусор' in s.days, false);
  assert.equal('2026-08-09' in s.days, false);
  assert.deepEqual(Object.keys(s.days).sort(), ['2026-08-10', '2026-08-11']);
});

test('З25/4.3: двойной прогон migrate по дням даёт побайтово тот же результат', () => {
  setNow(2026, 8, 14, 12, 0);
  const file = () => ({
    schemaVersion: 16, items: [], settings: {},
    days: {
      '2026-08-10': { a: true, e: 1, f: 'x' },
      '2026-08-11': { a: false },
      '2026-08-12': { z: {} },
      'мусор': { a: true }
    }
  });
  const once = JSON.stringify(app.migrate(file(), { external: true }));
  const twice = JSON.stringify(app.migrate(app.migrate(file(), { external: true }), { external: true }));
  assert.equal(once, twice, 'миграция идемпотентна');
});

test('З25/3: dataCounts считает по сырому файлу, droppedLine называет расхождение', () => {
  setNow(2026, 8, 14, 12, 0);
  const raw = {
    schemaVersion: 16,
    items: [null, 'мусор', {
      id: 'a', name: 'Пункт',
      // задача 28.B, п. 5: история планки роняется по дате и по значению
      history: [{ date: '2026-08-10', value: 5 }, { date: 'нет', value: 7 }]
    }],
    days: { '2026-08-10': { a: true, e: 1 }, 'мусор': { a: true } },
    notes: [{ text: 'мысль' }, { text: '   ' }],
    reviews: [null, {}],
    // ненулевые упражнения и тренировки: без них две категории из семи
    // считались бы «проверенными» на одних нулях
    exercises: [null, {
      id: 'e1', name: 'Жим',
      history: [{ date: '2026-08-10', value: 10 }, { date: 'нет', value: 12 }]
    }],
    sessions: [
      { id: 's1', date: '2026-08-10', entries: [{ exId: 'e1', value: 10 }, { exId: 'e1', value: null }] },
      { id: 's2', date: 'мусор', entries: [] }
    ],
    // пять категорий, которых счёт прежде не видел вовсе
    groups: [{ name: 'Утро' }, { name: '   ' }, { name: 'Утро' }, 42],
    weekLog: [{ itemId: 'a', date: '2026-08-10' }, 'мусор', null],
    paramDecided: { p1: { week: '2026-08-10', from: 1, to: 2 }, p2: { мусор: true } }
  };
  const was = app.dataCounts(raw);
  assert.deepEqual(was, {
    // пропусков (задача Р2) в файле нет: e: 1 — не булево, ни отметка, ни пропуск
    items: 3, days: 2, marks: 2, skips: 0, notes: 2, reviews: 2, exercises: 2, sessions: 2,
    groups: 4, weekLog: 3, history: 4, schedule: 0, blockDays: 0, groupLog: 0, modes: 0, modeLog: 0,
    entries: 2, params: 2
  });

  // считать обязательно ДО migrate: он мутирует переданный объект
  const got = app.dataCounts(app.migrate(raw, { external: true }));
  assert.deepEqual(got, {
    items: 1, days: 1, marks: 1, skips: 0, notes: 1, reviews: 1, exercises: 1, sessions: 1,
    // расписания в сыром файле не было — migrate достроил уцелевшему пункту
    // якорь «все семь». Это ПРИБАВКА: droppedLine считает только убыль
    // журнал принадлежности пункт получил пустым: одно состояние — не история
    // основной режим migrate дописал файлу без режимов (задача Р2) — тоже прибавка
    groups: 1, weekLog: 1, history: 2, schedule: 1, blockDays: 0, groupLog: 0, modes: 1, modeLog: 0,
    entries: 1, params: 1
  });

  assert.equal(app.droppedLine(was, got),
    '2 пункта, 1 день, 1 отметка, 1 заметка, 1 разбор, 1 упражнение, 1 тренировка, ' +
    '3 блока, 2 записи счётчика, 2 записи истории, 1 значение тренировки, 1 решение по параметру');
  assert.equal(app.droppedLine(got, got), '', 'числа сошлись — строки нет');
});

/* 5.2: склонения новых категорий на 1, 2 и 5 — по одному замеру на слово,
   а не «на глаз». Разница «1 запись счётчика / 2 записи / 5 записей». */
test('З28B/5.2: склонения новых категорий потерь на 1, 2 и 5', () => {
  const zero = { items: 0, days: 0, marks: 0, notes: 0, reviews: 0, exercises: 0, sessions: 0, groups: 0, weekLog: 0, history: 0, schedule: 0, blockDays: 0, groupLog: 0, entries: 0, params: 0 };
  const line = (key, n) => app.droppedLine(Object.assign({}, zero, { [key]: n }), zero);
  assert.equal(line('groups', 1), '1 блок');
  assert.equal(line('groups', 2), '2 блока');
  assert.equal(line('groups', 5), '5 блоков');
  assert.equal(line('weekLog', 1), '1 запись счётчика');
  assert.equal(line('weekLog', 2), '2 записи счётчика');
  assert.equal(line('weekLog', 5), '5 записей счётчика');
  assert.equal(line('history', 1), '1 запись истории');
  assert.equal(line('history', 2), '2 записи истории');
  assert.equal(line('history', 5), '5 записей истории');
  assert.equal(line('entries', 1), '1 значение тренировки');
  assert.equal(line('entries', 2), '2 значения тренировки');
  assert.equal(line('entries', 5), '5 значений тренировки');
  assert.equal(line('params', 1), '1 решение по параметру');
  assert.equal(line('params', 2), '2 решения по параметру');
  assert.equal(line('params', 5), '5 решений по параметру');
});

/* 5.3: файл из разведки 0.5 — тот, на котором строка потерь молчала. */
test('З28B/5.3: файл, ронявший данные молча, теперь называет потерю числом', () => {
  setNow(2026, 8, 14, 12, 0);
  const raw = {
    schemaVersion: 16,
    items: [{
      id: 'i1', name: 'Пункт', type: 'daily', area: 'min', active: true, addedAt: '2026-08-01',
      value: 10, unit: 'мин', history: [{ date: '2026-08-01', value: 5 }, { date: 'не-дата', value: 7 }, { date: '2026-08-05', value: 'семь' }]
    }],
    days: { '2026-08-01': { i1: true } },
    groups: [{ name: 'Утро' }, { name: '   ' }, { name: 'Утро' }, 42],
    weekLog: [{ itemId: 'w1', date: '2026-08-01', ts: 1 }, 'мусор', null],
    reviews: [], pendingRaises: [], pendingLowers: [], notes: [],
    exercises: [{ id: 'x1', name: 'Отжимания', unit: 'раз', value: 10, active: true, addedAt: '2026-08-01', history: [{ date: '2026-08-01', value: 10 }, { date: 'нет', value: 12 }] }],
    sessions: [{ id: 's1', date: '2026-08-01', note: '', entries: [{ exId: 'x1', value: 10 }, { exId: 'x1', value: null }, { нет: 1 }] }],
    paramDecided: { p1: { week: '2026-08-03', from: 1, to: 2 }, p2: { мусор: true } },
    draftOneChange: '', weekStart: '2026-08-03',
    settings: { dayBoundary: 4, dayThreshold: 0.8, calendarSince: '2026-08-03', habitSeeded: true, seed17: true }
  };
  const was = app.dataCounts(raw);
  const got = app.dataCounts(app.migrate(JSON.parse(JSON.stringify(raw)), { external: true }));
  const line = app.droppedLine(was, got);
  assert.notEqual(line, '', 'прежде здесь была пустая строка');
  for (const part of ['3 блока', '2 записи счётчика', '3 записи истории', '2 значения тренировки', '1 решение по параметру']) {
    assert.match(line, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), part);
  }
});

test('З25/3.1: счёт «было», снятый после migrate, потерь уже не видит', () => {
  setNow(2026, 8, 14, 12, 0);
  const raw = { schemaVersion: 16, items: [null, 'мусор', { id: 'a' }], days: {}, settings: {} };
  // порядок в importJSON: счёт снимается ПЕРЕД migrate и живёт своей жизнью
  const было = app.dataCounts(raw);
  const out = app.migrate(raw, { external: true });
  assert.equal(out, raw, 'migrate вернул тот же объект — прежнего содержимого не осталось');
  const стало = app.dataCounts(out);

  // правильный порядок: потеря названа
  assert.equal(app.droppedLine(было, стало), '2 пункта');
  // неправильный: «было» снято уже с мигрированного объекта — потери не видно
  assert.equal(app.droppedLine(app.dataCounts(raw), стало), '',
    'счёт после migrate даёт ноль — ради этого он и снимается заранее');
});

test('З25/7: пустой store копию не подменяет — «последняя содержательная»', () => {
  const mem = fakeLocalStorage();
  const before = filledStore();
  const snapshot = JSON.parse(JSON.stringify(before));

  assert.equal(app.hasData(before), true);
  assert.equal(app.wipeAll(), true);
  assert.deepEqual(app.wipedCopy().store, snapshot);

  // store после чистки пуст по всем числам wipeStats — терять нечего
  assert.equal(app.hasData(app.store), false);
  assert.equal(app.wipeAll(), true, 'вторая чистка не отказывает');
  assert.deepEqual(app.wipedCopy().store, snapshot, 'практика в копии, а не пустота');

  // содержательный store копию по-прежнему заменяет
  app.store.notes.push({ id: 'n-одна', date: app.todayKey(), text: 'одна заметка — уже содержание', kind: 'note', source: '', updatedAt: 1 });
  assert.equal(app.hasData(app.store), true);
  const second = JSON.parse(JSON.stringify(app.store));
  app.wipeAll();
  assert.deepEqual(app.wipedCopy().store, second);
  assert.ok(mem[app.WIPE_KEY]);
  clearLocalStorage();
});

test('З25/2: keepPrev — общая механика копии, kind различает повод', () => {
  fakeLocalStorage();
  const before = filledStore();
  const snapshot = JSON.parse(JSON.stringify(before));

  assert.equal(app.keepPrev(app.store, 'import'), true);
  const c = app.wipedCopy();
  assert.equal(c.kind, 'import');
  assert.deepEqual(c.store, snapshot);
  assert.deepEqual(c.stats, app.wipeStats(snapshot));

  // «Вернуть» одинаков для всех поводов: migrate с внешним флагом. С задачи
  // 26 (п. 1.1) он ещё и обратим — смещённое состояние ложится в ту же копию
  assert.equal(app.restoreWiped(), true);
  assert.deepEqual(app.store, snapshot);
  const back = app.wipedCopy();
  assert.ok(back, 'копия обменная, а не убранная');
  assert.equal(back.kind, 'restore');

  // чистка ставит свой kind
  app.wipeAll();
  assert.equal(app.wipedCopy().kind, 'wipe');
  clearLocalStorage();
});

/* Задача 26, п. 1.1. Копия — переключатель между двумя состояниями:
   наработанное после чистки или импорта возврат не уносит, а меняет
   местами. Прежде возврат был единственной необратимой операцией. */
test('З26/1: «Вернуть» обменивает состояния, а не стирает нынешнее', () => {
  fakeLocalStorage();
  filledStore();
  const был = JSON.parse(JSON.stringify(app.store));

  app.wipeAll();                       // чистка: практика ушла в копию
  app.store.items.push({
    id: 'после', name: 'Заведено после чистки', value: null, unit: '', type: 'daily',
    area: 'min', goal: null, note: '', group: '', active: true, addedAt: '2026-08-14',
    raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  });
  const после = JSON.parse(JSON.stringify(app.store));

  assert.equal(app.restoreWiped(), true, 'возврат выполнен');
  assert.deepEqual(app.store.items.map(i => i.name), был.items.map(i => i.name), 'прежнее вернулось');
  const c = app.wipedCopy();
  assert.equal(c.kind, 'restore', 'повод копии — возврат');
  assert.deepEqual(c.store.items.map(i => i.id), после.items.map(i => i.id),
    'наработанное после чистки лежит в копии, а не потеряно');

  // и обратно: второй тап возвращает наработанное
  assert.equal(app.restoreWiped(), true);
  assert.deepEqual(app.store.items.map(i => i.id), после.items.map(i => i.id), 'переключатель');
  assert.deepEqual(app.wipedCopy().store.items.map(i => i.name), был.items.map(i => i.name));
  clearLocalStorage();
});

test('З26/1: пустое нынешнее состояние менять не на что — копия убирается', () => {
  fakeLocalStorage();
  filledStore();
  app.wipeAll();                       // после чистки store пуст
  assert.equal(app.restoreWiped(), true);
  assert.equal(app.wipedCopy(), null, 'пустоту в копию не кладут, старая копия отдана');
  clearLocalStorage();
});

test('З25/2: копию некуда положить — keepPrev отказывает, чистка не выполняется', () => {
  fakeLocalStorage();
  const before = filledStore();
  const snapshot = JSON.parse(JSON.stringify(before));
  const real = global.localStorage.setItem;
  global.localStorage.setItem = (k) => { if (k === app.WIPE_KEY) throw new Error('quota'); };

  assert.equal(app.keepPrev(app.store, 'import'), false);
  assert.equal(app.wipeAll(), false);
  assert.deepEqual(app.store, snapshot, 'store не тронут');

  // пустому store копия не нужна вовсе — отказа нет даже при полном хранилище
  app.store = app.emptyStore(4, 0.8);
  assert.equal(app.keepPrev(app.store, 'import'), true);

  global.localStorage.setItem = real;
  clearLocalStorage();
});

test('З25/6: нечитаемые данные читаются с датой и в старом формате, убираются', () => {
  const mem = fakeLocalStorage();
  setNow(2026, 8, 14, 12, 0);
  assert.equal(app.corruptCopy(), null, 'нечего показывать');

  const t0 = Date.now();
  mem['minimum:data'] = '{битый json';
  app.load();
  const c = app.corruptCopy();
  assert.equal(c.raw, '{битый json');
  assert.equal(c.at, t0, 'дата — момент, когда строку отложили, а не что попало');

  // копия, снятая версией до задачи 25, — голая строка без даты
  mem[app.CORRUPT_KEY] = '{совсем старый';
  const old = app.corruptCopy();
  assert.equal(old.raw, '{совсем старый');
  assert.equal(old.at, null, 'дата неизвестна — не выдумывается');

  // валидный JSON, но не обёртка: считается сырой строкой целиком —
  // иначе чужая структура молча выдала бы себя за отложенные данные
  mem[app.CORRUPT_KEY] = '{"items":[],"days":{}}';
  const alien = app.corruptCopy();
  assert.equal(alien.raw, '{"items":[],"days":{}}');
  assert.equal(alien.at, null);
  mem[app.CORRUPT_KEY] = JSON.stringify({ raw: 42, at: 1 }); // raw не строка — не обёртка
  assert.equal(app.corruptCopy().raw, '{"raw":42,"at":1}');

  app.dropCorrupt();
  assert.equal(app.corruptCopy(), null);
  app.dropCorrupt(); // повтор не падает
  clearLocalStorage();
});

test('З25/6.4: чистка нечитаемые данные не трогает', () => {
  const mem = fakeLocalStorage();
  filledStore();
  mem[app.CORRUPT_KEY] = JSON.stringify({ raw: '{битый json', at: 1 });
  assert.equal(app.wipeAll(), true);
  assert.equal(app.corruptCopy().raw, '{битый json', 'переживает стирание');
  assert.equal(app.restoreWiped(), true);
  assert.equal(app.corruptCopy().raw, '{битый json', 'и возврат');
  clearLocalStorage();
});

/* ══ Задача 27.1: ремонт по приёмке ═══════════════════════════ */

/* Запись в localStorage отказывает — как переполненная квота на устройстве.
   Возвращает всё на место, даже если тело бросило. */
function withBrokenWrite(fn) {
  const real = global.localStorage;
  global.localStorage = {
    getItem: k => real.getItem(k),
    setItem: (k, v) => {
      if (k === 'minimum:data') { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      return real.setItem(k, v);
    },
    removeItem: k => real.removeItem(k),
    key: i => real.key(i),
    get length() { return real.length; }
  };
  try { fn(); } finally { global.localStorage = real; }
}

/* Д1. «Открыть заново» подчинено правилу одной активной лестницы.
   Прежде проверки не было вовсе: тап давал ДВЕ живые лестницы, вторая
   была невидима, а дедуп migrate при следующем запуске снимал ту, у
/* Д2. Новая лестница на пункте с ЗАКРЫТОЙ — именно новая, а не правка
   текста внутри закрытой (прежде done оставался true, step не сбрасывался,
/* Д5. Копия расходуется только после успешной записи. Прежде возврат
   снимал копию ДО save(), а успех записи никто не проверял: отказ квоты
   уничтожал практику и на диске, и в копии. */
test('З27/2: отказ записи откатывает чистку целиком — копия и store на месте', () => {
  setNow(2026, 7, 17, 12, 0);
  fakeLocalStorage();
  const s = freshStore();
  calendarPast(s);
  app.toggleMark(app.todayKey(), s.items[0].id);
  const before = JSON.stringify(app.store);

  withBrokenWrite(() => {
    assert.equal(app.wipeAll(), false, 'чистка не выполнена');
  });
  assert.equal(JSON.stringify(app.store), before, 'store в памяти прежний');
  assert.equal(app.wipedCopy(), null, 'копия не осталась висеть');
  assert.equal(app.lastSaveOk(), false, 'и приложение знает, что записи не было');
});

test('З27/2: отказ записи откатывает возврат — копия не расходуется', () => {
  setNow(2026, 7, 17, 12, 0);
  fakeLocalStorage();
  const s = freshStore();
  calendarPast(s);
  app.toggleMark(app.todayKey(), s.items[0].id);
  const practice = JSON.stringify(app.store);
  assert.equal(app.wipeAll(), true);
  assert.equal(app.store.items.length, 0, 'после чистки пусто');
  const copyRaw = app.wipedRaw();
  assert.ok(copyRaw, 'копия есть');

  withBrokenWrite(() => {
    assert.equal(app.restoreWiped(), false, 'возврат не выполнен');
  });
  assert.equal(app.store.items.length, 0, 'состояние прежнее — пустое');
  assert.equal(app.wipedRaw(), copyRaw, 'копия НА МЕСТЕ побайтово');
  // и при живой записи возврат по-прежнему работает
  assert.equal(app.restoreWiped(), true);
  assert.equal(JSON.stringify(app.store), practice, 'практика вернулась целиком');
});

/* 10.2. Решения по планке из ДВУХ разборов не складываются в один срез. */
test('З27/10.2: в срез идут решения только текущей недели', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const [a, b] = s.items.filter(i => i.type === 'daily' && i.area === 'min');
  // решение прошлой недели: запись есть, якорь пункта — прошлая неделя
  s.pendingRaises.push({ itemId: a.id, name: a.name, from: 5, to: 6 });
  a.raiseAfterWeek = app.addDays(app.currentWeekStart(), -7);
  // решение этой недели
  s.pendingRaises.push({ itemId: b.id, name: b.name, from: 10, to: 11 });
  b.raiseAfterWeek = app.currentWeekStart();

  const cur = app.pendingThisWeek(s.pendingRaises, 'raiseAfterWeek');
  assert.deepEqual(cur.map(r => r.itemId), [b.id], 'чужая неделя в срез не идёт');

  assert.equal(app.closeWeek(), true);
  assert.deepEqual(s.reviews[0].raises.map(r => r.itemId), [b.id]);
  assert.deepEqual(s.pendingRaises, [], 'накопленное чистится целиком');
});

test('З27/10.2: пункт, решённый дважды, отдаёт в срез последнее решение', () => {
  setNow(2026, 7, 17, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const a = s.items.find(i => i.type === 'daily' && i.area === 'min');
  s.pendingRaises.push({ itemId: a.id, name: a.name, from: 5, to: 6 });
  s.pendingRaises.push({ itemId: a.id, name: a.name, from: 6, to: 7 });
  a.raiseAfterWeek = app.currentWeekStart();
  const cur = app.pendingThisWeek(s.pendingRaises, 'raiseAfterWeek');
  assert.equal(cur.length, 1);
  assert.deepEqual(cur[0], { itemId: a.id, name: a.name, from: 6, to: 7 });
});

/* Д8. exportedAt вне диапазона Date нормализуется миграцией. */
test('З27/7: exportedAt вне диапазона Date не доезжает до рендера', () => {
  setNow(2026, 7, 17, 12, 0);
  const one = () => [{ id: 'x', name: 'П', type: 'daily' }];
  for (const bad of [8640000000000001, 1e18, -1e18, Infinity, NaN, 'вчера', {}]) {
    const s = app.migrate({ schemaVersion: 16, items: one(), settings: { exportedAt: bad, seed17: true } });
    assert.equal(s.settings.exportedAt, null, 'мусор сведён к «экспорта не было»: ' + String(bad));
  }
  // граница: последняя представимая дата остаётся как есть
  const ok = app.migrate({ schemaVersion: 16, items: one(), settings: { exportedAt: 8640000000000000 } });
  assert.equal(ok.settings.exportedAt, 8640000000000000);
  const norm = app.migrate({ schemaVersion: 16, items: one(), settings: { exportedAt: 1750000000000 } });
  assert.equal(norm.settings.exportedAt, 1750000000000, 'нормальная отметка не тронута');
});

/* п. 8. Полуночный переход — обёртка суток, а не подъём на всю высоту. */
test('З27/8: минуты суток разворачиваются по кратчайшей дуге', () => {
  const p = (date, value) => ({ date, value });
  // 00:00 → 23:45 — пятнадцать минут назад, а не 1425 вперёд
  const a = app.unwrapDayMinutes([p('2026-07-01', 0), p('2026-07-08', 1425), p('2026-07-15', 1410)]);
  assert.deepEqual(a.map(x => x.value), [0, -15, -30]);
  // и обратно: 23:45 → 00:00 — пятнадцать минут вперёд
  const b = app.unwrapDayMinutes([p('2026-07-01', 1425), p('2026-07-08', 0)]);
  assert.deepEqual(b.map(x => x.value), [1425, 1440]);
  // обычный ряд без перехода через полночь не меняется
  const c = [p('2026-07-01', 1380), p('2026-07-08', 1365), p('2026-07-15', 1350)];
  assert.deepEqual(app.unwrapDayMinutes(c).map(x => x.value), [1380, 1365, 1350]);
  // даты не трогаются
  assert.deepEqual(a.map(x => x.date), ['2026-07-01', '2026-07-08', '2026-07-15']);
  // размах после разворота сопоставим с шагом: линия читается
  const vals = a.map(x => x.value);
  assert.equal(Math.max(...vals) - Math.min(...vals), 30, 'размах — два шага по 15, а не 1425');
});

/* 9.3. Арифметика keepInPlace — чистой функцией, а не только замером. */
test('З27/9.3: holdScrollTarget — куда встанет скролл, чтобы точка нажатия не ушла', () => {
  // узел ниже кнопки на 20 px — скролл вниз на столько же
  assert.equal(app.holdScrollTarget(400, 420, 1000), 1020);
  // узел выше кнопки — скролл вверх
  assert.equal(app.holdScrollTarget(500, 430, 1000), 930);
  // смещения нет — трогать скролл незачем
  assert.equal(app.holdScrollTarget(300, 300, 1000), null);
  // ниже нуля не уходим: отрицательного скролла не бывает
  assert.equal(app.holdScrollTarget(600, 0, 100), 0);
  // scrollY может отсутствовать — считается как ноль
  assert.equal(app.holdScrollTarget(0, 40, undefined), 40);
});

/* ── Задача 28.A: страховка зеркала (инвариант 9) ───────────── */

/* Разбор снапшота: непарсящийся — это null, а не пустой store. Ветка
   существует затем, чтобы исход 'read' перестал считаться успехом. */
test('З28A/1.1: mirrorParse — снапшот разбирается, мусор даёт null', () => {
  setNow(2026, 8, 15);
  const s = freshStore();
  assert.equal(mirrorParseOf(null), null, 'снапшота нет');
  assert.equal(mirrorParseOf({}), null, 'нет поля json');
  assert.equal(mirrorParseOf({ json: 42 }), null, 'json не строка');
  assert.equal(mirrorParseOf({ json: '{"items":[{"id":"a"' }), null, 'обрыв строки');
  assert.equal(mirrorParseOf({ json: 'не json вовсе' }), null, 'не json');
  const ok = mirrorParseOf({ json: JSON.stringify(s) });
  assert.ok(ok && Array.isArray(ok.items), 'валидный снапшот разобран');
  assert.equal(ok.schemaVersion, app.SCHEMA_VERSION, 'migrate прогнан при разборе');

  function mirrorParseOf(snap) { return app.mirrorParse(snap); }
});

/* Снапшот старой схемы разбирается и доводится migrate — прежнее
   поведение восстановления, вынесенное в отдельную функцию. */
test('З28A/1.1: mirrorParse доводит снапшот старой схемы', () => {
  setNow(2026, 8, 15);
  const old = { schemaVersion: 2, items: [], days: {}, settings: { dayBoundary: 4 } };
  const got = app.mirrorParse({ json: JSON.stringify(old) });
  assert.equal(got.schemaVersion, app.SCHEMA_VERSION);
  assert.ok(Array.isArray(got.reviews), 'поля достроены');
});

/* Направление сравнения: предложение рождает только то, чего в рабочей
   копии НЕТ ВОВСЕ. Отставание зеркала на одну операцию даёт снапшоту
   МЕНЬШЕ, а не больше, — и потому предложения не порождает. */
test('З28A/2.2: mirrorHasMore — только то, чего в рабочей копии нет вовсе', () => {
  setNow(2026, 8, 15);
  const cur = {
    items: [{ id: 'a' }, { id: 'b' }],
    days: { '2026-08-14': { a: true }, '2026-08-15': { a: true } }
  };
  const same = { items: [{ id: 'a' }, { id: 'b' }], days: { '2026-08-14': {}, '2026-08-15': {} } };
  assert.equal(app.mirrorHasMore(same, cur), false, 'то же самое — предложения нет');

  // зеркало отстало: в нём МЕНЬШЕ дней и меньше пунктов
  assert.equal(app.mirrorHasMore({ items: [{ id: 'a' }], days: { '2026-08-14': {} } }, cur), false,
    'отставание на операцию предложения не порождает');

  // в снапшоте день, которого в рабочей копии нет
  assert.equal(app.mirrorHasMore({ items: [], days: { '2026-08-10': {} } }, cur), true);
  // в снапшоте пункт, которого в рабочей копии нет
  assert.equal(app.mirrorHasMore({ items: [{ id: 'z' }], days: {} }, cur), true);
  // мусор вместо снапшота предложения не порождает
  assert.equal(app.mirrorHasMore(null, cur), false);
  assert.equal(app.mirrorHasMore({ items: 'нет', days: 7 }, cur), false);
});

/* Тот самый случай дыры 2, посчитанный на числах: подлинная практика
   против рождённого посевом localStorage. Идентификаторы посева новые,
   дни чужие — снапшот «впереди» по обоим признакам. */
test('З28A/2.2: практика в зеркале против посева в localStorage', () => {
  setNow(2026, 8, 15);
  const seeded = freshStore();                 // 9 посевных пунктов, дней нет
  const genuine = {
    items: [{ id: 'own1', name: 'Умыться' }],
    days: { '2026-08-13': { own1: true }, '2026-08-14': { own1: true } }
  };
  assert.equal(app.mirrorHasMore(genuine, seeded), true, 'подлинный снапшот виден как «есть чего нет»');
  assert.equal(app.mirrorHasMore(seeded, seeded), false, 'сам себе предложения не делает');
});

/* Ключ отдельный: один на двоих затирал бы одно другим, когда нечитаемы
   и рабочий ключ, и снапшот (load() пишет свой первым). */
test('З28A/1.2: ключ нечитаемой копии зеркала отдельный от рабочего', () => {
  assert.equal(app.CORRUPT_KEY, 'minimum:data:corrupt');
  assert.equal(app.MIRROR_CORRUPT_KEY, 'minimum:data:mirror-corrupt');
  assert.notEqual(app.CORRUPT_KEY, app.MIRROR_CORRUPT_KEY);
});

/* 9.1. Ключ формы по разметке — формы блока и упражнения его получили. */
test('З27/9.1: domFormKey — формы блока и упражнения получили ключ', () => {
  const f = (form, id) => ({ dataset: id === undefined ? { form } : { form, id } });
  assert.equal(app.domFormKey(f('add')), 'add');
  assert.equal(app.domFormKey(f('edit', 'i1')), 'edit:i1');
  assert.equal(app.domFormKey(f('group-edit', 'Утро')), 'group:Утро');
  assert.equal(app.domFormKey(f('group-add')), 'group+new');
  assert.equal(app.domFormKey(f('ex-edit', 'x1')), 'ex:x1');
  assert.equal(app.domFormKey(f('ex-add')), 'ex+new');
  assert.equal(app.domFormKey(f('formula', 'i1')), 'formula:i1');
  assert.equal(app.domFormKey(f('ladder', 'i1')), 'ladder:i1');
  assert.equal(app.domFormKey(f('train', 'w1')), 'train:w1');
});


/* ══ Инвариант 12. Отрезок жизни пункта (задача 28.E/A) ═══════
   Прошлое считается по тем, кто ЖИЛ в том дне: addedAt ≤ день и
   (removedAt пуст или день < removedAt). Прежде фильтр читал i.active —
   нынешнее значение — и применял его ко всем дням истории, то есть
   сегодняшний тумблер переписывал прошлое. */

/* Детерминированный ГПСЧ фикстуры регресса: без него «реалистичный store»
   был бы либо крошечным, либо невоспроизводимым. */
function lcg28e(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

/* Реалистичный v16-store владельца: 105 дней истории, восемь пунктов
   минимума (три ВЫКЛЮЧЕНЫ: с отметками, заведённый позже и ни разу не
   отмеченный), две привычки, недельный счётчик и параметр. */
function v16Fixture() {
  const since = '2026-05-04'; // понедельник, 105-й день до 16.08.2026 включительно
  const mk = (id, name, extra) => Object.assign({
    id, name, value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group: '', active: true, addedAt: since,
    raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  }, extra || {});
  const items = [
    mk('m1', 'Умыться'),
    mk('m2', 'Душ'),
    mk('m3', 'Подтягивания', { value: 5, unit: 'повт.', history: [{ date: since, value: 5 }] }),
    mk('m4', 'Английский', { value: 5, unit: 'мин', addedAt: '2026-05-25' }),
    mk('m5', 'Развитие', { active: false }),                       // выключен, отметки есть
    mk('m6', 'Пешком', { active: false, addedAt: '2026-06-15' }),  // выключен и заведён позже
    mk('m7', 'Растяжка', { active: false }),                       // выключен и ни разу не отмечен
    mk('m8', 'Дневник', { addedAt: '2026-07-06' }),                // заведён поздно, активен
    mk('h1', 'Телефон вне кровати', { area: 'habit', normPerWeek: 7 }),
    mk('h2', 'Ногти', { area: 'habit', normPerWeek: 5, active: false }),
    mk('w1', 'Тренировка', { type: 'weekly', goal: 3 }),
    mk('p1', 'Отбой', {
      type: 'param', area: 'habit', pkind: 'time', pvalue: 1380, pstep: -15,
      history: [{ date: since, value: 1410 }, { date: '2026-06-01', value: 1380 }]
    })
  ];
  const rnd = lcg28e(20260816);
  const days = {};
  const t = '2026-08-16';
  let k = since;
  while (k <= t) {
    for (const it of items) {
      if (it.type !== 'daily' || it.addedAt > k) continue;
      const pr = it.id === 'm7' ? 0 : (it.id === 'm5' ? 0.55 : (it.id === 'm6' ? 0.4 : 0.86));
      if (rnd() < pr) (days[k] || (days[k] = {}))[it.id] = true;
    }
    k = app.addDays(k, 1);
  }
  return {
    schemaVersion: 16, items, groups: [], days,
    weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [],
    exercises: [], sessions: [], notes: [], paramDecided: {},
    draftOneChange: '', weekStart: t,
    settings: {
      dayBoundary: 4, dayThreshold: 0.8, exportedAt: null,
      calendarSince: since, habitSeeded: true, seed17: true
    }
  };
}

/* Цепь дней строкой: F — зачтён, P — частичный, «.» — пусто,
   f — впереди, p — до начала отсчёта. Сравнивать проще, чем сетку. */
function chainString() {
  const t = app.todayKey();
  const since = app.store.settings.calendarSince;
  const th = app.dayThreshold() - 1e-9;
  let out = '';
  for (const mon of app.chainWeeks(8)) {
    for (let i = 0; i < 7; i++) {
      const d = app.addDays(mon, i);
      if (d > t) { out += 'f'; continue; }
      if (d < since) { out += 'p'; continue; }
      const sc = app.dayScore(d);
      out += (sc !== null && sc >= th) ? 'F' : (sc ? 'P' : '.');
    }
  }
  return out;
}

/* Эталон, снятый КОДОМ ДО ПРАВКИ (minimum-v41, схема 16) на этой самой
   фикстуре: разведка A.0.6. Числа владельца не вправе сдвинуться после
   миграции ни на единицу — в этом всё содержание части A. */
const V41_STREAK = 22;
const V41_BEST = 22;
const V41_CHAIN = 'PFFFPFFPFPFFFFFFFFFFFPPFFFFPFFFFPFPFFFFFFFFFFFFFFFFFFFFF';

test('З28E/A.7.1: миграция v16→v17 не сдвигает числа «Прогресса» ни на единицу', () => {
  setNow(2026, 8, 16, 12, 0);
  const raw = v16Fixture();

  // «ДО» по дням считается ПРЯВИЛОМ v41 прямо здесь, на непромигрированных
  // данных: active && addedAt ≤ день. Эталон не переписан из вывода нового
  // кода — он выведен из старого правила независимо
  const t = '2026-08-16';
  const before = [];
  for (let k = raw.settings.calendarSince; k <= t; k = app.addDays(k, 1)) {
    const applicable = raw.items.filter(i =>
      i.type === 'daily' && i.area === 'min' && i.active && i.addedAt <= k);
    const done = applicable.filter(i => raw.days[k] && raw.days[k][i.id]).length;
    before.push(done + '/' + applicable.length);
  }
  assert.equal(before.length, 105, 'эпоха на 105 дней');

  // «ПОСЛЕ»: миграция и те же числа новым правилом
  const m = app.migrate(raw);
  app.store = m;
  assert.equal(m.schemaVersion, app.SCHEMA_VERSION);
  // v19 («Расписание 1/3»): цепочка шагов проходит и через дни блоков —
  // числа обязаны уцелеть и после неё, поэтому версия — нынешняя.
  // v20 (Р2): и через режимы — тем же доводом версия нынешняя, двадцатая
  assert.equal(m.schemaVersion, 20, 'схема поднята до двадцатой');

  const after = [];
  for (let k = m.settings.calendarSince; k <= t; k = app.addDays(k, 1)) {
    const x = app.minDayMarks(k);
    after.push(x.done + '/' + x.total);
  }
  assert.deepEqual(after, before, 'dayScore по каждому дню эпохи — тот же');

  assert.equal(app.dayStreak(), V41_STREAK, 'серия та же, что до миграции');
  assert.equal(app.bestStreak(), V41_BEST, 'рекорд тот же');
  assert.equal(chainString(), V41_CHAIN, 'цепь дней та же');

  // и сама конверсия: выключенные стали убранными с дня заведения,
  // поле active снято у всех
  for (const it of m.items) assert.equal('active' in it, false);
  assert.equal(m.items.find(i => i.id === 'm5').removedAt, '2026-05-04');
  assert.equal(m.items.find(i => i.id === 'm6').removedAt, '2026-06-15');
  assert.equal(m.items.find(i => i.id === 'm1').removedAt, null);

  // повторный прогон ничего не меняет
  assert.equal(JSON.stringify(app.migrate(JSON.parse(JSON.stringify(m)))), JSON.stringify(m));
});

test('З28E/A.7.2: уход пункта не двигает прошлое — серия, рекорд и цепь те же', () => {
  setNow(2026, 8, 16, 12, 0);
  const m = app.migrate(v16Fixture());
  app.store = m;
  const was = { streak: app.dayStreak(), best: app.bestStreak(), chain: chainString() };

  // уходит пункт с САМОЙ РЕДКОЙ историей — прежде именно он и «чинил» прошлое
  assert.equal(app.removeItem('m4'), true);
  assert.equal(m.items.find(i => i.id === 'm4').removedAt, app.todayKey());

  assert.equal(app.bestStreak(), was.best, 'рекорд не сдвинулся');
  assert.equal(chainString().slice(0, -1), was.chain.slice(0, -1), 'вчера и раньше — та же цепь');
  // сегодняшний день — единственный, который вправе измениться: уход
  // действует с сегодняшнего дня включительно
  const t = app.todayKey();
  assert.equal(app.minDayItems(app.addDays(t, -1)).some(i => i.id === 'm4'), true, 'вчера пункт был');
  assert.equal(app.minDayItems(t).some(i => i.id === 'm4'), false, 'сегодня его уже нет');
  assert.ok(app.dayStreak() >= was.streak, 'серия не могла укоротиться от ухода');
});

test('З28E/A.7.3: уход и возврат в тот же день — полная отмена', () => {
  setNow(2026, 8, 16, 12, 0);
  const m = app.migrate(v16Fixture());
  app.store = m;
  const snap = JSON.stringify(m.items);

  assert.equal(app.removeItem('m1'), true);
  const back = app.restoreItem('m1');
  assert.equal(back.id, 'm1', 'та же запись, а не новая');
  assert.equal(m.items.filter(i => i.name === 'Умыться').length, 1, 'дублей не завелось');
  assert.equal(JSON.stringify(m.items), snap, 'состояние побайтово прежнее');
});

test('З28E/A.7.4: возврат позже — новая запись, дни паузы не в знаменателе', () => {
  setNow(2026, 8, 16, 12, 0);
  const m = app.migrate(v16Fixture());
  app.store = m;
  const pause = app.todayKey();
  assert.equal(app.removeItem('m3'), true);

  advanceDays(3);
  const t2 = app.todayKey();
  const back = app.restoreItem('m3');
  assert.notEqual(back.id, 'm3', 'новый id');
  assert.equal(back.addedAt, t2);
  assert.equal(back.removedAt, null);
  assert.equal(back.name, 'Подтягивания');
  assert.equal(back.value, 5);
  assert.deepEqual(back.history, [{ date: t2, value: 5 }], 'история прежнего отрезка при нём и осталась');
  assert.equal(m.items.find(i => i.id === 'm3').history.length, 1, 'у прежней записи история цела');
  // новая запись встала сразу за прежней — порядок блока не потерян
  assert.equal(m.items.indexOf(back), m.items.findIndex(i => i.id === 'm3') + 1);

  // дни паузы: ни прежняя запись, ни новая в знаменателе не стоят
  for (let k = pause; k < t2; k = app.addDays(k, 1)) {
    const ids = app.minDayItems(k).map(i => i.id);
    assert.equal(ids.includes('m3'), false, 'убранный не в знаменателе ' + k);
    assert.equal(ids.includes(back.id), false, 'вернувшийся тоже: его тогда не было');
  }
  assert.equal(app.minDayItems(t2).some(i => i.id === back.id), true, 'сегодня он снова считается');
  // и вчерашний день до ухода по-прежнему знает прежнюю запись
  assert.equal(app.minDayItems(app.addDays(pause, -1)).some(i => i.id === 'm3'), true);
});

test('З28E/A.7.5: заведён и убран в один день — не в знаменателе ни одного дня', () => {
  setNow(2026, 8, 16, 12, 0);
  const m = app.migrate(v16Fixture());
  app.store = m;
  const t = app.todayKey();
  m.items.push({
    id: 'oneday', name: 'Однодневка', value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group: '', removedAt: null, addedAt: t,
    raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  });
  assert.equal(app.minDayItems(t).some(i => i.id === 'oneday'), true, 'пока живёт — считается');
  assert.equal(app.removeItem('oneday'), true);

  for (let k = m.settings.calendarSince; k <= t; k = app.addDays(k, 1)) {
    assert.equal(app.minDayItems(k).some(i => i.id === 'oneday'), false, 'ни в одном дне: ' + k);
  }
  assert.equal(app.livedOn(m.items.find(i => i.id === 'oneday'), t), false);
});

test('З28E/A.7.6: отказ записи откатывает поле — ни ухода, ни возврата', () => {
  setNow(2026, 8, 16, 12, 0);
  const m = app.migrate(v16Fixture());
  app.store = m;

  // localStorage, который не принимает запись: save() возвращает false
  const mem = {};
  let deny = false;
  global.localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { if (deny) throw new Error('quota'); mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  };
  try {
    deny = true;
    assert.equal(app.removeItem('m1'), false, 'уход не выполнен');
    assert.equal(m.items.find(i => i.id === 'm1').removedAt, null, 'поле откачено');

    deny = false;
    assert.equal(app.removeItem('m1'), true);
    const n = m.items.length;

    // возврат в тот же день при отказе записи: поле возвращается на место
    deny = true;
    assert.equal(app.restoreItem('m1'), null);
    assert.equal(m.items.find(i => i.id === 'm1').removedAt, app.todayKey(), 'по-прежнему убран');
    assert.equal(m.items.length, n, 'записей не прибавилось');

    // возврат ПОЗЖЕ при отказе записи: новая запись не остаётся в списке
    advanceDays(2);
    assert.equal(app.restoreItem('m1'), null);
    assert.equal(m.items.length, n, 'новая запись откачена');

    // упражнения — тем же механизмом
    m.exercises.push({ id: 'x1', name: 'Жим', unit: 'кг', value: 40, history: [], removedAt: null, addedAt: '2026-05-04' });
    assert.equal(app.removeExercise('x1'), false);
    assert.equal(m.exercises.find(e => e.id === 'x1').removedAt, null);
  } finally {
    delete global.localStorage;
  }
});

test('З28E/A: убранный пункт не двигается стрелками и не участвует в порядке', () => {
  setNow(2026, 8, 16, 12, 0);
  const m = app.migrate(v16Fixture());
  app.store = m;
  const order = () => m.items.filter(i => i.area === 'min' && !i.group).map(i => i.id);

  // m5, m6, m7 убраны миграцией; соседями живых они не считаются
  assert.equal(app.canMoveItem('m5', 'up'), false);
  assert.equal(app.canMoveItem('m5', 'down'), false);
  assert.equal(app.moveItem('m5', 'up'), false);
  assert.equal(app.reorderItem('m5', 0), false);

  const was = order();
  assert.equal(app.moveItem('m8', 'up'), true); // перепрыгивает через убранные
  const now = order();
  assert.notDeepEqual(now, was);
  assert.deepEqual(now.filter(id => ['m5', 'm6', 'm7'].includes(id)),
    was.filter(id => ['m5', 'm6', 'm7'].includes(id)), 'убранные остались на своих местах');
});


/* ══ Задача 28.E, часть B: строка дня ═════════════════════════
   Единственное исключение из запрета на лозунги приложения. Выбор —
   чистая функция от ключа логического дня и только от него. */

test('З28E/B.5.1: одна и та же строка весь день, разная в разные дни', () => {
  setNow(2026, 8, 16, 5, 0);
  const morning = app.dayLine(app.todayKey());
  setNow(2026, 8, 16, 23, 59);
  assert.equal(app.dayLine(app.todayKey()), morning, 'весь логический день — одна строка');
  // 00:30 следующих суток — ещё этот же логический день (инвариант 1)
  setNow(2026, 8, 17, 0, 30);
  assert.equal(app.dayLine(app.todayKey()), morning, 'до границы дня строка не меняется');
  setNow(2026, 8, 17, 12, 0);
  assert.notEqual(app.dayLine(app.todayKey()), morning, 'новый день — новая строка');
});

test('З28E/B.5.2: выбор не зависит от days{}, calendarSince и чистки', () => {
  setNow(2026, 8, 16, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const was = app.dayLine(t);

  // отметка по кругу
  const it = s.items.find(i => i.type === 'daily');
  app.toggleMark(t, it.id);
  assert.equal(app.dayLine(t), was, 'тап по кругу строку не меняет');

  // начало отсчёта — правится владельцем, и строка не вправе за ним ходить
  s.settings.calendarSince = app.addDays(app.weekStartOf(t), -700);
  assert.equal(app.dayLine(t), was);
  s.settings.calendarSince = app.addDays(app.weekStartOf(t), 700);
  assert.equal(app.dayLine(t), was, 'пустая эпоха тоже ничего не меняет');

  // и число дней в системе — тем более: прежний quoteOfDay брал именно его
  assert.notEqual(app.daysInSystem(), 0 - 1);
  const before = app.daysInSystem();
  s.settings.calendarSince = app.addDays(app.weekStartOf(t), -70);
  assert.notEqual(app.daysInSystem(), before);
  assert.equal(app.dayLine(t), was, 'daysInSystem на выбор не влияет');

  // чистка: другой store, тот же день — та же строка
  fakeLocalStorage();
  app.store = app.emptyStore(4, 0.8);
  assert.equal(app.dayLine(t), was, 'чистка строку не трогает');
  clearLocalStorage();

  // и вообще без store
  const keep = app.store;
  app.store = null;
  assert.equal(app.dayLine(t), was, 'функция не читает store вовсе');
  app.store = keep;
});

test('З28E/B.5.3: набор — 91 строка, дублей нет, за строкой не закреплён день недели', () => {
  const L = app.DAY_LINES;
  // Промпт задачи называл 90 и перечислял 91: набор взят дословно, счёт
  // доложен архитектору. 91 = 7 × 13 — голый остаток намертво привязал бы
  // строку к одному дню недели, и привязку снимает сам выбор
  assert.equal(L.length, 91);
  assert.equal(new Set(L).size, L.length, 'дублей нет');
  for (const line of L) {
    assert.equal(typeof line, 'string');
    assert.equal(line.trim(), line);
    assert.ok(line.length > 0 && line.length <= 90, line);
    assert.doesNotMatch(line, /[«»"]/, 'без кавычек: это не цитата — ' + line);
  }
  assert.equal(L[0], 'Минимум выполняется даже в худший день.', 'кредо «Сегодня» — первый элемент');

  // круг: каждая строка ровно один раз
  let k = app.DAY_LINE_EPOCH;
  const cycle = new Set();
  for (let n = 0; n < L.length; n++) { cycle.add(app.dayLine(k)); k = app.addDays(k, 1); }
  assert.equal(cycle.size, L.length, 'за круг набор проходится целиком');

  // и главное: за семь кругов каждая строка бывает во все дни недели
  const seen = new Map();
  k = app.DAY_LINE_EPOCH;
  for (let n = 0; n < L.length * 7; n++) {
    const line = app.dayLine(k);
    if (!seen.has(line)) seen.set(line, new Set());
    seen.get(line).add(app.weekStartOf(k) === k ? 0 : app.diffDays(k, app.weekStartOf(k)));
    k = app.addDays(k, 1);
  }
  assert.equal(seen.size, L.length);
  for (const [line, dows] of seen) {
    assert.equal(dows.size, 7, 'строка сцепилась с днями недели: ' + line);
  }

  // соседние дни не повторяются
  k = '2025-01-01';
  for (let n = 0; n < 800; n++) {
    assert.notEqual(app.dayLine(k), app.dayLine(app.addDays(k, 1)), 'повтор подряд у ' + k);
    k = app.addDays(k, 1);
  }
  // дни до якоря считаются тем же правилом, без NaN и без выхода за границы
  assert.ok(L.includes(app.dayLine('2019-03-07')));
});

/* ══ Задача 29/B: расписание пункта ══════════════════════════════ */

/* ── B.6.1 РЕГРЕСС: схема 17 → 18 не двигает ни одного числа ──────
   Та же фикстура и те же ЗАПИСАННЫЕ константы, что у регресса задачи
   28.E/A: V41_STREAK, V41_BEST и V41_CHAIN сняты с версии ДО обеих
   миграций и от нового кода не зависят вовсе. Уцелели и здесь — значит
   числа владельца не сдвинулись за две точки невозврата подряд.

   Плюс независимый расчёт по СТАРОМУ правилу прямо в тесте: применимость
   без всякой маски, выведенная из непромигрированных данных, а не
   списанная с вывода нового кода. */
test('З29B/6.1: миграция v17→v18 не сдвигает числа «Прогресса» ни на единицу', () => {
  setNow(2026, 8, 16, 12, 0);
  const raw = v16Fixture();
  const t = '2026-08-16';

  // «ДО» — правило БЕЗ расписания, на сырых данных: пункт применим ко дню,
  // если он в нём жил. Именно так считала семнадцатая схема.
  const before = [];
  for (let k = raw.settings.calendarSince; k <= t; k = app.addDays(k, 1)) {
    const applicable = raw.items.filter(i =>
      i.type === 'daily' && i.area === 'min' && i.active && i.addedAt <= k);
    const done = applicable.filter(i => raw.days[k] && raw.days[k][i.id]).length;
    before.push(done + '/' + applicable.length);
  }

  const m = app.migrate(raw);
  app.store = m;
  // v19 («Расписание 1/3»): цепочка шагов проходит и через дни блоков —
  // числа обязаны уцелеть и после неё, поэтому версия — нынешняя.
  // v20 (Р2): и через режимы — тем же доводом версия нынешняя, двадцатая
  assert.equal(m.schemaVersion, 20, 'схема поднята до двадцатой');

  const after = [];
  for (let k = m.settings.calendarSince; k <= t; k = app.addDays(k, 1)) {
    const x = app.minDayMarks(k);
    after.push(x.done + '/' + x.total);
  }
  assert.deepEqual(after, before, 'знаменатель и числитель каждого дня эпохи — те же');
  assert.equal(app.dayStreak(), V41_STREAK, 'серия та же');
  assert.equal(app.bestStreak(), V41_BEST, 'рекорд тот же');
  assert.equal(chainString(), V41_CHAIN, 'цепь дней та же');

  // B.1.1: каждому ЕЖЕДНЕВНОМУ пункту ровно один отрезок «все семь» с дня
  // заведения; недельный счётчик и параметр расписания не несут вовсе
  for (const it of m.items) {
    if (it.type === 'daily') {
      assert.deepEqual(it.schedule, [{ from: it.addedAt, mask: '1111111' }], it.name);
    } else {
      assert.equal('schedule' in it, false, it.name + ': расписания не несёт');
    }
    assert.equal(it.at, '', it.name + ': время пустое');
  }
  assert.equal(JSON.stringify(app.migrate(JSON.parse(JSON.stringify(m)))), JSON.stringify(m));
});

/* Сердце части B: сегодняшняя смена маски не двигает ВЧЕРАШНИЕ числа —
   то же утверждение, ради которого задача 28.E/A подняла схему. */
test('З29B/6.1: сужение маски СЕГОДНЯ не двигает ни одного прошлого числа', () => {
  setNow(2026, 8, 16, 12, 0);
  const m = app.migrate(v16Fixture());
  app.store = m;
  const t = app.todayKey();

  const snapshot = () => {
    const per = [];
    for (let k = m.settings.calendarSince; k < t; k = app.addDays(k, 1)) {
      const x = app.minDayMarks(k);
      per.push(x.done + '/' + x.total);
    }
    return { per, chain: chainString().slice(0, -1), best: app.bestStreak() };
  };
  const before = snapshot();

  const it = m.items.find(i => i.id === 'm1');
  assert.equal(app.setSchedule(it, '0000001'), true);
  assert.equal(it.schedule.length, 2, 'прежний отрезок не тронут, добавлен новый');
  assert.equal(it.schedule[0].mask, '1111111');
  assert.equal(it.schedule[1].from, t, 'новый отрезок — с сегодняшнего дня');

  const after = snapshot();
  assert.deepEqual(after.per, before.per, 'доли прошлых дней не сдвинулись');
  assert.equal(after.chain, before.chain, 'цепь прошлого та же');
  assert.equal(after.best, before.best, 'рекорд тот же');
  assert.equal(app.weekdayOf(t), 6, 'фикстура кончается воскресеньем');
  assert.equal(app.dueOn(it, t), true);
  assert.equal(app.dueOn(it, app.addDays(t, 1)), false, 'завтра понедельник — пункта нет');
});

/* ── B.6.2: scheduleOn — маска ТОГО дня ──────────────────────── */
test('З29B/6.2: scheduleOn берёт отрезок, действовавший в дне', () => {
  setNow(2026, 8, 16, 12, 0);
  const it = { id: 'x', addedAt: '2026-08-01', schedule: [
    { from: '2026-08-01', mask: '1111111' },
    { from: '2026-08-10', mask: '1010100' }
  ] };
  assert.equal(app.scheduleOn(it, '2026-08-05'), '1111111', 'до смены — прежняя');
  assert.equal(app.scheduleOn(it, '2026-08-09'), '1111111', 'накануне — ещё прежняя');
  assert.equal(app.scheduleOn(it, '2026-08-10'), '1010100', 'в день смены — новая');
  assert.equal(app.scheduleOn(it, '2026-08-30'), '1010100', 'дальше — новая');
  assert.equal(app.scheduleOn({ id: 'y' }, '2020-01-01'), '1111111', 'отрезков нет — все семь');
  assert.equal(app.scheduleOn({ id: 'y', schedule: [] }, '2020-01-01'), '1111111');
  assert.equal(app.scheduleOn({ schedule: [{ from: '2026-09-01', mask: '1000000' }] }, '2026-08-01'),
    '1111111', 'отрезок позже дня в счёт не идёт');
});

test('З29B/6.2: повторная смена в тот же день заменяет отрезок, не плодит', () => {
  setNow(2026, 8, 16, 12, 0);
  const s = freshStore();
  const it = s.items.find(i => i.type === 'daily');
  assert.equal(it.schedule.length, 1, 'посевной пункт — один отрезок');
  advanceDays(1); // отрезок посева стал вчерашним — сегодняшняя смена его не трогает
  const t = app.todayKey();

  app.setSchedule(it, '1010100');
  assert.equal(it.schedule.length, 2);
  app.setSchedule(it, '1100000');
  assert.equal(it.schedule.length, 2, 'второй раз за день — замена, а не третья запись');
  assert.equal(it.schedule[1].mask, '1100000');
  assert.equal(it.schedule[1].from, t);

  app.setSchedule(it, '1111111');
  assert.equal(it.schedule.length, 1, 'возврат к прежней маске схлопывает отрезок');
  assert.equal(it.schedule[0].mask, '1111111');

  advanceDays(1);
  app.setSchedule(it, '0000001');
  assert.equal(it.schedule.length, 2);
  assert.equal(it.schedule[0].mask, '1111111', 'прежний отрезок не тронут');
  assert.equal(app.setSchedule(it, '0000000'), false, 'пустая маска расписанием не становится');
  assert.equal(it.schedule.length, 2, 'отказ ничего не записал');
});

test('З29B/6.2: normSchedule — канон, мусор и идемпотентность', () => {
  const A = '2026-08-01';
  const got = app.normSchedule([
    { from: '2026-08-10', mask: '1010100' },
    { from: 'не дата', mask: '1111111' },
    { from: '2026-08-05', mask: 'ЖЖЖЖЖЖЖ' },
    { from: '2026-08-20', mask: '0000000' }
  ], A);
  assert.deepEqual(got, [{ from: A, mask: '1111111' }, { from: '2026-08-10', mask: '1010100' }]);
  assert.deepEqual(
    app.normSchedule([{ from: '2020-01-01', mask: '1111111' }, { from: '2026-09-01', mask: '1111111' }], A),
    [{ from: A, mask: '1111111' }], 'подряд одинаковые схлопнуты, якорь на addedAt');
  assert.deepEqual(
    app.normSchedule([{ from: A, mask: '1000000' }, { from: A, mask: '0000001' }], A),
    [{ from: A, mask: '0000001' }], 'два отрезка одним днём: побеждает последний');
  for (const inp of [[], [{ from: '2026-08-10', mask: '1010100' }], got]) {
    const once = app.normSchedule(inp, A);
    assert.deepEqual(app.normSchedule(once, A), once, 'идемпотентно');
  }
});

/* ── B.6.3: по тесту на каждый пункт B.2 ─────────────────────── */

test('З29B/6.3 (B.2.6): при m = 7 пороги — РОВНО прежние 6 и 3', () => {
  assert.equal(app.raiseNeed(7), 6, 'существующим пунктам механика не меняется');
  assert.equal(app.lowerNeed(7), 3);
  const table = [];
  for (let m = 1; m <= 7; m++) table.push([m, app.raiseNeed(m), app.lowerNeed(m)]);
  assert.deepEqual(table, [[1, 1, 0], [2, 2, 0], [3, 3, 1], [4, 4, 1], [5, 5, 2], [6, 6, 2], [7, 6, 3]]);
});

function schedItem(id, name, since, mask, extra) {
  return Object.assign({
    id, name, value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group: '', removedAt: null, addedAt: since, at: '',
    schedule: [{ from: since, mask }],
    raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  }, extra || {});
}

test('З29B/6.3 (B.2.6): воскресный пункт получает повышение и НЕ получает понижения', () => {
  setNow(2026, 8, 24, 12, 0);
  const s = freshStore();
  s.items = [];
  const since = app.addDays(app.weekStartOf(app.todayKey()), -7 * 5);
  s.settings.calendarSince = since;
  const it = schedItem('sun', 'Звонок родителям', since, '0000001',
    { value: 10, unit: 'мин', history: [{ date: since, value: 10 }] });
  s.items.push(it);
  for (const mon of app.closedWeeks(5)) s.days[app.addDays(mon, 6)] = { sun: true };

  for (const mon of app.closedWeeks(3)) {
    assert.equal(app.weekMaskDays(it, mon), 1, 'дней расписания в неделе — один');
    assert.equal(app.itemWeekCount(it, mon), 1, 'и он отмечен');
  }
  assert.equal(app.raiseEligible(it), true, 'один из одного — это «держится»');
  assert.equal(app.lowerEligible(it), false, 'безупречному пункту «Сделать легче» не предлагают');
});

test('З29B/6.3 (B.2.2): день без применимых пунктов сквозной — не рвёт серию и не входит в счёт', () => {
  setNow(2026, 8, 24, 12, 0);
  const s = freshStore();
  s.items = [];
  const since = app.addDays(app.todayKey(), -13);
  s.settings.calendarSince = since;
  const it = schedItem('wd', 'Будни', since, '1111100');
  s.items.push(it);
  for (let k = since; k < app.todayKey(); k = app.addDays(k, 1)) {
    if (app.dueOn(it, k)) s.days[k] = { wd: true };
  }
  const sat = app.addDays(app.weekStartOf(app.todayKey()), -2);
  assert.equal(app.dayScore(sat), null, 'суббота: применимых пунктов нет');
  assert.equal(app.minDayMarks(sat).total, 0);
  let workdays = 0;
  for (let k = since; k < app.todayKey(); k = app.addDays(k, 1)) if (app.dueOn(it, k)) workdays++;
  assert.equal(app.dayStreak(), workdays, 'серия идёт СКВОЗЬ выходные: ' + workdays);
  assert.equal(app.bestStreak(), workdays);
});

test('З29B/6.3 (B.2.4): норма привычки зажимается числом дней маски', () => {
  setNow(2026, 8, 24, 12, 0);
  const s = freshStore();
  const h = s.items.find(i => i.type === 'daily' && i.area === 'habit');
  h.normPerWeek = 7;
  app.setSchedule(h, '0000011');
  assert.equal(h.normPerWeek, 2, 'норма не может превышать числа дней расписания');
  app.setSchedule(h, '1111111');
  assert.equal(h.normPerWeek, 2, 'расширение норму не поднимает: это решение владельца');
  h.normPerWeek = 5;
  assert.equal(app.clampNorm(h), null, 'при семи днях зажимать нечего');
  app.setSchedule(h, '1100000');
  assert.equal(h.normPerWeek, 2);
  const m = app.migrate({ schemaVersion: 17, items: [{
    id: 'z', name: 'З', type: 'daily', area: 'habit', addedAt: '2026-08-01', normPerWeek: 6,
    schedule: [{ from: '2026-08-01', mask: '0000011' }] }] });
  assert.equal(m.items[0].normPerWeek, 2, 'импорт не приносит невыполнимой нормы');
});

test('З29B/6.3 (B.2.5): вчера вне маски — точки нет, ретро-отметка невозможна', () => {
  setNow(2026, 8, 24, 12, 0);
  const s = freshStore();
  s.items = [];
  const since = app.addDays(app.todayKey(), -20);
  s.settings.calendarSince = since;
  const it = schedItem('wd', 'Будни', since, '1111100');
  s.items.push(it);
  s.days[app.addDays(app.todayKey(), -4)] = { wd: true };
  const y = app.addDays(app.todayKey(), -1);
  assert.equal(app.weekdayOf(y), 6, 'вчера воскресенье');
  assert.equal(app.missedYesterday(it, app.todayKey()), false, 'дела вчера не стояло — укора нет');
  assert.equal(app.markYesterday('wd'), false, 'и отметить вчера нечем');
  assert.equal(s.days[y] === undefined || s.days[y].wd === undefined, true, 'в days{} ничего не легло');
});

test('З29B/6.3 (B.2.1): знаменатель «Отметок» — дни расписания, а не календарные', () => {
  setNow(2026, 8, 24, 12, 0);
  const s = freshStore();
  s.items = [];
  const since = app.addDays(app.weekStartOf(app.todayKey()), -7 * 4);
  s.settings.calendarSince = since;
  const it = schedItem('sun', 'Вс', since, '0000001');
  s.items.push(it);
  let sundays = 0;
  for (let k = since; k <= app.todayKey(); k = app.addDays(k, 1)) {
    if (app.weekdayOf(k) === 6) { sundays++; s.days[k] = { sun: true }; }
  }
  assert.equal(app.marksWindow(it), sundays, 'знаменатель — только воскресенья окна');
  assert.equal(app.marksInSystem(it), sundays, 'числитель — тем же правилом');
  assert.ok(sundays >= 3 && sundays <= 5, 'окно четырёх недель: ' + sundays);
});

test('З29B/6.3 (B.2.1): отметка, оставшаяся вне суженной маски, в счёт не идёт', () => {
  setNow(2026, 8, 24, 12, 0);
  const s = freshStore();
  s.items = [];
  const since = app.addDays(app.todayKey(), -20);
  s.settings.calendarSince = since;
  const it = schedItem('x', 'X', since, '1111111');
  s.items.push(it);
  for (let k = since; k <= app.todayKey(); k = app.addDays(k, 1)) s.days[k] = { x: true };
  const wasDen = app.marksWindow(it);
  assert.equal(app.marksInSystem(it), wasDen, '21 день, всё отмечено');
  // сегодня понедельник, новая маска — только воскресенье: из знаменателя
  // уходит РОВНО сегодняшний день, прошлые считаются прежней маской
  assert.equal(app.weekdayOf(app.todayKey()), 0);
  app.setSchedule(it, '0000001');
  assert.ok(app.marksInSystem(it) <= app.marksWindow(it), 'числитель никогда не больше знаменателя');
  assert.equal(app.marksWindow(it), wasDen - 1, 'ушёл только сегодняшний день');
  assert.equal(app.marksInSystem(it), wasDen - 1, 'и его отметка — вместе с ним');
});

/* ── B.6.5: время — подпись, и ни на что не влияет ───────────── */
test('З29B/6.5: normTime — валидация, пустое, мусор', () => {
  for (const ok of ['00:00', '07:30', '23:59', '19:05']) assert.equal(app.normTime(ok), ok);
  assert.equal(app.normTime(' 07:30 '), '07:30', 'пробелы по краям снимаются');
  for (const bad of ['24:00', '7:30', '23:60', '', '  ', 'вечером', null, undefined, 730, {}])
    assert.equal(app.normTime(bad), '', 'мусор не сохраняется: ' + JSON.stringify(bad));
});

test('З29B/6.5: время не влияет НИ НА ОДИН расчёт', () => {
  setNow(2026, 8, 24, 12, 0);
  const s = freshStore();
  calendarPast(s);
  const t = app.todayKey();
  for (let d = 20; d >= 0; d--) {
    const k = app.addDays(t, -d);
    s.days[k] = {};
    for (const i of s.items) if (i.type === 'daily') s.days[k][i.id] = true;
  }
  const snap = () => JSON.stringify([app.dayStreak(), app.bestStreak(), app.chainWeeks(8),
    s.items.map(i => [app.marksInSystem(i), app.marksWindow(i),
      app.raiseEligible(i), app.lowerEligible(i), app.habitStreak(i)])]);
  const before = snap();
  for (const i of s.items) i.at = '07:30';
  assert.equal(snap(), before, 'ни серия, ни цепь, ни отметки, ни планка времени не видят');
});

/* ── B.6.6: пороги производительности держатся ───────────────── */
test('З29B/6.6: bestStreak и dayStreak с расписанием держат пороги инварианта', () => {
  const { store: s } = perfStore();
  app.store = s;
  const mid = app.addDays(s.settings.calendarSince, 400);
  const late = app.addDays(s.settings.calendarSince, 800);
  for (const i of s.items) {
    if (i.type !== 'daily') continue;
    i.schedule = [{ from: s.settings.calendarSince, mask: '1111111' },
      { from: mid, mask: '1111110' }, { from: late, mask: '1111111' }];
  }
  const best = measureMs(() => app.bestStreak());
  const day = measureMs(() => app.dayStreak());
  assert.ok(best < 50, `bestStreak с расписанием: ${best.toFixed(1)} мс ≥ 50 мс`);
  assert.ok(day < 30, `dayStreak с расписанием: ${day.toFixed(1)} мс ≥ 30 мс`);
});

/* ── Инвариант 6: отрезки — вложенная коллекция, потери считаются ── */
test('З29B: потери отрезков расписания называются числом при импорте', () => {
  setNow(2026, 8, 24, 12, 0);
  const raw = { schemaVersion: 18, items: [{
    id: 'x', name: 'A', type: 'daily', area: 'min', addedAt: '2026-08-01',
    schedule: [{ from: '2026-08-01', mask: '1111111' }, { from: 'мусор', mask: '1010101' },
      { from: '2026-08-05', mask: 'ЖЖЖ' }, { from: '2026-08-09', mask: '0000000' }] }] };
  const was = app.dataCounts(JSON.parse(JSON.stringify(raw)));
  const got = app.dataCounts(app.migrate(raw));
  assert.equal(was.schedule, 4);
  assert.equal(got.schedule, 1);
  assert.match(app.droppedLine(was, got), /3 отрезка расписания/);
});

/* ══ «Расписание 1/3»: конструктор расписания — домен (Р1/) ═════════

   Даты фиксированы: 07.09.2026 — понедельник, 12–13.09 — выходные,
   14.09 — понедельник, 19.09 — суббота. Каждый тест, которому нужна
   успешная запись, ставит свою заглушку localStorage: без неё save()
   возвращает false, и доменные операции с откатом честно откатываются. */

const R1_MON = '2026-09-07';
const R1_WEEK = '1111111';

/* Пункт в канонической форме v19: журнал принадлежности — только у действия */
function r1Item(id, since, group, mask, extra) {
  const it = Object.assign({
    id, name: id, value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group, removedAt: null, addedAt: since, at: '',
    schedule: [{ from: since, mask }],
    raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  }, extra || {});
  if (it.type === 'daily' && it.area === 'min' && !Array.isArray(it.groupLog)) it.groupLog = [];
  return it;
}

const r1Block = (name, days, removedAt, caption) =>
  ({ name, caption: caption || '', days: days || [], removedAt: removedAt || null });

/* Тот же блок в каноне v20 (задача Р2): migrate и фабрики заводят блок в
   режиме, и у данных без режимов это основной. Блок без поля читается
   основным, поэтому фикстуры r1Block остаются как есть — меняются только
   ожидания от migrate и от операций, которые блок ЗАВОДЯТ. */
const inMain = g => Object.assign({}, g, { mode: 'main' });

/* Фикстура владельца (п. 6 задачи) — ОДНА на оба уровня тестов: данные и
   сборка в tests/r1-owner.js, здесь — сборка через тестовый хук (addGroup,
   addActions, parseQuickLines, setSchedule) в понедельник 07.09.2026.
   Прежде доменная фикстура была своей и придуманной (Р1/рецензия). */
const { R1_OWNER, R1_OWNER_COUNTS, buildR1Owner } = require('./r1-owner.js');

function r1Owner() {
  setNow(2026, 9, 7, 12, 0);
  const s = freshStore();
  s.items = []; s.groups = []; s.days = {};
  s.settings.calendarSince = R1_MON;
  s.settings.dayThreshold = 0.8;
  buildR1Owner(app, assert);
  return s;
}

test('Р1/1: эффективные дни — «как блок», переопределение, ∧; привычки блоком не ограничены', () => {
  setNow(2026, 9, 7, 12, 0);
  const s = freshStore();
  s.days = {};
  const since = '2026-08-31';
  s.groups = [r1Block('Будни', [{ from: since, mask: '1111100' }]), r1Block('Все')];
  const a = r1Item('a', since, 'Будни', R1_WEEK);             // «как блок»
  const b = r1Item('b', since, 'Будни', '1010101');           // свои: пн ср пт вс
  const c = r1Item('c', since, 'Все', '0000011');             // блок без отрезков
  const d = r1Item('d', since, '', '0110000');                // без блока
  const e = r1Item('e', since, 'Нет такого', R1_WEEK);        // неизвестный блок
  const h = r1Item('h', since, 'Будни', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  s.items = [a, b, c, d, e, h];

  assert.equal(app.andMask('1010101', '1111100'), '1010100');
  assert.equal(app.andMask(R1_WEEK, '0000011'), '0000011', '«все семь» — нейтральный элемент ∧');
  assert.equal(app.andMask('мусор', '0000011'), '0000011', 'мусор читается нейтральным, а не нулём');

  const k = R1_MON;
  assert.equal(app.effectiveMaskOn(a, k), '1111100', '«как блок» — это маска блока');
  assert.equal(app.effectiveMaskOn(b, k), '1010100', 'свои дни сужают дни блока');
  assert.equal(app.effectiveMaskOn(c, k), '0000011', 'блок без отрезков — все семь');
  assert.equal(app.effectiveMaskOn(d, k), '0110000', 'без блока — своя маска');
  assert.equal(app.effectiveMaskOn(e, k), R1_WEEK, 'неизвестный блок ничего не режет');
  assert.equal(app.effectiveMaskOn(h, k), R1_WEEK, 'привычке дни блока не указ');
  assert.equal(app.blockMaskOn(s.groups[1], '2020-01-01'), R1_WEEK);
  assert.equal(app.blockMaskOn(s.groups[0], '2026-08-30'), R1_WEEK, 'до первого отрезка — все семь');
  assert.equal(app.blockMaskOn(s.groups[0], since), '1111100');

  assert.deepEqual([a, b, c, d, e, h].map(it => app.weekMaskDays(it, since)), [5, 3, 2, 2, 7, 7]);
  const sat = '2026-09-05';
  assert.equal(app.dueOn(a, sat), false, 'суббота вне дней блока');
  assert.equal(app.dueOn(h, sat), true, 'а привычка того же блока в субботе есть');
  assert.equal(app.dueNow(h, sat), true);
  assert.equal(app.minDayItems(sat).map(i => i.id).join(), 'c,e', 'в знаменателе дня — только эффективные');
});

test('Р1/1: dueOn, dueNow и weekMaskDays — ровно effectiveMaskOn, и с журналом, и со сменой дней', () => {
  setNow(2026, 9, 21, 12, 0);
  const s = freshStore();
  s.days = {};
  const since = '2026-08-31';
  s.groups = [
    r1Block('Школа', [{ from: since, mask: '1111100' }, { from: '2026-09-10', mask: '1010100' }]),
    r1Block('Спорт', [{ from: '2026-09-05', mask: '0000011' }], '2026-09-15'), // убран, но прошлое помнит
    r1Block('Утро')
  ];
  const items = [
    r1Item('x', since, 'Утро', '1111110', { groupLog: [
      { from: since, group: 'Школа' }, { from: '2026-09-08', group: 'Спорт' }, { from: '2026-09-15', group: 'Утро' }] }),
    r1Item('y', since, 'Спорт', R1_WEEK, { removedAt: '2026-09-15',
      schedule: [{ from: since, mask: R1_WEEK }, { from: '2026-09-12', mask: '0000001' }] }),
    r1Item('z', '2026-09-04', 'Школа', '0111111'),
    r1Item('h', since, 'Школа', '1000001', { area: 'habit', normPerWeek: 2 })
  ];
  s.items = items;
  let hits = 0;
  for (let k = '2026-08-28'; k <= '2026-09-21'; k = app.addDays(k, 1)) {
    const wd = app.weekdayOf(k);
    for (const it of items) {
      const eff = app.effectiveMaskOn(it, k)[wd] === '1';
      assert.equal(app.dueOn(it, k), app.livedOn(it, k) && eff, `dueOn ${it.id} ${k}`);
      assert.equal(app.dueNow(it, k), app.live(it) && eff, `dueNow ${it.id} ${k}`);
      assert.equal(app.inEffectiveDays(it, k), eff, `inEffectiveDays ${it.id} ${k}`);
      if (eff) hits++;
    }
  }
  assert.ok(hits > 20, 'сценарий не пустой: ' + hits);
  for (const mon of ['2026-08-31', '2026-09-07', '2026-09-14']) {
    for (const it of items) {
      let n = 0;
      for (let i = 0; i < 7; i++) {
        const k = app.addDays(mon, i);
        if (app.effectiveMaskOn(it, k)[app.weekdayOf(k)] === '1') n++;
      }
      assert.equal(app.weekMaskDays(it, mon), n, `weekMaskDays ${it.id} ${mon}`);
    }
  }
  // журнал ведёт блок по дням: в среду 9-го x был в «Спорте» (выходные)
  assert.equal(app.groupOn(items[0], '2026-09-09'), 'Спорт');
  assert.equal(app.dueOn(items[0], '2026-09-09'), false);
  assert.equal(app.groupOn(items[0], '2026-08-01'), 'Школа', 'день до первой записи — первая запись');
});

test('Р1/6: фикстура владельца — вторник 20, пн и пт 21, выходные 12; зачёт 80% — 16, 17, 10', () => {
  fakeLocalStorage();
  const s = r1Owner();
  assert.equal(app.weekdayOf(R1_MON), 0, 'фикстура начинается понедельником');
  assert.deepEqual(s.groups.map(g => [g.name, g.caption, app.blockMaskNow(g)]),
    R1_OWNER.map(b => [b.name, b.caption, b.mask]), 'блоки владельца — с подписями и днями, по порядку');
  assert.equal(s.items.length, 22);
  const b3 = s.items.find(i => i.name === 'Блок 3');
  assert.equal(b3.group, 'Учеба');
  assert.equal(b3.note, '50 минут / 10 перерыв', 'подпись из строки после « · »; «/» — не разделитель');
  assert.equal(app.scheduleNow(b3), '1010100', 'свои дни «Блока 3» — пн, ср, пт');
  assert.equal(app.effectiveMaskOn(b3, R1_MON), '1010100', 'внутри блока «все дни» свои дни и есть эффективные');
  assert.equal(s.items.find(i => i.name === 'Кровать').note, '');
  assert.equal(s.items.find(i => i.name === 'Экстра').note, '11:45');

  const counts = () => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const k = app.addDays(R1_MON, i);
      const n = app.minDayItems(k).length;
      assert.equal(s.items.filter(it => app.dueNow(it, k)).length, n, 'сегодняшний список — то же правило, ' + k);
      out.push([n, app.dayNeed(n)]);
    }
    return out;
  };
  assert.deepEqual(R1_OWNER_COUNTS, [[21, 17], [20, 16], [21, 17], [20, 16], [21, 17], [12, 10], [12, 10]],
    'контрольные числа раздела 3 — дословно');
  assert.deepEqual(counts(), R1_OWNER_COUNTS, 'пн вт ср чт пт сб вс');
  assert.equal(app.thresholdNote(), 'День зачтён, если отмечено не меньше 17 из 21.');

  // в субботу будних блоков нет — пустой блок не рисуется; «Учеба» стоит:
  // в ней «Блок 1» и «Блок 2» ежедневные, хотя «Блок 3» — нет
  const sat = app.addDays(R1_MON, 5);
  assert.deepEqual(app.groupedItems(s.items.filter(it => app.dueNow(it, sat))).map(x => x.group && x.group.name),
    ['Утро', 'Учеба', 'Выходной', 'Вечер']);
  assert.deepEqual(app.groupedItems(s.items.filter(it => app.dueNow(it, R1_MON))).map(x => x.group && x.group.name),
    ['Утро', 'Школа', 'Дом + Спорт', 'Учеба', 'Вечер']);
  const tue = app.addDays(R1_MON, 1);
  assert.equal(app.groupedItems(s.items.filter(it => app.dueNow(it, tue))).find(x => x.group.name === 'Учеба').items.length, 2,
    'во вторник в «Учебе» — два действия');

  // те же дни МАСКОЙ БЛОКА вместо своей — те же числа: переопределение и ∧
  // дают одно и то же
  assert.equal(app.addGroup('Пн, ср, пт', '', '1010100'), true);
  assert.equal(app.setSchedule(b3, R1_WEEK), true);
  assert.deepEqual(b3.schedule, [{ from: R1_MON, mask: R1_WEEK }], 'своя маска «все семь» — «как блок»');
  assert.equal(app.setItemGroup(b3, 'Пн, ср, пт'), true);
  assert.deepEqual(counts(), R1_OWNER_COUNTS, 'дни блока вместо своих — те же числа');
  assert.deepEqual(app.updateGroup('Пн, ср, пт', { mask: R1_WEEK }), { ok: true, name: 'Пн, ср, пт' });
  assert.deepEqual(app.findGroup('Пн, ср, пт').days, [], 'возврат к «все семь» в тот же день — без отрезков');
  clearLocalStorage();
});

test('Р1/2: смена дней блока сегодня не двигает прошлое — «N из M», доли, цепь и рекорд', () => {
  fakeLocalStorage();
  const s = r1Owner();
  let n = 0;
  for (let k = R1_MON; k <= '2026-09-18'; k = app.addDays(k, 1), n++) {
    const due = app.minDayItems(k);
    const day = {};
    due.forEach((it, j) => { if (!(n % 3 === 0 && j < 3)) day[it.id] = true; }); // частичные дни
    s.days[k] = day;
  }
  setNow(2026, 9, 19, 12, 0); // суббота
  const t = app.todayKey();
  const snap = () => {
    const per = [];
    for (let k = R1_MON; k < t; k = app.addDays(k, 1)) {
      const x = app.minDayMarks(k);
      per.push(`${k} ${x.done}/${x.total} ${app.dayScore(k)} ${app.dayNeed(x.total)}`);
    }
    const chain = chainString();
    const at = chain.indexOf('f') < 0 ? chain.length : chain.indexOf('f');
    return { per, chain: chain.slice(0, at - 1), best: app.bestStreak() };
  };
  const before = snap();
  assert.equal(app.minDayMarks(t).total, 12, 'сегодня суббота: 12 действий');

  assert.deepEqual(app.updateGroup('Утро', { mask: '1111100' }), { ok: true, name: 'Утро' });
  assert.deepEqual(app.findGroup('Утро').days, [{ from: t, mask: '1111100' }], 'отрезок — с сегодняшнего дня');
  assert.equal(app.minDayMarks(t).total, 5, 'сегодня семи дел «Утра» уже нет — правка действует');
  // остальные субботние блоки владельца — туда же, «Выходной» — на воскресенье;
  // у «Блока 3» свои пн, ср, пт внутри будней остаются — отказа нет
  for (const [name, mask] of [['Учеба', '1111100'], ['Вечер', '1111100'], ['Выходной', '0000001']]) {
    assert.deepEqual(app.updateGroup(name, { mask }), { ok: true, name });
  }
  assert.equal(app.minDayMarks(t).total, 0, 'в субботе не осталось ни одного действия');
  assert.equal(app.dayScore(t), null, 'и день стал нейтральным');

  const after = snap();
  assert.deepEqual(after.per, before.per, 'вчера и раньше — те же числа');
  assert.equal(after.chain, before.chain, 'цепь прошлого та же');
  assert.equal(after.best, before.best, 'рекорд тот же');
  clearLocalStorage();
});

test('Р1/3: перенос действия в будний блок прошлого не двигает; туда-обратно за день — журнал пуст', () => {
  fakeLocalStorage();
  const s = r1Owner();
  const bed = s.items.find(i => i.name === 'Кровать');
  const pastSat = '2026-09-12';
  setNow(2026, 9, 19, 12, 0); // суббота
  const t = app.todayKey();
  const pastTotal = app.minDayMarks(pastSat).total;
  assert.equal(pastTotal, 12, 'прошлая суббота владельца — 12 действий');

  assert.equal(app.setItemGroup(bed, 'Школа'), true);
  assert.equal(bed.group, 'Школа');
  assert.deepEqual(bed.groupLog, [{ from: R1_MON, group: 'Утро' }, { from: t, group: 'Школа' }]);
  assert.equal(app.groupOn(bed, pastSat), 'Утро');
  assert.equal(app.groupOn(bed, t), 'Школа');
  assert.equal(app.dueOn(bed, pastSat), true, 'в прошлую субботу действие стояло в плане');
  assert.equal(app.minDayMarks(pastSat).total, pastTotal, 'знаменатель прошлой субботы прежний');
  assert.equal(app.dueNow(bed, t), false, 'а сегодня суббота, и «Школа» — будни');
  assert.deepEqual(app.normGroupLog(bed.groupLog, bed, t), bed.groupLog, 'журнал сразу в каноне migrate');
  // без журнала то же имя переписало бы прошлое — ради этого он и заведён
  assert.equal(app.dueOn(Object.assign({}, bed, { groupLog: [] }), pastSat), false);

  assert.equal(app.setItemGroup(bed, 'Дом + Спорт'), true);
  assert.deepEqual(bed.groupLog, [{ from: R1_MON, group: 'Утро' }, { from: t, group: 'Дом + Спорт' }],
    'вторая смена за день заменяет сегодняшнюю запись');
  assert.equal(app.setItemGroup(bed, '  Утро '), true);
  assert.deepEqual(bed.groupLog, [], 'туда-обратно за день — истории нет');
  assert.equal(bed.group, 'Утро');
  assert.equal(app.setItemGroup(bed, 'Утро'), false, 'то же имя — не смена');

  const fresh = app.addActions('Утро', [{ name: 'Новое', note: '' }])[0];
  assert.equal(app.setItemGroup(fresh, 'Школа'), true);
  assert.deepEqual(fresh.groupLog, [], 'заведённое сегодня вчерашнего дня не имело');

  const habit = r1Item('hab', R1_MON, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  s.items.push(habit);
  assert.equal(app.setItemGroup(habit, 'Школа'), true);
  assert.equal('groupLog' in habit, false, 'у привычки журнала нет');

  advanceDays(2); // понедельник
  assert.equal(app.setItemGroup(bed, 'Школа'), true);
  assert.deepEqual(bed.groupLog, [{ from: R1_MON, group: 'Утро' }, { from: '2026-09-21', group: 'Школа' }]);

  // Р1/рецензия: запись «из будущего» (сбитые часы) снимается, а не остаётся
  // перед новой — как хвост дней блока в Р1/20. Снимается всё с from ≥
  // сегодня, а не только сегодняшнее: иначе журнал вышел бы из порядка
  const skew = r1Item('skew', R1_MON, 'Школа', R1_WEEK,
    { groupLog: [{ from: R1_MON, group: 'Утро' }, { from: '2026-12-01', group: 'Школа' }] });
  assert.equal(app.setItemGroup(skew, 'Дом + Спорт'), true);
  assert.deepEqual(skew.groupLog, [{ from: R1_MON, group: 'Утро' }, { from: '2026-09-21', group: 'Дом + Спорт' }],
    'будущая запись снята, новая — с сегодняшнего дня');
  assert.deepEqual(app.normGroupLog(JSON.parse(JSON.stringify(skew.groupLog)), skew, app.todayKey()), skew.groupLog,
    'журнал сразу в каноне migrate');
  clearLocalStorage();
});

test('Р1/4: день без запланированных действий нейтрален — зачёт, серия, амнистия, рекорд', () => {
  setNow(2026, 9, 21, 12, 0); // понедельник
  const s = freshStore();
  s.days = {};
  const since = '2026-08-31';
  s.settings.calendarSince = since;
  s.groups = [r1Block('Школа', [{ from: since, mask: '1111100' }])];
  const a = r1Item('a', since, 'Школа', R1_WEEK);
  s.items = [a];
  const missed = ['2026-09-18', '2026-09-09']; // пятница и среда за 9 дней до неё
  let marked = 0;
  for (let k = since; k < app.todayKey(); k = app.addDays(k, 1)) {
    if (!app.dueOn(a, k) || missed.includes(k)) continue;
    s.days[k] = { a: true };
    marked++;
  }
  assert.equal(marked, 13, 'три недели будней без двух');
  assert.equal(app.dayScore('2026-09-19'), null, 'суббота — нечего было делать');
  assert.equal(app.dayScore('2026-09-20'), null);
  assert.equal(app.dayScore('2026-09-18'), 0, 'пятница — пропуск, а не нейтральный день');
  assert.equal(app.dayStreak(), 13, 'выходные не рвут серию и не тратят амнистию — оба пропуска прощены');
  assert.equal(app.bestStreak(), 13, 'рекорд по тем же правилам');

  // не вакуум: те же отметки при блоке «все семь» — выходные стали пропусками
  s.groups[0].days = [];
  assert.equal(app.dayScore('2026-09-19'), 0);
  assert.ok(app.dayStreak() < 13, 'без дней блока серия рвётся на выходных: ' + app.dayStreak());
});

test('Р1/5: пустая эффективная маска — ни повышения, ни понижения; при m ≥ 1 всё прежнее', () => {
  setNow(2026, 9, 21, 12, 0);
  const s = freshStore();
  s.days = {};
  const since = app.addDays(app.weekStartOf(app.todayKey()), -35);
  s.settings.calendarSince = since;
  s.groups = [r1Block('Выходные', [{ from: since, mask: '0000011' }])];
  const it = r1Item('z', since, 'Выходные', '1100000',
    { value: 10, unit: 'мин', history: [{ date: since, value: 10 }] });
  s.items = [it];
  s.days[since] = { z: true }; // начат: отметка до окна
  for (const w of app.closedWeeks(3)) assert.equal(app.weekMaskDays(it, w), 0, 'в неделе ни одного дня');
  // без guard'а оба критерия выполнялись бы разом: 0 ≥ 0 и 0 ≤ 0
  assert.equal(app.raiseNeed(0), 0);
  assert.equal(app.lowerNeed(0), 0);
  assert.equal(app.raiseEligible(it), false, 'повышения нет');
  assert.equal(app.lowerEligible(it), false, 'понижения нет');

  // m = 2: guard молчит, критерии прежние — в обе стороны
  s.groups[0].days = [];
  const W = app.closedWeeks(3);
  for (const w of W) { s.days[w] = { z: true }; s.days[app.addDays(w, 1)] = { z: true }; }
  assert.equal(app.weekMaskDays(it, W[2]), 2);
  assert.equal(app.raiseEligible(it), true, 'два из двух три недели — повышение');
  assert.equal(app.lowerEligible(it), false);
  for (const w of W.slice(1)) { delete s.days[w]; delete s.days[app.addDays(w, 1)]; }
  assert.equal(app.raiseEligible(it), false);
  assert.equal(app.lowerEligible(it), true, 'ноль из двух две недели — понижение');
});

/* Р1/рецензия: guard «m = 0» — ХОТЯ БЫ ОДНА пустая неделя окна, а не все
   разом. Окна смешанные: пустая только последняя и пустая только первая —
   так правило «хоть одна» отличается и от «все», и от «первая», и от
   «последняя». Отметки стоят только в днях плана, иначе числитель их не
   видит (planWeekCount). */
test('Р1/5: пустая эффективная маска хоть в одной неделе окна — ни повышения, ни понижения', () => {
  const setup = (blockDays, marks) => {
    setNow(2026, 9, 21, 12, 0); // понедельник; закрытые недели 08-31, 09-07, 09-14
    const s = freshStore();
    s.settings.calendarSince = '2026-08-03';
    s.groups = [r1Block('Блок', blockDays)];
    const z = r1Item('z', '2026-08-03', 'Блок', '1100000',
      { value: 10, unit: 'мин', history: [{ date: '2026-08-03', value: 10 }] });
    s.items = [z];
    s.days = {};
    for (const k of marks) s.days[k] = { z: true };
    return z;
  };
  const W3 = ['2026-08-31', '2026-09-07', '2026-09-14'];
  const monTue = w => [w, app.addDays(w, 1)];

  // (1) пустая только последняя неделя: m = [2, 2, 0]
  let z = setup([{ from: '2026-09-14', mask: '0000011' }], [...monTue(W3[0]), ...monTue(W3[1])]);
  assert.deepEqual(app.closedWeeks(3), W3);
  assert.deepEqual(W3.map(w => app.weekMaskDays(z, w)), [2, 2, 0]);
  assert.deepEqual(W3.map(w => app.planWeekCount(z, w)), [2, 2, 0]);
  assert.equal(app.raiseEligible(z), false, 'две недели «2 из 2» при третьей без плана — не повышение');
  // понижение: окно [09-07, 09-14], m = [2, 0]; отметка 08-31 делает пункт начатым
  z = setup([{ from: '2026-09-14', mask: '0000011' }], monTue(W3[0]));
  assert.deepEqual(app.closedWeeks(2).map(w => app.weekMaskDays(z, w)), [2, 0]);
  assert.equal(app.lowerEligible(z), false, '«0 из 2» одну неделю при второй без плана — не понижение');

  // (2) пустая только первая неделя: m = [0, 2, 2]
  z = setup([{ from: '2026-08-31', mask: '0000011' }, { from: '2026-09-07', mask: R1_WEEK }],
    [...monTue(W3[1]), ...monTue(W3[2])]);
  assert.deepEqual(W3.map(w => app.weekMaskDays(z, w)), [0, 2, 2]);
  assert.equal(app.raiseEligible(z), false, 'первая неделя без плана — повышения нет');
  // понижение: окно [09-07, 09-14], m = [0, 2]; отметка 08-24 делает пункт начатым
  z = setup([{ from: '2026-09-07', mask: '0000011' }, { from: '2026-09-14', mask: R1_WEEK }], ['2026-08-24']);
  assert.deepEqual(app.closedWeeks(2).map(w => app.weekMaskDays(z, w)), [0, 2]);
  assert.equal(app.lowerEligible(z), false, 'первая неделя окна без плана — понижения нет');

  // не вакуум: те же окна без пустых недель проходят оба критерия
  z = setup([{ from: '2026-08-03', mask: '1100000' }], [...monTue(W3[0]), ...monTue(W3[1]), ...monTue(W3[2])]);
  assert.equal(app.raiseEligible(z), true, 'три недели «2 из 2» — повышение');
  z = setup([{ from: '2026-08-03', mask: '1100000' }], ['2026-08-24']);
  assert.equal(app.lowerEligible(z), true, 'две недели «0 из 2» — понижение');
});

/* Р1/рецензия: числитель порогов — отметки в днях плана. Отметка вне плана
   возникает без ошибки владельца: отметил сегодня, потом в тот же день
   сузил дни блока. Прежде она засчитывалась, и повышение предлагалось при
   одной отметке из двух по плану, а сетка разбора (weekPlan) показывала
   «1 из 2». */
test('Р1/21: пороги планки считают только отметки в днях плана — в обе стороны', () => {
  fakeLocalStorage();
  setNow(2026, 8, 17, 12, 0); // понедельник
  const s = freshStore();
  s.days = {};
  s.settings.calendarSince = '2026-08-03';
  s.groups = [r1Block('Школа')];
  const x = r1Item('x', '2026-08-03', 'Школа', R1_WEEK, { value: 10, unit: 'мин', history: [{ date: '2026-08-03', value: 10 }] });
  s.items = [x];
  for (const mon of ['2026-08-03', '2026-08-10']) for (let i = 0; i < 6; i++) s.days[app.addDays(mon, i)] = { x: true };
  app.toggleMark('2026-08-17', 'x');
  assert.equal(app.isMarked('2026-08-17', 'x'), true, 'отмечено сегодня');
  assert.deepEqual(app.updateGroup('Школа', { mask: '0000011' }), { ok: true, name: 'Школа' }, 'и в тот же день дни блока сужены');
  s.days['2026-08-22'] = { x: true };
  setNow(2026, 8, 24, 12, 0);
  const W = app.closedWeeks(3);
  assert.deepEqual(W, ['2026-08-03', '2026-08-10', '2026-08-17']);
  assert.deepEqual(W.map(w => app.weekMaskDays(x, w)), [7, 7, 2]);
  assert.deepEqual(W.map(w => app.itemWeekCount(x, w)), [6, 6, 2], 'в days{} отметок две');
  assert.deepEqual(W.map(w => app.planWeekCount(x, w)), [6, 6, 1], 'в днях плана — одна');
  const keys = [0, 1, 2, 3, 4, 5, 6].map(i => app.addDays(W[2], i));
  assert.deepEqual(app.weekPlan(x, keys), { planned: 2, done: 1 }, 'сетка разбора — те же числа');
  assert.equal(app.raiseEligible(x), false, 'одна отметка из двух по плану — не повышение');
  s.days['2026-08-23'] = { x: true };
  assert.equal(app.raiseEligible(x), true, 'обе субботы-воскресенья отмечены — повышение');
  // при семи днях числитель прежний: отметок вне эффективных дней интерфейс не создаёт
  for (const w of W.slice(0, 2)) assert.equal(app.planWeekCount(x, w), app.itemWeekCount(x, w));

  // зеркально: отметки вне плана не гасят понижение
  setNow(2026, 9, 21, 12, 0);
  s.settings.calendarSince = '2026-08-31';
  s.groups = [r1Block('Выходные', [{ from: '2026-08-31', mask: '0000011' }])];
  const y = r1Item('y', '2026-08-31', 'Выходные', R1_WEEK, { value: 20, unit: 'мин', history: [{ date: '2026-08-31', value: 20 }] });
  s.items = [y];
  s.days = { '2026-08-31': { y: true }, '2026-09-07': { y: true }, '2026-09-14': { y: true } }; // понедельники — вне плана
  const W2 = app.closedWeeks(2);
  assert.deepEqual(W2.map(w => [app.weekMaskDays(y, w), app.itemWeekCount(y, w), app.planWeekCount(y, w)]), [[2, 1, 0], [2, 1, 0]]);
  assert.equal(app.lowerEligible(y), true, '«0 из 2» по плану — понижение, отметки вне плана его не гасят');
  s.days['2026-09-13'] = { y: true };
  assert.equal(app.lowerEligible(y), false, 'отметка в днях плана — «1 из 2», понижения нет');
  clearLocalStorage();
});

test('Р1/7: parseQuickLines — разделитель, пустые строки, обрезка, повторы', () => {
  assert.deepEqual(app.parseQuickLines('Кровать\n\n  Развитие · 10 мин  \r\n   \nКровать'), [
    { name: 'Кровать', note: '' }, { name: 'Развитие', note: '10 мин' }, { name: 'Кровать', note: '' }
  ], 'пустые пропущены, края обрезаны, повтор — второе действие, порядок строк сохранён');
  assert.deepEqual(app.parseQuickLines('Подтягивания / отжимания · 5 / 10'),
    [{ name: 'Подтягивания / отжимания', note: '5 / 10' }], '«/» разделителем не является');
  assert.deepEqual(app.parseQuickLines('a · b · c'), [{ name: 'a', note: 'b · c' }], 'разделитель — первое « · »');
  assert.deepEqual(app.parseQuickLines('Кровать ·'), [{ name: 'Кровать', note: '' }], 'хвостовой « ·» — пустая подпись');
  assert.deepEqual(app.parseQuickLines('Кровать ·   '), [{ name: 'Кровать', note: '' }]);
  assert.deepEqual(app.parseQuickLines('Чай\t·\tс мятой'), [{ name: 'Чай', note: 'с мятой' }], 'пробельные по бокам — любые');
  assert.deepEqual(app.parseQuickLines('a·b'), [{ name: 'a·b', note: '' }], 'точка без пробелов — часть имени');
  assert.deepEqual(app.parseQuickLines('· подпись'), [{ name: '· подпись', note: '' }], 'имя не бывает пустым');
  for (const empty of ['', '   ', '\n\r\n  \n', null, undefined]) {
    assert.deepEqual(app.parseQuickLines(empty), [], JSON.stringify(empty));
  }
});

test('Р2/0: parseQuickLines — четыре разделителя наравне, первое вхождение любого, границы', () => {
  const P = app.parseQuickLines;
  // Каждый из четырёх делит одинаково — и в середине строки, и хвостом.
  for (const sep of ['·', '—', '–', '-']) {
    assert.deepEqual(P(`Развитие ${sep} 10 мин`), [{ name: 'Развитие', note: '10 мин' }], `« ${sep} » делит`);
    assert.deepEqual(P(`Кровать ${sep}`), [{ name: 'Кровать', note: '' }], `хвостовой « ${sep}» — пустая подпись`);
    assert.deepEqual(P(`Кровать ${sep}   `), [{ name: 'Кровать', note: '' }], `хвостовой « ${sep} » с пробелами`);
    assert.deepEqual(P(`Чай\t${sep} с мятой`), [{ name: 'Чай', note: 'с мятой' }], `« ${sep} » — пробельные по бокам любые`);
    assert.deepEqual(P(`a${sep}b`), [{ name: `a${sep}b`, note: '' }], `«${sep}» без пробелов — часть имени`);
    assert.deepEqual(P(`a ${sep}b`), [{ name: `a ${sep}b`, note: '' }], `«${sep}» без пробела справа — часть имени`);
    assert.deepEqual(P(`a${sep} b`), [{ name: `a${sep} b`, note: '' }], `«${sep}» без пробела слева — часть имени`);
    assert.deepEqual(P(`${sep} подпись`), [{ name: `${sep} подпись`, note: '' }], `имя не бывает пустым: « ${sep} » в начале строки`);
  }
  // Первое вхождение ЛЮБОГО — не первый по списку знак.
  assert.deepEqual(P('a — b · c'), [{ name: 'a', note: 'b · c' }], 'тире раньше точки — делит тире');
  assert.deepEqual(P('a · b — c'), [{ name: 'a', note: 'b — c' }], 'точка раньше тире — делит точка');
  assert.deepEqual(P('a - b – c — d'), [{ name: 'a', note: 'b – c — d' }], 'остальные — в подписи как есть');
  assert.deepEqual(P('a – b - c'), [{ name: 'a', note: 'b - c' }]);
  // Дефис и тире внутри слова и числа — не разделители; разделитель после них — делит.
  assert.deepEqual(P('Кросс-фит'), [{ name: 'Кросс-фит', note: '' }], 'дефис внутри слова');
  assert.deepEqual(P('10–15 минут'), [{ name: '10–15 минут', note: '' }], 'тире в диапазоне без пробелов');
  assert.deepEqual(P('Кросс-фит - 10–15 минут'), [{ name: 'Кросс-фит', note: '10–15 минут' }], 'делит дефис с пробелами, а не внутри слова');
  assert.deepEqual(P('Планка -5'), [{ name: 'Планка -5', note: '' }], 'минус у числа — не разделитель');
  assert.deepEqual(P('a -- b'), [{ name: 'a -- b', note: '' }], 'двойной дефис — не разделитель');
  // «/» — не разделитель ни с пробелами, ни без; делит следующий за ним знак.
  assert.deepEqual(P('Подтягивания / отжимания - 5 / 10'), [{ name: 'Подтягивания / отжимания', note: '5 / 10' }]);
  assert.deepEqual(P('50 минут / 10 перерыв'), [{ name: '50 минут / 10 перерыв', note: '' }]);
  // Пустые строки и повторы — как в Р1, с любым разделителем.
  assert.deepEqual(P('Вода — стакан\n\n  Вода — стакан  \r\n   \nСон - 8 ч'), [
    { name: 'Вода', note: 'стакан' }, { name: 'Вода', note: 'стакан' }, { name: 'Сон', note: '8 ч' }
  ], 'пустые пропущены, повтор — второе действие, порядок сохранён');
});

test('Р2/5: restoreExercise — правило преемника: то же имя, addedAt строго позже removedAt, пара одна на запись', () => {
  fakeLocalStorage();
  try {
    setNow(2026, 9, 14, 12, 0);
    const s = freshStore();
    const ex = (id, name, extra) => Object.assign({ id, name, unit: 'кг', value: 40, history: [], addedAt: '2026-08-31', removedAt: null }, extra);
    s.exercises = [ex('e1', 'Жим'), ex('e2', 'Тяга')];

    // возврат в тот же день — полная отмена: преемника нет и не заводится
    assert.equal(app.removeExercise('e1'), true);
    assert.equal(app.laterExerciseOf(s.exercises[0]), null, 'пока преемника нет');
    assert.equal(app.restoreExercise('e1'), s.exercises[0], 'та же запись');
    assert.equal(s.exercises.length, 2);

    // возврат ПОЗЖЕ дня ухода — новая запись сразу за прежней; прежняя
    // получает преемника и вторым экземпляром не возвращается
    assert.equal(app.removeExercise('e1'), true);
    advanceDays(2);
    const back = app.restoreExercise('e1');
    assert.ok(back && back.id !== 'e1');
    assert.deepEqual(s.exercises.map(e => e.id), ['e1', back.id, 'e2'], 'сразу за прежней');
    assert.equal(app.laterExerciseOf(s.exercises[0]), back, 'у прежней — преемник');
    assert.equal(app.laterExerciseOf(back), null, 'живая запись прежним отрезком не бывает');
    const n = s.exercises.length;
    const saved = localStorage.getItem('minimum:data');
    assert.equal(app.restoreExercise('e1'), null, '«Вернуть» прежней записи дубля не заводит');
    assert.equal(s.exercises.length, n);
    assert.equal(localStorage.getItem('minimum:data'), saved, 'и ничего не записано');
    // прошлое не двигается: у прежней записи — прежние поля
    assert.deepEqual([s.exercises[0].removedAt, s.exercises[0].addedAt], ['2026-09-14', '2026-08-31']);

    // уход преемника: прежняя прячется и за убранным, последний отрезок — нет
    assert.equal(app.removeExercise(back.id), true);
    assert.equal(app.laterExerciseOf(back), null, 'последний отрезок прятать нечем');
    assert.equal(app.laterExerciseOf(s.exercises[0]), back, 'прежняя — за убранным преемником');

    // не преемник: заведённое В ДЕНЬ ухода (строго позже) и другое имя
    const t = app.todayKey();
    s.exercises.push(ex('x1', 'Присед', { removedAt: t }), ex('x2', 'Присед', { addedAt: t }), ex('y1', 'Выпады', { removedAt: '2026-09-01' }), ex('y2', 'Присед', { addedAt: '2026-09-10' }));
    const x1 = s.exercises.find(e => e.id === 'x1');
    const y1 = s.exercises.find(e => e.id === 'y1');
    assert.equal(app.laterExerciseOf(y1), null, 'другое имя — не преемник');
    assert.equal(app.laterExerciseOf(x1), null, 'заведённое в день ухода — соседнее, а не продолжение');

    // пара одна на запись: два одноимённых убранных, один преемник — прячется
    // ровно одна прежняя, вторая остаётся без пары и возвращается
    s.exercises = [ex('d1', 'Вис', { removedAt: '2026-09-02' }), ex('d2', 'Вис', { removedAt: '2026-09-02' }), ex('d3', 'Вис', { addedAt: '2026-09-05' })];
    const [d1, d2, d3] = s.exercises;
    assert.equal([d1, d2].filter(d => app.laterExerciseOf(d) === d3).length, 1, 'преемник прячет ровно одну');
    const unpaired = [d1, d2].find(d => !app.laterExerciseOf(d));
    assert.ok(unpaired, 'одна запись без пары');
    const again = app.restoreExercise(unpaired.id);
    assert.ok(again && again.name === 'Вис', 'запись без пары возвращается');
    assert.equal([d1, d2].filter(d => !app.laterExerciseOf(d)).length, 0, 'после возврата у обеих есть пара');

    // общая часть правила — одна у пунктов и упражнений
    assert.equal(typeof app.successorAmong, 'function');
  } finally {
    clearLocalStorage();
  }
});

test('Р1/8: addActions — в конец items[], канон, пусто — без записи, отказ записи — откат', () => {
  fakeLocalStorage();
  setNow(2026, 9, 7, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const n0 = s.items.length;
  const made = app.addActions(' Утро ', app.parseQuickLines('Кровать\nВода · стакан'));
  assert.equal(made.length, 2);
  assert.deepEqual(s.items.slice(n0), made, 'в конец, по порядку строк');
  assert.deepEqual(made.map(i => [i.name, i.note, i.group, i.type, i.area, i.addedAt, i.value]),
    [['Кровать', '', 'Утро', 'daily', 'min', t, null], ['Вода', 'стакан', 'Утро', 'daily', 'min', t, null]]);
  assert.deepEqual(made[0].schedule, [{ from: t, mask: R1_WEEK }], '«как блок»');
  assert.deepEqual(made[0].groupLog, []);
  const m = app.migrate(JSON.parse(JSON.stringify(s)));
  for (const it of made) assert.deepEqual(m.items.find(x => x.id === it.id), it, 'канон: migrate ничего не меняет');

  assert.deepEqual(app.addActions('Утро', []), []);
  assert.deepEqual(app.addActions('Утро', [{ name: '   ', note: '' }]), [], 'пустое имя действием не становится');
  assert.equal(s.items.length, n0 + 2);
  assert.equal(app.addActions('', [{ name: 'Без блока', note: '' }])[0].group, '', '«Без блока» — пустое имя');

  const before = JSON.stringify(s.items);
  withBrokenWrite(() => {
    assert.deepEqual(app.addActions('Утро', [{ name: 'X', note: '' }, { name: 'Y', note: '' }]), []);
  });
  assert.equal(JSON.stringify(s.items), before, 'отказ записи — ни одного действия в памяти');
  clearLocalStorage();
});

test('Р1/9: duplicateGroup — имя копии, дни и подпись, только живые действия, канон, откат', () => {
  fakeLocalStorage();
  setNow(2026, 9, 7, 12, 0);
  const s = freshStore();
  const t = app.todayKey();
  const since = '2026-08-03';
  s.groups = [r1Block('Школа', [{ from: since, mask: '1111100' }], null, '8:30'), r1Block('Вечер')];
  const d1 = r1Item('d1', since, 'Школа', '1010101', {
    name: 'Чтение', value: 5, unit: 'мин', note: 'вслух', at: '08:30', raiseAfterWeek: '2026-08-31',
    history: [{ date: since, value: 3 }, { date: '2026-08-20', value: 5 }],
    groupLog: [{ from: since, group: 'Вечер' }, { from: '2026-08-10', group: 'Школа' }]
  });
  const w1 = { id: 'w1', name: 'Тренировка', value: null, unit: '', type: 'weekly', area: 'min', goal: 3,
    note: '', group: 'Школа', removedAt: null, addedAt: since, at: '', raiseAfter: 0, raiseAfterWeek: null,
    lowerAfterWeek: null, history: [], formula: null, ladder: null, ladderLog: [] };
  const gone = r1Item('gone', since, 'Школа', R1_WEEK, { removedAt: '2026-09-01' });
  const hab = r1Item('hab', since, 'Школа', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  const par = { id: 'par', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit', pkind: 'time',
    pvalue: 1380, pstep: -15, goal: null, note: '', group: 'Школа', removedAt: null, addedAt: since, at: '',
    raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [{ date: since, value: 1380 }],
    formula: null, ladder: null, ladderLog: [] };
  const other = r1Item('other', since, 'Вечер', R1_WEEK);
  s.items = [d1, hab, w1, gone, par, other];
  s.days = { '2026-09-01': { d1: true, w1: true } };

  const nm = app.duplicateGroup('Школа');
  assert.equal(nm, 'Школа (копия)');
  assert.deepEqual(s.groups.map(g => g.name), ['Школа', 'Школа (копия)', 'Вечер'], 'копия — сразу за источником');
  const copy = app.findGroup(nm);
  // v20 (Р2): копия встаёт в режим источника — у блока без поля это основной
  assert.deepEqual(copy, { name: nm, caption: '8:30', days: [{ from: t, mask: '1111100' }], removedAt: null, mode: 'main' });

  const copies = s.items.slice(6);
  assert.deepEqual(copies.map(i => i.name), ['Чтение', 'Тренировка'],
    'живые действия в порядке items[]; привычки, параметры и убранные не копируются');
  const [c1, c2] = copies;
  assert.notEqual(c1.id, 'd1');
  assert.deepEqual(
    [c1.addedAt, c1.group, c1.value, c1.unit, c1.note, c1.at, c1.raiseAfterWeek, c1.removedAt],
    [t, nm, 5, 'мин', 'вслух', '08:30', null, null]);
  assert.deepEqual(c1.schedule, [{ from: t, mask: '1010101' }], 'своя маска на сегодня');
  assert.deepEqual(c1.groupLog, [], 'журнала у копии нет — прошлого у неё нет');
  assert.deepEqual(c1.history, [{ date: t, value: 5 }]);
  assert.equal(c2.goal, 3);
  assert.equal('schedule' in c2, false, 'недельному — ни расписания');
  assert.equal('groupLog' in c2, false, 'ни журнала');
  assert.deepEqual(c2.history, []);

  const m = app.migrate(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(m.groups[1], copy, 'блок-копия — канон');
  for (const c of copies) assert.deepEqual(m.items.find(x => x.id === c.id), c, 'копия ≡ migrate(копия): ' + c.name);
  assert.deepEqual(s.days, { '2026-09-01': { d1: true, w1: true } }, 'отметки при прежних записях');

  assert.equal(app.duplicateGroup('Школа'), 'Школа (копия 2)');
  assert.equal(app.duplicateGroup('Школа'), 'Школа (копия 3)');
  s.items.push(r1Item('orph', since, 'Вечер (копия)', R1_WEEK)); // имя без блока (импорт)
  assert.equal(app.duplicateGroup('Вечер'), 'Вечер (копия 2)', 'осиротевшее имя копия не берёт');
  assert.deepEqual(app.findGroup('Вечер (копия 2)').days, [], 'источник «все семь» — копия без отрезков');
  assert.equal(app.duplicateGroup('Нет такого'), null);

  const before = JSON.stringify(s);
  withBrokenWrite(() => { assert.equal(app.duplicateGroup('Школа'), null); });
  assert.equal(JSON.stringify(s), before, 'отказ записи — ни блока, ни копий');
  clearLocalStorage();
});

test('Р1/10: уход и возврат блока — в тот же день отмена, позже новые записи сразу за прежними', () => {
  fakeLocalStorage();
  setNow(2026, 9, 7, 12, 0);
  const s = freshStore();
  const since = '2026-08-31';
  s.groups = [r1Block('Школа', [{ from: since, mask: '1111100' }]), r1Block('Вечер')];
  const g = s.groups[0];
  // у действия — непустой журнал: копия при возврате позже его НЕ наследует
  const a = r1Item('a', since, 'Школа', R1_WEEK, { value: 5, unit: 'мин', history: [{ date: since, value: 5 }],
    groupLog: [{ from: since, group: 'Вечер' }, { from: '2026-09-03', group: 'Школа' }] });
  const h = r1Item('h', since, 'Школа', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  // «всех типов»: недельный счётчик и параметр уходят и возвращаются с блоком
  const w = r1Item('w', since, 'Школа', R1_WEEK, { type: 'weekly', goal: 3 });
  delete w.schedule;
  const e = r1Item('e', since, 'Вечер', R1_WEEK);
  const b = r1Item('b', since, 'Школа', R1_WEEK);
  const p = r1Item('p', since, 'Школа', R1_WEEK,
    { type: 'param', area: 'habit', pkind: 'number', pvalue: 4000, pstep: 500, unit: 'шаг.' });
  delete p.schedule;
  const pre = r1Item('pre', since, 'Школа', R1_WEEK, { removedAt: '2026-09-03' }); // убран раньше блока
  s.items = [a, h, w, e, b, p, pre];
  s.days = { '2026-09-04': { a: true, b: true } };
  const snap = JSON.stringify(s);
  const t = app.todayKey();

  assert.equal(app.removeGroup('Школа'), true);
  assert.equal(g.removedAt, t);
  assert.deepEqual([a, h, w, b, p, e, pre].map(i => i.removedAt), [t, t, t, t, t, null, '2026-09-03'],
    'ушли живые пункты блока обеих областей и всех типов; чужой и убранный раньше — нет');
  assert.equal(app.removeGroup('Школа'), false, 'уже убран');
  assert.deepEqual(app.liveGroups().map(x => x.name), ['Вечер']);
  assert.deepEqual(app.minDayMarks('2026-09-04'), { done: 2, total: 3, skipped: 0, planned: 3 }, 'прошлая пятница — прежняя');
  assert.equal(app.dueOn(a, '2026-09-05'), false, 'дни убранного блока прошлое помнит');
  assert.equal(app.groupJoinRefusal('Школа'), 'Блок «Школа» убран — вернуть можно в «Убранных»');
  assert.equal(app.groupJoinRefusal('Вечер'), null, 'в живой блок вступать можно');
  assert.equal(app.groupJoinRefusal('Нет такого'), null, 'неизвестное имя — не убранный блок');
  assert.equal(app.groupJoinRefusal(''), null, '«без блока» — не убранный блок');

  assert.equal(app.restoreGroup('Школа'), true);
  assert.equal(JSON.stringify(s), snap, 'тот же день — полная отмена, побайтово');
  assert.equal(app.restoreGroup('Школа'), false, 'живой блок возвращать нечего');

  // ядро возврата: меняет store без записи и отдаёт откат
  assert.equal(app.removeItem('e'), true);
  const core = app.restoreItemCore('e');
  assert.equal(core.item, e, 'тот же день — та же запись');
  assert.equal(e.removedAt, null);
  core.undo();
  assert.equal(e.removedAt, t, 'откат вернул уход');
  assert.equal(app.restoreItemCore('b'), null, 'живой пункт возвращать нечего');
  assert.equal(app.restoreItem('e'), e);

  assert.equal(app.removeGroup('Школа'), true);
  advanceDays(3);
  const t2 = app.todayKey();
  assert.equal(app.restoreGroup('Школа'), true);
  assert.equal(g.removedAt, null);
  assert.deepEqual(s.items.map(i => [i.name, i.addedAt, i.removedAt]), [
    ['a', since, t], ['a', t2, null], ['h', since, t], ['h', t2, null], ['w', since, t], ['w', t2, null],
    ['e', since, null], ['b', since, t], ['b', t2, null], ['p', since, t], ['p', t2, null], ['pre', since, '2026-09-03']
  ], 'новые записи всех типов — сразу за прежними; убранный раньше не вернулся');
  const cw = s.items[5], cp = s.items[10];
  assert.deepEqual([cw.type, cw.goal, 'schedule' in cw, 'groupLog' in cw], ['weekly', 3, false, false], 'копия счётчика');
  assert.deepEqual([cp.type, cp.pvalue, cp.pstep, cp.history], ['param', 4000, 500, [{ date: t2, value: 4000 }]], 'копия параметра');
  assert.deepEqual(a.groupLog, [{ from: since, group: 'Вечер' }, { from: '2026-09-03', group: 'Школа' }],
    'журнал прежней записи — при ней');
  const ca = s.items[1];
  assert.notEqual(ca.id, 'a');
  assert.deepEqual(ca.history, [{ date: t2, value: 5 }]);
  assert.deepEqual(ca.groupLog, [], 'копия действия — с пустым журналом');
  assert.equal('groupLog' in s.items[3], false, 'у копии привычки журнала нет');
  const again = app.migrate(JSON.parse(JSON.stringify(s)));
  for (const i of [1, 3, 5, 10]) assert.deepEqual(again.items[i], s.items[i], 'копия — канон: ' + s.items[i].name);
  assert.deepEqual(s.days, { '2026-09-04': { a: true, b: true } }, 'отметки при прежних записях');
  for (let k = t; k < t2; k = app.addDays(k, 1)) {
    assert.equal(app.minDayItems(k).some(i => i.group === 'Школа'), false, 'дни паузы не в знаменателе: ' + k);
  }

  // отказ записи — откат всего: и ухода, и возврата
  let was = JSON.stringify(s);
  withBrokenWrite(() => { assert.equal(app.removeGroup('Школа'), false); });
  assert.equal(JSON.stringify(s), was, 'уход откачен');
  assert.equal(app.removeGroup('Школа'), true);
  was = JSON.stringify(s);
  withBrokenWrite(() => { assert.equal(app.restoreGroup('Школа'), false); });
  assert.equal(JSON.stringify(s), was, 'возврат в тот же день откачен');
  advanceDays(1);
  withBrokenWrite(() => { assert.equal(app.restoreGroup('Школа'), false); });
  assert.equal(JSON.stringify(s), was, 'возврат позже откачен — ни новых записей, ни полей');
  clearLocalStorage();
});

test('Р1/11: nameTaken и renameGroup — журналы переписываются, осиротевшее имя не берётся', () => {
  fakeLocalStorage();
  setNow(2026, 9, 14, 12, 0);
  const s = freshStore();
  s.days = {};
  const since = '2026-08-31';
  s.groups = [r1Block('Школа', [{ from: since, mask: '1111100' }]), r1Block('Утро'), r1Block('Архив', [], '2026-09-01')];
  const a = r1Item('a', since, 'Утро', R1_WEEK, { groupLog: [{ from: since, group: 'Школа' }, { from: '2026-09-07', group: 'Утро' }] });
  const o = r1Item('o', since, 'Сирота', R1_WEEK);
  const x = r1Item('x', since, 'Утро', R1_WEEK, { groupLog: [{ from: since, group: 'Былое' }, { from: '2026-09-07', group: 'Утро' }] });
  s.items = [a, o, x];

  assert.equal(app.nameTaken('Школа'), true, 'живой блок');
  assert.equal(app.nameTaken('Архив'), true, 'убранный блок');
  assert.equal(app.nameTaken('Сирота'), true, 'имя в item.group без блока');
  assert.equal(app.nameTaken('Былое'), true, 'имя только в журнале');
  assert.equal(app.nameTaken(' Новое '), false);
  assert.equal(app.nameTaken(''), false, 'пустое — не имя');
  assert.equal(app.nameTaken('Школа', 'Школа'), false, 'свой блок себе не помеха');
  assert.equal(app.nameTaken(' Утро ', 'Утро'), false);
  assert.equal(app.nameTaken('Школа', 'Утро'), true);

  for (const bad of ['Сирота', 'Былое', 'Архив', 'Утро']) {
    assert.equal(app.renameGroup('Школа', bad), false, 'занятое: ' + bad);
  }
  assert.equal(app.findGroup('Школа').name, 'Школа');
  assert.equal(app.effectiveMaskOn(a, since), '1111100', 'прошлое a — дни «Школы»');

  assert.equal(app.renameGroup('Школа', ' Учёба '), true);
  assert.equal(app.findGroup('Школа'), null);
  assert.deepEqual(a.groupLog, [{ from: since, group: 'Учёба' }, { from: '2026-09-07', group: 'Утро' }],
    'журнал ссылается на тот же блок под новым именем');
  assert.equal(app.effectiveMaskOn(a, since), '1111100', 'и прошлое нашло его дни');
  assert.equal(app.renameGroup('Утро', 'Утро'), true, 'то же имя — законно');
  // ядро без записи: те же три места, проверок у него нет — их делает вызывающий
  const saves = global.localStorage.getItem('minimum:data');
  app.renameGroupCore(app.findGroup('Учёба'), 'Учёба', 'Школа');
  assert.equal(a.groupLog[0].group, 'Школа');
  assert.equal(global.localStorage.getItem('minimum:data'), saves, 'ядро не пишет');
  app.renameGroupCore(app.findGroup('Школа'), 'Школа', 'Учёба');

  // addGroup в осиротевшее имя разрешён: дни нового блока начинаются сегодня
  assert.equal(app.addGroup('Былое', '', '0000011'), true);
  assert.equal(app.effectiveMaskOn(x, since), R1_WEEK, 'прошлое x не сдвинулось');
  assert.equal(app.addGroup('Архив'), false, 'имя убранного блока занято');
  assert.equal(app.addGroup('Нули', '', '0000000'), false, 'пустая маска — не дни');
  assert.equal(app.addGroup(' Будни ', ' 8:30 ', '1111100'), true);
  // v20 (Р2): новый блок — в активном режиме, здесь основном
  assert.deepEqual(app.findGroup('Будни'),
    { name: 'Будни', caption: '8:30', days: [{ from: '2026-09-14', mask: '1111100' }], removedAt: null, mode: 'main' });
  clearLocalStorage();
});

test('Р1/12: updateGroup — проверки до записи, одна запись, полный откат; zeroDaysIn', () => {
  fakeLocalStorage();
  setNow(2026, 9, 14, 12, 0);
  const s = freshStore();
  s.days = {};
  const since = '2026-08-31';
  s.groups = [r1Block('Утро', [], null, '7:00'), r1Block('Архив', [], '2026-09-01')];
  const a = r1Item('a', since, 'Утро', '1100000');
  const b = r1Item('b', since, 'Утро', R1_WEEK);
  const o = r1Item('o', since, 'Сирота', R1_WEEK);
  const h = r1Item('h', since, 'Утро', '1100000', { area: 'habit', normPerWeek: 2 });
  // убранное действие: при «выходных» у него не осталось бы дней, но на
  // экране его нет — дни блока держать ему нечего
  const gone = r1Item('gone', since, 'Утро', '1100000', { removedAt: '2026-09-10' });
  s.items = [a, b, o, h, gone];
  const snap = () => JSON.stringify(s);
  let was = snap();

  assert.deepEqual(app.updateGroup('Нет', { name: 'X' }), { ok: false, reason: 'missing' });
  assert.deepEqual(app.updateGroup('Утро', { name: '  ' }), { ok: false, reason: 'empty' });
  assert.deepEqual(app.updateGroup('Утро', { name: 'Архив' }), { ok: false, reason: 'removed' });
  assert.deepEqual(app.updateGroup('Утро', { name: 'Сирота' }), { ok: false, reason: 'taken' });
  assert.deepEqual(app.updateGroup('Утро', { mask: '0000000' }), { ok: false, reason: 'nodays' });
  assert.deepEqual(app.updateGroup('Утро', { mask: 'мусор' }), { ok: false, reason: 'nodays' });
  assert.deepEqual(app.zeroDaysIn('Утро', '0000011'), ['a'], 'привычку дни блока не режут, убранное действие не видно — их в списке нет');
  assert.deepEqual(app.updateGroup('Утро', { name: 'Рассвет', caption: 'x', mask: '0000011' }),
    { ok: false, reason: 'zero', names: ['a'] });
  assert.equal(snap(), was, 'отказ — ни имени, ни подписи, ни дней');

  assert.deepEqual(app.updateGroup('Утро', { name: ' Рассвет ', caption: ' 6:30 ', mask: '1111100' }),
    { ok: true, name: 'Рассвет' });
  assert.deepEqual(s.groups[0],
    { name: 'Рассвет', caption: '6:30', days: [{ from: '2026-09-14', mask: '1111100' }], removedAt: null });
  assert.deepEqual([a, b, h].map(i => i.group), ['Рассвет', 'Рассвет', 'Рассвет']);
  assert.equal(JSON.parse(global.localStorage.getItem('minimum:data')).groups[0].caption, '6:30', 'записано');

  // дни не трогали — нуль, пришедший импортом, отказом не становится
  a.schedule = [{ from: since, mask: '0000011' }];
  assert.deepEqual(app.zeroDaysIn('Рассвет', '1111100'), ['a']);
  assert.deepEqual(app.updateGroup('Рассвет', { caption: '6:45' }), { ok: true, name: 'Рассвет' });
  assert.deepEqual(app.updateGroup('Рассвет', { mask: '1111100' }), { ok: true, name: 'Рассвет' }, 'та же маска — не смена');
  assert.equal(s.groups[0].caption, '6:45', 'patch без подписи подпись не сбрасывает');

  // откат при отказе записи возвращает и ЖУРНАЛЫ: переименование переписывает
  // имя в них, и без отката прошлое пункта искало бы блок под новым именем.
  // У блока — дни в прошлом, чтобы разница была видна и по dueOn
  s.groups[0].days = [{ from: since, mask: '1111100' }];
  o.groupLog = [{ from: since, group: 'Рассвет' }, { from: '2026-09-07', group: 'Сирота' }];
  const pastSat = '2026-09-05';
  assert.equal(app.dueOn(o, pastSat), false, 'в прошлую субботу o был в будничном блоке');
  was = snap();
  withBrokenWrite(() => {
    assert.deepEqual(app.updateGroup('Рассвет', { name: 'Учёба', caption: 'y', mask: R1_WEEK }),
      { ok: false, reason: 'storage' });
  });
  assert.equal(snap(), was, 'отказ записи — имя, подпись, дни, пункты и журналы откачены');
  assert.deepEqual(o.groupLog, [{ from: since, group: 'Рассвет' }, { from: '2026-09-07', group: 'Сирота' }]);
  assert.equal(app.dueOn(o, pastSat), false, 'прошлое o не сдвинулось');

  // смена дней, при которой нуль получило бы только убранное действие, проходит
  assert.deepEqual(app.zeroDaysIn('Рассвет', '0000011'), [], 'a теперь — выходные, gone убран');
  assert.deepEqual(app.updateGroup('Рассвет', { mask: '0000011' }), { ok: true, name: 'Рассвет' });
  assert.equal(s.groups[0].caption, '6:45');
  clearLocalStorage();
});

test('Р1/13: moveGroup и reorderGroup перепрыгивают убранные; groupedItems — только живые блоки', () => {
  fakeLocalStorage();
  setNow(2026, 9, 14, 12, 0);
  const s = freshStore();
  s.groups = [r1Block('A'), r1Block('Убр', [], '2026-09-01'), r1Block('B'), r1Block('C')];
  const names = () => s.groups.map(g => g.name);

  assert.equal(app.moveGroup('B', 'up'), true);
  assert.deepEqual(names(), ['B', 'Убр', 'A', 'C'], 'обмен с живым соседом; убранный на своём месте');
  assert.equal(app.moveGroup('B', 'up'), false, 'среди живых уже первый');
  assert.equal(app.moveGroup('Убр', 'down'), false, 'убранный не двигается');
  assert.equal(app.moveGroup('C', 'down'), false);
  assert.equal(app.moveGroup('A', 'down'), true);
  assert.deepEqual(names(), ['B', 'Убр', 'C', 'A']);

  assert.equal(app.reorderGroup('A', 0), true);
  assert.deepEqual(names(), ['A', 'Убр', 'B', 'C'], 'позиция — среди живых');
  assert.equal(app.reorderGroup('C', 2), false, 'та же позиция');
  assert.equal(app.reorderGroup('C', 3), false, 'за границей живых');
  assert.equal(app.reorderGroup('Убр', 0), false, 'убранный не перетаскивается');
  assert.equal(app.reorderGroup('C', 1), true);
  assert.deepEqual(names(), ['A', 'Убр', 'C', 'B']);
  assert.deepEqual(app.liveGroups().map(g => g.name), ['A', 'C', 'B']);
  assert.deepEqual(app.liveGroupIndexes(), [0, 2, 3], 'соседи — индексы живых в store.groups');

  const t = app.todayKey();
  const items = [r1Item('i1', t, 'Убр', R1_WEEK), r1Item('i2', t, 'B', R1_WEEK), r1Item('i3', t, '', R1_WEEK)];
  assert.deepEqual(app.groupedItems(items).map(x => [x.group && x.group.name, x.items.map(i => i.id)]),
    [['B', ['i2']], [null, ['i1', 'i3']]], 'пункт убранного блока — в секции без заголовка');
  clearLocalStorage();
});

test('Р1/14: миграция v18→v19 — аддитивна, идемпотентна, маски пунктов не меняются ни на символ', () => {
  setNow(2026, 8, 16, 12, 0);
  // v18-файл: блок — одно имя, журналов нет, у пунктов свои отрезки
  const raw = JSON.parse(JSON.stringify(app.migrate(v16Fixture())));
  raw.schemaVersion = 18;
  raw.groups = [{ name: 'Утро' }, { name: 'Движение', chain: true }];
  for (const it of raw.items) delete it.groupLog;
  raw.items.find(i => i.id === 'm1').group = 'Утро';
  raw.items.find(i => i.id === 'm2').group = 'Утро';
  raw.items.find(i => i.id === 'm3').group = 'Движение';
  raw.items.find(i => i.id === 'm3').schedule = [{ from: '2026-05-04', mask: R1_WEEK }, { from: '2026-07-01', mask: '1010100' }];
  raw.items.find(i => i.id === 'h1').group = 'Утро';
  raw.reviews = [{ closedAt: 1, week: '2026-08-03', keys: [], perItem: {}, trainings: {}, oneChange: 'x', raises: [], lowers: [], params: [] }];
  const days = JSON.parse(JSON.stringify(raw.days));
  const reviews = JSON.parse(JSON.stringify(raw.reviews));
  const scheds = {};
  for (const it of raw.items) if (it.schedule) scheds[it.id] = JSON.stringify(it.schedule);

  // «ДО» — правило v18 на сырых данных: отрезок жизни и своя маска дня, блоков нет
  const t = '2026-08-16';
  const before = [];
  for (let k = raw.settings.calendarSince; k <= t; k = app.addDays(k, 1)) {
    const applicable = raw.items.filter(i => i.type === 'daily' && i.area === 'min' &&
      i.addedAt <= k && (!i.removedAt || k < i.removedAt) && app.scheduleOn(i, k)[app.weekdayOf(k)] === '1');
    before.push(applicable.filter(i => raw.days[k] && raw.days[k][i.id]).length + '/' + applicable.length);
  }

  const m = app.migrate(raw);
  app.store = m;
  // v20 (Р2): цепочка шагов проходит дальше, через режимы; предмет теста —
  // шаг v18→v19, и его обещания (days, reviews, маски, журналы) проверяются ниже
  assert.equal(m.schemaVersion, 20);
  assert.deepEqual(m.days, days, 'days{} цел');
  assert.deepEqual(m.reviews, reviews, 'reviews[] цел');
  for (const it of m.items) {
    if (it.type === 'daily') assert.equal(JSON.stringify(it.schedule), scheds[it.id], 'маска не тронута: ' + it.id);
    if (it.type === 'daily' && it.area === 'min') assert.deepEqual(it.groupLog, [], 'журнал действия пуст: ' + it.id);
    else assert.equal('groupLog' in it, false, 'у прочих журнала нет: ' + it.id);
  }
  assert.deepEqual(m.groups, [r1Block('Утро'), r1Block('Движение')].map(inMain), 'подпись пустая, дни «все семь», не убран; chain снят; режим основной (v20)');

  const after = [];
  for (let k = m.settings.calendarSince; k <= t; k = app.addDays(k, 1)) {
    const x = app.minDayMarks(k);
    after.push(x.done + '/' + x.total);
  }
  assert.deepEqual(after, before, 'числа каждого дня эпохи — те же');

  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(again, m, 'второй прогон ничего не меняет');
  assert.equal(JSON.stringify(again), JSON.stringify(m), 'и побайтово');

  // v1-store: литерал «Принять душ» — сразу канон, досборка блоков — тоже
  const once = app.migrate(v1Store());
  assert.deepEqual(once.items.find(i => i.name === 'Принять душ').groupLog, []);
  assert.deepEqual(once.groups.find(g => g.name === 'Тело'), inMain(r1Block('Тело')), 'v8→v9 заводит блок сразу каноническим');
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(once))), once, 'v1-store: два прогона совпадают');
  assert.equal(JSON.stringify(app.migrate(JSON.parse(JSON.stringify(once)))), JSON.stringify(once));

  // фабрики: defaultStore и посев — в нынешнем каноне (v20: блоки в основном
  // режиме) и совпадают с migrate от себя
  const def = app.defaultStore();
  assert.equal(JSON.stringify(app.migrate(JSON.parse(JSON.stringify(def)))), JSON.stringify(def));
  assert.deepEqual(def.groups, [r1Block('Утро'), r1Block('Подряд'), r1Block('Движение')].map(inMain));
  assert.deepEqual(app.emptyStore(4).groups, []);
});

test('Р1/15: migrate — канон блоков, мусор дней отброшен, живой пункт возвращает убранный блок', () => {
  setNow(2026, 9, 14, 12, 0);
  const mkRaw = () => ({
    schemaVersion: 19,
    items: [
      { id: 'a', name: 'A', type: 'daily', area: 'min', addedAt: '2026-09-01', group: 'Школа' },
      { id: 'b', name: 'B', type: 'daily', area: 'min', addedAt: '2026-09-01', group: 'Архив', removedAt: '2026-09-05' },
      { id: 'h', name: 'H', type: 'daily', area: 'habit', addedAt: '2026-09-01', group: '',
        groupLog: [{ from: '2026-09-01', group: 'X' }, { from: '2026-09-03', group: 'Архив' }] },
      { id: 'w', name: 'W', type: 'weekly', goal: 2, addedAt: '2026-09-01', group: '', groupLog: [] },
      { id: 'c', name: 'C', type: 'daily', area: 'min', addedAt: '2026-09-01', group: 'Мусор',
        groupLog: [{ from: '2026-09-01', group: 'Архив' }, { from: 'нет', group: 'Y' }, null, { from: '2026-09-04', group: 'Мусор' }] }
    ],
    groups: [
      { name: ' Школа ', caption: '  8:30 ', days: [{ from: '2026-09-07', mask: '1111100' }], removedAt: '2026-09-10' },
      { name: 'Архив', caption: 42, removedAt: '2026-09-05', days: [
        { from: '2026-09-01', mask: R1_WEEK },
        { from: 'мусор', mask: '1111100' },
        { from: '2026-09-02', mask: '0000000' },
        { from: '2026-09-03', mask: 'ЖЖЖЖЖЖЖ' },
        { from: '2026-09-08', mask: '0000011' },
        { from: '2026-09-04', mask: '1111100' },
        { from: '2026-09-08', mask: '1111100' },
        { from: '2026-09-09', mask: '1010100' }
      ] },
      { name: 'Мусор', days: 'не список', removedAt: 'не дата' },
      { name: 'Школа' }
    ],
    days: {}, settings: { dayBoundary: 4, calendarSince: '2026-08-31', seed17: true, habitSeeded: true }
  });
  const raw = mkRaw();
  const was = app.dataCounts(JSON.parse(JSON.stringify(raw)));
  const m = app.migrate(raw);
  assert.deepEqual(m.groups, [
    r1Block('Школа', [{ from: '2026-09-07', mask: '1111100' }], null, '8:30'),
    r1Block('Архив', [{ from: '2026-09-04', mask: '1111100' }, { from: '2026-09-09', mask: '1010100' }], '2026-09-05'),
    r1Block('Мусор')
  ].map(inMain), 'Школа возвращена живым пунктом; Архив остался убранным — его пункты тоже убраны; v20 — в основном режиме');
  assert.equal('groupLog' in m.items.find(i => i.id === 'h'), false, 'привычке журнал не положен');
  assert.equal('groupLog' in m.items.find(i => i.id === 'w'), false);
  assert.deepEqual(m.items.find(i => i.id === 'a').groupLog, []);
  assert.deepEqual(m.items.find(i => i.id === 'c').groupLog,
    [{ from: '2026-09-01', group: 'Архив' }, { from: '2026-09-04', group: 'Мусор' }]);
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(m))), m, 'идемпотентно');

  const got = app.dataCounts(m);
  assert.equal(was.blockDays, 9);
  assert.equal(got.blockDays, 3);
  assert.equal(was.groupLog, 6);
  assert.equal(got.groupLog, 2);
  const line = app.droppedLine(was, got);
  assert.match(line, /6 отрезков дней блока/);
  assert.match(line, /4 записи о блоке/);

  // Р1/рецензия: три ветки, которые фикстура выше не различает.
  // (a) журнал действия расходится с item.group — нынешнее дописывается С
  // СЕГОДНЯШНЕГО дня, прежние записи не трогаются (связка migrate → today)
  const mis = app.migrate({ schemaVersion: 19, items: [
    { id: 'x', name: 'X', type: 'daily', area: 'min', addedAt: '2026-09-01', group: 'C',
      groupLog: [{ from: '2026-09-01', group: 'A' }, { from: '2026-09-07', group: 'B' }] }
  ], groups: [], days: {}, settings: { dayBoundary: 4, calendarSince: '2026-08-31', seed17: true, habitSeeded: true } });
  assert.deepEqual(mis.items[0].groupLog, [
    { from: '2026-09-01', group: 'A' }, { from: '2026-09-07', group: 'B' }, { from: '2026-09-14', group: 'C' }
  ], 'неделя 09-07…09-13 осталась за B');
  // (b) мусорный день ухода у блока без живых пунктов — null, а не мусор
  // (шаг возврата блока его не маскирует: ссылок на блок нет)
  // (c) убранный блок, на который ссылается только живая ПРИВЫЧКА, возвращается:
  // «хоть один живой пункт», а не только действие
  const rev = app.migrate({ schemaVersion: 19, items: [
    { id: 'h', name: 'H', type: 'daily', area: 'habit', addedAt: '2026-09-01', group: 'Архив' }
  ], groups: [{ name: 'X', removedAt: 'не дата' }, { name: 'Архив', removedAt: '2026-09-05' }],
  days: {}, settings: { dayBoundary: 4, calendarSince: '2026-08-31', seed17: true, habitSeeded: true } });
  assert.deepEqual(rev.groups, [r1Block('X'), r1Block('Архив')].map(inMain), 'мусор — null; блок живой привычки возвращён');

  // normBlockDays напрямую
  const nb = app.normBlockDays;
  assert.deepEqual(nb(undefined), []);
  assert.deepEqual(nb([{ from: '2026-09-01', mask: R1_WEEK }]), [], 'одни «все семь» — без отрезков');
  assert.deepEqual(nb([{ from: '2026-09-01', mask: '1111100' }, { from: '2026-09-05', mask: R1_WEEK }]),
    [{ from: '2026-09-01', mask: '1111100' }, { from: '2026-09-05', mask: R1_WEEK }], 'не ведущий «все семь» остаётся');
  for (const inp of [[], m.groups[1].days, mkRaw().groups[1].days, [{ from: '2026-09-01', mask: R1_WEEK }, { from: '2026-09-02', mask: R1_WEEK }]]) {
    const once = nb(inp);
    assert.deepEqual(nb(once), once, 'идемпотентно');
  }
});

test('Р1/16: normGroupLog — канон и идемпотентность на крайних случаях', () => {
  const T = '2026-09-14';
  const it = (addedAt, group) => ({ addedAt, group, type: 'daily', area: 'min' });
  const norm = (list, item) => {
    const once = app.normGroupLog(list, item, T);
    assert.deepEqual(app.normGroupLog(JSON.parse(JSON.stringify(once)), item, T), once, 'второй прогон — то же');
    return once;
  };
  const e = (from, group) => ({ from, group });

  assert.deepEqual(norm([], it('2026-09-01', 'A')), [], 'пустой');
  assert.deepEqual(norm(undefined, it('2026-09-01', 'A')), [], 'отсутствующий');
  assert.deepEqual(norm([e('2026-09-01', 'A')], it('2026-09-01', 'A')), [], 'одно состояние — не история');
  assert.deepEqual(norm([e('2026-09-01', 'A'), e('2026-09-07', 'B')], it('2026-09-01', 'B')),
    [e('2026-09-01', 'A'), e('2026-09-07', 'B')], 'канон не меняется');
  assert.deepEqual(norm([null, 'x', e('нет', 'A'), e('2026-09-07', ' B '), e('2026-08-01', 'A'), { from: '2026-09-03', group: 5 }],
    it('2026-09-01', 'B')), [e('2026-09-01', 'A'), e('2026-09-07', 'B')], 'мусор, раньше addedAt, пробелы, порядок');
  assert.deepEqual(norm([e(T, 'A')], it(T, 'B')), [], 'addedAt — сегодня: расхождение схлопывается в []');
  assert.deepEqual(norm([e('2026-09-01', 'A'), e('2026-09-07', 'B')], it('2026-09-01', 'C')),
    [e('2026-09-01', 'A'), e('2026-09-07', 'B'), e(T, 'C')], 'рассогласование: нынешнее дописано с сегодня');
  assert.deepEqual(norm([e('2026-09-01', 'A'), e('2026-09-20', 'B')], it('2026-09-01', 'C')),
    [e('2026-09-01', 'A'), e('2026-09-20', 'C')], 'последний from позже сегодня: дописано тем же днём и победило');
  assert.deepEqual(norm([e('2026-09-01', 'A'), e('2026-09-20', 'B')], it('2026-09-01', 'B')),
    [e('2026-09-01', 'A'), e('2026-09-20', 'B')], 'будущая запись в согласии с пунктом не трогается');
  assert.deepEqual(norm([e('2026-09-05', 'A'), e('2026-09-07', 'B')], it('2026-09-01', 'B')),
    [e('2026-09-01', 'A'), e('2026-09-07', 'B')], 'первая запись — с дня заведения');
  assert.deepEqual(norm([e('2026-09-01', 'A'), e('2026-09-07', 'B'), e('2026-09-07', 'A'), e('2026-09-09', 'A'), e('2026-09-10', 'C')],
    it('2026-09-01', 'C')), [e('2026-09-01', 'A'), e('2026-09-10', 'C')], 'один день — одна запись, подряд одинаковые схлопнуты');
  assert.deepEqual(norm([e('2026-09-01', 'A')], it('2026-08-20', '  B ')),
    [e('2026-08-20', 'A'), e(T, 'B')], 'имя пункта с пробелами — через groupNameOf');
});

test('Р1/17: категории потерь blockDays и groupLog — склонения и счёт по сырому файлу', () => {
  const zero = { items: 0, days: 0, marks: 0, notes: 0, reviews: 0, exercises: 0, sessions: 0, groups: 0,
    weekLog: 0, history: 0, schedule: 0, blockDays: 0, groupLog: 0, entries: 0, params: 0,
    modes: 0, modeLog: 0, skips: 0 }; // Р2: режимы, отрезки режима и пропуски — их склонения в тестах Р2/
  assert.deepEqual(Object.keys(app.dataCounts({})).sort(), Object.keys(zero).sort(), 'категории счёта — ровно эти');
  const line = (key, n) => app.droppedLine(Object.assign({}, zero, { [key]: n }), zero);
  assert.equal(line('blockDays', 1), '1 отрезок дней блока');
  assert.equal(line('blockDays', 2), '2 отрезка дней блока');
  assert.equal(line('blockDays', 5), '5 отрезков дней блока');
  assert.equal(line('groupLog', 1), '1 запись о блоке');
  assert.equal(line('groupLog', 2), '2 записи о блоке');
  assert.equal(line('groupLog', 5), '5 записей о блоке');
  const c = app.dataCounts({
    groups: [{ days: [1, 2] }, null, { days: 'x' }, 'строка'],
    items: [{ groupLog: [1] }, { groupLog: {} }, null]
  });
  assert.equal(c.blockDays, 2);
  assert.equal(c.groupLog, 1);
});

test('Р1/18: bestStreak и dayStreak с блоками, днями и журналами держат пороги инварианта', () => {
  const { store: s } = perfStore();
  app.store = s;
  const since = s.settings.calendarSince;
  const mid = app.addDays(since, 400);
  const late = app.addDays(since, 800);
  s.groups = s.groups.map(g => r1Block(g.name, [{ from: mid, mask: '1111110' }, { from: late, mask: R1_WEEK }]));
  for (const i of s.items) {
    if (i.type !== 'daily') continue;
    i.schedule = [{ from: since, mask: R1_WEEK }, { from: mid, mask: '1111101' }, { from: late, mask: R1_WEEK }];
    if (i.area === 'min') i.groupLog = [{ from: since, group: 'Движение' }, { from: app.addDays(since, 600), group: i.group }];
  }
  // ответ сначала: сторож скорости не должен разрешать неверный счёт
  const best0 = app.bestStreak();
  assert.ok(best0 > 0 && best0 >= app.dayStreak(), 'рекорд не меньше текущей серии: ' + best0);
  const best = measureMs(() => app.bestStreak());
  const day = measureMs(() => app.dayStreak());
  assert.ok(best < 50, `bestStreak с блоками: ${best.toFixed(1)} мс ≥ 50 мс`);
  assert.ok(day < 30, `dayStreak с блоками: ${day.toFixed(1)} мс ≥ 30 мс`);
});

test('Р1/19: weekPlan — план и отметки одним правилом', () => {
  setNow(2026, 9, 14, 12, 0);
  const s = freshStore();
  s.days = {};
  const since = '2026-08-31';
  s.groups = [r1Block('Школа', [{ from: since, mask: '1111100' }])];
  const a = r1Item('a', since, 'Школа', '1010101');                  // пн ср пт
  const h = r1Item('h', since, 'Школа', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  const late = r1Item('late', '2026-09-10', '', R1_WEEK);             // заведён в четверг
  const z = r1Item('z', since, 'Школа', '0000011');                  // пустая эффективная маска
  s.items = [a, h, late, z];
  const keys = [];
  for (let i = 0; i < 7; i++) keys.push(app.addDays(R1_MON, i));
  s.days[R1_MON] = { a: true, h: true };
  s.days['2026-09-08'] = { a: true };   // вторник вне плана a
  s.days['2026-09-13'] = { a: true, late: true };
  assert.deepEqual(app.weekPlan(a, keys), { planned: 3, done: 1 }, 'отметка вне плана в счёт не идёт');
  assert.deepEqual(app.weekPlan(h, keys), { planned: 7, done: 1 }, 'привычка — своя маска');
  assert.deepEqual(app.weekPlan(late, keys), { planned: 4, done: 1 }, 'дни до заведения не в плане');
  assert.deepEqual(app.weekPlan(z, keys), { planned: 0, done: 0 });
});

test('Р1/20: дни блока — отрезки с сегодняшнего дня, замена за день, схлопывание, будущее снимается', () => {
  setNow(2026, 9, 14, 12, 0);
  freshStore();
  const T = app.todayKey();
  const g = r1Block('Школа');
  assert.equal(app.setBlockDays(g, R1_WEEK), true);
  assert.deepEqual(g.days, [], '«все семь» без отрезков — и так все семь');
  assert.equal(app.setBlockDays(g, '0000000'), false, 'пустая маска — не дни');
  assert.equal(app.setBlockDays(g, 'мусор'), false);
  assert.deepEqual(g.days, []);
  app.setBlockDays(g, '1111100');
  assert.deepEqual(g.days, [{ from: T, mask: '1111100' }]);
  app.setBlockDays(g, '1010100');
  assert.deepEqual(g.days, [{ from: T, mask: '1010100' }], 'второй раз за день — замена');
  app.setBlockDays(g, R1_WEEK);
  assert.deepEqual(g.days, [], 'возврат к прежней маске схлопывает');
  app.setBlockDays(g, '1111100');
  advanceDays(7);
  const T2 = app.todayKey();
  app.setBlockDays(g, '0000011');
  assert.deepEqual(g.days, [{ from: T, mask: '1111100' }, { from: T2, mask: '0000011' }], 'прежний отрезок не тронут');
  assert.equal(app.blockMaskOn(g, app.addDays(T, -1)), R1_WEEK);
  assert.equal(app.blockMaskOn(g, T), '1111100');
  assert.equal(app.blockMaskOn(g, T2), '0000011');
  assert.equal(app.blockMaskNow(g), '0000011');
  g.days.push({ from: '2026-12-01', mask: '1000000' }); // сбитые часы
  app.setBlockDays(g, '0100000');
  assert.deepEqual(g.days, [{ from: T, mask: '1111100' }, { from: T2, mask: '0100000' }],
    'хвост «из будущего» снят, а не встал перед новым');
  assert.deepEqual(app.normBlockDays(g.days), g.days, 'setBlockDays даёт канон');
  assert.equal(app.setBlockDays(g, '1111100'), true);
  assert.deepEqual(g.days, [{ from: T, mask: '1111100' }], 'возврат к прежней маске схлопывает и через неделю');
});

/* ── Р1/рецензия: ремонт по замечаниям к доменному этапу ─────── */

/* Возврат действия, у которого не осталось бы ни одного дня. Пустая
   эффективная маска возникает без ошибки владельца: пункт убран, дни блока
   сужены (zeroDaysIn убранных не видит), пункт возвращён. Такой пункт
   возвращается «как блок» — своя маска с сегодняшнего дня «все семь»;
   отказ не годится: уход обратим всегда (инвариант 12), а возврат блока
   иначе упирался бы в пункт с нулём, пришедшим импортом, и убранный блок
   оставался бы убранным навсегда. */
test('Р1/22: возврат без единого дня — «как блок»; тот же день, позже, блоком; откат; прошлое цело', () => {
  fakeLocalStorage();
  setNow(2026, 9, 7, 12, 0); // понедельник
  const s = freshStore();
  s.items = []; s.groups = []; s.days = {};
  s.settings.calendarSince = '2026-08-31';
  assert.equal(app.addGroup('Утро'), true);
  const [run, swim, walk] = app.addActions('Утро', app.parseQuickLines('Бег\nПлавание\nПрогулка'));
  assert.equal(app.setSchedule(run, '0000011'), true);
  assert.equal(app.setSchedule(swim, '0000011'), true);
  assert.equal(app.setSchedule(walk, '1100000'), true);
  s.days['2026-09-06'] = { [run.id]: true }; // прошлое, которое не должно сдвинуться
  advanceDays(1); // вторник
  const t = app.todayKey();
  assert.equal(app.removeItem(run.id), true);
  assert.equal(app.removeItem(swim.id), true);
  assert.equal(app.removeItem(walk.id), true);
  assert.deepEqual(app.updateGroup('Утро', { mask: '1111100' }), { ok: true, name: 'Утро' },
    'убранных zeroDaysIn не видит — дни блока сужены');
  assert.equal(app.returnsWithoutDays(run), true);
  assert.equal(app.returnsWithoutDays(walk), false, 'пн и вт в днях блока есть');
  const past = () => ['2026-09-05', '2026-09-06', '2026-09-07'].map(k => JSON.stringify(app.minDayMarks(k))).join();
  const pastWas = past();

  // тот же день: та же запись, у неё меняется только сегодняшний отрезок
  let was = JSON.stringify(s);
  const core = app.restoreItemCore(run.id);
  assert.equal(core.item, run);
  assert.equal(core.asBlock, true);
  assert.equal(run.removedAt, null);
  assert.deepEqual(run.schedule, [{ from: '2026-09-07', mask: '0000011' }, { from: t, mask: R1_WEEK }]);
  assert.equal(app.effectiveMaskOn(run, t), '1111100', 'эффективные дни — дни блока');
  assert.equal(app.dueNow(run, t), true, 'вернувшийся пункт на «Сегодня» есть');
  assert.deepEqual(app.zeroDaysIn('Утро', '1111100'), [], 'пустой эффективной маски нет');
  assert.equal(past(), pastWas, 'прошлое не сдвинулось');
  core.undo();
  assert.equal(JSON.stringify(s), was, 'откат ядра — побайтово, вместе с расписанием');
  withBrokenWrite(() => { assert.equal(app.restoreItem(run.id), null); });
  assert.equal(JSON.stringify(s), was, 'отказ записи — побайтово');
  assert.equal(app.restoreItem(run.id), run);
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(s))).items[0].schedule, run.schedule, 'расписание — канон');

  // непустой пункт возвращается как был: признака нет, расписание прежнее
  const walkSched = JSON.stringify(walk.schedule);
  const cw = app.restoreItemCore(walk.id);
  assert.equal(cw.asBlock, false);
  assert.equal(JSON.stringify(walk.schedule), walkSched);
  cw.undo();

  // позже: новая запись «как блок», прежняя не тронута
  advanceDays(2); // четверг
  const t2 = app.todayKey();
  was = JSON.stringify(s);
  withBrokenWrite(() => { assert.equal(app.restoreItem(swim.id), null); });
  assert.equal(JSON.stringify(s), was, 'отказ записи — ни копии, ни полей');
  const copy = app.restoreItem(swim.id);
  assert.notEqual(copy.id, swim.id);
  assert.deepEqual(copy.schedule, [{ from: t2, mask: R1_WEEK }]);
  assert.deepEqual(swim.schedule, [{ from: '2026-09-07', mask: '0000011' }], 'прежняя запись — при своей маске');
  assert.equal(swim.removedAt, t);
  assert.equal(app.effectiveMaskOn(copy, t2), '1111100');
  assert.equal(app.weekMaskDays(copy, '2026-09-14'), 5);
  const back = app.migrate(JSON.parse(JSON.stringify(s))).items.find(i => i.id === copy.id);
  assert.deepEqual(back, copy, 'копия — канон');
  assert.equal(past(), pastWas, 'прошлое не сдвинулось');

  // неизвестный блок ничего не режет, привычке дни блока не указ
  assert.equal(app.returnsWithoutDays(r1Item('u', t, 'Нет такого', '0000011', { removedAt: t })), false);
  assert.equal(app.returnsWithoutDays(r1Item('hb', t, 'Утро', '0000011', { area: 'habit', normPerWeek: 2, removedAt: t })), false);
  assert.equal(app.returnsWithoutDays(null), false);

  // возврат БЛОКА не упирается в пункт с нулём, пришедшим импортом
  const zero = r1Item('zero', '2026-09-01', 'Утро', '0000011'); // живой, дней нет (импорт)
  s.items.push(zero);
  const zeroPast = () => { const o = []; for (let k = '2026-09-01'; k < t2; k = app.addDays(k, 1)) o.push(app.dueOn(zero, k) ? 1 : 0); return o.join(''); };
  const zp = zeroPast();
  const pastZero = past(); // пункт «из импорта» сам входит в прошлые дни — точка отсчёта после него
  assert.equal(zp, '000011000', 'выходные до сужения дней блока, после — ни одного дня');
  assert.equal(app.removeGroup('Утро'), true);
  was = JSON.stringify(s);
  withBrokenWrite(() => { assert.equal(app.restoreGroup('Утро'), false); });
  assert.equal(JSON.stringify(s), was, 'отказ записи — откат и расписаний');
  assert.equal(app.restoreGroup('Утро'), true, 'блок возвращается');
  assert.equal(zero.removedAt, null);
  assert.deepEqual(zero.schedule, [{ from: '2026-09-01', mask: '0000011' }, { from: t2, mask: R1_WEEK }]);
  assert.equal(app.dueNow(zero, t2), true, 'вернувшийся с блоком пункт виден');
  assert.equal(zeroPast(), zp, 'его прошлое — прежнее');
  assert.equal(past(), pastZero, 'и числа прошлых дней');
  clearLocalStorage();
});

/* Удаление блока с днями переписало бы прошлое: блок по имени больше не
   найдётся, и его маска перестанет резать прошлые дни его действий.
   Интерфейсный этап снял удаление целиком (п. 1.4): блок убирается, и
   убранный блок по имени находится — его дни режут прошлое, как резали.
   Предмет теста прежний: операция над блоком с днями и без дней не двигает
   ни одного прошлого числа. */
test('Р1/23: удаления блока нет — уход блока с днями и без дней прошлое не двигает', () => {
  fakeLocalStorage();
  setNow(2026, 9, 13, 12, 0);
  const s = freshStore();
  s.settings.calendarSince = '2026-06-01';
  s.groups = [r1Block('A', [{ from: '2026-07-01', mask: '1111100' }]), r1Block('B'), r1Block('C')];
  const a1 = r1Item('a1', '2026-06-01', 'A', R1_WEEK);
  const a2 = r1Item('a2', '2026-06-01', 'A', '1010101');
  const b1 = r1Item('b1', '2026-06-01', 'B', R1_WEEK);
  s.items = [a1, a2, b1];
  s.days = { '2026-07-04': { a1: true, b1: true }, '2026-07-05': { a2: true } };
  const marks = () => ['2026-07-03', '2026-07-04', '2026-07-05'].map(k => JSON.stringify(app.minDayMarks(k))).join();
  const m0 = marks();
  const was = JSON.stringify(s);
  assert.equal(app.deleteGroup, undefined, 'удаления блока нет — ни с днями, ни без');
  assert.equal(JSON.stringify(s), was, 'ничего не тронуто');
  assert.equal(app.removeGroup('A'), true, 'блок с днями убирается');
  assert.equal(app.findGroup('A').removedAt, '2026-09-13', 'и по имени находится — дни на месте');
  assert.equal(app.weekMaskDays(a1, '2026-08-31'), 5, 'прошлая неделя действия — дни блока, как были');
  assert.equal(marks(), m0, 'числа прошлых дней прежние');
  assert.equal(app.removeGroup('B'), true, 'блок «все семь» убирается так же');
  assert.equal(app.findGroup('B').removedAt, '2026-09-13');
  assert.equal(b1.group, 'B', 'пункт остаётся при своём блоке');
  assert.equal(marks(), m0, 'числа прошлых дней прежние');
  assert.equal(app.removeGroup('Нет'), false);
  clearLocalStorage();
});

/* Неизменность прошлого на ПОЛНОМ наборе операций над блоками и пунктами.
   Удаление блока снято интерфейсным этапом («Расписание 1/3», п. 1.4) и из
   набора ушло вместе с функцией; уход блока в нём был и остаётся. Случайная, но воспроизводимая
   последовательность: каждый день — отметки и несколько операций; после
   каждой операции числа всех прошедших дней, применимость и недельные дни
   прежних пунктов обязаны совпасть с тем, что было до неё. */
test('Р1/23: фаззинг — ни одна операция над блоками не двигает прошлое', () => {
  fakeLocalStorage();
  let seed = 20260913;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const pick = list => list[Math.floor(rnd() * list.length)];
  const MASKS = [R1_WEEK, '1111100', '0000011', '1010101', '0100100', '1100000', '0000001', '0000000'];
  const NAMES = ['A', 'B', 'C', 'D', 'Сирота', 'A (копия)', ''];

  setNow(2026, 7, 6, 12, 0); // понедельник
  const s = freshStore();
  s.items = []; s.groups = []; s.days = {};
  s.settings.calendarSince = '2026-07-06';
  app.addGroup('A');
  app.addGroup('B', '', '1111100');
  app.addGroup('C', '', '1010101');
  for (const g of ['A', 'B', 'C', '']) app.addActions(g, app.parseQuickLines('x1\nx2\nx3'));
  s.items.push(r1Item('orph', '2026-07-06', 'Сирота', R1_WEEK));
  s.items.push(r1Item('hab', '2026-07-06', 'A', '1010100', { area: 'habit', normPerWeek: 3 }));
  s.items.push(Object.assign(r1Item('wk', '2026-07-06', 'B', R1_WEEK, { type: 'weekly', goal: 2 }), { schedule: undefined }));
  delete s.items[s.items.length - 1].schedule;
  for (const it of s.items.slice(0, 6)) app.setSchedule(it, pick(MASKS.slice(0, 7)));

  const counts = {};
  const OPS = {
    updMask: () => app.updateGroup(pick(s.groups.map(g => g.name).concat('Нет')), { mask: pick(MASKS) }).ok,
    updName: () => app.updateGroup(pick(s.groups.map(g => g.name)), { name: pick(NAMES) }).ok,
    rename: () => app.renameGroup(pick(s.groups.map(g => g.name)), pick(NAMES)),
    remove: () => app.removeGroup(pick(s.groups.map(g => g.name))),
    restore: () => app.restoreGroup(pick(s.groups.map(g => g.name))),
    dup: () => app.duplicateGroup(pick(s.groups.map(g => g.name))) !== null,
    add: () => app.addGroup(pick(NAMES), '', pick(MASKS)),
    move: () => app.moveGroup(pick(s.groups.map(g => g.name)), pick(['up', 'down'])),
    reorder: () => app.reorderGroup(pick(s.groups.map(g => g.name)), Math.floor(rnd() * 4)),
    itemGroup: () => { const it = pick(s.items.filter(i => i.removedAt === null)); return !!it && app.setItemGroup(it, pick(NAMES)); },
    sched: () => { const it = pick(s.items.filter(i => i.type === 'daily' && i.removedAt === null)); return !!it && app.setSchedule(it, pick(MASKS)); },
    rmItem: () => { const it = pick(s.items.filter(i => i.removedAt === null)); return !!it && app.removeItem(it.id); },
    rsItem: () => { const it = pick(s.items.filter(i => i.removedAt !== null)); return !!it && app.restoreItem(it.id) !== null; },
    actions: () => app.addActions(pick(NAMES), app.parseQuickLines('n' + Math.floor(rnd() * 100))).length > 0
  };
  const picture = (t, items) => {
    const out = [];
    for (let k = '2026-07-06'; k < t; k = app.addDays(k, 1)) {
      out.push(k + JSON.stringify(app.minDayMarks(k)));
      for (const it of items) out.push(app.dueOn(it, k) ? '1' : '0');
    }
    for (let w = '2026-07-06'; app.addDays(w, 6) < t; w = app.addDays(w, 7)) {
      for (const it of items) out.push(app.weekMaskDays(it, w));
    }
    return out.join('|');
  };
  let checked = 0;
  for (let day = 0; day < 35; day++) {
    const t = app.todayKey();
    for (const it of s.items) if (it.type === 'daily' && app.dueNow(it, t) && rnd() < 0.7) app.toggleMark(t, it.id);
    for (let n = 0; n < 4; n++) {
      const name = pick(Object.keys(OPS));
      const items = s.items.slice();
      const before = picture(t, items);
      const ok = OPS[name]();
      counts[name] = counts[name] || [0, 0];
      counts[name][ok ? 0 : 1]++;
      assert.equal(picture(t, items), before, `прошлое сдвинулось: ${name} в ${t}, шаг ${day}.${n}`);
      checked++;
    }
    advanceDays(1);
  }
  assert.ok(checked >= 140, 'операций проверено: ' + checked);
  // не вакуум: уход блока и отказ в нём, смена дней и возврат действительно случались
  assert.ok(counts.remove && counts.remove[0] > 0 && counts.remove[1] > 0, 'removeGroup и убирал, и отказывал: ' + JSON.stringify(counts.remove));
  for (const k of ['updMask', 'remove', 'restore', 'itemGroup', 'sched', 'rsItem']) {
    assert.ok(counts[k] && counts[k][0] > 0, `операция ${k} хоть раз прошла: ${JSON.stringify(counts[k])}`);
  }
  clearLocalStorage();
});

/* Шаг v1→v2 переписывает item.group уже ПОСЛЕ нормализации журнала. Без
   сверки журнал называл бы прежний блок, а второй прогон дописывал бы
   запись рассогласования — migrate(migrate(x)) ≠ migrate(x). */
test('Р1/24: v1-файл с журналом принадлежности — два прогона migrate побайтово совпадают', () => {
  setNow(2026, 9, 13, 12, 0);
  const file = () => ({
    items: [
      { id: 'a', name: 'Умыться', type: 'daily', group: '', addedAt: '2026-08-01',
        groupLog: [{ from: '2026-08-01', group: 'Утро' }, { from: '2026-09-01', group: '' }] },
      { id: 'b', name: 'X', type: 'daily', group: 'Утро', addedAt: '2026-08-01' }
    ],
    groups: [{ name: 'Утро', days: [{ from: '2026-08-01', mask: '1111100' }] }],
    days: {}
  });
  const once = app.migrate(file());
  const a = once.items.find(i => i.id === 'a');
  assert.equal(a.group, 'Тело', 'шаг v1→v2 назначил блок по имени');
  assert.equal(a.groupLog[a.groupLog.length - 1].group, a.group, 'последняя запись журнала — нынешний блок');
  assert.deepEqual(a.groupLog.slice(0, 2), [{ from: '2026-08-01', group: 'Утро' }, { from: '2026-09-01', group: '' }],
    'прежние записи не тронуты');
  const json = JSON.stringify(once);
  assert.equal(JSON.stringify(app.migrate(JSON.parse(json))), json, 'второй прогон — побайтово то же');
});

/* Пункт, заведённый сегодня: свои дни, затем «все семь» («как блок») в тот
   же день. Прежде отрезок снимался и не ставился — schedule = [], форма,
   которую migrate переписывает в [{addedAt, все семь}]. */
test('Р1/25: setSchedule у заведённого сегодня — возврат к «все семь» оставляет канон', () => {
  fakeLocalStorage();
  setNow(2026, 9, 14, 12, 0);
  const s = freshStore();
  s.items = []; s.groups = [];
  const t = app.todayKey();
  app.addGroup('Школа', '', '1111100');
  const [it] = app.addActions('Школа', [{ name: 'Портфель', note: '' }]);
  assert.deepEqual(it.schedule, [{ from: t, mask: R1_WEEK }]);
  app.setSchedule(it, '1010100');
  assert.deepEqual(it.schedule, [{ from: t, mask: '1010100' }]);
  app.setSchedule(it, R1_WEEK);
  assert.deepEqual(it.schedule, [{ from: t, mask: R1_WEEK }], '«как блок» — единственный отрезок с дня заведения');
  const hab = r1Item('hab', t, '', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  s.items.push(hab);
  app.setSchedule(hab, '0000011');
  app.setSchedule(hab, R1_WEEK);
  assert.deepEqual(hab.schedule, [{ from: t, mask: R1_WEEK }], 'у привычки — то же');
  const m = app.migrate(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(m.items.map(i => i.schedule), [it.schedule, hab.schedule], 'store совпадает с migrate от себя');

  // у пункта, заведённого раньше, прежнее поведение: возврат схлопывает сегодняшний отрезок
  advanceDays(1);
  app.setSchedule(it, '0000011');
  app.setSchedule(it, R1_WEEK);
  assert.deepEqual(it.schedule, [{ from: t, mask: R1_WEEK }]);

  // ядро не пишет
  const disk = global.localStorage.getItem('minimum:data');
  assert.equal(app.scheduleCore(it, '0100000'), true);
  assert.equal(app.scheduleCore(it, '0000000'), false, 'пустая маска — не расписание');
  assert.equal(global.localStorage.getItem('minimum:data'), disk, 'ядро не пишет');
  clearLocalStorage();
});

/* ── «Расписание 1/3», этап B: чистые функции интерфейса «Настроек» ── */

test('Р1/B: daysSummary — «ежедневно», «будни», «выходные», иначе перечень; пустая маска названа', () => {
  assert.equal(app.daysSummary('1111111'), 'ежедневно');
  assert.equal(app.daysSummary('1111100'), 'будни');
  assert.equal(app.daysSummary('0000011'), 'выходные');
  assert.equal(app.daysSummary('1010100'), 'пн, ср, пт');
  assert.equal(app.daysSummary('0000001'), 'вс');
  assert.equal(app.daysSummary('1111110'), 'пн, вт, ср, чт, пт, сб', 'почти все — перечнем, не словом');
  assert.equal(app.daysSummary('0111110'), 'вт, ср, чт, пт, сб');
  assert.equal(app.daysSummary('0000000'), 'ни одного дня', 'пустая маска (импорт) не печатается пустотой');
});

test('Р1/B: groupList — только живые блоки в порядке store.groups', () => {
  setNow(2026, 9, 13, 12, 0);
  const s = freshStore();
  s.groups = [r1Block('A'), Object.assign(r1Block('B'), { removedAt: '2026-09-10' }), r1Block('C')];
  assert.deepEqual(app.groupList(), ['A', 'C'], 'убранный блок в вариантах поля «Блок» не стоит');
  s.groups[1].removedAt = null;
  assert.deepEqual(app.groupList(), ['A', 'B', 'C']);
});

/* ── «Расписание 1/3», этап C: форма правки действия ─────────────── */

test('Р1/C: mergeOwnMask — внутри дней блока выбор, вне их — своя маска как есть', () => {
  // будний блок: выходные владелец в форме выбрать не мог — их биты не теряются
  assert.equal(app.mergeOwnMask('1111111', '1101100', '1111100'), '1101111', 'снята среда, выходные целы');
  assert.equal(app.mergeOwnMask('1010100', '1111100', '1111100'), '1111100', 'выбраны все будни');
  assert.equal(app.mergeOwnMask('0000010', '1000000', '1111100'), '1000010', 'суббота своей маски пережила правку будней');
  assert.equal(app.mergeOwnMask('1111111', '0000000', '0000011'), '1111100', 'выбор пуст — вне блока своё, внутри ничего');
  // «все семь» дней блока — выбор целиком; невалидное — «все семь», как в andMask
  assert.equal(app.mergeOwnMask('0000001', '1010100', '1111111'), '1010100');
  assert.equal(app.mergeOwnMask('мусор', '1010100', '1111100'), '1010111');
  assert.equal(app.mergeOwnMask('0000011', 'x', '1111100'), '1111111');
  assert.equal(app.mergeOwnMask('0000011', '1000000', null), '1000000');
  // эффективные дни после слияния — ровно выбор в пределах блока
  for (const [own, pick, blk] of [['1111111', '1101100', '1111100'], ['0110011', '1000100', '1111100'], ['1010101', '0000010', '0000011']]) {
    assert.equal(app.andMask(app.mergeOwnMask(own, pick, blk), blk), app.andMask(pick, blk), `${own} ${pick} ${blk}`);
  }
});

test('Р1/C: тип действия — только в день заведения, отказы по сегодняшнему факту, канон migrate', () => {
  fakeLocalStorage();
  setNow(2026, 9, 14, 12, 0);
  const s = freshStore();
  s.items = []; s.groups = []; s.days = {}; s.weekLog = [];
  const t = app.todayKey();
  app.addGroup('Школа', '', '1111100');
  const [a, b] = app.addActions('Школа', app.parseQuickLines('Зал\nПланка'));

  assert.equal(app.canChangeType(a), true, 'заведено сегодня');
  const old = { id: 'old', addedAt: app.addDays(t, -1), type: 'daily', area: 'min' };
  assert.equal(app.canChangeType(old), false, 'вчерашнее — нет');
  assert.equal(app.canChangeType({ id: 'h', addedAt: t, type: 'daily', area: 'habit' }), false, 'привычка — не действие');
  assert.equal(app.canChangeType({ id: 'p', addedAt: t, type: 'param', area: 'habit' }), false);
  assert.equal(app.canChangeType(null), false);

  // daily → weekly: цель обязательна, расписание и журнал снимаются
  assert.equal(app.typeChangeRefusal(a, 'daily'), null, 'тот же тип — не смена');
  assert.equal(app.setItemType(a, 'weekly', 0), false, 'без цели счётчика нет');
  assert.equal(a.type, 'daily');
  assert.equal(app.setItemType(a, 'weekly', 3.4), true);
  assert.equal(a.type, 'weekly');
  assert.equal(a.goal, 3);
  assert.equal('schedule' in a, false);
  assert.equal('groupLog' in a, false);
  assert.equal(a.ladder, null);
  assert.equal(app.setItemType(a, 'weekly', 5), false, 'тот же тип — false, цель не тронута');
  assert.equal(a.goal, 3);
  // канон: store совпадает с migrate от себя
  let m = app.migrate(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(m.items.find(i => i.id === a.id), JSON.parse(JSON.stringify(a)), 'счётчик — в каноне');

  // weekly → daily: «все семь» с дня заведения, пустой журнал, цели нет
  assert.equal(app.setItemType(a, 'daily'), true);
  assert.deepEqual(a.schedule, [{ from: t, mask: R1_WEEK }]);
  assert.deepEqual(a.groupLog, []);
  assert.equal(a.goal, null);
  m = app.migrate(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(m.items.find(i => i.id === a.id), JSON.parse(JSON.stringify(a)), 'ежедневный — в каноне');
  assert.equal(app.effectiveMaskOn(a, t), '1111100', 'в будничном блоке — «как блок»');

  // сегодняшняя отметка держит тип ежедневного
  app.toggleMark(t, b.id);
  assert.equal(app.typeChangeRefusal(b, 'weekly'), 'Тип не меняется: пункт сегодня отмечен');
  assert.equal(app.setItemType(b, 'weekly', 3), false);
  assert.equal(b.type, 'daily');
  app.toggleMark(t, b.id);
  assert.equal(app.typeChangeRefusal(b, 'weekly'), null, 'снятая отметка отказ снимает');

  // запись счётчика держит тип недельного
  assert.equal(app.setItemType(b, 'weekly', 2), true);
  app.incTrain(b.id);
  assert.equal(app.typeChangeRefusal(b, 'daily'), 'Тип не меняется: по счётчику уже есть записи');
  assert.equal(app.setItemType(b, 'daily'), false);
  assert.equal(b.type, 'weekly');
  // чужие записи не мешают
  assert.equal(app.typeChangeRefusal(a, 'weekly'), null);

  // назавтра тип не меняется вовсе — и ничего не пишется
  advanceDays(1);
  const before = JSON.stringify(a);
  assert.equal(app.canChangeType(a), false);
  assert.equal(app.setItemType(a, 'weekly', 3), false);
  assert.equal(JSON.stringify(a), before);

  // смена типа не пишет сама: запись — у формы
  const disk = global.localStorage.getItem('minimum:data');
  setNow(2026, 9, 14, 13, 0);
  assert.equal(app.setItemType(a, 'weekly', 4), true);
  assert.equal(global.localStorage.getItem('minimum:data'), disk, 'setItemType не сохраняет');
  clearLocalStorage();
});

/* ── «Расписание 1/3»: замечания рецензии, домен (Р1/рецензия) ─────── */

test('Р1/рецензия: addGroup в осиротевшее имя — отказ, если у живого действия этого имени не останется ни одного дня', () => {
  fakeLocalStorage();
  setNow(2026, 9, 7, 12, 0);
  const s = freshStore();
  s.days = {};
  const since = '2026-08-31';
  s.groups = [r1Block('Утро')];
  // имя «Вечер» носят пункты, блока нет (импорт): осиротевшее
  s.items = [
    r1Item('Душ', since, 'Вечер', '1111100'),
    r1Item('Зубы', since, 'Вечер', R1_WEEK),
    r1Item('Ушедшее', since, 'Вечер', '1111100', { removedAt: '2026-09-03' }),
    r1Item('Привычка', since, 'Вечер', '1111100', { area: 'habit', normPerWeek: 5 })
  ];
  const before = JSON.stringify(s);
  assert.deepEqual(app.zeroDaysIn('Вечер', '0000011'), ['Душ'], 'убранное и привычка дней блока не теряют');
  assert.equal(app.addGroup('Вечер', '', '0000011'), false, 'у «Душа» будни — в выходные ему не останется ни одного дня');
  assert.equal(JSON.stringify(s), before, 'ничего не заведено и не записано');
  assert.equal(app.addGroup('Вечер', 'до 22:30', '1000011'), true, 'понедельник у «Душа» остаётся — можно');
  // v20 (Р2): блок заводится в активном режиме — здесь основном
  assert.deepEqual(app.findGroup('Вечер'), { name: 'Вечер', caption: 'до 22:30', days: [{ from: R1_MON, mask: '1000011' }], removedAt: null, mode: 'main' });
  assert.equal(app.effectiveMaskOn(s.items[0], R1_MON), '1000000');
  assert.equal(app.effectiveMaskOn(s.items[0], '2026-09-06'), '1111100', 'прошлое не двигается: дни блока — с сегодняшнего дня');
  // без дней («все семь» — нейтральный элемент ∧) осиротевшее имя берётся всегда
  s.items.push(r1Item('Сирота', since, 'Ночь', '0000001'));
  assert.equal(app.addGroup('Ночь'), true);
  clearLocalStorage();
});

test('Р1/рецензия: прежний отрезок с преемником — laterSegmentOf; «Вернуть» его второго экземпляра не заводит', () => {
  fakeLocalStorage();
  setNow(2026, 9, 14, 12, 0);
  const s = freshStore();
  s.days = {};
  const since = '2026-08-31', gone = '2026-09-10';
  s.groups = [r1Block('Школа', [], gone), r1Block('Утро')];
  s.items = [
    r1Item('a', since, 'Школа', R1_WEEK, { name: 'Звонок', removedAt: gone }),
    r1Item('h', since, 'Школа', R1_WEEK, { name: 'Чтение', area: 'habit', normPerWeek: 7, removedAt: gone })
  ];
  assert.equal(app.laterSegmentOf(s.items[0]), null, 'пока преемника нет');
  assert.equal(app.restoreGroup('Школа'), true);
  const [a, a2, h, h2] = s.items;
  assert.deepEqual([a2.name, a2.addedAt, a2.removedAt, h2.name, h2.addedAt], ['Звонок', '2026-09-14', null, 'Чтение', '2026-09-14'],
    'возврат позже дня ухода — новые записи сразу за прежними');
  assert.equal(app.laterSegmentOf(a), a2, 'у действия — преемник');
  assert.equal(app.laterSegmentOf(h), h2, 'у привычки — тоже');
  assert.equal(app.laterSegmentOf(a2), null, 'живая запись прежним отрезком не бывает');
  const n = s.items.length;
  const saved = localStorage.getItem('minimum:data');
  assert.equal(app.restoreItem('a'), null, '«Вернуть» прежнего отрезка второго экземпляра не заводит');
  assert.equal(app.restoreItemCore('h'), null, 'ядро — тоже, и у привычки');
  assert.equal(s.items.length, n);
  assert.equal(localStorage.getItem('minimum:data'), saved, 'и ничего не записано');

  // уход преемника: прячется прежний, последний отрезок — нет; возврат в тот
  // же день — полная отмена, как всегда (уводящая операция обратима)
  assert.equal(app.removeItem(a2.id), true);
  assert.equal(app.laterSegmentOf(a2), null, 'последний отрезок прятать нечем');
  assert.equal(app.laterSegmentOf(a), a2, 'прежний прячется и за убранным преемником');
  assert.equal(app.restoreItem(a2.id), a2);
  // назавтра — цепочка: у каждого прежнего есть запись позже
  assert.equal(app.removeItem(a2.id), true);
  advanceDays(2);
  const a3 = app.restoreItem(a2.id);
  assert.ok(a3 && a3 !== a2);
  assert.equal(app.laterSegmentOf(a), a2);
  assert.equal(app.laterSegmentOf(a2), a3);

  // не преемник: одноимённое дело, набранное в ДЕНЬ ухода (соседнее, а не
  // продолжение), и то же имя в другом блоке, другой области, другом типе
  const t = app.todayKey();
  const x = r1Item('x', since, 'Утро', R1_WEEK, { name: 'Кровать', removedAt: t });
  s.items.push(x,
    r1Item('x-same-day', t, 'Утро', R1_WEEK, { name: 'Кровать' }),
    r1Item('x-other-block', '2026-09-20', 'Школа', R1_WEEK, { name: 'Кровать' }),
    r1Item('x-habit', '2026-09-20', 'Утро', R1_WEEK, { name: 'Кровать', area: 'habit', normPerWeek: 7 }),
    r1Item('x-weekly', '2026-09-20', 'Утро', R1_WEEK, { name: 'Кровать', type: 'weekly', goal: 3 }));
  x.removedAt = '2026-09-12';
  assert.equal(app.laterSegmentOf(x), s.items.find(i => i.id === 'x-same-day'), 'заведённое позже дня ухода — преемник');
  x.removedAt = t;
  assert.equal(app.laterSegmentOf(x), null, 'в день ухода — соседнее дело, не продолжение; блок, область и тип — свои');
  clearLocalStorage();
});

/* ── «Расписание 1/3»: финальное ревью, домен (Р1/ревью) ──────────── */

/* Преемник прячет ровно одну прежнюю запись. Одноимённые действия в одном
   блоке законны (быстрое добавление повторы не склеивает), и прежде копия,
   заведённая возвратом первого, становилась «преемником» второго: второе
   не возвращалось и пропадало из «Убранных» без дороги назад. */
test('Р1/ревью: одноимённые действия — возврат блока возвращает все, преемник прячет одну запись', () => {
  fakeLocalStorage();
  setNow(2026, 9, 7, 12, 0);
  const s = freshStore();
  s.days = {};
  s.groups = [];
  s.items = [];
  const alive = () => s.items.filter(i => i.removedAt === null).map(i => i.name).sort();
  const unpaired = () => s.items.filter(i => i.removedAt !== null && !app.laterSegmentOf(i));

  // (1) блок: две «Вода» одним быстрым добавлением и «Другое»
  assert.equal(app.addGroup('A'), true);
  assert.equal(app.addActions('A', app.parseQuickLines('Вода\nВода\nДругое')).length, 3, 'повторы не склеиваются');
  advanceDays(1);
  assert.equal(app.removeGroup('A'), true);
  advanceDays(2);
  assert.equal(app.restoreGroup('A'), true);
  assert.deepEqual(alive(), ['Вода', 'Вода', 'Другое'], 'вернулись все три');
  const disk = JSON.parse(global.localStorage.getItem('minimum:data'));
  assert.equal(disk.items.filter(i => i.removedAt === null).length, 3, 'и записаны');
  const olds = s.items.filter(i => i.removedAt !== null);
  assert.equal(olds.length, 3);
  const pairs = olds.map(app.laterSegmentOf);
  assert.ok(pairs.every(Boolean), 'каждый прежний отрезок продолжен');
  assert.equal(new Set(pairs).size, 3, 'и у каждого — СВОЙ преемник');
  assert.deepEqual(unpaired(), [], '«Убранные» пусты: вернуть больше нечего');
  // каждая копия — сразу за своей прежней записью, и в пару взята именно она
  for (const o of olds) assert.equal(app.laterSegmentOf(o), s.items[s.items.indexOf(o) + 1]);

  // (2) поштучно: три «Чай» без блока ушли в один день; K возвратов — N − K в «Убранных»
  s.groups = [];
  s.items = [];
  const tea = app.addActions('', app.parseQuickLines('Чай\nЧай\nЧай'));
  assert.equal(tea.length, 3);
  advanceDays(1);
  for (const x of tea) assert.equal(app.removeItem(x.id), true);
  advanceDays(1);
  assert.equal(unpaired().length, 3);
  const back1 = app.restoreItem(tea[1].id); // средний: пара — своя копия, а не первый по списку
  assert.ok(back1, 'вернулся');
  assert.equal(app.laterSegmentOf(tea[1]), back1, 'копия в паре со своей прежней записью');
  assert.deepEqual(unpaired().map(x => x.id), [tea[0].id, tea[2].id], 'два других двойника остались в «Убранных»');
  const saved = global.localStorage.getItem('minimum:data');
  assert.equal(app.restoreItem(tea.find(x => app.laterSegmentOf(x)).id), null, 'прежний отрезок с парой — не возвращается');
  assert.equal(global.localStorage.getItem('minimum:data'), saved, 'и ничего не пишет');
  assert.ok(app.restoreItem(unpaired()[0].id), 'второй — возвращается');
  assert.ok(app.restoreItem(unpaired()[0].id), 'третий — тоже');
  assert.deepEqual(unpaired(), []);
  assert.deepEqual(alive(), ['Чай', 'Чай', 'Чай']);

  // (3) независимый уход: #1 убран поштучно, #2 ушёл с блоком; возврат блока
  // #1 не прячет — его копия берёт в пару #2, ушедший ближе
  setNow(2026, 9, 1, 12, 0);
  s.groups = [];
  s.items = [];
  assert.equal(app.addGroup('B'), true);
  const [w1, w2] = app.addActions('B', app.parseQuickLines('Вода\nВода'));
  advanceDays(1);
  assert.equal(app.removeItem(w1.id), true);
  advanceDays(4);
  assert.equal(app.removeGroup('B'), true);
  advanceDays(2);
  assert.equal(app.restoreGroup('B'), true);
  assert.deepEqual(alive(), ['Вода'], 'с блоком вернулся ушедший с ним');
  assert.equal(app.laterSegmentOf(w1), null, 'убранный раньше — без пары');
  assert.ok(app.laterSegmentOf(w2), 'ушедший с блоком — с парой');
  assert.deepEqual(unpaired(), [w1], '#1 стоит в «Убранных»');
  assert.ok(app.restoreItem(w1.id), 'и возвращается');
  assert.deepEqual(alive(), ['Вода', 'Вода']);

  // (4) цепочка у двойников: пары встают по дню ухода, число без пары верное
  setNow(2026, 9, 1, 12, 0);
  s.groups = [];
  s.items = [];
  const [v1, v2] = app.addActions('', app.parseQuickLines('Сок\nСок'));
  advanceDays(1);
  app.removeItem(v1.id); app.removeItem(v2.id);
  advanceDays(1);
  const v1b = app.restoreItem(v1.id);
  advanceDays(1);
  app.removeItem(v1b.id);
  advanceDays(1);
  assert.equal(unpaired().length, 2, 'v2 и ушедшая копия v1 — без пары');
  assert.ok(app.restoreItem(unpaired()[0].id));
  assert.equal(unpaired().length, 1, 'после возврата одного — один');
  assert.equal(alive().length, 1);

  // (5) двойники ушли в разные дни, возвращён ушедший раньше: в «Убранных»
  // остаётся тот, кого не возвращали, со своим днём ухода
  setNow(2026, 9, 1, 12, 0);
  s.groups = [];
  s.items = [];
  const [c1, c2] = app.addActions('', app.parseQuickLines('Морс\nМорс'));
  advanceDays(1);
  app.removeItem(c2.id);
  advanceDays(2);
  app.removeItem(c1.id);
  advanceDays(1);
  const c2b = app.restoreItem(c2.id);
  assert.ok(c2b);
  assert.equal(app.laterSegmentOf(c2), c2b);
  assert.deepEqual(unpaired(), [c1], 'не возвращённый — на месте, с днём ухода 04.09');
  assert.equal(c1.removedAt, '2026-09-04');

  // (6) пара одна на запись: две поздние записи с тем же именем берут в пару
  // две прежние, а не обе — ближайшую к себе
  setNow(2026, 9, 1, 12, 0);
  s.groups = [];
  s.items = [];
  const [e1, e2] = app.addActions('', app.parseQuickLines('Кефир\nКефир'));
  advanceDays(1);
  app.removeItem(e1.id); app.removeItem(e2.id);
  advanceDays(1);
  const [e3, e4] = app.addActions('', app.parseQuickLines('Кефир\nКефир'));
  assert.equal(app.laterSegmentOf(e2), e3);
  assert.equal(app.laterSegmentOf(e1), e4, 'вторая поздняя запись — пара второй прежней');
  assert.deepEqual(unpaired(), []);
  clearLocalStorage();
});

test('Р1/рецензия: scheduleCore снимает отрезки «из будущего» — порядок цел, после перезапуска те же маски', () => {
  fakeLocalStorage();
  setNow(2026, 9, 14, 12, 0);
  const s = freshStore();
  s.days = {};
  const since = '2026-08-31';
  s.groups = [r1Block('Утро')];
  const bed = r1Item('bed', since, 'Утро', R1_WEEK);
  s.items = [bed];
  assert.equal(app.setSchedule(bed, '0111111'), true, 'снят понедельник — с 14.09');
  assert.deepEqual(bed.schedule, [{ from: since, mask: R1_WEEK }, { from: '2026-09-14', mask: '0111111' }]);

  // логический день сдвинулся назад (граница дня, исправленные часы): 14.09 — будущее
  setNow(2026, 9, 13, 12, 0);
  assert.equal(app.setSchedule(bed, '1101111'), true, 'снята среда');
  assert.deepEqual(bed.schedule, [{ from: since, mask: R1_WEEK }, { from: '2026-09-13', mask: '1101111' }],
    'отрезок из будущего снят, новый — с сегодняшнего дня; список по возрастанию');
  // живая сессия и перезапуск (migrate сортирует отрезки) читают одно и то же
  const restarted = app.migrate(app.migrate(JSON.parse(JSON.stringify(s))));
  const bed2 = restarted.items.find(i => i.id === 'bed');
  for (let k = since; k <= '2026-11-30'; k = app.addDays(k, 1)) {
    assert.equal(app.scheduleOn(bed2, k), app.scheduleOn(bed, k), 'маска дня после перезапуска та же: ' + k);
  }
  assert.equal(app.scheduleOn(bed, '2026-09-21'), '1101111', 'последняя правка побеждает и в сессии, и после');

  // тот же сдвиг у возврата пункта в тот же день — ядро одно (restoreItemCore)
  setNow(2026, 9, 14, 12, 0);
  const g = r1Item('g', since, 'Утро', R1_WEEK, { removedAt: '2026-09-13',
    schedule: [{ from: since, mask: R1_WEEK }, { from: '2026-09-20', mask: '0000001' }] });
  s.items.push(g);
  assert.equal(app.scheduleCore(g, '1111110'), true);
  assert.deepEqual(g.schedule.map(x => x.from), [since, '2026-09-14'], 'будущий 20.09 снят, порядок цел');
  clearLocalStorage();
});

/* ── Р2: режимы, домен (задача Р2, п. 1 и 7) ─────────────────────────
   Сегодня — понедельник 14.09.2026. Основной режим — 'main'; прочие
   заводятся записями прямо в фикстуре. Хелперы — поверх r1Item/r1Block:
   форма та же, режим назван явно. */

const R2_T = '2026-09-14';
const r2Mode = (id, name, removedAt) => ({ id, name, removedAt: removedAt || null });
const r2Act = (id, since, group, mask, mode, extra) => r1Item(id, since, group, mask, Object.assign({ mode }, extra || {}));
const r2Block = (name, mode, days, removedAt, caption) => Object.assign(r1Block(name, days, removedAt, caption), { mode });
const r2Weekly = (id, since, group, goal) => ({
  id, name: id, value: null, unit: '', type: 'weekly', area: 'min', goal, note: '', group, removedAt: null,
  addedAt: since, at: '', raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
  formula: null, ladder: null, ladderLog: []
});
const r2Param = (id, since, group) => ({
  id, name: id, value: null, unit: '', type: 'param', area: 'habit', pkind: 'time', pvalue: 1380, pstep: -15,
  goal: null, note: '', group, removedAt: null, addedAt: since, at: '', raiseAfter: 0, raiseAfterWeek: null,
  lowerAfterWeek: null, history: [{ date: since, value: 1380 }], formula: null, ladder: null, ladderLog: []
});

function r2Store() {
  fakeLocalStorage();
  setNow(2026, 9, 14, 12, 0);
  const s = freshStore();
  s.items = []; s.groups = []; s.days = {};
  s.settings.calendarSince = '2026-08-17';
  return s;
}

test('Р2/1: modeOn — последний отрезок с from ≤ дня; до первого и при пустом журнале — основной; сотни отрезков совпадают с линейным проходом', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('school', 'Школа'), r2Mode('hol', 'Каникулы')];
  s.modeLog = [];
  assert.equal(app.modeOn('2020-01-01'), 'main', 'пустой журнал — основной на всю жизнь');
  assert.equal(app.activeMode(), 'main');
  s.modeLog = [{ from: '2026-09-01', mode: 'school' }, { from: '2026-09-07', mode: 'hol' },
    { from: '2026-09-10', mode: 'main' }, { from: '2026-09-12', mode: 'school' }];
  const want = {
    '2026-08-31': 'main', '2026-09-01': 'school', '2026-09-06': 'school', '2026-09-07': 'hol', '2026-09-09': 'hol',
    '2026-09-10': 'main', '2026-09-11': 'main', '2026-09-12': 'school', [R2_T]: 'school', '2030-01-01': 'school'
  };
  for (const [k, m] of Object.entries(want)) assert.equal(app.modeOn(k), m, k);
  assert.equal(app.activeMode(), 'school', 'активный — режим сегодняшнего дня');
  assert.equal(app.modeOn('2026-09-08', [{ from: '2026-09-08', mode: 'hol' }]), 'hol', 'журнал можно передать явно (migrate)');
  assert.equal(app.modeOn('2026-09-07', [{ from: '2026-09-08', mode: 'hol' }]), 'main');

  const ids = ['main', 'school', 'hol'];
  const log = [];
  let k = '2024-01-01';
  for (let i = 0; i < 400; i++) {
    k = app.addDays(k, 1 + (i * 7) % 4);
    const prev = log.length ? log[log.length - 1].mode : 'main';
    log.push({ from: k, mode: ids[(ids.indexOf(prev) + 1 + i % 2) % 3] });
  }
  s.modeLog = log;
  assert.deepEqual(app.normModeLog(log, s.modes), log, 'журнал фикстуры канонический');
  const linear = day => { let m = 'main'; for (const x of log) if (x.from <= day) m = x.mode; return m; };
  for (let d = '2023-12-25'; d <= app.addDays(k, 3); d = app.addDays(d, 1)) assert.equal(app.modeOn(d), linear(d), d);
  clearLocalStorage();
});

test('Р2/1: normModes и normModeLog — основной есть всегда, мусор и дубли роняются, ссылка дубля имени ведёт к одноимённому; идемпотентно', () => {
  setNow(2026, 9, 14, 12, 0);
  assert.deepEqual(app.normModes(undefined).modes, [r2Mode('main', 'Основной')]);
  assert.deepEqual(app.normModes('мусор').modes, [r2Mode('main', 'Основной')]);
  const n = app.normModes([
    { id: 'b', name: ' Школа ' },
    { id: 'main', name: 'Главный', removedAt: '2026-09-01' },
    { id: 'b', name: 'Другое' },   // дубль id
    { id: 'c', name: 'Школа' },    // дубль имени
    { id: '', name: 'Пусто' }, null, [], { id: 'd', name: '   ' }, { id: 7, name: 'Число' },
    { id: 'e', name: 'Лето', removedAt: 'не дата' }
  ]);
  assert.deepEqual(n.modes, [r2Mode('b', 'Школа'), r2Mode('main', 'Главный', '2026-09-01'), r2Mode('e', 'Лето')],
    'основной на своём месте; имя с trim; мусорный день ухода — null');
  assert.equal(n.resolve('b'), 'b');
  assert.equal(n.resolve('c'), 'b', 'дубль имени — туда, где владелец видел записи');
  assert.equal(n.resolve('d'), 'main', 'отброшенный мусор — в основной');
  assert.equal(n.resolve(undefined), 'main');
  assert.equal(n.known('zzz'), 'zzz', 'known неизвестное не подменяет — журнал его уронит');
  assert.deepEqual(app.normModes(n.modes).modes, n.modes, 'повторный прогон ничего не меняет');
  assert.equal(app.normModes([{ id: 'x', name: 'Основной' }]).resolve('x'), 'main', 'имя основного занимается первым');

  const ids = ['main', 'b', 'e'];
  const log = app.normModeLog([
    { from: '2026-09-05', mode: 'b' },
    { from: '2026-09-01', mode: 'main' },   // ведущий основной — до первого и так основной
    { from: 'не дата', mode: 'b' },
    { from: '2026-09-07', mode: 'zzz' },    // неизвестный режим
    { from: '2026-09-08', mode: 'b' },      // тот же режим продолжается
    { from: '2026-09-10', mode: 'e' },
    { from: '2026-09-10', mode: 'main' },   // один день — один отрезок, побеждает последний
    null, 'строка', { from: '2026-09-12' }
  ], ids);
  assert.deepEqual(log, [{ from: '2026-09-05', mode: 'b' }, { from: '2026-09-10', mode: 'main' }]);
  assert.deepEqual(app.normModeLog(log, ids), log, 'идемпотентно');
  assert.deepEqual(app.normModeLog(log, n.modes), log, 'режимы можно передать записями');
  assert.deepEqual(app.normModeLog('мусор', ids), []);
  assert.deepEqual(app.normModeLog([{ from: '2026-09-05', mode: 'b' }, { from: '2026-09-05', mode: 'main' }], ids), [],
    'замена в тот же день основным — пустой журнал');
});

test('Р2/1: setActiveMode — отрезок с сегодняшнего дня по правилам setSchedule; только живой режим; одна запись, откат', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('school', 'Школа'), r2Mode('old', 'Старый', '2026-09-01')];
  const disk = () => JSON.parse(global.localStorage.getItem('minimum:data'));
  const canon = () => assert.deepEqual(app.normModeLog(s.modeLog, s.modes), s.modeLog, 'журнал в каноне');

  assert.deepEqual(app.setActiveMode('school'), { ok: true });
  assert.deepEqual(s.modeLog, [{ from: R2_T, mode: 'school' }]);
  assert.deepEqual(disk().modeLog, s.modeLog, 'записано');
  assert.equal(app.activeMode(), 'school');
  canon();
  assert.deepEqual(app.setActiveMode('school'), { ok: true }, 'повторный выбор того же — не ошибка');
  assert.deepEqual(s.modeLog, [{ from: R2_T, mode: 'school' }], 'и не второй отрезок');
  assert.deepEqual(app.setActiveMode('main'), { ok: true });
  assert.deepEqual(s.modeLog, [], 'возврат к прежнему в тот же день схлопывает');
  canon();

  assert.deepEqual(app.setActiveMode('old'), { ok: false, reason: 'removed' }, 'убранный не выбирается');
  assert.deepEqual(app.setActiveMode('nope'), { ok: false, reason: 'missing' });
  assert.deepEqual(s.modeLog, []);

  s.modeLog = [{ from: '2026-09-01', mode: 'school' }];
  assert.deepEqual(app.setActiveMode('main'), { ok: true });
  assert.deepEqual(s.modeLog, [{ from: '2026-09-01', mode: 'school' }, { from: R2_T, mode: 'main' }], 'прежний отрезок не тронут');
  canon();
  assert.deepEqual(app.setActiveMode('school'), { ok: true });
  assert.deepEqual(s.modeLog, [{ from: '2026-09-01', mode: 'school' }], 'в тот же день назад к прежнему — отрезок схлопнут');
  s.modeLog = [{ from: '2026-09-01', mode: 'school' }, { from: '2026-09-20', mode: 'main' }];
  assert.deepEqual(app.setActiveMode('main'), { ok: true });
  assert.deepEqual(s.modeLog, [{ from: '2026-09-01', mode: 'school' }, { from: R2_T, mode: 'main' }],
    'отрезок 20.09 из будущего снят, новый — с сегодняшнего; порядок по возрастанию');
  canon();

  const before = JSON.stringify(s.modeLog);
  withBrokenWrite(() => { assert.deepEqual(app.setActiveMode('school'), { ok: false, reason: 'storage' }); });
  assert.equal(JSON.stringify(s.modeLog), before, 'откат журнала');
  assert.equal(app.activeMode(), 'main');
  clearLocalStorage();
});

test('Р2/1: переключение режима сегодня не меняет вчера — minDayMarks, dayScore, цепь, серия, рекорд, точка «вчера»; dueOn с режимом', () => {
  const s = r2Store();
  const since = '2026-08-17';
  s.modes = [r2Mode('main', 'Основной'), r2Mode('school', 'Школа')];
  s.groups = [r2Block('Утро', 'main'), r2Block('Утро', 'school', [{ from: since, mask: '1111100' }]), r2Block('Учёба', 'school')];
  const a1 = r2Act('a1', since, 'Утро', R1_WEEK, 'main');
  const a2 = r2Act('a2', since, '', R1_WEEK, 'main');
  const b1 = r2Act('b1', since, 'Утро', R1_WEEK, 'school');
  const b2 = r2Act('b2', since, 'Учёба', '1010100', 'school');
  const h = r1Item('h', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 5 });
  s.items = [a1, a2, b1, b2, h];
  s.modeLog = [{ from: '2026-08-31', mode: 'school' }, { from: '2026-09-07', mode: 'main' }];

  assert.equal(app.dueOn(a1, '2026-08-28'), true, 'пятница основного');
  assert.equal(app.dueOn(b1, '2026-08-28'), false, 'действие школы в день основного — не в плане');
  assert.equal(app.dueOn(a1, '2026-09-02'), false, 'действие основного в неделю школы — не в плане');
  assert.equal(app.dueOn(b1, '2026-09-02'), true, 'имя блока — в режиме действия: будни «Утра» школы');
  assert.equal(app.dueOn(b1, '2026-09-05'), false, 'суббота вне дней блока школы');
  assert.equal(app.dueOn(b2, '2026-09-04'), true, 'своя маска пн, ср, пт');
  assert.equal(app.dueOn(h, '2026-09-02'), true, 'привычка глобальна');
  assert.equal(app.dueOn(h, '2026-08-28'), true);
  assert.equal(app.effectiveMaskOn(a1, '2026-09-02'), '0000000');
  assert.equal(app.dayScore('2026-09-05'), null, 'суббота школы: запланированного нет — день нейтрален');
  for (let k = since; k <= '2026-09-20'; k = app.addDays(k, 1)) {
    for (const it of s.items) {
      assert.equal(app.effectiveMaskOn(it, k)[app.weekdayOf(k)] === '1', app.inEffectiveDays(it, k), `горячий путь совпадает: ${it.id} ${k}`);
    }
  }

  let n = 0;
  for (let k = since; k < R2_T; k = app.addDays(k, 1), n++) {
    const due = [a1, a2, b1, b2].filter(it => app.dueOn(it, k));
    let marked = n % 6 === 2 ? due.slice(0, 1) : due;
    if (n % 9 === 4) marked = [];
    const day = {};
    for (const it of marked) day[it.id] = true;
    if (n % 2 === 0) day.h = true;
    if (Object.keys(day).length) s.days[k] = day;
  }
  (s.days['2026-09-08'] || (s.days['2026-09-08'] = {})).b1 = true; // вне плана: в числах не участвует
  delete s.days['2026-09-13'].a1;

  const yesterday = app.addDays(R2_T, -1);
  const picture = () => {
    const days = [];
    for (let k = since; k <= yesterday; k = app.addDays(k, 1)) {
      const x = app.minDayMarks(k);
      days.push(`${k} ${x.done}/${x.total} ${app.dayScore(k)} ${app.minDayClosed(k)}`);
    }
    return {
      days,
      chain: app.chainWeeks(8).map(w => [0, 1, 2, 3, 4, 5, 6].map(i => app.addDays(w, i)).filter(k => k < R2_T).map(app.dayScore)),
      streak: app.dayStreak(),
      best: app.bestStreak(),
      dots: s.items.map(it => app.missedYesterday(it, R2_T)),
      marks: s.items.map(it => app.marksInSystem(it))
    };
  };
  const before = picture();
  assert.ok(before.best > 0, 'рекорд не пуст: ' + before.best);
  assert.deepEqual(before.dots.slice(0, 4), [true, false, false, false], 'вчера (вс, основной) a1 пропущен; у действий школы вчера плана не было');
  assert.deepEqual(app.minDayItems(R2_T).map(i => i.id), ['a1', 'a2']);

  assert.equal(app.setActiveMode('school').ok, true);
  assert.deepEqual(app.minDayItems(R2_T).map(i => i.id), ['b1', 'b2'], 'сегодня — действия школы');
  assert.deepEqual(picture(), before, 'прошлое то же до последней ячейки');
  assert.equal(app.markYesterday('b1'), false, 'вчера у действия школы плана не было');
  assert.equal(app.setActiveMode('main').ok, true);
  assert.deepEqual(picture(), before);
  assert.deepEqual(app.minDayItems(R2_T).map(i => i.id), ['a1', 'a2']);
  clearLocalStorage();
});

test('Р2/1: неделя чужого режима — дни плана 0, guard m = 0 держит повышение и понижение; частичная неделя считает только свои дни', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('school', 'Школа')];
  const since = '2026-08-17';
  const x = r2Act('x', since, '', R1_WEEK, 'main', { value: 5, unit: 'мин' });
  const y = r2Act('y', since, '', R1_WEEK, 'main');
  s.items = [x, y];
  for (let k = since; k < R2_T; k = app.addDays(k, 1)) s.days[k] = { x: true };
  s.days['2026-08-19'].y = true; // y начат и больше не отмечался
  assert.deepEqual(app.closedWeeks(3), ['2026-08-24', '2026-08-31', '2026-09-07']);

  assert.equal(app.raiseEligible(x), true, 'контроль: без режимов x готов к повышению');
  assert.equal(app.lowerEligible(y), true, 'и y — к понижению');

  s.modeLog = [{ from: '2026-08-31', mode: 'school' }, { from: '2026-09-07', mode: 'main' }];
  assert.equal(app.weekMaskDays(x, '2026-08-31'), 0, 'неделя целиком в другом режиме — дней плана 0');
  assert.equal(app.planWeekCount(x, '2026-08-31'), 0, 'отметки в днях чужого режима в числитель не идут');
  for (let k = '2026-08-31'; k <= '2026-09-06'; k = app.addDays(k, 1)) assert.equal(app.dueOn(x, k), false, k);
  assert.equal(app.dueOn(x, '2026-09-07'), true);
  assert.equal(app.raiseEligible(x), false, 'неделя без дней плана — не «держится»');
  assert.equal(app.lowerEligible(y), false, 'и не «не держится»');
  assert.deepEqual(s.days['2026-09-02'], { x: true }, 'отметки на месте');

  s.modeLog = [{ from: '2026-09-03', mode: 'school' }, { from: '2026-09-05', mode: 'main' }];
  assert.equal(app.weekMaskDays(x, '2026-08-31'), 5, 'два дня чужого режима');
  assert.equal(app.planWeekCount(x, '2026-08-31'), 5);
  assert.equal(app.raiseEligible(x), true, '5 из 5 ≥ ceil(6/7·5)');
  assert.equal(app.lowerEligible(y), true, '0 ≤ floor(3/7·5)');
  assert.deepEqual(app.weekPlan(x, ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']), { planned: 2, done: 2 },
    'сетка разбора — тем же правилом');
  clearLocalStorage();
});

test('Р2/1: addMode — пустой и копия: блоки и живые действия новыми записями с сегодняшнего дня; привычки, параметры и счётчики не копируются; копия ≡ migrate; откат', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Другой')];
  const since = '2026-08-31';
  s.groups = [
    r2Block('Утро', 'main', [{ from: '2026-09-07', mask: '1111100' }], null, '7:00'),
    r2Block('Вечер', 'main', [], '2026-09-10'),
    r2Block('Утро', 'x', [], null, 'чужая подпись'),
    r2Block('Школа', 'main')
  ];
  const a = r2Act('a', since, 'Утро', '1010100', 'main', {
    value: 5, unit: 'мин', note: 'вслух', at: '07:10', raiseAfterWeek: '2026-09-07',
    history: [{ date: since, value: 3 }, { date: '2026-09-03', value: 5 }],
    groupLog: [{ from: since, group: 'Школа' }, { from: '2026-09-07', group: 'Утро' }]
  });
  const loose = r2Act('loose', since, '', R1_WEEK, 'main', { note: 'без блока' });
  const gone = r2Act('gone', since, 'Утро', R1_WEEK, 'main', { removedAt: '2026-09-10' });
  const sch = r2Act('sch', since, 'Школа', R1_WEEK, 'main');
  const other = r2Act('other', since, 'Утро', R1_WEEK, 'x');
  const hab = r1Item('hab', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  s.items = [a, hab, r2Weekly('w', since, 'Утро', 3), loose, gone, r2Param('par', since, 'Утро'), sch, other];
  s.days = { '2026-09-10': { a: true, w: true } };

  assert.deepEqual(app.addMode('  '), { ok: false, reason: 'empty' });
  assert.deepEqual(app.addMode(' Основной '), { ok: false, reason: 'taken' });
  assert.deepEqual(app.addMode('Лето', { copyOf: 'nope' }), { ok: false, reason: 'missing' });
  assert.equal(s.modes.length, 2, 'отказы ничего не заводят');

  const e = app.addMode(' Лето ');
  assert.equal(e.ok, true);
  assert.deepEqual(s.modes[2], r2Mode(e.id, 'Лето'));
  assert.ok(e.id && e.id !== 'main' && e.id !== 'x', 'новый id');
  assert.deepEqual([s.groups.length, s.items.length], [4, 8], 'пустой режим — только запись в списке');
  assert.equal(app.activeMode(), 'main', 'новый режим не становится активным сам');
  assert.deepEqual(s.modeLog, []);
  assert.deepEqual(app.addMode('Лето'), { ok: false, reason: 'taken' });
  assert.deepEqual(JSON.parse(global.localStorage.getItem('minimum:data')).modes, s.modes, 'записано');

  const c = app.addMode('Школа летом', { copyOf: 'main' });
  assert.equal(c.ok, true);
  const blocks = s.groups.filter(g => g.mode === c.id);
  assert.deepEqual(blocks, [
    { name: 'Утро', caption: '7:00', days: [{ from: R2_T, mask: '1111100' }], removedAt: null, mode: c.id },
    { name: 'Школа', caption: '', days: [], removedAt: null, mode: c.id }
  ], 'живые блоки источника в его порядке, дни на сегодня одним отрезком; убранный и чужой не копируются');
  const copies = s.items.filter(i => i.mode === c.id);
  assert.deepEqual(copies.map(i => i.name), ['a', 'loose', 'sch'], 'живые действия режима — и в блоках, и без блока');
  assert.ok(copies.every(i => !['a', 'loose', 'sch'].includes(i.id)), 'новые id');
  const [ca, cl] = copies;
  assert.deepEqual([ca.addedAt, ca.group, ca.value, ca.unit, ca.note, ca.at, ca.raiseAfterWeek, ca.removedAt, ca.type, ca.area],
    [R2_T, 'Утро', 5, 'мин', 'вслух', '07:10', null, null, 'daily', 'min']);
  assert.deepEqual(ca.schedule, [{ from: R2_T, mask: '1010100' }], 'своя маска на сегодня');
  assert.deepEqual(ca.groupLog, [], 'прошлого у копии нет');
  assert.deepEqual(ca.history, [{ date: R2_T, value: 5 }], 'одна стартовая запись');
  assert.deepEqual([cl.group, cl.note, cl.history], ['', 'без блока', []]);
  assert.equal(s.items.filter(i => i.type === 'weekly').length, 1, 'счётчик не копируется');
  assert.equal(s.items.filter(i => i.area === 'habit').length, 2, 'привычка и параметр не копируются');
  assert.deepEqual(s.days, { '2026-09-10': { a: true, w: true } }, 'отметки при прежних записях');

  const m = app.migrate(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(m.modes, s.modes);
  assert.deepEqual(m.groups.filter(g => g.mode === c.id), blocks, 'блоки-копии — канон');
  for (const x of copies) assert.deepEqual(m.items.find(i => i.id === x.id), x, 'копия ≡ migrate(копия): ' + x.name);

  assert.equal(app.dueNow(ca), false, 'сегодня действует основной');
  assert.equal(app.setActiveMode(c.id).ok, true);
  assert.equal(app.dueNow(ca), true);
  assert.equal(app.effectiveMaskOn(ca, R2_T), '1010100');
  assert.equal(app.dueNow(a), false, 'источник — в днях своего режима');
  assert.equal(app.findGroup('Утро'), blocks[0], 'поиск по умолчанию — в активном режиме');

  const before = JSON.stringify(s);
  withBrokenWrite(() => { assert.deepEqual(app.addMode('Зима', { copyOf: 'main' }), { ok: false, reason: 'storage' }); });
  assert.equal(JSON.stringify(s), before, 'ни режима, ни блоков, ни действий');
  clearLocalStorage();
});

test('Р2/1: renameMode, removeMode, restoreMode — активный не убирается, убранный не выбирается и держит имя; прошлое читается режимом того дня', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('school', 'Школа')];
  const since = '2026-08-17';
  s.groups = [r2Block('Утро', 'school', [{ from: since, mask: '1111100' }])];
  const b = r2Act('b', since, 'Утро', R1_WEEK, 'school');
  s.items = [b];
  s.modeLog = [{ from: '2026-08-31', mode: 'school' }, { from: '2026-09-07', mode: 'main' }];
  const snap = () => JSON.stringify([s.groups, s.items, s.modeLog, s.days]);
  const was = snap();

  assert.deepEqual(app.removeMode('main'), { ok: false, reason: 'active' }, 'активный убрать нельзя');
  assert.deepEqual(app.removeMode('nope'), { ok: false, reason: 'missing' });
  assert.deepEqual(app.removeMode('school'), { ok: true });
  assert.equal(s.modes[1].removedAt, R2_T);
  assert.equal(snap(), was, 'отрезки, блоки и действия не тронуты');
  assert.equal(app.modeOn('2026-09-02'), 'school', 'прошлые дни — режимом того дня');
  assert.equal(app.dueOn(b, '2026-09-02'), true, 'и действия того режима в них запланированы');
  assert.deepEqual(app.removeMode('school'), { ok: false, reason: 'removed' });
  assert.deepEqual(app.setActiveMode('school'), { ok: false, reason: 'removed' });
  assert.deepEqual(app.addMode('Школа'), { ok: false, reason: 'taken' }, 'имя убранного занято');
  assert.deepEqual(app.renameMode('main', ' Школа '), { ok: false, reason: 'taken' });
  assert.equal(app.modeNameTaken('Школа'), true);
  assert.equal(app.modeNameTaken('Школа', 'school'), false, 'своё имя себе не помеха');
  assert.deepEqual(app.liveModes().map(m => m.id), ['main']);

  assert.deepEqual(app.restoreMode('school'), { ok: true });
  assert.equal(s.modes[1].removedAt, null);
  assert.deepEqual(app.restoreMode('school'), { ok: false, reason: 'live' });
  assert.deepEqual(app.restoreMode('nope'), { ok: false, reason: 'missing' });
  assert.deepEqual(app.setActiveMode('school'), { ok: true });
  assert.deepEqual(app.removeMode('school'), { ok: false, reason: 'active' });
  assert.deepEqual(app.removeMode('main'), { ok: true }, 'неактивный основной убирается так же');
  assert.equal(app.modeOn('2026-08-20'), 'main', 'до первого отрезка — по-прежнему основной');

  assert.deepEqual(app.renameMode('school', '  '), { ok: false, reason: 'empty' });
  assert.deepEqual(app.renameMode('nope', 'X'), { ok: false, reason: 'missing' });
  assert.deepEqual(app.renameMode('school', ' Учёба '), { ok: true });
  assert.equal(s.modes[1].name, 'Учёба');
  assert.deepEqual(app.renameMode('school', 'Учёба'), { ok: true }, 'то же имя — законно');
  assert.equal(JSON.parse(global.localStorage.getItem('minimum:data')).modes[1].name, 'Учёба', 'записано');

  const m0 = JSON.stringify(s.modes);
  withBrokenWrite(() => {
    assert.deepEqual(app.renameMode('school', 'Зима'), { ok: false, reason: 'storage' });
    assert.deepEqual(app.restoreMode('main'), { ok: false, reason: 'storage' });
  });
  assert.equal(JSON.stringify(s.modes), m0, 'откат имени и дня ухода');
  assert.deepEqual(app.restoreMode('main'), { ok: true });
  assert.deepEqual(app.setActiveMode('main'), { ok: true });
  const m1 = JSON.stringify(s.modes);
  withBrokenWrite(() => { assert.deepEqual(app.removeMode('school'), { ok: false, reason: 'storage' }); });
  assert.equal(JSON.stringify(s.modes), m1);
  clearLocalStorage();
});

test('Р2/1: имя блока уникально в пределах режима; одноимённые блоки разных режимов друг на друга не влияют', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Другой')];
  const since = '2026-08-31';
  assert.equal(app.addGroup('Утро', '7:00', '1111100'), true, 'в активном режиме');
  assert.equal(app.addGroup('Утро', '', undefined, 'x'), true, 'то же имя в другом режиме — законно');
  assert.equal(app.addGroup('Утро'), false, 'в своём режиме имя занято');
  assert.equal(app.addGroup('Утро', '', undefined, 'x'), false);
  const [gm, gx] = s.groups;
  assert.deepEqual([gm.mode, gx.mode, gm.caption, gx.caption], ['main', 'x', '7:00', '']);
  assert.equal(app.findGroup('Утро'), gm, 'по умолчанию — активный режим');
  assert.equal(app.findGroup('Утро', 'x'), gx);
  assert.equal(app.findGroup('Утро', 'nope'), null);
  assert.deepEqual(app.liveGroups(), [gm]);
  assert.deepEqual(app.liveGroups('x'), [gx]);

  const am = r2Act('am', since, 'Утро', R1_WEEK, 'main', { groupLog: [{ from: since, group: 'Былое' }, { from: '2026-09-07', group: 'Утро' }] });
  const ax = r2Act('ax', since, 'Утро', '1100000', 'x', { groupLog: [{ from: since, group: 'Былое' }, { from: '2026-09-07', group: 'Утро' }] });
  const om = r2Act('om', since, 'Сирота', R1_WEEK, 'main');
  const hp = r1Item('hp', since, 'Привычное', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  s.items = [am, ax, om, hp];

  assert.equal(app.nameTaken('Сирота'), true, 'осиротевшее имя действия занято в его режиме');
  assert.equal(app.nameTaken('Сирота', undefined, 'x'), false, 'и свободно в другом');
  assert.equal(app.nameTaken('Былое', undefined, 'x'), true, 'имя из журнала — в режиме действия');
  assert.equal(app.nameTaken('Привычное'), false, 'глобальный пункт имя не занимает: дни блока его не режут');
  assert.equal(app.addGroup('Сирота', '', undefined, 'x'), true);

  assert.deepEqual(app.zeroDaysIn('Утро', '0000011'), []);
  assert.deepEqual(app.zeroDaysIn('Утро', '0000011', 'x'), ['ax']);
  assert.deepEqual(app.updateGroup('Утро', { mask: '0000011' }, 'x'), { ok: false, reason: 'zero', names: ['ax'] });
  assert.deepEqual(app.updateGroup('Утро', { mask: '0000011' }), { ok: true, name: 'Утро' }, 'действие другого режима правке не мешает');
  assert.deepEqual(gm.days, [{ from: R2_T, mask: '0000011' }]);
  assert.deepEqual(gx.days, [], 'одноимённый блок другого режима не тронут');

  assert.deepEqual(app.updateGroup('Утро', { name: 'Сирота' }), { ok: false, reason: 'taken' });
  assert.equal(app.renameGroup('Утро', 'Рассвет'), true);
  assert.deepEqual([am.group, am.groupLog[0].group, am.groupLog[1].group], ['Рассвет', 'Былое', 'Рассвет']);
  assert.deepEqual([ax.group, ax.groupLog[1].group, gx.name], ['Утро', 'Утро', 'Утро'], 'другой режим — при своём имени');
  assert.equal(app.findGroup(app.groupOn(ax, '2026-09-08'), 'x'), gx, 'прошлое ax находит свой блок');
  assert.equal(app.renameGroup('Утро', 'Рассвет', 'x'), true, 'имя, занятое в другом режиме, свободно в этом');
  assert.deepEqual([gm.name, gx.name, ax.group, ax.groupLog[1].group], ['Рассвет', 'Рассвет', 'Рассвет', 'Рассвет']);

  assert.equal(app.removeGroup('Рассвет'), true);
  assert.deepEqual([gm.removedAt, gx.removedAt, am.removedAt, ax.removedAt], [R2_T, null, R2_T, null], 'уход — в режиме блока');
  assert.match(app.groupJoinRefusal('Рассвет'), /убран/);
  assert.equal(app.groupJoinRefusal('Рассвет', 'x'), null, 'в другом режиме блок живой');
  assert.equal(app.addGroup('Рассвет'), false, 'имя убранного блока занято в его режиме');

  assert.equal(app.duplicateGroup('Рассвет', 'x'), 'Рассвет (копия)');
  const gi = s.groups.indexOf(gx);
  assert.deepEqual([s.groups[gi + 1].name, s.groups[gi + 1].mode], ['Рассвет (копия)', 'x'], 'копия — за источником, в его режиме');
  assert.deepEqual(s.items.filter(i => i.group === 'Рассвет (копия)').map(i => [i.name, i.mode]), [['ax', 'x']]);
  clearLocalStorage();
});

test('Р2/1: порядок и раскладка — в области режима (moveGroup, reorderGroup, groupedItems, moveItem, canMoveItem, reorderItem); преемник и возврат — в режиме действия', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Другой')];
  const since = '2026-08-31';
  s.groups = [r2Block('A', 'main'), r2Block('C', 'x'), r2Block('B', 'main'), r2Block('R', 'main', [], '2026-09-10'),
    r2Block('D', 'x'), r2Block('E', 'main')];
  const names = () => s.groups.map(g => g.name).join('');
  assert.equal(app.moveGroup('A', 'down'), true);
  assert.equal(names(), 'BCARDE', 'соседи — живые блоки своего режима: C другого режима на месте');
  assert.equal(app.moveGroup('A', 'down'), true);
  assert.equal(names(), 'BCERDA', 'убранный R перепрыгнут и остался на месте');
  assert.equal(app.moveGroup('A', 'down'), false, 'последний живой блок режима');
  assert.equal(app.moveGroup('C', 'up', 'x'), false);
  assert.equal(app.moveGroup('C', 'down', 'x'), true);
  assert.equal(names(), 'BDERCA');
  assert.equal(app.moveGroup('D', 'down'), false, 'блок другого режима в активном не ищется');
  assert.deepEqual(app.liveGroupIndexes('x'), [1, 4]);
  assert.equal(app.reorderGroup('A', 0), true);
  assert.equal(names(), 'ADBRCE');
  assert.equal(app.reorderGroup('C', 0, 'x'), true);
  assert.equal(names(), 'ACBRDE');
  assert.equal(app.reorderGroup('R', 0), false, 'убранный не перетаскивается');
  assert.equal(app.reorderGroup('C', 1), false, 'C в активном режиме не ищется');

  const m1 = r2Act('m1', since, 'A', R1_WEEK, 'main');
  const x1 = r2Act('x1', since, 'A', R1_WEEK, 'x');
  const m2 = r2Act('m2', since, 'A', R1_WEEK, 'main');
  const xc = r2Act('xc', since, 'C', R1_WEEK, 'x');
  const h = r1Item('h', since, 'C', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  s.items = [m1, x1, m2, r2Weekly('w', since, 'A', 2), xc, h];
  const lay = mode => app.groupedItems(s.items, mode)
    .map(sec => (sec.group ? sec.group.name : '—') + ':' + sec.items.map(i => i.id).join(','));
  assert.deepEqual(lay(), ['A:m1,m2,w', '—:x1,xc,h'], 'действие другого режима под одноимённым блоком не встаёт; глобальные — по имени');
  assert.deepEqual(lay('x'), ['C:xc,h', '—:m1,x1,m2,w']);

  assert.equal(app.moveItem('m1', 'down'), true);
  assert.deepEqual(s.items.map(i => i.id), ['m2', 'x1', 'm1', 'w', 'xc', 'h'], 'x1 другого режима перепрыгнут и остался на месте');
  assert.equal(app.canMoveItem('x1', 'up'), false);
  assert.equal(app.canMoveItem('x1', 'down'), false, 'у x1 соседей в его режиме нет');
  assert.equal(app.canMoveItem('m1', 'down'), true, 'счётчик — сосед по карточке активного режима');
  assert.equal(app.reorderItem('m1', 0), true);
  assert.deepEqual(s.items.map(i => i.id), ['m1', 'x1', 'm2', 'w', 'xc', 'h']);

  const old = r2Act('old', since, 'A', R1_WEEK, 'main', { name: 'Вода', removedAt: '2026-09-10' });
  const later = r2Act('later', '2026-09-12', 'A', R1_WEEK, 'x', { name: 'Вода' });
  s.items.push(old, later);
  assert.equal(app.laterSegmentOf(old), null, 'одноимённое дело в одноимённом блоке другого режима — соседнее, не продолжение');
  const back = app.restoreItem('old');
  assert.ok(back, 'возврат не отказывает');
  assert.deepEqual([back.mode, back.addedAt, back.name, back.groupLog], ['main', R2_T, 'Вода', []], 'новая запись — в режиме прежней');
  assert.equal(app.laterSegmentOf(old), back);
  clearLocalStorage();
});

test('Р2/1: глобальные пункты при уходе, возврате и переименовании одноимённых блоков в двух режимах', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Другой'), r2Mode('y', 'Третий', '2026-09-01')];
  const since = '2026-08-31';
  s.groups = [r2Block('Утро', 'main'), r2Block('Утро', 'x')];
  s.items = [
    r2Act('am', since, 'Утро', R1_WEEK, 'main'),
    r2Act('ax', since, 'Утро', R1_WEEK, 'x'),
    r1Item('h', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7 }),
    r2Weekly('w', since, 'Утро', 2),
    r2Param('p', since, 'Утро')
  ];
  const alive = () => s.items.filter(app.live).map(i => i.name).sort().join(' ');
  const gone = () => s.items.filter(i => !app.live(i)).map(i => i.name + '@' + i.removedAt).sort().join(' ');

  assert.equal(app.removeGroup('Утро'), true);
  assert.equal(alive(), 'ax h p w', 'одноимённый блок жив в другом режиме — глобальные остаются при нём');
  assert.equal(app.restoreGroup('Утро'), true, 'в тот же день — полная отмена');
  assert.equal(alive(), 'am ax h p w');
  assert.equal(s.items.length, 5, 'новых записей нет');

  assert.equal(app.removeGroup('Утро', 'x'), true);
  assert.equal(alive(), 'am h p w');
  advanceDays(1); // 15.09
  assert.equal(app.removeGroup('Утро'), true, 'последний живой одноимённый — глобальные уходят с ним');
  assert.equal(alive(), '');
  assert.equal(gone(), 'am@2026-09-15 ax@2026-09-14 h@2026-09-15 p@2026-09-15 w@2026-09-15');

  advanceDays(2); // 17.09
  assert.equal(app.restoreGroup('Утро', 'x'), true);
  assert.equal(alive(), 'ax', 'с блоком x вернулось только ушедшее с ним: глобальные ушли в другой день');
  const liveOf = nm => s.items.find(i => i.name === nm && app.live(i));
  assert.deepEqual([liveOf('ax').mode, liveOf('ax').addedAt], ['x', '2026-09-17']);
  assert.equal(app.restoreGroup('Утро'), true);
  assert.equal(alive(), 'am ax h p w', 'глобальные вернулись с тем уходом, который их увёл, — по одному экземпляру');
  assert.ok(['h', 'p', 'w'].every(nm => !('mode' in liveOf(nm))), 'у глобальных копий режима нет');
  assert.equal(liveOf('am').mode, 'main');

  const groupsOf = () => ['am', 'ax', 'h', 'p', 'w'].map(nm => liveOf(nm).group);
  assert.equal(app.renameGroup('Утро', 'Рассвет'), true);
  assert.deepEqual(groupsOf(), ['Рассвет', 'Утро', 'Утро', 'Утро', 'Утро'], 'блок «Утро» есть в другом режиме — глобальные при старом имени');
  s.groups.push(r2Block('Утро', 'y', [], '2026-09-01'));
  assert.equal(app.renameGroup('Утро', 'Закат', 'x'), true);
  // Р2/рецензия: прежде здесь стояло «и убранный блок убранного режима держит
  // имя» — живые привычка, параметр и счётчик оставались при имени, у которого
  // нет ни одного живого блока, и следующий старт оживлял убранный блок y
  assert.deepEqual(groupsOf(), ['Рассвет', 'Закат', 'Закат', 'Закат', 'Закат'],
    'живого одноимённого блока не осталось — живые глобальные идут за переименованием, убранный их не держит');
  assert.equal(app.renameGroup('Утро', 'Полдень', 'y'), true);
  assert.deepEqual(groupsOf(), ['Рассвет', 'Закат', 'Закат', 'Закат', 'Закат'],
    'переименование убранного блока живые пункты чужого имени не трогает');
  clearLocalStorage();
});

test('Р2/1: duplicateGroupTo — блок с живыми действиями в другой режим: имя то же, если свободно; в конец блоков цели; только действия; отказы и откат', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Другой'), r2Mode('gone', 'Убранный', '2026-09-01')];
  const since = '2026-08-31';
  s.groups = [r2Block('Школа', 'main', [{ from: '2026-09-07', mask: '1111100' }], null, '8:30'), r2Block('Вечер', 'x'), r2Block('Утро', 'main')];
  const a = r2Act('a', since, 'Школа', '1010101', 'main', {
    value: 5, unit: 'мин', note: 'n', at: '08:30',
    history: [{ date: since, value: 3 }, { date: '2026-09-03', value: 5 }],
    groupLog: [{ from: since, group: 'Утро' }, { from: '2026-09-07', group: 'Школа' }]
  });
  s.items = [a, r2Act('goneA', since, 'Школа', R1_WEEK, 'main', { removedAt: '2026-09-10' }), r2Weekly('w', since, 'Школа', 3),
    r1Item('h', since, 'Школа', R1_WEEK, { area: 'habit', normPerWeek: 7 }), r2Act('ev', since, 'Вечер', R1_WEEK, 'x')];
  const layout = () => s.groups.map(g => g.name + '/' + g.mode);

  assert.equal(app.duplicateGroupTo('Школа', 'main'), null, 'в свой же режим — не сюда (duplicateGroup)');
  assert.equal(app.duplicateGroupTo('Школа', 'gone'), null, 'в убранный режим — нет');
  assert.equal(app.duplicateGroupTo('Школа', 'nope'), null);
  assert.equal(app.duplicateGroupTo('Нет', 'x'), null);
  assert.equal(s.groups.length, 3);

  assert.equal(app.duplicateGroupTo('Школа', 'x'), 'Школа', 'в цели имя свободно — остаётся тем же');
  assert.deepEqual(layout(), ['Школа/main', 'Вечер/x', 'Школа/x', 'Утро/main'], 'в конец блоков цели');
  const copy = s.groups[2];
  assert.deepEqual(copy, { name: 'Школа', caption: '8:30', days: [{ from: R2_T, mask: '1111100' }], removedAt: null, mode: 'x' });
  const made = s.items.slice(5);
  assert.deepEqual(made.map(i => i.name), ['a'], 'только живые действия: счётчик, привычка и убранное — нет');
  const [c] = made;
  assert.notEqual(c.id, 'a');
  assert.deepEqual([c.mode, c.group, c.addedAt, c.value, c.unit, c.note, c.at], ['x', 'Школа', R2_T, 5, 'мин', 'n', '08:30']);
  assert.deepEqual([c.schedule, c.groupLog, c.history], [[{ from: R2_T, mask: '1010101' }], [], [{ date: R2_T, value: 5 }]]);
  const m = app.migrate(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(m.groups[2], copy, 'блок-копия — канон');
  assert.deepEqual(m.items.find(i => i.id === c.id), c, 'копия ≡ migrate(копия)');
  assert.equal(app.findGroup('Школа', 'x'), copy);
  assert.equal(app.findGroup('Школа'), s.groups[0], 'источник на месте');

  assert.equal(app.duplicateGroupTo('Школа', 'x'), 'Школа (копия)', 'занято в цели — «(копия)»');
  assert.equal(app.duplicateGroupTo('Школа', 'x'), 'Школа (копия 2)');
  assert.deepEqual(layout(), ['Школа/main', 'Вечер/x', 'Школа/x', 'Школа (копия)/x', 'Школа (копия 2)/x', 'Утро/main']);
  s.items.push(r2Act('orph', since, 'Утро', R1_WEEK, 'x'));
  assert.equal(app.duplicateGroupTo('Утро', 'x'), 'Утро (копия)', 'осиротевшее в цели имя не берётся');
  assert.equal(app.duplicateGroupTo('Вечер', 'main', 'x'), 'Вечер', 'источник — из названного режима');
  assert.equal(layout()[layout().length - 1], 'Вечер/main', 'в конец блоков основного');
  assert.deepEqual([s.items[s.items.length - 1].name, s.items[s.items.length - 1].mode], ['ev', 'main']);

  const before = JSON.stringify(s);
  withBrokenWrite(() => { assert.equal(app.duplicateGroupTo('Школа', 'x'), null); });
  assert.equal(JSON.stringify(s), before, 'откат: ни блока, ни действий');
  clearLocalStorage();
});

test('Р2/1: миграция v19→v20 — режим «Основной», блоки и действия в нём, журнал пуст; days{}, reviews[], schedule, groupLog — ни символа; идемпотентна (v1, v18, v19, файл с режимами)', () => {
  setNow(2026, 8, 16, 12, 0);
  const raw = JSON.parse(JSON.stringify(app.migrate(v16Fixture())));
  raw.schemaVersion = 19;
  delete raw.modes; delete raw.modeLog;
  raw.groups = [
    { name: 'Утро', caption: '7:00', days: [{ from: '2026-06-01', mask: '1111100' }], removedAt: null },
    { name: 'Движение', caption: '', days: [], removedAt: '2026-08-10' }
  ];
  for (const it of raw.items) delete it.mode;
  const m1 = raw.items.find(i => i.id === 'm1');
  m1.group = 'Утро';
  m1.groupLog = [{ from: '2026-05-04', group: 'Движение' }, { from: '2026-06-15', group: 'Утро' }];
  raw.items.find(i => i.id === 'm3').group = 'Утро';
  raw.items.find(i => i.id === 'h1').group = 'Утро';
  raw.items.find(i => i.id === 'h1').mode = 'мусор'; // привычке поле не положено
  raw.items.find(i => i.id === 'w1').mode = 'main';  // счётчику — тоже
  raw.reviews = [{ closedAt: 1, week: '2026-08-03', keys: [], perItem: {}, trainings: {}, oneChange: 'x', raises: [], lowers: [], params: [] }];
  const days = JSON.stringify(raw.days);
  const reviews = JSON.stringify(raw.reviews);
  const blockDays = JSON.stringify(raw.groups.map(g => g.days));
  const scheds = {}, logs = {};
  for (const it of raw.items) {
    if (it.schedule) scheds[it.id] = JSON.stringify(it.schedule);
    if (it.groupLog) logs[it.id] = JSON.stringify(it.groupLog);
  }

  // «ДО»: числа эпохи на непромигрированном файле — без полей режима всё читается основным
  const numbers = () => {
    const out = [];
    for (let k = '2026-05-04'; k <= '2026-08-16'; k = app.addDays(k, 1)) {
      const x = app.minDayMarks(k);
      out.push(x.done + '/' + x.total);
    }
    return out.concat([app.dayStreak(), app.bestStreak()]);
  };
  app.store = JSON.parse(JSON.stringify(raw));
  const before = numbers();

  const m = app.migrate(raw);
  app.store = m;
  assert.equal(m.schemaVersion, 20);
  assert.deepEqual(m.modes, [r2Mode('main', 'Основной')]);
  assert.deepEqual(m.modeLog, []);
  assert.deepEqual(m.groups.map(g => g.mode), ['main', 'main']);
  for (const it of m.items) {
    if (it.type === 'daily' && it.area === 'min') assert.equal(it.mode, 'main', 'действие в основном: ' + it.id);
    else assert.equal('mode' in it, false, 'глобальному поле не положено: ' + it.id);
    if (scheds[it.id]) assert.equal(JSON.stringify(it.schedule), scheds[it.id], 'schedule ни символа: ' + it.id);
    if (logs[it.id]) assert.equal(JSON.stringify(it.groupLog), logs[it.id], 'groupLog ни символа: ' + it.id);
  }
  assert.equal(JSON.stringify(m.days), days, 'days{} ни символа');
  assert.equal(JSON.stringify(m.reviews), reviews, 'reviews[] ни символа');
  assert.equal(JSON.stringify(m.groups.map(g => g.days)), blockDays, 'дни блоков ни символа');
  assert.deepEqual(numbers(), before, 'числа каждого дня эпохи, серия и рекорд — те же');
  const again = app.migrate(JSON.parse(JSON.stringify(m)));
  assert.equal(JSON.stringify(again), JSON.stringify(m), 'второй прогон — побайтово то же');

  // v18-файл: блок — одно имя, журналов и режимов нет
  const r18 = JSON.parse(JSON.stringify(m));
  r18.schemaVersion = 18;
  delete r18.modes; delete r18.modeLog;
  r18.groups = [{ name: 'Утро' }];
  for (const it of r18.items) { delete it.mode; delete it.groupLog; }
  const m18 = app.migrate(r18);
  assert.deepEqual(m18.modes, [r2Mode('main', 'Основной')]);
  assert.deepEqual(m18.groups, [{ name: 'Утро', caption: '', days: [], removedAt: null, mode: 'main' }]);
  assert.ok(m18.items.filter(i => i.type === 'daily' && i.area === 'min').every(i => i.mode === 'main'));
  assert.equal(JSON.stringify(m18.days), days);
  assert.equal(JSON.stringify(app.migrate(JSON.parse(JSON.stringify(m18)))), JSON.stringify(m18), 'v18: идемпотентно');

  // v1-файл: литерал «Принять душ» и досборка блоков — сразу в режиме
  const once = app.migrate(v1Store());
  assert.deepEqual(once.modes, [r2Mode('main', 'Основной')]);
  assert.equal(once.items.find(i => i.name === 'Принять душ').mode, 'main');
  assert.equal('mode' in once.items.find(i => i.name === 'Тренировка'), false);
  assert.ok(once.groups.length && once.groups.every(g => g.mode === 'main'));
  assert.equal(JSON.stringify(app.migrate(JSON.parse(JSON.stringify(once)))), JSON.stringify(once), 'v1: идемпотентно');

  // файл с режимами: дубль имени, неизвестные ссылки, убранный активный
  setNow(2026, 9, 14, 12, 0);
  const imp = app.migrate({
    schemaVersion: 20,
    modes: [{ id: 's', name: 'Школа', removedAt: '2026-09-02' }, { id: 's2', name: 'Школа' }, { id: 'k', name: 'Каникулы', removedAt: '2026-09-01' }],
    modeLog: [{ from: '2026-09-01', mode: 's2' }, { from: '2026-09-03', mode: 'zzz' }],
    groups: [{ name: 'A', mode: 's2' }, { name: 'A', mode: 's', caption: 'дубль' }, { name: 'B', mode: 'zzz' }, { name: 'A' }],
    items: [
      { id: 'x', name: 'X', type: 'daily', area: 'min', addedAt: '2026-09-01', group: 'A', mode: 's2' },
      { id: 'y', name: 'Y', type: 'daily', area: 'min', addedAt: '2026-09-01', group: 'B' },
      { id: 'h', name: 'H', type: 'daily', area: 'habit', addedAt: '2026-09-01', group: 'A', mode: 's' }
    ],
    days: {}, settings: { dayBoundary: 4, calendarSince: '2026-08-31', seed17: true, habitSeeded: true }
  }, { external: true });
  assert.deepEqual(imp.modes, [r2Mode('main', 'Основной'), r2Mode('s', 'Школа'), r2Mode('k', 'Каникулы', '2026-09-01')],
    'основной дописан первым; дубль имени снят; режим, действующий сегодня, убранным не бывает');
  assert.deepEqual(imp.modeLog, [{ from: '2026-09-01', mode: 's' }], 'ссылка дубля — на одноимённый; неизвестный отрезок уронен');
  assert.deepEqual(imp.groups.map(g => [g.name, g.mode, g.caption]), [['A', 's', ''], ['B', 'main', ''], ['A', 'main', '']],
    'дубль имени в режиме схлопнут в первый; неизвестный режим — основной');
  assert.deepEqual(imp.items.map(i => i.mode), ['s', 'main', undefined]);
  assert.equal(JSON.stringify(app.migrate(JSON.parse(JSON.stringify(imp)))), JSON.stringify(imp), 'идемпотентно');
});

test('Р2/1: категории потерь «режим» и «отрезок режима» — склонения и счёт по сырому файлу', () => {
  setNow(2026, 9, 14, 12, 0);
  const zero = app.dataCounts({});
  const line = (key, n) => app.droppedLine(Object.assign({}, zero, { [key]: n }), zero);
  assert.equal(line('modes', 1), '1 режим');
  assert.equal(line('modes', 2), '2 режима');
  assert.equal(line('modes', 5), '5 режимов');
  assert.equal(line('modeLog', 1), '1 отрезок режима');
  assert.equal(line('modeLog', 3), '3 отрезка режима');
  assert.equal(line('modeLog', 11), '11 отрезков режима');
  const settings = { dayBoundary: 4, calendarSince: '2026-08-31', seed17: true, habitSeeded: true };
  const raw = {
    schemaVersion: 20,
    modes: [{ id: 'main', name: 'Основной' }, { id: 'b', name: 'Школа' }, { id: 'c', name: 'Школа' }, 'мусор'],
    modeLog: [{ from: '2026-09-01', mode: 'b' }, { from: 'нет', mode: 'b' }, { from: '2026-09-03', mode: 'c' }, { from: '2026-09-05', mode: 'zzz' }],
    items: [], groups: [], days: {}, settings
  };
  const was = app.dataCounts(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual([was.modes, was.modeLog], [4, 4]);
  const got = app.dataCounts(app.migrate(raw, { external: true }));
  assert.deepEqual([got.modes, got.modeLog], [2, 1]);
  const dropped = app.droppedLine(was, got);
  assert.match(dropped, /2 режима/);
  assert.match(dropped, /3 отрезка режима/);
  const v19 = { schemaVersion: 19, items: [], groups: [], days: {}, settings: Object.assign({}, settings) };
  const w19 = app.dataCounts(JSON.parse(JSON.stringify(v19)));
  assert.equal(app.droppedLine(w19, app.dataCounts(app.migrate(v19, { external: true }))), '',
    'файл без режимов потерь не называет: основной появляется, а не пропадает');
});

test('Р2/1: места создания действия и фабрики — в каноне v20: режим у действия, у глобальных поля нет', () => {
  const s = r2Store();
  const def = app.defaultStore();
  assert.deepEqual([def.modes, def.modeLog], [[r2Mode('main', 'Основной')], []]);
  for (const it of def.items) {
    if (it.type === 'daily' && it.area === 'min') assert.equal(it.mode, 'main', it.name);
    else assert.equal('mode' in it, false, it.name);
  }
  assert.ok(def.groups.every(g => g.mode === 'main'));
  const empty = app.emptyStore(4);
  assert.deepEqual([empty.modes, empty.modeLog], [[r2Mode('main', 'Основной')], []], 'чистый лист — основной режим');

  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Другой')];
  assert.equal(app.setActiveMode('x').ok, true);
  assert.equal(app.addGroup('Школа', '', '1111100'), true);
  assert.equal(app.findGroup('Школа').mode, 'x', 'новый блок — в активном режиме');
  const [q] = app.addActions('Школа', app.parseQuickLines('Звонок · родным'));
  assert.equal(q.mode, 'x', 'быстрое добавление — в активном режиме');
  assert.equal(app.dueNow(q), true);
  assert.equal(app.setItemType(q, 'weekly', 2), true);
  assert.equal('mode' in q, false, 'счётчик глобален');
  assert.equal(app.setActiveMode('main').ok, true);
  assert.equal(app.setItemType(q, 'daily'), true);
  assert.equal(q.mode, 'main', 'ежедневный рождается в активном режиме');

  const [r] = app.addActions('Школа', app.parseQuickLines('Пост'), 'x');
  assert.equal(r.mode, 'x', 'режим можно назвать явно');
  assert.equal(app.removeItem(r.id), true);
  advanceDays(2);
  const back = app.restoreItem(r.id);
  assert.ok(back);
  assert.deepEqual([back.mode, back.groupLog], ['x', []], 'новая запись возврата — в режиме прежней, не в активном');
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(s))).items.find(i => i.id === back.id), back, 'копия возврата — канон');
  clearLocalStorage();
});

test('Р2/1: bestStreak и dayStreak на трёх годах с журналом режимов из сотен отрезков держат пороги инварианта', () => {
  const { store: s } = perfStore();
  app.store = s;
  const since = s.settings.calendarSince;
  const t = app.todayKey();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('alt', 'Другой')];
  // двойники действий во втором режиме с теми же отметками: дни второго
  // режима считаются его действиями, и ответ обязан совпасть с прежним
  const min = s.items.filter(i => i.type === 'daily' && i.area === 'min');
  for (const i of min) s.items.push(Object.assign(JSON.parse(JSON.stringify(i)), { id: i.id + '-alt', mode: 'alt' }));
  for (const k of Object.keys(s.days)) for (const i of min) if (s.days[k][i.id]) s.days[k][i.id + '-alt'] = true;
  const bestPlain = app.bestStreak();
  const dayPlain = app.dayStreak();

  const log = [];
  for (let k = app.addDays(since, 3), n = 0; k <= t; k = app.addDays(k, 3), n++) log.push({ from: k, mode: n % 2 ? 'main' : 'alt' });
  s.modeLog = log;
  assert.ok(log.length >= 300, 'сотни отрезков: ' + log.length);
  assert.deepEqual(app.normModeLog(log, s.modes), log, 'журнал канонический');
  assert.deepEqual(app.minDayItems(log[0].from).map(i => i.mode), min.map(() => 'alt'), 'в дни второго режима — его действия');
  // ответ сначала: сторож скорости не должен разрешать неверный счёт
  assert.equal(app.bestStreak(), bestPlain, 'рекорд тот же');
  assert.equal(app.dayStreak(), dayPlain, 'серия та же');
  assert.ok(bestPlain > 0);
  const best = measureMs(() => app.bestStreak());
  const day = measureMs(() => app.dayStreak());
  assert.ok(best < 50, `bestStreak с режимами: ${best.toFixed(1)} мс ≥ 50 мс`);
  assert.ok(day < 30, `dayStreak с режимами: ${day.toFixed(1)} мс ≥ 30 мс`);
});

test('Р2/2: goneBesideBlock — строка «Убранных» по блоку: у действия — блок его режима, у глобального пункта — все режимы', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Другой')];
  const since = '2026-08-31';
  const off = { removedAt: '2026-09-08' };
  s.groups = [r2Block('Утро', 'main', [], '2026-09-10'), r2Block('Утро', 'x'), r2Block('Лагерь', 'x', [], '2026-09-10'), r2Block('Школа', 'main')];
  const habit = (id, group) => r1Item(id, since, group, R1_WEEK, Object.assign({ area: 'habit', normPerWeek: 7 }, off));
  s.items = [
    r2Act('am', since, 'Утро', R1_WEEK, 'main', off),   // блок своего режима убран
    r2Act('ax', since, 'Утро', R1_WEEK, 'x', off),      // блок своего режима жив
    r2Act('an', since, 'Лагерь', R1_WEEK, 'main', off), // у своего режима такого блока нет
    habit('hU', 'Утро'),                                // одноимённый жив в другом режиме
    habit('hL', 'Лагерь'),                              // единственный такой блок убран
    Object.assign(r2Weekly('wL', since, 'Лагерь', 2), off),
    Object.assign(r2Param('pS', since, 'Школа'), off),
    habit('hN', 'Нигде'),                               // блока с именем нет нигде
    habit('h0', '')
  ];
  const shown = s.items.filter(app.goneBesideBlock).map(i => i.id);
  assert.deepEqual(shown, ['ax', 'an', 'hU', 'pS', 'hN', 'h0']);
  // активный режим на ответ не влияет: правило не читает выбор
  app.setActiveMode('x');
  assert.deepEqual(s.items.filter(app.goneBesideBlock).map(i => i.id), shown);
  // возврат блока «Лагерь» делает его пункты возвращаемыми поодиночке
  assert.equal(app.restoreGroup('Лагерь', 'x'), true);
  assert.deepEqual(['hL', 'wL'].map(id => app.goneBesideBlock(s.items.find(i => i.id === id))), [true, true]);
  clearLocalStorage();
});

test('Р2/2: domFormKey — формы режима: переименование по id, «Новый режим» через «+»; ни один ключ не совпадает с чужим ни при каком имени и id', () => {
  const f = (form, id) => ({ dataset: id === undefined ? { form } : { form, id } });
  assert.equal(app.domFormKey(f('mode-rename', 'kan')), 'mode:kan');
  assert.equal(app.domFormKey(f('mode-add')), 'mode+new');
  assert.notEqual(app.domFormKey(f('mode-rename', 'new')), app.domFormKey(f('mode-add')), 'режим с id «new» — не форма добавления');
  // приставки всех форм «Настроек» различны: имя блока или id режима не даёт чужого ключа
  const tricky = ['new', 'x', 'mode:x', 'group:Утро', '', 'a+new'];
  const owner = new Map(); // ключ → вид формы, его давший
  const put = (kind, key) => {
    assert.ok(!owner.has(key) || owner.get(key) === kind, `ключ «${key}» дают две формы: ${owner.get(key)} и ${kind}`);
    owner.set(key, kind);
  };
  for (const x of tricky) {
    for (const kind of ['mode-rename', 'group-edit', 'ex-edit', 'quick', 'edit']) put(kind, app.domFormKey(f(kind, x)));
  }
  for (const kind of ['add', 'group-add', 'ex-add', 'mode-add']) put(kind, app.domFormKey(f(kind)));
  assert.equal(owner.size, tricky.length * 5 + 4, 'все ключи различны');
});

/* ══ Задача Р2, этап 4: «Не сегодня» ══════════════════════════
   Пропуск — false в days{}[день][id]: true — отметка, false — пропуск,
   ключа нет — не отмечено. Даты фиксированы: сегодня понедельник
   14.09.2026, эпоха с 17.08.2026 (r2Store). */

const R2_SINCE = '2026-08-17';
const r2Days = (s, from, to, fill) => { // fill(k) → объект значений дня или null
  for (let k = from; k <= to; k = app.addDays(k, 1)) {
    const d = fill(k);
    if (d && Object.keys(d).length) s.days[k] = d; else delete s.days[k];
  }
};

test('Р2/3: кодирование пропуска — false в days{}; прежние читатели отметки видят «не отмечено»; круг пропущенного отказывает; одна запись с откатом', () => {
  const s = r2Store();
  const a = r2Act('a', R2_SINCE, '', R1_WEEK, 'main');
  const b = r2Act('b', R2_SINCE, '', R1_WEEK, 'main');
  s.items = [a, b];
  const disk = () => JSON.parse(global.localStorage.getItem('minimum:data')).days;

  assert.equal(app.skipToday('a'), true);
  assert.deepEqual(s.days[R2_T], { a: false }, 'пропуск — отдельное значение, не отметка');
  assert.deepEqual(disk()[R2_T], { a: false }, 'и оно записано');
  assert.equal(app.isSkipped(R2_T, 'a'), true);
  assert.equal(app.isMarked(R2_T, 'a'), false);
  // прежние проверки истинности отметки читают false как «не отмечено» без правки
  assert.equal(app.everMarked(a), false, 'everMarked');
  assert.equal(app.marksInSystem(a), 0, 'marksInSystem');
  assert.equal(app.itemWeekCount(a, R2_T), 0, 'itemWeekCount');
  assert.equal(app.planWeekCount(a, R2_T), 0, 'planWeekCount');
  assert.deepEqual(app.weekPlan(a, [R2_T]), { planned: 1, done: 0 }, 'weekPlan');
  assert.equal(app.weekSkips(a, [R2_T]), 1, 'weekSkips — третье число строки разбора');
  assert.deepEqual([app.dataCounts(s).marks, app.dataCounts(s).skips], [0, 1], 'dataCounts: отметок нет, пропуск один');

  assert.equal(app.toggleMark(R2_T, 'a'), false, 'круг пропущенного неактивен');
  assert.deepEqual(s.days[R2_T], { a: false }, 'и значение не тронуто');
  assert.equal(app.skipToday('a'), false, 'повторный пропуск — отказ');

  assert.equal(app.unskipToday('a'), true);
  assert.equal(s.days[R2_T], undefined, 'день без значений не существует');
  assert.equal(disk()[R2_T], undefined);
  assert.equal(app.unskipToday('a'), false, 'снимать нечего');
  assert.equal(app.toggleMark(R2_T, 'a'), true, 'после «Вернуть» круг снова работает');
  assert.equal(app.skipToday('a'), false, 'отмеченному «Не сегодня» не предлагается');
  assert.equal(app.skipToday('b'), true);
  assert.equal(app.unskipToday('b'), true);
  assert.deepEqual(s.days[R2_T], { a: true }, 'снятие пропуска чужих значений дня не трогает');

  // отказ хранилища: память откатывается целиком, пустого дня не остаётся
  app.toggleMark(R2_T, 'a');
  assert.equal(s.days[R2_T], undefined);
  const real = global.localStorage.setItem;
  global.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(app.skipToday('a'), false, 'не записалось — отказ');
  assert.equal(s.days[R2_T], undefined, 'в памяти не осталось того, чего нет на диске');
  global.localStorage.setItem = real;
  assert.equal(app.skipToday('b'), true);
  global.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(app.unskipToday('b'), false);
  assert.deepEqual(s.days[R2_T], { b: false }, 'возврат не записался — пропуск на месте');
  global.localStorage.setItem = real;
  assert.deepEqual(disk()[R2_T], { b: false });
  clearLocalStorage();
});

test('Р2/3: пропуск — только сегодня и только живое действие минимума, запланированное сегодня и не отмеченное', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('school', 'Школа')];
  s.groups = [r2Block('Выходные', 'main', [{ from: R2_SINCE, mask: '0000011' }])];
  const ok = r2Act('ok', R2_SINCE, '', R1_WEEK, 'main');
  const fresh = r2Act('fresh', R2_T, '', R1_WEEK, 'main');                 // заведён сегодня
  const offDay = r2Act('offDay', R2_SINCE, '', '0111111', 'main');          // понедельник вне своей маски
  const offBlock = r2Act('offBlock', R2_SINCE, 'Выходные', R1_WEEK, 'main'); // понедельник вне дней блока
  const other = r2Act('other', R2_SINCE, '', R1_WEEK, 'school');           // действие чужого режима
  const gone = r2Act('gone', R2_SINCE, '', R1_WEEK, 'main', { removedAt: '2026-09-10' });
  const h = r1Item('h', R2_SINCE, '', R1_WEEK, { area: 'habit', normPerWeek: 7 });
  const w = r2Weekly('w', R2_SINCE, '', 3);
  const p = r2Param('p', R2_SINCE, '');
  s.items = [ok, fresh, offDay, offBlock, other, gone, h, w, p];

  for (const id of ['offDay', 'offBlock', 'other', 'gone', 'h', 'w', 'p', 'нет-такого']) {
    assert.equal(app.skipToday(id), false, 'отказ: ' + id);
  }
  assert.equal(s.days[R2_T], undefined, 'отказы не завели ни значения, ни пустого дня');
  assert.equal(app.skipToday('fresh'), true, 'заведённый сегодня — уже в плане');
  app.toggleMark(R2_T, 'ok');
  assert.equal(app.skipToday('ok'), false, 'отмеченный');
  assert.deepEqual(s.days[R2_T], { fresh: false, ok: true });
  // тип действия в день заведения не меняется, пока у него сегодняшний пропуск
  assert.equal(app.typeChangeRefusal(fresh, 'weekly'), 'Тип не меняется: у пункта сегодня «Не сегодня»');
  assert.equal(app.setItemType(fresh, 'weekly', 3), false);

  // вчера: пропуск, сделанный вчера, из интерфейса больше не снимается и
  // отметкой не переписывается; «завтра» у пропуска нет — только сегодняшний ключ
  const Y = app.addDays(R2_T, -1);
  s.days[Y] = { ok: false };
  assert.equal(app.unskipToday('ok'), false, 'вчерашний пропуск «Вернуть» не снимает');
  assert.equal(app.toggleMark(Y, 'ok'), false, 'и круг за вчера ему отказывает');
  assert.equal(app.markYesterday('ok'), false);
  assert.deepEqual(s.days[Y], { ok: false });
  setNow(2026, 9, 15, 12, 0); // наступил вторник
  assert.equal(app.unskipToday('fresh'), false, 'пропуск понедельника во вторник уже не снимается');
  assert.equal(app.skipToday('ok'), true, 'а пропуск ложится в новый сегодняшний день');
  assert.deepEqual(Object.keys(s.days).sort(), [Y, R2_T, '2026-09-15']);
  assert.deepEqual(s.days['2026-09-15'], { ok: false });
  clearLocalStorage();
});

test('Р2/3: знаменатель дня — minDayMarks {done, total, skipped, planned}, dayScore, «день закрыт», thresholdNote', () => {
  const s = r2Store();
  s.items = ['a', 'b', 'c', 'd'].map(id => r2Act(id, R2_SINCE, '', '1111110', 'main')); // воскресенье вне плана
  const m = k => app.minDayMarks(k);

  assert.deepEqual(m(R2_T), { done: 0, total: 4, skipped: 0, planned: 4 });
  assert.equal(app.thresholdNote(), 'День зачтён, если отмечено не меньше 4 из 4.');
  app.toggleMark(R2_T, 'a');
  app.toggleMark(R2_T, 'b');
  app.skipToday('c');
  assert.deepEqual(m(R2_T), { done: 2, total: 3, skipped: 1, planned: 4 }, 'пропущенное выпало из знаменателя');
  assert.equal(app.dayScore(R2_T), 2 / 3);
  assert.equal(app.minDayClosed(R2_T), false);
  assert.equal(app.thresholdNote(), 'День зачтён, если отмечено не меньше 3 из 3.', 'подпись зачёта — по тому же знаменателю');
  app.toggleMark(R2_T, 'd');
  assert.deepEqual(m(R2_T), { done: 3, total: 3, skipped: 1, planned: 4 });
  assert.equal(app.minDayClosed(R2_T), true, 'все непропущенные отмечены — день закрыт');
  assert.equal(app.dayScore(R2_T), 1);

  // всё пропущено: план есть — день НЕ нейтрален: доля 0, не закрыт
  const thu = '2026-09-10';
  s.days[thu] = { a: false, b: false, c: false, d: false };
  assert.deepEqual(m(thu), { done: 0, total: 0, skipped: 4, planned: 4 });
  assert.equal(app.dayScore(thu), 0, 'сплошные пропуски — не null');
  assert.equal(app.minDayClosed(thu), false, 'закрывать было что, закрыто не было');
  // день без плана нейтрален, даже если в данных лежит пропуск (импорт)
  const sun = '2026-09-13';
  s.days[sun] = { a: false };
  assert.deepEqual(m(sun), { done: 0, total: 0, skipped: 0, planned: 0 });
  assert.equal(app.dayScore(sun), null, 'нейтральность решает план, а не знаменатель');

  // сегодня всё пропущено — подписи зачёта нет: из 0 зачитывать нечего
  for (const id of ['a', 'b', 'd']) app.toggleMark(R2_T, id);
  for (const id of ['a', 'b', 'd']) app.skipToday(id);
  assert.deepEqual(m(R2_T), { done: 0, total: 0, skipped: 4, planned: 4 });
  assert.equal(app.thresholdNote(), '');
  assert.equal(app.dayScore(R2_T), 0);
  clearLocalStorage();
});

test('Р2/3: сплошные пропуски ≠ нейтральный день — серия рвётся и тратит амнистию по общему правилу; день без плана проходит насквозь; рекорд тем же правилом', () => {
  const s = r2Store();
  s.items = ['a', 'b'].map(id => r2Act(id, R2_SINCE, '', '1111110', 'main'));
  const full = k => (app.weekdayOf(k) === 6 ? null : { a: true, b: true });
  const Y = app.addDays(R2_T, -1);

  // 24 дня плана до вчера; среда 09.09 — пропущено всё. Сегодня пусто
  r2Days(s, R2_SINCE, Y, k => (k === '2026-09-09' ? { a: false, b: false } : full(k)));
  assert.equal(app.dayScore('2026-09-09'), 0);
  assert.equal(app.dayStreak(), 23, 'одна амнистия: день в счёт не идёт, серию не рвёт');
  assert.equal(app.bestStreak(), 23);
  // тот же счёт, что у дня вовсе без отметок: пропуск — не отметка
  r2Days(s, '2026-09-09', '2026-09-09', () => null);
  assert.equal(app.dayStreak(), 23);

  // второй день сплошных пропусков через два дня — амнистия уже потрачена
  r2Days(s, R2_SINCE, Y, k => (k === '2026-09-09' || k === '2026-09-11' ? { a: false, b: false } : full(k)));
  assert.equal(app.dayStreak(), 2, 'пт прощён, ср обрывает: 12.09 и 10.09');
  assert.equal(app.bestStreak(), 21, 'рекорд: 20 дней до 08.09, прощённая среда и 10.09');

  // контраст: если пятница — день БЕЗ плана, она проходит насквозь и амнистии не тратит
  for (const it of s.items) {
    it.schedule = [{ from: R2_SINCE, mask: '1111110' }, { from: '2026-09-11', mask: '1111010' }, { from: '2026-09-12', mask: '1111110' }];
  }
  assert.equal(app.dayScore('2026-09-11'), null, 'пятница вне плана: пропуски в ней не считаются');
  assert.equal(app.dayStreak(), 22, 'сквозная пятница: 12.09, 10.09, прощённая среда и 20 дней до неё');
  assert.equal(app.bestStreak(), 22);
  clearLocalStorage();
});

test('Р2/3: пороги планки пропусков не знают — m по расписанию, числитель — отметки, пропуск = не сделано', () => {
  const s = r2Store();
  const a = r2Act('a', R2_SINCE, '', R1_WEEK, 'main', { value: 10, unit: 'мин', history: [{ date: R2_SINCE, value: 10 }] });
  s.items = [a];
  const W = app.closedWeeks(3);
  assert.deepEqual(W, ['2026-08-24', '2026-08-31', '2026-09-07']);
  const week = (mon, marks, skips) => {
    for (let i = 0; i < 7; i++) {
      const k = app.addDays(mon, i);
      if (i < marks) s.days[k] = { a: true };
      else if (i < marks + skips) s.days[k] = { a: false };
      else delete s.days[k];
    }
  };

  // шесть отметок и пропуск — ≥ 6 из 7: готов к повышению
  for (const w of W) week(w, 6, 1);
  assert.deepEqual(W.map(w => [app.weekMaskDays(a, w), app.planWeekCount(a, w)]), [[7, 6], [7, 6], [7, 6]],
    'знаменатель — дни расписания, пропуск его не уменьшает');
  assert.equal(app.raiseEligible(a), true);
  // пять отметок и два пропуска — «5 из 5 непропущенных» порогом не считается
  for (const w of W) week(w, 5, 2);
  assert.equal(app.raiseEligible(a), false, 'пропуск — не сделано');
  // понижение: три отметки и четыре пропуска — ≤ 3 из 7, облегчение предлагается
  for (const w of W) week(w, 3, 4);
  assert.equal(app.lowerEligible(a), true);
  // пропуски знаменатель не уменьшают: 4 отметки из 7 — не «не держится»
  for (const w of W) week(w, 4, 3);
  assert.equal(app.lowerEligible(a), false);
  // пункт, у которого за всю жизнь одни пропуски, не начат: облегчать нечего
  for (const w of W) week(w, 0, 7);
  for (const k of Object.keys(s.days)) if (s.days[k].a === true) delete s.days[k];
  assert.equal(app.everMarked(a), false);
  assert.equal(app.lowerEligible(a), false, 'пропуски — не начало практики');
  clearLocalStorage();
});

test('Р2/3: точка «вчера — пропуск» у пропущенного вчера не рисуется, markYesterday отказывает', () => {
  const s = r2Store();
  const a = r2Act('a', R2_SINCE, '', R1_WEEK, 'main');
  const b = r2Act('b', R2_SINCE, '', R1_WEEK, 'main');
  s.items = [a, b];
  const Y = app.addDays(R2_T, -1);
  s.days['2026-09-10'] = { a: true, b: true }; // оба начаты
  s.days[Y] = { a: false };                    // «Не сегодня» у a было вчера
  assert.equal(app.missedYesterday(a, R2_T), false, 'пропуск — решение, а не забытая отметка');
  assert.equal(app.missedYesterday(b, R2_T), true, 'забытая отметка — точка есть');
  assert.equal(app.markYesterday('a'), false);
  assert.deepEqual(s.days[Y], { a: false }, 'пропуск отметкой не переписан');
  assert.equal(app.markYesterday('b'), true);
  assert.deepEqual(s.days[Y], { a: false, b: true });
  clearLocalStorage();
});

test('Р2/3: срез closeWeek — skips и skipCount отдельным рядом; count — отметки; убранный с одними пропусками в срезе', () => {
  const s = r2Store();
  const a = r2Act('a', R2_SINCE, '', R1_WEEK, 'main');
  const r = r2Act('r', R2_SINCE, '', R1_WEEK, 'main', { removedAt: '2026-09-12' });
  const q = r2Act('q', R2_SINCE, '', R1_WEEK, 'main', { removedAt: '2026-09-12' }); // убран без фактов в окне
  const h = r1Item('h', R2_SINCE, '', R1_WEEK, { area: 'habit', normPerWeek: 3 });
  s.items = [a, r, q, h];
  s.days['2026-09-07'] = { a: true, h: true };
  s.days['2026-09-08'] = { a: true };
  s.days['2026-09-09'] = { a: false };
  s.days['2026-09-10'] = { r: false };
  assert.equal(app.reviewDue(), true);
  assert.equal(app.closeWeek(), true);
  const rev = s.reviews[s.reviews.length - 1];
  const F = false, T = true;
  assert.deepEqual(rev.perItem.a, { name: 'a', marks: [T, T, F, F, F, F, F], count: 2, skips: [F, F, T, F, F, F, F], skipCount: 1 });
  assert.deepEqual(rev.perItem.r, { name: 'r', marks: [F, F, F, F, F, F, F], count: 0, skips: [F, F, F, T, F, F, F], skipCount: 1 },
    'факт недели — и пропуск тоже: убранный с ним стоит в срезе');
  assert.equal(rev.perItem.q, undefined, 'убранный без фактов — нет');
  assert.deepEqual([rev.perItem.h.count, rev.perItem.h.skipCount], [1, 0], 'у привычки ряд тот же, пропусков нет');
  assert.deepEqual(s.days['2026-09-09'], { a: false }, 'срез days{} не трогает');
  clearLocalStorage();
});

test('Р2/3: migrate — пропуск законен только у действия; экспорт → импорт переносит; категория потерь «пропуск»; зеркало видит день пропусков', () => {
  setNow(2026, 9, 14, 12, 0);
  const zero = app.dataCounts({});
  const line = (n) => app.droppedLine(Object.assign({}, zero, { skips: n }), zero);
  assert.equal(line(1), '1 пропуск');
  assert.equal(line(2), '2 пропуска');
  assert.equal(line(5), '5 пропусков');

  const act = r2Act('a', R2_SINCE, '', R1_WEEK, 'main');
  const raw = {
    schemaVersion: 20,
    modes: [r2Mode('main', 'Основной')], modeLog: [],
    items: [act, r1Item('h', R2_SINCE, '', R1_WEEK, { area: 'habit', normPerWeek: 7 }), r2Weekly('w', R2_SINCE, '', 2), r2Param('p', R2_SINCE, '')],
    groups: [],
    days: {
      '2026-09-10': { a: false, h: false, w: false, p: false, ghost: false, a2: 'x' },
      '2026-09-11': { a: true, h: true },
      '2026-09-12': { h: false }
    },
    settings: { dayBoundary: 4, calendarSince: R2_SINCE, seed17: true, habitSeeded: true }
  };
  const was = app.dataCounts(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual([was.marks, was.skips, was.days], [2, 6, 3]);
  const got = app.migrate(raw, { external: true });
  assert.deepEqual(got.days, { '2026-09-10': { a: false, ghost: false }, '2026-09-11': { a: true, h: true } },
    'у привычки, счётчика и параметра false отброшен; у действия и неизвестного id — остался');
  const gc = app.dataCounts(got);
  assert.deepEqual([gc.marks, gc.skips, gc.days], [2, 2, 2]);
  assert.equal(app.droppedLine(was, gc), '1 день, 4 пропуска');
  assert.deepEqual(app.migrate(JSON.parse(JSON.stringify(got)), { external: true }).days, got.days, 'идемпотентно');

  // экспорт — JSON.stringify(store), импорт — migrate({external}): пропуск доезжает как есть
  const s = r2Store();
  s.items = [r2Act('a', R2_SINCE, '', R1_WEEK, 'main'), r2Act('b', R2_SINCE, '', R1_WEEK, 'main')];
  app.toggleMark(R2_T, 'a');
  app.skipToday('b');
  s.days['2026-09-09'] = { b: false };
  const file = JSON.parse(JSON.stringify(app.store));
  const back = app.migrate(file, { external: true });
  assert.deepEqual(back.days, { [R2_T]: { a: true, b: false }, '2026-09-09': { b: false } });
  app.store = back;
  assert.deepEqual(app.minDayMarks(R2_T), { done: 1, total: 1, skipped: 1, planned: 2 }, 'импорт — те же числа дня');
  assert.equal(app.droppedLine(app.dataCounts(JSON.parse(JSON.stringify(s))), app.dataCounts(back)), '', 'потерь нет');
  // зеркало: день из одних пропусков — тоже практика, которой в рабочей копии нет
  const cur = JSON.parse(JSON.stringify(back));
  delete cur.days['2026-09-09'];
  assert.equal(app.mirrorHasMore(back, cur), true);
  clearLocalStorage();
});

/* ── Свёртка выполненного блока «Сегодня» (задача Р2, п. 4) ─────
   Сама свёртка — состояние экрана (интерфейсный уровень). Здесь — её
   доменная опора: счёт блока, чистая функция от days{}. */

test('Р2/4: blockTally — выполнен, когда каждое действие блока отмечено или пропущено и их ≥ 1; N — отмеченные, K — пропуски; чужой день и чужие пункты не в счёт', () => {
  const s = r2Store();
  s.groups = [r2Block('Утро', 'main', [], null, '7:00'), r2Block('Вечер', 'main', [], null, '')];
  const a = r2Act('a', R2_SINCE, 'Утро', R1_WEEK, 'main');
  const b = r2Act('b', R2_SINCE, 'Утро', R1_WEEK, 'main');
  const c = r2Act('c', R2_SINCE, 'Вечер', R1_WEEK, 'main');
  const loose = r2Act('l', R2_SINCE, '', R1_WEEK, 'main');
  s.items = [a, b, c, loose];
  const secs = () => app.groupedItems(app.minDayItems(R2_T), 'main');
  const utro = () => secs().find(x => x.group && x.group.name === 'Утро').items;

  assert.deepEqual(app.blockTally([], R2_T), { done: 0, skipped: 0, full: false }, 'пустой блок выполненным не бывает');
  assert.deepEqual(app.blockTally(utro(), R2_T), { done: 0, skipped: 0, full: false });
  app.toggleMark(R2_T, 'a');
  assert.deepEqual(app.blockTally(utro(), R2_T), { done: 1, skipped: 0, full: false }, 'один не отмечен — не выполнен');
  app.toggleMark(R2_T, 'b');
  assert.deepEqual(app.blockTally(utro(), R2_T), { done: 2, skipped: 0, full: true }, 'все отмечены — «✓ 2 из 2»');
  app.toggleMark(R2_T, 'b');
  assert.equal(app.skipToday('b'), true);
  assert.deepEqual(app.blockTally(utro(), R2_T), { done: 1, skipped: 1, full: true }, 'отмечен и пропущен — «1 из 1 · пропусков 1»');
  app.toggleMark(R2_T, 'a');
  assert.equal(app.skipToday('a'), true);
  assert.deepEqual(app.blockTally(utro(), R2_T), { done: 0, skipped: 2, full: true },
    'сплошные пропуски блок выполненным делают — «день закрыт» при этом нет');
  assert.equal(app.minDayClosed(R2_T), false);

  // счёт — по переданным пунктам и по этому дню: соседний блок, пункт без
  // блока и вчерашние отметки в него не входят
  const vecher = secs().find(x => x.group && x.group.name === 'Вечер').items;
  assert.deepEqual(app.blockTally(vecher, R2_T), { done: 0, skipped: 0, full: false });
  s.days['2026-09-13'] = { c: true };
  assert.deepEqual(app.blockTally(vecher, R2_T), { done: 0, skipped: 0, full: false }, 'вчерашняя отметка — не сегодняшняя');
  assert.deepEqual(app.blockTally(vecher, '2026-09-13'), { done: 1, skipped: 0, full: true });
  assert.equal(secs().some(x => !x.group && x.items.some(i => i.id === 'l')), true, 'пункт без блока — в секции без заголовка');

  // чистая функция: store не меняет, ui не читает
  const before = JSON.stringify(app.store);
  app.blockTally(utro(), R2_T);
  assert.equal(JSON.stringify(app.store), before);
  assert.doesNotMatch(app.blockTally.toString(), /\bui\b/, 'развёртку владельца решает интерфейс, не счёт');
  clearLocalStorage();
});

/* ══ Задача Р2: ремонт по рецензии ═══════════════════════════════ */

test('Р2/рецензия: переименование — убранный одноимённый блок другого режима живых глобальных пунктов не держит; store остаётся каноном', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Каникулы')];
  const since = '2026-08-31';
  s.groups = [r2Block('Утро', 'main'), r2Block('Утро', 'x')];
  s.items = [
    r2Act('am', since, 'Утро', R1_WEEK, 'main'),
    r2Act('ax', since, 'Утро', R1_WEEK, 'x'),
    r1Item('h', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7 }),
    r2Weekly('w', since, 'Утро', 2)
  ];
  const byIdOf = id => s.items.find(i => i.id === id);
  const shape = st => JSON.stringify({ groups: st.groups, items: st.items });

  assert.equal(app.removeGroup('Утро', 'x'), true, 'уход «Утра» другого режима');
  assert.deepEqual(['h', 'w'].map(id => byIdOf(id).removedAt), [null, null], 'живое «Утро» основного держит глобальные');
  advanceDays(1); // 15.09
  const r = app.updateGroup('Утро', { name: 'Morning' }, 'main');
  assert.deepEqual(r, { ok: true, name: 'Morning' });
  assert.deepEqual(['am', 'ax', 'h', 'w'].map(id => byIdOf(id).group), ['Morning', 'Утро', 'Morning', 'Morning'],
    'привычка и счётчик идут за переименованием: у старого имени живого блока не осталось');
  const secs = app.groupedItems(s.items.filter(i => app.live(i)), 'main')
    .map(x => (x.group ? x.group.name : '—') + ':' + x.items.map(i => i.id).join(','));
  assert.deepEqual(secs, ['Morning:am,h,w'], 'пункты не выпали из блока, где только что стояли');
  const m = app.migrate(JSON.parse(JSON.stringify(s)));
  assert.equal(shape(m), shape(s), 'migrate(store) ≡ store: старт убранный блок не оживляет');
  assert.equal(s.groups.find(g => g.mode === 'x').removedAt, R2_T, '«Утро» режима x осталось убранным');
  assert.equal(app.restoreGroup('Утро', 'x'), true, 'и возвращается только владельцем');
  assert.deepEqual(s.items.filter(i => app.live(i) && i.name === 'ax').map(i => [i.mode, i.group]), [['x', 'Утро']]);
  clearLocalStorage();
});

/* Было «убранный одноимённый блок держит глобальные пункты, ушедшие с ним в
   один день, и только их». Решение архитектора по вопросу Р2 № 3 (задача Р3,
   п. 0.3): держит только живой блок живого режима — убранный не держит никого,
   в том числе ушедших с ним в один день. Сценарий тот же; изменились ожидания
   у «h»: она идёт за переименованием, стоит в «Убранных» под новым именем, а
   возврат «Утра» режима x её уже не уводит. «h2» — как было. */
test('Р3/0.3: переименование — убранный одноимённый блок не держит глобальных пунктов, в том числе ушедших с ним в один день', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Каникулы')];
  const since = '2026-08-31';
  s.groups = [r2Block('Утро', 'x')];
  s.items = [
    r2Act('ax', since, 'Утро', R1_WEEK, 'x'),
    r1Item('h', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7 }),
    r1Item('h2', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7, removedAt: '2026-09-13' })
  ];
  const byIdOf = id => s.items.find(i => i.id === id);

  assert.equal(app.removeGroup('Утро', 'x'), true);
  assert.equal(byIdOf('h').removedAt, R2_T, 'живого одноимённого нет — привычка ушла с блоком');
  assert.equal(app.addGroup('Утро', '', undefined, 'main'), true, 'одноимённый блок заведён в основном');
  assert.deepEqual(app.updateGroup('Утро', { name: 'Рассвет' }, 'main'), { ok: true, name: 'Рассвет' });
  assert.equal(byIdOf('h').group, 'Рассвет', 'ушедшая с «Утром» x в тот же день — идёт за переименованием: убранный блок не держит');
  assert.equal(byIdOf('h2').group, 'Рассвет', 'убранная поштучно в другой день — тоже');
  assert.equal(byIdOf('ax').group, 'Утро', 'действие режима x — при своём блоке');
  assert.equal(app.goneBesideBlock(byIdOf('h')), true, 'дорога назад у неё одна — строка «Убранных» под новым именем');
  assert.equal(app.goneBesideBlock(byIdOf('h2')), true);
  assert.equal(app.restoreGroup('Утро', 'x'), true);
  assert.deepEqual([byIdOf('h').removedAt, byIdOf('h').group], [R2_T, 'Рассвет'], 'возврат «Утра» x её не уводит: она при другом имени');
  assert.equal(byIdOf('h2').removedAt, '2026-09-13');
  assert.equal(app.restoreItem('h').id, 'h', 'возвращается своей строкой — той же записью');
  assert.deepEqual([byIdOf('h').removedAt, byIdOf('h').group], [null, 'Рассвет'], 'в тот же день — полная отмена, под живым «Рассветом»');
  clearLocalStorage();
});

test('Р2/рецензия: возврат блока — одноимённые блоки двух режимов убраны в один день; возвращаются действия только режима блока (restoreSetOf)', () => {
  const setup = () => {
    const s = r2Store();
    s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Каникулы')];
    const since = '2026-08-31';
    s.groups = [r2Block('Утро', 'main'), r2Block('Утро', 'x')];
    s.items = [
      r2Act('am', since, 'Утро', R1_WEEK, 'main'),
      r2Act('ax', since, 'Утро', R1_WEEK, 'x'),
      r1Item('h', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7 })
    ];
    assert.equal(app.removeGroup('Утро', 'x'), true);
    assert.equal(app.removeGroup('Утро', 'main'), true);
    return s;
  };
  const ids = arr => arr.map(i => i.id).sort();

  let s = setup();
  assert.deepEqual(s.items.map(i => i.removedAt), [R2_T, R2_T, R2_T], 'все ушли в один день');
  assert.deepEqual(ids(app.restoreSetOf(app.findGroup('Утро', 'main'))), ['am', 'h'], 'действие режима x в набор основного не входит');
  assert.deepEqual(ids(app.restoreSetOf(app.findGroup('Утро', 'x'))), ['ax', 'h']);
  assert.equal(app.restoreGroup('Утро', 'main'), true, 'в тот же день — полная отмена');
  assert.deepEqual(s.items.map(i => [i.id, i.removedAt]), [['am', null], ['ax', R2_T], ['h', null]]);
  assert.equal(app.findGroup('Утро', 'x').removedAt, R2_T, 'блок режима x остался убранным');
  assert.equal(app.migrate(JSON.parse(JSON.stringify(s))).groups.find(g => g.mode === 'x').removedAt, R2_T, 'и старт его не оживляет');
  clearLocalStorage();

  s = setup();
  advanceDays(1); // 15.09 — возврат позже заводит новые записи
  assert.equal(app.restoreGroup('Утро', 'main'), true);
  assert.deepEqual(s.items.filter(i => app.live(i)).map(i => [i.name, i.addedAt]).sort(), [['am', '2026-09-15'], ['h', '2026-09-15']],
    'новые записи — только своего режима и глобальная');
  assert.equal(s.items.filter(i => i.name === 'ax').length, 1, 'копии действия режима x не заведено');
  assert.equal(s.items.find(i => i.name === 'ax').removedAt, R2_T);
  assert.equal(app.findGroup('Утро', 'x').removedAt, R2_T);
  clearLocalStorage();
});

test('Р2/рецензия: hasLiveNamesake — живой одноимённый блок другого режима; убранный и сам блок не в счёт', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Каникулы')];
  s.groups = [r2Block('Утро', 'main'), r2Block('Утро', 'x'), r2Block('Школа', 'main'), r2Block('Школа', 'x', [], '2026-09-10')];
  const [um, ux, sm, sx] = s.groups;
  assert.equal(app.hasLiveNamesake(um), true);
  assert.equal(app.hasLiveNamesake(ux), true);
  assert.equal(app.hasLiveNamesake(sm), false, 'одноимённый убран');
  assert.equal(app.hasLiveNamesake(sx), true, 'для убранного — живой в другом режиме');
  s.groups = [um];
  assert.equal(app.hasLiveNamesake(um), false, 'сам блок себе не тёзка');
  clearLocalStorage();
});

/* ══ Задача Р3, п. 0: решения архитектора по вопросам Р2 ═══════════
   Сегодня — понедельник 14.09.2026 (r2Store). */

test('Р3/0.3: блок убранного режима имени не держит — уход одноимённого блока уводит глобальные пункты, возврат возвращает; «Убранные» — тем же правилом', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Каникулы', '2026-09-10')];
  const since = '2026-08-31';
  s.groups = [r2Block('Утро', 'main'), r2Block('Утро', 'x')];
  s.items = [
    r2Act('am', since, 'Утро', R1_WEEK, 'main'),
    r2Act('ax', since, 'Утро', R1_WEEK, 'x'),
    r1Item('h', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7 }),
    r2Weekly('w', since, 'Утро', 2)
  ];
  const [um, ux] = s.groups;
  const byIdOf = id => s.items.find(i => i.id === id);
  assert.deepEqual([app.holdsName(um), app.holdsName(ux)], [true, false], 'живой блок убранного режима имени не держит');
  assert.equal(app.holdsName(Object.assign({}, um, { removedAt: '2026-09-12' })), false, 'убранный блок — тоже');
  assert.equal(app.hasLiveNamesake(um), false, 'тёзка «Утра» основного — в убранном режиме');
  assert.equal(app.hasLiveNamesake(ux), true, 'для блока убранного режима тёзка основного жив');

  assert.equal(app.removeGroup('Утро', 'main'), true);
  assert.deepEqual(s.items.map(i => [i.id, i.removedAt]), [['am', R2_T], ['ax', null], ['h', R2_T], ['w', R2_T]],
    'привычка и счётчик ушли вместе с блоком: держать их некому');
  assert.deepEqual(['h', 'w'].map(id => app.goneBesideBlock(byIdOf(id))), [false, false], 'в «Убранных» их нет — дорога назад через блок');
  assert.deepEqual(app.restoreSetOf(um).map(i => i.id), ['am', 'h', 'w'], 'возврат блока берёт их');
  const shape = st => JSON.stringify({ groups: st.groups, items: st.items });
  assert.equal(shape(app.migrate(JSON.parse(JSON.stringify(s)))), shape(s), 'старт ничего не оживляет');

  advanceDays(1); // 15.09 — возврат позже заводит новые записи
  assert.equal(app.restoreGroup('Утро', 'main'), true);
  assert.deepEqual(s.items.filter(i => app.live(i)).map(i => [i.name, i.addedAt]).sort(),
    [['am', '2026-09-15'], ['ax', since], ['h', '2026-09-15'], ['w', '2026-09-15']], 'глобальные пункты вернулись с блоком');

  // правило читает режимы store, а не память: режим вернулся — его блок держит снова
  assert.equal(app.restoreMode('x').ok, true);
  assert.deepEqual([app.holdsName(ux), app.hasLiveNamesake(um)], [true, true]);
  assert.equal(app.removeGroup('Утро', 'main'), true);
  assert.equal(s.items.filter(i => (i.name === 'h' || i.name === 'w') && app.live(i)).length, 2, 'живой тёзка живого режима держит, как в Р2');

  // режим тёзки убран уже после: привычка жива, держащего блока нет — она
  // «без блока», а старт убранное «Утро» основного молча не оживляет
  assert.equal(app.removeMode('x').ok, true);
  const liveH = s.items.filter(i => i.name === 'h' && app.live(i));
  assert.deepEqual(app.habitSections(liveH, 'main').map(x => x.name), [null], 'держащего нет — без блока');
  assert.equal(shape(app.migrate(JSON.parse(JSON.stringify(s)))), shape(s), 'migrate считает живым и блок убранного режима: оживлять нечего');
  clearLocalStorage();
});

test('Р3/0.3: переименование — блок убранного режима имени не держит: глобальные пункты идут за именем; тёзка живого режима держит, как прежде', () => {
  const setup = xRemovedAt => {
    const s = r2Store();
    s.modes = [r2Mode('main', 'Основной'), r2Mode('x', 'Каникулы', xRemovedAt)];
    const since = '2026-08-31';
    s.groups = [r2Block('Утро', 'main'), r2Block('Утро', 'x')];
    s.items = [
      r2Act('am', since, 'Утро', R1_WEEK, 'main'),
      r2Act('ax', since, 'Утро', R1_WEEK, 'x'),
      r1Item('h', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7 }),
      r2Weekly('w', since, 'Утро', 2),
      r1Item('hg', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7, removedAt: '2026-09-12' })
    ];
    return s;
  };
  const groupsOf = s => s.items.map(i => [i.id, i.group]);

  let s = setup('2026-09-10');
  assert.deepEqual(app.updateGroup('Утро', { name: 'Рассвет' }, 'main'), { ok: true, name: 'Рассвет' });
  assert.deepEqual(groupsOf(s), [['am', 'Рассвет'], ['ax', 'Утро'], ['h', 'Рассвет'], ['w', 'Рассвет'], ['hg', 'Рассвет']],
    'тёзка — в убранном режиме: глобальные пункты, живые и убранные, идут за именем; действие режима x — при своём блоке');
  assert.deepEqual(app.habitSections(s.items.filter(i => i.area === 'habit' && app.live(i)), 'main')
    .map(x => [x.name, x.group === s.groups[0], x.items.map(i => i.id)]),
  [['Рассвет', true, ['h']]], 'привычка стоит под переименованным блоком, а не «без блока»');
  assert.equal(app.goneBesideBlock(s.items.find(i => i.id === 'hg')), true, 'убранная — в «Убранных» под новым именем');
  clearLocalStorage();

  s = setup(null);
  assert.deepEqual(app.updateGroup('Утро', { name: 'Рассвет' }, 'main'), { ok: true, name: 'Рассвет' });
  assert.deepEqual(groupsOf(s), [['am', 'Рассвет'], ['ax', 'Утро'], ['h', 'Утро'], ['w', 'Утро'], ['hg', 'Утро']],
    'живой тёзка живого режима держит все глобальные — и живые, и убранные');
  clearLocalStorage();
});

test('Р3/0.2: habitSections — блоки активного режима (с блоком), затем прочие имена (без блока), пункты без блока последними; имя блока убранного режима — без блока', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('kan', 'Каникулы'), r2Mode('old', 'Прошлое', '2026-09-01')];
  const since = '2026-08-31';
  s.groups = [
    r2Block('Лагерь', 'kan'), r2Block('Утро', 'main', [], null, '7:00'), r2Block('Школа', 'main'),
    r2Block('Утро', 'kan', [], null, '9:00'), r2Block('Сад', 'old'), r2Block('Поле', 'main', [], '2026-09-05'),
    r2Block('Пусто', 'main')
  ];
  const habit = (id, group, extra) => r1Item(id, since, group, R1_WEEK, Object.assign({ area: 'habit', normPerWeek: 7 }, extra || {}));
  s.items = [
    habit('hL', 'Лагерь'), habit('h0', ''), habit('hU', 'Утро'), r2Param('pS', since, 'Школа'),
    habit('hC', 'Сад'), habit('hP', 'Поле'), habit('hN', 'Нигде'), habit('hU2', 'Утро')
  ];
  const lay = mode => app.habitSections(s.items, mode)
    .map(x => [x.name, x.group ? x.group.mode + ':' + x.group.caption : null, x.items.map(i => i.id)]);
  assert.deepEqual(lay('main'), [
    ['Утро', 'main:7:00', ['hU', 'hU2']], ['Школа', 'main:', ['pS']], ['Лагерь', null, ['hL']],
    [null, null, ['h0', 'hC', 'hP', 'hN']]
  ], 'основной: его блоки по порядку с самим блоком, затем «Лагерь» без блока — подпись чужого режима не печатается; без блока — пустое имя, имя блока убранного режима, убранный блок и неизвестное имя');
  assert.deepEqual(lay('kan'), [
    ['Лагерь', 'kan:', ['hL']], ['Утро', 'kan:9:00', ['hU', 'hU2']], ['Школа', null, ['pS']],
    [null, null, ['h0', 'hC', 'hP', 'hN']]
  ], 'каникулы: порядок — их блоков, одноимённое «Утро» — их блок; каждая привычка под тем же именем');
  assert.deepEqual(app.habitSections(s.items), app.habitSections(s.items, 'main'), 'режим не назван — активный');
  assert.ok(!lay('main').some(x => x[0] === 'Пусто'), 'пустых секций нет');
  assert.deepEqual(app.habitSections([], 'main'), []);
  assert.equal(app.goneBesideBlock(habit('hG', 'Сад', { removedAt: '2026-09-10' })), true,
    'имя живёт только в блоке убранного режима, убранного блока нет — строка «Убранных» остаётся дорогой назад');

  assert.equal(app.restoreMode('old').ok, true);
  assert.deepEqual(lay('main').map(x => x[0]), ['Утро', 'Школа', 'Лагерь', 'Сад', null], 'режим вернулся — имя его блока снова заголовок');
  clearLocalStorage();
});

test('Р2/рецензия: режимы — содержание store: чистка, «Вернуть» и импорт кладут их в копию; стартовый основной содержанием не считается', () => {
  const mem = fakeLocalStorage();
  setNow(2026, 9, 14, 12, 0);
  app.store = app.emptyStore(4, 0.8);
  const st = () => app.wipeStats(app.store);
  assert.deepEqual([st().modes, st().modeLog, app.hasData(app.store)], [0, 0, false], 'пустой store с основным — пуст');

  const r = app.addMode('Лето');
  assert.equal(r.ok, true);
  assert.deepEqual([st().modes, st().modeLog, app.hasData(app.store)], [1, 0, true], 'заведённый режим — содержание');
  assert.equal(app.setActiveMode(r.id).ok, true);
  assert.equal(st().modeLog, 1);

  // чистка store из одних режимов кладёт их в копию — прежде копии не было вовсе
  assert.equal(app.wipeAll(), true);
  const c = app.wipedCopy();
  assert.ok(c, 'копия есть');
  assert.deepEqual([c.kind, c.stats.modes, c.stats.modeLog], ['wipe', 1, 1]);
  assert.deepEqual(c.store.modes.map(m => m.name), ['Основной', 'Лето']);
  assert.deepEqual(app.store.modes.map(m => m.id), ['main'], 'чистый лист — один основной');
  assert.equal(app.restoreWiped(), true);
  assert.deepEqual(app.store.modes.map(m => m.name), ['Основной', 'Лето'], '«Вернуть» вернуло режим');
  assert.equal(app.activeMode(), r.id, 'и выбор');
  assert.equal(mem[app.WIPE_KEY], undefined, 'нынешнее было пустым — копия ушла');

  // обратный обмен: практика в копии, в рабочей — только новый режим
  app.store = freshStore();
  assert.equal(app.wipeAll(), true);
  assert.equal(app.addMode('Школа').ok, true);
  assert.equal(app.restoreWiped(), true);
  const back = app.wipedCopy();
  assert.ok(back, 'нынешнее с режимом легло в копию, а не пропало');
  assert.deepEqual([back.kind, back.store.modes.map(m => m.name)], ['restore', ['Основной', 'Школа']]);
  assert.equal(app.restoreWiped(), true);
  assert.deepEqual(app.store.modes.map(m => m.name), ['Основной', 'Школа']);

  // импорт идёт тем же keepPrev
  app.store = app.emptyStore(4, 0.8);
  assert.equal(app.renameMode('main', 'Будни').ok, true);
  assert.deepEqual([st().modes, app.hasData(app.store)], [1, true], 'переименованный основной — слово владельца');
  delete mem[app.WIPE_KEY];
  assert.equal(app.keepPrev(app.store, 'import'), true);
  assert.deepEqual([app.wipedCopy().kind, app.wipedCopy().store.modes[0].name], ['import', 'Будни']);
  clearLocalStorage();
});

/* ── Задача Р3, пп. 1–3: обновление приложения ─────────────────
   Номер версии страница узнаёт у воркера и печатает коротким («v48»);
   автопроверка обновления — не чаще раза в UPDATE_CHECK_MS. Обе функции
   чистые: всё прочее живёт на service worker API и закреплено
   интерфейсным уровнем (dom.test.js, подмена navigator.serviceWorker). */

test('Р3/2: versionLabel — «minimum-vN» → «vN», всё вне формата — null', () => {
  assert.equal(app.versionLabel('minimum-v48'), 'v48');
  assert.equal(app.versionLabel('minimum-v49'), 'v49');
  assert.equal(app.versionLabel('minimum-v1'), 'v1');
  assert.equal(app.versionLabel('minimum-v100'), 'v100', 'номер любой длины');
  // формат замка версии (tools/deploy-hash.mjs): строго minimum-v{целое}
  for (const bad of ['minimum-v48a', 'minimum-48', 'v48', 'minimum-v', 'Minimum-v48', ' minimum-v48',
    'minimum-v48 ', 'minimum-v4.8', 'other-v48', '']) {
    assert.equal(app.versionLabel(bad), null, JSON.stringify(bad));
  }
  // чужой ответ воркера: не строка — не номер
  for (const bad of [undefined, null, 48, {}, ['minimum-v48'], true]) {
    assert.equal(app.versionLabel(bad), null, String(bad));
  }
});

test('Р3/2: updateCheckDue — первая проверка сразу, дальше не чаще UPDATE_CHECK_MS; часы назад и мусор не запирают', () => {
  const N = app.TIMING_DEFAULTS.UPDATE_CHECK_MS;
  assert.equal(N, 600000, 'рантайм — 10 минут');
  const t0 = 1_800_000_000_000;
  // первой проверки не было
  assert.equal(app.updateCheckDue(null, t0), true);
  assert.equal(app.updateCheckDue(undefined, t0), true);
  assert.equal(app.updateCheckDue(NaN, t0), true);
  // сразу после — рано, граница включительно пропускает
  assert.equal(app.updateCheckDue(t0, t0), false, 'в тот же миг');
  assert.equal(app.updateCheckDue(t0, t0 + 1), false);
  assert.equal(app.updateCheckDue(t0, t0 + N - 1), false, 'на миллисекунду раньше срока');
  assert.equal(app.updateCheckDue(t0, t0 + N), true, 'ровно через 10 минут — пора');
  assert.equal(app.updateCheckDue(t0, t0 + N * 6), true);
  // часы ушли назад: метка из «будущего» не запирает автопроверку на весь сдвиг
  assert.equal(app.updateCheckDue(t0, t0 - 1), true);
  assert.equal(app.updateCheckDue(t0, t0 - 86400000), true);
  // нечисловое «сейчас» — проверка разрешена: лишний update() ничего не стоит
  assert.equal(app.updateCheckDue(t0, NaN), true);
  // чистая: вход не меняется, ответ повторяем
  assert.equal(app.updateCheckDue(t0, t0 + 5), app.updateCheckDue(t0, t0 + 5));
});

/* ── Р3/рецензия: ремонт после рецензии ─────────────────────── */

/* Раскладка и соседство привычек — одно правило. С задачи Р3 имя, которое
   держит только блок убранного режима, стоит в «Без блока» рядом с
   пунктами без блока; соседи по сырому item.group оставляли такую строку
   посреди списка с обеими неактивными стрелками, а соседнюю уводили через
   её голову (замер рецензии: A↓ давало [B, L, A]). */
test('Р3/рецензия: соседи привычки и параметра — строки её секции habitSections; имя блока убранного режима — соседи «Без блока»; режим вернулся — снова свой блок', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной'), r2Mode('kan', 'Каникулы')];
  const since = '2026-08-31';
  s.groups = [r2Block('Утро', 'main'), r2Block('Лагерь', 'kan')];
  const habit = (id, group, extra) => r1Item(id, since, group, R1_WEEK, Object.assign({ area: 'habit', normPerWeek: 7 }, extra || {}));
  s.items = [
    habit('A', ''), habit('L', 'Лагерь'), habit('G', '', { removedAt: '2026-09-10' }), r2Param('P', since, ''),
    habit('U', 'Утро'), habit('B', '')
  ];
  const byId = id => s.items.find(i => i.id === id);
  const order = () => s.items.map(i => i.id).join('');
  const arrows = id => [app.canMoveItem(id, 'up'), app.canMoveItem(id, 'down')];

  // режим «Каникулы» жив: «Лагерь» — своя секция, L в ней один
  assert.equal(app.habitSectionName(byId('L')), 'Лагерь');
  assert.deepEqual(arrows('L'), [false, false], 'один в своём блоке — двигать некуда');
  assert.deepEqual(['A', 'P', 'B'].map(arrows), [[false, true], [true, true], [true, false]], '«Без блока» — A, P, B');

  assert.equal(app.removeMode('kan').ok, true);
  assert.equal(app.habitSectionOf(byId('L')).name, null, 'держащего блока нет — L в «Без блока»');
  assert.equal(app.habitSectionName(byId('L')), '', 'имя секции для перетаскивания — «Без блока»');
  assert.equal(app.habitSectionName(byId('U')), 'Утро');
  assert.deepEqual(['A', 'L', 'P', 'B'].map(arrows), [[false, true], [true, true], [true, true], [true, false]],
    'в видимом списке A, L, P, B у каждой строки стрелки — к видимому соседу; ни одна живая не заперта');
  assert.deepEqual(arrows('U'), [false, false], 'чужая секция в соседи не попадает');
  assert.deepEqual(arrows('G'), [false, false], 'убранный не двигается и соседом не считается');

  assert.equal(app.moveItem('A', 'down'), true);
  assert.equal(order(), 'LAGPUB', 'A встал за L — на одну строку, а не через голову L');
  assert.equal(app.moveItem('L', 'up'), false, 'L теперь первый в «Без блока»');
  assert.equal(app.moveItem('P', 'down'), true);
  assert.equal(order(), 'LAGBUP', 'P перепрыгнул U чужой секции и убранного G не трогал — обмен с B');
  assert.equal(app.reorderItem('L', 3), true);
  assert.equal(order(), 'ABGPUL', 'перетаскивание — позиция среди тех же четырёх');
  assert.equal(byId('G'), s.items[2], 'убранный остался на своём месте items[]');

  // режим вернулся — L снова под «Лагерем», и соседи у него только свои
  assert.equal(app.restoreMode('kan').ok, true);
  assert.equal(app.habitSectionName(byId('L')), 'Лагерь');
  assert.deepEqual(arrows('L'), [false, false]);
  assert.deepEqual(['A', 'B', 'P'].map(arrows), [[false, true], [true, true], [true, false]]);
  // пункт не из store секции не имеет
  assert.equal(app.habitSectionOf(habit('X', '')), null);
  assert.equal(app.habitSectionName(habit('X', '')), '');
  clearLocalStorage();
});

/* Ветка holdsName «режима блока нет в store.modes — блок читается живым»
   (выживший мутант R3-блок-без-записи-режима-не-держит). После migrate она
   недостижима — неизвестный режим переводится в основной, — но holdsName
   читает store напрямую, и запись, собранная без режима (или с режимом,
   которого нет), держит имя, как блок без поля читается основным. */
test('Р3/рецензия: holdsName — блок живой записи с режимом, которого нет в store.modes, держит имя; hasLiveNamesake и уход блока его учитывают', () => {
  const s = r2Store();
  s.modes = [r2Mode('main', 'Основной')];
  const since = '2026-08-31';
  s.groups = [r2Block('Утро', 'main'), r2Block('Утро', 'ghost'), r2Block('Сон', 'ghost')];
  s.items = [
    r2Act('am', since, 'Утро', R1_WEEK, 'main'),
    r1Item('h', since, 'Утро', R1_WEEK, { area: 'habit', normPerWeek: 7 }),
    r1Item('hs', since, 'Сон', R1_WEEK, { area: 'habit', normPerWeek: 7 })
  ];
  const [um, ug, sg] = s.groups;
  assert.equal(app.holdsName(ug), true, 'режима нет в store — блок живой записи держит');
  assert.equal(app.holdsName(sg), true);
  assert.equal(app.holdsName(Object.assign({}, ug, { removedAt: '2026-09-12' })), false, 'убранный — нет, режим тут ни при чём');
  assert.equal(app.hasLiveNamesake(um), true, 'тёзка без записи режима — живой тёзка');
  assert.deepEqual(app.habitSections(s.items.filter(i => i.area === 'habit'), 'main').map(x => [x.name, x.items.map(i => i.id)]),
    [['Утро', ['h']], ['Сон', ['hs']]], '«Сон» — заголовок, а не «Без блока»');
  assert.equal(app.removeGroup('Утро', 'main'), true);
  assert.deepEqual(s.items.map(i => [i.id, i.removedAt]), [['am', R2_T], ['h', null], ['hs', null]],
    'привычку держит тёзка — с блоком основного она не уходит');
  clearLocalStorage();
});
