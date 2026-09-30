// Минимум v2 — интерфейс. Пользовательский текст попадает в разметку только текстовыми узлами.

import * as D from './domain.js';
import { ICONS, ICON_GROUPS, UI as G } from './icons.js';
import { createStore, requestPersist, shareOrDownload, parseImport } from './store.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WDL = ['П', 'В', 'С', 'Ч', 'П', 'С', 'В'];
const NB = '\u00a0'; // число с единицей и «до» со временем не разрываются переносом
const HINTS = [
  'Поел после школы → телефон на кухню → лежка',
  'Книга в кровать вместо телефона',
  'Карнеги: 1 приём в день на живом человеке',
];
const RULES = [
  'Минимум — пол, а не план. Одинаков каждый день.',
  'Не пропускай дважды.',
  'Среда сильнее силы воли: телефон — на кухне, учёба — за обеденным столом, кровать — для сна.',
  'Одно улучшение в неделю — 1%.',
  'План дня — в Напоминаниях, не здесь.',
  'Сон — главное: отбой шагами к 23:30, подъём 7:30.',
];
const CHOICE = { earlier30: 'Раньше на 30 минут', earlier15: 'Раньше на 15 минут', keep: 'Оставить', later15: 'Позже на 15 минут' };
const TABS = [['today', 'Сегодня', G.tabToday], ['progress', 'Прогресс', G.tabProgress], ['settings', 'Настройки', G.tabSettings]];
const WELCOME = `8${NB}пунктов, одинаковых каждый день. Отбой — шагами от 01:00 к${NB}23:30, решаешь на итогах недели. Старые данные стёрты.`;
const BEFORE = [15, 30, 45, 60];
const EVENING_HOUR = 18;
const UPDATE_EVERY = 10 * 60e3;

const dm = iso => `${+iso.slice(8)}${NB}${MONTHS[+iso.slice(5, 7) - 1]}`;
const weekRange = mon => {
  const sun = D.addDays(mon, 6);
  return mon.slice(5, 7) === sun.slice(5, 7) ? `${+mon.slice(8)}–${dm(sun)}` : `${dm(mon)} — ${dm(sun)}`;
};
const dur = m => {
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}${NB}ч ${r}${NB}мин` : `${h}${NB}ч`) : `${r}${NB}мин`;
};
const plural = (n, [one, few, many]) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
const clock = t => t.replace(/^0(?=\d:)/, ''); // 07:30 → 7:30
const tint = c => `--item:var(--c-${c});--bar:var(--b-${c})`;
// Название пункта внутри фразы: «Телефон на кухню» → «телефон на кухню», но «ЕГЭ» и «iPhone» не трогаем.
const lcFirst = s => (/^\p{Lu}\p{Ll}/u.test(s) ? s[0].toLocaleLowerCase('ru') + s.slice(1) : s);

export async function boot({ win = window, now = () => new Date(), idb = win.indexedDB } = {}) {
  const doc = win.document;
  const root = doc.getElementById('app');
  const ui = {
    tab: 'today', sheet: null, alert: null, fresh: false, alertFresh: false,
    yOpen: false, sleepOpen: false, edit: false, revOpen: new Set(),
    dataMsg: '', updMsg: '', toast: '', celebrate: false, pop: '',
    saveFailed: false, restored: false, update: false, version: '',
  };
  let S, today, reg = null, reloading = false, lastCheck = Date.now(), dayTimer, toastTimer, pendingTime = null;

  let ls;
  try {
    ls = win.localStorage;
  } catch {}
  const store = createStore({ ls, idb, today: () => D.logicalDate(now()), onSaveError: () => (ui.saveFailed = true) });
  const loaded = await store.load();
  S = loaded.state;
  ui.restored = loaded.restored;
  requestPersist(win.navigator);

  // ---------- разметка

  const h = (tag, attrs, ...kids) => {
    const el = doc.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat(9).filter(c => c != null && c !== false && c !== ''));
    return el;
  };
  const svg = (tag, attrs, ...kids) => {
    const el = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    el.append(...kids.flat(9).filter(Boolean));
    return el;
  };
  const gl = (d, cls = '') => svg('svg', { class: 'gl ' + cls, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d }));
  const icon = id => gl((ICONS[id] || ICONS.star)[1]);
  const tile = (id, color) => h('span', { class: 'tile', style: color ? tint(color) : null }, icon(id));
  const chev = open => gl(G.chevron, 'chev' + (open ? ' open' : ''));
  const txt = (name, note, strong) => h('span', { class: 'txt' },
    h('span', { class: 'name' + (strong ? ' strong' : '') }, name), note && h('span', { class: 'note' }, note));
  const secH = (title, action) => h('h2', { class: 'sec-h' }, h('span', {}, title), action);
  const pressed = on => String(!!on);

  // Градиенты колец и столбиков сна — один раз на документ.
  const grad = (id, x2, y2, stops) => svg('linearGradient', { id, x1: 0, y1: 0, x2, y2 },
    stops.map(([cls, offset]) => svg('stop', { class: cls, offset })));
  const defs = () => svg('svg', { class: 'defs', 'aria-hidden': 'true', focusable: 'false' }, svg('defs', {},
    grad('g-sun', 1, 1, [['s-sun-1', 0], ['s-sun-2', 0.5], ['s-sun-3', 1]]),
    grad('g-sleep', 1, 1, [['s-sleep-1', 0], ['s-sleep-2', 1]]),
    grad('g-train', 1, 1, [['s-train-1', 0], ['s-train-2', 1]]),
    grad('g-bar', 0, 1, [['s-sleep-1', 0], ['s-sleep-2', 1]])));

  // Кольца: parts — [{ kind: 'sun' | 'sleep' | 'train', f: 0…1 }] снаружи внутрь.
  function rings(cls, size, radii, width, parts, label) {
    const c = size / 2;
    return svg('svg', { class: cls, viewBox: `0 0 ${size} ${size}`, role: label ? 'img' : null, 'aria-label': label, 'aria-hidden': label ? null : 'true' },
      parts.map((p, i) => {
        const r = radii[i], len = 2 * Math.PI * r, f = Math.max(0, Math.min(1, p.f || 0));
        return [
          svg('circle', { class: 'tr-' + p.kind, cx: c, cy: c, r, 'stroke-width': width }),
          f > 0 && svg('circle', {
            class: 'arc arc-' + p.kind, cx: c, cy: c, r, 'stroke-width': width,
            'stroke-dasharray': `${(len * f).toFixed(2)} ${len.toFixed(2)}`, transform: `rotate(-90 ${c} ${c})`,
          }),
        ];
      }));
  }
  const miniRings = (r, w, day) => rings('mini', 44, [18.5, 12.5, 6.5], 5, [
    { kind: 'sun', f: r.min }, { kind: 'sleep', f: r.sleep ? 1 : 0 }, w && { kind: 'train', f: r.week ? 1 : 0 },
  ].filter(Boolean), r.min == null ? `${day}: нет данных` : [
    `${day}: минимум ${Math.round(r.min * 100)}%`, r.sleep == null ? 'сон не отмечен' : r.sleep ? 'сон в цель' : 'сон позже шага',
    w && (r.week ? `${lcFirst(w.name)} — да` : `${lcFirst(w.name)} — нет`),
  ].filter(Boolean).join(', '));

  const save = () => store.save(S);
  const commit = () => {
    save();
    render();
  };
  // Экран мог устареть на границе дня, пока приложение спало: сначала перерисовать.
  const stale = () => D.logicalDate(now()) !== today && (render(), true);

  function toast(msg) {
    ui.toast = msg;
    win.clearTimeout(toastTimer);
    // Убираем полосу без перерисовки: не сбивать фокус, если владелец уже печатает в листе.
    toastTimer = win.setTimeout(() => {
      ui.toast = '';
      root.querySelector('.bar-toast')?.remove();
    }, 2200);
  }

  // Родной барабан времени: пока он открыт, экран не перерисовываем — iOS закрыл бы его на полпути.
  function timeInput(cls, value, label, pick) {
    return h('input', {
      type: 'time', class: cls, value: value || '', 'aria-label': label,
      onclick: e => { try { e.target.showPicker?.(); } catch {} },
      onchange: e => {
        const v = e.target.value;
        if (!D.isTime(v)) {
          if (pendingTime?.el === e.target) pendingTime = null; // барабан сбросили — прежний выбор не применяем
          return;
        }
        if (doc.activeElement === e.target) pendingTime = { el: e.target, run: () => pick(v) };
        else pick(v);
      },
      onblur: e => {
        if (pendingTime?.el !== e.target) return;
        const { run } = pendingTime;
        pendingTime = null;
        run();
      },
    });
  }

  // Выбор из барабана, ждущий закрытия, применяется до любой перерисовки — иначе он потерялся бы вместе с полем.
  function flushTime() {
    if (!pendingTime) return;
    const { run } = pendingTime;
    pendingTime = null;
    run();
  }

  function render() {
    flushTime();
    const day = D.logicalDate(now());
    if (today && day !== today) Object.assign(ui, { sleepOpen: false, yOpen: false });
    today = day;
    if (D.syncToday(S, today)) save();
    const panel = root.querySelector('.sheet-panel');
    const keep = panel && !ui.fresh ? panel.scrollTop : 0;
    const screen = ui.tab === 'today' ? todayScreen() : ui.tab === 'progress' ? progressScreen() : settingsScreen();
    root.replaceChildren(
      defs(),
      h('main', { class: 'screen' + (ui.celebrate ? ' celebrate' : ''), 'aria-hidden': ui.sheet || ui.alert ? 'true' : null }, screen),
      h('div', { class: 'bars' },
        ui.saveFailed && h('div', { class: 'bar bar-warn', role: 'alert' }, 'Не удалось сохранить — сделай экспорт в Настройках'),
        ui.update && h('button', { class: 'bar bar-update', onclick: applyUpdate }, 'Доступна новая версия · ', h('b', {}, 'Обновить')),
        ui.toast && h('div', { class: 'bar bar-toast', role: 'status' }, ui.toast)),
      h('nav', { class: 'tabbar', 'aria-label': 'Разделы', 'aria-hidden': ui.sheet || ui.alert ? 'true' : null }, TABS.map(([id, label, d]) =>
        h('button', { class: 'tab', 'aria-current': ui.tab === id ? 'page' : null, onclick: () => openTab(id) }, gl(d), h('span', {}, label)))),
      ...[ui.sheet && sheetView(), ui.alert && alertView()].filter(Boolean), // null в replaceChildren стал бы текстом «null»
    );
    const np = root.querySelector('.sheet-panel');
    if (np) np.scrollTop = keep;
    root.querySelectorAll('textarea.area').forEach(autosize);
    // Открытый лист или подтверждение получает фокус — VoiceOver читает его первым.
    if (ui.alertFresh) root.querySelector('.alert-box')?.focus({ preventScroll: true });
    else if (ui.fresh) root.querySelector('.sheet-panel')?.focus({ preventScroll: true });
    doc.body.classList.toggle('locked', !!(ui.sheet || ui.alert));
    ui.fresh = ui.alertFresh = ui.celebrate = false;
    ui.pop = '';
    win.clearTimeout(dayTimer);
    dayTimer = win.setTimeout(render, D.msToNextDay(now()) + 1000);
  }

  function autosize(el) {
    el.style.height = 'auto';
    if (el.scrollHeight) el.style.height = el.scrollHeight + 'px';
  }

  function openTab(id) {
    Object.assign(ui, { tab: id, alert: null, edit: false, sleepOpen: false, dataMsg: '', updMsg: '' });
    render();
    doc.documentElement.scrollTop = 0;
  }

  function showAlert(a) {
    ui.alert = a;
    ui.alertFresh = true;
    render();
  }

  // ---------- Сегодня

  function itemRow(it, isDone, onTap, extra, key) {
    return h('button', {
      class: 'row' + (isDone ? ' done' : '') + (ui.pop === key ? ' pop' : ''), style: tint(it.color), 'aria-pressed': pressed(isDone), onclick: onTap,
    }, tile(it.icon), txt(it.name, [it.note, extra].filter(Boolean).join(' · ')), h('span', { class: 'check' }, gl(G.check)));
  }

  function toggle(date, id) {
    if (stale()) return;
    const was = D.status(S, today, today) === 'closed';
    if (!D.toggleDone(S, date, id, today)) return;
    const on = D.doneOf(S, date).includes(id);
    ui.pop = on ? `${date}:${id}` : '';
    ui.celebrate = date === today && !was && D.status(S, today, today) === 'closed';
    commit();
  }

  function sleepCardShown() {
    const n = S.sleep.nights[today] || {};
    const hr = now().getHours();
    return ui.sleepOpen || (!(n.bed && n.wake) && hr >= D.DAY_START_HOUR && hr < EVENING_HOUR);
  }

  function todayScreen() {
    const { streak } = D.history(S, today);
    const { plan, k, n } = D.progress(S, today, today);
    const done = D.doneOf(S, today);
    const closed = n > 0 && k === n;
    const y = D.addDays(today, -1);
    const step = D.stepTonight(S, today);
    const improvement = D.weekImprovement(S, today);
    const rv = D.pendingReview(S, today);
    const weekly = S.weekly.filter(i => !i.archivedAt);
    const card = sleepCardShown();
    const stack = [
      rv && h('section', { class: 'group banner' }, h('button', { class: 'row', onclick: () => openReview(rv.monday) },
        tile('checklist', 'pink'),
        rv.kind === 'sunday' ? txt('Итоги недели', `10${NB}минут · шаг сна и 1% на неделю`, true) : txt('Итоги прошлой недели', `не закрыты · 10${NB}минут`, true),
        chev())),
      yesterdayCard(y),
    ].filter(Boolean);
    return [
      h('header', { class: 'head' },
        h('div', { class: 'head-top' },
          h('p', { class: 'overline' }, `${WEEKDAYS[D.weekday(today)]}, ${dm(today)}`),
          h('span', { class: 'streak', role: 'img', 'aria-label': `Серия ${streak}` }, gl(G.flame), h('span', { 'aria-hidden': 'true' }, streak))),
        h('h1', { class: 'title' }, 'Сегодня')),
      ui.restored && h('p', { class: 'group notice-card' }, 'Данные восстановлены из резервной копии'),
      !S.ui.welcomeSeen && h('section', { class: 'group card-pad welcome' },
        h('div', { class: 'welcome-head' }, tile('sparkles', 'pink'), h('p', { class: 'name strong' }, 'Новый минимум')),
        h('p', {}, WELCOME),
        h('button', { class: 'btn-text', onclick: () => { S.ui.welcomeSeen = true; commit(); } }, 'Понятно')),
      hero({ plan, done, k, n, closed, step, card }),
      D.status(S, y, today) === 'miss' && !closed && h('p', { class: 'notice-line' }, 'Вчера пропуск — сегодня не пропускай дважды'),
      card && sleepCard(),
      stack.length > 0 && h('div', { class: 'stack' }, stack),
      secH('Минимум'),
      n > 0
        ? h('section', { class: 'group list-min' }, plan.map(id => {
          const it = D.findItem(S, id);
          const extra = it.beforeBed ? `до${NB}${D.deadline(step, it.beforeBed)}` : '';
          return itemRow(it, done.includes(id), () => toggle(today, id), extra, `${today}:${id}`);
        }))
        : h('p', { class: 'group empty' }, 'Минимум пуст — добавь пункты в Настройках'),
      weekly.length > 0 && [secH('На неделе'), h('section', { class: 'group list-week' }, weekly.map(weekRow))],
      improvement && h('section', { class: 'group onepct' }, h('div', { class: 'row' }, tile('sparkles', 'yellow'),
        h('span', { class: 'txt' }, h('span', { class: 'note' }, '1% недели'), h('span', { class: 'name' }, improvement)))),
    ];
  }

  function hero({ plan, done, k, n, closed, step, card }) {
    const goal = S.sleep.goalBed, wake = clock(S.sleep.goalWake);
    const atGoal = D.norm(step) <= D.norm(goal);
    const mon = D.weekStart(today);
    const sh = D.sleepHits(S, D.knownMornings(S, mon, D.addDays(mon, 6), today));
    const w = D.firstWeekly(S);
    const wc = w ? D.weekCount(S, w.id, today) : 0;
    const phone = D.activeItems(S).find(i => i.beforeBed);
    const night = S.sleep.nights[today] || {};
    const full = night.bed && night.wake;
    let last = null;
    if (!card) {
      if (full) {
        const late = D.norm(night.bed) - D.norm(D.targetFor(S, today));
        const d = D.duration(night);
        last = h('span', { class: 'sl2' }, `прошлая ночь ${d ? dur(d) : '—'} · `,
          late > 0 ? `на${NB}${dur(late)} позже шага` : h('span', { class: 'ok' }, 'в цель'));
      } else last = h('span', { class: 'sl2 warn' }, night.bed || night.wake ? 'прошлая ночь отмечена не полностью' : 'прошлая ночь не отмечена');
    }
    const label = [`Минимум ${k} из ${n}`, sh.n ? `сон ${sh.k} из ${sh.n} в цель` : 'сон — нет данных',
      w && `${w.name} ${wc} из ${w.perWeek}`].filter(Boolean).join(', ');
    return h('section', { class: 'hero' },
      h('div', { class: 'hero-top' },
        rings('rings', 132, [57, 41, 25], 13, [
          { kind: 'sun', f: n ? k / n : 0 }, { kind: 'sleep', f: sh.n ? sh.k / sh.n : 0 }, w && { kind: 'train', f: wc / w.perWeek },
        ].filter(Boolean), label),
        h('div', { class: 'hero-info' },
          h('div', {},
            h('p', { class: 'count' }, n ? `${k} из ${n}` : '—'),
            h('p', { class: 'count-sub' + (closed ? ' closed' : '') }, closed ? 'День закрыт' : n ? `минимум · осталось ${n - k}` : 'минимум пуст')),
          h('div', { class: 'legend' },
            h('p', { class: 'lg' }, h('span', { class: 'lg-dot' }), h('span', { class: 'lg-label' }, 'Сон'),
              h('span', { class: 'lg-val' }, sh.n ? `${sh.k}/${sh.n} в${NB}цель` : 'нет данных')),
            w && h('p', { class: 'lg' }, h('span', { class: 'lg-dot train' }), h('span', { class: 'lg-label' }, w.name),
              h('span', { class: 'lg-val' }, `${wc}/${w.perWeek}`))))),
      n > 0 && h('div', { class: 'segs', 'aria-hidden': 'true' }, plan.map((id, i) =>
        h('span', { class: 'seg' + (done.includes(id) ? ' on' : ''), style: `--i:${i};--n:${plan.length}` }))),
      h('div', { class: 'hero-line' }),
      h('button', { class: 'sleep-btn', onclick: () => { if (!stale()) { ui.sleepOpen = true; render(); } } },
        gl(ICONS.moon[1]),
        h('span', { class: 'sl' },
          h('span', { class: 'sl1' }, h('b', {}, `Отбой ${step}`), h('span', { class: 't2' }, atGoal ? ' · цель достигнута' : ` · цель ${goal}`)),
          h('span', { class: 'sl2' }, [phone && `${lcFirst(phone.name)} до${NB}${D.deadline(step, phone.beforeBed)}`, `подъём ${wake}`].filter(Boolean).join(' · ')),
          last)));
  }

  function weekRow(it) {
    const c = D.weekCount(S, it.id, today);
    const mine = (S.weekMarks[it.id] || []).includes(today);
    return h('button', {
      class: 'row', style: tint(it.color), 'aria-pressed': pressed(mine),
      onclick: () => { if (!stale()) { D.toggleWeekMark(S, it.id, today); commit(); } },
    }, tile(it.icon), txt(it.name, it.note),
    h('span', { class: 'wk' },
      h('span', { class: 'wk-label' + (mine ? ' today' : '') }, mine ? `✓ ${c} из ${it.perWeek}` : `${c} из ${it.perWeek}`),
      h('span', { class: 'pills', 'aria-hidden': 'true' }, Array.from({ length: Math.min(7, Math.max(it.perWeek, c)) }, (_, i) =>
        h('span', { class: 'pill' + (i < c ? ' on' : '') })))));
  }

  function sleepCard() {
    const n = S.sleep.nights[today] || {};
    const full = !!(n.bed && n.wake);
    return [
      secH('Прошлая ночь', full && h('button', { class: 'link', onclick: () => { ui.sleepOpen = false; render(); } }, 'Готово')),
      h('section', { class: 'group sleep-card', 'aria-label': 'Прошлая ночь' }, nightEditor(today, true)),
    ];
  }

  function nightEditor(date, isToday) {
    const n = S.sleep.nights[date] || {};
    const step = D.targetFor(S, date), wake = S.sleep.goalWake;
    const set = (field, v) => {
      if (stale()) return;
      D.setNight(S, date, field, v);
      if (isToday) ui.sleepOpen = true; // карточка остаётся до ухода с экрана — видно итог
      commit();
    };
    const d = D.duration(n);
    const late = n.bed ? D.norm(n.bed) - D.norm(step) : 0;
    return [
      h('div', { class: 'sc-head' }, h('span', { class: 'sc-label' }, 'Лёг'), h('span', { class: 'sc-hint' }, `шаг отбоя ${step}`)),
      chipRow('Лёг', [-60, -30, 0, 30, 60, 90, 120].map(x => D.shiftTime(step, x)), n.bed, step, v => set('bed', v), t => t),
      h('div', { class: 'sc-sep' }),
      h('div', { class: 'sc-head' }, h('span', { class: 'sc-label' }, 'Встал'), h('span', { class: 'sc-hint' }, `цель ${clock(wake)}`)),
      chipRow('Встал', [-60, -30, 0, 30, 60, 90].map(x => D.shiftTime(wake, x)), n.wake, wake, v => set('wake', v), clock),
      n.bed && n.wake && h('p', { class: 'strip' }, gl(ICONS.moon[1]), h('span', {}, h('b', {}, `Сон ${d ? dur(d) : '—'}`),
        h('span', { class: 't2' }, late > 0 ? ` · на${NB}${dur(late)} позже шага` : ' · в цель'))),
    ];
  }

  function chipRow(label, values, current, mark, pick, fmt) {
    const other = current && !values.includes(current);
    return h('div', { class: 'chips', role: 'group', 'aria-label': label },
      values.map(v => h('button', {
        class: 'chip' + (v === mark ? ' mark' : ''), 'aria-pressed': pressed(v === current),
        onclick: () => pick(v === current ? null : v),
      }, fmt(v))),
      // Родной выбор времени лежит прозрачным поверх чипа: iOS открывает его только от прямого касания.
      h('label', { class: 'chip chip-other' + (other ? ' on' : '') }, other ? fmt(current) : 'Другое',
        timeInput('chip-input', current, `${label}: другое время`, pick)));
  }

  function yesterdayCard(y) {
    if (y < S.createdAt) return null;
    const { plan, k, n } = D.progress(S, y, today);
    if (!n || k === n) return null;
    const done = D.doneOf(S, y);
    return h('section', { class: 'group yesterday' },
      h('button', { class: 'row', 'aria-expanded': pressed(ui.yOpen), onclick: () => { ui.yOpen = !ui.yOpen; render(); } },
        tile('clock', 'gray'), txt(`Вчера: ${k} из ${n}`, `доотметить можно до${NB}${D.DAY_START_HOUR}:00`), chev(ui.yOpen)),
      ui.yOpen && plan.map(id => D.findItem(S, id)).filter(Boolean).map(it =>
        itemRow(it, done.includes(it.id), () => toggle(y, it.id), '', `${y}:${it.id}`)));
  }

  // ---------- листы

  function sheetView() {
    const sh = ui.sheet;
    const close = () => { ui.sheet = null; render(); };
    let title, right = null, body;
    if (sh.kind === 'review') {
      title = 'Итоги недели';
      body = reviewSheet(sh);
    } else if (sh.kind === 'rules') {
      title = 'Правила';
      right = h('button', { class: 'sheet-act right', onclick: close }, 'Готово');
      body = rulesSheet();
    } else {
      title = sh.id ? (sh.weekly ? 'Счётчик' : 'Пункт') : sh.weekly ? 'Новый счётчик' : 'Новый пункт';
      right = h('button', { class: 'sheet-act right', id: 'sheet-done', disabled: !sh.draft.name.trim(), onclick: () => saveItem(sh) }, 'Готово');
      body = itemSheet(sh);
    }
    return h('div', { class: 'sheet' + (ui.fresh ? ' enter' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-back', onclick: close }),
      h('div', { class: 'sheet-panel', tabindex: '-1' },
        h('div', { class: 'grabber', 'aria-hidden': 'true' }),
        h('header', { class: 'sheet-head' },
          sh.kind === 'rules' ? h('span') : h('button', { class: 'sheet-act', onclick: close }, 'Отмена'),
          h('h2', { class: 'sheet-title' }, title),
          right || h('span')),
        body));
  }

  function openReview(monday) {
    ui.sheet = { kind: 'review', monday, choice: null, draft: { good: '', bad: '', learned: '', notesDone: false, improvement: '' } };
    ui.fresh = true;
    render();
  }

  function reviewSheet(sh) {
    const W = sh.monday, dr = sh.draft;
    const sum = D.weekSummary(S, W, today), p = D.proposal(S, W, today);
    if (!p.options.some(o => o.choice === sh.choice)) sh.choice = null; // ночи дозаполнили — кнопки могли смениться
    const opt = p.options.find(o => o.choice === sh.choice);
    const phone = D.activeItems(S).find(i => i.beforeBed);
    const w = D.firstWeekly(S);
    const wc = w ? D.weekCount(S, w.id, W) : 0;
    const area = (label, key) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
      h('textarea', { class: 'area', rows: 1, value: dr[key], placeholder: 'одной-двумя фразами', oninput: e => { dr[key] = e.target.value; autosize(e.target); } }));
    const headLine = [
      h('b', {}, `В цель ${sum.K} из ${sum.mornings.length}`),
      sum.avgBed && h('span', { class: 't2' }, ` · отбой в среднем ${sum.avgBed}`),
      sum.avgDur && h('span', { class: 't2' }, ` · сон ${dur(sum.avgDur)}`),
    ];
    const optSub = o => o.choice === 'keep'
      ? `отбой ${o.to} ещё на неделю`
      : `отбой ${o.to}` + (phone ? ` · ${lcFirst(phone.name)} до${NB}${D.deadline(o.to, phone.beforeBed)}` : '');
    const footer = opt
      ? opt.to === p.from
        ? `Отбой остаётся ${p.from}.`
        : `Со следующей ночи отбой ${opt.to}.` + (phone ? ` Передвинь сигнал «${phone.name}» на${NB}${D.deadline(opt.to, phone.beforeBed)}.` : '')
      : p.fewData ? 'Мало данных — шаг пока оставляем: выбери «Оставить», чтобы закрыть неделю.' : `Выбор нужен, чтобы закрыть неделю. Цель — ${S.sleep.goalBed}.`;
    return [
      h('p', { class: 'sheet-sub' }, weekRange(W)),
      h('section', { class: 'group rv-card first' },
        h('div', { class: 'week-rings' }, sum.days.map((d, i) => h('div', { class: 'wr-day' },
          h('span', { class: 'wr-label', 'aria-hidden': 'true' }, WDL[i]), miniRings(D.dayRings(S, d, today), w, WEEKDAYS[i])))),
        h('div', { class: 'sc-sep' }),
        h('div', { class: 'stats' },
          h('p', { class: 'stat' }, h('b', {}, `${sum.closed} из ${sum.total}`), h('span', {}, 'дней закрыто')),
          h('p', { class: 'stat' }, h('b', {}, String(D.history(S, today).streak)), h('span', {}, 'серия')),
          w && h('p', { class: 'stat' }, h('b', {}, `${wc} из ${w.perWeek}`), h('span', {}, lcFirst(w.name))))),
      sum.missingNights.length > 0 && [
        secH('Ночи по памяти'),
        h('div', { class: 'stack stack-tight' }, sum.missingNights.map(d => h('section', { class: 'group sleep-card' },
          h('p', { class: 'night-date' }, `${WD[D.weekday(d)]}, ${dm(d)}`), nightEditor(d, false)))),
      ],
      secH('Сон · шаг отбоя'),
      h('section', { class: 'group' },
        h('p', { class: 'rv-line' }, p.atGoal ? [h('b', {}, `Цель достигнута, держим ${S.sleep.goalBed}`), h('span', { class: 't2' }, ` · в цель ${sum.K} из ${sum.mornings.length}`)] : headLine),
        p.options.map(o => h('button', {
          class: 'opt' + (o.choice === p.recommended ? ' rec' : ''), 'aria-pressed': pressed(o.choice === sh.choice),
          onclick: () => { sh.choice = o.choice; render(); },
        }, h('span', { class: 'txt' },
          h('span', { class: 'opt-title' }, h('span', {}, CHOICE[o.choice]), o.choice === p.recommended && h('span', { class: 'rec-pill' }, 'рекомендовано')),
          h('span', { class: 'note' }, optSub(o))),
        o.choice === sh.choice && gl(G.tick, 'tick')))),
      h('p', { class: 'sec-foot' }, footer),
      secH('Разбор'),
      h('section', { class: 'group' }, area('Что получилось?', 'good'), area('Что не получилось?', 'bad'), area('Чему научился?', 'learned')),
      h('section', { class: 'group group-gap' }, h('button', {
        class: 'switch-row', role: 'switch', 'aria-checked': pressed(dr.notesDone),
        onclick: () => { dr.notesDone = !dr.notesDone; render(); },
      }, txt('Notes разобраны', 'каждой строке — одно действие в Напоминания или вычеркнуть'), h('span', { class: 'switch', 'aria-hidden': 'true' }))),
      secH('1% на следующую неделю'),
      h('section', { class: 'group pct-card' },
        h('input', {
          class: 'one-input', value: dr.improvement, maxlength: 500, placeholder: 'Одно маленькое улучшение',
          'aria-label': '1% на следующую неделю', oninput: e => (dr.improvement = e.target.value),
        }),
        h('div', { class: 'chips' }, HINTS.map(t => h('button', {
          class: 'chip chip-hint', 'aria-pressed': pressed(dr.improvement === t), onclick: () => { dr.improvement = t; render(); },
        }, t)))),
      h('button', {
        class: 'btn-primary', disabled: !opt,
        onclick: () => {
          if (stale() || !D.closeWeek(S, W, dr, sh.choice, today, now().toISOString())) return;
          ui.sheet = null;
          toast('Неделя закрыта');
          commit();
        },
      }, 'Закрыть неделю'),
    ];
  }

  function rulesSheet() {
    return h('section', { class: 'group rules-list first' }, RULES.map((r, i) =>
      h('div', { class: 'row' }, h('span', { class: 'rule-n' }, String(i + 1)), h('span', { class: 'txt' }, h('span', { class: 'name' }, r)))));
  }

  function openItem(id, weekly) {
    const it = id && D.findItem(S, id);
    const draft = it
      ? { icon: it.icon, name: it.name, note: it.note, color: it.color, beforeBed: it.beforeBed ?? null, perWeek: it.perWeek ?? 3 }
      : { icon: 'star', name: '', note: '', color: D.DEFAULT_COLOR, beforeBed: null, perWeek: 3 };
    ui.sheet = { kind: 'item', id, weekly, draft };
    ui.fresh = true;
    render();
  }

  function itemSheet(sh) {
    const d = sh.draft;
    const set = (k, v) => { d[k] = v; render(); };
    const step = D.stepTonight(S, today);
    const placeholder = sh.weekly ? 'Новый счётчик' : 'Новый пункт';
    const onText = (k, sel, fallback) => e => {
      d[k] = e.target.value;
      // Без перерисовки: поле не теряет фокус, меняются только превью и «Готово».
      const pv = root.querySelector(sel);
      if (pv) pv.textContent = d[k].trim() || fallback;
      const done = root.querySelector('#sheet-done');
      if (done) done.disabled = !d.name.trim();
    };
    const mins = [...new Set([...BEFORE, ...(d.beforeBed != null ? [+d.beforeBed] : [])])].sort((a, b) => a - b);
    return [
      h('div', { class: 'preview', style: tint(d.color) },
        h('span', { class: 'tile' }, icon(d.icon)),
        h('p', { class: 'pv-name' }, d.name.trim() || placeholder),
        h('p', { class: 'pv-note' }, d.note.trim() || 'когда / после чего')),
      h('section', { class: 'group group-gap-l' },
        h('label', { class: 'form-row' }, h('span', { class: 'form-label' }, 'Название'),
          h('input', { class: 'form-input', name: 'name', value: d.name, maxlength: 60, placeholder: 'например, Растяжка', oninput: onText('name', '.pv-name', placeholder) })),
        h('label', { class: 'form-row' }, h('span', { class: 'form-label' }, 'Подпись'),
          h('input', { class: 'form-input', name: 'note', value: d.note, maxlength: 120, placeholder: 'когда / после чего', oninput: onText('note', '.pv-note', 'когда / после чего') }))),
      secH('Цвет'),
      h('section', { class: 'group swatches', role: 'group', 'aria-label': 'Цвет' }, D.COLORS.map(c => h('button', {
        class: 'swatch', style: tint(c), 'aria-label': COLOR_NAMES[c], 'aria-pressed': pressed(d.color === c), onclick: () => set('color', c),
      }))),
      secH(`Значок · ${ICON_GROUPS.reduce((a, g) => a + g[1].length, 0)}`),
      h('section', { class: 'group icons', style: tint(d.color) }, ICON_GROUPS.map(([name, ids]) => [
        h('p', { class: 'ig-title' }, name),
        h('div', { class: 'ig-row', role: 'group', 'aria-label': name }, ids.map(id => h('button', {
          class: 'ig-btn', 'aria-label': ICONS[id][0], 'aria-pressed': pressed(d.icon === id), onclick: () => set('icon', id),
        }, icon(id)))),
      ])),
      sh.weekly
        ? [secH('Раз в неделю'), h('section', { class: 'group sub-block sub-first' }, h('div', { class: 'chips' }, [1, 2, 3, 4, 5, 6, 7].map(n =>
          h('button', { class: 'chip', 'aria-pressed': pressed(+d.perWeek === n), onclick: () => set('perWeek', n) }, String(n)))))]
        : h('section', { class: 'group group-gap-l' },
          h('button', {
            class: 'switch-row', role: 'switch', 'aria-checked': pressed(d.beforeBed != null),
            onclick: () => set('beforeBed', d.beforeBed != null ? null : 30),
          }, txt('Привязать к отбою', d.beforeBed != null
            ? `подпись дополнится временем: «до${NB}${D.deadline(step, +d.beforeBed)}»`
            : 'для пунктов вроде «Телефон на кухню»'), h('span', { class: 'switch', 'aria-hidden': 'true' })),
          d.beforeBed != null && h('div', { class: 'sub-block' },
            h('span', { class: 'field-label' }, 'За сколько до отбоя'),
            h('div', { class: 'chips' }, mins.map(m => h('button', {
              class: 'chip', 'aria-pressed': pressed(+d.beforeBed === m), onclick: () => set('beforeBed', m),
            }, m === 60 ? `1${NB}ч` : m % 60 === 0 ? `${m / 60}${NB}ч` : `${m}${NB}мин`))))),
      sh.id && h('section', { class: 'group group-gap-l' }, h('button', { class: 'row row-t row-danger', onclick: () => removeItem(sh) },
        sh.weekly ? 'Убрать из недельных' : 'Убрать из минимума')),
    ];
  }

  function saveItem(sh) {
    if (!D.cleanFields(sh.draft, sh.weekly)) return;
    if (sh.id) D.updateItem(S, sh.id, sh.draft);
    else D.addItem(S, sh.draft, sh.weekly, today);
    ui.sheet = null;
    commit();
  }

  function removeItem(sh) {
    const it = D.findItem(S, sh.id);
    showAlert({
      title: `Убрать «${it.name}»?`, msg: 'Прошлые дни не изменятся. Вернуть можно в Настройках, в разделе «Убранные».',
      yes: 'Убрать', danger: true,
      action: () => { D.archiveItem(S, sh.id, today); ui.sheet = null; commit(); },
    });
  }

  function alertView() {
    const a = ui.alert;
    return h('div', { class: 'alert' + (ui.alertFresh ? ' enter' : ''), role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'alert-title', 'aria-describedby': a.msg ? 'alert-msg' : null },
      h('div', { class: 'alert-box', tabindex: '-1' },
        h('div', { class: 'alert-body' }, h('p', { class: 'alert-title', id: 'alert-title' }, a.title), a.msg && h('p', { class: 'alert-msg', id: 'alert-msg' }, a.msg)),
        h('div', { class: 'alert-btns' },
          h('button', { class: 'alert-btn', onclick: () => { ui.alert = null; render(); } }, 'Отмена'),
          h('button', { class: 'alert-btn' + (a.danger ? ' danger' : ''), onclick: () => { const f = a.action; ui.alert = null; f(); } }, a.yes))));
  }

  // ---------- Прогресс

  function progressScreen() {
    const { streak, best, marks } = D.history(S, today);
    const days = D.diffDays(S.since, today) + 1;
    const w = D.firstWeekly(S);
    const weekly = S.weekly.filter(i => !i.archivedAt);
    const mon = D.weekStart(today);
    const revs = Object.keys(S.reviews).sort().reverse();
    return [
      h('header', { class: 'head' },
        h('div', { class: 'head-top' }, h('p', { class: 'overline' }, `В системе с ${dm(S.since)} · ${days}${NB}${plural(days, ['день', 'дня', 'дней'])}`)),
        h('h1', { class: 'title' }, 'Прогресс')),
      h('section', { class: 'hero' },
        h('div', { class: 'streak-hero' },
          h('div', {},
            h('p', { class: 'sh-over' }, 'СЕРИЯ'),
            h('p', { class: 'sh-num' }, h('span', { class: 'big' }, String(streak)),
              h('span', { class: 'unit' }, `${plural(streak, ['день', 'дня', 'дней'])} подряд`))),
          h('p', { class: 'sh-rec' }, h('span', { class: 't2' }, 'рекорд'), h('b', {}, String(best)))),
        chain(marks),
        h('div', { class: 'chain-legend' },
          h('span', {}, h('i', { class: 'lsq closed' }), 'закрыт'), h('span', {}, h('i', { class: 'lsq forgiven' }), 'прощён'),
          h('span', {}, h('i', { class: 'lsq break' }), 'разрыв'), h('span', {}, h('i', { class: 'lsq today' }), 'сегодня')),
        h('p', { class: 'rule' }, 'Один пропуск прощается, два подряд — серия с нуля.')),
      secH('Эта неделя'),
      h('section', { class: 'group rv-card' },
        h('div', { class: 'week-rings' }, D.range(mon, D.addDays(mon, 6)).map((d, i) => h('div', { class: 'wr-day' },
          h('span', { class: 'wr-label' + (d === today ? ' today' : ''), 'aria-hidden': 'true' }, WDL[i]), miniRings(D.dayRings(S, d, today), w, WEEKDAYS[i])))),
        h('div', { class: 'dots-legend' },
          h('span', {}, h('i', { class: 'lg-dot min' }), 'минимум'), h('span', {}, h('i', { class: 'lg-dot' }), 'сон в цель'),
          w && h('span', {}, h('i', { class: 'lg-dot train' }), lcFirst(w.name)))),
      secH(`Сон · 14${NB}ночей`),
      sleepSection(),
      secH('Пункты · 4 недели'),
      h('section', { class: 'group rates' }, D.itemRates(S, today).map(r => h('div', { class: 'rate', style: tint(r.item.color) },
        tile(r.item.icon), h('span', { class: 'rate-name' }, r.item.name),
        h('span', { class: 'rate-bar' }, h('span', { class: 'rate-fill', style: `--p:${r.rate ?? 0}` })),
        h('span', { class: 'rate-val' }, r.rate == null ? '—' : `${Math.round(r.rate * 100)}%`)))),
      weekly.map(it => [secH(`${it.name} · 8 недель`), h('section', { class: 'group rv-card' }, h('div', { class: 'w8' },
        Array.from({ length: 8 }, (_, i) => D.addDays(mon, -7 * (7 - i))).map(wk => {
          const c = D.weekCount(S, it.id, wk);
          return h('div', { class: 'w8-col' },
            h('div', { class: 'w8-cells', 'aria-label': `${c} из ${it.perWeek}`, role: 'img' }, Array.from({ length: Math.min(7, Math.max(it.perWeek, c)) }, (_, k) =>
              h('span', { class: 'w8-cell' + (k < c ? ' on' : '') }))),
            h('span', { class: 'w8-label' + (wk === mon ? ' now' : '') }, `${+wk.slice(8)}.${+wk.slice(5, 7)}`));
        })))]),
      secH('Недели'),
      h('section', { class: 'group' }, revs.length ? revs.map(m => {
        const r = S.reviews[m];
        const open = ui.revOpen.has(m);
        const sl = r.sleep.to && r.sleep.to !== r.sleep.from ? `отбой ${r.sleep.from} → ${r.sleep.to}` : `отбой ${r.sleep.from || '—'} — оставили`;
        const parts = [['Получилось', r.good], ['Не получилось', r.bad], ['Научился', r.learned]].filter(x => x[1]);
        return [
          h('button', { class: 'row row-s row-plain', 'aria-expanded': pressed(open), onclick: () => { open ? ui.revOpen.delete(m) : ui.revOpen.add(m); render(); } },
            txt(weekRange(m), sl + (r.improvement ? ` · 1%: ${r.improvement}` : '')), chev(open)),
          open && h('div', { class: 'drawer drawer-plain' },
            parts.map(([l, v]) => h('p', {}, h('b', {}, `${l}: `), v)),
            h('p', { class: 't2' }, r.notesDone ? 'Notes разобраны' : 'Notes не разобраны')),
        ];
      }) : h('p', { class: 'empty' }, 'Закрытых недель пока нет')),
    ];
  }

  function chain(marks) {
    const rows = 6, start = D.addDays(D.weekStart(today), -7 * (rows - 1));
    return h('div', { class: 'chain-wrap' },
      h('div', { class: 'chain', 'aria-hidden': 'true' }, WDL.map(l => h('span', { class: 'chain-wd' }, l))),
      h('div', { class: 'chain', role: 'img', 'aria-label': `Цепь дней за ${rows} недель` },
        D.range(start, D.addDays(D.weekStart(today), 6)).map((d, i) => {
          const m = d > today ? 'future' : marks[d] || 'none';
          return h('span', {
            class: `cell ${m}` + (d === today ? ' today' : ''),
            style: m === 'closed' ? `--col:${i % 7};--row:${Math.floor(i / 7)};--rows:${rows}` : null,
          });
        })));
  }

  function sleepSection() {
    const cur = D.knownMornings(S, D.addDays(today, -6), today, today);
    const prev = D.knownMornings(S, D.addDays(today, -13), D.addDays(today, -7), today);
    const a = D.sleepStats(S, cur), b = D.sleepStats(S, prev), hits = D.sleepHits(S, cur);
    const delta = [];
    if (a.avgDur != null && b.avgDur != null) {
      const x = a.avgDur - b.avgDur;
      delta.push(x > 0 ? `+${dur(x)} сна` : x < 0 ? `−${dur(-x)} сна` : 'сна столько же');
    }
    if (a.avgBedNorm != null && b.avgBedNorm != null) {
      const x = Math.round(a.avgBedNorm - b.avgBedNorm);
      delta.push(x < 0 ? `отбой на${NB}${dur(-x)} раньше` : x > 0 ? `отбой на${NB}${dur(x)} позже` : 'отбой в то же время');
    }
    return h('section', { class: 'group rv-card' },
      sleepChart(),
      h('div', { class: 'chart-legend' },
        h('span', {}, h('i', { class: 'cl-ok' }), 'в цель'), h('span', {}, h('i', { class: 'cl-late' }), 'позже'),
        h('span', {}, h('i', { class: 'cl-step' }), 'шаг отбоя'), h('span', {}, h('i', { class: 'cl-goal' }), S.sleep.goalBed)),
      h('div', { class: 'sc-sep' }),
      h('div', { class: 'stats' },
        h('p', { class: 'stat' }, h('b', {}, a.avgBed || '—'), h('span', {}, 'средний отбой')),
        h('p', { class: 'stat' }, h('b', {}, a.avgDur != null ? dur(a.avgDur) : '—'), h('span', {}, 'сон в среднем')),
        h('p', { class: 'stat' }, h('b', {}, hits.n ? `${hits.k} из ${hits.n}` : '—'), h('span', {}, 'в цель'))),
      delta.length > 0 && h('p', { class: 'delta' }, `7 ночей к прошлым 7: ${delta.join(', ')}`));
  }

  function sleepChart() {
    const days = D.range(D.addDays(today, -13), today);
    const W = 364, H = 236, L = 44, Y0 = 1380, K = 3, OFF = 8; // 23:00 сверху, 3 минуты на единицу
    const slot = (W - L) / days.length, bw = 10;
    const y = m => Math.max(0, Math.min(H, (m - Y0) / K + OFF));
    const steps = [];
    days.forEach((d, i) => {
      if (d < S.createdAt) return; // до посева шага ещё не было
      const t = D.targetFor(S, d), last = steps.at(-1);
      if (last && last.t === t) last.to = i + 1;
      else steps.push({ t, from: i, to: i + 1 });
    });
    return svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Сон за 14 ночей' },
      ['23:00', '01:00', '03:00', '05:00', '07:00', '09:00'].map(t => {
        const yy = y(D.norm(t));
        return [svg('line', { class: 'grid', x1: L, x2: W, y1: yy, y2: yy }), svg('text', { class: 'axis', x: 0, y: yy + 4 }, t)];
      }),
      svg('line', { class: 'goal', x1: L, x2: W, y1: y(D.norm(S.sleep.goalBed)), y2: y(D.norm(S.sleep.goalBed)) }),
      days.map((d, i) => {
        const n = S.sleep.nights[d];
        if (!n?.bed) return null;
        const cls = D.onTarget(S, d) ? 'bar-ok' : 'bar-late';
        const x = L + slot * i + (slot - bw) / 2, top = y(D.norm(n.bed));
        if (!n.wake) return svg('circle', { class: cls, cx: x + bw / 2, cy: top + bw / 2, r: bw / 2 });
        const bottom = y(D.toMin(n.wake) + 1440);
        return svg('rect', { class: cls, x, y: top, width: bw, height: Math.max(bw, bottom - top), rx: bw / 2 });
      }),
      steps.map(s => svg('line', { class: 'step', x1: L + slot * s.from + 2, x2: L + slot * s.to - 2, y1: y(D.norm(s.t)), y2: y(D.norm(s.t)) })));
  }

  // ---------- Настройки

  const tooMany = () => {
    const n = D.activeItems(S).length;
    return `В минимуме уже ${n} ${plural(n, ['пункт', 'пункта', 'пунктов'])}`;
  };

  function tryAdd(weekly) {
    if (!weekly && D.activeItems(S).length >= D.MAX_DAILY) {
      showAlert({ title: tooMany(), msg: 'Минимум должен выполняться в худший день. Всё равно добавить?', yes: 'Добавить', action: () => openItem(null, false) });
    } else openItem(null, weekly);
  }

  function restore(it) {
    const go = () => { D.restoreItem(S, it.id); commit(); };
    if (S.items.includes(it) && D.activeItems(S).length >= D.MAX_DAILY) {
      showAlert({ title: tooMany(), msg: 'Минимум должен выполняться в худший день. Всё равно вернуть?', yes: 'Вернуть', action: go });
    } else go();
  }

  function listRows(list, weekly) {
    const act = list.filter(i => !i.archivedAt);
    const move = (id, dir) => { D.moveItem(S, id, dir); commit(); };
    return act.map((it, i) => {
      const sub = weekly ? null : [it.note, it.beforeBed && `за${NB}${it.beforeBed}${NB}мин до${NB}отбоя`].filter(Boolean).join(' · ');
      const value = weekly && h('span', { class: 'value' }, `${it.perWeek}${NB}${plural(it.perWeek, ['раз', 'раза', 'раз'])}`);
      if (ui.edit) {
        return h('div', { class: 'row row-s', style: tint(it.color) }, tile(it.icon), txt(it.name, sub), value,
          h('span', { class: 'up-down' },
            h('button', { class: 'icon-btn', 'aria-label': `${it.name}: выше`, disabled: i === 0, onclick: () => move(it.id, -1) }, gl(G.up)),
            h('button', { class: 'icon-btn', 'aria-label': `${it.name}: ниже`, disabled: i === act.length - 1, onclick: () => move(it.id, 1) }, gl(G.down))));
      }
      return h('button', { class: 'row row-s', style: tint(it.color), onclick: () => openItem(it.id, weekly) }, tile(it.icon), txt(it.name, sub), value, chev());
    });
  }

  const addRow = weekly => h('button', { class: 'row row-m plus-row', onclick: () => tryAdd(weekly) },
    h('span', { class: 'tile tile-round' }, gl(G.plus)), h('span', { class: 'name' }, weekly ? 'Добавить счётчик' : 'Добавить пункт'));

  function timeRow(d, name, note, value, fmt, onSet) {
    const val = h('span', { class: 'value' }, fmt(value));
    return h('label', { class: 'row row-s time-row', style: tint('indigo') },
      h('span', { class: 'tile' }, gl(d)), txt(name, note), val, chev(),
      timeInput('time-input', value, name, v => {
        onSet(v);
        save();
        val.textContent = fmt(v); // без перерисовки: остальное на экране от этих полей не зависит
      }));
  }

  const readText = file => new Promise((ok, fail) => {
    const r = new win.FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsText(file);
  });

  async function doImport(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let text;
    try {
      text = await readText(file);
    } catch {
      ui.dataMsg = 'Не удалось прочитать файл';
      return render();
    }
    const r = parseImport(text, today);
    if (r.error) {
      ui.dataMsg = r.error;
      return render();
    }
    showAlert({
      title: 'Заменить все данные?', msg: 'Текущие отметки, сон и итоги будут стёрты и заменены данными из файла.', yes: 'Заменить', danger: true,
      action: () => {
        S = r.state;
        Object.assign(ui, { dataMsg: 'Данные импортированы', yOpen: false, sleepOpen: false, edit: false });
        commit();
      },
    });
  }

  async function doExport() {
    try {
      const how = await shareOrDownload(win, S, today);
      ui.dataMsg = how === 'cancelled' ? '' : 'Файл готов';
    } catch {
      ui.dataMsg = 'Не удалось сделать экспорт';
    }
    render();
  }

  function askReset() {
    showAlert({
      title: 'Сбросить к шаблону?', msg: 'Все отметки, сон и итоги недель будут стёрты. Если нужна копия — сначала экспорт.', yes: 'Сбросить', danger: true,
      action: () => {
        S = D.seed(today);
        Object.assign(ui, { dataMsg: 'Сброшено к шаблону', yOpen: false, sleepOpen: false, edit: false });
        commit();
      },
    });
  }

  function settingsScreen() {
    const act = D.activeItems(S), wact = S.weekly.filter(i => !i.archivedAt);
    const arch = [...S.items, ...S.weekly].filter(i => i.archivedAt);
    const canEdit = act.length > 1 || wact.length > 1;
    return [
      h('header', { class: 'head' },
        h('div', { class: 'head-top head-right' }, canEdit && h('button', {
          class: 'head-action' + (ui.edit ? ' on' : ''), onclick: () => { ui.edit = !ui.edit; render(); },
        }, ui.edit ? 'Готово' : 'Изменить')),
        h('h1', { class: 'title' }, 'Настройки')),
      secH(`Минимум · ${act.length}`),
      h('section', { class: 'group' }, listRows(S.items, false), !ui.edit && addRow(false)),
      h('p', { class: 'sec-foot' }, 'Минимум должен выполняться в худший день. На 11-м пункте приложение переспросит.'),
      arch.length > 0 && [secH('Убранные'), h('section', { class: 'group' }, arch.map(it => h('div', { class: 'row row-s archived', style: tint(it.color) },
        tile(it.icon), txt(it.name, S.weekly.includes(it) ? 'каждую неделю' : it.note),
        h('button', { class: 'restore', 'aria-label': `Вернуть «${it.name}»`, onclick: () => restore(it) }, 'Вернуть'))))],
      secH('Каждую неделю'),
      h('section', { class: 'group' }, listRows(S.weekly, true), !ui.edit && addRow(true)),
      secH('Сон'),
      h('section', { class: 'group' },
        timeRow(ICONS.moon[1], 'Цель отбоя', null, S.sleep.goalBed, t => t, v => (S.sleep.goalBed = v)),
        timeRow(ICONS.alarm[1], 'Подъём', null, S.sleep.goalWake, clock, v => (S.sleep.goalWake = v)),
        timeRow(G.stairs, 'Текущий шаг', 'меняется на итогах недели', D.stepTonight(S, today), t => t, v => D.setStep(S, v, today))),
      secH('Система'),
      h('section', { class: 'group' }, h('button', {
        class: 'row row-s', style: tint('gray'), onclick: () => { ui.sheet = { kind: 'rules' }; ui.fresh = true; render(); },
      }, tile('checklist'), txt('Правила'), chev())),
      secH('Данные'),
      h('section', { class: 'group' },
        h('button', { class: 'row row-t row-accent', onclick: doExport }, 'Экспорт в файл'),
        h('label', { class: 'row row-t row-accent' }, 'Импорт из файла',
          h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden-input', onchange: doImport })),
        h('button', { class: 'row row-t row-danger', onclick: askReset }, 'Сбросить к шаблону')),
      ui.dataMsg && h('p', { class: 'sec-foot', role: 'status' }, ui.dataMsg),
      secH('О приложении'),
      h('section', { class: 'group' },
        h('div', { class: 'row row-t' }, h('span', { class: 'txt' }, 'Версия'), h('span', { class: 'value' }, ui.version || '—')),
        h('button', { class: 'row row-t row-accent', onclick: checkUpdates }, 'Проверить обновления')),
      ui.updMsg && h('p', { class: 'sec-foot', role: 'status' }, ui.updMsg),
    ];
  }

  // ---------- обновление

  function askVersion() {
    const c = win.navigator.serviceWorker?.controller;
    if (!c || !win.MessageChannel) return;
    const ch = new win.MessageChannel();
    ch.port1.onmessage = e => {
      const m = /^minimum-(v\d+)$/.exec(e.data?.version || '');
      if (m && m[1] !== ui.version) {
        ui.version = m[1];
        if (ui.tab === 'settings' && !ui.sheet && !ui.alert) render();
      }
    };
    c.postMessage({ type: 'version' }, [ch.port2]);
  }

  function watchUpdate() {
    const track = w => w?.addEventListener('statechange', () => w.state === 'installed' && checkWaiting());
    reg.addEventListener('updatefound', () => track(reg.installing));
    track(reg.installing); // проверка при навигации могла начаться до регистрации слушателя
    checkWaiting();
  }

  function checkWaiting() {
    if (reg?.waiting && win.navigator.serviceWorker.controller && !ui.update) {
      ui.update = true;
      render();
    }
  }

  function applyUpdate() {
    if (!reg?.waiting) return;
    reloading = true;
    reg.waiting.postMessage({ type: 'skipWaiting' });
  }

  async function checkUpdates() {
    if (!reg) { ui.updMsg = 'Обновления недоступны'; return render(); }
    ui.updMsg = 'Проверяю…';
    render();
    try {
      await reg.update();
      lastCheck = Date.now();
      checkWaiting();
      ui.updMsg = reg.installing || reg.waiting ? 'Нашлась новая версия — внизу появится «Обновить»' : 'Установлена последняя версия';
    } catch {
      ui.updMsg = 'Нет связи — попробуй позже';
    }
    render();
  }

  async function initSW() {
    const sw = win.navigator.serviceWorker;
    if (!sw) return;
    // Перезагрузка — только если владелец сам нажал «Обновить».
    sw.addEventListener('controllerchange', () => (reloading ? win.location.reload() : askVersion()));
    try {
      reg = await sw.register('./sw.js', { updateViaCache: 'none' });
    } catch {
      return;
    }
    watchUpdate();
    askVersion();
    reg.update().catch(() => {});
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') {
      flushTime();
      return void store.flush();
    }
    if (D.logicalDate(now()) !== today) render();
    else if (ui.sleepOpen && !ui.sheet && !ui.alert) {
      ui.sleepOpen = false; // вернулся позже — карточка ночи сворачивается в строку героя
      render();
    }
    if (reg && Date.now() - lastCheck > UPDATE_EVERY) {
      lastCheck = Date.now();
      reg.update().catch(() => {});
    }
  });
  win.addEventListener('pagehide', () => store.flush());
  doc.addEventListener('touchstart', () => {}, { passive: true }); // без слушателя iOS не показывает :active

  render();
  initSW();
  return { render, get state() { return S; } };
}

const COLOR_NAMES = {
  red: 'красный', orange: 'оранжевый', yellow: 'жёлтый', green: 'зелёный', mint: 'мятный', teal: 'бирюзовый',
  blue: 'синий', indigo: 'индиго', purple: 'фиолетовый', pink: 'розовый', brown: 'коричневый', gray: 'серый',
};
