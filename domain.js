// Минимум v2 — чистая логика: даты, план дня, серия, сон, итоги недели. Без DOM.

import { ICON_IDS, DEFAULT_ICON } from './icons.js';

export const DAY_START_HOUR = 4;
export const MAX_DAILY = 10;
export const SINCE = '2026-07-20';
// Палитра плиток: под белый значок, контраст ≥ 3:1 (считает tests/style.test.js).
export const COLORS = ['red', 'orange', 'yellow', 'green', 'mint', 'teal', 'blue', 'indigo', 'purple', 'pink', 'brown', 'gray'];
export const DEFAULT_COLOR = 'blue';
export const LATEST_BED = '03:00';
export const CHOICES = ['earlier30', 'earlier15', 'keep', 'later15'];
// Круглые даты серии — праздник закрытия дня чуть больше. 66 — средний срок, за который действие становится привычкой.
export const MILESTONES = [3, 7, 14, 21, 30, 50, 66, 100];
export const isMilestone = n => MILESTONES.includes(n) || (n > 100 && n % 50 === 0);

// ---------- даты: календарная арифметика по YYYY-MM-DD через UTC, переходы времени не сдвигают дни

const pad = n => String(n).padStart(2, '0');
const toUTC = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const fromUTC = ms => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
export const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUTC(toUTC(s)) === s;
export const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const addDays = (s, n) => fromUTC(toUTC(s) + n * 864e5);
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 864e5);
export const weekday = s => (new Date(toUTC(s)).getUTCDay() + 6) % 7; // 0 = пн … 6 = вс
export const weekStart = s => addDays(s, -weekday(s));
export const range = (a, b) => {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
};
const minD = (a, b) => (a < b ? a : b);
const maxD = (a, b) => (a > b ? a : b);

export function logicalDate(now = new Date()) {
  const cal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return now.getHours() < DAY_START_HOUR ? addDays(cal, -1) : cal;
}

// Через сколько мс наступит следующий логический день (локальный конструктор сам учитывает переход времени).
export function msToNextDay(now = new Date()) {
  const [y, m, d] = addDays(logicalDate(now), 1).split('-').map(Number);
  return new Date(y, m - 1, d, DAY_START_HOUR).getTime() - now.getTime();
}

// ---------- время HH:MM

export const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
export const norm = t => (toMin(t) < 720 ? toMin(t) + 1440 : toMin(t)); // ночь идёт после вечера
export const fmtTime = m => {
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
export const shiftTime = (t, d) => fmtTime(toMin(t) + d);
export const deadline = (step, before) => shiftTime(step, -before);
// Минуты «сейчас» в шкале norm(): после полуночи — продолжение вечера.
export const nowNorm = d => {
  const m = d.getHours() * 60 + d.getMinutes();
  return m < 720 ? m + 1440 : m;
};
// Сколько минут до HH:MM этой ночью (меньше нуля — уже прошло).
export const untilMin = (d, t) => norm(t) - nowNorm(d);

// ---------- пункты

export const makeId = () =>
  globalThis.crypto?.randomUUID?.() ?? 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2);

export const activeItems = s => s.items.filter(i => !i.archivedAt);
export const activeIds = s => activeItems(s).map(i => i.id);
export const findItem = (s, id) => s.items.find(i => i.id === id) || s.weekly.find(i => i.id === id);

// Неразрывный пробел держит число с единицей и «до» со временем на одной строке.
const NB = '\u00a0';
const TEMPLATE_ITEMS = [
  ['sunrise', 'Шторы + умыться', 'сразу как встал', 'orange', null],
  ['dumbbell', 'Спорт', `5${NB}отжиманий · 5${NB}подтягиваний · вис`, 'red', null],
  ['book', 'Развитие', `10${NB}минут · книга, вникай в суть`, 'purple', null],
  ['headphones', 'Vocabulary', `10${NB}минут · плейлист лексики`, 'blue', null],
  ['bed', 'Лежка', `15${NB}минут`, 'mint', null],
  ['drop', 'Душ', 'вечером', 'teal', null],
  ['bottle', 'Лак на ногти', 'после душа', 'pink', null],
  ['phone', 'Телефон на кухню', 'будильник заведён — и на кухню', 'indigo', 30],
];
const TEMPLATE_WEEKLY = [['pulse', 'Тренировка', `подтягивания · брусья · уголок · бег 1${NB}км · подъём ног`, 'green', 3]];

export function seed(today, id = makeId) {
  return {
    schema: 1,
    createdAt: today,
    since: SINCE,
    items: TEMPLATE_ITEMS.map(([icon, name, note, color, beforeBed]) =>
      ({ id: id(), icon, name, note, color, beforeBed, addedAt: today, archivedAt: null })),
    weekly: TEMPLATE_WEEKLY.map(([icon, name, note, color, perWeek]) =>
      ({ id: id(), icon, name, note, color, perWeek, addedAt: today, archivedAt: null })),
    days: {},
    weekMarks: {},
    sleep: { goalBed: '23:30', goalWake: '07:30', targets: [{ from: today, bed: '01:00' }], nights: {} },
    reviews: {},
    ui: { welcomeSeen: false, news: '', lastExport: '' },
  };
}

// Поля формы → чистые значения; null, если название пустое.
export function cleanFields(f, weekly) {
  const name = String(f.name ?? '').trim().slice(0, 60);
  if (!name) return null;
  const out = {
    icon: ICON_IDS.includes(f.icon) ? f.icon : DEFAULT_ICON,
    name,
    note: String(f.note ?? '').trim().slice(0, 120),
    color: COLORS.includes(f.color) ? f.color : DEFAULT_COLOR,
  };
  if (weekly) out.perWeek = Math.min(7, Math.max(1, Math.round(+f.perWeek) || 3));
  else {
    const b = Math.round(+f.beforeBed);
    out.beforeBed = f.beforeBed == null || f.beforeBed === '' || !(b >= 1) ? null : Math.min(240, b);
  }
  return out;
}

export function addItem(s, f, weekly, today, id = makeId) {
  const c = cleanFields(f, weekly);
  if (!c) return null;
  const item = { id: id(), ...c, addedAt: today, archivedAt: null };
  (weekly ? s.weekly : s.items).push(item);
  return item;
}

export function updateItem(s, id, f) {
  const item = findItem(s, id);
  const c = item && cleanFields(f, s.weekly.includes(item));
  if (!c) return false;
  Object.assign(item, c);
  return true;
}

// Сдвиг среди активных пунктов своего списка: dir = −1 вверх, +1 вниз.
export function moveItem(s, id, dir) {
  const list = s.items.some(i => i.id === id) ? s.items : s.weekly;
  const act = list.filter(i => !i.archivedAt);
  const k = act.findIndex(i => i.id === id);
  const other = act[k + dir];
  if (k < 0 || !other) return false;
  const a = list.indexOf(act[k]), b = list.indexOf(other);
  [list[a], list[b]] = [list[b], list[a]];
  return true;
}

export function archiveItem(s, id, today) {
  const item = findItem(s, id);
  if (!item || item.archivedAt) return false;
  item.archivedAt = today;
  return true;
}

export function restoreItem(s, id) {
  const item = findItem(s, id);
  if (!item || !item.archivedAt) return false;
  item.archivedAt = null;
  return true;
}

// ---------- план и статус дня

// Сегодня (и вчера без записи) — живой план; прошлые дни — свой снимок;
// день без записи восстанавливается по addedAt/archivedAt.
export function planOf(s, date, today) {
  const rec = s.days[date];
  if (date === today || (!rec && date === addDays(today, -1))) return activeIds(s);
  if (rec) return rec.plan;
  return s.items.filter(i => i.addedAt <= date && (!i.archivedAt || i.archivedAt > date)).map(i => i.id);
}

export const doneOf = (s, date) => s.days[date]?.done || [];

export function progress(s, date, today) {
  const plan = planOf(s, date, today), done = doneOf(s, date);
  return { plan, k: plan.filter(id => done.includes(id)).length, n: plan.length };
}

export function status(s, date, today) {
  if (date < s.createdAt || date > today) return 'none';
  const { k, n } = progress(s, date, today);
  if (!n) return 'none';
  if (k === n) return 'closed';
  if (date === today) return 'pending';
  return date === s.createdAt ? 'none' : 'miss';
}

export const canEdit = (s, date, today) => date >= s.createdAt && (date === today || date === addDays(today, -1));

// Снимок сегодняшнего плана — чтобы завтра он замёрз таким, каким был.
export function syncToday(s, today) {
  const plan = activeIds(s);
  const rec = s.days[today];
  if (!rec) {
    if (!plan.length) return false;
    s.days[today] = { plan, done: [] };
    return true;
  }
  if (rec.plan.join() === plan.join()) return false;
  rec.plan = plan;
  return true;
}

export function toggleDone(s, date, id, today) {
  if (!canEdit(s, date, today)) return false;
  const rec = (s.days[date] ||= { plan: planOf(s, date, today).slice(), done: [] });
  if (date === today) rec.plan = activeIds(s);
  const i = rec.done.indexOf(id);
  if (i >= 0) rec.done.splice(i, 1);
  else if (rec.plan.includes(id)) rec.done.push(id);
  else return false;
  return true;
}

// ---------- серия: «не пропускай дважды»

// Проход вперёд по [дата, статус]. Даёт текущую серию, рекорд и метку дня для цепи:
// closed | forgiven (одиночный пропуск) | break (два подряд) | pending | none.
function walkStreak(entries) {
  const marks = {};
  let run = 0, best = 0, misses = 0, firstMiss = null;
  for (const [d, st] of entries) {
    if (st === 'closed') {
      run++;
      misses = 0;
      best = Math.max(best, run);
      marks[d] = 'closed';
    } else if (st === 'miss') {
      misses++;
      if (misses === 1) {
        firstMiss = d;
        marks[d] = 'forgiven';
      } else {
        if (misses === 2) marks[firstMiss] = 'break';
        run = 0;
        marks[d] = 'break';
      }
    } else marks[d] = st;
  }
  return { streak: run, best, marks };
}

export const history = (s, today) => walkStreak(range(s.createdAt, today).map(d => [d, status(s, d, today)]));

// Статус одного пункта в день — по тем же правилам, что и статус дня.
export function itemStatus(s, id, date, today) {
  if (date < s.createdAt || date > today || !planOf(s, date, today).includes(id)) return 'none';
  if (doneOf(s, date).includes(id)) return 'closed';
  if (date === today) return 'pending';
  return date === s.createdAt ? 'none' : 'miss';
}

// ---------- недельные счётчики

export function weekCount(s, id, date) {
  const a = weekStart(date), b = addDays(a, 6);
  return (s.weekMarks[id] || []).filter(d => d >= a && d <= b).length;
}

export function toggleWeekMark(s, id, date) {
  const m = (s.weekMarks[id] ||= []);
  const i = m.indexOf(date);
  if (i >= 0) m.splice(i, 1);
  else {
    m.push(date);
    m.sort();
  }
}

// ---------- сон (ночь хранится под датой утра)

export function targetFor(s, date) {
  const ts = s.sleep.targets;
  let bed = ts[0]?.bed ?? '01:00';
  for (const t of ts) if (t.from <= date) bed = t.bed;
  return bed;
}

export const stepTonight = (s, today) => targetFor(s, addDays(today, 1));

export function onTarget(s, date) {
  const n = s.sleep.nights[date];
  return !!n?.bed && norm(n.bed) <= norm(targetFor(s, date));
}

export function duration(n) {
  if (!n?.bed || !n?.wake) return null;
  const d = toMin(n.wake) + 1440 - norm(n.bed);
  return d > 0 ? d : null;
}

export function setNight(s, date, field, value) {
  const n = (s.sleep.nights[date] ||= {});
  if (isTime(value)) n[field] = value;
  else delete n[field];
  if (!n.bed && !n.wake) delete s.sleep.nights[date];
}

// Новый шаг действует с завтрашнего логического дня — то есть с ближайшей ночи.
export function setStep(s, bed, today) {
  if (!isTime(bed)) return false;
  const from = addDays(today, 1);
  const ts = s.sleep.targets.filter(t => t.from !== from);
  if (targetFor({ sleep: { targets: ts } }, from) !== bed) ts.push({ from, bed });
  ts.sort((a, b) => (a.from < b.from ? -1 : 1));
  s.sleep.targets = ts;
  return true;
}

export function sleepStats(s, dates) {
  const beds = [], durs = [];
  for (const d of dates) {
    const n = s.sleep.nights[d];
    if (n?.bed) beds.push(norm(n.bed));
    const du = duration(n);
    if (du) durs.push(du);
  }
  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const b = avg(beds), du = avg(durs);
  return { avgBed: b == null ? null : fmtTime(b), avgBedNorm: b, avgDur: du == null ? null : Math.round(du) };
}

// Утра для показа (кольцо «Сон», «Прогресс»): пустое утро — не в цель, но утро дня посева
// и сегодняшнее утро без записи не считаются — их ещё не успели отметить.
export function knownMornings(s, from, to, today) {
  const a = maxD(from, s.createdAt), b = minD(to, today);
  if (a > b) return [];
  return range(a, b).filter(d => (d !== today && d !== s.createdAt) || !!s.sleep.nights[d]?.bed);
}

// → { k, n }: сколько утр из показываемых — «в цель».
export function sleepHits(s, dates) {
  return { k: dates.filter(d => onTarget(s, d)).length, n: dates.length };
}

// ---------- итоги недели

// Учитываемые утра недели: не раньше дня после посева и не позже сегодня.
export function weekMornings(s, monday, today) {
  const a = maxD(monday, addDays(s.createdAt, 1)), b = minD(addDays(monday, 6), today);
  return a <= b ? range(a, b) : [];
}

export function proposal(s, monday, today) {
  const from = stepTonight(s, today);
  const E = weekMornings(s, monday, today);
  const K = E.filter(d => onTarget(s, d)).length;
  const goal = s.sleep.goalBed;
  const atGoal = norm(from) <= norm(goal);
  let opts, rec;
  if (!E.length) [opts, rec] = [['keep'], 'keep'];
  else if (K / E.length >= 0.7) [opts, rec] = [['earlier30', 'earlier15', 'keep'], 'earlier30'];
  else if (K / E.length >= 0.4) [opts, rec] = [['keep', 'earlier15'], 'keep'];
  else [opts, rec] = [['keep', 'later15'], 'keep'];
  if (atGoal) opts = opts.filter(c => !c.startsWith('earlier'));
  const f = norm(from), latest = norm(LATEST_BED);
  const to = {
    earlier30: fmtTime(Math.max(norm(goal), f - 30)),
    earlier15: fmtTime(Math.max(norm(goal), f - 15)),
    keep: from,
    later15: f >= latest ? from : fmtTime(Math.min(latest, f + 15)),
  };
  // У цели «−30» и «−15» совпали — оставляем честное «−15».
  if (to.earlier30 === to.earlier15 && opts.includes('earlier30')) {
    opts = opts.filter(c => c !== 'earlier30');
    if (!opts.includes('earlier15')) opts.unshift('earlier15');
    if (rec === 'earlier30') rec = 'earlier15';
  }
  // Упёрлись в границу — одинаковое время даёт одну кнопку, первую по порядку.
  const options = [];
  for (const c of opts) {
    const same = options.find(o => o.to === to[c]);
    if (same) {
      if (c === rec) rec = same.choice;
    } else options.push({ choice: c, to: to[c] });
  }
  if (!options.some(o => o.choice === rec)) rec = 'keep';
  return { from, E: E.length, K, atGoal, fewData: !E.length, options, recommended: rec };
}

export function pendingReview(s, today) {
  const cur = weekStart(today);
  if (weekday(today) === 6) return s.reviews[cur] ? null : { monday: cur, kind: 'sunday' };
  const prev = addDays(cur, -7);
  if (s.reviews[prev] || addDays(prev, 6) < s.createdAt) return null;
  return { monday: prev, kind: 'overdue' };
}

export const weekImprovement = (s, today) => s.reviews[addDays(weekStart(today), -7)]?.improvement || '';

export function closeWeek(s, monday, draft, choice, today, nowISO = new Date().toISOString()) {
  const p = proposal(s, monday, today);
  const opt = p.options.find(o => o.choice === choice);
  if (!opt) return false;
  const txt = v => String(v ?? '').trim();
  s.reviews[monday] = {
    closedAt: nowISO,
    good: txt(draft.good),
    bad: txt(draft.bad),
    learned: txt(draft.learned),
    notesDone: !!draft.notesDone,
    improvement: txt(draft.improvement),
    sleep: { from: p.from, to: opt.to, choice },
  };
  setStep(s, opt.to, today);
  return true;
}

export function weekSummary(s, monday, today) {
  const days = range(monday, addDays(monday, 6));
  const counted = days.filter(d => status(s, d, today) !== 'none');
  const E = weekMornings(s, monday, today);
  return {
    days,
    closed: counted.filter(d => status(s, d, today) === 'closed').length,
    total: counted.length,
    mornings: E,
    K: E.filter(d => onTarget(s, d)).length,
    missingNights: E.filter(d => duration(s.sleep.nights[d]) == null),
    ...sleepStats(s, E),
  };
}

// ---------- прогресс

// Первый активный недельный счётчик — его показывают кольца.
export const firstWeekly = s => s.weekly.find(i => !i.archivedAt) || null;

// Три кольца дня: доля минимума, ночь «в цель», отметка первого недельного счётчика. null — нет данных.
export function dayRings(s, date, today) {
  if (date > today || date < s.createdAt) return { min: null, sleep: null, week: null };
  const { k, n } = progress(s, date, today);
  const w = firstWeekly(s);
  return {
    min: n ? k / n : null,
    sleep: s.sleep.nights[date]?.bed ? onTarget(s, date) : null,
    week: w ? (s.weekMarks[w.id] || []).includes(date) : null,
  };
}

// Детали пункта. Ежедневный: серия и рекорд по правилу «не пропускай дважды», доля за 28 дней,
// сетка 6 недель (пн–вс) — done | miss | pending | off | future.
// Недельный: счёт этой недели и 8 недель, сколько завершённых недель в цель.
export function itemStats(s, id, today) {
  const item = findItem(s, id);
  if (!item) return null;
  const cur = weekStart(today);
  if (s.weekly.includes(item)) {
    const weeks = Array.from({ length: 8 }, (_, i) => addDays(cur, -7 * (7 - i)))
      .map(monday => ({ monday, count: weekCount(s, id, monday) }));
    const done = weeks.filter(w => w.monday < cur && w.monday >= weekStart(s.createdAt));
    return {
      weekly: true,
      thisWeek: weekCount(s, id, today),
      weeks,
      goalWeeks: done.filter(w => w.count >= item.perWeek).length,
      pastWeeks: done.length,
    };
  }
  const h = walkStreak(range(s.createdAt, today).map(d => [d, itemStatus(s, id, d, today)]));
  const MAP = { closed: 'done', miss: 'miss', pending: 'pending', none: 'off' };
  const cells = range(addDays(cur, -35), addDays(cur, 6))
    .map(d => ({ date: d, st: d > today ? 'future' : MAP[itemStatus(s, id, d, today)] }));
  let planned = 0, done = 0;
  for (const d of range(maxD(addDays(today, -28), s.createdAt), addDays(today, -1))) {
    if (!planOf(s, d, today).includes(id)) continue;
    planned++;
    if (doneOf(s, d).includes(id)) done++;
  }
  return { weekly: false, streak: h.streak, best: h.best, planned, done, rate: planned ? done / planned : null, cells };
}

// Доля выполнения каждого активного пункта за 28 дней до сегодня — по дням, где он был в плане.
export function itemRates(s, today) {
  const days = range(maxD(addDays(today, -28), s.createdAt), addDays(today, -1));
  return activeItems(s).map(item => {
    let planned = 0, done = 0;
    for (const d of days) {
      if (!planOf(s, d, today).includes(item.id)) continue;
      planned++;
      if (doneOf(s, d).includes(item.id)) done++;
    }
    return { item, planned, done, rate: planned ? done / planned : null };
  });
}

// ---------- нормализация (заготовка migrate под будущие схемы)

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const uniq = a => [...new Set(a)];

function normItem(v, weekly, createdAt) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id) return null;
  const c = cleanFields(v, weekly);
  if (!c) return null;
  return {
    id: v.id,
    ...c,
    addedAt: isDate(v.addedAt) ? v.addedAt : createdAt,
    archivedAt: isDate(v.archivedAt) ? v.archivedAt : null,
  };
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// Признак файла v2: схема и характерные поля. Всё остальное — чужой или старый формат.
export const isV2 = raw => isObj(raw) && raw.schema === 1 && Array.isArray(raw.items) && Array.isArray(raw.weekly) && isObj(raw.sleep);

export function normalize(raw, today) {
  if (!isV2(raw)) return null;
  const createdAt = isDate(raw.createdAt) ? raw.createdAt : today;
  const seen = new Set();
  const list = (a, weekly) =>
    a.map(v => normItem(v, weekly, createdAt)).filter(i => i && !seen.has(i.id) && seen.add(i.id));
  const items = list(raw.items, false), weekly = list(raw.weekly, true);
  const days = {};
  for (const [d, r] of Object.entries(isObj(raw.days) ? raw.days : {})) {
    if (!isDate(d) || !isObj(r)) continue;
    const ids = a => (Array.isArray(a) ? uniq(a.filter(x => typeof x === 'string')) : []);
    days[d] = { plan: ids(r.plan), done: ids(r.done) };
  }
  const weekMarks = {};
  for (const [id, a] of Object.entries(isObj(raw.weekMarks) ? raw.weekMarks : {}))
    if (Array.isArray(a)) weekMarks[id] = uniq(a.filter(isDate)).sort();
  const sl = raw.sleep;
  const targets = (Array.isArray(sl.targets) ? sl.targets : [])
    .filter(t => isObj(t) && isDate(t.from) && isTime(t.bed))
    .map(t => ({ from: t.from, bed: t.bed }))
    .sort((a, b) => (a.from < b.from ? -1 : 1));
  const nights = {};
  for (const [d, n] of Object.entries(isObj(sl.nights) ? sl.nights : {})) {
    if (!isDate(d) || !isObj(n)) continue;
    const o = {};
    if (isTime(n.bed)) o.bed = n.bed;
    if (isTime(n.wake)) o.wake = n.wake;
    if (o.bed || o.wake) nights[d] = o;
  }
  const reviews = {};
  for (const [d, r] of Object.entries(isObj(raw.reviews) ? raw.reviews : {})) {
    if (!isDate(d) || !isObj(r)) continue;
    const sr = isObj(r.sleep) ? r.sleep : {};
    reviews[d] = {
      closedAt: str(r.closedAt, 40),
      good: str(r.good, 2000),
      bad: str(r.bad, 2000),
      learned: str(r.learned, 2000),
      notesDone: r.notesDone === true,
      improvement: str(r.improvement, 500),
      sleep: {
        from: isTime(sr.from) ? sr.from : '',
        to: isTime(sr.to) ? sr.to : '',
        choice: CHOICES.includes(sr.choice) ? sr.choice : 'keep',
      },
    };
  }
  return {
    schema: 1,
    createdAt,
    since: isDate(raw.since) ? raw.since : SINCE,
    items,
    weekly,
    days,
    weekMarks,
    sleep: {
      goalBed: isTime(sl.goalBed) ? sl.goalBed : '23:30',
      goalWake: isTime(sl.goalWake) ? sl.goalWake : '07:30',
      targets: targets.length ? targets : [{ from: createdAt, bed: '01:00' }],
      nights,
    },
    reviews,
    ui: {
      welcomeSeen: raw.ui?.welcomeSeen === true,
      news: str(raw.ui?.news, 16),
      lastExport: isDate(raw.ui?.lastExport) ? raw.ui.lastExport : '',
    },
  };
}

export const migrate = normalize;
