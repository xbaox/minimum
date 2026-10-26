process.env.TZ = 'America/Toronto';
// Первая настройка нового телефона и разделы (v58) — приложение целиком в jsdom.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { boot } from '../app.js';
import { addDays, range, activeIds, addSection, addSecItem } from '../domain.js';
import { fakeSupabase } from './fake-supabase.js';
import { baoSeed } from './fixtures.js';
import { shareOf } from '../share.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const MON = new Date(2026, 9, 26, 9, 10); // понедельник 26 октября, утро
const sp = s => s.replace(/\u00a0/g, " "); // неразрывные пробелы → обычные для сравнения
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

const open = new Set();
afterEach(() => {
  for (const w of open) w.close();
  open.clear();
});

// Телефон в деле: пункты БАО за back дней и разделы «Работа» (два пункта) и выключенное «Хобби».
function withSections(today, back = 10) {
  let n = 0;
  const S = baoSeed(addDays(today, -back), () => 'i' + ++n);
  S.ui = { welcomeSeen: true, news: 'v59', lastExport: today };
  const ids = activeIds(S);
  for (const d of range(S.createdAt, addDays(today, -1))) S.days[d] = { plan: ids.slice(), done: [] };
  const w = addSection(S, { name: 'Работа', icon: 'briefcase', color: 'blue' }, S.createdAt, () => 'sec-w');
  addSecItem(S, w.id, { name: 'Главная задача', note: 'первым делом', icon: 'target', color: 'red' }, S.createdAt, () => 'w1');
  addSecItem(S, w.id, { name: 'Почта', note: 'два раза в день', icon: 'mail', color: 'blue' }, S.createdAt, () => 'w2');
  const hb = addSection(S, { name: 'Хобби', icon: 'heart', color: 'orange' }, S.createdAt, () => 'sec-h');
  addSecItem(S, hb.id, { name: 'Гитара', icon: 'music', color: 'orange' }, S.createdAt, () => 'h1');
  hb.on = false;
  S.secMarks = { w1: [addDays(today, -3)] };
  return { 'minimum.v2': JSON.stringify(S) };
}

// Подмена Web Animations: всё «доигрывает» сразу, ключевые кадры записываются.
function recordMotion(win) {
  const log = [];
  win.Element.prototype.animate = function (frames, opts) {
    const a = { el: this, frames, opts, finished: Promise.resolve(), cancel() {}, pause() {}, play() {} };
    log.push(a);
    return a;
  };
  return log;
}

async function start({ when = MON, storage = {}, idb = new IDBFactory(), server = null, motion = false, spy = false } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e); });
  vc.on('error', e => errors.push(e));
  const dom = new JSDOM(HTML, { url: 'https://xbaox.github.io/minimum/', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  open.add(win);
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  const motionLog = motion ? recordMotion(win) : null;
  // spy — живые таймеры окна по длительности: видно, взведён ли минутный опрос друзей.
  const live = new Map();
  if (spy) {
    const st = win.setTimeout.bind(win), ct = win.clearTimeout.bind(win);
    win.setTimeout = (f, ms, ...rest) => {
      const id = st((...x) => { live.delete(id); f(...x); }, ms, ...rest);
      live.set(id, ms);
      return id;
    };
    win.clearTimeout = id => { live.delete(id); ct(id); };
  }
  const timers = ms => [...live.values()].filter(v => v === ms).length;
  const t = { now: when };
  const cloud = server ? { url: server.url, key: server.key, fetch: server.fetch } : { url: '', key: '' };
  const app = await boot({ win, now: () => t.now, idb, cloud });
  const doc = win.document;
  const all = sel => [...doc.querySelectorAll(sel)];
  const find = (text, sel = 'button, label') => {
    const el = all(sel).find(e => sp(e.textContent).includes(text));
    assert.ok(el, 'не найдено: ' + text);
    return el;
  };
  const click = (text, sel) => find(text, sel).click();
  const type = (el, value) => { el.value = value; el.dispatchEvent(new win.Event('input', { bubbles: true })); };
  const text = () => sp(doc.querySelector('.screen').textContent);
  const sheet = () => doc.querySelector('.sheet');
  const sheetText = () => sp(doc.querySelector('.sheet')?.textContent || '');
  const alertBtn = label => [...doc.querySelectorAll('.alert button')].find(b => b.textContent === label).click();
  const next = () => doc.querySelector('.setup-foot .btn-primary').click();
  const picked = () => all('.pick[aria-pressed="true"] .name').map(e => e.textContent);
  const dump = () => {
    const o = {};
    for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); o[k] = win.localStorage.getItem(k); }
    return o;
  };
  const ptr = (el, type) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, button: 0 }));
  const hold = async el => {
    ptr(el, 'pointerdown');
    await wait(500);
    ptr(el, 'pointerup');
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  };
  const clean = where => assert.doesNotMatch(doc.getElementById('app').textContent, /null|undefined|NaN/, where);
  const done = () => { assert.deepEqual(errors.map(String), []); win.close(); open.delete(win); };
  return { win, doc, app, t, idb, all, find, click, type, text, sheet, sheetText, alertBtn, next, picked, dump, hold, clean, done, errors, motionLog, timers };
}

test('первая настройка: привет → минимум → сон → разделы → друзья; выборы сразу в состоянии; конец — приложение с сегодняшнего дня', async () => {
  const server = fakeSupabase({ now: () => MON });
  const sasha = server.addProfile({ name: 'Саша', code: 'R8DX4' });
  const a = await start({ server, when: new Date(2026, 9, 25, 22, 0) }); // настройку начали вечером в воскресенье
  assert.ok(a.doc.querySelector('main.setup'));
  assert.equal(a.doc.querySelector('.tabbar'), null);
  assert.equal(a.all('.dot-i').length, 5);
  assert.equal(a.doc.querySelector('.dots').getAttribute('aria-label'), 'Шаг 1 из 5');
  assert.match(a.text(), /Минимум/);
  assert.match(a.text(), /Пол, а не план/);
  assert.match(a.text(), /Не пропускай дважды/);
  assert.match(a.text(), /Друзья и гонка недели/);
  assert.equal(a.doc.querySelector('.setup-bar button'), null, 'на первом шаге — без «Назад»');
  a.clean('привет');
  a.t.now = MON; // продолжили утром — уже другой день
  a.click('Настроить', '.setup-foot button');

  // минимум: шаблон выбран, ещё шесть подсказок и свой пункт
  assert.match(a.text(), /Твой минимум/);
  assert.equal(a.all('.pick').length, 11);
  assert.deepEqual(a.picked(), ['Стакан воды', 'Зарядка', 'План на завтра', 'Телефон на кухню', 'Чтение']);
  assert.match(a.text(), /Выбрано 5/);
  a.click('Растяжка', '.pick');
  a.click('Зарядка', '.pick');
  assert.deepEqual(a.app.state.items.map(i => i.name), ['Стакан воды', 'План на завтра', 'Телефон на кухню', 'Чтение', 'Растяжка']);
  assert.ok(a.app.state.items.every(i => !i.archivedAt), 'убранное в настройке — бесследно, не в «Убранных»');
  a.click('Свой пункт', '.plus-row');
  a.type(a.sheet().querySelector('input[name="name"]'), 'Отжимания');
  a.doc.getElementById('sheet-done').click();
  await wait();
  assert.deepEqual(a.picked().at(-1), 'Отжимания');
  a.click('Отжимания', '.pick'); // свой — снимается и исчезает
  assert.ok(!a.app.state.items.some(i => i.name === 'Отжимания'));
  for (const n of ['Стакан воды', 'План на завтра', 'Телефон на кухню', 'Чтение', 'Растяжка']) a.click(n, '.pick');
  const main = () => a.doc.querySelector('.setup-foot .btn-primary');
  assert.deepEqual([main().disabled, main().textContent], [false, 'Добавлю потом'], 'пустой минимум — можно: пункты добавятся потом');
  assert.match(a.text(), /Выбрано 0/);
  assert.match(a.text(), /Можно и без пунктов: добавишь потом на «Сегодня» — из этих же подсказок или свои/);
  for (const n of ['Стакан воды', 'Телефон на кухню', 'Чтение']) a.click(n, '.pick');
  assert.equal(main().textContent, 'Дальше');
  a.clean('минимум');
  a.next();

  // сон: в часах, первый шаг — с первой ночи
  assert.match(a.text(), /Подъём.*7:30/);
  assert.match(a.text(), /6 ч 30 мин.*сейчас · отбой 01:00/);
  assert.match(a.text(), /8 ч.*цель · отбой 23:30/);
  assert.match(a.text(), /До цели 1 ч 30 мин — примерно 3–6 недель/);
  const bar = () => a.doc.querySelector('.nbar');
  assert.equal(sp(bar().getAttribute('aria-label')), 'Сейчас 6 ч 30 мин сна, цель 8 ч, подъём 7:30');
  assert.match(bar().getAttribute('style'), /--f:0\.5909;--g:0\.7273/); // 390 и 480 минут из 11 часов
  const barNode = bar();
  const btn = label => a.doc.querySelector(`[aria-label="${label}"]`);
  btn('Сейчас: больше на 15 минут').click();
  btn('Сейчас: больше на 15 минут').click();
  assert.match(a.text(), /7 ч.*сейчас · отбой 00:30/);
  assert.equal(bar(), barNode, 'полоса та же — сдвигается переходом, а не появляется заново');
  assert.match(bar().getAttribute('style'), /--f:0\.6364/);
  assert.deepEqual(a.app.state.sleep.targets, [{ from: a.app.state.createdAt, bed: '00:30' }]);
  for (let i = 0; i < 6; i++) btn('Сейчас: больше на 15 минут').click();
  assert.equal(btn('Сейчас: больше на 15 минут').disabled, true, 'не больше цели');
  assert.match(a.text(), /Сейчас — уже цель/);
  btn('Цель сна: меньше на 15 минут').click(); // цель ниже «сейчас» — «сейчас» опускается вместе с ней
  assert.match(a.text(), /7 ч 45 мин.*сейчас · отбой 23:45/);
  btn('Сейчас: меньше на 15 минут').click();
  btn('Сейчас: меньше на 15 минут').click();
  const wake = a.doc.querySelector('.time-row input[type=time]');
  wake.value = '06:30';
  wake.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  assert.equal(a.app.state.sleep.goalWake, '06:30');
  assert.match(a.text(), /7 ч 15 мин.*сейчас · отбой 23:15/, 'часы сна те же');
  a.clean('сон');
  a.next();

  // разделы: три на выбор и свой
  assert.match(a.text(), /Разделы/);
  assert.deepEqual(a.all('.switch-row').map(r => r.getAttribute('aria-checked')), ['false', 'false', 'false']);
  a.click('Учёба', '.switch-row');
  a.click('Работа', '.switch-row');
  assert.deepEqual(a.app.state.sections.map(x => x.name), ['Работа', 'Учёба'], 'порядок — как в списке');
  a.click('Учёба', '.switch-row');
  assert.deepEqual(a.app.state.sections.map(x => x.name), ['Работа']);
  a.click('Свой раздел', '.plus-row');
  assert.match(a.sheetText(), /Новый раздел/);
  a.type(a.sheet().querySelector('input[name="name"]'), 'Музыка');
  a.doc.getElementById('sheet-done').click();
  await wait();
  assert.deepEqual(a.app.state.sections.map(x => x.name), ['Работа', 'Музыка']);
  assert.match(a.text(), /Музыкасвой раздел/);
  a.clean('разделы');
  assert.equal(server.profiles.length, 1, 'до шага друзей сервер не знает о телефоне');
  a.next();

  // друзья: имя и код друга — включить и сразу запрос
  assert.match(a.text(), /Прогресс вместе/);
  const join = () => a.doc.getElementById('setup-join');
  assert.equal(join().disabled, true, 'без имени — нельзя');
  a.type(a.doc.querySelector('input[name="friend-name"]'), 'Бао');
  assert.equal(join().disabled, false);
  assert.equal(join().textContent, 'Включить друзей');
  a.type(a.doc.getElementById('setup-code'), 'r8d-x4');
  assert.equal(join().textContent, 'Включить и добавить друга');
  join().click();
  await wait(80);
  assert.ok(a.app.cloud.joined);
  assert.match(a.text(), /Твой код/);
  assert.match(a.text(), /Запрос отправлен/);
  const me = server.profiles.find(p => p.name === 'Бао');
  assert.ok(server.links.some(l => l.from === me.id && l.to === sasha.id), 'запрос другу ушёл');
  assert.equal(me.snapshot, null, 'пока идёт настройка — снимок не уходит');
  a.clean('друзья');
  a.click('Начать', '.setup-foot button');
  await wait(60);
  assert.ok(me.snapshot, 'настройка закончена — снимок сразу на сервере');
  assert.equal(me.snapshot.createdAt, '2026-10-26');
  assert.doesNotMatch(JSON.stringify(me.snapshot), /Музыка|Работа/, 'разделы друзьям не уходят');

  // приложение: с сегодняшнего дня, без приветствий, разделы на «Сегодня»
  assert.equal(a.doc.querySelector('main.setup'), null);
  assert.ok(a.doc.querySelector('.tabbar'));
  const S = a.app.state;
  assert.deepEqual([S.createdAt, S.since, S.ui.setup, S.ui.welcomeSeen, S.ui.news], ['2026-10-26', '2026-10-26', false, true, 'v59']);
  assert.deepEqual(S.sleep.targets, [{ from: '2026-10-26', bed: '23:15' }]); // 7 ч 15 мин до подъёма 6:30
  assert.deepEqual([...a.doc.querySelectorAll('.list-min > .row .name')].map(e => e.textContent), ['Стакан воды', 'Телефон на кухню', 'Чтение']);
  assert.doesNotMatch(a.text(), /Новый минимум|Что нового/);
  assert.match(a.text(), /Работа.*Добавить пункт.*Музыка.*Добавить пункт/);
  assert.doesNotMatch(a.text(), /Вчера:|пропуск/i, 'дни настройки — не пропуски');
  a.done();
});

test('настройка переживает перезапуск: выборы на месте; без сервера шага друзей нет', async () => {
  const a = await start();
  assert.equal(a.all('.dot-i').length, 4);
  a.next();
  a.click('Прогулка', '.pick');
  a.click('Чтение', '.pick');
  a.next();
  a.doc.querySelector('[aria-label="Сейчас: больше на 15 минут"]').click();
  const storage = a.dump();
  a.done();
  const b = await start({ storage });
  assert.ok(b.doc.querySelector('main.setup'), 'настройка не закончена — снова она');
  b.next();
  assert.deepEqual(b.picked(), ['Стакан воды', 'Зарядка', 'План на завтра', 'Телефон на кухню', 'Прогулка']);
  b.next();
  assert.match(b.text(), /6 ч 45 мин.*сейчас · отбой 00:45/);
  b.click('Назад', '.setup-bar button');
  assert.match(b.text(), /Твой минимум/);
  b.next();
  b.next();
  assert.equal(b.doc.querySelector('.setup-foot .btn-primary').textContent, 'Начать');
  b.next();
  assert.equal(b.doc.querySelector('main.setup'), null);
  assert.equal(b.all('.list-min > .row').length, 5);
  b.done();
});

test('«Добавлю потом»: настройка без пунктов → «Сегодня» с подсказками; пункты вечером — ни вчера, ни их первый день не пропуск', async () => {
  const a = await start(); // понедельник 26 октября, без сервера
  a.next();
  for (const n of ['Стакан воды', 'Зарядка', 'План на завтра', 'Телефон на кухню', 'Чтение']) a.click(n, '.pick');
  a.click('Добавлю потом', '.setup-foot button');
  a.next();
  assert.match(a.text(), /Можно и без разделов — добавишь потом в Настройках/);
  assert.doesNotMatch(a.text(), /Что видят друзья/, 'без сервера — ни слова о друзьях');
  assert.equal(a.doc.querySelector('.setup-foot .btn-primary').textContent, 'Начать');
  a.next();
  assert.equal(a.doc.querySelector('main.setup'), null);
  assert.deepEqual([a.app.state.items, a.app.state.createdAt], [[], '2026-10-26']);
  assert.equal(a.all('.list-min > .row').length, 0);
  assert.match(a.text(), /Из подсказок11 пунктов на выборСвой пункт/);
  a.clean('пустое «Сегодня»');
  // вторник прошёл пустым; в среду вечером — первые пункты
  a.t.now = new Date(2026, 9, 28, 21, 0);
  a.app.render();
  a.click('Из подсказок', '.row');
  a.click('Стакан воды', '.sheet .pick');
  a.click('Зарядка', '.sheet .pick');
  a.doc.getElementById('sheet-done').click();
  await wait();
  assert.deepEqual(a.all('.list-min > .row .name').map(e => e.textContent), ['Стакан воды', 'Зарядка']);
  assert.doesNotMatch(a.text(), /Вчера/, 'во вторник минимум был пуст — он не пропуск и не «доотметить»');
  // среду не закрыли: в четверг она не пропуск — первый день минимума; доотметить её можно
  a.t.now = new Date(2026, 9, 29, 9, 0);
  a.app.render();
  assert.match(a.text(), /Вчера: 0 из 2/);
  assert.doesNotMatch(a.text(), /не пропускай дважды/);
  a.click('Прогресс', '.tab');
  a.all('.chain button.cell').find(c => sp(c.getAttribute('aria-label')).includes('28 октября')).click();
  assert.equal(sp(a.sheet().querySelector('.day-status').textContent), 'Первый день — не в счёт · 0 из 2');
  a.click('Готово', '.sheet-act');
  // четверг тоже не закрыли — в пятницу обычное правило: пропуск, прощённый
  a.t.now = new Date(2026, 9, 30, 9, 0);
  a.click('Сегодня', '.tab');
  assert.match(a.text(), /Вчера пропуск — сегодня не пропускай дважды/);
  a.done();
});

test('новый раздел после настройки — готовые одним касанием; в самой настройке их нет — там они списком', async () => {
  const a = await start({ storage: withSections('2026-10-26') }); // уже есть «Работа» и «Хобби»
  a.click('Настройки', '.tab');
  a.click('Добавить раздел', '.plus-row');
  assert.deepEqual([...a.sheet().querySelectorAll('.chip')].map(c => c.textContent), ['Учёба']);
  a.click('Учёба', '.sheet .chip');
  assert.equal(a.sheet().querySelector('input[name="name"]').value, 'Учёба');
  assert.equal(a.sheet().querySelector('.pv-name').textContent, 'Учёба');
  assert.equal(a.sheet().querySelector('.chip').getAttribute('aria-pressed'), 'true');
  a.doc.getElementById('sheet-done').click();
  await wait();
  const sec = a.app.state.sections.at(-1);
  assert.deepEqual([sec.name, sec.icon, sec.color], ['Учёба', 'cap', 'purple']);
  a.click('Добавить раздел', '.plus-row');
  assert.equal(a.sheet().querySelector('.chip'), null, 'все готовые уже есть');
  a.click('Отмена', '.sheet-act');
  a.done();
  const b = await start();
  for (let i = 0; i < 3; i++) b.next();
  b.click('Свой раздел', '.plus-row');
  assert.equal(b.sheet().querySelector('.chip'), null);
  b.done();
});

test('восстановить из копии в первой настройке — без подтверждения; битый файл — причина на месте', async () => {
  const a = await start();
  const input = a.doc.querySelector('.setup-alt input[type=file]');
  const pick = async content => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new a.win.File([content], 'x.json')] });
    input.dispatchEvent(new a.win.Event('change', { bubbles: true }));
    await wait(20);
  };
  await pick('не json');
  assert.match(a.text(), /Не удалось прочитать файл — это не JSON/);
  assert.ok(a.doc.querySelector('main.setup'));
  const copy = JSON.parse(withSections('2026-10-26')['minimum.v2']);
  copy.ui.setup = true; // даже такой файл не возвращает настройку
  await pick(JSON.stringify(copy));
  assert.equal(a.doc.querySelector('.alert'), null, 'стирать нечего — без подтверждения');
  assert.equal(a.doc.querySelector('main.setup'), null);
  assert.equal(a.all('.list-min > .row').length, 8);
  assert.match(a.text(), /Работа/);
  assert.match(sp(a.doc.querySelector('.bars').textContent), /Данные восстановлены из копии/);
  a.done();
});

test('друзья в настройке: нет связи — понятная причина, «Пропустить» ведёт в приложение', async () => {
  const server = fakeSupabase({ now: () => MON });
  server.mode = 'offline';
  const a = await start({ server });
  for (let i = 0; i < 4; i++) a.next();
  a.type(a.doc.querySelector('input[name="friend-name"]'), 'Бао');
  a.doc.getElementById('setup-join').click();
  await wait(60);
  assert.match(a.text(), /Нет связи с сервером/);
  assert.equal(a.app.cloud.joined, false);
  a.click('Пропустить', '.setup-foot button');
  assert.equal(a.doc.querySelector('main.setup'), null);
  assert.equal(a.app.state.ui.setup, false);
  a.done();
});

test('«Начать заново» при включённых друзьях: в настройке — свой код и «Добавить»', async () => {
  const server = fakeSupabase({ now: () => MON });
  const sasha = server.addProfile({ name: 'Саша', code: 'R8DX4' });
  const a = await start({ server, storage: withSections('2026-10-26') });
  a.click('Друзья', '.tab');
  a.type(a.doc.querySelector('input[name="friend-name"]'), 'Бао');
  a.click('Включить друзей');
  await wait(60);
  a.click('Настройки', '.tab');
  a.click('Начать заново');
  a.alertBtn('Стереть');
  assert.ok(a.doc.querySelector('main.setup'));
  assert.deepEqual([a.app.state.sections, a.app.state.secMarks], [[], {}], 'разделы стёрты');
  for (let i = 0; i < 4; i++) a.next();
  assert.match(a.text(), /Твой код/);
  const add = a.doc.getElementById('setup-add');
  assert.equal(add.disabled, true);
  a.type(a.doc.getElementById('setup-code'), 'ZZZZZ');
  assert.equal(add.disabled, false);
  add.click();
  await wait(60);
  assert.match(a.text(), /Такого кода нет/);
  a.type(a.doc.getElementById('setup-code'), 'R8DX4');
  a.doc.getElementById('setup-add').click();
  await wait(60);
  assert.match(a.text(), /Запрос отправлен/);
  assert.equal(a.doc.getElementById('setup-code').value, '', 'код ушёл — поле пустое');
  const me = server.profiles.find(p => p.name === 'Бао');
  assert.ok(server.links.some(l => l.from === me.id && l.to === sasha.id));
  a.click('Начать', '.setup-foot button');
  assert.equal(a.doc.querySelector('main.setup'), null);
  a.done();
});

test('разделы на «Сегодня»: отметка цветом пункта, минимум и серия не меняются; удержание — детали без отбоя и друзей', async () => {
  const a = await start({ storage: withSections('2026-10-26') });
  assert.match(a.text(), /Работа0 из 2/);
  assert.doesNotMatch(a.text(), /Гитара/, 'выключенный раздел не виден');
  const hero = () => sp(a.doc.querySelector('.hero .count').textContent);
  const streak = () => a.doc.querySelector('.topbar .streak').getAttribute('aria-label');
  const before = [hero(), streak()];
  const row = () => a.find('Главная задача', '.list-sec .row');
  row().click();
  assert.equal(row().getAttribute('aria-pressed'), 'true');
  assert.ok(row().classList.contains('done'));
  assert.ok(row().classList.contains('sec-row'), 'отметка — цветом пункта, не закатом минимума');
  assert.deepEqual(a.app.state.secMarks.w1, ['2026-10-23', '2026-10-26']);
  assert.match(a.text(), /Работа1 из 2/);
  assert.deepEqual([hero(), streak()], before, 'минимум и серия те же');
  assert.equal(a.app.state.days['2026-10-26'].done.length, 0);
  await a.hold(a.find('Почта', '.list-sec .row'));
  assert.ok(a.sheet());
  assert.match(a.sheetText(), /Раздел «Работа» · отдельно от минимума/);
  assert.match(a.sheetText(), /эта неделя/);
  assert.match(a.sheetText(), /без отметки/);
  assert.doesNotMatch(a.sheetText(), /Привязать к отбою|Видно друзьям|подряд|пропуск/);
  a.type(a.sheet().querySelector('input[name="name"]'), 'Почта и чаты');
  a.doc.getElementById('sheet-done').click();
  await wait();
  assert.match(a.text(), /Почта и чаты/);
  await a.hold(a.find('Почта и чаты', '.list-sec .row'));
  a.click('Удалить из раздела', '.sheet button');
  assert.match(sp(a.doc.querySelector('.alert').textContent), /Удалить «Почта и чаты»\?.*Отметки пункта сотрутся/);
  a.alertBtn('Удалить');
  await wait();
  assert.doesNotMatch(a.text(), /Почта и чаты/);
  assert.equal(a.app.state.sections[0].items.length, 1);
  a.clean('сегодня');
  a.done();
});

test('разделы в Настройках: переключатель, новый раздел и пункт, удаление через подтверждение, порядок', async () => {
  const a = await start({ storage: withSections('2026-10-26') });
  a.click('Настройки', '.tab');
  const sw = name => a.find(name, '.switch-row');
  assert.equal(sw('Работа').getAttribute('aria-checked'), 'true');
  assert.equal(sw('Хобби').getAttribute('aria-checked'), 'false');
  assert.match(sp(sw('Хобби').textContent), /выключен · 1 пункт/);
  assert.match(a.text(), /Отдельно от минимума: на серию, кольца и гонку не влияют\.РаботаНастроить/); // без сервера — ни слова о друзьях
  sw('Работа').click();
  a.click('Сегодня', '.tab');
  assert.doesNotMatch(a.text(), /Главная задача/, 'выключенный — пропал с «Сегодня»');
  assert.equal(a.app.state.sections[0].items.length, 2, 'пункты остались');
  a.click('Настройки', '.tab');
  sw('Работа').click();
  a.click('Добавить раздел', '.plus-row');
  assert.equal(a.doc.getElementById('sheet-done').disabled, true);
  a.type(a.sheet().querySelector('input[name="name"]'), 'Учёба');
  a.sheet().querySelector('[aria-label="фиолетовый"]').click();
  a.doc.getElementById('sheet-done').click();
  await wait();
  assert.deepEqual(a.app.state.sections.map(x => [x.name, x.color, x.on]), [['Работа', 'blue', true], ['Хобби', 'orange', false], ['Учёба', 'purple', true]]);
  a.click('Сегодня', '.tab');
  assert.match(a.text(), /Учёба.*Добавить пункт/);
  a.find('Добавить пункт', '.list-sec .plus-row').click();
  assert.match(a.sheetText(), /Новый пункт.*Раздел «Учёба»/);
  assert.equal(a.sheet().querySelector('.preview').getAttribute('style').includes('purple'), true, 'цвет пункта — цвет раздела');
  a.type(a.sheet().querySelector('input[name="name"]'), 'Домашка');
  a.doc.getElementById('sheet-done').click();
  await wait();
  assert.match(a.text(), /Учёба0 из 1.*Домашка/);
  a.click('Настройки', '.tab');
  // «Изменить» — порядок разделов
  a.click('Изменить', '.head-action');
  a.doc.querySelector('[aria-label="Учёба: выше"]').click();
  assert.deepEqual(a.app.state.sections.map(x => x.name), ['Работа', 'Учёба', 'Хобби']);
  a.click('Готово', '.head-action');
  // удалить раздел — с пунктами и отметками, через подтверждение
  const link = [...a.doc.querySelectorAll('.sec-h')].find(hh => sp(hh.textContent).startsWith('Работа')).querySelector('.link');
  link.click();
  assert.match(a.sheetText(), /Раздел.*2 пункта/);
  a.click('Удалить раздел', '.sheet button');
  assert.match(sp(a.doc.querySelector('.alert').textContent), /Удалить раздел «Работа»\?.*можно просто выключить/);
  a.alertBtn('Удалить');
  await wait();
  assert.deepEqual(a.app.state.sections.map(x => x.name), ['Учёба', 'Хобби']);
  assert.equal(a.app.state.secMarks.w1, undefined);
  a.clean('настройки');
  a.done();
});

test('лист дня: разделы — вчера можно отметить, раньше — только посмотреть', async () => {
  const a = await start({ storage: withSections('2026-10-26') });
  a.click('Прогресс', '.tab');
  [...a.doc.querySelectorAll('.chain button.cell')].find(c => sp(c.getAttribute('aria-label')).includes('25 октября')).click();
  assert.match(a.sheetText(), /Работа0 из 2/);
  a.find('Почта', '.sheet .sec-row').click();
  assert.deepEqual(a.app.state.secMarks.w2, ['2026-10-25']);
  assert.match(a.sheetText(), /Работа1 из 2/);
  a.click('Готово', '.sheet-act');
  await wait();
  [...a.doc.querySelectorAll('.chain button.cell')].find(c => sp(c.getAttribute('aria-label')).includes('23 октября')).click();
  assert.match(a.sheetText(), /Работа1 из 2/);
  assert.equal(a.doc.querySelector('.sheet button.sec-row'), null, 'раньше вчера — только посмотреть');
  assert.ok(a.doc.querySelector('.sheet .sec-row.static.done'));
  a.done();
});

test('движение настройки: шаг въезжает с той стороны, куда идём; только transform и opacity', async () => {
  const a = await start({ motion: true });
  const log = a.motionLog;
  const enter = () => log.filter(x => x.el.matches('main.setup, .setup-body')).at(-1);
  assert.equal(enter().frames[0].transform, 'translateY(12px)', 'первый шаг — снизу, как экран');
  assert.ok(log.some(x => x.el.matches('.setup-hero .rings .arc')), 'кольца дорисовываются');
  const foot = a.doc.querySelector('.setup-foot');
  a.next();
  assert.ok(enter().el.matches('.setup-clip > .setup-body'), 'едет только содержимое шага — внутри обёртки, которая режет сдвиг вбок');
  assert.equal(enter().frames[0].transform, 'translateX(28px)', 'вперёд — справа');
  assert.equal(a.doc.querySelector('.setup-foot'), foot, 'кнопка снизу — тот же узел, стоит на месте');
  a.click('Назад', '.setup-bar button');
  assert.equal(enter().frames[0].transform, 'translateX(-28px)', 'назад — слева');
  const keys = new Set(log.flatMap(x => x.frames.flatMap(f => Object.keys(f))));
  for (const k of keys) assert.ok(['transform', 'opacity', 'strokeDashoffset', 'offset'].includes(k), 'анимируется ' + k);
  a.done();
});

test('в настройке снимок не уходит ни одним путём: фон, возврат, опрос, видимость своего пункта', async () => {
  const server = fakeSupabase({ now: () => MON });
  const sasha = server.addProfile({ name: 'Саша', code: 'R8DX4', snapshot: { meta: { day: '2026-10-26' } } });
  const a = await start({ server, storage: withSections('2026-10-26') });
  a.click('Друзья', '.tab');
  a.type(a.doc.querySelector('input[name="friend-name"]'), 'Бао');
  a.click('Включить друзей');
  await wait(60);
  const me = server.profiles.find(p => p.name === 'Бао');
  server.befriend(me, sasha);
  const sent = () => server.calls.filter(c => c.body.p_snapshot).length;
  a.click('Настройки', '.tab');
  a.click('Начать заново');
  a.alertBtn('Стереть');
  await wait(60);
  const before = sent();
  const visibility = async state => {
    Object.defineProperty(a.doc, 'visibilityState', { configurable: true, get: () => state });
    a.doc.dispatchEvent(new a.win.Event('visibilitychange'));
    await wait(60);
  };
  await visibility('hidden'); // уход в фон — снимок с keepalive
  await visibility('visible'); // возврат — синхронизация
  a.win.dispatchEvent(new a.win.Event('online'));
  a.next();
  a.click('Свой пункт', '.plus-row');
  a.type(a.sheet().querySelector('input[name="name"]'), 'Секретный пункт');
  assert.match(a.sheetText(), /Видно друзьям/); // друзья включены — переключатель видимости тоже не шлёт снимок
  a.doc.getElementById('sheet-done').click();
  await wait(2700); // дольше задержки публикации
  assert.equal(sent(), before, 'ни одного снимка, пока идёт настройка');
  assert.doesNotMatch(JSON.stringify(me.snapshot || {}), /Секретный пункт/);
  for (const b of ['Дальше', 'Дальше', 'Дальше', 'Начать']) a.click(b, '.setup-foot button');
  await wait(60);
  assert.ok(sent() > before, 'закончили — снимок ушёл');
  assert.match(JSON.stringify(me.snapshot), /Секретный пункт/);
  a.done();
});

test('гонка: в настройке опрос друзей молчит, после «Начать» — снова раз в минуту', async () => {
  const server = fakeSupabase({ now: () => MON });
  const friend = JSON.parse(withSections('2026-10-26')['minimum.v2']);
  const sasha = server.addProfile({ name: 'Саша', code: 'R8DX4', snapshot: shareOf(friend, '2026-10-26', { tz: 'America/Toronto' }) });
  const a = await start({ server, storage: withSections('2026-10-26'), spy: true });
  a.click('Друзья', '.tab');
  a.type(a.doc.querySelector('input[name="friend-name"]'), 'Бао');
  a.click('Включить друзей');
  await wait(60);
  server.befriend(server.profiles.find(p => p.name === 'Бао'), sasha);
  a.click('Сегодня', '.tab');
  a.win.dispatchEvent(new a.win.Event('online')); // друг появился — свежий список сразу
  await wait(60);
  assert.ok(a.doc.querySelector('.race'), 'гонка на «Сегодня»');
  assert.equal(a.timers(60e3), 1, 'гонка на экране — опрос раз в минуту');
  a.click('Настройки', '.tab');
  a.click('Начать заново');
  a.alertBtn('Стереть');
  a.win.dispatchEvent(new a.win.Event('online'));
  await wait(60);
  assert.equal(a.timers(60e3), 0, 'в настройке гонки нет — и опроса нет');
  for (let i = 0; i < 4; i++) a.next();
  a.click('Начать', '.setup-foot button');
  await wait(60);
  assert.equal(a.timers(60e3), 1, 'после настройки опрос снова идёт');
  a.done();
});

test('свой пункт с названием подсказки — свой; код друга после Enter — поле пустое', async () => {
  const server = fakeSupabase({ now: () => MON });
  server.addProfile({ name: 'Саша', code: 'R8DX4' });
  const a = await start({ server });
  a.next();
  a.click('Свой пункт', '.plus-row');
  a.type(a.sheet().querySelector('input[name="name"]'), 'Чтение');
  a.type(a.sheet().querySelector('textarea[name="note"]'), '30 минут · своё');
  a.doc.getElementById('sheet-done').click();
  await wait();
  assert.match(a.text(), /Выбрано 6/);
  assert.equal(a.picked().length, 6, 'свой «Чтение» — отдельная отмеченная строка');
  a.find('Чтение10 страниц', '.pick').click(); // шаблонный «Чтение» снимается, свой остаётся
  assert.deepEqual(a.app.state.items.map(i => [i.name, i.note]).filter(x => x[0] === 'Чтение'), [['Чтение', '30 минут · своё']]);
  assert.equal(a.find('Чтение10 страниц', '.pick').getAttribute('aria-pressed'), 'false');
  for (let i = 0; i < 3; i++) a.next();
  a.type(a.doc.querySelector('input[name="friend-name"]'), 'Бао');
  a.doc.getElementById('setup-join').click();
  await wait(60);
  const input = a.doc.getElementById('setup-code');
  input.focus();
  a.type(input, 'R8DX4');
  input.dispatchEvent(new a.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(60);
  assert.match(a.text(), /Запрос отправлен/);
  assert.equal(a.doc.getElementById('setup-code').value, '', 'поле в фокусе тоже очищено');
  assert.equal(a.doc.getElementById('setup-add').disabled, true);
  a.done();
});

test('«Прогресс»: разделы — 8 недель столбиками и доля по пунктам; выключенный не показан; тап — детали пункта', async () => {
  const a = await start({ storage: withSections('2026-10-26') });
  a.click('Прогресс', '.tab');
  assert.match(a.text(), /Работа8 недель/);
  assert.doesNotMatch(a.text(), /Хобби8 недель/, 'выключенный раздел не показан');
  assert.deepEqual(a.all('.sbar-n').map(e => e.textContent), ['', '', '', '', '', '0', '1', '0'], 'до раздела — пусто, дальше отметки по неделям');
  assert.equal(a.all('.sbar.none').length, 5);
  assert.ok(a.all('.sbar').at(-1).classList.contains('now'));
  assert.match(a.doc.querySelector('.sbars').getAttribute('aria-label'), /Работа, отметок по неделям: 0, 0, 0, 0, 0, 0, 1, 0/);
  assert.deepEqual(a.all('.sec-rates .rate-val').map(e => e.textContent), ['10%', '0%']); // 1 из 10 дней с появления
  assert.match(a.text(), /Столбики — отметки за неделю/);
  a.find('Главная задача', '.sec-rates .rate').click();
  assert.match(a.sheetText(), /Раздел «Работа»/);
  a.clean('прогресс');
  a.done();
});

test('раздел друзьям: закрыт по умолчанию; открытый друг видит с сегодняшними отметками, гонка — та же', async () => {
  const server = fakeSupabase({ now: () => MON });
  // друг с открытым разделом «Хобби» и отметкой сегодня
  const fs = JSON.parse(withSections('2026-10-26')['minimum.v2']);
  fs.sections[1].on = true;
  fs.secMarks = { h1: ['2026-10-26'] };
  const sasha = server.addProfile({ name: 'Саша', code: 'R8DX4', snapshot: shareOf(fs, '2026-10-26', { tz: 'America/Toronto', sections: ['sec-h'] }) });
  const a = await start({ server, storage: withSections('2026-10-26') });
  a.click('Друзья', '.tab');
  a.type(a.doc.querySelector('input[name="friend-name"]'), 'Бао');
  a.click('Включить друзей');
  await wait(60);
  const me = server.profiles.find(p => p.name === 'Бао');
  assert.equal('sections' in me.snapshot, false, 'по умолчанию разделы закрыты');
  server.befriend(me, sasha);
  a.win.dispatchEvent(new a.win.Event('online'));
  await wait(60);
  // лист друга: его открытый раздел — сегодняшние отметки цветом пункта, только для чтения
  a.find('Саша', '.list-friends .friend').click();
  assert.match(a.sheetText(), /Хобби1 из 1Гитара/);
  assert.ok(a.doc.querySelector('.sheet .sec-row.static.done'));
  assert.match(a.sheetText(), /Разделы — сверх минимума: на серию и гонку не влияют/);
  assert.doesNotMatch(a.sheetText(), /Главная задача/, 'закрытый раздел друга не виден');
  a.click('Готово', '.sheet-act');
  await wait();
  // «Что видят друзья» → «Разделы»: выключенный не предлагается, открыть «Работу»
  a.click('Что видят друзья', '.link');
  assert.match(a.sheetText(), /РазделыРаботазакрыт — друзья не видят/);
  assert.doesNotMatch(a.sheetText(), /Хобби/);
  a.find('Работа', '.sheet .switch-row').click();
  assert.deepEqual(a.app.cloud.prefs.sections, ['sec-w']);
  assert.match(a.sheetText(), /Работадрузья видят пункты и отметки/);
  a.click('Готово', '.sheet-act');
  await wait();
  a.click('Сегодня', '.tab');
  const scoreBefore = sp(a.doc.querySelector('.race').textContent);
  a.find('Главная задача', '.list-sec .row').click();
  assert.equal(sp(a.doc.querySelector('.race').textContent), scoreBefore, 'гонка — только минимум и сон');
  await wait(2700); // снимок уходит, когда отметки улягутся
  assert.deepEqual(me.snapshot.sections.map(x => [x.name, x.items.map(i => [i.name, i.m.at(-1)])]), [['Работа', [['Главная задача', '1'], ['Почта', '0']]]]);
  // «Я» — так тебя видят друзья
  a.click('Друзья', '.tab');
  a.find('Бао', '.list-friends .friend').click();
  assert.match(a.sheetText(), /Работа1 из 2/);
  a.click('Готово', '.sheet-act');
  await wait();
  // лист раздела: «Видно друзьям» — тот же переключатель; новый раздел закрыт
  a.click('Настройки', '.tab');
  [...a.doc.querySelectorAll('.sec-h')].find(hh => sp(hh.textContent).startsWith('Работа')).querySelector('.link').click();
  const shared = () => [...a.doc.querySelectorAll('.sheet .switch-row')].find(r => sp(r.textContent).includes('Видно друзьям'));
  assert.equal(shared().getAttribute('aria-checked'), 'true');
  shared().click();
  a.doc.getElementById('sheet-done').click();
  await wait();
  assert.deepEqual(a.app.cloud.prefs.sections, []);
  a.click('Добавить раздел', '.plus-row');
  assert.equal(shared().getAttribute('aria-checked'), 'false', 'новый раздел друзьям закрыт');
  a.click('Отмена', '.sheet-act');
  a.done();
});
