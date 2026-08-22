const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./game-core.js');
const app = require('./app.js');

function createFakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const frames = new Map();

  function runNext(expectedDelay) {
    const pending = [...timers.entries()].sort((left, right) => left[1].due - right[1].due);
    assert.notEqual(pending.length, 0, 'expected a pending timeout');
    const [id, timer] = pending[0];
    assert.equal(timer.due - now, expectedDelay);
    timers.delete(id);
    now = timer.due;
    timer.callback();
  }

  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      frames.delete(id);
    },
    runNext,
  };
}

const sampleCards = [
  { suit: 'hearts', rank: '5' },
  { suit: 'spades', rank: '8' },
  { suit: 'hearts', rank: 'Q' },
  { suit: 'clubs', rank: '8' },
];

test('validateConfig accepts defaults and integer boundaries', () => {
  assert.deepEqual(core.validateConfig(10, 2), {
    valid: true,
    totalCards: 10,
    n: 2,
    errors: {},
  });
  assert.equal(core.validateConfig(2, 1).valid, true);
  assert.equal(core.validateConfig(100, 99).valid, true);
});

test('validateConfig rejects invalid totals and N values', () => {
  assert.equal(core.validateConfig(1, 1).errors.totalCards.length > 0, true);
  assert.equal(core.validateConfig(101, 2).errors.totalCards.length > 0, true);
  assert.equal(core.validateConfig(10.5, 2).errors.totalCards.length > 0, true);
  assert.equal(core.validateConfig(10, 0).errors.n.length > 0, true);
  assert.equal(core.validateConfig(10, 10).errors.n.length > 0, true);
});

test('generateCards creates independent standard cards', () => {
  const randomValues = [0, 0, 0, 0];
  let index = 0;
  const cards = core.generateCards(2, () => randomValues[index++]);
  assert.deepEqual(cards, [
    { suit: 'spades', rank: 'A' },
    { suit: 'spades', rank: 'A' },
  ]);
});

test('getCorrectAnswers implements all comparison relationships', () => {
  assert.deepEqual(
    core.getCorrectAnswers(
      { suit: 'hearts', rank: 'Q' },
      { suit: 'hearts', rank: '5' },
    ),
    ['A'],
  );
  assert.deepEqual(
    core.getCorrectAnswers(
      { suit: 'clubs', rank: '8' },
      { suit: 'spades', rank: '8' },
    ),
    ['B'],
  );
  assert.deepEqual(
    core.getCorrectAnswers(
      { suit: 'diamonds', rank: 'K' },
      { suit: 'clubs', rank: '3' },
    ),
    ['C'],
  );
  assert.deepEqual(
    core.getCorrectAnswers(
      { suit: 'spades', rank: 'A' },
      { suit: 'spades', rank: 'A' },
    ),
    ['A', 'B'],
  );
});

test('isAnswerCorrect accepts either answer for identical cards', () => {
  assert.equal(core.isAnswerCorrect(['A', 'B'], 'A'), true);
  assert.equal(core.isAnswerCorrect(['A', 'B'], 'B'), true);
  assert.equal(core.isAnswerCorrect(['A', 'B'], 'C'), false);
});

test('buildResults includes memory, answered, wrong, and timeout rows', () => {
  const cards = [
    { suit: 'hearts', rank: '5' },
    { suit: 'spades', rank: '8' },
    { suit: 'hearts', rank: 'Q' },
    { suit: 'clubs', rank: '8' },
    { suit: 'diamonds', rank: 'K' },
  ];
  const result = core.buildResults(cards, 2, [
    { index: 2, answer: 'A' },
    { index: 3, answer: 'C' },
    { index: 4, answer: null },
  ]);

  assert.equal(result.correctCount, 1);
  assert.equal(result.questionCount, 3);
  assert.equal(result.accuracy, 33);
  assert.equal(result.records[0].phase, 'memory');
  assert.equal(result.records[2].correct, true);
  assert.equal(result.records[3].correct, false);
  assert.equal(result.records[4].timedOut, true);
});

test('controller advances a memory card after 4000 ms', () => {
  const scheduler = createFakeScheduler();
  const controller = app.createGameController({ scheduler, onChange() {} });

  controller.start({ cards: sampleCards, n: 2 });
  scheduler.runNext(4000);

  assert.equal(controller.getState().index, 1);
  assert.equal(controller.getState().phase, 'memory');
});

test('controller records timeout then waits 1200 ms for feedback', () => {
  const scheduler = createFakeScheduler();
  const controller = app.createGameController({ scheduler, onChange() {} });

  controller.start({ cards: sampleCards, n: 2 });
  scheduler.runNext(4000);
  scheduler.runNext(4000);
  scheduler.runNext(4000);

  assert.equal(controller.getState().phase, 'feedback');
  assert.equal(controller.getState().responses[0].answer, null);
  assert.equal(controller.getState().feedback.timedOut, true);

  scheduler.runNext(1200);
  assert.equal(controller.getState().index, 3);
  assert.equal(controller.getState().phase, 'question');
});

test('controller ignores duplicate answers', () => {
  const scheduler = createFakeScheduler();
  const controller = app.createGameController({ scheduler, onChange() {} });

  controller.start({ cards: sampleCards, n: 2 });
  scheduler.runNext(4000);
  scheduler.runNext(4000);

  assert.equal(controller.answer('A'), true);
  assert.equal(controller.answer('B'), false);
  assert.equal(controller.getState().responses.length, 1);
  assert.equal(controller.getState().feedback.correct, true);
});

test('HTML contains the complete page contract and local script order', () => {
  const html = fs.readFileSync(path.join(__dirname, 'poker-n-back.html'), 'utf8');
  const requiredIds = [
    'setup-view',
    'play-view',
    'results-view',
    'setup-form',
    'total-cards',
    'n-value',
    'start-button',
    'card-rank',
    'card-suit',
    'timer-value',
    'timer-bar',
    'answer-a',
    'answer-b',
    'answer-c',
    'feedback',
    'accuracy-value',
    'score-detail',
    'records-body',
    'replay-button',
    'settings-button',
    'live-region',
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /href=["']styles\.css["']/);
  assert.ok(html.indexOf('game-core.js') < html.indexOf('app.js'));
});

test('CSS includes dark mode, reduced motion, focus, and responsive table contracts', () => {
  const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /--color-bg/);
  assert.match(css, /overflow-x:\s*auto/);
});

test('formatCard uses Chinese suit symbols and red classification', () => {
  assert.deepEqual(app.formatCard({ suit: 'hearts', rank: 'Q' }), {
    rank: 'Q',
    symbol: '♥',
    color: 'red',
    label: '红桃 Q',
  });
  assert.deepEqual(app.formatCard({ suit: 'clubs', rank: '10' }), {
    rank: '10',
    symbol: '♣',
    color: 'black',
    label: '梅花 10',
  });
});

test('answer formatting describes single and dual answers', () => {
  assert.equal(app.formatAnswer('A'), 'A 花色相同');
  assert.equal(app.formatAnswer(null), '未作答');
  assert.equal(app.formatCorrectAnswers(['A', 'B']), 'A 花色相同或 B 点数相同');
  assert.equal(app.formatCorrectAnswers(['C']), 'C 都不相同');
});

test('view switching does not repeat scrolling for the active view', () => {
  const views = {
    setup: { hidden: false },
    play: { hidden: true },
    results: { hidden: true },
  };
  let scrollCount = 0;
  const showView = app.createViewSwitcher(views, () => {
    scrollCount += 1;
  });

  assert.equal(showView('play'), true);
  assert.equal(showView('play'), false);
  assert.equal(views.play.hidden, false);
  assert.equal(scrollCount, 1);
});
