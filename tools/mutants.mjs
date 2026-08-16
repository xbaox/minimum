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
    edits: [[
      `    if (!isDayKey(k) || !day || typeof day !== 'object' || Array.isArray(day)) { delete s.days[k]; continue; }
    for (const id of Object.keys(day)) if (typeof day[id] !== 'boolean') delete day[id];
    if (!Object.keys(day).length) delete s.days[k];`,
      `    const ok = isDayKey(k) && day && typeof day === 'object' && !Array.isArray(day) &&
      Object.keys(day).length > 0 &&
      Object.values(day).every(v => typeof v === 'boolean');
    if (!ok) delete s.days[k];`]]
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
    edits: [
      ["  let h = `<header class=\"page\"><p class=\"overline\">Устройство приложения</p><h1>Настройки</h1></header>`;",
        "  let h = `<header class=\"page\"><p class=\"overline\">Устройство приложения</p><h1>Настройки</h1></header>`;\n  if (ui.savedAt) { h += `<p class=\"flash\" role=\"status\">${esc(ui.savedAt.text)}</p>`; ui.savedAt = null; }"],
      ["        ${flashAt('item:' + it.id)}\n", '']
    ]
  },
  {
    id: '26.2-отказ-закрывает-форму',
    file: 'app.js',
    note: 'занятое имя блока снова закрывает форму молча и уносит правку',
    edits: [[
      `      if (!nm) { refuse(b, 'Название не заполнено'); break; }
      if (nm !== from && findGroup(nm)) { refuse(b, 'Блок с таким именем уже есть'); break; }`,
      `      if (!nm || (nm !== from && findGroup(nm))) { ui.groupRename = null; renderSettings(); break; }`]]
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
    // хвостовой кнопкой строки дня
    edits: [[`.btn:active,
.dot:active,
.undo:active,
.itxt:active,
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
    edits: [['.hstrip i.fut { visibility: hidden; }', '.hstrip i.fut { opacity: .45; }']]
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
    edits: [['  if (!(item.addedAt <= y) || isMarked(y, item.id)) return false;',
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
    edits: [["const visibleFlash = () => document.querySelector('main .screen:not([hidden]) .flash:not(.keep)');",
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
    edits: [['      ui.wipeOpen = false;\n      resetConfirms();\n      // копия могла нести другую границу дня', '      // копия могла нести другую границу дня']]
  },
  {
    id: '27.1-Д8-invalid-date',
    file: 'app.js',
    note: 'Д8: exportedAt вне диапазона Date снова доезжает до рендера — «Экспорт запускался: Invalid Date»',
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
    edits: [["  if (ui.groupAdd) return 'group:new';\n  if (ui.groupRename !== null) return 'group:' + ui.groupRename;\n", '']]
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
    edits: [["  ['groups', 'блок', 'блока', 'блоков'],\n  ['weekLog', 'запись счётчика', 'записи счётчика', 'записей счётчика'],\n  ['history', 'запись истории', 'записи истории', 'записей истории'],\n  ['entries', 'значение тренировки', 'значения тренировки', 'значений тренировки'],\n  ['params', 'решение по параметру', 'решения по параметру', 'решений по параметру']\n", '']]
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
    edits: [['  const sub = it.note;',
      '  const sub = (it.ladder && it.ladder.steps[it.ladder.step]) || it.note;']]
  },
  {
    id: '28D-строка-последствия-снова-над-кнопкой',
    file: 'app.js',
    note: 'строка последствия «Закрыть неделю» возвращается наверх — кнопка уезжает на 69 px между первым и вторым тапом',
    edits: [["  h += `<button class=\"btn primary wide\" data-act=\"close-week\">${ui.weekCloseConfirm ? 'Подтвердить: закрыть неделю' : 'Закрыть неделю'}</button>`;\n  if (ui.weekCloseConfirm) {\n    h += `<p class=\"muted\">Неделя уйдёт в архив: принятые решения, «одно изменение» и решения по параметрам очистятся. Отметки останутся.</p>`;\n  }\n  h += REVIEW_DONE;",
      "  if (ui.weekCloseConfirm) {\n    h += `<p class=\"muted\">Неделя уйдёт в архив: принятые решения, «одно изменение» и решения по параметрам очистятся. Отметки останутся.</p>`;\n  }\n  h += `<button class=\"btn primary wide\" data-act=\"close-week\">${ui.weekCloseConfirm ? 'Подтвердить: закрыть неделю' : 'Закрыть неделю'}</button>` + REVIEW_DONE;"]]
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
