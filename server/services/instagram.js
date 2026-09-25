// Instagram Graph API client (Instagram API with Instagram Login).
// Reads the club account's media so admins can pick photos for the welcome
// screen. Token: INSTAGRAM_ACCESS_TOKEN (long-lived), kept fresh by
// refreshToken() and stored in instagram_credentials once refreshed.
const db = require('../db');
const {
  MAX_IMAGE_BYTES, ALLOWED_IMAGE_TYPES, isAllowedImageUrl,
} = require('./instagramHelpers');

const DEFAULT_BASE = 'https://graph.instagram.com';
const apiBase = () => (process.env.INSTAGRAM_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
// Set only when INSTAGRAM_API_BASE is overridden (local mock server).
const mockOrigin = () => (process.env.INSTAGRAM_API_BASE ? new URL(apiBase()).origin : null);

class InstagramError extends Error {
  constructor(message, status) { super(message); this.status = status || 502; }
}

async function getToken() {
  const envTok = process.env.INSTAGRAM_ACCESS_TOKEN || '';
  if (!envTok) return null;
  const { rows } = await db.query('SELECT access_token, seeded_from FROM instagram_credentials WHERE id = 1');
  if (rows.length && rows[0].seeded_from === envTok) return rows[0].access_token;
  return envTok;
}

async function isConfigured() { return !!process.env.INSTAGRAM_ACCESS_TOKEN; }

// Never put the request URL (which carries the token) into an error message.
async function graphGet(pathOrUrl, params = {}) {
  const token = await getToken();
  if (!token) throw new InstagramError('Instagram is not connected.', 503);
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${apiBase()}${pathOrUrl}`);
  if (url.origin !== new URL(apiBase()).origin) throw new InstagramError('Unexpected Instagram URL.');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', token);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new InstagramError('Could not reach Instagram.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const expired = body?.error?.code === 190 || res.status === 401;
    throw new InstagramError(
      expired ? 'The Instagram access token is invalid or expired - generate a new one in the Meta developer dashboard.' : `Instagram error: ${msg}`,
      expired ? 401 : 502
    );
  }
  return body;
}

const MEDIA_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp';

/** Most recent media, newest first, following pagination up to `max` items. */
async function listMedia(max = 60) {
  const out = [];
  let body = await graphGet('/me/media', { fields: MEDIA_FIELDS, limit: 50 });
  for (;;) {
    out.push(...(body.data || []));
    const next = body.paging?.next;
    if (!next || out.length >= max) break;
    body = await graphGet(next);
  }
  return out.slice(0, max);
}

async function getMedia(id) {
  return graphGet(`/${id}`, { fields: MEDIA_FIELDS });
}

async function getAccount() {
  return graphGet('/me', { fields: 'username,account_type' });
}

/** Download an image from Instagram's CDN, enforcing host/type/size limits. */
async function downloadImage(url) {
  if (!isAllowedImageUrl(url, mockOrigin())) throw new InstagramError('Refusing to download from an unexpected host.');
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new InstagramError('Could not download the photo from Instagram.');
  }
  if (!res.ok) throw new InstagramError(`Photo download failed (HTTP ${res.status}).`);
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) throw new InstagramError('Photo is not a JPEG, PNG or WebP image.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new InstagramError('Photo is too large.');
  return { buffer: buf, contentType };
}

/** Renew the long-lived token (valid 60 days; refreshable once >24h old). */
async function refreshToken() {
  const envTok = process.env.INSTAGRAM_ACCESS_TOKEN || '';
  const current = await getToken();
  if (!current) return { refreshed: false, reason: 'not configured' };
  const body = await graphGet('/refresh_access_token', { grant_type: 'ig_refresh_token' });
  if (!body.access_token) throw new InstagramError('Instagram did not return a refreshed token.');
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null;
  await db.query(
    `INSERT INTO instagram_credentials (id, access_token, seeded_from, expires_at, refreshed_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE
       SET access_token = EXCLUDED.access_token, seeded_from = EXCLUDED.seeded_from,
           expires_at = EXCLUDED.expires_at, refreshed_at = NOW()`,
    [body.access_token, envTok, expiresAt]
  );
  return { refreshed: true, expiresAt };
}

async function tokenExpiry() {
  const { rows } = await db.query('SELECT expires_at, seeded_from FROM instagram_credentials WHERE id = 1');
  const envTok = process.env.INSTAGRAM_ACCESS_TOKEN || '';
  return rows.length && rows[0].seeded_from === envTok ? rows[0].expires_at : null;
}

module.exports = {
  InstagramError, isConfigured, listMedia, getMedia, getAccount,
  downloadImage, refreshToken, tokenExpiry,
};
