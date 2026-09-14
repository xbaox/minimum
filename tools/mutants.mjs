/* Батарея мутантов: проверка того, что тесты действительно сторожат, а не
   просто зелены. Каждый мутант — точечная порча кода, возвращающая поведение
   к тому, каким оно было ДО задачи. Тесты обязаны такого мутанта «убить»
   (упасть). Выживший мутант означает ровно одно: закреплённого поведения
   у этого места нет — тест либо не написан, либо проверяет не то.

   ЗАПУСК
     node tools/mutants.mjs                 — вся батарея
     node tools/mutants.mjs raise param     — только мутанты, чьи id содержат
                                              одну из подстрок
     node tools/mutants.mjs --list          — перечислить, не запуская

   ИЗОЛИРОВАННАЯ КОПИЯ
   Живое дерево не трогается вовсе (CLAUDE.md, «Правила изменений»):
   отслеживаемые git'ом файлы копируются во временный каталог ОС, туда же
   ставится junction на node_modules проекта (jsdom и fake-indexeddb —
   devDependencies, копировать их незачем). Копия удаляется в конце,
   даже если прогон прерван исключением. Путь копии печатается первой
   строкой вывода — если понадобится посмотреть, что там осталось.

   ЧТЕНИЕ ВЫВОДА
     ✔ убит      — тесты упали, поведение закреплено; это норма
     ✖ ВЫЖИЛ     — тесты прошли на испорченном коде; дыра в покрытии
     ⚠ не наложен — текст мутации не найден в файле: код изменился,
                     мутант устарел и требует правки (молчать нельзя,
                     иначе батарея тихо усохнет до нуля)

   КОНТРОЛЬ
   Первым идёт прогон БЕЗ мутации. Он обязан «выжить»: тесты в копии
   зелёные. Если контроль «убит», врёт сам инструмент — копия собрана
   неверно, и тогда «убитыми» окажутся все мутанты подряд независимо от
   покрытия. На этом инструмент задачи 23 и попался: он показывал 100%
   убийств, потому что в прогон входил sw.test.js. Прогон в таком случае
   прекращается с кодом 1 и не печатает ложной статистики. */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* Тесты батареи. Список именно перечислением, а не маской tests/*.test.js:
   два файла из прогона ИЗЪЯТЫ намеренно, и причина обязана жить здесь,
   а не в голове следующего окна.

   sw.test.js       — меряет sha256 файлов деплоя и сверяет его с
                      tests/releases.json. Любая мутация app.js меняет
                      отпечаток, поэтому этот файл убивает КАЖДОГО мутанта
                      подряд, включая заведомо безобидного. С ним батарея
                      показывает 100% убийств и не значит ничего.
   icons.test.js    — проверяет закоммиченные PNG на соответствие палитре.
                      К доменной логике и рендеру отношения не имеет,
                      мутациями app.js не затрагивается, а на прогон
                      тратит время. */
const TESTS = ['tests/domain.test.js', 'tests/dom.test.js', 'tests/regression.test.js', 'tests/contrast.test.js'];
const EXCLUDED = {
  'tests/sw.test.js': 'меряет отпечаток деплоя — «убивает» любого мутанта подряд',
  'tests/icons.test.js': 'проверяет PNG, к домену и рендеру отношения не имеет'
};

/* Мутант: id, файл, список замен [что, на что] и что он моделирует.
   Замена должна встречаться в файле РОВНО один раз — иначе мутация
   неопределённа, и инструмент об этом сообщает. */
const MUTANTS = [
  {
    id: '24.2-param-под-свёртку',
    file: 'app.js',
    note: 'карточка нерешённого параметра возвращается под свёртку, как было до задачи 24',
    edits: [
      ['  for (const p of pendingParams()) {\n    bar += `',
        '  for (const p of []) {\n    bar += `'],
      ['    const decided = paramDecision(p.id);\n    if (!decided) continue;',
        '    const decided = paramDecision(p.id);\n    if (!decided) { wk += `<div class="card param"><p>«${esc(p.name)}»</p>' +
        '<div class="btns"><button class="btn" data-act="param-step" data-id="${esc(p.id)}">Шаг</button>' +
        '<button class="btn quiet" data-act="param-keep" data-id="${esc(p.id)}">Оставить</button></div></div>`; continue; }']
    ]
  },
  {
    id: '24.6-вторая-карточка-повышения',
    file: 'app.js',
    note: 'разбор снова предлагает повысить все готовые пункты сразу',
    edits: [['  if (offer) {\n    const it = offer;', '  for (const it of raiseReady()) {']]
  },
  {
    id: '24.6-строка-про-остальных-исчезает',
    file: 'app.js',
    note: 'отложенные предложения пропадают молча',
    edits: [['  if (restReady > 0) {', '  if (false) {']]
  },
  {
    id: '24.7-точка-при-первой-отметке',
    file: 'app.js',
    note: 'первая в жизни отметка снова делает вчерашний пропуск «начатым»',
    edits: [['  return everMarked(item, y);', '  return everMarked(item);']]
  },
  {
    id: '24.9-weekOpen-не-сбрасывается',
    file: 'app.js',
    note: 'свёртка недели переносит память между разборами',
    // якорь обновлён в задаче 25: после ui.weekOpen в closeReview встал
    // сброс ui.ladderStay, и прежний текст «…= null;\n}» исчез
    edits: [['  ui.weekOpen = null;\n', '']]
  },
  {
    id: '24.9-свёртка-не-открывается',
    file: 'app.js',
    note: 'при пустых решениях свёртка остаётся закрытой',
    // якорь обновлён в задаче 27.1, п. 10.3: умолчание стало сниматься
    // один раз при первом рендере разбора, и прежнее выражение исчезло
    edits: [['  if (ui.weekOpen === null) ui.weekOpen = !reviewActionable();',
      '  if (ui.weekOpen === null) ui.weekOpen = false;']]
  },
  {
    id: '24.10-placeholder-убран',
    file: 'app.js',
    note: 'поле «Одно изменение» снова не объясняет, чего от владельца ждут',
    edits: [['placeholder="например: перенести зарядку на утро"', 'placeholder="необязательно"']]
  },
  {
    id: '25.2-импорт-без-копии',
    file: 'app.js',
    note: 'импорт снова замещает данные необратимо — копии перед подменой нет',
    // якорь обновлён в задаче 27.1, п. 2.3: перед keepPrev встал снимок
    // ключа копии для отката (wasCopy), и прежний текст исчез
    edits: [[
      `    if (!keepPrev(prev, 'import')) {
      alert('Импорт не выполнен: копию прежних данных некуда сохранить. Текущие данные не изменены.');
      return;
    }
`, '']]
  },
  {
    id: '25.2-подтверждение-переживает-импорт',
    file: 'app.js',
    note: 'взведённое «Подтвердить: стереть» переживает импорт — один тап подменяет только что записанную копию',
    edits: [['    ui.wipeOpen = false;\n    resetConfirms();', '    ui.wipeDropConfirm = false;']]
  },
  {
    id: '25.3-счёт-было-после-migrate',
    file: 'app.js',
    note: 'потери считаются по уже мигрированному объекту — расхождение всегда нулевое',
    edits: [['    const lost = droppedLine(was, dataCounts(incoming));',
      '    const lost = droppedLine(dataCounts(incoming), dataCounts(incoming));']]
  },
  {
    id: '25.4-день-выбрасывается-целиком',
    file: 'app.js',
    note: 'один посторонний флаг снова уносит весь день с валидными отметками',
    // якорь обновлён в задаче Р2: фильтр значений дня стал блоком и получил
    // второе условие — false («Не сегодня») у известного не-действия
    // отбрасывается. Порча прежняя — день целиком уходит из-за одного
    // небулева значения; отсев пропуска у не-действия в мутанте сохранён,
    // чтобы мутант не сносил заодно чужое правило (его держит
    // R2-миграция-оставляет-пропуск-не-действию)
    edits: [[
      `    if (!isDayKey(k) || !day || typeof day !== 'object' || Array.isArray(day)) { delete s.days[k]; continue; }
    for (const id of Object.keys(day)) {
      if (typeof day[id] !== 'boolean' || (day[id] === false && notAction.has(id))) delete day[id];
    }
    if (!Object.keys(day).length) delete s.days[k];`,
      `    const ok = isDayKey(k) && day && typeof day === 'object' && !Array.isArray(day) &&
      Object.keys(day).length > 0 &&
      Object.values(day).every(v => typeof v === 'boolean');
    if (!ok) { delete s.days[k]; continue; }
    for (const id of Object.keys(day)) if (day[id] === false && notAction.has(id)) delete day[id];
    if (!Object.keys(day).length) delete s.days[k];`]]
  },
  {
    id: '25.5-схема-новее-молчит',
    file: 'app.js',
    note: 'файл, снятый более новой версией, импортируется без предупреждения',
    edits: [['    if (fileVersion > SCHEMA_VERSION) {', '    if (false) {']]
  },
  {
    id: '25.6-нечитаемые-данные-невидимы',
    file: 'app.js',
    note: 'повреждённая копия снова лежит в ключе молча — ни скачать, ни убрать',
    edits: [['    ${corruptLine()}\n', '']]
  },
  {
    id: '25.7-пустая-чистка-переписывает-копию',
    file: 'app.js',
    note: 'вторая чистка подряд снова кладёт в копию пустоту вместо практики',
    edits: [['function keepPrev(prev, kind) {\n  if (!hasData(prev)) return true;',
      'function keepPrev(prev, kind) {']]
  },
  /* ── Задача 26 ─────────────────────────────────────────────── */
  {
    id: '26.1-возврат-не-кладёт-копию',
    file: 'app.js',
    note: '«Вернуть» снова необратим — наработанное после чистки или импорта теряется',
    // якорь обновлён в задаче 27.1, п. 2.1: перед keepPrev встал снимок
    // ключа копии для отката (wasCopy)
    edits: [[
      `  if (hasData(prev)) {
    if (!keepPrev(prev, 'restore')) return false; // копию некуда положить — возврат не выполняется
  } else {
    dropWiped();
  }
  store = restored;`,
      `  dropWiped();
  store = restored;`]]
  },
  {
    id: '26.1-строка-возврата-врёт-про-стёртое',
    file: 'app.js',
    note: 'строка называет совершённое действие вместо содержимого обменной копии',
    edits: [["      <p class=\"muted\">В копии — состояние ${whence}${when ? ', ' + esc(when) : ''} ·",
      "      <p class=\"muted\">Стёрто${when ? ' ' + esc(when) : ''} ·"]]
  },
  {
    id: '26.2-сохранено-при-отброшенном-вводе',
    file: 'app.js',
    note: 'невалидное число снова молча оставляет старое значение и печатает «Сохранено»',
    edits: [["          if (value === null) { refuse(b, 'Значение не принято: нужно число больше нуля'); break; }",
      '          if (value === null) value = item.value;']]
  },
  {
    id: '26.2-подтверждение-снова-в-шапке',
    file: 'app.js',
    note: 'узел «Сохранено» возвращается в шапку экрана, за 1939 px от нажатой кнопки',
    // якорь обновлён в задаче Р1: строка пункта разделилась на строку
    // действия (actionRow) и строку привычки (habitRow), и узел у якоря
    // печатается в ОБЕИХ — прежний текст встречался дважды. Снимаются оба
    edits: [
      ["  let h = `<header class=\"page\"><p class=\"overline\">Устройство приложения</p><h1>Настройки</h1></header>`;",
        "  let h = `<header class=\"page\"><p class=\"overline\">Устройство приложения</p><h1>Настройки</h1></header>`;\n  if (ui.savedAt) { h += `<p class=\"flash\" role=\"status\">${esc(ui.savedAt.text)}</p>`; ui.savedAt = null; }"],
      ["        ${flashAt('item:' + it.id)}\n      </div>`;\n}\n\n/* Список действий", "      </div>`;\n}\n\n/* Список действий"],
      ["        ${flashAt('item:' + it.id)}\n      </div>`;\n}\n\n/* Секция «Привычки»", "      </div>`;\n}\n\n/* Секция «Привычки»"]
    ]
  },
  {
    id: '26.2-отказ-закрывает-форму',
    file: 'app.js',
    note: 'занятое имя блока снова закрывает форму молча и уносит правку',
    // якорь обновлён в задаче Р1: проверки имени ушли в доменную updateGroup
    // (имя, подпись и дни — одной записью), обработчик получает причину
    // отказа. Предмет прежний — отказ снова закрывает форму молча
    edits: [[
      "      if (!r.ok) { refuse(b, groupRefusal(r, el('g-name') ? el('g-name').value : from)); break; }",
      '      if (!r.ok) { ui.groupRename = null; renderSettings(); break; }']]
  },
  {
    id: '26.3-черновик-тренировки-теряется',
    file: 'app.js',
    note: 'поля листа тренировки снова не черновик: перерисовка возвращает сохранённые нагрузки',
    // Якорь обновлён в задаче 28.D. Прежде мутация сносила строку ключа в
    // currentFormKey; после 28.D эту же строку дословно сверяет тест
    // приоритета листов (З28D/3), и мутант умирал от него, а не от теста
    // черновика — то есть проверял не то, что назван проверять. Мутируем
    // ниже по течению: ключ остаётся, но перестаёт опознаваться как
    // «листовой», слот и экран поиска формы становятся чужими, и снимок
    // черновика не снимается вовсе — ровно то, что описано в note.
    edits: [["const isTrainKey = key => key.startsWith('train:');", 'const isTrainKey = () => false;']]
  },
  {
    id: '26.4-скролл-не-возвращается-таб-баром',
    file: 'app.js',
    note: 'закрытие листа таб-баром снова роняет вкладку наверх и теряет фокус',
    edits: [['      if (back && back.tab === ui.tab) { window.scrollTo(0, back.y); focusSrc(back.src); }\n', '']]
  },
  {
    id: '26.4-фокус-не-уходит-в-лист',
    file: 'app.js',
    note: 'фокус остаётся на прежней вкладке — лист открыт, а клавиатура и AT о нём не знают',
    edits: [['function focusSheet(id) {\n  const h = document.querySelector', 'function focusSheet(id) {\n  if (id) return;\n  const h = document.querySelector']]
  },
  {
    id: '26.5-градиент-полосы-дня-снят',
    file: 'styles.css',
    note: 'планка дня снова заливается плоским акцентом',
    edits: [['  background: linear-gradient(90deg, var(--accent), var(--chain));', '  background: var(--accent);']]
  },
  {
    id: '26.5-планка-дня-снова-3px',
    file: 'styles.css',
    note: 'высота планки дня расходится с полосой «Прогресса»',
    edits: [['.bar, .dbar {\n  height: 8px;', '.bar, .dbar {\n  height: 3px;']]
  },
  {
    id: '26.5-счёт-дня-снова-мельче-даты',
    file: 'styles.css',
    note: 'крупное число счёта дня возвращается на 13px',
    edits: [['.bar-note b { font-size: 22px;', '.bar-note b { font-size: 13px;']]
  },
  {
    id: '26.5-имя-блока-снова-тише-надстрочника',
    file: 'styles.css',
    note: 'слово владельца снова мельче и тише декоративной подписи приложения',
    edits: [['  font-size: var(--text-xs);\n  font-weight: 650;\n  letter-spacing: .08em;\n  text-transform: uppercase;\n  color: var(--muted);\n}',
      '  font-size: 11px;\n  font-weight: 650;\n  letter-spacing: .08em;\n  text-transform: uppercase;\n  color: var(--faint);\n}']]
  },
  {
    id: '26.5-рамка-кнопок-вернулась-к-старому-токену',
    file: 'styles.css',
    note: 'кнопка снова обведена вдвое тише поля в той же карточке (1,45:1)',
    edits: [['  border: 1px solid var(--control-border);\n  border-radius: var(--radius-md);',
      '  border: 1px solid var(--line-strong);\n  border-radius: var(--radius-md);']]
  },
  {
    id: '26.5-ячейка-цепи-снова-мелкая',
    file: 'styles.css',
    note: 'шаг сетки разбора возвращается на «Прогресс», краска — пятая часть ширины',
    edits: [['  grid-template-columns: repeat(7, 1fr);\n  gap: 8px 6px;', '  grid-template-columns: repeat(7, 26px);\n  gap: 8px 4px;'],
      ['.cdays i {\n  width: 20px;\n  height: 20px;\n', '.cdays i {\n']]
  },
  {
    id: '26.6-active-снят',
    file: 'styles.css',
    note: 'состояние нажатия снова только у .btn — остальные тач-цели молчат под пальцем',
    // якорь обновлён в задаче 28.D: .idetail ушёл из списка вместе с
    // хвостовой кнопкой строки дня.
    // якорь обновлён в задаче Р2: в список встала свёрнутая строка блока
    // .bfold (п. 4). Снимается вместе с прочими — отклика нет ни у кого, кроме .btn
    edits: [[`.btn:active,
.dot:active,
.undo:active,
.itxt:active,
.bfold:active,
.sect > summary:active,
#tabs button:active { background: var(--accent-weak); }`,
      '.btn:active { background: var(--accent-weak); }']]
  },
  {
    id: '26.6-переход-таб-бара-вне-окна',
    file: 'styles.css',
    note: 'переход цвета вкладки возвращается на 160 мс — короче окна движения',
    edits: [['  transition: color .18s ease-out;', '  transition: color .16s ease;']]
  },
  {
    id: '26.6-reduced-motion-не-отключает-переходы',
    file: 'styles.css',
    note: 'глобальный блок перестаёт гасить transition — движение играет и при reduced-motion',
    edits: [['    transition: none !important;\n    animation: none !important;', '    animation: none !important;']]
  },
  {
    id: '26.8-будущая-ячейка-снова-одной-прозрачностью',
    file: 'styles.css',
    note: 'состояние «будущий день» опять передаётся только альфой (1,35:1 в тёмной)',
    edits: [['.hstrip i.fut,\n.hstrip i.off { visibility: hidden; }', '.hstrip i.fut,\n.hstrip i.off { opacity: .45; }']]
  },
  {
    id: '26.8-точка-без-aria-controls',
    file: 'app.js',
    note: 'aria-expanded снова без aria-controls, раскрываемая строка без id',
    edits: [['aria-controls="miss-${esc(it.id)}" ', ''],
      ['<p class="miss-note" id="miss-${esc(it.id)}"${ui.missOpen[it.id] ? \'\' : \' hidden\'}>',
        '<p class="miss-note"${ui.missOpen[it.id] ? \'\' : \' hidden\'}>']]
  },
  {
    id: '26.7-система-называет-чужие-блоки',
    file: 'app.js',
    note: 'тексты «Системы» снова описывают набор блоков, которого у владельца нет',
    edits: [["      { lead: 'Блок — связка пунктов.',", "      { lead: 'Тело:', text: 'гигиена, короткая силовая связка.' },\n      { lead: 'Сон:', text: 'телефон вне кровати до отбоя.' },\n      { lead: 'Развитие:', text: 'десять минут в день.' },\n      { lead: 'Блок — связка пунктов.',"]]
  },
  /* ── Задача 27, п. 3.2: стыки ──────────────────────────────────
     Мутанты на местах, которых коснулись ДВЕ задачи цикла. Каждая
     правка по отдельности проверялась в своём окне; здесь проверяется,
     что вторая не расшатала сторожа первой. */
  {
    id: '27.1-понижение-неначатому',
    file: 'app.js',
    note: 'стык 22×24: запрет понижения неначатому пункту снят — посев без единой отметки снова получает предложение урезать планку',
    edits: [['  if (!everMarked(item, addDays(W[W.length - 1], 6))) return false;\n', '']]
  },
  {
    id: '27.2-повышение-без-якоря',
    file: 'app.js',
    note: 'стык 22×24: raiseOffer перестаёт видеть принятое решение — «Не сейчас» гасит карточку, а следующая перерисовка выдаёт вторую',
    edits: [['  if (cur && store.items.some(i => i.raiseAfterWeek === cur)) return null;\n', '']]
  },
  {
    id: '27.3-точка-у-пункта-заведённого-сегодня',
    file: 'app.js',
    note: 'стык 22×24: проверка «пункт существовал вчера» снята — заведённый сегодня пункт получает точку «вчера — пропуск»',
    edits: [['  if (!dueOn(item, y) || isMarked(y, item.id)) return false;',
      '  if (isMarked(y, item.id)) return false;']]
  },
  {
    id: '27.4-возврат-подписан-чисткой',
    file: 'app.js',
    note: 'стык 25×26: обмен при возврате подписывается «до чистки» — строка «Данных» называет не тот источник',
    edits: [["    if (!keepPrev(prev, 'restore')) return false;", "    if (!keepPrev(prev, 'wipe')) return false;"]]
  },
  {
    id: '27.5-свёртка-слепа-к-параметру',
    file: 'app.js',
    note: 'стык 24×26: reviewActionable перестаёт считать нерешённый параметр действенным — картина недели раскрывается поверх живого решения',
    // якорь обновлён в задаче 28.D: лестничная часть условия снята, и
    // проверка параметра стала последней строкой функции
    edits: [['  return pendingParams().length > 0;', '  return false;']]
  },
  /* ── Задача 27.1: ремонт по приёмке ────────────────────────────
     По мутанту на каждую правку. Д1 и Д5 — пути безвозвратной потери:
     они обязаны умирать от теста, а не от рассуждения. */
  {
    id: '27.1-Д5-save-не-сообщает-об-успехе',
    file: 'app.js',
    note: 'Д5: save() снова молчит об успехе — замещение считает записанным то, чего на диске нет',
    edits: [['  storageNote(); // вне try: своей ошибкой она не должна выглядеть отказом записи\n  return ok;',
      '  storageNote();\n  return true;']]
  },
  {
    id: '27.1-Д5-возврат-расходует-копию-до-записи',
    file: 'app.js',
    note: 'Д5: возврат снова необратим — копия израсходована, запись не удалась, практика потеряна в обоих местах',
    edits: [[`  if (!save()) {
    store = prev;
    setWipedRaw(wasCopy);
    return false;
  }
  flushMirror();
  return true;
}

/* Восстановление из зеркала`, `  save();
  flushMirror();
  return true;
}

/* Восстановление из зеркала`]]
  },
  {
    id: '27.1-Д5-чистка-без-отката',
    file: 'app.js',
    note: 'Д5: чистка не откатывается при отказе записи — экран пуст, копия «до чистки», а на диске нетронутая практика',
    edits: [[`  if (!save()) {
    store = prev;
    setWipedRaw(wasCopy);
    return false;
  }
  flushMirror();
  return true;
}

/* Возврат: копия проходит migrate`, `  save();
  flushMirror();
  return true;
}

/* Возврат: копия проходит migrate`]]
  },
  {
    id: '27.1-Д6-сохранено-без-записи',
    file: 'app.js',
    note: 'Д6: «Сохранено» снова печатается при отказе хранилища — приложение утверждает то, чего не произошло',
    // якорь обновлён в задаче 28.D, п. 9.1: у flashWrite снят второй
    // параметр — его не передавал ни один вызывающий
    edits: [["  flashOk(key, lastSaveOk() ? undefined : 'Не сохранено: хранилище недоступно');", '  flashOk(key);']]
  },
  {
    id: '27.1-Д6-баннер-только-на-дневных',
    file: 'app.js',
    note: 'Д6: баннер отказа хранилища снова не показывается — отказ на «Настройках» проходит без следа',
    edits: [["  p.textContent = saveFailed ? 'Хранилище недоступно — отметки сейчас не сохраняются' : '';\n  p.hidden = !saveFailed;",
      "  p.textContent = '';\n  p.hidden = true;"]]
  },
  {
    id: '27.1-Д4-flash-по-всему-документу',
    file: 'app.js',
    note: 'Д4: узел подтверждения снова ищется по всему документу — берётся чужой со скрытого экрана, страница прыгает',
    // якорь обновлён в задаче Р1: выборка по видимому экрану вынесена в
    // общий shownIn (им же ищется .gone-note), и узлы в [hidden] свёрнутой
    // карточки пропускаются. Порча — только у visibleFlash, как прежде
    edits: [["const visibleFlash = () => shownIn('.flash:not(.keep)');",
      "const visibleFlash = () => document.querySelector('.flash:not(.keep)');"]]
  },
  {
    id: '27.1-Д4-keepInPlace-снят',
    file: 'app.js',
    note: 'Д4/9.3: арифметика удержания точки нажатия снята — узел подтверждения рождается за краем экрана',
    edits: [['  const dy = nodeTop - anchorTop;\n  if (!dy) return null;\n  return Math.max(0, (scrollY || 0) + dy);',
      '  return null;']]
  },
  {
    id: '27.1-9.3-keepInPlace-снят',
    file: 'app.js',
    note: '9.3: подгонка скролла снята целиком — тот самый мутант, который до задачи 27.1 выжил бы (проверять было нечем)',
    edits: [['  const to = holdScrollTarget(y, n.getBoundingClientRect().top, window.scrollY);\n  if (to !== null) window.scrollTo(0, to);',
      '  return;']]
  },
  {
    id: '27.1-Д7-возврат-отказывает-молча',
    file: 'app.js',
    note: 'Д7: «Вернуть» снова ничего не говорит при отказе — владелец видит кнопку, которая не сработала',
    edits: [["      if (!restoreWiped()) { ui.restoreFailed = true; renderSettings(); break; }\n      ui.restoreFailed = false;",
      '      if (!restoreWiped()) break;']]
  },
  {
    id: '27.1-Д7-подтверждение-переживает-возврат',
    file: 'app.js',
    note: 'Д7: взведённое «Подтвердить: стереть» снова переживает возврат — один тап уничтожает обмен',
    // якорь обновлён в задаче 28.D: closeDetail() из ветки ушёл вместе с
    // листом детали; сбрасывать подтверждения остался один resetConfirms
    // якорь обновлён в задаче Р1: между resetConfirms и сменой дня встал
    // resetSettingsView (формы — к прежним данным); он подтверждений чистки
    // не гасит, и предмет мутанта не заслоняет
    edits: [['      ui.wipeOpen = false;\n      resetConfirms();\n      resetSettingsView(); // и открытые формы', '      resetSettingsView(); // и открытые формы']]
  },
  {
    id: '27.1-Д8-invalid-date',
    file: 'app.js',
    note: 'Д8: exportedAt вне диапазона Date снова доезжает до рендера — «Данные скачивались: Invalid Date»',
    edits: [['        && Math.abs(s.settings.exportedAt) <= MAX_TIME)) {', '        )) {']]
  },
  {
    id: '27.1-подъём-параметра-через-полночь',
    file: 'app.js',
    note: 'п. 8: полуночный переход снова рисуется подъёмом на всю высоту, и настоящие шаги неразличимы',
    edits: [["    const geo = (it.type === 'param' && it.pkind === 'time') ? unwrapDayMinutes(s.points) : s.points;",
      '    const geo = s.points;']]
  },
  {
    id: '27.1-10.2-решения-двух-разборов-в-одном-срезе',
    file: 'app.js',
    note: '10.2: срез снова забирает всё накопленное — решения двух разборов ложатся в одну неделю',
    edits: [["    raises: pendingThisWeek(store.pendingRaises, 'raiseAfterWeek'),\n    lowers: pendingThisWeek(store.pendingLowers, 'lowerAfterWeek'),",
      '    raises: store.pendingRaises,\n    lowers: [...store.pendingLowers],']]
  },
  {
    id: '27.1-9.1-снимок-берёт-первую-форму',
    file: 'app.js',
    note: '9.1: снимок черновика снова берёт первую форму экрана — раскрытая правка блока крадёт черновик «Пунктов»',
    edits: [[`  let form = null;
  for (const f of document.querySelectorAll(formScope(key) + ' [data-form]')) {
    if (domFormKey(f) === key) { form = f; break; }
  }`,
      `  const form = document.querySelector(formScope(key) + ' [data-form]:not([data-form="group-add"])');`]]
  },
  {
    id: '27.1-9.1-форма-блока-без-черновика',
    file: 'app.js',
    note: '9.1: форма блока снова без ключа — введённое имя пропадает при перерисовке по чужому поводу',
    // якорь обновлён в задаче Р1: ключ формы добавления стал 'group+new' —
    // 'group:new' совпадал с ключом правки блока по имени «new»
    edits: [["  if (ui.groupAdd) return 'group+new';\n  if (ui.groupRename !== null) return 'group:' + ui.groupRename;\n", '']]
  },
  {
    id: '27.1-9.2-отказ-не-объявляется',
    file: 'app.js',
    note: '9.2: отказ формы снова не доходит до скринридера — узел рождается вместе с текстом и молчит',
    edits: [['  announce(text);\n}', '}']]
  },
  {
    id: '27.1-9.4-добавить-блок-не-закрывает-правку',
    file: 'app.js',
    note: '9.4: «Добавить блок» снова оставляет открытой правку блока — на экране две формы блока разом',
    // якорь перевыставлен в задаче 28.B: обработчик переписан на общее
    // правило openSettingsForm, и прежняя строка из кода ушла. Предмет
    // мутанта тот же — «Добавить блок» перестаёт закрывать правку блока
    edits: [["    case 'group-add-open': openSettingsForm(() => { ui.groupAdd = true; }); break;",
      "    case 'group-add-open': ui.groupAdd = true; renderSettings(); break;"]]
  },
  {
    id: '27.1-9.5-hstrip-обводка-невидима',
    file: 'styles.css',
    note: '9.5: кружок дня в полосе недели снова обведён тоном разделителей (1,45:1) — день без отметки не виден',
    edits: [['  border: 1.5px solid var(--control-border);\n  /* заполнение сегодняшней',
      '  border: 1.5px solid var(--line-strong);\n  /* заполнение сегодняшней']]
  },
  {
    id: '27.1-10.3-свёртка-пересчитывается-каждый-рендер',
    file: 'app.js',
    note: '10.3: умолчание свёртки снова пересчитывается на каждой перерисовке — последнее решение само раскрывает картину недели',
    edits: [['  if (ui.weekOpen === null) ui.weekOpen = !reviewActionable();\n  return ui.weekOpen;',
      '  return ui.weekOpen === null ? !reviewActionable() : ui.weekOpen;']]
  },
  /* Мутант 27.1-5.1 («посевные выписки в другом порядке ключей») снят
     задачей 28.C вместе с programQuotes: предмета больше нет, а мутант
     без предмета молча превращается в «не наложен» и усыхает батарею. */
  {
    id: '27.1-10.5-копия-из-заметок-читается-пустой',
    file: 'app.js',
    note: '10.5: строка копии снова считает только пункты и дни — копия из одних заметок выглядит пустой',
    edits: [["  if (q) parts.push(`${q} ${plural(q, 'запись', 'записи', 'записей')}`);\n", '']]
  },

  /* ── Задача 28.A: страховка зеркала ─────────────────────────
     Шесть мутантов возвращают ровно те два пути безвозвратной потери,
     которые задача закрыла: непарсящийся снапшот, считавшийся успехом,
     и осторожность, жившую одну сессию. */
  {
    id: '28A-1.1-непарсящийся-снапшот-считается-успехом',
    file: 'app.js',
    note: 'исход read с нечитаемым снапшотом снова признаётся успехом — дефолт затирает его в той же сессии',
    edits: [['      if (!store) { keepMirrorCorrupt(probe.snap); readable = false; }',
      '      if (!store) { keepMirrorCorrupt(probe.snap); }']]
  },
  {
    id: '28A-1.2-сырая-строка-не-сохраняется',
    file: 'app.js',
    note: 'содержимое нечитаемого снапшота больше никуда не откладывается — показывать нечего',
    edits: [['    localStorage.setItem(MIRROR_CORRUPT_KEY, JSON.stringify({ raw, at: Date.now() }));\n', '']]
  },
  {
    id: '28A-2.1-зеркало-не-читается-при-валидном-localStorage',
    file: 'app.js',
    note: 'localStorage снова безоговорочный источник истины: сверки нет, осторожность живёт одну сессию',
    edits: [['  if (fromLocal) await verifyMirror();', '  if (false) await verifyMirror();']]
  },
  {
    id: '28A-2.2-предложение-не-показывается',
    file: 'app.js',
    note: 'предложение восстановления перестаёт рендериться — зеркало не пишется, а владелец не знает почему',
    edits: [["  h += sect('data', 'Данные', mirrorOfferLine() + restoreLine() + `",
      "  h += sect('data', 'Данные', restoreLine() + `"]]
  },
  {
    id: '28A-2.2-подмена-происходит-молча',
    file: 'app.js',
    note: 'снапшот, обогнавший рабочую копию, подставляется сам — решение отобрано у владельца',
    edits: [['        mirrorOffer = { store: kept, savedAt: probe.snap.savedAt, stats: wipeStats(kept) };\n        return; // молча не затираем: решение за владельцем (п. 2.2)',
      '        store = kept; save();']]
  },
  {
    id: '28A-3-чистка-молчит-о-непроверенном-зеркале',
    file: 'app.js',
    note: 'чистка в непроверенной сессии снова не сбрасывает зеркало и не говорит об этом',
    edits: [["      ${mirrorReady ? '' : (mirrorOffer", "      ${true ? '' : (mirrorOffer"]]
  },

  /* ── Задача 28.B: мёртвое и тихое ──────────────────────────── */
  {
    id: '28B-1-скачок-подписи-вернулся',
    file: 'styles.css',
    note: 'высота подписи планки снова зависит от крупного <b> — список прыгает на 7,25 px в момент закрытия дня',
    edits: [['  height: 34px;\n  line-height: 34px;\n', '']]
  },
  {
    id: '28B-2-мёртвая-ветка-восстановлена',
    file: 'app.js',
    note: 'ветка создания кнопки «отменить последний» возвращена — недостижимый код снова в файле',
    edits: [['  if (!n && hasUndo) next.remove();',
      '  if (n && !hasUndo) {\n    const it = store.items.find(x => x.id === id);\n    const btn = document.createElement(\'button\');\n    btn.className = \'undo\';\n    btn.dataset.act = \'train-undo\';\n    btn.dataset.id = id;\n    btn.textContent = \'отменить последний\';\n    wc.after(btn);\n  } else if (!n && hasUndo) {\n    next.remove();\n  }']]
  },
  {
    id: '28B-3-фокус-по-всему-документу',
    file: 'app.js',
    note: 'focusSrc снова ищет кнопку-источник во всём документе и попадает на скрытый экран',
    edits: [['  const list = [...document.querySelectorAll(`main .screen:not([hidden]) [data-act="${src.act}"]`)];',
      '  const list = [...document.querySelectorAll(`[data-act="${src.act}"]`)];']]
  },
  {
    id: '28B-4-формы-не-гасят-друг-друга',
    file: 'app.js',
    note: 'открытие второй формы «Настроек» больше не закрывает первую — на экране снова две',
    edits: [['function settingsFormsClosed() {\n  ui.editingId = null;', 'function settingsFormsClosed() {\n  if (true) return;\n  ui.editingId = null;']]
  },
  {
    id: '28B-4-снимок-после-смены-ui',
    file: 'app.js',
    note: 'снимок черновика делается ПОСЛЕ закрытия прежней формы — ключ уже чужой, набранное не снимается',
    edits: [['  snapshotOpenForm();     // набранное в прежней форме — в слот, ДО смены ui\n  settingsFormsClosed();',
      '  settingsFormsClosed();\n  snapshotOpenForm();']]
  },
  {
    id: '28B-5-потеря-категории-не-называется',
    file: 'app.js',
    note: 'блоки, weekLog, история, значения сессий и решения по параметрам снова вне счёта — импорт молчит о потере',
    // якорь обновлён в задаче Р1: между schedule и entries встали категории
    // blockDays и groupLog. Они снимаются вместе с прочими — до 28.B не было
    // и их; по отдельности их держат мутанты R1-потери-*.
    // якорь обновлён в задаче Р2: между groupLog и entries встали категории
    // modes и modeLog — снимаются вместе с прочими по той же причине
    edits: [["  ['groups', 'блок', 'блока', 'блоков'],\n  ['weekLog', 'запись счётчика', 'записи счётчика', 'записей счётчика'],\n  ['history', 'запись истории', 'записи истории', 'записей истории'],\n  ['schedule', 'отрезок расписания', 'отрезка расписания', 'отрезков расписания'],\n  ['blockDays', 'отрезок дней блока', 'отрезка дней блока', 'отрезков дней блока'],\n  ['groupLog', 'запись о блоке', 'записи о блоке', 'записей о блоке'],\n  ['modes', 'режим', 'режима', 'режимов'],\n  ['modeLog', 'отрезок режима', 'отрезка режима', 'отрезков режима'],\n  ['entries', 'значение тренировки', 'значения тренировки', 'значений тренировки'],\n  ['params', 'решение по параметру', 'решения по параметру', 'решений по параметру']\n", '']]
  },
  {
    id: '28B-6-неделя-закрывается-одним-тапом',
    file: 'app.js',
    note: 'закрытие недели снова срабатывает с первого тапа — самая тяжёлая необратимость без подтверждения',
    edits: [['      if (!ui.weekCloseConfirm) { ui.weekCloseConfirm = true; renderReview(); break; }\n', '']]
  },

  /* ── Задача 28.C: экран «Заметки» снят, данные остались ─────
     Пять мутантов делят задачу пополам. Первый и последний возвращают
     СНЯТОЕ: посев выписок и вкладку в разметке. Три средних отнимают
     ОСТАВЛЕННОЕ — нормализацию, экспорт и счёт потерь, — то есть ровно
     те три пути, которыми данные владельца переживают снятие экрана.
     Выживший из этих трёх означает, что «данные остались» никем не
     сторожится и следующая задача снимет поле, ничего не заметив. */
  {
    id: '28C-посев-снова-заводит-выписки',
    file: 'app.js',
    note: 'посев снова кладёт выписки в store — записи появляются там, где показать их нечем',
    edits: [['  s.items = programItems(today);\n  s.settings.seed17 = true;',
      "  s.items = programItems(today);\n  s.notes = [{ id: uid(), date: today, text: 'Начал — половину сделал.', kind: 'quote', source: 'Гораций', updatedAt: 1 }];\n  s.settings.seed17 = true;"]]
  },
  {
    id: '28C-notes-выпадает-из-migrate',
    file: 'app.js',
    note: 'нормализация обнуляет поле вместо того, чтобы его чинить — заметки владельца исчезают при первом же запуске',
    edits: [['  if (!Array.isArray(s.notes)) s.notes = [];', '  s.notes = [];']]
  },
  {
    id: '28C-notes-выпадает-из-экспорта',
    file: 'app.js',
    note: 'экспорт отдаёт store без заметок — единственный оставшийся путь владельца к своим записям обрывается молча',
    edits: [["  download('minimum-' + todayKey() + '.json', JSON.stringify(store, null, 1));",
      "  download('minimum-' + todayKey() + '.json', JSON.stringify(Object.assign({}, store, { notes: [] }), null, 1));"]]
  },
  {
    id: '28C-заметки-выпали-из-счёта-потерь',
    file: 'app.js',
    note: 'категория заметок в dataCounts обнулена — импорт, роняющий записи, молчит об этом',
    edits: [['    notes: len(s && s.notes), reviews: len(s && s.reviews),',
      '    notes: 0, reviews: len(s && s.reviews),']]
  },
  {
    id: '28C-вкладка-заметок-вернулась',
    file: 'index.html',
    note: 'кнопка вкладки и секция экрана возвращаются в разметку — снятое возвращается тихой правкой html',
    edits: [['    <button data-tab="progress">Прогресс</button>\n',
      '    <button data-tab="progress">Прогресс</button>\n    <button data-tab="notes">Заметки</button>\n'],
      ['    <section class="screen" id="scr-progress" hidden></section>\n',
        '    <section class="screen" id="scr-progress" hidden></section>\n    <section class="screen" id="scr-notes" hidden></section>\n']]
  },
  /* ── Задача 28.D: лестница и формула сняты ─────────────────────
     Первые два — главные. Механики нет, но ДАННЫЕ владельца остались, и
     держатся они ровно на двух путях: нормализация в migrate и экспорт.
     Порвётся любой — поля исчезнут молча, при первом же запуске или при
     первом импорте. Снимать эти мутанты вместе с полями, а не раньше. */
  {
    id: '28D-нормализация-лестницы-выпадает-из-migrate',
    file: 'app.js',
    note: 'migrate обнуляет ladder и ladderLog вместо того, чтобы их чинить — лестница владельца исчезает при первом же запуске',
    edits: [["    it.ladder = it.type === 'daily' ? normLadder(it.ladder, today) : null;\n    it.ladderLog = normLadderLog(it.ladderLog);",
      '    it.ladder = null;\n    it.ladderLog = [];']]
  },
  {
    id: '28D-нормализация-формулы-выпадает-из-migrate',
    file: 'app.js',
    note: 'migrate обнуляет formula — семь полей владельца исчезают при первом же запуске',
    edits: [['    it.formula = normFormula(it.formula);', '    it.formula = null;']]
  },
  {
    id: '28D-поля-выпадают-из-экспорта',
    file: 'app.js',
    note: 'экспорт отдаёт store без формулы и лестницы — единственный оставшийся путь владельца к этим данным обрывается молча',
    edits: [['function exportJSON() {',
      'function exportJSON() {\n  store = JSON.parse(JSON.stringify(store));\n  for (const it of store.items) { it.formula = null; it.ladder = null; it.ladderLog = []; }']]
  },
  {
    id: '28D-дедуп-лестниц-снят',
    file: 'app.js',
    note: 'последний рубеж канонической формы снят: импорт файла прежней версии приносит две живые лестницы',
    edits: [["  for (const it of s.items) if (it.ladder && !it.ladder.done && it !== keeper) it.ladder = null;\n", '']]
  },
  {
    id: '28D-guard-повышения-вернулся',
    file: 'app.js',
    note: 'raiseEligible снова смотрит на поле ladder — пункт, носивший лестницу, молча не получает предложения никогда',
    edits: [['  const W = closedWeeks(3);\n  if (W.length < 3) return false;',
      '  if (item.ladder && !item.ladder.done) return false;\n  const W = closedWeeks(3);\n  if (W.length < 3) return false;']]
  },
  {
    id: '28D-решение-получает-номер-3',
    file: 'app.js',
    note: 'нумерация решений снова идёт «1, 3» — владелец видит пропуск и не знает, что потерял',
    edits: [['  h += `<h2>Решение 2 · Одно изменение</h2>`;', '  h += `<h2>Решение 3 · Одно изменение</h2>`;']]
  },
  {
    id: '28D-лист-детали-вернулся',
    file: 'index.html',
    note: 'секция снятого листа возвращается в разметку — снятое возвращается тихой правкой html',
    edits: [['    <section class="screen" id="scr-train" hidden></section>\n',
      '    <section class="screen" id="scr-train" hidden></section>\n    <section class="screen" id="scr-detail" hidden></section>\n']]
  },
  {
    id: '28D-подпись-строки-дня-снова-из-ступени',
    file: 'app.js',
    note: 'подписью пункта снова служит текущая ступень — слово владельца вытеснено данными снятой механики',
    edits: [['  const sub = rowNote(it);',
      '  const sub = (it.ladder && it.ladder.steps[it.ladder.step]) || rowNote(it);']]
  },
  {
    id: '28D-строка-последствия-снова-над-кнопкой',
    file: 'app.js',
    note: 'строка последствия «Закрыть неделю» возвращается наверх — кнопка уезжает на 69 px между первым и вторым тапом',
    edits: [["  h += `<button class=\"btn primary wide\" data-act=\"close-week\">${ui.weekCloseConfirm ? 'Подтвердить: закрыть неделю' : 'Закрыть неделю'}</button>`;\n  if (ui.weekCloseConfirm) {\n    h += `<p class=\"muted\">Неделя уйдёт в архив: принятые решения, «одно изменение» и решения по параметрам очистятся. Отметки останутся.</p>`;\n  }\n  h += REVIEW_DONE;",
      "  if (ui.weekCloseConfirm) {\n    h += `<p class=\"muted\">Неделя уйдёт в архив: принятые решения, «одно изменение» и решения по параметрам очистятся. Отметки останутся.</p>`;\n  }\n  h += `<button class=\"btn primary wide\" data-act=\"close-week\">${ui.weekCloseConfirm ? 'Подтвердить: закрыть неделю' : 'Закрыть неделю'}</button>` + REVIEW_DONE;"]]
  },
  /* ── Задача 28.E, часть A: уход пункта отрезком жизни ────────
     Точка невозврата всей волны: миграция active → removedAt необратима
     асимметрично. Пять мутантов держат её и правило применимости. */
  {
    id: '28E-A-правило-применимости-игнорирует-removedAt',
    file: 'app.js',
    note: 'minDayItems снова не смотрит на день ухода — прошлое считается по всем когда-либо заведённым',
    edits: [["    i.type === 'daily' && i.area === 'min' && dueOn(i, dayKey));",
      "    i.type === 'daily' && i.area === 'min' && i.addedAt <= dayKey);"]]
  },
  {
    id: '28E-A-миграция-не-переносит-выключенных',
    file: 'app.js',
    note: 'выключенный пункт получает removedAt = null — прошлое владельца сдвигается вверх при первом же запуске',
    edits: [['    if (it.active === false && it.removedAt === null) it.removedAt = it.addedAt;',
      '    if (false && it.active === false) it.removedAt = it.addedAt;']]
  },
  {
    id: '28E-A-уход-действует-со-вчера',
    file: 'app.js',
    note: 'уход закрывает отрезок вчерашним днём — вчерашний знаменатель переписывается задним числом',
    edits: [['  if (!it || !live(it)) return false;\n  it.removedAt = todayKey();',
      '  if (!it || !live(it)) return false;\n  it.removedAt = addDays(todayKey(), -1);']]
  },
  {
    id: '28E-A-возврат-позже-воскрешает-прежний-отрезок',
    file: 'app.js',
    note: 'возврат через неделю снимает removedAt у прежней записи — дни паузы задним числом входят в знаменатель',
    // якорь обновлён в задаче Р1: ядро возврата (restoreItemCore) сперва
    // запоминает расписание для отката — возврат «как блок» меняет его в
    // той же ветке
    edits: [['  if (it.removedAt === t) {\n    const was = it.schedule;',
      '  if (true) {\n    const was = it.schedule;']]
  },
  {
    id: '28E-A-убрать-одним-тапом',
    file: 'app.js',
    note: '«Убрать» срабатывает с первого тапа — последствие не названо, и промах по кнопке уводит пункт',
    // якорь обновлён в задаче Р1: ту же строку взводки получил уход блока
    // (group-remove), и текст встречался дважды. Якорь — ключ пункта
    edits: [["      const key = kind + ':' + id;\n      if (ui.removeConfirm !== key) { ui.removeConfirm = key; renderSettings(); break; }",
      "      const key = kind + ':' + id;\n      if (false) { ui.removeConfirm = key; renderSettings(); break; }"]]
  },
  /* ── Задача 28.E, часть B: строка дня ────────────────────────
     Исключение из запрета на лозунги держится своими границами: один
     экран, закрытый набор, выбор — чистая функция от ключа дня. */
  {
    id: '28E-B-выбор-берёт-daysInSystem',
    file: 'app.js',
    note: 'строка дня снова считается от числа дней в системе — правка «начала отсчёта» её перебрасывает',
    edits: [['  const n = diffDays(key, DAY_LINE_EPOCH);',
      '  const n = daysInSystem();']]
  },
  {
    id: '28E-B-строка-читает-практику',
    file: 'app.js',
    note: 'выбор начинает зависеть от отметок — строка меняется от тапа по кругу',
    edits: [['  const n = diffDays(key, DAY_LINE_EPOCH);',
      '  const n = diffDays(key, DAY_LINE_EPOCH) + Object.keys(store.days).length;']]
  },
  {
    id: '28E-B-строка-на-втором-экране',
    file: 'app.js',
    note: 'строка дня появляется и на «Привычках» — исключение из запрета на лозунги перестаёт быть одним',
    edits: [["      <p class=\"overline\">Программа роста</p>\n      <h1>Привычки</h1>",
      "      <p class=\"overline\">Программа роста</p>\n      <h1>Привычки</h1>\n      <p class=\"dline\">${esc(dayLine(t))}</p>"]]
  },
  {
    id: '28E-B-набор-сцеплен-с-днём-недели',
    file: 'app.js',
    note: 'сдвиг на круг снят: длина набора кратна семи, и каждая строка навсегда садится на один день недели',
    edits: [['  const i = ((n + Math.floor(n / len)) % len + len) % len;',
      '  const i = ((n % len) + len) % len;']]
  },
  {
    id: '28E-B-кредо-вернулось-на-сегодня',
    file: 'app.js',
    note: 'кредо-строка возвращается вниз «Сегодня» — за сгиб, где её никто не видит, и вторым лозунгом на экране',
    edits: [["  el('scr-today').innerHTML = h;",
      "  h += `<p class=\"creed\">Минимум выполняется даже в худший день.</p>`;\n  el('scr-today').innerHTML = h;"]]
  },
  /* ── Задача 28.E, часть C: сцена закрытия дня ────────────────
     Заметный отклик в приложении один, и границы у него жёсткие:
     закрытие дня, «Сегодня», три фазы, покойное состояние невидимо. */
  {
    id: '28E-C-эффект-при-обычном-тапе',
    file: 'app.js',
    note: 'сцена играет на любой отметке, а не только на закрывающей день — заметный отклик перестаёт быть событием',
    // якорь обновлён в задаче Р2: условие сцены вынесено в переменную scene —
    // её читает и свёртка выполненного блока (todayFoldAfter, п. 4)
    edits: [['    const scene = on && minDayClosed(todayKey());',
      '    const scene = on;']]
  },
  {
    id: '28E-C-эффект-не-гасится-под-reduced-motion',
    file: 'app.js',
    note: 'ранний выход снят: при reduced-motion классы навешиваются, и покой экрана нарушен',
    edits: [['  if (prefersReducedMotion()) return;\n  const nodes = [dayline, label].filter(Boolean);',
      '  const nodes = [dayline, label].filter(Boolean);']]
  },
  {
    id: '28E-C-блик-рождается-в-горячем-пути',
    file: 'app.js',
    note: 'узел блика печатается не разметкой: точечный путь и полная перерисовка расходятся',
    edits: [['<div class="bar"><i style="width:${pct}%"><b class="sheen" aria-hidden="true"></b></i></div>',
      '<div class="bar"><i style="width:${pct}%"></i></div>'],
      ['  const nodes = [dayline, label].filter(Boolean);\n  if (!nodes.length) return;',
        '  const nodes = [dayline, label].filter(Boolean);\n  if (!nodes.length) return;\n' +
        '  const fill = dayline && dayline.querySelector(\'.bar i\');\n' +
        '  if (fill && !fill.querySelector(\'.sheen\')) fill.insertAdjacentHTML(\'beforeend\', \'<b class="sheen" aria-hidden="true"></b>\');']]
  },
  {
    id: '28E-C-фаза-вылезла-за-240',
    file: 'styles.css',
    note: 'фаза блика растянута до 300 мс — сцена перестаёт укладываться в раскадровку',
    edits: [['.dayline.closing .sheen { animation: .24s ease-out .1s day-sheen; }',
      '.dayline.closing .sheen { animation: .3s ease-out .1s day-sheen; }']]
  },
  {
    id: '28E-C-сцена-вылезла-за-360',
    file: 'styles.css',
    note: 'фраза стартует позже и сцена тянется 420 мс — потолок, легализованный архитектором, пробит',
    edits: [['.dayline.closing .bar-note { transform-origin: right center; animation: .24s ease-out .12s day-word; }',
      '.dayline.closing .bar-note { transform-origin: right center; animation: .24s ease-out .18s day-word; }']]
  },
  {
    id: '28E-C-покой-блика-виден',
    file: 'styles.css',
    note: 'блик виден в покое: при reduced-motion по планке остаётся неподвижная светлая полоса',
    edits: [['  width: 45%;\n  opacity: 0;\n  background: linear-gradient(90deg, transparent, var(--sheen), transparent);',
      '  width: 45%;\n  opacity: 1;\n  background: linear-gradient(90deg, transparent, var(--sheen), transparent);']]
  },
  {
    id: '28E-C-сторож-не-видит-задержку',
    file: 'tests/dom.test.js',
    note: 'разбор объявлений возвращается к первому числу: фазовая задержка снова не проверяется никем',
    edits: [["      const ts = [...part.matchAll(/(-?[\\d.]+)s(?![\\w-])/g)].map(m => Math.round(+m[1] * 1000));",
      "      const ts = [...part.matchAll(/(-?[\\d.]+)s(?![\\w-])/g)].map(m => Math.round(+m[1] * 1000)).slice(0, 1);"]]
  },
  {
    id: '29A-хвост-вернулся',
    file: 'app.js',
    note: 'единица снова дописывается хвостом к подписи «Подъёма»: «7 → 8 7» у упражнения с числом в поле «Единица»',
    edits: [['    const label = `${riseValue(it, a)} → ${riseValue(it, b)}`;',
      "    const label = `${riseValue(it, a)} → ${riseValue(it, b)}${it.type !== 'param' && it.unit ? ' ' + it.unit : ''}`;"]]
  },
  {
    id: '29A-единица-параметра-дважды',
    file: 'app.js',
    note: 'fmtParam снова вклеивает единицу параметра-числа в ОБА значения: «4000 шаг. → 5000 шаг.»',
    edits: [["  return (it.type === 'param' && it.pkind === 'time') ? fmtParam(it, v) : String(v);",
      "  return it.type === 'param' ? fmtParam(it, v) : String(v);"]]
  },
  {
    id: '29A-подсказка-зовёт-пункт-привычкой',
    file: 'app.js',
    note: 'подсказка снова говорит текстом до задачи 29/A: «правило системы», которого в «Системе» нет, и «последний пункт» вместо предмета формы',
    // Переписан в задаче Р1. Ветка минимума снята вместе с формой
    // добавления минимума и полем ui.addArea: действия заводятся быстрым
    // добавлением, где подсказки нет вовсе (это сторожит тест З22/7.2, а
    // строку «Одно новое дело за раз» — его же doesNotMatch по APP). Вторая
    // половина прежнего предмета — «называет привычкой минимум» — ушла вместе
    // с формой: назвать минимум больше негде. Осталась первая: мутант
    // возвращает прежний текст в единственную оставшуюся форму
    edits: [['<p class="hint">Одна новая привычка за раз: последнее добавлено меньше 14 дней назад.</p>',
      '<p class="hint">Правило системы: одна новая привычка за раз. Последний пункт добавлен меньше 14 дней назад.</p>']]
  },
  {
    id: '29A-взводка-блока-вне-шаблона',
    file: 'app.js',
    note: 'уход блока снова взводится вне общего шаблона «Подтвердить: {глагол} {предмет}» — кнопка без предмета и словом «удаление»',
    // Переписан в задаче Р1. Удаления блока больше нет (deleteGroup,
    // «Удалить блок» и ui.groupDelete сняты: блок несёт дни, от которых
    // зависит прошлое, и по словарю конституции он убирается). Взводка
    // второго тапа у блока осталась — у «Убрать блок», — и предмет мутанта
    // переехал туда: подпись кнопки выпадает из шаблона и возвращает
    // прежнее слово. Шаблон — тот же, что у «Убрать» пункта
    edits: [["${armed ? 'Подтвердить: убрать блок' : 'Убрать блок'}",
      "${armed ? 'Подтвердить удаление' : 'Удалить'}"]]
  },
  {
    id: '29A-акцент-вернулся-в-справку',
    file: 'styles.css',
    note: 'история планки снова печатается акцентом: справка читается как объявление',
    edits: [['.hist { font-size: var(--text-xs); line-height: 1.35; color: var(--muted); }',
      '.hist { font-size: var(--text-xs); line-height: 1.35; color: var(--accent); }']]
  },
  {
    id: '29B-маска-игнорируется',
    file: 'app.js',
    note: 'применимость снова читает только отрезок жизни: расписание не влияет ни на что',
    // якорь обновлён в задаче Р1: день недели проверяет inEffectiveDays
    // (своя маска ∧ дни блока); снимается вся проверка, как прежде
    edits: [['  return livedOn(item, dayKey) && inEffectiveDays(item, dayKey);',
      '  return livedOn(item, dayKey);']]
  },
  {
    id: '29B-маска-переписывает-прошлое',
    file: 'app.js',
    note: 'scheduleOn отдаёт НЫНЕШНЮЮ маску для любого дня — ровно дефект поля active (28.E/A)',
    // якорь обновлён в задаче Р1: тот же цикл дословно получил blockMaskOn
    // (дни блока — те же отрезки). Якорь — строка списка отрезков пункта
    edits: [['  const segs = Array.isArray(item && item.schedule) ? item.schedule : [];\n  for (let i = segs.length - 1; i >= 0; i--) {\n    if (segs[i].from <= dayKey) return segs[i].mask;\n  }\n  return WEEK_ALL;',
      '  const segs = Array.isArray(item && item.schedule) ? item.schedule : [];\n  return segs.length ? segs[segs.length - 1].mask : WEEK_ALL;']]
  },
  {
    id: '29B-смена-маски-затирает-отрезки',
    file: 'app.js',
    note: 'setSchedule заменяет весь список одним отрезком: прошлое теряет свои маски',
    // якорь обновлён в задаче Р1: ядро смены (scheduleCore) снимает весь
    // хвост с from ≥ сегодня, а не только сегодняшний отрезок, и пишет
    // отрезок в опустевший список всегда. Порча прежняя — список обнуляется
    edits: [['  while (segs.length && segs[segs.length - 1].from >= t) segs.pop();\n  const prev = segs.length ? segs[segs.length - 1].mask : WEEK_ALL;\n  if (prev !== mask || !segs.length)',
      '  segs.length = 0;\n  const prev = segs.length ? segs[segs.length - 1].mask : WEEK_ALL;\n  if (prev !== mask || !segs.length)']]
  },
  {
    id: '29B-сквозной-день-рвёт-серию',
    file: 'app.js',
    note: 'день без применимых пунктов снова даёт ноль вместо null — серия рвётся на выходном по расписанию',
    // якорь обновлён в задаче Р2: нейтральность дня решает planned, а не
    // знаменатель (пропуски выпадают из total, но день нейтральным не делают),
    // и null ушёл в отдельную строку. Порча прежняя — пустой план даёт 0
    edits: [['  if (!m.planned) return null;\n  return m.total > 0 ? m.done / m.total : 0;', '  return m.total > 0 ? m.done / m.total : 0;']]
  },
  {
    id: '29B-цепь-читает-сквозной-как-пропуск',
    file: 'app.js',
    note: 'сквозной день снова рисуется пустой ячейкой, то есть пропуском',
    edits: [['      if (s === null) { cells += `<i class="cd off"></i>`; continue; }', '']]
  },
  {
    id: '29B-норма-не-зажимается',
    file: 'app.js',
    note: 'норма привычки снова может превышать число дней маски — невыполнима с рождения',
    edits: [['  if (was <= cap) return null;\n  item.normPerWeek = cap;\n  return was;',
      '  if (was <= cap) return null;\n  return null;']]
  },
  {
    id: '29B-норма-не-зажимается-в-migrate',
    file: 'app.js',
    note: 'импорт снова приносит невыполнимую норму: потолок опять семь, а не число дней маски',
    edits: [['      const cap = maskDays(it.schedule[it.schedule.length - 1].mask);', '      const cap = 7;']]
  },
  {
    id: '29B-пороги-захардкожены',
    file: 'app.js',
    note: 'пороги планки снова «6 из 7» и «3 из 7»: расписанный пункт не растёт никогда и вечно получает «Сделать легче»',
    edits: [['const raiseNeed = m => Math.ceil(6 / 7 * m);\nconst lowerNeed = m => Math.floor(3 / 7 * m);',
      'const raiseNeed = () => 6;\nconst lowerNeed = () => 3;']]
  },
  {
    id: '29B-знаменатель-отметок-календарный',
    file: 'app.js',
    note: 'знаменатель «Отметок» снова считает календарные дни: воскресный пункт читается «1 из 12»',
    edits: [['  let n = 0;\n  for (let k = from; k <= t; k = addDays(k, 1)) if (dueOn(item, k)) n++;\n  return n;',
      '  return diffDays(t, from) + 1;']]
  },
  {
    id: '29B-точка-за-день-вне-расписания',
    file: 'app.js',
    note: 'точка «вчера — пропуск» снова рождается в день, в который дела не стояло',
    edits: [['  if (!dueOn(item, y) || isMarked(y, item.id)) return false;',
      '  if (!livedOn(item, y) || isMarked(y, item.id)) return false;']]
  },
  {
    id: '29B-ретро-отметка-вне-расписания',
    file: 'app.js',
    note: 'markYesterday снова пишет отметку в день, которого у пункта нет',
    edits: [['  if (!dueOn(item, y)) return false;\n  if (isMarked(y, item.id)) return false;',
      '  if (isMarked(y, item.id)) return false;']]
  },
  {
    id: '29B-время-в-расчёте',
    file: 'app.js',
    note: 'время перестаёт быть подписью: пункт с вписанным временем выпадает из применимости',
    edits: [['function dueOn(item, dayKey) {', 'function dueOn(item, dayKey) {\n  if (item.at) return false;']]
  },
  {
    id: '29B-сортировка-по-времени',
    file: 'app.js',
    note: 'список дня сортируется по времени — ручной порядок (инвариант 17) перестаёт держаться',
    edits: [["const dueDaily = (area, t) => liveDaily().filter(i => i.area === area && dueNow(i, t));",
      "const dueDaily = (area, t) => liveDaily().filter(i => i.area === area && dueNow(i, t)).sort((a, b) => (a.at || '99:99') < (b.at || '99:99') ? -1 : 1);"]]
  },
  {
    id: '29B-горячий-путь-не-видит-маску',
    file: 'app.js',
    note: 'точечное обновление планки снова считает по «есть сейчас» — расходится с перерисовкой',
    edits: [["  const items = dueDaily('min', t); // то же правило, что в renderToday: сторож сравнивает их вывод",
      "  const items = liveDaily().filter(i => i.area === 'min');"]]
  },
  {
    id: '29B-полоса-привычки-без-третьего-состояния',
    file: 'app.js',
    note: 'дни вне маски в полосе недели снова рисуются пустым кружком, то есть пропуском',
    edits: [["    const off = scheduleOn(it, k)[weekdayOf(k)] !== '1';", '    const off = false;']]
  },
  {
    id: '29B-миграция-не-ставит-якорь',
    file: 'app.js',
    note: 'normSchedule перестаёт достраивать отрезок «все семь» с дня заведения',
    edits: [["  if (!out.length || out[0].from !== addedAt) out.unshift({ from: addedAt, mask: WEEK_ALL });", '']]
  },
  {
    id: '29B-пустая-маска-проходит',
    file: 'app.js',
    note: 'маска без единого дня становится расписанием: пункт исчезает навсегда, а «Убрать» тут ни при чём',
    edits: [['  if (!isMask(mask) || maskDays(mask) === 0) return false; // пустая маска — не расписание',
      '  if (!isMask(mask)) return false;']]
  },
  {
    id: '29B-отрезки-не-считаются-в-потерях',
    file: 'app.js',
    note: 'потеря отрезков расписания при импорте снова проходит молча (инвариант 6)',
    edits: [['    schedule: sum(s && s.items, x => x.schedule),', '    schedule: 0,']]
  },

  /* ── Задача «Расписание 1/3» (Р1): дни блока, журнал, быстрое добавление ─
     Блок получил дни недели, и от него стали зависеть прошлые числа его
     действий. Отсюда три оси, и мутанты идут по ним: (1) эффективные дни —
     ∧ с днями блока того дня, по журналу принадлежности, и пороги планки,
     которые считают по ним; (2) блок из «удаляется» стал «убирается» — уход,
     возврат, копия, занятость имени, отказы по днях; (3) интерфейс и данные
     — быстрое добавление, форма действия, migrate, счёт потерь, разбор.
     «до задачи» в note — мутант возвращает поведение, каким оно было до Р1;
     «ошибка» — правдоподобная порча нового кода. */
  {
    id: 'R1-эффективная-маска-без-дней-блока',
    file: 'app.js',
    note: 'до задачи: effectiveMaskOn отдаёт только свою маску — дни блока не ограничивают действие',
    edits: [['  return g ? andMask(own, blockMaskOn(g, dayKey)) : own;', '  return own;']]
  },
  {
    id: 'R1-горячая-применимость-без-дней-блока',
    file: 'app.js',
    note: 'ошибка: inEffectiveDays (горячий путь серии и рекорда) забывает ∧ с блоком и расходится с effectiveMaskOn',
    edits: [["  return !g || blockMaskOn(g, dayKey)[wd] === '1';", '  return true;']]
  },
  {
    id: 'R1-groupOn-игнорирует-журнал',
    file: 'app.js',
    note: 'до задачи: блок дня — нынешний item.group; перенос в будний блок задним числом выбрасывает действие из прошлых выходных',
    edits: [['  if (!log.length) return groupNameOf(item);', '  return groupNameOf(item);']]
  },
  {
    id: 'R1-смена-блока-без-журнала',
    file: 'app.js',
    note: 'до задачи: setItemGroup меняет только item.group — истории принадлежности нет, прошлое переписывается',
    edits: [["  if (item.type === 'daily' && item.area === 'min') {\n    const t = todayKey();\n    const log = Array.isArray(item.groupLog)",
      "  if (false) {\n    const t = todayKey();\n    const log = Array.isArray(item.groupLog)"]]
  },
  {
    id: 'R1-повышение-при-неделе-без-дней',
    file: 'app.js',
    note: 'ошибка: guard m = 0 снят у повышения — raiseNeed(0) = 0, и пункт с пустой неделей «держится» без единой отметки',
    edits: [['  if (ms.some(m => m === 0)) return false;\n  if (!W.every((w, i) => planWeekCount(item, w) >= raiseNeed(ms[i]))) return false;',
      '  if (!W.every((w, i) => planWeekCount(item, w) >= raiseNeed(ms[i]))) return false;']]
  },
  {
    id: 'R1-понижение-при-неделе-без-дней',
    file: 'app.js',
    note: 'ошибка: guard m = 0 снят у понижения — тот же пункт готов и к повышению, и к понижению в одном разборе',
    edits: [['  if (ms.some(m => m === 0)) return false;\n  if (!W.every((w, i) => planWeekCount(item, w) <= lowerNeed(ms[i]))) return false;',
      '  if (!W.every((w, i) => planWeekCount(item, w) <= lowerNeed(ms[i]))) return false;']]
  },
  {
    id: 'R1-повышение-считает-отметки-вне-плана',
    file: 'app.js',
    note: 'до задачи: числитель повышения — все отметки недели (itemWeekCount), отметка в дне вне плана засчитывается',
    edits: [['planWeekCount(item, w) >= raiseNeed(ms[i])', 'itemWeekCount(item, w) >= raiseNeed(ms[i])']]
  },
  {
    id: 'R1-понижение-считает-отметки-вне-плана',
    file: 'app.js',
    note: 'до задачи: числитель понижения — все отметки недели (itemWeekCount), отметка вне плана прячет «не держится»',
    edits: [['planWeekCount(item, w) <= lowerNeed(ms[i])', 'itemWeekCount(item, w) <= lowerNeed(ms[i])']]
  },
  {
    id: 'R1-журнал-блока-неидемпотентен',
    file: 'app.js',
    note: 'ошибка: normGroupLog дописывает нынешний блок ПОСЛЕ дедупа — migrate(migrate(x)) ≠ migrate(x), в журнале два состояния одного дня',
    edits: [
      ['  if (log.length && log[log.length - 1].group !== cur) {\n    const lastFrom = log[log.length - 1].from;\n    log.push({ from: today > lastFrom ? today : lastFrom, group: cur });\n  }\n', ''],
      ['    out.push(e);\n  }\n  if (out.length && out[0].from > addedAt) out[0].from = addedAt;',
        '    out.push(e);\n  }\n  if (out.length && out[out.length - 1].group !== cur) {\n    const lastFrom = out[out.length - 1].from;\n    out.push({ from: today > lastFrom ? today : lastFrom, group: cur });\n  }\n  if (out.length && out[0].from > addedAt) out[0].from = addedAt;']
    ]
  },
  {
    id: 'R1-стрелки-блоков-считают-убранные',
    file: 'app.js',
    note: 'до задачи: moveGroup меняется местами с убранным блоком — стрелка «срабатывает», а на экране ничего не движется',
    // якорь обновлён в задаче Р2: соседи ищутся в режиме (liveGroupIndexes(m)).
    // Порча прежняя — убранные считаются соседями; область режима в мутанте
    // сохранена, чтобы он снимал ровно правило Р1
    edits: [['  const idxs = liveGroupIndexes(m);\n  const at = idxs.indexOf(i);',
      '  const idxs = store.groups.map((g, k) => (blockMode(g) === m ? k : -1)).filter(k => k >= 0);\n  const at = idxs.indexOf(i);']]
  },
  {
    id: 'R1-перетаскивание-блоков-считает-убранные',
    file: 'app.js',
    note: 'до задачи: reorderGroup считает позицию среди всех блоков — убранный занимает место в порядке живых',
    // якорь обновлён в задаче Р2: позиция считается в режиме
    // (liveGroupIndexes(m)); область режима в мутанте сохранена
    edits: [['  if (!g || !live(g)) return false;\n  const idxs = liveGroupIndexes(m);',
      '  if (!g || !live(g)) return false;\n  const idxs = store.groups.map((x, k) => (blockMode(x) === m ? k : -1)).filter(k => k >= 0);']]
  },
  {
    id: 'R1-уход-блока-оставляет-пункты',
    file: 'app.js',
    note: 'ошибка: removeGroup уводит только блок — его действия остаются на «Сегодня» без заголовка и с днями невидимого блока',
    edits: [['  g.removedAt = t;\n  for (const it of touched) it.removedAt = t;', '  g.removedAt = t;']]
  },
  {
    id: 'R1-уход-блока-только-ежедневные',
    file: 'app.js',
    note: 'ошибка: removeGroup уводит только ежедневные — счётчик и параметр блока остаются живыми в убранном блоке',
    // якорь обновлён в задаче Р2: выборка разделилась по режиму — действия
    // режима блока, глобальные пункты только без живого одноимённого блока
    // (namesake). Порча прежняя — уводятся только ежедневные
    edits: [['  const touched = store.items.filter(it => live(it) && groupNameOf(it) === g.name &&\n    (isAction(it) ? itemMode(it) === md : !namesake));',
      "  const touched = store.items.filter(it => live(it) && it.type === 'daily' && groupNameOf(it) === g.name &&\n    (isAction(it) ? itemMode(it) === md : !namesake));"]]
  },
  {
    id: 'R1-возврат-блока-без-пунктов',
    file: 'app.js',
    note: 'ошибка: restoreGroup возвращает пустой блок — ушедшие с ним действия остаются в «Убранных» поштучно',
    // якорь обновлён в задаче Р2: набор возврата вынесен в restoreSetOf (его
    // читает и строка «Вернулись с днями блока»)
    edits: [['  const back = restoreSetOf(g, when).map(it => it.id);', '  const back = [];']]
  },
  {
    id: 'R1-копия-блока-с-привычками',
    file: 'app.js',
    note: 'ошибка: duplicateGroup копирует и привычки — они становятся действиями минимума (area min в копии)',
    edits: [["    .filter(it => live(it) && it.area === 'min' && (it.type === 'daily' || it.type === 'weekly') &&",
      "    .filter(it => live(it) && (it.type === 'daily' || it.type === 'weekly') &&"]]
  },
  {
    id: 'R1-копия-блока-без-дней',
    file: 'app.js',
    note: 'ошибка: копия блока не получает дни источника — будний блок копируется ежедневным',
    // якорь обновлён в задаче Р2: та же строка дней появилась у копии режима
    // (addMode) и копии блока в другой режим (duplicateGroupTo) — прежний
    // текст встречался трижды. Якорь — хвост литерала duplicateGroup
    edits: [['    days: m !== WEEK_ALL ? [{ from: t, mask: m }] : [],\n    removedAt: null,\n    mode: md\n  };\n  // действия режима блока',
      '    days: [],\n    removedAt: null,\n    mode: md\n  };\n  // действия режима блока']]
  },
  {
    id: 'R1-имя-занято-только-в-списке-блоков',
    file: 'app.js',
    note: 'до задачи: nameTaken смотрит только store.groups — переименование в осиротевшее имя применяет дни блока к прошлому чужих пунктов',
    // якорь обновлён в задаче Р2: имя занимают только действия режима
    // (isAction, itemMode). Порча прежняя — пункты имя не занимают вовсе
    edits: [['  return store.items.some(it => isAction(it) && itemMode(it) === m && (groupNameOf(it) === n ||\n    (Array.isArray(it.groupLog) && it.groupLog.some(e => e && e.group === n))));', '  return false;']]
  },
  {
    id: 'R1-вход-в-убранный-блок-без-отказа',
    file: 'app.js',
    note: 'ошибка: groupJoinRefusal выключен — пункт молча входит в убранный блок: на экране «без блока», а маска невидимого блока режет дни',
    edits: [["  return g && !live(g) ? `Блок «${g.name}» убран — вернуть можно в «Убранных»` : null;", '  return null;']]
  },
  {
    id: 'R1-правка-блока-оставляет-действие-без-дней',
    file: 'app.js',
    note: 'ошибка: updateGroup не проверяет zeroDaysIn — сужение дней блока оставляет действие без единого дня, неотличимым от убранного',
    // якорь обновлён в задаче Р2: zeroDaysIn получила режим блока
    edits: [['    const names = zeroDaysIn(from, mask, md);', '    const names = [];']]
  },
  {
    id: 'R1-новый-блок-оставляет-действие-без-дней',
    file: 'app.js',
    note: 'ошибка: addGroup в осиротевшее имя не проверяет zeroDaysIn — действия с этим именем входят в блок без единого дня',
    // якорь обновлён в задаче Р2: zeroDaysIn получила режим нового блока
    edits: [['  if (zeroDaysIn(n, m, md).length) return false;\n', '']]
  },
  {
    id: 'R1-форма-нового-блока-не-называет-действия-без-дней',
    file: 'app.js',
    note: 'ошибка: «Добавить блок» не спрашивает zeroDaysIn — отказ домена проходит молча, форма закрывается без записи и без строки',
    edits: [['      const zero = byName || maskDays(mask) === 0 ? [] : zeroDaysIn(nm, mask);', '      const zero = [];']]
  },
  {
    id: 'R1-правка-действия-оставляет-без-дней',
    file: 'app.js',
    note: 'ошибка: форма действия не проверяет итоговый блок — перенос в блок с чужими днями сохраняет пункт без единого дня',
    edits: [['  if ((st.touched || moved) && maskDays(andMask(mask !== null ? mask : st.now, fm)) === 0) {', '  if (false) {']]
  },
  {
    id: 'R1-свои-дни-режут-биты-вне-блока',
    file: 'app.js',
    note: 'ошибка: mergeOwnMask обнуляет свою маску вне дней блока — при переносе в блок с другими днями дни, которых владелец не снимал, потеряны',
    edits: [["  for (let i = 0; i < 7; i++) out += w[i] === '1' ? p[i] : o[i];", "  for (let i = 0; i < 7; i++) out += w[i] === '1' ? p[i] : '0';"]]
  },
  {
    id: 'R1-расписание-пишется-без-касания',
    file: 'app.js',
    note: 'ошибка: «Сохранить» без касания дней пишет показанный выбор (своя ∧ блок) своей маской — «как блок» застывает днями блока на сегодня',
    edits: [['function editDaysOutcome(it, st, finalGroup, shownName) {\n  let mask = null;', 'function editDaysOutcome(it, st, finalGroup, shownName) {\n  let mask = st.pick;']]
  },
  {
    id: 'R1-тип-меняется-не-в-день-заведения',
    file: 'app.js',
    note: 'ошибка: canChangeType не проверяет день заведения — ежедневный с историей отметок становится счётчиком, отметки остаются без пункта',
    edits: [["  return !!item && item.area === 'min' && (item.type === 'daily' || item.type === 'weekly') &&\n    item.addedAt === todayKey();",
      "  return !!item && item.area === 'min' && (item.type === 'daily' || item.type === 'weekly');"]]
  },
  {
    id: 'R1-быстрое-добавление-режет-по-косой',
    file: 'app.js',
    note: 'ошибка: «/» считается разделителем подписи — «Подтягивания / отжимания» становится именем «Подтягивания» с подписью',
    // якорь обновлён в задаче Р2: разделителей стало четыре (« · », « — »,
    // « – », « - »). Порча прежняя — к ним добавляется «/»
    edits: [['    const m = /^(.*?)\\s+[·—–-](?:\\s+(.*))?$/.exec(line);', '    const m = /^(.*?)\\s+[·—–\\/-](?:\\s+(.*))?$/.exec(line);']]
  },
  {
    id: 'R1-быстрое-добавление-режет-по-последней-точке',
    file: 'app.js',
    note: 'ошибка: жадная группа режет по ПОСЛЕДНЕМУ « · » — «Чтение · 20 мин · перед сном» даёт имя «Чтение · 20 мин»',
    // якорь обновлён в задаче Р2: разделителей стало четыре; порча прежняя —
    // жадная группа имени
    edits: [['    const m = /^(.*?)\\s+[·—–-](?:\\s+(.*))?$/.exec(line);', '    const m = /^(.*)\\s+[·—–-](?:\\s+(.*))?$/.exec(line);']]
  },
  {
    id: 'R1-отказ-быстрого-добавления-закрывает-форму',
    file: 'app.js',
    note: 'до задачи 26 (правило отказов): отказ записи закрывает быструю форму молча — набранные строки пропадают',
    edits: [["      if (!made.length) { refuse(b, 'Не добавлено: хранилище недоступно'); break; }", '      if (!made.length) { ui.quickFor = null; renderSettings(); break; }']]
  },
  {
    id: 'R1-преемник-не-опознаётся',
    file: 'app.js',
    note: 'до задачи: laterSegmentOf выключен — прежний отрезок стоит в «Убранных» рядом с живым преемником, и «Вернуть» заводит дубль',
    edits: [['function laterSegmentOf(item) {\n  if (!item || live(item) || !item.removedAt) return null;', 'function laterSegmentOf(item) {\n  return null;']]
  },
  {
    id: 'R1-миграция-не-возвращает-блок-живого-пункта',
    file: 'app.js',
    note: 'ошибка: импорт живого пункта в убранный блок оставляет блок убранным — маска невидимого блока режет дни, снять нечем',
    // якорь обновлён в задаче Р2: возврат разделился по режиму — блок режима
    // живого действия и блок живого глобального пункта, если одноимённого
    // живого нет нигде. Снимаются обе ветки: порча прежняя — ни один блок не
    // возвращается.
    // якорь обновлён в задаче Р3: в цикл по глобальным именам встал
    // комментарий о holdsName, и цельный текст блока исчез. Ветки снимаются
    // двумя заменами без комментария: строка возврата блоков действий
    // удаляется, цикл глобальных имён идёт по пустому списку — порча та же
    edits: [
      ['    for (const g of s.groups) if (g.removedAt !== null && liveActions.has(JSON.stringify([g.mode, g.name]))) g.removedAt = null;\n', ''],
      ['    for (const name of liveGlobal) {\n', '    for (const name of []) {\n']
    ]
  },
  {
    id: 'R1-миграция-не-чинит-подпись-блока',
    file: 'app.js',
    note: 'ошибка: migrate берёт подпись блока как есть — undefined и число доезжают до рендера и экспорта',
    edits: [["        caption: typeof g.caption === 'string' ? g.caption.trim() : '',", '        caption: g.caption,']]
  },
  {
    id: 'R1-миграция-не-чинит-дни-блока',
    file: 'app.js',
    note: 'ошибка: migrate берёт дни блока как есть — мусорные отрезки, пустая маска и ведущий «все семь» остаются в каноне',
    edits: [['        days: normBlockDays(g.days),', '        days: g.days,']]
  },
  {
    id: 'R1-потери-дней-блока-не-называются',
    file: 'app.js',
    note: 'ошибка: категория blockDays в dataCounts обнулена — импорт, роняющий отрезки дней блока, молчит (инвариант 6)',
    edits: [['    blockDays: sum(s && s.groups, x => x.days),', '    blockDays: 0,']]
  },
  {
    id: 'R1-потери-журнала-блока-не-называются',
    file: 'app.js',
    note: 'ошибка: категория groupLog в dataCounts обнулена — импорт, роняющий записи о блоке, молчит (инвариант 6)',
    edits: [['    groupLog: sum(s && s.items, x => x.groupLog),', '    groupLog: 0,']]
  },
  {
    id: 'R1-убранный-блок-на-дневном-экране',
    file: 'app.js',
    note: 'до задачи: groupedItems рисует заголовки и убранных блоков — ушедшее из виду остаётся на «Сегодня»',
    // якорь обновлён в задаче Р2: раскладка строится по блокам режима, и
    // проверка живости слилась с проверкой режима в одну строку
    edits: [['    if (!live(g) || blockMode(g) !== m) continue;', '    if (blockMode(g) !== m) continue;']]
  },
  {
    id: 'R1-пустой-день-зовёт-заводить-пункты',
    file: 'app.js',
    note: 'до задачи: в день без запланированных действий «Сегодня» пишет «Пунктов пока нет — добавить можно…» и зовёт заводить заведённое',
    // якорь обновлён в задаче Р2: считаются действия активного режима
    edits: [["  } else if (liveDaily().some(i => i.area === 'min' && itemMode(i) === modeOn(t))) {", '  } else if (false) {']]
  },
  {
    id: 'R1-сетка-разбора-считает-отметки-вне-плана',
    file: 'app.js',
    note: 'ошибка: weekPlan считает done по всем отметкам, а planned по плану — сетка разбора читается «2 из 1»',
    edits: [['    if (!dueOn(item, k)) continue;\n    planned++;\n    if (isMarked(k, item.id)) done++;',
      '    if (isMarked(k, item.id)) done++;\n    if (!dueOn(item, k)) continue;\n    planned++;']]
  },
  {
    id: 'R1-подпись-плана-при-семи-днях',
    file: 'app.js',
    note: 'ошибка: «запланировано 7 дней» печатается у каждого ежедневного действия — подпись, которая ничего не сообщает',
    // якорь обновлён в задаче Р2: подпись собирается частями — рядом с
    // «запланировано D дней» встало «пропусков K», и условие ушло в строку push
    edits: [['          if (p.planned < 7) parts.push(', '          if (p.planned <= 7) parts.push(']]
  },
  {
    id: 'R1-убрать-блок-одним-тапом',
    file: 'app.js',
    note: 'до задачи (по образцу «Удалить блок»): «Убрать блок» срабатывает с первого тапа — блок и все его действия уходят промахом по кнопке',
    edits: [["      const key = 'group:' + nm;\n      if (ui.removeConfirm !== key) { ui.removeConfirm = key; renderSettings(); break; }\n", "      const key = 'group:' + nm;\n"]]
  },
  {
    id: 'R1-блок-берётся-не-за-шапку',
    file: 'app.js',
    note: 'ошибка: долгое нажатие в теле карточки поднимает весь блок — строки действий становятся ручкой перетаскивания',
    edits: [["  if (row.dataset.drag === 'group' && !e.target.closest('.bhead')) return;\n", '']]
  },
  {
    id: 'R1-импорт-не-гасит-формы',
    file: 'app.js',
    note: 'ошибка: importJSON не зовёт resetSettingsView — быстрая форма, форма блока и свёртка остаются открытыми над чужими данными',
    edits: [['    resetSettingsView();\n    ui.missOpen = {};', '    ui.missOpen = {};']]
  },
  {
    id: 'R1-система-снова-удаляет-блоки',
    file: 'app.js',
    note: 'до задачи: «Система» говорит, что блоки удаляются и пункты не трогают, — словарь «удалить/убрать» расходится с интерфейсом',
    edits: [["text: 'Блоки заводятся, переименовываются и убираются в Настройках → Расписание; убранный блок уводит из виду свои действия и привычки, отметки остаются.'",
      "text: 'Блоки заводятся, переименовываются и удаляются в Настройках; удаление блока пункты не трогает.'"]]
  },

  /* ── Задача Р2: режимы, «Не сегодня», свёртка блока, хвосты Р1 ──────
     Решение архитектора: мутанты — только для НОВЫХ доменных функций Р2 и
     новых доменных правил внутри прежних. Оси: (1) режимы — нормализация,
     режим дня, область режима у блоков и действий, операции над режимами и
     копия блока в другой режим; (2) пропуск «Не сегодня» — кодирование
     false, знаменатель дня, отказы отметки и точки «вчера», счёт недели и
     свёртка блока; (3) хвосты Р1 — разделители быстрого добавления,
     преемник упражнения, «Убранные» по всем режимам; (4) migrate v20.
     «до задачи» в note — поведение, каким оно было до Р2; «ошибка» —
     правдоподобная порча нового кода. */
  {
    id: 'R2-основной-режим-не-дописывается',
    file: 'app.js',
    note: 'ошибка: normModes не дописывает основной режим в список без него — файл v19 получает пустой выбор режимов, а действия ссылаются на режим, которого нет',
    edits: [['  if (!main) { main = { id: MAIN_MODE, name: MAIN_MODE_NAME, removedAt: null }; valid.unshift(main); }',
      '  if (!main) { main = { id: MAIN_MODE, name: MAIN_MODE_NAME, removedAt: null }; }']]
  },
  {
    id: 'R2-дубль-имени-режима-уводит-в-основной',
    file: 'app.js',
    note: 'ошибка: normModes роняет дубль имени без переадресации — блоки и действия дубля уезжают в основной, а не к одноимённому режиму',
    edits: [['    if (names.has(x.name)) { if (!remap.has(x.id)) remap.set(x.id, names.get(x.name)); continue; }',
      '    if (names.has(x.name)) continue;']]
  },
  {
    id: 'R2-журнал-режимов-хранит-ведущий-основной',
    file: 'app.js',
    note: 'ошибка: normModeLog оставляет ведущий отрезок основного режима — второй способ сказать «основной», migrate от канона меняет журнал',
    edits: [['    if (!out.length && seg.mode === MAIN_MODE) continue;', '']]
  },
  {
    id: 'R2-режим-дня-с-опозданием-на-день',
    file: 'app.js',
    note: 'ошибка: modeOn сравнивает from строго — в день переключения действует прежний режим, выбор вступает в силу назавтра',
    edits: [['    if (segs[mid].from <= dayKey) { at = mid; lo = mid + 1; } else hi = mid - 1;',
      '    if (segs[mid].from < dayKey) { at = mid; lo = mid + 1; } else hi = mid - 1;']]
  },
  {
    id: 'R2-активный-режим-всегда-основной',
    file: 'app.js',
    note: 'до задачи: activeMode не читает журнал — «Выбрать» пишет отрезок, а «Сегодня», формы и списки остаются в основном режиме',
    edits: [['const activeMode = () => modeOn(todayKey());', 'const activeMode = () => MAIN_MODE;']]
  },
  {
    id: 'R2-запись-без-поля-режима-выпадает',
    file: 'app.js',
    note: 'ошибка: itemMode не читает отсутствие поля основным — запись, собранная без mode, не принадлежит ни одному режиму и выпадает из всех дней',
    edits: [["const itemMode = it => (it && typeof it.mode === 'string' && it.mode ? it.mode : MAIN_MODE);",
      'const itemMode = it => (it ? it.mode : MAIN_MODE);']]
  },
  {
    id: 'R2-действие-чужого-режима-в-области',
    file: 'app.js',
    note: 'до задачи: belongsToMode пускает любую запись — действие чужого режима встаёт под одноимённый блок и возвращается вместе с чужим блоком',
    edits: [['const belongsToMode = (it, mode) => !isAction(it) || itemMode(it) === mode;',
      'const belongsToMode = (it, mode) => true;']]
  },
  {
    id: 'R2-глобальный-пункт-привязан-к-режиму',
    file: 'app.js',
    note: 'ошибка: belongsToMode судит глобальный пункт по itemMode — привычка и счётчик принадлежат только основному режиму',
    edits: [['const belongsToMode = (it, mode) => !isAction(it) || itemMode(it) === mode;',
      'const belongsToMode = (it, mode) => itemMode(it) === mode;']]
  },
  {
    id: 'R2-имя-убранного-режима-свободно',
    file: 'app.js',
    note: 'ошибка: modeNameTaken смотрит только живые режимы — после возврата убранного в выборе два одноимённых режима',
    edits: [['  return modeList().some(m => m.id !== exceptId && m.name === n);',
      '  return liveModes().some(m => m.id !== exceptId && m.name === n);']]
  },
  {
    id: 'R2-копия-режима-несёт-убранные-блоки',
    file: 'app.js',
    note: 'ошибка: addMode копирует и убранные блоки источника — в новом режиме живым встаёт блок, который владелец убрал',
    edits: [['      if (!live(g) || blockMode(g) !== copyOf) continue;', '      if (blockMode(g) !== copyOf) continue;']]
  },
  {
    id: 'R2-копия-действия-без-своей-маски',
    file: 'app.js',
    note: 'ошибка: actionCopy даёт копии «все семь» — свои дни действия («пн, ср, пт») в новом режиме потеряны',
    edits: [['    schedule: [{ from: t, mask: scheduleNow(src) }], groupLog: [], mode',
      '    schedule: [{ from: t, mask: WEEK_ALL }], groupLog: [], mode']]
  },
  {
    id: 'R2-режим-переименовывается-в-занятое',
    file: 'app.js',
    note: 'ошибка: renameMode не проверяет занятость — два режима с одним именем, выбирать нечем различить',
    edits: [["  if (modeNameTaken(n, id)) return { ok: false, reason: 'taken' };\n  const was = m.name;", '  const was = m.name;']]
  },
  {
    id: 'R2-активный-режим-убирается',
    file: 'app.js',
    note: 'ошибка: removeMode убирает и активный режим — сегодняшний день остаётся без режима, который можно выбрать',
    edits: [["  if (activeMode() === id) return { ok: false, reason: 'active' };\n", '']]
  },
  {
    id: 'R2-возврат-режима-без-отката',
    file: 'app.js',
    note: 'ошибка: restoreMode при отказе записи не откатывает поле — в памяти режим живой, на диске убранный',
    edits: [['  m.removedAt = was;\n', '']]
  },
  {
    id: 'R2-выбор-режима-оставляет-хвост-из-будущего',
    file: 'app.js',
    note: 'ошибка: setActiveMode снимает только сегодняшний отрезок — отрезок «из будущего» остаётся перед новым, и выбор проигрывает прежнему',
    edits: [['  while (log.length && log[log.length - 1].from >= t) log.pop();\n  const prev = log.length ? log[log.length - 1].mode : MAIN_MODE;',
      '  while (log.length && log[log.length - 1].from === t) log.pop();\n  const prev = log.length ? log[log.length - 1].mode : MAIN_MODE;']]
  },
  {
    id: 'R2-выбор-прежнего-режима-не-схлопывает',
    file: 'app.js',
    note: 'ошибка: setActiveMode пишет отрезок и при возврате к прежнему режиму — подряд одинаковые отрезки, журнал не канон',
    edits: [['  if (prev !== id) log.push({ from: t, mode: id });', '  log.push({ from: t, mode: id });']]
  },
  {
    id: 'R2-выбирается-убранный-режим',
    file: 'app.js',
    note: 'ошибка: setActiveMode не проверяет живость — активным становится режим, которого в выборе нет',
    edits: [["  if (!live(m)) return { ok: false, reason: 'removed' };\n  if (!Array.isArray(store.modeLog)) store.modeLog = [];",
      '  if (!Array.isArray(store.modeLog)) store.modeLog = [];']]
  },
  {
    id: 'R2-копия-в-режим-встаёт-за-источником',
    file: 'app.js',
    note: 'ошибка: duplicateGroupTo вставляет копию сразу за источником (как duplicateGroup) — блок цели оказывается среди блоков чужого режима, а не в конце своих',
    edits: [['  store.groups.splice(at < 0 ? store.groups.length : at + 1, 0, block);',
      '  store.groups.splice(store.groups.indexOf(g) + 1, 0, block);']]
  },
  {
    id: 'R2-копия-в-режим-всегда-с-суффиксом',
    file: 'app.js',
    note: 'ошибка: duplicateGroupTo зовёт копию «(копия)», даже когда имя в целевом режиме свободно',
    edits: [['  let nm = g.name;\n  if (nameTaken(nm, undefined, md)) {', '  let nm = g.name;\n  if (true) {']]
  },
  {
    id: 'R2-возврат-блока-берёт-чужой-режим',
    file: 'app.js',
    note: 'до задачи: restoreSetOf не смотрит режим — возврат блока возвращает действия одноимённого блока другого режима, ушедшие в тот же день',
    edits: [['  return store.items.filter(it => groupNameOf(it) === g.name && it.removedAt === day && belongsToMode(it, md));',
      '  return store.items.filter(it => groupNameOf(it) === g.name && it.removedAt === day);']]
  },
  {
    id: 'R2-убранные-судят-глобальный-по-активному-режиму',
    file: 'app.js',
    note: 'до задачи: goneBesideBlock ищет блок глобального пункта в активном режиме — пункт блока, убранного во всех режимах, стоит в «Убранных», и одиночный возврат молча оживит блок на следующем старте',
    // якорь обновлён в задаче Р3: глобальный пункт судится через holdsName
    // (живой блок живого режима), и строка стоит ещё и тогда, когда убранного
    // тёзки нет нигде; порча прежняя — блок ищется в одном активном режиме
    edits: [['  const same = store.groups.filter(g => g.name === name);\n  return same.some(holdsName) || !same.some(g => !live(g));',
      '  const g = findGroup(name);\n  return !g || live(g);']]
  },
  {
    id: 'R2-пропуск-путается-с-неотмеченным',
    file: 'app.js',
    note: 'ошибка: isSkipped читает любое ложное значение пропуском — неотмеченный пункт в дне с чужими отметками считается пропущенным',
    edits: [['  return !!store.days[dayKey] && store.days[dayKey][itemId] === false;',
      '  return !!store.days[dayKey] && !store.days[dayKey][itemId];']]
  },
  {
    id: 'R2-пропуск-вне-плана',
    file: 'app.js',
    note: 'ошибка: skipToday не проверяет план дня — false ложится на пункт вне расписания, режима или дней блока',
    edits: [['  if (!isAction(item) || !dueNow(item, t) || isMarked(t, itemId) || isSkipped(t, itemId)) return false;',
      '  if (!isAction(item) || isMarked(t, itemId) || isSkipped(t, itemId)) return false;']]
  },
  {
    id: 'R2-пропуск-у-привычки',
    file: 'app.js',
    note: 'ошибка: skipToday пускает любой пункт — привычка получает false и её круг запирается (пропущенному тап отказывает)',
    edits: [['  if (!isAction(item) || !dueNow(item, t) || isMarked(t, itemId) || isSkipped(t, itemId)) return false;',
      '  if (!item || !dueNow(item, t) || isMarked(t, itemId) || isSkipped(t, itemId)) return false;']]
  },
  {
    id: 'R2-пропуск-стирает-отметку',
    file: 'app.js',
    note: 'ошибка: skipToday не проверяет отметку — «Не сегодня» у отмеченного переписывает true на false, отметка потеряна',
    edits: [['  if (!isAction(item) || !dueNow(item, t) || isMarked(t, itemId) || isSkipped(t, itemId)) return false;',
      '  if (!isAction(item) || !dueNow(item, t) || isSkipped(t, itemId)) return false;']]
  },
  {
    id: 'R2-вернуть-оставляет-пустой-день',
    file: 'app.js',
    note: 'ошибка: unskipToday не удаляет опустевший день — в days{} остаётся {}, день без единого значения существует',
    edits: [['  if (emptied) delete store.days[t];\n', '']]
  },
  {
    id: 'R2-пропуски-недели-вне-плана',
    file: 'app.js',
    note: 'ошибка: weekSkips считает пропуски и в днях, ушедших из плана — «пропусков» больше, чем дней плана',
    edits: [['    if (isSkipped(k, item.id) && dueOn(item, k)) n++;', '    if (isSkipped(k, item.id)) n++;']]
  },
  {
    id: 'R2-свёртка-блока-не-видит-пропусков',
    file: 'app.js',
    note: 'ошибка: blockTally считает блок выполненным только по отметкам — блок с решённым «Не сегодня» не сворачивается',
    edits: [['  return { done, skipped, full: items.length > 0 && done + skipped === items.length };',
      '  return { done, skipped, full: items.length > 0 && done === items.length };']]
  },
  {
    id: 'R2-преемник-упражнения-не-опознаётся',
    file: 'app.js',
    note: 'до задачи: laterExerciseOf выключен — прежняя запись упражнения стоит в «Убранных» рядом с живым преемником, и «Вернуть» заводит второе поле на листе',
    edits: [['function laterExerciseOf(ex) {\n  if (!ex || live(ex) || !ex.removedAt) return null;', 'function laterExerciseOf(ex) {\n  return null;']]
  },
  {
    id: 'R2-преемник-в-тот-же-день',
    file: 'app.js',
    note: 'ошибка: successorAmong берёт в преемники запись, заведённую в день ухода, — одноимённое соседнее дело прячет убранное',
    edits: [['!(y.addedAt > x.removedAt)', '!(y.addedAt >= x.removedAt)']]
  },
  {
    id: 'R2-быстрое-добавление-режет-только-по-точке',
    file: 'app.js',
    note: 'до задачи: разделитель подписи — только « · »; «Зарядка — 10 мин» и «Зарядка - 10 мин» становятся именем целиком',
    edits: [['    const m = /^(.*?)\\s+[·—–-](?:\\s+(.*))?$/.exec(line);', '    const m = /^(.*?)\\s+·(?:\\s+(.*))?$/.exec(line);']]
  },
  {
    id: 'R2-разделитель-без-пробелов-режет-имя',
    file: 'app.js',
    note: 'ошибка: знак без пробелов по бокам считается разделителем — «Кросс-фит» становится именем «Кросс» с подписью «фит»',
    edits: [['    const m = /^(.*?)\\s+[·—–-](?:\\s+(.*))?$/.exec(line);', '    const m = /^(.*?)\\s*[·—–-](?:\\s*(.*))?$/.exec(line);']]
  },
  {
    id: 'R2-блок-ищется-во-всех-режимах',
    file: 'app.js',
    note: 'до задачи: findGroup ищет блок только по имени — дни одноимённого блока другого режима режут действие',
    edits: [['  return store.groups.find(g => g.name === n && blockMode(g) === m) || null;',
      '  return store.groups.find(g => g.name === n) || null;']]
  },
  {
    id: 'R2-имя-блока-занято-во-всех-режимах',
    file: 'app.js',
    note: 'до задачи: nameTaken видит блоки всех режимов — одноимённый блок в другом режиме не заводится, копия в режим получает «(копия)»',
    edits: [['  if (store.groups.some(g => g.name === n && blockMode(g) === m)) return true;',
      '  if (store.groups.some(g => g.name === n)) return true;']]
  },
  {
    id: 'R2-горячая-применимость-без-режима',
    file: 'app.js',
    note: 'ошибка: inEffectiveDays (горячий путь серии и рекорда) забывает режим дня и расходится с effectiveMaskOn — вчерашние числа читают нынешний режим',
    edits: [['  if (itemMode(item) !== modeOn(dayKey)) return false;\n', '']]
  },
  {
    id: 'R2-пропуск-остаётся-в-знаменателе',
    file: 'app.js',
    note: 'до задачи: minDayMarks не вычитает пропуски — «Не сегодня» оставляет дело в «N из M», день с пропуском не закрывается',
    edits: [['  return { done, total: items.length - skipped, skipped, planned: items.length };',
      '  return { done, total: items.length, skipped, planned: items.length };']]
  },
  {
    id: 'R2-сплошные-пропуски-сквозной-день',
    file: 'app.js',
    note: 'ошибка: dayScore отдаёт null дню, где всё пропущено, — «Не сегодня» у всех дел даёт серию без единой отметки',
    edits: [['  return m.total > 0 ? m.done / m.total : 0;', '  return m.total > 0 ? m.done / m.total : null;']]
  },
  {
    id: 'R2-сплошные-пропуски-закрывают-день',
    file: 'app.js',
    note: 'ошибка: minDayClosed проверяет план, а не знаменатель — день, где всё пропущено, «закрыт» с 0 из 0 и играет сцену',
    edits: [['  return m.total > 0 && m.done === m.total;', '  return m.planned > 0 && m.done === m.total;']]
  },
  {
    id: 'R2-тап-по-пропущенному-отмечает',
    file: 'app.js',
    note: 'до задачи: toggleMark не отказывает пропущенному — тап по неактивному кругу переписывает пропуск отметкой',
    edits: [['  if (isSkipped(dayKey, itemId)) return false;\n', '']]
  },
  {
    id: 'R2-отметка-за-вчера-переписывает-пропуск',
    file: 'app.js',
    note: 'до задачи: markYesterday не отказывает вчерашнему пропуску — решение владельца переписывается отметкой задним числом',
    edits: [['  if (isSkipped(y, item.id)) return false;\n  const day = store.days[y]', '  const day = store.days[y]']]
  },
  {
    id: 'R2-точка-вчера-у-пропущенного',
    file: 'app.js',
    note: 'до задачи: missedYesterday не видит пропуска — за вчерашнее «Не сегодня» показывается укор «вчера — пропуск»',
    edits: [['  if (isSkipped(y, item.id)) return false;\n  return everMarked(item, y);', '  return everMarked(item, y);']]
  },
  {
    id: 'R2-миграция-без-списка-режимов',
    file: 'app.js',
    note: 'ошибка: migrate нормализует режимы, только если список в файле есть, — файл v19 остаётся без основного режима',
    edits: [['  s.modes = modesNorm.modes;', '  s.modes = Array.isArray(s.modes) ? modesNorm.modes : [];']]
  },
  {
    id: 'R2-миграция-не-ставит-режим-действию',
    file: 'app.js',
    note: 'ошибка: migrate не ставит mode действию — действие v19 без поля, неизвестный режим остаётся ссылкой в никуда',
    edits: [["    if (it.type === 'daily' && it.area === 'min') it.mode = modeOf(it.mode);\n    else delete it.mode;",
      "    if (!(it.type === 'daily' && it.area === 'min')) delete it.mode;"]]
  },
  {
    id: 'R2-миграция-оставляет-режим-не-действию',
    file: 'app.js',
    note: 'ошибка: migrate не снимает mode у привычки, параметра и счётчика — глобальный пункт привязан к режиму данными',
    edits: [['    else delete it.mode;\n', '']]
  },
  {
    id: 'R2-миграция-оставляет-пропуск-не-действию',
    file: 'app.js',
    note: 'ошибка: migrate оставляет false у известного не-действия — круг привычки из импорта заперт навсегда',
    edits: [['typeof day[id] !== \'boolean\' || (day[id] === false && notAction.has(id))', 'typeof day[id] !== \'boolean\'']]
  },
  {
    id: 'R2-миграция-не-возвращает-активный-режим',
    file: 'app.js',
    note: 'ошибка: импорт убранного режима, действующего сегодня, оставляет его убранным — активный режим, которого нет в выборе',
    edits: [['    if (am && am.removedAt !== null) am.removedAt = null;\n', '']]
  },

  /* ── Задача Р3: номер версии, автопроверка, «держит имя», раскладка
     привычек, хвост счёта дня ──────────────────────────────────────
     Решение архитектора: мутанты — ТОЛЬКО для новых доменных функций Р3:
     versionLabel, updateCheckDue, holdsName (и его чтение в hasLiveNamesake,
     renameGroupCore и goneBesideBlock), habitSections — и для доменного
     правила todayCounts (хвост «· пропусков K» в note). Service worker,
     предложение обновления, «Система», признак точки на свёрнутой строке и
     фильтр motionLeave сюда не входят: это не доменные функции.
     «до задачи» в note — поведение, каким оно было до Р3; «ошибка» —
     правдоподобная порча нового кода. */
  {
    id: 'R3-номер-версии-без-границ-формата',
    file: 'app.js',
    note: 'ошибка: versionLabel ищет номер без ^ и $ — «minimum-v48a», «other-minimum-v48» и ответ с хвостом печатаются номером',
    edits: [['/^minimum-(v\\d+)$/.exec(', '/minimum-(v\\d+)/.exec(']]
  },
  {
    id: 'R3-номер-версии-из-не-строки',
    file: 'app.js',
    note: 'ошибка: versionLabel приводит чужой ответ воркера к строке — массив [\'minimum-v48\'] читается номером',
    edits: [["typeof v === 'string' ? v : ''", 'String(v)']]
  },
  {
    id: 'R3-номер-версии-полным-именем',
    file: 'app.js',
    note: 'ошибка: versionLabel отдаёт имя кеша целиком — «Минимум · minimum-v48» вместо «v48»',
    edits: [['  return m ? m[1] : null;', '  return m ? m[0] : null;']]
  },
  {
    id: 'R3-автопроверка-без-метки-не-пора',
    file: 'app.js',
    note: 'ошибка: updateCheckDue при отсутствии прошлой проверки отвечает «рано» — при запуске обновление не ищется',
    edits: [["  if (typeof last !== 'number' || !isFinite(last)) return true;", "  if (typeof last !== 'number' || !isFinite(last)) return false;"]]
  },
  {
    id: 'R3-автопроверка-граница-срока',
    file: 'app.js',
    note: 'ошибка: updateCheckDue не включает границу — ровно через UPDATE_CHECK_MS ещё «рано»',
    edits: [['  return !(d >= 0 && d < UPDATE_CHECK_MS);', '  return !(d >= 0 && d <= UPDATE_CHECK_MS);']]
  },
  {
    id: 'R3-часы-назад-запирают-автопроверку',
    file: 'app.js',
    note: 'ошибка: updateCheckDue не видит часов, ушедших назад, — метка «из будущего» запирает автопроверку на весь сдвиг',
    edits: [['  return !(d >= 0 && d < UPDATE_CHECK_MS);', '  return !(d < UPDATE_CHECK_MS);']]
  },
  {
    id: 'R3-блок-убранного-режима-держит-имя',
    file: 'app.js',
    note: 'до задачи: holdsName не смотрит на режим — живой блок убранного режима держит привычки и счётчики своим именем',
    edits: [['  const m = findMode(blockMode(g));\n  return !m || live(m);', '  return true;']]
  },
  {
    id: 'R3-убранный-блок-держит-имя',
    file: 'app.js',
    note: 'ошибка: holdsName не проверяет уход самого блока — убранный блок держит глобальные пункты, как живой',
    edits: [['  if (!g || !live(g)) return false;\n  const m = findMode(blockMode(g));', '  if (!g) return false;\n  const m = findMode(blockMode(g));']]
  },
  {
    id: 'R3-блок-без-записи-режима-не-держит',
    file: 'app.js',
    note: 'ошибка: holdsName читает режим, которого нет в store, убранным — блок записи, собранной без modes, не держит никого',
    edits: [['  return !m || live(m);', '  return !!m && live(m);']]
  },
  {
    id: 'R3-уход-блока-судит-тёзку-без-режима',
    file: 'app.js',
    note: 'до задачи: hasLiveNamesake считает тёзкой живой блок убранного режима — «Убрать блок» оставляет привычки под невидимым блоком, и последствие называет «останутся»',
    edits: [['x.name === g.name && holdsName(x)', 'x.name === g.name && live(x)']]
  },
  {
    id: 'R3-переименование-держит-ушедших-в-один-день',
    file: 'app.js',
    note: 'до задачи: убранный тёзка держит глобальные пункты, ушедшие с ним в один день, — при переименовании они остаются при старом имени',
    edits: [
      ['  const held = store.groups.some(x => x !== g && x.name === from && holdsName(x));',
        '  const held = it => store.groups.some(x => x !== g && x.name === from &&\n    (holdsName(x) || (!live(it) && x.removedAt === it.removedAt)));'],
      ['    } else if (groupNameOf(it) === from && !held) {', '    } else if (groupNameOf(it) === from && !held(it)) {']
    ]
  },
  {
    id: 'R3-переименование-держит-тёзкой-убранного-режима',
    file: 'app.js',
    note: 'до задачи: renameGroupCore судит тёзку по live — блок убранного режима держит привычки и счётчики при переименовании',
    edits: [['x.name === from && holdsName(x)', 'x.name === from && live(x)']]
  },
  {
    id: 'R3-убранные-держит-блок-убранного-режима',
    file: 'app.js',
    note: 'до задачи: goneBesideBlock судит глобальный пункт по live — пункт, ушедший с блоком основного при тёзке в убранном режиме, стоит в «Убранных» второй дорогой назад',
    edits: [['  return same.some(holdsName) || !same.some(g => !live(g));', '  return same.some(live) || !same.some(g => !live(g));']]
  },
  {
    id: 'R3-убранные-прячут-пункт-без-дороги-назад',
    file: 'app.js',
    note: 'ошибка: goneBesideBlock переводит прежнее правило на holdsName дословно (!same.length) — имя живёт только в блоке убранного режима, убранного блока нет: пункт пропадает из «Убранных» без дороги назад',
    edits: [['  return same.some(holdsName) || !same.some(g => !live(g));', '  return same.some(holdsName) || !same.length;']]
  },
  {
    id: 'R3-привычки-только-по-блокам-режима',
    file: 'app.js',
    note: 'до задачи (дневные «Привычки»): раскладка только по блокам активного режима — привычка, чей блок живёт в другом режиме, уходит в «Без блока»',
    edits: [['  for (const g of own.concat(store.groups.filter(holdsName))) {', '  for (const g of own) {']]
  },
  {
    id: 'R3-заголовок-по-блоку-убранного-режима',
    file: 'app.js',
    note: 'до задачи («Настройки»): прочие имена берутся у любых живых блоков — имя блока убранного режима становится заголовком привычек',
    edits: [['  for (const g of own.concat(store.groups.filter(holdsName))) {', '  for (const g of own.concat(store.groups.filter(live))) {']]
  },
  {
    id: 'R3-секция-с-блоком-чужого-режима',
    file: 'app.js',
    note: 'ошибка: habitSections отдаёт в group блок другого режима — дневные «Привычки» печатают чужую подпись',
    edits: [['group: own.includes(g) ? g : null', 'group: g']]
  },
  {
    id: 'R3-одно-имя-две-секции',
    file: 'app.js',
    note: 'ошибка: habitSections не склеивает одноимённые блоки режимов — имя, живущее в двух режимах, даёт два заголовка',
    edits: [['    if (known.has(g.name)) continue;\n    known.add(g.name);', '    known.add(g.name);']]
  },
  {
    id: 'R3-пустая-секция-рождается',
    file: 'app.js',
    note: 'ошибка: habitSections рождает секцию блока без привычек — пустой заголовок на «Привычках»',
    edits: [['    if (list.length) out.push({ name: g.name,', '    out.push({ name: g.name,']]
  },
  {
    id: 'R3-раскладка-привычек-по-основному-режиму',
    file: 'app.js',
    note: 'ошибка: habitSections без названного режима берёт основной, а не активный — при выбранных «Каникулах» порядок и подписи основного',
    edits: [['function habitSections(items, mode) {\n  const m = mode === undefined ? activeMode() : mode;',
      'function habitSections(items, mode) {\n  const m = mode === undefined ? MAIN_MODE : mode;']]
  },
  {
    id: 'R3-хвост-пропусков-снят',
    file: 'app.js',
    note: 'до задачи: счёт дня «Сегодня» без хвоста — «0 из 1» при пропуске, «0 из 0» при сплошных пропусках, пропуск числом не назван',
    edits: [['  const tail = skipped ? `<span class="bar-skip"> · пропусков&nbsp;${skipped}</span>` : \'\';', '  const tail = \'\';']]
  },
  {
    id: 'R3-хвост-при-нуле-пропусков',
    file: 'app.js',
    note: 'ошибка: хвост печатается и без пропусков — «0 из 2 · пропусков 0»',
    edits: [['  const tail = skipped ? `<span', '  const tail = skipped >= 0 ? `<span']]
  },
  {
    id: 'R3-хвост-у-закрытого-дня',
    file: 'app.js',
    note: 'ошибка: «День закрыт» получает хвост пропусков — у акцентного слова экрана появляется приписка',
    edits: [["  const note = closed ? 'День закрыт' : ", "  const note = closed ? 'День закрыт' + tail : "]]
  },
  {
    id: 'R3-хвост-без-приглушения',
    file: 'app.js',
    note: 'ошибка: хвост без .bar-skip — «· пропусков K» печатается голосом счёта, а не приглушённо',
    edits: [['<span class="bar-skip"> · пропусков', '<span> · пропусков']]
  }
];

/* ── Прогон ─────────────────────────────────────────────────── */

function makeCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'minimum-mutants-'));
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  for (const f of files) cpSync(join(ROOT, f), join(dir, f), { recursive: false, force: true });
  // devDependencies не копируем — junction на каталог проекта дешевле и
  // исключает расхождение версий jsdom между копией и живым деревом
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  return dir;
}

/* true = тесты зелёные (мутант ВЫЖИЛ) */
function runTests(dir) {
  const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: dir, encoding: 'utf8' });
  return { green: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

function apply(dir, m) {
  const path = join(dir, m.file);
  const src = readFileSync(path, 'utf8');
  let out = src;
  for (const [from, to] of m.edits) {
    const n = out.split(from).length - 1;
    if (n !== 1) return { ok: false, why: n === 0 ? 'текст не найден' : `текст встречается ${n} раз` };
    out = out.replace(from, to);
  }
  writeFileSync(path, out);
  return { ok: true, restore: () => writeFileSync(path, src) };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const m of MUTANTS) console.log(`${m.id}\n    ${m.note}`);
    return 0;
  }
  const picked = args.length ? MUTANTS.filter(m => args.some(a => m.id.includes(a))) : MUTANTS;
  if (!picked.length) { console.error('ни один мутант не подошёл под ' + args.join(', ')); return 1; }

  const dir = makeCopy();
  console.log(`изолированная копия: ${dir}`);
  console.log(`тесты: ${TESTS.join(' ')}`);
  for (const [f, why] of Object.entries(EXCLUDED)) console.log(`изъят из прогона: ${f} — ${why}`);
  try {
    process.stdout.write('\nконтроль (без мутации) … ');
    const ctl = runTests(dir);
    if (!ctl.green) {
      console.log('УБИТ');
      console.error('\nКонтрольный прогон обязан быть зелёным. Врёт инструмент, а не тесты:\n');
      console.error(ctl.out.split('\n').filter(l => /^(not ok|✖|# fail)/.test(l)).slice(0, 20).join('\n'));
      return 1;
    }
    console.log('выжил ✔ (копия собрана верно)');

    let killed = 0; const survived = [], broken = [];
    for (const m of picked) {
      process.stdout.write(`\n${m.id} … `);
      const a = apply(dir, m);
      if (!a.ok) { console.log(`⚠ не наложен: ${a.why}`); broken.push(m.id); continue; }
      const r = runTests(dir);
      a.restore();
      if (r.green) { console.log('✖ ВЫЖИЛ'); survived.push(m); }
      else {
        killed++;
        const by = (r.out.match(/^✖ (?!failing)(.+?) \(/m) || [])[1] || '(тест не опознан)';
        console.log(`✔ убит — ${by}`);
      }
    }

    console.log(`\n── итог: убито ${killed} из ${picked.length}`);
    for (const m of survived) console.log(`   ✖ выжил ${m.id} — ${m.note}: этого поведения не сторожит ни один тест`);
    for (const id of broken) console.log(`   ⚠ устарел ${id} — текст мутации в коде не найден`);
    return (survived.length || broken.length) ? 1 : 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main());
