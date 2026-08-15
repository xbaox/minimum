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
    id: '24.3-счёт-недель-не-показывается',
    file: 'app.js',
    note: 'строка состояния лестницы снова оценивает вместо счёта',
    edits: [['  return ladderWeekCounts(item);', "  return 'Две полные недели нормы ещё не набраны';"]]
  },
  {
    id: '24.4-заголовок-решения-2-исчезает',
    file: 'app.js',
    note: 'закрытая лестница снова убирает «Решение 2» — нумерация идёт 1, 3',
    edits: [['  h += `<h2>Решение 2 · Ступень</h2>`;',
      '  if (L || !closedLadderItem()) h += `<h2>Решение 2 · Ступень</h2>`;']]
  },
  {
    id: '24.5-закрытая-лестница-блокирует-повышение',
    file: 'app.js',
    note: 'raiseEligible снова смотрит на любую лестницу, а не на живую',
    edits: [['  if (item.ladder && !item.ladder.done) return false;', '  if (item.ladder) return false;']]
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
    edits: [['  ui.weekOpen = null;\n}', '}']]
  },
  {
    id: '24.9-свёртка-не-открывается',
    file: 'app.js',
    note: 'при пустых решениях свёртка остаётся закрытой',
    edits: [['const weekFoldOpen = () => (ui.weekOpen === null ? !reviewActionable() : ui.weekOpen);',
      'const weekFoldOpen = () => (ui.weekOpen === null ? false : ui.weekOpen);']]
  },
  {
    id: '24.10-placeholder-убран',
    file: 'app.js',
    note: 'поле «Одно изменение» снова не объясняет, чего от владельца ждут',
    edits: [['placeholder="например: перенести зарядку на утро"', 'placeholder="необязательно"']]
  },
  {
    id: '24.4-слот-свободен-не-говорится',
    file: 'app.js',
    note: 'о свободном слоте молчат — владелец не знает, что можно завести новую',
    edits: [['      ? `<p class="muted">Лестница пройдена — слот свободен. Новую заводят в «Формуле и лестнице» пункта: Настройки → Пункты → правка.</p>`',
      '      ? `<p class="muted">Лестницы сейчас нет</p>`']]
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
