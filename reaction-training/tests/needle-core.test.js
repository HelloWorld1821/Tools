const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  isCollision,
  isNeedleContact,
  nextSpeed,
  normaliseAngle,
} = require('../games/needle-core.js');

test('normaliseAngle keeps angles within one positive circle', () => {
  assert.equal(normaliseAngle(0), 0);
  assert.equal(normaliseAngle(Math.PI * 2), 0);
  assert.equal(normaliseAngle(-Math.PI / 2), Math.PI * 1.5);
  assert.equal(normaliseAngle(Math.PI * 5), Math.PI);
  assert.equal(normaliseAngle(Number.EPSILON / 2), Number.EPSILON / 2);
  const tinyNegative = -Number.EPSILON / 2;
  assert.ok(normaliseAngle(tinyNegative) >= 0);
  assert.ok(normaliseAngle(tinyNegative) < Math.PI * 2);
  assert.equal(normaliseAngle(Infinity), 0);
  assert.equal(normaliseAngle(NaN), 0);
});

test('isCollision detects clearance using shortest circular distance', () => {
  assert.equal(isCollision(0.04, [Math.PI, Math.PI * 2 - 0.03], 0.08), true);
  assert.equal(isCollision(Math.PI / 2, [0, Math.PI], 0.2), false);
  assert.equal(isCollision(0.125, [0], 0.125), true);
  assert.equal(isCollision(0.1 + Number.EPSILON / 2, [0], 0.1), false);
  assert.equal(isCollision(Number.EPSILON / 2, [0], 0), false);
  assert.equal(isCollision(-Number.EPSILON / 2, [0], 0), false);
  assert.equal(isCollision(Infinity, [0], 0), false);
});

test('isNeedleContact detects contact between the rendered needle shapes', () => {
  const geometry = { radius: 100, needleLength: 70, strokeWidth: 5, tipRadius: 5 };

  assert.equal(isNeedleContact(0, [0.02], geometry), true);
  assert.equal(isNeedleContact(0, [0.1], geometry), false);
});

test('nextSpeed raises and rounds the speed from placed needles', () => {
  assert.equal(nextSpeed(1.5, 4), 1.82);
  assert.equal(nextSpeed(0, 0), 0.08);
});

test('nextSpeed caps acceleration at the speed reached with eight placed needles', () => {
  const speedAtEight = nextSpeed(1.5, 8);
  assert.equal(nextSpeed(speedAtEight, 9), speedAtEight);
  assert.equal(nextSpeed(1.5, 8), 2.06);
});

test('NeedleCore attaches to the browser global without CommonJS', () => {
  const context = { globalThis: {} };
  const source = fs.readFileSync(path.join(__dirname, '../games/needle-core.js'), 'utf8');

  vm.runInNewContext(source, context);

  assert.ok(context.globalThis.NeedleCore);
  assert.equal(typeof context.globalThis.NeedleCore.isCollision, 'function');
});
