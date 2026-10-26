// Минимум v2 — чистая логика: даты, план дня, серия, сон, итоги недели. Без DOM.

import { ICON_IDS, DEFAULT_ICON } from './icons.js';

export const DAY_START_HOUR = 4;
export const MAX_DAILY = 10;
// Разделы (v58): «Работа», «Хобби» и свои — отдельно от минимума. Пределы — против мусора, не против человека.
export const MAX_SECTIONS = 8;
export const MAX_SEC_ITEMS = 20;
export const SECTION_NAME_MAX = 30;
export const SINCE = '2026-07-20';
// Палитра плиток: под белый значок, контраст ≥ 3:1 (считает tests/style.test.js).
export const COLORS = ['red', 'orange', 'yellow', 'green', 'mint', 'teal', 'blue', 'indigo', 'purple', 'pink', 'brown', 'gray'];
export const DEFAULT_COLOR = 'blue';
export const LATEST_BED = '03:00';
export const EVENING_HOUR = 18; // вечер — с 18:00 до границы дня 04:00
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
// Шаблон нового телефона — базовый минимум, который выполним в плохой день; подпись — «когда / после чего».
// Свои пункты и недельные счётчики человек добавляет сам. «Телефон на кухню» держит дедлайн перед отбоем.
const TEMPLATE_ITEMS = [ // по ходу дня; подписи без «встал/лёг» — пол человека неизвестен
  ['glass', 'Стакан воды', 'сразу после подъёма', 'teal', null],
  ['dumbbell', 'Зарядка', `5${NB}минут · после воды`, 'red', null],
  ['notebook', 'План на завтра', `3${NB}главных дела · после ужина`, 'yellow', null],
  ['phone', 'Телефон на кухню', 'будильник заведён — и на кухню', 'indigo', 30],
  ['book', 'Чтение', `10${NB}страниц · в кровати вместо телефона`, 'purple', null],
];
const TEMPLATE_WEEKLY = [];
// Первая настройка предлагает ещё шесть пунктов — того же рода: малые, с «когда / после чего».
const EXTRA_ITEMS = [
  ['heart', 'Растяжка', `5${NB}минут · перед душем`, 'green', null],
  ['globe', 'Английский', `10${NB}минут · после завтрака`, 'blue', null],
  ['leaf', 'Прогулка', `15${NB}минут · на воздухе`, 'mint', null],
  ['pencil', 'Дневник', `3${NB}строки · перед сном`, 'brown', null],
  ['shirt', 'Одежда на завтра', 'с вечера', 'pink', null],
  ['pill', 'Витамины', 'с завтраком', 'orange', null],
];
// Подсказки первой настройки: сначала шаблон (он уже выбран), потом ещё шесть на выбор.
export const SUGGESTIONS = [...TEMPLATE_ITEMS, ...EXTRA_ITEMS].map(([icon, name, note, color, beforeBed]) => ({ icon, name, note, color, beforeBed }));

// since — «в системе с»: у нового телефона — сегодня; сброс к шаблону передаёт прежнюю дату.
// ui.setup — новый телефон начинает с первой настройки (v58).
export function seed(today, id = makeId, since = today) {
  return {
    schema: 1,
    createdAt: today,
    since: isDate(since) ? since : today,
    items: TEMPLATE_ITEMS.map(([icon, name, note, color, beforeBed]) =>
      ({ id: id(), icon, name, note, color, beforeBed, addedAt: today, archivedAt: null })),
    weekly: TEMPLATE_WEEKLY.map(([icon, name, note, color, perWeek]) =>
      ({ id: id(), icon, name, note, color, perWeek, addedAt: today, archivedAt: null })),
    days: {},
    weekMarks: {},
    sleep: { goalBed: '23:30', goalWake: '07:30', targets: [{ from: today, bed: '01:00' }], nights: {} },
    reviews: {},
    sections: [],
    secMarks: {},
    ui: { welcomeSeen: false, news: '', lastExport: '', setup: true },
  };
}

// Обрезка по длине без половинки эмодзи (суррогатной пары) на конце.
const cut = (s, max) => {
  s = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
};

// Поля формы → чистые значения; null, если название пустое.
export function cleanFields(f, weekly) {
  // Одна строка: из поля могли вставить переносы. Неразрывные пробелы («5 минут») остаются.
  const line = v => String(v ?? '').replace(/[\t\n\v\f\r\u2028\u2029]+/g, ' ').trim();
  const name = cut(line(f.name), 60);
  if (!name) return null;
  const out = {
    icon: ICON_IDS.includes(f.icon) ? f.icon : DEFAULT_ICON,
    name,
    note: cut(line(f.note), 120),
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

// ---------- разделы (v58): «Работа», «Хобби» и свои. Отдельно от минимума: план дня, серия, кольца, итоги
// и гонка их не видят, друзьям они не уходят. Отметка — дата в secMarks; пропусков нет — раздел не обязательство.

export const findSection = (s, id) => s.sections.find(x => x.id === id) || null;

export function findSecItem(s, id) {
  for (const section of s.sections) {
    const item = section.items.find(i => i.id === id);
    if (item) return { section, item };
  }
  return null;
}

// Поля раздела → чистые значения; null, если название пустое.
export function cleanSection(f) {
  const c = cleanFields({ name: f?.name, icon: f?.icon, color: f?.color }, false);
  return c && { name: cut(c.name, SECTION_NAME_MAX), icon: c.icon, color: c.color };
}

// Пункт раздела — как пункт минимума, только без привязки к отбою.
function secFields(f) {
  const c = cleanFields(f, false);
  if (!c) return null;
  delete c.beforeBed;
  return c;
}

export function addSection(s, f, today, id = makeId) {
  const c = cleanSection(f);
  if (!c || s.sections.length >= MAX_SECTIONS) return null;
  const sec = { id: id(), ...c, on: true, addedAt: today, items: [] };
  s.sections.push(sec);
  return sec;
}

export function updateSection(s, id, f) {
  const sec = findSection(s, id);
  const c = sec && cleanSection(f);
  if (!c) return false;
  Object.assign(sec, c);
  return true;
}

// Выключенный раздел пропадает с «Сегодня», пункты и отметки остаются.
export function setSectionOn(s, id, on) {
  const sec = findSection(s, id);
  if (!sec) return false;
  sec.on = !!on;
  return true;
}

// Удалить раздел — вместе с пунктами и их отметками (в интерфейсе — через подтверждение).
export function removeSection(s, id) {
  const k = s.sections.findIndex(x => x.id === id);
  if (k < 0) return false;
  for (const it of s.sections[k].items) delete s.secMarks[it.id];
  s.sections.splice(k, 1);
  return true;
}

const swap = (list, k, dir) => {
  const j = k + dir;
  if (k < 0 || j < 0 || j >= list.length) return false;
  [list[k], list[j]] = [list[j], list[k]];
  return true;
};

export const moveSection = (s, id, dir) => swap(s.sections, s.sections.findIndex(x => x.id === id), dir);

export function addSecItem(s, sectionId, f, today, id = makeId) {
  const sec = findSection(s, sectionId);
  const c = sec && secFields(f);
  if (!c || sec.items.length >= MAX_SEC_ITEMS) return null;
  const item = { id: id(), ...c, addedAt: today };
  sec.items.push(item);
  return item;
}

export function updateSecItem(s, id, f) {
  const hit = findSecItem(s, id);
  const c = hit && secFields(f);
  if (!c) return false;
  Object.assign(hit.item, c);
  return true;
}

export function removeSecItem(s, id) {
  const hit = findSecItem(s, id);
  if (!hit) return false;
  hit.section.items.splice(hit.section.items.indexOf(hit.item), 1);
  delete s.secMarks[id];
  return true;
}

export function moveSecItem(s, id, dir) {
  const hit = findSecItem(s, id);
  return !!hit && swap(hit.section.items, hit.section.items.indexOf(hit.item), dir);
}

export const secDone = (s, id, date) => (s.secMarks[id] || []).includes(date);

// Отметка пункта раздела — в те же дни, что у минимума: сегодня и вчера; до появления пункта — нельзя.
export function toggleSecMark(s, id, date, today) {
  const hit = findSecItem(s, id);
  if (!hit || !canEdit(s, date, today) || date < hit.item.addedAt) return false;
  const m = (s.secMarks[id] ||= []);
  const i = m.indexOf(date);
  if (i >= 0) m.splice(i, 1);
  else {
    m.push(date);
    m.sort();
  }
  if (!m.length) delete s.secMarks[id];
  return true;
}

// Пункты раздела, которые уже были в этот день, и сколько из них отмечено.
export function secDay(s, sec, date) {
  const items = sec.items.filter(i => i.addedAt <= date);
  return { items, k: items.filter(i => secDone(s, i.id, date)).length, n: items.length };
}

// Детали пункта раздела: эта неделя, 4 недели, всего и клетки 6 недель (пн–вс) — done | none | off | future.
export function secStats(s, id, today) {
  const hit = findSecItem(s, id);
  if (!hit) return null;
  const marks = new Set((s.secMarks[id] || []).filter(d => d <= today));
  const cur = weekStart(today);
  const count = (a, b) => range(a, b).filter(d => marks.has(d)).length;
  return {
    week: count(cur, today),
    month: count(addDays(today, -27), today),
    total: marks.size,
    cells: range(addDays(cur, -35), addDays(cur, 6)).map(d => ({
      date: d, st: d > today ? 'future' : marks.has(d) ? 'done' : d < hit.item.addedAt ? 'off' : 'none',
    })),
  };
}

// ---------- первая настройка (v58)

// Убрать пункт бесследно — только в первой настройке: у нового телефона ещё нет истории, которую надо беречь.
export function dropItem(s, id) {
  const k = s.items.findIndex(i => i.id === id);
  if (k < 0) return false;
  s.items.splice(k, 1);
  for (const r of Object.values(s.days)) {
    r.plan = r.plan.filter(x => x !== id);
    r.done = r.done.filter(x => x !== id);
  }
  return true;
}

// Первый шаг отбоя — с первой ночи: прошлого, которое он мог бы переписать, ещё нет.
export function setFirstStep(s, bed) {
  if (!isTime(bed)) return false;
  s.sleep.targets = [{ from: s.createdAt, bed }];
  return true;
}

// Настройка закончена. Отметок ещё нет — приложение начинается сегодня: день посева, «в системе с» у нового
// телефона (после «Начать заново» — прежняя дата), пункты, разделы и первый шаг сна; дни самой настройки не в счёт.
export function finishSetup(s, today) {
  const blank = !Object.values(s.days).some(r => r.done.length) && !Object.keys(s.sleep.nights).length &&
    !Object.values(s.weekMarks).some(a => a.length) && !Object.values(s.secMarks).some(a => a.length);
  if (blank) {
    const bed = targetFor(s, addDays(today, 1));
    if (s.since === s.createdAt) s.since = today;
    s.createdAt = today;
    s.days = {};
    for (const it of [...s.items, ...s.weekly]) if (!it.archivedAt) it.addedAt = today;
    for (const sec of s.sections) {
      sec.addedAt = today;
      for (const it of sec.items) it.addedAt = today;
    }
    s.sleep.targets = [{ from: today, bed }];
  }
  s.ui.setup = false;
  s.ui.welcomeSeen = true;
  return blank;
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

// Новый шаг действует с завтрашнего логического дня — то есть с ближайшей ночи (или с from, см. stepFrom).
// Решение заменяет все шаги с from и дальше: последнее слово — за последним решением.
export function setStep(s, bed, today, from = addDays(today, 1)) {
  if (!isTime(bed)) return false;
  const ts = s.sleep.targets.filter(t => t.from < from);
  if (targetFor({ sleep: { targets: ts } }, from) !== bed) ts.push({ from, bed });
  ts.sort((a, b) => (a.from < b.from ? -1 : 1));
  s.sleep.targets = ts;
  return true;
}

// Сколько минут сна от отбоя bed до подъёма wake (не меньше нуля — для странных пар времени).
export const sleepFor = (bed, wake) => Math.max(0, toMin(wake) + 1440 - norm(bed));

// С какой ночи действует новый отбой: с ближайшей, но если этой ночью отбой уже прошёл — новый или прежний
// (tonight), — со следующей. Задним числом ночь не становится ни «позже шага», ни «в цель».
// today — логический день, now — часы.
export function stepFrom(today, bed, now, tonight = bed) {
  const h = now.getHours();
  const night = h >= EVENING_HOUR || h < DAY_START_HOUR;
  const passed = nowNorm(now) >= Math.min(norm(bed), norm(tonight));
  return addDays(today, night && passed ? 2 : 1);
}

// Подъём меняется — часы сна те же: цель отбоя и шаги (с from) сдвигаются на ту же разницу.
// from — с какой ночи сдвигать шаг (stepFrom для нового отбоя); прошлые ночи не трогаем.
// Отбой не позже LATEST_BED: иначе «вечер» перевалил бы за границу дня 04:00.
export function setWake(s, wake, today, from = addDays(today, 1)) {
  if (!isTime(wake)) return false;
  const d = ((((toMin(wake) - toMin(s.sleep.goalWake)) % 1440) + 1440 + 720) % 1440) - 720;
  s.sleep.goalWake = wake;
  if (!d) return true;
  const move = t => {
    const m = shiftTime(t, d);
    return norm(m) > norm(LATEST_BED) ? LATEST_BED : m;
  };
  s.sleep.goalBed = move(s.sleep.goalBed);
  const at = targetFor(s, from);
  const keep = s.sleep.targets.filter(t => t.from < from);
  const later = s.sleep.targets.filter(t => t.from > from).map(t => ({ from: t.from, bed: move(t.bed) }));
  const ts = [...keep, { from, bed: move(at) }, ...later].sort((a, b) => (a.from < b.from ? -1 : 1));
  s.sleep.targets = ts.filter((t, i) => i === 0 || t.bed !== ts[i - 1].bed); // A → B → A не копит лишних шагов
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
  // Итоги закрывают ночью, когда отбой уже прошёл, — новый шаг со следующей ночи (stepFrom).
  setStep(s, opt.to, today, stepFrom(today, opt.to, new Date(nowISO), stepTonight(s, today)));
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
// id — ключ в обычных объектах (weekMarks, secMarks): «constructor», «__proto__» и прочие имена Object.prototype
// подменили бы массив отметок функцией и уронили бы экран — такие id (из файла или чужого снимка) отбрасываем.
const badId = id => typeof id !== 'string' || !id || id in Object.prototype;

function normItem(v, weekly, createdAt) {
  if (!v || typeof v !== 'object' || badId(v.id)) return null;
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
    if (Array.isArray(a) && !badId(id)) weekMarks[id] = uniq(a.filter(isDate)).sort();
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
  // Разделы: id не повторяют id пунктов и друг друга; отметки — только у известных пунктов разделов.
  const sections = [];
  for (const v of Array.isArray(raw.sections) ? raw.sections : []) {
    if (sections.length >= MAX_SECTIONS) break;
    if (!isObj(v) || badId(v.id) || seen.has(v.id)) continue;
    const c = cleanSection(v);
    if (!c) continue;
    seen.add(v.id);
    const items = [];
    for (const x of Array.isArray(v.items) ? v.items : []) {
      if (items.length >= MAX_SEC_ITEMS) break;
      if (!isObj(x) || badId(x.id) || seen.has(x.id)) continue;
      const f = secFields(x);
      if (!f) continue;
      seen.add(x.id);
      items.push({ id: x.id, ...f, addedAt: isDate(x.addedAt) ? x.addedAt : createdAt });
    }
    sections.push({ id: v.id, ...c, on: v.on !== false, addedAt: isDate(v.addedAt) ? v.addedAt : createdAt, items });
  }
  const known = new Set(sections.flatMap(x => x.items.map(i => i.id)));
  const secMarks = {};
  for (const [id, a] of Object.entries(isObj(raw.secMarks) ? raw.secMarks : {})) {
    if (!known.has(id) || !Array.isArray(a)) continue;
    const m = uniq(a.filter(isDate)).sort();
    if (m.length) secMarks[id] = m;
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
    sections,
    secMarks,
    ui: {
      welcomeSeen: raw.ui?.welcomeSeen === true,
      news: str(raw.ui?.news, 16),
      lastExport: isDate(raw.ui?.lastExport) ? raw.ui.lastExport : '',
      setup: raw.ui?.setup === true,
    },
  };
}

export const migrate = normalize;
