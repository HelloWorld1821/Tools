(function attachMoleCore(root, factory) {
  const core = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }

  if (root) {
    root.MoleCore = core;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMoleCore() {
  function safeRandom(random) {
    const value = Number(random());
    return Math.min(0.999999, Math.max(0, Number.isFinite(value) ? value : 0));
  }

  function normaliseNonNegativeInteger(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue > 0 ? Math.floor(numericValue) : 0;
  }

  function getRoundSettings(score) {
    const normalisedScore = normaliseNonNegativeInteger(score);

    return {
      gapMs: Math.max(340, 920 - normalisedScore * 22),
      visibleMs: Math.max(360, 1050 - normalisedScore * 20),
      missLimit: 3,
    };
  }

  function pickHole(holeCount, previousHole, random = Math.random) {
    const count = normaliseNonNegativeInteger(holeCount);

    if (count === 0) {
      return -1;
    }

    if (count === 1) {
      return 0;
    }

    if (!Number.isInteger(previousHole) || previousHole < 0 || previousHole >= count) {
      return Math.floor(safeRandom(random) * count);
    }

    const choice = Math.floor(safeRandom(random) * (count - 1));
    return choice >= previousHole ? choice + 1 : choice;
  }

  function createHoleLayout(holeCount, random = Math.random) {
    const count = normaliseNonNegativeInteger(holeCount);
    const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(count))));
    const rows = Math.max(1, Math.ceil(count / columns));
    const horizontalStep = columns === 1 ? 0 : 72 / (columns - 1);
    const verticalStep = rows === 1 ? 0 : 72 / (rows - 1);
    const positions = [];

    for (let index = 0; index < count; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const xBase = columns === 1 ? 50 : 14 + column * horizontalStep;
      const yBase = rows === 1 ? 50 : 14 + row * verticalStep;
      const x = xBase + (safeRandom(random) - 0.5) * (columns === 1 ? 0 : 2);
      const y = yBase + (safeRandom(random) - 0.5) * (rows === 1 ? 0 : 3);

      positions.push({ x: +x.toFixed(2), y: +y.toFixed(2) });
    }

    return positions;
  }

  return { createHoleLayout, getRoundSettings, pickHole };
}));
