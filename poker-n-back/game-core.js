(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.PokerNBackCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUITS = ['spades', 'hearts', 'clubs', 'diamonds'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  function validateConfig(totalValue, nValue) {
    const totalCards = Number(totalValue);
    const n = Number(nValue);
    const errors = {};

    if (!Number.isInteger(totalCards) || totalCards < 2 || totalCards > 100) {
      errors.totalCards = '总牌数必须是 2–100 之间的整数。';
    }

    if (!Number.isInteger(n) || n < 1 || (Number.isInteger(totalCards) && n >= totalCards)) {
      errors.n = 'N 必须是大于等于 1 且小于总牌数的整数。';
    }

    return {
      valid: Object.keys(errors).length === 0,
      totalCards,
      n,
      errors,
    };
  }

  function generateCards(count, random = Math.random) {
    return Array.from({ length: count }, () => ({
      suit: SUITS[Math.floor(random() * SUITS.length)],
      rank: RANKS[Math.floor(random() * RANKS.length)],
    }));
  }

  function getCorrectAnswers(current, previous) {
    const sameSuit = current.suit === previous.suit;
    const sameRank = current.rank === previous.rank;

    if (sameSuit && sameRank) {
      return ['A', 'B'];
    }
    if (sameSuit) {
      return ['A'];
    }
    if (sameRank) {
      return ['B'];
    }
    return ['C'];
  }

  function isAnswerCorrect(correctAnswers, answer) {
    return correctAnswers.includes(answer);
  }

  function buildResults(cards, n, responses) {
    const responseByIndex = new Map(responses.map((response) => [response.index, response]));
    const records = cards.map((card, index) => {
      if (index < n) {
        return {
          index,
          card,
          phase: 'memory',
        };
      }

      const comparisonCard = cards[index - n];
      const correctAnswers = getCorrectAnswers(card, comparisonCard);
      const response = responseByIndex.get(index) || { answer: null };

      return {
        index,
        card,
        comparisonCard,
        phase: 'question',
        answer: response.answer,
        correctAnswers,
        correct: isAnswerCorrect(correctAnswers, response.answer),
        timedOut: response.answer == null,
      };
    });

    const questionRecords = records.filter((record) => record.phase === 'question');
    const correctCount = questionRecords.filter((record) => record.correct).length;

    return {
      records,
      correctCount,
      questionCount: questionRecords.length,
      accuracy: questionRecords.length
        ? Math.round((correctCount / questionRecords.length) * 100)
        : 0,
    };
  }

  return {
    SUITS,
    RANKS,
    validateConfig,
    generateCards,
    getCorrectAnswers,
    isAnswerCorrect,
    buildResults,
  };
});
