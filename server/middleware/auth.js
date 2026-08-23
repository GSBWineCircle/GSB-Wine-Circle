// Session middleware: resolves the bearer token to a member row.
// Attaches req.member (or null) and req.isAdmin, req.isExecTeam.
const crypto = require('crypto');
const db = require('../db');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Resolve session from Authorization header or X-Session-Token header.
 * Always calls next(); use requireAuth / requireAdmin in routes.
 */
async function sessionMiddleware(req, res, next) {
  req.member = null;
  req.isAdmin = false;
  req.isExecTeam = false;
  req.sessionLookupFailed = false;

  let token =
    req.headers['x-session-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!token) return next();

  try {
    const tokenHash = hashToken(token);
    const { rows } = await db.query(
      `SELECT s.member_id, s.expires_at,
              m.email, m.full_name, m.affiliation,
              m.is_admin, m.is_exec_team, m.fee_balance, m.status
       FROM auth_sessions s
       JOIN members m ON m.member_id = s.member_id
       WHERE s.token_hash = $1
         AND s.expires_at > NOW()`,
      [tokenHash]
    );
    if (rows.length) {
      const r = rows[0];
      req.member = {
        member_id:      r.member_id,
        email:          r.email,
        full_name:      r.full_name,
        affiliation:    r.affiliation,
        is_admin:       r.is_admin,
        is_exec_team:   r.is_exec_team,
        fee_balance:    parseFloat(r.fee_balance) || 0,
        status:         r.status,
      };
      req.isAdmin = !!r.is_admin;
      req.isExecTeam = !!r.is_exec_team;
    }
  } catch (err) {
    // A DB failure here means we could not determine WHETHER this token is
    // valid - which is not the same as knowing it is invalid. Flag it so the
    // require* guards below can answer 503 instead of 401: under a burst that
    // exhausts the connection pool, a 401 would tell a legitimately
    // logged-in member they've been signed out mid-signup (observed in load
    // testing), and their client would likely discard a good session token.
    req.sessionLookupFailed = true;
    console.error('Session resolution error:', err.message);
  }

  next();
}

// Shared by every guard: distinguishes "we know you're not authenticated"
// from "we couldn't check right now, please retry".
function denyUnauthenticated(req, res) {
  if (req.sessionLookupFailed) {
    res.set('Retry-After', '2');
    return res.status(503).json({ error: 'Server busy, please try again in a moment.' });
  }
  return res.status(401).json({ error: 'Authentication required' });
}

function requireAuth(req, res, next) {
  if (!req.member) return denyUnauthenticated(req, res);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.member) return denyUnauthenticated(req, res);
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requireExecTeam(req, res, next) {
  if (!req.member) return denyUnauthenticated(req, res);
  if (!req.isExecTeam) return res.status(403).json({ error: 'Exec Team permission required' });
  next();
}

module.exports = { sessionMiddleware, requireAuth, requireAdmin, requireExecTeam, hashToken };
