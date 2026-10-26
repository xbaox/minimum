process.env.TZ = 'America/Toronto';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../domain.js';
import { baoSeed } from './fixtures.js';
import { shareOf, readShare, summaryOf, changes, logicalDateIn, clean, weekScore, ranked, HIDDEN_NAME, NIGHTS_KEEP } from '../share.js';

const ids = () => { let n = 0; return () => 'uuid-' + ++n + '-xxxxxxxxxxxxxxxx'; };
const mk = createdAt => baoSeed(createdAt, ids());
const closeDay = (s, d) => { s.days[d] = { plan: D.activeIds(s), done: D.activeIds(s) }; };
const missDay = (s, d) => { s.days[d] = { plan: D.activeIds(s), done: [] }; };
const TODAY = '2026-10-21'; // среда
const at = (iso, h = 12) => new Date(`${iso}T${String(h).padStart(2, '0')}:00:00-04:00`); // Торонто, летнее время

// Живое состояние: 3 недели истории, сон, недельные отметки, закрытая неделя с разбором.
function life() {
  const s = mk('2026-09-30');
  for (const d of D.range('2026-09-30', '2026-10-20')) (d === '2026-10-08' ? missDay : closeDay)(s, d);
  s.days[TODAY] = { plan: D.activeIds(s), done: D.activeIds(s).slice(0, 3) };
  for (const d of D.range('2026-10-01', TODAY)) s.sleep.nights[d] = { bed: '00:45', wake: '07:30' };
  s.weekMarks[s.weekly[0].id] = ['2026-10-19', '2026-10-20'];
  s.reviews['2026-10-12'] = {
    closedAt: '2026-10-18T23:10:00.000Z', good: 'тайное хорошее', bad: 'тайное плохое', learned: 'тайный урок', notesDone: true,
    improvement: 'Книга в кровать', sleep: { from: '01:00', to: '00:30', choice: 'earlier30' },
  };
  D.setStep(s, '00:30', '2026-10-18');
  return s;
}

test('логический день в поясе друга: граница 04:00, неизвестный пояс — по часам устройства', () => {
  const t = at('2026-10-21', 22); // 22:00 в Торонто = 05:00 22-го в Москве
  assert.equal(logicalDateIn('America/Toronto', t), '2026-10-21');
  assert.equal(logicalDateIn('Europe/Moscow', t), '2026-10-22');
  const t2 = at('2026-10-21', 20); // 03:00 в Москве — ещё вчерашний логический день
  assert.equal(logicalDateIn('Europe/Moscow', t2), '2026-10-21');
  assert.equal(logicalDateIn('Not/AZone', t), D.logicalDate(t));
  assert.equal(logicalDateIn('', t), D.logicalDate(t));
  // полночь в h23 — «00», не «24»
  assert.equal(logicalDateIn('America/Toronto', new Date('2026-10-22T04:00:00Z')), '2026-10-21');
});

test('снимок: без разбора недели и uuid, скрытый пункт — «Личный пункт», отметки на месте', () => {
  const s = life();
  const lak = s.items.find(i => i.name === 'Лак на ногти');
  const snap = shareOf(s, TODAY, { tz: 'America/Toronto', hidden: [lak.id, 'нет-такого'] });
  const text = JSON.stringify(snap);
  for (const secret of ['тайное хорошее', 'тайное плохое', 'тайный урок', 'Лак на ногти', 'после душа', 'uuid-']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(snap.items.map(i => i.id), ['0', '1', '2', '3', '4', '5', '6', '7']);
  assert.equal(snap.weekly[0].id, '8');
  const masked = snap.items[6];
  assert.deepEqual([masked.name, masked.note, masked.color, masked.icon, masked.beforeBed], [HIDDEN_NAME, '', 'gray', 'star', null]);
  assert.deepEqual(snap.meta, { v: 1, tz: 'America/Toronto', day: TODAY, hidden: ['6'], sleep: true, onepct: true });
  assert.deepEqual(snap.plans, [['0', '1', '2', '3', '4', '5', '6', '7']]);
  assert.deepEqual(snap.days[TODAY], [0, '11100000']);
  assert.deepEqual(snap.days['2026-10-20'], [0, '11111111'], 'отметки скрытого пункта остаются');
  assert.deepEqual(snap.days['2026-10-08'], [0, '00000000']);
  assert.deepEqual(snap.weekMarks, { 8: ['2026-10-19', '2026-10-20'] });
  assert.equal(snap.reviews['2026-10-12'].improvement, 'Книга в кровать');
  assert.equal(snap.reviews['2026-10-12'].good, undefined);
  assert.equal(snap.reviews['2026-10-12'].notesDone, undefined);
});

test('снимок: сон и 1% — по выбору; ночи — только последние 6 недель', () => {
  const s = life();
  s.sleep.nights['2026-08-01'] = { bed: '02:00', wake: '09:00' };
  const off = shareOf(s, TODAY, { sleep: false, onepct: false });
  assert.deepEqual(off.sleep, { targets: [], nights: {} });
  assert.equal(off.reviews['2026-10-12'].improvement, '');
  assert.deepEqual(off.reviews['2026-10-12'].sleep, {});
  assert.equal(JSON.stringify(off).includes('00:45'), false);
  const on = shareOf(s, TODAY);
  assert.equal(on.sleep.nights['2026-08-01'], undefined);
  assert.ok(Object.keys(on.sleep.nights).every(d => d >= D.addDays(TODAY, -(NIGHTS_KEEP - 1))));
  assert.deepEqual(on.sleep.targets.map(t => t.bed), ['01:00', '00:30']);
});

test('друг видит ровно то, что показал бы твой телефон: «3 из 9», серия, рекорд, сон, счётчик', () => {
  const s = life();
  const v = readShare(JSON.parse(JSON.stringify(shareOf(s, TODAY, { tz: 'America/Toronto' }))), at(TODAY, 18));
  assert.equal(v.today, TODAY);
  const mine = summaryOf(s, TODAY), theirs = summaryOf(v.F, v.today);
  for (const k of ['k', 'n', 'closed', 'streak', 'best', 'wc']) assert.equal(theirs[k], mine[k], k);
  assert.deepEqual(theirs.sh, mine.sh);
  assert.equal(theirs.w.name, 'Тренировка');
  assert.deepEqual(D.history(v.F, TODAY).marks, D.history(s, TODAY).marks);
  assert.deepEqual([mine.k, mine.n, mine.streak], [3, 8, 20]); // одиночный пропуск 8 октября прощён
});

test('друг не открывал приложение: у него уже новый день — сегодня «идёт», вчера закрыт или пропуск', () => {
  const s = life();
  closeDay(s, TODAY);
  const doc = JSON.parse(JSON.stringify(shareOf(s, TODAY, { tz: 'America/Toronto' })));
  const v = readShare(doc, at('2026-10-22', 9));
  assert.equal(v.today, '2026-10-22');
  assert.equal(v.day, TODAY);
  const sum = summaryOf(v.F, v.today);
  assert.deepEqual([sum.k, sum.closed], [0, false]);
  assert.equal(D.status(v.F, TODAY, v.today), 'closed');
  assert.equal(sum.streak, 21);
  // часы смотрящего отстали на сутки — день снимка всё равно «сегодня»
  assert.equal(readShare(doc, at('2026-10-20', 9)).today, TODAY);
});

test('чужой снимок — недоверенные данные: мусор → null, поля чистятся normalize', () => {
  for (const bad of [null, 5, 'x', [], { schema: 2 }, { meta: {} }]) assert.equal(readShare(bad), null);
  const s = life();
  const doc = JSON.parse(JSON.stringify(shareOf(s, TODAY)));
  doc.items[0].name = 'Я'.repeat(500);
  doc.items[0].color = 'url(javascript:alert(1))';
  doc.items[0].icon = '<img onerror=alert(1)>';
  doc.meta.hidden = ['0', 5, '999'];
  doc.meta.tz = 'Не/Пояс';
  const v = readShare(doc, at(TODAY, 12));
  assert.equal(v.F.items[0].name.length, 60);
  assert.equal(v.F.items[0].color, 'blue');
  assert.equal(v.F.items[0].icon, 'star');
  assert.deepEqual([...v.hidden], ['0']);
  assert.equal(v.today, TODAY);
});

test('лента: новые и убранные пункты, шаг отбоя, 1% недели, круглые серии, неделя счётчика — свежие сверху', () => {
  const s = life();
  const it = D.addItem(s, { name: 'Растяжка', note: 'перед сном', icon: 'heart', color: 'pink' }, false, '2026-10-19');
  D.archiveItem(s, s.items.find(i => i.name === 'Vocabulary').id, '2026-10-20');
  s.weekMarks[s.weekly[0].id].push('2026-10-21');
  const lak = s.items.find(i => i.name === 'Лак на ногти');
  D.addItem(s, { name: 'Тайный пункт', icon: 'eye', color: 'red' }, false, '2026-10-21');
  const secretId = s.items.at(-1).id;
  const v = readShare(JSON.parse(JSON.stringify(shareOf(s, TODAY, { tz: 'America/Toronto', hidden: [lak.id, secretId] }))), at(TODAY, 20));
  const feed = changes(v);
  const brief = feed.map(e => `${e.date} ${e.kind}` + (e.n ? ` ${e.n}` : '') + (e.item ? ` ${e.item.name}` : '') + (e.to ? ` ${e.from}→${e.to}` : '') + (e.text ? ` ${e.text}` : '') + (e.hidden ? ' (скрыт)' : ''));
  assert.deepEqual(brief, [
    `2026-10-21 week Тренировка`,
    `2026-10-21 add ${HIDDEN_NAME} (скрыт)`,
    '2026-10-20 remove Vocabulary',
    '2026-10-19 add Растяжка',
    '2026-10-18 step 01:00→00:30',
    '2026-10-18 onepct Книга в кровать',
    '2026-10-14 streak 14',
    '2026-10-06 streak 7',
    '2026-10-02 streak 3',
  ]);
  assert.equal(it.name, 'Растяжка');
  assert.equal(changes(v, 3).length, 3);
  // пункты шаблона в день посева — не «новые»
  assert.ok(!feed.some(e => e.kind === 'add' && e.date === '2026-09-30'));
  // сон и 1% скрыты — их нет в ленте
  const quiet = readShare(JSON.parse(JSON.stringify(shareOf(s, TODAY, { sleep: false, onepct: false }))), at(TODAY, 20));
  assert.ok(!changes(quiet).some(e => e.kind === 'step' || e.kind === 'onepct'));
});

test('снимок трёх лет жизни лёгкий: меньше 60 КБ (влезает в keepalive), лимит сервера — 256 КБ', () => {
  const s = mk('2023-10-21');
  for (let i = 0; i < 4; i++) D.addItem(s, { name: 'Пункт ' + i, note: 'подпись подлиннее, чем обычно бывает' }, false, '2024-01-0' + (i + 1));
  for (const d of D.range('2023-10-21', '2026-10-20')) {
    s.days[d] = { plan: D.activeIds(s), done: D.activeIds(s).filter((_, i) => (i + d.length + +d.slice(-2)) % 3) };
    s.sleep.nights[d] = { bed: '00:30', wake: '07:30' };
    if (+d.slice(-2) % 2) (s.weekMarks[s.weekly[0].id] ||= []).push(d);
  }
  const text = JSON.stringify(shareOf(s, TODAY, { tz: 'America/Toronto' }));
  assert.ok(new TextEncoder().encode(text).length < 60000, `${text.length} байт`);
  // и читается обратно: история — в окне трёх лет, последние недели — как у владельца
  const v = readShare(JSON.parse(text), at(TODAY, 12));
  assert.equal(v.F.createdAt, D.addDays(TODAY, -1095));
  const mine = D.history(s, TODAY).marks, theirs = D.history(v.F, TODAY).marks;
  for (const d of D.range(D.addDays(TODAY, -60), TODAY)) assert.equal(theirs[d], mine[d], d);
  const names = (st, ids) => ids.map(id => D.findItem(st, id).name);
  assert.deepEqual(names(v.F, v.F.days['2025-05-05'].done), names(s, s.days['2025-05-05'].done));
  assert.deepEqual(names(v.F, v.F.days['2025-05-05'].plan), names(s, s.days['2025-05-05'].plan));
});

test('битые дни в чужом снимке пропускаются, остальное читается', () => {
  const s = life();
  const doc = JSON.parse(JSON.stringify(shareOf(s, TODAY)));
  doc.days['2026-10-01'] = [7, '1111'];
  doc.days['2026-10-02'] = 'мусор';
  doc.days['2026-10-03'] = [0.5, '1'];
  doc.days['не-дата'] = [0, '1'];
  const v = readShare(doc, at(TODAY, 12));
  assert.equal(v.F.days['2026-10-01'], undefined);
  assert.equal(v.F.days['2026-10-02'], undefined);
  assert.equal(v.F.days['2026-10-03'], undefined);
  assert.equal(v.F.days['не-дата'], undefined);
  assert.deepEqual(v.F.days['2026-10-04'].done.length, 8);
  assert.equal(readShare({ ...doc, plans: 'x' }, at(TODAY, 12)).F.days[TODAY], undefined);
});

test('сон скрыт — «до 00:30» у пунктов не уходит; неделя закрыта — только день, без минут', () => {
  const s = life();
  const phone = s.items.find(i => i.beforeBed);
  const off = shareOf(s, TODAY, { tz: 'America/Toronto', sleep: false });
  assert.equal(off.items.find(i => i.name === phone.name).beforeBed, null);
  const on = shareOf(s, TODAY, { tz: 'America/Toronto' });
  assert.equal(on.items.find(i => i.name === phone.name).beforeBed, 30);
  assert.equal(on.reviews['2026-10-12'].closedAt, '2026-10-18');
  const v = readShare(JSON.parse(JSON.stringify(on)), at(TODAY, 20));
  assert.ok(changes(v).some(e => e.kind === 'onepct' && e.date === '2026-10-18'));
});

test('чужой снимок не подвесит вкладку: 1900 год, 3000 пунктов и день из будущего обрезаются', () => {
  const s = life();
  const doc = JSON.parse(JSON.stringify(shareOf(s, TODAY)));
  doc.createdAt = '1900-01-01';
  for (let i = 0; i < 3000; i++) doc.items.push({ id: 'x' + i, name: 'мусор' + i, icon: 'star', color: 'red', addedAt: '1900-01-01', archivedAt: null });
  doc.meta.day = '2099-01-01';
  const t0 = performance.now();
  const v = readShare(doc, at(TODAY, 12));
  const sum = summaryOf(v.F, v.today);
  changes(v);
  assert.ok(performance.now() - t0 < 1500, `${Math.round(performance.now() - t0)} мс`);
  assert.equal(v.today, TODAY, 'день из будущего не принят');
  assert.equal(v.F.items.length, 60);
  assert.ok(v.F.createdAt >= D.addDays(TODAY, -1095));
  assert.ok(sum.n <= 60);
});

test('чистка текста: без \\u0000 и половинок суррогатных пар, целые эмодзи остаются', () => {
  assert.equal(clean('a\u0000b\u0007c'), 'abc');
  assert.equal(clean('ok 😀'), 'ok 😀');
  assert.equal(clean('\uD83D'), '�');
  assert.equal(clean('\uDE00x'), '�x');
});

test('гонка недели: счёт — закрытые дни + ночи в цель с понедельника, у друга — из его снимка', () => {
  const s = life(); // пн 19 и вт 20 закрыты, сегодня 3 из 8; шаг с 19-го — 00:30, отбой 00:45 — мимо
  const me = { F: s, today: TODAY, sleep: true };
  assert.deepEqual(weekScore(me, '2026-10-19'), { closed: 2, nights: 0, score: 2 });
  // прошлая неделя целиком: 7 закрытых дней, 7 ночей в цель (шаг тогда был 01:00)
  assert.deepEqual(weekScore(me, '2026-10-12'), { closed: 7, nights: 7, score: 14 });
  // тот же счёт — у друга из снимка; скрыл сон — ночи не в счёт
  const v = readShare(shareOf(s, TODAY, { tz: 'America/Toronto' }), at(TODAY, 20));
  assert.deepEqual(weekScore(v, '2026-10-12'), { closed: 7, nights: 7, score: 14 });
  const hidden = readShare(shareOf(s, TODAY, { tz: 'America/Toronto', sleep: false }), at(TODAY, 20));
  assert.equal(hidden.sleep, false);
  assert.deepEqual(weekScore(hidden, '2026-10-12'), { closed: 7, nights: 0, score: 7 });
  // сегодня закрыт — +1 сразу; будущие дни недели не считаются
  closeDay(s, TODAY);
  assert.deepEqual(weekScore(me, '2026-10-19'), { closed: 3, nights: 0, score: 3 });
  // новичок с середины недели: дни до посева и утро посева — не в счёт
  const fresh = mk(TODAY);
  fresh.sleep.nights['2026-10-20'] = { bed: '23:00', wake: '07:00' };
  assert.deepEqual(weekScore({ F: fresh, today: TODAY, sleep: true }, '2026-10-19'), { closed: 0, nights: 0, score: 0 });
  // неделя, которая ещё не началась у этого «сегодня», — ноль
  assert.deepEqual(weekScore(me, '2026-10-26'), { closed: 0, nights: 0, score: 0 });
});

test('гонка недели: места по счёту, при равном — общее место, выше тот, у кого больше закрытых дней', () => {
  const r = ranked([
    { id: 'me', score: 3, closed: 2 }, { id: 'a', score: 4, closed: 2 }, { id: 'b', score: 3, closed: 3 }, { id: 'c', score: 0, closed: 0 },
  ]);
  assert.deepEqual(r.map(p => [p.id, p.place]), [['a', 1], ['b', 2], ['me', 2], ['c', 4]]);
  assert.deepEqual(ranked([{ id: 'me', score: 2, closed: 2 }, { id: 'a', score: 2, closed: 2 }]).map(p => [p.id, p.place]), [['me', 1], ['a', 1]]);
  assert.deepEqual(ranked([]), []);
});

test('разделы (v58) друзьям не уходят: ни названий, ни пунктов, ни отметок; счёт гонки тот же', () => {
  const s = life();
  const before = shareOf(s, TODAY, { tz: 'America/Toronto' });
  const sec = D.addSection(s, { name: 'Секретная работа', icon: 'briefcase', color: 'blue' }, TODAY, () => 'sec-1');
  const it = D.addSecItem(s, sec.id, { name: 'Тайный проект', note: 'никому' }, TODAY, () => 'sec-item-1');
  D.toggleSecMark(s, it.id, TODAY, TODAY);
  const snap = shareOf(s, TODAY, { tz: 'America/Toronto' });
  assert.deepEqual(snap, before, 'снимок не изменился');
  const text = JSON.stringify(snap);
  for (const secret of ['Секретная работа', 'Тайный проект', 'никому', 'sec-1', 'sec-item-1', 'secMarks', 'sections']) assert.ok(!text.includes(secret), secret);
  const v = readShare(JSON.parse(text), at(TODAY, 20));
  assert.deepEqual([v.F.sections, v.F.secMarks], [[], {}]);
  assert.deepEqual(weekScore(v, '2026-10-19'), weekScore(readShare(JSON.parse(JSON.stringify(before)), at(TODAY, 20)), '2026-10-19'));
});

test('чужой снимок с id «constructor» не роняет сводку и гонку', () => {
  const snap = JSON.parse(JSON.stringify(shareOf(life(), TODAY, { tz: 'America/Toronto' })));
  snap.weekly.unshift({ id: 'constructor', name: 'ловушка', perWeek: 3, icon: 'star', color: 'red', addedAt: '2026-09-30' });
  snap.items.push({ id: 'toString', name: 'ловушка', icon: 'star', color: 'red', addedAt: '2026-09-30' });
  const v = readShare(snap, at(TODAY, 20));
  assert.ok(v);
  assert.doesNotThrow(() => summaryOf(v.F, v.today));
  assert.doesNotThrow(() => weekScore(v, '2026-10-19'));
  assert.ok(!v.F.weekly.some(w => w.id === 'constructor') && !v.F.items.some(i => i.id === 'toString'));
});
