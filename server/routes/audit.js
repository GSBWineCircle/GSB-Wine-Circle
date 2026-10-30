// Audit log endpoint — admin read-only.
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { affectedFrom } = require('../services/auditView');

const router = express.Router();

// GET /api/audit — list audit log entries (paginated)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { limit = 100, offset = 0, action, target_table } = req.query;
    const params = [];
    const where = [];
    if (action) { params.push(action); where.push(`a.action = $${params.length}`); }
    if (target_table) { params.push(target_table); where.push(`a.target_table = $${params.length}`); }
    params.push(parseInt(limit) || 100);
    params.push(parseInt(offset) || 0);

    // Resolve the affected member at read time so older entries get one too:
    // signup entries via the signup's member, member/fee entries via the member
    // id, partner links also name the other half of the pair.
    // Only the small pieces of the saved before/after snapshots that "member affected"
    // needs are pulled; the snapshots themselves can be large and the page never shows them.
    const q = `SELECT a.id, a.created_at, a.admin_email, a.action, a.target_table, a.target_id,
                      jsonb_build_object('member_name', a.before_state->>'member_name', 'member_email', a.before_state->>'member_email',
                                         'full_name', a.before_state->>'full_name', 'email', a.before_state->>'email',
                                         'deleted', CASE WHEN a.action = 'BulkDeleteMembers' THEN a.before_state->'deleted' END) AS before_state,
                      jsonb_build_object('member_name', a.after_state->>'member_name', 'member_email', a.after_state->>'member_email',
                                         'full_name', a.after_state->>'full_name', 'email', a.after_state->>'email') AS after_state,
                      COALESCE(sm.full_name, mm.full_name) AS affected_name,
                      COALESCE(sm.email, mm.email)         AS affected_email,
                      pm.full_name                         AS partner_name
               FROM audit_log a
               LEFT JOIN signups sg ON a.target_table = 'signups' AND sg.signup_id = a.target_id
               LEFT JOIN members sm ON sm.member_id = sg.member_id
               LEFT JOIN members mm ON a.target_table IN ('members', 'fee_ledger') AND mm.member_id = a.target_id
               LEFT JOIN members pm ON a.action IN ('LinkPartner', 'UnlinkPartner')
                                   AND pm.member_id = COALESCE(a.after_state->>'partner_id', a.before_state->>'partner_id')
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY a.created_at DESC
               LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows: raw } = await db.query(q, params);
    const rows = raw.map(r => {
      const { affected_name, affected_email, partner_name, before_state, after_state, ...entry } = r;
      return { ...entry, affected: affectedFrom(r) };
    });
    return res.json({ log: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
