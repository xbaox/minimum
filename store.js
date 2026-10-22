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

async function readMirror(idb, doc = DOC) {
  const db = await openDB(idb);
  try {
    return await new Promise((ok, fail) => {
      const r = db.transaction(STORE).objectStore(STORE).get(doc);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
  } finally {
    db.close();
  }
}

async function writeMirror(idb, text, doc = DOC) {
  const db = await openDB(idb);
  try {
    await new Promise((ok, fail) => {
      const tx = db.transaction(STORE, 'readwrite');
      if (text == null) tx.objectStore(STORE).delete(doc);
      else tx.objectStore(STORE).put(text, doc);
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
        // Старую копию убираем: иначе при следующем старте она победит более свежее зеркало.
        try {
          ls.removeItem(KEY);
        } catch {}
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

// Отдельный документ рядом с состоянием (друзья): свой ключ localStorage и своя запись в том же зеркале
// IndexedDB. Пишется целиком; null — стереть. local: false — только IndexedDB (большой кэш не теснит отметки
// в localStorage, общем для всех PWA домена). IndexedDB может зависнуть — чтение и сброс ждут не дольше wait мс.
export function createDoc({ ls, idb, key, mirror = true, local = true }) {
  let timer = null, lastText;
  const useLs = local && !!ls, useIdb = !!idb && (mirror || !local);
  const within = (p, wait) => (wait ? Promise.race([p, new Promise(ok => setTimeout(ok, wait, undefined))]) : p);
  const flushMirror = async () => {
    timer = null;
    if (!useIdb || lastText === undefined) return;
    try {
      await writeMirror(idb, lastText, key);
    } catch {}
  };
  return {
    // → текст или null
    async load(wait = 0) {
      if (useLs) {
        try {
          const text = ls.getItem(key);
          if (text) return text;
        } catch {}
      }
      if (!useIdb) return null;
      try {
        const m = await within(readMirror(idb, key), wait);
        if (typeof m !== 'string' || !m) return null;
        if (useLs) {
          try {
            ls.setItem(key, m);
          } catch {}
        }
        return m;
      } catch {
        return null;
      }
    },
    save(text) {
      lastText = text;
      if (useLs) {
        try {
          if (text == null) ls.removeItem(key);
          else ls.setItem(key, text);
        } catch {
          // Старую копию убираем: иначе при следующем старте она победит более свежее зеркало.
          try {
            ls.removeItem(key);
          } catch {}
        }
      }
      clearTimeout(timer);
      timer = setTimeout(flushMirror, MIRROR_DELAY);
    },
    async flush(wait = 0) {
      clearTimeout(timer);
      await within(flushMirror(), wait);
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
