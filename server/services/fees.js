// Shared fee-balance and waitlist-promotion helpers used by signups/events/fees routes.
// Consolidated from three near-duplicate copies (see task-plans/13-fee-balance-deduplication.md).
const { v4: uuidv4 } = require('uuid');
const { computeBalance, pickWaitlistUnit } = require('./signupLogic');

/**
 * Recompute a member's fee_balance from their fee_ledger and set their
 * Blocked/Active status accordingly. Never overrides an Inactive status.
 */
async function recomputeBalance(client, memberId) {
  const { rows } = await client.query(
    `SELECT type, amount FROM fee_ledger WHERE member_id = $1`, [memberId]
  );
  const bal = computeBalance(rows);
  const newStatus = bal > 0 ? 'Blocked' : 'Active';
  await client.query(
    `UPDATE members SET fee_balance = $1, status = CASE WHEN status = 'Inactive' THEN status ELSE $2 END
     WHERE member_id = $3`,
    [bal, newStatus, memberId]
  );
  return bal;
}

/**
 * Promote the next Waitlist signup (by lottery_rank) for an event to Invited,
 * issuing a fresh decline token. Returns the promoted signup row, or null if
 * the waitlist is empty. Caller is responsible for sending the promotion email.
 *
 * @param {string} [excludeSignupId] - skip this signup even if it's on the
 *   Waitlist. Needed when a signup was just moved TO Waitlist in the same
 *   transaction (e.g. admin demoting an Invited member) - otherwise a lone
 *   waitlister would immediately "promote" themselves right back.
 */
async function promoteNextWaitlist(client, eventId, excludeSignupId) {
  const { rows: waitlist } = await client.query(
    `SELECT s2.signup_id, s2.linked_signup_id, s2.member_id, s2.lottery_rank, m.email AS member_email, m.full_name AS member_name
     FROM signups s2
     JOIN members m ON m.member_id = s2.member_id
     WHERE s2.event_id = $1 AND s2.status = 'Waitlist'
     ORDER BY s2.lottery_rank ASC
     FOR UPDATE OF s2`,
    [eventId]
  );
  if (!waitlist.length) return null;

  // Seats still free, needed only to decide whether a LINKED PAIR at the head of the
  // waitlist fits (solo entries are promoted without a seat check, as always).
  const { rows: cap } = await client.query(
    `SELECT e.capacity,
            (SELECT COUNT(*) FROM signups x WHERE x.event_id = e.event_id AND x.status IN ('Invited', 'Attended')) AS taken
     FROM events e WHERE e.event_id = $1`, [eventId]
  );
  const freeSeats = cap.length ? (parseInt(cap[0].capacity) || 0) - parseInt(cap[0].taken) : 0;

  const ids = pickWaitlistUnit(waitlist, freeSeats, excludeSignupId);
  if (!ids.length) return null;

  const promotedRows = [];
  for (const id of ids) {
    const row = waitlist.find(w => w.signup_id === id);
    const newDeclineToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    await client.query(
      `UPDATE signups SET status = 'Invited', decline_token = $1, invite_sent_at = NOW()
       WHERE signup_id = $2`,
      [newDeclineToken, id]
    );
    promotedRows.push({ ...row, newDeclineToken });
  }
  // First one is the main result (as before); a linked partner promoted with them rides along.
  return { ...promotedRows[0], partnerPromoted: promotedRows[1] || null };
}

module.exports = { recomputeBalance, promoteNextWaitlist };
