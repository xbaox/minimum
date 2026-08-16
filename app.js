'use strict';
/* ============================================================
   МИНИМУМ — трекер ежедневного минимума
   Без зависимостей. Данные — localStorage, схема версионируется.
   ============================================================ */

/* ── ТЕКСТЫ РАЗДЕЛА «СИСТЕМА» ────────────────────────────────
   Правятся только здесь. kind: 'leads' — абзацы с жирным
   зачином, 'rules' — нумерованный канон, 'note' — врезка. */
const SYSTEM_TEXTS = [
  {
    kind: 'leads',
    title: 'Архитектура — три решения',
    items: [
      { lead: 'Минимум отделён от нормы.', text: 'Минимум — неснижаемая планка, которая выполняется даже в худший день. Норма — обычный объём. Приложение видит только минимум.' },
      { lead: 'Единица самооценки — неделя.', text: 'День фиксируется, но не оценивается; картина складывается раз в неделю на разборе.' },
      { lead: 'Инициатива у человека.', text: 'Система не напоминает, не повышает планку сама и ничего не решает за владельца.' }
    ]
  },
  {
    kind: 'rules',
    title: 'Пять правил',
    items: [
      'Минимум выполняется даже в худший день.',
      'Не пропускай дважды: пропуск — событие, два подряд — начало новой привычки.',
      // Правило держится механикой в одном месте из двух: повышение планки
      // разбор предлагает одному пункту за раз. Второе — «одно изменение» на
      // неделю — свободное поле, и держит его сам владелец. Прежде здесь
      // называлась и лестница («лестница одна»); она снята задачей 28.D, и
      // текст не вправе обещать механику, которой в приложении нет
      // (задача 26, п. 7.2: «Система» описывает то, что приложение делает).
      'Одно изменение за раз: повышение планки одно за разбор; «одно изменение» недели держит сам владелец.',
      'Самооценка раз в неделю, не ежедневно.',
      'Планка повышается только вручную и только после устойчивых трёх недель.'
    ]
  },
  {
    // Прежний текст перечислял Тело · Движение · Сон · Развитие — набор,
    // которого у владельца нет: посев заводит Утро · Подряд · Движение
    // (задача 26, п. 7.3). Названо стартовым, чтобы не разойтись снова:
    // блоки переименовываются и удаляются.
    kind: 'leads',
    title: 'Блоки',
    items: [
      { lead: 'Блок — связка пунктов.', text: 'На дневном экране они соединены линией и идут подряд. Линия показывает принадлежность, а не очередь: порядок не принудителен.' },
      { lead: 'Стартовая программа:', text: 'Утро — умыться, душ. Подряд — подтягивания с отжиманиями, английский, развитие. Движение — пешком. Тренировка, телефон вне кровати и отбой идут без блока.' },
      { lead: 'Всё правится.', text: 'Блоки заводятся, переименовываются и удаляются в Настройках; удаление блока пункты не трогает.' }
    ]
  },
  {
    kind: 'note',
    title: 'Заметка',
    text: 'Привычка держится минимум 2–3 недели, пока не покажется лёгкой. Начинай всегда с маленьких шагов: +0,01% всё равно лучше, чем ничего.'
  }
];

/* ── СТРОКА ДНЯ (задача 28.E/B) ───────────────────────────────
   Единственное исключение из правила «в списке пунктов и на дневных
   экранах — только слова владельца». Границы жёсткие и записаны в
   CLAUDE.md: одна строка, один экран, закрытый набор в коде, выбор —
   чистая функция от ключа логического дня.

   Плоский массив строк без источников: форма данных держит запрет на
   цитаты сама — приписать строке автора здесь просто негде.

   ДЛИНА НАБОРА — 91, и это не опечатка отчёта: промпт задачи называл
   90, но перечислял 91 строку, а редактировать набор задача запрещает
   («возьми дословно… не подгоняй»). 91 = 7 × 13 делится на семь, и
   простой остаток от деления числа дней намертво привязал бы каждую
   строку к одному дню недели — ровно то, от чего сторожил счёт. Набор
   оставлен как есть, привязку снимает выбор (см. dayLine). */
const DAY_LINES = [
  'Минимум выполняется даже в худший день.',
  'Не спеши — доверься накопительному эффекту.',
  'Плюс один процент сегодня — это не мало, это направление.',
  'Малое, повторённое, становится опорой.',
  'Ровный шаг доносит дальше быстрого.',
  'Ноль целых одна сотая процента всё равно больше нуля.',
  'Привычка держится две-три недели, пока не покажется лёгкой.',
  'Начинай с маленьких шагов: они единственные, что не срываются.',
  'Планка опускается до того уровня, на котором ты её выполнишь.',
  'Сегодня достаточно сделать минимум.',
  'Практика — это то, что остаётся, когда настроение ушло.',
  'День без сил тоже считается днём.',
  'Мелкий шаг вперёд отменяет большой шаг назад.',
  'Постоянство складывается медленнее, чем хочется, и держится дольше, чем кажется.',
  'Тот, кто делает мало и каждый день, обгоняет того, кто делает много и редко.',
  'Цепь рвётся не в трудный день, а в тот, когда решил, что можно.',
  'Не пропускай дважды.',
  'Один пропуск — случайность. Два — новая привычка.',
  'Возвращаться важнее, чем не уходить.',
  'Ты не начинаешь заново — ты продолжаешь.',
  'Сложное складывается из простого, повторённого много раз.',
  'Каждый раз, когда делаешь, ты голосуешь за того, кем становишься.',
  'Сначала действие, потом настроение.',
  'Не жди подходящего дня — подходящих не бывает.',
  'Уменьшай до тех пор, пока отговорки не кончатся.',
  'Две минуты — уже практика.',
  'Действие меньше сопротивления всегда побеждает.',
  'Убери одно препятствие — и делать станет легче, чем не делать.',
  'Сила воли кончается, устройство жизни остаётся.',
  'Проще изменить обстановку, чем себя.',
  'Дисциплина — это когда решение принято заранее.',
  'Ты не поднимешься до цели, ты опустишься до своей системы.',
  'Система важнее цели.',
  'Результат — побочный эффект практики.',
  'Считай не итог, а количество повторений.',
  'Числа растут потом. Сначала растёт привычка.',
  'Терпение — это скорость, которую не видно.',
  'Лучше меньше, да чаще.',
  'Тише едешь — дальше будешь.',
  'Капля камень точит.',
  'Вода камень точит не силой, а постоянством.',
  'Дорога в тысячу ли начинается с одного шага.',
  'Кто идёт медленно, идёт далеко.',
  'Не бойся медленно идти, бойся остановиться.',
  'Терпение и труд всё перетрут.',
  'Мало-помалу птичка гнездо вьёт.',
  'По зёрнышку — ворох, по капельке — море.',
  'Пока дышу, надеюсь.',
  'Начало — половина дела.',
  'Хорошее начало — половина успеха.',
  'Что посеешь, то и пожнёшь.',
  'Всякое дело начинается с малого.',
  'Дело мастера боится.',
  'Не откладывай на завтра то, что можно сделать сегодня.',
  'Всякому овощу своё время.',
  'Семь раз отмерь, один раз отрежь.',
  'Утро вечера мудренее.',
  'Кто рано встаёт, тому Бог подаёт.',
  'Без труда не выловишь и рыбку из пруда.',
  'Глаза боятся, а руки делают.',
  'Лиха беда начало.',
  'Куй железо, пока горячо.',
  'Один в поле не воин, но один шаг в день — уже путь.',
  'Тише сам, крепче дело.',
  'Сегодня сделанное завтра не сделается само.',
  'Долгий путь одолевает идущий.',
  'Идущий дорогу осилит.',
  'Постоянство лучше порыва.',
  'Человек привыкает — и это его главная сила.',
  'Мы есть то, что делаем изо дня в день.',
  'Совершенство — не действие, а привычка.',
  'Мы становимся тем, что повторяем.',
  'Привычка — вторая натура.',
  'Что делаешь часто, то делаешь легко.',
  'Трудное становится привычным, привычное — лёгким, лёгкое — приятным.',
  'Нет ничего сильнее привычки.',
  'Привычка сильнее принуждения.',
  'Кто хочет — ищет способ, кто не хочет — причину.',
  'Начать всегда труднее, чем продолжить.',
  'Труден только первый шаг.',
  'Делай, что должен, и будь что будет.',
  'Спеши медленно.',
  'Пока откладываешь, жизнь проходит.',
  'Сделанное сегодня освобождает завтра.',
  'Порядок в малом рождает порядок в большом.',
  'Кто верен в малом, тот верен и в большом.',
  'Довольно для каждого дня своей заботы.',
  'Сегодня — единственный день, в котором можно что-то сделать.',
  'Лучшее время начать было вчера. Второе лучшее — сейчас.',
  'Не важно, как медленно ты идёшь, пока ты не останавливаешься.',
  'Маленькие дела, сделанные, лучше больших, задуманных.',
];

/* Якорь — неподвижная дата в коде, а не начало отсчёта владельца:
   calendarSince он правит сам, и строка дня скакала бы от правки
   настройки. Дата произвольна и значения не несёт — важно лишь то,
   что она неподвижна. */
const DAY_LINE_EPOCH = '2026-01-01';

/* Строка дня: чистая функция от ключа логического дня и только от него.
   Ни days{}, ни items[], ни reviews[], ни daysInSystem она не читает —
   от тапа по кругу не меняется, потому что принадлежит дате, а не
   результату; а число о практике на «Сегодня» запрещено конституцией.

   Индекс — не голый остаток. К номеру дня прибавляется номер пройденного
   круга: длина набора кратна семи, и без сдвига строка i выпадала бы
   всегда на один и тот же день недели. Сдвиг на круг поворачивает набор
   на одну позицию каждые 91 день, поэтому за семь кругов (637 дней)
   каждая строка обходит все дни недели. Внутри круга порядок прежний и
   каждая строка встречается ровно один раз. */
function dayLine(key) {
  const n = diffDays(key, DAY_LINE_EPOCH);
  const len = DAY_LINES.length;
  const i = ((n + Math.floor(n / len)) % len + len) % len;
  return DAY_LINES[i];
}

/* ── Константы времени (задача 23) ───────────────────────────
   Каждая объявлена там, где работает, но проходит через timing():
   первый аргумент — имя, второй — значение по умолчанию, оно же и есть
   рантайм приложения. Ни одна не становится настройкой владельца и в
   store не попадает.

   Тест подменяет константу ДО загрузки app.js, положив объект в
   globalThis.MINIMUM_TIMING ({ MOTION_MS: 20, … }); правка самого
   app.js для этого не нужна. Значения читаются один раз при загрузке —
   после неё поведение неизменно. Нечисловое, бесконечное и
   отрицательное значение игнорируется: подмена не должна уметь то,
   чего не умеет рантайм.

   Блок стоит перед «Хранилищем», а не внутри: timing() зовут разделы
   от зеркала до перетаскивания, и таблицы должны быть инициализированы
   раньше первого вызова (const, не var — TDZ обязывает). */
const TIMING_DEFAULTS = {}; // имя → значение по умолчанию (рантайм)
const TIMING = {};          // имя → значение, с которым работает эта загрузка

function timing(name, def) {
  TIMING_DEFAULTS[name] = def;
  const o = (typeof globalThis !== 'undefined' && globalThis.MINIMUM_TIMING) || null;
  const v = o ? o[name] : undefined;
  TIMING[name] = (typeof v === 'number' && isFinite(v) && v >= 0) ? v : def;
  return TIMING[name];
}

/* ── Хранилище ─────────────────────────────────────────────── */

const NS = 'minimum:data';
const SCHEMA_VERSION = 17;

let store = null;
let saveFailed = false; // хранилище недоступно — постоянный баннер над экраном
const MAX_TIME = 8640000000000000; // предел представимой даты: за ним new Date() — Invalid Date

const uid = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* Блок по умолчанию для стартовых пунктов (и для миграции v1-данных) */
const DEFAULT_GROUPS = {
  'Умыться': 'Тело',
  'Принять душ': 'Тело',
  'Подтягивания + отжимания': 'Тело',
  'Пешком': 'Движение',
  'Телефон вне кровати': 'Сон',
  'Развитие': 'Развитие',
  'Тренировка': 'Тело'
};
const TRAIN_NOTE = 'Полноценная тренировка, 40–50 минут';

/* Понедельник дня k, если k — понедельник, иначе ближайший следующий */
function nextCalendarMonday(k) {
  const mon = weekStartOf(k);
  return mon === k ? k : addDays(mon, 7);
}

/* Стартовая программа привычек — тот же посев идёт миграцией v5 */
function seedHabits(today) {
  const habit = (name) => ({
    id: uid(), name, value: null, unit: '', type: 'daily', area: 'habit', normPerWeek: 7,
    goal: null, note: '', group: '', removedAt: null, addedAt: today, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  });
  return [
    { id: uid(), name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
      pkind: 'time', pvalue: 0, pstep: -15, goal: null, note: '', group: '',
      removedAt: null, addedAt: today, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [{ date: today, value: 0 }],
      formula: null, ladder: null, ladderLog: [] },
    habit('Перестать грызть ногти'),
    habit('Ловить импульс трат → алгоритм')
  ];
}

/* ── Посев программы (задача 17) ───────────────────────────────
   Одноразовый и идемпотентный: migrate заводит программу владельца
   только на пустом store (items[] пуст) и только пока не стоит флаг
   settings.seed17. Непустые данные посев не трогает и флага не ставит.

   Чистка ставит флаг сама (emptyStore): «Начать с чистого листа»
   обязано оставаться чистым и после перезапуска — иначе следующий
   старт прогнал бы стёртый store через migrate и вернул программу
   (инвариант 18, «ни одного стартового пункта»). */

const SEED_GROUPS = ['Утро', 'Подряд', 'Движение'];

/* [название, значение, единица, блок, тип, цель, подпись, добавка] */
const SEED_ITEMS = [
  ['Умыться', null, '', 'Утро', 'daily', null, ''],
  ['Принять душ', null, '', 'Утро', 'daily', null, ''],
  ['Подтягивания + отжимания', 5, 'повт.', 'Подряд', 'daily', null, ''],
  ['Английский', 5, 'мин', 'Подряд', 'daily', null, ''],
  ['Развитие', 10, 'мин', 'Подряд', 'daily', null, ''],
  ['Пешком', 500, 'м', 'Движение', 'daily', null, ''],
  ['Тренировка', null, '', '', 'weekly', 3, TRAIN_NOTE],
  ['Телефон вне кровати', null, '', '', 'daily', null, '', { area: 'habit', normPerWeek: 7 }],
  ['Отбой', null, '', '', 'param', null, '',
    { area: 'habit', pkind: 'time', pvalue: 0, pstep: -15 }]
];

/* Пункты программы. Единственная фабрика на два пути — посев в migrate
   и defaultStore: наборы обязаны совпадать, поэтому собираются здесь. */
function programItems(today) {
  return SEED_ITEMS.map(([name, value, unit, group, type, goal, note, extra]) => {
    const it = {
      id: uid(), name, value, unit, type, area: 'min', goal, note, group,
      removedAt: null, addedAt: today, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
      // числовому пункту — стартовая запись истории планки (инвариант 5)
      history: (typeof value === 'number') ? [{ date: today, value }] : [],
      formula: null, ladder: null, ladderLog: []
    };
    Object.assign(it, extra);
    // порог параметра — такая же планка: своя стартовая запись истории
    if (it.type === 'param') it.history = [{ date: today, value: it.pvalue }];
    return it;
  });
}

const programGroups = () => SEED_GROUPS.map(name => ({ name }));

/* День посева — по нему подсказка «одна новая привычка за раз» отличает
   программу от пунктов владельца (задача 22, п. 7.2). Пометить посевные
   пункты полем нельзя, не меняя схему, но у всех девяти один addedAt:
   день первого запуска, самый ранний в store.

   Одиночный пункт с минимальным addedAt посевным не считается никогда:
   после чистки store пуст, а settings.seed17 стоит намеренно (инвариант
   18) — первый же пункт владельца оказался бы самым ранним и выпал бы из
   счёта, и подсказка не показалась бы при добавлении второй привычки.
   Посев кладёт девять пунктов одной датой, владелец добавляет по одному —
   количество в группе и есть различитель (решение архитектора). */
function seedDayKey() {
  if (store.settings.seed17 !== true || !store.items.length) return null;
  let min = null, n = 0;
  for (const it of store.items) {
    if (min === null || it.addedAt < min) { min = it.addedAt; n = 1; }
    else if (it.addedAt === min) n++;
  }
  return n > 1 ? min : null;
}

/* Позже всех заведённый пункт владельца; посев в счёт не идёт */
function ownerNewestItem() {
  const seedDay = seedDayKey();
  let newest = null;
  for (const it of store.items) {
    if (seedDay !== null && it.addedAt === seedDay) continue;
    if (!newest || it.addedAt > newest.addedAt) newest = it;
  }
  return newest;
}

function seedProgram(s, today) {
  s.groups = programGroups();
  s.items = programItems(today);
  s.settings.seed17 = true;
  s.settings.habitSeeded = true; // привычки программы уже здесь — посев v5 не нужен
}

function defaultStore() {
  const today = dateKeyShift(new Date(), 4);
  return {
    schemaVersion: SCHEMA_VERSION,
    items: programItems(today),
    // порядок блоков на экранах (инвариант 13); блок из двух и более
    // активных пунктов сам по себе рисует линию — отдельного признака нет
    groups: programGroups(),
    days: {},          // "YYYY-MM-DD" -> { itemId: true }
    weekLog: [],       // инкременты недельных счётчиков текущей календарной недели
    reviews: [],       // закрытые недели
    pendingRaises: [], // принятые повышения, ещё не записанные в разбор
    pendingLowers: [], // принятые понижения, ещё не записанные в разбор
    exercises: [],     // упражнения тренировки: рабочая нагрузка и её история
    sessions: [],      // записанные тренировки: день, значения упражнений, заметка
    // заметки и выписки владельца. Экран снят задачей 28.C, но поле живёт:
    // данные никуда не делись, идут в экспорт и проходят нормализацию
    notes: [],
    paramDecided: {},  // itemId -> {week, from, to|null}: решения по параметрам, привязанные к разбираемой неделе
    draftOneChange: '',
    weekStart: today,  // историческая отсечка скользящей эпохи
    settings: {
      dayBoundary: 4,
      dayThreshold: 0.8,
      exportedAt: null,
      calendarSince: nextCalendarMonday(today),
      habitSeeded: true,
      seed17: true     // программа уже здесь: migrate не станет сеять её повторно
    }
  };
}

/* Числовое поле из внешних данных: число или числовая строка
   (запятая как точка); всё остальное — fallback. */
function numOr(v, fallback) {
  if (typeof v === 'number') return isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(',', '.'));
    return isFinite(n) ? n : fallback;
  }
  return fallback;
}

/* ── Формула и лестница: нормализация полей ────────────────────
   Механики сняты задачей 28.D — экрана, форм и решений больше нет.
   НОРМАЛИЗАЦИЯ ОСТАЁТСЯ ЦЕЛИКОМ, и это решение, а не остаток: поля
   formula, ladder и ladderLog живут в store владельца, уходят в экспорт
   и в зеркало, а снятие самих полей — отдельная задача. Пока их
   нормализует migrate, ни один байт не теряется — ни при обновлении,
   ни при импорте. Схема остаётся v16 (инвариант 12, помета «СНЯТ»).

   Убрать normLadder, не убрав строку `it.ladder = … normLadder(…)` в
   цикле по пунктам, — ReferenceError при первой же миграции. Функции и
   строки цикла снимаются только вместе с полями. */

/* Семь полей формулы; на логику не влияют — только текст владельца */
const FORMULA_KEYS = ['anchor', 'when', 'pair', 'identity', 'twoMin', 'friction', 'proof'];

/* Формула из внешних данных: объект из семи строк либо null.
   Пустая (все поля пусты после trim) — это null, а не объект пустышек.

   v14 → v15 (задача 20): формула несёт режим. Отдельного шага миграции не
   нужно — mode достраивается этой же безусловной нормализацией, как в своё
   время normPerWeek (v5→v6) и сама formula (v6→v7); шаг аддитивен и
   идемпотентен, days{} и reviews[] не трогает. */
function normFormula(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const out = {};
  let any = false;
  for (const k of FORMULA_KEYS) {
    const v = typeof f[k] === 'string' ? f[k].trim() : '';
    out[k] = v;
    if (v) any = true;
  }
  // режим описывает, КАК читать те же семь полей, и сам формулы не создаёт:
  // пустая формула с одним лишь mode остаётся null. Неизвестное — 'build'.
  out.mode = f.mode === 'break' ? 'break' : 'build';
  return any ? out : null;
}

/* Лестница из внешних данных: непустой список ступеней, индекс в границах,
   неделя последнего шага — понедельник или null. Без ступеней лестницы нет. */
function normLadder(l, today) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  const steps = Array.isArray(l.steps)
    ? l.steps.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean)
    : [];
  if (!steps.length) return null;
  let step = Math.round(numOr(l.step, 0));
  if (!(step > 0)) step = 0;
  if (step > steps.length - 1) step = steps.length - 1;
  // рукотворный не-понедельник приводится к своему понедельнику, а не
  // обнуляется: иначе правка данных открывала бы лишний шаг на неделе
  const wk = l.steppedWeek;
  return {
    steps,
    step,
    steppedWeek: isDayKey(wk) ? weekStartOf(wk) : null,
    startedAt: isDayKey(l.startedAt) ? l.startedAt : today,
    // v15 → v16 (задача 21): привычка закрыта владельцем. Отдельного шага
    // миграции не нужно — done достраивается этой же безусловной
    // нормализацией, как mode в v14→v15; шаг аддитивен и идемпотентен,
    // days{}, history и ladderLog не трогает. Ставился только действием
    // владельца; действия сняты задачей 28.D — поле сохраняется как есть.
    done: l.done === true
  };
}

/* Журнал шагов: записи с валидным днём, неотрицательной ступенью и текстом.
   Флаг start (стартовая запись создания лестницы) сохраняется, если он есть,
   и только в виде true — иначе поле не появляется вовсе. */
function normLadderLog(log) {
  if (!Array.isArray(log)) return [];
  return log
    .filter(e => e && typeof e === 'object' && !Array.isArray(e) && isDayKey(e.date))
    .map(e => {
      const out = {
        date: e.date,
        step: Math.max(0, Math.round(numOr(e.step, 0))),
        text: typeof e.text === 'string' ? e.text : ''
      };
      if (e.start === true) out.start = true;
      if (e.closed === true) out.closed = true;
      return out;
    });
}

/* Миграции схемы. При изменении структуры: поднять SCHEMA_VERSION
   и добавить шаг вида if (s.schemaVersion < N) { ...; }.
   Толерантна к мусору: не-объекты отбрасываются, обязательные поля
   достраиваются, числовые приводятся или обнуляются — импортированный
   или повреждённый store не должен ронять ни migrate, ни рендер. */
/* opts.external — данные пришли извне (импорт файла, возврат стёртой
   копии). Стартовая программа принадлежит ПЕРВОМУ ЗАПУСКУ, а не всякому
   пустому store: файл, снятый версией без флага seed17, приносил пустой
   items[] и получал девять чужих пунктов (аудит, находка 3). */
function migrate(s, opts) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return defaultStore();
  s.schemaVersion = numOr(s.schemaVersion, 0) || 1; // мусорная версия = v1, шаги миграций не пропускаются

  // настройки — первыми: от dayBoundary зависит «сегодня» для достройки дат
  if (!s.settings || typeof s.settings !== 'object' || Array.isArray(s.settings)) s.settings = {};
  // граница дня — час суток: целое 0..23. Без рамки импортированное
  // значение вроде 1e6 уводило логический день на десятилетия назад и
  // currentWeekStart навсегда становился null (аудит, находка 28).
  s.settings.dayBoundary = (typeof s.settings.dayBoundary === 'number' && isFinite(s.settings.dayBoundary))
    ? Math.min(23, Math.max(0, Math.round(s.settings.dayBoundary)))
    : 4;
  // v13 → v14 (задача 17): порог зачёта дня — доля отмеченного, шаг 0,1
  s.settings.dayThreshold = clampThreshold(s.settings.dayThreshold);
  // отметка экспорта — момент времени, и она обязана быть представимой
  // датой. isFinite её пропускал: 8.64e15 + 1 даёт Invalid Date, оттуда
  // «NaN-NaN-NaN» и английская строка «Экспорт запускался: Invalid Date»
  // в русском интерфейсе (задача 27, Д8). Тот же класс враждебного числа
  // у dayBoundary зажат строкой выше — здесь зажимаем тем же приёмом.
  // Вне диапазона — не «починить наугад», а «экспорта не было»: подделывать
  // дату, которой не было, приложение не должно
  if (!(typeof s.settings.exportedAt === 'number' && isFinite(s.settings.exportedAt)
        && Math.abs(s.settings.exportedAt) <= MAX_TIME)) {
    if (s.settings.exportedAt !== undefined) s.settings.exportedAt = null;
  }
  const today = dateKeyShift(new Date(), s.settings.dayBoundary);

  // пункты: только объекты; id и addedAt достраиваются, id дедуплицируются
  if (!Array.isArray(s.items)) s.items = [];
  s.items = s.items.filter(it => it && typeof it === 'object' && !Array.isArray(it));
  // Пустота, пришедшая извне, — намеренная: посев ей не адресован
  // независимо от schemaVersion и наличия флагов (A.2.1). Флаги ставятся
  // сразу и переживают сохранение: иначе следующий старт прогнал бы этот
  // же store через migrate уже как «первый запуск» и всё-таки засеял.
  if (opts && opts.external && !s.items.length) {
    s.settings.seed17 = true;
    s.settings.habitSeeded = true; // и посев привычек шага v4→v5
  }
  // посев программы (задача 17): только пустой store и только один раз
  let seeded = false;
  if (!s.items.length && s.settings.seed17 !== true) { seedProgram(s, today); seeded = true; }
  const ids = new Set();
  for (const it of s.items) {
    if (typeof it.id !== 'string' || !it.id || ids.has(it.id)) it.id = uid();
    ids.add(it.id);
    if (!isDayKey(it.addedAt)) it.addedAt = today;
    it.type = it.type === 'weekly' ? 'weekly' : (it.type === 'param' ? 'param' : 'daily');
    it.area = it.area === 'habit' ? 'habit' : 'min';
    if (it.type === 'weekly') it.area = 'min'; // недельный счётчик принадлежит только минимуму (инвариант 10)
    // Отрезок жизни пункта (задача 28.E/A): addedAt — день, с которого он
    // есть, removedAt — день, с которого его уже нет, либо null. Нормализация
    // безусловная и стоит рядом с addedAt: это вторая половина одной пары.
    it.removedAt = isDayKey(it.removedAt) ? it.removedAt : null;
    // v16 → v17: выключенный пункт становится убранным С ДНЯ ЗАВЕДЕНИЯ, поле
    // active снимается. Числа владельца при этом не сдвигаются ни на единицу:
    // прежнее правило применимости выбрасывало выключенный пункт из ВСЕХ дней,
    // и пустой отрезок [addedAt, addedAt) выбрасывает его ровно так же.
    // Шаг безусловный, как и прочие нормализации: экспорт версии v16,
    // импортированный позже, обязан пройти его тем же путём. Идемпотентен —
    // после первого прогона поля active в данных нет вовсе. Рукотворный
    // removedAt при active === false не переписывается: он точнее.
    if (it.active === false && it.removedAt === null) it.removedAt = it.addedAt;
    delete it.active;
    if (typeof it.name !== 'string') it.name = '';
    if (typeof it.unit !== 'string') it.unit = '';
    if (typeof it.note !== 'string') it.note = '';
    if (typeof it.group !== 'string') it.group = '';
    it.value = numOr(it.value, null);
    if (it.value !== null && it.value <= 0) it.value = null; // планка всегда > 0, как и в формах
    if (it.type === 'param') {
      it.area = 'habit'; // параметры существуют только в области привычек
      it.value = null;   // и не несут планку минимума
      it.pkind = it.pkind === 'number' ? 'number' : 'time';
      let pv = numOr(it.pvalue, 0);
      if (it.pkind === 'time') pv = ((Math.round(pv) % 1440) + 1440) % 1440; // минуты суток
      it.pvalue = pv; // числовой порог может быть дробным — формы его не округляют
      it.pstep = Math.round(numOr(it.pstep, 0));
    }
    if (it.type === 'daily' && it.area === 'habit') {
      // норма недели (инвариант 11): целое 1–7, невалид — к ближайшему допустимому
      it.normPerWeek = Math.max(1, Math.min(7, Math.round(numOr(it.normPerWeek, 7))));
    } else {
      delete it.normPerWeek; // норма — только у привычек
    }
    const g = numOr(it.goal, null);
    it.goal = g !== null && Math.round(g) >= 1 ? Math.round(g) : null;
    it.raiseAfter = Math.max(0, Math.round(numOr(it.raiseAfter, 0)));
    // v10 → v11 (задача 16C): якоря обеих механик планки — понедельник недели
    // последнего решения либо null. raiseAfter остаётся историческим полем:
    // счёт по массиву reviews пропущенные разборы блокировали навсегда.
    // Рукотворный не-понедельник приводится к своему понедельнику, как steppedWeek.
    it.raiseAfterWeek = isDayKey(it.raiseAfterWeek) ? weekStartOf(it.raiseAfterWeek) : null;
    it.lowerAfterWeek = isDayKey(it.lowerAfterWeek) ? weekStartOf(it.lowerAfterWeek) : null;
    if (!Array.isArray(it.history)) it.history = [];
    it.history = it.history
      .filter(h => h && typeof h === 'object' && !Array.isArray(h) && isDayKey(h.date))
      .map(h => ({ date: h.date, value: numOr(h.value, null) }))
      .filter(h => h.value !== null);
    // v6 → v7: формула, лестница и журнал шагов — аддитивно. Лестницу несёт
    // только ежедневный пункт: правило от той поры, когда лестница занимала
    // единственный слот, а снять её можно было лишь в листе детали, который
    // открывался только для daily (аудит, находка 4). Механики сняты
    // задачей 28.D, нормализация оставлена целиком — иначе данные владельца
    // пострадали бы при первом же запуске. Журнал не трогаем.
    it.formula = normFormula(it.formula);
    it.ladder = it.type === 'daily' ? normLadder(it.ladder, today) : null;
    it.ladderLog = normLadderLog(it.ladderLog);
  }
  // ЖИВАЯ лестница в данных одна: побеждает начатая позже (строгое сравнение —
  // при равенстве и отсутствии startedAt остаётся первая по порядку items[]),
  // у прочих снимается; журналы, отметки и история не трогаются. Закрытые
  // (done) в конфликте не участвуют и не снимаются (задача 21, 4.2).
  // Дедуп остаётся и после снятия механики (задача 28.D): интерфейс лестниц
  // больше не заводит, но принести две живых может импорт файла, снятого
  // прежней версией, — это последний рубеж канонической формы поля.
  let keeper = null;
  for (const it of s.items) {
    if (!it.ladder || it.ladder.done) continue;
    if (!keeper || it.ladder.startedAt > keeper.ladder.startedAt) keeper = it;
  }
  for (const it of s.items) if (it.ladder && !it.ladder.done && it !== keeper) it.ladder = null;

  // v7 → v8: живой лестнице с пустым журналом дописывается стартовая запись
  // от startedAt. Непустой журнал не трогается: исходная ступень пути в нём
  // неизвестна, домысливать её нельзя. Идёт после разрешения конфликта —
  // снятой лестнице старт не пишется.
  if (s.schemaVersion < 8) {
    for (const it of s.items) {
      if (!it.ladder || it.ladderLog.length) continue;
      it.ladderLog.push({
        date: isDayKey(it.ladder.startedAt) ? it.ladder.startedAt : today,
        step: it.ladder.step,
        text: it.ladder.steps[it.ladder.step] || '',
        start: true
      });
    }
  }

  // отметки: ключ — валидный день, значение — непустой объект с булевыми
  // полями (как их оставляет toggleMark). Посторонние значения отбрасываются
  // ПОИМЁННО, а не вместе с днём (задача 25, п. 4): прежнее правило «весь
  // день целиком» уносило валидные отметки — один не-булев флаг в дне из
  // четырёх отметок стоил всех четырёх, а посторонний ключ в каждом дне
  // (правка файла руками) обнулял days{} без единого слова. День, в котором
  // после фильтрации не осталось ничего, по-прежнему не существует.
  if (!s.days || typeof s.days !== 'object' || Array.isArray(s.days)) s.days = {};
  for (const k of Object.keys(s.days)) {
    const day = s.days[k];
    if (!isDayKey(k) || !day || typeof day !== 'object' || Array.isArray(day)) { delete s.days[k]; continue; }
    for (const id of Object.keys(day)) if (typeof day[id] !== 'boolean') delete day[id];
    if (!Object.keys(day).length) delete s.days[k];
  }

  // блоки (инвариант 13): имена уникальны и непусты, дубликаты схлопываются
  // в первый; порядок массива — это порядок блоков на экранах. Пересборка
  // списка заодно снимает поле chain (шаг v9→v10) — блок и есть цепочка
  if (!Array.isArray(s.groups)) s.groups = [];
  {
    const out = [];
    const seen = new Set();
    for (const g of s.groups) {
      if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
      const name = typeof g.name === 'string' ? g.name.trim() : '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name });
    }
    s.groups = out;
  }

  if (!Array.isArray(s.weekLog)) s.weekLog = [];
  s.weekLog = s.weekLog.filter(e => e && typeof e === 'object' && !Array.isArray(e));
  if (!Array.isArray(s.reviews)) s.reviews = [];
  s.reviews = s.reviews.filter(r => r && typeof r === 'object' && !Array.isArray(r));
  if (!Array.isArray(s.pendingRaises)) s.pendingRaises = [];
  s.pendingRaises = s.pendingRaises.filter(e => e && typeof e === 'object' && !Array.isArray(e));
  if (!Array.isArray(s.pendingLowers)) s.pendingLowers = [];
  s.pendingLowers = s.pendingLowers.filter(e => e && typeof e === 'object' && !Array.isArray(e));

  // v11 → v12 (задача 16D): упражнения и записанные тренировки. Шаг
  // аддитивен и идемпотентен: days{}, reviews[] и items[] не трогает.
  // Форма упражнения — как у пункта: имя, единица, рабочая нагрузка и
  // её история по тем же правилам (recordBar общий).
  if (!Array.isArray(s.exercises)) s.exercises = [];
  {
    const exIds = new Set();
    s.exercises = s.exercises.filter(e => e && typeof e === 'object' && !Array.isArray(e));
    for (const ex of s.exercises) {
      if (typeof ex.id !== 'string' || !ex.id || exIds.has(ex.id)) ex.id = uid();
      exIds.add(ex.id);
      if (typeof ex.name !== 'string') ex.name = '';
      if (typeof ex.unit !== 'string') ex.unit = '';
      if (!isDayKey(ex.addedAt)) ex.addedAt = today;
      // тот же отрезок жизни, что у пункта, и тот же шаг v16 → v17
      ex.removedAt = isDayKey(ex.removedAt) ? ex.removedAt : null;
      if (ex.active === false && ex.removedAt === null) ex.removedAt = ex.addedAt;
      delete ex.active;
      ex.value = numOr(ex.value, null);
      if (ex.value !== null && ex.value <= 0) ex.value = null; // нагрузка всегда > 0
      if (!Array.isArray(ex.history)) ex.history = [];
      ex.history = ex.history
        .filter(h => h && typeof h === 'object' && !Array.isArray(h) && isDayKey(h.date))
        .map(h => ({ date: h.date, value: numOr(h.value, null) }))
        .filter(h => h.value !== null);
    }
  }
  // v12 → v13 (задача 16E): свободные заметки. Пустая по тексту заметка
  // не существует — в интерфейсе пустое сохранение удаляет её, поэтому
  // и на входе такие записи отбрасываются: данных в них нет.
  // v13 → v14 (задача 17): вид записи и источник. Существующим —
  // 'note' и пустой source; источник живёт только у выписки.
  if (!Array.isArray(s.notes)) s.notes = [];
  {
    const nIds = new Set();
    s.notes = s.notes
      .filter(n => n && typeof n === 'object' && !Array.isArray(n) &&
        typeof n.text === 'string' && n.text.trim())
      .map(n => {
        let id = typeof n.id === 'string' && n.id && !nIds.has(n.id) ? n.id : uid();
        nIds.add(id);
        const kind = n.kind === 'quote' ? 'quote' : 'note';
        return {
          id,
          date: isDayKey(n.date) ? n.date : today,
          text: n.text.trim(),
          kind,
          source: kind === 'quote' && typeof n.source === 'string' ? n.source.trim() : '',
          updatedAt: Math.max(0, Math.round(numOr(n.updatedAt, 0)))
        };
      });
  }

  if (!Array.isArray(s.sessions)) s.sessions = [];
  s.sessions = s.sessions
    .filter(x => x && typeof x === 'object' && !Array.isArray(x) && isDayKey(x.date))
    .map(x => ({
      id: typeof x.id === 'string' && x.id ? x.id : uid(),
      date: x.date,
      entries: (Array.isArray(x.entries) ? x.entries : [])
        .filter(e => e && typeof e === 'object' && !Array.isArray(e) && typeof e.exId === 'string')
        .map(e => ({ exId: e.exId, value: numOr(e.value, null) }))
        .filter(e => e.value !== null),
      note: typeof x.note === 'string' ? x.note : ''
    }));
  if (!s.paramDecided || typeof s.paramDecided !== 'object' || Array.isArray(s.paramDecided)) s.paramDecided = {};
  for (const k of Object.keys(s.paramDecided)) {
    const d = s.paramDecided[k];
    const ok = d && typeof d === 'object' && !Array.isArray(d) && isDayKey(d.week) &&
      typeof d.from === 'number' && (d.to === null || typeof d.to === 'number');
    if (!ok) delete s.paramDecided[k];
  }
  if (typeof s.settings.habitSeeded !== 'boolean') s.settings.habitSeeded = false;
  if (typeof s.draftOneChange !== 'string') s.draftOneChange = '';
  if (!isDayKey(s.weekStart)) s.weekStart = today;

  // v1 → v2: «Принять душ», подпись тренировки, блоки, посев истории планки.
  // Только что засеянной программе шаг не адресован: он переписал бы блоки
  // по именам старого набора («Тренировка» → «Тело»).
  if (s.schemaVersion < 2 && !seeded) {
    for (const it of s.items) {
      if (!it.group && DEFAULT_GROUPS[it.name]) it.group = DEFAULT_GROUPS[it.name];
      if (it.name === 'Тренировка' && !it.note) it.note = TRAIN_NOTE;
      if (typeof it.value === 'number' && isFinite(it.value) && !it.history.length) {
        it.history.push({ date: it.addedAt || dateKeyShift(new Date(), s.settings.dayBoundary), value: it.value });
      }
    }
    // в ПУСТОЙ список душ не дописывается: пустота здесь либо намеренная
    // (внешний файл, A.2), либо уже засеяна выше — оба случая не про v1
    if (s.items.length && !s.items.some(i => i.name === 'Принять душ')) {
      const shower = {
        id: uid(), name: 'Принять душ', value: null, unit: '', type: 'daily', area: 'min',
        goal: null, note: '', group: 'Тело', removedAt: null,
        addedAt: dateKeyShift(new Date(), s.settings.dayBoundary), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
        // вставка идёт после валидации пунктов — каноническая форма задаётся здесь
        formula: null, ladder: null, ladderLog: []
      };
      const at = s.items.findIndex(i => i.name === 'Умыться');
      s.items.splice(at >= 0 ? at + 1 : 0, 0, shower);
    }
  }

  // v2 → v3: срез недели получает weekStart — период счёта тренировок
  if (s.schemaVersion < 3) {
    for (const r of s.reviews) {
      if (!isDayKey(r.weekStart)) {
        r.weekStart = (Array.isArray(r.keys) && isDayKey(r.keys[0])) ? r.keys[0] : today;
      }
    }
  }

  // v3 → v4: отметка последнего экспорта — мягкий дефолт
  if (s.schemaVersion < 4) {
    if (!('exportedAt' in s.settings)) s.settings.exportedAt = null;
  }

  // v4 → v5: календарные недели и программа привычек; мёртвое поле подсказки вычищается
  if (s.schemaVersion < 5) {
    if (!isDayKey(s.settings.calendarSince)) {
      s.settings.calendarSince = nextCalendarMonday(dateKeyShift(new Date(), s.settings.dayBoundary));
    }
    if (!s.settings.habitSeeded) { // однократность посева — по флагу, не по именам
      s.items.push(...seedHabits(dateKeyShift(new Date(), s.settings.dayBoundary)));
      s.settings.habitSeeded = true;
    }
    delete s.settings.hintShownForItemId;
  }

  // v9 → v10: признак цепочки упразднён — линию рисует сам блок. Поле снято
  // безусловной пересборкой списка выше, отдельный шаг не нужен; items[],
  // days{} и reviews[] не изменяются

  // v8 → v9: список блоков собирается из item.group в порядке первого появления
  // в items[]. Существующий store.groups не перезаписывается; items[], days{}
  // и reviews[] не изменяются — группа остаётся именем в пункте (инвариант 13)
  if (s.schemaVersion < 9) {
    const seen = new Set(s.groups.map(g => g.name));
    for (const it of s.items) {
      const name = (it.group || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      s.groups.push({ name });
    }
  }

  // v5 → v6: недельная норма привычек (normPerWeek = 7) — достраивается
  // безусловной валидацией пунктов выше, отдельный шаг не нужен; миграция
  // аддитивна: days{} и reviews[] не изменяются (решение владельца 19.07.2026)
  // v6 → v7: formula/ladder/ladderLog — тем же способом; ничего не сеялось
  // и тогда, и сейчас (стартовый текст лестницы жил только в её форме)
  // рукотворный/битый calendarSince приводится тем же правилом; не-понедельник
  // нормализуется вперёд — недели существуют только целиком
  if (!isDayKey(s.settings.calendarSince)) {
    s.settings.calendarSince = nextCalendarMonday(dateKeyShift(new Date(), s.settings.dayBoundary));
  } else if (weekStartOf(s.settings.calendarSince) !== s.settings.calendarSince) {
    s.settings.calendarSince = nextCalendarMonday(s.settings.calendarSince);
  }

  s.schemaVersion = SCHEMA_VERSION;
  return s;
}

/* Чтение localStorage: store при валидной строке, null при пустой или битой —
   дальше решает стартовая проверка init() (зеркало или дефолт, инвариант 9).
   Битая строка сохраняется в corrupt-ключ до любого восстановления. */
function load() {
  let raw = null;
  try { raw = localStorage.getItem(NS); } catch (e) { return null; }
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw));
  } catch (e) {
    // нечитаемые данные не уничтожаются: сырая строка уходит в резервный
    // ключ вместе с датой — без неё владелец не понимает, что там лежит
    // (задача 25, п. 6). Формат-обёртка; прежняя голая строка читается тоже.
    try { localStorage.setItem(CORRUPT_KEY, JSON.stringify({ raw, at: Date.now() })); } catch (e2) { /* некуда сохранить */ }
    return null;
  }
}

/* true = записалось. Возвращать успех save() обязан по двум причинам
   (задача 27, Д5 и Д6): замещающие операции расходуют копию прежних данных
   и обязаны откатиться, если рабочий ключ записать не удалось; а тихое
   «Сохранено» не должно печататься там, где записи не было. Значение
   добавлено к прежнему поведению, не заменяет его: saveFailed по-прежнему
   взводится и гасится здесь же, прежние вызовы результат просто игнорируют. */
function save() {
  let ok = false;
  try {
    localStorage.setItem(NS, JSON.stringify(store));
    saveFailed = false; // первый успешный save снимает флаг
    scheduleMirror();   // успешное сохранение дублируется в зеркало (инвариант 9)
    ok = true;
  } catch (e) {
    saveFailed = true; // приватный режим / переполнение — баннер на текущем экране
  }
  storageNote(); // вне try: своей ошибкой она не должна выглядеть отказом записи
  return ok;
}

/* Успех ПОСЛЕДНЕЙ записи. Доменные функции зовут save() внутри и возвращают
   своё (сработала ли доменная операция), а обработчику нужно знать именно
   про запись — иначе подтверждение печатается там, где на диск ничего не
   легло (задача 27, Д6). */
const lastSaveOk = () => !saveFailed;

/* ── Зеркало в IndexedDB (инвариант 9) ─────────────────────────
   Тонкая обёртка: open/get/put, все ошибки глушатся — недоступность
   IndexedDB не меняет поведение приложения. */

const IDB_NAME = 'minimum';
const IDB_STORE = 'mirror';
const IDB_KEY = 'snapshot';
const MIRROR_PROBE_MS = timing('MIRROR_PROBE_MS', 1500); // сколько ждать зеркало на старте, не задерживая первый рендер

/* Нечитаемый снапшот зеркала откладывается СВОИМ ключом, а не общим с
   localStorage (задача 28.A, п. 1.2): оба источника могут оказаться
   нечитаемыми в одну сессию — load() пишет свой ключ первым, и один
   ключ на двоих затирал бы одно другим. Формат и показ общие. */
const MIRROR_CORRUPT_KEY = NS + ':mirror-corrupt';

let mirrorTimer = null;
let mirrorDirty = false; // есть изменения, не доехавшие до зеркала
let mirrorReady = false; // стартовая проверка init() завершена — писать можно
let mirrorUnverified = false; // чтение зеркала не завершилось: что там лежит — неизвестно
/* Снапшот несёт практику, которой нет в рабочей копии, и владелец решения
   ещё не принял: { store, savedAt, stats }. Пока предложение стоит, зеркало
   не пишется — иначе следующий save() затёр бы то, что предлагается. */
let mirrorOffer = null;

function idbOpen() {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(IDB_STORE); } catch (e) { /* уже есть */ }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

/* Чтение зеркала с РАЗЛИЧЕНИЕМ трёх исходов (задача 19, A.1):
     'read'   — снапшот прочитан;
     'empty'  — база открылась, ключа нет (зеркала ещё не было);
     'failed' — чтение не завершилось: ошибка открытия, ошибка запроса
                или таймаут.
   Различать обязательно. Раньше все три сводились к null, и init(),
   не дождавшись медленного IndexedDB, писал поверх снапшота дефолтный
   store — единственная страховка от исчезновения localStorage
   уничтожалась ровно в тот момент, когда была нужна (аудит, находка 1).
   timeoutMs = 0 — ждать сколько угодно (строка «Резервная копия»). */
function mirrorProbe(timeoutMs) {
  // IndexedDB нет вовсе — терять нечего, это не «не дочитали»
  if (typeof indexedDB === 'undefined') return Promise.resolve({ status: 'empty', snap: null });
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const fail = () => finish({ status: 'failed', snap: null });
    if (timeoutMs > 0) setTimeout(fail, timeoutMs);
    idbOpen().then(db => {
      if (!db) { fail(); return; }
      try {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = () => {
          finish(req.result ? { status: 'read', snap: req.result } : { status: 'empty', snap: null });
          db.close();
        };
        req.onerror = () => { fail(); db.close(); };
      } catch (e) { fail(); try { db.close(); } catch (e2) {} }
    }).catch(fail);
  });
}

/* Снапшот или null — прежний контракт поверх mirrorProbe */
function mirrorRead() {
  return mirrorProbe(0).then(r => r.snap);
}

/* Снять снапшот целиком. Единственный вызывающий — «Убрать» у строки
   нечитаемой копии: пока снапшот лежит, каждый старт упирается в него и
   зеркало не ведётся вовсе. Решение владельца, не приложения. */
function mirrorClear() {
  return idbOpen().then(db => new Promise(resolve => {
    if (!db) { resolve(false); return; }
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => { resolve(true); db.close(); };
      tx.onerror = () => { resolve(false); db.close(); };
      tx.onabort = () => { resolve(false); db.close(); };
    } catch (e) { resolve(false); try { db.close(); } catch (e2) {} }
  })).catch(() => false);
}

function mirrorWrite(snapshot) {
  return idbOpen().then(db => new Promise(resolve => {
    if (!db) { resolve(false); return; }
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(snapshot, IDB_KEY);
      tx.oncomplete = () => { resolve(true); db.close(); };
      tx.onerror = () => { resolve(false); db.close(); };
      tx.onabort = () => { resolve(false); db.close(); };
    } catch (e) { resolve(false); try { db.close(); } catch (e2) {} }
  })).catch(() => false);
}

/* Непарсящийся снапшот — ОТКАЗ чтения, а не пустота (задача 28.A, п. 1.1).
   Прежде исключение разбора глушилось на месте, store оставался null, и
   исход 'read' продолжал считаться успехом: mirrorReady вставал (статус-то
   не 'failed'), дефолтный store уезжал в зеркало и затирал снапшот В ТОЙ ЖЕ
   сессии. Замер: 9 посевных пунктов легли поверх снапшота, из которого не
   удалось прочитать ни байта.

   Сырая строка откладывается ровно так же, как load() откладывает
   нечитаемый localStorage, и показывается той же строкой «Данных».
   Сам снапшот при этом НЕ трогается: отложенная строка лежит в
   localStorage — в том самом хранилище, от исчезновения которого зеркало
   и страхует. Перезаписать снапшот вправе только владелец, кнопкой
   «Убрать» (она же снимает снапшот, иначе следующий старт упёрся бы
   в него снова).

   Результат не возвращается намеренно: удалась запись или нет, поведение
   одно и то же — сессия объявляется непроверенной и зеркало не пишется.
   Отложить не вышло (квота) — владелец всё равно видит «Резервная копия
   не проверена», а снапшот цел; врать про сохранённую строку нечем. */
function keepMirrorCorrupt(snap) {
  let raw;
  try {
    raw = (snap && typeof snap.json === 'string') ? snap.json : JSON.stringify(snap);
  } catch (e) { return; } // снапшот не сериализуется — сохранять нечего
  if (typeof raw !== 'string') return;
  try {
    localStorage.setItem(MIRROR_CORRUPT_KEY, JSON.stringify({ raw, at: Date.now() }));
  } catch (e) { /* некуда сохранить: снапшот трогать нельзя, он цел */ }
}

/* Снапшот → store или null. Разбор и migrate — как при восстановлении:
   зеркало пишет само приложение, посев ему адресован на общих правах. */
function mirrorParse(snap) {
  if (!snap || typeof snap.json !== 'string') return null;
  try { return migrate(JSON.parse(snap.json)); } catch (e) { return null; }
}

/* Снапшот несёт то, чего в рабочей копии нет ВОВСЕ: дни отметок или пункты.
   Сравнение по содержимому, а не по возрасту — и это вынужденно: savedAt
   есть только у снапшота, у localStorage времени записи нет ни в одном поле
   (разведка 0.5), а завести его значило бы поднять схему. Направление
   выбрано так, чтобы отставание зеркала на одну операцию (дебаунс 500 мс)
   предложения не порождало: оно даёт снапшоту МЕНЬШЕ, а не больше. */
function mirrorHasMore(snapStore, cur) {
  if (!snapStore || typeof snapStore !== 'object') return false;
  const days = (snapStore.days && typeof snapStore.days === 'object') ? snapStore.days : {};
  for (const k of Object.keys(days)) if (!cur.days[k]) return true;
  const ids = new Set(cur.items.map(i => i.id));
  return (Array.isArray(snapStore.items) ? snapStore.items : []).some(i => i && !ids.has(i.id));
}

/* Стартовая сверка с зеркалом. Зовётся ПОСЛЕ первого рендера, поэтому
   старт не удлиняет (п. 2.4), и зовётся ВСЕГДА — в том числе при валидном
   localStorage (п. 2.1). Прежде зеркало в этом случае не читалось вовсе, и
   осторожность, взведённая неудачным чтением, жила ровно одну сессию:
   первая же отметка делала localStorage источником истины, а следующий
   старт затирал подлинный снапшот. Замер: практика в 1 пункт и 2 дня
   становилась 9 посевными пунктами и 1 днём.

   Осторожность не запоминается, а ВЫВОДИТСЯ ЗАНОВО на каждом старте —
   поэтому переживает перезапуск и не требует поля в settings. */
function verifyMirror() {
  return mirrorProbe(MIRROR_PROBE_MS).then(probe => {
    if (probe.status === 'failed') { mirrorUnverified = true; return; }
    if (probe.status === 'read') {
      const kept = mirrorParse(probe.snap);
      if (!kept) {
        keepMirrorCorrupt(probe.snap); // сырую строку — на виду, снапшот — не трогать
        mirrorUnverified = true;
        return;
      } else if (mirrorHasMore(kept, store)) {
        mirrorOffer = { store: kept, savedAt: probe.snap.savedAt, stats: wipeStats(kept) };
        return; // молча не затираем: решение за владельцем (п. 2.2)
      }
    }
    mirrorReady = true;
    scheduleMirror(); // догнать всё, что накопилось, пока сверка шла
  }).then(() => {
    // строка и блок «Данных» рождаются разметкой: экран перерисовывается,
    // если владелец на нём (форма при этом сохраняет черновик обычным путём)
    if (ui.tab === 'settings') renderSettings();
    else updateMirrorNote();
  });
}

/* Дебаунс ~500 мс: частые отметки не молотят IndexedDB */
const MIRROR_FLUSH_MS = timing('MIRROR_FLUSH_MS', 500);

function scheduleMirror() {
  if (!mirrorReady || typeof indexedDB === 'undefined') return;
  mirrorDirty = true;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(flushMirror, MIRROR_FLUSH_MS);
}

/* Немедленный сброс незаписанного снапшота (pagehide, уход в фон, тесты) */
function flushMirror() {
  if (!mirrorReady || !mirrorDirty) return Promise.resolve(false);
  mirrorDirty = false;
  clearTimeout(mirrorTimer);
  return mirrorWrite({
    json: JSON.stringify(store),
    savedAt: Date.now(),
    schemaVersion: store.schemaVersion
  }).then(ok => {
    if (!ok) mirrorDirty = true; // сбой записи — изменения не потеряны, доедут со следующим flush
    return ok;
  });
}

/* ── Даты и граница дня ────────────────────────────────────── */

const pad2 = n => String(n).padStart(2, '0');

function dateKeyFromDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* Логическая дата: время до boundaryHours относится к предыдущему дню. */
function dateKeyShift(d, boundaryHours) {
  return dateKeyFromDate(new Date(d.getTime() - boundaryHours * 3600000));
}

function todayKey() {
  return dateKeyShift(new Date(), store.settings.dayBoundary);
}

function keyToDate(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0); // полдень — вне зоны перевода часов
}

/* Валидный ключ логического дня: формат YYYY-MM-DD и существующая дата */
function isDayKey(k) {
  return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) &&
    dateKeyFromDate(keyToDate(k)) === k;
}

/* Понедельник календарной недели, которой принадлежит логический день */
function weekStartOf(dayKey) {
  const dow = (keyToDate(dayKey).getDay() + 6) % 7; // 0 — понедельник
  return addDays(dayKey, -dow);
}

/* Миллисекунды до ближайшего момента границы дня */
function msToNextBoundary() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    store.settings.dayBoundary, 0, 0, 0);
  while (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function addDays(k, n) {
  const d = keyToDate(k);
  d.setDate(d.getDate() + n);
  return dateKeyFromDate(d);
}

function diffDays(a, b) {
  return Math.round((keyToDate(a) - keyToDate(b)) / 86400000);
}

function fmtWeekday(k) {
  return keyToDate(k).toLocaleDateString('ru-RU', { weekday: 'long' });
}

function fmtDay(k) {
  return keyToDate(k).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function fmtShort(k) {
  return keyToDate(k).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/* Дата и время из миллисекунд — для строки резервной копии */
function fmtStamp(ms) {
  return new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ── Домены: отметки, счётчики, недели ─────────────────────── */

/* ── Отрезок жизни пункта (инвариант 12, задача 28.E/A) ────────
   Пункт живёт от addedAt до removedAt: первый день — тот, в который он
   заведён, последний — накануне того, в который убран. Поле active
   упразднено вместе с тумблером: два контрола с одним последствием и были
   той перегруженностью, на которую жаловался владелец, а после правки
   правила применимости они бы ещё и разошлись — «Убрать» перестал бы
   двигать прошлое, тумблер продолжил бы.

   Две функции, и путать их нельзя. live() — «есть сейчас»: по ней
   строятся списки дневных экранов и механики, работающие с настоящим.
   livedOn() — «был в том дне»: по ней и только по ней считается прошлое. */
const live = x => !x.removedAt;

function livedOn(x, dayKey) {
  return x.addedAt <= dayKey && (!x.removedAt || dayKey < x.removedAt);
}

const liveDaily = () => store.items.filter(i => live(i) && i.type === 'daily');
const liveWeekly = () => store.items.filter(i => live(i) && i.type === 'weekly');

/* ── Уход и возврат ────────────────────────────────────────────
   Словарь задачи 28.E/A: «удалить» — стереть, «убрать» — увести из виду.
   Удаляется только то, от чего не зависит ни одно прошлое число (блок:
   deleteGroup давно воплощает это правило). Пункт и упражнение убираются:
   факт остаётся, из виду уходит.

   Уход действует с СЕГОДНЯШНЕГО дня включительно: removedAt = todayKey(),
   и livedOn перестаёт видеть пункт начиная с этого дня. Вчера и раньше не
   двигается никогда.

   Отказ записи откатывает поле целиком (A.1.8) — как всякая замещающая
   операция: в памяти не должно остаться того, чего нет на диске. */
function removeItem(id) {
  const it = store.items.find(x => x.id === id);
  if (!it || !live(it)) return false;
  it.removedAt = todayKey();
  if (save()) return true;
  it.removedAt = null;
  return false;
}

/* Возврат В ТОТ ЖЕ ДЕНЬ — полная отмена: отрезок не разрывался ни на день,
   и разрывать его записью нечем. ПОЗЖЕ — новая запись с новым id и
   сегодняшним addedAt: иначе дни паузы задним числом вошли бы в
   знаменатель тех дней, в которые пункта не было. Отметки и история
   принадлежат прежнему отрезку и остаются при нём.

   Новая запись встаёт СРАЗУ ЗА прежней, а не в конец списка: порядок
   внутри блока — решение владельца, и возврат не повод его терять.
   Мёртвые поля формулы и лестницы (задача 28.D) в неё не копируются:
   вторая живая лестница противоречила бы канонической форме, которую
   стережёт дедуп migrate. */
function restoreItem(id) {
  const at = store.items.findIndex(x => x.id === id);
  const it = at < 0 ? null : store.items[at];
  if (!it || live(it)) return null;
  const t = todayKey();
  if (it.removedAt === t) {
    it.removedAt = null;
    if (save()) return it;
    it.removedAt = t;
    return null;
  }
  const copy = {
    id: uid(), name: it.name, value: it.value, unit: it.unit,
    type: it.type, area: it.area, goal: it.goal, note: it.note, group: it.group,
    removedAt: null, addedAt: t, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
    history: [], formula: null, ladder: null, ladderLog: []
  };
  if (it.type === 'daily' && it.area === 'habit') copy.normPerWeek = it.normPerWeek || 7;
  if (it.type === 'param') {
    copy.pkind = it.pkind; copy.pvalue = it.pvalue; copy.pstep = it.pstep;
    copy.history = [{ date: t, value: it.pvalue }]; // порог — та же планка (инвариант 5)
  } else if (typeof copy.value === 'number') {
    copy.history = [{ date: t, value: copy.value }];
  }
  store.items.splice(at + 1, 0, copy);
  if (save()) return copy;
  store.items.splice(at + 1, 1);
  return null;
}

/* Упражнения: то же поле и тот же механизм (A.4.1). Правка тривиальна —
   в прошлых числах «Прогресса» упражнения не участвуют вовсе, у них
   только история нагрузки, а она принадлежит своей записи. */
function removeExercise(id) {
  const ex = findExercise(id);
  if (!ex || !live(ex)) return false;
  ex.removedAt = todayKey();
  if (save()) return true;
  ex.removedAt = null;
  return false;
}

function restoreExercise(id) {
  const at = store.exercises.findIndex(x => x.id === id);
  const ex = at < 0 ? null : store.exercises[at];
  if (!ex || live(ex)) return null;
  const t = todayKey();
  if (ex.removedAt === t) {
    ex.removedAt = null;
    if (save()) return ex;
    ex.removedAt = t;
    return null;
  }
  const copy = {
    id: uid(), name: ex.name, unit: ex.unit, value: ex.value,
    history: typeof ex.value === 'number' ? [{ date: t, value: ex.value }] : [],
    removedAt: null, addedAt: t
  };
  store.exercises.splice(at + 1, 0, copy);
  if (save()) return copy;
  store.exercises.splice(at + 1, 1);
  return null;
}

function isMarked(dayKey, itemId) {
  return !!(store.days[dayKey] && store.days[dayKey][itemId]);
}

function toggleMark(dayKey, itemId) {
  const day = store.days[dayKey] || (store.days[dayKey] = {});
  if (day[itemId]) {
    delete day[itemId];
    if (!Object.keys(day).length) delete store.days[dayKey];
  } else {
    day[itemId] = true;
  }
  save();
}

/* Отмечался ли пункт хоть раз — не позже дня upto, если он задан.
   Чистая функция от days{}: reviews в счёт не идут (инвариант 4). */
function everMarked(item, upto) {
  for (const k of Object.keys(store.days)) {
    if ((upto === undefined || k <= upto) && store.days[k][item.id]) return true;
  }
  return false;
}

/* «Не пропускай дважды»: пункт существовал вчера и не был отмечен.
   Пропустить можно только начатое (задача 22, п. 2): до первой отметки
   точки нет вовсе — иначе владелец в первый же день видел бы у всей
   программы «вчера — пропуск» за день, в который её ещё не было.

   Начатость считается НЕ ПОЗЖЕ ВЧЕРА (задача 24, п. 7): сегодняшняя
   первая в жизни отметка не делает вчерашний пропуск «начатым» задним
   числом — точка появится назавтра обычным путём. Иначе она рождалась
   в момент тапа, но только полной перерисовкой, и точечный путь с ней
   расходился (находка сторожа задачи 23; решение архитектора — прав
   точечный путь: отметить пункт и тут же получить укор за вчера
   владелец не должен). */
function missedYesterday(item, tKey) {
  const y = addDays(tKey, -1);
  if (!(item.addedAt <= y) || isMarked(y, item.id)) return false;
  return everMarked(item, y);
}

/* Единственная допустимая правка прошлого (инвариант 7): установить отметку
   за вчера через точку-маркер. Только вчера, только установка — не снятие. */
function markYesterday(itemId) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || !live(item) || item.type !== 'daily') return false;
  const y = addDays(todayKey(), -1);
  if (!(item.addedAt <= y)) return false;
  if (isMarked(y, item.id)) return false;
  const day = store.days[y] || (store.days[y] = {});
  day[item.id] = true;
  save();
  return true;
}

/* Начало текущего периода счёта тренировок: календарная неделя, а в
   переходные дни до calendarSince — прежняя скользящая отсечка weekStart */
function trainSince() {
  return currentWeekStart() || store.weekStart;
}

function trainCount(itemId) {
  const since = trainSince();
  return store.weekLog.reduce((n, e) => n + (e.itemId === itemId && e.date >= since ? 1 : 0), 0);
}

function incTrain(itemId) {
  store.weekLog.push({ itemId, date: todayKey(), ts: Date.now() });
  save();
}

/* Отмена — только записей текущей недели (прошлое неизменяемо). Вместе с
   записью счётчика уходит и сессия того же дня; рабочая нагрузка
   упражнений при этом НЕ откатывается — история планки правдива
   (задача 16D, «Принятые ограничения»). */
function undoTrain(itemId) {
  const since = trainSince();
  for (let i = store.weekLog.length - 1; i >= 0; i--) {
    const e = store.weekLog[i];
    if (e.itemId !== itemId || e.date < since) continue;
    store.weekLog.splice(i, 1);
    for (let j = store.sessions.length - 1; j >= 0; j--) {
      if (store.sessions[j].date === e.date) { store.sessions.splice(j, 1); break; }
    }
    save();
    return;
  }
}

/* ── Упражнения и тренировки (инвариант 15) ───────────────────
   Упражнение — имя, единица и рабочая нагрузка с историей по общим
   правилам планки (recordBar). Сессия — факт тренировки: день,
   значения упражнений и заметка. */

const liveExercises = () => store.exercises.filter(live);

function findExercise(id) {
  return store.exercises.find(e => e.id === id) || null;
}

function addExercise(name, unit, value) {
  const nm = (name || '').trim();
  if (!nm) return null;
  const v = (typeof value === 'number' && isFinite(value) && value > 0) ? value : null;
  const ex = {
    id: uid(), name: nm, unit: (unit || '').trim(), value: v,
    history: v === null ? [] : [{ date: todayKey(), value: v }],
    removedAt: null, addedAt: todayKey()
  };
  store.exercises.push(ex);
  save();
  return ex;
}

function updateExercise(id, name, unit) {
  const ex = findExercise(id);
  if (!ex) return false;
  const nm = (name || '').trim();
  if (!nm) return false; // безымянное упражнение не сохраняется — как у пунктов
  ex.name = nm;
  ex.unit = (unit || '').trim();
  save();
  return true;
}

/* Соседи упражнения по перестановке — только живые: убранное стоит в
   «Убранных», в порядке не участвует, но своё место в массиве сохраняет.
   Тот же приём, что у siblingIndexes для пунктов (инвариант 17). */
function exerciseIndexes() {
  const out = [];
  store.exercises.forEach((x, i) => { if (live(x)) out.push(i); });
  return out;
}

function moveExercise(id, dir) {
  const i = store.exercises.findIndex(e => e.id === id);
  if (i < 0) return false;
  const idxs = exerciseIndexes();
  const at = idxs.indexOf(i);
  if (at < 0) return false; // убранное не двигается: его строки в списке нет
  const j = idxs[at + (dir === 'up' ? -1 : 1)];
  if (j === undefined) return false;
  const t = store.exercises[i];
  store.exercises[i] = store.exercises[j];
  store.exercises[j] = t;
  save();
  return true;
}

/* Заметок и выписок в интерфейсе больше нет: экран снят задачей 28.C.
   Доменные функции (addNote, updateNote, deleteNote, notesByDate, quotes,
   quoteOfDay) ушли вместе с ним. ДАННЫЕ ОСТАЛИСЬ: `store.notes[]` живёт,
   нормализация в migrate его валидирует, счёт потерь импорта его считает,
   экспорт отдаёт целиком. Снятие поля — отдельное решение владельца, и до
   него ни один байт заметок не теряется. */

/* Запись тренировки: сессия дня, обновление нагрузок (история — только
   при изменении) и инкремент недельного счётчика, как раньше. */
function recordSession(weeklyId, entries, note) {
  const list = (Array.isArray(entries) ? entries : [])
    .map(e => ({ exId: e.exId, value: e.value }))
    .filter(e => findExercise(e.exId) && typeof e.value === 'number' && isFinite(e.value) && e.value > 0);
  store.sessions.push({ id: uid(), date: todayKey(), entries: list, note: (note || '').trim() });
  for (const e of list) {
    const ex = findExercise(e.exId);
    if (ex.value === e.value) continue; // нагрузка не менялась — истории нечего писать
    ex.value = e.value;
    recordBar(ex, e.value);
  }
  incTrain(weeklyId); // save() внутри
  return true;
}

/* Календарные недели (инвариант 2): понедельник–воскресенье в логических днях */
function currentWeekStart() {
  const t = todayKey();
  const since = store.settings.calendarSince;
  if (!isDayKey(since) || t < since) return null; // переходные дни до calendarSince
  return weekStartOf(t);
}

function previousWeekStart() {
  const cur = currentWeekStart();
  return cur ? addDays(cur, -7) : null;
}

/* Разбор предлагается только за последнюю завершённую календарную неделю.
   Пропущенные недели тихо проходят; скользящие записи reviews (без week)
   первый календарный разбор не блокируют. Уже разобранная неделя не
   разбирается повторно, где бы её запись ни стояла в reviews. */
function reviewDue() {
  const prev = previousWeekStart();
  if (!prev || prev < store.settings.calendarSince) return false;
  return !store.reviews.some(r => r.week === prev);
}

/* Окно разбора — ровно последняя завершённая неделя; сегодня не входит */
function windowKeys() {
  const prev = previousWeekStart();
  const keys = [];
  if (!prev) return keys;
  for (let i = 0; i < 7; i++) keys.push(addDays(prev, i));
  return keys;
}

/* Последнее записанное «одно изменение» — тихая строка на разборе (инвариант 3) */
function currentOneChange() {
  const last = store.reviews[store.reviews.length - 1];
  const s = (last && typeof last.oneChange === 'string') ? last.oneChange.trim() : '';
  return s || null;
}

/* ── Планка: повышение и понижение (инвариант 4) ─────────────
   Обе механики считают по КАЛЕНДАРНЫМ неделям и отметкам в days{},
   а не по массиву reviews: пропущенный разбор недели не съедает —
   она просто проходит тихо (инвариант 2), а механика продолжает
   работать. Якорь решения — понедельник недели, в которую оно
   принято; следующее предложение возможно, когда все нужные недели
   строго позже якоря. */

/* Критерий повышения: 3 последние закрытые недели, в каждой ≥6 из 7 */
function raiseEligible(item) {
  if (item.type !== 'daily' || !live(item) || item.area !== 'min') return false; // повышение — только минимум
  if (!(typeof item.value === 'number' && isFinite(item.value) && item.value > 0)) return false;
  // Здесь стоял guard «пункт с живой лестницей повышения не получает»: шаг
  // ступени и шаг планки в одну неделю были бы двумя изменениями за раз.
  // Лестница снята задачей 28.D — второго шага в приложении не осталось, и
  // guard стал бы запретом по данным, которых владелец не видит: пункт,
  // носивший лестницу, молча не получал бы предложения никогда. Критерий
  // теперь один — три закрытые недели по ≥6 из 7.
  const W = closedWeeks(3);
  if (W.length < 3) return false;
  if (!W.every(w => itemWeekCount(item, w) >= 6)) return false;
  return item.raiseAfterWeek === null || W[0] > item.raiseAfterWeek;
}

/* Критерий понижения: 2 последние закрытые недели, в каждой ≤3 из 7.
   Значения планки критерий не требует: пункт без числа тоже может
   не держаться — решение по нему сводится к «Оставить». */
function lowerEligible(item) {
  if (item.type !== 'daily' || !live(item) || item.area !== 'min') return false;
  const W = closedWeeks(2);
  if (W.length < 2) return false;
  // пункт должен существовать во ВСЕХ рассматриваемых неделях (A.4.1):
  // иначе «0 и 0 из 7» у заведённого сегодня пункта проходило как
  // «не держится» и разбор предлагал облегчить планку за недели, в
  // которые пункта не было (аудит, находка 6). Повышению такая защита
  // не нужна: там критерий требует ≥6 отметок, а у нового пункта их нет.
  if (!(item.addedAt <= W[0])) return false;
  // и пункт должен быть начат (задача 22, п. 1): ни одной отметки за всё
  // время до конца окна — облегчать нечего, планка ещё не проверялась.
  // Владелец, засеявший программу и не успевший отметиться, получал
  // предложение урезать её за недели, в которые не мог отмечаться.
  if (!everMarked(item, addDays(W[W.length - 1], 6))) return false;
  if (!W.every(w => itemWeekCount(item, w) <= 3)) return false;
  return item.lowerAfterWeek === null || W[0] > item.lowerAfterWeek;
}

/* Все пункты, готовые к повышению, — по порядку items[] */
const raiseReady = () => store.items.filter(raiseEligible);

/* Пункт, которому в ЭТОМ разборе предлагается повышение: первый готовый
   по порядку items[], и только если решения по планке вверх на текущей
   неделе ещё не было. «Принять» и «Не сейчас» ставят один и тот же якорь
   raiseAfterWeek = currentWeekStart() (инвариант 4) — он и служит признаком
   принятого решения, ровно как steppedWeek у лестницы. Отдельного поля
   и схемы это не требует.

   Так правило «одно изменение за раз» становится механикой (задача 24,
   п. 6): на трёх идеальных неделях посева готовы были все четыре числовых
   пункта минимума, и разбор предлагал повысить программу целиком.
   Остальные не запрещаются — их предложение просто откладывается
   на следующую неделю прежним путём, якорей это не трогает. */
function raiseOffer() {
  const cur = currentWeekStart();
  if (cur && store.items.some(i => i.raiseAfterWeek === cur)) return null;
  return store.items.find(raiseEligible) || null;
}

function raiseSuggest(v) {
  return v <= 12 ? v + 1 : Math.round(v * 1.1);
}

/* Насколько легче: крупная планка — на четверть, мелкая — на единицу,
   единице и ниже облегчать нечего (null — кнопки шага нет) */
function lowerSuggest(v) {
  if (!(typeof v === 'number' && isFinite(v))) return null;
  if (v > 12) return Math.round(v * 0.75);
  if (v >= 2) return v - 1;
  return null;
}

/* Якорь недели решения: и «Принять», и «Не сейчас» ставят его одинаково —
   отсчёт трёх недель начинается заново, с недели строго после текущей */
function resetRaiseCount(item) {
  item.raiseAfterWeek = currentWeekStart();
  save();
}

/* Понижение: планка меняется немедленно и попадает в срез разбора */
function acceptLower(item, newValue) {
  const from = item.value;
  item.value = newValue;
  recordBar(item, newValue);
  store.pendingLowers.push({ itemId: item.id, name: item.name, from, to: newValue });
  item.lowerAfterWeek = currentWeekStart();
  save();
}

/* «Оставить»: планка не меняется, решение по неделе зафиксировано */
function keepBar(item) {
  item.lowerAfterWeek = currentWeekStart();
  save();
}

/* Запись изменения планки в историю пункта.
   Повторное изменение в тот же день заменяет последнюю запись,
   возврат к прежнему значению схлопывает её — в истории остаётся
   движение по неделям без правок и дублей («5 → 5» не бывает). */
function recordBar(item, newValue) {
  if (!Array.isArray(item.history)) item.history = [];
  const last = item.history[item.history.length - 1];
  if (last && last.date === todayKey()) {
    const prev = item.history[item.history.length - 2];
    if (prev && prev.value === newValue) item.history.pop();
    else last.value = newValue;
  } else if (!last || last.value !== newValue) {
    item.history.push({ date: todayKey(), value: newValue });
  }
}

function acceptRaise(item, newValue) {
  const from = item.value;
  item.value = newValue;
  recordBar(item, newValue);
  store.pendingRaises.push({ itemId: item.id, name: item.name, from, to: newValue });
  item.raiseAfterWeek = currentWeekStart();
  save();
}

/* ── Параметры недели и готовность к новой привычке (area habit) ── */

function fmtParam(item, v) {
  const val = (v === undefined) ? item.pvalue : v;
  if (item.pkind === 'time') {
    const m = ((Math.round(val) % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }
  return item.unit ? `${val} ${item.unit}` : String(val);
}

function paramStepTarget(item) {
  if (item.pkind === 'time') return (((item.pvalue + item.pstep) % 1440) + 1440) % 1440;
  return item.pvalue + item.pstep;
}

/* Решение по параметру, принадлежащее разбираемой неделе;
   решение чужой недели — как отсутствие решения */
function paramDecision(itemId) {
  const d = store.paramDecided[itemId];
  return (d && d.week === previousWeekStart()) ? d : null;
}

/* Параметры, ждущие решения в этом разборе: их карточки живут в видимой
   части, в «Решении 1» (задача 24, п. 2) — порог параметра меняется тем
   же recordBar и той же историей, что планка пункта. Решённые остаются
   под свёрткой тихой строкой итога: это уже read-only справка. */
const pendingParams = () => store.items.filter(i => i.type === 'param' && live(i) && !paramDecision(i.id));

/* Одно решение на параметр за разбор (инвариант 10); шаг применяется немедленно */
function applyParamStep(itemId) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || item.type !== 'param' || !live(item)) return false;
  if (!reviewDue() || paramDecision(itemId)) return false;
  const from = item.pvalue;
  item.pvalue = paramStepTarget(item);
  recordBar(item, item.pvalue); // история порога — по общим правилам истории планки
  store.paramDecided[itemId] = { week: previousWeekStart(), from, to: item.pvalue };
  save();
  return true;
}

function keepParam(itemId) {
  const item = store.items.find(i => i.id === itemId);
  if (!item || item.type !== 'param' || !live(item)) return false;
  if (!reviewDue() || paramDecision(itemId)) return false;
  store.paramDecided[itemId] = { week: previousWeekStart(), from: item.pvalue, to: null };
  save();
  return true;
}

/* ── Норма и серия привычки (инвариант 11) ──────────────────
   Чистые функции от days{}, normPerWeek и календаря: разбор и
   closeWeek на них не влияют, смена нормы ретроактивна. */

/* Отметки ежедневного пункта в календарной неделе с понедельником mon —
   общая функция для обеих областей (инвариант 12) */
function itemWeekCount(item, mon) {
  let n = 0;
  for (let i = 0; i < 7; i++) if (isMarked(addDays(mon, i), item.id)) n++;
  return n;
}

/* Отметки привычки в той же неделе — тонкая обёртка (инвариант 11) */
function habitWeekCount(item, mon) {
  return itemWeekCount(item, mon);
}

/* Серия, считая назад от недели lastWeek включительно; недели существуют
   только с calendarSince (инвариант 2). Неделя без нормы обрывает счёт,
   поэтому цикл конечен: пустых недель норма (≥1) не набирает. */
function habitStreakFrom(item, lastWeek) {
  const since = store.settings.calendarSince;
  if (!isDayKey(since)) return 0;
  let n = 0;
  for (let w = lastWeek; w >= since; w = addDays(w, -7)) {
    if (habitWeekCount(item, w) < (item.normPerWeek || 7)) break;
    n++;
  }
  return n;
}

/* Серия на сегодня: от последней завершённой недели; текущая не входит —
   сегодняшние тапы серию не меняют */
function habitStreak(item) {
  const cur = currentWeekStart();
  return cur ? habitStreakFrom(item, addDays(cur, -7)) : 0;
}

/* Информационная готовность: 2 последние ЗАВЕРШЁННЫЕ календарные недели
   каждая активная привычка выполнила норму (≥ normPerWeek; норма
   ретроактивна — берётся текущая).
   Считает по days{} и календарю, как и всё остальное в программе роста.
   Раньше читала два последних элемента reviews — и тогда десять идеальных
   недель без единого разбора готовности не давали, а два разбора
   полугодовой давности давали её при пустых последних неделях
   (аудит, находка 5). reviews — архив, а не источник. */
function habitsSteady() {
  const habits = store.items.filter(i => i.type === 'daily' && i.area === 'habit' && live(i));
  if (!habits.length) return false;
  const W = closedWeeks(2);
  if (W.length < 2) return false;
  return W.every(w => habits.every(h => habitWeekCount(h, w) >= (h.normPerWeek || 7)));
}

/* ── Закрытые недели ───────────────────────────────────────────
   Общий счётчик календаря. Жил в разделе лестницы, но читателей у него
   всегда было больше: повышение и понижение планки, готовность привычек,
   консистентность в разборе. Лестница снята задачей 28.D — функция
   осталась и переехала под собственный заголовок. */

/* До n понедельников последних ЗАВЕРШЁННЫХ календарных недель, по
   возрастанию; текущая не входит, недели до calendarSince не существуют
   (инвариант 2) — при нехватке список короче n. */
function closedWeeks(n) {
  const out = [];
  const cur = currentWeekStart();
  const since = store.settings.calendarSince;
  if (!cur || !isDayKey(since)) return out;
  for (let i = 1; i <= n; i++) {
    const w = addDays(cur, -7 * i);
    if (w < since) break;
    out.unshift(w);
  }
  return out;
}

/* ── Блоки (инвариант 13) ──────────────────────────────────
   Блок — запись в store.groups: одно имя. Пункт хранит имя блока строкой;
   неизвестное имя не ошибка — такой пункт просто идёт без заголовка
   последним. Блок из двух и более активных пунктов и есть цепочка. */

const groupNameOf = it => (it.group || '').trim();

function findGroup(name) {
  const n = String(name ?? '').trim();
  return store.groups.find(g => g.name === n) || null;
}

function addGroup(name) {
  const n = String(name ?? '').trim();
  if (!n || findGroup(n)) return false;
  store.groups.push({ name: n });
  save();
  return true;
}

function moveGroup(name, dir) {
  const i = store.groups.findIndex(g => g.name === String(name ?? '').trim());
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= store.groups.length) return false;
  const t = store.groups[i];
  store.groups[i] = store.groups[j];
  store.groups[j] = t;
  save();
  return true;
}

/* Переименование атомарно: имя в списке и item.group всех пунктов блока
   меняются вместе. Пустое имя и столкновение с чужим именем не проходят. */
function renameGroup(oldName, newName) {
  const from = String(oldName ?? '').trim();
  const to = String(newName ?? '').trim();
  const g = findGroup(from);
  if (!g || !to) return false;
  if (to !== from && findGroup(to)) return false; // имена уникальны
  g.name = to;
  for (const it of store.items) if (groupNameOf(it) === from) it.group = to;
  save();
  return true;
}

/* Удаление блока: пункты остаются и отметки не трогаются — очищается
   только имя блока у них */
function deleteGroup(name) {
  const n = String(name ?? '').trim();
  const i = store.groups.findIndex(g => g.name === n);
  if (i < 0) return false;
  store.groups.splice(i, 1);
  for (const it of store.items) if (groupNameOf(it) === n) it.group = '';
  save();
  return true;
}

/* Раскладка дневного экрана: сначала блоки в порядке store.groups, затем
   пункты без блока или с неизвестным — одной секцией без заголовка */
function groupedItems(items) {
  const out = [];
  const known = new Set();
  for (const g of store.groups) {
    known.add(g.name);
    const inGroup = items.filter(it => groupNameOf(it) === g.name);
    if (inGroup.length) out.push({ group: g, items: inGroup });
  }
  const loose = items.filter(it => !known.has(groupNameOf(it)));
  if (loose.length) out.push({ group: null, items: loose });
  return out;
}

/* Соседи пункта по перестановке — пункты того же блока и той же области
   (задача 16F). Блок пункт меняет полем «Блок» в форме правки, а не
   стрелками и не перетаскиванием: порядок и принадлежность — разные
   решения. Возвращает индексы в store.items по возрастанию. */
function siblingIndexes(item) {
  const g = groupNameOf(item);
  const out = [];
  store.items.forEach((x, i) => {
    // убранный пункт в списке не стоит и соседом не считается: стрелка
    // перепрыгивает его, а его собственное место в items[] не меняется
    if (live(x) && x.area === item.area && groupNameOf(x) === g) out.push(i);
  });
  return out;
}

/* Перестановка пункта в пределах своего блока: обмен с ближайшим
   соседом. Границы блока — первый и последний его пункт. */
function moveItem(id, dir) {
  const i = store.items.findIndex(x => x.id === id);
  if (i < 0) return false;
  const idxs = siblingIndexes(store.items[i]);
  const at = idxs.indexOf(i);
  if (at < 0) return false; // убранный пункт не двигается: его строки в списке нет
  const j = idxs[at + (dir === 'up' ? -1 : 1)];
  if (j === undefined) return false;
  const t = store.items[i];
  store.items[i] = store.items[j];
  store.items[j] = t;
  save();
  return true;
}

/* Есть ли куда двигать — тем же правилом рисуется disabled у стрелок */
function canMoveItem(id, dir) {
  const i = store.items.findIndex(x => x.id === id);
  if (i < 0) return false;
  const idxs = siblingIndexes(store.items[i]);
  const at = idxs.indexOf(i);
  return at >= 0 && idxs[at + (dir === 'up' ? -1 : 1)] !== undefined;
}

/* Перестановка перетаскиванием: пункт встаёт на позицию to среди своих
   соседей по блоку, порядок остальных не меняется. */
function reorderItem(id, to) {
  const item = store.items.find(x => x.id === id);
  if (!item || !live(item)) return false;
  const idxs = siblingIndexes(item);
  const list = idxs.map(i => store.items[i]);
  const from = list.indexOf(item);
  if (from < 0 || to < 0 || to >= list.length || to === from) return false;
  list.splice(from, 1);
  list.splice(to, 0, item);
  idxs.forEach((pos, k) => { store.items[pos] = list[k]; });
  save();
  return true;
}

function reorderGroup(name, to) {
  const from = store.groups.findIndex(g => g.name === name);
  if (from < 0 || to < 0 || to >= store.groups.length || to === from) return false;
  const [g] = store.groups.splice(from, 1);
  store.groups.splice(to, 0, g);
  save();
  return true;
}

function reorderExercise(id, to) {
  const ex = findExercise(id);
  if (!ex || !live(ex)) return false;
  const idxs = exerciseIndexes();
  const list = idxs.map(i => store.exercises[i]);
  const from = list.indexOf(ex);
  if (from < 0 || to < 0 || to >= list.length || to === from) return false;
  list.splice(from, 1);
  list.splice(to, 0, ex);
  idxs.forEach((pos, k) => { store.exercises[pos] = list[k]; });
  save();
  return true;
}

/* ── Прогресс (инвариант 14) ───────────────────────────────────
   Чистые функции от days{}, items[] и календаря. Ни разборы, ни
   закрытие недели на них не влияют: прошлое читается по фактам
   отметок, а не по срезам. Всё это живёт только на «Прогрессе» —
   экране, который открывают намеренно. */

/* Пункты минимума, ЖИВШИЕ в этот день (инвариант 12). Единственная
   содержательная правка задачи 28.E/A — здесь; всё остальное наследуется.

   Прежде фильтр читал i.active — НЫНЕШНЕЕ значение — и применял его ко
   всем дням истории: сегодняшний тумблер переписывал прошлое. Замер на
   фикстуре 28 дней (разведка A.0.2): выключение одного пункта из шести
   превращало серию из 9 дней в 26, рекорд из 9 в 26, а цепь из «22
   полных, 4 частичных» в «26 полных, 0 частичных» — без единой новой
   отметки. Правило применимости и было дефектом, а не отсутствие
   удаления, которого просил владелец.

   Теперь день читается по отрезку жизни: пункт заведён не позже этого
   дня и не убран раньше или в этот день (livedOn). Уход действует с
   сегодняшнего дня включительно — вчера и раньше не двигается никогда. */
function minDayItems(dayKey) {
  return store.items.filter(i =>
    i.type === 'daily' && i.area === 'min' && livedOn(i, dayKey));
}

/* Сколько таких пунктов отмечено: 0 — день пуст, меньше всех —
   частичный, все — закрыт. Один проход для серии и для цепи дней. */
function minDayMarks(dayKey) {
  const items = minDayItems(dayKey);
  return { done: items.filter(i => isMarked(dayKey, i.id)).length, total: items.length };
}

/* «День закрыт» — отмечены ВСЕ применимые пункты. Понятие принадлежит
   экрану «Сегодня» и планке дня; серия и цепь дней им не пользуются:
   у них своё понятие «день зачтён» (доля ≥ порога, задача 17).
   Пустой список пунктов днём закрытым не делает: закрывать было
   нечего. Иначе вакуумная истина дала бы серию до начала календаря. */
function minDayClosed(dayKey) {
  const m = minDayMarks(dayKey);
  return m.total > 0 && m.done === m.total;
}

/* ── Доля дня и порог зачёта (задача 17) ───────────────────────
   «День зачтён» — не «день закрыт»: планке дня нужны все пункты,
   серии довольно доли. Порог живёт в настройках, шаг 0,1. */

const THRESHOLD_MIN = 0.3, THRESHOLD_MAX = 1, THRESHOLD_STEP = 0.1;

/* Порог из внешних данных: доля в [0,3..1,0], округлённая до десятой */
function clampThreshold(v) {
  const n = Math.round(numOr(v, 0.8) * 10) / 10;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, n));
}

function dayThreshold() {
  return clampThreshold(store.settings.dayThreshold);
}

/* Доля отмеченного среди применимых пунктов дня. Пунктов не было —
   null: день выпадает из счёта и серию не обрывает. */
function dayScore(dayKey) {
  const m = minDayMarks(dayKey);
  return m.total > 0 ? m.done / m.total : null;
}

/* Сравнение доли с порогом идёт с допуском: 0,1 и деления вроде 4/5
   не представимы в двоичной дроби точно, и 0,8 ≥ 0,8 могло бы не
   выполниться после нескольких шагов степпера. */
const EPS = 1e-9;

/* Сколько отметок из total даёт зачёт при текущем пороге — число для
   подписи степпера: минимальное done, при котором done/total ≥ порога */
function dayNeed(total) {
  return total > 0 ? Math.ceil(total * dayThreshold() - EPS) : 0;
}

/* Подпись под степпером порога. Отдельной функцией, потому что тумблер
   пункта меняет число применимых пунктов и обязан её обновить точечно
   (задача 22, п. 5): полная перерисовка убила бы переход тумблера.
   Пунктов нет — подписи нет, но узел остаётся: его нечем было бы
   создать, когда первый пункт включат обратно. */
function thresholdNote() {
  const total = minDayItems(todayKey()).length;
  return total ? `День зачтён, если отмечено не меньше ${dayNeed(total)} из ${total}.` : '';
}

/* «В системе N дней»: логические дни от calendarSince до сегодня
   включительно. Не прерывается никогда — пропуски на неё не влияют.
   Ноль до наступления calendarSince (миграция ставит его в ближайший
   понедельник, который может быть впереди). */
function daysInSystem() {
  const since = store.settings.calendarSince;
  const t = todayKey();
  if (!isDayKey(since) || t < since) return 0;
  return diffDays(t, since) + 1;
}

/* Амнистия одна на неделю: следующий незачтённый день прощается,
   только если предыдущий прощённый дальше этого срока (задача 17).
   Два незачтённых подряд — частный случай: расстояние 1 ≤ 7. */
const AMNESTY_GAP = 7;

/* Серия зачтённых дней, считая назад от дня end (инвариант 14).
   Сегодня незачтённым пропускается — день ещё не кончился, и амнистию
   он не тратит. Дальше назад: зачтённый +1; незачтённый прощается,
   если прошлая амнистия дальше AMNESTY_GAP, иначе обрыв; день без
   применимых пунктов проходит мимо счёта. Дно — calendarSince.

   score — как читать долю дня; отдельным параметром ради bestStreak,
   который прогоняет ту же логику по всей эпохе с готовой таблицей. */
function streakBack(end, score) {
  const t = todayKey();
  const since = store.settings.calendarSince;
  const floor = isDayKey(since) ? since : end;
  if (end < floor) return 0;
  const th = dayThreshold() - EPS;
  let n = 0;
  let k = end;
  if (k === t) { // сегодня: зачтённый идёт в счёт, незачтённый просто пропускается
    const s = score(k);
    if (s !== null && s >= th) n = 1;
    k = addDays(k, -1);
  }
  let amnesty = null; // день последней амнистии (он позже текущего k)
  for (; k >= floor; k = addDays(k, -1)) {
    const s = score(k);
    if (s === null) continue;
    if (s >= th) { n++; continue; }
    if (amnesty !== null && diffDays(amnesty, k) <= AMNESTY_GAP) break;
    amnesty = k; // прощён: серию не рвёт и в счёт не идёт
  }
  return n;
}

function dayStreak() {
  return streakBack(todayKey(), dayScore);
}

/* Рекорд — максимальная серия за всю историю по тем же правилам:
   в store не хранится, считается по days{} при каждом показе.

   Считается ОДНИМ проходом (задача 19, B.1). Раньше здесь стоял
   streakBack для каждого дня эпохи, и каждый уходил назад до
   calendarSince: квадратично по дням. Замер аудита — 100 мс на годе,
   940 мс на трёх годах, и «Прогресс» замирал вместе с ним.

   Требование к этому месту — наблюдаемое, а не предписывающее (задача
   23, п. 8.1): конституция спрашивает не «сколькими проходами», а
   «за сколько», и держит ответ тестом «bestStreak на трёх годах
   истории укладывается в 50 мс». Линейный проход даёт 1,6 мс,
   квадратичный возврат — 717 мс, то есть падение теста. Один проход —
   способ уложиться, и он описан ниже; способ можно сменить, порог —
   нет.

   Наблюдение, которое делает проход линейным: куда упрётся счёт,
   зависит не от дня, которым он кончается, а от ЦЕПОЧКИ незачтённых
   дней под ним. Счёт, начатый выше незачтённого дня u, прощает u,
   потом следующий незачтённый v — если v дальше AMNESTY_GAP, иначе
   обрывается на нём. Значит для каждого незачтённого дня можно один
   раз вычислить день обрыва (breakAt) по предыдущему такому же, а
   длину серии, кончающейся днём i, взять как разность префиксных
   сумм зачтённых дней. Дни без применимых пунктов (доля null) в
   обеих суммах прозрачны — как и в streakBack. */
function bestStreak() {
  const t = todayKey();
  const since = store.settings.calendarSince;
  if (!isDayKey(since) || t < since) return 0;
  const th = dayThreshold() - EPS;

  // проход первый: доли дней, префикс зачтённых, список незачтённых
  const days = [];       // дни эпохи по возрастанию
  const scored = [];     // scored[i] — зачтённых дней в days[0..i]
  const unscored = [];   // индексы дней с долей ниже порога (null — не сюда)
  let acc = 0;
  for (let k = since; k <= t; k = addDays(k, 1)) {
    const s = dayScore(k);
    if (s !== null) {
      if (s >= th) acc++;
      else unscored.push(days.length);
    }
    days.push(k);
    scored.push(acc);
  }

  // проход второй: цепочка амнистий. breakAt[j] — индекс дня, на котором
  // оборвётся счёт, спустившийся ниже j-го незачтённого дня; −1 — обрыва
  // нет, счёт доходит до начала эпохи.
  const breakAt = new Array(unscored.length);
  for (let j = 0; j < unscored.length; j++) {
    if (j === 0) { breakAt[j] = -1; continue; }
    const u = days[unscored[j]], v = days[unscored[j - 1]];
    breakAt[j] = diffDays(u, v) <= AMNESTY_GAP ? unscored[j - 1] : breakAt[j - 1];
  }

  // длина серии, кончающейся днём i (правило «сегодня» сюда не входит)
  const upto = (i, j) => {
    if (i < 0) return 0;
    if (j < 0) return scored[i];              // незачтённых под ним не было
    const b = breakAt[j];
    return scored[i] - (b < 0 ? 0 : scored[b]);
  };

  // проход третий: максимум. j идёт вместе с i — последний незачтённый ≤ i
  const last = days.length - 1;
  let best = 0, j = -1;
  for (let i = 0; i < last; i++) {
    if (j + 1 < unscored.length && unscored[j + 1] === i) j++;
    const n = upto(i, j);
    if (n > best) best = n;
  }
  // сегодня по особому правилу: незачтённый пропускается, а не амнистируется,
  // поэтому счёт за сегодня — это счёт за вчера плюс сам сегодняшний день
  const todayScored = scored[last] - (last > 0 ? scored[last - 1] : 0);
  const nToday = (last > 0 ? upto(last - 1, j) : 0) + todayScored;
  return nToday > best ? nToday : best;
}

/* Понедельники последних n календарных недель по возрастанию, включая
   текущую. Опирается на weekStartOf, а не на currentWeekStart: сетка
   рисуется и до наступления calendarSince. */
function chainWeeks(n) {
  const mon = weekStartOf(todayKey());
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(mon, -7 * i));
  return out;
}

/* Знаменатель строки «Отметки»: дни от позднейшей из двух дат —
   когда пункт заведён и когда началась эпоха — до сегодня включительно.
   Пункт, заведённый вчера, показывает «1 из 2», а не «1 из 32»:
   иначе новый пункт выглядел бы провалом с первого дня. */
function marksWindow(item) {
  const since = store.settings.calendarSince;
  const t = todayKey();
  if (!isDayKey(since)) return 0;
  const from = (isDayKey(item.addedAt) && item.addedAt > since) ? item.addedAt : since;
  return t < from ? 0 : diffDays(t, from) + 1;
}

/* Отметок пункта за время в системе — числитель строки «Отметки» */
function marksInSystem(item) {
  const since = store.settings.calendarSince;
  const t = todayKey();
  if (!isDayKey(since)) return 0;
  let n = 0;
  for (const k of Object.keys(store.days)) {
    if (k >= since && k <= t && store.days[k][item.id]) n++;
  }
  return n;
}

/* Ряд «Подъёма» — точки {date, value}. Источник один — история планки
   (у упражнения — история нагрузки, инвариант 15); меньше двух записей —
   ряда нет. Вторым источником был ladderLog: пункт без истории значений
   получал ступеньку по журналу лестницы. Лестница снята задачей 28.D, и
   рисовать подъём по механике, которой нет, нечем — правило «не больше
   одного визуала на пункт» держится теперь само собой. */
function riseSeries(item) {
  const hist = Array.isArray(item.history) ? item.history : [];
  if (hist.length < 2) return null;
  return { kind: 'bar', points: hist.map(x => ({ date: x.date, value: x.value })) };
}

/* ── Закрытие недели ───────────────────────────────────────── */

/* Решения по планке, принятые В ТЕКУЩУЮ календарную неделю. Приём тот же,
   что у счётчика тренировок (инвариант 3): читаем только свою неделю, а не
   всё накопленное. Датой служит якорь недели у самого пункта —
   raiseAfterWeek / lowerAfterWeek, который ставят ОБЕ кнопки решения;
   отдельного поля в записи для этого не нужно, схема не меняется.

   Прежде пропущенное закрытие складывало решения двух разборов в ОДИН
   срез: разбор недели W1 поднял планку «А», разбор не закрыли, назавтра
   окно сменилось, разбор W2 поднял «Б» — и срез W2 приписывал себе оба
   (задача 27). Пункт, решённый дважды, отдаёт в срез последнее решение. */
function pendingThisWeek(list, field) {
  const cur = currentWeekStart();
  if (!cur) return [];
  const seen = new Set();
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    const it = store.items.find(x => x.id === r.itemId);
    if (!it || it[field] !== cur || seen.has(r.itemId)) continue;
    seen.add(r.itemId);
    out.unshift(r);
  }
  return out;
}

function closeWeek() {
  if (!reviewDue()) return false; // guard: завершённой неразобранной недели нет
  const week = previousWeekStart();
  const keys = windowKeys();
  const perItem = {};
  for (const it of store.items) {
    if (it.type !== 'daily') continue;
    const marks = keys.map(k => isMarked(k, it.id));
    if (!live(it) && !marks.some(Boolean)) continue; // убранные без отметок в окне не попадают в срез
    perItem[it.id] = { name: it.name, marks, count: marks.filter(Boolean).length };
  }
  const weekEnd = keys[6];
  const trainings = {};
  for (const w of store.items.filter(i => i.type === 'weekly')) {
    const count = store.weekLog.filter(e => e.itemId === w.id && e.date >= week && e.date <= weekEnd).length;
    if (!live(w) && !count) continue; // как и в perItem: убранные без счёта не попадают
    trainings[w.id] = { name: w.name, count, goal: w.goal };
  }
  store.reviews.push({
    closedAt: Date.now(),
    week, // понедельник разобранной недели
    keys,
    perItem,
    trainings,
    oneChange: (store.draftOneChange || '').trim(),
    raises: pendingThisWeek(store.pendingRaises, 'raiseAfterWeek'),
    lowers: pendingThisWeek(store.pendingLowers, 'lowerAfterWeek'),
    // в срез идут только решения разобранной недели; чистится paramDecided целиком
    params: Object.entries(store.paramDecided)
      .filter(([, d]) => d.week === week)
      .map(([id, d]) => ({ id, from: d.from, to: d.to }))
  });
  store.pendingRaises = [];
  store.pendingLowers = [];
  store.draftOneChange = '';
  store.paramDecided = {};
  // счётчик «Сегодня» обнуляется сменой недели, не закрытием: чистим только прошлое
  const cur = currentWeekStart();
  store.weekLog = store.weekLog.filter(e => e.date >= cur);
  save();
  return true;
}

/* ── Чистка и её отмена (задача 16.1) ──────────────────────────
   Стирание данных — не исключение из правила «необратимых операций
   нет», а его применение: прежний store целиком ложится в отдельный
   ключ и живёт там, пока владелец не уберёт копию вторым решением.
   Копия — не часть store: ни в экспорт, ни в импорт она не входит. */

const WIPE_KEY = NS + ':wiped';
const CORRUPT_KEY = NS + ':corrupt';

/* Числа для строки предупреждения и для строки возврата */
function wipeStats(s) {
  return {
    items: s.items.length,
    groups: s.groups.length,
    days: Object.keys(s.days).length,
    reviews: s.reviews.length,
    ladders: s.items.filter(i => i.ladder).length,
    exercises: s.exercises.length,
    sessions: s.sessions.length,
    notes: s.notes.length
  };
}

function wipedCopy() {
  try {
    const raw = localStorage.getItem(WIPE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return (c && typeof c === 'object' && c.store && typeof c.store === 'object') ? c : null;
  } catch (e) { return null; } // нечитаемая копия — как её отсутствие
}

function dropWiped() {
  try { localStorage.removeItem(WIPE_KEY); } catch (e) { /* нечего убирать */ }
}

/* Сырое содержимое ключа копии и его восстановление — для ОТКАТА.
   Любое замещение трогает копию ДО записи рабочего ключа: иначе некуда
   было бы отступить, если копию положить не удалось. Но и запись рабочего
   ключа может не удаться, и тогда замещение остаётся совершённым
   наполовину — копия израсходована, а на диске прежнее состояние.
   Возврат при этом терял практику ЦЕЛИКОМ: dropWiped снимал копию,
   save() падал, и на диске оставался пустой store (задача 27, Д5).
   Пара функций возвращает ключ ровно в то состояние, в каком он был. */
function wipedRaw() {
  try { return localStorage.getItem(WIPE_KEY); } catch (e) { return null; }
}

function setWipedRaw(raw) {
  try {
    if (raw === null) localStorage.removeItem(WIPE_KEY);
    else localStorage.setItem(WIPE_KEY, raw);
  } catch (e) { /* откат копии не удался — сделать больше нечем */ }
}

/* Есть ли в store хоть что-нибудь владельца. Признак берётся из того же
   wipeStats, что показывает предупреждение чистки: заводить отдельное
   поле незачем — ни одного ненулевого числа значит терять нечего. */
function hasData(s) {
  return Object.values(wipeStats(s)).some(n => n > 0);
}

/* Копия прежнего состояния — одна механика на все поводы замещения:
   чистку, импорт и сам возврат (инвариант 18). Возвращает false, только
   если копию некуда положить, — тогда замещающая операция не выполняется.

   Пустой store копию НЕ подменяет: «одна, последняя» значит «последняя
   СОДЕРЖАТЕЛЬНАЯ». Вторая чистка подряд прежде клала в копию пустоту и
   уносила практику, которую первая чистка туда положила (задача 25, п. 7). */
function keepPrev(prev, kind) {
  if (!hasData(prev)) return true;
  try {
    localStorage.setItem(WIPE_KEY, JSON.stringify({
      store: prev, wipedAt: Date.now(), stats: wipeStats(prev), kind
    }));
    return true;
  } catch (e) {
    return false;
  }
}

/* Два источника нечитаемого — рабочий ключ и снапшот зеркала (задача 28.A,
   п. 1.3). Формат, показ и обе кнопки у них общие, различаются только ключ
   и слова: второй такой же механизм заводить незачем. */
const CORRUPT_SRC = {
  data: {
    key: CORRUPT_KEY,
    title: 'Найдены нечитаемые данные',
    why: 'Приложение не смогло их прочитать и отложило, ничего не стирая.',
    file: 'minimum-нечитаемое-'
  },
  mirror: {
    key: MIRROR_CORRUPT_KEY,
    title: 'Резервная копия оказалась нечитаемой',
    why: 'Приложение не смогло её прочитать и отложило содержимое сюда, ничего не стирая. Пока она лежит, новая копия не ведётся: «Убрать» освободит место под неё.',
    file: 'minimum-копия-нечитаемая-'
  }
};

/* Нечитаемые данные, отложенные load(): {raw, at}. Прежний формат — голая
   строка без даты — читается тоже, дата тогда неизвестна (задача 25, п. 6). */
function corruptCopy(src) {
  const key = (CORRUPT_SRC[src] || CORRUPT_SRC.data).key;
  let raw = null;
  try { raw = localStorage.getItem(key); } catch (e) { return null; }
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (c && typeof c === 'object' && typeof c.raw === 'string' && typeof c.at === 'number') return c;
  } catch (e) { /* голая строка старого формата — ниже */ }
  return { raw, at: null };
}

function dropCorrupt(src) {
  const key = (CORRUPT_SRC[src] || CORRUPT_SRC.data).key;
  try { localStorage.removeItem(key); } catch (e) { /* нечего убирать */ }
}

/* Пустое хранилище: ни одного стартового пункта. Граница дня и порог
   зачёта — настройки того, как считается день, а не данные: обе
   переживают чистку (инвариант 18). */
function emptyStore(boundary, threshold) {
  const b = (typeof boundary === 'number' && isFinite(boundary)) ? boundary : 4;
  const today = dateKeyShift(new Date(), b);
  return {
    schemaVersion: SCHEMA_VERSION,
    items: [], groups: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {},
    draftOneChange: '',
    weekStart: today,
    settings: {
      dayBoundary: b,
      dayThreshold: clampThreshold(threshold),
      exportedAt: null,
      calendarSince: nextCalendarMonday(today),
      habitSeeded: true, // посев привычек уже состоялся: чистый лист остаётся чистым
      seed17: true       // и посев программы: перезапуск не вернёт стёртое (инвариант 18)
    }
  };
}

/* Копия пишется ПЕРЕД заменой store: если её некуда положить, чистка
   не выполняется вовсе — необратимо стирать нельзя. Зеркало сбрасывается
   немедленно: с дебаунсом следующий запуск при пустом localStorage
   восстановил бы стёртое из старого снапшота. */
function wipeAll() {
  const prev = store;
  const wasCopy = wipedRaw();
  if (!keepPrev(prev, 'wipe')) return false;
  store = emptyStore(
    prev.settings && prev.settings.dayBoundary,
    prev.settings && prev.settings.dayThreshold);
  // запись пустого store не удалась — откат целиком: на диске осталось
  // прежнее, значит и в памяти, и в копии должно остаться прежнее. Иначе
  // экран показывал бы чистый лист, копия — «до чистки», а на диске лежала
  // бы нетронутая практика: три разных ответа на один вопрос (задача 27, Д5)
  if (!save()) {
    store = prev;
    setWipedRaw(wasCopy);
    return false;
  }
  flushMirror();
  return true;
}

/* Возврат: копия проходит migrate (как и импорт, инвариант 6 — она
   могла быть снята прежней версией).

   Возврат — такое же замещение, как чистка и импорт, и обратим он тем же
   путём (задача 26, п. 1.1): нынешнее состояние ложится в ТУ ЖЕ копию до
   подмены. Копия становится обменной, «Вернуть» — переключателем между
   двумя состояниями, и наработанное после чистки или импорта не теряется.
   Прежде возврат был единственной необратимой операцией в интерфейсе:
   неделя отметок, набранная после чистки, уходила одним тапом.

   Пустое нынешнее состояние менять не на что — копия просто убирается,
   как и прежде: keepPrev пустой store в копию не кладёт (иначе «Вернуть»
   подменяло бы практику пустотой), а оставить прежнюю копию нельзя — её
   содержимое только что стало живым, и строка врала бы про стёртое. */
function restoreWiped() {
  const c = wipedCopy();
  if (!c) return false;
  let restored;
  // external: копия — данные извне, посев ей не адресован (A.2.1)
  try { restored = migrate(c.store, { external: true }); } catch (e) { return false; }
  const prev = store;
  const wasCopy = wipedRaw();
  if (hasData(prev)) {
    if (!keepPrev(prev, 'restore')) return false; // копию некуда положить — возврат не выполняется
  } else {
    dropWiped();
  }
  store = restored;
  // здесь и жила единственная необратимая операция интерфейса (задача 27,
  // Д5): копия расходовалась ДО записи, а успех записи никто не проверял.
  // Пустое нынешнее состояние + отказ квоты = копия снята, на диске пустой
  // store, практика уничтожена в обоих местах. Откат возвращает и store,
  // и ключ копии — после отказа не изменилось ничего
  if (!save()) {
    store = prev;
    setWipedRaw(wasCopy);
    return false;
  }
  flushMirror();
  return true;
}

/* Восстановление из зеркала (задача 28.A, п. 2.2) — четвёртый повод
   замещения и точно такой же, как три прежних: прежнее состояние ложится
   в ТУ ЖЕ обменную копию ДО подмены, копию некуда положить — восстановление
   не выполняется вовсе, запись отказала — откат целиком. Иначе предложение
   исправить одну потерю данных само стало бы второй.
   migrate уже прогнан при разборе снапшота (mirrorParse). */
function restoreMirror() {
  if (!mirrorOffer) return false;
  const prev = store;
  const wasCopy = wipedRaw();
  if (hasData(prev) && !keepPrev(prev, 'mirror')) return false;
  store = mirrorOffer.store;
  if (!save()) {
    store = prev;
    setWipedRaw(wasCopy);
    return false;
  }
  // рабочая копия и зеркало снова сходятся — предложению нет предмета
  mirrorOffer = null;
  mirrorReady = true;
  scheduleMirror(); // снапшот и рабочий ключ приводятся к одному состоянию
  return true;
}

/* «Оставить рабочую»: предложение снято, зеркало ведётся дальше и на
   ближайшем flush примет рабочее состояние. Снапшот с этого момента
   заменяем — потому и второй тап, и «Скачать» рядом. */
function keepWorking() {
  mirrorOffer = null;
  mirrorReady = true;
  scheduleMirror();
}

/* ── Экспорт / импорт ──────────────────────────────────────── */

/* Отдать текст файлом. Приложение знает только то, что скачивание
   ЗАПУЩЕНО: сохранил ли владелец файл, в вебе узнать нечем (задача 25,
   п. 9) — отсюда осторожность формулировок вокруг exportedAt. */
function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function exportJSON() {
  store.settings.exportedAt = Date.now(); // дата попадает и в сам файл
  save();
  download('minimum-' + todayKey() + '.json', JSON.stringify(store, null, 1));
}

/* Единицы владельца в store — считаются одинаково по сырому файлу и по
   прошедшему migrate. Расхождение и есть то, что не доехало (задача 25,
   п. 3): сводка импорта прежде говорила только про уцелевшее, и потери
   были бесшумны. Считает по-хорошему defensive: сырой файл валидность
   не гарантирует ничем. */
function dataCounts(s) {
  const len = v => (Array.isArray(v) ? v.length : 0);
  const days = (s && s.days && typeof s.days === 'object' && !Array.isArray(s.days)) ? s.days : {};
  let marks = 0;
  for (const k of Object.keys(days)) {
    const d = days[k];
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const id of Object.keys(d)) if (d[id] === true) marks++;
    }
  }
  // Категории пересчитаны по тому, что migrate ДЕЙСТВИТЕЛЬНО роняет
  // (задача 28.B, п. 5.1), а не по тому, что удобно считать. Прежде счёт
  // шёл по семи верхнеуровневым спискам, и файл, у которого миграция
  // выбрасывала три блока, две записи weekLog, две записи истории, два
  // значения сессии и решение по параметру, проходил с ПУСТОЙ строкой
  // потерь: ни одно из этих чисел в счёт не входило (замер разведки 0.5).
  const arr = v => (Array.isArray(v) ? v : []);
  const sum = (list, get) => arr(list).reduce((n, x) => n + (x && typeof x === 'object' ? arr(get(x)).length : 0), 0);
  const params = (s && s.paramDecided && typeof s.paramDecided === 'object' && !Array.isArray(s.paramDecided))
    ? Object.keys(s.paramDecided).length : 0;
  return {
    items: len(s && s.items), days: Object.keys(days).length, marks,
    notes: len(s && s.notes), reviews: len(s && s.reviews),
    exercises: len(s && s.exercises), sessions: len(s && s.sessions),
    groups: len(s && s.groups),
    weekLog: len(s && s.weekLog),
    // история планки и история нагрузки — одна сущность (обе пишет recordBar,
    // инвариант 5), поэтому и категория потерь одна
    history: sum(s && s.items, x => x.history) + sum(s && s.exercises, x => x.history),
    entries: sum(s && s.sessions, x => x.entries),
    params
  };
}

const COUNT_WORDS = [
  ['items', 'пункт', 'пункта', 'пунктов'],
  ['days', 'день', 'дня', 'дней'],
  ['marks', 'отметка', 'отметки', 'отметок'],
  ['notes', 'заметка', 'заметки', 'заметок'],
  ['reviews', 'разбор', 'разбора', 'разборов'],
  ['exercises', 'упражнение', 'упражнения', 'упражнений'],
  ['sessions', 'тренировка', 'тренировки', 'тренировок'],
  ['groups', 'блок', 'блока', 'блоков'],
  ['weekLog', 'запись счётчика', 'записи счётчика', 'записей счётчика'],
  ['history', 'запись истории', 'записи истории', 'записей истории'],
  ['entries', 'значение тренировки', 'значения тренировки', 'значений тренировки'],
  ['params', 'решение по параметру', 'решения по параметру', 'решений по параметру']
];

/* «2 дня, 8 отметок» — перечисление того, чего в файле больше, чем доедет.
   Пустая строка, когда числа сошлись: лишней строки в подтверждении нет. */
function droppedLine(was, got) {
  const parts = [];
  for (const [key, one, few, many] of COUNT_WORDS) {
    const n = was[key] - got[key];
    if (n > 0) parts.push(`${n} ${plural(n, one, few, many)}`);
  }
  return parts.join(', ');
}

function importJSON(file) {
  const r = new FileReader();
  r.onload = () => {
    let data;
    try { data = JSON.parse(r.result); } catch (e) { alert('Файл не читается как JSON.'); return; }
    if (!data || !Array.isArray(data.items) || typeof data.days !== 'object') {
      alert('Файл не похож на экспорт «Минимума».');
      return;
    }
    // «было» — по СЫРОМУ файлу и обязательно ДО migrate: migrate мутирует
    // переданный объект и возвращает его же, после него считать уже нечего
    const was = dataCounts(data);
    const fileVersion = numOr(data.schemaVersion, 0);
    let incoming;
    try {
      incoming = migrate(data, { external: true }); // файл извне — без посева (A.2.1)
    } catch (e) {
      alert('Импорт не выполнен: файл повреждён. Текущие данные не изменены.');
      return;
    }
    // сводка из файла — перед подтверждением (после migrate все ключи days валидны)
    const dayCount = Object.keys(incoming.days).length;
    const range = Object.keys(incoming.days).sort();
    const parts = [
      `пунктов: ${incoming.items.length}`,
      `дней с отметками: ${dayCount}`,
      `закрытых недель: ${incoming.reviews.length}`
    ];
    if (range.length) parts.push(`отметки: ${fmtShort(range[0])} — ${fmtShort(range[range.length - 1])}`);
    let msg = `Заменить текущие данные данными из файла?\n\nВ файле: ${parts.join(', ')}.`;
    // сводка уцелевшего остаётся, к ней добавляется отброшенное: владелец
    // видит и что придёт, и что потеряется (задача 25, п. 3)
    const lost = droppedLine(was, dataCounts(incoming));
    if (lost) msg += `\n\nНе будет прочитано: ${lost}.`;
    // файл новее приложения: шаги миграции для его полей ещё не написаны,
    // и незнакомое отсеется валидацией. Не блокирует — спрашивает (п. 5)
    if (fileVersion > SCHEMA_VERSION) {
      msg += `\n\nФайл снят более новой версией приложения: часть данных может не сохраниться.`;
    }
    if (!confirm(msg)) return;
    // прежние данные ложатся в копию ДО подмены и той же механикой, что при
    // чистке (инвариант 18). Копию некуда положить — импорт не выполняется:
    // необратимых операций в интерфейсе нет, импорт был последней
    const prev = store;
    const wasCopy = wipedRaw();
    if (!keepPrev(prev, 'import')) {
      alert('Импорт не выполнен: копию прежних данных некуда сохранить. Текущие данные не изменены.');
      return;
    }
    store = incoming;
    // тот же откат, что у чистки и возврата (задача 27.1, п. 2.3): копия
    // израсходована ДО записи, и если рабочий ключ не записался, импорт
    // остался бы совершённым наполовину — в памяти новое, на диске старое,
    // а копия уже подменена. Один класс, одно лечение
    if (!save()) {
      store = prev;
      setWipedRaw(wasCopy);
      alert('Импорт не выполнен: данные не удалось записать. Текущие данные не изменены.');
      return;
    }
    // импорт заменил состояние целиком: черновики форм и дневное ui-состояние
    // не переносятся, граница дня могла смениться — таймер и день заново
    ui.editingId = null;
    ui.editNorm = null;
    ui.addOpen = false;
    ui.formDraft = {};
    ui.missOpen = {};
    ui.raiseEdit = {};
    ui.groupRename = null;
    ui.groupAdd = false;
    ui.groupPick = null;
    ui.groupNew = false;
    ui.exEditingId = null;
    ui.exAddOpen = false;
    // Взведённые подтверждения относились к ПРЕЖНИМ данным и после подмены
    // указывают уже на чужие. Опаснее всех «Подтвердить: стереть»: оно
    // переживало импорт, и один тап по нему стирал импортированное, подменяя
    // ТОЛЬКО ЧТО записанную копию прежних данных — та самая обратимость,
    // ради которой копия и заводится, уничтожалась одним касанием (задача 25).
    // Список подтверждений один — в resetConfirms(); дублировать его здесь
    // значит забыть очередное, что и случилось.
    ui.wipeOpen = false;
    resetConfirms();
    ui.renderedDayKey = todayKey();
    armDayTimer();
    const n = store.items.length;
    ui.importNote = `Импортировано: ${n} ${plural(n, 'пункт', 'пункта', 'пунктов')}, ` +
      `${dayCount} ${plural(dayCount, 'день', 'дня', 'дней')}`;
    renderAll();
  };
  r.readAsText(file);
}

/* ── Интерфейс ─────────────────────────────────────────────── */

const ui = {
  tab: 'today',
  editingId: null,
  addOpen: false,
  addType: 'daily',
  addHint: false,
  raiseEdit: {},   // itemId -> true, когда открыт ввод своего значения
  missOpen: {},    // itemId -> true, когда показана подпись «вчера — пропуск»
  justClosed: false,
  addArea: 'min',       // область формы добавления: 'min' | 'habit'
  addPkind: 'time',     // вид параметра в форме добавления; после создания вид не меняется
  editNorm: null,       // черновик нормы недели в открытой форме привычки (null — как у пункта)
  // разовое тихое подтверждение сохранения формы (движение, задача 12).
  // С задачи 26 это не флаг, а якорь: { key, text } — ключ той строки, у
  // которой узел должен родиться, чтобы стоять у пальца, а не в шапке (п. 2.1)
  savedAt: null,
  importNote: null,     // строка «Импортировано: …», исчезает при следующем действии
  renderedDayKey: null, // логический день, для которого отрисован интерфейс (инвариант 8)
  renderedTab: null,    // последний отрисованный вид (вкладка или лист) — скролл сбрасывается только при его смене
  // Черновики форм — по одному ХРАНИЛИЩУ на экран, внутри по ключу формы:
  // { 'edit:i1': { fields, focus } }. Прежде слот держал ровно один черновик,
  // и открытие соседней формы того же экрана его затирало (задача 28.B, п. 4).
  formDraft: {},        // черновик открытой формы: значения, фокус, каретка
  weekCloseConfirm: false, // «Закрыть неделю» — вторым тапом (задача 28.B, п. 6)
  // «Убрать» — тоже вторым тапом (задача 28.E/A). Одна форма на «Настройках»
  // открыта за раз, поэтому и поле одно на пункты и упражнения: в нём ключ
  // взведённой кнопки ('item:<id>' | 'ex:<id>'), а не голый флаг
  removeConfirm: null,
  // Только что убранное: на месте строки стоит «{имя} · убран — Вернуть».
  // Это НЕ .flash: тот гаснет через FLASH_MS, а отмена, исчезающая через
  // секунду, отменой не является (A.3.4). Живёт до следующего действия
  // владельца — как ui.importNote, и снимается там же
  goneNote: null,
  groupRename: null,    // имя блока с раскрытой правкой
  groupDelete: null,    // блок ждёт подтверждения удаления вторым тапом
  groupAdd: false,      // открыто поле «Добавить блок»
  groupPick: null,      // выбор в поле «Блок» открытой формы (null — как у пункта)
  groupNew: false,      // в поле «Блок» выбран «+ Новый блок…»: раскрыто имя
  // свёртка «Показать неделю» в разборе (задача 16C): null — владелец её
  // в этом разборе не трогал, состояние берётся по умолчанию (задача 24)
  weekOpen: null,
  reviewOpen: false,    // разбор открыт поверх вкладки (с таб-бара он ушёл, задача 16B)
  reviewFrom: null,     // вкладка, на которую вернёт «Готово»
  reviewScroll: 0,      // её скролл — возвращается вместе с ней
  trainOpen: false,     // лист «Тренировка» поверх вкладки (задача 16D)
  trainId: null,        // недельный пункт, чей счётчик растёт записью
  trainFrom: null,      // вкладка возврата и её скролл
  trainScroll: 0,
  // черновик листа «Тренировка» — нагрузки и заметка (задача 26, п. 3).
  // Слотов механизма осталось два — этот и «Пунктов»: заметочный ушёл с
  // экраном (задача 28.C), слот листа детали — с самим листом (28.D).
  // Снимается в начале renderTrain, возвращается в конце.
  // Прежде здесь лежала строка ui.trainNote с комментарием «переживает
  // перерисовку» — ввод в неё не попадал вовсе, и обещание было ложным.
  trainDraft: {},
  // кнопка, открывшая лист: закрытие любым путём вернёт ей фокус (п. 4.2)
  sheetSrc: null,       // { act, id } | null
  exEditingId: null,    // упражнение с раскрытой правкой
  exAddOpen: false,     // открыта форма «Добавить упражнение»
  wipeOpen: false,      // раскрыто предупреждение «Начать с чистого листа» (16.1)
  wipeFailed: false,    // чистка не выполнена: копию некуда положить или запись отказала (19, C.6.4)
  restoreFailed: false, // то же у возврата — молчать о нём нельзя (задача 27, Д7)
  wipeConfirm: false,   // «Стереть» ждёт подтверждения вторым тапом
  wipeDropConfirm: false, // «Убрать копию» — тоже вторым тапом
  // «Убрать» нечитаемые данные — вторым тапом (задача 25). Источников два
  // (рабочий ключ и снапшот зеркала), поэтому здесь имя источника, а не флаг
  corruptDropConfirm: null,
  mirrorRestoreConfirm: false, // «Восстановить из копии» — вторым тапом (28.A)
  mirrorKeepConfirm: false,    // «Оставить рабочую» — тоже: снапшот станет заменяемым
  mirrorFailed: false,         // восстановление не выполнено — молчать нельзя
  // свёрнутые секции «Настроек»: по умолчанию раскрыты только «Пункты»
  settingsOpen: { groups: false, items: true, exercises: false, data: false, system: false }
};

let dayTimer = null; // таймер на ближайшую границу дня

/* Инвариант 8: экран мог устареть (смена логического дня в открытом
   приложении). При расхождении — чистка дневного ui-состояния и полная
   перерисовка текущей вкладки; true = действие применять нельзя. */
function syncDay() {
  if (ui.renderedDayKey === null || todayKey() === ui.renderedDayKey) return false;
  ui.missOpen = {};
  ui.raiseEdit = {};
  ui.renderedDayKey = todayKey(); // фиксируем новый день и для не-«Сегодня» вкладок
  renderAll();
  return true;
}

// +1 c запаса: таймеры iOS могут срабатывать на самой границе
const DAY_TIMER_SLACK_MS = timing('DAY_TIMER_SLACK_MS', 1000);

function armDayTimer() {
  clearTimeout(dayTimer);
  dayTimer = setTimeout(() => { syncDay(); armDayTimer(); }, msToNextBoundary() + DAY_TIMER_SLACK_MS);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function valUnit(it) {
  const parts = [];
  if (typeof it.value === 'number' && isFinite(it.value)) parts.push(String(it.value));
  if (it.unit) parts.push(it.unit);
  return parts.join(' ');
}

function el(id) { return document.getElementById(id); }

/* Баннер отказа хранилища — ПОСТОЯННЫЙ узел вне экранов (index.html),
   обновляется точечно из save(). Прежде он жил в разметке «Сегодня» и
   «Привычек», а renderAll рисует одну текущую вкладку — и все отказы,
   случившиеся на «Настройках» и листах (правка пункта,
   экспорт, «Вернуть»), проходили без единого следа на том экране, где
   владелец стоял (задача 27, Д6). Тон прежний: тихая констатация, ни
   красного, ни слова «ошибка».
   Домен без DOM (доменные тесты) выходит сразу — save() зовётся и там. */
function storageNote() {
  if (typeof document === 'undefined') return;
  const p = el('storage-note');
  if (!p) return;
  p.textContent = saveFailed ? 'Хранилище недоступно — отметки сейчас не сохраняются' : '';
  p.hidden = !saveFailed;
}

/* Постоянная область объявлений (index.html): узел role="status",
   рождённый ВМЕСТЕ с текстом, скринридером не объявляется — объявляется
   только изменение текста в уже существующем узле. Так устроен анонс
   планки дня; тем же путём идут отказы формы (задача 27.1, п. 9.2).
   Чистится в начале onClick, чтобы повторный отказ после другого
   действия снова читался как изменение. */
function announce(text) {
  if (typeof document === 'undefined') return;
  const p = el('live');
  if (p) p.textContent = text || '';
}

/* ── Движение (задача 12): короткая функциональная обратная связь ──
   Заполнение круга и ячейки полосы, fade экрана и flash сохранения —
   на CSS (transition/@keyframes). Уходу карточки разбора нужен JS:
   класс-триггер, затем удаление узла перерисовкой. */

const MOTION_MS = timing('MOTION_MS', 240); // потолок движения (12.1); fallback ухода карточки — сверх него
const MOTION_TAIL_MS = timing('MOTION_TAIL_MS', 60); // запас fallback'а сверх самого перехода

function prefersReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { return false; }
}

/* Короткий scale-отклик на тап (класс-триггер .pop с рестартом анимации).
   Только в горячих путях отметки — при первичном рендере класса нет.
   При reduced-motion не навешивается (и CSS animation:none подстрахует). */
function tapPop(node) {
  if (!node || prefersReducedMotion()) return;
  node.classList.remove('pop');
  void node.offsetWidth; // рефлоу — чтобы повторный тап перезапустил анимацию
  node.classList.add('pop');
}

/* Пометить узел уходящим, затем выполнить done() — перерисовку, реально
   убирающую узел. Триггер — transitionend, но он ненадёжен (jsdom его не
   шлёт, reduced-motion отключает переход), поэтому done гарантирован
   fallback-таймаутом и вызывается ровно один раз. При reduced-motion —
   сразу, без ожидания: конечное состояние достижимо мгновенно. */
/* Тихое подтверждение «Сохранено» обычно гаснет ключевыми кадрами. При
   reduced-motion анимация выключена глобальным блоком, и узел остался бы
   невидимым (opacity: 0) — CSS показывает его статично, а убрать его после
   паузы может только JS: конечное состояние должно быть достижимо и здесь
   (задача 19, C.6.3). */
const FLASH_MS = timing('FLASH_MS', 1200);

/* Узел подтверждения — ТОЛЬКО на видимом экране. Выборка по всему
   документу брала первый узел в порядке секций index.html, а renderAll
   рисует одну текущую вкладку: узлы .flash с прежних экранов остаются в
   DOM (CSS лишь возвращает их к opacity:0), и первым находился чужой,
   скрытый. armFlash взводил таймер не на тот узел, keepInPlace считал по
   нулевому rect скрытой секции и прыгал вверх на всю высоту кнопки
   (задача 27, Д4). Экран всегда ровно один — hidden снимает renderAll. */
const visibleFlash = () => document.querySelector('main .screen:not([hidden]) .flash:not(.keep)');

/* Строка «убран — Вернуть» — тем же правилом: только на видимом экране.
   Нужна keepInPlace, который держит точку нажатия на месте (A.3.4). */
const goneNoteEl = () => document.querySelector('main .screen:not([hidden]) .gone-note');

function armFlash() {
  if (!prefersReducedMotion()) return;
  // строку отказа (.flash.keep) не трогаем: она обязана дождаться правки
  const n = visibleFlash();
  if (!n) return;
  setTimeout(() => { if (n.isConnected) n.remove(); }, FLASH_MS);
}

/* ── Тихое подтверждение и тихий отказ (задача 26, п. 2) ───────
   Один и тот же узел .flash и один и тот же тон. Разводит их жизненный
   путь, и он же диктует механику.

   ПОДТВЕРЖДЕНИЕ: форма закрылась, экран перерисован — узел рождается
   разметкой у ЯКОРЯ той строки, которой форма принадлежала. Прежде оно
   печаталось в шапке экрана: у правки упражнения — на 1939 px выше
   нажатой кнопки (замер, 375×812). Ключ отдаётся ровно один раз.

   ОТКАЗ: форма ОСТАЛАСЬ открытой, и перерисовывать её нельзя — она
   вернула бы в поля сохранённые значения, а введённое владельцем
   пропало бы (п. 2.4). Поэтому строка вставляется точечно рядом с
   нажатой кнопкой; тем же путём это делал лист тренировки до задачи 26. */
const flashOk = (key, text) => { ui.savedAt = { key, text: text || 'Сохранено' }; };

/* Подтверждение ПО ФАКТУ ЗАПИСИ. Прежде все вызовы были безусловны, и
   «Сохранено» печаталось даже когда localStorage отказал: в памяти новое,
   на диске прежнее, а приложение утверждает обратное (задача 27, Д6).
   Узел, якорь и тон те же — меняется только текст; постоянный баннер о
   недоступности хранилища ставит save() сам.

   Вызовов ШЕСТЬ: правка и добавление пункта, правка и добавление
   упражнения, переименование и добавление блока. Прежде их было восемь —
   два ушли с формами листа детали (задача 28.D); ещё раньше комментарий
   называл одиннадцать, а их и тогда было восемь. Второй параметр (свой
   текст подтверждения) снят там же: его не передавал ни один вызывающий,
   и okText всегда приходил undefined — «Сохранено» ставил flashOk. */
function flashWrite(key) {
  flashOk(key, lastSaveOk() ? undefined : 'Не сохранено: хранилище недоступно');
}

function flashAt(key) {
  if (!ui.savedAt || ui.savedAt.key !== key) return '';
  const text = ui.savedAt.text;
  ui.savedAt = null; // разовое: отдав узел, якорь гаснет
  return `<p class="flash" role="status">${esc(text)}</p>`;
}

/* Подтверждение обязано появиться ТАМ, ГДЕ ПАЛЕЦ, а форма при сохранении
   закрывается и разметка схлопывается на её высоту. У высокой формы
   (правка параметра — 530 px на 375×812) строка-якорь уезжала выше края
   экрана, и узел рождался за пределами видимого — замер дал −73 px.
   Держим точку нажатия на месте: запоминаем, на какой высоте ЭКРАНА стояла
   кнопка, и после перерисовки подгоняем скролл так, чтобы узел встал туда
   же. Скролл мгновенный — это не движение, а та же бухгалтерия положения,
   что у листов (п. 4.1). */
/* Куда встанет скролл, чтобы узел подтверждения оказался там, где стояла
   кнопка. Чистая функция: до задачи 27.1 арифметика жила внутри
   keepInPlace и проверялась только замером в браузере — мутант «keepInPlace
   снят» выжил бы (п. 9.3). Ниже нуля не уходим: отрицательного скролла нет.
   Смещения нет — null, и трогать скролл незачем. */
function holdScrollTarget(anchorTop, nodeTop, scrollY) {
  const dy = nodeTop - anchorTop;
  if (!dy) return null;
  return Math.max(0, (scrollY || 0) + dy);
}

/* find — чем искать узел, который должен встать на место кнопки. По
   умолчанию это подтверждение .flash; у ухода пункта якорь другой —
   строка «убран» со своим классом (A.3.4), и подменяется он здесь. */
function keepInPlace(btn, render, find) {
  const y = btn ? btn.getBoundingClientRect().top : null;
  render();
  if (y === null) return;
  const n = (find || visibleFlash)();
  if (!n) return;
  const to = holdScrollTarget(y, n.getBoundingClientRect().top, window.scrollY);
  if (to !== null) window.scrollTo(0, to);
}

function refuse(btn, text) {
  if (!btn) return;
  const box = btn.closest('.btns') || btn;
  const prev = box.previousElementSibling;
  // повторный отказ заменяет прежний, а не копится строками
  if (prev && prev.classList && prev.classList.contains('flash')) prev.remove();
  // role="status" со вставленного узла снят намеренно: узел рождается ВМЕСТЕ
  // с текстом, и такой скринридером не объявляется — обещание было ложным.
  // Объявляет постоянная область (задача 27.1, п. 9.2), у неё меняется текст
  box.insertAdjacentHTML('beforebegin', `<p class="flash keep">${esc(text)}</p>`);
  announce(text);
}

function motionLeave(node, done) {
  if (!node || prefersReducedMotion()) { done(); return; }
  // зафиксировать текущую высоту как старт схлопывания (в конце — max-height:0)
  node.style.maxHeight = node.scrollHeight + 'px';
  void node.offsetHeight; // рефлоу, чтобы стартовое значение применилось до перехода
  node.classList.add('leaving');
  node.style.maxHeight = '0px';
  let fired = false;
  // done ровно один раз; если узел уже убран (напр. соседним решением,
  // перерисовавшим весь разбор) — повторная перерисовка не нужна
  const fin = () => { if (fired) return; fired = true; if (node.isConnected) done(); };
  node.addEventListener('transitionend', fin, { once: true });
  setTimeout(fin, MOTION_MS + MOTION_TAIL_MS);
}

/* Четыре вкладки плюс ДВА листа поверх них: разбор недели и тренировка.
   Третьим был лист детали пункта; он существовал ради формулы и лестницы
   и ушёл вместе с ними (задача 28.D). Разбор с таб-бара ушёл (задача 16B) —
   открывается баннером «Сегодня» и строкой «Прогресса», закрывается
   «Готово» на ту вкладку, с которой открыт.

   Приоритет при одновременных флагах пересчитан: главнее разбор. Прежде
   первым стоял лист детали, и разбор был вторым; теперь порядок «разбор,
   затем тренировка» — тот же, что читает currentFormKey. */
function renderAll() {
  const map = {
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    settings: 'scr-settings'
  };
  // исчезнувший недельный пункт (импорт) закрывает лист тренировки
  if (ui.trainOpen && !store.items.some(i => i.id === ui.trainId)) closeTrain();
  const sheet = ui.reviewOpen ? 'review' : (ui.trainOpen ? 'train' : null);
  for (const [tab, id] of Object.entries(map)) el(id).hidden = sheet ? true : tab !== ui.tab;
  el('scr-review').hidden = sheet !== 'review';
  el('scr-train').hidden = sheet !== 'train';
  document.querySelectorAll('#tabs button').forEach(b => {
    // вкладка возврата остаётся текущей и при открытом листе
    if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  // узлы подтверждения и отказа со СКРЫТЫХ экранов снимаются (задача 27.1,
  // п. 4.2): они принадлежали действию на другом экране и своё уже сказали,
  // а оставаясь в DOM, копились там до следующей перерисовки той вкладки.
  // Выборка по видимому экрану их и так не берёт — но держать мусор незачем
  document.querySelectorAll('main .screen[hidden] .flash').forEach(n => n.remove());
  storageNote(); // постоянный узел баннера — вне экранов, состояние сверяется здесь
  if (ui.reviewOpen) renderReview();
  else if (ui.trainOpen) renderTrain();
  else {
    if (ui.tab === 'today') renderToday();
    if (ui.tab === 'habits') renderHabits();
    if (ui.tab === 'progress') renderProgress();
    if (ui.tab === 'settings') renderSettings();
  }
  const view = sheet || ui.tab;
  if (ui.renderedTab !== view) window.scrollTo(0, 0); // скролл — только при фактической смене вида
  ui.renderedTab = view;
}

/* Экран 1 — «Сегодня»: только область min (инвариант 10) */
function renderToday() {
  const t = todayKey();
  ui.renderedDayKey = t;
  const items = liveDaily().filter(i => i.area === 'min');
  const done = items.filter(i => isMarked(t, i.id)).length;
  const total = items.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const closed = total > 0 && done === total;

  // строка дня — ТРЕТЬЕЙ в шапке: над планкой и над списком. Ниже она
  // физически читалась бы как комментарий к сделанному (задача 28.E/B, п. 2.1).
  // Ни кавычек, ни курсива, ни акцента, ни aria-live, ни своей анимации:
  // это тихая справка о дате, а не объявление и не оценка
  let h = `
    <header class="page">
      <p class="overline">${esc(fmtWeekday(t))}</p>
      <h1>${esc(fmtDay(t))}</h1>
      <p class="dline">${esc(dayLine(t))}</p>
    </header>`;

  if (reviewDue()) {
    h += `<button class="banner" data-act="goto-review"><span>Доступен разбор недели</span><span class="chev" aria-hidden="true">&rsaquo;</span></button>`;
  }

  // пустой список — как на «Привычках»: планка дня без пунктов ничего не
  // измеряет, поэтому её нет вовсе (задача 16.1, состояние после чистки)
  if (total) {
    h += `
    <div class="dayline">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="bar-note${closed ? ' ok' : ''}" aria-live="polite">${closed ? 'День закрыт' : `<b>${done}</b>&nbsp;из&nbsp;${total}`}</p>
    </div>`;
    h += `<div class="list">` + groupSections(items, t, false) + `</div>`;
  } else {
    h += `<p class="muted">Пунктов пока нет — добавить можно в Настройках → Пункты.</p>`;
  }

  // area у недельного счётчика не проверяется: migrate принудительно ставит
  // ему min (инвариант 10), другого значения в данных не бывает (C.5.4)
  for (const w of liveWeekly()) {
    const n = trainCount(w.id);
    h += `
      <div class="weekcount">
        <span class="txt">
          <span class="tname">${esc(w.name)}</span>
          ${w.note ? `<span class="note">${esc(w.note)}</span>` : ''}
        </span>
        <span class="wctl">
          <span class="wnum"><b>${n}</b>&thinsp;/&thinsp;${w.goal || 0}</span>
          <button class="btn icon plus" data-act="train-inc" data-id="${esc(w.id)}" aria-label="записать тренировку: «${esc(w.name)}»">+</button>
        </span>
      </div>
      ${n ? `<button class="undo" data-act="train-undo" data-id="${esc(w.id)}" aria-label="отменить последний: «${esc(w.name)}»">отменить последний</button>` : ''}`;
  }

  // Здесь стояла кредо-строка «Минимум выполняется даже в худший день.».
  // Замер на 375×812: она начиналась на 905 px при сгибе (верх таб-бара) на
  // 753 — за сгибом, и без прокрутки её не видел никто. Текст никуда не
  // делся: он первый элемент набора строк дня и теперь бывает в шапке, где
  // его читают. Кредо «Привычек» остаётся: там оно на 468 px, то есть видно
  // всегда, и снимать видимое задача не просила.

  el('scr-today').innerHTML = h;
}

/* Секции дневного экрана: заголовок блока плюс его строки. Блок из двух и
   более активных пунктов заворачивается в .chain и рисует линию; блок из
   одного пункта и пункты без блока — нет (инвариант 13). Крайние половинки
   линии гасит CSS по :first-child/:last-child — считать соседей не нужно. */
function groupSections(items, t, habit) {
  let h = '';
  for (const sec of groupedItems(items)) {
    if (sec.group) h += `<p class="g-label">${esc(sec.group.name)}</p>`;
    const chained = !!sec.group && sec.items.length > 1;
    if (chained) h += `<div class="chain">`;
    for (const it of sec.items) h += dailyRow(it, t, habit, chained);
    if (chained) h += `</div>`;
  }
  return h;
}

/* Строка ежедневного пункта: чекбокс, точка-маркер, ретро-отметка —
   общая для «Сегодня» (area min) и «Привычек» (habit: true добавляет
   серию у названия и полосу текущей недели под строкой).
   Название внутри label: тап по всей строке переключает отметку.

   Подписью идёт СЛОВО ВЛАДЕЛЬЦА — item.note. Прежде у пункта с лестницей
   его вытесняла текущая ступень (а у вставшей привычки — строка о том, что
   работа здесь закончена); лестница снята задачей 28.D, и подпись вернулась
   к единственному источнику. Хвостовой кнопки в строке тоже больше нет: она
   вела в лист детали и существовала только у пунктов с лестницей или
   формулой — теперь строка одинакова у всех.

   Имя чекбоксу даёт содержимое label — aria-label его только затёр бы.
   Подпись «вчера — пропуск» стоит в разметке всегда, когда есть точка,
   и прячется атрибутом hidden: aria-controls обязан указывать на
   существующий узел, иначе disclosure для AT неполон (задача 26, п. 8.1). */
function dailyRow(it, t, habit, chain) {
  const on = isMarked(t, it.id);
  const miss = missedYesterday(it, t);
  const vu = valUnit(it);
  const streak = habit ? habitStreak(it) : 0; // при нуле справка скрыта
  const sub = it.note;
  // половинки линии блока: верхняя идёт к предыдущему пункту, нижняя — к
  // следующему; у крайних строк лишнюю гасит CSS. Идут первыми в разметке —
  // круг отметки закрывает линию собой.
  const segs = chain
    ? `<span class="cseg up" aria-hidden="true"></span><span class="cseg down" aria-hidden="true"></span>`
    : '';
  return `
      <div class="rowwrap${habit ? ' hrow' : ''}">
        ${segs}
        <label class="row check${on ? ' on' : ''}">
          <input type="checkbox" data-act="mark" data-id="${esc(it.id)}"${on ? ' checked' : ''}>
          <span class="box" aria-hidden="true"></span>
          <span class="txt">
            <span class="tname">${esc(it.name)}${vu ? ` <span class="val">${esc(vu)}</span>` : ''}${streak ? ` <span class="streak">серия ${streak} нед</span>` : ''}</span>
            ${sub ? `<span class="note">${esc(sub)}</span>` : ''}
          </span>
        </label>
        ${miss ? `<button type="button" class="dot" data-act="miss-note" data-id="${esc(it.id)}" aria-expanded="${ui.missOpen[it.id] ? 'true' : 'false'}" aria-controls="miss-${esc(it.id)}" aria-label="вчера — пропуск"><i></i></button>` : ''}
        ${miss ? `<p class="miss-note" id="miss-${esc(it.id)}"${ui.missOpen[it.id] ? '' : ' hidden'}>вчера — пропуск<button type="button" class="undo" data-act="mark-yesterday" data-id="${esc(it.id)}" aria-label="отметить вчера: «${esc(it.name)}»">отметить</button></p>` : ''}
        ${habit ? habitWeekRow(it, t) : ''}
      </div>`;
}

/* Полоса текущей недели привычки: визуальный язык сетки разбора (подписи
   дней, кружки), пассивна — тапов не принимает; рядом «X из N». Сама
   полоса скрыта от AT — счёт недели даёт видимый текст «X из N». */
function habitWeekRow(it, t) {
  const mon = weekStartOf(t);
  const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  let cells = '';
  for (let i = 0; i < 7; i++) {
    const k = addDays(mon, i);
    const today = k === t;
    cells += `<span class="hday${today ? ' today' : ''}"><span class="hd">${names[i]}</span>` +
      `<i class="c${isMarked(k, it.id) ? ' on' : ''}${today ? ' today' : ''}${k > t ? ' fut' : ''}"></i></span>`;
  }
  return `
        <div class="hweek">
          <span class="hstrip" aria-hidden="true">${cells}</span>
          <span class="hcount">${habitWeekCount(it, mon)} из ${it.normPerWeek || 7}</span>
        </div>`;
}

/* Экран 2 — «Привычки»: только сегодняшний день программы роста */
function renderHabits() {
  const t = todayKey();
  ui.renderedDayKey = t;
  const habits = liveDaily().filter(i => i.area === 'habit');
  const done = habits.filter(i => isMarked(t, i.id)).length;
  const total = habits.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const allDone = total > 0 && done === total;

  let h = `
    <header class="page">
      <p class="overline">Программа роста</p>
      <h1>Привычки</h1>
    </header>`;

  if (total) {
    h += `
    <div class="dayline">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="bar-note${allDone ? ' ok' : ''}" aria-live="polite">${allDone ? 'Все отмечены' : `сегодня <b>${done}</b>&nbsp;из&nbsp;${total}`}</p>
    </div>
    <div class="list">` + groupSections(habits, t, true) + `</div>`;
  } else {
    h += `<p class="muted">Привычек пока нет — добавить можно в Настройках → Пункты.</p>`;
  }

  const params = store.items.filter(i => i.type === 'param' && live(i));
  if (params.length) {
    h += `<p class="g-label">Порог недели</p>`;
    for (const p of params) {
      h += `<p class="line muted">${esc(p.name)} · ${esc(fmtParam(p))}</p>`;
    }
  }

  h += `<p class="creed">Не спеши — доверься накопительному эффекту.</p>`;

  el('scr-habits').innerHTML = h;
}

/* ── Экран 3 — «Прогресс» (инвариант 14) ───────────────────────
   Единственное место, где приложение показывает прошлое: экран
   открывают намеренно, дневные экраны остаются без истории. */

const RISE_W = 100, RISE_H = 44, RISE_PAD = 2; // система координат ступеньки

/* Ступенчатый путь: ось X — даты от первой записи до сегодня, ось Y —
   значения. Последнее значение держится до правого края, поэтому
   сегментов ровно 2N−1: N−1 горизонталей, N−1 вертикалей и финальная
   горизонталь. Ни осей, ни сетки, ни точек — только линия. */
function risePath(points) {
  const r = n => Math.round(n * 100) / 100;
  const first = points[0].date;
  const last = points[points.length - 1].date;
  const t = todayKey();
  const end = last > t ? last : t;
  const span = diffDays(end, first);
  // все записи одним днём (стартовая запись лестницы и шаг того же дня) —
  // раскладываем по индексу: дат для пропорции не хватает
  const x = (p, i) => span > 0
    ? r(RISE_W * diffDays(p.date, first) / span)
    : r(points.length > 1 ? RISE_W * i / (points.length - 1) : 0);
  const vals = points.map(p => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const y = v => hi === lo
    ? RISE_H / 2 // ряд без размаха — ровная линия посередине
    : r(RISE_H - RISE_PAD - (v - lo) / (hi - lo) * (RISE_H - RISE_PAD * 2));
  let d = `M${x(points[0], 0)} ${y(vals[0])}`;
  for (let i = 1; i < points.length; i++) d += `H${x(points[i], i)}V${y(vals[i])}`;
  return d + `H${RISE_W}`;
}

/* Значение ряда словами владельца: у параметра — через fmtParam
   (time читается как 23:30), у остальных — числом */
function riseValue(it, v) {
  return it.type === 'param' ? fmtParam(it, v) : String(v);
}

/* Минуты суток цикличны: 00:00 и 23:45 — соседи, между ними 15 минут, а не
   1425. На линейной шкале «Подъёма» переход через полночь уходил на всю
   высоту холста, и все настоящие шаги по 15 минут становились неразличимы
   навсегда — а у посевного «Отбоя» (pvalue 0, pstep −15) ровно такой шаг
   первый же (задача 27, п. 8). Разворачиваем ряд по КРАТЧАЙШЕЙ дуге: из
   эквивалентных представлений (±1440) берётся ближайшее к предыдущему.
   Выбрана она, а не сглаживание и не отказ рисовать: движение порога и
   есть предмет визуала, а по кратчайшей дуге оно читается тем, чем
   является, — пятнадцатью минутами. Механика pvalue и pstep не тронута
   (п. 8.3), подпись «00:00 → 23:45» печатается по сырым значениям. */
const DAY_MIN = 1440;

function unwrapDayMinutes(points) {
  const out = [];
  let prev = null;
  for (const p of points) {
    let v = p.value;
    if (prev !== null) {
      while (v - prev > DAY_MIN / 2) v -= DAY_MIN;
      while (prev - v > DAY_MIN / 2) v += DAY_MIN;
    }
    out.push({ date: p.date, value: v });
    prev = v;
  }
  return out;
}

function riseBlocks() {
  let h = '';
  // упражнения идут после пунктов и по тем же правилам: у них та же
  // история нагрузки, что и планка у пункта (задача 16D)
  for (const it of store.items.concat(store.exercises)) {
    const s = riseSeries(it);
    if (!s) continue;
    const a = s.points[0].value, b = s.points[s.points.length - 1].value;
    // подпись одна: ряд теперь тоже один — история планки или нагрузки.
    // Ветка «Ступень a → b» ушла с лестницей (задача 28.D)
    const label = `${riseValue(it, a)} → ${riseValue(it, b)}${it.type !== 'param' && it.unit ? ' ' + it.unit : ''}`;
    // геометрия у порога-времени своя (кратчайшая дуга), подпись — по сырым
    const geo = (it.type === 'param' && it.pkind === 'time') ? unwrapDayMinutes(s.points) : s.points;
    h += `
      <div class="rise-b">
        <p class="rise-h"><span class="rise-n">${esc(it.name)}</span><span class="rise-v">${esc(label)}</span></p>
        <svg class="rise" viewBox="0 0 ${RISE_W} ${RISE_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="${risePath(geo)}"/></svg>
      </div>`;
  }
  return h;
}

/* Цепь дней: 8 календарных недель, строка — неделя, ячейка — день.
   Три состояния (задача 17): доля ≥ порога — заливка --accent, доля
   между нулём и порогом — контур --accent, ноль — пустая ячейка.
   --chain здесь не участвует: тёплый тон закреплён за связкой блока,
   сетка дней — про выполнение. Будущие дни текущей недели и дни до
   начала эпохи не рисуются. */
function chainGrid() {
  const t = todayKey();
  const since = store.settings.calendarSince;
  const weeks = chainWeeks(8);
  const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  let cells = '';
  let drawn = 0; // ячеек с отметками: пустая цепь показывает свою строку
  let shown = 0; // видимых ячеек вообще: ни одной — сетки нет (задача 22, п. 3.2)
  const sr = [];
  for (const mon of weeks) {
    let hit = 0;
    let vis = 0;
    for (let i = 0; i < 7; i++) {
      const k = addDays(mon, i);
      if (k > t) { cells += `<i class="cd fut"></i>`; continue; }
      if (isDayKey(since) && k < since) { cells += `<i class="cd pre"></i>`; continue; }
      const s = dayScore(k);
      const full = s !== null && s >= dayThreshold() - EPS;
      if (full) hit++;
      if (s) drawn++;
      vis++;
      cells += `<i class="cd${full ? ' full' : (s ? ' part' : '')}"></i>`;
    }
    shown += vis;
    // неделя целиком до начала отсчёта не существует — скринридер не должен
    // слышать про неё «зачтено 0 из 7» (задача 22, п. 3.4)
    if (vis) sr.push(`Неделя с ${fmtShort(mon)}: зачтено ${hit} из 7`);
  }
  // все восемь недель до начала отсчёта (эпоха ещё не наступила или только
  // что задана вперёд) — рисовать нечего: одна строка вместо пустой сетки
  if (!shown) return `<p class="muted">Цепь начнётся с первого дня отсчёта.</p>`;
  return `<p class="sr-only">${esc(sr.join('. '))}</p>` +
    `<div class="cdays" aria-hidden="true">` +
    names.map(d => `<span class="cd-head">${d}</span>`).join('') + cells + `</div>` +
    // своя строка, не «Отметок» (задача 23, п. 9.1): обе карточки «Прогресса»
    // говорили одно слово в слово, и пустой экран читался как повтор
    (drawn ? '' : `<p class="muted">Цепь заполнится с первой отметки.</p>`);
}

/* Блок «Прогресса» — карточка на --surface: заголовок и содержимое */
function pcard(title, body) {
  return `<section class="pcard"><h2>${title}</h2>${body}</section>`;
}

/* Полоса сегодняшнего дня под числом серии: заполнение — доля дня.
   Форма общая с планкой дня «Сегодня» и «Привычек» — та же высота,
   радиус и тот же единственный в приложении градиент (задача 26, п. 5.1). */
function dayBar() {
  const t = todayKey();
  const m = minDayMarks(t);
  if (!m.total) return ''; // нечего измерять — полосы нет, как и на «Сегодня»
  const pct = Math.round(m.done / m.total * 100);
  const closed = m.done === m.total;
  return `
    <div class="dbar" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <p class="muted dbar-note">${closed ? 'День закрыт' : `${m.done} из ${m.total} сегодня`}</p>`;
}

function renderProgress() {
  const t = todayKey();
  ui.renderedDayKey = t;
  const since = store.settings.calendarSince;
  const days = daysInSystem();
  const streak = dayStreak();
  const best = bestStreak();

  let h = `
    <header class="page">
      <p class="overline">Накопленное</p>
      <h1>Прогресс</h1>
    </header>`;

  // 1. В системе — счёт, который не прерывается никогда
  h += pcard('В системе',
    `<p class="stat">${days} ${plural(days, 'день', 'дня', 'дней')}</p>` +
    (isDayKey(since)
      ? `<p class="muted">${days ? 'с ' + esc(fmtDay(since)) : `Отсчёт идёт с ${esc(fmtDay(since))}.`}</p>`
      : ''));

  // 2. Серия — число, рекорд справа, полоса сегодняшнего дня под ним
  h += pcard('Серия',
    `<p class="statrow">
      <span class="stat">${streak} ${plural(streak, 'день', 'дня', 'дней')}</span>
      ${best ? `<span class="muted rec">рекорд ${best} ${plural(best, 'день', 'дня', 'дней')}</span>` : ''}
    </p>` + dayBar() +
    (streak || best
      // правда о правиле, а не приблизительная (задача 19, C.7.1): прощается
      // пропуск, если предыдущий прощённый был БОЛЬШЕ недели назад; ровно
      // через неделю — уже обрыв. «Раз в неделю» звучало мягче, чем работает.
      ? `<p class="muted">Пропуск прощается, если прошлый был больше недели назад. Иначе счёт начинается заново.</p>`
      : `<p class="muted">Серия начнётся с первого зачтённого дня.</p>`));

  h += pcard('Цепь дней', chainGrid());

  const rise = riseBlocks();
  h += pcard('Подъём', rise || `<p class="muted">Появится, когда планка изменится во второй раз.</p>`);

  const inOrder = area => groupedItems(liveDaily().filter(i => i.area === area))
    .reduce((acc, sec) => acc.concat(sec.items), []);
  const listed = inOrder('min').concat(inOrder('habit'));
  // ряд нулей — не картина, а её отсутствие (задача 22, п. 3.1): пока ни у
  // одного пункта нет ни одной отметки в окне, блок показывает одну строку,
  // как того и требует инвариант 14 от пустого блока
  let marks = '';
  if (listed.some(it => marksInSystem(it) > 0)) {
    for (const it of listed) {
      marks += `<p class="line muted">${esc(it.name)} · ${marksInSystem(it)} из ${marksWindow(it)}</p>`;
    }
  }
  h += pcard('Отметки', marks ||
    `<p class="muted">${listed.length ? 'Первые отметки появятся здесь.' : 'Пунктов пока нет.'}</p>`);

  h += reviewDue()
    ? `<button class="banner rev" data-act="goto-review"><span>Разбор недели</span><span class="chev" aria-hidden="true">&rsaquo;</span></button>`
    : `<p class="muted rev">Следующий разбор — в понедельник</p>`;

  // Ниже строки разбора не стоит ничего: выписка дня ушла с экраном
  // «Заметки» (задача 28.C), и на её место не встало ничего.
  el('scr-progress').innerHTML = h;
}

/* ── Лист «Тренировка» (задача 16D) ────────────────────────────
   Открывается кнопкой «+» недельного счётчика вместо немедленного
   инкремента: сначала записывается, что сделано, потом растёт счёт.
   «Отмена» не пишет ничего. */
function renderTrain() {
  snapshotOpenForm(); // черновик листа — тот же механизм, что у форм (задача 26, п. 3)
  const w = store.items.find(i => i.id === ui.trainId);
  // имя недельного пункта — заголовок, надстрочник — день записи: прежде
  // оба говорили «Тренировка» (задача 22, п. 7.3)
  let h = `
    <header class="page">
      <p class="overline">${esc(fmtDay(todayKey()))}</p>
      <h1 tabindex="-1">${esc(w ? w.name : 'Тренировка')}</h1>
    </header>`;

  // Поля листа — те же черновиковые поля, что в формах: обёртка несёт
  // data-form, и snapshotOpenForm находит их по общему правилу.
  h += `<div data-form="train" data-id="${esc(ui.trainId || '')}">`;
  const list = liveExercises();
  if (!list.length) {
    h += `<p class="muted">Упражнений пока нет — добавить можно в Настройках → Упражнения.</p>`;
  }
  for (const ex of list) {
    const v = (typeof ex.value === 'number' && isFinite(ex.value)) ? String(ex.value) : '';
    h += `
      <div class="exline">
        <span class="txt">
          <span class="tname">${esc(ex.name)}</span>
          ${ex.unit ? `<span class="note">${esc(ex.unit)}</span>` : ''}
        </span>
        <span class="exctl">
          <button class="btn icon quiet" data-act="ex-step" data-id="${esc(ex.id)}" data-dir="down" aria-label="меньше: «${esc(ex.name)}»">&minus;</button>
          <input class="num" id="ex-${esc(ex.id)}" type="text" inputmode="decimal" value="${esc(v)}" aria-label="${esc(ex.name)}">
          <button class="btn icon quiet" data-act="ex-step" data-id="${esc(ex.id)}" data-dir="up" aria-label="больше: «${esc(ex.name)}»">+</button>
        </span>
      </div>`;
  }

  h += `
    <label class="field">
      <span>Заметка</span>
      <input type="text" id="tr-note" value="" placeholder="необязательно">
    </label>
    </div>
    <button class="btn primary wide" data-act="train-save">Записать</button>
    <button class="btn wide" data-act="train-cancel">Отмена</button>`;

  el('scr-train').innerHTML = h;
  restoreOpenForm();
}

/* ── Точечные обновления «Сегодня» и «Привычек» (горячие пути) ──
   Существующие узлы не пересоздаются — CSS-переходы чекбокса и
   планки дня реально проигрываются. Структурные изменения идут
   через полную перерисовку экрана. */

/* Здесь стояла updateThresholdNote — точечное обновление подписи зачёта
   дня. Её единственным вызывающим был тумблер пункта, который менял число
   применимых пунктов, не перерисовывая экран. Тумблер упразднён (задача
   28.E/A, п. 2), а «Убрать» всегда идёт полной перерисовкой «Настроек»:
   подпись пересчитывает сам renderSettings. Узел #thr-note остаётся —
   его печатает разметка секции. */

function updateDayline() {
  const t = todayKey();
  const items = liveDaily().filter(i => i.area === 'min');
  const done = items.filter(i => isMarked(t, i.id)).length;
  const total = items.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const closed = total > 0 && done === total;
  const bar = document.querySelector('#scr-today .bar i');
  if (bar) bar.style.width = pct + '%';
  const note = document.querySelector('#scr-today .bar-note');
  if (note) {
    note.classList.toggle('ok', closed);
    note.innerHTML = closed ? 'День закрыт' : `<b>${done}</b>&nbsp;из&nbsp;${total}`;
  }
}

function updateHabitsDayline() {
  const t = todayKey();
  const habits = liveDaily().filter(i => i.area === 'habit');
  const done = habits.filter(i => isMarked(t, i.id)).length;
  const total = habits.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const allDone = total > 0 && done === total;
  const bar = document.querySelector('#scr-habits .bar i');
  if (bar) bar.style.width = pct + '%';
  const note = document.querySelector('#scr-habits .bar-note');
  if (note) {
    note.classList.toggle('ok', allDone);
    note.innerHTML = allDone ? 'Все отмечены' : `сегодня <b>${done}</b>&nbsp;из&nbsp;${total}`;
  }
}

/* Точечное обновление полосы недели привычки: сегодняшняя ячейка и «X из N».
   Серия не пересчитывается — текущая неделя в неё не входит (инвариант 11). */
function updateHabitWeekRow(input) {
  const wrap = input.closest('.rowwrap');
  if (!wrap) return;
  const t = todayKey();
  const cell = wrap.querySelector('.hstrip i.today');
  if (cell) { cell.classList.toggle('on', isMarked(t, input.dataset.id)); tapPop(cell); } // scale-отклик ячейки (12.1)
  const hc = wrap.querySelector('.hcount');
  const it = store.items.find(x => x.id === input.dataset.id);
  if (hc && it) hc.textContent = `${habitWeekCount(it, weekStartOf(t))} из ${it.normPerWeek || 7}`;
}

/* Точечная отметка: обновляется планка того экрана, где стоит чекбокс.
   Линия блока постоянна и от отметок не зависит — пересчитывать нечего. */
function updateTodayMark(input) {
  const on = isMarked(todayKey(), input.dataset.id);
  input.checked = on;
  const label = input.closest('label.check');
  if (label) { label.classList.toggle('on', on); tapPop(label.querySelector('.box')); } // scale-отклик круга (12.1)
  const scr = input.closest('section.screen');
  if (scr && scr.id === 'scr-habits') { updateHabitsDayline(); updateHabitWeekRow(input); }
  else updateDayline();
}

/* Дневные экраны: перерисовка и контейнер по активной вкладке */
function renderDayScreen() {
  if (ui.tab === 'habits') renderHabits();
  else renderToday();
}

function dayScreenEl() {
  return el(ui.tab === 'habits' ? 'scr-habits' : 'scr-today');
}

function updateWeekCount(id) {
  const scr = el('scr-today');
  const plus = [...scr.querySelectorAll('[data-act="train-inc"]')].find(x => x.dataset.id === id);
  if (!plus) { renderToday(); return; }
  const n = trainCount(id);
  const wc = plus.closest('.weekcount');
  const num = wc.querySelector('.wnum b');
  if (num) num.textContent = n;
  // Ветка СОЗДАНИЯ кнопки «отменить последний» снята как недостижимая
  // (задача 28.B, п. 2). Единственный вызывающий — обработчик 'train-undo',
  // то есть сама эта кнопка: чтобы её нажать, она обязана существовать,
  // значит hasUndo при входе всегда true, а счёт после undoTrain только
  // убывает. Доказано не рассуждением: ветка была заминирована throw'ом
  // в изолированной копии и не выстрелила ни разу на 452 тестах, тогда как
  // ветка удаления на том же прогоне выстрелила сразу.
  // hasUndo остаётся: он проверяет, что снимается ИМЕННО кнопка этого
  // пункта, а не случайный сосед, — это валидация узла, а не мёртвый код.
  const next = wc.nextElementSibling;
  const hasUndo = !!(next && next.classList.contains('undo') && next.dataset.id === id);
  if (!n && hasUndo) next.remove();
}

/* Лист «Разбор недели»: открывается баннером «Сегодня» и строкой
   «Прогресса», возвращает на прежнюю вкладку (задача 16B) */
const REVIEW_DONE = `<button class="btn wide" data-act="review-done">Готово</button>`;

/* Есть ли в разборе хоть одно ДЕЙСТВЕННОЕ решение: карточка повышения,
   понижения или нерешённый параметр. Все три — одна и та же планка.

   Лестничная часть условия (доступный шаг и предложение закрыть вставшую
   привычку) снята вместе с механикой (задача 28.D); с ней ушёл и единственный
   повод читать ui — флаг «Остаться». Функция снова чистая: считает по days{},
   items[] и календарю.

   Нужна свёртке недели (задача 24, п. 9.2): когда решений нет, картина
   недели остаётся единственным содержательным на экране, и прятать её
   не за чем. Когда есть — свёртка закрыта: решения важнее таблиц. */
function reviewActionable() {
  if (!reviewDue()) return false;
  if (raiseOffer()) return true;
  const keys = windowKeys();
  const inWeek = it => live(it) || keys.some(k => isMarked(k, it.id));
  if (store.items.some(it => it.type === 'daily' && it.area === 'min' && inWeek(it) && lowerEligible(it))) return true;
  return pendingParams().length > 0;
}

/* Свёртка недели: ui.weekOpen === null — владелец её в этом разборе не
   трогал, тогда действует состояние по умолчанию. Тап пишет явное
   true/false, закрытие разбора возвращает null (задача 24, п. 9.1):
   чужая память о прошлом разборе следующему не принадлежит. */
const weekFoldOpen = () => {
  // умолчание снимается ОДИН РАЗ — при первом рендере разбора, а не при
  // каждом (задача 27.1, п. 10.3). Прежде reviewActionable() пересчитывался
  // на каждой перерисовке, и последнее принятое решение само раскрывало
  // картину недели под пальцем: тап по тихой второстепенной кнопке
  // выкатывал сетки и счётчики. Снимок делает умолчание умолчанием, а не
  // реакцией; тап владельца по свёртке перезаписывает его обычным путём
  if (ui.weekOpen === null) ui.weekOpen = !reviewActionable();
  return ui.weekOpen;
};

function renderReview() {
  let h = `<header class="page"><p class="overline">Раз в неделю</p><h1 tabindex="-1">Разбор недели</h1></header>`;

  if (!reviewDue()) {
    if (ui.justClosed) h += `<p class="lead" role="status">Неделя закрыта.</p>`;
    const cur = currentWeekStart();
    if (!cur) {
      // Эпоха ещё не наступила: переходные дни скользящей эпохи — и чистый
      // лист (задача 16.1: чистка ставит calendarSince в ближайший
      // понедельник, то есть в будущее во все дни, кроме понедельника).
      // fmtDay (полный месяц) — дата умещается целиком, без «сент..» (отделка, задача 13)
      h += `<p class="muted">Разбор откроется в понедельник, ${esc(fmtDay(addDays(store.settings.calendarSince, 7)))}.</p>`;
    } else {
      h += `<p class="muted">Идёт ${diffDays(todayKey(), cur) + 1}-й день недели. Разбор откроется в понедельник, ${esc(fmtDay(addDays(cur, 7)))}.</p>`;
    }
    const ocWait = currentOneChange();
    if (ocWait) h += `<p class="muted">Изменение этой недели: „${esc(ocWait)}“</p>`;
    h += REVIEW_DONE;
    el('scr-review').innerHTML = h;
    ui.justClosed = false; // «Неделя закрыта.» показывается ровно один раз
    return;
  }

  const keys = windowKeys();
  const inWeek = it => live(it) || keys.some(k => isMarked(k, it.id));
  const minItems = store.items.filter(it => it.type === 'daily' && it.area === 'min' && inWeek(it));
  const habitItems = store.items.filter(it => it.type === 'daily' && it.area === 'habit' && inWeek(it));

  h += `<p class="muted">Неделя ${esc(fmtShort(keys[0]))} — ${esc(fmtShort(keys[6]))}</p>`;
  // одна строка итога вместо чтения сетки: закрытых дней минимума за неделю
  h += `<p class="lead">Минимум закрыт ${keys.filter(k => minDayClosed(k)).length} из 7 дней</p>`;

  // Сетка 7 дней × пункты: кружки и числа скрыты от AT (aria-hidden-обёртки
  // с display:contents), итог строки — визуально скрытым счётчиком в имени
  const weekGrid = (items) => {
    let g = `<div class="grid" style="--cols:${keys.length}">`;
    g += `<span class="g-vis" aria-hidden="true"><span class="g-head"></span>` +
      ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(d => `<span class="g-head">${d}</span>`).join('') + `</span>`;
    for (const it of items) {
      const n = keys.filter(k => isMarked(k, it.id)).length;
      g += `<span class="g-name">${esc(it.name)}<span class="sr-only">, отмечено ${n} из 7</span></span>`;
      g += `<span class="g-vis" aria-hidden="true">` +
        keys.map(k => `<i class="c${isMarked(k, it.id) ? ' on' : ''}"></i>`).join('') + `</span>`;
    }
    return g + `</div>`;
  };

  // Консистентность за 3 последние ЗАВЕРШЁННЫЕ календарные недели.
  // Заголовок «Три закрытые недели» стоял над тремя последними РАЗБОРАМИ,
  // которые после пропусков относились к несмежным и не последним неделям
  // (аудит, находка 13). Теперь счёт по days{} — заголовок стал правдой.
  const consist = (items) => {
    const W = closedWeeks(3);
    if (!W.length) return `<p class="muted">Закрытых недель пока нет.</p>`;
    let c = `<div class="consist">`;
    for (const it of items) {
      const counts = W.map(w => itemWeekCount(it, w));
      c += `<span class="c-name">${esc(it.name)}</span><span class="c-val">${counts.map(x => esc(x)).join(' · ')} из 7</span>`;
    }
    return c + `</div>`;
  };

  // ── Решение 1: планка. Повышение, понижение и порог параметра — одна
  // и та же механика: recordBar, история пункта, одно решение за разбор
  // (инварианты 5 и 10). Поэтому карточка параметра стоит здесь, а не
  // под свёрткой с read-only сетками (задача 24, п. 2). Порядок внутри
  // решения — вверх, вниз, параметры. Предложений нет — одна строка.
  h += `<h2>Решение 1 · Планка</h2>`;
  let bar = '';
  const offer = raiseOffer(); // одно предложение повышения за разбор (п. 6)
  if (offer) {
    const it = offer;
    const sug = raiseSuggest(it.value);
    const editing = ui.raiseEdit[it.id];
    bar += `
      <div class="card raise" data-raise="${esc(it.id)}">
        <p>${esc(it.name)}: три недели подряд не меньше 6 из 7.</p>
        <p class="raise-line">Повысить ${esc(String(it.value))} →
          ${editing
            ? `<input class="num" id="raise-${esc(it.id)}" type="text" inputmode="decimal" value="${esc(String(sug))}" aria-label="новая планка: «${esc(it.name)}»${it.unit ? ', ' + esc(it.unit) : ''}">`
            : `<b>${esc(String(sug))}</b>`}
          ${it.unit ? esc(it.unit) : ''}?</p>
        <p class="muted">Только если стало легко</p>
        <div class="btns">
          <button class="btn" data-act="raise-ok" data-id="${esc(it.id)}">Принять</button>
          ${editing ? '' : `<button class="btn quiet" data-act="raise-edit" data-id="${esc(it.id)}">Изменить</button>`}
          <button class="btn quiet" data-act="raise-later" data-id="${esc(it.id)}">Не сейчас</button>
        </div>
      </div>`;
  }
  // остальным готовым — тихая строка без имён и без счётчика-акцента:
  // владелец знает, что предложение не потеряно, и не выбирает из четырёх
  const restReady = raiseReady().length - (offer ? 1 : 0);
  if (restReady > 0) {
    bar += `<p class="muted">Ещё ${restReady} ${plural(restReady, 'пункт готов', 'пункта готовы', 'пунктов готовы')} к повышению — предложение вернётся на следующей неделе</p>`;
  }
  const lowW = closedWeeks(2);
  for (const it of minItems) {
    if (!lowerEligible(it)) continue;
    const to = lowerSuggest(it.value);
    const counts = lowW.map(w => itemWeekCount(it, w)).join(' и ');
    bar += `
      <div class="card lower" data-lower="${esc(it.id)}">
        <p>Сделать легче</p>
        <p class="muted">${esc(it.name)} — ${counts} из 7 за две недели</p>
        <div class="btns">
          ${to === null ? '' : `<button class="btn" data-act="lower-ok" data-id="${esc(it.id)}">Сделать легче ${esc(String(it.value))} → ${esc(String(to))}${it.unit ? ' ' + esc(it.unit) : ''}</button>`}
          <button class="btn quiet" data-act="lower-keep" data-id="${esc(it.id)}">Оставить</button>
        </div>
      </div>`;
  }
  // порог параметра — решение того же рода; одно на параметр за разбор
  for (const p of pendingParams()) {
    bar += `
      <div class="card param">
        <p>«${esc(p.name)} · ${esc(fmtParam(p))}» — как прошла неделя?</p>
        <div class="btns">
          <button class="btn" data-act="param-step" data-id="${esc(p.id)}">Шаг: → ${esc(fmtParam(p, paramStepTarget(p)))}</button>
          <button class="btn quiet" data-act="param-keep" data-id="${esc(p.id)}">Оставить</button>
        </div>
      </div>`;
  }
  h += bar || `<p class="muted">Планка держится, менять нечего</p>`;

  // ── Решение 2: одно изменение на следующую неделю.
  // Прежде вторым решением стояла «Ступень» — шаг лестницы; она снята
  // задачей 28.D, и решений осталось ДВА. Номер сдвинут, а не оставлен
  // пустым: дыры в нумерации не бывает (задача 24, п. 4) — «1, 3»
  // читалось владельцем как потеря.
  // Placeholder с примером — подсказка в ФОРМЕ, а не в списке пунктов
  // (анти-требование задачи 14 разрешает подсказки формам). В первых двух
  // разборах это единственное живое поле, и «необязательно» не объясняло,
  // чего от владельца ждут. Пример операционный и мелкий: не лозунг.
  h += `<h2>Решение 2 · Одно изменение</h2>`;
  const oc = currentOneChange();
  if (oc) h += `<p class="muted">Изменение этой недели: „${esc(oc)}“</p>`;
  h += `
    <label class="field">
      <span>Одно изменение на следующую неделю</span>
      <input type="text" data-bind="one-change" value="${esc(store.draftOneChange)}" placeholder="например: перенести зарядку на утро">
    </label>`;

  // ── Неделя целиком: сетки, счётчики и готовность — под свёрткой.
  // Здесь остаётся только read-only (задача 24, п. 2.3): решения уехали
  // в видимую часть, а картина недели — справка, а не действие.
  let wk = `<h2>Минимум</h2>`;
  wk += weekGrid(minItems);
  for (const w of store.items.filter(i => i.type === 'weekly' && live(i))) {
    // счёт разбираемой недели — тот же интервал, что уйдёт в срез closeWeek
    const n = store.weekLog.filter(e => e.itemId === w.id && e.date >= keys[0] && e.date <= keys[6]).length;
    wk += `<p class="line">${esc(w.name)}: ${n} из ${w.goal || 0}</p>`;
  }
  wk += `<h2>Три закрытые недели</h2>`;
  wk += consist(minItems);

  wk += `<h2>Привычки</h2>`;
  if (habitItems.length) {
    wk += weekGrid(habitItems);
    // норма и серия разбираемой недели: read-only справка, закрытие данных не меняет
    for (const hb of habitItems) {
      const x = habitWeekCount(hb, keys[0]);
      const norm = hb.normPerWeek || 7;
      // строка прерывания серии упразднена (задача 15): невыполненная неделя
      // сообщается счётом «x из normPerWeek» и молчанием, без тона и оценки
      const tail = x >= norm ? ` · серия ${habitStreakFrom(hb, keys[0])} нед` : '';
      wk += `<p class="muted">${esc(hb.name)}: ${x} из ${norm}${tail}</p>`;
    }
    wk += consist(habitItems);
  } else {
    wk += `<p class="muted">Привычек пока нет — добавить можно в Настройках → Пункты.</p>`;
  }

  // итог принятого решения по параметру — read-only строка; нерешённые
  // стоят карточками выше, в «Решении 1» (решение чужой недели карточку
  // не гасит: paramDecision привязан к разбираемой неделе)
  for (const p of store.items.filter(i => i.type === 'param' && live(i))) {
    const decided = paramDecision(p.id);
    if (!decided) continue;
    wk += `<p class="muted">${esc(p.name)}: ${decided.to === null
      ? `${esc(fmtParam(p, decided.from))}, без шага`
      : `${esc(fmtParam(p, decided.from))} → ${esc(fmtParam(p, decided.to))}`}</p>`;
  }

  if (habitsSteady()) {
    wk += `<p class="muted">Привычки устойчивы 2 недели — можно добавить новую</p>`;
  }

  h += `
    <details class="sect week"${weekFoldOpen() ? ' open' : ''}>
      <summary data-act="week-fold">Показать неделю<span class="chev" aria-hidden="true">&rsaquo;</span></summary>
      <div class="sect-b">${wk}</div>
    </details>`;

  // Закрытие недели — самая тяжёлая необратимость приложения: срез уходит в
  // архив, а принятые решения, поле «одного изменения» и решения по
  // параметрам чистятся. Один тап для этого мало (задача 28.B, п. 6):
  // «Стереть» и «Удалить блок» давно просят второго, а эта кнопка стояла
  // вплотную над «Готово» и срабатывала с первого.
  // Последствие названо между тапами и названо нейтрально: что произойдёт,
  // без тревоги и без уговоров.
  //
  // Строка стоит ПОД кнопкой, а не над ней (задача 28.D, п. 9.3). Сверху
  // она сдвигала кнопку вниз ровно в тот момент, когда владелец готовился
  // ко второму тапу: замер на 375×812 дал 957 → 1026 px, то есть 69 px —
  // палец попадал в пустоту или в соседний узел. Порядок «кнопка, затем
  // объяснение» держит точку нажатия на месте, а текст остаётся на экране
  // и прочитывается до тапа: он ниже кнопки, но выше «Готово».
  h += `<button class="btn primary wide" data-act="close-week">${ui.weekCloseConfirm ? 'Подтвердить: закрыть неделю' : 'Закрыть неделю'}</button>`;
  if (ui.weekCloseConfirm) {
    h += `<p class="muted">Неделя уйдёт в архив: принятые решения, «одно изменение» и решения по параметрам очистятся. Отметки останутся.</p>`;
  }
  h += REVIEW_DONE;

  el('scr-review').innerHTML = h;
}

/* Экран 3 — «Пункты и настройки» */
/* Подсказки поля «Блок» — из списка блоков (инвариант 13): он же задаёт
   порядок на экранах, поэтому другого источника имён у формы нет */
function groupList() {
  return store.groups.map(g => g.name);
}

function barHistory(it) {
  if (typeof it.value !== 'number' || !isFinite(it.value)) return ''; // после очистки значения строка не показывается
  if (!Array.isArray(it.history) || it.history.length < 2) return '';
  const vals = it.history.map(x => String(x.value));
  const shown = vals.length > 6 ? ['…'].concat(vals.slice(-6)) : vals;
  const last = it.history[it.history.length - 1];
  return `<span class="hist">Планка: ${shown.map(esc).join(' → ')}${it.unit ? ' ' + esc(it.unit) : ''} · с ${esc(fmtShort(last.date))}</span>`;
}

/* История порога параметра: «Отбой: 00:00 → 23:45 · с <дата>» */
function paramHistory(it) {
  if (!Array.isArray(it.history) || it.history.length < 2) return '';
  const last = it.history[it.history.length - 1];
  const vals = it.history.map(x => fmtParam(it, x.value));
  const shown = vals.length > 6 ? ['…'].concat(vals.slice(-6)) : vals;
  return `<span class="hist">${esc(it.name)}: ${shown.map(esc).join(' → ')} · с ${esc(fmtShort(last.date))}</span>`;
}

/* Черновик открытой формы «Пунктов»: значения всех полей (сливаются
   с прежним черновиком — цель переживает смену типа), сфокусированное
   поле и позиция каретки. Восстанавливается при каждом renderSettings,
   пока открыта та же форма. */
function currentFormKey() {
  // лист тренировки перекрывает вкладку целиком — его поля и есть открытая
  // форма, пока он открыт (задача 26, п. 3). Порядок проверок — как в
  // renderAll: разбор главнее листа тренировки. Прежде первым стоял лист
  // детали, а разбор в проверке не участвовал вовсе; лист детали снят
  // (задача 28.D), и на его место встал тот, кто и рисуется первым.
  if (!ui.reviewOpen && ui.trainOpen) return 'train:' + ui.trainId;
  if (ui.addOpen) return 'add';
  if (ui.editingId !== null) return 'edit:' + ui.editingId;
  // формы блока и упражнения черновиком не считались вовсе — ключ был null,
  // и введённое имя пропадало при перерисовке по чужому поводу (задача 27,
  // п. 7.1). Слот у них общий с «Пунктами»: он один на экран, а пятого
  // заводить незачем — форму снимок теперь ищет по СОВПАДЕНИЮ КЛЮЧА, а не
  // «первую по DOM», и потому чужую больше не подхватывает. Приоритет у
  // форм пункта: они самые большие, и терять в них ввод дороже всего
  if (ui.groupAdd) return 'group:new';
  if (ui.groupRename !== null) return 'group:' + ui.groupRename;
  if (ui.exAddOpen) return 'ex:new';
  if (ui.exEditingId !== null) return 'ex:' + ui.exEditingId;
  return null;
}

/* Ключ формы по её разметке — та же строка, что даёт currentFormKey.
   Пары «data-form → ключ» неоднозначны только у форм добавления: у них
   нет data-id, и суффикс «new» проставляется здесь, а не в разметке. */
const FORM_KIND = { 'group-edit': 'group', 'ex-edit': 'ex' };

function domFormKey(form) {
  const f = form.dataset.form;
  if (f === 'add') return 'add';
  if (f === 'group-add') return 'group:new';
  if (f === 'ex-add') return 'ex:new';
  return (FORM_KIND[f] || f) + ':' + (form.dataset.id || '');
}

/* ДВА слота черновика (задача 15, п. 6; лист тренировки — задача 26,
   п. 3): формы листа тренировки и «Пунктов» не делят один. Иначе уход в
   лист стирал бы начатую правку названия, а возврат — черновик формы
   листа. Слотов было четыре: третьим был заметочный, ушедший с экраном
   (задача 28.C), четвёртым — слот форм листа детали, ушедший с самим
   листом (задача 28.D). Механизм при этом не изменился ни разу. */
const isTrainKey = key => key.startsWith('train:');
const draftSlot = key => (isTrainKey(key) ? 'trainDraft' : 'formDraft');
/* Экран, на котором живёт форма ключа: снимок ищет её именно там */
const formScope = key => (isTrainKey(key) ? '#scr-train' : '#scr-settings');

/* Черновик формы по ключу. Хранилище — по одному на экран (`draftSlot`),
   внутри — запись на каждую форму этого экрана (задача 28.B, п. 4.3):
   прежде запись была ОДНА, и открытие соседней формы того же экрана
   затирало набранное в первой. Ключ хранится ключом объекта, а не полем
   записи, — сверять его на восстановлении больше не нужно. */
const draftOf = key => ui[draftSlot(key)][key] || null;

function snapshotOpenForm() {
  const key = currentFormKey();
  if (!key) return; // ничего не открыто — черновики живут до своей формы
  const slot = draftSlot(key);
  // Форма ищется на том экране, которому принадлежит ключ, и именно ТА,
  // чей ключ совпал. Прежде бралась ПЕРВАЯ форма экрана — а на «Настройках»
  // секция «Блоки» стоит выше «Пунктов», и раскрытая правка блока крала
  // черновик формы пункта: домашний ключ не совпадал с чужой разметкой, и
  // снимок молча не снимался (задача 27, п. 7.1).
  // Признак формы — data-form, а не класс .card.form: поля листа тренировки
  // карточкой не обёрнуты, но черновик им нужен тот же (задача 26, п. 3.2)
  let form = null;
  for (const f of document.querySelectorAll(formScope(key) + ' [data-form]')) {
    if (domFormKey(f) === key) { form = f; break; }
  }
  // Формы ещё нет в разметке — её открывают прямо сейчас, текущий рендер её
  // только напечатает. Снимать нечего, и чистить тоже: черновики соседних
  // форм лежат по своим ключам и этой не мешают. Прежде здесь стояла чистка
  // «открыли другую форму», и набранное в первой пропадало (28.B, п. 4.3).
  if (!form) return;
  const fields = {};
  for (const inp of form.querySelectorAll('input[id], select[id], textarea[id]')) {
    if (inp.dataset.act) continue; // управляемые ui-состоянием контролы (select типа) — не черновик
    fields[inp.id] = inp.value;
  }
  const ae = document.activeElement;
  const focus = (ae && form.contains(ae) && ae.id)
    ? { id: ae.id, start: ae.selectionStart ?? null, end: ae.selectionEnd ?? null }
    : null;
  const base = draftOf(key);
  ui[slot][key] = { fields: Object.assign({}, base && base.fields, fields), focus };
}

/* ── Формы «Настроек»: одна за раз (задача 28.B, п. 4) ─────────
   На экране четыре семейства форм — пункт, добавление пункта, блок и
   упражнение, — и слот черновика у них ОДИН (`formDraft`, он же один на
   экран по инварианту). Гасили друг друга они несимметрично: `edit-open`
   снимал только `addOpen`, `group-add-open` — только правку блока, а
   обратно не гасило ничто. Замер: в 20 сочетаниях из 30 на экране
   оставалось ДВЕ открытые формы, и в 18 набранное в первой пропадало.

   Правило теперь одно на всех: сначала снимок того, что открыто, потом
   закрытие ВСЕХ форм экрана, потом открытие нужной. Порядок обязателен —
   снимок читает `currentFormKey()`, и если ui уже переписан, ключ укажет
   на новую форму, а набранное в прежней не будет снято вовсе (именно так
   оно и терялось: черновик снимается только при перерисовке). */
function settingsFormsClosed() {
  ui.editingId = null;
  ui.addOpen = false;
  ui.groupRename = null;
  ui.groupAdd = false;
  ui.groupDelete = null;
  ui.exEditingId = null;
  ui.exAddOpen = false;
  // производные состояния открытой формы принадлежат ей, не экрану
  ui.editNorm = null;
  ui.groupPick = null;
  ui.groupNew = false;
  ui.removeConfirm = null; // взведённое «Убрать» принадлежало закрытой форме
}

function openSettingsForm(apply) {
  snapshotOpenForm();     // набранное в прежней форме — в слот, ДО смены ui
  settingsFormsClosed();
  apply();
  renderSettings();
}

/* «Отмена» — осознанный отказ от набранного, а не переключение: черновик
   снимается явно. Иначе повторное открытие той же формы вернуло бы то,
   от чего владелец только что отказался (снимок теперь делается при
   открытии соседней формы, а прежде не делался вовсе). */
function dropOpenDraft() {
  const key = currentFormKey();
  if (key) delete ui[draftSlot(key)][key];
}

function restoreOpenForm() {
  const key = currentFormKey();
  if (!key) return;
  const draft = draftOf(key);
  if (!draft) return;
  for (const [fid, v] of Object.entries(draft.fields)) {
    const inp = el(fid);
    if (inp) inp.value = v;
  }
  const f = draft.focus;
  if (f) {
    const inp = el(f.id);
    if (inp) {
      inp.focus();
      if (f.start !== null && typeof inp.setSelectionRange === 'function') {
        try { inp.setSelectionRange(f.start, f.end); } catch (e) { /* select и др. */ }
      }
    }
  }
}

/* Редактор блоков: строка — имя и стрелки, правка раскрывается тапом по
   имени (механика формы правки пункта). Порядок задаётся стрелками и
   перетаскиванием (инвариант 17, задача 16F). */
function groupEditor() {
  let h = '';
  if (!store.groups.length) {
    h += `<p class="muted">Блоков пока нет — пункты идут одним списком.</p>`;
  }
  store.groups.forEach((g, i) => {
    h += `
      <div class="rowwrap drag-row" data-drag="group" data-drag-id="${esc(g.name)}">
        <div class="row item">
          <button class="itxt" data-act="group-open" data-name="${esc(g.name)}" aria-label="изменить «${esc(g.name)}»">
            <span class="tname">${esc(g.name)}</span>
          </button>
          <span class="ictl">
            <button class="btn icon quiet" data-act="group-up" data-name="${esc(g.name)}"${i === 0 ? ' disabled' : ''} aria-label="выше: «${esc(g.name)}»">&uarr;</button>
            <button class="btn icon quiet" data-act="group-down" data-name="${esc(g.name)}"${i === store.groups.length - 1 ? ' disabled' : ''} aria-label="ниже: «${esc(g.name)}»">&darr;</button>
          </span>
        </div>
        ${ui.groupRename === g.name ? `
        <div class="card form" data-form="group-edit" data-id="${esc(g.name)}">
          <label class="field"><span>Название</span><input type="text" id="g-name" value="${esc(g.name)}"></label>
          <div class="btns">
            <button class="btn primary" data-act="group-save" data-name="${esc(g.name)}">Сохранить</button>
            <button class="btn quiet" data-act="group-cancel">Отмена</button>
            <button class="btn quiet" data-act="group-del" data-name="${esc(g.name)}">${ui.groupDelete === g.name ? 'Подтвердить удаление' : 'Удалить'}</button>
          </div>
        </div>` : ''}
        ${flashAt('group:' + g.name)}
      </div>`;
  });
  h += ui.groupAdd
    ? `<div class="card form" data-form="group-add">
        <label class="field"><span>Название блока</span><input type="text" id="g-add" placeholder="Например: Вечер"></label>
        <div class="btns">
          <button class="btn primary" data-act="group-add-save">Добавить</button>
          <button class="btn quiet" data-act="group-add-cancel">Отмена</button>
        </div>
      </div>`
    : `<button class="btn wide" data-act="group-add-open">Добавить блок</button>`;
  return h;
}

/* ── Уход из виду: две дороги назад (задача 28.E/A, п. 3) ──────
   КОРОТКАЯ — строка на месте только что убранного: «{имя} · убран —
   Вернуть». Своим классом, а не .flash: тот гаснет через FLASH_MS, а
   отмена, исчезающая через секунду, отменой не является (A.3.4). Живёт
   до следующего действия владельца, как ui.importNote.
   ДЛИННАЯ — блок «Убранные» внизу своей области. Пустым не рисуется.

   Род слова разный: пункт убран, упражнение убрано. */
const GONE_WORD = { item: 'убран', ex: 'убрано' };

/* Что произойдёт — названо МЕЖДУ тапами и названо нейтрально: последствие,
   без тревоги и без уговоров. Числа «во что превратится серия» здесь нет и
   быть не может — это была бы инструкция по накрутке (A.3.3). */
const REMOVE_WHAT = {
  item: 'Пункт уйдёт из списков. Отметки и прошлые дни останутся как есть.',
  ex: 'Упражнение уйдёт из списков. Записанные тренировки и история нагрузки останутся как есть.'
};

/* Хвост формы правки: свои кнопки, «Убрать» и под ними — последствие.

   Строка последствия стоит ПОД кнопкой, а не над ней (правило задачи 28.D,
   п. 9.3): сверху она сдвигала бы «Убрать» вниз ровно в тот момент, когда
   владелец готовится ко второму тапу.

   «Убрать» живёт в СВОЁМ ряду, отдельно от «Сохранить» и «Отмены». Замер в
   браузере (375×812): в общем ряду надпись «Подтвердить: убрать» переносила
   кнопку на следующую строку flex-обёртки и уводила её вниз на 54 px — тот
   же дефект, от которого лечили «Закрыть неделю». В собственном ряду ширина
   надписи ни на что не влияет: ряд один, переносить нечего. Заодно ряд
   разводит сохранение и уход визуально. */
function removeFoot(kind, id, buttons) {
  const armed = ui.removeConfirm === kind + ':' + id;
  return `
      <div class="btns">
        ${buttons}
      </div>
      <div class="btns">
        <button class="btn quiet" data-act="${kind}-remove" data-id="${esc(id)}">${armed ? 'Подтвердить: убрать' : 'Убрать'}</button>
      </div>
      ${armed ? `<p class="muted">${REMOVE_WHAT[kind]}</p>` : ''}`;
}

function goneNote(x, kind) {
  return `<p class="gone-note">${esc(x.name)} · ${GONE_WORD[kind]}` +
    `<button type="button" class="undo" data-act="${kind}-restore" data-id="${esc(x.id)}"` +
    ` aria-label="вернуть «${esc(x.name)}»">Вернуть</button></p>`;
}

/* Только что убранное здесь не повторяется: оно стоит строкой на своём
   прежнем месте, и двух «Вернуть» на одну запись быть не должно. */
function goneBlock(list, kind) {
  const gone = list.filter(x => !live(x) && ui.goneNote !== x.id);
  if (!gone.length) return '';
  let h = `<h2>Убранные</h2><div class="list">`;
  for (const x of gone) {
    h += `
      <div class="rowwrap gone">
        <div class="row item">
          <span class="gtxt">
            <span class="tname">${esc(x.name)}</span>
            <span class="meta">${GONE_WORD[kind]} ${esc(fmtShort(x.removedAt))}</span>
          </span>
          <span class="ictl">
            <button class="btn quiet" data-act="${kind}-restore" data-id="${esc(x.id)}" aria-label="вернуть «${esc(x.name)}»">Вернуть</button>
          </span>
        </div>
      </div>`;
  }
  return h + `</div>`;
}

/* Редактор упражнений (задача 16D): та же механика, что у пунктов —
   строка с именем раскрывает правку, стрелки задают порядок, «Убрать» в
   форме уводит из виду. Нагрузку правит запись тренировки, не форма. */
function exerciseEditor() {
  let h = '';
  if (!store.exercises.length) {
    h += `<p class="muted">Упражнений пока нет.</p>`;
  }
  // границы стрелок считаются по ВИДИМОМУ списку: убранное в порядке не
  // участвует, но своё место в store.exercises сохраняет (exerciseIndexes)
  const shown = liveExercises();
  store.exercises.forEach((ex) => {
    if (!live(ex)) {
      if (ui.goneNote === ex.id) h += goneNote(ex, 'ex');
      return;
    }
    const i = shown.indexOf(ex);
    const meta = [valUnit(ex)].filter(Boolean).join(' · ');
    h += `
      <div class="rowwrap drag-row" data-drag="ex" data-drag-id="${esc(ex.id)}">
        <div class="row item">
          <button class="itxt" data-act="ex-open" data-id="${esc(ex.id)}" aria-label="изменить «${esc(ex.name)}»">
            <span class="tname">${esc(ex.name)}</span>
            ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
            ${barHistory(ex)}
          </button>
          <span class="ictl">
            <button class="btn icon quiet" data-act="ex-up" data-id="${esc(ex.id)}"${i === 0 ? ' disabled' : ''} aria-label="выше">&uarr;</button>
            <button class="btn icon quiet" data-act="ex-down" data-id="${esc(ex.id)}"${i === shown.length - 1 ? ' disabled' : ''} aria-label="ниже">&darr;</button>
          </span>
        </div>
        ${ui.exEditingId === ex.id ? `
        <div class="card form" data-form="ex-edit" data-id="${esc(ex.id)}">
          <label class="field"><span>Название</span><input type="text" id="x-name" value="${esc(ex.name)}"></label>
          <label class="field"><span>Единица</span><input type="text" id="x-unit" value="${esc(ex.unit)}" placeholder="кг, повт."></label>
          ${removeFoot('ex', ex.id, `<button class="btn primary" data-act="ex-save" data-id="${esc(ex.id)}">Сохранить</button>
            <button class="btn quiet" data-act="ex-cancel">Отмена</button>`)}
        </div>` : ''}
        ${flashAt('ex:' + ex.id)}
      </div>`;
  });
  h += ui.exAddOpen
    ? `<div class="card form" data-form="ex-add">
        <label class="field"><span>Название</span><input type="text" id="x-add-name" placeholder="Например: Жим лёжа"></label>
        <label class="field"><span>Единица</span><input type="text" id="x-add-unit" placeholder="кг, повт."></label>
        <label class="field"><span>Рабочая нагрузка</span><input type="text" id="x-add-value" inputmode="decimal" placeholder="необязательно"></label>
        <div class="btns">
          <button class="btn primary" data-act="ex-add-save">Добавить</button>
          <button class="btn quiet" data-act="ex-add-cancel">Отмена</button>
        </div>
      </div>`
    : `<button class="btn wide" data-act="ex-add-open">Добавить упражнение</button>`;
  h += goneBlock(store.exercises, 'ex');
  return h;
}

/* Сворачиваемая секция «Настроек» на нативном details: раскрытие —
   дело браузера, ui хранит только состояние, чтобы перерисовка после
   действия внутри секции её не захлопнула. */
function sect(key, title, body) {
  return `
    <details class="sect"${ui.settingsOpen[key] ? ' open' : ''}>
      <summary data-act="sect" data-sect="${key}">${title}<span class="chev" aria-hidden="true">&rsaquo;</span></summary>
      <div class="sect-b">${body}</div>
    </details>`;
}

/* Строка возврата — первой в «Данных», пока копия существует. Поводов к её
   жизни три: чистка, импорт (задача 25, п. 2.2) и сам возврат (задача 26,
   п. 1.1) — все замещают прежнее состояние и все обратимы одной кнопкой.
   Копия без kind — снятая до задачи 25, то есть чисткой.

   Строка говорит, ЧТО лежит в копии и ОТКУДА взялось (п. 1.2), а не что
   было сделано: копия обменная, и «Стёрто» после второго тапа по «Вернуть»
   называло бы стёртым то, что как раз вернули. Тон нейтральный: ни
   тревоги, ни оценки. */
const PREV_WHENCE = { import: 'до импорта', restore: 'до возврата', mirror: 'до восстановления из резервной копии' };

function restoreLine() {
  const c = wipedCopy();
  if (!c) return '';
  const st = c.stats || {};
  const when = (typeof c.wipedAt === 'number' && isFinite(c.wipedAt))
    ? fmtDay(dateKeyShift(new Date(c.wipedAt), store.settings.dayBoundary))
    : '';
  const whence = PREV_WHENCE[c.kind] || 'до чистки';
  const n = Number(st.items) || 0;
  const d = Number(st.days) || 0;
  // копия из одних заметок читалась как пустая: считались только пункты и
  // дни (задача 27.1, п. 10.5). Заметки и выписки — такие же слова
  // владельца, и их отсутствие в строке делало содержательную копию немой.
  // Экран заметок снят (задача 28.C), новых записей не заводится, но
  // прежние живут в store и в копию идут — значит, и в счёт тоже
  const q = Number(st.notes) || 0;
  const parts = [
    `${n} ${plural(n, 'пункт', 'пункта', 'пунктов')}`,
    `${d} ${plural(d, 'день', 'дня', 'дней')} отметок`
  ];
  if (q) parts.push(`${q} ${plural(q, 'запись', 'записи', 'записей')}`);
  return `
    <div class="restore">
      <p class="muted">В копии — состояние ${whence}${when ? ', ' + esc(when) : ''} · ${parts.join(', ')}</p>
      <p class="muted">«Вернуть» меняет местами: нынешнее состояние ляжет в копию.</p>
      ${ui.restoreFailed ? `<p class="muted">Возврат не выполнен — данные не изменены</p>` : ''}
      <div class="btns">
        <button class="btn" data-act="wipe-undo">Вернуть</button>
        <button class="btn quiet" data-act="wipe-drop">${ui.wipeDropConfirm ? 'Подтвердить: убрать копию' : 'Убрать копию'}</button>
      </div>
    </div>`;
}

/* Нечитаемые данные, отложенные load(), становятся видимыми (задача 25,
   п. 6): прежде они молча лежали в ключе, о котором владелец не знал, —
   ни скачать, ни убрать. Тон — как у «Резервная копия не проверена»:
   это «неизвестно», а не тревога, поэтому muted и без акцента. */
function corruptLine() {
  return Object.keys(CORRUPT_SRC).map(corruptBlock).join('');
}

function corruptBlock(src) {
  const c = corruptCopy(src);
  if (!c) return '';
  const w = CORRUPT_SRC[src];
  const when = (typeof c.at === 'number' && isFinite(c.at))
    ? ' от ' + esc(fmtDay(dateKeyShift(new Date(c.at), store.settings.dayBoundary)))
    : '';
  return `
    <div class="restore corrupt">
      <p class="muted">${w.title}${when}</p>
      <p class="muted">${w.why}</p>
      <div class="btns">
        <button class="btn" data-act="corrupt-save" data-src="${src}">Скачать</button>
        <button class="btn quiet" data-act="corrupt-drop" data-src="${src}">${ui.corruptDropConfirm === src ? 'Подтвердить: убрать' : 'Убрать'}</button>
      </div>
    </div>`;
}

/* Предложение восстановления (задача 28.A, п. 2.2). Появляется, когда в
   снапшоте есть практика, которой нет в рабочей копии. Автоматической
   подмены нет: приложение не знает, какое из двух состояний владелец
   считает своим, — оно знает лишь, что одно не является продолжением
   другого. Пока строка стоит, зеркало не перезаписывается.
   Три пути наружу, и ни один ничего не теряет: восстановить (обменной
   копией, как импорт и возврат), скачать файлом, оставить рабочую. */
function mirrorOfferLine() {
  if (!mirrorOffer) return '';
  const st = mirrorOffer.stats || {};
  const when = (typeof mirrorOffer.savedAt === 'number' && isFinite(mirrorOffer.savedAt))
    ? ' от ' + esc(fmtStamp(mirrorOffer.savedAt))
    : '';
  const n = Number(st.items) || 0;
  const d = Number(st.days) || 0;
  return `
    <div class="restore corrupt">
      <p class="muted">Резервная копия${when} отличается от рабочей: ${n} ${plural(n, 'пункт', 'пункта', 'пунктов')}, ${d} ${plural(d, 'день', 'дня', 'дней')} отметок</p>
      <p class="muted">В ней есть записи, которых в рабочей копии нет. Пока решение не принято, копия не перезаписывается.</p>
      ${ui.mirrorFailed ? `<p class="muted" role="status">Восстановление не выполнено — данные не изменены</p>` : ''}
      <div class="btns">
        <button class="btn" data-act="mirror-restore">${ui.mirrorRestoreConfirm ? 'Подтвердить: восстановить' : 'Восстановить из копии'}</button>
        <button class="btn quiet" data-act="mirror-save">Скачать</button>
        <button class="btn quiet" data-act="mirror-keep">${ui.mirrorKeepConfirm ? 'Подтвердить: оставить рабочую' : 'Оставить рабочую'}</button>
      </div>
    </div>`;
}

/* «Начать с чистого листа» — внизу «Данных», отделено линией.
   Предупреждение перечисляет стираемое числами: решение принимается
   с открытыми глазами, а не по памяти. */
function wipeBlock() {
  if (!ui.wipeOpen) {
    return `<div class="danger"><button class="btn quiet" data-act="wipe-open">Начать с чистого листа</button></div>`;
  }
  const s = wipeStats(store);
  // Список стираемого называет и лестницы, и заметки — механик и экрана для
  // них больше нет (задачи 28.C и 28.D), но данные владельца в store лежат и
  // чисткой действительно стираются. Умолчать о том, что уходит, нельзя:
  // решение принимается с открытыми глазами, а не по памяти.
  const line = [
    `${s.items} ${plural(s.items, 'пункт', 'пункта', 'пунктов')}`,
    `${s.groups} ${plural(s.groups, 'блок', 'блока', 'блоков')}`,
    `${s.days} ${plural(s.days, 'день', 'дня', 'дней')} отметок`,
    `${s.reviews} ${plural(s.reviews, 'разбор', 'разбора', 'разборов')}`,
    `${s.ladders} ${plural(s.ladders, 'лестница', 'лестницы', 'лестниц')}`,
    `${s.exercises} ${plural(s.exercises, 'упражнение', 'упражнения', 'упражнений')}`,
    `${s.sessions} ${plural(s.sessions, 'тренировка', 'тренировки', 'тренировок')}`,
    `${s.notes} ${plural(s.notes, 'заметка', 'заметки', 'заметок')}`
  ].join(', ');
  return `
    <div class="danger">
      <p class="lead">Начать с чистого листа</p>
      ${ui.wipeFailed ? `<p class="muted" role="status">Чистка не выполнена — данные не изменены</p>` : ''}
      <p class="muted">Будут стёрты: ${line}.</p>
      ${mirrorReady ? '' : (mirrorOffer
        ? `<p class="muted">Резервная копия ждёт решения выше — чистка её не сбросит и не тронет.</p>`
        : `<p class="muted">Резервная копия сейчас недоступна, и стереть её нечем. Она останется от прежнего состояния, и приложение предложит её при следующем запуске — подменить данные само оно не станет.</p>`)}
      <p class="muted">Копия останется в приложении — вернуть можно, пока она не убрана.${wipedCopy() && hasData(store) ? ' Прежняя копия будет заменена новой: хранится одна, последняя.' : ''}</p>
      <div class="btns">
        <button class="btn" data-act="export">Сначала скачать копию</button>
        <button class="btn quiet" data-act="wipe-do">${ui.wipeConfirm ? 'Подтвердить: стереть' : 'Стереть'}</button>
        <button class="btn quiet" data-act="wipe-cancel">Отмена</button>
      </div>
    </div>`;
}

/* Экран 5 — «Настройки»: секции по порядку (задачи 16B, 16D) */
function renderSettings() {
  snapshotOpenForm();
  // подтверждение сохранения печатается не здесь, а у якоря той строки,
  // которой принадлежала форма (задача 26, п. 2.1) — см. flashAt()
  let h = `<header class="page"><p class="overline">Устройство приложения</p><h1>Настройки</h1></header>`;

  h += sect('groups', 'Блоки', groupEditor());

  // две группы: минимум и привычки, у каждой своя кнопка добавления
  const groups = [
    ['Минимум', 'min', 'Добавить пункт'],
    ['Привычки', 'habit', 'Добавить привычку']
  ];
  let body = '';
  for (const [title, area, addLabel] of groups) {
    const items = store.items.filter(i => i.area === area);
    body += `<h2>${title}</h2>`;
    body += `<div class="list">`;
    items.forEach((it) => {
      // убранный пункт из списка ушёл. Тот, что убран ПРЯМО СЕЙЧАС, оставляет
      // на своём месте короткий путь назад и в «Убранных» не дублируется
      if (!live(it)) {
        if (ui.goneNote === it.id) body += goneNote(it, 'item');
        return;
      }
      const vu = it.type === 'param' ? `порог ${fmtParam(it)}` : valUnit(it);
      const meta = [vu, it.type === 'weekly' ? `цель ${it.goal || 0} / нед.` : '', (it.group || '').trim()]
        .filter(Boolean).join(' · ');
      body += `
      <div class="rowwrap drag-row" data-drag="item" data-drag-id="${esc(it.id)}" data-dgroup="${esc((it.group || '').trim())}">
        <div class="row item">
          <button class="itxt" data-act="edit-open" data-id="${esc(it.id)}" aria-label="изменить «${esc(it.name)}»">
            <span class="tname">${esc(it.name)}</span>
            ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
            ${it.note ? `<span class="note">${esc(it.note)}</span>` : ''}
            ${it.type === 'param' ? paramHistory(it) : barHistory(it)}
          </button>
          <span class="ictl">
            <button class="btn icon quiet" data-act="move-up" data-id="${esc(it.id)}"${canMoveItem(it.id, 'up') ? '' : ' disabled'} aria-label="выше">&uarr;</button>
            <button class="btn icon quiet" data-act="move-down" data-id="${esc(it.id)}"${canMoveItem(it.id, 'down') ? '' : ' disabled'} aria-label="ниже">&darr;</button>
          </span>
        </div>
        ${ui.editingId === it.id ? editForm(it) : ''}
        ${flashAt('item:' + it.id)}
      </div>`;
    });
    body += `</div>`;
    body += (ui.addOpen && ui.addArea === area)
      ? addForm()
      : `<button class="btn wide" data-act="add-open" data-area="${area}">${addLabel}</button>`;
    body += goneBlock(items, 'item');
  }

  // граница дня — механика самих пунктов, поэтому живёт в их секции
  const hours = [];
  for (let i = 0; i <= 8; i++) hours.push(`<option value="${i}"${store.settings.dayBoundary === i ? ' selected' : ''}>${pad2(i)}:00</option>`);
  body += `
    <h2>Граница дня</h2>
    <label class="field inline">
      <span>Смена дня в</span>
      <select data-act="boundary">${hours.join('')}</select>
    </label>
    <p class="muted">Отметки до этого часа относятся к предыдущему дню.</p>`;

  // порог зачёта дня (задача 17): «день зачтён» — доля, а не всё подряд.
  // Живёт рядом с границей дня: обе настройки — про то, как считается день.
  const th = dayThreshold();
  const thrNote = thresholdNote();
  body += `
    <h2>Зачёт дня</h2>
    <div class="field inline norm">
      <span>Отмечено не меньше <b>${Math.round(th * 100)}%</b></span>
      <span class="btns">
        <button type="button" class="btn icon quiet" data-act="thr-dec"${th <= THRESHOLD_MIN + EPS ? ' disabled' : ''} aria-label="ниже порог">&minus;</button>
        <button type="button" class="btn icon quiet" data-act="thr-inc"${th >= THRESHOLD_MAX - EPS ? ' disabled' : ''} aria-label="выше порог">+</button>
      </span>
    </div>
    <p class="muted" id="thr-note"${thrNote ? '' : ' hidden'}>${thrNote}</p>`;

  h += sect('items', 'Пункты', body);
  h += sect('exercises', 'Упражнения', exerciseEditor());

  // «запускался», а не «был»: приложение знает лишь то, что отдало файл
  // браузеру. Сохранил ли его владелец — в вебе узнать нечем, и строка
  // не должна утверждать больше, чем приложение знает (задача 25, п. 9)
  const exp = (typeof store.settings.exportedAt === 'number' && isFinite(store.settings.exportedAt))
    // логический день — как в имени файла экспорта (инвариант 1)
    ? `Экспорт запускался: ${esc(fmtShort(dateKeyShift(new Date(store.settings.exportedAt), store.settings.dayBoundary)))}`
    : 'Экспорта ещё не было';
  h += sect('data', 'Данные', mirrorOfferLine() + restoreLine() + `
    <div class="btns">
      <button class="btn" data-act="export">Экспорт JSON</button>
      <button class="btn" data-act="import">Импорт JSON</button>
    </div>
    ${ui.importNote ? `<p class="muted" role="status">${esc(ui.importNote)}</p>` : ''}
    <p class="muted">${exp}</p>
    <p class="muted" id="mirror-note" hidden></p>
    ${corruptLine()}
    <input type="file" id="import-file" accept="application/json,.json" hidden>
    <p class="muted">Все данные — на этом устройстве: рабочая копия и автоматическая резервная. Экспорт — способ сохранить их вне приложения.</p>
    <h2>Начало отсчёта</h2>
    <label class="field">
      <span>Первый день в системе</span>
      <input type="date" id="since" data-act="since" value="${esc(isDayKey(store.settings.calendarSince) ? store.settings.calendarSince : '')}">
    </label>
    <p class="muted">Меняет счёт дней в системе, серию и доступность разбора. Отметки не затрагивает.</p>` + wipeBlock());

  h += sect('system', 'Система', systemSection());

  el('scr-settings').innerHTML = h;
  restoreOpenForm();
  armFlash();
  updateMirrorNote();
}

/* Строка «Резервная копия: …» — асинхронно и точечно после рендера
   «Пунктов»; при недоступном зеркале не показывается вовсе.
   Стартовое чтение не завершилось — так и сказано: не «ошибка» и не
   тревога, а честное «неизвестно» тем же muted (A.1.4). */
function updateMirrorNote() {
  const p = el('mirror-note');
  if (!p) return;
  // о зеркале уже говорит блок предложения, и говорит подробнее — второй
  // строки про ту же копию не нужно
  if (mirrorOffer) { p.hidden = true; return; }
  if (mirrorUnverified) {
    p.textContent = 'Резервная копия не проверена';
    p.hidden = false;
    return;
  }
  if (typeof indexedDB === 'undefined') return;
  mirrorRead().then(snap => {
    if (!snap || typeof snap.savedAt !== 'number') return;
    p.textContent = 'Резервная копия: ' + fmtStamp(snap.savedAt);
    p.hidden = false;
  });
}

/* Поле «Блок» — выбор из заведённых (задача 17). Свободного ввода нет:
   опечатка заводила блок-двойник. «+ Новый блок…» всегда последний
   вариант — значение-маркер могло бы совпасть с именем блока, индекс
   не может; отсюда isNewGroupPick. */
const isNewGroupPick = sel => !!sel && sel.selectedIndex === sel.options.length - 1;

function groupField(idPrefix, value) {
  const cur = ui.groupPick !== null ? ui.groupPick : (value || '').trim();
  const names = groupList();
  let opts = `<option value=""${cur ? '' : ' selected'}>— без блока</option>`;
  for (const g of names) {
    opts += `<option value="${esc(g)}"${g === cur ? ' selected' : ''}>${esc(g)}</option>`;
  }
  // имя из импорта, которого нет в списке блоков: вариант виден и выбран,
  // чтобы правка формы не сбрасывала принадлежность молча (инвариант 13)
  if (cur && !names.includes(cur)) {
    opts += `<option value="${esc(cur)}" selected>${esc(cur)} (нет в списке)</option>`;
  }
  opts += `<option value=""${ui.groupNew ? ' selected' : ''}>+ Новый блок…</option>`;
  return `
    <label class="field"><span>Блок</span>
      <select id="${idPrefix}-group" data-act="group-pick">${opts}</select>
    </label>
    ${ui.groupNew ? `<label class="field"><span>Имя блока</span>
      <input type="text" id="${idPrefix}-gnew" placeholder="Например: Утро"></label>` : ''}`;
}

/* Значение поля «Блок» при сохранении формы: имя из списка либо новое
   имя из раскрытого поля. Пустое имя блока не заводит и принадлежность
   пункта не меняет — прежняя возвращается как fallback. */
function readGroupField(idPrefix, fallback) {
  const sel = el(idPrefix + '-group');
  if (!sel) return fallback;
  if (!isNewGroupPick(sel)) return sel.value;
  const inp = el(idPrefix + '-gnew');
  const name = inp ? inp.value.trim() : '';
  if (!name) return fallback;
  addGroup(name); // в конец списка (инвариант 13)
  return name;
}

function editForm(it) {
  const head = `
    <div class="card form" data-form="edit" data-id="${esc(it.id)}">
      <label class="field"><span>Название</span><input type="text" id="e-name" value="${esc(it.name)}"></label>
      <label class="field"><span>Подпись</span><input type="text" id="e-note" value="${esc(it.note || '')}" placeholder="необязательная строка под названием"></label>`;
  // Здесь стояла ссылка «Формула и лестница ›» — вход в лист детали, и
  // предупреждение о том, что у пункта с лестницей подпись на дневных
  // экранах вытесняется ступенью. Обе механики сняты задачей 28.D: ссылке
  // некуда вести, а подпись снова показывается всегда и как есть.
  // «Убрать» живёт В ФОРМЕ, а не в строке: на 375 px строка занята именем,
  // стрелками и метой — места под ещё одну цель в ней нет (A.3.1)
  const foot = removeFoot('item', it.id,
    `<button class="btn primary" data-act="edit-save" data-id="${esc(it.id)}">Сохранить</button>
        <button class="btn quiet" data-act="edit-cancel">Отмена</button>`) + `
    </div>`;
  if (it.type === 'param') {
    // вид фиксируется при создании (инвариант 10) — не селект, а тихая строка
    return head + `
      <p class="muted">Вид: ${it.pkind === 'number' ? 'число' : 'время'}</p>
      ${it.pkind === 'number'
        ? `<div class="pair">
            <label class="field"><span>Порог</span><input class="num" type="text" inputmode="decimal" id="e-pvalue" value="${esc(it.pvalue)}"></label>
            <label class="field"><span>Единица</span><input type="text" id="e-punit" value="${esc(it.unit || '')}"></label>
          </div>`
        : `<label class="field"><span>Порог</span><input id="e-ptime" type="time" value="${esc(fmtParam(it))}"></label>`}
      <label class="field"><span>Шаг (со знаком)</span><input class="num" type="text" inputmode="decimal" id="e-pstep" value="${esc(it.pstep)}"></label>
      ${groupField('e', it.group)}` + foot;
  }
  if (it.area === 'habit') {
    // привычка: название, подпись и норма недели степпером (границы 1–7)
    const n = ui.editNorm !== null ? ui.editNorm : (it.normPerWeek || 7);
    return head + `
      <div class="field inline norm">
        <span>Норма в неделю: <b>${n}</b></span>
        <span class="btns">
          <button type="button" class="btn icon quiet" data-act="norm-dec" data-id="${esc(it.id)}"${n <= 1 ? ' disabled' : ''} aria-label="уменьшить норму">&minus;</button>
          <button type="button" class="btn icon quiet" data-act="norm-inc" data-id="${esc(it.id)}"${n >= 7 ? ' disabled' : ''} aria-label="увеличить норму">+</button>
        </span>
      </div>
      ${groupField('e', it.group)}` + foot;
  }
  return head + `
      <div class="pair">
        <label class="field"><span>Значение</span><input class="num" type="text" inputmode="decimal" id="e-value" value="${esc(it.value)}"></label>
        <label class="field"><span>Единица</span><input type="text" id="e-unit" value="${esc(it.unit || '')}"></label>
      </div>
      ${groupField('e', it.group)}
      ${it.type === 'weekly' ? `<label class="field"><span>Цель за неделю</span><input class="num" type="text" inputmode="numeric" id="e-goal" value="${esc(it.goal)}"></label>` : ''}` + foot;
}

function addForm() {
  const hint = ui.addHint
    ? `<p class="hint">Правило системы: одна новая привычка за раз. Последний пункт добавлен меньше 14 дней назад.</p>`
    : '';
  const head = `
    <div class="card form" data-form="add">
      ${hint}
      <label class="field"><span>Название</span><input type="text" id="f-name" placeholder="Например: чтение"></label>
      <label class="field"><span>Подпись</span><input type="text" id="f-note" placeholder="необязательная строка под названием"></label>`;
  const foot = `
      <div class="btns">
        <button class="btn primary" data-act="add-save">Добавить</button>
        <button class="btn quiet" data-act="add-cancel">Отмена</button>
      </div>
    </div>`;
  if (ui.addArea === 'habit') {
    const isParam = ui.addType === 'param';
    return head + `
      <label class="field"><span>Тип</span>
        <select id="f-type" data-act="add-type">
          <option value="daily"${isParam ? '' : ' selected'}>привычка (ежедневная)</option>
          <option value="param"${isParam ? ' selected' : ''}>параметр (порог недели)</option>
        </select>
      </label>
      ${isParam ? `
      <label class="field"><span>Вид</span>
        <select id="f-pkind" data-act="add-pkind">
          <option value="time"${ui.addPkind === 'number' ? '' : ' selected'}>время</option>
          <option value="number"${ui.addPkind === 'number' ? ' selected' : ''}>число</option>
        </select>
      </label>
      ${ui.addPkind === 'number'
        ? `<div class="pair">
            <label class="field"><span>Порог</span><input class="num" type="text" inputmode="decimal" id="f-pvalue" placeholder="4000"></label>
            <label class="field"><span>Единица</span><input type="text" id="f-punit" placeholder="шаг."></label>
          </div>`
        : `<label class="field"><span>Порог</span><input id="f-ptime" type="time" value="00:00"></label>`}
      <label class="field"><span>Шаг (со знаком)</span><input class="num" type="text" inputmode="decimal" id="f-pstep" placeholder="-15"></label>` : ''}
      ${groupField('f', '')}` + foot;
  }
  return head + `
      <div class="pair">
        <label class="field"><span>Значение</span><input class="num" type="text" inputmode="decimal" id="f-value" placeholder="10"></label>
        <label class="field"><span>Единица</span><input type="text" id="f-unit" placeholder="мин"></label>
      </div>
      ${groupField('f', '')}
      <label class="field"><span>Тип</span>
        <select id="f-type" data-act="add-type">
          <option value="daily"${ui.addType === 'weekly' ? '' : ' selected'}>ежедневный чекбокс</option>
          <option value="weekly"${ui.addType === 'weekly' ? ' selected' : ''}>недельный счётчик с целью</option>
        </select>
      </label>
      ${ui.addType === 'weekly' ? `<label class="field"><span>Цель за неделю</span><input class="num" type="text" inputmode="numeric" id="f-goal" value="3"></label>` : ''}` + foot;
}

/* Экран 4 — «Система» */
/* Тексты «Системы» — секция «Настроек» (задача 16B), не отдельный экран */
function systemSection() {
  let h = '';
  for (const s of SYSTEM_TEXTS) {
    h += `<section class="sys"><h2>${esc(s.title)}</h2>`;
    if (s.kind === 'rules') {
      h += `<ol class="rules">` + s.items.map(r => `<li>${esc(r)}</li>`).join('') + `</ol>`;
    } else if (s.kind === 'leads') {
      h += s.items.map(x => `<p class="lead-p"><strong>${esc(x.lead)}</strong> ${esc(x.text)}</p>`).join('');
    } else if (s.kind === 'note') {
      h += `<p class="note-block">${esc(s.text)}</p>`;
    }
    h += `</section>`;
  }
  return h;
}

/* ── Обработчики ───────────────────────────────────────────── */

function parseNum(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/* Единая валидация пользовательского ввода чисел: только > 0, иначе null */
function parsePositive(v) {
  const n = parseNum(v);
  return n !== null && n > 0 ? n : null;
}

/* ── Листы поверх вкладок (задача 26, п. 4) ────────────────────
   ДВА листа: разбор недели и тренировка. Третьим был лист детали пункта,
   снятый вместе с формулой и лестницей (задача 28.D). Оба возвращают
   прежнюю вкладку с прежним скроллом и фокусом — каким бы путём ни
   закрывались: кнопкой «Готово» или таб-баром. Прежде скролл и фокус
   возвращали только кнопки, а таб-бар ронял экран наверх. */

/* Куда вернёт закрытие открытого сейчас листа: вкладка, её скролл и
   кнопка, которой лист открыт. Зовётся ДО close*(), пока состояние цело.
   Порядок проверок — как в renderAll: разбор главнее тренировки. */
function sheetReturn() {
  const src = ui.sheetSrc;
  if (ui.reviewOpen) return { tab: ui.reviewFrom || ui.tab, y: ui.reviewScroll, src };
  if (ui.trainOpen) return { tab: ui.trainFrom || ui.tab, y: ui.trainScroll, src };
  return null;
}

/* Фокус — в открытый лист: заголовок несёт tabindex="-1", чтобы клавиатура
   и чтение с экрана начинались с листа, а не с начала документа. Ловушки
   фокуса нет: лист закрывается таб-баром, запирать в нём нельзя (п. 4.3). */
function focusSheet(id) {
  const h = document.querySelector('#' + id + ' h1');
  // preventScroll: скроллом распоряжается renderAll и sheetReturn, а не фокус
  if (h && typeof h.focus === 'function') h.focus({ preventScroll: true });
}

/* Фокус обратно на кнопку-источник. Узел к этому моменту пересоздан
   перерисовкой, поэтому помним не ссылку, а действие и пункт. Зовётся
   ПОСЛЕ возврата скролла: кнопка тогда уже на экране и фокус его не двинет. */
function focusSrc(src) {
  if (!src) return;
  // Кнопка ищется в пределах ВИДИМОГО экрана — тот же приём, что у
  // visibleFlash (задача 27.1, Д4), и тот же класс дефекта: renderAll рисует
  // одну текущую вкладку, а прочие экраны сохраняют прежнюю разметку. Баннер
  // разбора (`goto-review`) стоит и на «Сегодня», и на «Прогрессе», и data-id
  // у него нет ни там, ни там — выборка по всему документу отдавала list[0],
  // то есть узел «Сегодня». Замер: разбор, открытый с «Прогресса», возвращал
  // фокус на кнопку внутри scr-today при hidden = true (задача 28.B, п. 3).
  const list = [...document.querySelectorAll(`main .screen:not([hidden]) [data-act="${src.act}"]`)];
  const btn = src.id ? list.find(x => x.dataset.id === src.id) : list[0];
  if (btn && typeof btn.focus === 'function') btn.focus({ preventScroll: true });
}

/* Лист разбора закрывается и таб-баром — как лист тренировки */
function closeReview() {
  ui.reviewOpen = false;
  ui.reviewFrom = null;
  // свёртка недели принадлежит открытому разбору: следующий открывается
  // в состоянии по умолчанию, а не с чужой памятью (задача 24, п. 9.1)
  ui.weekOpen = null;
  ui.sheetSrc = null;
}

function closeTrain() {
  ui.trainOpen = false;
  ui.trainId = null;
  ui.trainFrom = null;
  ui.trainDraft = {}; // черновик принадлежал закрытому листу
  ui.sheetSrc = null;
}

/* Взведённое подтверждение вторым тапом — временное состояние одного
   экрана, а не решение владельца: уход с экрана его снимает (задача 22,
   п. 4). Иначе «Подтвердить: стереть» переживало смену вкладки, и один
   тап по возвращении стирал всё. Список полный и живёт здесь одним
   местом: новое подтверждение добавляется сюда, а не в обработчики. */
function resetConfirms() {
  ui.wipeConfirm = false;
  ui.wipeDropConfirm = false;
  ui.corruptDropConfirm = null;
  ui.mirrorRestoreConfirm = false;
  ui.mirrorKeepConfirm = false;
  ui.groupDelete = null;
  ui.weekCloseConfirm = false;
  ui.removeConfirm = null;
}

/* ── Перетаскивание (задача 16F) ───────────────────────────────
   Pointer Events без библиотек. Захват — долгим нажатием (250 мс):
   до него любое движение считается скроллом. Соседи раздвигаются
   CSS-переходом (при reduced-motion — мгновенно, глобальный блок).
   Стрелки ↑↓ остаются: перетаскивание их не заменяет, а дополняет.
   Пункт двигается только среди соседей по блоку — как и стрелками. */

const DRAG_HOLD = timing('DRAG_HOLD', 250);   // мс удержания до захвата
const DRAG_SLOP = 8;     // px до захвата: это скролл, а не перетаскивание (не время — не в TIMING)
const DRAG_CLICK_MS = timing('DRAG_CLICK_MS', 300); // сколько глушить клик после перетаскивания
const DRAG_EDGE = 64;    // px от края экрана, где включается автоскролл
const DRAG_SPEED = 12;   // px за кадр автоскролла
const DRAG_OUT = 60;     // px вбок от списка — отмена

let drag = null;
let dragSuppressClick = false; // тап после перетаскивания не открывает форму
let dragClickTimer = null;     // страховка: флаг снимается, если клика не последовало

function dragSiblings(row) {
  const kind = row.dataset.drag;
  const g = row.dataset.dgroup;
  return [...row.parentElement.children].filter(n =>
    n.dataset && n.dataset.drag === kind && (kind !== 'item' || n.dataset.dgroup === g));
}

function dragDown(e) {
  if (drag || (typeof e.button === 'number' && e.button > 0)) return;
  const row = e.target.closest ? e.target.closest('[data-drag]') : null;
  if (!row) return;
  // стрелки, тумблер и открытая форма живут своей жизнью
  if (e.target.closest('.ictl, .card.form, input, textarea, select')) return;
  drag = {
    row, kind: row.dataset.drag, id: row.dataset.dragId || '',
    x: e.clientX, y: e.clientY, startY: e.clientY, startX: e.clientX,
    active: false, from: -1, to: -1, sibs: [], mids: [], h: 0, listRect: null,
    raf: null,
    timer: setTimeout(dragActivate, DRAG_HOLD)
  };
  document.addEventListener('pointermove', dragMove, { passive: false });
  document.addEventListener('pointerup', dragUp);
  document.addEventListener('pointercancel', dragStop);
  document.addEventListener('keydown', dragKey);
}

/* Захват: замер соседей в координатах документа — автоскролл во время
   перетаскивания не должен сбивать расчёт позиции */
function dragActivate() {
  if (!drag) return;
  const sc = window.scrollY || 0;
  drag.sibs = dragSiblings(drag.row);
  drag.from = drag.sibs.indexOf(drag.row);
  if (drag.sibs.length < 2 || drag.from < 0) { dragStop(); return; }
  drag.mids = drag.sibs.map(n => {
    const r = n.getBoundingClientRect();
    return r.top + r.height / 2 + sc;
  });
  const own = drag.row.getBoundingClientRect();
  drag.h = own.height || 56;
  // смещение центра строки относительно пальца в момент захвата
  drag.offset = drag.mids[drag.from] - (drag.y + sc);
  drag.listRect = drag.row.parentElement.getBoundingClientRect();
  drag.active = true;
  drag.to = drag.from;
  drag.row.classList.add('drag-live');
  document.body.classList.add('dragging');
  // iOS: скролл страницы во время перетаскивания глушится непассивным touchmove
  document.addEventListener('touchmove', dragTouch, { passive: false });
  dragFrame();
}

function dragTouch(e) { if (drag && drag.active) e.preventDefault(); }

/* Автоскролл у краёв экрана — отдельным кадром, чтобы работал и когда
   палец стоит на месте у края */
function dragFrame() {
  if (!drag || !drag.active) return;
  const vh = window.innerHeight || 812;
  let d = 0;
  if (drag.y < DRAG_EDGE) d = -DRAG_SPEED;
  else if (drag.y > vh - DRAG_EDGE) d = DRAG_SPEED;
  if (d) { window.scrollBy(0, d); dragApply(); }
  drag.raf = (window.requestAnimationFrame || setTimeout)(dragFrame, 16);
}

/* Положение перетаскиваемой строки и раздвижение соседей */
function dragApply() {
  if (!drag || !drag.active) return;
  const center = drag.y + (window.scrollY || 0) + drag.offset;
  let to = 0;
  drag.mids.forEach((m, k) => { if (k !== drag.from && m < center) to++; });
  drag.to = to;
  drag.row.style.transform = `translateY(${center - drag.mids[drag.from]}px) scale(1.03)`;
  drag.sibs.forEach((n, k) => {
    if (k === drag.from) return;
    let dy = 0;
    if (to > drag.from && k > drag.from && k <= to) dy = -drag.h;
    else if (to < drag.from && k >= to && k < drag.from) dy = drag.h;
    n.style.transform = dy ? `translateY(${dy}px)` : '';
  });
}

function dragMove(e) {
  if (!drag) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.active) {
    // движение до захвата — это скролл: удержание отменяется
    if (Math.abs(e.clientY - drag.startY) > DRAG_SLOP || Math.abs(e.clientX - drag.startX) > DRAG_SLOP) dragStop();
    return;
  }
  e.preventDefault();
  // уход пальца за пределы списка вбок — отмена без записи
  if (drag.listRect && (e.clientX < drag.listRect.left - DRAG_OUT || e.clientX > drag.listRect.right + DRAG_OUT)) {
    dragStop();
    return;
  }
  dragApply();
}

function dragKey(e) { if (e.key === 'Escape') dragStop(); } // отмена с клавиатуры

function dragUp() {
  if (!drag) return;
  const { active, kind, id, from, to } = drag;
  dragStop();
  if (!active || to === from || to < 0) return;
  const ok = kind === 'item' ? reorderItem(id, to)
    : kind === 'group' ? reorderGroup(id, to)
      : reorderExercise(id, to);
  if (ok) renderSettings(); // перестановка — структурное изменение
}

/* Снятие захвата: стили сняты, слушатели убраны, модель не тронута */
function dragStop() {
  if (!drag) return;
  clearTimeout(drag.timer);
  if (drag.raf !== null) (window.cancelAnimationFrame || clearTimeout)(drag.raf);
  if (drag.active) {
    dragSuppressClick = true;
    // клик приходит сразу за отпусканием пальца; если его не будет вовсе
    // (pointercancel, отмена с клавиатуры), флаг снимается сам и не глотает
    // следующий, уже не связанный с перетаскиванием тап (аудит, находка 29)
    clearTimeout(dragClickTimer);
    dragClickTimer = setTimeout(() => { dragSuppressClick = false; }, DRAG_CLICK_MS);
    drag.row.classList.remove('drag-live');
    drag.row.style.transform = '';
    drag.sibs.forEach(n => { n.style.transform = ''; });
    document.body.classList.remove('dragging');
    document.removeEventListener('touchmove', dragTouch);
  }
  document.removeEventListener('pointermove', dragMove);
  document.removeEventListener('pointerup', dragUp);
  document.removeEventListener('pointercancel', dragStop);
  document.removeEventListener('keydown', dragKey);
  drag = null;
}

function onClick(e) {
  // клик, родившийся из перетаскивания, форму не открывает
  if (dragSuppressClick) { dragSuppressClick = false; return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (syncDay()) return; // stale-экран: действие не применяется (инвариант 8)
  const hadImportNote = ui.importNote !== null;
  ui.importNote = null; // строка «Импортировано…» живёт до следующего действия
  // и строка «убран — Вернуть» тоже: короткий путь назад открыт до
  // следующего действия владельца, а не до таймера (A.3.4)
  ui.goneNote = null;
  // и якорь подтверждения тоже: не отданный прошлым рендером, он не должен
  // всплыть позже у чужого действия (задача 26, п. 2.1)
  ui.savedAt = null;
  // область объявлений чистится здесь же: скринридер объявляет ИЗМЕНЕНИЕ
  // текста, и повторный тот же отказ после другого действия обязан снова
  // читаться как изменение (задача 27.1, п. 9.2)
  announce('');
  const act = b.dataset.act;
  const id = b.dataset.id;
  const item = id ? store.items.find(i => i.id === id) : null;

  switch (act) {
    // разбор — лист поверх вкладки: помним, откуда открыт и с каким скроллом
    case 'goto-review':
      ui.missOpen = {}; // уход с дневного экрана — как в таб-баре
      ui.raiseEdit = {};
      ui.reviewScroll = window.scrollY || 0;
      ui.reviewFrom = ui.tab;
      ui.reviewOpen = true;
      ui.sheetSrc = { act, id: id || '' };
      renderAll();
      focusSheet('scr-review');
      break;

    case 'review-done': {
      const back = sheetReturn();
      closeReview();
      resetConfirms(); // «Готово» уводит с листа — как таб-бар
      if (back && back.tab) ui.tab = back.tab;
      renderAll();
      if (back) { window.scrollTo(0, back.y); focusSrc(back.src); } // прежняя вкладка, скролл и фокус
      break;
    }

    // сворачивание секции «Настроек»: раскрытие делает сам details,
    // здесь только запоминается состояние — перерисовка его не теряет
    case 'sect':
      if (b.dataset.sect in ui.settingsOpen) ui.settingsOpen[b.dataset.sect] = !ui.settingsOpen[b.dataset.sect];
      break;

    case 'miss-note': {
      ui.missOpen[id] = !ui.missOpen[id];
      renderDayScreen();
      // вернуть фокус пересозданной кнопке — disclosure-паттерн остаётся рабочим для AT
      const dot = [...dayScreenEl().querySelectorAll('[data-act="miss-note"]')].find(d => d.dataset.id === id);
      if (dot) dot.focus();
      break;
    }

    case 'mark-yesterday': {
      markYesterday(id); // guard'ы внутри; «вчера» актуален — stale-guard уже отработал
      delete ui.missOpen[id];
      renderDayScreen(); // структурный путь: точка исчезает
      const cb = [...dayScreenEl().querySelectorAll('input[data-act="mark"]')].find(i => i.dataset.id === id);
      if (cb) cb.focus();
      break;
    }

    // «+» открывает лист тренировки: сначала записывается, что сделано
    case 'train-inc':
      ui.trainScroll = window.scrollY || 0;
      ui.trainFrom = ui.tab;
      ui.trainId = id;
      ui.trainDraft = {}; // новый лист — чистые поля
      // прежний лист остаётся в DOM скрытым; чистим разметку, иначе снимок
      // черновика подхватит его поля как «текущие» (у листа тот же ключ)
      el('scr-train').innerHTML = '';
      ui.trainOpen = true;
      ui.sheetSrc = { act, id };
      renderAll();
      focusSheet('scr-train');
      break;

    case 'train-save': {
      const list = liveExercises();
      const entries = list.map(ex => {
        const inp = el('ex-' + ex.id);
        return { exId: ex.id, value: inp ? parsePositive(inp.value) : null };
      });
      // заполнять было что, но не заполнено ничего — записывать нечего
      // (задача 22, п. 7.4): ни сессии, ни счётчика. Упражнений нет вовсе —
      // поведение прежнее: лист вырождается в подтверждение «тренировка была»,
      // и это единственный способ засчитать её (решение архитектора).
      if (list.length && !entries.some(e => e.value !== null)) {
        // отказ молчаливым не бывает: лист остаётся и говорит — той же
        // строкой у кнопки, что и все прочие формы (задача 26, п. 2.5)
        refuse(b, 'Нечего записать: ни одно упражнение не заполнено');
        break;
      }
      const note = el('tr-note') ? el('tr-note').value : '';
      const back = sheetReturn(), weekly = ui.trainId;
      recordSession(weekly, entries, note);
      closeTrain();
      resetConfirms();
      if (back && back.tab) ui.tab = back.tab;
      renderAll();
      if (back) { window.scrollTo(0, back.y); focusSrc(back.src); }
      break;
    }

    case 'train-cancel': { // ничего не пишет
      const back = sheetReturn();
      closeTrain();
      resetConfirms();
      if (back && back.tab) ui.tab = back.tab;
      renderAll();
      if (back) { window.scrollTo(0, back.y); focusSrc(back.src); }
      break;
    }

    // шаг ±1 правит поле на месте: перерисовка листа сбросила бы соседние
    case 'ex-step': {
      const inp = el('ex-' + id);
      if (!inp) break;
      const cur = parseNum(inp.value);
      const next = Math.round(((cur === null ? 0 : cur) + (b.dataset.dir === 'up' ? 1 : -1)) * 100) / 100;
      // вниз до нуля не доводим (задача 22, п. 7.5): сессия берёт только
      // значение > 0, а ноль в поле «Записать» молча выбросил бы — поле
      // показывало бы одно, а записалось бы другое
      if (!(next > 0)) break;
      inp.value = String(next);
      break;
    }

    case 'ex-add-open': openSettingsForm(() => { ui.exAddOpen = true; }); break;
    case 'ex-add-cancel': dropOpenDraft(); ui.exAddOpen = false; renderSettings(); break;
    case 'ex-add-save': {
      const name = el('x-add-name') ? el('x-add-name').value.trim() : '';
      if (!name) { refuse(b, 'Название не заполнено'); break; } // безымянное упражнение не заводится
      const raw = el('x-add-value') ? el('x-add-value').value : '';
      // нагрузка необязательна, но написанная и непринятая — отказ, а не тишина
      if (String(raw).trim() && parsePositive(raw) === null) {
        refuse(b, 'Нагрузка не принята: нужно число больше нуля');
        break;
      }
      const ex = addExercise(name, el('x-add-unit') ? el('x-add-unit').value : '', parsePositive(raw));
      ui.exAddOpen = false;
      if (ex) flashWrite('ex:' + ex.id); // подтверждение — у только что заведённой строки
      keepInPlace(b, renderSettings);
      break;
    }
    case 'ex-open': openSettingsForm(() => { ui.exEditingId = id; }); break;
    case 'ex-cancel': dropOpenDraft(); ui.exEditingId = null; renderSettings(); break;
    case 'ex-save': {
      const name = el('x-name') ? el('x-name').value.trim() : '';
      if (!name) { refuse(b, 'Название не заполнено'); break; }
      updateExercise(id, name, el('x-unit') ? el('x-unit').value : '');
      ui.exEditingId = null;
      flashWrite('ex:' + id);
      keepInPlace(b, renderSettings);
      break;
    }
    case 'ex-up':
    case 'ex-down': {
      if (!moveExercise(id, act === 'ex-up' ? 'up' : 'down')) break;
      renderSettings();
      // фокус — той же кнопке пересозданной строки, как у пунктов
      const find = a => [...el('scr-settings').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.id === id);
      const same = find(act);
      const pair = find(act === 'ex-up' ? 'ex-down' : 'ex-up');
      if (same && !same.disabled) same.focus();
      else if (pair) pair.focus();
      break;
    }
    case 'train-undo': {
      // баннер хранилища ушёл из разметки экрана в постоянный узел
      // (задача 27.1, п. 5.2) — его появление больше не структурный путь
      // и перерисовки не требует: storageNote() обновляет его сам
      undoTrain(id);
      updateWeekCount(id);
      break;
    }

    case 'raise-edit': ui.raiseEdit[id] = true; renderReview(); break;
    case 'raise-later':
      if (item) { resetRaiseCount(item); delete ui.raiseEdit[id]; motionLeave(b.closest('.card'), renderReview); }
      break;
    // понижение планки: шаг применяется немедленно и уходит в срез недели,
    // «Оставить» просто фиксирует решение — обе кнопки ставят якорь недели
    case 'lower-ok': {
      if (!item) break;
      const to = lowerSuggest(item.value);
      if (to === null) break;
      acceptLower(item, to);
      motionLeave(b.closest('.card'), renderReview);
      break;
    }

    case 'lower-keep':
      if (item) { keepBar(item); motionLeave(b.closest('.card'), renderReview); }
      break;

    case 'week-fold': // раскрытие свёртки делает сам details, здесь — только память
      ui.weekOpen = !weekFoldOpen(); // от состояния по умолчанию, а не от null
      break;

    case 'raise-ok': {
      if (!item) break;
      const input = el('raise-' + id);
      const v = input ? parsePositive(input.value) : raiseSuggest(item.value);
      // карточка остаётся — и говорит, почему (задача 26, п. 2.3): прежде
      // это был тихий no-op, и тап по «Принять» выглядел как промах
      if (v === null) { refuse(b, 'Планка не принята: нужно число больше нуля'); break; }
      acceptRaise(item, v);
      delete ui.raiseEdit[id];
      motionLeave(b.closest('.card'), renderReview); // карточка уходит, затем перерисовка
      break;
    }

    case 'param-step': if (applyParamStep(id)) motionLeave(b.closest('.card'), renderReview); break;
    case 'param-keep': if (keepParam(id)) motionLeave(b.closest('.card'), renderReview); break;

    case 'close-week':
      if (!ui.weekCloseConfirm) { ui.weekCloseConfirm = true; renderReview(); break; }
      ui.weekCloseConfirm = false;
      if (closeWeek()) ui.justClosed = true;
      renderReview();
      window.scrollTo(0, 0); // длинный экран разбора схлопывается — наверх
      break;

    case 'move-up':
    case 'move-down': {
      if (!moveItem(id, act === 'move-up' ? 'up' : 'down')) break;
      renderSettings();
      // вернуть фокус кнопке того же действия и пункта; на краю списка — парной
      const find = a => [...el('scr-settings').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.id === id);
      let btn = find(act);
      if (!btn || btn.disabled) btn = find(act === 'move-up' ? 'move-down' : 'move-up');
      if (btn && !btn.disabled) btn.focus();
      break;
    }

    case 'group-up':
    case 'group-down': {
      if (!moveGroup(b.dataset.name, act === 'group-up' ? 'up' : 'down')) break;
      ui.groupDelete = null;
      renderSettings();
      // фокус на кнопке того же действия и той же группы; на краю — парной
      const find = a => [...el('scr-settings').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.name === b.dataset.name);
      let btn = find(act);
      if (!btn || btn.disabled) btn = find(act === 'group-up' ? 'group-down' : 'group-up');
      if (btn && !btn.disabled) btn.focus();
      break;
    }
    case 'group-open': {
      // тап по раскрытой строке её сворачивает — цель считается ДО того,
      // как settingsFormsClosed обнулит ui.groupRename
      const next = ui.groupRename === b.dataset.name ? null : b.dataset.name;
      openSettingsForm(() => { ui.groupRename = next; });
      break;
    }
    case 'group-cancel':
      dropOpenDraft();
      ui.groupRename = null; ui.groupDelete = null; renderSettings();
      break;
    // Отказ больше не молчит и не закрывает форму: пустое или занятое имя
    // прежде уносило правку целиком — форма закрывалась, введённое пропадало
    // (задача 26, пп. 2.3–2.4)
    case 'group-save': {
      const from = b.dataset.name;
      const nm = el('g-name') ? el('g-name').value.trim() : '';
      if (!nm) { refuse(b, 'Название не заполнено'); break; }
      if (nm !== from && findGroup(nm)) { refuse(b, 'Блок с таким именем уже есть'); break; }
      renameGroup(from, nm);
      ui.groupRename = null;
      ui.groupDelete = null;
      flashWrite('group:' + nm);
      keepInPlace(b, renderSettings);
      break;
    }
    case 'group-del': {
      if (ui.groupDelete !== b.dataset.name) { ui.groupDelete = b.dataset.name; renderSettings(); break; }
      deleteGroup(b.dataset.name); // пункты остаются, отметки не трогаются
      ui.groupDelete = null;
      ui.groupRename = null;
      renderSettings();
      break;
    }
    // раскрыт один: «Добавить блок» закрывает открытую правку блока, как
    // «Добавить упражнение» закрывает правку упражнения (задача 27, п. 7.4)
    case 'group-add-open': openSettingsForm(() => { ui.groupAdd = true; }); break;
    case 'group-add-cancel': dropOpenDraft(); ui.groupAdd = false; renderSettings(); break;
    case 'group-add-save': {
      const inp = el('g-add');
      const nm = inp ? inp.value.trim() : '';
      if (!nm) { refuse(b, 'Название не заполнено'); if (inp) inp.focus(); break; }
      if (findGroup(nm)) { refuse(b, 'Блок с таким именем уже есть'); if (inp) inp.focus(); break; }
      addGroup(nm);
      ui.groupAdd = false;
      flashWrite('group:' + nm); // подтверждение — у только что заведённой строки
      keepInPlace(b, renderSettings);
      break;
    }

    case 'edit-open':
      // поле «Блок» открывается на значении пункта: groupPick/groupNew
      // гасит settingsFormsClosed вместе с прочими формами экрана
      openSettingsForm(() => { ui.editingId = id; });
      break;
    case 'edit-cancel':
      dropOpenDraft();
      ui.editingId = null; ui.editNorm = null; ui.groupPick = null; ui.groupNew = false;
      renderSettings();
      break;

    /* Уход пункта — вторым тапом (A.3.2). Первый взводит и печатает
       последствие ПОД кнопкой, поэтому сама кнопка с места не двигается.
       Второй убирает и оставляет на месте строки короткий путь назад.

       Отказ записи говорит строкой у той же кнопки и формы не закрывает:
       removeItem уже откатил поле, и в памяти ровно то же, что на диске. */
    case 'item-remove':
    case 'ex-remove': {
      const kind = act === 'item-remove' ? 'item' : 'ex';
      const key = kind + ':' + id;
      if (ui.removeConfirm !== key) { ui.removeConfirm = key; renderSettings(); break; }
      ui.removeConfirm = null;
      if (!(kind === 'item' ? removeItem(id) : removeExercise(id))) {
        refuse(b, 'Не убрано: хранилище недоступно');
        break;
      }
      dropOpenDraft();               // форма ушла вместе со строкой
      settingsFormsClosed();
      ui.goneNote = id;
      // строка «убран» встаёт туда, где стояла кнопка: форма схлопывается,
      // и без этого точка нажатия уехала бы вверх (механика keepInPlace)
      keepInPlace(b, renderSettings, goneNoteEl);
      const back = goneNoteEl();
      if (back) { const u = back.querySelector('.undo'); if (u) u.focus(); }
      break;
    }

    /* Возврат. В тот же день — полная отмена, позже — новая запись
       (restoreItem/restoreExercise, инвариант 12). Обе дороги назад,
       короткая и длинная, ведут сюда. */
    case 'item-restore':
    case 'ex-restore': {
      const kind = act === 'item-restore' ? 'item' : 'ex';
      const made = kind === 'item' ? restoreItem(id) : restoreExercise(id);
      if (!made) { refuse(b, 'Не возвращено: хранилище недоступно'); break; }
      flashWrite(kind + ':' + made.id); // подтверждение — у вернувшейся строки
      keepInPlace(b, renderSettings);
      break;
    }

    case 'norm-dec':
    case 'norm-inc': {
      if (!item) break;
      const cur = ui.editNorm !== null ? ui.editNorm : (item.normPerWeek || 7);
      const next = Math.max(1, Math.min(7, cur + (act === 'norm-inc' ? 1 : -1)));
      if (next === cur) break;
      ui.editNorm = next;
      renderSettings();
      // вернуть фокус кнопке того же действия; на границе — парной (как у «выше/ниже»)
      const find = a => [...el('scr-settings').querySelectorAll(`[data-act="${a}"]`)].find(x => x.dataset.id === id);
      let btn = find(act);
      if (!btn || btn.disabled) btn = find(act === 'norm-inc' ? 'norm-dec' : 'norm-inc');
      if (btn && !btn.disabled) btn.focus();
      break;
    }
    case 'thr-dec':
    case 'thr-inc': {
      const cur = dayThreshold();
      const next = clampThreshold(cur + (act === 'thr-inc' ? THRESHOLD_STEP : -THRESHOLD_STEP));
      if (next === cur) break;
      store.settings.dayThreshold = next;
      save();
      renderSettings();
      // фокус — той же кнопке; на границе диапазона парной (как у нормы недели)
      let btn = el('scr-settings').querySelector(`[data-act="${act}"]`);
      if (!btn || btn.disabled) {
        btn = el('scr-settings').querySelector(`[data-act="${act === 'thr-inc' ? 'thr-dec' : 'thr-inc'}"]`);
      }
      if (btn && !btn.disabled) btn.focus();
      break;
    }

    /* Форма правки пункта. Порядок жёсткий: сначала ВСЕ проверки, потом
       запись. Прежде поля писались по ходу, невалидное число молча
       оставляло старое значение, а форма всё равно закрывалась с
       «Сохранено» — приложение говорило «сохранено» о том, что выбросило
       (задача 26, п. 2.2). Теперь первый же непринятый ввод — отказ:
       форма остаётся открытой, введённое не переписано, в store не
       записано ничего (п. 2.4). Сообщается первый отказ: строка короткая,
       и владелец правит по одному полю. */
    case 'edit-save': {
      if (!item) break;
      const name = el('e-name').value.trim();
      if (!name) { refuse(b, 'Название не заполнено'); break; }
      let pv = null, pstep = null, value, goal = null;
      if (item.type === 'param') {
        // pkind фиксирован при создании — правятся только порог, единица и шаг
        if (item.pkind === 'number') {
          const n = parseNum(el('e-pvalue') ? el('e-pvalue').value : '');
          if (n === null) { refuse(b, 'Порог не принят: нужно число'); break; }
          pv = n;
        } else {
          const m = /^(\d{1,2}):(\d{2})$/.exec((el('e-ptime') ? el('e-ptime').value : '') || '');
          if (!m) { refuse(b, 'Порог не принят: нужно время вида 23:30'); break; }
          pv = Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
        }
        const st = parseNum(el('e-pstep') ? el('e-pstep').value : '');
        if (st === null) { refuse(b, 'Шаг не принят: нужно число со знаком'); break; }
        pstep = Math.round(st);
      } else if (item.area !== 'habit') {
        const rawValue = el('e-value').value;
        if (!String(rawValue).trim()) {
          value = null; // осознанная очистка: пункт остаётся чекбоксом без числа, история не трогается
        } else {
          value = parsePositive(rawValue);
          if (value === null) { refuse(b, 'Значение не принято: нужно число больше нуля'); break; }
        }
        if (item.type === 'weekly') {
          const g = parsePositive(el('e-goal') ? el('e-goal').value : null);
          if (g === null || Math.round(g) < 1) { refuse(b, 'Цель не принята: нужно целое число от 1'); break; }
          goal = Math.round(g);
        }
      }
      // проверки пройдены — запись
      item.name = name;
      item.note = el('e-note').value.trim();
      if (item.type === 'param') {
        if (item.pkind === 'number' && el('e-punit')) item.unit = el('e-punit').value.trim();
        if (pv !== item.pvalue) { item.pvalue = pv; recordBar(item, pv); } // история — по общим правилам
        item.pstep = pstep;
      } else if (item.area !== 'habit') {
        if (value === null) item.value = null;
        else if (value !== item.value) { item.value = value; recordBar(item, value); }
        item.unit = el('e-unit').value.trim();
        if (item.type === 'weekly') item.goal = goal;
      } else if (ui.editNorm !== null) {
        item.normPerWeek = Math.max(1, Math.min(7, ui.editNorm)); // ежедневная привычка: норма недели
      }
      // блок — поле всех форм, а не только минимума (задача 19, B.3): блоки
      // работали на «Привычках», но назначить их привычке и параметру было
      // нечем. Без поля в форме readGroupField возвращает прежнее значение.
      item.group = readGroupField('e', item.group);
      save();
      ui.editingId = null;
      ui.editNorm = null;
      ui.groupPick = null;
      ui.groupNew = false;
      flashWrite('item:' + id); // тихое подтверждение у той же строки (задача 26)
      keepInPlace(b, renderSettings);
      break;
    }

    case 'add-open': {
      const area = b.dataset.area === 'habit' ? 'habit' : 'min';
      // Подсказка «одна новая привычка за раз» видима все 14 дней после
      // добавления пункта — но считается только по добавленному владельцем
      const newest = ownerNewestItem();
      const hint = !!(newest && diffDays(todayKey(), newest.addedAt) < 14);
      openSettingsForm(() => {
        ui.addOpen = true; ui.addType = 'daily'; ui.addArea = area; ui.addPkind = 'time';
        ui.addHint = hint;
      });
      break;
    }
    case 'add-cancel':
      dropOpenDraft();
      ui.addOpen = false; ui.addHint = false; ui.groupPick = null; ui.groupNew = false;
      renderSettings();
      break;
    /* Форма добавления — тот же порядок, что у правки: сначала проверки,
       потом создание (задача 26, пп. 2.2–2.5). Прежде пустое название
       молча ставило фокус в поле, а непринятое число подставляло
       умолчание — и пункт заводился не таким, каким его набрали. */
    case 'add-save': {
      const name = el('f-name').value.trim();
      if (!name) { refuse(b, 'Название не заполнено'); el('f-name').focus(); break; }
      const note = el('f-note').value.trim();
      let item;
      if (ui.addArea === 'habit' && ui.addType === 'param') {
        const pkind = el('f-pkind') && el('f-pkind').value === 'number' ? 'number' : 'time';
        let pvalue;
        if (pkind === 'time') {
          const m = /^(\d{1,2}):(\d{2})$/.exec((el('f-ptime') ? el('f-ptime').value : '') || '');
          if (!m) { refuse(b, 'Порог не принят: нужно время вида 23:30'); break; }
          pvalue = Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
        } else {
          const n = parseNum(el('f-pvalue') ? el('f-pvalue').value : '');
          if (n === null) { refuse(b, 'Порог не принят: нужно число'); break; }
          pvalue = n;
        }
        const st = parseNum(el('f-pstep') ? el('f-pstep').value : '');
        if (st === null) { refuse(b, 'Шаг не принят: нужно число со знаком'); break; }
        item = {
          id: uid(), name, value: null,
          unit: pkind === 'number' && el('f-punit') ? el('f-punit').value.trim() : '',
          note, group: readGroupField('f', ''),
          type: 'param', area: 'habit', pkind, pvalue,
          pstep: Math.round(st),
          goal: null, removedAt: null, addedAt: todayKey(), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
          history: [{ date: todayKey(), value: pvalue }]
        };
      } else if (ui.addArea === 'habit') {
        item = {
          id: uid(), name, value: null, unit: '', note, group: readGroupField('f', ''),
          type: 'daily', area: 'habit', normPerWeek: 7, // каноническая форма привычки (инвариант 11)
          goal: null, removedAt: null, addedAt: todayKey(), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: []
        };
      } else {
        const type = el('f-type').value === 'weekly' ? 'weekly' : 'daily';
        let goal = null;
        if (type === 'weekly') {
          const g = parsePositive(el('f-goal') ? el('f-goal').value : null);
          if (g === null || Math.round(g) < 1) { refuse(b, 'Цель не принята: нужно целое число от 1'); break; }
          goal = Math.round(g);
        }
        // значение необязательно; написанное и непринятое — отказ, а не «без числа»
        const rawValue = el('f-value').value;
        const value = String(rawValue).trim() ? parsePositive(rawValue) : null;
        if (String(rawValue).trim() && value === null) {
          refuse(b, 'Значение не принято: нужно число больше нуля');
          break;
        }
        item = {
          id: uid(), name, value,
          unit: el('f-unit').value.trim(),
          note,
          group: readGroupField('f', ''),
          type, area: 'min', goal,
          removedAt: null, addedAt: todayKey(), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
          history: (typeof value === 'number') ? [{ date: todayKey(), value }] : []
        };
      }
      store.items.push(item);
      save();
      ui.addOpen = false;
      ui.groupPick = null;
      ui.groupNew = false;
      flashWrite('item:' + item.id); // подтверждение у только что появившейся строки
      keepInPlace(b, renderSettings);
      break;
    }

    case 'export':
      exportJSON();
      renderSettings(); // обновить строку «Последний экспорт» (и погасить строку импорта)
      break;

    // ── чистка и её отмена (задача 16.1) ──────────────────────
    case 'wipe-open': ui.wipeOpen = true; ui.wipeConfirm = false; renderSettings(); break;
    case 'wipe-cancel': ui.wipeOpen = false; ui.wipeConfirm = false; renderSettings(); break;

    case 'wipe-do': {
      if (!ui.wipeConfirm) { ui.wipeConfirm = true; renderSettings(); break; } // второй тап
      // копию некуда положить — чистка не выполнена; молчать об этом нельзя:
      // владелец видел бы, что «Стереть» ничего не сделало (аудит, находка 20)
      if (!wipeAll()) { ui.wipeConfirm = false; ui.wipeFailed = true; renderSettings(); break; }
      ui.wipeFailed = false;
      // экран после чистки — «Сегодня» с пустым списком; ui-состояние,
      // указывавшее на исчезнувшие записи, снимается целиком
      ui.wipeOpen = false;
      ui.wipeConfirm = false;
      ui.wipeDropConfirm = false;
      ui.editingId = null;
      ui.addOpen = false;
      ui.exEditingId = null;
      ui.exAddOpen = false;
      ui.formDraft = {};
      ui.missOpen = {};
      ui.raiseEdit = {};
      closeReview();
      closeTrain();
      ui.tab = 'today';
      renderAll();
      break;
    }

    case 'wipe-undo':
      // возврат отказывает СТРОКОЙ, как чистка (задача 27, Д7): прежде
      // ветки else не было вовсе, и владелец видел кнопку, которая ничего
      // не сделала, — при том что в самой чистке про это написано прямо
      if (!restoreWiped()) { ui.restoreFailed = true; renderSettings(); break; }
      ui.restoreFailed = false;
      // взведённые подтверждения относились к ПРЕЖНИМ данным: «Подтвердить:
      // стереть» переживало возврат, и один тап уничтожал обмен, ради
      // которого копия и заводится (задача 27, Д7). Список один — resetConfirms
      ui.wipeOpen = false;
      resetConfirms();
      // копия могла нести другую границу дня — день и таймер заново,
      // тем же путём, что импорт (задача 27.1, п. 5.5)
      ui.renderedDayKey = todayKey();
      armDayTimer();
      ui.tab = 'settings';
      renderAll(); // вернулось всё сразу, включая дневные экраны
      break;

    case 'wipe-drop':
      if (!ui.wipeDropConfirm) { ui.wipeDropConfirm = true; renderSettings(); break; }
      dropWiped();
      ui.wipeDropConfirm = false;
      renderSettings();
      break;

    // ── нечитаемые данные (задача 25, п. 6; источников два — 28.A) ──
    case 'corrupt-save': {
      const src = b.dataset.src || 'data';
      const c = corruptCopy(src);
      if (c) download(CORRUPT_SRC[src].file + todayKey() + '.json', c.raw);
      break;
    }

    case 'corrupt-drop': {
      const src = b.dataset.src || 'data';
      if (ui.corruptDropConfirm !== src) { ui.corruptDropConfirm = src; renderSettings(); break; }
      dropCorrupt(src);
      // у зеркала «Убрать» снимает и сам нечитаемый снапшот: иначе каждый
      // следующий старт упирался бы в него и копия не велась бы никогда
      if (src === 'mirror') mirrorClear();
      ui.corruptDropConfirm = null;
      renderSettings();
      break;
    }

    // ── предложение восстановления из зеркала (задача 28.A, п. 2.2) ──
    case 'mirror-restore':
      if (!ui.mirrorRestoreConfirm) { ui.mirrorRestoreConfirm = true; renderSettings(); break; }
      ui.mirrorRestoreConfirm = false;
      if (!restoreMirror()) { ui.mirrorFailed = true; renderSettings(); break; }
      ui.mirrorFailed = false;
      // дальше — тот же хвост, что у «Вернуть» (задача 27, Д7; 27.1, п. 5.5):
      // состояние подменено целиком, взведённое и открытое к нему не относится,
      // а копия могла нести другую границу дня
      ui.wipeOpen = false;
      resetConfirms();
      ui.renderedDayKey = todayKey();
      armDayTimer();
      renderAll();
      break;

    case 'mirror-save':
      if (mirrorOffer) download('minimum-копия-' + todayKey() + '.json', JSON.stringify(mirrorOffer.store, null, 1));
      break;

    case 'mirror-keep':
      if (!ui.mirrorKeepConfirm) { ui.mirrorKeepConfirm = true; renderSettings(); break; }
      ui.mirrorKeepConfirm = false;
      keepWorking();
      renderSettings();
      break;

    case 'import':
      if (hadImportNote) renderSettings(); // до открытия диалога: file-input должен остаться в живом DOM
      el('import-file').click();
      break;
  }
}

function onChange(e) {
  const t = e.target;
  if (syncDay()) return; // stale-экран: действие не применяется (инвариант 8)
  ui.importNote = null;
  const act = t.dataset.act;
  if (act === 'mark') {
    // отказ хранилища больше не меняет разметку экрана: баннер — постоянный
    // узел вне экранов (задача 27.1, п. 5.2), и горячий путь остаётся горячим
    toggleMark(todayKey(), t.dataset.id);
    updateTodayMark(t);
  // Здесь стояли тумблеры пункта и упражнения (data-act toggle-active и
  // ex-active) с точечным обновлением класса .off и подписи зачёта дня.
  // Поле active упразднено вместе с ними (задача 28.E/A, п. 2): уход из
  // виду — теперь «Убрать» в форме правки, и он всегда полная перерисовка.
  } else if (act === 'boundary') {
    store.settings.dayBoundary = Number(t.value) || 0;
    save();
    armDayTimer(); // граница сместилась — таймер на новую; экран «Пункты» от неё не зависит, select держит фокус
    if (todayKey() !== ui.renderedDayKey) {
      // новая граница сдвинула логический день прямо сейчас — фиксируем без
      // перерисовки, иначе guard молча проглотит следующее действие
      ui.missOpen = {};
      ui.raiseEdit = {};
      ui.renderedDayKey = todayKey();
    }
  } else if (act === 'since') {
    // начало отсчёта: приводится к понедельнику своей недели. Дата вперёд
    // законна (задача 22, п. 8): пустая эпоха — обычное состояние приложения,
    // в неё же кладёт чистка, и владелец вправе назначить старт сам.
    const v = t.value;
    if (isDayKey(v)) {
      store.settings.calendarSince = weekStartOf(v);
      save();
    }
    t.value = store.settings.calendarSince; // поле показывает принятое значение
  } else if (act === 'group-pick') {
    // «+ Новый блок…» — последний вариант: раскрывает поле имени в форме
    ui.groupNew = isNewGroupPick(t);
    if (!ui.groupNew) ui.groupPick = t.value;
    renderSettings();
  } else if (act === 'add-type') {
    ui.addType = t.value;
    renderSettings(); // снимок/восстановление формы — внутри renderSettings, цель не сбрасывается
  } else if (act === 'add-pkind') {
    ui.addPkind = t.value === 'number' ? 'number' : 'time';
    renderSettings();
  } else if (t.id === 'import-file') {
    if (t.files && t.files[0]) importJSON(t.files[0]);
    t.value = '';
  }
}

function onInput(e) {
  if (e.target.dataset.bind === 'one-change') {
    store.draftOneChange = e.target.value;
    save();
  }
}

/* ── Запуск ────────────────────────────────────────────────── */

async function init() {
  // Стартовая проверка (инвариант 9): зеркало не пишется, пока она не завершена
  store = load();
  const fromLocal = !!store;
  if (fromLocal) {
    // localStorage валиден, но безоговорочным источником истины он больше
    // не признаётся (задача 28.A, п. 2.1): зеркало сверяется тоже — после
    // первого рендера, чтобы старт не удлинялся. До конца сверки
    // mirrorReady остаётся false, и save() зеркала не трогает.
    save(); // результат migrate на диск; в зеркало — после verifyMirror()
  } else {
    // localStorage пуст или бит (corrupt-ключ уже записан) — пробуем зеркало;
    // зависший IndexedDB (WebKit) не должен блокировать первый рендер
    const probe = await mirrorProbe(MIRROR_PROBE_MS);
    // непарсящийся снапшот — такой же отказ, как недочитанный (п. 1.1):
    // сырая строка откладывается на виду, а сам снапшот не трогается
    let readable = probe.status !== 'failed';
    if (probe.status === 'read') {
      store = mirrorParse(probe.snap);
      if (!store) { keepMirrorCorrupt(probe.snap); readable = false; }
    }
    // 'failed' — под недочитанным зеркалом может лежать живой снапшот.
    // Писать туда в этой сессии нельзя вовсе: дефолтный store затёр бы
    // его безвозвратно (A.1.2). Приложение при этом работает как обычно.
    mirrorReady = readable;
    mirrorUnverified = !readable;
    if (!store) store = defaultStore();
    // и в localStorage дефолт тоже не пишется: непустой localStorage на
    // следующем старте стал бы источником истины, зеркало перестали бы
    // читать — и всё равно затёрли бы. Пустой localStorage оставляет
    // перезапуску шанс дочитать зеркало и восстановить данные (A.1.5).
    // Первое же действие владельца сохранится обычным save().
    if (readable) save();
  }
  navigator.storage?.persist?.()?.catch?.(() => {}); // fire-and-forget: просим не вычищать localStorage
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('pointerdown', dragDown); // перетаскивание (задача 16F)
  document.querySelectorAll('#tabs button').forEach(b =>
    b.addEventListener('click', () => {
      ui.importNote = null;
      ui.goneNote = null; // короткий путь назад не переживает уход с экрана
      // лист закрывается и таб-баром: если владелец вернулся на ту же
      // вкладку, с которой лист открыт, вернуть её скролл и фокус — как
      // это делает «Готово» (задача 26, п. 4.1). Замер снимается ДО close*.
      const back = sheetReturn();
      if (b.dataset.tab !== ui.tab) { ui.missOpen = {}; ui.raiseEdit = {}; }
      resetConfirms(); // взведённое подтверждение не переживает уход с экрана
      closeReview();
      closeTrain();
      ui.tab = b.dataset.tab;
      if (!syncDay()) renderAll(); // при смене дня syncDay уже перерисовал новую вкладку
      if (back && back.tab === ui.tab) { window.scrollTo(0, back.y); focusSrc(back.src); }
    }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { syncDay(); armDayTimer(); }
    else flushMirror(); // уход в фон — немедленный сброс незаписанного зеркала
  });
  window.addEventListener('focus', syncDay);
  window.addEventListener('pagehide', flushMirror);
  renderAll();
  armDayTimer();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  // Сверка с зеркалом — последней строкой и только при валидном localStorage
  // (в пустой ветке зеркало уже прочитано выше). Await стоит ПОСЛЕ рендера:
  // кадр отдан браузеру, старт не удлиняется (п. 2.4), а тесты получают
  // детерминированный момент, когда сверка завершена.
  if (fromLocal) await verifyMirror();
}

/* Тестовый хук для Node; в браузере — обычный запуск. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    get store() { return store; }, set store(v) { store = v; },
    SCHEMA_VERSION,
    defaultStore, migrate, dateKeyShift, dateKeyFromDate, addDays, diffDays,
    todayKey, msToNextBoundary, weekStartOf, currentWeekStart, previousWeekStart,
    toggleMark, isMarked, incTrain, undoTrain, trainCount,
    reviewDue, windowKeys, currentOneChange, raiseEligible, raiseSuggest, resetRaiseCount,
    acceptRaise, closeWeek, missedYesterday, markYesterday, plural, parseNum,
    // разбор: одно предложение повышения, действенность решений (задача 24)
    raiseReady, raiseOffer, pendingParams, reviewActionable,
    // планка вниз (задача 16C)
    lowerEligible, lowerSuggest, acceptLower, keepBar,
    // упражнения и тренировки (задача 16D)
    liveExercises, findExercise, addExercise, updateExercise, moveExercise, recordSession,
    // чистка и её отмена (задача 16.1)
    WIPE_KEY, emptyStore, wipeStats, wipedCopy, wipeAll, restoreWiped, dropWiped,
    // копия перед замещением, нечитаемые данные и счёт потерь (задача 25)
    CORRUPT_KEY, hasData, keepPrev, corruptCopy, dropCorrupt, dataCounts, droppedLine,
    // страховка зеркала (задача 28.A). keepMirrorCorrupt и verifyMirror
    // в хук не идут: localStorage и IndexedDB в Node нет, доменного теста
    // им не написать, а непокрытых имён в хуке и без того долг (28, п. 8Г).
    // Оба закреплены интерфейсным уровнем через init()
    MIRROR_CORRUPT_KEY, mirrorParse, mirrorHasMore,
    fmtParam, paramDecision, applyParamStep, keepParam, habitsSteady,
    habitWeekCount, habitStreakFrom, habitStreak,
    moveItem, canMoveItem, reorderItem, reorderGroup, reorderExercise,
    // уход и возврат (инвариант 12, задача 28.E/A)
    live, livedOn, removeItem, restoreItem, removeExercise, restoreExercise,
    recordBar, parsePositive, isDayKey, load,
    mirrorRead, mirrorWrite, flushMirror,
    closedWeeks, itemWeekCount,
    // Механики формулы и лестницы сняты задачей 28.D; их доменные функции
    // ушли из файла целиком. Остались нормализаторы: поля formula, ladder и
    // ladderLog живут в store владельца, и migrate обязан приводить их к
    // канонической форме, как прежде. Экспортируются они здесь, чтобы
    // сохранность данных проверялась прямо, а не через один лишь migrate.
    normFormula, normLadder, normLadderLog,
    // блоки (инвариант 13)
    findGroup, addGroup, moveGroup, renameGroup,
    deleteGroup, groupedItems, groupList,
    // прогресс (инвариант 14)
    minDayItems, minDayMarks, minDayClosed, daysInSystem, dayStreak,
    chainWeeks, marksInSystem, riseSeries, risePath,
    // доля дня, порог и рекорд (задача 17)
    dayScore, dayNeed, dayThreshold, clampThreshold, bestStreak,
    marksWindow, seedProgram,
    // задача 22
    everMarked, thresholdNote, seedDayKey, ownerNewestItem,
    // строка дня (задача 28.E/B): набор и выбор
    DAY_LINES, DAY_LINE_EPOCH, dayLine,
    // задача 27.1: ремонт по приёмке
    lastSaveOk, wipedRaw, setWipedRaw, pendingThisWeek,
    holdScrollTarget, unwrapDayMinutes, domFormKey, currentFormKey,
    // константы времени (задача 23): TIMING — значения этой загрузки,
    // TIMING_DEFAULTS — рантайм приложения, подмене не подверженный
    TIMING, TIMING_DEFAULTS
  };
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
