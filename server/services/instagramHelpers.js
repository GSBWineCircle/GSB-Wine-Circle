/**
 * Pure helpers for the Instagram integration - no IO, unit-tested.
 */
'use strict';

const MAX_WELCOME_PHOTOS = 24;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SELECTABLE_MEDIA_TYPES = ['IMAGE', 'CAROUSEL_ALBUM'];

/** Instagram media ids are numeric strings. */
function isValidMediaId(id) {
  return typeof id === 'string' && /^\d{1,32}$/.test(id);
}

/**
 * Only fetch image bytes from Instagram's own CDN (https), so a malformed
 * API response can never make the server fetch an arbitrary URL.
 * `extraOrigin` lets tests point at a local mock server.
 */
function isAllowedImageUrl(rawUrl, extraOrigin) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { return false; }
  if (extraOrigin && u.origin === extraOrigin) return true;
  if (u.protocol !== 'https:') return false;
  return /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(u.hostname);
}

function isSelectableMedia(m) {
  return !!m && SELECTABLE_MEDIA_TYPES.includes(m.media_type) && !!m.media_url;
}

/**
 * Validate a requested selection: array of unique valid media ids, capped.
 * @returns {{ok: true, ids: string[]} | {ok: false, error: string}}
 */
function validateSelection(ids) {
  if (!Array.isArray(ids)) return { ok: false, error: 'media_ids must be an array.' };
  if (ids.length > MAX_WELCOME_PHOTOS) {
    return { ok: false, error: `Choose at most ${MAX_WELCOME_PHOTOS} photos.` };
  }
  if (!ids.every(isValidMediaId)) return { ok: false, error: 'Invalid photo id in selection.' };
  return { ok: true, ids: [...new Set(ids)] };
}

module.exports = {
  MAX_WELCOME_PHOTOS, MAX_IMAGE_BYTES, ALLOWED_IMAGE_TYPES,
  isValidMediaId, isAllowedImageUrl, isSelectableMedia, validateSelection,
};
