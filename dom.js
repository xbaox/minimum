// Минимум — движок разметки и движения. Экран собирается заново на каждый рендер, а patch() переносит
// разницу в живой DOM и сохраняет узлы: поэтому идут CSS-переходы, не теряются фокус, прокрутка и
// открытый родной выбор времени. Анимации — только transform, opacity и stroke-dashoffset колец.

export const EASE = {
  out: 'cubic-bezier(0.22, 1, 0.36, 1)', // плавное торможение — почти всё
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)', // лёгкий перелёт — «щелчок» отметки, чипа, цифры
  ios: 'cubic-bezier(0.32, 0.72, 0, 1)', // лист снизу, как в iOS
  in: 'cubic-bezier(0.4, 0, 1, 1)', // уход со сцены
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createDOM(win) {
  const doc = win.document;
  const reduce = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  // Без Web Animations (тесты, старый браузер) и при «Уменьшении движения» интерфейс просто меняет состояние.
  const motion = () => typeof win.Element?.prototype?.animate === 'function' && !reduce?.matches;

  // ---------- разметка

  // Обработчики живут на узле: при переиспользовании узла их набор заменяется целиком.
  const fire = function (e) {
    const f = this.__on && this.__on[e.type];
    if (f) return f.call(this, e);
  };

  function setAttrs(el, attrs) {
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (k === 'key') {
        if (v != null) el.__k = String(v);
        continue;
      }
      if (v == null || v === false) continue;
      if (k.startsWith('on')) {
        const type = k.slice(2);
        (el.__on ||= {})[type] = v;
        el.addEventListener(type, fire);
      } else if (k === 'value') {
        el.value = v;
        el.__v = String(v);
      } else if (k === 'checked') {
        el.checked = true;
        el.__c = true;
      } else if (k === 'disabled') el.disabled = true;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = (el, kids) => {
    el.append(...kids.flat(9).filter(c => c != null && c !== false && c !== ''));
    return el;
  };
  const h = (tag, attrs, ...kids) => {
    const el = doc.createElement(tag);
    setAttrs(el, attrs);
    return add(el, kids);
  };
  const svg = (tag, attrs, ...kids) => {
    const el = doc.createElementNS(SVG_NS, tag);
    setAttrs(el, attrs);
    return add(el, kids);
  };

  // ---------- перенос нового дерева в живой DOM

  const same = (a, b) =>
    a.nodeType === b.nodeType &&
    (a.nodeType !== 1 ||
      (a.namespaceURI === b.namespaceURI && a.nodeName === b.nodeName && a.__k === b.__k &&
        (a.nodeName !== 'INPUT' || a.type === b.type)));

  // kids — новые узлы. Узлы с key сопоставляются по ключу, остальные — по порядку и тегу.
  // В entered попадают корни вставленных поддеревьев: им нужна анимация появления.
  function patch(parent, kids, entered = []) {
    kids = kids.flat(9).filter(c => c != null && c !== false && c !== '').map(c => (typeof c === 'object' ? c : doc.createTextNode(String(c))));
    const old = Array.from(parent.childNodes);
    const keyed = new Map();
    for (const c of old) if (c.__k !== undefined) keyed.set(c.__k, c);
    const free = old.filter(c => c.__k === undefined);
    let f = 0;
    const used = new Set(), next = [];
    for (const n of kids) {
      const o = n.__k !== undefined ? keyed.get(n.__k) : free[f];
      if (o && !used.has(o) && same(o, n)) {
        if (n.__k === undefined) f++;
        used.add(o);
        morph(o, n, entered);
        next.push(o);
      } else {
        // Узел с тем же ключом сменил тег (строка-кнопка ↔ строка-блок): это не «новый» блок,
        // а замена — FLIP поведёт её со старого места без анимации появления.
        if (n.__k !== undefined && o && !used.has(o)) n.__was = o;
        next.push(n);
        entered.push(n);
      }
    }
    for (const c of old) if (!used.has(c)) c.remove();
    next.forEach((node, i) => {
      const at = parent.childNodes[i];
      if (at !== node) parent.insertBefore(node, at || null);
    });
    return entered;
  }

  function morph(o, n, entered) {
    if (o.nodeType !== 1) {
      if (o.nodeValue !== n.nodeValue) {
        const was = o.nodeValue;
        o.nodeValue = n.nodeValue;
        const p = o.parentNode;
        if (p && p.nodeType === 1 && p.hasAttribute('data-roll')) roll(p, was, n.nodeValue);
      }
      return;
    }
    for (let i = o.attributes.length - 1; i >= 0; i--) {
      const name = o.attributes[i].name;
      // Стиль, выставленный скриптом (высота поля, лист под пальцем), перерисовка не снимает.
      if (!n.hasAttribute(name) && !(name === 'style' && o.__keepStyle)) o.removeAttribute(name);
    }
    for (const a of n.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
    if (o.__keepClass) o.classList.add(o.__keepClass);
    if (n.__v !== undefined) {
      // Поле в фокусе не трогаем: владелец печатает или крутит барабан.
      if (o !== doc.activeElement && o.type !== 'file' && o.value !== n.__v) o.value = n.__v;
      o.__v = n.__v;
    }
    if (n.__c !== undefined || o.__c !== undefined) {
      o.checked = !!n.__c;
      o.__c = n.__c;
    }
    if (o.nodeName === 'BUTTON' || o.nodeName === 'INPUT') o.disabled = n.disabled;
    o.__on = n.__on;
    if (n.__on) for (const t in n.__on) o.addEventListener(t, fire);
    if (o.nodeName !== 'TEXTAREA') patch(o, Array.from(n.childNodes), entered);
  }

  // ---------- анимации

  function anim(el, frames, opts) {
    if (!el || !motion()) return null;
    try {
      return el.animate(frames, typeof opts === 'number' ? { duration: opts, easing: EASE.out } : { easing: EASE.out, ...opts });
    } catch {
      return null;
    }
  }
  const done = a => (a ? a.finished.then(() => {}, () => {}) : Promise.resolve());

  // Цифра «перекатывается»: больше — снизу вверх, меньше — сверху вниз.
  function roll(el, was, now) {
    const a = parseFloat(was), b = parseFloat(now);
    const dir = Number.isNaN(a) || Number.isNaN(b) || b >= a ? 1 : -1;
    anim(el, [{ transform: `translateY(${dir * 0.55}em)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 340, easing: EASE.spring });
  }

  // FLIP: до рендера запоминаем положение блоков [data-flip], после — плавно доводим их до нового места.
  function measure(scope) {
    if (!motion()) return null;
    const m = new Map();
    for (const el of scope.querySelectorAll('[data-flip]')) m.set(el, el.getBoundingClientRect());
    return m;
  }

  function flip(before, entered) {
    if (!before) {
      for (const el of entered) el.__was = null;
      return;
    }
    // Сначала снимаем незаконченные сдвиги и замеряем всё: начатая анимация родителя исказила бы замер детей.
    for (const [el] of before) if (el.__flip && el.isConnected) el.__flip.cancel();
    const raw = new Map();
    for (const [el, r] of before) {
      if (!el.isConnected) continue;
      const n = el.getBoundingClientRect();
      raw.set(el, [r.left - n.left, r.top - n.top]);
    }
    for (const el of entered) {
      const r = el.__was && before.get(el.__was);
      if (r && el.isConnected && el.hasAttribute('data-flip')) {
        const n = el.getBoundingClientRect();
        raw.set(el, [r.left - n.left, r.top - n.top]);
      }
    }
    for (const [el, [rx, ry]] of raw) {
      let dx = rx, dy = ry;
      // Вложенный блок уже едет вместе с родителем — двигаем только разницу.
      for (let p = el.parentElement; p; p = p.parentElement) {
        const d = raw.get(p);
        if (d) {
          dx -= d[0];
          dy -= d[1];
          break;
        }
      }
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.__flip = anim(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 420, easing: EASE.out });
    }
    let parent = null, i = 0;
    for (const el of entered) {
      const swapped = !!el.__was;
      el.__was = null;
      if (swapped || el.nodeType !== 1 || !el.hasAttribute('data-flip')) continue;
      i = el.parentNode === parent ? i + 1 : 0;
      parent = el.parentNode;
      anim(el, [{ opacity: 0, transform: 'translateY(-8px) scale(0.985)' }, { opacity: 1, transform: 'none' }],
        { duration: 340, delay: Math.min(i * 30, 240), easing: EASE.out, fill: 'backwards' });
    }
  }

  // Кольца «дорисовываются» от нуля до своего значения. Возвращает анимации — их можно придержать до показа.
  function draw(svgEl, delay = 0) {
    const out = [];
    if (!motion()) return out;
    svgEl.querySelectorAll('.arc').forEach((a, i) => {
      if (a.classList.contains('zero')) return;
      // Значения — из атрибута style: так надёжнее, чем разбор CSSOM (SVG-свойства понимают не везде).
      const st = a.getAttribute('style') || '';
      const C = parseFloat(/stroke-dasharray:\s*([\d.]+)/.exec(st)?.[1]);
      const to = /stroke-dashoffset:\s*([\d.]+px)/.exec(st)?.[1];
      if (!C || !to) return;
      out.push(anim(a, [{ strokeDashoffset: `${C}px` }, { strokeDashoffset: to }],
        { duration: 1000, delay: delay + (i % 4) * 90, easing: EASE.out, fill: 'backwards' }));
    });
    return out.filter(Boolean);
  }

  const FRAMES = {
    rise: [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
    pop: [{ opacity: 0, transform: 'scale(0.4)' }, { opacity: 1, transform: 'none' }],
    'grow-x': [{ transform: 'scaleX(0)' }, { transform: 'none' }],
    'grow-y': [{ transform: 'scaleY(0)' }, { transform: 'none' }],
  };

  // Дети контейнера [data-stagger="pop|rise|grow-x|grow-y"] появляются по очереди; порядок — data-d или индекс.
  function stagger(box) {
    const out = [];
    if (!motion()) return out;
    const kind = box.getAttribute('data-stagger') || 'rise';
    const sel = box.getAttribute('data-stagger-sel');
    const step = +box.getAttribute('data-step') || 28;
    const els = sel ? box.querySelectorAll(sel) : box.children;
    let i = 0;
    for (const el of els) {
      const d = el.hasAttribute('data-d') ? +el.getAttribute('data-d') : i;
      out.push(anim(el, FRAMES[kind] || FRAMES.rise, {
        duration: kind === 'pop' ? 420 : 520, delay: Math.min(d * step, 900),
        easing: kind === 'pop' ? EASE.spring : EASE.out, fill: 'backwards',
      }));
      i++;
    }
    return out.filter(Boolean);
  }

  // Анимации блока ниже таб-бара стоят на первом кадре и запускаются, когда блок покажется.
  let io = null;
  const watched = new Set();
  function reveal(el, anims) {
    if (!anims.length) return;
    if (typeof win.IntersectionObserver !== 'function') return;
    for (const a of anims) a.pause();
    io ||= new win.IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        watched.delete(e.target);
        const list = e.target.__reveal || [];
        e.target.__reveal = null;
        for (const a of list) a.play();
      }
    }, { rootMargin: '0px 0px -72px 0px' });
    // Блоки ушедших экранов, до которых так и не долистали, — отпускаем, чтобы не копились.
    for (const w of watched) {
      if (w.isConnected) continue;
      io.unobserve(w);
      w.__reveal = null;
      watched.delete(w);
    }
    el.__reveal = anims;
    watched.add(el);
    io.observe(el);
  }

  // Число набегает от нуля.
  function countUp(el, to, duration = 800) {
    if (!motion() || !(to > 1) || typeof win.requestAnimationFrame !== 'function') return;
    const t0 = win.performance.now();
    const step = t => {
      if (!el.isConnected) return;
      const p = Math.min(1, (t - t0) / duration);
      el.textContent = String(Math.round(to * (1 - (1 - p) ** 3)));
      if (p < 1) win.requestAnimationFrame(step);
    };
    el.textContent = '0';
    win.requestAnimationFrame(step);
  }

  // Конфетти из центра элемента — в отдельном слое вне экрана: перерисовка его не задевает.
  let fx = null, seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  function burst(origin, colors, { n = 22, spread = 1, delay = 0 } = {}) {
    if (!motion() || !origin || !origin.isConnected) return;
    if (!fx) {
      fx = doc.createElement('div');
      fx.className = 'fx';
      fx.setAttribute('aria-hidden', 'true');
      doc.body.append(fx);
    }
    const r = origin.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < n; i++) {
      const p = doc.createElement('i');
      p.className = i % 3 ? 'spark' : 'spark spark-bar';
      p.style.background = colors[i % colors.length];
      p.style.left = `${cx}px`;
      p.style.top = `${cy}px`;
      fx.append(p);
      const ang = (i / n) * Math.PI * 2 + rnd() * 0.5;
      const dist = (72 + rnd() * 84) * spread, rot = (rnd() - 0.5) * 600;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
      // До старта частица невидима: иначе на задержке она висела бы точкой в центре.
      const a = anim(p, [
        { transform: 'translate(0, 0) scale(0.2)', opacity: 0 },
        { transform: `translate(${dx * 0.25}px, ${dy * 0.25}px) scale(0.8)`, opacity: 1, offset: 0.12 },
        { transform: `translate(${dx * 0.8}px, ${dy * 0.8}px) rotate(${rot * 0.6}deg) scale(1)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy + 34}px) rotate(${rot}deg) scale(0.7)`, opacity: 0 },
      ], { duration: 640 + rnd() * 300, delay, easing: 'cubic-bezier(0.15, 0.8, 0.3, 1)', fill: 'both' });
      if (a) done(a).then(() => p.remove());
      else p.remove();
    }
  }

  // ---------- тактильный отклик

  // iOS 18+: переключатель <input type=checkbox switch> отвечает системной вибрацией — нажимаем его скрыто.
  // Android и прочие — navigator.vibrate. Где нет ни того, ни другого — тишина.
  const ios = /iP(hone|ad|od)/.test(win.navigator.userAgent || '') ||
    (/Macintosh/.test(win.navigator.userAgent || '') && 'ontouchend' in doc);
  let switchEl = null;
  function haptic() {
    try {
      if (ios) {
        if (!switchEl) {
          switchEl = doc.createElement('label');
          switchEl.className = 'haptic';
          switchEl.setAttribute('aria-hidden', 'true');
          const input = doc.createElement('input');
          input.type = 'checkbox';
          input.setAttribute('switch', '');
          input.tabIndex = -1;
          switchEl.append(input);
          doc.body.append(switchEl);
        }
        switchEl.click();
      } else if (typeof win.navigator.vibrate === 'function' && win.navigator.userActivation?.isActive) {
        win.navigator.vibrate(8);
      }
    } catch {}
  }

  // ---------- жесты

  // Короткое касание — onTap, удержание 450 мс — onHold (и отклик). Сдвиг пальца или прокрутка отменяют удержание.
  // После удержания палец отпускают уже над открывшимся листом: iOS может «кликнуть» туда.
  // Такой клик глотаем — до следующего касания или 350 мс после отпускания (палец могут держать долго);
  // 10 с — на случай, если отпускания так и не пришло.
  let swallowing = false;
  function swallowNextClick() {
    if (swallowing) return;
    swallowing = true;
    const eat = e => {
      if (!e.detail) return; // клавиатура, VoiceOver и программные клики (detail 0) — не трогаем
      e.stopPropagation();
      e.preventDefault();
    };
    let t = 0;
    const off = () => {
      swallowing = false;
      win.clearTimeout(t);
      doc.removeEventListener('click', eat, true);
      doc.removeEventListener('pointerdown', off, true);
      doc.removeEventListener('pointerup', later, true);
      doc.removeEventListener('pointercancel', later, true);
    };
    const later = () => {
      win.clearTimeout(t);
      t = win.setTimeout(off, 350);
    };
    doc.addEventListener('click', eat, true);
    doc.addEventListener('pointerdown', off, true);
    doc.addEventListener('pointerup', later, true);
    doc.addEventListener('pointercancel', later, true);
    t = win.setTimeout(off, 10000);
  }

  function holdable(onTap, onHold, ms = 450) {
    const stop = el => {
      win.clearTimeout(el.__ht);
      el.__ht = 0;
      el.__keepClass = null;
      el.classList.remove('holding');
    };
    return {
      onpointerdown(e) {
        if (e.button > 0) return;
        const el = this;
        stop(el);
        el.__held = false;
        el.__hx = e.clientX;
        el.__hy = e.clientY;
        el.classList.add('holding');
        el.__keepClass = 'holding';
        el.__ht = win.setTimeout(() => {
          el.__ht = 0;
          el.__held = true;
          el.__keepClass = null;
          el.classList.remove('holding');
          haptic();
          swallowNextClick();
          onHold();
        }, ms);
      },
      onpointermove(e) {
        if (this.__ht && Math.hypot(e.clientX - this.__hx, e.clientY - this.__hy) > 10) stop(this);
      },
      onpointerup() {
        stop(this);
        // На iPhone клик после удержания съедает фильтр документа и до строки не доходит — флаг снимаем сами,
        // иначе следующий клик с клавиатуры или VoiceOver пропал бы.
        if (this.__held) { const el = this; win.setTimeout(() => (el.__held = false), 350); }
      },
      onpointercancel() { stop(this); },
      onpointerleave() { stop(this); },
      oncontextmenu(e) { e.preventDefault(); },
      onclick(e) {
        if (this.__held) {
          this.__held = false;
          return;
        }
        onTap(e);
      },
    };
  }

  // Лист тянется вниз за шапку или, когда содержимое прокручено до верха, за любое место.
  // close(dy) — закрыть с текущей позиции; guard() → true, если закрывать нельзя (есть несохранённое).
  function dragSheet(sheet, { close, guard }) {
    const panel = sheet.querySelector('.sheet-panel'), back = sheet.querySelector('.sheet-back');
    if (!panel || !back || panel.__drag) return;
    panel.__drag = true;
    let mode = null, y0 = 0, dy = 0, v = 0, ly = 0, lt = 0;
    const clock = () => (win.performance ? win.performance.now() : Date.now());
    const onHandle = t => !!t.closest?.('.grabber, .sheet-head') && !t.closest('button, a, input, textarea, label');
    const typing = t => !!t.closest?.('input, textarea') && t === doc.activeElement;
    const set = y => {
      dy = y;
      panel.__keepStyle = back.__keepStyle = true; // перерисовка под пальцем не сбросит положение
      panel.style.transform = `translateY(${y}px)`;
      back.style.opacity = String(Math.max(0, 1 - y / (panel.offsetHeight || 600)));
    };
    const settle = () => {
      const from = dy, op = back.style.opacity || '1';
      dy = 0;
      panel.__keepStyle = back.__keepStyle = false;
      panel.style.transform = '';
      back.style.opacity = '';
      anim(panel, [{ transform: `translateY(${from}px)` }, { transform: 'none' }], { duration: 380, easing: EASE.ios });
      anim(back, [{ opacity: op }, { opacity: 1 }], 260);
    };
    const start = (y, t) => {
      mode = null;
      if (typing(t)) return;
      y0 = ly = y;
      lt = clock();
      dy = 0;
      v = 0;
      mode = onHandle(t) ? 'arm' : panel.scrollTop <= 0 ? 'maybe' : null;
    };
    const move = (y, e) => {
      if (!mode) return;
      const d = y - y0;
      if (mode === 'maybe') {
        if (d < 0 || panel.scrollTop > 0) return void (mode = null);
        if (d === 0) return;
        mode = 'drag';
      }
      if (mode === 'arm') {
        if (Math.abs(d) < 4) return;
        mode = 'drag';
      }
      if (e.cancelable === false) {
        mode = null;
        settle();
        return;
      }
      e.preventDefault();
      const t = clock();
      v = (y - ly) / Math.max(1, t - lt);
      ly = y;
      lt = t;
      set(d > 0 ? d : d / 5); // вверх — с сопротивлением
    };
    const end = () => {
      if (mode !== 'drag') return void (mode = null);
      mode = null;
      if (clock() - lt > 100) v = 0; // дотянул и замер — решает расстояние, а не старый рывок
      const far = dy > (panel.offsetHeight || 600) * 0.25 || (v > 0.55 && dy > 24);
      if (far && !(guard && guard())) {
        haptic();
        const from = dy;
        dy = 0;
        close(from);
      } else settle();
    };
    // Касание отменила система (звонок, жест iOS) — лист возвращается, а не закрывается.
    const cancel = () => {
      const was = mode;
      mode = null;
      if (was === 'drag') settle();
    };
    if ('ontouchstart' in win) {
      panel.addEventListener('touchstart', e => start(e.touches[0].clientY, e.target), { passive: true });
      panel.addEventListener('touchmove', e => move(e.touches[0].clientY, e), { passive: false });
      panel.addEventListener('touchend', end);
      panel.addEventListener('touchcancel', cancel);
    } else {
      // Мышь и стилус — только за шапку.
      panel.addEventListener('pointerdown', e => {
        if (e.pointerType === 'touch') return;
        start(e.clientY, e.target);
        if (mode !== 'arm') return void (mode = null);
        try { panel.setPointerCapture?.(e.pointerId); } catch {}
      });
      panel.addEventListener('pointermove', e => move(e.clientY, e));
      panel.addEventListener('pointerup', end);
      panel.addEventListener('pointercancel', cancel);
    }
  }

  return { h, svg, patch, motion, anim, done, measure, flip, draw, stagger, reveal, countUp, burst, haptic, holdable, dragSheet };
}
