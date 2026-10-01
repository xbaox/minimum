// Минимум v3 — интерфейс. Каждый рендер строит экран целиком, а dom.js переносит разницу в живой DOM:
// узлы живут, поэтому кольца, отметки и блоки двигаются, а фокус и прокрутка не теряются.
// Пользовательский текст попадает в разметку только текстовыми узлами.

import * as D from './domain.js';
import { ICONS, ICON_GROUPS, UI as G } from './icons.js';
import { createDOM, EASE } from './dom.js';
import { createStore, requestPersist, shareOrDownload, parseImport } from './store.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WDL = ['П', 'В', 'С', 'Ч', 'П', 'С', 'В'];
const NB = ' '; // число с единицей и «до» со временем не разрываются переносом
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
const NEWS_ID = 'v53';
const NEWS = [
  'Отметки, кольца и листы теперь живые, а закрытый день — праздник',
  `Удержи пункт — откроются его серия и 6${NB}недель истории`,
  'Тапни день в «Прогрессе» — увидишь, что в нём было',
  'Лист закрывается свайпом вниз',
];
const DAY_STATUS = { closed: 'День закрыт', forgiven: 'Пропуск — прощён', break: 'Пропуск', pending: 'Идёт сейчас', none: 'Без минимума' };
const CELL = { closed: 'закрыт', forgiven: 'пропуск прощён', break: 'пропуск', pending: 'сегодня', none: 'без отметок', future: '' };
const BEFORE = [15, 30, 45, 60];
const EVENING_HOUR = 18;
const NIGHT_AUTOCLOSE = 1600;
const UPDATE_EVERY = 10 * 60e3;

const dm = iso => `${+iso.slice(8)}${NB}${MONTHS[+iso.slice(5, 7) - 1]}`;
const weekRange = mon => {
  const sun = D.addDays(mon, 6);
  return mon.slice(5, 7) === sun.slice(5, 7) ? `${+mon.slice(8)}–${dm(sun)}` : `${dm(mon)} — ${dm(sun)}`;
};
const dur = m => {
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}${NB}ч${NB}${r}${NB}мин` : `${h}${NB}ч`) : `${r}${NB}мин`;
};
const plural = (n, [one, few, many]) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
const days = n => `${n}${NB}${plural(n, ['день', 'дня', 'дней'])}`;
const clock = t => t.replace(/^0(?=\d:)/, ''); // 07:30 → 7:30
const tint = c => `--item:var(--c-${c});--bar:var(--b-${c})`;
// Название пункта внутри фразы: «Телефон на кухню» → «телефон на кухню», но «ЕГЭ» и «iPhone» не трогаем.
const lcFirst = s => (/^\p{Lu}\p{Ll}/u.test(s) ? s[0].toLocaleLowerCase('ru') + s.slice(1) : s);
const cap = s => s.charAt(0).toLocaleUpperCase('ru') + s.slice(1);
const ago = (from, to) => {
  const n = D.diffDays(from, to);
  return n <= 0 ? 'сегодня' : n === 1 ? 'вчера' : `${days(n)} назад`;
};

export async function boot({ win = window, now = () => new Date(), idb = win.indexedDB } = {}) {
  const doc = win.document;
  const root = doc.getElementById('app');
  const M = createDOM(win);
  const { h, svg } = M;
  const ui = {
    tab: 'today', sheet: null, alert: null, yOpen: false, sleepOpen: false, edit: false, revOpen: new Set(), chartSel: null,
    dataMsg: '', updMsg: '', toast: '', saveFailed: false, restored: false, update: false, version: '', scrolled: false, scroll: {}, alertClosing: false,
  };
  let S, today, reg = null, reloading = false, lastCheck = Date.now(), closing = false, pendingTime = null;
  let dayTimer, tickTimer, toastTimer, nightTimer;

  let ls;
  try {
    ls = win.localStorage;
  } catch {}
  const store = createStore({ ls, idb, today: () => D.logicalDate(now()), onSaveError: () => (ui.saveFailed = true) });
  const loaded = await store.load();
  S = loaded.state;
  ui.restored = loaded.restored;
  requestPersist(win.navigator);

  // ---------- мелкие детали разметки

  // len — длина пути 1: галочку можно «дорисовать» через stroke-dashoffset.
  const gl = (d, cls = '', len) => svg('svg', { class: 'gl ' + cls, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d, pathLength: len }));
  const icon = id => gl((ICONS[id] || ICONS.star)[1]);
  const tile = (id, color) => h('span', { class: 'tile', style: color ? tint(color) : null }, icon(id));
  const chev = open => gl(G.chevron, 'chev' + (open ? ' open' : ''));
  const txt = (name, note, strong) => h('span', { class: 'txt' },
    h('span', { class: 'name' + (strong ? ' strong' : '') }, name), note && h('span', { class: 'note' }, note));
  const secH = (key, title, action) => h('h2', { key, class: 'sec-h', 'data-flip': '' }, h('span', {}, title), action);
  const stat = (value, label) => h('p', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
  const pressed = on => String(!!on);
  const all = (el, sel) => [...(el.matches?.(sel) ? [el] : []), ...el.querySelectorAll(sel)];

  // Градиенты колец и столбиков сна — один раз на документ.
  const grad = (id, x2, y2, stops) => svg('linearGradient', { id, x1: 0, y1: 0, x2, y2 },
    stops.map(([cls, offset]) => svg('stop', { class: cls, offset })));
  const defs = () => svg('svg', { key: 'defs', class: 'defs', 'aria-hidden': 'true', focusable: 'false' }, svg('defs', {},
    grad('g-sun', 1, 1, [['s-sun-1', 0], ['s-sun-2', 0.5], ['s-sun-3', 1]]),
    grad('g-sleep', 1, 1, [['s-sleep-1', 0], ['s-sleep-2', 1]]),
    grad('g-train', 1, 1, [['s-train-1', 0], ['s-train-2', 1]]),
    grad('g-bar', 0, 1, [['s-sleep-1', 0], ['s-sleep-2', 1]])));

  // Кольца: parts — [{ kind: 'sun' | 'sleep' | 'train', f: 0…1 }] снаружи внутрь. dual — второй, белый
  // набор дуг для закрытого дня (герой становится закатным, дуги — белыми; переход — сменой прозрачности).
  function rings(cls, size, radii, width, parts, label, dual) {
    const c = size / 2;
    const arc = (r, f, kind) => {
      const C = 2 * Math.PI * r;
      return svg('circle', {
        class: `arc arc-${kind}` + (f > 0 ? '' : ' zero'), cx: c, cy: c, r, 'stroke-width': width, transform: `rotate(-90 ${c} ${c})`,
        style: `stroke-dasharray:${C.toFixed(2)}px ${C.toFixed(2)}px;stroke-dashoffset:${(C * (1 - f)).toFixed(2)}px`,
      });
    };
    return svg('svg', {
      class: cls, viewBox: `0 0 ${size} ${size}`, role: label ? 'img' : null, 'aria-label': label, 'aria-hidden': label ? null : 'true', 'data-draw': '',
    }, parts.map((p, i) => {
      const r = radii[i], f = Math.max(0, Math.min(1, p.f || 0));
      return [
        svg('circle', { class: `tr tr-${p.kind}`, cx: c, cy: c, r, 'stroke-width': width }),
        arc(r, f, p.kind),
        dual && svg('circle', { class: 'tr tr-w', cx: c, cy: c, r, 'stroke-width': width }),
        dual && arc(r, f, `w${i + 1}`),
      ];
    }));
  }
  const miniRings = (r, w, name) => rings('mini', 44, [18.5, 12.5, 6.5], 5, [
    { kind: 'sun', f: r.min }, { kind: 'sleep', f: r.sleep ? 1 : 0 }, w && { kind: 'train', f: r.week ? 1 : 0 },
  ].filter(Boolean), r.min == null ? `${name}: нет данных` : [
    `${name}: минимум ${Math.round(r.min * 100)}%`, r.sleep == null ? 'сон не отмечен' : r.sleep ? 'сон в цель' : 'сон позже шага',
    w && `${lcFirst(w.name)} — ${r.week ? 'да' : 'нет'}`,
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
    toastTimer = win.setTimeout(() => {
      const el = root.querySelector('.bar-toast');
      const go = () => {
        ui.toast = '';
        render();
      };
      if (!el || !M.motion()) return go();
      M.done(M.anim(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(16px)' }],
        { duration: 220, easing: EASE.in, fill: 'forwards' })).then(go);
    }, 2400);
  }

  // Родной барабан времени: пока поле в фокусе, выбор ждёт его закрытия — iOS закрыл бы барабан на полпути.
  function timeInput(cls, value, label, pick) {
    return h('input', {
      type: 'time', class: cls, value: value || '', 'aria-label': label,
      onclick: e => {
        try {
          e.target.showPicker?.();
        } catch {}
      },
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
        if (pendingTime?.el === e.target) flushTime();
      },
    });
  }
  // Барабан времени открыт — экран по таймерам не трогаем: iOS закрыл бы его на полпути.
  const pickerOpen = () => !!pendingTime || doc.activeElement?.type === 'time';

  // Выбор из барабана, ждущий закрытия, применяется до любой перерисовки.
  function flushTime() {
    if (!pendingTime) return;
    const { run } = pendingTime;
    pendingTime = null;
    run();
  }

  // ---------- рендер

  function render() {
    flushTime();
    const day = D.logicalDate(now());
    if (today && day !== today) Object.assign(ui, { sleepOpen: false, yOpen: false, chartSel: null });
    today = day;
    if (D.syncToday(S, today)) save();
    const modal = !!(ui.sheet || ui.alert);
    const screen = ui.tab === 'today' ? todayScreen() : ui.tab === 'progress' ? progressScreen() : settingsScreen();
    const before = M.measure(root);
    const entered = M.patch(root, [
      defs(),
      h('main', { key: `screen-${ui.tab}`, class: 'screen', 'data-enter': 'screen', 'aria-hidden': modal ? 'true' : null, inert: modal }, screen),
      h('div', { key: 'bars', class: 'bars' },
        ui.saveFailed && h('div', { key: 'warn', class: 'bar bar-warn', role: 'alert', 'data-enter': 'bar' }, 'Не удалось сохранить — сделай экспорт в Настройках'),
        ui.update && h('button', { key: 'update', class: 'bar bar-update', 'data-enter': 'bar', onclick: applyUpdate }, 'Доступна новая версия · ', h('b', {}, 'Обновить')),
        ui.toast && h('div', { key: 'toast', class: 'bar bar-toast', role: 'status', 'data-enter': 'bar' }, ui.toast)),
      h('nav', { key: 'tabbar', class: 'tabbar', 'aria-label': 'Разделы', 'aria-hidden': modal ? 'true' : null, inert: modal }, TABS.map(([id, label, d]) =>
        h('button', { key: id, class: 'tab', 'aria-current': ui.tab === id ? 'page' : null, onclick: () => openTab(id) }, gl(d), h('span', {}, label)))),
      ui.sheet && sheetView(),
      ui.alert && alertView(),
    ].filter(Boolean));
    // Высота полей — до FLIP: иначе блоки под ними «прыгали» бы на каждом касании.
    for (const t of root.querySelectorAll('textarea.area')) if (t.__sized !== t.value) autosize(t);
    M.flip(before, entered);
    entrance(entered);
    doc.body.classList.toggle('locked', modal);
    win.clearTimeout(dayTimer);
    dayTimer = win.setTimeout(render, D.msToNextDay(now()) + 1000);
    tick();
  }

  // Появление новых узлов: экран, лист, подтверждение, полоса; кольца дорисовываются, сетки — по очереди.
  function entrance(entered) {
    for (const el of entered) {
      if (el.nodeType !== 1) continue;
      const kind = el.getAttribute('data-enter');
      if (kind === 'screen') M.anim(el, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], 380);
      else if (kind === 'sheet') sheetIn(el);
      else if (kind === 'alert') alertIn(el);
      else if (kind === 'bar') M.anim(el, [{ opacity: 0, transform: 'translateY(18px) scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE.spring });
      else if (kind === 'pop') M.anim(el, [{ opacity: 0, transform: 'scale(0.3)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: EASE.spring });
      const later = new Set();
      for (const box of all(el, '[data-reveal]')) {
        const parts = [...all(box, '[data-draw]'), ...all(box, '[data-stagger]')];
        parts.forEach(p => later.add(p));
        M.reveal(box, play(parts));
      }
      play([...all(el, '[data-draw]'), ...all(el, '[data-stagger]')].filter(p => !later.has(p)));
      for (const c of all(el, '[data-count]')) M.countUp(c, +c.getAttribute('data-count'));
    }
  }
  const play = parts => parts.flatMap(p => (p.hasAttribute('data-draw') ? M.draw(p) : M.stagger(p)));

  // Поле растёт по тексту; прокрутка листа при этом не съезжает.
  function autosize(el) {
    const panel = el.closest('.sheet-panel');
    const top = panel ? panel.scrollTop : 0;
    el.__keepStyle = true;
    el.style.height = 'auto';
    if (el.scrollHeight) el.style.height = `${el.scrollHeight}px`;
    el.__sized = el.value;
    if (panel && panel.scrollTop !== top) panel.scrollTop = top;
  }

  // Раз в минуту — свежий отсчёт до отбоя; в фоне не тикаем.
  function tick() {
    win.clearTimeout(tickTimer);
    if (doc.visibilityState === 'hidden') return;
    const d = now();
    tickTimer = win.setTimeout(() => {
      if (ui.tab === 'today' && !ui.sheet && !ui.alert && !closing && !pickerOpen()) render();
      else tick();
    }, 60500 - (d.getSeconds() * 1000 + d.getMilliseconds()));
  }

  // ---------- верхняя панель и вкладки

  const topbar = (left, center, right) => h('header', { key: 'topbar', class: 'topbar' + (ui.scrolled ? ' scrolled' : '') },
    h('div', { class: 'tb' },
      h('div', { class: 'tb-l' }, left),
      h('div', { class: 'tb-c', 'aria-hidden': 'true' }, center),
      h('div', { class: 'tb-r' }, right)));
  const title = text => h('h1', { key: 'title', class: 'large-title' }, text);

  // Крупный заголовок ушёл под панель — панель получает подложку и маленький заголовок, как в iOS.
  function updateScrolled() {
    const bar = root.querySelector('.topbar'), t = root.querySelector('.large-title');
    if (!bar || !t) return;
    const on = t.getBoundingClientRect().bottom <= bar.getBoundingClientRect().bottom + 2;
    if (on !== ui.scrolled) {
      ui.scrolled = on;
      bar.classList.toggle('scrolled', on);
    }
  }
  let scrollRaf = 0;
  function onScroll() {
    if (scrollRaf || typeof win.requestAnimationFrame !== 'function') return;
    scrollRaf = win.requestAnimationFrame(() => {
      scrollRaf = 0;
      updateScrolled();
    });
  }

  function scrollY(y, smooth) {
    const se = doc.scrollingElement || doc.documentElement;
    if (smooth && M.motion() && typeof se.scrollTo === 'function') {
      try {
        return void se.scrollTo({ top: y, behavior: 'smooth' });
      } catch {}
    }
    se.scrollTop = y;
  }

  function openTab(id) {
    if (id === ui.tab) return scrollY(0, true); // повторный тап — наверх
    const se = doc.scrollingElement || doc.documentElement;
    ui.scroll[ui.tab] = se.scrollTop;
    Object.assign(ui, { tab: id, alert: null, edit: false, sleepOpen: false, dataMsg: '', updMsg: '', chartSel: null, scrolled: false });
    render();
    scrollY(ui.scroll[id] || 0);
    updateScrolled(); // сразу, до первого кадра: панель не «догоняет» прокрутку
    M.anim(root.querySelector('.tab[aria-current] .gl'), [{ transform: 'scale(0.78)' }, { transform: 'scale(1.14)' }, { transform: 'none' }],
      { duration: 460, easing: EASE.out });
  }

  // ---------- листы и подтверждения

  function sheetIn(el) {
    const panel = el.querySelector('.sheet-panel'), back = el.querySelector('.sheet-back');
    M.anim(back, [{ opacity: 0 }, { opacity: 1 }], 320);
    M.anim(panel, [{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: 520, easing: EASE.ios });
    M.dragSheet(el, { close: from => closeSheet(null, from), guard: guardDirty });
    try {
      panel.focus({ preventScroll: true });
    } catch {}
  }

  function alertIn(el) {
    const box = el.querySelector('.alert-box');
    M.anim(el, [{ opacity: 0 }, { opacity: 1 }], 200);
    M.anim(box, [{ opacity: 0, transform: 'scale(1.12)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE.out });
    try {
      box.focus({ preventScroll: true });
    } catch {}
  }

  // Лист уезжает вниз (с места, куда его дотянули), потом исчезает из состояния.
  function closeSheet(after, from = 0) {
    const finish = () => {
      closing = false;
      ui.sheet = null;
      after?.();
      render();
    };
    const el = root.querySelector('.sheet');
    if (!el || !M.motion()) return finish();
    if (closing) return;
    closing = true;
    el.inert = true; // уезжающий лист уже не принимает касаний
    const panel = el.querySelector('.sheet-panel'), back = el.querySelector('.sheet-back');
    const op = win.getComputedStyle(back).opacity;
    const a = M.anim(panel, [{ transform: `translateY(${from}px)` }, { transform: 'translateY(105%)' }],
      { duration: from ? 260 : 340, easing: EASE.in, fill: 'forwards' });
    M.anim(back, [{ opacity: op }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
    M.done(a).then(finish);
  }

  function closeAlert(after) {
    if (ui.alertClosing) return; // двойное касание по кнопке — действие один раз
    const finish = () => {
      ui.alert = null;
      ui.alertClosing = false;
      after?.();
      render();
    };
    const el = root.querySelector('.alert');
    if (!el || !M.motion()) return finish();
    ui.alertClosing = true;
    el.inert = true;
    M.done(M.anim(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 170, fill: 'forwards' })).then(finish);
  }

  function showAlert(a) {
    ui.alert = a;
    render();
  }

  // Случайный свайп или тап мимо листа не должен стирать набранное.
  function sheetDirty() {
    const sh = ui.sheet;
    if (!sh) return false;
    if (sh.kind === 'review') return ['good', 'bad', 'learned', 'improvement'].some(k => sh.draft[k].trim());
    if (sh.kind === 'item') return JSON.stringify(sh.draft) !== sh.orig;
    return false;
  }
  function guardDirty() {
    if (closing) return true;
    if (!sheetDirty()) return false;
    showAlert({ title: 'Закрыть без сохранения?', msg: 'Введённое пропадёт.', yes: 'Закрыть', danger: true, action: () => closeSheet() });
    return true;
  }

  // Блоки плавно уходят, затем состояние меняется, а соседи съезжают на их место (FLIP).
  // Если состояние блок оставило (передумали на полпути), он снова виден.
  function leave(els, then) {
    els = [].concat(els).filter(Boolean);
    if (!els.length || !M.motion()) return then();
    const anims = els.map(el => M.anim(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }],
      { duration: 200, easing: EASE.in, fill: 'forwards' }));
    M.done(anims[0]).then(() => {
      then();
      for (const a of anims) a?.cancel();
    });
  }

  // ---------- Сегодня

  const evening = () => {
    const hr = now().getHours();
    return hr >= EVENING_HOUR || hr < D.DAY_START_HOUR;
  };

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
      rv && h('section', { key: 'review', class: 'group banner', 'data-flip': '' }, h('button', { class: 'row', onclick: () => openReview(rv.monday) },
        tile('checklist', 'pink'),
        rv.kind === 'sunday' ? txt('Итоги недели', `10${NB}минут · шаг сна и 1% на неделю`, true) : txt('Итоги прошлой недели', `не закрыты · 10${NB}минут`, true),
        chev())),
      yesterdayCard(y),
    ].filter(Boolean);
    return [
      topbar(h('p', { class: 'overline' }, `${WEEKDAYS[D.weekday(today)]}, ${dm(today)}`),
        h('span', { class: 'tb-progress' }, rings('tb-ring', 22, [8.5], 3.5, [{ kind: 'sun', f: n ? k / n : 0 }]),
          h('span', { class: 'roll', 'data-roll': '' }, closed ? 'День закрыт' : `${k} из ${n}`)),
        h('span', { class: 'streak', role: 'img', 'aria-label': `Серия ${streak}` }, gl(G.flame), h('span', { class: 'roll', 'data-roll': '', 'aria-hidden': 'true' }, String(streak)))),
      title('Сегодня'),
      ui.restored && h('p', { key: 'restored', class: 'group notice-card', 'data-flip': '' }, 'Данные восстановлены из резервной копии'),
      !S.ui.welcomeSeen && h('section', { key: 'welcome', class: 'group card-pad welcome', 'data-flip': '' },
        h('div', { class: 'welcome-head' }, tile('sparkles', 'pink'), h('p', { class: 'name strong' }, 'Новый минимум')),
        h('p', {}, WELCOME),
        h('button', { class: 'btn-text', onclick: e => leave(e.currentTarget.closest('.group'), () => { S.ui.welcomeSeen = true; S.ui.news = NEWS_ID; commit(); }) }, 'Понятно')),
      S.ui.welcomeSeen && S.ui.news !== NEWS_ID && h('section', { key: 'news', class: 'group card-pad welcome', 'data-flip': '' },
        h('div', { class: 'welcome-head' }, tile('star', 'purple'), h('p', { class: 'name strong' }, 'Что нового')),
        h('ul', { class: 'news' }, NEWS.map(t => h('li', {}, t))),
        h('button', { class: 'btn-text', onclick: e => leave(e.currentTarget.closest('.group'), () => { S.ui.news = NEWS_ID; commit(); }) }, 'Понятно')),
      hero({ plan, done, k, n, closed, step, card, streak }),
      D.status(S, y, today) === 'miss' && !closed && h('p', { key: 'miss', class: 'notice-line', 'data-flip': '' }, 'Вчера пропуск — сегодня не пропускай дважды'),
      card && sleepCard(),
      stack.length > 0 && h('div', { key: 'stack', class: 'stack', 'data-flip': '' }, stack),
      secH('h-min', 'Минимум'),
      n > 0
        ? h('section', { key: 'list-min', class: 'group list-min', 'data-flip': '' }, plan.map(id => {
          const it = D.findItem(S, id);
          return itemRow(it, done.includes(id), today, it.beforeBed ? `до${NB}${D.deadline(step, it.beforeBed)}` : '');
        }))
        : h('p', { key: 'empty', class: 'group empty', 'data-flip': '' }, 'Минимум пуст — добавь пункты в Настройках'),
      weekly.length > 0 && [secH('h-week', 'На неделе'), h('section', { key: 'list-week', class: 'group list-week', 'data-flip': '' }, weekly.map(weekRow))],
      improvement && h('section', { key: 'onepct', class: 'group onepct', 'data-flip': '' }, h('div', { class: 'row' }, tile('sparkles', 'yellow'),
        h('span', { class: 'txt' }, h('span', { class: 'note' }, '1% недели'), h('span', { class: 'name' }, improvement)))),
    ];
  }

  function hero({ plan, done, k, n, closed, step, card, streak }) {
    const mon = D.weekStart(today);
    const sh = D.sleepHits(S, D.knownMornings(S, mon, D.addDays(mon, 6), today));
    const w = D.firstWeekly(S);
    const wc = w ? D.weekCount(S, w.id, today) : 0;
    const label = [`Минимум ${k} из ${n}`, sh.n ? `сон ${sh.k} из ${sh.n} в цель` : 'сон — нет данных',
      w && `${w.name} ${wc} из ${w.perWeek}`].filter(Boolean).join(', ');
    const sub = closed ? (D.isMilestone(streak) ? `Серия ${days(streak)}` : 'День закрыт') : n ? `минимум · осталось ${n - k}` : 'минимум пуст';
    return h('section', { key: 'hero', class: 'hero' + (closed ? ' closed' : ''), style: `--p:${n ? (k / n).toFixed(3) : 0}`, 'data-flip': '' },
      h('span', { class: 'hero-sun', 'aria-hidden': 'true' }),
      h('div', { class: 'hero-top' },
        rings('rings', 132, [57, 41, 25], 13, [
          { kind: 'sun', f: n ? k / n : 0 }, { kind: 'sleep', f: sh.n ? sh.k / sh.n : 0 }, w && { kind: 'train', f: wc / w.perWeek },
        ].filter(Boolean), label, true),
        h('div', { class: 'hero-info' },
          h('div', {},
            h('p', { class: 'count', 'data-roll': '' }, n ? `${k} из ${n}` : '—'),
            h('p', { class: 'count-sub', 'data-roll': '' }, sub)),
          h('div', { class: 'legend' },
            h('p', { class: 'lg' }, h('span', { class: 'lg-dot' }), h('span', { class: 'lg-label' }, 'Сон'),
              h('span', { class: 'lg-val roll', 'data-roll': '' }, sh.n ? `${sh.k}/${sh.n} в${NB}цель` : 'нет данных')),
            w && h('p', { class: 'lg' }, h('span', { class: 'lg-dot train' }), h('span', { class: 'lg-label' }, w.name),
              h('span', { class: 'lg-val roll', 'data-roll': '' }, `${wc}/${w.perWeek}`))))),
      n > 0 && h('div', { key: 'segs', class: 'segs', 'aria-hidden': 'true' }, plan.map((id, i) =>
        h('span', { key: id, class: 'seg' + (done.includes(id) ? ' on' : ''), style: `--i:${i};--n:${plan.length}` }, h('i', { class: 'seg-fill' })))),
      h('div', { key: 'line', class: 'hero-line' }),
      sleepLine(step, card));
  }

  // Строка сна в герое. Днём — цель и подъём, вечером — живой отсчёт до отбоя и до «телефона на кухню».
  function sleepLine(step, card) {
    const goal = S.sleep.goalBed, wake = clock(S.sleep.goalWake), t = now(), eve = evening();
    const toBed = D.untilMin(t, step);
    const phone = D.activeItems(S).find(i => i.beforeBed);
    const night = S.sleep.nights[today] || {};
    const line1 = h('span', { class: 'sl1' }, h('b', {}, `Отбой ${step}`),
      !eve ? h('span', { class: 't2' }, D.norm(step) <= D.norm(goal) ? ' · цель достигнута' : ` · цель ${goal}`)
        : toBed > 0 ? h('span', { class: toBed <= 30 ? 'warn' : 't2' }, ` · через${NB}${dur(toBed)}`)
          : h('span', { class: 'warn' }, ' · пора спать'));
    let line2 = h('span', { class: 'sl2' }, `подъём ${wake}`);
    if (phone) {
      const dl = D.deadline(step, phone.beforeBed), left = D.untilMin(t, dl), name = lcFirst(phone.name);
      if (!eve) line2 = h('span', { class: 'sl2' }, `${name} до${NB}${dl} · подъём ${wake}`);
      else if (D.doneOf(S, today).includes(phone.id)) line2 = h('span', { class: 'sl2' }, h('span', { class: 'ok' }, `${name}${NB}✓`), ` · подъём ${wake}`);
      else if (left > 0) line2 = h('span', { class: 'sl2' }, `${name} до${NB}${dl} · через${NB}${dur(left)}`);
      else line2 = h('span', { class: 'sl2' }, h('span', { class: 'warn' }, `${name} — пора`), ` · подъём ${wake}`);
    }
    let last = null;
    if (!card) {
      if (night.bed && night.wake) {
        const late = D.norm(night.bed) - D.norm(D.targetFor(S, today));
        const d = D.duration(night);
        last = h('span', { class: 'sl2' }, `прошлая ночь ${d ? dur(d) : '—'} · `,
          late > 0 ? `на${NB}${dur(late)} позже шага` : h('span', { class: 'ok' }, 'в цель'));
      } else last = h('span', { class: 'sl2 warn' }, night.bed || night.wake ? 'прошлая ночь отмечена не полностью' : 'прошлая ночь не отмечена');
    }
    return h('button', { key: 'sleep', class: 'sleep-btn', onclick: () => { if (!stale()) { ui.sleepOpen = true; render(); } } },
      gl(ICONS.moon[1]), h('span', { class: 'sl' }, line1, line2, last));
  }

  function itemRow(it, isDone, date, extra) {
    return h('button', {
      key: it.id, class: 'row' + (isDone ? ' done' : ''), style: tint(it.color), 'aria-pressed': pressed(isDone), 'data-flip': '',
      ...M.holdable(() => toggle(date, it.id), () => openItem(it.id, S.weekly.includes(it))),
    }, tile(it.icon), txt(it.name, [it.note, extra].filter(Boolean).join(' · ')), h('span', { class: 'check' }, gl(G.check, '', 1)));
  }

  function toggle(date, id) {
    if (stale() || closing) return;
    const was = D.status(S, today, today) === 'closed';
    if (!D.toggleDone(S, date, id, today)) return;
    M.haptic();
    commit();
    if (date === today && !was && D.status(S, today, today) === 'closed') celebrate();
  }

  // Праздник закрытия дня: толчок колец, конфетти цветами пунктов, огонёк серии. Сам переход героя
  // в закатный и волна света по полосе — CSS (класс closed). Всего ≈ 1,3 с, один раз, без звука.
  function celebrate() {
    if (!M.motion()) return;
    const { streak } = D.history(S, today);
    const big = D.isMilestone(streak);
    const colors = D.activeItems(S).map(i => `var(--c-${i.color})`).concat(['var(--sun-1)', 'var(--sun-2)', 'var(--sun-3)']);
    const pulse = (el, delay) => M.anim(el, [{ transform: 'none' }, { transform: 'scale(1.07)' }, { transform: 'none' }], { duration: 600, delay });
    // День закрыли из листа дня — салют от его колец, герой за листом не виден.
    const dayRings = ui.sheet?.kind === 'day' && root.querySelector('.sheet .day-rings');
    if (dayRings) {
      pulse(dayRings, 120);
      return M.burst(dayRings, colors, { n: big ? 30 : 20, spread: 0.8, delay: 140 });
    }
    const heroEl = root.querySelector('.hero:not(.hero-streak)');
    const ringsEl = heroEl?.querySelector('.rings');
    if (!ringsEl) return;
    pulse(ringsEl, 300);
    M.burst(ringsEl, colors, { n: big ? 40 : 26, spread: big ? 1.35 : 1, delay: 320 });
    M.anim(root.querySelector('.topbar .streak'), [{ transform: 'none' }, { transform: 'scale(1.28)' }, { transform: 'none' }],
      { duration: 520, delay: 560, easing: EASE.spring });
  }

  function weekRow(it) {
    const c = D.weekCount(S, it.id, today);
    const mine = (S.weekMarks[it.id] || []).includes(today);
    return h('button', {
      key: it.id, class: 'row', style: tint(it.color), 'aria-pressed': pressed(mine), 'data-flip': '', 'data-wk': it.id,
      ...M.holdable(() => weekToggle(it), () => openItem(it.id, true)),
    }, tile(it.icon), txt(it.name, it.note),
    h('span', { class: 'wk' },
      h('span', { class: 'wk-label roll' + (mine ? ' today' : ''), 'data-roll': '' }, mine ? `✓ ${c} из ${it.perWeek}` : `${c} из ${it.perWeek}`),
      h('span', { class: 'pills', 'aria-hidden': 'true' }, Array.from({ length: Math.min(7, Math.max(it.perWeek, c)) }, (_, i) =>
        h('span', { class: 'pill' + (i < c ? ' on' : '') })))));
  }

  function weekToggle(it) {
    if (stale() || closing) return;
    const was = D.weekCount(S, it.id, today);
    D.toggleWeekMark(S, it.id, today);
    M.haptic();
    commit();
    if (was < it.perWeek && D.weekCount(S, it.id, today) >= it.perWeek) {
      M.burst(root.querySelector(`[data-wk="${it.id}"] .pills`), ['var(--train-1)', 'var(--train-2)', 'var(--c-mint)'], { n: 14, spread: 0.55 });
    }
  }

  function sleepCard() {
    const n = S.sleep.nights[today] || {};
    return [
      secH('h-night', 'Прошлая ночь', n.bed && n.wake && h('button', { class: 'link', onclick: collapseNight }, 'Готово')),
      h('section', { key: 'night', class: 'group sleep-card', 'aria-label': 'Прошлая ночь', 'data-flip': '' }, nightEditor(today, true)),
    ];
  }

  // Обе отметки ночи есть — через 1,6 с карточка сворачивается в строку героя; пока крутят барабан — ждёт.
  function armCollapse() {
    win.clearTimeout(nightTimer);
    nightTimer = win.setTimeout(() => {
      if (ui.tab !== 'today' || !ui.sleepOpen || ui.sheet || ui.alert) return;
      if (pickerOpen()) return armCollapse();
      collapseNight();
    }, NIGHT_AUTOCLOSE);
  }

  function collapseNight() {
    win.clearTimeout(nightTimer);
    const card = root.querySelector('.sleep-card');
    const go = () => {
      ui.sleepOpen = false;
      render();
    };
    if (!card) return go();
    leave([card.previousElementSibling, card], go);
  }

  function nightEditor(date, isToday) {
    const n = S.sleep.nights[date] || {};
    const step = D.targetFor(S, date), wake = S.sleep.goalWake;
    const set = (field, v) => {
      if (stale()) return;
      D.setNight(S, date, field, v);
      M.haptic();
      if (isToday) {
        // Обе отметки есть — показать итог и свернуть карточку в строку героя.
        ui.sleepOpen = true;
        win.clearTimeout(nightTimer);
        const m = S.sleep.nights[date];
        if (m?.bed && m?.wake) armCollapse();
      }
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
      n.bed && n.wake && h('p', { key: 'sum', class: 'strip', 'data-flip': '' }, gl(ICONS.moon[1]), h('span', {}, h('b', { class: 'roll', 'data-roll': '' }, `Сон ${d ? dur(d) : '—'}`),
        h('span', { class: 't2' }, late > 0 ? ` · на${NB}${dur(late)} позже шага` : ' · в цель'))),
    ];
  }

  function chipRow(label, values, current, mark, pick, fmt) {
    const other = current && !values.includes(current);
    return h('div', { class: 'chips', role: 'group', 'aria-label': label },
      values.map(v => h('button', {
        key: `v${v}`, class: 'chip' + (v === mark ? ' mark' : ''), 'aria-pressed': pressed(v === current),
        onclick: () => pick(v === current ? null : v),
      }, fmt(v))),
      // Родной выбор времени лежит прозрачным поверх чипа: iOS открывает его только от прямого касания.
      h('label', { key: 'other', class: 'chip chip-other' + (other ? ' on' : '') }, other ? fmt(current) : 'Другое',
        timeInput('chip-input', current, `${label}: другое время`, pick)));
  }

  function yesterdayCard(y) {
    if (y < S.createdAt) return null;
    const { plan, k, n } = D.progress(S, y, today);
    // Закрыл вчера, пока список раскрыт, — карточка остаётся и показывает итог.
    if (!n || (k === n && !ui.yOpen)) return null;
    const done = D.doneOf(S, y);
    return h('section', { key: 'yesterday', class: 'group yesterday', 'data-flip': '' },
      h('button', { key: 'head', class: 'row', 'aria-expanded': pressed(ui.yOpen), onclick: toggleYesterday },
        tile(k === n ? 'checklist' : 'clock', k === n ? 'green' : 'gray'),
        txt(`Вчера: ${k} из ${n}`, k === n ? 'день закрыт' : `доотметить можно до${NB}${D.DAY_START_HOUR}:00`), chev(ui.yOpen)),
      ui.yOpen && plan.map(id => D.findItem(S, id)).filter(Boolean).map(it => itemRow(it, done.includes(it.id), y, '')));
  }

  function toggleYesterday() {
    if (!ui.yOpen) {
      ui.yOpen = true;
      return render();
    }
    leave([...root.querySelectorAll('.yesterday .row[aria-pressed]')], () => {
      ui.yOpen = false;
      render();
    });
  }

  // ---------- листы

  function sheetView() {
    const sh = ui.sheet;
    const cancel = h('button', { class: 'sheet-act', onclick: () => closeSheet() }, 'Отмена');
    let titleText, left = cancel, right = null, body;
    if (sh.kind === 'review') {
      titleText = 'Итоги недели';
      body = reviewSheet(sh);
    } else if (sh.kind === 'rules') {
      titleText = 'Правила';
      left = h('span');
      right = h('button', { class: 'sheet-act right', onclick: () => closeSheet() }, 'Готово');
      body = rulesSheet();
    } else if (sh.kind === 'day') {
      titleText = `${cap(WEEKDAYS[D.weekday(sh.date)])}, ${dm(sh.date)}`;
      left = h('span');
      right = h('button', { class: 'sheet-act right', onclick: () => closeSheet() }, 'Готово');
      body = daySheet(sh);
    } else {
      titleText = sh.id ? (sh.weekly ? 'Счётчик' : 'Пункт') : sh.weekly ? 'Новый счётчик' : 'Новый пункт';
      right = h('button', { class: 'sheet-act right', id: 'sheet-done', disabled: !sh.draft.name.trim(), onclick: () => saveItem(sh) }, 'Готово');
      body = itemSheet(sh);
    }
    return h('div', {
      key: `sheet-${sh.kind}-${sh.id || sh.date || sh.monday || ''}`, class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': titleText,
      'data-enter': 'sheet', inert: closing,
    },
    h('div', { class: 'sheet-back', onclick: () => guardDirty() || closeSheet() }),
    h('div', { class: 'sheet-panel', tabindex: '-1' },
      h('div', { class: 'grabber', 'aria-hidden': 'true' }),
      h('header', { class: 'sheet-head' }, left, h('h2', { class: 'sheet-title' }, titleText), right || h('span')),
      body));
  }

  function openSheet(sheet) {
    if (closing) return;
    ui.alert = null;
    ui.sheet = sheet;
    render();
  }

  function openReview(monday) {
    openSheet({ kind: 'review', monday, choice: null, draft: { good: '', bad: '', learned: '', notesDone: false, improvement: '' } });
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
    const optSub = o => o.choice === 'keep'
      ? `отбой ${o.to} ещё на неделю`
      : `отбой ${o.to}` + (phone ? ` · ${lcFirst(phone.name)} до${NB}${D.deadline(o.to, phone.beforeBed)}` : '');
    const footer = opt
      ? opt.to === p.from
        ? `Отбой остаётся ${p.from}.`
        : `Со следующей ночи отбой ${opt.to}.` + (phone ? ` Передвинь сигнал «${phone.name}» на${NB}${D.deadline(opt.to, phone.beforeBed)}.` : '')
      : p.fewData ? 'Мало данных — шаг пока оставляем: выбери «Оставить», чтобы закрыть неделю.' : `Выбор нужен, чтобы закрыть неделю. Цель — ${S.sleep.goalBed}.`;
    return [
      h('p', { key: 'range', class: 'sheet-sub' }, weekRange(W)),
      h('section', { key: 'week', class: 'group rv-card first' },
        h('div', { class: 'week-rings' }, sum.days.map((d, i) => h('div', { key: d, class: 'wr-day' },
          h('span', { class: 'wr-label', 'aria-hidden': 'true' }, WDL[i]), miniRings(D.dayRings(S, d, today), w, cap(WEEKDAYS[i]))))),
        h('div', { class: 'sc-sep' }),
        h('div', { class: 'stats' },
          stat(`${sum.closed} из ${sum.total}`, 'дней закрыто'),
          stat(String(D.history(S, today).streak), 'серия'),
          w && stat(`${wc} из ${w.perWeek}`, lcFirst(w.name)))),
      sum.missingNights.length > 0 && [
        secH('h-nights', 'Ночи по памяти'),
        h('div', { key: 'nights', class: 'stack stack-tight', 'data-flip': '' }, sum.missingNights.map(d => h('section', { key: d, class: 'group sleep-card', 'data-flip': '' },
          h('p', { class: 'night-date' }, `${WD[D.weekday(d)]}, ${dm(d)}`), nightEditor(d, false)))),
      ],
      secH('h-step', 'Сон · шаг отбоя'),
      h('section', { key: 'step', class: 'group', 'data-flip': '' },
        h('p', { class: 'rv-line' }, p.atGoal
          ? [h('b', {}, `Цель достигнута, держим ${S.sleep.goalBed}`), h('span', { class: 't2' }, ` · в цель ${sum.K} из ${sum.mornings.length}`)]
          : [h('b', {}, `В цель ${sum.K} из ${sum.mornings.length}`),
            sum.avgBed && h('span', { class: 't2' }, ` · отбой в среднем ${sum.avgBed}`),
            sum.avgDur && h('span', { class: 't2' }, ` · сон ${dur(sum.avgDur)}`)]),
        p.options.map(o => h('button', {
          key: o.choice, class: 'opt' + (o.choice === p.recommended ? ' rec' : ''), 'aria-pressed': pressed(o.choice === sh.choice),
          onclick: () => { sh.choice = o.choice; M.haptic(); render(); },
        }, h('span', { class: 'txt' },
          h('span', { class: 'opt-title' }, h('span', {}, CHOICE[o.choice]), o.choice === p.recommended && h('span', { class: 'rec-pill' }, 'рекомендовано')),
          h('span', { class: 'note' }, optSub(o))),
        o.choice === sh.choice && h('span', { key: 'tick', class: 'tick-wrap', 'data-enter': 'pop' }, gl(G.tick, 'tick'))))),
      h('p', { key: 'step-foot', class: 'sec-foot', 'data-flip': '' }, footer),
      secH('h-talk', 'Разбор'),
      h('section', { key: 'talk', class: 'group', 'data-flip': '' }, area('Что получилось?', 'good'), area('Что не получилось?', 'bad'), area('Чему научился?', 'learned')),
      h('section', { key: 'notes', class: 'group group-gap', 'data-flip': '' }, h('button', {
        class: 'switch-row', role: 'switch', 'aria-checked': pressed(dr.notesDone),
        onclick: () => { dr.notesDone = !dr.notesDone; M.haptic(); render(); },
      }, txt('Notes разобраны', 'каждой строке — одно действие в Напоминания или вычеркнуть'), h('span', { class: 'switch', 'aria-hidden': 'true' }))),
      secH('h-pct', '1% на следующую неделю'),
      h('section', { key: 'pct', class: 'group pct-card', 'data-flip': '' },
        h('input', {
          class: 'one-input', value: dr.improvement, maxlength: 500, placeholder: 'Одно маленькое улучшение',
          'aria-label': '1% на следующую неделю', oninput: e => (dr.improvement = e.target.value),
        }),
        h('div', { class: 'chips' }, HINTS.map(t => h('button', {
          key: t, class: 'chip chip-hint', 'aria-pressed': pressed(dr.improvement === t), onclick: () => { dr.improvement = t; render(); },
        }, t)))),
      h('button', {
        key: 'close-week', class: 'btn-primary', disabled: !opt, 'data-flip': '',
        onclick: () => {
          if (closing || stale() || !D.closeWeek(S, W, dr, sh.choice, today, now().toISOString())) return;
          save();
          M.haptic();
          closeSheet(() => toast('Неделя закрыта'));
        },
      }, 'Закрыть неделю'),
    ];
  }

  function rulesSheet() {
    return h('section', { key: 'rules', class: 'group rules-list first', 'data-stagger': 'rise', 'data-step': '45' }, RULES.map((r, i) =>
      h('div', { class: 'row' }, h('span', { class: 'rule-n' }, String(i + 1)), h('span', { class: 'txt' }, h('span', { class: 'name' }, r)))));
  }

  // День из истории: кольца, пункты (вчера и сегодня — можно отметить), ночь и недельный счётчик.
  function openDay(date) {
    openSheet({ kind: 'day', date });
  }

  function daySheet(sh) {
    const d = sh.date;
    const { marks } = D.history(S, today);
    const mark = d === today ? (D.status(S, d, today) === 'closed' ? 'closed' : 'pending') : marks[d] || 'none';
    const { plan, k, n } = D.progress(S, d, today);
    const done = D.doneOf(S, d);
    const editable = D.canEdit(S, d, today);
    const r = D.dayRings(S, d, today);
    const w = D.firstWeekly(S);
    const night = S.sleep.nights[d];
    const items = plan.map(id => D.findItem(S, id)).filter(Boolean);
    let sleepText = 'Сон не отмечен';
    if (night?.bed) {
      const late = D.norm(night.bed) - D.norm(D.targetFor(S, d)), du = D.duration(night);
      sleepText = `Лёг ${night.bed}${night.wake ? ` · встал ${clock(night.wake)}` : ''}${du ? ` · ${dur(du)}` : ''} · ${late > 0 ? `на${NB}${dur(late)} позже шага` : 'в цель'}`;
    }
    return [
      h('p', { key: 'status', class: 'sheet-sub day-status ds-' + mark }, `${DAY_STATUS[mark]} · ${k} из ${n}`),
      h('section', { key: 'day', class: 'group day-hero first', 'data-flip': '' },
        rings('day-rings', 96, [41, 28.5, 16], 10, [
          { kind: 'sun', f: r.min }, { kind: 'sleep', f: r.sleep ? 1 : 0 }, w && { kind: 'train', f: r.week ? 1 : 0 },
        ].filter(Boolean), `Минимум ${k} из ${n}`),
        h('div', { class: 'day-info' },
          h('p', { class: 'lg' }, h('span', { class: 'lg-dot min' }), h('span', {}, `Минимум ${k} из ${n}`)),
          h('p', { class: 'lg' }, h('span', { class: 'lg-dot' }), h('span', {}, sleepText)),
          w && h('p', { class: 'lg' }, h('span', { class: 'lg-dot train' }), h('span', {}, `${w.name}: ${r.week ? 'была' : 'не было'}`)))),
      secH('h-day-items', editable ? 'Пункты · можно отметить' : 'Пункты'),
      h('section', { key: 'day-items', class: 'group list-day', 'data-flip': '' }, items.length ? items.map(it => editable
        ? h('button', { key: it.id, class: 'row' + (done.includes(it.id) ? ' done' : ''), style: tint(it.color), 'aria-pressed': pressed(done.includes(it.id)), onclick: () => toggle(d, it.id) },
          tile(it.icon), txt(it.name, it.note), h('span', { class: 'check' }, gl(G.check, '', 1)))
        : h('div', { key: it.id, class: 'row' + (done.includes(it.id) ? ' done' : ' missed'), style: tint(it.color) },
          tile(it.icon), txt(it.name, it.note), h('span', { class: 'check', role: 'img', 'aria-label': done.includes(it.id) ? 'сделано' : 'не сделано' }, gl(G.check, '', 1))))
        : h('p', { class: 'empty' }, 'В этот день минимума ещё не было')),
    ];
  }

  function openItem(id, weekly) {
    const it = id && D.findItem(S, id);
    const draft = it
      ? { icon: it.icon, name: it.name, note: it.note, color: it.color, beforeBed: it.beforeBed ?? null, perWeek: it.perWeek ?? 3 }
      : { icon: 'star', name: '', note: '', color: D.DEFAULT_COLOR, beforeBed: null, perWeek: 3 };
    openSheet({ kind: 'item', id, weekly: !!weekly, draft, orig: JSON.stringify(draft), icons: !id });
  }

  function itemSheet(sh) {
    const d = sh.draft;
    const set = (k, v) => {
      d[k] = v;
      M.haptic();
      render();
      if (k === 'icon' || k === 'color') M.anim(root.querySelector('.preview .tile'), [{ transform: 'scale(0.82)' }, { transform: 'none' }], { duration: 460, easing: EASE.spring });
    };
    const step = D.stepTonight(S, today);
    const placeholder = sh.weekly ? 'Новый счётчик' : 'Новый пункт';
    const onText = (k, sel, fallback) => e => {
      d[k] = e.target.value;
      // Без перерисовки: меняются только превью и «Готово».
      const pv = root.querySelector(sel);
      if (pv) pv.textContent = d[k].trim() || fallback;
      const ok = root.querySelector('#sheet-done');
      if (ok) ok.disabled = !d.name.trim();
    };
    const mins = [...new Set([...BEFORE, ...(d.beforeBed != null ? [+d.beforeBed] : [])])].sort((a, b) => a - b);
    const st = sh.id ? D.itemStats(S, sh.id, today) : null;
    return [
      h('div', { key: 'preview', class: 'preview', style: tint(d.color) },
        h('span', { class: 'tile' }, icon(d.icon)),
        h('p', { class: 'pv-name' }, d.name.trim() || placeholder),
        h('p', { class: 'pv-note' }, d.note.trim() || 'когда / после чего')),
      st && itemStatsView(st, sh),
      h('section', { key: 'form', class: 'group group-gap-l', 'data-flip': '' },
        h('label', { class: 'form-row' }, h('span', { class: 'form-label' }, 'Название'),
          h('input', { class: 'form-input', name: 'name', value: d.name, maxlength: 60, placeholder: 'например, Растяжка', oninput: onText('name', '.pv-name', placeholder) })),
        h('label', { class: 'form-row' }, h('span', { class: 'form-label' }, 'Подпись'),
          h('input', { class: 'form-input', name: 'note', value: d.note, maxlength: 120, placeholder: 'когда / после чего', oninput: onText('note', '.pv-note', 'когда / после чего') }))),
      secH('h-color', 'Цвет'),
      h('section', { key: 'colors', class: 'group swatches', role: 'group', 'aria-label': 'Цвет', 'data-flip': '' }, D.COLORS.map(c => h('button', {
        key: c, class: 'swatch', style: tint(c), 'aria-label': COLOR_NAMES[c], 'aria-pressed': pressed(d.color === c), onclick: () => set('color', c),
      }))),
      secH('h-icon', `Значок · ${ICON_GROUPS.reduce((a, g) => a + g[1].length, 0)}`),
      sh.icons
        ? h('section', { key: 'icons', class: 'group icons', style: tint(d.color), 'data-flip': '' }, ICON_GROUPS.map(([name, ids]) => [
          h('p', { class: 'ig-title' }, name),
          h('div', { class: 'ig-row', role: 'group', 'aria-label': name }, ids.map(id => h('button', {
            key: id, class: 'ig-btn', 'aria-label': ICONS[id][0], 'aria-pressed': pressed(d.icon === id), onclick: () => set('icon', id),
          }, icon(id)))),
        ]))
        : h('section', { key: 'icon-row', class: 'group', 'data-flip': '' }, h('button', {
          class: 'row row-s', style: tint(d.color), 'aria-expanded': 'false', onclick: () => { sh.icons = true; render(); },
        }, tile(d.icon), txt(cap((ICONS[d.icon] || ICONS.star)[0])), h('span', { class: 'value' }, 'Сменить'), chev())),
      sh.weekly
        ? [secH('h-per', 'Раз в неделю'), h('section', { key: 'per', class: 'group sub-block sub-first', 'data-flip': '' }, h('div', { class: 'chips' }, [1, 2, 3, 4, 5, 6, 7].map(n =>
          h('button', { key: n, class: 'chip', 'aria-pressed': pressed(+d.perWeek === n), onclick: () => set('perWeek', n) }, String(n)))))]
        : h('section', { key: 'bed', class: 'group group-gap-l', 'data-flip': '' },
          h('button', {
            class: 'switch-row', role: 'switch', 'aria-checked': pressed(d.beforeBed != null),
            onclick: () => set('beforeBed', d.beforeBed != null ? null : 30),
          }, txt('Привязать к отбою', d.beforeBed != null
            ? `подпись дополнится временем: «до${NB}${D.deadline(step, +d.beforeBed)}»`
            : 'для пунктов вроде «Телефон на кухню»'), h('span', { class: 'switch', 'aria-hidden': 'true' })),
          d.beforeBed != null && h('div', { key: 'mins', class: 'sub-block', 'data-flip': '' },
            h('span', { class: 'field-label' }, 'За сколько до отбоя'),
            h('div', { class: 'chips' }, mins.map(m => h('button', {
              key: m, class: 'chip', 'aria-pressed': pressed(+d.beforeBed === m), onclick: () => set('beforeBed', m),
            }, m % 60 === 0 ? `${m / 60}${NB}ч` : `${m}${NB}мин`))))),
      sh.id && h('section', { key: 'remove', class: 'group group-gap-l', 'data-flip': '' }, h('button', { class: 'row row-t row-danger', onclick: () => removeItem(sh) },
        sh.weekly ? 'Убрать из недельных' : 'Убрать из минимума')),
    ];
  }

  // Детали пункта: серия, рекорд, доля и 6 недель клеток цвета пункта; у счётчика — недели в цель.
  function itemStatsView(st, sh) {
    if (st.weekly) {
      const mon = D.weekStart(today);
      return h('section', { key: 'stats', class: 'group rv-card group-gap-l', 'data-flip': '' },
        h('div', { class: 'stats' },
          stat(`${st.thisWeek} из ${sh.draft.perWeek}`, 'эта неделя'),
          stat(st.pastWeeks ? `${st.goalWeeks} из ${st.pastWeeks}` : '—', 'недель в цель')),
        w8(st.weeks, +sh.draft.perWeek, mon));
    }
    return h('section', { key: 'stats', class: 'group rv-card group-gap-l', 'data-flip': '' },
      h('div', { class: 'stats' },
        stat(String(st.streak), `${plural(st.streak, ['день', 'дня', 'дней'])} подряд`),
        stat(String(st.best), 'рекорд'),
        stat(st.rate == null ? '—' : `${Math.round(st.rate * 100)}%`, 'за 4 недели')),
      h('div', { class: 'heat-wd', 'aria-hidden': 'true' }, WDL.map(l => h('span', {}, l))),
      h('div', { class: 'heat', style: tint(sh.draft.color), role: 'img', 'aria-label': `6 недель: сделано ${st.cells.filter(c => c.st === 'done').length} дней`, 'data-stagger': 'pop', 'data-step': '14' },
        st.cells.map((c, i) => h('span', { class: `hc hc-${c.st}` + (c.date === today ? ' hc-today' : ''), 'data-d': String((i % 7) + Math.floor(i / 7)) }))),
      h('div', { class: 'heat-legend' },
        h('span', {}, h('i', { class: 'hc hc-done', style: tint(sh.draft.color) }), 'сделано'),
        h('span', {}, h('i', { class: 'hc hc-miss' }), 'пропуск'),
        h('span', {}, h('i', { class: 'hc hc-off' }), 'не было в плане')));
  }

  function saveItem(sh) {
    if (closing || !D.cleanFields(sh.draft, sh.weekly)) return;
    if (sh.id) D.updateItem(S, sh.id, sh.draft);
    else D.addItem(S, sh.draft, sh.weekly, today);
    save();
    M.haptic();
    closeSheet();
  }

  function removeItem(sh) {
    const it = D.findItem(S, sh.id);
    showAlert({
      title: `Убрать «${it.name}»?`, msg: 'Прошлые дни не изменятся. Вернуть можно в Настройках, в разделе «Убранные».',
      yes: 'Убрать', danger: true,
      action: () => {
        D.archiveItem(S, sh.id, today);
        save();
        closeSheet();
      },
    });
  }

  function alertView() {
    const a = ui.alert;
    return h('div', {
      key: 'alert', class: 'alert', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'alert-title',
      'aria-describedby': a.msg ? 'alert-msg' : null, 'data-enter': 'alert', inert: !!ui.alertClosing,
    },
    h('div', { class: 'alert-box', tabindex: '-1' },
      h('div', { class: 'alert-body' }, h('p', { class: 'alert-title', id: 'alert-title' }, a.title), a.msg && h('p', { class: 'alert-msg', id: 'alert-msg' }, a.msg)),
      h('div', { class: 'alert-btns' },
        h('button', { class: 'alert-btn', onclick: () => closeAlert() }, 'Отмена'),
        h('button', { class: 'alert-btn' + (a.danger ? ' danger' : ''), onclick: () => { M.haptic(); closeAlert(a.action); } }, a.yes))));
  }

  // ---------- Прогресс

  function progressScreen() {
    const { streak, best, marks } = D.history(S, today);
    const total = D.diffDays(S.since, today) + 1;
    const w = D.firstWeekly(S);
    const weekly = S.weekly.filter(i => !i.archivedAt);
    const mon = D.weekStart(today);
    const revs = Object.keys(S.reviews).sort().reverse();
    return [
      topbar(h('p', { class: 'overline' }, `В системе с ${dm(S.since)} · ${days(total)}`), h('span', {}, 'Прогресс'), null),
      title('Прогресс'),
      h('section', { key: 'streak', class: 'hero hero-streak', 'data-flip': '' },
        h('div', { class: 'streak-hero' },
          h('div', {},
            h('p', { class: 'sh-over' }, 'СЕРИЯ'),
            h('p', { class: 'sh-num' }, h('span', { class: 'big', 'data-count': String(streak) }, String(streak)),
              h('span', { class: 'unit' }, `${plural(streak, ['день', 'дня', 'дней'])} подряд`))),
          h('p', { class: 'sh-rec' }, h('span', { class: 't2' }, 'рекорд'), h('b', {}, String(best)))),
        chain(marks),
        h('div', { class: 'chain-legend' },
          h('span', {}, h('i', { class: 'lsq closed' }), 'закрыт'), h('span', {}, h('i', { class: 'lsq forgiven' }), 'прощён'),
          h('span', {}, h('i', { class: 'lsq break' }), 'разрыв'), h('span', {}, h('i', { class: 'lsq today' }), 'сегодня')),
        h('p', { class: 'rule' }, 'Один пропуск прощается, два подряд — серия с нуля. Тапни день — увидишь детали.')),
      secH('h-week', 'Эта неделя'),
      h('section', { key: 'week', class: 'group rv-card', 'data-flip': '' },
        h('div', { class: 'week-rings', 'data-reveal': '' }, D.range(mon, D.addDays(mon, 6)).map((d, i) => {
          const tap = d <= today && d >= S.createdAt;
          const kids = [h('span', { class: 'wr-label' + (d === today ? ' today' : ''), 'aria-hidden': 'true' }, WDL[i]), miniRings(D.dayRings(S, d, today), w, cap(WEEKDAYS[i]))];
          return tap ? h('button', { key: d, class: 'wr-day', onclick: () => openDay(d) }, kids) : h('div', { key: d, class: 'wr-day' }, kids);
        })),
        h('div', { class: 'dots-legend' },
          h('span', {}, h('i', { class: 'lg-dot min' }), 'минимум'), h('span', {}, h('i', { class: 'lg-dot' }), 'сон в цель'),
          w && h('span', {}, h('i', { class: 'lg-dot train' }), lcFirst(w.name)))),
      secH('h-sleep', `Сон · 14${NB}ночей`),
      sleepSection(),
      secH('h-rates', 'Пункты · 4 недели'),
      h('section', { key: 'rates', class: 'group rates', 'data-flip': '', 'data-reveal': '', 'data-stagger': 'grow-x', 'data-stagger-sel': '.rate-fill', 'data-step': '50' },
        D.itemRates(S, today).map(r => h('button', { key: r.item.id, class: 'rate', style: tint(r.item.color), onclick: () => openItem(r.item.id, false) },
          tile(r.item.icon), h('span', { class: 'rate-name' }, r.item.name),
          h('span', { class: 'rate-bar' }, h('span', { class: 'rate-fill', style: `--p:${r.rate ?? 0}` })),
          h('span', { class: 'rate-val' }, r.rate == null ? '—' : `${Math.round(r.rate * 100)}%`)))),
      weekly.map(it => [secH(`h-w8-${it.id}`, `${it.name} · 8 недель`),
        h('section', { key: `w8-${it.id}`, class: 'group rv-card', 'data-flip': '' },
          w8(Array.from({ length: 8 }, (_, i) => D.addDays(mon, -7 * (7 - i))).map(wk => ({ monday: wk, count: D.weekCount(S, it.id, wk) })), it.perWeek, mon))]),
      secH('h-revs', 'Недели'),
      h('section', { key: 'revs', class: 'group', 'data-flip': '' }, revs.length ? revs.map(m => {
        const r = S.reviews[m];
        const open = ui.revOpen.has(m);
        const sl = r.sleep.to && r.sleep.to !== r.sleep.from ? `отбой ${r.sleep.from} → ${r.sleep.to}` : `отбой ${r.sleep.from || '—'} — оставили`;
        const parts = [['Получилось', r.good], ['Не получилось', r.bad], ['Научился', r.learned]].filter(x => x[1]);
        return [
          h('button', {
            key: m, class: 'row row-s row-plain', 'aria-expanded': pressed(open),
            onclick: () => { if (open) ui.revOpen.delete(m); else ui.revOpen.add(m); render(); },
          }, txt(weekRange(m), sl + (r.improvement ? ` · 1%: ${r.improvement}` : '')), chev(open)),
          open && h('div', { key: `${m}-drawer`, class: 'drawer drawer-plain', 'data-flip': '' },
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
      h('div', { class: 'chain', role: 'group', 'aria-label': `Цепь дней за ${rows} недель`, 'data-stagger': 'pop', 'data-step': '24' },
        D.range(start, D.addDays(D.weekStart(today), 6)).map((d, i) => {
          const m = d > today ? 'future' : marks[d] || 'none';
          const attrs = {
            key: d, class: `cell ${m}` + (d === today ? ' today' : ''), 'data-d': String((i % 7) + Math.floor(i / 7)),
            style: m === 'closed' ? `--col:${i % 7};--row:${Math.floor(i / 7)};--rows:${rows}` : null,
          };
          return d <= today && d >= S.createdAt
            ? h('button', { ...attrs, 'aria-label': `${cap(WEEKDAYS[i % 7])}, ${dm(d)}: ${CELL[m]}`, onclick: () => openDay(d) })
            : h('span', { ...attrs, 'aria-hidden': 'true' });
        })));
  }

  function w8(weeks, perWeek, mon) {
    return h('div', { class: 'w8', 'data-reveal': '', 'data-stagger': 'pop', 'data-stagger-sel': '.w8-cell.on', 'data-step': '40' }, weeks.map(({ monday, count }) =>
      h('div', { key: monday, class: 'w8-col' },
        h('div', { class: 'w8-cells', role: 'img', 'aria-label': `${count} из ${perWeek}` }, Array.from({ length: Math.min(7, Math.max(perWeek, count)) }, (_, k) =>
          h('span', { class: 'w8-cell' + (k < count ? ' on' : '') }))),
        h('span', { class: 'w8-label' + (monday === mon ? ' now' : '') }, `${+monday.slice(8)}.${+monday.slice(5, 7)}`))));
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
    const sel = ui.chartSel && S.sleep.nights[ui.chartSel]?.bed ? ui.chartSel : null;
    return h('section', { key: 'sleep', class: 'group rv-card', 'data-flip': '' },
      h('div', { class: 'chart-box', 'data-reveal': '', 'data-stagger': 'grow-y', 'data-stagger-sel': '.bar', 'data-step': '35' }, sleepChart(sel)),
      sel ? nightCaption(sel) : h('div', { key: 'legend', class: 'chart-legend' },
        h('span', {}, h('i', { class: 'cl-ok' }), 'в цель'), h('span', {}, h('i', { class: 'cl-late' }), 'позже'),
        h('span', {}, h('i', { class: 'cl-step' }), 'шаг отбоя'), h('span', {}, h('i', { class: 'cl-goal' }), S.sleep.goalBed)),
      h('div', { class: 'sc-sep' }),
      h('div', { class: 'stats' },
        stat(a.avgBed || '—', 'средний отбой'),
        stat(a.avgDur != null ? dur(a.avgDur) : '—', 'сон в среднем'),
        stat(hits.n ? `${hits.k} из ${hits.n}` : '—', 'в цель')),
      delta.length > 0 && h('p', { class: 'delta' }, `7 ночей к прошлым 7: ${delta.join(', ')}`));
  }

  function nightCaption(d) {
    const n = S.sleep.nights[d], late = D.norm(n.bed) - D.norm(D.targetFor(S, d)), du = D.duration(n);
    return h('button', { key: 'cap', class: 'strip chart-cap', 'data-flip': '', onclick: () => { ui.chartSel = null; render(); } },
      gl(ICONS.moon[1]), h('span', {}, h('b', {}, `${WD[D.weekday(d)]}, ${dm(d)}`),
        h('span', { class: 't2' }, ` · ${n.bed}${n.wake ? ` → ${clock(n.wake)}` : ''}${du ? ` · ${dur(du)}` : ''} · ${late > 0 ? `на${NB}${dur(late)} позже шага` : 'в цель'}`)));
  }

  function sleepChart(sel) {
    const range = D.range(D.addDays(today, -13), today);
    const W = 364, H = 236, L = 44, Y0 = 1380, K = 3, OFF = 8; // 23:00 сверху, 3 минуты на единицу
    const slot = (W - L) / range.length, bw = 10;
    const y = m => Math.max(0, Math.min(H, (m - Y0) / K + OFF));
    const steps = [];
    range.forEach((d, i) => {
      if (d < S.createdAt) return; // до посева шага ещё не было
      const t = D.targetFor(S, d), last = steps.at(-1);
      if (last && last.t === t && last.to === i) last.to = i + 1;
      else steps.push({ t, from: i, to: i + 1 });
    });
    const pick = d => () => {
      ui.chartSel = ui.chartSel === d ? null : d;
      M.haptic();
      render();
    };
    return svg('svg', { class: 'chart' + (sel ? ' has-sel' : ''), viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Сон за 14 ночей' },
      ['23:00', '01:00', '03:00', '05:00', '07:00', '09:00'].map(t => {
        const yy = y(D.norm(t));
        return [svg('line', { class: 'grid', x1: L, x2: W, y1: yy, y2: yy }), svg('text', { class: 'axis', x: 0, y: yy + 4 }, t)];
      }),
      svg('line', { class: 'goal', x1: L, x2: W, y1: y(D.norm(S.sleep.goalBed)), y2: y(D.norm(S.sleep.goalBed)) }),
      range.map((d, i) => {
        const n = S.sleep.nights[d];
        if (!n?.bed) return null;
        const cls = 'bar ' + (D.onTarget(S, d) ? 'bar-ok' : 'bar-late') + (d === sel ? ' sel' : '');
        const x = L + slot * i + (slot - bw) / 2, top = y(D.norm(n.bed));
        if (!n.wake) return svg('circle', { key: d, class: cls, cx: x + bw / 2, cy: top + bw / 2, r: bw / 2 });
        const bottom = y(D.toMin(n.wake) + 1440);
        return svg('rect', { key: d, class: cls, x, y: top, width: bw, height: Math.max(bw, bottom - top), rx: bw / 2 });
      }),
      steps.map(s => svg('line', { class: 'step', x1: L + slot * s.from + 2, x2: L + slot * s.to - 2, y1: y(D.norm(s.t)), y2: y(D.norm(s.t)) })),
      range.map((d, i) => S.sleep.nights[d]?.bed && svg('rect', { key: `hit-${d}`, class: 'hit', x: L + slot * i, y: 0, width: slot, height: H, onclick: pick(d) })));
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
    const go = () => {
      D.restoreItem(S, it.id);
      M.haptic();
      commit();
    };
    if (S.items.includes(it) && D.activeItems(S).length >= D.MAX_DAILY) {
      showAlert({ title: tooMany(), msg: 'Минимум должен выполняться в худший день. Всё равно вернуть?', yes: 'Вернуть', action: go });
    } else go();
  }

  function listRows(list, weekly) {
    const act = list.filter(i => !i.archivedAt);
    const move = (id, dir) => {
      D.moveItem(S, id, dir);
      M.haptic();
      commit();
    };
    return act.map((it, i) => {
      const sub = weekly ? null : [it.note, it.beforeBed && `за${NB}${it.beforeBed}${NB}мин до${NB}отбоя`].filter(Boolean).join(' · ');
      const value = weekly && h('span', { class: 'value' }, `${it.perWeek}${NB}${plural(it.perWeek, ['раз', 'раза', 'раз'])}`);
      if (ui.edit) {
        return h('div', { key: it.id, class: 'row row-s', style: tint(it.color), 'data-flip': '' }, tile(it.icon), txt(it.name, sub), value,
          h('span', { class: 'up-down' },
            h('button', { class: 'icon-btn', 'aria-label': `${it.name}: выше`, disabled: i === 0, onclick: () => move(it.id, -1) }, gl(G.up)),
            h('button', { class: 'icon-btn', 'aria-label': `${it.name}: ниже`, disabled: i === act.length - 1, onclick: () => move(it.id, 1) }, gl(G.down))));
      }
      return h('button', { key: it.id, class: 'row row-s', style: tint(it.color), 'data-flip': '', onclick: () => openItem(it.id, weekly) },
        tile(it.icon), txt(it.name, sub), value, chev());
    });
  }

  const addRow = weekly => h('button', { key: 'add', class: 'row row-m plus-row', 'data-flip': '', onclick: () => tryAdd(weekly) },
    h('span', { class: 'tile tile-round' }, gl(G.plus)), h('span', { class: 'name' }, weekly ? 'Добавить счётчик' : 'Добавить пункт'));

  function timeRow(d, name, note, value, fmt, onSet) {
    return h('label', { key: name, class: 'row row-s time-row', style: tint('indigo') },
      h('span', { class: 'tile' }, gl(d)), txt(name, note), h('span', { class: 'value roll', 'data-roll': '' }, fmt(value)), chev(),
      timeInput('time-input', value, name, v => {
        onSet(v);
        M.haptic();
        commit();
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
      // В файле — уже сегодняшняя дата копии: импорт этого файла вернёт и её.
      const how = await shareOrDownload(win, { ...S, ui: { ...S.ui, lastExport: today } }, today);
      if (how !== 'cancelled') {
        S.ui.lastExport = today;
        save();
      }
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
    const exp = S.ui.lastExport;
    const old = exp ? D.diffDays(exp, today) >= 14 : D.diffDays(S.createdAt, today) >= 7;
    return [
      topbar(null, h('span', {}, 'Настройки'), canEdit && h('button', {
        class: 'head-action' + (ui.edit ? ' on' : ''), onclick: () => { ui.edit = !ui.edit; render(); },
      }, ui.edit ? 'Готово' : 'Изменить')),
      title('Настройки'),
      secH('h-items', `Минимум · ${act.length}`),
      h('section', { key: 'items', class: 'group', 'data-flip': '' }, listRows(S.items, false), !ui.edit && addRow(false)),
      h('p', { key: 'items-foot', class: 'sec-foot', 'data-flip': '' }, 'Минимум должен выполняться в худший день. На 11-м пункте приложение переспросит.'),
      arch.length > 0 && [secH('h-arch', 'Убранные'), h('section', { key: 'arch', class: 'group', 'data-flip': '' }, arch.map(it => h('div', {
        key: it.id, class: 'row row-s archived', style: tint(it.color), 'data-flip': '',
      }, tile(it.icon), txt(it.name, S.weekly.includes(it) ? 'каждую неделю' : it.note),
      h('button', { class: 'restore', 'aria-label': `Вернуть «${it.name}»`, onclick: () => restore(it) }, 'Вернуть'))))],
      secH('h-weekly', 'Каждую неделю'),
      h('section', { key: 'weekly', class: 'group', 'data-flip': '' }, listRows(S.weekly, true), !ui.edit && addRow(true)),
      secH('h-sleep', 'Сон'),
      h('section', { key: 'sleep', class: 'group', 'data-flip': '' },
        timeRow(ICONS.moon[1], 'Цель отбоя', null, S.sleep.goalBed, t => t, v => (S.sleep.goalBed = v)),
        timeRow(ICONS.alarm[1], 'Подъём', null, S.sleep.goalWake, clock, v => (S.sleep.goalWake = v)),
        timeRow(G.stairs, 'Текущий шаг', 'меняется на итогах недели', D.stepTonight(S, today), t => t, v => D.setStep(S, v, today))),
      secH('h-sys', 'Система'),
      h('section', { key: 'sys', class: 'group', 'data-flip': '' }, h('button', {
        class: 'row row-s', style: tint('gray'), onclick: () => openSheet({ kind: 'rules' }),
      }, tile('checklist'), txt('Правила'), chev())),
      secH('h-data', 'Данные'),
      h('section', { key: 'data', class: 'group', 'data-flip': '' },
        h('button', { class: 'row row-t row-accent', onclick: doExport }, h('span', { class: 'txt' }, 'Экспорт в файл'),
          h('span', { class: 'value' + (old ? ' warn' : '') }, exp ? ago(exp, today) : 'ещё не было')),
        h('label', { class: 'row row-t row-accent' }, 'Импорт из файла',
          h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden-input', onchange: doImport })),
        h('button', { class: 'row row-t row-danger', onclick: askReset }, 'Сбросить к шаблону')),
      (ui.dataMsg || old) && h('p', { key: 'data-foot', class: 'sec-foot', role: 'status', 'data-flip': '' },
        ui.dataMsg || 'Данные живут только на этом телефоне — время сделать копию в файл.'),
      secH('h-about', 'О приложении'),
      h('section', { key: 'about', class: 'group', 'data-flip': '' },
        h('div', { class: 'row row-t' }, h('span', { class: 'txt' }, 'Версия'), h('span', { class: 'value' }, ui.version || '—')),
        h('button', { class: 'row row-t row-accent', onclick: checkUpdates }, 'Проверить обновления')),
      ui.updMsg && h('p', { key: 'upd-foot', class: 'sec-foot', role: 'status', 'data-flip': '' }, ui.updMsg),
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
    if (!reg) {
      ui.updMsg = 'Обновления недоступны';
      return render();
    }
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
      win.clearTimeout(tickTimer);
      return void store.flush();
    }
    // Вернулся: свежий день и отсчёт; раскрытая карточка ночи сворачивается в строку героя.
    if (ui.sleepOpen && !ui.sheet && !ui.alert) ui.sleepOpen = false;
    render();
    if (reg && Date.now() - lastCheck > UPDATE_EVERY) {
      lastCheck = Date.now();
      reg.update().catch(() => {});
    }
  });
  win.addEventListener('pagehide', () => store.flush());
  win.addEventListener('scroll', onScroll, { passive: true });
  doc.addEventListener('touchstart', () => {}, { passive: true }); // без слушателя iOS не показывает :active

  render();
  initSW();
  return { render, get state() { return S; } };
}

const COLOR_NAMES = {
  red: 'красный', orange: 'оранжевый', yellow: 'жёлтый', green: 'зелёный', mint: 'мятный', teal: 'бирюзовый',
  blue: 'синий', indigo: 'индиго', purple: 'фиолетовый', pink: 'розовый', brown: 'коричневый', gray: 'серый',
};
