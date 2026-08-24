const assert = require('node:assert/strict');
const test = require('node:test');

const NeedleCore = require('../games/needle-core.js');
const { createNeedleController } = require('../games/needle.js');

test('needle projectile duration is tuned for a quick reaction response', () => {
  assert.equal(require('../games/needle.js').PROJECTILE_DURATION <= 220, true);
});

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
      return Array.from(listeners.values()).reduce((count, group) => count + group.size, 0);
    },
  };
}

function createCanvas() {
  const target = createEventTarget();
  const context = {};
  for (const name of ['arc', 'beginPath', 'clearRect', 'fill', 'fillRect', 'lineTo', 'moveTo', 'restore', 'save', 'setTransform', 'stroke']) {
    context[name] = () => {};
  }

  return {
    ...target,
    clientHeight: 220,
    clientWidth: 300,
    height: 220,
    width: 300,
    focus: () => {},
    getBoundingClientRect: () => ({ width: 300, height: 220 }),
    getContext: () => context,
  };
}

function createControllerHarness(storage = new Map()) {
  const nodes = {
    'needle-canvas': createCanvas(),
    'needle-score': { textContent: '' },
    'needle-start': { ...createEventTarget(), disabled: false },
    'needle-fire': { ...createEventTarget(), disabled: true },
    'needle-result': { hidden: true },
    'needle-result-copy': { textContent: '' },
    'needle-best-record': { textContent: '', classList: { toggle() {} } },
    'needle-replay': { ...createEventTarget(), disabled: false },
    'needle-live': { textContent: '' },
  };
  const windowTarget = createEventTarget();
  const frames = new Map();
  let nextFrame = 1;
  let collide = false;
  let observerDisconnected = false;
  const windowRef = {
    ...windowTarget,
    NeedleCore: {
      ...NeedleCore,
      isNeedleContact: () => collide,
    },
    ReactionCommon: {
      readStoredJson: (target, key, fallback) => {
        const raw = target.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      },
      scoreRating: (score) => ({ label: score ? '稳定' : '新手', detail: '测试评级' }),
      writeStoredJson: (target, key, value) => {
        target.setItem(key, JSON.stringify(value));
        return true;
      },
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
      disconnect() { observerDisconnected = true; }
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    devicePixelRatio: 2,
    requestAnimationFrame: (callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
  };
  const documentRef = { getElementById: (id) => nodes[id] || null };
  const controller = createNeedleController(documentRef, windowRef);

  return {
    controller,
    frames,
    nodes,
    setCollision(value) { collide = value; },
    observerDisconnected: () => observerDisconnected,
    tick(timestamp) {
      const [id, callback] = frames.entries().next().value || [];
      if (id !== undefined) {
        frames.delete(id);
        callback(timestamp);
      }
    },
  };
}

function resolveFlight(harness, firstTimestamp) {
  for (let timestamp = firstTimestamp; timestamp <= firstTimestamp + 500; timestamp += 50) {
    harness.tick(timestamp);
  }
}

test('needle controller runs, resolves a shot, ends on collision, and replays with one RAF', () => {
  const harness = createControllerHarness();
  const { controller, frames, nodes } = harness;

  assert.equal(nodes['needle-canvas'].width, 600);
  assert.equal(nodes['needle-canvas'].height, 440);
  controller.start();
  controller.start();
  assert.equal(frames.size, 1);
  nodes['needle-fire'].dispatch('click');
  assert.equal(nodes['needle-fire'].disabled, true);
  resolveFlight(harness, 0);
  assert.equal(controller.state.score, 1);
  assert.equal(nodes['needle-fire'].disabled, false);

  harness.setCollision(true);
  nodes['needle-fire'].dispatch('click');
  resolveFlight(harness, 600);
  assert.equal(controller.state.running, false);
  assert.equal(frames.size, 0);
  assert.equal(nodes['needle-result'].hidden, false);
  assert.match(nodes['needle-result-copy'].textContent, /稳定/);

  nodes['needle-replay'].dispatch('click');
  assert.equal(controller.state.score, 0);
  assert.equal(controller.state.running, true);
  assert.equal(frames.size, 1);
});

test('needle controller announces the speed cap after the eighth placed needle', () => {
  const harness = createControllerHarness();
  const { controller, nodes } = harness;
  controller.start();

  for (let score = 1; score <= 9; score += 1) {
    nodes['needle-fire'].dispatch('click');
    resolveFlight(harness, score * 600);
    if (score < 8) {
      assert.match(nodes['needle-live'].textContent, /正在加速/);
    } else {
      assert.match(nodes['needle-live'].textContent, /已达到最高速度/);
    }
  }

  assert.equal(controller.state.score, 9);
  assert.match(nodes['needle-live'].textContent, /已达到最高速度/);
});

test('needle controller stores and displays one best score', () => {
  const storage = new Map();
  const harness = createControllerHarness(storage);
  const { controller, nodes } = harness;

  function finishRound(score) {
    controller.start();
    harness.setCollision(false);
    for (let index = 1; index <= score; index += 1) {
      nodes['needle-fire'].dispatch('click');
      resolveFlight(harness, index * 600);
    }
    harness.setCollision(true);
    nodes['needle-fire'].dispatch('click');
    resolveFlight(harness, (score + 1) * 600);
  }

  finishRound(4);
  assert.match(nodes['needle-best-record'].textContent, /最佳纪录：4 分/);
  assert.match(nodes['needle-best-record'].textContent, /新的最佳纪录/);

  finishRound(6);
  assert.match(nodes['needle-best-record'].textContent, /最佳纪录：6 分/);

  finishRound(3);
  assert.match(nodes['needle-best-record'].textContent, /最佳纪录：6 分/);
});

test('needle controller filters pointer input, supports keyboard, and fully disables itself on destroy', () => {
  const harness = createControllerHarness();
  const { controller, frames, nodes } = harness;
  const canvas = nodes['needle-canvas'];
  controller.start();

  canvas.dispatch('pointerdown', { button: 2, isPrimary: true, pointerType: 'mouse', preventDefault() {} });
  canvas.dispatch('pointerdown', { button: 0, isPrimary: false, pointerType: 'mouse', preventDefault() {} });
  assert.equal(controller.state.projectile, null);
  canvas.dispatch('pointerdown', { button: -1, isPrimary: true, pointerType: 'touch', preventDefault() {} });
  assert.ok(controller.state.projectile);
  controller.state.projectile = null;
  nodes['needle-fire'].disabled = false;
  let prevented = false;
  canvas.dispatch('keydown', { key: ' ', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(controller.state.projectile);

  controller.destroy();
  assert.equal(controller.state.running, false);
  assert.equal(controller.state.projectile, null);
  assert.equal(frames.size, 0);
  assert.equal(harness.observerDisconnected(), true);
  assert.equal(canvas.listenerCount(), 0);
  assert.equal(nodes['needle-start'].listenerCount(), 0);
  assert.equal(nodes['needle-fire'].listenerCount(), 0);
  assert.equal(nodes['needle-replay'].listenerCount(), 0);
  controller.start();
  assert.equal(controller.state.running, false);
});
