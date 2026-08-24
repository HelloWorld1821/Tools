const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  createHoleLayout,
  getRoundSettings,
  pickHole,
} = require('../games/whack-a-mole-core.js');

test('getRoundSettings accelerates rounds while preserving lower timing bounds', () => {
  const initial = getRoundSettings(0);
  const advanced = getRoundSettings(20);
  const capped = getRoundSettings(1000);

  assert.deepEqual(initial, { gapMs: 920, visibleMs: 1050, missLimit: 3 });
  assert.deepEqual(getRoundSettings(10), { gapMs: 700, visibleMs: 850, missLimit: 3 });
  assert.deepEqual(getRoundSettings(10.9), { gapMs: 700, visibleMs: 850, missLimit: 3 });
  for (const score of [-1, NaN, Infinity, -Infinity]) {
    assert.deepEqual(getRoundSettings(score), initial, `score ${score}`);
  }
  assert.ok(advanced.visibleMs < initial.visibleMs);
  assert.deepEqual(capped, { gapMs: 340, visibleMs: 360, missLimit: 3 });
});

test('pickHole chooses a valid new hole when alternatives exist', () => {
  assert.equal(pickHole(4, 2, () => 0.9), 3);
  assert.equal(pickHole(1, 0, () => 0.5), 0);
  assert.equal(pickHole(0, 0, () => 0.5), -1);
});

test('createHoleLayout returns spaced percentage coordinates for every hole', () => {
  const centredLayout = createHoleLayout(6, () => 0.5);
  const jitteredLayout = createHoleLayout(6, () => 0);

  assert.equal(jitteredLayout.length, 6);
  for (const hole of jitteredLayout) {
    assert.ok(hole.x >= 0 && hole.x <= 100);
    assert.ok(hole.y >= 0 && hole.y <= 100);
  }
  assert.equal(new Set(jitteredLayout.map(({ x, y }) => `${x},${y}`)).size, 6);
  assert.notDeepEqual(jitteredLayout, centredLayout);
});

test('createHoleLayout supports every offered count with distinct, separated positions', () => {
  for (const count of [6, 9, 12]) {
    let randomCall = 0;
    const layout = createHoleLayout(count, () => ((randomCall += 1) % 2 ? 0 : 1));
    assert.equal(layout.length, count);
    assert.equal(new Set(layout.map(({ x, y }) => `${x},${y}`)).size, count);
    for (const { x, y } of layout) {
      assert.ok(x >= 0 && x <= 100);
      assert.ok(y >= 0 && y <= 100);
    }
    for (let first = 0; first < layout.length; first += 1) {
      for (let second = first + 1; second < layout.length; second += 1) {
        const distance = Math.hypot(layout[first].x - layout[second].x, layout[first].y - layout[second].y);
        assert.ok(distance >= 13, `${count}-hole layout should keep holes physically separated`);
      }
    }
  }
});

test('twelve-hole layout retains responsive-safe row and column spacing despite jitter', () => {
  let randomCall = 0;
  const layout = createHoleLayout(12, () => ((randomCall += 1) % 2 ? 0 : 1));

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const left = layout[row * 4 + column];
      const right = layout[row * 4 + column + 1];
      assert.ok(right.x - left.x >= 22, 'adjacent columns should retain at least 22 percentage points');
    }
  }
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 2; row += 1) {
      const top = layout[row * 4 + column];
      const bottom = layout[(row + 1) * 4 + column];
      assert.ok(bottom.y - top.y >= 33, 'adjacent rows should retain at least 33 percentage points');
    }
  }
});

test('createHoleLayout rejects invalid counts without hanging', () => {
  assert.deepEqual(createHoleLayout(-1), []);
  assert.deepEqual(createHoleLayout(NaN), []);

  const modulePath = path.join(__dirname, '../games/whack-a-mole-core.js');
  const script = `const { createHoleLayout } = require(${JSON.stringify(modulePath)}); process.stdout.write(JSON.stringify(createHoleLayout(Infinity)));`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 1000 });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '[]');
});

test('MoleCore attaches to the browser global without CommonJS', () => {
  const context = { globalThis: {} };
  const source = fs.readFileSync(path.join(__dirname, '../games/whack-a-mole-core.js'), 'utf8');

  vm.runInNewContext(source, context);

  assert.ok(context.globalThis.MoleCore);
  assert.equal(typeof context.globalThis.MoleCore.pickHole, 'function');
});
