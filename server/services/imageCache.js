/**
 * Small in-process cache for images served out of Postgres (welcome photos,
 * wine bottles). Without it every browser request read the whole image out of
 * the database again - counted as database egress. One instance serves the app,
 * so entries are dropped explicitly when an image changes, with a TTL as a
 * safety net.
 */

'use strict';

class ImageCache {
  constructor({ maxBytes = 24 * 1024 * 1024, ttlMs = 60 * 60 * 1000 } = {}) {
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.bytes = 0;
    this.map = new Map(); // key -> {buf, type, at}; Map order = LRU order
  }

  get(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e) return null;
    if (now - e.at > this.ttlMs) { this.del(key); return null; }
    this.map.delete(key); this.map.set(key, e); // mark most recently used
    return e;
  }

  set(key, buf, type, now = Date.now()) {
    if (!Buffer.isBuffer(buf) || buf.length > this.maxBytes / 2) return; // never cache one huge image
    this.del(key);
    this.map.set(key, { buf, type, at: now });
    this.bytes += buf.length;
    while (this.bytes > this.maxBytes && this.map.size) {
      this.del(this.map.keys().next().value); // evict least recently used
    }
  }

  del(key) {
    const e = this.map.get(key);
    if (e) { this.bytes -= e.buf.length; this.map.delete(key); }
  }

  /** Drop every entry whose key starts with `prefix` (or everything). */
  clear(prefix = '') {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.del(k);
  }
}

// One shared cache for all image routes; keys are namespaced ("wp:", "wine:").
const images = new ImageCache();

module.exports = { ImageCache, images };
