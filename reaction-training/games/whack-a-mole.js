(function attachWhackAMoleGame(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (!root || !root.document) {
    return;
  }

  function initialise() {
    if (root.document.getElementById('mole-field')) {
      api.createWhackAMoleController(root.document, root);
    }
  }

  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createWhackAMoleGame() {
  const BEST_RECORD_KEY = 'reaction-training:mole-best';

  function createWhackAMoleController(documentRef, windowRef) {
    const countSelect = documentRef.getElementById('mole-count');
    const startButton = documentRef.getElementById('mole-start');
    const scoreNode = documentRef.getElementById('mole-score');
    const missesNode = documentRef.getElementById('mole-misses');
    const field = documentRef.getElementById('mole-field');
    const resultPanel = documentRef.getElementById('mole-result');
    const resultCopy = documentRef.getElementById('mole-result-copy');
    const bestRecordNode = documentRef.getElementById('mole-best-record');
    const replayButton = documentRef.getElementById('mole-replay');
    const liveRegion = documentRef.getElementById('mole-live');
    const feedbackNode = documentRef.getElementById('mole-feedback');
    const missStatusNode = documentRef.getElementById('mole-miss-status');
    const core = windowRef.MoleCore;
    const common = windowRef.ReactionCommon;

    if (!countSelect || !startButton || !scoreNode || !missesNode || !field || !resultPanel || !resultCopy || !bestRecordNode || !replayButton || !liveRegion || !feedbackNode || !missStatusNode || !core || !common) {
      return null;
    }

    const state = {
      currentHole: null,
      destroyed: false,
      holeCount: 0,
      holes: [],
      misses: 0,
      nextTimer: null,
      previousHole: -1,
      roundToken: 0,
      running: false,
      score: 0,
      visibleTimer: null,
    };

    function announce(message) {
      liveRegion.textContent = message;
    }

    function clearMissFeedback() {
      feedbackNode.textContent = '';
      feedbackNode.classList.remove('is-visible');
      field.classList.remove('is-missed');
      missStatusNode.classList.remove('is-alert');
    }

    function showMissFeedback(missLimit) {
      const remaining = Math.max(0, missLimit - state.misses);
      feedbackNode.textContent = `漏掉了！还可漏掉 ${remaining} 次`;
      feedbackNode.classList.add('is-visible');
      field.classList.add('is-missed');
      missStatusNode.classList.add('is-alert');
    }

    function updateStatus() {
      scoreNode.textContent = String(state.score);
      missesNode.textContent = String(state.misses);
    }

    function updateBestRecord() {
      const storage = windowRef.localStorage;
      const currentBest = common.readStoredJson(storage, BEST_RECORD_KEY, null);
      const isNew = !currentBest || Number(state.score) > Number(currentBest.score);
      const bestRecord = isNew ? { score: state.score, misses: state.misses } : currentBest;

      if (isNew) {
        common.writeStoredJson(storage, BEST_RECORD_KEY, bestRecord);
      }

      bestRecordNode.textContent = `最佳纪录：${bestRecord.score} 分（漏掉 ${bestRecord.misses} 次）${isNew ? ' · 新的最佳纪录' : ''}`;
      bestRecordNode.classList.toggle('is-new', isNew);
    }

    function clearPendingTimers() {
      if (state.nextTimer !== null) {
        windowRef.clearTimeout(state.nextTimer);
        state.nextTimer = null;
      }
      if (state.visibleTimer !== null) {
        windowRef.clearTimeout(state.visibleTimer);
        state.visibleTimer = null;
      }
    }

    function deactivateHole(index) {
      if (!Number.isInteger(index) || !state.holes[index]) {
        return;
      }
      const hole = state.holes[index];
      hole.classList.remove('mole-hole--active');
      hole.disabled = true;
    }

    function clearCurrentMole() {
      deactivateHole(state.currentHole);
      state.currentHole = null;
    }

    function finishRound() {
      if (!state.running) {
        return;
      }
      state.running = false;
      clearPendingTimers();
      clearCurrentMole();
      state.holes.forEach((hole) => { hole.disabled = true; });
      countSelect.disabled = false;
      const rating = common.scoreRating(state.score);
      resultCopy.textContent = `得分 ${state.score} · ${rating.label}：${rating.detail}`;
      updateBestRecord();
      resultPanel.hidden = false;
      announce(`训练结束，得分 ${state.score}，漏掉 ${state.misses} 次，评级：${rating.label}。`);
    }

    function scheduleNextMole() {
      if (!state.running || state.destroyed) {
        return;
      }
      if (state.nextTimer !== null || state.currentHole !== null) {
        return;
      }
      const settings = core.getRoundSettings(state.score);
      const token = state.roundToken;
      let timerId = null;
      timerId = windowRef.setTimeout(() => {
        if (state.destroyed || !state.running || token !== state.roundToken || state.nextTimer !== timerId) {
          return;
        }
        state.nextTimer = null;
        showMole();
      }, settings.gapMs);
      state.nextTimer = timerId;
    }

    function expireMole() {
      if (!state.running || state.currentHole === null) {
        return;
      }
      state.visibleTimer = null;
      clearCurrentMole();
      state.misses += 1;
      updateStatus();
      const settings = core.getRoundSettings(state.score);
      showMissFeedback(settings.missLimit);
      if (state.misses >= settings.missLimit) {
        finishRound();
        return;
      }
      announce(`错过目标，已漏掉 ${state.misses} 次。`);
      scheduleNextMole();
    }

    function showMole() {
      if (!state.running || state.currentHole !== null || state.destroyed) {
        return;
      }
      clearMissFeedback();
      const index = core.pickHole(state.holeCount, state.previousHole);
      if (index < 0 || !state.holes[index]) {
        return;
      }
      state.currentHole = index;
      state.previousHole = index;
      const hole = state.holes[index];
      hole.disabled = false;
      hole.classList.add('mole-hole--active');
      const settings = core.getRoundSettings(state.score);
      const token = state.roundToken;
      const activeIndex = index;
      let timerId = null;
      timerId = windowRef.setTimeout(() => {
        if (state.destroyed || !state.running || token !== state.roundToken || state.visibleTimer !== timerId || state.currentHole !== activeIndex) {
          return;
        }
        state.visibleTimer = null;
        expireMole();
      }, settings.visibleMs);
      state.visibleTimer = timerId;
      if (typeof hole.focus === 'function') {
        hole.focus({ preventScroll: true });
      }
      announce('地鼠出现，立即点击目标！');
    }

    function hitHole(index) {
      if (!state.running || state.currentHole !== index || state.destroyed) {
        return;
      }
      clearMissFeedback();
      clearPendingTimers();
      clearCurrentMole();
      state.score += 1;
      updateStatus();
      announce(`命中！得分 ${state.score}。`);
      scheduleNextMole();
    }

    function makeHole(index, position) {
      const hole = documentRef.createElement('button');
      hole.type = 'button';
      hole.className = 'mole-hole';
      hole.disabled = true;
      hole.ariaLabel = `第 ${index + 1} 个地洞`;
      hole.style.left = `${position.x}%`;
      hole.style.top = `${position.y}%`;

      function onHoleClick() {
        hitHole(index);
      }

      function onHoleKeydown(event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          hitHole(index);
        }
      }

      function onHolePointerdown(event) {
        const isTouchOrPen = event.isPrimary === true && (event.pointerType === 'touch' || event.pointerType === 'pen');
        if (!isTouchOrPen) {
          return;
        }
        event.preventDefault();
        hitHole(index);
      }

      hole.addEventListener('click', onHoleClick);
      hole.addEventListener('keydown', onHoleKeydown);
      hole.addEventListener('pointerdown', onHolePointerdown);
      hole._moleListeners = { onHoleClick, onHoleKeydown, onHolePointerdown };
      return hole;
    }

    function buildLayout() {
      state.holes.forEach((hole) => {
        const listeners = hole._moleListeners;
        if (!listeners) return;
        hole.removeEventListener('click', listeners.onHoleClick);
        hole.removeEventListener('keydown', listeners.onHoleKeydown);
        hole.removeEventListener('pointerdown', listeners.onHolePointerdown);
      });
      const layout = core.createHoleLayout(state.holeCount);
      state.holes = layout.map((position, index) => makeHole(index, position));
      field.replaceChildren(...state.holes);
    }

    function start() {
      if (state.destroyed) {
        return;
      }
      clearPendingTimers();
      state.roundToken += 1;
      state.holeCount = [6, 9, 12].includes(Number(countSelect.value)) ? Number(countSelect.value) : 6;
      state.score = 0;
      state.misses = 0;
      state.currentHole = null;
      state.previousHole = -1;
      state.running = true;
      countSelect.disabled = true;
      resultPanel.hidden = true;
      clearMissFeedback();
      buildLayout();
      updateStatus();
      announce(`训练开始，共 ${state.holeCount} 个地洞。`);
      scheduleNextMole();
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
        state.roundToken += 1;
        clearPendingTimers();
        clearCurrentMole();
        startButton.disabled = true;
        replayButton.disabled = true;
        countSelect.disabled = true;
        startButton.removeEventListener('click', onStartClick);
        replayButton.removeEventListener('click', onReplayClick);
        state.holes.forEach((hole) => {
          const listeners = hole._moleListeners;
          if (!listeners) return;
          hole.removeEventListener('click', listeners.onHoleClick);
          hole.removeEventListener('keydown', listeners.onHoleKeydown);
          hole.removeEventListener('pointerdown', listeners.onHolePointerdown);
          hole.disabled = true;
        });
      },
      start,
      state,
    };
  }

  return { createWhackAMoleController };
}));
