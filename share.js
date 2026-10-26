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
export const SEC_DAYS = 21; // разделы друзьям — отметки за три недели: эта, прошлая (итоги гонки) и позапрошлая (сравнение)
export const SEC_NOTE_DAYS = 7; // записи «Что сделано» — за неделю
export const SEC_NOTE_SHARE = 200; // и не длиннее двухсот знаков
const NOTES_IN_FEED = 3; // записей в ленте «Изменения» — не больше трёх свежих: остальное не вытесняют
export const HIDDEN_COLOR = 'gray';
const MAX_ITEMS = 60, MAX_WEEKLY = 20; // больше в чужом снимке — мусор, а не привычки

// Обрезка без половинки эмодзи на конце: половинка в jsonb — отказ сервера и «застрявший» снимок.
const cutText = (s, n) => {
  s = String(s ?? '').slice(0, n);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
};

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

// Снимок своего состояния. prefs: { tz, hidden: [id пунктов], sleep, onepct, sections: [id открытых разделов] }.
export function shareOf(S, today, { tz = '', hidden = [], sleep = true, onepct = true, sections = [] } = {}) {
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
  // Разделы — только открытые и включённые: пункты и отметки за SEC_DAYS дней строкой «0/1», последняя буква — сегодня;
  // отметки дня самого раздела («Что сделано») — такой же строкой d, записи с текстом за неделю — t { дата: текст }.
  const open = new Set(sections);
  let next = ids.size;
  const secFrom = D.addDays(today, -(SEC_DAYS - 1)), noteFrom = D.addDays(today, -(SEC_NOTE_DAYS - 1));
  const secs = (S.sections || []).filter(sec => sec.on && open.has(sec.id)).map(sec => {
    const t = {};
    for (const [d, text] of D.secNotes(S, sec, noteFrom, today)) t[d] = clean(cutText(text, SEC_NOTE_SHARE)); // сначала режем, потом чистим
    return {
      id: (next++).toString(36), name: clean(sec.name), icon: sec.icon, color: sec.color, on: true, addedAt: sec.addedAt,
      items: sec.items.map(it => ({
        id: (next++).toString(36), icon: it.icon, name: clean(it.name), note: clean(it.note), color: it.color, addedAt: it.addedAt,
        m: D.range(secFrom, today).map(d => (D.secDone(S, it.id, d) ? '1' : '0')).join(''),
      })),
      d: D.range(secFrom, today).map(d => (D.secRec(S, sec.id, d) != null ? '1' : '0')).join(''),
      ...(Object.keys(t).length ? { t } : {}),
    };
  });
  return {
    schema: 1,
    createdAt,
    since: S.since,
    items: S.items.map(it => pack(it, false)),
    weekly: S.weekly.map(it => pack(it, true)),
    plans,
    days,
    weekMarks,
    ...(secs.length ? { sections: secs } : {}), // нет открытых — снимок прежний, лишней публикации нет
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
  const F = D.normalize({ ...doc, days: unpackDays(doc.plans, doc.days), ...unpackSections(doc.sections, day) }, today);
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
  for (const id of Object.keys(F.secMarks)) F.secMarks[id] = F.secMarks[id].filter(d => d <= today);
  for (const o of Object.values(F.secDays)) for (const d of Object.keys(o)) if (d > today) delete o[d];
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

// Отметки разделов из снимка: строка «0/1» по дням, последняя буква — день снимка. Без дня снимка — без отметок.
// Пункты → secMarks; день самого раздела (d) и записи (t) → secDays.
function unpackSections(sections, day) {
  const secMarks = {}, secDays = {};
  if (!Array.isArray(sections) || !day) return { secMarks, secDays };
  const dates = bits => {
    const m = typeof bits === 'string' ? bits.slice(-SEC_DAYS) : '';
    const out = [];
    for (let i = 0; i < m.length; i++) if (m[i] === '1') out.push(D.addDays(day, i - (m.length - 1)));
    return out;
  };
  const okId = id => typeof id === 'string' && !(id in Object.prototype);
  for (const sec of sections) {
    if (!sec || typeof sec !== 'object') continue;
    for (const it of Array.isArray(sec.items) ? sec.items : []) {
      if (!it || !okId(it.id)) continue;
      const m = dates(it.m);
      if (m.length) secMarks[it.id] = m;
    }
    if (!okId(sec.id)) continue;
    const t = sec.t && typeof sec.t === 'object' && !Array.isArray(sec.t) ? sec.t : {};
    const o = {};
    for (const d of dates(sec.d)) o[d] = typeof t[d] === 'string' ? t[d] : ''; // ключ — дата: имён Object.prototype не бывает
    if (Object.keys(o).length) secDays[sec.id] = o;
  }
  return { secMarks, secDays };
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

// Гонка недели (v60): очко за закрытый день, за ночь в цель и за дело сверх минимума (раздел, открытый друзьям, или
// недельный счётчик) — до трёх в день, с monday по воскресенье, но не дальше своего «сегодня». Каждый идёт против своего
// минимума и своего шага отбоя. Ночи считаются, только если сон виден друзьям: скрыл сон — ночей в счёте нет (у всех
// одинаково, и у «Я»); закрытый раздел очков не даёт — друзья его не видят.
export function weekScore({ F, today, sleep = true }, monday) {
  const sun = D.addDays(monday, 6), last = sun < today ? sun : today;
  const days = monday > last ? [] : D.range(monday, last);
  const closed = days.filter(d => D.status(F, d, today) === 'closed').length;
  const nights = sleep ? D.sleepHits(F, D.knownMornings(F, monday, sun, today)).k : 0;
  const extra = days.filter(d => D.extraDay(F, d)).length;
  return { closed, nights, extra, score: closed + nights + extra };
}

// Что ещё даст очки сегодня: закрыть день, отметить прошлую ночь (если она в цель — очко), дело сверх минимума.
// Сверх минимума — только если есть где: раздел, открытый друзьям, или недельный счётчик.
export function scoreLeft({ F, today, sleep = true }) {
  const { k, n } = D.progress(F, today, today);
  return {
    day: n > 0 && k < n,
    night: sleep && !F.sleep.nights[today]?.bed,
    extra: !D.extraDay(F, today) && (F.sections.some(sec => sec.on) || F.weekly.some(w => !w.archivedAt)),
  };
}

// Места: больше счёт — выше; при равном счёте выше тот, у кого больше закрытых дней, но место общее: 1, 1, 3.
// Дальше — исходный порядок (сначала «Я», потом друзья в порядке добавления). Возвращает новый массив.
export function ranked(list) {
  const out = list.map((p, i) => ({ ...p, i })).sort((a, b) => b.score - a.score || b.closed - a.closed || a.i - b.i);
  out.forEach((p, k) => (p.place = k && p.score === out[k - 1].score ? out[k - 1].place : k + 1));
  return out;
}

const ORDER = { streak: 0, week: 1, note: 2, step: 3, onepct: 4, add: 5, remove: 6 };

// Лента изменений: новые и убранные пункты, шаг отбоя, «1% недели», круглые серии, неделя счётчика в цель,
// записи «Что сделано» в открытых разделах.
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
  // Записи «Что сделано» — только три свежие: ежедневные записи не вытесняют из ленты новые пункты, шаги и серии.
  F.sections.flatMap(sec => D.secNotes(F, sec, F.createdAt, today).map(([d, text]) => ({ d, sec, text })))
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)).slice(0, NOTES_IN_FEED)
    .forEach(n => push(n.d, 'note', { section: n.sec, text: n.text }));
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
