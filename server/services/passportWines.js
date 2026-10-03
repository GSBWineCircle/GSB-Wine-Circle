/** Pure input validation for passport wines and member notes. */

'use strict';

const { STYLES, inferStyle, normalizeTagList } = require('./wineTags');

const MAX_WINES_PER_EVENT = 30;
const MAX_NOTE_LENGTH = 2000;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** @returns {{ok: true, wine: object}|{ok: false, error: string}} */
function sanitizeWine(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid wine.' };
  const name = clip(raw.name, 120);
  if (!name) return { ok: false, error: 'Every wine needs a name.' };
  const wine = {
    wine_id: typeof raw.wine_id === 'string' && /^wine_[a-f0-9]{32}$/.test(raw.wine_id) ? raw.wine_id : null,
    name,
    producer: clip(raw.producer, 80),
    vintage: clip(raw.vintage, 12),
    region: clip(raw.region, 80),
    country: clip(raw.country, 60),
    grape: clip(raw.grape, 80),
    style: STYLES.includes(raw.style) ? raw.style : '',
  };
  if (!wine.style) wine.style = inferStyle(`${wine.name} ${wine.grape} ${wine.region}`);
  return { ok: true, wine };
}

/** Fields whose change means the cached research/image may be stale. */
function researchKey(w) {
  return [w.name, w.producer, w.vintage, w.region, w.country, w.grape, w.style].join('|').toLowerCase();
}

/** @returns {{rating: number|null, note: string, tags: string[], share_tags: boolean}|{error: string}} */
function sanitizeNoteInput(body) {
  const b = body || {};
  let rating = null;
  if (b.rating !== null && b.rating !== undefined && b.rating !== '' && b.rating !== 0) {
    const n = Number(b.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { error: 'Rating must be a whole number from 1 to 5.' };
    rating = n;
  }
  return {
    rating,
    note: typeof b.note === 'string' ? b.note.trim().slice(0, MAX_NOTE_LENGTH) : '',
    tags: normalizeTagList(b.tags),
    share_tags: b.share_tags === true,
  };
}

/** True when a note carries nothing worth storing. */
function isEmptyNote(n) {
  return n.rating === null && !n.note && !n.tags.length;
}

module.exports = { MAX_WINES_PER_EVENT, MAX_NOTE_LENGTH, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, sanitizeWine, researchKey, sanitizeNoteInput, isEmptyNote };
