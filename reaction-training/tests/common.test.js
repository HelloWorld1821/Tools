const assert = require('node:assert/strict');
const test = require('node:test');

const {
  formatDuration,
  readStoredJson,
  scoreRating,
  shuffle,
  writeStoredJson,
} = require('../assets/common.js');

test('shuffle retains the original values without mutating the source array', () => {
  const values = [1, 2, 3, 4];
  const randomValues = [0, 0, 0];
  const shuffled = shuffle(values, () => randomValues.shift());

  assert.deepEqual(values, [1, 2, 3, 4]);
  assert.deepEqual([...shuffled].sort((left, right) => left - right), values);
  assert.notStrictEqual(shuffled, values);
  assert.deepEqual(shuffled, [2, 3, 4, 1]);
});

test('scoreRating selects the correct rating at every band boundary', () => {
  const cases = [
    [28, '闪电'],
    [27, '专注'],
    [16, '专注'],
    [15, '稳定'],
    [8, '稳定'],
    [7, '新手'],
    [-1, '新手'],
  ];

  for (const [score, label] of cases) {
    const rating = scoreRating(score);

    assert.equal(rating.label, label, `score ${score}`);
    assert.equal(typeof rating.detail, 'string', `score ${score} detail type`);
    assert.ok(rating.detail.length > 0, `score ${score} detail`);
  }
});

test('formatDuration formats milliseconds as MM:SS.CC', () => {
  const cases = [
    [0, '00:00.00'],
    [-1, '00:00.00'],
    [9, '00:00.00'],
    [10, '00:00.01'],
    [59999, '00:59.99'],
    [60000, '01:00.00'],
    [61000, '01:01.00'],
    [61540, '01:01.54'],
  ];

  for (const [milliseconds, expected] of cases) {
    assert.equal(formatDuration(milliseconds), expected, `${milliseconds} milliseconds`);
  }
});

test('stored JSON helpers read, write, and tolerate malformed storage', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.equal(readStoredJson(storage, 'missing', null), null);
  assert.equal(writeStoredJson(storage, 'best', { score: 8 }), true);
  assert.deepEqual(readStoredJson(storage, 'best', null), { score: 8 });
  values.set('broken', '{bad json');
  assert.deepEqual(readStoredJson(storage, 'broken', { score: 0 }), { score: 0 });
});
