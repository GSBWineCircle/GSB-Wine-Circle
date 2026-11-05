// Exec-only view of the per-endpoint database egress estimate (see services/dbMeter.js).
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const dbMeter = require('../services/dbMeter');

const router = express.Router();

router.get('/', requireAdmin, (req, res) => {
  if (!req.member.is_exec_team) return res.status(403).json({ error: 'Exec Team permission required' });
  res.json(dbMeter.snapshot());
});

module.exports = router;
