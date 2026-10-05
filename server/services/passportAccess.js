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

const VISIBILITIES = ['hidden', 'start', 'after'];
const DEFAULT_VISIBILITY = 'after';

/**
 * Whether an event shows in a member's passport.
 *  - hidden: never.
 *  - after (default): once attendance has been recorded (status Attended).
 *  - start: from the moment the event begins, for confirmed attendees
 *    (Invited), and of course once Attended.
 * @param {string} visibility
 * @param {string} signupStatus the member's internal signup status
 * @param {*} eventDate
 * @param {Date} [now]
 */
function isEventVisibleInPassport(visibility, signupStatus, eventDate, now = new Date()) {
  const v = VISIBILITIES.includes(visibility) ? visibility : DEFAULT_VISIBILITY;
  if (v === 'hidden') return false;
  if (signupStatus === 'Attended') return true;
  if (v === 'start' && signupStatus === 'Invited' && eventDate) {
    const d = new Date(eventDate);
    return !isNaN(d.getTime()) && d.getTime() <= now.getTime();
  }
  return false;
}

module.exports = { VISIBILITIES, DEFAULT_VISIBILITY, isEventVisibleInPassport, isPassportEnabledFor, allowedList, DEFAULT_ALLOWED };
