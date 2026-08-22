(function (root, factory) {
  const core = typeof module === 'object' && module.exports
    ? require('./game-core.js')
    : root.PokerNBackCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.PokerNBackApp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  const CARD_DURATION_MS = 4000;
  const WRONG_FEEDBACK_MS = 1200;
  const CORRECT_FEEDBACK_MS = 250;
  const SUIT_PRESENTATION = {
    spades: { symbol: '♠', name: '黑桃', color: 'black' },
    hearts: { symbol: '♥', name: '红桃', color: 'red' },
    clubs: { symbol: '♣', name: '梅花', color: 'black' },
    diamonds: { symbol: '♦', name: '方块', color: 'red' },
  };
  const ANSWER_LABELS = {
    A: 'A 花色相同',
    B: 'B 点数相同',
    C: 'C 都不相同',
  };

  function createGameController({ scheduler, onChange }) {
    let timerId = null;
    let frameId = null;
    let roundToken = 0;
    let state = createInitialState();

    function createInitialState() {
      return {
        phase: 'idle',
        cards: [],
        n: 2,
        index: 0,
        deadline: 0,
        remainingMs: CARD_DURATION_MS,
        feedback: null,
        responses: [],
      };
    }

    function snapshot() {
      return {
        ...state,
        cards: state.cards.slice(),
        responses: state.responses.map((response) => ({ ...response })),
        feedback: state.feedback ? { ...state.feedback } : null,
      };
    }

    function notify() {
      onChange(snapshot());
    }

    function clearScheduledWork() {
      if (timerId != null) {
        scheduler.clearTimeout(timerId);
        timerId = null;
      }
      if (frameId != null) {
        scheduler.cancelFrame(frameId);
        frameId = null;
      }
    }

    function scheduleTick(token) {
      frameId = scheduler.requestFrame(() => {
        if (token !== roundToken || !['memory', 'question'].includes(state.phase)) {
          return;
        }
        state.remainingMs = Math.max(0, state.deadline - scheduler.now());
        notify();
        if (state.remainingMs > 0) {
          scheduleTick(token);
        }
      });
    }

    function beginCard() {
      clearScheduledWork();
      roundToken += 1;
      const token = roundToken;
      state.phase = state.index < state.n ? 'memory' : 'question';
      state.feedback = null;
      state.remainingMs = CARD_DURATION_MS;
      state.deadline = scheduler.now() + CARD_DURATION_MS;
      notify();
      timerId = scheduler.setTimeout(() => {
        if (token !== roundToken) {
          return;
        }
        handleCardTimeout();
      }, CARD_DURATION_MS);
      scheduleTick(token);
    }

    function beginFeedback({ answer, correct, timedOut, correctAnswers }) {
      clearScheduledWork();
      roundToken += 1;
      state.phase = 'feedback';
      state.remainingMs = 0;
      state.feedback = {
        answer,
        correct,
        timedOut,
        correctAnswers: correctAnswers.slice(),
      };
      notify();
      const delay = correct ? CORRECT_FEEDBACK_MS : WRONG_FEEDBACK_MS;
      timerId = scheduler.setTimeout(advance, delay);
    }

    function handleCardTimeout() {
      if (state.phase === 'memory') {
        advance();
        return;
      }
      if (state.phase !== 'question') {
        return;
      }

      const correctAnswers = core.getCorrectAnswers(
        state.cards[state.index],
        state.cards[state.index - state.n],
      );
      state.responses.push({ index: state.index, answer: null });
      beginFeedback({
        answer: null,
        correct: false,
        timedOut: true,
        correctAnswers,
      });
    }

    function advance() {
      clearScheduledWork();
      state.index += 1;
      if (state.index >= state.cards.length) {
        roundToken += 1;
        state.phase = 'finished';
        state.feedback = null;
        state.remainingMs = 0;
        notify();
        return;
      }
      beginCard();
    }

    function start({ cards, n }) {
      clearScheduledWork();
      roundToken += 1;
      state = {
        ...createInitialState(),
        cards: cards.slice(),
        n,
      };
      beginCard();
    }

    function answer(value) {
      if (state.phase !== 'question' || !['A', 'B', 'C'].includes(value)) {
        return false;
      }

      const correctAnswers = core.getCorrectAnswers(
        state.cards[state.index],
        state.cards[state.index - state.n],
      );
      const correct = core.isAnswerCorrect(correctAnswers, value);
      state.responses.push({ index: state.index, answer: value });
      beginFeedback({
        answer: value,
        correct,
        timedOut: false,
        correctAnswers,
      });
      return true;
    }

    function getState() {
      return snapshot();
    }

    function destroy() {
      clearScheduledWork();
      roundToken += 1;
    }

    return {
      start,
      answer,
      getState,
      destroy,
    };
  }

  function formatCard(card) {
    const suit = SUIT_PRESENTATION[card.suit];
    return {
      rank: card.rank,
      symbol: suit.symbol,
      color: suit.color,
      label: `${suit.name} ${card.rank}`,
    };
  }

  function formatAnswer(answer) {
    return answer == null ? '未作答' : ANSWER_LABELS[answer];
  }

  function formatCorrectAnswers(answers) {
    return answers.map((answer) => ANSWER_LABELS[answer]).join('或 ');
  }

  function createBrowserScheduler(browserWindow) {
    return {
      now: () => browserWindow.performance.now(),
      setTimeout: (callback, delay) => browserWindow.setTimeout(callback, delay),
      clearTimeout: (id) => browserWindow.clearTimeout(id),
      requestFrame: (callback) => browserWindow.requestAnimationFrame(callback),
      cancelFrame: (id) => browserWindow.cancelAnimationFrame(id),
    };
  }

  function createViewSwitcher(views, scrollToTop) {
    let activeView = Object.keys(views).find((name) => !views[name].hidden) || null;

    return function showView(viewName) {
      if (!views[viewName] || viewName === activeView) {
        return false;
      }
      for (const [name, view] of Object.entries(views)) {
        view.hidden = name !== viewName;
      }
      activeView = viewName;
      scrollToTop();
      return true;
    };
  }

  function initializeBrowser(documentRef, browserWindow) {
    const elements = {
      setupView: documentRef.getElementById('setup-view'),
      playView: documentRef.getElementById('play-view'),
      resultsView: documentRef.getElementById('results-view'),
      setupForm: documentRef.getElementById('setup-form'),
      totalCards: documentRef.getElementById('total-cards'),
      nValue: documentRef.getElementById('n-value'),
      totalError: documentRef.getElementById('total-cards-error'),
      nError: documentRef.getElementById('n-value-error'),
      startButton: documentRef.getElementById('start-button'),
      rulesSummary: documentRef.getElementById('rules-summary'),
      currentIndex: documentRef.getElementById('current-index'),
      totalCount: documentRef.getElementById('total-count'),
      timerValue: documentRef.getElementById('timer-value'),
      timerTrack: documentRef.querySelector('.timer-track'),
      timerBar: documentRef.getElementById('timer-bar'),
      stageBadge: documentRef.getElementById('stage-badge'),
      comparisonCopy: documentRef.getElementById('comparison-copy'),
      playingCard: documentRef.getElementById('playing-card'),
      cardRank: documentRef.getElementById('card-rank'),
      cardSuit: documentRef.getElementById('card-suit'),
      cardSuitLarge: documentRef.getElementById('card-suit-large'),
      cardRankBottom: documentRef.getElementById('card-rank-bottom'),
      cardSuitBottom: documentRef.getElementById('card-suit-bottom'),
      feedback: documentRef.getElementById('feedback'),
      answerButtons: [...documentRef.querySelectorAll('.answer-button')],
      accuracyValue: documentRef.getElementById('accuracy-value'),
      scoreDetail: documentRef.getElementById('score-detail'),
      recordsBody: documentRef.getElementById('records-body'),
      replayButton: documentRef.getElementById('replay-button'),
      settingsButton: documentRef.getElementById('settings-button'),
      liveRegion: documentRef.getElementById('live-region'),
      brand: documentRef.querySelector('.brand'),
    };

    let currentConfig = { totalCards: 10, n: 2 };
    let lastAnnouncedCard = -1;
    const controller = createGameController({
      scheduler: createBrowserScheduler(browserWindow),
      onChange: renderState,
    });
    const showView = createViewSwitcher(
      {
        setup: elements.setupView,
        play: elements.playView,
        results: elements.resultsView,
      },
      () => browserWindow.scrollTo({ top: 0, behavior: 'smooth' }),
    );

    function updateRulesSummary(validation) {
      const strongValues = elements.rulesSummary.querySelectorAll('strong');
      const n = Number.isInteger(validation.n) && validation.n > 0 ? validation.n : 'N';
      strongValues[0].textContent = n;
      strongValues[1].textContent = Number.isInteger(validation.n) && validation.n > 0
        ? validation.n + 1
        : 'N+1';
      if (Number.isInteger(validation.totalCards)) {
        elements.nValue.max = Math.max(1, validation.totalCards - 1);
      }
    }

    function validateInputs(showErrors) {
      const validation = core.validateConfig(elements.totalCards.value, elements.nValue.value);
      elements.startButton.disabled = !validation.valid;
      elements.totalCards.setAttribute('aria-invalid', String(Boolean(validation.errors.totalCards)));
      elements.nValue.setAttribute('aria-invalid', String(Boolean(validation.errors.n)));
      elements.totalError.textContent = showErrors ? validation.errors.totalCards || '' : '';
      elements.nError.textContent = showErrors ? validation.errors.n || '' : '';
      updateRulesSummary(validation);
      return validation;
    }

    function renderCard(card) {
      const presentation = formatCard(card);
      elements.cardRank.textContent = presentation.rank;
      elements.cardRankBottom.textContent = presentation.rank;
      elements.cardSuit.textContent = presentation.symbol;
      elements.cardSuitLarge.textContent = presentation.symbol;
      elements.cardSuitBottom.textContent = presentation.symbol;
      elements.playingCard.classList.toggle('red', presentation.color === 'red');
      elements.playingCard.setAttribute('aria-label', presentation.label);
    }

    function renderFeedback(state) {
      elements.feedback.className = 'feedback';
      elements.feedback.textContent = '';

      if (state.phase !== 'feedback' || !state.feedback) {
        return;
      }

      if (state.feedback.correct) {
        elements.feedback.classList.add('success');
        elements.feedback.textContent = '✓ 回答正确';
      } else {
        elements.feedback.classList.add('error');
        const prefix = state.feedback.timedOut ? '已超时' : '回答错误';
        elements.feedback.textContent = `${prefix}，正确答案：${formatCorrectAnswers(state.feedback.correctAnswers)}`;
      }
      elements.liveRegion.textContent = elements.feedback.textContent;
    }

    function renderPlay(state) {
      showView('play');
      renderCard(state.cards[state.index]);
      elements.currentIndex.textContent = state.index + 1;
      elements.totalCount.textContent = state.cards.length;

      const remaining = Math.max(0, state.remainingMs);
      const ratio = Math.min(1, remaining / CARD_DURATION_MS);
      elements.timerValue.textContent = (remaining / 1000).toFixed(1);
      elements.timerBar.style.transform = `scaleX(${ratio})`;
      elements.timerBar.classList.toggle('urgent', remaining <= 1000 && state.phase === 'question');
      elements.timerTrack.setAttribute('aria-valuenow', String(Math.round(remaining)));

      const isQuestion = state.phase === 'question';
      const isMemory = state.phase === 'memory';
      elements.stageBadge.textContent = isMemory ? '记忆阶段' : isQuestion ? '判断阶段' : '答案反馈';
      elements.comparisonCopy.textContent = isMemory
        ? '记住这张牌，暂时无需判断'
        : `与前第 ${state.n} 张牌比较`;
      for (const button of elements.answerButtons) {
        button.disabled = !isQuestion;
      }
      renderFeedback(state);

      if ((isMemory || isQuestion) && lastAnnouncedCard !== state.index) {
        lastAnnouncedCard = state.index;
        const cardLabel = formatCard(state.cards[state.index]).label;
        elements.liveRegion.textContent = isMemory
          ? `第 ${state.index + 1} 张，${cardLabel}，记忆阶段。`
          : `第 ${state.index + 1} 张，${cardLabel}，请与前第 ${state.n} 张牌比较。`;
      }
    }

    function appendTextCell(row, text) {
      const cell = documentRef.createElement('td');
      cell.textContent = text;
      row.appendChild(cell);
      return cell;
    }

    function appendCardCell(row, card) {
      const cell = documentRef.createElement('td');
      if (!card) {
        cell.textContent = '—';
      } else {
        const presentation = formatCard(card);
        const span = documentRef.createElement('span');
        span.className = `card-text ${presentation.color}`;
        span.textContent = `${presentation.rank}${presentation.symbol}`;
        span.setAttribute('aria-label', presentation.label);
        cell.appendChild(span);
      }
      row.appendChild(cell);
    }

    function appendResultCell(row, record) {
      const cell = documentRef.createElement('td');
      const pill = documentRef.createElement('span');
      if (record.phase === 'memory') {
        pill.className = 'result-pill memory';
        pill.textContent = '记忆牌';
      } else if (record.correct) {
        pill.className = 'result-pill correct';
        pill.textContent = '正确';
      } else if (record.timedOut) {
        pill.className = 'result-pill timeout';
        pill.textContent = '超时';
      } else {
        pill.className = 'result-pill wrong';
        pill.textContent = '错误';
      }
      cell.appendChild(pill);
      row.appendChild(cell);
    }

    function renderResults(state) {
      const results = core.buildResults(state.cards, state.n, state.responses);
      elements.accuracyValue.textContent = `${results.accuracy}%`;
      elements.scoreDetail.textContent = `${results.correctCount} / ${results.questionCount} 次判断正确`;
      elements.recordsBody.textContent = '';
      const fragment = documentRef.createDocumentFragment();

      for (const record of results.records) {
        const row = documentRef.createElement('tr');
        appendTextCell(row, String(record.index + 1));
        appendCardCell(row, record.card);
        appendCardCell(row, record.comparisonCard);
        appendTextCell(row, record.phase === 'memory' ? '—' : formatAnswer(record.answer));
        appendTextCell(
          row,
          record.phase === 'memory' ? '—' : formatCorrectAnswers(record.correctAnswers),
        );
        appendResultCell(row, record);
        fragment.appendChild(row);
      }

      elements.recordsBody.appendChild(fragment);
      elements.liveRegion.textContent = `本局结束，正确率 ${results.accuracy}%。`;
      showView('results');
    }

    function renderState(state) {
      if (state.phase === 'finished') {
        renderResults(state);
      } else if (state.phase !== 'idle') {
        renderPlay(state);
      }
    }

    function startGame(validation) {
      currentConfig = {
        totalCards: validation.totalCards,
        n: validation.n,
      };
      lastAnnouncedCard = -1;
      const cards = core.generateCards(currentConfig.totalCards);
      controller.start({ cards, n: currentConfig.n });
    }

    elements.setupForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const validation = validateInputs(true);
      if (validation.valid) {
        startGame(validation);
      }
    });

    for (const input of [elements.totalCards, elements.nValue]) {
      input.addEventListener('input', () => validateInputs(true));
    }

    for (const button of elements.answerButtons) {
      button.addEventListener('click', () => controller.answer(button.dataset.answer));
    }

    documentRef.addEventListener('keydown', (event) => {
      const tagName = event.target && event.target.tagName;
      if (event.repeat || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || event.target?.isContentEditable) {
        return;
      }
      const answer = event.key.toUpperCase();
      if (['A', 'B', 'C'].includes(answer) && controller.answer(answer)) {
        event.preventDefault();
      }
    });

    elements.replayButton.addEventListener('click', () => {
      lastAnnouncedCard = -1;
      controller.start({
        cards: core.generateCards(currentConfig.totalCards),
        n: currentConfig.n,
      });
    });

    elements.settingsButton.addEventListener('click', () => {
      controller.destroy();
      showView('setup');
      elements.totalCards.focus();
    });

    elements.brand.addEventListener('click', (event) => {
      event.preventDefault();
      controller.destroy();
      showView('setup');
    });

    validateInputs(false);
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && core) {
    initializeBrowser(document, window);
  }

  return {
    CARD_DURATION_MS,
    WRONG_FEEDBACK_MS,
    CORRECT_FEEDBACK_MS,
    createGameController,
    formatCard,
    formatAnswer,
    formatCorrectAnswers,
    createViewSwitcher,
    initializeBrowser,
  };
});
