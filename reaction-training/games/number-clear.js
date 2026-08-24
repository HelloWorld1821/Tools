(function attachNumberClearGame(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (!root || !root.document) {
    return;
  }

  function initialise() {
    if (root.document.getElementById('number-grid')) {
      api.createNumberClearController(root.document, root);
    }
  }

  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createNumberClearGame() {
  const VALID_ORDERS = [4, 5, 6];
  const WRONG_FLASH_MS = 320;
  const BEST_RECORD_KEY = 'reaction-training:number-best';

  function normaliseOrder(value) {
    const order = Number(value);
    return VALID_ORDERS.includes(order) ? order : 4;
  }

  function createNumberClearController(documentRef, windowRef) {
    const orderSelect = documentRef.getElementById('number-order');
    const startButton = documentRef.getElementById('number-start');
    const targetNode = documentRef.getElementById('number-target');
    const timeNode = documentRef.getElementById('number-time');
    const grid = documentRef.getElementById('number-grid');
    const resultPanel = documentRef.getElementById('number-result');
    const resultCopy = documentRef.getElementById('number-result-copy');
    const bestRecordNode = documentRef.getElementById('number-best-record');
    const replayButton = documentRef.getElementById('number-replay');
    const liveRegion = documentRef.getElementById('number-live');
    const core = windowRef.NumberCore;
    const common = windowRef.ReactionCommon;

    if (!orderSelect || !startButton || !targetNode || !timeNode || !grid || !resultPanel || !resultCopy || !bestRecordNode || !replayButton || !liveRegion || !core || !common) {
      return null;
    }

    const state = {
      board: [],
      buttons: [],
      destroyed: false,
      elapsed: 0,
      expected: 1,
      frameId: null,
      order: 4,
      running: false,
      startTimestamp: null,
      wrongTimer: null,
    };

    function announce(message) {
      liveRegion.textContent = message;
    }

    function formatTime() {
      return common.formatDuration(state.elapsed);
    }

    function updateStatus() {
      targetNode.textContent = state.running ? String(state.expected) : (state.expected > state.order * state.order ? '完成' : String(state.expected));
      timeNode.textContent = formatTime();
    }

    function updateBestRecord() {
      const storage = windowRef.localStorage;
      const records = common.readStoredJson(storage, BEST_RECORD_KEY, {});
      const currentBest = Number(records?.[state.order]);
      const isNew = !Number.isFinite(currentBest) || state.elapsed < currentBest;
      const bestElapsed = isNew ? state.elapsed : currentBest;

      if (isNew) {
        records[state.order] = state.elapsed;
        common.writeStoredJson(storage, BEST_RECORD_KEY, records);
      }

      bestRecordNode.textContent = `${state.order} × ${state.order} 最佳：${common.formatDuration(bestElapsed)}${isNew ? ' · 新的最佳纪录' : ''}`;
      bestRecordNode.classList.toggle('is-new', isNew);
    }

    function stopAnimation() {
      if (state.frameId !== null) {
        windowRef.cancelAnimationFrame(state.frameId);
        state.frameId = null;
      }
      state.startTimestamp = null;
    }

    function scheduleFrame() {
      if (state.running && state.frameId === null) {
        state.frameId = windowRef.requestAnimationFrame(onFrame);
      }
    }

    function onFrame(timestamp) {
      state.frameId = null;
      if (!state.running || state.destroyed) {
        return;
      }
      if (state.startTimestamp === null) {
        state.startTimestamp = timestamp;
      }
      state.elapsed = Math.max(0, timestamp - state.startTimestamp);
      updateStatus();
      scheduleFrame();
    }

    function clearWrongFlash() {
      if (state.wrongTimer !== null) {
        windowRef.clearTimeout(state.wrongTimer);
        state.wrongTimer = null;
      }
    }

    function flashWrong(button) {
      clearWrongFlash();
      button.classList.add('number-cell--wrong');
      const timerId = windowRef.setTimeout(() => {
        if (state.wrongTimer !== timerId) {
          return;
        }
        state.wrongTimer = null;
        button.classList.remove('number-cell--wrong');
      }, WRONG_FLASH_MS);
      state.wrongTimer = timerId;
      announce(`请按顺序点击 ${state.expected}。`);
    }

    function removeCellListeners() {
      state.buttons.forEach((button) => {
        const listener = button._numberClearClick;
        if (listener) {
          button.removeEventListener('click', listener);
        }
        button._numberClearClick = null;
      });
    }

    function clearBoard() {
      removeCellListeners();
      state.buttons = [];
      state.board = [];
      grid.replaceChildren();
    }

    function focusExpected() {
      const nextButton = state.buttons.find((button) => Number(button.value) === state.expected);
      if (nextButton && typeof nextButton.focus === 'function') {
        nextButton.focus({ preventScroll: true });
      }
    }

    function finish() {
      if (!state.running) {
        return;
      }
      state.running = false;
      stopAnimation();
      clearWrongFlash();
      state.buttons.forEach((button) => { button.disabled = true; });
      startButton.disabled = false;
      const rating = core.timeRating(state.order, state.elapsed);
      resultCopy.textContent = `用时 ${formatTime()} · ${rating.label}：${rating.detail}`;
      updateBestRecord();
      resultPanel.hidden = false;
      updateStatus();
      announce(`本局完成，用时 ${formatTime()}，评级：${rating.label}。`);
    }

    function choose(button, value) {
      if (state.destroyed || !state.running || button.disabled) {
        return;
      }
      if (!core.checkSelection(value, state.expected)) {
        flashWrong(button);
        return;
      }

      clearWrongFlash();
      button.classList.remove('number-cell--wrong');
      button.classList.add('number-cell--cleared');
      button.disabled = true;
      button.textContent = '';
      state.expected += 1;
      if (state.expected > state.order * state.order) {
        finish();
        return;
      }
      updateStatus();
      announce(`正确，下一项是 ${state.expected}。`);
      focusExpected();
    }

    function makeCell(value) {
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'number-cell';
      button.value = String(value);
      button.textContent = String(value);
      button.ariaLabel = `数字 ${value}`;
      function onCellClick() {
        choose(button, value);
      }
      button._numberClearClick = onCellClick;
      button.addEventListener('click', onCellClick);
      return button;
    }

    function buildBoard() {
      clearBoard();
      state.board = core.createBoard(state.order);
      state.buttons = state.board.map(makeCell);
      grid.style.setProperty ? grid.style.setProperty('--number-columns', String(state.order)) : (grid.style['--number-columns'] = String(state.order));
      grid.replaceChildren(...state.buttons);
    }

    function start() {
      if (state.destroyed) {
        return;
      }
      stopAnimation();
      clearWrongFlash();
      state.order = normaliseOrder(orderSelect.value);
      state.elapsed = 0;
      state.expected = 1;
      state.running = true;
      resultPanel.hidden = true;
      startButton.disabled = true;
      orderSelect.disabled = true;
      buildBoard();
      updateStatus();
      announce(`训练开始，请先点击 1。本局为 ${state.order} × ${state.order}。`);
      scheduleFrame();
      focusExpected();
    }

    function onStartClick() {
      start();
    }

    function onReplayClick() {
      start();
    }

    startButton.addEventListener('click', onStartClick);
    replayButton.addEventListener('click', onReplayClick);
    updateStatus();

    return {
      destroy() {
        if (state.destroyed) {
          return;
        }
        state.destroyed = true;
        state.running = false;
        stopAnimation();
        clearWrongFlash();
        startButton.disabled = true;
        replayButton.disabled = true;
        orderSelect.disabled = true;
        startButton.removeEventListener('click', onStartClick);
        replayButton.removeEventListener('click', onReplayClick);
        state.buttons.forEach((button) => { button.disabled = true; });
        removeCellListeners();
      },
      start,
      state,
    };
  }

  return { createNumberClearController, normaliseOrder };
}));
