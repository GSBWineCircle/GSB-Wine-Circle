/**
 * Shrink images before they are stored in (and later served out of) Postgres.
 * Welcome-screen backgrounds and wine bottle photos are only ever shown at
 * screen size, but were stored as full-size originals (often 1 MB+), which both
 * cost database egress whenever the in-memory cache refilled and made the login
 * screen heavy on phones. Re-encoded as WebP, capped at 1600 px on the long edge,
 * they are typically 5-10x smaller with no visible difference.
 */

'use strict';

const sharp = require('sharp');

const MAX_DIM = 1600;
const QUALITY = 78;
// Anything already smaller than this isn't worth re-encoding.
const SKIP_BELOW_BYTES = 150 * 1024;

/**
 * @param {Buffer} buffer original image bytes
 * @param {{maxDim?: number, quality?: number, force?: boolean}} [opts]
 * @returns {Promise<{buffer: Buffer, contentType: string, changed: boolean}>}
 *   Always resolves: on any failure (or if the result isn't smaller) the original comes back untouched.
 */
async function optimizeImage(buffer, opts = {}) {
  const original = { buffer, contentType: null, changed: false };
  try {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return original;
    if (!opts.force && buffer.length < SKIP_BELOW_BYTES) return original;
    const maxDim = opts.maxDim || MAX_DIM;
    // Already optimised (WebP within the size cap)? Leave it: re-encoding a lossy image every
    // time it is read would slowly degrade it for no benefit.
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    if (meta.format === 'webp' && meta.width <= maxDim && meta.height <= maxDim) return original;
    const out = await sharp(buffer, { failOn: 'none' })
      .rotate() // honour the EXIF orientation, then drop the metadata
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: opts.quality || QUALITY })
      .toBuffer();
    if (out.length >= buffer.length) return original;
    return { buffer: out, contentType: 'image/webp', changed: true };
  } catch (err) {
    console.error('Image optimize failed, keeping original:', err.message);
    return original;
  }
}

module.exports = { optimizeImage, MAX_DIM, QUALITY, SKIP_BELOW_BYTES };
