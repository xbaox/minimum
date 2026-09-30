process.env.TZ = 'America/Toronto';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../domain.js';
import { ICON_IDS } from '../icons.js';

const ids = () => { let n = 0; return () => 'i' + ++n; };
const mk = createdAt => D.seed(createdAt, ids());
const closeDay = (s, d) => { s.days[d] = { plan: D.activeIds(s), done: D.activeIds(s) }; };
const missDay = (s, d) => { s.days[d] = { plan: D.activeIds(s), done: [] }; };

test('логический день: граница 03:59 / 04:00', () => {
  assert.equal(D.logicalDate(new Date(2026, 8, 29, 3, 59)), '2026-09-28');
  assert.equal(D.logicalDate(new Date(2026, 8, 29, 4, 0)), '2026-09-29');
  assert.equal(D.logicalDate(new Date(2026, 8, 29, 23, 59)), '2026-09-29');
  assert.equal(D.logicalDate(new Date(2026, 8, 30, 0, 30)), '2026-09-29');
});

test('переход времени 2026-11-01 не сдвигает дни', () => {
  assert.equal(D.logicalDate(new Date(2026, 10, 1, 1, 30)), '2026-10-31');
  assert.equal(D.logicalDate(new Date(2026, 10, 1, 3, 59)), '2026-10-31');
  assert.equal(D.logicalDate(new Date(2026, 10, 1, 4, 0)), '2026-11-01');
  assert.equal(D.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(D.addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(D.diffDays('2026-10-25', '2026-11-08'), 14);
  // 12:00 → 04:00 следующего дня: 16 ч + лишний час осеннего перевода
  assert.equal(D.msToNextDay(new Date(2026, 9, 31, 12, 0)), 17 * 3600e3);
});

test('переход времени 2027-03-14 не сдвигает дни', () => {
  assert.equal(D.logicalDate(new Date(2027, 2, 14, 3, 30)), '2027-03-13');
  assert.equal(D.logicalDate(new Date(2027, 2, 14, 4, 0)), '2027-03-14');
  assert.equal(D.addDays('2027-03-13', 2), '2027-03-15');
  assert.deepEqual(D.range('2027-03-13', '2027-03-15'), ['2027-03-13', '2027-03-14', '2027-03-15']);
  assert.equal(D.msToNextDay(new Date(2027, 2, 13, 12, 0)), 15 * 3600e3);
});

test('неделя пн–вс', () => {
  assert.equal(D.weekday('2026-09-28'), 0);
  assert.equal(D.weekday('2026-10-04'), 6);
  assert.equal(D.weekStart('2026-10-04'), '2026-09-28');
  assert.equal(D.weekStart('2026-10-05'), '2026-10-05');
  assert.equal(D.weekStart('2026-11-01'), '2026-10-26');
});

test('шаблон валиден: 8 + 1, id уникальны, цвета из палитры', () => {
  const s = D.seed('2026-09-30');
  assert.equal(s.items.length, 8);
  assert.equal(s.weekly.length, 1);
  const all = [...s.items, ...s.weekly];
  assert.equal(new Set(all.map(i => i.id)).size, 9);
  for (const i of all) assert.ok(D.COLORS.includes(i.color), i.color);
  for (const i of all) assert.ok(ICON_IDS.includes(i.icon), i.icon);
  assert.deepEqual(s.items.map(i => i.icon), ['sunrise', 'dumbbell', 'book', 'headphones', 'bed', 'drop', 'bottle', 'phone']);
  assert.deepEqual(s.items.map(i => i.color), ['orange', 'red', 'purple', 'blue', 'mint', 'teal', 'pink', 'indigo']);
  assert.deepEqual([s.weekly[0].icon, s.weekly[0].color], ['pulse', 'green']);
  assert.ok(all.every(i => !('emoji' in i)));
  // число с единицей не разрывается переносом
  assert.equal(s.items[2].note, '10\u00a0минут · книга, вникай в суть');
  assert.match(s.weekly[0].note, /бег 1\u00a0км/);
  assert.equal(s.items[7].beforeBed, 30);
  assert.equal(s.weekly[0].perWeek, 3);
  assert.equal(s.sleep.targets[0].bed, '01:00');
  assert.equal(s.sleep.goalBed, '23:30');
  assert.equal(s.sleep.goalWake, '07:30');
  assert.equal(s.since, '2026-07-20');
  assert.deepEqual(D.normalize(s, '2026-09-30'), s);
});

test('статусы дня, включая день посева', () => {
  const s = mk('2026-09-01');
  const today = '2026-09-05';
  assert.equal(D.status(s, '2026-08-31', today), 'none');
  assert.equal(D.status(s, '2026-09-01', today), 'none'); // посев не закрыт — не пропуск
  closeDay(s, '2026-09-01');
  assert.equal(D.status(s, '2026-09-01', today), 'closed');
  assert.equal(D.status(s, '2026-09-02', today), 'miss'); // без записи
  missDay(s, '2026-09-03');
  assert.equal(D.status(s, '2026-09-03', today), 'miss');
  s.days['2026-09-04'] = { plan: [], done: [] };
  assert.equal(D.status(s, '2026-09-04', today), 'none'); // пустой план
  assert.equal(D.status(s, today, today), 'pending');
  closeDay(s, today);
  assert.equal(D.status(s, today, today), 'closed');
  assert.equal(D.status(s, '2026-09-06', today), 'none');
});

test('серия: З З П З → 3, З П П З → 1, сегодня pending — не пропуск', () => {
  let s = mk('2026-09-01');
  closeDay(s, '2026-09-02'); closeDay(s, '2026-09-03'); missDay(s, '2026-09-04'); closeDay(s, '2026-09-05');
  assert.equal(D.history(s, '2026-09-06').streak, 3);
  s = mk('2026-09-01');
  closeDay(s, '2026-09-02'); missDay(s, '2026-09-03'); missDay(s, '2026-09-04'); closeDay(s, '2026-09-05');
  assert.equal(D.history(s, '2026-09-06').streak, 1);
  closeDay(s, '2026-09-06');
  assert.equal(D.history(s, '2026-09-06').streak, 2); // сегодня закрыт — считается
});

test('одиночный вчерашний пропуск не рвёт, второй — рвёт', () => {
  const s = mk('2026-09-01');
  closeDay(s, '2026-09-02'); closeDay(s, '2026-09-03');
  const h = D.history(s, '2026-09-05'); // 09-04 без записи = пропуск, сегодня pending
  assert.equal(h.streak, 2);
  assert.equal(h.marks['2026-09-04'], 'forgiven');
  assert.equal(h.marks['2026-09-05'], 'pending');
  const h2 = D.history(s, '2026-09-06');
  assert.equal(h2.streak, 0);
  assert.equal(h2.marks['2026-09-04'], 'break');
  assert.equal(h2.marks['2026-09-05'], 'break');
});

test('рекорд — максимум по всей истории', () => {
  const s = mk('2026-09-01');
  for (const d of ['02', '03', '05', '06']) closeDay(s, '2026-09-' + d); // 04 прощён → 4
  missDay(s, '2026-09-07'); missDay(s, '2026-09-08');
  closeDay(s, '2026-09-09');
  const h = D.history(s, '2026-09-10');
  assert.equal(h.best, 4);
  assert.equal(h.streak, 1);
});

test('живой план сегодня, замороженный — позавчера', () => {
  const s = mk('2026-09-01');
  const today = '2026-09-10';
  D.syncToday(s, '2026-09-08');
  const before = s.days['2026-09-08'].plan.slice();
  const it = D.addItem(s, { name: 'Вода', icon: 'glass', color: 'teal' }, false, today, () => 'new');
  assert.deepEqual([it.icon, it.color], ['glass', 'teal']);
  assert.ok(D.planOf(s, today, today).includes(it.id));
  assert.deepEqual(D.planOf(s, '2026-09-08', today), before);
  D.archiveItem(s, s.items[0].id, today);
  assert.ok(!D.planOf(s, today, today).includes(s.items[0].id));
  assert.equal(D.planOf(s, '2026-09-08', today).length, 8);
  // день без записи восстанавливается по addedAt/archivedAt
  assert.equal(D.planOf(s, '2026-09-05', today).length, 8);
});

test('вчера правится (запись создаётся с активными пунктами), позавчера — нет', () => {
  const s = mk('2026-09-01');
  const today = '2026-09-10', id = s.items[0].id;
  assert.ok(D.toggleDone(s, '2026-09-09', id, today));
  assert.deepEqual(s.days['2026-09-09'], { plan: D.activeIds(s), done: [id] });
  assert.equal(D.toggleDone(s, '2026-09-08', id, today), false);
  assert.equal(s.days['2026-09-08'], undefined);
  assert.ok(D.toggleDone(s, '2026-09-09', id, today));
  assert.deepEqual(s.days['2026-09-09'].done, []);
  // до посева — нельзя
  const s2 = mk('2026-09-10');
  assert.equal(D.toggleDone(s2, '2026-09-09', s2.items[0].id, '2026-09-10'), false);
});

test('недельный счёт пн–вс, не больше одной отметки в день', () => {
  const s = mk('2026-09-01');
  const id = s.weekly[0].id;
  D.toggleWeekMark(s, id, '2026-09-28');
  D.toggleWeekMark(s, id, '2026-10-04');
  D.toggleWeekMark(s, id, '2026-10-05');
  assert.equal(D.weekCount(s, id, '2026-10-01'), 2);
  assert.equal(D.weekCount(s, id, '2026-10-05'), 1);
  D.toggleWeekMark(s, id, '2026-10-04');
  assert.equal(D.weekCount(s, id, '2026-09-30'), 1);
});

test('сон: нормализация, «в цель», длительность', () => {
  assert.equal(D.norm('01:00'), 1500);
  assert.equal(D.norm('23:30'), 1410);
  assert.equal(D.norm('11:59'), 719 + 1440);
  assert.equal(D.norm('12:00'), 720);
  assert.equal(D.duration({ bed: '23:30', wake: '07:30' }), 480);
  assert.equal(D.duration({ bed: '01:00', wake: '07:30' }), 390);
  assert.equal(D.duration({ bed: '01:00' }), null);
  const s = mk('2026-09-01');
  s.sleep.nights['2026-09-05'] = { bed: '00:55', wake: '07:30' };
  s.sleep.nights['2026-09-06'] = { bed: '01:05' };
  s.sleep.nights['2026-09-07'] = { wake: '07:00' };
  assert.equal(D.onTarget(s, '2026-09-05'), true);
  assert.equal(D.onTarget(s, '2026-09-06'), false);
  assert.equal(D.onTarget(s, '2026-09-07'), false);
  assert.equal(D.onTarget(s, '2026-09-08'), false);
});

test('targetFor по истории шагов', () => {
  const s = mk('2026-09-01');
  s.sleep.targets.push({ from: '2026-09-15', bed: '00:30' }, { from: '2026-09-22', bed: '00:15' });
  assert.equal(D.targetFor(s, '2026-09-01'), '01:00');
  assert.equal(D.targetFor(s, '2026-09-14'), '01:00');
  assert.equal(D.targetFor(s, '2026-09-15'), '00:30');
  assert.equal(D.targetFor(s, '2026-09-30'), '00:15');
  assert.equal(D.stepTonight(s, '2026-09-21'), '00:15');
  assert.equal(D.targetFor(s, '2026-09-21'), '00:30');
});

test('дедлайн через полночь', () => {
  assert.equal(D.deadline('00:15', 30), '23:45');
  assert.equal(D.deadline('01:00', 30), '00:30');
  assert.equal(D.deadline('23:30', 30), '23:00');
});

// Неделя 21–27 сентября, сегодня воскресенье 27-го.
const MON = '2026-09-21', SUN = '2026-09-27';
function sleepWeek(onTargetCount, createdAt = '2026-09-01', step = '01:00') {
  const s = mk(createdAt);
  s.sleep.targets = [{ from: createdAt, bed: step }];
  D.range(MON, SUN).forEach((d, i) => {
    s.sleep.nights[d] = { bed: i < onTargetCount ? D.shiftTime(step, -10) : D.shiftTime(step, 30), wake: '07:30' };
  });
  return s;
}
const opts = p => p.options.map(o => `${o.choice}:${o.to}`);

test('предложение: 5/7 → раньше на 30', () => {
  const p = D.proposal(sleepWeek(5), MON, SUN);
  assert.equal(p.K, 5); assert.equal(p.E, 7);
  assert.equal(p.recommended, 'earlier30');
  assert.deepEqual(opts(p), ['earlier30:00:30', 'earlier15:00:45', 'keep:01:00']);
});

test('предложение: 4/7 → оставить, ещё раньше на 15', () => {
  const p = D.proposal(sleepWeek(4), MON, SUN);
  assert.equal(p.recommended, 'keep');
  assert.deepEqual(opts(p), ['keep:01:00', 'earlier15:00:45']);
});

test('предложение: 2/7 → оставить, ещё позже на 15', () => {
  const p = D.proposal(sleepWeek(2), MON, SUN);
  assert.equal(p.recommended, 'keep');
  assert.deepEqual(opts(p), ['keep:01:00', 'later15:01:15']);
});

test('предложение: неполная неделя считается с дня после посева', () => {
  const s = sleepWeek(0, '2026-09-23');
  for (const d of ['2026-09-24', '2026-09-25', '2026-09-26']) s.sleep.nights[d].bed = '00:40';
  const p = D.proposal(s, MON, SUN);
  assert.equal(p.E, 4); assert.equal(p.K, 3);
  assert.equal(p.recommended, 'earlier30');
  // середина недели: утра только до сегодня, без записи — не в цель
  const q = D.proposal(sleepWeek(7), MON, '2026-09-23');
  assert.equal(q.E, 3); assert.equal(q.K, 3);
});

test('предложение: |E| = 0 → только «Оставить», мало данных', () => {
  const p = D.proposal(sleepWeek(7, SUN), MON, SUN);
  assert.equal(p.E, 0);
  assert.equal(p.fewData, true);
  assert.deepEqual(opts(p), ['keep:01:00']);
});

test('предложение: не раньше цели и не позже 03:00', () => {
  let p = D.proposal(sleepWeek(7, '2026-09-01', '23:45'), MON, SUN);
  assert.deepEqual(opts(p), ['earlier15:23:30', 'keep:23:45']);
  assert.equal(p.recommended, 'earlier15');
  p = D.proposal(sleepWeek(7, '2026-09-01', '23:30'), MON, SUN);
  assert.equal(p.atGoal, true);
  assert.deepEqual(opts(p), ['keep:23:30']);
  p = D.proposal(sleepWeek(0, '2026-09-01', '02:50'), MON, SUN);
  assert.deepEqual(opts(p), ['keep:02:50', 'later15:03:00']);
  p = D.proposal(sleepWeek(0, '2026-09-01', '03:00'), MON, SUN);
  assert.deepEqual(opts(p), ['keep:03:00']);
});

test('закрытие недели пишет шаг с завтрашней даты', () => {
  const s = sleepWeek(5);
  assert.ok(D.closeWeek(s, MON, { improvement: ' Книга в кровать ' }, 'earlier30', SUN, 'T'));
  assert.deepEqual(s.reviews[MON].sleep, { from: '01:00', to: '00:30', choice: 'earlier30' });
  assert.equal(s.reviews[MON].improvement, 'Книга в кровать');
  assert.equal(D.targetFor(s, SUN), '01:00');
  assert.equal(D.targetFor(s, '2026-09-28'), '00:30');
  assert.equal(D.stepTonight(s, SUN), '00:30');
  assert.equal(D.weekImprovement(s, '2026-09-28'), 'Книга в кровать');
  assert.equal(D.weekImprovement(s, '2026-10-04'), 'Книга в кровать');
  assert.equal(D.weekImprovement(s, '2026-10-05'), '');
  assert.equal(D.closeWeek(s, MON, {}, 'later15', SUN), false); // нет такой кнопки
  // «Оставить» не плодит записей
  const t = sleepWeek(4);
  D.closeWeek(t, MON, {}, 'keep', SUN);
  assert.equal(t.sleep.targets.length, 1);
});

test('ручная правка шага — с завтрашней даты, повтор в тот же день заменяет', () => {
  const s = mk('2026-09-01');
  D.setStep(s, '00:45', '2026-09-10');
  D.setStep(s, '00:40', '2026-09-10');
  assert.deepEqual(s.sleep.targets, [{ from: '2026-09-01', bed: '01:00' }, { from: '2026-09-11', bed: '00:40' }]);
  D.setStep(s, '01:00', '2026-09-10');
  assert.equal(s.sleep.targets.length, 1);
});

test('баннер итогов: воскресенье — эта неделя, пн–сб — незакрытая прошлая', () => {
  const s = mk('2026-09-01');
  assert.deepEqual(D.pendingReview(s, SUN), { monday: MON, kind: 'sunday' });
  assert.deepEqual(D.pendingReview(s, '2026-09-30'), { monday: MON, kind: 'overdue' });
  s.reviews[MON] = {};
  assert.equal(D.pendingReview(s, '2026-09-30'), null);
  assert.equal(D.pendingReview(s, SUN), null);
  const fresh = mk('2026-09-30');
  assert.equal(D.pendingReview(fresh, '2026-10-01'), null); // прошлая неделя до посева
});

test('пункты: добавить, переименовать, ↑↓, убрать и вернуть', () => {
  const s = mk('2026-09-01');
  assert.equal(D.addItem(s, { name: '   ' }, false, '2026-09-02'), null);
  const it = D.addItem(s, { name: 'x'.repeat(80), color: 'nope', beforeBed: '15' }, false, '2026-09-02');
  assert.equal(it.name.length, 60);
  assert.equal(it.color, 'blue');
  assert.equal(it.icon, 'star'); // значок по умолчанию
  assert.equal(it.beforeBed, 15);
  assert.ok(D.updateItem(s, it.id, { ...it, name: 'Вода' }));
  assert.equal(it.name, 'Вода');
  const first = s.items[0].id;
  assert.equal(D.moveItem(s, first, -1), false);
  assert.ok(D.moveItem(s, first, 1));
  assert.equal(s.items[1].id, first);
  D.archiveItem(s, s.items[0].id, '2026-09-02');
  assert.ok(D.moveItem(s, first, -1) === false); // выше только убранный
  assert.ok(D.restoreItem(s, s.items[0].id));
  assert.equal(D.activeIds(s).length, 9);
});

test('нормализация: битые поля → по умолчанию, неизвестные выброшены, повтор — то же', () => {
  const s = mk('2026-09-01');
  const raw = JSON.parse(JSON.stringify(s));
  raw.junk = 1;
  raw.items[0].extra = 'x';
  raw.items[1].color = 'violet'; // имя из старой палитры
  raw.items[1].icon = 'rocket';
  raw.items[1].emoji = '💪';
  raw.items.push({ id: raw.items[2].id, name: 'дубль' }, { name: 'без id' }, null);
  raw.days = { '2026-09-02': { plan: ['i1', 'i1', 5], done: 'bad' }, 'не дата': {} };
  raw.sleep.nights = { '2026-09-03': { bed: '25:00', wake: '07:30' }, '2026-09-04': { bed: 'x' } };
  raw.sleep.targets = [];
  raw.ui = null;
  const n = D.normalize(raw, '2026-09-10');
  assert.equal(n.junk, undefined);
  assert.equal(n.items.length, 8);
  assert.equal(n.items[0].extra, undefined);
  assert.equal(n.items[1].color, 'blue');
  assert.equal(n.items[1].icon, 'star');
  assert.equal(n.items[1].emoji, undefined);
  assert.deepEqual(n.days, { '2026-09-02': { plan: ['i1'], done: [] } });
  assert.deepEqual(n.sleep.nights, { '2026-09-03': { wake: '07:30' } });
  assert.deepEqual(n.sleep.targets, [{ from: '2026-09-01', bed: '01:00' }]);
  assert.deepEqual(n.ui, { welcomeSeen: false });
  assert.deepEqual(D.normalize(JSON.parse(JSON.stringify(n)), '2026-09-10'), n);
  assert.equal(D.normalize({ schema: 2, items: [], weekly: [], sleep: {} }), null);
  assert.equal(D.normalize([]), null);
});

test('итоги недели: дни, кольца, сон', () => {
  const s = sleepWeek(5);
  closeDay(s, '2026-09-21'); closeDay(s, '2026-09-22'); missDay(s, '2026-09-23');
  D.toggleWeekMark(s, s.weekly[0].id, '2026-09-22');
  delete s.sleep.nights['2026-09-26'].wake;
  const w = D.weekSummary(s, MON, SUN);
  assert.equal(w.closed, 2);
  assert.equal(w.total, 7);
  assert.equal(w.days.length, 7);
  assert.deepEqual(D.dayRings(s, '2026-09-22', SUN), { min: 1, sleep: true, week: true });
  assert.equal(D.dayRings(s, '2026-09-23', SUN).min, 0);
  assert.equal(D.weekCount(s, s.weekly[0].id, MON), 1);
  assert.equal(w.K, 5);
  assert.deepEqual(w.missingNights, ['2026-09-26']);
  assert.equal(w.avgBed, '01:01'); // (5 × 00:50 + 2 × 01:30) / 7
});

test('доля пунктов за 4 недели — только по дням в плане', () => {
  const s = mk('2026-09-01');
  const [a] = D.activeIds(s);
  s.days['2026-09-20'] = { plan: [a], done: [a] };
  s.days['2026-09-21'] = { plan: [a], done: [] };
  s.days['2026-09-22'] = { plan: [], done: [] };
  const r = D.itemRates(s, '2026-09-23').find(x => x.item.id === a);
  // 01–22 сентября; дни без записи восстановлены по addedAt, 22-го пункта не было в плане
  assert.equal(r.planned, 21);
  assert.equal(r.done, 1);
});

test('утра для показа: пустое — не в цель, но день посева и сегодня без записи не считаются', () => {
  const s = mk('2026-09-30');
  const nightAt = (d, bed) => (s.sleep.nights[d] = { bed, wake: '07:30' });
  // четверг 1 октября, утро ещё не отмечено
  assert.deepEqual(D.knownMornings(s, '2026-09-28', '2026-10-04', '2026-10-01'), []);
  nightAt('2026-09-30', '00:50'); // утро дня посева отмечено — считается
  assert.deepEqual(D.knownMornings(s, '2026-09-28', '2026-10-04', '2026-10-01'), ['2026-09-30']);
  nightAt('2026-10-01', '01:40');
  const m = D.knownMornings(s, '2026-09-28', '2026-10-04', '2026-10-01');
  assert.deepEqual(m, ['2026-09-30', '2026-10-01']);
  assert.deepEqual(D.sleepHits(s, m), { k: 1, n: 2 });
  // пятница: пустой четверг уже не отмечен — считается «не в цель»
  delete s.sleep.nights['2026-10-01'];
  assert.deepEqual(D.knownMornings(s, '2026-09-28', '2026-10-04', '2026-10-02'), ['2026-09-30', '2026-10-01']);
});

test('кольца дня: минимум, ночь, первый недельный счётчик', () => {
  const s = mk('2026-09-28');
  const [a, b] = D.activeIds(s);
  s.days['2026-09-29'] = { plan: D.activeIds(s), done: [a, b] };
  s.sleep.nights['2026-09-29'] = { bed: '00:40', wake: '07:30' };
  D.toggleWeekMark(s, s.weekly[0].id, '2026-09-29');
  assert.deepEqual(D.dayRings(s, '2026-09-29', '2026-09-30'), { min: 2 / 8, sleep: true, week: true });
  s.sleep.nights['2026-09-30'] = { bed: '02:00' };
  assert.deepEqual(D.dayRings(s, '2026-09-30', '2026-09-30'), { min: 0, sleep: false, week: false });
  assert.deepEqual(D.dayRings(s, '2026-10-01', '2026-09-30'), { min: null, sleep: null, week: null }); // будущее
  assert.deepEqual(D.dayRings(s, '2026-09-27', '2026-09-30'), { min: null, sleep: null, week: null }); // до посева
  s.weekly[0].archivedAt = '2026-09-30';
  assert.equal(D.firstWeekly(s), null);
  assert.equal(D.dayRings(s, '2026-09-29', '2026-09-30').week, null);
});
