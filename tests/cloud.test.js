process.env.TZ = 'America/Toronto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import * as D from '../domain.js';
import { baoSeed } from './fixtures.js';
import { createCloud, cleanCode, cleanName, hash, CLOUD_KEY, CACHE_KEY, CloudError } from '../cloud.js';
import { readShare, summaryOf, HIDDEN_NAME } from '../share.js';
import { fakeSupabase } from './fake-supabase.js';

class MemoryStorage {
  constructor(init = {}) { this.m = new Map(Object.entries(init)); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

// Окно с ручными таймерами: публикация «чуть позже» проверяется без ожидания.
function fakeWin() {
  const timers = new Map();
  let n = 0;
  return {
    localStorage: new MemoryStorage(),
    crypto: globalThis.crypto,
    TextEncoder,
    AbortController,
    setTimeout: (f, ms) => (timers.set(++n, { f, ms }), n),
    clearTimeout: id => timers.delete(id),
    timers,
    run(minMs = 0) { for (const [id, t] of [...timers]) if (t.ms >= minMs) { timers.delete(id); t.f(); } },
  };
}

const TODAY = '2026-10-21';
const NOW = new Date('2026-10-21T18:00:00-04:00');
const ids = () => { let n = 0; return () => 'id-' + ++n; };

function person(server, { win = fakeWin(), idb = new IDBFactory(), state, now = () => NOW } = {}) {
  const S = state || baoSeed('2026-10-01', ids());
  const box = { S, changes: 0 };
  box.win = win;
  box.idb = idb;
  box.cloud = createCloud({ win, idb, getState: () => box.S, now, onChange: () => box.changes++, url: server.url, key: server.key, fetch: server.fetch });
  return box;
}

test('без адреса и ключа друзей нет: ничего не грузится, «включить» — ошибка настройки', async () => {
  const c = createCloud({ win: fakeWin(), getState: () => D.seed(TODAY), url: '', key: '' });
  assert.equal(c.enabled, false);
  await c.load();
  assert.equal(c.joined, false);
  await assert.rejects(c.join('Бао'), e => e instanceof CloudError && e.kind === 'config');
  await c.sync(); // молча ничего
});

test('код и имя чистятся как на сервере; отпечаток снимка меняется вместе с ним', () => {
  assert.equal(cleanCode(' k7m-2p '), 'K7M2P');
  assert.equal(cleanName('  Бао\n\t Б '), 'Бао Б');
  assert.equal(cleanName('Я'.repeat(60)).length, 40);
  assert.notEqual(hash('{"a":1}'), hash('{"a":2}'));
  assert.equal(hash('абв'), hash('абв'));
});

test('включение: секрет на диске до запроса — потерянный ответ не создаёт второй профиль', async () => {
  const server = fakeSupabase();
  const a = person(server);
  server.mode = 'offline';
  await assert.rejects(a.cloud.join('  Бао '), e => e.kind === 'offline');
  assert.equal(a.cloud.joined, false);
  assert.equal(a.cloud.status, 'offline');
  const saved = JSON.parse(a.win.localStorage.getItem(CLOUD_KEY));
  assert.match(saved.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(saved.name, 'Бао');
  // сервер на самом деле успел создать профиль, но ответ потерялся
  server.mode = 'up';
  await server.fetch(`${server.url}/rest/v1/rpc/minimum_join`, { method: 'POST', headers: { apikey: server.key }, body: JSON.stringify({ p_secret: saved.secret, p_name: 'Бао' }) });
  await a.cloud.join('Бао');
  assert.equal(server.profiles.length, 1);
  assert.equal(a.cloud.joined, true);
  assert.match(a.cloud.me.code, /^[2-9A-HJ-NP-Z]{5}$/);
  assert.equal(a.cloud.me.code, server.profiles[0].code);
  assert.ok(server.profiles[0].snapshot, 'после включения снимок уже на сервере');
  assert.equal(a.cloud.status, 'ok');
});

test('запрос по коду → принять → друзья видят снимки друг друга, чужие — нет', async () => {
  const server = fakeSupabase();
  const a = person(server), b = person(server), e = person(server);
  await a.cloud.join('Бао');
  await b.cloud.join('Саша');
  await e.cloud.join('Чужой');
  assert.equal(await a.cloud.request(b.cloud.me.code.toLowerCase()), 'sent');
  assert.deepEqual(a.cloud.cache.outgoing.map(o => o.code), [b.cloud.me.code]);
  assert.equal(a.cloud.cache.outgoing[0].name, undefined);
  await b.cloud.sync({ force: true });
  assert.deepEqual(b.cloud.cache.incoming.map(i => i.name), ['Бао']);
  await b.cloud.accept(b.cloud.cache.incoming[0].id);
  assert.deepEqual(b.cloud.cache.friends.map(f => f.name), ['Бао']);
  await a.cloud.sync({ force: true });
  const friend = a.cloud.cache.friends[0];
  assert.equal(friend.name, 'Саша');
  const v = readShare(friend.snapshot, NOW);
  assert.equal(v.today, TODAY);
  assert.equal(summaryOf(v.F, v.today).n, 8);
  await e.cloud.sync({ force: true });
  assert.deepEqual([e.cloud.cache.friends, e.cloud.cache.incoming], [[], []]);
  assert.equal(await a.cloud.request(a.cloud.me.code), 'self');
  const free = ['22222', '33333', '44444'].find(c => !server.profiles.some(p => p.code === c));
  assert.equal(await a.cloud.request(free), 'not_found');
  assert.equal(await a.cloud.request('O0I1'), 'not_found');
});

test('снимок уходит только когда поменялся; отметки подряд — одним запросом', async () => {
  const server = fakeSupabase();
  const a = person(server);
  await a.cloud.join('Бао');
  const sent = () => server.calls.filter(c => c.fn === 'minimum_publish' || (c.fn === 'minimum_sync' && c.body.p_snapshot)).length;
  const base = sent();
  await a.cloud.sync({ force: true });
  assert.equal(sent(), base, 'без изменений снимок не отправляется');
  for (const id of D.activeIds(a.S).slice(0, 3)) {
    D.toggleDone(a.S, TODAY, id, TODAY);
    a.cloud.changed();
  }
  assert.equal(a.win.timers.size, 1, 'одна отложенная публикация');
  a.win.run(1000);
  await a.cloud.sync({ force: true });
  assert.equal(sent(), base + 1);
  const snap = server.profiles[0].snapshot;
  assert.deepEqual(snap.days[TODAY], [0, '11100000']);
  // ключ — в заголовке apikey, без Authorization (publishable-ключ — не JWT)
  const call = server.calls.at(-1);
  assert.equal(call.headers.apikey, server.key);
  assert.equal(call.headers.Authorization, undefined);
  assert.equal(call.headers['Content-Type'], 'application/json');
});

test('уход в фон: отложенный снимок уходит сразу и с keepalive', async () => {
  const server = fakeSupabase();
  const a = person(server);
  await a.cloud.join('Бао');
  D.toggleDone(a.S, TODAY, D.activeIds(a.S)[0], TODAY);
  a.cloud.changed();
  a.cloud.flush();
  await a.cloud.sync({ force: true });
  const pub = server.calls.find(c => c.fn === 'minimum_publish');
  assert.ok(pub && pub.keepalive);
  assert.equal(a.win.timers.size, 0);
});

test('нет связи и сервер спит: кэш друзей остаётся, состояние — offline / down', async () => {
  const server = fakeSupabase();
  const a = person(server), b = person(server);
  await a.cloud.join('A');
  await b.cloud.join('B');
  await a.cloud.request(b.cloud.me.code);
  await b.cloud.sync({ force: true });
  await b.cloud.accept(b.cloud.cache.incoming[0].id);
  await a.cloud.sync({ force: true });
  server.mode = 'offline';
  await a.cloud.sync({ force: true });
  assert.equal(a.cloud.status, 'offline');
  assert.equal(a.cloud.cache.friends.length, 1);
  server.mode = 'down';
  await a.cloud.sync({ force: true });
  assert.equal(a.cloud.status, 'down');
  server.mode = 'up';
  await a.cloud.sync({ force: true });
  assert.equal(a.cloud.status, 'ok');
  // кэш переживает перезапуск — он лежит только в IndexedDB (запись — через ~300 мс)
  await new Promise(r => setTimeout(r, 400));
  assert.equal(a.win.localStorage.getItem(CACHE_KEY), null, 'кэш друзей не теснит localStorage');
  const again = person(server, { win: a.win, idb: a.idb });
  await again.cloud.load();
  assert.equal(again.cloud.cache.friends[0].name, 'B');
});

test('сервер не узнал секрет — личность забыта, видимость пунктов осталась, «Друзья» предложат включить заново', async () => {
  const server = fakeSupabase();
  const a = person(server);
  await a.cloud.join('Бао');
  a.cloud.setHidden('id-7', true);
  server.profiles.length = 0; // профиль удалили в базе
  await a.cloud.sync({ force: true });
  assert.equal(a.cloud.joined, false);
  assert.equal(a.cloud.notice, 'lost');
  assert.deepEqual(a.cloud.prefs.hidden, ['id-7']);
  assert.equal(a.cloud.me.name, 'Бао');
  assert.equal(a.cloud.cache, null);
  await a.cloud.join('Бао');
  assert.equal(a.cloud.joined, true);
  assert.equal(a.cloud.notice, '');
});

test('видимость: скрытый пункт и выключенный сон у друга не видны, отметки считаются', async () => {
  const server = fakeSupabase();
  const a = person(server), b = person(server);
  await a.cloud.join('A');
  await b.cloud.join('B');
  const lak = a.S.items.find(i => i.name === 'Лак на ногти');
  a.S.sleep.nights[TODAY] = { bed: '00:40', wake: '07:20' };
  for (const id of D.activeIds(a.S)) D.toggleDone(a.S, TODAY, id, TODAY);
  a.cloud.setHidden(lak.id, true);
  a.cloud.setShare('sleep', false);
  await a.cloud.request(b.cloud.me.code);
  await b.cloud.sync({ force: true });
  await b.cloud.accept(b.cloud.cache.incoming[0].id);
  const text = JSON.stringify(b.cloud.cache.friends[0].snapshot);
  assert.ok(!text.includes('Лак на ногти') && !text.includes('00:40'));
  const v = readShare(b.cloud.cache.friends[0].snapshot, NOW);
  assert.equal(v.sleep, false);
  assert.ok(v.F.items.some(i => i.name === HIDDEN_NAME));
  assert.equal(summaryOf(v.F, v.today).closed, true);
  a.cloud.setHidden(lak.id, false);
  assert.deepEqual(a.cloud.prefs.hidden, []);
});

test('отклонить, отменить, удалить из друзей; имя меняется; выключение стирает профиль с сервера', async () => {
  const server = fakeSupabase();
  const a = person(server), b = person(server);
  await a.cloud.join('A');
  await b.cloud.join('B');
  await a.cloud.request(b.cloud.me.code);
  await b.cloud.sync({ force: true });
  await b.cloud.remove(b.cloud.cache.incoming[0].id); // отклонил
  await a.cloud.sync({ force: true });
  assert.deepEqual(a.cloud.cache.outgoing, []);
  await a.cloud.request(b.cloud.me.code);
  await a.cloud.remove(a.cloud.cache.outgoing[0].id); // отменил
  await b.cloud.sync({ force: true });
  assert.deepEqual(b.cloud.cache.incoming, []);
  await a.cloud.rename('  Новое  имя ');
  assert.equal(a.cloud.me.name, 'Новое имя');
  await assert.rejects(a.cloud.rename('   '), e => e.kind === 'bad_name');
  await a.cloud.leave();
  assert.equal(a.cloud.joined, false);
  assert.equal(server.profiles.some(p => p.name === 'Новое имя'), false);
  assert.equal(JSON.parse(a.win.localStorage.getItem(CLOUD_KEY)).secret, '');
  assert.equal(a.win.localStorage.getItem(CACHE_KEY), null);
});

test('без связи выключить нельзя — профиль остаётся на сервере и на телефоне', async () => {
  const server = fakeSupabase();
  const a = person(server);
  await a.cloud.join('A');
  server.mode = 'offline';
  await assert.rejects(a.cloud.leave(), e => e.kind === 'offline');
  assert.equal(a.cloud.joined, true);
  assert.equal(server.profiles.length, 1);
});

test('localStorage стёрт — личность возвращается из зеркала IndexedDB', async () => {
  const server = fakeSupabase();
  const a = person(server);
  await a.cloud.join('Бао');
  await new Promise(r => setTimeout(r, 400)); // зеркало пишется через ~300 мс — таймер настоящий
  a.win.run();
  await new Promise(r => setTimeout(r, 50));
  const code = a.cloud.me.code;
  const win2 = fakeWin();
  const b = person(server, { win: win2, idb: a.idb });
  await b.cloud.load();
  assert.equal(b.cloud.joined, true);
  assert.equal(b.cloud.me.code, code);
});

test('битый документ на диске не ломает запуск', async () => {
  const server = fakeSupabase();
  const win = fakeWin();
  win.localStorage.setItem(CLOUD_KEY, '{"secret":"коротко","id":"x","code":"!!","hidden":[1,"a","a"]}');
  win.localStorage.setItem(CACHE_KEY, 'не json');
  const a = person(server, { win });
  await a.cloud.load();
  assert.equal(a.cloud.joined, false);
  assert.deepEqual(a.cloud.prefs.hidden, ['a']);
  assert.equal(a.cloud.cache, null);
});

test('ответ сервера — недоверенные данные: чужие поля отброшены, имена почищены', async () => {
  const server = fakeSupabase();
  const a = person(server), b = person(server);
  await a.cloud.join('A');
  await b.cloud.join('B');
  server.profiles[1].name = 'Злой\u0000<b>';
  server.befriend(server.profiles[0], server.profiles[1]);
  server.profiles[1].snapshot = [1, 2, 3];
  await a.cloud.sync({ force: true });
  const f = a.cloud.cache.friends[0];
  assert.equal(f.name, 'Злой<b>');
  assert.equal(f.snapshot, null);
  assert.deepEqual(Object.keys(f).sort(), ['code', 'id', 'name', 'seenAt', 'since', 'snapshot']);
});

test('профиль «потерялся» из-за чужого адреса — секрет цел: «Включить» вернёт тот же профиль и код', async () => {
  const server = fakeSupabase();
  const a = person(server);
  await a.cloud.join('Бао');
  const code = a.cloud.me.code;
  const other = fakeSupabase(); // приложение по ошибке смотрит в пустой проект
  const lostOne = person(other, { win: a.win, idb: a.idb });
  await lostOne.cloud.load();
  await lostOne.cloud.sync({ force: true });
  assert.equal(lostOne.cloud.joined, false);
  assert.equal(lostOne.cloud.notice, 'lost');
  // адрес вернули — секрет тот же, сервер узнаёт профиль
  const back = person(server, { win: a.win, idb: a.idb });
  await back.cloud.load();
  await back.cloud.join('Бао');
  assert.equal(back.cloud.me.code, code);
  assert.equal(server.profiles.length, 1);
});

test('код на русской раскладке: «к7м-2р» → K7M2P', async () => {
  assert.equal(cleanCode('к7м-2р'), 'K7M2P');
  assert.equal(cleanCode('Х3ВТ9'), 'X3BT9');
  const server = fakeSupabase();
  const a = person(server), b = person(server);
  await a.cloud.join('A');
  await b.cloud.join('B');
  server.profiles[1].code = 'K7M2P';
  assert.equal(await a.cloud.request('к7м2р'), 'sent');
});

test('половинка эмодзи и управляющие символы в названии — снимок всё равно уходит', async () => {
  const server = fakeSupabase();
  const a = person(server);
  a.S.items[0].name = 'Зарядка \uD83D'; // обрезанный эмодзи
  a.S.items[1].note = 'с\u0000нулём';
  await a.cloud.join('A');
  const snap = server.profiles[0].snapshot;
  assert.ok(snap, 'снимок принят');
  assert.equal(snap.items[0].name, 'Зарядка �');
  assert.equal(snap.items[1].note, 'снулём');
  assert.equal(a.cloud.stuck, false);
});

test('сервер отверг снимок — друзья всё равно обновляются, тот же снимок больше не шлётся, вкладка предупреждает', async () => {
  const server = fakeSupabase();
  const a = person(server), b = person(server);
  await a.cloud.join('A');
  await b.cloud.join('B');
  server.befriend(server.profiles[0], server.profiles[1]);
  server.rejectSnapshots = true;
  D.toggleDone(a.S, TODAY, D.activeIds(a.S)[0], TODAY);
  await a.cloud.sync({ force: true });
  assert.equal(a.cloud.stuck, true);
  assert.equal(a.cloud.status, 'ok');
  assert.deepEqual(a.cloud.cache.friends.map(f => f.name), ['B']);
  const before = server.calls.length;
  await a.cloud.sync({ force: true });
  assert.equal(server.calls.length - before, 1, 'один запрос без снимка');
  assert.equal(server.calls.at(-1).body.p_snapshot, undefined);
  // снимок изменился и сервер снова принимает — уходит, предупреждение снято
  server.rejectSnapshots = false;
  D.toggleDone(a.S, TODAY, D.activeIds(a.S)[1], TODAY);
  await a.cloud.sync({ force: true });
  assert.equal(a.cloud.stuck, false);
  assert.deepEqual(server.profiles[0].snapshot.days[TODAY], [0, '11000000']);
});

test('ответ на «принять» false — запрос уже отменили; при ошибке список запросов возвращается', async () => {
  const server = fakeSupabase();
  const a = person(server), b = person(server);
  await a.cloud.join('A');
  await b.cloud.join('B');
  await a.cloud.request(b.cloud.me.code);
  await b.cloud.sync({ force: true });
  const id = b.cloud.cache.incoming[0].id;
  await a.cloud.remove(b.cloud.me.id); // отменил, пока B думал
  assert.equal(await b.cloud.accept(id), false);
  await a.cloud.request(b.cloud.me.code);
  await b.cloud.sync({ force: true });
  server.mode = 'offline';
  await assert.rejects(b.cloud.accept(b.cloud.cache.incoming[0].id), e => e.kind === 'offline');
  server.mode = 'up';
  await b.cloud.sync({ force: true });
  assert.equal(b.cloud.cache.incoming.length, 1, 'запрос снова виден');
});
