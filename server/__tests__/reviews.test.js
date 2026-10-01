'use strict';
const { isValidRating, sanitizeComment, buildReviewStats, MAX_COMMENT_LENGTH } = require('../services/reviews');

describe('isValidRating', () => {
  test('accepts whole numbers 1-5, including as strings', () => {
    [1, 2, 3, 4, 5, '1', '5'].forEach(v => expect(isValidRating(v)).toBe(true));
  });
  test('rejects 0, 6, negatives, decimals, non-numbers', () => {
    [0, 6, -1, 3.5, 'abc', null, undefined, {}, []].forEach(v => expect(isValidRating(v)).toBe(false));
  });
});

describe('sanitizeComment', () => {
  test('trims whitespace', () => {
    expect(sanitizeComment('  great night!  ')).toBe('great night!');
  });
  test('non-string input becomes empty string, never null/undefined', () => {
    expect(sanitizeComment(null)).toBe('');
    expect(sanitizeComment(undefined)).toBe('');
    expect(sanitizeComment(42)).toBe('');
  });
  test('caps length at MAX_COMMENT_LENGTH', () => {
    const long = 'x'.repeat(MAX_COMMENT_LENGTH + 500);
    expect(sanitizeComment(long).length).toBe(MAX_COMMENT_LENGTH);
  });
});

describe('buildReviewStats', () => {
  test('empty list -> zeroed stats, no division by zero', () => {
    expect(buildReviewStats([])).toEqual({ count: 0, avgRating: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
  });
  test('computes count, average, and per-star distribution', () => {
    const reviews = [{ rating: 5 }, { rating: 5 }, { rating: 3 }, { rating: 1 }];
    expect(buildReviewStats(reviews)).toEqual({
      count: 4, avgRating: 3.5, distribution: { 1: 1, 2: 0, 3: 1, 4: 0, 5: 2 },
    });
  });
  test('tolerates string ratings from raw DB rows', () => {
    expect(buildReviewStats([{ rating: '4' }, { rating: '2' }])).toEqual({
      count: 2, avgRating: 3, distribution: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 0 },
    });
  });
  test('ignores out-of-range junk rather than crashing', () => {
    const stats = buildReviewStats([{ rating: 5 }, { rating: 99 }]);
    expect(stats.count).toBe(2); // counted as submitted...
    expect(stats.distribution[5]).toBe(1); // ...but only the valid one lands in a bucket
  });
  test('handles undefined/null input as empty', () => {
    expect(buildReviewStats(undefined).count).toBe(0);
    expect(buildReviewStats(null).count).toBe(0);
  });
});
