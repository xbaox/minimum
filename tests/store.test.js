process.env.TZ = 'America/Toronto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, purgeLegacy, parseImport, exportText, exportName, KEY } from '../store.js';
import { seed, toggleDone } from '../domain.js';

class MemoryStorage {
  constructor(init = {}) { this.m = new Map(Object.entries(init)); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

const TODAY = '2026-09-30';
const today = () => TODAY;
const names = async idb => (await idb.databases()).map(d => d.name).sort();
const makeDB = (idb, name) => new Promise(ok => {
  const r = idb.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('x');
  r.onsuccess = () => { r.result.close(); ok(); };
});
const legacyKeys = () => ({
  'minimum:data': '{"old":1}',
  'minimum:data:corrupt': 'x',
  'minimum:data:mirror-corrupt': 'x',
  'minimum:data:wiped': '1',
  'minimum.v2': '{"keep":1}',
  'englishSummer.v2': '{"neighbour":1}',
});

test('стирание: все minimum:* и база minimum, чужое цело, идемпотентно', async () => {
  const ls = new MemoryStorage(legacyKeys());
  const idb = new IDBFactory();
  await makeDB(idb, 'minimum');
  await makeDB(idb, 'minimum-v2');
  await makeDB(idb, 'english-summer');
  await purgeLegacy(ls, idb);
  assert.deepEqual([...ls.m.keys()].sort(), ['englishSummer.v2', 'minimum.v2']);
  assert.equal(ls.getItem('englishSummer.v2'), '{"neighbour":1}');
  assert.deepEqual(await names(idb), ['english-summer', 'minimum-v2']);
  await purgeLegacy(ls, idb);
  assert.deepEqual([...ls.m.keys()].sort(), ['englishSummer.v2', 'minimum.v2']);
  assert.deepEqual(await names(idb), ['english-summer', 'minimum-v2']);
  await purgeLegacy(undefined, undefined); // нет хранилищ — не падает
});

test('посев на пустом, затем чтение того же', async () => {
  const ls = new MemoryStorage(), idb = new IDBFactory();
  const st = createStore({ ls, idb, today });
  const r = await st.load();
  assert.equal(r.seeded, true);
  assert.equal(r.state.items.length, 8);
  assert.equal(r.state.createdAt, TODAY);
  assert.ok(ls.getItem(KEY));
  const r2 = await createStore({ ls, idb, today }).load();
  assert.equal(r2.seeded, false);
  assert.deepEqual(r2.state, r.state);
  await st.flush();
});

test('первый старт со старыми ключами: стёрто и посеяно', async () => {
  const ls = new MemoryStorage({ 'minimum:data': '{"old":1}', 'englishSummer.v2': 'n' });
  const r = await createStore({ ls, idb: new IDBFactory(), today }).load();
  assert.equal(r.seeded, true);
  assert.deepEqual([...ls.m.keys()].sort(), ['englishSummer.v2', KEY]);
});

test('восстановление из зеркала при битом localStorage', async () => {
  const ls = new MemoryStorage(), idb = new IDBFactory();
  const st = createStore({ ls, idb, today });
  const { state } = await st.load();
  toggleDone(state, TODAY, state.items[0].id, TODAY);
  st.save(state);
  await st.flush();
  ls.setItem(KEY, '{битое');
  const r = await createStore({ ls, idb, today }).load();
  assert.equal(r.restored, true);
  assert.deepEqual(r.state, state);
  assert.deepEqual(JSON.parse(ls.getItem(KEY)), state); // локальная копия вернулась
  ls.removeItem(KEY);
  const r2 = await createStore({ ls, idb, today }).load();
  assert.equal(r2.restored, true);
});

test('зеркало пишется с задержкой, а не на каждое изменение', async () => {
  const ls = new MemoryStorage(), idb = new IDBFactory();
  const st = createStore({ ls, idb, today });
  const { state } = await st.load();
  await st.flush();
  state.ui.welcomeSeen = true;
  st.save(state);
  ls.removeItem(KEY);
  const early = await createStore({ ls: new MemoryStorage(), idb, today }).load();
  assert.equal(early.state.ui.welcomeSeen, false);
  await new Promise(r => setTimeout(r, 400));
  const late = await createStore({ ls: new MemoryStorage(), idb, today }).load();
  assert.equal(late.state.ui.welcomeSeen, true);
});

test('отказ записи сообщается', async () => {
  const ls = new MemoryStorage();
  ls.setItem = () => { throw new Error('QuotaExceededError'); };
  let failed = 0;
  const st = createStore({ ls, idb: null, today, onSaveError: () => failed++ });
  const r = await st.load();
  assert.equal(r.seeded, true);
  assert.equal(failed, 1);
  assert.equal(st.save(r.state), false);
});

test('экспорт → импорт = то же состояние', () => {
  const s = seed(TODAY);
  toggleDone(s, TODAY, s.items[2].id, TODAY);
  s.sleep.nights[TODAY] = { bed: '01:10', wake: '07:30' };
  s.reviews['2026-09-28'] = {
    closedAt: '2026-10-04T20:00:00.000Z', good: 'a', bad: 'b', learned: 'c', notesDone: true,
    improvement: 'd', sleep: { from: '01:00', to: '00:30', choice: 'earlier30' },
  };
  const r = parseImport(exportText(s), TODAY);
  assert.deepEqual(r.state, s);
  assert.equal(exportName(TODAY), 'minimum-2026-09-30.json');
});

test('старый файл и мусор отклоняются', () => {
  const old = { version: 'minimum-v50', data: { days: {}, items: [] } };
  assert.equal(parseImport(JSON.stringify(old), TODAY).error, 'Это файл старой версии — импорт не поддерживается');
  assert.equal(parseImport('{"schema":1,"items":[]}', TODAY).error, 'Это файл старой версии — импорт не поддерживается');
  assert.match(parseImport('не json', TODAY).error, /не JSON/);
});
