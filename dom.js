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

// skyIdle — сколько без касаний небо идёт, прежде чем стихнуть (тесты передают короткое).
export function createDOM(win, { skyIdle = 60e3 } = {}) {
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

  // Цифра «перекатывается»: больше — снизу вверх, меньше — сверху вниз. Числа сравниваются по порядку:
  // «6 ч 45 мин» → «6 ч 30 мин» — меньше, «3 из 9» → «4 из 9» — больше.
  const nums = t => (String(t).match(/\d+/g) || []).map(Number);
  function roll(el, was, now) {
    const a = nums(was), b = nums(now);
    let dir = 1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) {
        dir = (b[i] ?? 0) > (a[i] ?? 0) ? 1 : -1;
        break;
      }
    }
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
  function layer() {
    if (fx && fx.isConnected) return;
    fx = doc.createElement('div');
    fx.className = 'fx';
    fx.setAttribute('aria-hidden', 'true');
    doc.body.append(fx);
  }
  // stars — цвет звёзд: тогда каждая четвёртая частица — звезда (праздник закрытого дня, v61);
  // theme — тема неба: каждая пятая частица — её фигура (снежинка, лепесток, лист, капля; летом — золотая звезда,
  // на Новый год — звёзды цветами гирлянды).
  const SHAPES = {
    winter: ['spark-snow', ['var(--snow)', 'var(--snow-2)']],
    spring: ['spark-petal', ['var(--petal-1)', 'var(--petal-2)', 'var(--petal-3)']],
    summer: ['spark-star', ['var(--fly)', 'var(--sun-1)']],
    autumn: ['spark-leaf', ['var(--leaf-1)', 'var(--leaf-2)', 'var(--leaf-3)', 'var(--leaf-4)']],
    newyear: ['spark-star', ['var(--bulb-1)', 'var(--bulb-2)', 'var(--bulb-3)', 'var(--bulb-4)', 'var(--bulb-5)']],
    rain: ['spark-drop', ['var(--rain)', 'var(--rain-2)']],
  };
  function burst(origin, colors, { n = 22, spread = 1, delay = 0, stars = '', theme = '' } = {}) {
    if (!motion() || !origin || !origin.isConnected) return;
    layer();
    const r = origin.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const shape = SHAPES[theme];
    for (let i = 0; i < n; i++) {
      const p = doc.createElement('i');
      const star = stars && i % 4 === 1, own = shape && i % 5 === 3;
      p.className = own ? `spark ${shape[0]}` : star ? 'spark spark-star' : i % 3 ? 'spark' : 'spark spark-bar';
      p.style.background = own ? shape[1][i % shape[1].length] : star ? stars : colors[i % colors.length];
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

  // Звёзды над элементами (v61): над каждым сегментом полосы минимума — своя звезда, волной слева направо.
  // Сколько привычек закрыто — столько звёзд; волна сжимается так, чтобы всё уложилось в within (праздник ≤ 1,3 с).
  function rise(origins, color, { delay = 0, dist = 44, duration = 700, within = 1300 } = {}) {
    if (!motion()) return;
    const list = [...origins].filter(o => o?.isConnected);
    if (!list.length) return;
    layer();
    const step = list.length > 1 ? Math.min(60, Math.max(0, within - delay - duration) / (list.length - 1)) : 0;
    list.forEach((o, i) => {
      const r = o.getBoundingClientRect();
      const p = doc.createElement('i');
      p.className = 'spark spark-star spark-rise';
      p.style.background = color;
      p.style.left = `${r.left + r.width / 2}px`;
      p.style.top = `${r.top + r.height / 2}px`;
      fx.append(p);
      const up = dist + rnd() * 16, sway = (rnd() - 0.5) * 18, rot = (rnd() - 0.5) * 120;
      const a = anim(p, [
        { transform: 'translate(0, 0) scale(0.2)', opacity: 0, easing: EASE.spring },
        { transform: `translate(${sway * 0.3}px, ${-up * 0.45}px) scale(1.15)`, opacity: 1, offset: 0.35, easing: EASE.out },
        { transform: `translate(${sway}px, ${-up}px) rotate(${rot}deg) scale(0.6)`, opacity: 0 },
      ], { duration, delay: delay + i * step, easing: 'linear', fill: 'both' });
      if (a) done(a).then(() => p.remove());
      else p.remove();
    });
  }

  // Голос «я» (v61): плашка поднимается над отметкой и тает (≈ 2,2 с) — в том же слое, что конфетти.
  // Текст — только текстовыми узлами. Без движения — false: тогда приложение говорит то же обычной полосой.
  // round — круглое число голосов: плашка закатом, крупнее, дольше и с салютом звёзд и фигур темы.
  function vote(origin, { over, text, color, glyph, round = false, theme = '' }) {
    if (!motion() || !origin || !origin.isConnected) return false;
    layer();
    for (const old of [...fx.querySelectorAll('.vote')].slice(0, -2)) old.remove(); // не больше трёх разом
    const r = origin.getBoundingClientRect();
    const el = doc.createElement('div');
    el.className = round ? 'vote round' : 'vote';
    el.style.setProperty('--vc', color);
    const dot = doc.createElement('span');
    dot.className = 'vote-dot';
    if (glyph) {
      const g = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      g.setAttribute('viewBox', '0 0 24 24');
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', glyph);
      g.append(path);
      dot.append(g);
    }
    const t = doc.createElement('span');
    t.className = 'vote-txt';
    const a = doc.createElement('span');
    a.className = 'vote-over';
    a.textContent = over;
    const b = doc.createElement('span');
    b.className = 'vote-who';
    b.textContent = text;
    t.append(a, b);
    el.append(dot, t);
    fx.append(el);
    // Над строкой, правым краем — к отметке; у края экрана — внутрь.
    const vw = win.innerWidth || doc.documentElement.clientWidth || 0;
    const w = el.offsetWidth, hh = el.offsetHeight;
    el.style.left = `${Math.max(12, Math.min(vw - 12 - w, r.right - w + 6))}px`;
    el.style.top = `${Math.max(8, r.top - hh - 4)}px`;
    // Кривая — у каждого участка своя: вылет с пружиной, покой, уход вверх с таянием.
    const an = anim(el, [
      { transform: 'translateY(14px) scale(0.82)', opacity: 0, easing: EASE.spring },
      { transform: `translateY(0) scale(${round ? 1.06 : 1})`, opacity: 1, offset: round ? 0.14 : 0.2, easing: 'linear' },
      { transform: 'translateY(-4px) scale(1)', opacity: 1, offset: round ? 0.84 : 0.78, easing: EASE.in },
      { transform: 'translateY(-22px) scale(0.96)', opacity: 0 },
    ], { duration: round ? 3200 : 2200, easing: 'linear', fill: 'both' });
    if (!an) {
      el.remove();
      return false;
    }
    if (round) burst(el, ['var(--sun-1)', 'var(--sun-2)', 'var(--sun-3)', color], { n: 24, spread: 0.9, delay: 160, stars: 'var(--fly)', theme });
    // Прокрутили (экран или лист) — плашка отстала бы от строки: тает сразу.
    let gone = false;
    const away = () => {
      if (gone || !el.isConnected) return;
      gone = true;
      const o = win.getComputedStyle(el).opacity;
      an.cancel();
      const out = anim(el, [{ opacity: o }, { opacity: 0 }], { duration: 160, easing: 'linear', fill: 'both' });
      if (out) done(out).then(() => el.remove());
      else el.remove();
    };
    doc.addEventListener('scroll', away, { capture: true, once: true, passive: true });
    done(an).then(() => {
      doc.removeEventListener('scroll', away, { capture: true });
      if (!gone) el.remove();
    });
    return true;
  }

  // ---------- небо темы (v61). Три слоя вне #app — перерисовка их не трогает:
  // .sky — цвет неба за экраном; .sky-lights — гирлянда Нового года, тоже за экраном (текст всегда поверх);
  // .sky-fall — снег, лепестки, светлячки, листья и дождь тонким слоем поверх (касаний не ловит, под листом и
  // подтверждением гаснет — CSS по body.locked; смешивается с экраном так, что текст остаётся поверх: в светлой —
  // умножением, в тёмной — осветлением, CSS). У частицы своя глубина: ближние крупнее, ярче и быстрее (параллакс).
  // Падение ровное, качание — синусом, лепестки и листья переворачиваются, светлячок тлеет, дождь — косыми штрихами.
  // Только transform и opacity. Небо проявляется мягко, смена темы — перетекание. Минута без касаний — небо стихает:
  // частицы тают, лампочки дотлевают свой вдох и горят ровно (батарея не тратится); касание — небо оживает.
  // Без движения — цвет и ровная гирлянда. Ушли в фон — пауза; поменялись размер окна или «Уменьшение движения» — заново.
  const SKY = {
    // dur — [дальние, ближние]: ближние падают быстрее
    winter: { n: 28, cls: 'sky-snow', size: [3.5, 9], dur: [17000, 9000], sway: 24, peak: [0.4, 1], colors: ['var(--snow)', 'var(--snow-2)'] },
    spring: { n: 12, cls: 'sky-petal', size: [6, 10.5], dur: [19000, 12000], sway: 40, spin: 200, flip: 1.6, peak: [0.45, 0.9], colors: ['var(--petal-1)', 'var(--petal-2)', 'var(--petal-3)'] },
    summer: { n: 12, cls: 'sky-fly', size: [3, 6], dur: [24000, 15000], sway: 34, glow: 4, up: true, peak: [0.45, 0.85], colors: ['var(--fly)'] },
    autumn: { n: 10, cls: 'sky-leaf', size: [8, 13], dur: [18000, 11000], sway: 52, spin: 300, flip: 1.8, peak: [0.55, 0.9], colors: ['var(--leaf-1)', 'var(--leaf-2)', 'var(--leaf-3)', 'var(--leaf-4)'] },
    newyear: { n: 16, cls: 'sky-snow', size: [3, 7.5], dur: [18000, 10000], sway: 20, peak: [0.35, 0.9], colors: ['var(--snow)', 'var(--snow-2)'], lights: true },
    rain: { n: 26, cls: 'sky-rain', size: [10, 22], dur: [3000, 1700], slant: 0.2, peak: [0.25, 0.6], colors: ['var(--rain)', 'var(--rain-2)'] },
  };
  const SKY_STEPS = 24; // кадров на круг: между ними — прямая, поэтому падение ровное, а качание — почти синус
  const BULBS = ['var(--bulb-1)', 'var(--bulb-2)', 'var(--bulb-3)', 'var(--bulb-4)', 'var(--bulb-5)'];
  const BREATH = 3600, WAVE = 300; // вдох лампочки и шаг волны по гирлянде, мс
  const TAU = Math.PI * 2;
  const lerp = ([a, b], z) => a + (b - a) * z;
  const clock = () => (win.performance?.now ? win.performance.now() : Date.now());
  let skyEl = null, lightsEl = null, fallEl = null, skyKind = null, skyMo = null, skyW = 0, skyH = 0;
  let fallAnims = [], bulbAnims = [], bulbs = [], asleep = false, stirAt = clock(), napTimer = 0, napFade = null, napList = [];
  const skyLayer = cls => {
    const el = doc.createElement('div');
    el.className = cls;
    el.setAttribute('aria-hidden', 'true');
    return el;
  };
  const fadeIn = (el, delay = 0) => {
    if (!doc.body.classList.contains('locked')) anim(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 1400, delay, easing: 'ease-in-out', fill: 'backwards' });
  };
  // Тает с той яркости, что сейчас на экране (слой мог ещё проявляться) — без вспышки.
  const fadeOut = (el, duration, then) => {
    const o = parseFloat(win.getComputedStyle(el).opacity);
    return done(anim(el, [{ opacity: Number.isFinite(o) ? o : 1 }, { opacity: 0 }], { duration, easing: 'ease-in-out', fill: 'forwards' })).then(then);
  };

  function sky(kind = '') {
    const W = win.innerWidth || 0, H = win.innerHeight || 0, mo = motion(), sk = kind || 'none';
    // Высота окна в браузере гуляет от панелей — небо заново только при заметной разнице.
    if (kind === skyKind && mo === skyMo && skyEl?.isConnected && fallEl?.isConnected && W === skyW && Math.abs(H - skyH) <= 120) return;
    const swap = mo && skyKind !== null && kind !== skyKind; // тема сменилась на глазах — перетекание, не щелчок
    // Цвет неба: прежний — призраком поверх нового — тает.
    if (!skyEl?.isConnected) {
      skyEl = skyLayer('sky');
      doc.body.prepend(skyEl);
    } else if (swap && skyEl.dataset.kind !== sk) {
      const ghost = skyLayer('sky');
      ghost.dataset.kind = skyEl.dataset.kind;
      skyEl.after(ghost);
      fadeOut(ghost, 900, () => ghost.remove());
    }
    skyEl.dataset.kind = sk;
    [skyKind, skyMo, skyW, skyH] = [kind, mo, W, H];
    const cfg = SKY[kind];
    // Гирлянда: прежняя тает, новая проявляется.
    const oldLights = lightsEl?.isConnected ? lightsEl : null, oldBulbs = bulbAnims;
    bulbAnims = [];
    bulbs = [];
    lightsEl = null;
    if (oldLights) {
      const drop = () => { oldBulbs.forEach(a => a.cancel()); oldLights.remove(); };
      if (swap) fadeOut(oldLights, 700, drop);
      else drop();
    }
    if (cfg?.lights && W) {
      lightsEl = garland(W);
      skyEl.after(lightsEl);
      if (mo) {
        bulbAnims = bulbs.map(breathe);
        fadeIn(lightsEl, swap ? 250 : 0);
      }
    }
    // Частицы: прежние тают и уходят, новые проявляются (стихшее небо — тоже заново).
    const old = fallEl?.isConnected ? fallEl : null, oldAnims = fallAnims.concat(napList);
    napFade?.cancel();
    [fallAnims, napList, napFade] = [[], [], null];
    if (old) {
      const drop = () => { oldAnims.forEach(a => a.cancel()); old.remove(); };
      if (swap) fadeOut(old, 600, drop);
      else drop();
    }
    fallEl = skyLayer('sky-fall');
    fallEl.dataset.kind = sk;
    doc.body.append(fallEl);
    asleep = false;
    if (cfg && mo && W && H) {
      fall(cfg, W, H);
      fadeIn(fallEl, swap ? 250 : 0);
    }
    stirAt = clock();
    arm();
  }

  // Частицы неба — в fallEl, по кругу, с отрицательной задержкой: сразу на всём экране.
  function fall(cfg, W, H) {
    const slant = cfg.slant || 0;
    for (let i = 0; i < cfg.n; i++) {
      const z = (i + rnd()) / cfg.n; // глубина: 0 — далеко, 1 — близко; дальних и ближних поровну
      const p = doc.createElement('i');
      p.className = `sky-p ${cfg.cls}`;
      const sz = lerp(cfg.size, z);
      if (slant) p.style.height = `${sz.toFixed(1)}px`; // штрих дождя: длина — по глубине, толщина — CSS
      else {
        p.style.width = `${sz.toFixed(1)}px`;
        p.style.height = `${(cfg.cls === 'sky-petal' ? sz * 0.78 : sz).toFixed(1)}px`;
      }
      // косой дождь сносит влево — начинается и правее экрана
      p.style.left = `${Math.round(rnd() * (W + slant * H))}px`;
      p.style.setProperty('--fc', cfg.colors[i % cfg.colors.length]); // снежинка — мягким пятном, остальные — заливкой
      fallEl.append(p);
      const dur = Math.round(lerp(cfg.dur, z) * (0.9 + rnd() * 0.2));
      const [y0, y1] = cfg.up ? [H + 30, -30] : [-30, H + 30];
      const sw = (0.5 + z * 0.5) * (cfg.sway || 0) * (0.7 + rnd() * 0.6) * (rnd() < 0.5 ? -1 : 1);
      const rot = (cfg.spin || 0) * (0.5 + rnd()) * (rnd() < 0.5 ? -1 : 1);
      const peak = lerp(cfg.peak, z), waves = 1 + rnd(), flips = (cfg.flip || 0) * (0.6 + rnd() * 0.8);
      const ph = rnd() * TAU, ph2 = rnd() * TAU;
      const tilt = slant ? Math.round((Math.atan(slant) * 180) / Math.PI) : 0; // штрих — вдоль падения
      const frames = [];
      for (let k = 0; k <= SKY_STEPS; k++) {
        const f = k / SKY_STEPS;
        const y = y0 + (y1 - y0) * f;
        const x = slant ? -slant * (y1 - y0) * f : sw * Math.sin(f * TAU * waves + ph);
        const turn = flips ? ` scaleX(${Math.cos(f * TAU * flips + ph2).toFixed(2)})` : ''; // лист переворачивается
        const edge = Math.min(1, f / 0.1, (1 - f) / 0.1); // проявляется и тает у краёв экрана
        const glow = cfg.glow ? 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(f * TAU * cfg.glow + ph2)) : 1; // светлячок тлеет — медленно, не мигает
        frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${slant ? tilt : Math.round(rot * f)}deg)${turn}`, opacity: +(peak * edge * glow).toFixed(3) });
      }
      const a = anim(p, frames, { duration: dur, delay: -Math.round(rnd() * dur), iterations: Infinity, easing: 'linear' });
      if (a) fallAnims.push(a);
    }
  }

  // Гирлянда Нового года: провод провисает дугами вдоль верхнего края, на нём — лампочки пяти цветов.
  function garland(W) {
    const el = skyLayer('sky-lights');
    const arcs = Math.max(2, Math.round(W / 110)), span = (W + 24) / arcs, top = -2, sag = 9, per = 4;
    let d = `M-12 ${top}`;
    for (let a = 0; a < arcs; a++) {
      const x0 = -12 + a * span;
      d += ` Q${(x0 + span / 2).toFixed(1)} ${top + sag * 2} ${(x0 + span).toFixed(1)} ${top}`;
    }
    const NS = 'http://www.w3.org/2000/svg';
    const wire = doc.createElementNS(NS, 'svg');
    wire.setAttribute('class', 'sky-wire');
    wire.setAttribute('width', String(W));
    wire.setAttribute('height', String(top + sag * 2 + 4));
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    wire.append(path);
    el.append(wire);
    for (let a = 0; a < arcs; a++) {
      for (let k = 1; k <= per; k++) {
        const t = k / (per + 1), x = -12 + (a + t) * span, y = top + 4 * sag * t * (1 - t); // точка на дуге провода
        const b = doc.createElement('i');
        b.className = 'sky-bulb';
        b.style.left = `${x.toFixed(1)}px`;
        b.style.top = `${y.toFixed(1)}px`;
        b.style.setProperty('--fc', BULBS[bulbs.length % BULBS.length]);
        el.append(b);
        bulbs.push(b);
      }
    }
    return el;
  }
  // Вдох лампочки: ярко — тише — ярко; волна бежит по гирлянде (задержка по порядку — до старта лампочка горит ровно).
  const breathe = (b, i) => anim(b, [
    { opacity: 1, transform: 'scale(1)' },
    { opacity: 0.45, transform: 'scale(0.86)' },
    { opacity: 1, transform: 'scale(1)' },
  ], { duration: BREATH, delay: i * WAVE, iterations: Infinity, easing: 'ease-in-out' });

  // Минута без касаний — небо стихает. Частицы тают; лампочка дотлевает свой вдох и горит ровно (ещё не начала — сразу).
  function nap() {
    if (asleep || (!fallAnims.length && !bulbAnims.length)) return;
    asleep = true;
    const el = fallEl;
    napList = fallAnims;
    fallAnims = [];
    napFade = napList.length ? anim(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 2400, easing: 'ease-in-out', fill: 'forwards' }) : null;
    done(napFade).then(() => {
      if (!asleep || el !== fallEl) return; // проснулись раньше — частицы остались
      napList.forEach(a => a.cancel());
      napList = [];
      while (el.firstChild) el.firstChild.remove();
    });
    for (const a of bulbAnims) {
      try {
        const it = a.effect.getComputedTiming().currentIteration;
        if (it == null) a.cancel();
        else a.effect.updateTiming({ iterations: it + 1 });
      } catch {
        a.cancel();
      }
    }
  }
  // Касание — небо оживает: таяние ещё идёт — частицы возвращаются тем же путём, растаяли — проявляются заново;
  // гирлянда снова дышит.
  function wake() {
    if (!asleep) return;
    asleep = false;
    const cfg = SKY[skyKind];
    if (napFade?.playState === 'running' && napList.length) {
      napFade.reverse();
      fallAnims = napList;
    } else if (cfg && skyMo && skyW && skyH && fallEl?.isConnected) {
      napFade?.cancel();
      const old = fallEl;
      fallEl = skyLayer('sky-fall');
      fallEl.dataset.kind = old.dataset.kind;
      old.after(fallEl);
      old.remove();
      fall(cfg, skyW, skyH);
      fadeIn(fallEl);
    }
    napFade = null;
    napList = [];
    bulbAnims = bulbs.map((b, i) => {
      const a = bulbAnims[i];
      if (a && a.playState === 'running') {
        try {
          a.effect.updateTiming({ iterations: Infinity }); // ещё дотлевает — просто дышит дальше
          return a;
        } catch {}
      }
      a?.cancel();
      return breathe(b, i);
    }).filter(Boolean);
    arm();
  }
  function arm() {
    win.clearTimeout(napTimer);
    if (fallAnims.length || bulbAnims.length) napTimer = win.setTimeout(check, skyIdle);
  }
  function check() {
    const idle = clock() - stirAt;
    if (idle >= skyIdle - 20) nap();
    else napTimer = win.setTimeout(check, skyIdle - idle);
  }
  const stir = () => {
    stirAt = clock();
    if (asleep) wake();
  };
  for (const t of ['pointerdown', 'keydown', 'wheel', 'scroll']) doc.addEventListener(t, stir, { capture: true, passive: true });
  doc.addEventListener('visibilitychange', () => {
    // снятые и доигравшие не трогаем: play() запустил бы их заново
    for (const a of [...fallAnims, ...bulbAnims]) if (a.playState !== 'finished' && a.playState !== 'idle') doc.hidden ? a.pause() : a.play();
    if (!doc.hidden) stir();
  });

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

  return { h, svg, patch, motion, anim, done, measure, flip, draw, stagger, reveal, countUp, burst, rise, vote, sky, haptic, holdable, dragSheet };
}
