const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const controllerPath = path.join(__dirname, '../games/number-clear.js');
const NumberClearGame = fs.existsSync(controllerPath) ? require(controllerPath) : {};
const NumberCore = require('../games/number-clear-core.js');
const createNumberClearController = NumberClearGame.createNumberClearController;

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    listenerCount() {
      return Array.from(listeners.values()).reduce((total, listenersForType) => total + listenersForType.size, 0);
    },
  };
}

function createElement(tagName = 'div') {
  const target = createEventTarget();
  const classes = new Set();
  return {
    ...target,
    tagName: tagName.toUpperCase(),
    ariaLabel: '',
    children: [],
    classList: {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classes.has(name) : force;
        if (shouldAdd) classes.add(name); else classes.delete(name);
        return shouldAdd;
      },
    },
    disabled: false,
    hidden: true,
    style: {},
    textContent: '',
    type: '',
    focus() { this.focused = true; },
    replaceChildren(...children) { this.children = children; },
  };
}

function createHarness(storage = new Map()) {
  const nodes = {
    'number-order': { ...createEventTarget(), value: '4', disabled: false },
    'number-start': { ...createEventTarget(), disabled: false },
    'number-target': createElement(),
    'number-time': createElement(),
    'number-grid': createElement(),
    'number-result': createElement(),
    'number-result-copy': createElement(),
    'number-best-record': createElement(),
    'number-replay': { ...createEventTarget(), disabled: false },
    'number-live': createElement(),
  };
  const frames = new Map();
  const timeouts = new Map();
  let nextFrame = 1;
  let nextTimeout = 1;
  const windowRef = {
    NumberCore,
    ReactionCommon: {
      formatDuration: (milliseconds) => `T${Math.floor(milliseconds)}`,
      readStoredJson: (target, key, fallback) => {
        const raw = target.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      },
      writeStoredJson: (target, key, value) => {
        target.setItem(key, JSON.stringify(value));
        return true;
      },
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    clearTimeout: (id) => timeouts.delete(id),
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    setTimeout(callback) {
      const id = nextTimeout++;
      timeouts.set(id, callback);
      return id;
    },
  };
  const documentRef = {
    createElement,
    getElementById: (id) => nodes[id] || null,
  };
  const controller = createNumberClearController(documentRef, windowRef);

  function tick(timestamp) {
    const [id, callback] = frames.entries().next().value || [];
    if (id === undefined) return false;
    frames.delete(id);
    callback(timestamp);
    return true;
  }

  function runTimeout() {
    const [id, callback] = timeouts.entries().next().value || [];
    if (id === undefined) return false;
    timeouts.delete(id);
    callback();
    return true;
  }

  return { controller, frames, nodes, runTimeout, tick, timeouts };
}

test('number clear exports a controller factory', () => {
  assert.equal(typeof createNumberClearController, 'function');
});

test('number clear starts a shuffled 4x4 board with one running timer and target 1', (context) => {
  if (typeof createNumberClearController !== 'function') {
    context.skip('controller factory is not available yet');
    return;
  }
  const harness = createHarness();
  const { controller, frames, nodes } = harness;
  controller.start();
  controller.start();

  assert.equal(controller.state.expected, 1);
  assert.equal(nodes['number-grid'].children.length, 16);
  assert.deepEqual(nodes['number-grid'].children.map((button) => Number(button.value)).sort((a, b) => a - b), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.equal(nodes['number-target'].textContent, '1');
  assert.equal(frames.size, 1);
  harness.tick(100);
  assert.equal(nodes['number-time'].textContent, 'T0');
  assert.equal(frames.size, 1);
});

test('number clear rejects a wrong number, advances correct selections, and ends only after the final number', (context) => {
  if (typeof createNumberClearController !== 'function') {
    context.skip('controller factory is not available yet');
    return;
  }
  const harness = createHarness();
  const { controller, nodes } = harness;
  controller.start();
  harness.tick(100);
  const wrong = nodes['number-grid'].children.find((button) => Number(button.value) !== 1);
  wrong.dispatch('click');
  assert.equal(controller.state.running, true);
  assert.equal(controller.state.expected, 1);
  assert.equal(wrong.classList.contains('number-cell--wrong'), true);
  assert.match(nodes['number-live'].textContent, /请按顺序/);
  assert.equal(harness.runTimeout(), true);
  assert.equal(wrong.classList.contains('number-cell--wrong'), false);

  for (let expected = 1; expected <= 16; expected += 1) {
    const button = nodes['number-grid'].children.find((cell) => Number(cell.value) === expected);
    button.dispatch('click');
    if (expected < 16) {
      assert.equal(button.disabled, true);
      assert.equal(button.textContent, '');
      assert.equal(controller.state.expected, expected + 1);
      const next = nodes['number-grid'].children.find((cell) => Number(cell.value) === expected + 1);
      assert.equal(next.focused, true);
    }
  }
  assert.equal(controller.state.running, false);
  assert.equal(harness.frames.size, 0);
  assert.equal(nodes['number-result'].hidden, false);
  assert.match(nodes['number-result-copy'].textContent, /闪电/);
  assert.match(nodes['number-result-copy'].textContent, /T0/);
});

test('number clear stores one best time per board size', (context) => {
  if (typeof createNumberClearController !== 'function') {
    context.skip('controller factory is not available yet');
    return;
  }

  const storage = new Map();
  const harness = createHarness(storage);
  const { controller, nodes } = harness;

  function finishRound(order, elapsed) {
    nodes['number-order'].value = String(order);
    controller.start();
    harness.tick(0);
    harness.tick(elapsed);
    for (let expected = 1; expected <= order * order; expected += 1) {
      nodes['number-grid'].children.find((button) => Number(button.value) === expected).dispatch('click');
    }
  }

  finishRound(4, 12000);
  assert.match(nodes['number-best-record'].textContent, /4 × 4 最佳：T12000/);
  assert.match(nodes['number-best-record'].textContent, /新的最佳纪录/);

  finishRound(4, 13000);
  assert.match(nodes['number-best-record'].textContent, /4 × 4 最佳：T12000/);

  finishRound(5, 20000);
  assert.match(nodes['number-best-record'].textContent, /5 × 5 最佳：T20000/);
});

test('number clear supports 4, 5, and 6 orders and replay and destroy clean up frames and listeners', (context) => {
  if (typeof createNumberClearController !== 'function') {
    context.skip('controller factory is not available yet');
    return;
  }
  const harness = createHarness();
  const { controller, frames, nodes } = harness;
  for (const [order, cellCount] of [[4, 16], [5, 25], [6, 36]]) {
    nodes['number-order'].value = String(order);
    controller.start();
    assert.equal(controller.state.order, order);
    assert.equal(nodes['number-grid'].children.length, cellCount);
    assert.equal(frames.size, 1);
  }
  const oldCells = nodes['number-grid'].children.slice();
  nodes['number-replay'].dispatch('click');
  assert.equal(controller.state.expected, 1);
  assert.equal(nodes['number-grid'].children.length, 36);
  assert.equal(frames.size, 1);
  for (const button of oldCells) assert.equal(button.listenerCount(), 0);

  controller.destroy();
  assert.equal(controller.state.running, false);
  assert.equal(frames.size, 0);
  assert.equal(nodes['number-start'].disabled, true);
  assert.equal(nodes['number-replay'].disabled, true);
  assert.equal(nodes['number-order'].disabled, true);
  assert.equal(nodes['number-start'].listenerCount(), 0);
  assert.equal(nodes['number-replay'].listenerCount(), 0);
  for (const button of nodes['number-grid'].children) assert.equal(button.listenerCount(), 0);
});
