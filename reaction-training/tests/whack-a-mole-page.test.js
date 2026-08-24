const assert = require('node:assert/strict');
const test = require('node:test');

const MoleCore = require('../games/whack-a-mole-core.js');
const { createWhackAMoleController } = require('../games/whack-a-mole.js');

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
      return Array.from(listeners.values()).reduce((total, group) => total + group.size, 0);
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
    hidden: false,
    style: {},
    textContent: '',
    type: '',
    append(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
  };
}

function createHarness(storage = new Map()) {
  let activeElement = null;
  function createHarnessElement(tagName) {
    const element = createElement(tagName);
    element.focus = () => { activeElement = element; };
    return element;
  }
  const nodes = {
    'mole-count': { ...createEventTarget(), value: '6', disabled: false },
    'mole-start': { ...createEventTarget(), disabled: false },
    'mole-score': createElement(),
    'mole-misses': createElement(),
    'mole-miss-status': createElement(),
    'mole-feedback': createElement(),
    'mole-field': createElement(),
    'mole-result': createElement(),
    'mole-result-copy': createElement(),
    'mole-best-record': createElement(),
    'mole-replay': { ...createEventTarget(), disabled: false },
    'mole-live': createElement(),
  };
  const timers = new Map();
  let nextTimer = 1;
  const windowRef = {
    MoleCore: { ...MoleCore, createHoleLayout: (count) => Array.from({ length: count }, (_, index) => ({ x: index * 10, y: index * 5 })) },
    ReactionCommon: {
      readStoredJson: (target, key, fallback) => {
        const raw = target.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      },
      scoreRating: (score) => ({ label: `评级${score}`, detail: '测试评级' }),
      writeStoredJson: (target, key, value) => {
        target.setItem(key, JSON.stringify(value));
        return true;
      },
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    clearTimeout: (id) => timers.delete(id),
    setTimeout: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
  };
  const documentRef = {
    createElement: createHarnessElement,
    getElementById: (id) => nodes[id] || null,
  };
  const controller = createWhackAMoleController(documentRef, windowRef);

  function runTimer() {
    const [id, timer] = timers.entries().next().value || [];
    if (id === undefined) return false;
    timers.delete(id);
    timer.callback();
    return true;
  }

  return { activeElement: () => activeElement, controller, nodes, runTimer, timers };
}

function revealMole(harness) {
  assert.equal(harness.runTimer(), true, 'next-mole timer should be pending');
  assert.notEqual(harness.controller.state.currentHole, null);
}

test('mole controller creates the selected hole count and scores a hit without retaining a visible timer', () => {
  const harness = createHarness();
  const { controller, nodes, timers } = harness;
  nodes['mole-count'].value = '9';
  nodes['mole-start'].dispatch('click');

  assert.equal(controller.state.holeCount, 9);
  assert.equal(nodes['mole-field'].children.length, 9);
  assert.equal(timers.size, 1);
  revealMole(harness);
  const mole = nodes['mole-field'].children[controller.state.currentHole];
  assert.equal(harness.activeElement(), mole);
  mole.dispatch('click');

  assert.equal(controller.state.score, 1);
  assert.equal(controller.state.currentHole, null);
  assert.equal(timers.size, 1);
  assert.equal(nodes['mole-score'].textContent, '1');
});

test('mole controller ends once after three misses and replay safely resets a round', () => {
  const harness = createHarness();
  const { controller, nodes, timers } = harness;
  controller.start();

  for (let miss = 0; miss < 3; miss += 1) {
    revealMole(harness);
    assert.equal(harness.runTimer(), true, 'visible-mole timer should be pending');
  }

  assert.equal(controller.state.running, false);
  assert.equal(controller.state.misses, 3);
  assert.equal(timers.size, 0);
  assert.equal(nodes['mole-result'].hidden, false);
  assert.match(nodes['mole-result-copy'].textContent, /评级0/);
  const firstResult = nodes['mole-result-copy'].textContent;
  assert.equal(harness.runTimer(), false);
  assert.equal(nodes['mole-result-copy'].textContent, firstResult);

  nodes['mole-replay'].dispatch('click');
  assert.equal(controller.state.running, true);
  assert.equal(controller.state.score, 0);
  assert.equal(controller.state.misses, 0);
  assert.equal(controller.state.currentHole, null);
  assert.equal(timers.size, 1);
});

test('mole controller stores and displays one best score', () => {
  const storage = new Map();
  const harness = createHarness(storage);
  const { controller, nodes } = harness;

  function finishRound(score) {
    controller.start();
    for (let index = 0; index < score; index += 1) {
      revealMole(harness);
      nodes['mole-field'].children[controller.state.currentHole].dispatch('click');
    }
    for (let index = 0; index < 3; index += 1) {
      revealMole(harness);
      assert.equal(harness.runTimer(), true);
    }
  }

  finishRound(5);
  assert.match(nodes['mole-best-record'].textContent, /最佳纪录：5 分/);
  assert.match(nodes['mole-best-record'].textContent, /新的最佳纪录/);

  finishRound(4);
  assert.match(nodes['mole-best-record'].textContent, /最佳纪录：5 分/);

  finishRound(6);
  assert.match(nodes['mole-best-record'].textContent, /最佳纪录：6 分/);
});

test('mole controller shows coordinated miss feedback and clears it for the next target', () => {
  const harness = createHarness();
  const { controller, nodes } = harness;
  controller.start();

  revealMole(harness);
  assert.equal(harness.runTimer(), true, 'visible-mole timer should expire');

  assert.equal(nodes['mole-feedback'].textContent, '漏掉了！还可漏掉 2 次');
  assert.equal(nodes['mole-feedback'].classList.contains('is-visible'), true);
  assert.equal(nodes['mole-field'].classList.contains('is-missed'), true);
  assert.equal(nodes['mole-miss-status'].classList.contains('is-alert'), true);

  revealMole(harness);
  assert.equal(nodes['mole-feedback'].textContent, '');
  assert.equal(nodes['mole-feedback'].classList.contains('is-visible'), false);
  assert.equal(nodes['mole-field'].classList.contains('is-missed'), false);
  assert.equal(nodes['mole-miss-status'].classList.contains('is-alert'), false);

  const mole = nodes['mole-field'].children[controller.state.currentHole];
  mole.dispatch('click');
  assert.equal(nodes['mole-feedback'].classList.contains('is-visible'), false);

  controller.start();
  assert.equal(nodes['mole-feedback'].textContent, '');
  assert.equal(nodes['mole-miss-status'].classList.contains('is-alert'), false);
});

test('mole controller prevents duplicate activations and removes all listeners and timers on destroy', () => {
  const harness = createHarness();
  const { controller, nodes, timers } = harness;
  controller.start();
  controller.start();
  assert.equal(timers.size, 1);
  revealMole(harness);
  const mole = nodes['mole-field'].children[controller.state.currentHole];
  let prevented = false;
  mole.dispatch('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
  mole.dispatch('click');
  assert.equal(prevented, true);
  assert.equal(controller.state.score, 1);
  assert.equal(timers.size, 1);

  revealMole(harness);
  const touchMole = nodes['mole-field'].children[controller.state.currentHole];
  touchMole.dispatch('pointerdown', { isPrimary: true, pointerType: 'touch', preventDefault() {} });
  assert.equal(controller.state.score, 2);
  assert.equal(timers.size, 1);

  controller.destroy();
  assert.equal(controller.state.running, false);
  assert.equal(timers.size, 0);
  assert.equal(nodes['mole-start'].disabled, true);
  assert.equal(nodes['mole-replay'].disabled, true);
  assert.equal(nodes['mole-count'].disabled, true);
  assert.equal(nodes['mole-start'].listenerCount(), 0);
  assert.equal(nodes['mole-replay'].listenerCount(), 0);
  for (const hole of nodes['mole-field'].children) assert.equal(hole.listenerCount(), 0);
  controller.start();
  assert.equal(controller.state.running, false);
  nodes['mole-start'].dispatch('click');
  nodes['mole-replay'].dispatch('click');
  assert.equal(controller.state.score, 2);
  assert.equal(timers.size, 0);
});

test('mole controller resets an active round and ignores stale timers after replay and destroy', () => {
  const harness = createHarness();
  const { controller, nodes, timers } = harness;
  controller.start();
  const staleGap = timers.values().next().value.callback;
  revealMole(harness);
  const staleVisible = timers.values().next().value.callback;

  controller.start();
  assert.equal(controller.state.currentHole, null);
  assert.equal(nodes['mole-field'].children.length, 6);
  assert.equal(timers.size, 1);
  staleGap();
  assert.equal(controller.state.currentHole, null);
  assert.equal(timers.size, 1);

  revealMole(harness);
  staleVisible();
  assert.equal(controller.state.misses, 0);
  assert.notEqual(controller.state.currentHole, null);
  assert.equal(timers.size, 1);

  const afterDestroy = timers.values().next().value.callback;
  controller.destroy();
  afterDestroy();
  assert.equal(controller.state.currentHole, null);
  assert.equal(timers.size, 0);
});
