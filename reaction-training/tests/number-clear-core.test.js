const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  checkSelection,
  createBoard,
  timeRating,
} = require('../games/number-clear-core.js');

test('createBoard makes a complete independently shuffled numeric board', () => {
  const board = createBoard(3, () => 0);

  assert.equal(board.length, 9);
  assert.deepEqual([...board].sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.notDeepEqual(board, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('createBoard clamps injected random values to a valid shuffle range', () => {
  const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  for (const randomValue of [1, -1, NaN, Infinity]) {
    const board = createBoard(3, () => randomValue);
    assert.equal(board.length, 9, `length for ${randomValue}`);
    assert.deepEqual([...board].sort((left, right) => left - right), expected, `values for ${randomValue}`);
  }
});

test('createBoard uses a conservative 1x1 fallback for invalid orders', () => {
  for (const order of [Infinity, -1, 0, NaN, 1.5, 7]) {
    assert.deepEqual(createBoard(order), [1], `order ${order}`);
  }
});

test('checkSelection accepts only the expected number', () => {
  assert.equal(checkSelection(4, 4), true);
  assert.equal(checkSelection(3, 4), false);
  assert.equal(checkSelection('4', 4), false);
});

test('timeRating applies order-specific labels around each threshold', () => {
  const cases = [
    [3, 13000, '闪电'], [3, 13001, '专注'],
    [4, 22000, '闪电'], [4, 22001, '专注'], [4, 32000, '专注'], [4, 32001, '稳定'], [4, 46000, '稳定'], [4, 46001, '新手'],
    [5, 36000, '闪电'], [5, 36001, '专注'], [5, 52000, '专注'], [5, 52001, '稳定'], [5, 72000, '稳定'], [5, 72001, '新手'],
    [6, 52000, '闪电'], [6, 52001, '专注'], [6, 72000, '专注'], [6, 72001, '稳定'], [6, 98000, '稳定'], [6, 98001, '新手'],
    [99, 22000, '闪电'], [99, 22001, '专注'],
    [4, NaN, '闪电'], [4, Infinity, '闪电'],
  ];

  for (const [order, milliseconds, label] of cases) {
    assert.equal(timeRating(order, milliseconds).label, label, `${order}x${order} at ${milliseconds}ms`);
  }
});

test('NumberCore attaches to the browser global without CommonJS', () => {
  const context = { globalThis: {} };
  const source = fs.readFileSync(path.join(__dirname, '../games/number-clear-core.js'), 'utf8');

  vm.runInNewContext(source, context);

  assert.ok(context.globalThis.NumberCore);
  assert.equal(typeof context.globalThis.NumberCore.createBoard, 'function');
});
