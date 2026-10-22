process.env.TZ = 'America/Toronto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { boot } from '../app.js';
import { seed, addDays, range, activeIds } from '../domain.js';
import { fakeSupabase } from './fake-supabase.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WED = new Date(2026, 9, 21, 18, 0); // среда 21 октября, вечер
const sp = s => s.replace(/ /g, ' ');
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));

const open = new Set();
afterEach(() => {
  for (const w of open) w.close();
  open.clear();
});

// Своё состояние: посев за back дней, closed — закрытые дни.
function stateWith(today, back, { closed = [] } = {}) {
  let n = 0;
  const S = seed(addDays(today, -back), () => 'i' + ++n);
  S.ui = { welcomeSeen: true, news: 'v55', lastExport: today };
  const ids = activeIds(S);
  for (const d of range(S.createdAt, addDays(today, -1))) S.days[d] = { plan: ids.slice(), done: closed.includes(d) ? ids.slice() : [] };
  return { 'minimum.v2': JSON.stringify(S) };
}

async function start(server, { when = WED, storage = stateWith('2026-10-21', 10, { closed: range('2026-10-12', '2026-10-20') }), idb = new IDBFactory() } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e); });
  vc.on('error', e => errors.push(e));
  const dom = new JSDOM(HTML, { url: 'https://xbaox.github.io/minimum/', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  open.add(win);
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
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
  const sheetText = () => sp(doc.querySelector('.sheet')?.textContent || '');
  const bars = () => sp(doc.querySelector('.bars').textContent);
  const visibility = async state => {
    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => state });
    doc.dispatchEvent(new win.Event('visibilitychange'));
    await wait();
  };
  const tab = async name => { click(name, '.tab'); await wait(); };
  const alertBtn = label => [...doc.querySelectorAll('.alert button')].find(b => b.textContent === label).click();
  const done = () => { assert.deepEqual(errors.map(String), []); win.close(); open.delete(win); };
  // Включить друзей с именем; → код.
  const join = async name => {
    await tab('Друзья');
    type(doc.querySelector('input[name="friend-name"]'), name);
    click('Включить друзей');
    await wait(60);
    return app.cloud.me.code;
  };
  return { win, doc, app, t, all, find, click, type, text, sheetText, bars, visibility, tab, alertBtn, done, join, errors };
}

const addFriend = async (a, code) => {
  a.click('Добавить друга', '.plus-row');
  a.type(a.doc.querySelector('#add-code'), code);
  assert.equal(a.doc.querySelector('#sheet-done').disabled, false);
  a.doc.querySelector('#sheet-done').click();
  await wait(60);
};

test('без сервера друзей вкладки и раздела нет', async () => {
  const a = await start(null);
  assert.deepEqual(a.all('.tab').map(t => sp(t.textContent)), ['Сегодня', 'Прогресс', 'Настройки']);
  await a.tab('Настройки');
  assert.doesNotMatch(a.text(), /Друзья/);
  a.done();
});

test('включение: имя → код; вкладка, раздел в Настройках, снимок уже на сервере', async () => {
  const server = fakeSupabase();
  const a = await start(server);
  assert.deepEqual(a.all('.tab').map(t => sp(t.textContent)), ['Сегодня', 'Прогресс', 'Друзья', 'Настройки']);
  await a.tab('Друзья');
  assert.match(a.text(), /Прогресс вместе/);
  assert.equal(a.doc.querySelector('#join-btn').disabled, true, 'без имени — нельзя');
  const code = await a.join('  Бао ');
  assert.match(code, /^[2-9A-HJ-NP-Z]{5}$/);
  assert.match(a.text(), new RegExp(`Твой код${code}`));
  assert.match(a.text(), /Бао0 из 8 · это ты/);
  assert.match(a.bars(), /Друзья включены/);
  assert.equal(server.profiles[0].name, 'Бао');
  assert.ok(server.profiles[0].snapshot?.days, 'снимок на сервере');
  await a.tab('Настройки');
  assert.match(a.text(), /ДрузьяИмя для друзейБао/);
  a.done();
});

test('код друга → запрос → у друга точка на вкладке и «Принять» → оба видят друг друга', async () => {
  const server = fakeSupabase();
  const a = await start(server), b = await start(server);
  await a.join('Бао');
  const codeB = await b.join('Саша');
  await addFriend(a, codeB.toLowerCase().replace(/^(..)/, '$1-'));
  assert.match(a.bars(), /Запрос отправлен/);
  assert.equal(a.doc.querySelector('.sheet'), null);
  assert.match(a.text(), new RegExp(`Ждут ответа.*Код ${codeB}`));
  assert.doesNotMatch(a.text(), /Саша/, 'имя адресата до согласия не видно');

  b.app.cloud.sync({ force: true }); // на телефоне — при возвращении в приложение
  await wait(60);
  assert.ok(b.doc.querySelector('.tab .tab-dot'), 'точка на вкладке «Друзья»');
  assert.match(b.find('Друзья', '.tab').getAttribute('aria-label'), /есть запросы/);
  assert.match(b.text(), /Запросы.Баохочет дружить/); // перед именем — буква на аватаре
  b.click('Принять', '.pill-btn');
  // имя в запросе — какое угодно, поэтому подтверждение показывает настоящий код
  assert.match(sp(b.doc.querySelector('.alert').textContent), new RegExp(`Принять запрос от «Бао»\\?Его код — ${a.app.cloud.me.code}`));
  b.alertBtn('Принять');
  await wait(80);
  assert.equal(b.doc.querySelector('.tab .tab-dot'), null);
  assert.match(b.text(), /Бао0 из 8/);

  await a.visibility('visible');
  a.app.cloud.sync({ force: true });
  await wait(60);
  assert.match(a.text(), /Саша0 из 8/);
  assert.doesNotMatch(a.text(), /Ждут ответа/);
  // лист друга: герой, его пункты, неделя, цепь, сон
  a.find('Саша', '.friend').click();
  await wait();
  const s = a.sheetText();
  assert.match(s, /обновлено/);
  assert.match(s, /0 из 8/);
  assert.match(s, /Минимум сегодня/);
  assert.match(s, /Шторы \+ умыться/);
  assert.match(s, /Эта неделя/);
  assert.equal(a.doc.querySelectorAll('.sheet .chain .cell').length, 42);
  assert.equal(a.doc.querySelectorAll('.sheet button.cell').length, 0, 'дни друга не нажимаются');
  assert.equal(a.doc.querySelectorAll('.sheet .week-rings .mini').length, 7);
  assert.match(s, /Удалить из друзей/);
  a.done();
  b.done();
});

test('встречные коды — сразу друзья; свой код, чужой и повтор — понятные ответы', async () => {
  const server = fakeSupabase();
  const a = await start(server), b = await start(server);
  const codeA = await a.join('A');
  const codeB = await b.join('B');
  await addFriend(a, codeB);
  await addFriend(b, codeA);
  assert.match(b.bars(), /Теперь вы друзья/);
  await addFriend(a, codeB);
  assert.match(a.sheetText(), /Вы уже друзья/);
  a.type(a.doc.querySelector('#add-code'), codeA);
  a.doc.querySelector('#sheet-done').click();
  await wait(60);
  assert.match(a.sheetText(), /Это твой код/);
  const free = ['22222', '33333', '44444'].find(c => c !== codeA && c !== codeB);
  a.type(a.doc.querySelector('#add-code'), free);
  a.doc.querySelector('#sheet-done').click();
  await wait(60);
  assert.match(a.sheetText(), /Такого кода нет/);
  a.type(a.doc.querySelector('#add-code'), 'K7M');
  assert.equal(a.doc.querySelector('#sheet-done').disabled, true, 'неполный код не отправить');
  a.done();
  b.done();
});

test('отметка у меня — друг видит её: снимок уходит при уходе в фон', async () => {
  const server = fakeSupabase();
  const a = await start(server), b = await start(server);
  await a.join('A');
  const codeB = await b.join('B');
  server.befriend(server.profiles[0], server.profiles[1]);
  await a.tab('Сегодня');
  a.doc.querySelectorAll('.list-min > .row')[3].click();
  await a.visibility('hidden');
  await wait(60);
  const pub = server.calls.filter(c => c.fn === 'minimum_publish');
  assert.ok(pub.length >= 1 && pub.at(-1).keepalive, 'снимок ушёл с keepalive');
  await b.tab('Друзья');
  b.app.cloud.sync({ force: true });
  await wait(60);
  assert.match(b.text(), /A1 из 8/);
  assert.equal(codeB.length, 5);
  a.done();
  b.done();
});

test('что видят друзья: скрытый пункт — «Личный пункт» с замком, без сна — ни кольца, ни графика', async () => {
  const server = fakeSupabase();
  const a = await start(server), b = await start(server);
  await a.join('A');
  await b.join('B');
  server.befriend(server.profiles[0], server.profiles[1]);
  a.click('Что видят друзья', '.link');
  await wait();
  const lak = a.all('.sheet .item-switch').find(r => sp(r.textContent).includes('Лак на ногти'));
  assert.equal(lak.getAttribute('aria-checked'), 'true');
  lak.click();
  assert.equal(a.all('.sheet .item-switch').find(r => sp(r.textContent).includes('Лак на ногти')).getAttribute('aria-checked'), 'false');
  assert.match(a.sheetText(), /друзья видят «Личный пункт»/);
  a.find('Сон', '.sheet .switch-row').click();
  // как меня видят друзья — тот же снимок
  a.click('Как меня видят друзья', '.sheet button');
  await wait();
  assert.match(a.sheetText(), /так тебя видят друзья/);
  assert.match(a.sheetText(), /Личный пункт/);
  assert.doesNotMatch(a.sheetText(), /Лак на ногти/);
  await a.visibility('hidden');
  await wait(60);
  await b.tab('Друзья');
  b.app.cloud.sync({ force: true });
  await wait(60);
  b.find('A', '.friend').click();
  await wait();
  const s = b.sheetText();
  assert.match(s, /Личный пункт/);
  assert.doesNotMatch(s, /Лак на ногти|после душа/);
  assert.ok(b.doc.querySelector('.sheet .row.static .tile path[d^="M6.5 11h11"]'), 'замок вместо значка');
  assert.doesNotMatch(s, /Сон · 14 ночей|Отбой/);
  assert.equal(b.doc.querySelector('.sheet .rings .arc-sleep'), null, 'кольца сна нет');
  a.done();
  b.done();
});

test('удалить из друзей — через подтверждение, пропадает у обоих', async () => {
  const server = fakeSupabase();
  const a = await start(server), b = await start(server);
  await a.join('A');
  await b.join('B');
  server.befriend(server.profiles[0], server.profiles[1]);
  a.app.cloud.sync({ force: true });
  await wait(60);
  a.find('B', '.friend').click();
  await wait();
  a.click('Удалить из друзей', '.sheet button');
  assert.match(sp(a.doc.querySelector('.alert').textContent), /B и ты перестанете видеть прогресс друг друга/);
  a.alertBtn('Удалить');
  await wait(80);
  assert.equal(a.doc.querySelector('.sheet'), null);
  assert.equal(a.doc.querySelector('.alert'), null);
  assert.doesNotMatch(a.text(), /B\d+ из/);
  assert.equal(server.links.length, 0);
  b.app.cloud.sync({ force: true });
  await wait(60);
  assert.doesNotMatch(b.text(), /A\d+ из/);
  a.done();
  b.done();
});

test('выключить друзей: подтверждение, профиль стёрт с сервера, вкладка снова предлагает включить', async () => {
  const server = fakeSupabase();
  const a = await start(server);
  await a.join('Бао');
  await a.tab('Настройки');
  a.click('Выключить друзей');
  assert.match(sp(a.doc.querySelector('.alert').textContent), /сотрутся с сервера/);
  a.alertBtn('Выключить');
  await wait(80);
  assert.equal(server.profiles.length, 0);
  assert.match(a.bars(), /Друзья выключены/);
  assert.match(a.text(), /Друзьявыключены/);
  await a.tab('Друзья');
  assert.match(a.text(), /Прогресс вместе/);
  a.done();
});

test('нет связи: «Нет связи» сверху, друзья из кэша на месте; связь вернулась — «Обновлено»', async () => {
  const server = fakeSupabase();
  const a = await start(server), b = await start(server);
  await a.join('A');
  await b.join('B');
  server.befriend(server.profiles[0], server.profiles[1]);
  a.app.cloud.sync({ force: true });
  await wait(60);
  server.mode = 'offline';
  a.app.cloud.sync({ force: true });
  await wait(60);
  assert.match(a.text(), /Нет связи/);
  assert.match(a.text(), /B\d из 8/);
  server.mode = 'up';
  a.app.cloud.sync({ force: true });
  await wait(60);
  assert.match(a.text(), /Обновлено только что/);
  a.done();
  b.done();
});

test('профиль пропал с сервера — сообщение и форма с прежним именем', async () => {
  const server = fakeSupabase();
  const a = await start(server);
  await a.join('Бао');
  server.profiles.length = 0;
  a.app.cloud.sync({ force: true });
  await wait(60);
  assert.match(a.text(), /Профиль на сервере не найден — включи друзей заново/);
  assert.equal(a.doc.querySelector('input[name="friend-name"]').value, 'Бао');
  a.click('Включить друзей');
  await wait(60);
  assert.match(a.text(), /Твой код/);
  a.done();
});

test('имя для друзей: лист с превью, несохранённое переспрашивает, у друга — новое имя', async () => {
  const server = fakeSupabase();
  const a = await start(server), b = await start(server);
  await a.join('Бао');
  await b.join('B');
  server.befriend(server.profiles[0], server.profiles[1]);
  await a.tab('Настройки');
  a.click('Имя для друзей');
  await wait();
  const input = a.doc.querySelector('.sheet input[name="friend-name"]');
  a.type(input, 'Бао Б');
  assert.equal(a.doc.querySelector('.sheet .pv-name').textContent, 'Бао Б');
  a.doc.querySelector('.sheet-back').click();
  assert.match(sp(a.doc.querySelector('.alert').textContent), /Закрыть без сохранения/);
  a.alertBtn('Отмена');
  await wait();
  a.doc.querySelector('#sheet-done').click();
  await wait(80);
  assert.match(a.bars(), /Имя для друзей сохранено/);
  b.app.cloud.sync({ force: true });
  await wait(60);
  assert.match(b.text(), /Бао Б/);
  a.done();
  b.done();
});

test('имя и пункты друга — только текстом: разметка из чужого снимка не исполняется', async () => {
  const server = fakeSupabase();
  const a = await start(server);
  await a.join('A');
  const evil = '<img src=x onerror="window.__x=1">';
  const S = seed('2026-10-15', () => 'e' + Math.random());
  S.items[0].name = evil;
  const p = server.addProfile({ name: evil, snapshot: { ...S, meta: { v: 1, tz: 'America/Toronto', day: '2026-10-21' } } });
  server.befriend(server.profiles[0], p);
  a.app.cloud.sync({ force: true });
  await wait(60);
  a.find('<img', '.friend').click();
  await wait();
  assert.equal(a.doc.querySelector('.screen img, .sheet img'), null);
  assert.match(a.sheetText(), /<img src=x/);
  assert.equal(a.win.__x, undefined);
  a.done();
});

test('новый пункт с выключенным «Видно друзьям» уходит другу сразу «Личным пунктом»', async () => {
  const server = fakeSupabase();
  const a = await start(server);
  await a.join('A');
  await a.tab('Настройки');
  a.click('Добавить пункт');
  await wait();
  a.type(a.doc.querySelector('.sheet input[name="name"]'), 'Тайная привычка');
  const sw = a.find('Видно друзьям', '.sheet .switch-row');
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  sw.click();
  assert.equal(a.find('Видно друзьям', '.sheet .switch-row').getAttribute('aria-checked'), 'false');
  a.doc.querySelector('#sheet-done').click();
  await a.visibility('hidden');
  await wait(80);
  const text = JSON.stringify(server.profiles[0].snapshot);
  assert.ok(!text.includes('Тайная привычка'));
  assert.ok(text.includes('Личный пункт'));
  // открыли этот пункт снова — переключатель помнит
  await a.visibility('visible');
  a.app.state.items.at(-1);
  await a.tab('Настройки');
  a.click('Тайная привычка');
  await wait();
  assert.equal(a.find('Видно друзьям', '.sheet .switch-row').getAttribute('aria-checked'), 'false');
  a.done();
});

test('«Что видят друзья» показывает и убранные пункты — они видны другу в прошлых днях', async () => {
  const server = fakeSupabase();
  const a = await start(server);
  await a.join('A');
  a.app.state.items[6].archivedAt = '2026-10-20';
  a.click('Что видят друзья', '.link');
  await wait();
  assert.match(a.sheetText(), /Убранные.*Лак на ногти/);
  assert.match(a.sheetText(), /часовой пояс/);
  a.done();
});

test('ответ на «Добавить» пришёл, когда открыт уже другой лист, — тот лист и введённое целы', async () => {
  const server = fakeSupabase();
  const slow = { url: server.url, key: server.key, fetch: async (u, init) => { await wait(150); return server.fetch(u, init); } };
  const b = await start(server);
  const codeB = await b.join('B');
  const a = await start(slow);
  await a.join('A');
  await wait(400);
  a.click('Добавить друга', '.plus-row');
  a.type(a.doc.querySelector('#add-code'), codeB);
  a.doc.querySelector('#sheet-done').click();
  a.click('Отмена', '.sheet-act');
  await wait(20);
  await a.tab('Настройки');
  a.click('Добавить пункт');
  await wait(10);
  a.type(a.doc.querySelector('.sheet input[name="name"]'), 'Черновик');
  await wait(500);
  assert.ok(a.doc.querySelector('.sheet'), 'лист пункта не закрыт чужим ответом');
  assert.equal(a.doc.querySelector('.sheet input[name="name"]').value, 'Черновик');
  assert.match(a.bars(), /Запрос отправлен/);
  a.done();
  b.done();
});
