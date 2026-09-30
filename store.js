// Минимум v2 — хранилище: localStorage + зеркало в IndexedDB, стирание v1, экспорт/импорт.

import { seed, normalize, isV2 } from './domain.js';

export const KEY = 'minimum.v2';
export const LEGACY_PREFIX = 'minimum:';
export const LEGACY_DB = 'minimum';
const DB = 'minimum-v2', STORE = 'kv', DOC = 'state';
const MIRROR_DELAY = 300;

// Стирание данных v1 — при каждом старте: идемпотентно, чужие ключи и базы не трогаем.
export function purgeLegacy(ls, idb) {
  try {
    const old = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(LEGACY_PREFIX)) old.push(k);
    }
    old.forEach(k => ls.removeItem(k));
  } catch {}
  return new Promise(ok => {
    const t = setTimeout(done, 1500); // blocked может не закончиться — не держим старт
    function done() {
      clearTimeout(t);
      ok();
    }
    try {
      const r = idb.deleteDatabase(LEGACY_DB);
      r.onsuccess = r.onerror = r.onblocked = done;
    } catch {
      done();
    }
  });
}

function openDB(idb) {
  return new Promise((ok, fail) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
    r.onblocked = () => fail(new Error('blocked'));
  });
}

async function readMirror(idb) {
  const db = await openDB(idb);
  try {
    return await new Promise((ok, fail) => {
      const r = db.transaction(STORE).objectStore(STORE).get(DOC);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
  } finally {
    db.close();
  }
}

async function writeMirror(idb, text) {
  const db = await openDB(idb);
  try {
    await new Promise((ok, fail) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(text, DOC);
      tx.oncomplete = () => ok();
      tx.onerror = tx.onabort = () => fail(tx.error);
    });
  } finally {
    db.close();
  }
}

const parse = (text, today) => {
  try {
    return normalize(JSON.parse(text), today);
  } catch {
    return null;
  }
};

// ls, idb — localStorage и indexedDB (в тестах подменяются).
export function createStore({ ls, idb, today, onSaveError = () => {} }) {
  let timer = null, lastText = null;

  const flushMirror = async () => {
    timer = null;
    if (!idb || lastText == null) return;
    try {
      await writeMirror(idb, lastText);
    } catch {}
  };

  return {
    // → { state, restored, seeded }
    async load() {
      await purgeLegacy(ls, idb);
      let text = null;
      try {
        text = ls.getItem(KEY);
      } catch {}
      let state = text && parse(text, today());
      if (state) return { state, restored: false, seeded: false };
      if (idb) {
        try {
          const m = await readMirror(idb);
          state = typeof m === 'string' && parse(m, today());
        } catch {}
      }
      if (state) {
        try {
          ls.setItem(KEY, JSON.stringify(state)); // зеркало и так содержит это состояние
        } catch {
          onSaveError();
        }
        return { state, restored: true, seeded: false };
      }
      state = seed(today());
      this.save(state);
      return { state, restored: false, seeded: true };
    },

    save(state) {
      lastText = JSON.stringify(state);
      let ok = true;
      try {
        ls.setItem(KEY, lastText);
      } catch {
        ok = false;
        onSaveError();
      }
      clearTimeout(timer);
      timer = setTimeout(flushMirror, MIRROR_DELAY);
      return ok;
    },

    // Дописать зеркало немедленно (уход в фон, тесты).
    async flush() {
      clearTimeout(timer);
      await flushMirror();
    },
  };
}

export function requestPersist(nav) {
  try {
    nav?.storage?.persist?.().catch(() => {});
  } catch {}
}

// ---------- экспорт / импорт

export const exportName = today => `minimum-${today}.json`;
export const exportText = state => JSON.stringify(state, null, 2);

// → { state } или { error }
export function parseImport(text, today) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'Не удалось прочитать файл — это не JSON' };
  }
  if (!isV2(raw)) return { error: 'Это файл старой версии — импорт не поддерживается' };
  const state = normalize(raw, today);
  return state ? { state } : { error: 'Это файл старой версии — импорт не поддерживается' };
}

// Web Share с файлом, иначе скачивание.
export async function shareOrDownload(win, state, today) {
  const name = exportName(today), text = exportText(state);
  const file = new win.File([text], name, { type: 'application/json' });
  const nav = win.navigator;
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = win.URL.createObjectURL(file);
  const a = win.document.createElement('a');
  a.href = url;
  a.download = name;
  win.document.body.append(a);
  a.click();
  a.remove();
  win.setTimeout(() => win.URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
