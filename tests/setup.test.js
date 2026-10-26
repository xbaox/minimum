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
  S.ui = { welcomeSeen: true, news: 'v58', lastExport: today };
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

async function start({ when = MON, storage = {}, idb = new IDBFactory(), server = null, motion = false } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e); });
  vc.on('error', e => errors.push(e));
  const dom = new JSDOM(HTML, { url: 'https://xbaox.github.io/minimum/', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  open.add(win);
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  const motionLog = motion ? recordMotion(win) : null;
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
  return { win, doc, app, t, idb, all, find, click, type, text, sheet, sheetText, alertBtn, next, picked, dump, hold, clean, done, errors, motionLog };
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
  assert.equal(a.doc.querySelector('.setup-foot .btn-primary').disabled, true, 'пустой минимум — дальше нельзя');
  assert.match(a.text(), /Выбери хотя бы один пункт/);
  for (const n of ['Стакан воды', 'Телефон на кухню', 'Чтение']) a.click(n, '.pick');
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
  assert.ok(me.snapshot, 'снимок уже на сервере');
  assert.doesNotMatch(JSON.stringify(me.snapshot), /Музыка|Работа/, 'разделы друзьям не уходят');
  a.clean('друзья');
  a.click('Начать', '.setup-foot button');
  await wait();

  // приложение: с сегодняшнего дня, без приветствий, разделы на «Сегодня»
  assert.equal(a.doc.querySelector('main.setup'), null);
  assert.ok(a.doc.querySelector('.tabbar'));
  const S = a.app.state;
  assert.deepEqual([S.createdAt, S.since, S.ui.setup, S.ui.welcomeSeen, S.ui.news], ['2026-10-26', '2026-10-26', false, true, 'v58']);
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
  assert.match(a.text(), /Отдельно от минимума: на серию, кольца и гонку не влияют, друзьям не видны/);
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
  const enter = () => log.filter(x => x.el.matches('main.setup')).at(-1);
  assert.equal(enter().frames[0].transform, 'translateY(12px)', 'первый шаг — снизу, как экран');
  assert.ok(log.some(x => x.el.matches('.setup-hero .rings .arc')), 'кольца дорисовываются');
  a.next();
  assert.equal(enter().frames[0].transform, 'translateX(28px)', 'вперёд — справа');
  a.click('Назад', '.setup-bar button');
  assert.equal(enter().frames[0].transform, 'translateX(-28px)', 'назад — слева');
  const keys = new Set(log.flatMap(x => x.frames.flatMap(f => Object.keys(f))));
  for (const k of keys) assert.ok(['transform', 'opacity', 'strokeDashoffset', 'offset'].includes(k), 'анимируется ' + k);
  a.done();
});
