'use strict';
// Read-only count of trialing users whose trial_end is already in the past.
// Prints two counts. Prints no emails and no ids.
const path = require('path');
const Database = require('better-sqlite3');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const dbPath = process.argv[2];
if (process.argv.length !== 3 || !dbPath) {
  fail('usage: node scripts/count-expired-trialing.js <db-path>');
}

const resolved = path.resolve(dbPath);
if (resolved === '/data/users.db' || resolved.startsWith('/data/')) {
  fail('refusing to open a production database path');
}

let db;
try {
  db = new Database(resolved, { readonly: true, fileMustExist: true });
} catch (err) {
  fail('could not open database read-only');
}

try {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS expired_trialing,
      COALESCE(SUM(CASE
        WHEN (
          (whop_membership_id IS NOT NULL AND TRIM(whop_membership_id) != '')
          OR (stripe_subscription_id IS NOT NULL AND TRIM(stripe_subscription_id) != '')
          OR (stripe_customer_id IS NOT NULL AND TRIM(stripe_customer_id) != '')
        ) THEN 1 ELSE 0 END), 0) AS with_signal
    FROM users
    WHERE status = 'trialing'
      AND trial_end IS NOT NULL
      AND TRIM(trial_end) != ''
      AND trial_end < ?
  `).get(new Date().toISOString());
  const expired = Number(row && row.expired_trialing) || 0;
  const signal = Number(row && row.with_signal) || 0;
  process.stdout.write(`expired_trialing=${expired}\n`);
  process.stdout.write(`with_payment_or_membership_signal=${signal}\n`);
} catch (err) {
  fail('could not count expired trialing rows');
} finally {
  try { db.close(); } catch (closeErr) {}
}
