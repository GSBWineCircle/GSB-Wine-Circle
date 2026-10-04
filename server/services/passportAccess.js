/**
 * Who can see the member-facing Passport. While it's being polished only the
 * emails in PASSPORT_ALLOWED_EMAILS (comma-separated; default: the built-in
 * list below) get it. Set the env var to "*" on Render to open it to everyone.
 * The admin wine-list editor is unaffected - it is admin-only anyway.
 */

'use strict';

const DEFAULT_ALLOWED = 'rdighe@stanford.edu,rutingl@stanford.edu';

function allowedList(env = process.env.PASSPORT_ALLOWED_EMAILS) {
  return String(env == null || env === '' ? DEFAULT_ALLOWED : env)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** @param {string} email @param {string} [env] override for tests */
function isPassportEnabledFor(email, env) {
  const list = allowedList(env);
  if (list.includes('*')) return true;
  return !!email && list.includes(String(email).trim().toLowerCase());
}

module.exports = { isPassportEnabledFor, allowedList, DEFAULT_ALLOWED };
