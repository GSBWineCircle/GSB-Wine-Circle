// Signup lifecycle: enter, decline (by token), mark attendance, promote from waitlist.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin, requireExecTeam } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { getSettings } = require('../services/email');
const { recomputeBalance, promoteNextWaitlist } = require('../services/fees');
const {
  determineDeclineOutcome,
  isMemberBlocked,
  shouldAutoPromote,
  canManualAddToEvent,
  canRemoveFromInvited,
} = require('../services/signupLogic');

const router = express.Router();

// POST /api/signups — member: enter lottery for an event
router.post('/', requireAuth, async (req, res) => {
  const { event_id } = req.body;
  if (!event_id) return res.status(400).json({ error: 'event_id required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check member is not blocked
    const { rows: memberRows } = await client.query(
      `SELECT fee_balance, status FROM members WHERE member_id = $1 FOR UPDATE`, [req.member.member_id]
    );
    if (!memberRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Member not found' }); }
    const m = memberRows[0];

    const settings = await getSettings(client);
    if (isMemberBlocked(m)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: `You have an outstanding $${settings.flake_fee_amount || 30} flake fee. ` +
               `Pay at ${settings.assu_epay_url || '[ePay URL not configured]'} and a leader will unblock you.`,
        blocked: true,
      });
    }

    // Check event is open
    const { rows: evRows } = await client.query(
      `SELECT * FROM events WHERE event_id = $1`, [event_id]
    );
    if (!evRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }
    const event = evRows[0];
    if (event.status !== 'Open') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Signups are not open for this event.' });
    }
    // Belt-and-suspenders: the auto-close cron only ticks once a minute, so
    // without this a request could land in the gap just after the deadline.
    if (event.signup_closes_at && new Date() > new Date(event.signup_closes_at)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Signups have closed for this event.' });
    }

    // Check not already signed up
    const { rows: existing } = await client.query(
      `SELECT signup_id, status FROM signups WHERE event_id = $1 AND member_id = $2`,
      [event_id, req.member.member_id]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.json({ signup: existing[0], alreadySignedUp: true });
    }

    const signupId = 's_' + uuidv4().replace(/-/g, '');
    const declineToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const { rows } = await client.query(
      `INSERT INTO signups
         (signup_id, event_id, event_name, member_id, member_name, member_email,
          email_at_signup, status, decline_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', $8)
       RETURNING *`,
      [
        signupId, event_id, event.name,
        req.member.member_id, req.member.full_name, req.member.email,
        req.member.email, declineToken,
      ]
    );

    await client.query('COMMIT');
    return res.status(201).json({ signup: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// GET /api/signups/invitations — member: their Invited + Waitlist signups with event detail
router.get('/invitations', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.signup_id, s.event_id, s.member_visible_status AS status, s.lottery_rank,
              s.invite_sent_at, s.decline_token, s.declined_at,
              e.name AS event_name, e.event_date, e.location, e.description
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       WHERE s.member_id = $1
         AND s.member_visible_status IN ('Invited', 'Waitlist')
       ORDER BY e.event_date ASC NULLS LAST`,
      [req.member.member_id]
    );
    return res.json({ invitations: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/signups/my — member: all their signups
router.get('/my', requireAuth, async (req, res) => {
  try {
    // The join is against THIS member's own submissions only (member_id =
    // req.member.member_id), so it only ever answers "did I review this
    // event?" - it's never used to look up anyone else's, and still never
    // touches event_reviews itself.
    const { rows } = await db.query(
      `SELECT s.signup_id, s.event_id, s.member_visible_status AS status, s.lottery_rank,
              s.signed_up_at, s.invite_sent_at, s.declined_at,
              e.name AS event_name, e.event_date, e.location,
              (ers.event_id IS NOT NULL) AS reviewed
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       LEFT JOIN event_review_submissions ers
         ON ers.event_id = s.event_id AND ers.member_id = s.member_id
       WHERE s.member_id = $1
       ORDER BY s.signed_up_at DESC`,
      [req.member.member_id]
    );
    return res.json({ signups: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/signups/:id/decline — member: decline an invitation (authenticated)
router.post('/:id/decline', requireAuth, async (req, res) => {
  const signupId = req.params.id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: signupRows } = await client.query(
      `SELECT s.*, e.name AS event_name_resolved, e.event_date, e.auto_invite_enabled,
              m.email AS member_email, m.full_name AS member_full_name
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       JOIN members m ON m.member_id = s.member_id
       WHERE s.signup_id = $1
         AND s.member_id = $2
         AND s.status IN ('Invited', 'Pending')
       FOR UPDATE`,
      [signupId, req.member.member_id]
    );
    if (!signupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invite not found or already handled.' });
    }
    const s = signupRows[0];
    const settings = await getSettings(client);
    const { newStatus, feeAmount } = determineDeclineOutcome(s, settings, new Date());
    const wasInvited = s.status === 'Invited';

    // Member-caused transition — reflect it in their portal immediately,
    // there's no "surprise" to hold back since they did this themselves.
    await client.query(
      `UPDATE signups SET status = $1, member_visible_status = $1, declined_at = NOW() WHERE signup_id = $2`,
      [newStatus, s.signup_id]
    );

    if (newStatus === 'Flaked') {
      const ledgerId = 'l_' + uuidv4().replace(/-/g, '');
      await client.query(
        `INSERT INTO fee_ledger (ledger_id, member_id, event_id, event_name, type, amount, recorded_by, notes)
         VALUES ($1, $2, $3, $4, 'Charge', $5, 'system', $6)`,
        [ledgerId, s.member_id, s.event_id, s.event_name_resolved, feeAmount,
         `Late decline (flake) at event "${s.event_name_resolved}"`]
      );
      await recomputeBalance(client, s.member_id);
    }

    let promoted = null;
    if (shouldAutoPromote(s, { auto_invite_enabled: s.auto_invite_enabled })) {
      promoted = await promoteNextWaitlist(client, s.event_id);
    }

    await client.query('COMMIT');

    audit(req.member.email, 'DeclineSignup', 'signups', signupId, { status: s.status }, { status: newStatus });

    return res.json({ ok: true, status: newStatus, feeAmount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/signups/decline-by-token — public: decline via unique link in email
router.post('/decline-by-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: signupRows } = await client.query(
      `SELECT s.*, e.name AS event_name_resolved, e.event_date, e.auto_invite_enabled,
              m.email AS member_email, m.full_name AS member_full_name
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       JOIN members m ON m.member_id = s.member_id
       WHERE s.decline_token = $1
         AND s.status IN ('Invited', 'Pending')
       FOR UPDATE`,
      [token]
    );
    if (!signupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invite not found or already declined.' });
    }
    const s = signupRows[0];
    const settings = await getSettings(client);
    const { newStatus, feeAmount } = determineDeclineOutcome(s, settings, new Date());
    const wasInvited = s.status === 'Invited';

    // Member-caused transition — reflect it in their portal immediately.
    await client.query(
      `UPDATE signups SET status = $1, member_visible_status = $1, declined_at = NOW() WHERE signup_id = $2`,
      [newStatus, s.signup_id]
    );

    if (newStatus === 'Flaked') {
      // Charge fee
      const ledgerId = 'l_' + uuidv4().replace(/-/g, '');
      await client.query(
        `INSERT INTO fee_ledger (ledger_id, member_id, event_id, event_name, type, amount, recorded_by, notes)
         VALUES ($1, $2, $3, $4, 'Charge', $5, 'system', $6)`,
        [ledgerId, s.member_id, s.event_id, s.event_name_resolved, feeAmount,
         `Late decline (flake) at event "${s.event_name_resolved}"`]
      );
      await recomputeBalance(client, s.member_id);
    }

    // Auto-promote from waitlist if this was an Invited slot
    let promoted = null;
    if (shouldAutoPromote(s, { auto_invite_enabled: s.auto_invite_enabled })) {
      promoted = await promoteNextWaitlist(client, s.event_id);
    }

    await client.query('COMMIT');

    audit('system', 'DeclineSignup', 'signups', s.signup_id, { status: s.status }, { status: newStatus });

    return res.json({ ok: true, status: newStatus, promoted: !!promoted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// GET /api/signups/by-token/:token — public: get invite info for decline page
router.get('/by-token/:token', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.signup_id, s.member_visible_status AS status, s.event_id, s.event_name, s.member_name,
              e.event_date, e.location, e.description
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       WHERE s.decline_token = $1`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invite not found.' });
    return res.json({ invite: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/signups/:id/attendance — admin: mark attendance
// Checking the box moves a signup to 'Attended', remembering whatever
// status it had before (Invited or Waitlist) so that unchecking restores
// that exact prior status rather than leaving it stuck on 'Attended'.
router.post('/:id/attendance', requireAdmin, async (req, res) => {
  const { attended } = req.body;
  if (attended === undefined) return res.status(400).json({ error: 'attended required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      'SELECT * FROM signups WHERE signup_id = $1 FOR UPDATE', [req.params.id]
    );
    if (!existing.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Signup not found' }); }
    const s = existing[0];

    let newStatus, newPreStatus;
    if (attended) {
      newPreStatus = s.status === 'Attended' ? s.pre_attendance_status : s.status;
      newStatus = 'Attended';
    } else {
      newStatus = s.status === 'Attended' ? (s.pre_attendance_status || 'Invited') : s.status;
      newPreStatus = null;
    }

    const { rows } = await client.query(
      `UPDATE signups SET status = $1, pre_attendance_status = $2, attended_marked_at = NOW(), marked_by = $3
       WHERE signup_id = $4 RETURNING *`,
      [newStatus, newPreStatus, req.member.email, req.params.id]
    );
    await client.query('COMMIT');
    await audit(req.member.email, attended ? 'MarkAttended' : 'UnmarkAttended',
      'signups', req.params.id, { status: s.status }, { status: newStatus });
    return res.json({ signup: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/signups/:id/promote — admin: manually promote a waitlist member
router.post('/:id/promote', requireAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT s.*, m.email AS member_email, m.full_name AS member_name
       FROM signups s JOIN members m ON m.member_id = s.member_id
       WHERE s.signup_id = $1`,
      [req.params.id]
    );
    if (!existing.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Signup not found' }); }
    const s = existing[0];
    if (s.status !== 'Waitlist') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Signup is not on the waitlist' });
    }

    const newToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const { rows } = await client.query(
      `UPDATE signups SET status = 'Invited', decline_token = $1, invite_sent_at = NOW()
       WHERE signup_id = $2 RETURNING *`,
      [newToken, req.params.id]
    );
    await client.query('COMMIT');

    await audit(req.member.email, 'PromoteWaitlist', 'signups', req.params.id,
      { status: 'Waitlist' }, { status: 'Invited' });
    return res.json({ signup: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/signups/:id/demote — admin: manually remove a member from the
// Invited (lottery-winner) list, sending them back to Waitlist. Frees their
// slot, so the next waitlisted member is auto-promoted if the event allows it.
router.post('/:id/demote', requireAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT s.*, e.auto_invite_enabled, e.event_date
       FROM signups s JOIN events e ON e.event_id = s.event_id
       WHERE s.signup_id = $1 FOR UPDATE OF s`,
      [req.params.id]
    );
    if (!existing.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Signup not found' }); }
    const s = existing[0];
    if (s.status !== 'Invited') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Signup is not currently Invited' });
    }
    // Inside the grace window only the Exec Team may do this (non-exec admins
    // would otherwise be able to dodge the late-decline flake rule).
    const settings = await getSettings(client);
    if (!canRemoveFromInvited({ isExec: !!req.isExecTeam, eventDate: s.event_date, graceHours: settings.decline_grace_window_hours })) {
      await client.query('ROLLBACK');
      const hrs = parseInt(settings.decline_grace_window_hours) || 24;
      return res.status(403).json({ error: `Within ${hrs} hours of the event start, only the Exec Team can remove a member from Invited.` });
    }

    const { rows } = await client.query(
      `UPDATE signups SET status = 'Waitlist', decline_token = NULL, invite_sent_at = NULL
       WHERE signup_id = $1 RETURNING *`,
      [req.params.id]
    );

    let promoted = null;
    if (s.auto_invite_enabled) {
      // Exclude the signup we just moved to Waitlist - otherwise a lone
      // waitlister would immediately re-promote themselves right back.
      promoted = await promoteNextWaitlist(client, s.event_id, req.params.id);
    }

    await client.query('COMMIT');

    await audit(req.member.email, 'DemoteFromInvited', 'signups', req.params.id,
      { status: 'Invited' }, { status: 'Waitlist', promoted: promoted ? promoted.signup_id : null });
    return res.json({ signup: rows[0], promoted: !!promoted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/signups/:id/mark-dropped — Admin: mark a lottery winner as a
// clean Dropped (no fee), bypassing the normal decline-timing rule that would
// otherwise charge a late decline inside the grace window as a Flake. For
// administrative exceptions - a genuine emergency, a scheduling mistake on
// the club's end, etc. - where charging the fee wouldn't be fair, without
// having to change the grace-window setting for everyone. The outcome is
// exactly what a member's own on-time decline would produce: Dropped, no
// charge, and the next waitlisted member (if auto-invite is on) promoted.
// Exec Team can do this at any time (including inside the grace window, where
// it waives the fee); other admins only while the event is still more than the
// grace window away - where it is the same as an on-time decline anyway.
router.post('/:id/mark-dropped', requireAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT s.*, e.auto_invite_enabled, e.event_date
       FROM signups s JOIN events e ON e.event_id = s.event_id
       WHERE s.signup_id = $1 FOR UPDATE OF s`,
      [req.params.id]
    );
    if (!existing.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Signup not found' }); }
    const s = existing[0];
    if (s.status !== 'Invited') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only a currently Invited signup can be marked dropped this way.' });
    }
    const settings = await getSettings(client);
    if (!canRemoveFromInvited({ isExec: !!req.isExecTeam, eventDate: s.event_date, graceHours: settings.decline_grace_window_hours })) {
      await client.query('ROLLBACK');
      const hrs = parseInt(settings.decline_grace_window_hours) || 24;
      return res.status(403).json({ error: `Within ${hrs} hours of the event start, only the Exec Team can mark a member as dropped.` });
    }

    await client.query(
      `UPDATE signups SET status = 'Dropped', member_visible_status = 'Dropped', declined_at = NOW()
       WHERE signup_id = $1`,
      [req.params.id]
    );

    let promoted = null;
    if (s.auto_invite_enabled) {
      promoted = await promoteNextWaitlist(client, s.event_id, req.params.id);
    }

    await client.query('COMMIT');
    await audit(req.member.email, req.isExecTeam ? 'MarkDroppedByExec' : 'MarkDroppedByAdmin', 'signups', req.params.id,
      { status: 'Invited' },
      { status: 'Dropped', waivedFlakeFee: true, promoted: promoted ? promoted.signup_id : null });
    return res.json({ ok: true, promoted: !!promoted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/signups/:id/remove-from-lottery — Exec Team: take a member out of
// an event's lottery before it is run. Only a Pending signup on an event that
// hasn't been lotteried can be removed; the row is deleted (the full row is
// kept in the audit log) so it can't be drawn. Note this frees them to sign up
// again while signups are still open - close signups first if that matters.
router.post('/:id/remove-from-lottery', requireAdmin, requireExecTeam, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT s.*, e.status AS event_status
       FROM signups s JOIN events e ON e.event_id = s.event_id
       WHERE s.signup_id = $1 FOR UPDATE OF s`,
      [req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Signup not found' }); }
    const s = rows[0];
    if (s.status !== 'Pending' || !['Open', 'Closed', 'Draft'].includes(s.event_status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Members can only be removed from the lottery before it has been run.' });
    }
    await client.query('DELETE FROM signups WHERE signup_id = $1', [req.params.id]);
    await client.query('COMMIT');

    const { event_status, decline_token, ...before } = s;
    await audit(req.member.email, 'RemoveFromLottery', 'signups', req.params.id, before, null);
    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/signups/manual-add — Exec Team: manually invite a member to an
// event, bypassing the lottery entirely - including after it has already
// been run. If the member already has a signup for this event (e.g. they
// were Waitlisted, Dropped, or never got drawn), that row is turned into an
// Invite instead of creating a duplicate; otherwise a new Invited signup is
// created. Capacity is NOT enforced - exceeding it is exactly the kind of
// deliberate override this exists for - but the response flags it so the
// admin UI can warn rather than silently going over.
router.post('/manual-add', requireAdmin, requireExecTeam, async (req, res) => {
  const { event_id, member_id } = req.body;
  if (!event_id || !member_id) return res.status(400).json({ error: 'event_id and member_id are required.' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const [{ rows: evRows }, { rows: memRows }, { rows: sigRows }] = await Promise.all([
      client.query('SELECT * FROM events WHERE event_id = $1 FOR UPDATE', [event_id]),
      client.query('SELECT * FROM members WHERE member_id = $1', [member_id]),
      client.query('SELECT * FROM signups WHERE event_id = $1 AND member_id = $2 FOR UPDATE', [event_id, member_id]),
    ]);
    const event = evRows[0] || null;
    const member = memRows[0] || null;
    const existing = sigRows[0] || null;

    const check = canManualAddToEvent(event, member, existing);
    if (!check.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: check.error }); }

    const declineToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    let signup;
    if (existing) {
      const { rows } = await client.query(
        `UPDATE signups SET
           status = 'Invited', member_visible_status = 'Invited',
           decline_token = $1, invite_sent_at = NOW(), declined_at = NULL,
           member_name = $2, member_email = $3
         WHERE signup_id = $4 RETURNING *`,
        [declineToken, member.full_name, member.email, existing.signup_id]
      );
      signup = rows[0];
    } else {
      const signupId = 's_' + uuidv4().replace(/-/g, '');
      const { rows } = await client.query(
        `INSERT INTO signups
           (signup_id, event_id, event_name, member_id, member_name, member_email,
            email_at_signup, status, member_visible_status, decline_token, invite_sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'Invited', 'Invited', $7, NOW())
         RETURNING *`,
        [signupId, event_id, event.name, member_id, member.full_name, member.email, declineToken]
      );
      signup = rows[0];
    }

    const { rows: countRows } = await client.query(
      `SELECT count(*)::int AS n FROM signups WHERE event_id = $1 AND status = 'Invited'`, [event_id]
    );
    const capacityExceeded = parseInt(event.capacity) > 0 && countRows[0].n > parseInt(event.capacity);

    await client.query('COMMIT');

    await audit(req.member.email, 'ManualAddToEvent', 'signups', signup.signup_id,
      existing ? { status: existing.status } : null, { status: 'Invited', member_id, event_id });
    return res.status(existing ? 200 : 201).json({ signup, capacityExceeded });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

module.exports = router;
