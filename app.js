// Минимум v2 — интерфейс. Пользовательский текст попадает в разметку только текстовыми узлами.

import * as D from './domain.js';
import { createStore, requestPersist, shareOrDownload, parseImport } from './store.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WD = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const EMOJIS = ['🌅', '💪', '📖', '🎧', '🛋️', '🚿', '🖐️', '📱', '🏋️', '💧', '🧠', '✨'];
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
const CHOICE = { earlier30: 'Раньше на 30 мин', earlier15: 'Раньше на 15 мин', keep: 'Оставить', later15: 'Позже на 15 мин' };
const TABS = [['today', 'Сегодня'], ['progress', 'Прогресс'], ['settings', 'Настройки']];
const WELCOME = 'Новый минимум: 8 пунктов, одинаковых каждый день. Отбой — шагами от 01:00 к 23:30, решаешь на итогах недели. Старые данные стёрты.';
const UPDATE_EVERY = 10 * 60e3;

const dm = iso => `${+iso.slice(8)} ${MONTHS[+iso.slice(5, 7) - 1]}`;
const weekRange = mon => {
  const sun = D.addDays(mon, 6);
  return mon.slice(5, 7) === sun.slice(5, 7) ? `${+mon.slice(8)}–${dm(sun)}` : `${dm(mon)} – ${dm(sun)}`;
};
const dur = m => {
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} ч ${r} мин` : `${h} ч`) : `${r} мин`;
};
const plural = (n, [one, few, many]) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
const clock = t => t.replace(/^0(?=\d:)/, ''); // 07:30 → 7:30
const tint = c => `--item:var(--c-${c});--on-item:var(--on-${c})`;

export async function boot({ win = window, now = () => new Date(), idb = win.indexedDB } = {}) {
  const doc = win.document;
  const root = doc.getElementById('app');
  const ui = {
    tab: 'today', sheet: null, fresh: false, yOpen: false, sleepEdit: false, ask: null, resetArmed: false,
    dataMsg: '', updMsg: '', toast: '', celebrate: false, saveFailed: false, restored: false, update: false, version: '',
  };
  let S, today, reg = null, reloading = false, lastCheck = Date.now(), dayTimer, toastTimer;

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
  const checkIcon = () => svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svg('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }));
  const sec = (title, ...kids) => h('section', { class: 'sec' }, title && h('h2', { class: 'sec-title' }, title), kids);
  const emo = it => h('span', { class: 'emo', 'aria-hidden': 'true' }, it.emoji);
  const txt = (name, note) => h('span', { class: 'txt' }, h('span', { class: 'name' }, name), note && h('span', { class: 'note' }, note));
  const pressed = on => String(!!on);

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

  function render() {
    const day = D.logicalDate(now());
    if (today && day !== today) Object.assign(ui, { sleepEdit: false, yOpen: false });
    today = day;
    if (D.syncToday(S, today)) save();
    const panel = root.querySelector('.sheet-panel');
    const keep = panel && !ui.fresh ? panel.scrollTop : 0;
    const screen = ui.tab === 'today' ? todayScreen() : ui.tab === 'progress' ? progressScreen() : settingsScreen();
    root.replaceChildren(
      h('main', { class: 'screen', 'aria-hidden': ui.sheet ? 'true' : null }, screen),
      h('div', { class: 'bars' },
        ui.saveFailed && h('div', { class: 'bar bar-warn', role: 'alert' }, 'Не удалось сохранить — сделай экспорт в Настройках'),
        ui.update && h('button', { class: 'bar bar-update', onclick: applyUpdate }, 'Доступна новая версия · ', h('b', {}, 'Обновить')),
        ui.toast && h('div', { class: 'bar bar-toast', role: 'status' }, ui.toast)),
      h('nav', { class: 'tabbar', 'aria-label': 'Разделы' }, TABS.map(([id, label]) =>
        h('button', { class: 'tab', 'aria-current': ui.tab === id ? 'page' : null, onclick: () => openTab(id) }, label))),
      ui.sheet && sheetView(),
    );
    const np = root.querySelector('.sheet-panel');
    if (np) np.scrollTop = keep;
    doc.body.classList.toggle('locked', !!ui.sheet);
    ui.fresh = ui.celebrate = false;
    win.clearTimeout(dayTimer);
    dayTimer = win.setTimeout(render, D.msToNextDay(now()) + 1000);
  }

  function openTab(id) {
    Object.assign(ui, { tab: id, ask: null, resetArmed: false, dataMsg: '', updMsg: '', sleepEdit: false });
    render();
    doc.documentElement.scrollTop = 0;
  }

  // ---------- Сегодня

  function itemRow(it, done, onTap, extra) {
    return h('button', { class: 'row' + (done ? ' done' : ''), style: tint(it.color), 'aria-pressed': pressed(done), onclick: onTap },
      emo(it), txt(it.name, [it.note, extra].filter(Boolean).join(' · ')), h('span', { class: 'check' }, checkIcon()));
  }

  function toggle(date, id) {
    if (stale()) return;
    const was = D.status(S, today, today) === 'closed';
    if (!D.toggleDone(S, date, id, today)) return;
    ui.celebrate = date === today && !was && D.status(S, today, today) === 'closed';
    commit();
  }

  function todayScreen() {
    const { streak } = D.history(S, today);
    const { plan, k, n } = D.progress(S, today, today);
    const done = D.doneOf(S, today);
    const closed = n > 0 && k === n;
    const y = D.addDays(today, -1);
    const step = D.stepTonight(S, today), goal = S.sleep.goalBed, wake = clock(S.sleep.goalWake);
    const improvement = D.weekImprovement(S, today);
    const rv = D.pendingReview(S, today);
    const weekly = S.weekly.filter(i => !i.archivedAt);
    return [
      h('header', { class: 'head' },
        h('div', {}, h('p', { class: 'overline' }, WEEKDAYS[D.weekday(today)]), h('h1', { class: 'title' }, dm(today))),
        h('span', { class: 'streak', 'aria-label': `Серия ${streak}` }, `🔥 ${streak}`)),
      ui.restored && h('p', { class: 'notice' }, 'Данные восстановлены из резервной копии'),
      !S.ui.welcomeSeen && h('section', { class: 'card welcome' }, h('p', {}, WELCOME),
        h('button', { class: 'btn btn-primary', onclick: () => { S.ui.welcomeSeen = true; commit(); } }, 'Понятно')),
      n > 0 && h('section', { class: 'day' },
        h('p', { class: 'day-count' }, closed ? 'День закрыт ✓' : `${k} из ${n}`),
        h('div', { class: 'segs' + (ui.celebrate ? ' celebrate' : ''), 'aria-hidden': 'true' }, plan.map((id, i) =>
          h('span', { class: 'seg' + (done.includes(id) ? ' on' : ''), style: `${tint(D.findItem(S, id).color)};--i:${i}` })))),
      h('p', { class: 'line' }, D.norm(step) <= D.norm(goal)
        ? `🌙 Отбой ${step} · цель достигнута · подъём ${wake}`
        : `🌙 Отбой ${step} · цель ${goal} · подъём ${wake}`),
      improvement && h('p', { class: 'line line-strong' }, `1% недели: ${improvement}`),
      D.status(S, y, today) === 'miss' && !closed && h('p', { class: 'line' }, 'Вчера пропуск — сегодня не пропускай дважды'),
      rv && h('button', { class: 'banner', onclick: () => openReview(rv.monday) },
        rv.kind === 'sunday' ? 'Итоги недели · 10 минут' : 'Итоги прошлой недели не закрыты', h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
      sleepCard(),
      yesterdayBlock(y),
      n > 0
        ? h('div', { class: 'list' }, plan.map(id => {
          const it = D.findItem(S, id);
          return itemRow(it, done.includes(id), () => toggle(today, id), it.beforeBed ? `до ${D.deadline(step, it.beforeBed)}` : '');
        }))
        : h('p', { class: 'empty' }, 'Минимум пуст — добавь пункты в Настройках'),
      weekly.length > 0 && h('div', { class: 'list' }, h('p', { class: 'overline list-title' }, 'Каждую неделю'), weekly.map(weekRow)),
    ];
  }

  function weekRow(it) {
    const c = D.weekCount(S, it.id, today);
    const mine = (S.weekMarks[it.id] || []).includes(today);
    const segs = h('span', { class: 'segs segs-sm', 'aria-hidden': 'true' },
      Array.from({ length: Math.max(it.perWeek, c) }, (_, i) => h('span', { class: 'seg' + (i < c ? ' on' : ''), style: tint(it.color) })));
    return h('button', {
      class: 'row' + (mine ? ' done' : ''), style: tint(it.color), 'aria-pressed': pressed(mine),
      onclick: () => { if (!stale()) { D.toggleWeekMark(S, it.id, today); commit(); } },
    }, emo(it), h('span', { class: 'txt' }, h('span', { class: 'name' }, it.name), it.note && h('span', { class: 'note' }, it.note),
      h('span', { class: 'wk-meta' }, segs, h('span', { class: 'note' }, `${c} из ${it.perWeek}`, mine ? ' · сегодня ✓' : ''))),
    h('span', { class: 'check' }, checkIcon()));
  }

  function sleepCard() {
    const n = S.sleep.nights[today] || {};
    const full = n.bed && n.wake;
    const edit = () => { ui.sleepEdit = true; render(); };
    if (full && !ui.sleepEdit) {
      const late = D.norm(n.bed) - D.norm(D.targetFor(S, today));
      const d = D.duration(n);
      return h('button', { class: 'line line-btn', onclick: edit },
        `Сон ${d ? dur(d) : '—'} · лёг ${n.bed} ${late > 0 ? `· на ${dur(late)} позже цели` : '✓'}`);
    }
    const hr = now().getHours();
    if (!full && !ui.sleepEdit && (hr >= 18 || hr < D.DAY_START_HOUR))
      return h('button', { class: 'line line-btn link', onclick: edit }, 'Сон за прошлую ночь не отмечен');
    return h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'Прошлая ночь'), nightEditor(today));
  }

  function nightEditor(date) {
    const n = S.sleep.nights[date] || {};
    const step = D.targetFor(S, date), wake = S.sleep.goalWake;
    const set = (field, v) => {
      if (stale()) return;
      D.setNight(S, date, field, v);
      const m = S.sleep.nights[date];
      if (m?.bed && m?.wake) ui.sleepEdit = false;
      commit();
    };
    return [
      chipRow('Лёг', [-60, -30, 0, 30, 60, 90, 120].map(d => D.shiftTime(step, d)), n.bed, step, v => set('bed', v)),
      chipRow('Встал', [-60, -30, 0, 30, 60, 90].map(d => D.shiftTime(wake, d)), n.wake, wake, v => set('wake', v)),
    ];
  }

  function chipRow(label, values, current, mark, pick) {
    const other = current && !values.includes(current);
    return h('div', { class: 'chips-row' }, h('p', { class: 'chips-label' }, label), h('div', { class: 'chips' },
      values.map(v => h('button', {
        class: 'chip' + (v === mark ? ' chip-mark' : ''), 'aria-pressed': pressed(v === current),
        onclick: () => pick(v === current ? null : v),
      }, v)),
      // Родной выбор времени лежит прозрачным поверх чипа: iOS открывает его только от прямого касания.
      h('label', { class: 'chip chip-other' + (other ? ' on' : '') }, other ? current : 'Другое',
        h('input', {
          type: 'time', class: 'chip-input', value: current || '', 'aria-label': `${label}: другое время`,
          onclick: e => { try { e.target.showPicker?.(); } catch {} },
          onchange: e => D.isTime(e.target.value) && pick(e.target.value),
        }))));
  }

  function yesterdayBlock(y) {
    if (y < S.createdAt) return null;
    const { plan, k, n } = D.progress(S, y, today);
    if (!n || k === n) return null;
    const done = D.doneOf(S, y);
    return h('section', { class: 'yesterday' },
      h('button', { class: 'line line-btn', 'aria-expanded': pressed(ui.yOpen), onclick: () => { ui.yOpen = !ui.yOpen; render(); } },
        `Вчера: ${k} из ${n} — отметить`),
      ui.yOpen && h('div', { class: 'list' }, plan.map(id => D.findItem(S, id)).filter(Boolean).map(it =>
        itemRow(it, done.includes(it.id), () => toggle(y, it.id)))));
  }

  // ---------- листы

  function sheetView() {
    const sh = ui.sheet;
    const title = sh.kind === 'review' ? 'Итоги недели' : sh.id ? 'Пункт' : 'Новый пункт';
    const close = () => { ui.sheet = null; render(); };
    return h('div', { class: 'sheet' + (ui.fresh ? ' enter' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-back', onclick: close }),
      h('div', { class: 'sheet-panel' },
        h('header', { class: 'sheet-head' }, h('h2', { class: 'sheet-title' }, title),
          h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', onclick: close }, '✕')),
        sh.kind === 'review' ? reviewSheet(sh) : itemSheet(sh)));
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
    const area = (label, key) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
      h('textarea', { class: 'input', rows: 2, value: dr[key], oninput: e => (dr[key] = e.target.value) }));
    const dot = (c, it) => h('span', { class: 'dot dot-' + c, style: tint(it.color) });
    return [
      h('p', { class: 'overline' }, weekRange(W)),
      sec('Неделя',
        h('p', {}, `Закрыто дней ${sum.closed} из ${sum.total} · серия ${D.history(S, today).streak}`),
        sum.weekly.map(w => h('p', {}, `${w.item.name}: ${w.count} из ${w.item.perWeek}`)),
        sum.rows.length > 0 && h('div', { class: 'grid' },
          h('span', {}), WD.map(d => h('span', { class: 'grid-wd' }, d)),
          sum.rows.map(r => [h('span', { class: 'grid-emo', title: r.item.name }, r.item.emoji), r.cells.map(c => dot(c, r.item))]))),
      sec('Сон',
        h('p', {}, `В цель ${sum.K} из ${sum.mornings.length}`),
        sum.avgBed && h('p', {}, `Средний отбой ${sum.avgBed}`),
        sum.avgDur && h('p', {}, `Средняя длительность ${dur(sum.avgDur)}`),
        sum.missingNights.length > 0 && h('p', { class: 'hint' }, 'Незаполненные ночи — по памяти:'),
        sum.missingNights.map(d => h('div', { class: 'night' }, h('p', { class: 'night-date' }, `${WD[D.weekday(d)]}, ${dm(d)}`), nightEditor(d))),
        p.atGoal && h('p', {}, `Цель достигнута, держим ${S.sleep.goalBed}`),
        p.fewData && h('p', { class: 'hint' }, 'Мало данных — шаг пока оставляем'),
        h('div', { class: 'choices' }, p.options.map(o => h('button', {
          class: 'choice' + (o.choice === p.recommended ? ' rec' : ''), 'aria-pressed': pressed(o.choice === sh.choice),
          onclick: () => { sh.choice = o.choice; render(); },
        }, o.choice === 'keep' ? `Оставить ${o.to}` : `${CHOICE[o.choice]} → ${o.to}`,
        o.choice === p.recommended && h('span', { class: 'rec-tag' }, 'рекомендовано')))),
        opt && h('p', { class: 'line line-strong' }, opt.to === p.from
          ? `Отбой остаётся ${p.from}`
          : `Со следующей ночи отбой ${opt.to}.` + (phone ? ` Передвинь сигнал «${phone.name}» на ${D.deadline(opt.to, phone.beforeBed)}` : ''))),
      sec('Разбор',
        area('Что получилось?', 'good'), area('Что не получилось?', 'bad'), area('Чему научился?', 'learned'),
        h('label', { class: 'check-field' }, h('input', { type: 'checkbox', checked: dr.notesDone, onchange: e => (dr.notesDone = e.target.checked) }),
          h('span', {}, 'Notes разобраны: каждой строке — одно действие в Напоминания или вычеркнуть'))),
      sec('1% на следующую неделю',
        h('input', { class: 'input', value: dr.improvement, maxlength: 500, 'aria-label': '1% на следующую неделю', oninput: e => (dr.improvement = e.target.value) }),
        h('div', { class: 'chips' }, HINTS.map(t => h('button', { class: 'chip chip-hint', onclick: () => { dr.improvement = t; render(); } }, t)))),
      h('button', {
        class: 'btn btn-primary btn-wide', disabled: !opt,
        onclick: () => {
          if (stale() || !D.closeWeek(S, W, dr, sh.choice, today, now().toISOString())) return;
          ui.sheet = null;
          toast('Неделя закрыта');
          commit();
        },
      }, 'Закрыть неделю'),
      !opt && h('p', { class: 'hint center' }, 'Сначала выбери шаг сна'),
    ];
  }

  function openItem(id, weekly) {
    const it = id && D.findItem(S, id);
    const draft = it
      ? { emoji: it.emoji, name: it.name, note: it.note, color: it.color, beforeBed: it.beforeBed ?? null, perWeek: it.perWeek ?? 3 }
      : { emoji: '✨', name: '', note: '', color: 'blue', beforeBed: null, perWeek: 3 };
    ui.sheet = { kind: 'item', id, weekly, draft, armed: false, error: '' };
    ui.fresh = true;
    render();
  }

  function itemSheet(sh) {
    const d = sh.draft;
    const set = (k, v, re) => { d[k] = v; if (re) render(); };
    const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
    return [
      field('Эмодзи', h('input', { class: 'input input-emoji', value: d.emoji, maxlength: 16, oninput: e => set('emoji', e.target.value) })),
      h('div', { class: 'chips' }, EMOJIS.map(e =>
        h('button', { class: 'chip chip-emoji', 'aria-pressed': pressed(d.emoji === e), onclick: () => set('emoji', e, true) }, e))),
      field('Название', h('input', {
        class: 'input', name: 'name', value: d.name, maxlength: 60, 'aria-invalid': sh.error ? 'true' : null,
        oninput: e => set('name', e.target.value),
      })),
      sh.error && h('p', { class: 'error' }, sh.error),
      field('Подпись', h('input', { class: 'input', name: 'note', value: d.note, maxlength: 120, placeholder: 'когда / после чего', oninput: e => set('note', e.target.value) })),
      h('p', { class: 'field-label' }, 'Цвет'),
      h('div', { class: 'swatches' }, D.COLORS.map(c => h('button', {
        class: 'swatch', style: tint(c), 'aria-label': c, 'aria-pressed': pressed(d.color === c), onclick: () => set('color', c, true),
      }, checkIcon()))),
      sh.weekly
        ? [h('p', { class: 'field-label' }, 'Раз в неделю'), h('div', { class: 'chips' }, [1, 2, 3, 4, 5, 6, 7].map(n =>
          h('button', { class: 'chip', 'aria-pressed': pressed(+d.perWeek === n), onclick: () => set('perWeek', n, true) }, n)))]
        : [h('label', { class: 'check-field' },
          h('input', { type: 'checkbox', checked: d.beforeBed != null, onchange: e => set('beforeBed', e.target.checked ? 30 : null, true) }),
          h('span', {}, 'Привязать к отбою')),
        d.beforeBed != null && h('label', { class: 'field field-inline' }, h('span', {}, 'за'),
          h('input', { type: 'number', class: 'input input-num', min: 1, max: 240, inputmode: 'numeric', value: String(d.beforeBed), oninput: e => set('beforeBed', e.target.value) }),
          h('span', {}, 'минут'))],
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', onclick: () => saveItem(sh) }, sh.id ? 'Сохранить' : 'Добавить'),
        sh.id && h('button', { class: 'btn btn-danger', onclick: () => removeItem(sh) },
          sh.armed ? 'Точно убрать? Нажми ещё раз' : sh.weekly ? 'Убрать из недельных' : 'Убрать из минимума')),
    ];
  }

  function saveItem(sh) {
    if (!D.cleanFields(sh.draft, sh.weekly)) {
      sh.error = 'Нужно название';
      return render();
    }
    if (sh.id) D.updateItem(S, sh.id, sh.draft);
    else D.addItem(S, sh.draft, sh.weekly, today);
    ui.sheet = null;
    commit();
  }

  function removeItem(sh) {
    if (!sh.armed) {
      sh.armed = true;
      return render();
    }
    D.archiveItem(S, sh.id, today);
    ui.sheet = null;
    commit();
  }

  // ---------- Прогресс

  function progressScreen() {
    const { streak, best, marks } = D.history(S, today);
    const days = D.diffDays(S.since, today) + 1;
    const cur = D.weekStart(today);
    const now7 = D.sleepStats(S, D.weekMornings(S, cur, today));
    const prev7 = D.sleepStats(S, D.weekMornings(S, D.addDays(cur, -7), today));
    const diffs = [];
    if (now7.avgDur != null && prev7.avgDur != null) {
      const x = now7.avgDur - prev7.avgDur;
      diffs.push(`${x >= 0 ? '+' : '−'}${dur(Math.abs(x))} сна`);
    }
    if (now7.avgBedNorm != null && prev7.avgBedNorm != null) {
      const x = Math.round(now7.avgBedNorm - prev7.avgBedNorm);
      diffs.push(x === 0 ? 'отбой как на прошлой' : `отбой на ${dur(Math.abs(x))} ${x < 0 ? 'раньше' : 'позже'}`);
    }
    const weekly = S.weekly.filter(i => !i.archivedAt);
    const weeks8 = Array.from({ length: 8 }, (_, i) => D.addDays(cur, -7 * (7 - i)));
    const revs = Object.keys(S.reviews).sort().reverse();
    return [
      h('header', { class: 'head' }, h('div', {}, h('p', { class: 'overline' }, 'Прогресс'),
        h('h1', { class: 'title title-sm' }, `В системе с ${dm(S.since)} · ${days} ${plural(days, ['день', 'дня', 'дней'])}`))),
      sec('Серия',
        h('div', { class: 'streak-big' }, h('span', { class: 'big' }, streak), h('span', { class: 'note' }, `рекорд ${best}`)),
        h('p', { class: 'note' }, 'Один пропуск прощается, два подряд — серия с нуля'),
        chain(marks),
        h('p', { class: 'legend note' }, h('span', { class: 'cell cell-closed' }), ' закрыт ', h('span', { class: 'cell cell-forgiven' }), ' прощён ',
          h('span', { class: 'cell cell-break' }), ' разрыв')),
      sec('Сон · 28 ночей', sleepChart(),
        h('p', { class: 'note' }, now7.avgBed
          ? `Эта неделя: отбой ${now7.avgBed}` + (now7.avgDur != null ? ` · сон ${dur(now7.avgDur)}` : '')
          : 'На этой неделе ночей пока нет'),
        diffs.length > 0 && h('p', { class: 'note' }, `К прошлой неделе: ${diffs.join(' · ')}`)),
      sec('Пункты за 4 недели', h('div', { class: 'rates' }, D.itemRates(S, today).map(r =>
        h('div', { class: 'rate', style: tint(r.item.color) },
          h('span', { class: 'rate-name' }, `${r.item.emoji} ${r.item.name}`),
          h('span', { class: 'rate-bar' }, h('span', { class: 'rate-fill', style: `--p:${r.rate ?? 0}` })),
          h('span', { class: 'rate-val' }, r.rate == null ? '—' : `${Math.round(r.rate * 100)}%`))))),
      weekly.map(it => sec(`${it.emoji} ${it.name} · 8 недель`, h('div', { class: 'weeks8' }, weeks8.map(w => {
        const c = D.weekCount(S, it.id, w);
        return h('div', { class: 'wk', style: tint(it.color) },
          h('span', { class: 'wk-bar' }, h('span', { class: 'wk-fill', style: `--p:${Math.min(1, c / it.perWeek)}` })),
          h('span', { class: 'note' }, `${c}/${it.perWeek}`));
      })))),
      sec('Недели', revs.length ? revs.map(m => {
        const r = S.reviews[m];
        const sl = r.sleep.to && r.sleep.to !== r.sleep.from ? `отбой ${r.sleep.from} → ${r.sleep.to}` : `отбой ${r.sleep.from || '—'} — оставили`;
        const parts = [['Получилось', r.good], ['Не получилось', r.bad], ['Научился', r.learned]].filter(x => x[1]);
        return h('details', { class: 'review' },
          h('summary', {}, h('span', { class: 'name' }, weekRange(m)), h('span', { class: 'note' }, sl + (r.improvement ? ` · 1%: ${r.improvement}` : ''))),
          parts.map(([l, v]) => h('p', {}, h('b', {}, `${l}: `), v)),
          h('p', { class: 'note' }, r.notesDone ? 'Notes разобраны' : 'Notes не разобраны'));
      }) : h('p', { class: 'note' }, 'Закрытых недель пока нет')),
    ];
  }

  function chain(marks) {
    const start = D.addDays(D.weekStart(today), -77);
    return h('div', { class: 'chain', role: 'img', 'aria-label': 'Цепь дней за 12 недель' },
      D.range(start, D.addDays(D.weekStart(today), 6)).map(d =>
        h('span', { class: `cell cell-${d > today ? 'future' : marks[d] || 'none'}` + (d === today ? ' cell-today' : '') })));
  }

  function sleepChart() {
    const days = D.range(D.addDays(today, -27), today);
    const W = 340, H = 200, L = 40, T = 10, B = 10, top = 1320, bot = 2040; // 22:00 … 10:00
    const y = v => T + ((Math.min(bot, Math.max(top, v)) - top) / (bot - top)) * (H - T - B);
    const cw = (W - L) / days.length, x = i => L + cw * (i + 0.5);
    const hours = [1320, 1440, 1560, 1680, 1800, 1920, 2040];
    let stepPath = '';
    days.forEach((d, i) => {
      const sy = y(D.norm(D.targetFor(S, d))).toFixed(1);
      stepPath += `${i ? 'L' : 'M'}${(L + cw * i).toFixed(1)} ${sy}H${(L + cw * (i + 1)).toFixed(1)}`;
    });
    return svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Сон за 28 ночей' },
      hours.map(v => [svg('line', { class: 'grid-line', x1: L, x2: W, y1: y(v), y2: y(v) }),
        svg('text', { class: 'axis', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, D.fmtTime(v))]),
      svg('line', { class: 'goal-line', x1: L, x2: W, y1: y(D.norm(S.sleep.goalBed)), y2: y(D.norm(S.sleep.goalBed)) }),
      svg('path', { class: 'step-line', d: stepPath }),
      days.map((d, i) => {
        const n = S.sleep.nights[d];
        if (!n?.bed) return null;
        const cls = D.onTarget(S, d) ? 'night-ok' : 'night-late';
        if (!n.wake) return svg('circle', { class: cls, cx: x(i), cy: y(D.norm(n.bed)), r: 3 });
        return svg('line', { class: cls, x1: x(i), x2: x(i), y1: y(D.norm(n.bed)), y2: y(D.toMin(n.wake) + 1440) });
      }));
  }

  // ---------- Настройки

  function ask(text, yes, action, where) {
    ui.ask = { text, yes, action, where };
    render();
  }
  const askBox = where => ui.ask?.where === where && h('div', { class: 'card ask', role: 'alertdialog' }, h('p', {}, ui.ask.text),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', onclick: () => { const a = ui.ask.action; ui.ask = null; a(); } }, ui.ask.yes),
      h('button', { class: 'btn', onclick: () => { ui.ask = null; render(); } }, 'Отмена')));

  const tooMany = () => `В минимуме уже ${D.activeItems(S).length} ${plural(D.activeItems(S).length, ['пункт', 'пункта', 'пунктов'])}. Минимум должен выполняться в худший день. Всё равно добавить?`;

  function tryAdd(weekly) {
    if (!weekly && D.activeItems(S).length >= D.MAX_DAILY) ask(tooMany(), 'Всё равно добавить', () => openItem(null, false), 'items');
    else openItem(null, weekly);
  }

  function restore(it, weekly) {
    const go = () => { D.restoreItem(S, it.id); commit(); };
    if (!weekly && D.activeItems(S).length >= D.MAX_DAILY) ask(tooMany(), 'Всё равно вернуть', go, 'items');
    else go();
  }

  function listEditor(list, weekly) {
    const act = list.filter(i => !i.archivedAt), arch = list.filter(i => i.archivedAt);
    const move = (id, dir) => { D.moveItem(S, id, dir); commit(); };
    const sub = it => weekly ? [it.note, `${it.perWeek} в неделю`].filter(Boolean).join(' · ')
      : [it.note, it.beforeBed && `за ${it.beforeBed} мин до отбоя`].filter(Boolean).join(' · ');
    return [
      askBox(weekly ? 'weekly' : 'items'),
      act.length > 0 && h('div', { class: 'list' }, act.map((it, i) => h('div', { class: 'set-row', style: tint(it.color) },
        h('button', { class: 'set-main', onclick: () => openItem(it.id, weekly) }, emo(it), txt(it.name, sub(it))),
        h('button', { class: 'icon-btn', 'aria-label': `${it.name}: выше`, disabled: i === 0, onclick: () => move(it.id, -1) }, '↑'),
        h('button', { class: 'icon-btn', 'aria-label': `${it.name}: ниже`, disabled: i === act.length - 1, onclick: () => move(it.id, 1) }, '↓')))),
      h('button', { class: 'btn btn-wide', onclick: () => tryAdd(weekly) }, weekly ? 'Добавить счётчик' : 'Добавить пункт'),
      arch.length > 0 && h('div', { class: 'list' }, h('p', { class: 'overline list-title' }, 'Убранные'), arch.map(it =>
        h('div', { class: 'set-row archived', style: tint(it.color) }, h('span', { class: 'set-main' }, emo(it), txt(it.name, it.note)),
          h('button', { class: 'btn btn-sm', onclick: () => restore(it, weekly) }, 'Вернуть')))),
    ];
  }

  function timeField(label, value, onSet, hint) {
    return h('label', { class: 'field-row' }, h('span', { class: 'field-label' }, label, hint && h('span', { class: 'hint' }, hint)),
      h('input', {
        type: 'time', class: 'input input-time', value,
        // Без перерисовки: иначе поле потеряет фокус посреди ввода.
        onchange: e => { if (D.isTime(e.target.value)) { onSet(e.target.value); save(); } },
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
    ask('Заменить все данные данными из файла? Текущие будут стёрты.', 'Заменить', () => {
      S = r.state;
      ui.dataMsg = 'Данные импортированы';
      commit();
    }, 'data');
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

  function doReset() {
    if (!ui.resetArmed) {
      ui.resetArmed = true;
      return render();
    }
    S = D.seed(today);
    Object.assign(ui, { resetArmed: false, dataMsg: 'Сброшено к шаблону', yOpen: false, sleepEdit: false });
    commit();
  }

  function settingsScreen() {
    return [
      h('header', { class: 'head' }, h('h1', { class: 'title' }, 'Настройки')),
      sec('Минимум', listEditor(S.items, false)),
      sec('Каждую неделю', listEditor(S.weekly, true)),
      sec('Сон',
        timeField('Цель отбоя', S.sleep.goalBed, v => (S.sleep.goalBed = v)),
        timeField('Цель подъёма', S.sleep.goalWake, v => (S.sleep.goalWake = v)),
        timeField('Текущий шаг', D.stepTonight(S, today), v => D.setStep(S, v, today), 'обычно меняется на итогах недели')),
      sec('Правила', h('ol', { class: 'rules' }, RULES.map(r => h('li', {}, r)))),
      sec('Данные',
        askBox('data'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: doExport }, 'Экспорт'),
          h('label', { class: 'btn' }, 'Импорт', h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden-input', onchange: doImport }))),
        h('button', { class: 'btn btn-danger btn-wide', onclick: doReset }, ui.resetArmed ? 'Точно стереть всё? Нажми ещё раз' : 'Сбросить к шаблону'),
        ui.dataMsg && h('p', { class: 'hint', role: 'status' }, ui.dataMsg)),
      sec('О приложении',
        h('p', {}, 'Минимум' + (ui.version ? ` · ${ui.version}` : '')),
        h('button', { class: 'btn btn-wide', onclick: checkUpdates }, 'Проверить обновления'),
        ui.updMsg && h('p', { class: 'hint', role: 'status' }, ui.updMsg)),
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
        if (ui.tab === 'settings' && !ui.sheet) render();
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
    if (doc.visibilityState === 'hidden') return void store.flush();
    if (D.logicalDate(now()) !== today) render();
    if (reg && Date.now() - lastCheck > UPDATE_EVERY) {
      lastCheck = Date.now();
      reg.update().catch(() => {});
    }
  });
  win.addEventListener('pagehide', () => store.flush());

  render();
  initSW();
  return { render, get state() { return S; } };
}
