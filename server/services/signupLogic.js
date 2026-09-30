/**
 * Pure business-logic helpers — no database or IO dependencies.
 * Used by route handlers AND unit tests so both exercise the same code.
 */

'use strict';

/**
 * Compute a member's outstanding fee balance from raw ledger rows.
 * @param {Array<{type: string, amount: string|number}>} ledgerRows
 * @returns {number}  balance (never negative)
 */
function computeBalance(ledgerRows) {
  let bal = 0;
  for (const r of ledgerRows) {
    const amt = Math.abs(parseFloat(r.amount)) || 0;
    const t = (r.type || '').toLowerCase();
    if (t === 'charge') bal += amt;
    else if (t === 'payment' || t === 'waiver') bal -= amt;
  }
  return bal < 0 ? 0 : bal;
}

/**
 * Decide whether a decline is a flake (late) or a clean drop.
 *
 * @param {object} signup          — must have .status and .event_date
 * @param {object} settings        — must have .decline_grace_window_hours and .flake_fee_amount
 * @param {Date}   now             — current time (injected for testability)
 * @returns {{ newStatus: 'Flaked'|'Dropped', feeAmount: number, isLate: boolean }}
 */
function determineDeclineOutcome(signup, settings, now) {
  const graceHours = parseInt(settings.decline_grace_window_hours) || 24;
  const feeAmount  = parseFloat(settings.flake_fee_amount) || 30;

  const eventDate = signup.event_date ? new Date(signup.event_date) : null;
  const isLate    = !!eventDate && (eventDate - now) < graceHours * 60 * 60 * 1000;
  const wasInvited = signup.status === 'Invited';

  const newStatus = (wasInvited && isLate) ? 'Flaked' : 'Dropped';
  return { newStatus, feeAmount, isLate };
}

/**
 * Assign lottery ranks and statuses to a list of pending signups.
 *
 * @param {Array<{signup_id: string}>} pendingSignups — already shuffled or in desired order
 * @param {number} capacity
 * @returns {Array<{signup_id: string, lottery_rank: number, newStatus: 'Invited'|'Waitlist'}>}
 */
function assignLotteryResults(pendingSignups, capacity) {
  return pendingSignups.map((s, i) => ({
    signup_id:    s.signup_id,
    lottery_rank: i + 1,
    newStatus:    i < capacity ? 'Invited' : 'Waitlist',
  }));
}

/**
 * Same as assignLotteryResults, except every priority=true entrant is
 * guaranteed Invited (Admins and Exec Team always win), and only the
 * remaining capacity is drawn at random from everyone else. Priority
 * entrants still get a random relative rank among themselves - they
 * aren't ranked ahead by being first in the input, only by never landing
 * on the waitlist.
 *
 * If priority entrants alone outnumber capacity, they are ALL still
 * Invited (capacity is exceeded rather than waitlisting an Admin/Exec
 * member) - "always wins" is treated as an absolute guarantee, not one
 * bounded by capacity. With ~12 Admin/Exec members against typical 30-60
 * capacities this should not occur in practice, but is handled rather
 * than assumed away.
 *
 * @param {Array<{signup_id: string, priority: boolean}>} pendingSignups — already shuffled or in desired order
 * @param {number} capacity
 * @returns {Array<{signup_id: string, lottery_rank: number, newStatus: 'Invited'|'Waitlist'}>}
 */
function assignLotteryResultsWithPriority(pendingSignups, capacity) {
  const priority = pendingSignups.filter(s => s.priority);
  const rest = pendingSignups.filter(s => !s.priority);
  const remainingCapacity = Math.max(0, capacity - priority.length);

  const priorityResults = priority.map((s, i) => ({
    signup_id: s.signup_id, lottery_rank: i + 1, newStatus: 'Invited',
  }));
  const restResults = assignLotteryResults(rest, remainingCapacity)
    .map(r => ({ ...r, lottery_rank: r.lottery_rank + priority.length }));

  return [...priorityResults, ...restResults];
}

/**
 * Decide whether a decline should trigger auto-promotion from the waitlist.
 * Only an Invited member vacating their slot on an auto_invite_enabled event
 * opens a slot for promotion.
 *
 * @param {{ status: string }}        signup
 * @param {{ auto_invite_enabled: * }} event
 * @returns {boolean}
 */
function shouldAutoPromote(signup, event) {
  return signup.status === 'Invited' && !!event.auto_invite_enabled;
}

/**
 * Classify signups for finalization:
 *   - Invited → will be Flaked (fee charged)
 *   - Waitlist → will be marked Lost
 *
 * Pure: does not mutate input or touch the database.
 *
 * @param {Array<{signup_id: string, status: string}>} signups
 * @returns {{ toFlake: Array, toLose: Array }}
 */
function classifyFinalizeSignups(signups) {
  return {
    toFlake: signups.filter(s => s.status === 'Invited'),
    toLose:  signups.filter(s => s.status === 'Waitlist'),
  };
}

/**
 * Given current member state, decide whether they are blocked from entering lottery.
 *
 * @param {{ fee_balance: string|number, status: string }} member
 * @returns {boolean}
 */
function isMemberBlocked(member) {
  return parseFloat(member.fee_balance) > 0 || member.status === 'Blocked';
}

// Events in these statuses have already happened or won't happen at all, so
// there is no "invite" left to manually add someone to.
const NOT_MANUAL_ADDABLE_EVENT_STATUSES = ['Completed', 'Cancelled'];

/**
 * Decide whether an Exec Team member may manually add `member` to `event`
 * as an Invited guest — bypassing the lottery, even after it has already
 * been run. Pure: takes plain rows, makes no DB calls.
 *
 * @param {object|null} event           — must have .status
 * @param {object|null} member          — must have .fee_balance, .status
 * @param {object|null} existingSignup  — this member's current signup for
 *   the event, if any; must have .status
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function canManualAddToEvent(event, member, existingSignup) {
  if (!event) return { ok: false, error: 'Event not found.' };
  if (NOT_MANUAL_ADDABLE_EVENT_STATUSES.includes(event.status)) {
    return { ok: false, error: `This event is ${event.status.toLowerCase()} and can no longer take new invites.` };
  }
  if (!member) return { ok: false, error: 'Member not found.' };
  if (isMemberBlocked(member)) {
    return { ok: false, error: 'This member has an outstanding flake fee and is blocked from joining events.' };
  }
  if (existingSignup?.status === 'Invited') {
    return { ok: false, error: 'This member is already invited to this event.' };
  }
  if (existingSignup?.status === 'Attended') {
    return { ok: false, error: 'This member already attended this event.' };
  }
  return { ok: true };
}

// ── Birth-year verification (birthday tastings) ─────────────────────────────

/**
 * Validate a member-submitted birth date string ('YYYY-MM-DD'): a real
 * calendar date, not in the future, and not absurdly old.
 * @param {string} value
 * @returns {boolean}
 */
function isValidBirthDateInput(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1900) return false;
  const asUTC = new Date(Date.UTC(y, m - 1, d));
  // Catches both malformed calendar dates (e.g. month 13, Feb 30) and the
  // Date constructor's own overflow rollover (e.g. day 32 -> next month).
  if (asUTC.getUTCFullYear() !== y || asUTC.getUTCMonth() !== m - 1 || asUTC.getUTCDate() !== d) return false;
  return asUTC.getTime() <= Date.now();
}

/**
 * Validate a birth-year priority value for an event: a plausible birth year,
 * not in the future.
 * @param {number|string} value
 * @returns {boolean}
 */
function isValidBirthYear(value) {
  const y = Number(value);
  return Number.isInteger(y) && y >= 1900 && y <= new Date().getUTCFullYear();
}

/**
 * The calendar year of a 'YYYY-MM-DD' birth date string, or null.
 * @param {string|null} birthDate
 * @returns {number|null}
 */
function extractBirthYear(birthDate) {
  const m = typeof birthDate === 'string' ? /^(\d{4})-\d{2}-\d{2}$/.exec(birthDate) : null;
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Whether a member qualifies for an event's birth-year lottery priority.
 * Requires BOTH a matching birth year AND an ID photo on file - a
 * self-reported date alone isn't "confirmation". No targetYear (event opts
 * out) always returns false.
 *
 * @param {{birth_date: string|null, has_id_photo: boolean}} member
 * @param {number|null} targetYear
 * @returns {boolean}
 */
function hasBirthYearPriority(member, targetYear) {
  if (!targetYear || !member || !member.has_id_photo) return false;
  return extractBirthYear(member.birth_date) === targetYear;
}

module.exports = {
  computeBalance,
  determineDeclineOutcome,
  assignLotteryResults,
  assignLotteryResultsWithPriority,
  shouldAutoPromote,
  classifyFinalizeSignups,
  isMemberBlocked,
  canManualAddToEvent,
  isValidBirthDateInput,
  isValidBirthYear,
  extractBirthYear,
  hasBirthYearPriority,
};
