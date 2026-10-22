// Фейковый Supabase для тестов и превью: те же функции minimum_* и те же ответы и ошибки, что у
// supabase/friends.sql под PostgREST (200 + JSON, 400 + {code:'P0001', message}, 404 без функции, 401 без ключа).
// Секреты хранятся как есть — это тестовый двойник, не сервер.

const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^[2-9A-HJ-NP-Z]{5}$/;

export function fakeSupabase({ url = 'https://demo.supabase.co', key = 'sb_publishable_demo', now = () => new Date() } = {}) {
  const profiles = [], links = [], attempts = [], calls = [];
  let mode = 'up', seq = 0, rnd = 12345;
  const iso = () => now().toISOString();
  const ms = () => now().getTime();
  const random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const fail = message => {
    const e = new Error(message);
    e.sql = true;
    throw e;
  };
  const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const LOOK = { А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M', О: 'O', Р: 'P', Т: 'T', Х: 'X', У: 'Y', З: '3' };
  const cleanCode = s => String(s ?? '').replace(/[а-яё]/gi, ch => LOOK[ch.toUpperCase()] || ch).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const okSecret = s => typeof s === 'string' && s.length >= 32 && s.length <= 128;
  const auth = s => (okSecret(s) && profiles.find(p => p.secret === s)) || fail('unknown_secret');
  const me = p => ({ id: p.id, code: p.code, name: p.name });
  const other = (l, id) => (l.from === id ? l.to : l.from);
  const byId = id => profiles.find(p => p.id === id);
  // Как Postgres: jsonb не принимает \u0000 и половинки суррогатных пар (ошибка 22P05/22P02, не P0001),
  // а размер считается по jsonb::text — с пробелами после «:» и «,».
  const badText = v => typeof v === 'string' && (/\u0000/.test(v) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v));
  const walk = (v, f) => { f(v); if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { f(k); walk(x, f); } };
  const jsonbText = v => (Array.isArray(v) ? `[${v.map(jsonbText).join(', ')}]`
    : v && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${jsonbText(x)}`).join(', ')}}` : JSON.stringify(v));
  const checkSnapshot = s => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail('bad_snapshot');
    if (api.rejectSnapshots) fail('too_large'); // тест: сервер не принимает снимок
    walk(s, v => { if (badText(v)) { const e = new Error('unsupported Unicode escape sequence'); e.pg = '22P05'; throw e; } });
    if (new TextEncoder().encode(jsonbText(s)).length > 131072) fail('too_large');
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ARGS = {
    minimum_join: ['p_secret', 'p_name'], minimum_publish: ['p_secret', 'p_snapshot'], minimum_sync: ['p_secret', 'p_snapshot'],
    minimum_request: ['p_secret', 'p_code'], minimum_accept: ['p_secret', 'p_id'], minimum_remove: ['p_secret', 'p_id'],
    minimum_rename: ['p_secret', 'p_name'], minimum_leave: ['p_secret'],
  };
  const newCode = () => {
    for (;;) {
      let c = '';
      for (let i = 0; i < 5; i++) c += ALPHA[Math.floor(random() * 32)];
      if (!profiles.some(p => p.code === c)) return c;
    }
  };

  function addProfile({ name, code = newCode(), secret = 'secret-' + String(++seq).padStart(40, '0'), snapshot = null, seenAt = iso(), createdAt = iso() }) {
    const p = { id: uuid(), code, secret, name: cleanName(name), snapshot, snapshotAt: snapshot ? seenAt : null, seenAt, createdAt };
    profiles.push(p);
    return p;
  }

  const fns = {
    minimum_join({ p_secret, p_name }) {
      if (!okSecret(p_secret)) fail('bad_secret');
      const name = cleanName(p_name);
      if (!name) fail('bad_name');
      const had = profiles.find(p => p.secret === p_secret);
      if (had) return me(had);
      if (profiles.filter(p => ms() - Date.parse(p.createdAt) < 3600e3).length >= 30) fail('rate_limited');
      for (const p of profiles.slice()) {
        if (ms() - Date.parse(p.seenAt) > 14 * 864e5 && !links.some(l => l.from === p.id || l.to === p.id)) profiles.splice(profiles.indexOf(p), 1);
      }
      if (profiles.length >= 500) fail('full');
      return me(addProfile({ name, secret: p_secret }));
    },
    minimum_publish({ p_secret, p_snapshot }) {
      const p = auth(p_secret);
      checkSnapshot(p_snapshot);
      p.snapshot = JSON.parse(JSON.stringify(p_snapshot));
      p.snapshotAt = p.seenAt = iso();
      return { at: iso() };
    },
    minimum_sync({ p_secret, p_snapshot = null }) {
      const p = auth(p_secret);
      if (p_snapshot !== null && p_snapshot !== undefined) {
        checkSnapshot(p_snapshot);
        p.snapshot = JSON.parse(JSON.stringify(p_snapshot));
        p.snapshotAt = iso();
      }
      p.seenAt = iso();
      const mine = links.filter(l => l.from === p.id || l.to === p.id);
      return {
        now: iso(),
        me: me(p),
        friends: mine.filter(l => l.accepted).sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : a.acceptedAt > b.acceptedAt ? 1 : 0)).map(l => {
          const f = byId(other(l, p.id));
          return { id: f.id, code: f.code, name: f.name, snapshot: f.snapshot, snapshotAt: f.snapshotAt, seenAt: f.seenAt, since: l.acceptedAt };
        }),
        incoming: mine.filter(l => !l.accepted && l.to === p.id).map(l => {
          const f = byId(l.from);
          return { id: f.id, code: f.code, name: f.name, at: l.createdAt };
        }),
        outgoing: mine.filter(l => !l.accepted && l.from === p.id).map(l => ({ id: l.to, code: byId(l.to).code, at: l.createdAt })),
      };
    },
    minimum_request({ p_secret, p_code }) {
      const p = auth(p_secret);
      if (attempts.filter(a => a.id === p.id && ms() - a.at < 3600e3).length >= 20) return 'rate_limited';
      attempts.push({ id: p.id, at: ms() });
      const code = cleanCode(p_code);
      if (!CODE_RE.test(code)) return 'not_found';
      const to = profiles.find(x => x.code === code);
      if (!to) return 'not_found';
      if (to.id === p.id) return 'self';
      const l = links.find(x => (x.from === p.id && x.to === to.id) || (x.from === to.id && x.to === p.id));
      if (l) {
        if (l.accepted) return 'already';
        if (l.from === p.id) return 'pending';
        l.accepted = true;
        l.acceptedAt = iso();
        return 'friends';
      }
      if (links.filter(x => x.from === p.id || (x.to === p.id && x.accepted)).length >= 50 || links.filter(x => x.to === to.id && !x.accepted).length >= 20) return 'limit';
      links.push({ from: p.id, to: to.id, accepted: false, createdAt: iso(), acceptedAt: null });
      return 'sent';
    },
    minimum_accept({ p_secret, p_id }) {
      const p = auth(p_secret);
      const l = links.find(x => x.from === p_id && x.to === p.id && !x.accepted);
      if (!l) return false;
      l.accepted = true;
      l.acceptedAt = iso();
      return true;
    },
    minimum_remove({ p_secret, p_id }) {
      const p = auth(p_secret);
      const i = links.findIndex(x => (x.from === p.id && x.to === p_id) || (x.from === p_id && x.to === p.id));
      if (i < 0) return false;
      links.splice(i, 1);
      return true;
    },
    minimum_rename({ p_secret, p_name }) {
      const p = auth(p_secret);
      const name = cleanName(p_name);
      if (!name) fail('bad_name');
      p.name = name;
      return me(p);
    },
    minimum_leave({ p_secret }) {
      const p = auth(p_secret);
      profiles.splice(profiles.indexOf(p), 1);
      for (let i = links.length - 1; i >= 0; i--) if (links[i].from === p.id || links[i].to === p.id) links.splice(i, 1);
      return true;
    },
  };

  const res = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });
  const prefix = `${url}/rest/v1/rpc/`;

  async function fetch(u, init = {}) {
    const body = init.body ? JSON.parse(init.body) : {};
    const fn = u.startsWith(prefix) ? u.slice(prefix.length) : '';
    calls.push({ fn, body, headers: init.headers || {}, keepalive: !!init.keepalive, method: init.method });
    if (mode === 'offline') throw new TypeError('Failed to fetch');
    if (mode === 'down') return res(503, '<html>Service Unavailable</html>');
    if (init.method !== 'POST' || (init.headers || {}).apikey !== key) return res(401, JSON.stringify({ message: 'Invalid API key' }));
    // PostgREST ищет функцию по именам аргументов: лишний или незнакомый — «нет такой функции».
    if (!fns[fn] || Object.keys(body).some(k => !ARGS[fn].includes(k))) return res(404, JSON.stringify({ code: 'PGRST202', message: `Could not find the function public.${fn}` }));
    if ('p_id' in body && !UUID.test(String(body.p_id))) return res(400, JSON.stringify({ code: '22P02', message: 'invalid input syntax for type uuid' }));
    try {
      return res(200, JSON.stringify(fns[fn](body) ?? null));
    } catch (e) {
      if (e.sql) return res(400, JSON.stringify({ code: 'P0001', details: null, hint: null, message: e.message }));
      if (e.pg) return res(400, JSON.stringify({ code: e.pg, details: null, hint: null, message: e.message }));
      throw e;
    }
  }

  // Подружить напрямую (для превью и тестов).
  function befriend(a, b, accepted = true) {
    links.push({ from: a.id, to: b.id, accepted, createdAt: iso(), acceptedAt: accepted ? iso() : null });
  }

  const api = {
    url, key, fetch, calls, profiles, links, addProfile, befriend, rejectSnapshots: false,
    get mode() {
      return mode;
    },
    set mode(m) {
      mode = m;
    },
  };
  return api;
}
