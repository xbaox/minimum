// Состояние «как у БАО» для тестов: восемь его пунктов и недельная «Тренировка» — прежний шаблон (до v56).
// Новый телефон с v56 начинает с базового шаблона из domain.js; здесь — привычный тестам набор с теми же id по порядку.
import { seed, makeId } from '../domain.js';

const NB = '\u00a0';
const ITEMS = [
  ['sunrise', 'Шторы + умыться', 'сразу как встал', 'orange', null],
  ['dumbbell', 'Спорт', `5${NB}отжиманий · 5${NB}подтягиваний · вис`, 'red', null],
  ['book', 'Развитие', `10${NB}минут · книга, вникай в суть`, 'purple', null],
  ['headphones', 'Vocabulary', `10${NB}минут · плейлист лексики`, 'blue', null],
  ['bed', 'Лежка', `15${NB}минут`, 'mint', null],
  ['drop', 'Душ', 'вечером', 'teal', null],
  ['bottle', 'Лак на ногти', 'после душа', 'pink', null],
  ['phone', 'Телефон на кухню', 'будильник заведён — и на кухню', 'indigo', 30],
];
const WEEKLY = [['pulse', 'Тренировка', `подтягивания · брусья · уголок · бег 1${NB}км · подъём ног`, 'green', 3]];

// Как seed(today, id, since), но с пунктами БАО; id выдаются в том же порядке: пункты, затем счётчик.
export function baoSeed(today, id = makeId, since = today) {
  const S = seed(today, () => 'tmp', since);
  S.items = ITEMS.map(([icon, name, note, color, beforeBed]) => ({ id: id(), icon, name, note, color, beforeBed, addedAt: today, archivedAt: null }));
  S.weekly = WEEKLY.map(([icon, name, note, color, perWeek]) => ({ id: id(), icon, name, note, color, perWeek, addedAt: today, archivedAt: null }));
  return S;
}
