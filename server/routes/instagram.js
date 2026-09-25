// Welcome-screen photos: admins pick posts from the club's Instagram account;
// the chosen images are copied into the DB and shown behind the login screen.
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/audit');
const ig = require('../services/instagram');
const { isSelectableMedia, validateSelection, isValidMediaId } = require('../services/instagramHelpers');

const router = express.Router();
const adminRouter = express.Router();

// ── Public: what the welcome screen shows ────────────────────────────────────
// GET /api/welcome-photos
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT photo_id, EXTRACT(EPOCH FROM created_at)::bigint AS v FROM welcome_photos ORDER BY position, created_at`
    );
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ photos: rows.map(r => ({ id: r.photo_id, url: `/api/welcome-photos/${r.photo_id}/image?v=${r.v}` })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/welcome-photos/:id/image
router.get('/:id/image', async (req, res) => {
  if (!isValidMediaId(req.params.id)) return res.status(404).end();
  try {
    const { rows } = await db.query('SELECT image, content_type FROM welcome_photos WHERE photo_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).end();
    res.set('Content-Type', rows[0].content_type);
    // URL carries a ?v= version, so a long cache lifetime is safe.
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(rows[0].image);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ── Admin: browse Instagram and choose photos ────────────────────────────────
// GET /api/instagram/media
adminRouter.get('/media', requireAdmin, async (req, res) => {
  if (!(await ig.isConfigured())) return res.json({ connected: false, media: [], selected: [] });
  try {
    const [account, media, expiresAt, sel] = await Promise.all([
      ig.getAccount().catch(() => null),
      ig.listMedia(60),
      ig.tokenExpiry(),
      db.query('SELECT photo_id FROM welcome_photos ORDER BY position, created_at'),
    ]);
    res.json({
      connected: true,
      username: account?.username || null,
      tokenExpiresAt: expiresAt,
      selected: sel.rows.map(r => r.photo_id),
      // Only the fields the picker needs; thumbnail_url is the still frame for videos.
      media: media.map(m => ({
        id: m.id, media_type: m.media_type, permalink: m.permalink,
        caption: (m.caption || '').slice(0, 140), timestamp: m.timestamp,
        selectable: isSelectableMedia(m),
        thumb: m.media_type === 'VIDEO' ? (m.thumbnail_url || null) : m.media_url,
      })),
    });
  } catch (err) {
    console.error('Instagram media error:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// PUT /api/instagram/selection  { media_ids: [...] }  - ordered; replaces the set
adminRouter.put('/selection', requireAdmin, async (req, res) => {
  const v = validateSelection(req.body.media_ids);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const { rows: existing } = await db.query('SELECT photo_id FROM welcome_photos');
    const have = new Set(existing.map(r => r.photo_id));

    // Fetch + download anything new BEFORE touching the DB, so a failure
    // part-way leaves the current welcome screen exactly as it was.
    const fresh = [];
    for (const id of v.ids.filter(i => !have.has(i))) {
      const m = await ig.getMedia(id);
      if (!isSelectableMedia(m)) return res.status(400).json({ error: 'One of the chosen posts is not a photo.' });
      const { buffer, contentType } = await ig.downloadImage(m.media_url);
      fresh.push({ id, permalink: m.permalink || '', caption: (m.caption || '').slice(0, 500), buffer, contentType });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM welcome_photos WHERE NOT (photo_id = ANY($1))', [v.ids]);
      for (const f of fresh) {
        await client.query(
          `INSERT INTO welcome_photos (photo_id, permalink, caption, content_type, image, added_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [f.id, f.permalink, f.caption, f.contentType, f.buffer, req.member.email]
        );
      }
      for (let i = 0; i < v.ids.length; i++) {
        await client.query('UPDATE welcome_photos SET position = $2 WHERE photo_id = $1', [v.ids[i], i]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    await audit(req.member.email, 'SetWelcomePhotos', 'welcome_photos', 'all',
      { photo_ids: [...have] }, { photo_ids: v.ids });
    res.json({ ok: true, count: v.ids.length });
  } catch (err) {
    console.error('Welcome photo selection error:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' });
  }
});

module.exports = { publicRouter: router, adminRouter };
