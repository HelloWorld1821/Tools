(function attachNeedleGame(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (!root || !root.document) {
    return;
  }

  function initialise() {
    if (root.document.getElementById('needle-canvas')) {
      api.createNeedleController(root.document, root);
    }
  }

  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createNeedleGame() {
  const HIT_ANGLE = Math.PI / 2;
  const START_SPEED = 1.05;
  const PROJECTILE_DURATION = 180;
  const BEST_RECORD_KEY = 'reaction-training:needle-best';

  function normaliseAngle(angle) {
    const circle = Math.PI * 2;
    const remainder = angle % circle;
    return remainder < 0 ? remainder + circle : remainder;
  }

  function canvasMetrics(canvas, pixelRatio) {
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || canvas.clientWidth || 600));
    const height = Math.max(1, Math.round(bounds.height || canvas.clientHeight || width));
    const ratio = Math.max(1, Math.min(3, Number(pixelRatio) || 1));

    return { width, height, ratio, pixelWidth: Math.round(width * ratio), pixelHeight: Math.round(height * ratio) };
  }

  function drawNeedle(context, centerX, centerY, radius, angle, length, colour) {
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    const startX = centerX + x * radius;
    const startY = centerY + y * radius;
    const endX = centerX + x * (radius + length);
    const endY = centerY + y * (radius + length);

    context.save();
    context.strokeStyle = colour;
    context.lineWidth = 5;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(endX, endY);
    context.stroke();
    context.fillStyle = '#14213d';
    context.beginPath();
    context.arc(endX, endY, 5, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function createNeedleController(documentRef, windowRef) {
    const canvas = documentRef.getElementById('needle-canvas');
    const scoreNode = documentRef.getElementById('needle-score');
    const startButton = documentRef.getElementById('needle-start');
    const fireButton = documentRef.getElementById('needle-fire');
    const resultPanel = documentRef.getElementById('needle-result');
    const resultCopy = documentRef.getElementById('needle-result-copy');
    const bestRecordNode = documentRef.getElementById('needle-best-record');
    const replayButton = documentRef.getElementById('needle-replay');
    const liveRegion = documentRef.getElementById('needle-live');

    if (!canvas || !scoreNode || !startButton || !fireButton || !resultPanel || !resultCopy || !bestRecordNode || !replayButton || !liveRegion) {
      return null;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }

    const core = windowRef.NeedleCore;
    const common = windowRef.ReactionCommon;
    if (!core || !common) {
      return null;
    }

    const state = {
      angle: 0,
      speed: START_SPEED,
      score: 0,
      placedAngles: [],
      projectile: null,
      running: false,
      destroyed: false,
      frameId: null,
      lastTime: null,
      metrics: null,
    };

    function announce(message) {
      liveRegion.textContent = message;
    }

    function updateScore() {
      scoreNode.textContent = String(state.score);
    }

    function updateBestRecord() {
      const storage = windowRef.localStorage;
      const currentBest = common.readStoredJson(storage, BEST_RECORD_KEY, null);
      const isNew = !currentBest || Number(state.score) > Number(currentBest.score);
      const bestScore = isNew ? state.score : Number(currentBest.score);

      if (isNew) {
        common.writeStoredJson(storage, BEST_RECORD_KEY, { score: state.score });
      }

      bestRecordNode.textContent = `最佳纪录：${bestScore} 分${isNew ? ' · 新的最佳纪录' : ''}`;
      bestRecordNode.classList.toggle('is-new', isNew);
    }

    function resize() {
      if (state.destroyed) {
        return;
      }
      const nextMetrics = canvasMetrics(canvas, windowRef.devicePixelRatio);
      state.metrics = nextMetrics;
      if (canvas.width !== nextMetrics.pixelWidth || canvas.height !== nextMetrics.pixelHeight) {
        canvas.width = nextMetrics.pixelWidth;
        canvas.height = nextMetrics.pixelHeight;
      }
      context.setTransform(nextMetrics.ratio, 0, 0, nextMetrics.ratio, 0, 0);
      draw();
    }

    function drawProjectile(centerX, centerY, radius, needleLength) {
      if (!state.projectile) {
        return;
      }

      const distance = Math.max(1, state.metrics.height - 22 - (centerY + radius));
      const tipY = state.metrics.height - 22 - distance * Math.min(1, state.projectile.progress);
      context.save();
      context.strokeStyle = '#ff984d';
      context.lineWidth = 5;
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(centerX, tipY);
      context.lineTo(centerX, tipY + needleLength);
      context.stroke();
      context.fillStyle = '#14213d';
      context.beginPath();
      context.arc(centerX, tipY + needleLength, 5, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }

    function draw() {
      if (!state.metrics) {
        return;
      }

      const { width, height } = state.metrics;
      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) * 0.19;
      const needleLength = Math.min(width, height) * 0.14;

      context.clearRect(0, 0, width, height);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.strokeStyle = 'rgba(8, 127, 140, 0.24)';
      context.lineWidth = 1;
      context.beginPath();
      context.arc(centerX, centerY, radius + needleLength + 22, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = '#dce9f3';
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = '#087f8c';
      context.lineWidth = 4;
      context.stroke();
      context.fillStyle = '#14213d';
      context.beginPath();
      context.arc(centerX, centerY, 9, 0, Math.PI * 2);
      context.fill();

      state.placedAngles.forEach((localAngle) => {
        drawNeedle(context, centerX, centerY, radius, normaliseAngle(localAngle + state.angle), needleLength, '#ee7526');
      });
      drawProjectile(centerX, centerY, radius, needleLength);
    }

    function stopAnimation() {
      if (state.frameId !== null) {
        windowRef.cancelAnimationFrame(state.frameId);
        state.frameId = null;
      }
      state.lastTime = null;
    }

    function finish() {
      state.running = false;
      state.projectile = null;
      fireButton.disabled = true;
      stopAnimation();
      const rating = common.scoreRating(state.score);
      resultCopy.textContent = `得分 ${state.score} · ${rating.label}：${rating.detail}`;
      updateBestRecord();
      resultPanel.hidden = false;
      announce(`碰撞结束，本局得分 ${state.score}，评级：${rating.label}。`);
      draw();
    }

    function resolveShot() {
      const placedWorldAngles = state.placedAngles.map((localAngle) => normaliseAngle(localAngle + state.angle));
      const dimension = Math.min(state.metrics.width, state.metrics.height);
      const geometry = {
        radius: dimension * 0.19,
        needleLength: dimension * 0.14,
        strokeWidth: 5,
        tipRadius: 5,
      };
      if (core.isNeedleContact(HIT_ANGLE, placedWorldAngles, geometry)) {
        finish();
        return;
      }

      state.placedAngles.push(normaliseAngle(HIT_ANGLE - state.angle));
      state.score += 1;
      state.speed = core.nextSpeed(state.speed, state.placedAngles.length);
      state.projectile = null;
      fireButton.disabled = false;
      updateScore();
      const speedMessage = state.placedAngles.length >= 8 ? '圆盘已达到最高速度。' : '圆盘正在加速。';
      announce(`命中空隙，得分 ${state.score}。${speedMessage}`);
    }

    function frame(timestamp) {
      if (!state.running) {
        state.frameId = null;
        return;
      }

      const delta = state.lastTime === null ? 0 : Math.min(50, timestamp - state.lastTime);
      state.lastTime = timestamp;
      state.angle = core.normaliseAngle(state.angle + state.speed * delta / 1000);
      if (state.projectile) {
        state.projectile.progress += delta / PROJECTILE_DURATION;
        if (state.projectile.progress >= 1) {
          resolveShot();
        }
      }
      draw();
      if (state.running) {
        state.frameId = windowRef.requestAnimationFrame(frame);
      }
    }

    function ensureAnimation() {
      if (state.frameId === null && state.running) {
        state.frameId = windowRef.requestAnimationFrame(frame);
      }
    }

    function start() {
      if (state.destroyed) {
        return;
      }
      stopAnimation();
      state.angle = 0;
      state.speed = START_SPEED;
      state.score = 0;
      state.placedAngles = [];
      state.projectile = null;
      state.running = true;
      resultPanel.hidden = true;
      startButton.disabled = true;
      fireButton.disabled = false;
      updateScore();
      announce('训练开始，点击圆盘、按回车或空格键，或选择发射一针。');
      resize();
      ensureAnimation();
      canvas.focus({ preventScroll: true });
    }

    function fire() {
      if (state.destroyed || !state.running || state.projectile) {
        return;
      }
      state.projectile = { progress: 0 };
      fireButton.disabled = true;
      announce('投针飞行中。');
      draw();
    }

    function onCanvasKeydown(event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fire();
      }
    }

    function onStartClick() {
      start();
    }

    function onReplayClick() {
      start();
    }

    function onFireClick() {
      fire();
    }

    function onCanvasPointerdown(event) {
      const isPermittedPointer = event.isPrimary === true
        && (event.pointerType === 'touch' || event.pointerType === 'pen' || event.button === 0);
      if (!isPermittedPointer) {
        return;
      }
      event.preventDefault();
      fire();
    }

    startButton.addEventListener('click', onStartClick);
    replayButton.addEventListener('click', onReplayClick);
    fireButton.addEventListener('click', onFireClick);
    canvas.addEventListener('pointerdown', onCanvasPointerdown);
    canvas.addEventListener('keydown', onCanvasKeydown);
    windowRef.addEventListener('resize', resize);

    let resizeObserver = null;
    if (typeof windowRef.ResizeObserver === 'function') {
      resizeObserver = new windowRef.ResizeObserver(resize);
      resizeObserver.observe(canvas);
    }

    resize();
    return {
      destroy() {
        if (state.destroyed) {
          return;
        }
        state.destroyed = true;
        state.running = false;
        state.projectile = null;
        startButton.disabled = true;
        fireButton.disabled = true;
        stopAnimation();
        startButton.removeEventListener('click', onStartClick);
        replayButton.removeEventListener('click', onReplayClick);
        fireButton.removeEventListener('click', onFireClick);
        canvas.removeEventListener('pointerdown', onCanvasPointerdown);
        canvas.removeEventListener('keydown', onCanvasKeydown);
        windowRef.removeEventListener('resize', resize);
        if (resizeObserver) {
          resizeObserver.disconnect();
        }
      },
      draw,
      fire,
      resize,
      start,
      state,
    };
  }

  return { PROJECTILE_DURATION, canvasMetrics, createNeedleController, drawNeedle };
}));
