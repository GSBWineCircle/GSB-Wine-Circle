// Wine Circle Passport: admins enter an event's wine list on the event page;
// members who attended see the event (stamp, blurb, wines) in their passport
// and keep their own ratings, notes and tags per wine.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { buildStamp, abridgeDescription } = require('../services/passportStamp');
const { researchWine, findBottleImage } = require('../services/wineResearch');
const { normalizeTag, ruleBasedSuggestions } = require('../services/wineTags');
const {
  MAX_WINES_PER_EVENT, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES,
  sanitizeWine, researchKey, sanitizeNoteInput, isEmptyNote,
} = require('../services/passportWines');

const adminRouter = express.Router();   // mounted at /api/passport/admin
const memberRouter = express.Router();  // mounted at /api/passport
const imageRouter = express.Router();   // mounted at /api/passport-images (public, like welcome photos)

const WINE_COLS = `wine_id, event_id, position, name, producer, vintage, region, country, grape, style,
                   suggested_tags, tags_source, (image IS NOT NULL) AS has_image, image_source,
                   EXTRACT(EPOCH FROM updated_at)::bigint AS v`;

const wineOut = w => ({
  wine_id: w.wine_id, position: w.position, name: w.name, producer: w.producer, vintage: w.vintage,
  region: w.region, country: w.country, grape: w.grape, style: w.style,
  suggested_tags: w.suggested_tags, tags_source: w.tags_source,
  image_url: w.has_image ? `/api/passport-images/${w.wine_id}?v=${w.v}` : null,
  image_source: w.image_source,
});

// Research one wine (tags, and a bottle image if it has none) and save it.
// Never throws: research is a nicety and must not take the request down.
async function enrichWine(wineId) {
  try {
    const { rows } = await db.query(
      `SELECT *, (image IS NOT NULL) AS has_image FROM event_wines WHERE wine_id = $1`, [wineId]);
    if (!rows.length) return;
    const w = rows[0];
    const { style, tags, source } = await researchWine(w);
    await db.query(
      `UPDATE event_wines SET style = $2, suggested_tags = $3::jsonb, tags_source = $4, updated_at = NOW() WHERE wine_id = $1`,
      [wineId, style, JSON.stringify(tags), source]);
    // Only look for a bottle image when there is none (never replaces an admin upload).
    if (!w.has_image) {
      const img = await findBottleImage(w);
      if (img) {
        await db.query(
          `UPDATE event_wines SET image = $2, image_content_type = $3, image_source = $4, updated_at = NOW()
           WHERE wine_id = $1 AND image IS NULL`,
          [wineId, img.buffer, img.contentType, 'auto:' + img.source]);
      }
    }
  } catch (err) {
    console.error('enrichWine failed:', err.message);
  }
}

// Sequential, so one admin save never fires dozens of simultaneous API calls.
function enrichInBackground(ids) {
  setImmediate(async () => { for (const id of ids) await enrichWine(id); });
}

async function listEventWines(eventId) {
  const { rows } = await db.query(
    `SELECT ${WINE_COLS} FROM event_wines WHERE event_id = $1 ORDER BY position, created_at`, [eventId]);
  return rows;
}

// ── Admin ────────────────────────────────────────────────────────────────────

// GET /api/passport/admin/events/:eventId/wines — wine list + moderation view of shared tags
adminRouter.get('/events/:eventId/wines', requireAdmin, async (req, res) => {
  try {
    const wines = await listEventWines(req.params.eventId);
    const ids = wines.map(w => w.wine_id);
    const shared = ids.length ? await sharedTagCounts(ids, true) : {};
    res.json({
      wines: wines.map(w => ({ ...wineOut(w), shared_tags: shared[w.wine_id] || [] })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT /api/passport/admin/events/:eventId/wines — replace the list (ordered).
// Wines omitted from the list are deleted along with members' notes on them.
adminRouter.put('/events/:eventId/wines', requireAdmin, async (req, res) => {
  const raw = req.body && req.body.wines;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'wines array required' });
  if (raw.length > MAX_WINES_PER_EVENT) return res.status(400).json({ error: `At most ${MAX_WINES_PER_EVENT} wines per event.` });
  const clean = [];
  for (const r of raw) {
    const s = sanitizeWine(r);
    if (!s.ok) return res.status(400).json({ error: s.error });
    clean.push(s.wine);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: ev } = await client.query('SELECT event_id FROM events WHERE event_id = $1 FOR UPDATE', [req.params.eventId]);
    if (!ev.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }

    const { rows: existing } = await client.query('SELECT * FROM event_wines WHERE event_id = $1', [req.params.eventId]);
    const byId = new Map(existing.map(w => [w.wine_id, w]));
    const keep = new Set();
    const toEnrich = [];

    for (let i = 0; i < clean.length; i++) {
      const w = clean[i];
      const prev = w.wine_id && byId.get(w.wine_id);
      if (prev) {
        keep.add(w.wine_id);
        const changed = researchKey(prev) !== researchKey(w);
        await client.query(
          `UPDATE event_wines SET position=$2, name=$3, producer=$4, vintage=$5, region=$6, country=$7, grape=$8, style=$9, updated_at=NOW()
           WHERE wine_id=$1`,
          [w.wine_id, i, w.name, w.producer, w.vintage, w.region, w.country, w.grape, w.style]);
        if (changed) toEnrich.push(w.wine_id);
      } else {
        const id = 'wine_' + uuidv4().replace(/-/g, '');
        keep.add(id);
        await client.query(
          `INSERT INTO event_wines (wine_id, event_id, position, name, producer, vintage, region, country, grape, style, suggested_tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [id, req.params.eventId, i, w.name, w.producer, w.vintage, w.region, w.country, w.grape, w.style,
           JSON.stringify(ruleBasedSuggestions(w))]);
        toEnrich.push(id);
      }
    }
    const drop = existing.filter(w => !keep.has(w.wine_id)).map(w => w.wine_id);
    if (drop.length) await client.query('DELETE FROM event_wines WHERE wine_id = ANY($1)', [drop]);
    await client.query('COMMIT');

    await audit(req.member.email, 'passport_wines_saved', 'event_wines', req.params.eventId,
                { count: existing.length }, { count: clean.length, removed: drop.length });
    enrichInBackground(toEnrich);
    const wines = await listEventWines(req.params.eventId);
    res.json({ wines: wines.map(wineOut), researching: toEnrich.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/passport/admin/wines/:wineId/research — re-run research now
adminRouter.post('/wines/:wineId/research', requireAdmin, async (req, res) => {
  try {
    await enrichWine(req.params.wineId);
    const { rows } = await db.query(`SELECT ${WINE_COLS} FROM event_wines WHERE wine_id = $1`, [req.params.wineId]);
    if (!rows.length) return res.status(404).json({ error: 'Wine not found' });
    res.json({ wine: wineOut(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT /api/passport/admin/wines/:wineId/image — upload a bottle photo, or null to remove it
adminRouter.put('/wines/:wineId/image', requireAdmin, async (req, res) => {
  const { image_base64, content_type } = req.body || {};
  try {
    if (image_base64 === null) {
      const r = await db.query(
        `UPDATE event_wines SET image=NULL, image_content_type=NULL, image_source='', updated_at=NOW() WHERE wine_id=$1`,
        [req.params.wineId]);
      return r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Wine not found' });
    }
    if (!ALLOWED_IMAGE_TYPES.includes(content_type)) return res.status(400).json({ error: 'Photo must be a JPEG, PNG or WebP.' });
    const buf = Buffer.from(String(image_base64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Invalid photo data.' });
    if (buf.length > MAX_IMAGE_BYTES) return res.status(400).json({ error: 'Photo is too large (4 MB max).' });
    const r = await db.query(
      `UPDATE event_wines SET image=$2, image_content_type=$3, image_source='upload', updated_at=NOW() WHERE wine_id=$1`,
      [req.params.wineId, buf, content_type]);
    if (!r.rowCount) return res.status(404).json({ error: 'Wine not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT /api/passport/admin/wines/:wineId/hidden-tags — hide/unhide a member-shared tag
adminRouter.put('/wines/:wineId/hidden-tags', requireAdmin, async (req, res) => {
  const tag = normalizeTag((req.body || {}).tag);
  if (!tag) return res.status(400).json({ error: 'Invalid tag.' });
  try {
    if (req.body.hidden === false) {
      await db.query('DELETE FROM wine_hidden_tags WHERE wine_id=$1 AND tag=$2', [req.params.wineId, tag]);
    } else {
      const { rows } = await db.query('SELECT 1 FROM event_wines WHERE wine_id=$1', [req.params.wineId]);
      if (!rows.length) return res.status(404).json({ error: 'Wine not found' });
      await db.query('INSERT INTO wine_hidden_tags (wine_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.wineId, tag]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Public image (unguessable id; same model as welcome photos) ─────────────
imageRouter.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT image, image_content_type FROM event_wines WHERE wine_id=$1', [req.params.id]);
    if (!rows.length || !rows[0].image) return res.status(404).end();
    res.set('Content-Type', rows[0].image_content_type || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(rows[0].image);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ── Members ──────────────────────────────────────────────────────────────────

// Tag -> count across members who chose to share, per wine. Anonymous: no
// member ids ever leave this function. Admin view includes hidden tags.
async function sharedTagCounts(wineIds, includeHidden, excludeMemberId) {
  const { rows } = await db.query(
    `SELECT n.wine_id, t.tag, COUNT(*)::int AS count,
            EXISTS (SELECT 1 FROM wine_hidden_tags h WHERE h.wine_id = n.wine_id AND h.tag = t.tag) AS hidden
     FROM member_wine_notes n
     CROSS JOIN LATERAL jsonb_array_elements_text(n.tags) AS t(tag)
     WHERE n.share_tags = TRUE AND n.wine_id = ANY($1)
       AND ($2::text IS NULL OR n.member_id <> $2)
     GROUP BY n.wine_id, t.tag
     ORDER BY count DESC, t.tag`,
    [wineIds, excludeMemberId || null]);
  const out = {};
  for (const r of rows) {
    if (r.hidden && !includeHidden) continue;
    (out[r.wine_id] = out[r.wine_id] || []).push(includeHidden ? { tag: r.tag, count: r.count, hidden: r.hidden } : { tag: r.tag, count: r.count });
  }
  return out;
}

// GET /api/passport — the caller's passport: events they attended + their notes
memberRouter.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: events } = await db.query(
      `SELECT e.event_id, e.name, e.event_date, e.location, e.description
       FROM events e JOIN signups s ON s.event_id = e.event_id
       WHERE s.member_id = $1 AND s.status = 'Attended'
       ORDER BY e.event_date DESC NULLS LAST`, [req.member.member_id]);
    const eventIds = events.map(e => e.event_id);
    const { rows: wines } = eventIds.length ? await db.query(
      `SELECT ${WINE_COLS} FROM event_wines WHERE event_id = ANY($1) ORDER BY position, created_at`, [eventIds]) : { rows: [] };
    const wineIds = wines.map(w => w.wine_id);
    const [{ rows: notes }, shared] = await Promise.all([
      wineIds.length ? db.query(
        `SELECT wine_id, rating, note, tags, share_tags FROM member_wine_notes WHERE member_id = $1 AND wine_id = ANY($2)`,
        [req.member.member_id, wineIds]) : { rows: [] },
      wineIds.length ? sharedTagCounts(wineIds, false, req.member.member_id) : {},
    ]);
    const noteBy = new Map(notes.map(n => [n.wine_id, n]));

    const winesByEvent = {};
    wines.forEach(w => {
      const n = noteBy.get(w.wine_id);
      (winesByEvent[w.event_id] = winesByEvent[w.event_id] || []).push({
        ...wineOut(w),
        my: n ? { rating: n.rating, note: n.note, tags: n.tags, share_tags: n.share_tags } : { rating: null, note: '', tags: [], share_tags: false },
        shared_tags: shared[w.wine_id] || [],
      });
    });

    res.json({
      events: events.map(e => {
        const ws = winesByEvent[e.event_id] || [];
        return {
          event_id: e.event_id, name: e.name, event_date: e.event_date, location: e.location,
          stamp: buildStamp(e, ws), blurb: abridgeDescription(e, ws), wines: ws,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT /api/passport/wines/:wineId/note — save the caller's rating/notes/tags for a wine
memberRouter.put('/wines/:wineId/note', requireAuth, async (req, res) => {
  const input = sanitizeNoteInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM event_wines w JOIN signups s ON s.event_id = w.event_id
       WHERE w.wine_id = $1 AND s.member_id = $2 AND s.status = 'Attended'`,
      [req.params.wineId, req.member.member_id]);
    if (!rows.length) return res.status(403).json({ error: 'You can only add notes for wines from events you attended.' });

    if (isEmptyNote(input)) {
      await db.query('DELETE FROM member_wine_notes WHERE member_id=$1 AND wine_id=$2', [req.member.member_id, req.params.wineId]);
    } else {
      await db.query(
        `INSERT INTO member_wine_notes (member_id, wine_id, rating, note, tags, share_tags)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (member_id, wine_id) DO UPDATE
           SET rating=EXCLUDED.rating, note=EXCLUDED.note, tags=EXCLUDED.tags,
               share_tags=EXCLUDED.share_tags, updated_at=NOW()`,
        [req.member.member_id, req.params.wineId, input.rating, input.note, JSON.stringify(input.tags), input.share_tags]);
    }
    res.json({ ok: true, my: input });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = { adminRouter, memberRouter, imageRouter };
