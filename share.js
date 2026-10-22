// Минимум — снимок прогресса для друзей. Чистые функции: без сети и DOM.
// Снимок — это состояние v2 в том же формате (его принимает normalize), только без личного:
// разбор недели («получилось», «не получилось», «научился», Notes) не уходит никогда; скрытый пункт
// уходит «Личным пунктом» серого цвета — отметки остаются, иначе «3 из 9» у друга разошлось бы с твоим;
// сон и «1% недели» — по выбору владельца. Id пунктов сжаты до номеров: снимок лёгкий и не выдаёт uuid.
// Друг читает снимок теми же функциями domain.js — видит ровно то, что показал бы твой телефон.

import * as D from './domain.js';
import { DEFAULT_ICON } from './icons.js';

export const SHARE_V = 1;
export const NIGHTS_KEEP = 42; // 6 недель: цепь, неделя, график сна
export const WINDOW_DAYS = 1096; // история — три года: снимок не растёт вечно (≈ 40 КБ), серия длиннее — редкость
export const HIDDEN_NAME = 'Личный пункт';
export const HIDDEN_COLOR = 'gray';
const MAX_ITEMS = 60, MAX_WEEKLY = 20; // больше в чужом снимке — мусор, а не привычки

// Текст в снимок: без управляющих символов и половинок эмодзи — Postgres такой jsonb не примет.
// Без lookbehind в регулярке: старый Safari не разобрал бы модуль целиком.
export function clean(s) {
  s = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else out += '\ufffd';
    } else out += c >= 0xdc00 && c <= 0xdfff ? '\ufffd' : s[i];
  }
  return out;
}

// Логический день (граница 04:00) в поясе tz; без пояса или с неизвестным — по часам устройства.
export function logicalDateIn(tz, now = new Date()) {
  if (tz) {
    try {
      const p = {};
      const f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
      });
      for (const x of f.formatToParts(now)) p[x.type] = x.value;
      const cal = `${p.year}-${p.month}-${p.day}`;
      if (D.isDate(cal)) return +p.hour % 24 < D.DAY_START_HOUR ? D.addDays(cal, -1) : cal;
    } catch {}
  }
  return D.logicalDate(now);
}

export function deviceZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

// Снимок своего состояния. prefs: { tz, hidden: [id пунктов], sleep, onepct }.
export function shareOf(S, today, { tz = '', hidden = [], sleep = true, onepct = true } = {}) {
  const ids = new Map();
  [...S.items, ...S.weekly].forEach((it, i) => ids.set(it.id, i.toString(36)));
  const hide = new Set(hidden.filter(id => ids.has(id)));
  // Окно истории: всё, что раньше, — как будто приложения ещё не было.
  const from0 = D.addDays(today, -(WINDOW_DAYS - 1));
  const createdAt = S.createdAt < from0 ? from0 : S.createdAt;
  const pack = (it, weekly) => {
    const h = hide.has(it.id);
    const o = {
      id: ids.get(it.id), icon: h ? DEFAULT_ICON : it.icon, name: h ? HIDDEN_NAME : clean(it.name), note: h ? '' : clean(it.note),
      color: h ? HIDDEN_COLOR : it.color, addedAt: it.addedAt, archivedAt: it.archivedAt,
    };
    if (weekly) o.perWeek = it.perWeek;
    else o.beforeBed = h || !sleep ? null : it.beforeBed; // «до 00:30» выдало бы отбой, если сон скрыт
    return o;
  };
  // День — [номер плана, флаги «сделано» по позициям плана]: планы повторяются изо дня в день,
  // поэтому лежат один раз в plans. Отметка вне плана ни на что не влияет — её не шлём.
  const plans = [], planAt = new Map();
  const days = {};
  for (const d of Object.keys(S.days).sort()) {
    if (d > today || d < createdAt) continue;
    const plan = S.days[d].plan.filter(id => ids.has(id)).map(id => ids.get(id));
    const key = plan.join(',');
    if (!planAt.has(key)) {
      planAt.set(key, plans.length);
      plans.push(plan);
    }
    const done = new Set(S.days[d].done.filter(id => ids.has(id)).map(id => ids.get(id)));
    days[d] = [planAt.get(key), plan.map(id => (done.has(id) ? '1' : '0')).join('')];
  }
  const weekMarks = {};
  for (const [id, a] of Object.entries(S.weekMarks)) {
    const m = a.filter(d => d <= today && d >= createdAt);
    if (ids.has(id) && m.length) weekMarks[ids.get(id)] = m;
  }
  const from = D.addDays(today, -(NIGHTS_KEEP - 1));
  const nights = {};
  if (sleep) for (const [d, n] of Object.entries(S.sleep.nights)) if (d >= from && d <= today) nights[d] = { ...n };
  const reviews = {};
  for (const [m, r] of Object.entries(S.reviews)) {
    if (m < D.addDays(createdAt, -6)) continue;
    // Когда закрыта неделя — только день (по своему поясу), без минут.
    const at = new Date(r.closedAt);
    const closedAt = Number.isNaN(at.getTime()) ? '' : logicalDateIn(tz, at);
    reviews[m] = { closedAt, improvement: onepct ? clean(r.improvement) : '', sleep: sleep ? { ...r.sleep } : {} };
  }
  return {
    schema: 1,
    createdAt,
    since: S.since,
    items: S.items.map(it => pack(it, false)),
    weekly: S.weekly.map(it => pack(it, true)),
    plans,
    days,
    weekMarks,
    sleep: sleep
      ? { goalBed: S.sleep.goalBed, goalWake: S.sleep.goalWake, targets: S.sleep.targets.map(t => ({ ...t })), nights }
      : { targets: [], nights: {} },
    reviews,
    meta: { v: SHARE_V, tz, day: today, hidden: [...hide].map(id => ids.get(id)), sleep: !!sleep, onepct: !!onepct },
  };
}

// Чужой снимок → { F (нормализованное состояние), today (логический день друга сейчас), day (день снимка),
// tz, hidden, sleep, onepct } или null. Снимок — недоверенные данные: всё проходит через normalize,
// текст в интерфейс попадает только текстовыми узлами.
export function readShare(doc, now = new Date()) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const meta = doc.meta && typeof doc.meta === 'object' && !Array.isArray(doc.meta) ? doc.meta : {};
  const tz = typeof meta.tz === 'string' ? meta.tz.slice(0, 64) : '';
  const real = logicalDateIn(tz, now);
  // День снимка из будущего больше чем на сутки — мусор или сбитые часы: не верим.
  const day = D.isDate(meta.day) && meta.day <= D.addDays(real, 2) ? meta.day : null;
  let today = real;
  if (day && today < day) today = day; // часы смотрящего отстают — не показываем «вчера» вместо «сегодня»
  const F = D.normalize({ ...doc, days: unpackDays(doc.plans, doc.days) }, today);
  if (!F) return null;
  // Чужой снимок не должен подвесить вкладку: окно истории и число пунктов — как у честного снимка.
  const from0 = D.addDays(today, -(WINDOW_DAYS - 1));
  if (F.createdAt < from0) F.createdAt = from0;
  if (F.createdAt > today) F.createdAt = today;
  F.items = F.items.slice(0, MAX_ITEMS);
  F.weekly = F.weekly.slice(0, MAX_WEEKLY);
  const known = new Set([...F.items, ...F.weekly].map(i => i.id));
  for (const d of Object.keys(F.days)) {
    if (d < F.createdAt || d > today) delete F.days[d];
    else for (const k of ['plan', 'done']) F.days[d][k] = F.days[d][k].filter(id => known.has(id));
  }
  for (const id of Object.keys(F.weekMarks)) {
    if (known.has(id)) F.weekMarks[id] = F.weekMarks[id].filter(d => d >= F.createdAt && d <= today);
    else delete F.weekMarks[id];
  }
  const hidden = new Set((Array.isArray(meta.hidden) ? meta.hidden : []).filter(id => typeof id === 'string' && known.has(id)));
  return { F, today, day, tz, hidden, sleep: meta.sleep !== false, onepct: meta.onepct !== false };
}

// plans + days из снимка → days состояния v2. Битые записи пропускаются.
function unpackDays(plans, days) {
  const out = {};
  if (!Array.isArray(plans) || !days || typeof days !== 'object' || Array.isArray(days)) return out;
  for (const [d, v] of Object.entries(days)) {
    if (!Array.isArray(v) || !Number.isInteger(v[0]) || typeof v[1] !== 'string') continue;
    const plan = plans[v[0]];
    if (!Array.isArray(plan)) continue;
    out[d] = { plan, done: plan.filter((_, i) => v[1][i] === '1') };
  }
  return out;
}

// Сводка дня — для героя, строки друга и «Я».
export function summaryOf(F, today) {
  const { plan, k, n } = D.progress(F, today, today);
  const { streak, best } = D.history(F, today);
  const mon = D.weekStart(today);
  const sh = D.sleepHits(F, D.knownMornings(F, mon, D.addDays(mon, 6), today));
  const w = D.firstWeekly(F);
  return { plan, done: D.doneOf(F, today), k, n, closed: n > 0 && k === n, streak, best, sh, w, wc: w ? D.weekCount(F, w.id, today) : 0 };
}

const ORDER = { streak: 0, week: 1, step: 2, onepct: 3, add: 4, remove: 5 };

// Лента изменений: новые и убранные пункты, шаг отбоя, «1% недели», круглые серии, неделя счётчика в цель.
// Всё выводится из самого состояния — отдельного журнала нет. Свежие сверху.
export function changes({ F, today, hidden = new Set(), sleep = true, onepct = true, tz = '' }, limit = 12) {
  const out = [];
  const push = (date, kind, data) => {
    if (D.isDate(date) && date >= F.createdAt && date <= today) out.push({ date, kind, ...data });
  };
  for (const it of [...F.items, ...F.weekly]) {
    const weekly = F.weekly.includes(it), hid = hidden.has(it.id);
    if (it.addedAt > F.createdAt) push(it.addedAt, 'add', { item: it, weekly, hidden: hid });
    if (it.archivedAt) push(it.archivedAt, 'remove', { item: it, weekly, hidden: hid });
  }
  if (sleep) {
    const ts = F.sleep.targets;
    // Новый шаг действует с завтрашнего дня — решение принято накануне.
    for (let i = 1; i < ts.length; i++) if (ts[i].bed !== ts[i - 1].bed) push(D.addDays(ts[i].from, -1), 'step', { from: ts[i - 1].bed, to: ts[i].bed });
  }
  if (onepct) {
    for (const [monday, r] of Object.entries(F.reviews)) {
      if (!r.improvement) continue;
      // В снимке — день закрытия; у старых или битых — воскресенье той недели.
      let d = D.isDate(r.closedAt) ? r.closedAt : '';
      if (!d) {
        const at = new Date(r.closedAt);
        d = Number.isNaN(at.getTime()) ? D.addDays(monday, 6) : logicalDateIn(tz, at);
      }
      push(d, 'onepct', { text: r.improvement });
    }
  }
  // Серия — тем же правилом, что в walkStreak: один пропуск прощён, второй подряд — с нуля.
  let run = 0, misses = 0;
  for (const d of D.range(F.createdAt, today)) {
    const st = D.status(F, d, today);
    if (st === 'closed') {
      run++;
      misses = 0;
      if (D.isMilestone(run)) push(d, 'streak', { n: run });
    } else if (st === 'miss' && ++misses >= 2) run = 0;
  }
  for (const w of F.weekly) {
    const weeks = new Map();
    for (const d of F.weekMarks[w.id] || []) {
      if (d > today) continue;
      const m = D.weekStart(d);
      if (!weeks.has(m)) weeks.set(m, []);
      weeks.get(m).push(d);
    }
    for (const ds of weeks.values()) {
      ds.sort();
      if (ds.length >= w.perWeek) push(ds[w.perWeek - 1], 'week', { item: w, hidden: hidden.has(w.id) });
    }
  }
  out.sort((a, b) => (a.date === b.date ? ORDER[a.kind] - ORDER[b.kind] : a.date < b.date ? 1 : -1));
  return out.slice(0, limit);
}
