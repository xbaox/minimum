process.env.TZ = 'America/Toronto';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../domain.js';
import { baoSeed } from './fixtures.js';
import { ICON_IDS } from '../icons.js';

const ids = () => { let n = 0; return () => 'i' + ++n; };
const mk = createdAt => baoSeed(createdAt, ids());
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

test('шаблон нового телефона — базовый: 5 пунктов без недельных счётчиков, id уникальны, цвета из палитры', () => {
  const s = D.seed('2026-09-30');
  assert.equal(s.items.length, 5);
  assert.equal(s.weekly.length, 0, 'счётчики человек добавит сам');
  assert.equal(new Set(s.items.map(i => i.id)).size, 5);
  for (const i of s.items) assert.ok(D.COLORS.includes(i.color), i.color);
  for (const i of s.items) assert.ok(ICON_IDS.includes(i.icon), i.icon);
  assert.deepEqual(s.items.map(i => i.name), ['Стакан воды', 'Зарядка', 'План на завтра', 'Телефон на кухню', 'Чтение']);
  assert.deepEqual(s.items.map(i => i.icon), ['glass', 'dumbbell', 'notebook', 'phone', 'book']);
  assert.deepEqual(s.items.map(i => i.color), ['teal', 'red', 'yellow', 'indigo', 'purple']);
  assert.ok(s.items.every(i => !/встал|лёг|легла|встала/.test(i.note)), 'подписи без рода — пол человека неизвестен');
  assert.ok(s.items.every(i => !('emoji' in i) && i.note), 'у каждого пункта подпись «когда / после чего»');
  // число с единицей не разрывается переносом
  assert.equal(s.items[1].note, '5\u00a0минут · после воды');
  assert.equal(s.items[4].note, '10\u00a0страниц · в кровати вместо телефона');
  assert.equal(s.items[3].beforeBed, 30);
  assert.equal(s.sleep.targets[0].bed, '01:00');
  assert.equal(s.sleep.goalBed, '23:30');
  assert.equal(s.sleep.goalWake, '07:30');
  assert.equal(s.since, '2026-09-30', 'новый телефон — «в системе» с сегодня');
  assert.equal(D.seed('2026-09-30', undefined, '2026-07-20').since, '2026-07-20', 'сброс передаёт прежнюю дату');
  assert.equal(D.seed('2026-09-30', undefined, 'мусор').since, '2026-09-30');
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
  assert.deepEqual(n.ui, { welcomeSeen: false, news: '', lastExport: '', setup: false });
  assert.deepEqual(n.sections, []);
  assert.deepEqual(n.secMarks, {});
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

test('ui: новости и дата экспорта переживают нормализацию, мусор — нет', () => {
  const s = mk('2026-09-01');
  s.ui = { welcomeSeen: true, news: 'v53', lastExport: '2026-09-20', junk: 1 };
  assert.deepEqual(D.normalize(JSON.parse(JSON.stringify(s)), '2026-09-21').ui, { welcomeSeen: true, news: 'v53', lastExport: '2026-09-20', setup: false });
  s.ui = { welcomeSeen: true, news: 5, lastExport: '2026-02-30', setup: 'да' };
  assert.deepEqual(D.normalize(JSON.parse(JSON.stringify(s)), '2026-09-21').ui, { welcomeSeen: true, news: '', lastExport: '', setup: false });
  s.ui = { welcomeSeen: false, news: '', lastExport: '', setup: true }; // настройка не закончена — переживает перезапуск
  assert.equal(D.normalize(JSON.parse(JSON.stringify(s)), '2026-09-21').ui.setup, true);
});

test('время до отбоя: шкала ночи, через полночь', () => {
  const at = (h, m) => new Date(2026, 9, 1, h, m);
  assert.equal(D.nowNorm(at(21, 0)), 1260);
  assert.equal(D.nowNorm(at(0, 40)), 1480);
  assert.equal(D.untilMin(at(21, 0), '01:00'), 240);
  assert.equal(D.untilMin(at(0, 20), '00:30'), 10);
  assert.equal(D.untilMin(at(0, 40), '00:30'), -10);
  assert.equal(D.untilMin(at(23, 50), '23:30'), -20);
});

test('круглые даты серии', () => {
  for (const n of [3, 7, 14, 21, 30, 50, 66, 100, 150, 200]) assert.ok(D.isMilestone(n), n);
  for (const n of [0, 1, 2, 8, 65, 101, 120]) assert.ok(!D.isMilestone(n), n);
});

test('пункт: статус по дням, серия «не пропускай дважды», рекорд, доля, сетка 6 недель', () => {
  const s = mk('2026-09-01');
  const [a, b] = D.activeIds(s);
  const today = '2026-09-17';
  const mark = (d, ids) => { s.days[d] = { plan: D.activeIds(s), done: ids }; };
  // 01 — посев (не отмечен → none), 02–05 сделан, 06 пропуск, 07–09 сделан, 10–11 пропуски, 12–16 сделан, 17 — сегодня
  for (const d of D.range('2026-09-02', '2026-09-16')) mark(d, [a]);
  for (const d of ['2026-09-06', '2026-09-10', '2026-09-11']) mark(d, [b]);
  assert.equal(D.itemStatus(s, a, '2026-09-01', today), 'none');
  assert.equal(D.itemStatus(s, a, '2026-09-06', today), 'miss');
  assert.equal(D.itemStatus(s, a, today, today), 'pending');
  assert.equal(D.itemStatus(s, b, '2026-09-06', today), 'closed');
  const st = D.itemStats(s, a, today);
  assert.equal(st.weekly, false);
  assert.equal(st.best, 7); // 02–09: 4 + прощённый пропуск + 3
  assert.equal(st.streak, 5); // после двух пропусков подряд — с нуля: 12–16
  assert.equal(st.cells.length, 42);
  assert.equal(st.cells[0].date, '2026-08-10'); // пн за 5 недель до текущей
  assert.equal(st.cells.find(c => c.date === '2026-09-06').st, 'miss');
  assert.equal(st.cells.find(c => c.date === '2026-09-08').st, 'done');
  assert.equal(st.cells.find(c => c.date === today).st, 'pending');
  assert.equal(st.cells.find(c => c.date === '2026-09-20').st, 'future');
  assert.equal(st.cells.find(c => c.date === '2026-08-31').st, 'off'); // до посева
  assert.equal(st.planned, 16); // 01–16
  assert.equal(st.done, 12);
  // отметка сегодня продлевает серию
  mark(today, [a]);
  assert.equal(D.itemStats(s, a, today).streak, 6);
  assert.equal(D.itemStats(s, 'нет такого', today), null);
});

test('недельный счётчик: эта неделя, 8 недель, завершённые недели в цель', () => {
  const s = mk('2026-09-01'); // вт; неделя посева — с 31 августа
  const w = s.weekly[0].id;
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-08', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-22']) D.toggleWeekMark(s, w, d);
  const st = D.itemStats(s, w, '2026-09-23');
  assert.equal(st.weekly, true);
  assert.equal(st.thisWeek, 1);
  assert.equal(st.weeks.length, 8);
  assert.deepEqual(st.weeks.slice(-4).map(x => x.count), [3, 1, 3, 1]);
  assert.equal(st.pastWeeks, 3); // 31.08, 07.09, 14.09
  assert.equal(st.goalWeeks, 2);
});

test('сон в часах: sleepFor, отбой из Настроек не задним числом (stepFrom), подъём сохраняет часы (setWake)', () => {
  assert.equal(D.sleepFor('00:45', '07:30'), 405);
  assert.equal(D.sleepFor('23:30', '07:30'), 480);
  assert.equal(D.sleepFor('03:00', '07:30'), 270);
  const t = (d, h, m = 0) => new Date(2026, 9, d, h, m);
  assert.equal(D.stepFrom('2026-10-21', '00:00', t(21, 14)), '2026-10-22', 'днём — с ближайшей ночи');
  assert.equal(D.stepFrom('2026-10-21', '00:00', t(21, 23, 30)), '2026-10-22', 'вечером, до нового отбоя — тоже');
  assert.equal(D.stepFrom('2026-10-21', '00:00', t(22, 0, 30)), '2026-10-23', 'ночью после нового отбоя — со следующей');
  assert.equal(D.stepFrom('2026-10-21', '23:30', t(21, 23, 30)), '2026-10-23', 'ровно в отбой — тоже со следующей');
  assert.equal(D.stepFrom('2026-10-22', '00:00', t(22, 5)), '2026-10-23', 'утро — новый логический день, ближайшая ночь');
  const s = mk('2026-10-01');
  D.setStep(s, '00:30', '2026-10-10');
  D.setStep(s, '00:15', '2026-10-10', '2026-10-12');
  assert.deepEqual(s.sleep.targets, [{ from: '2026-10-01', bed: '01:00' }, { from: '2026-10-11', bed: '00:30' }, { from: '2026-10-12', bed: '00:15' }]);
  assert.ok(D.setWake(s, '07:00', '2026-10-10'));
  assert.equal(s.sleep.goalWake, '07:00');
  assert.equal(s.sleep.goalBed, '23:00', 'цель — те же 8 ч');
  assert.deepEqual(s.sleep.targets, [{ from: '2026-10-01', bed: '01:00' }, { from: '2026-10-11', bed: '00:00' }, { from: '2026-10-12', bed: '23:45' }],
    'прошлое не тронуто, шаги дальше сдвинуты на ту же разницу');
  assert.equal(D.sleepFor(D.targetFor(s, '2026-10-12'), s.sleep.goalWake), D.sleepFor('00:15', '07:30'));
  assert.ok(D.setWake(s, '07:00', '2026-10-10'), 'тот же подъём — ничего не меняется');
  assert.equal(s.sleep.goalBed, '23:00');
  assert.equal(D.setWake(s, '7:00', '2026-10-10'), false);
});

test('название и подпись — одна строка: переносы схлопываются, неразрывные пробелы остаются', () => {
  const f = D.cleanFields({ name: '  Чтение\n', note: '10 страниц\n\nперед сном  ' }, false);
  assert.equal(f.name, 'Чтение');
  assert.equal(f.note, '10 страниц перед сном');
});

test('шаг: последнее решение заменяет все шаги с его ночи; отбой этой ночью уже прошёл — со следующей', () => {
  const s = mk('2026-10-01');
  D.setStep(s, '00:15', '2026-10-10', '2026-10-12'); // ночью: на послезавтра
  D.setStep(s, '00:45', '2026-10-10'); // передумал — с ближайшей ночи
  assert.deepEqual(s.sleep.targets, [{ from: '2026-10-01', bed: '01:00' }, { from: '2026-10-11', bed: '00:45' }], 'запись на 12-е не прячет новое решение');
  const t = (d, h, m = 0) => new Date(2026, 9, d, h, m);
  assert.equal(D.stepFrom('2026-10-21', '17:30', t(21, 17, 59)), '2026-10-22', 'до вечера — с ближайшей ночи');
  assert.equal(D.stepFrom('2026-10-21', '17:30', t(21, 18, 0)), '2026-10-23', 'вечер, и новый отбой уже прошёл');
  assert.equal(D.stepFrom('2026-10-21', '03:00', t(22, 3, 59)), '2026-10-23', '03:59 — ещё та же ночь');
  assert.equal(D.stepFrom('2026-10-22', '03:00', t(22, 4, 0)), '2026-10-23', '04:00 — новый день, ближайшая ночь');
  assert.equal(D.stepFrom('2026-10-21', '01:30', t(22, 1, 15), '01:00'), '2026-10-23', 'прежний отбой прошёл — позднюю ночь в «в цель» не переделать');
  assert.equal(D.stepFrom('2026-10-21', '01:30', t(21, 23, 0), '01:00'), '2026-10-22', 'вечером до обоих отбоев — с ближайшей');
});

test('подъём: отбой не позже 03:00, туда-обратно — без лишних шагов; сон в часах не отрицателен', () => {
  const s = mk('2026-10-01');
  D.setStep(s, '03:00', '2026-10-05');
  D.setWake(s, '09:00', '2026-10-10'); // +90 минут: шаг упёрся бы в 04:30
  assert.equal(D.targetFor(s, '2026-10-11'), '03:00', 'отбой не позже 03:00');
  assert.equal(s.sleep.goalBed, '01:00', 'цель 23:30 + 1,5 ч');
  const u = mk('2026-10-01');
  D.setWake(u, '08:00', '2026-10-10');
  D.setWake(u, '07:30', '2026-10-10');
  assert.deepEqual(u.sleep.targets, [{ from: '2026-10-01', bed: '01:00' }], 'A → B → A — как было');
  assert.equal(u.sleep.goalBed, '23:30');
  assert.equal(D.sleepFor('08:00', '07:30'), 0);
});

test('итоги недели ночью: новый шаг — со следующей ночи, если отбой этой ночью уже прошёл', () => {
  const s = sleepWeek(5);
  // понедельник 00:40 — логически ещё воскресенье, шаг 01:00 впереди, новый 00:30 уже прошёл
  assert.ok(D.closeWeek(s, MON, {}, 'earlier30', SUN, new Date(2026, 8, 28, 0, 40).toISOString()));
  assert.equal(D.targetFor(s, '2026-09-28'), '01:00', 'эта ночь — по прежнему шагу');
  assert.equal(D.targetFor(s, '2026-09-29'), '00:30');
});

// ---------- разделы (v58)

const sids = () => { let n = 0; return () => 's' + ++n; }; // id разделов не пересекаются с пунктами mk()

test('разделы: добавить, править, выключить, порядок; пункт раздела — без привязки к отбою', () => {
  const s = mk('2026-10-01');
  const id = sids();
  const w = D.addSection(s, { name: '  Работа ', icon: 'briefcase', color: 'blue' }, '2026-10-05', id);
  assert.deepEqual(w, { id: 's1', name: 'Работа', icon: 'briefcase', color: 'blue', on: true, addedAt: '2026-10-05', items: [] });
  assert.equal(D.addSection(s, { name: '   ' }, '2026-10-05', id), null);
  const hb = D.addSection(s, { name: 'Хобби', icon: 'rocket', color: 'violet' }, '2026-10-05', id);
  assert.equal(hb.icon, 'star');
  assert.equal(hb.color, 'blue');
  assert.equal(D.addSection(s, { name: 'x'.repeat(50) }, '2026-10-05', id).name.length, D.SECTION_NAME_MAX);
  assert.ok(D.updateSection(s, hb.id, { name: 'Музыка', icon: 'music', color: 'orange' }));
  assert.deepEqual([D.findSection(s, hb.id).name, D.findSection(s, hb.id).icon], ['Музыка', 'music']);
  assert.equal(D.updateSection(s, hb.id, { name: '' }), false);
  assert.ok(D.moveSection(s, hb.id, -1));
  assert.deepEqual(s.sections.map(x => x.name).slice(0, 2), ['Музыка', 'Работа']);
  assert.equal(D.moveSection(s, hb.id, -1), false);
  assert.ok(D.setSectionOn(s, w.id, false));
  assert.equal(D.findSection(s, w.id).on, false);
  const a = D.addSecItem(s, w.id, { name: 'Главная задача', note: 'первым\nделом', icon: 'target', color: 'red', beforeBed: 30 }, '2026-10-05', id);
  assert.deepEqual(a, { id: a.id, icon: 'target', name: 'Главная задача', note: 'первым делом', color: 'red', addedAt: '2026-10-05' });
  const b = D.addSecItem(s, w.id, { name: 'Почта' }, '2026-10-05', id);
  assert.equal(D.addSecItem(s, 'нет', { name: 'X' }, '2026-10-05', id), null);
  assert.equal(D.addSecItem(s, w.id, { name: ' ' }, '2026-10-05', id), null);
  assert.ok(D.moveSecItem(s, b.id, -1));
  assert.deepEqual(D.findSection(s, w.id).items.map(i => i.name), ['Почта', 'Главная задача']);
  assert.ok(D.updateSecItem(s, a.id, { name: 'Фокус', note: '90 минут', icon: 'clock', color: 'indigo' }));
  assert.equal(D.findSecItem(s, a.id).item.name, 'Фокус');
  assert.equal(D.findSecItem(s, a.id).section.id, w.id);
  assert.equal(D.findItem(s, a.id), undefined, 'пункт раздела — не пункт минимума');
});

test('разделы: пределы — 8 разделов, 20 пунктов в разделе', () => {
  const s = mk('2026-10-01');
  const id = sids();
  for (let i = 0; i < D.MAX_SECTIONS; i++) assert.ok(D.addSection(s, { name: 'Р' + i }, '2026-10-01', id));
  assert.equal(D.addSection(s, { name: 'лишний' }, '2026-10-01', id), null);
  const sec = s.sections[0];
  for (let i = 0; i < D.MAX_SEC_ITEMS; i++) assert.ok(D.addSecItem(s, sec.id, { name: 'п' + i }, '2026-10-01', id));
  assert.equal(D.addSecItem(s, sec.id, { name: 'лишний' }, '2026-10-01', id), null);
});

test('отметки разделов: сегодня и вчера, не раньше пункта; минимум, серия и итоги их не видят', () => {
  const s = mk('2026-10-01');
  const id = sids();
  const sec = D.addSection(s, { name: 'Хобби' }, '2026-10-01', id);
  const g = D.addSecItem(s, sec.id, { name: 'Гитара' }, '2026-10-03', id);
  const before = JSON.stringify([D.progress(s, '2026-10-05', '2026-10-05'), D.history(s, '2026-10-05'), D.weekSummary(s, '2026-09-28', '2026-10-05')]);
  assert.ok(D.toggleSecMark(s, g.id, '2026-10-05', '2026-10-05'));
  assert.ok(D.toggleSecMark(s, g.id, '2026-10-04', '2026-10-05'), 'вчера — можно');
  assert.equal(D.toggleSecMark(s, g.id, '2026-10-03', '2026-10-05'), false, 'раньше вчера — нельзя');
  assert.equal(D.toggleSecMark(s, g.id, '2026-10-02', '2026-10-03'), false, 'до появления пункта — нельзя');
  assert.equal(D.toggleSecMark(s, 'нет', '2026-10-05', '2026-10-05'), false);
  assert.deepEqual(s.secMarks[g.id], ['2026-10-04', '2026-10-05']);
  assert.ok(D.secDone(s, g.id, '2026-10-05'));
  assert.deepEqual(D.secDay(s, sec, '2026-10-05'), { items: [g], k: 1, n: 1 });
  assert.deepEqual(D.secDay(s, sec, '2026-10-02'), { items: [], k: 0, n: 0 });
  assert.equal(JSON.stringify([D.progress(s, '2026-10-05', '2026-10-05'), D.history(s, '2026-10-05'), D.weekSummary(s, '2026-09-28', '2026-10-05')]), before);
  assert.ok(D.toggleSecMark(s, g.id, '2026-10-05', '2026-10-05'));
  assert.ok(D.toggleSecMark(s, g.id, '2026-10-04', '2026-10-05'));
  assert.equal(s.secMarks[g.id], undefined, 'пустой список отметок не копится');
  D.toggleSecMark(s, g.id, '2026-10-05', '2026-10-05');
  assert.ok(D.removeSecItem(s, g.id));
  assert.deepEqual(s.secMarks, {}, 'удалённый пункт уносит отметки');
  const x = D.addSecItem(s, sec.id, { name: 'Рисунок' }, '2026-10-05', id);
  D.toggleSecMark(s, x.id, '2026-10-05', '2026-10-05');
  assert.ok(D.removeSection(s, sec.id));
  assert.deepEqual([s.sections, s.secMarks], [[], {}], 'удалённый раздел уносит пункты и отметки');
  assert.equal(D.removeSection(s, sec.id), false);
});

test('детали пункта раздела: неделя, 4 недели, всего; клетки без пропусков', () => {
  const s = mk('2026-09-01');
  const sec = D.addSection(s, { name: 'Работа' }, '2026-09-01', sids());
  const it = D.addSecItem(s, sec.id, { name: 'Фокус' }, '2026-09-10', () => 'f');
  s.secMarks.f = ['2026-09-11', '2026-09-20', '2026-09-28', '2026-09-30', '2026-10-01', '2026-10-09'];
  const st = D.secStats(s, it.id, '2026-10-01'); // чт; неделя с 28.09
  assert.deepEqual([st.week, st.month, st.total], [3, 5, 5], 'будущая отметка не считается');
  assert.equal(st.cells.length, 42);
  const at = d => st.cells.find(c => c.date === d).st;
  assert.equal(at('2026-09-09'), 'off');
  assert.equal(at('2026-09-12'), 'none');
  assert.equal(at('2026-09-11'), 'done');
  assert.equal(at('2026-10-02'), 'future');
  assert.ok(!st.cells.some(c => c.st === 'miss'));
  assert.equal(D.secStats(s, 'нет', '2026-10-01'), null);
});

test('нормализация разделов: мусор выброшен, id не повторяются, отметки только своих пунктов', () => {
  const s = mk('2026-09-01');
  const raw = JSON.parse(JSON.stringify(s));
  raw.sections = [
    { id: 'w', name: ' Работа ', icon: 'briefcase', color: 'blue', on: false, addedAt: '2026-09-02', junk: 1,
      items: [{ id: 'w1', name: 'Фокус', note: 'утром', icon: 'clock', color: 'red', beforeBed: 30, addedAt: '2026-09-03' }, { id: 'w1', name: 'дубль' }, { id: 'i1', name: 'чужой id' }, { name: 'без id' }, null] },
    { id: 'w', name: 'дубль раздела' },
    { id: 'h', name: '', items: [] },
    { id: 'i2', name: 'id пункта минимума' },
    { id: 'm', name: 'Музыка', icon: 'rocket', color: 'violet', items: 'bad' },
    'мусор',
  ];
  raw.secMarks = { w1: ['2026-09-05', '2026-09-05', 'не дата', '2026-09-04'], i1: ['2026-09-05'], zz: ['2026-09-05'], m: 'bad' };
  const n = D.normalize(raw, '2026-09-10');
  assert.deepEqual(n.sections, [
    { id: 'w', name: 'Работа', icon: 'briefcase', color: 'blue', on: false, addedAt: '2026-09-02', items: [{ id: 'w1', icon: 'clock', name: 'Фокус', note: 'утром', color: 'red', addedAt: '2026-09-03' }] },
    { id: 'm', name: 'Музыка', icon: 'star', color: 'blue', on: true, addedAt: '2026-09-01', items: [] },
  ]);
  assert.deepEqual(n.secMarks, { w1: ['2026-09-04', '2026-09-05'] });
  assert.deepEqual(D.normalize(JSON.parse(JSON.stringify(n)), '2026-09-10'), n);
  raw.sections = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, name: 'Р' + i, items: Array.from({ length: 30 }, (_, k) => ({ id: `s${i}-${k}`, name: 'п' }) ) }));
  const big = D.normalize(raw, '2026-09-10');
  assert.equal(big.sections.length, D.MAX_SECTIONS);
  assert.ok(big.sections.every(x => x.items.length === D.MAX_SEC_ITEMS));
});

// ---------- первая настройка (v58)

test('новый телефон: первая настройка, пустые разделы; подсказки — шаблон и ещё шесть', () => {
  const s = D.seed('2026-10-26', ids());
  assert.equal(s.ui.setup, true);
  assert.deepEqual([s.sections, s.secMarks], [[], {}]);
  assert.equal(D.SUGGESTIONS.length, 11);
  assert.deepEqual(D.SUGGESTIONS.slice(0, 5).map(x => x.name), s.items.map(i => i.name), 'первые пять — шаблон');
  assert.equal(new Set(D.SUGGESTIONS.map(x => x.name)).size, 11);
  for (const x of D.SUGGESTIONS) {
    assert.ok(ICON_IDS.includes(x.icon), x.icon);
    assert.ok(D.COLORS.includes(x.color), x.color);
    assert.ok(D.cleanFields(x, false), x.name);
    assert.doesNotMatch(x.note, /встал|лёг|сделал/, 'подписи без рода');
  }
});

test('первая настройка: пункт убирается бесследно, первый шаг — с первой ночи', () => {
  const s = D.seed('2026-10-26', ids());
  D.syncToday(s, '2026-10-26');
  const id = s.items[1].id;
  assert.ok(D.dropItem(s, id));
  assert.equal(s.items.length, 4);
  assert.ok(!s.days['2026-10-26'].plan.includes(id));
  assert.equal(D.dropItem(s, id), false);
  assert.ok(D.setFirstStep(s, '00:00'));
  assert.deepEqual(s.sleep.targets, [{ from: '2026-10-26', bed: '00:00' }]);
  assert.equal(D.stepTonight(s, '2026-10-26'), '00:00');
  assert.equal(D.setFirstStep(s, '25:00'), false);
  // подъём в настройке: шаг и цель сдвигаются, часы сна те же — тоже с первой ночи
  D.setWake(s, '06:30', '2026-10-26', s.createdAt);
  assert.deepEqual(s.sleep.targets, [{ from: '2026-10-26', bed: '23:00' }]);
  assert.equal(s.sleep.goalBed, '22:30');
});

test('конец настройки: без отметок приложение начинается сегодня; «в системе с» после «Начать заново» — прежнее', () => {
  const s = D.seed('2026-10-24', ids());
  D.syncToday(s, '2026-10-24');
  D.setFirstStep(s, '00:30');
  const sec = D.addSection(s, { name: 'Работа' }, '2026-10-24', sids());
  D.addSecItem(s, sec.id, { name: 'Фокус' }, '2026-10-24', () => 'f');
  assert.equal(D.finishSetup(s, '2026-10-26'), true);
  assert.deepEqual([s.createdAt, s.since], ['2026-10-26', '2026-10-26']);
  assert.deepEqual(s.days, {});
  assert.ok([...s.items, sec, ...sec.items].every(x => x.addedAt === '2026-10-26'));
  assert.deepEqual(s.sleep.targets, [{ from: '2026-10-26', bed: '00:30' }]);
  assert.deepEqual([s.ui.setup, s.ui.welcomeSeen], [false, true]);
  assert.equal(D.status(s, '2026-10-25', '2026-10-26'), 'none', 'дни настройки не пропуски');
  // после «Начать заново» — «в системе с» прежняя дата
  const r = D.seed('2026-10-26', ids(), '2026-07-20');
  D.finishSetup(r, '2026-10-26');
  assert.equal(r.since, '2026-07-20');
  // уже есть отметки (например, копия) — прошлое не трогаем
  const t = D.seed('2026-10-20', ids());
  t.sleep.nights['2026-10-21'] = { bed: '00:30', wake: '07:30' };
  assert.equal(D.finishSetup(t, '2026-10-26'), false);
  assert.equal(t.createdAt, '2026-10-20');
  assert.equal(t.ui.setup, false);
});
