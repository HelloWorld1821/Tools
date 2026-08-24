(function attachReactionCommon(root, factory) {
  const common = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = common;
  }

  if (root) {
    root.ReactionCommon = common;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createReactionCommon() {
  function shuffle(values, random = Math.random) {
    const shuffled = values.slice();

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }

    return shuffled;
  }

  function scoreRating(score) {
    if (score >= 28) {
      return { label: '闪电', detail: '反应如闪电，继续保持！' };
    }

    if (score >= 16) {
      return { label: '专注', detail: '注意力很集中，状态不错。' };
    }

    if (score >= 8) {
      return { label: '稳定', detail: '节奏很稳定，再接再厉。' };
    }

    return { label: '新手', detail: '从基础开始，慢慢熟悉节奏。' };
  }

  function formatDuration(milliseconds) {
    const centiseconds = Math.floor(Math.max(0, milliseconds) / 10);
    const minutes = Math.floor(centiseconds / 6000);
    const seconds = Math.floor(centiseconds / 100) % 60;
    const remainingCentiseconds = centiseconds % 100;

    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainingCentiseconds).padStart(2, '0')}`;
  }

  function readStoredJson(storage, key, fallback) {
    try {
      const raw = storage?.getItem(key);
      return raw === null || raw === undefined ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeStoredJson(storage, key, value) {
    try {
      storage?.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  return { formatDuration, readStoredJson, scoreRating, shuffle, writeStoredJson };
}));
