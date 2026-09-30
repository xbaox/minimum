process.env.TZ = 'America/Toronto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { boot } from '../app.js';
import { normalize } from '../domain.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WED = new Date(2026, 8, 30, 9, 0); // среда 30 сентября, утро

async function start(when, { storage = {}, idb = new IDBFactory() } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e); });
  vc.on('error', e => errors.push(e));
  const dom = new JSDOM(HTML, { url: 'https://xbaox.github.io/minimum/', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  const t = { now: when };
  const app = await boot({ win, now: () => t.now, idb });
  const doc = win.document;
  const dump = () => {
    const o = {};
    for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); o[k] = win.localStorage.getItem(k); }
    return o;
  };
  const all = sel => [...doc.querySelectorAll(sel)];
  const find = (text, sel = 'button, label') => {
    const el = all(sel).find(e => e.textContent.includes(text));
    assert.ok(el, 'не найдено: ' + text);
    return el;
  };
  const click = (text, sel) => find(text, sel).click();
  const type = (el, value) => { el.value = value; el.dispatchEvent(new win.Event('input', { bubbles: true })); };
  const rows = () => all('.screen > .list')[0]?.querySelectorAll(':scope > .row') ?? [];
  const text = () => doc.querySelector('.screen').textContent;
  const done = () => { assert.deepEqual(errors.map(String), []); win.close(); };
  return { win, doc, app, t, idb, dump, all, find, click, type, rows, text, done, errors };
}

const reboot = async (prev, when = prev.t.now) => {
  const storage = prev.dump();
  prev.done();
  return start(when, { storage, idb: prev.idb });
};

test('первый старт со старыми ключами: стёрто, 8 строк, приветствие один раз', async () => {
  const idb = new IDBFactory();
  await new Promise(ok => { const r = idb.open('minimum', 1); r.onupgradeneeded = () => r.result.createObjectStore('x'); r.onsuccess = () => { r.result.close(); ok(); }; });
  const a = await start(WED, {
    idb,
    storage: { 'minimum:data': '{"old":1}', 'minimum:data:corrupt': 'x', 'minimum:data:wiped': '1', 'englishSummer.v2': 'соседи' },
  });
  const keys = Object.keys(a.dump()).sort();
  assert.deepEqual(keys, ['englishSummer.v2', 'minimum.v2']);
  assert.ok(!(await idb.databases()).some(d => d.name === 'minimum'));
  assert.equal(a.rows().length, 8);
  assert.match(a.text(), /Новый минимум: 8 пунктов/);
  assert.match(a.text(), /среда/);
  assert.match(a.text(), /30 сентября/);
  assert.match(a.text(), /🌙 Отбой 01:00 · цель 23:30 · подъём 7:30/);
  assert.equal(a.all('.screen > .list')[1].querySelectorAll('.row').length, 1); // Тренировка
  a.click('Понятно');
  assert.doesNotMatch(a.text(), /Новый минимум/);
  const b = await reboot(a);
  assert.doesNotMatch(b.text(), /Новый минимум/);
  assert.equal(b.rows().length, 8);
  b.done();
});

test('тап отмечает и снимает; 8 из 8 → «День закрыт» с откликом один раз', async () => {
  const a = await start(WED);
  const r0 = () => a.rows()[0];
  r0().click();
  assert.equal(r0().getAttribute('aria-pressed'), 'true');
  assert.match(a.text(), /1 из 8/);
  r0().click();
  assert.equal(r0().getAttribute('aria-pressed'), 'false');
  assert.match(a.text(), /0 из 8/);
  for (let i = 0; i < 8; i++) a.rows()[i].click();
  assert.match(a.text(), /День закрыт ✓/);
  assert.ok(a.doc.querySelector('.segs.celebrate'));
  a.app.render();
  assert.equal(a.doc.querySelector('.segs.celebrate'), null); // перерисовка не повторяет праздник
  assert.match(a.doc.querySelector('.streak').textContent, /🔥 1/);
  a.done();
});

test('у «Телефон на кухню» дедлайн от шага: до 00:30', async () => {
  const a = await start(WED);
  const phone = [...a.rows()].find(r => r.textContent.includes('Телефон на кухню'));
  assert.match(phone.textContent, /будильник заведён — и на кухню · до 00:30/);
  a.done();
});

test('чипы сна → свёрнутая строка, тап — снова правка; вечером — ссылка', async () => {
  const a = await start(WED);
  const row = label => a.all('.chips-row').find(r => r.querySelector('.chips-label').textContent === label);
  const chip = (label, v) => [...row(label).querySelectorAll('button')].find(b => b.textContent === v);
  assert.ok(chip('Лёг', '01:00').classList.contains('chip-mark'));
  assert.deepEqual([...row('Лёг').querySelectorAll('button')].map(b => b.textContent), ['00:00', '00:30', '01:00', '01:30', '02:00', '02:30', '03:00']);
  assert.deepEqual([...row('Встал').querySelectorAll('button')].map(b => b.textContent), ['06:30', '07:00', '07:30', '08:00', '08:30', '09:00']);
  chip('Лёг', '01:00').click();
  chip('Встал', '07:30').click();
  assert.match(a.text(), /Сон 6 ч 30 мин · лёг 01:00 ✓/);
  assert.doesNotMatch(a.text(), /Прошлая ночь/);
  a.click('Сон 6 ч 30 мин');
  chip('Лёг', '01:30').click();
  assert.match(a.text(), /Сон 6 ч · лёг 01:30 · на 30 мин позже цели/);
  // «Другое» — родной выбор времени
  a.click('Сон 6 ч');
  const other = row('Лёг').querySelector('input[type=time]');
  other.value = '01:10';
  other.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  assert.match(a.text(), /лёг 01:10 · на 10 мин позже цели/);
  a.t.now = new Date(2026, 9, 1, 19, 0);
  a.app.render();
  assert.match(a.text(), /Сон за прошлую ночь не отмечен/);
  a.done();
});

test('вчера можно доотметить, позавчера — нет', async () => {
  const a = await start(WED);
  a.t.now = new Date(2026, 9, 1, 9, 0);
  a.app.render();
  a.click('Вчера: 0 из 8 — отметить');
  const yRows = () => a.doc.querySelectorAll('.yesterday .row');
  assert.equal(yRows().length, 8);
  yRows()[0].click();
  assert.match(a.text(), /Вчера: 1 из 8/);
  assert.deepEqual(a.app.state.days['2026-09-30'].done.length, 1);
  a.t.now = new Date(2026, 9, 2, 9, 0);
  a.app.render();
  assert.match(a.text(), /Вчера: 0 из 8/); // 1 октября
  assert.doesNotMatch(a.text(), /1 из 8/);
  assert.match(a.text(), /Вчера пропуск — сегодня не пропускай дважды/);
  a.done();
});

test('воскресенье: баннер → итоги → выбор → новый шаг; с понедельника строка 1%', async () => {
  const a = await start(WED);
  const S = a.app.state;
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) S.sleep.nights[d] = { bed: '00:50', wake: '07:30' };
  a.t.now = new Date(2026, 9, 4, 20, 0); // вс 4 октября
  a.app.render();
  // Закрыть лист без кнопки — ничего не сохраняется
  a.click('Итоги недели · 10 минут');
  assert.ok(a.doc.querySelector('.sheet'));
  a.click('Раньше на 30 мин');
  a.doc.querySelector('.sheet [aria-label="Закрыть"]').click();
  assert.equal(a.doc.querySelector('.sheet'), null);
  assert.deepEqual(S.reviews, {});
  a.click('Итоги недели · 10 минут');
  const close = () => a.find('Закрыть неделю');
  assert.equal(close().disabled, true);
  assert.match(a.doc.querySelector('.sheet').textContent, /В цель 4 из 4/);
  const rec = a.doc.querySelector('.choice.rec');
  assert.match(rec.textContent, /Раньше на 30 мин → 00:30/);
  rec.click();
  assert.equal(close().disabled, false);
  assert.match(a.doc.querySelector('.sheet').textContent, /Со следующей ночи отбой 00:30\. Передвинь сигнал «Телефон на кухню» на 00:00/);
  a.type(a.doc.querySelector('.sheet textarea'), 'держал отбой');
  a.click('Книга в кровать вместо телефона');
  assert.equal(a.doc.querySelector('.sheet input[aria-label="1% на следующую неделю"]').value, 'Книга в кровать вместо телефона');
  assert.equal(a.doc.querySelector('.sheet textarea').value, 'держал отбой'); // черновик пережил перерисовку
  close().click();
  assert.equal(a.doc.querySelector('.sheet'), null);
  assert.match(a.doc.querySelector('.bars').textContent, /Неделя закрыта/);
  assert.equal(S.reviews['2026-09-28'].sleep.to, '00:30');
  assert.equal(S.reviews['2026-09-28'].good, 'держал отбой');
  assert.deepEqual(S.sleep.targets.at(-1), { from: '2026-10-05', bed: '00:30' });
  assert.doesNotMatch(a.text(), /Итоги недели · 10 минут/);
  assert.match(a.text(), /Отбой 00:30/);
  const b = await reboot(a, new Date(2026, 9, 5, 9, 0));
  assert.match(b.text(), /1% недели: Книга в кровать вместо телефона/);
  assert.match(b.text(), /до 00:00/);
  assert.doesNotMatch(b.text(), /Итоги прошлой недели не закрыты/);
  b.t.now = new Date(2026, 9, 12, 9, 0); // через неделю строка уходит, а незакрытая прошлая — баннер
  b.app.render();
  assert.doesNotMatch(b.text(), /1% недели/);
  assert.match(b.text(), /Итоги прошлой недели не закрыты/);
  b.done();
});

test('Настройки: добавить (11-й — переспрос), переименовать, ↑↓, убрать и вернуть', async () => {
  const a = await start(WED);
  a.click('Настройки');
  const names = () => [...a.all('.sec')[0].querySelectorAll('.set-row:not(.archived) .name')].map(n => n.textContent);
  const add = name => {
    a.type(a.doc.querySelector('.sheet input[name=name]'), name);
    a.click('Добавить', '.sheet button');
  };
  a.click('Добавить пункт');
  a.click('Добавить', '.sheet button'); // пустое название
  assert.match(a.doc.querySelector('.sheet').textContent, /Нужно название/);
  add('Вода');
  a.click('Добавить пункт');
  add('Ещё');
  assert.equal(names().length, 10);
  a.click('Добавить пункт');
  assert.equal(a.doc.querySelector('.sheet'), null);
  assert.match(a.text(), /В минимуме уже 10 пунктов\. Минимум должен выполняться в худший день\. Всё равно добавить\?/);
  a.click('Всё равно добавить');
  add('Одиннадцатый');
  assert.equal(names().length, 11);
  // переименовать
  a.find('Шторы + умыться', '.set-main').click();
  a.type(a.doc.querySelector('.sheet input[name=name]'), 'Шторы');
  a.click('Сохранить');
  assert.equal(names()[0], 'Шторы');
  // ↑↓
  a.doc.querySelector('[aria-label="Шторы: ниже"]').click();
  assert.equal(names()[1], 'Шторы');
  a.doc.querySelector('[aria-label="Шторы: выше"]').click();
  assert.equal(names()[0], 'Шторы');
  // убрать вторым тапом и вернуть
  a.find('Спорт', '.set-main').click();
  a.click('Убрать из минимума');
  assert.ok(a.doc.querySelector('.sheet'));
  a.click('Точно убрать? Нажми ещё раз');
  assert.ok(!names().includes('Спорт'));
  assert.match(a.all('.sec')[0].querySelector('.archived').textContent, /Спорт/);
  a.click('Вернуть');
  a.click('Всё равно вернуть'); // активных уже 10
  assert.ok(names().includes('Спорт'));
  a.click('Сегодня');
  assert.equal(a.rows().length, 11);
  assert.match(a.text(), /Шторы/);
  a.done();
});

test('Настройки: цели сна и ручной шаг — с завтрашней даты', async () => {
  const a = await start(WED);
  a.click('Настройки');
  const field = label => a.all('.field-row').find(f => f.textContent.includes(label)).querySelector('input');
  const set = (label, v) => { const i = field(label); i.value = v; i.dispatchEvent(new a.win.Event('change', { bubbles: true })); };
  set('Текущий шаг', '00:45');
  set('Цель подъёма', '07:00');
  const S = a.app.state;
  assert.deepEqual(S.sleep.targets.at(-1), { from: '2026-10-01', bed: '00:45' });
  assert.equal(S.sleep.goalWake, '07:00');
  a.click('Сегодня');
  assert.match(a.text(), /Отбой 00:45 · цель 23:30 · подъём 7:00/);
  a.done();
});

test('экспорт отдаёт валидный JSON, импорт старого файла отклоняется, сброс — вторым тапом', async () => {
  const a = await start(WED);
  a.rows()[0].click();
  let file, name;
  a.win.URL.createObjectURL = f => { file = f; return 'blob:x'; };
  a.win.URL.revokeObjectURL = () => {};
  a.win.HTMLAnchorElement.prototype.click = function () { name = this.download; };
  a.click('Настройки');
  a.click('Экспорт');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(name, 'minimum-2026-09-30.json');
  const text = await new Promise(ok => { const r = new a.win.FileReader(); r.onload = () => ok(r.result); r.readAsText(file); });
  const parsed = JSON.parse(text);
  assert.deepEqual(normalize(parsed, '2026-09-30'), a.app.state);
  assert.equal(parsed.days['2026-09-30'].done.length, 1);

  const input = a.doc.querySelector('input[type=file]');
  const pick = async content => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new a.win.File([content], 'x.json')] });
    input.dispatchEvent(new a.win.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
  };
  await pick(JSON.stringify({ version: 'minimum-v50', data: {} }));
  assert.match(a.text(), /Это файл старой версии — импорт не поддерживается/);
  const other = JSON.parse(text);
  other.items[0].name = 'Из файла';
  await pick(JSON.stringify(other));
  assert.match(a.text(), /Заменить все данные/);
  a.click('Заменить');
  assert.equal(a.app.state.items[0].name, 'Из файла');

  a.click('Сбросить к шаблону');
  assert.equal(a.app.state.items[0].name, 'Из файла');
  a.click('Точно стереть всё? Нажми ещё раз');
  assert.equal(a.app.state.items[0].name, 'Шторы + умыться');
  assert.deepEqual(a.app.state.days['2026-09-30'].done, []);
  a.done();
});

test('Прогресс рисуется: серия, цепь 12 недель, сон 28 ночей, пункты, недели', async () => {
  const a = await start(WED);
  a.click('Прогресс');
  assert.match(a.text(), /В системе с 20 июля · 73 дня/);
  assert.match(a.text(), /Один пропуск прощается, два подряд — серия с нуля/);
  assert.equal(a.doc.querySelectorAll('.chain .cell').length, 84);
  assert.equal(a.doc.querySelectorAll('.chain .cell-today').length, 1);
  assert.ok(a.doc.querySelector('svg.chart'));
  assert.match(a.text(), /Закрытых недель пока нет/);
  a.done();
});

test('пустой минимум', async () => {
  const a = await start(WED);
  for (const it of a.app.state.items) it.archivedAt = '2026-09-30';
  a.app.render();
  assert.match(a.text(), /Минимум пуст — добавь пункты в Настройках/);
  a.done();
});

test('отказ записи → постоянная полоса', async () => {
  const a = await start(WED);
  a.win.Storage.prototype.setItem = () => { throw new Error('quota'); };
  a.rows()[0].click();
  assert.match(a.doc.querySelector('.bars').textContent, /Не удалось сохранить — сделай экспорт в Настройках/);
  a.done();
});
