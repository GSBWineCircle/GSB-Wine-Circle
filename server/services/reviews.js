/**
 * Pure helpers for anonymous event reviews - no DB/IO dependencies.
 */

'use strict';

const MAX_COMMENT_LENGTH = 2000;

/** A rating must be a whole number from 1 to 5. */
function isValidRating(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

/** Trim and cap a comment's length; always returns a string (never null). */
function sanitizeComment(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.slice(0, MAX_COMMENT_LENGTH);
}

/**
 * Aggregate a flat list of reviews into count/average/distribution.
 * @param {Array<{rating: number|string}>} reviews
 * @returns {{count: number, avgRating: number, distribution: Record<1|2|3|4|5, number>}}
 */
function buildReviewStats(reviews) {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  (reviews || []).forEach(r => {
    const n = Number(r.rating);
    if (distribution[n] !== undefined) distribution[n]++;
    sum += n;
  });
  const count = (reviews || []).length;
  return { count, avgRating: count ? sum / count : 0, distribution };
}

module.exports = { MAX_COMMENT_LENGTH, isValidRating, sanitizeComment, buildReviewStats };
