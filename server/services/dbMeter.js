/**
 * Approximate database egress metering, per endpoint.
 *
 * Supabase bills the bytes that leave the database. This hooks the single
 * choke point every query goes through (pg's Client.prototype.query) and adds up
 * an estimate of the bytes in each result, labelled by the HTTP route that
 * caused it (via AsyncLocalStorage) or "background" for cron jobs. Counters live in
 * memory (reset on restart/deploy) and a top-N summary is logged hourly, so
 * "which endpoint costs the most egress?" has a real answer instead of a guess.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const stats = new Map();      // label -> {calls, rows, bytes}
const startedAt = new Date();
let installed = false;

/** Rough size in bytes of one result row as it travels over the wire. */
function rowBytes(row) {
  let n = 7; // row header
  for (const k in row) {
    const v = row[k];
    n += 4; // per-field length prefix
    if (v === null || v === undefined) continue;
    if (Buffer.isBuffer(v)) n += v.length;
    else if (typeof v === 'string') n += v.length;
    else if (typeof v === 'number') n += 8;
    else if (typeof v === 'boolean') n += 1;
    else if (v instanceof Date) n += 8;
    else n += JSON.stringify(v).length; // json/jsonb, arrays
  }
  return n;
}

function labelFor() {
  const store = als.getStore();
  if (!store) return 'background (cron/startup)';
  const req = store.req;
  // Queries run before routing (the per-request session lookup) have no matched route yet.
  if (!req.route) return 'session lookup (every signed-in request)';
  const route = req.route.path || '';
  return `${req.method} ${req.baseUrl || ''}${route === '/' ? '' : route}` || `${req.method} ${req.path}`;
}

function record(result, label) {
  if (!result || !Array.isArray(result.rows)) return;
  const key = label || labelFor();
  let s = stats.get(key);
  if (!s) { s = { calls: 0, rows: 0, bytes: 0 }; stats.set(key, s); }
  s.calls++;
  s.rows += result.rows.length;
  for (const r of result.rows) s.bytes += rowBytes(r);
}

/**
 * Meter a pg Pool. The label (which endpoint is asking) is captured at the moment the app
 * calls pool.query() / pool.connect(), where the request context is still correct - pg's
 * internal connection queue would lose it. pool.query()'s own internal use of the pool is
 * left alone, so nothing is counted twice.
 */
function wrapPool(pool) {
  const rawQuery = pool.query.bind(pool);
  pool.query = function (text, values, cb) {
    if (typeof values === 'function') { cb = values; values = undefined; }
    const label = labelFor();
    const p = rawQuery(text, values).then(r => { try { record(r, label); } catch (_) { /* never break a query */ } return r; });
    if (cb) { p.then(r => cb(null, r), cb); return undefined; }
    return p;
  };

  const rawConnect = pool.connect.bind(pool);
  pool.connect = async function (...a) {
    if (typeof a[0] === 'function') return rawConnect(...a); // pg-pool's own internal use
    const label = labelFor();
    const client = await rawConnect();
    if (!client.__metered) {
      const q = client.query.bind(client);
      client.query = function (...args) {
        const r = q(...args);
        if (r && typeof r.then === 'function') {
          return r.then(x => { try { record(x, client.__label); } catch (_) { /* ignore */ } return x; });
        }
        return r;
      };
      client.__metered = true;
    }
    client.__label = label; // clients are reused across requests: relabel at every checkout
    return client;
  };
  return pool;
}

/** Express middleware: tags everything the request does with its route. */
function middleware(req, res, next) { als.run({ req }, next); }

function snapshot() {
  const rows = [...stats.entries()].map(([endpoint, s]) => ({
    endpoint, calls: s.calls, rows: s.rows, bytes: s.bytes,
    avg_bytes_per_call: s.calls ? Math.round(s.bytes / s.calls) : 0,
  })).sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  return { since: startedAt.toISOString(), total_bytes: total, endpoints: rows };
}

const fmt = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';

/** One-line-per-endpoint log of the heaviest endpoints, for Render's logs. */
function logTop(n = 8) {
  const snap = snapshot();
  if (!snap.endpoints.length) return;
  console.log(`[db-egress] since ${snap.since}: ${fmt(snap.total_bytes)} total`);
  snap.endpoints.slice(0, n).forEach(r =>
    console.log(`[db-egress]   ${fmt(r.bytes).padStart(9)}  ${String(r.calls).padStart(6)} calls  ${fmt(r.avg_bytes_per_call).padStart(8)}/call  ${r.endpoint}`));
}

function reset() { stats.clear(); }

module.exports = { wrapPool, middleware, snapshot, logTop, reset, rowBytes, fmt };
