// Минимум — друзья через Supabase. Личность — секрет устройства (256 бит; на сервере — только его sha256):
// ни почты, ни паролей, ни сессий, которые истекают. Отметки живут на телефоне и работают без сети;
// на сервер уходит только снимок для друзей (share.js) — после изменений, при открытии и уходе в фон.
// Без supabase-js: POST /rest/v1/rpc/minimum_* с publishable-ключом в заголовке apikey (роль anon).
// Все проверки — в функциях базы (supabase/friends.sql): таблицы снаружи не видны вовсе.

import { logicalDate } from './domain.js';
import { shareOf, deviceZone } from './share.js';
import { createDoc } from './store.js';

// Проект Supabase. Адрес и publishable-ключ публичны по замыслу: данные защищают функции базы, не ключ.
// Пусто — «Друзей» в приложении нет. Secret-ключ (sb_secret_…) сюда не попадает никогда.
export const SUPABASE_URL = 'https://yoefpifnclqsmcogrfcf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_tSJvd-I_bXATaaYT2xYBdw_074BGarN';

export const CLOUD_KEY = 'minimum.cloud';
export const CACHE_KEY = 'minimum.cloud-cache';
export const CODE_RE = /^[2-9A-HJ-NP-Z]{5}$/;
export const NAME_MAX = 40;
const PUBLISH_DELAY = 2500; // отметки подряд уходят одним снимком
const SYNC_GAP = 8000; // чаще не спрашиваем сервер без нужды
const TIMEOUT = 15000;
const KEEPALIVE_MAX = 60000; // запрос с keepalive переживает уход в фон, но не больше 64 КБ
const ACTION_ERRORS = ['bad_name', 'bad_secret', 'bad_snapshot', 'too_large', 'rate_limited', 'busy', 'full'];
const DISK_WAIT = 1500; // зеркало IndexedDB может зависнуть — интерфейс его не ждёт дольше

// Кириллица-двойник → латиница: на русской раскладке «К7М2Р» — тот же код, что «K7M2P».
const LOOKALIKE = { А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M', О: 'O', Р: 'P', Т: 'T', Х: 'X', У: 'Y', З: '3' };
// Код друга из ввода: «k7m-2p» → «K7M2P». Имя — как его почистит сервер.
export const cleanCode = s => String(s ?? '').toUpperCase().replace(/[А-ЯЁ]/g, ch => LOOKALIKE[ch] || '').replace(/[^0-9A-Z]/g, '');
export const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

export class CloudError extends Error {
  constructor(kind, status = 0) {
    super(kind);
    this.kind = kind; // offline | down | config | lost | bad_name | rate_limited | … | error
    this.status = status;
  }
}

// FNV-1a: понять, изменился ли снимок, не храня его копию.
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + '.' + s.length.toString(36);
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;

// Документ устройства: секрет, профиль, что видят друзья, отпечаток последнего отправленного снимка.
function normDoc(raw) {
  const o = isObj(raw) ? raw : {};
  const secret = SECRET_RE.test(o.secret) ? o.secret : '';
  const id = secret ? str(o.id, 64) : '';
  return {
    v: 1,
    secret,
    id,
    code: id && CODE_RE.test(o.code) ? o.code : '',
    name: cleanName(o.name),
    hidden: Array.isArray(o.hidden) ? [...new Set(o.hidden.filter(x => typeof x === 'string' && x))].slice(0, 500) : [],
    sleep: o.sleep !== false,
    onepct: o.onepct !== false,
    sent: id ? str(o.sent, 40) : '',
  };
}

// Ответ сервера о друзьях — тоже недоверенные данные: только ожидаемые поля и типы.
function normCache(raw) {
  if (!isObj(raw)) return null;
  const list = (a, f) => (Array.isArray(a) ? a.filter(isObj).map(f).filter(x => x.id) : []);
  const time = v => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : '');
  return {
    at: time(raw.at),
    now: time(raw.now),
    friends: list(raw.friends, f => ({
      id: str(f.id, 64), code: str(f.code, 8), name: cleanName(f.name) || '—',
      snapshot: isObj(f.snapshot) ? f.snapshot : null, seenAt: time(f.seenAt), since: time(f.since),
    })),
    incoming: list(raw.incoming, f => ({ id: str(f.id, 64), code: str(f.code, 8), name: cleanName(f.name) || '—', at: time(f.at) })),
    outgoing: list(raw.outgoing, f => ({ id: str(f.id, 64), code: str(f.code, 8), at: time(f.at) })),
  };
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// win — окно (fetch, crypto, localStorage, таймеры); getState — текущее состояние; onChange — перерисовать.
// url, key, fetch подменяются в тестах и превью.
// paused() → true — снимок не уходит (идёт первая настройка: полунастроенный телефон друзьям не показываем),
// друзья и запросы при этом работают.
export function createCloud({ win, idb, getState, now = () => new Date(), onChange = () => {}, paused = () => false, url = SUPABASE_URL, key = SUPABASE_KEY, fetch: fetchFn } = {}) {
  const enabled = !!(url && key);
  let ls;
  try {
    ls = win.localStorage;
  } catch {}
  const docStore = createDoc({ ls, idb, key: CLOUD_KEY });
  // Кэш друзей — только в IndexedDB: localStorage общий со всеми PWA домена, его место — для отметок.
  const cacheStore = createDoc({ idb, key: CACHE_KEY, local: false });
  const go = fetchFn || (typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
  const t = () => now().getTime();

  let doc = normDoc(null), cache = null;
  let status = 'idle', lastOk = 0, skew = 0, notice = '', stuck = '';
  let pubTimer = 0, lastSync = -Infinity, syncQueued = false;
  let chain = Promise.resolve();
  const serial = fn => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  const joined = () => enabled && !!(doc.secret && doc.id);
  const saveDoc = () => docStore.save(JSON.stringify(doc));
  const saveCache = () => cacheStore.save(cache ? JSON.stringify(cache) : null);

  async function rpc(fn, args, { keepalive = false } = {}) {
    if (!go) throw new CloudError('offline');
    const body = JSON.stringify(args);
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // старый anon-ключ — это JWT
    const bytes = typeof win.TextEncoder === 'function' ? new win.TextEncoder().encode(body).length : body.length * 3;
    const ctl = typeof win.AbortController === 'function' ? new win.AbortController() : null;
    const timer = ctl ? win.setTimeout(() => ctl.abort(), TIMEOUT) : 0;
    try {
      let res;
      try {
        res = await go(`${url}/rest/v1/rpc/${fn}`, {
          method: 'POST', headers, body, signal: ctl?.signal, cache: 'no-store', credentials: 'omit',
          keepalive: keepalive && bytes < KEEPALIVE_MAX,
        });
      } catch {
        throw new CloudError('offline');
      }
      let data = null, parsed = true;
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : null;
      } catch {
        parsed = false;
      }
      if (res.ok && parsed) return data;
      const msg = typeof data?.message === 'string' ? data.message : '';
      if (msg === 'unknown_secret') throw new CloudError('lost', res.status);
      if (ACTION_ERRORS.includes(msg)) throw new CloudError(msg, res.status);
      if (res.status >= 500 || res.ok) throw new CloudError('down', res.status); // 5xx, спящий проект, HTML вместо JSON
      if (res.status === 401 || res.status === 403 || res.status === 404) throw new CloudError('config', res.status);
      throw new CloudError('error', res.status);
    } finally {
      if (timer) win.clearTimeout(timer);
    }
  }

  // Сервер не узнал секрет (профиль удалили, база новая или адрес проекта перепутали): профиль забываем,
  // а секрет, имя и видимость пунктов — нет. «Включить заново» с тем же секретом вернёт прежний профиль,
  // если он на сервере всё-таки есть, и создаст новый, если нет.
  function lose() {
    doc = { ...doc, id: '', code: '', sent: '' };
    cache = null;
    notice = 'lost';
    saveDoc();
    saveCache();
  }

  // Ошибка запроса → состояние связи; «потерянный» профиль — сразу забываем.
  function fail(e) {
    const kind = e instanceof CloudError ? e.kind : 'error';
    if (kind === 'lost') lose();
    else if (kind === 'offline' || kind === 'down' || kind === 'config') status = kind;
    return kind;
  }

  function snapshot() {
    const today = logicalDate(now());
    const obj = shareOf(getState(), today, { tz: deviceZone(), hidden: doc.hidden, sleep: doc.sleep, onepct: doc.onepct });
    return { obj, h: hash(JSON.stringify(obj)) };
  }

  const ok = () => {
    const was = status;
    status = 'ok';
    lastOk = t();
    return was !== 'ok';
  };

  // Друзья, запросы и (если снимок поменялся) публикация — одним запросом.
  function sync({ force = false } = {}) {
    if (!joined()) return Promise.resolve();
    if (syncQueued || (!force && t() - lastSync < SYNC_GAP)) return chain;
    syncQueued = true;
    return serial(async () => {
      syncQueued = false;
      if (!joined()) return;
      lastSync = t();
      const args = { p_secret: doc.secret };
      let h = '';
      if (!paused()) {
        const snap = snapshot();
        h = snap.h;
        if (h !== doc.sent && h !== stuck) args.p_snapshot = snap.obj;
      }
      try {
        let r;
        try {
          r = await rpc('minimum_sync', args);
        } catch (e) {
          // Сервер отверг сам снимок (4xx, не связь и не профиль) — друзей всё равно обновим,
          // а этот снимок больше не шлём, пока он не изменится.
          if (!args.p_snapshot || !(e instanceof CloudError) || ['offline', 'down', 'config', 'lost'].includes(e.kind)) throw e;
          stuck = h;
          delete args.p_snapshot;
          r = await rpc('minimum_sync', args);
        }
        if (args.p_snapshot) {
          doc.sent = h;
          stuck = '';
        }
        if (isObj(r?.me) && CODE_RE.test(r.me.code)) {
          doc.code = r.me.code;
          doc.name = cleanName(r.me.name) || doc.name;
        }
        cache = normCache({ ...r, at: new Date(t()).toISOString() });
        const srv = Date.parse(r?.now);
        if (!Number.isNaN(srv)) skew = srv - t();
        ok();
        notice = '';
        saveDoc();
        saveCache();
      } catch (e) {
        fail(e);
      }
      onChange();
    });
  }

  // Своё изменилось — отправим снимок чуть позже, когда отметки улягутся.
  function changed() {
    if (!joined() || paused()) return;
    win.clearTimeout(pubTimer);
    pubTimer = win.setTimeout(() => {
      pubTimer = 0;
      publish();
    }, PUBLISH_DELAY);
  }

  function publish({ keepalive = false } = {}) {
    return serial(async () => {
      if (!joined() || paused()) return;
      const { obj, h } = snapshot();
      if (h === doc.sent || h === stuck) return;
      try {
        await rpc('minimum_publish', { p_secret: doc.secret, p_snapshot: obj }, { keepalive });
        doc.sent = h;
        stuck = '';
        saveDoc();
        if (ok()) onChange();
      } catch (e) {
        if (e instanceof CloudError && !['offline', 'down', 'config', 'lost'].includes(e.kind)) stuck = h;
        fail(e);
        onChange();
      }
    });
  }

  // Уход в фон: снимок — сейчас (keepalive), секрет — на диск.
  function flush() {
    docStore.flush();
    if (!joined()) return;
    if (pubTimer) {
      win.clearTimeout(pubTimer);
      pubTimer = 0;
    }
    publish({ keepalive: true });
  }

  // Действие с ответом для интерфейса: ошибка «потерянного» профиля или связи — тоже в состояние.
  async function act(fn, args) {
    try {
      return await serial(() => rpc(fn, { p_secret: doc.secret, ...args }));
    } catch (e) {
      fail(e);
      onChange();
      throw e;
    }
  }

  return {
    enabled,
    get joined() {
      return joined();
    },
    get me() {
      return { id: doc.id, code: doc.code, name: doc.name };
    },
    get prefs() {
      return { hidden: doc.hidden.slice(), sleep: doc.sleep, onepct: doc.onepct };
    },
    get status() {
      return status;
    },
    get notice() {
      return notice;
    },
    get cache() {
      return cache;
    },
    get lastOk() {
      return lastOk;
    },
    // Сервер не принимает текущий снимок — друзья видят прежний.
    get stuck() {
      return !!stuck;
    },
    // Время сервера: «обновлено N мин назад» не врёт, даже если часы телефона сбиты.
    serverNow: () => t() + skew,

    async load() {
      if (!enabled) return;
      const before = doc;
      try {
        const text = await docStore.load(DISK_WAIT);
        if (text && doc === before) doc = normDoc(JSON.parse(text)); // пока читали, «Включить» уже записало своё
      } catch {}
      if (!doc.id) return;
      try {
        const text = await cacheStore.load(DISK_WAIT);
        if (text && doc.id && !cache) cache = normCache(JSON.parse(text));
      } catch {}
    },

    sync,
    changed,
    flush,

    // Включить друзей. Секрет пишется на диск до запроса: если ответ потеряется, повтор вернёт тот же профиль.
    async join(name) {
      const n = cleanName(name);
      if (!n) throw new CloudError('bad_name');
      if (!enabled) throw new CloudError('config');
      try {
        await serial(async () => {
          if (!doc.secret) {
            const b = new Uint8Array(32);
            win.crypto.getRandomValues(b);
            doc.secret = base64url(b);
          }
          doc = { ...doc, name: n, id: '', code: '', sent: '' };
          notice = '';
          saveDoc();
          await docStore.flush(DISK_WAIT);
          const me = await rpc('minimum_join', { p_secret: doc.secret, p_name: n });
          if (!isObj(me) || !me.id || !CODE_RE.test(me.code)) throw new CloudError('down');
          doc.id = str(me.id, 64);
          doc.code = me.code;
          doc.name = cleanName(me.name) || n;
          ok();
          saveDoc();
        });
      } catch (e) {
        fail(e);
        onChange();
        throw e;
      }
      onChange();
      await sync({ force: true });
    },

    // → sent | friends | pending | already | self | not_found | limit | rate_limited
    async request(code) {
      const c = cleanCode(code);
      if (!CODE_RE.test(c)) return 'not_found';
      if (c === doc.code) return 'self';
      const r = await act('minimum_request', { p_code: c });
      await sync({ force: true });
      return typeof r === 'string' ? r : 'error';
    },

    // → true, если приняли; false — запрос уже отменили.
    async accept(id) {
      if (cache) cache.incoming = cache.incoming.filter(f => f.id !== id);
      onChange();
      try {
        return (await act('minimum_accept', { p_id: id })) === true;
      } finally {
        await sync({ force: true });
      }
    },

    // Отклонить, отменить или удалить из друзей.
    async remove(id) {
      if (cache) for (const k of ['friends', 'incoming', 'outgoing']) cache[k] = cache[k].filter(f => f.id !== id);
      saveCache();
      onChange();
      try {
        await act('minimum_remove', { p_id: id });
      } finally {
        await sync({ force: true });
      }
    },

    async rename(name) {
      const n = cleanName(name);
      if (!n) throw new CloudError('bad_name');
      const me = await act('minimum_rename', { p_name: n });
      doc.name = cleanName(me?.name) || n;
      saveDoc();
      onChange();
    },

    // Выключить друзей: профиль, снимок и связи стираются с сервера; без связи — не выключаем.
    async leave() {
      try {
        await act('minimum_leave', {});
      } catch (e) {
        if (!(e instanceof CloudError) || e.kind !== 'lost') throw e;
      }
      doc = normDoc({ hidden: doc.hidden, sleep: doc.sleep, onepct: doc.onepct });
      cache = null;
      notice = '';
      stuck = '';
      status = 'idle';
      saveDoc();
      saveCache();
      onChange();
    },

    // Что видят друзья: скрытые пункты, сон, «1% недели».
    setHidden(id, hide) {
      const set = new Set(doc.hidden);
      if (hide) set.add(id);
      else set.delete(id);
      doc.hidden = [...set];
      saveDoc();
      changed();
    },
    setShare(what, on) {
      if (what !== 'sleep' && what !== 'onepct') return;
      doc[what] = !!on;
      saveDoc();
      changed();
    },
    clearNotice() {
      notice = '';
    },
  };
}
