// Anonymous event reviews: members who attended rate 1-5 and may leave a
// comment; the review itself carries no member_id (see schema.sql). Admins
// see aggregate stats and the raw comments, never who wrote them.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { isValidRating, sanitizeComment, buildReviewStats } = require('../services/reviews');

const router = express.Router();

// POST /api/reviews — member: submit an anonymous review for an event they attended
router.post('/', requireAuth, async (req, res) => {
  const { event_id, rating, comment } = req.body;
  if (!event_id) return res.status(400).json({ error: 'event_id required' });
  if (!isValidRating(rating)) return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: attended } = await client.query(
      `SELECT 1 FROM signups WHERE event_id = $1 AND member_id = $2 AND status = 'Attended'`,
      [event_id, req.member.member_id]
    );
    if (!attended.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only review events you attended.' });
    }

    // Write the dedup marker FIRST - its primary key (event_id, member_id)
    // conflicting means "already reviewed", and only on success do we write
    // the review itself, so a double-click or race can never produce two
    // reviews for one attendance.
    try {
      await client.query(
        `INSERT INTO event_review_submissions (event_id, member_id) VALUES ($1, $2)`,
        [event_id, req.member.member_id]
      );
    } catch (e) {
      if (e.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: "You've already reviewed this event." });
      }
      throw e;
    }

    const reviewId = 'rev_' + uuidv4().replace(/-/g, '');
    await client.query(
      `INSERT INTO event_reviews (review_id, event_id, rating, comment) VALUES ($1, $2, $3, $4)`,
      [reviewId, event_id, rating, sanitizeComment(comment)]
    );

    await client.query('COMMIT');
    // Deliberately no audit() call here - audit log entries are attributed to
    // an actor, and attributing an "anonymous" review would defeat the point.
    return res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// GET /api/reviews/dashboard — admin: aggregate stats plus the raw (still
// anonymous) review list, for the admin Reviews page. Returns everything;
// the page filters by event client-side the same way Analytics does.
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const [{ rows: events }, { rows: reviews }] = await Promise.all([
      db.query(`SELECT event_id, name, event_date FROM events ORDER BY event_date DESC NULLS LAST`),
      db.query(`SELECT event_id, rating, comment, created_at FROM event_reviews ORDER BY created_at DESC`),
    ]);

    const byEvent = {};
    reviews.forEach(r => { (byEvent[r.event_id] = byEvent[r.event_id] || []).push(r); });

    // Only events that actually have at least one review, so the dashboard
    // isn't dominated by a long list of zeroes.
    const eventsWithStats = events
      .filter(e => byEvent[e.event_id])
      .map(e => ({ event_id: e.event_id, name: e.name, event_date: e.event_date, ...buildReviewStats(byEvent[e.event_id]) }));

    return res.json({ overall: buildReviewStats(reviews), events: eventsWithStats, reviews });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
