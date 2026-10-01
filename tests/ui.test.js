// Движок dom.js: разметка, перенос в живой DOM, жесты и анимации (с подменой Web Animations).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createDOM } from '../dom.js';

function env({ ua, animate = false } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="r"></div></body>', { pretendToBeVisual: true });
  const win = dom.window;
  if (ua) Object.defineProperty(win.navigator, 'userAgent', { value: ua, configurable: true });
  const calls = [];
  if (animate) {
    // Подмена Web Animations: запоминаем вызовы, «завершаем» сразу.
    win.Element.prototype.animate = function (frames, opts) {
      const a = {
        el: this, frames, opts, state: 'running',
        finished: Promise.resolve(),
        cancel() { this.state = 'cancelled'; },
        pause() { this.state = 'paused'; },
        play() { this.state = 'running'; },
      };
      calls.push(a);
      return a;
    };
  }
  const M = createDOM(win);
  const root = win.document.getElementById('r');
  return { win, doc: win.document, M, root, calls, close: () => win.close() };
}

test('h: атрибуты, обработчики, плоские дети, пустое не попадает в DOM', () => {
  const { M, root, close } = env();
  let hit = 0;
  const el = M.h('button', { class: 'a', 'aria-pressed': 'true', disabled: false, title: null, onclick: () => hit++ },
    'текст', null, false, '', [M.h('i', {}), [M.h('b', {}, 'x')]]);
  root.append(el);
  assert.equal(el.getAttribute('class'), 'a');
  assert.equal(el.hasAttribute('disabled'), false);
  assert.equal(el.hasAttribute('title'), false);
  assert.equal(el.childNodes.length, 3);
  assert.equal(el.textContent, 'текстx');
  el.click();
  assert.equal(hit, 1);
  const s = M.svg('svg', { viewBox: '0 0 1 1' }, M.svg('path', { d: 'M0 0', pathLength: undefined }));
  assert.equal(s.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(s.firstChild.hasAttribute('pathLength'), false);
  close();
});

test('patch: узлы переиспользуются, атрибуты и текст обновляются, лишнее удаляется', () => {
  const { M, root, close } = env();
  const view = (n, extra) => [M.h('p', { key: 'p', class: 'c' + n }, `n=${n}`), extra && M.h('div', { key: 'x', 'data-x': '1' }), M.h('span', {}, 'конец')];
  M.patch(root, view(1, true));
  const p = root.querySelector('p'), span = root.querySelector('span');
  M.patch(root, view(2, false));
  assert.equal(root.querySelector('p'), p, 'тот же узел');
  assert.equal(root.querySelector('span'), span);
  assert.equal(p.className, 'c2');
  assert.equal(p.textContent, 'n=2');
  assert.equal(root.querySelector('[data-x]'), null);
  // атрибут, которого нет в новом дереве, снимается
  M.patch(root, [M.h('p', { key: 'p' }, 'n=3'), M.h('span', {}, 'конец')]);
  assert.equal(p.hasAttribute('class'), false);
  close();
});

test('patch: ключи переставляются без пересоздания, новые узлы попадают в entered', () => {
  const { M, root, close } = env();
  const list = ids => [M.h('ul', {}, ids.map(id => M.h('li', { key: id }, id)))];
  M.patch(root, list(['a', 'b', 'c']));
  const [a, b, c] = root.querySelectorAll('li');
  const entered = M.patch(root, list(['c', 'a', 'd', 'b']));
  const now = [...root.querySelectorAll('li')];
  assert.deepEqual(now.map(li => li.textContent), ['c', 'a', 'd', 'b']);
  assert.equal(now[0], c);
  assert.equal(now[1], a);
  assert.equal(now[3], b);
  assert.deepEqual(entered.map(e => e.textContent), ['d']);
  // другой тег под тем же ключом — новый узел
  M.patch(root, [M.h('ul', {}, M.h('p', { key: 'a' }, 'a'))]);
  assert.equal(root.querySelector('ul').firstChild.nodeName, 'P');
  close();
});

test('patch: обработчики заменяются, а не копятся', () => {
  const { M, root, close } = env();
  const got = [];
  M.patch(root, [M.h('button', { key: 'b', onclick: () => got.push(1) }, 'x')]);
  const btn = root.querySelector('button');
  M.patch(root, [M.h('button', { key: 'b', onclick: () => got.push(2) }, 'x')]);
  M.patch(root, [M.h('button', { key: 'b' }, 'x')]);
  btn.click();
  M.patch(root, [M.h('button', { key: 'b', onclick: () => got.push(3) }, 'x')]);
  btn.click();
  assert.deepEqual(got, [3]);
  close();
});

test('patch: поле в фокусе не перезаписывается, остальные — да; disabled переключается', () => {
  const { M, root, doc, close } = env();
  const form = (v, dis) => [M.h('input', { key: 'a', value: v }), M.h('input', { key: 'b', value: v }), M.h('button', { key: 'c', disabled: dis }, 'ok')];
  M.patch(root, form('1', true));
  const [a, b] = root.querySelectorAll('input');
  const btn = root.querySelector('button');
  assert.equal(btn.disabled, true);
  a.focus();
  a.value = 'печатаю';
  M.patch(root, form('2', false));
  assert.equal(doc.activeElement, a, 'фокус на месте');
  assert.equal(a.value, 'печатаю');
  assert.equal(b.value, '2');
  assert.equal(btn.disabled, false);
  a.blur();
  M.patch(root, form('3', false));
  assert.equal(a.value, '3');
  close();
});

test('patch: textarea — значение через value, текстовые узлы внутрь не пишутся', () => {
  const { M, root, close } = env();
  M.patch(root, [M.h('textarea', { key: 't', value: 'раз' })]);
  const t = root.querySelector('textarea');
  M.patch(root, [M.h('textarea', { key: 't', value: 'два' })]);
  assert.equal(root.querySelector('textarea'), t);
  assert.equal(t.value, 'два');
  assert.equal(t.childNodes.length, 0);
  close();
});

test('без Web Animations всё мгновенно: анимации — null, замеры и эффекты — пусто', async () => {
  const { M, root, doc, close } = env();
  assert.equal(M.motion(), false);
  const el = M.h('div', { 'data-flip': '' });
  root.append(el);
  assert.equal(M.anim(el, [{ opacity: 0 }, { opacity: 1 }], 100), null);
  await M.done(null);
  assert.equal(M.measure(root), null);
  M.flip(null, [el]);
  assert.deepEqual(M.draw(M.svg('svg', {})), []);
  assert.deepEqual(M.stagger(M.h('div', { 'data-stagger': 'pop' }, M.h('i', {}))), []);
  M.reveal(el, []);
  M.burst(el, ['red']);
  assert.equal(doc.querySelector('.fx'), null);
  const n = M.h('span', {}, '5');
  M.countUp(n, 5);
  assert.equal(n.textContent, '5');
  close();
});

test('FLIP: блок едет со старого места, вложенный — только на свою разницу, новые проявляются', () => {
  const { M, root, calls, close } = env({ animate: true });
  assert.equal(M.motion(), true);
  const box = M.h('section', { 'data-flip': '' }, M.h('div', { 'data-flip': '' }, 'вложенный'));
  root.append(box);
  const inner = box.firstChild;
  const rect = (top, left = 0) => () => ({ top, left, width: 10, height: 10, right: left + 10, bottom: top + 10 });
  box.getBoundingClientRect = rect(100);
  inner.getBoundingClientRect = rect(130);
  const before = M.measure(root);
  box.getBoundingClientRect = rect(160); // блок съехал на 60
  inner.getBoundingClientRect = rect(200); // вложенный — на 70: 60 с родителем и 10 свои
  const fresh = M.h('p', { 'data-flip': '' });
  root.append(fresh);
  M.flip(before, [fresh]);
  const by = el => calls.filter(c => c.el === el);
  assert.equal(by(box)[0].frames[0].transform, 'translate(0px, -60px)');
  assert.equal(by(inner)[0].frames[0].transform, 'translate(0px, -10px)');
  assert.equal(by(fresh)[0].frames[0].opacity, 0);
  // повторный FLIP отменяет незаконченный
  const first = by(box)[0];
  const again = M.measure(root);
  box.getBoundingClientRect = rect(100);
  M.flip(again, []);
  assert.equal(first.state, 'cancelled');
  close();
});

test('FLIP: строка сменила тег под тем же ключом — едет со старого места, без появления', () => {
  const { M, root, calls, close } = env({ animate: true });
  M.patch(root, [M.h('section', {}, M.h('button', { key: 'a', 'data-flip': '' }, 'a'), M.h('button', { key: 'b', 'data-flip': '' }, 'b'))]);
  const oldB = root.querySelectorAll('button')[1];
  oldB.getBoundingClientRect = () => ({ top: 50, left: 0 });
  const before = M.measure(root);
  const entered = M.patch(root, [M.h('section', {}, M.h('div', { key: 'b', 'data-flip': '' }, 'b'), M.h('button', { key: 'a', 'data-flip': '' }, 'a'))]);
  const newB = root.querySelector('div');
  assert.notEqual(newB, oldB);
  assert.equal(newB.__was, oldB);
  newB.getBoundingClientRect = () => ({ top: 0, left: 0 });
  M.flip(before, entered);
  const mine = calls.filter(c => c.el === newB);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].frames[0].transform, 'translate(0px, 50px)');
  assert.equal(newB.__was, null, 'ссылка на старый узел не держится');
  close();
});

test('кольца, очередь появления и показ из-под таб-бара', () => {
  const { M, root, win, calls, close } = env({ animate: true });
  const ring = M.svg('svg', {},
    M.svg('circle', { class: 'arc', style: 'stroke-dasharray:100px 100px;stroke-dashoffset:25px' }),
    M.svg('circle', { class: 'arc zero', style: 'stroke-dasharray:100px 100px;stroke-dashoffset:100px' }));
  root.append(ring);
  const ra = M.draw(ring);
  assert.equal(ra.length, 1, 'пустая дуга не рисуется');
  assert.deepEqual(ra[0].frames, [{ strokeDashoffset: '100px' }, { strokeDashoffset: '25px' }]);
  const grid = M.h('div', { 'data-stagger': 'pop', 'data-step': '10' }, M.h('i', { 'data-d': '3' }), M.h('i', {}));
  root.append(grid);
  const sa = M.stagger(grid);
  assert.deepEqual(sa.map(a => a.opts.delay), [30, 10]);
  // без IntersectionObserver — играют сразу
  M.reveal(grid, sa);
  assert.ok(sa.every(a => a.state === 'running'));
  // с IntersectionObserver — ждут показа
  let cb;
  win.IntersectionObserver = class { constructor(f) { cb = f; } observe() {} unobserve() {} };
  const unobserved = [];
  win.IntersectionObserver.prototype.unobserve = el => unobserved.push(el);
  M.reveal(ring, ra);
  assert.equal(ra[0].state, 'paused');
  cb([{ isIntersecting: true, target: ring }]);
  assert.equal(ra[0].state, 'running');
  // блок ушёл со страницы, не показавшись, — наблюдение снимается при следующем вызове
  const gone = M.h('div', {});
  root.append(gone);
  M.reveal(gone, [M.anim(gone, [{ opacity: 0 }, { opacity: 1 }], 100)]);
  gone.remove();
  M.reveal(ring, M.draw(ring));
  assert.ok(unobserved.includes(gone));
  assert.equal(gone.__reveal, null);
  assert.ok(calls.length >= 3);
  close();
});

test('конфетти — в отдельном слое и убирается после анимации', async () => {
  const { M, root, doc, close } = env({ animate: true });
  const o = M.h('div', {});
  root.append(o);
  M.burst(o, ['var(--c-red)', 'var(--sun-1)'], { n: 6 });
  const fx = doc.querySelector('body > .fx');
  assert.ok(fx);
  assert.equal(fx.getAttribute('aria-hidden'), 'true');
  assert.equal(root.contains(fx), false);
  assert.equal(fx.children.length, 6);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(fx.children.length, 0);
  close();
});

test('тактильный отклик: iOS — скрытый переключатель, Android — vibrate, без поддержки — тишина', () => {
  const a = env({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
  a.M.haptic();
  const input = a.doc.querySelector('label.haptic input[type=checkbox][switch]');
  assert.ok(input);
  assert.equal(input.checked, true);
  a.M.haptic();
  assert.equal(input.checked, false);
  assert.equal(a.doc.querySelectorAll('label.haptic').length, 1);
  a.close();
  const b = env({ ua: 'Mozilla/5.0 (Linux; Android 14)' });
  const got = [];
  b.win.navigator.vibrate = ms => got.push(ms);
  Object.defineProperty(b.win.navigator, 'userActivation', { value: { isActive: true }, configurable: true });
  b.M.haptic();
  assert.deepEqual(got, [8]);
  b.close();
  const c = env();
  c.M.haptic();
  assert.equal(c.doc.querySelector('.haptic'), null);
  c.close();
});

test('удержание: тап — отметка, 450 мс — детали без лишней отметки, сдвиг пальца отменяет', async () => {
  const { M, root, win, close } = env();
  const got = [];
  M.patch(root, [M.h('button', { key: 'r', ...M.holdable(() => got.push('tap'), () => got.push('hold'), 30) }, 'строка')]);
  const btn = root.querySelector('button');
  const ptr = (type, x = 0, y = 0) => btn.dispatchEvent(new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  btn.click();
  assert.deepEqual(got, ['tap']);
  ptr('pointerdown');
  assert.ok(btn.classList.contains('holding'));
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(got, ['tap', 'hold']);
  assert.equal(btn.classList.contains('holding'), false);
  ptr('pointerup');
  btn.click(); // отпустил после удержания — не отметка
  assert.deepEqual(got, ['tap', 'hold']);
  ptr('pointerdown', 0, 0);
  ptr('pointermove', 0, 30); // прокрутка
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(got, ['tap', 'hold']);
  ptr('pointerup');
  btn.click();
  assert.deepEqual(got, ['tap', 'hold', 'tap']);
  close();
});

test('после удержания клик в месте отпускания глотается — до следующего касания', async () => {
  const { M, root, win, doc, close } = env();
  const got = [];
  M.patch(root, [M.h('button', { key: 'r', ...M.holdable(() => got.push('tap'), () => got.push('hold'), 20) }, 'строка'),
    M.h('button', { key: 's', onclick: () => got.push('лист') }, 'лист под пальцем')]);
  const [row, other] = root.querySelectorAll('button');
  const ptr = (el, type) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, button: 0 }));
  const tapClick = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  ptr(row, 'pointerdown');
  await new Promise(r => setTimeout(r, 40));
  ptr(other, 'pointerup');
  tapClick(other); // iOS «кликнул» туда, где теперь лист
  assert.deepEqual(got, ['hold']);
  other.click(); // клавиатура и VoiceOver (detail 0) проходят всегда
  assert.deepEqual(got, ['hold', 'лист']);
  ptr(other, 'pointerdown'); // новое касание — снова всё работает
  tapClick(other);
  assert.deepEqual(got, ['hold', 'лист', 'лист']);
  // без нового касания глотание само снимается через 350 мс после отпускания
  ptr(row, 'pointerdown');
  await new Promise(r => setTimeout(r, 40));
  ptr(row, 'pointerup');
  await new Promise(r => setTimeout(r, 400));
  tapClick(other);
  assert.deepEqual(got, ['hold', 'лист', 'лист', 'hold', 'лист']);
  assert.equal(doc.querySelectorAll('.holding').length, 0);
  close();
});

test('после удержания, чей клик съел фильтр, клавиатура и VoiceOver снова отмечают строку', async () => {
  const { M, root, win, close } = env();
  const got = [];
  M.patch(root, [M.h('button', { key: 'r', ...M.holdable(() => got.push('tap'), () => got.push('hold'), 20) }, 'строка')]);
  const row = root.querySelector('button');
  const ptr = type => row.dispatchEvent(new win.MouseEvent(type, { bubbles: true, button: 0 }));
  ptr('pointerdown');
  await new Promise(r => setTimeout(r, 40));
  ptr('pointerup');
  row.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); // iOS: съеден фильтром документа
  assert.deepEqual(got, ['hold']);
  await new Promise(r => setTimeout(r, 400));
  row.click(); // клавиатура / VoiceOver (detail 0)
  assert.deepEqual(got, ['hold', 'tap']);
  close();
});

test('палец держат дольше 2 с — клик при отпускании всё равно глотается', async () => {
  const { M, root, win, close } = env();
  const got = [];
  M.patch(root, [M.h('button', { key: 'r', ...M.holdable(() => got.push('tap'), () => got.push('hold'), 20) }, 'строка'),
    M.h('button', { key: 's', onclick: () => got.push('лист') }, 'лист под пальцем')]);
  const [row, other] = root.querySelectorAll('button');
  row.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  await new Promise(r => setTimeout(r, 2100));
  other.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, button: 0 }));
  other.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  assert.deepEqual(got, ['hold']);
  close();
});

test('перерисовка не снимает класс удержания и стиль, выставленный скриптом', () => {
  const { M, root, win, close } = env();
  const view = () => [M.h('button', { key: 'r', class: 'row', ...M.holdable(() => {}, () => {}, 5000) }, 'строка'), M.h('textarea', { key: 't', value: '' })];
  M.patch(root, view());
  const row = root.querySelector('button'), area = root.querySelector('textarea');
  row.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  area.__keepStyle = true;
  area.style.height = '120px';
  M.patch(root, view());
  assert.ok(row.classList.contains('holding'), 'удержание продолжается');
  assert.equal(area.style.height, '120px');
  row.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, button: 0 }));
  M.patch(root, view());
  assert.equal(row.classList.contains('holding'), false);
  close();
});

function sheetEnv() {
  const e = env();
  const { M, root } = e;
  M.patch(root, [M.h('div', { class: 'sheet' },
    M.h('div', { class: 'sheet-back' }),
    M.h('div', { class: 'sheet-panel' }, M.h('div', { class: 'grabber' }), M.h('header', { class: 'sheet-head' }, M.h('button', {}, 'Отмена')), M.h('p', { class: 'body' }, 'текст')))]);
  const sheet = root.querySelector('.sheet');
  const panel = sheet.querySelector('.sheet-panel');
  return { ...e, sheet, panel, head: sheet.querySelector('.sheet-head'), body: sheet.querySelector('.body'), back: sheet.querySelector('.sheet-back') };
}

const touch = (win, el, type, y) => {
  const ev = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] });
  el.dispatchEvent(ev);
  return ev;
};

test('лист тянется вниз и закрывается; несохранённое держит его на месте', () => {
  const s = sheetEnv();
  assert.ok('ontouchstart' in s.win, 'в jsdom есть касания');
  const closed = [];
  let dirty = false;
  s.M.dragSheet(s.sheet, { close: dy => closed.push(dy), guard: () => dirty });
  s.M.dragSheet(s.sheet, { close: () => closed.push('дубль') }); // повторная привязка игнорируется
  touch(s.win, s.head, 'touchstart', 100);
  const mv = touch(s.win, s.head, 'touchmove', 140);
  assert.equal(mv.defaultPrevented, true);
  assert.equal(s.panel.style.transform, 'translateY(40px)');
  touch(s.win, s.head, 'touchmove', 400);
  touch(s.win, s.head, 'touchend');
  assert.deepEqual(closed, [300]);
  // несохранённое: лист возвращается
  dirty = true;
  touch(s.win, s.head, 'touchstart', 100);
  touch(s.win, s.head, 'touchmove', 120);
  touch(s.win, s.head, 'touchmove', 400);
  touch(s.win, s.head, 'touchend');
  assert.deepEqual(closed, [300]);
  assert.equal(s.panel.style.transform, '');
  // короткий рывок — лист остаётся
  dirty = false;
  touch(s.win, s.head, 'touchstart', 100);
  touch(s.win, s.head, 'touchmove', 110);
  touch(s.win, s.head, 'touchend');
  assert.deepEqual(closed, [300]);
  // контент прокручен — тянуть за середину нельзя, за шапку можно
  s.panel.scrollTop = 50;
  touch(s.win, s.body, 'touchstart', 100);
  const scroll = touch(s.win, s.body, 'touchmove', 300);
  assert.equal(scroll.defaultPrevented, false);
  touch(s.win, s.body, 'touchend');
  // кнопка в шапке не тянет лист
  touch(s.win, s.head.querySelector('button'), 'touchstart', 100);
  const press = touch(s.win, s.head.querySelector('button'), 'touchmove', 300);
  assert.equal(press.defaultPrevented, false);
  touch(s.win, s.head.querySelector('button'), 'touchend');
  // система отменила касание (звонок) — лист возвращается, даже если утянут далеко
  s.panel.scrollTop = 0;
  touch(s.win, s.head, 'touchstart', 100);
  touch(s.win, s.head, 'touchmove', 120);
  touch(s.win, s.head, 'touchmove', 500);
  touch(s.win, s.head, 'touchcancel');
  assert.deepEqual(closed, [300]);
  assert.equal(s.panel.style.transform, '');
  // рывок и пауза: скорость старого рывка не закрывает лист, решает расстояние
  touch(s.win, s.head, 'touchend');
  touch(s.win, s.head, 'touchstart', 100);
  touch(s.win, s.head, 'touchmove', 130);
  touch(s.win, s.head, 'touchmove', 160);
  const t0 = Date.now();
  while (Date.now() - t0 < 130) {} // палец замер
  touch(s.win, s.head, 'touchend');
  assert.deepEqual(closed, [300]);
  assert.equal(s.panel.style.transform, '');
  // быстрый рывок с отпусканием сразу — закрывает
  touch(s.win, s.head, 'touchstart', 100);
  touch(s.win, s.head, 'touchmove', 130);
  touch(s.win, s.head, 'touchmove', 160);
  touch(s.win, s.head, 'touchend');
  assert.equal(closed.length, 2);
  // перерисовка под пальцем не сбрасывает положение листа
  touch(s.win, s.head, 'touchstart', 100);
  touch(s.win, s.head, 'touchmove', 160);
  s.M.patch(s.root, [s.M.h('div', { class: 'sheet' }, s.M.h('div', { class: 'sheet-back' }), s.M.h('div', { class: 'sheet-panel' }))]);
  assert.equal(s.panel.style.transform, 'translateY(60px)');
  s.close();
});
