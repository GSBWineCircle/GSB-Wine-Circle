// Database connection pool using pg
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Sized to stay UNDER Supabase's free-tier pooler slot budget (~15), not
  // just above pg's default of 10. Load testing at 500 concurrent members
  // showed that overshooting the upstream limit doesn't queue - the excess
  // connection attempts fail outright, surfacing as 500s and (worse) as
  // spurious 401s from the session middleware. Fewer slots that always work
  // beat more slots that error under exactly the burst we care about.
  max: 12,
  // Wait for a free client instead of erroring immediately when all 12 are
  // busy. A burst then costs some latency rather than a failed request;
  // 10s is well inside the browser's patience and Render's request timeout.
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

module.exports = pool;
