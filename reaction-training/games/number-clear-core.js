(function attachNumberCore(root, factory) {
  const core = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  }

  if (root) {
    root.NumberCore = core;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createNumberCore() {
  // Keep invalid board sizes small; the core supports boards up to the 6x6 game mode.
  const MAX_BOARD_ORDER = 6;

  function safeRandom(random) {
    const value = Number(random());
    return Math.min(0.999999, Math.max(0, Number.isFinite(value) ? value : 0));
  }

  function normaliseBoardOrder(order) {
    const numericOrder = Number(order);
    return Number.isInteger(numericOrder) && numericOrder > 0 && numericOrder <= MAX_BOARD_ORDER ? numericOrder : 1;
  }

  function shuffle(values, random) {
    const shuffled = values.slice();

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(safeRandom(random) * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }

    return shuffled;
  }

  function createBoard(order, random = Math.random) {
    const size = normaliseBoardOrder(order);
    const values = Array.from({ length: size * size }, (_, index) => index + 1);
    return shuffle(values, random);
  }

  function checkSelection(value, expected) {
    return value === expected;
  }

  function timeRating(order, milliseconds) {
    const limitsByOrder = {
      3: [13000, 19000, 27000],
      4: [22000, 32000, 46000],
      5: [36000, 52000, 72000],
      6: [52000, 72000, 98000],
    };
    const limits = limitsByOrder[order] || limitsByOrder[4];
    const numericMilliseconds = Number(milliseconds);
    const elapsed = Number.isFinite(numericMilliseconds) ? Math.max(0, numericMilliseconds) : 0;

    if (elapsed <= limits[0]) {
      return { label: '闪电', detail: '速度如闪电，数字尽在掌握。' };
    }

    if (elapsed <= limits[1]) {
      return { label: '专注', detail: '专注稳定，节奏掌控得很好。' };
    }

    if (elapsed <= limits[2]) {
      return { label: '稳定', detail: '完成得很稳，继续练习会更快。' };
    }

    return { label: '新手', detail: '慢慢来，熟悉数字分布就会提升。' };
  }

  return { checkSelection, createBoard, timeRating };
}));
