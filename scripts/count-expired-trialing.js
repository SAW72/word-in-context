'use strict';
// Read-only count of users WIC_ENFORCE_TRIAL_END would newly refuse.
// Trialing, access still granted, not manual_free, and the trial is not open:
// trial_end missing, blank, not a date, or already past. Same Date check as requireAuth.
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

function textFilled(value) {
  return value != null && String(value).trim() !== '';
}

function trialStillOpen(trialEnd, now) {
  return !!(trialEnd && now < new Date(trialEnd));
}

function flagWouldCut(row, now) {
  if (!row || !row.access_granted) return false;
  if (row.manual_free) return false;
  if (row.status === 'active' || row.status === 'free') return false;
  if (row.status !== 'trialing') return false;
  return !trialStillOpen(row.trial_end, now);
}

try {
  const now = new Date();
  const rows = db.prepare(`
    SELECT status, trial_end, access_granted, manual_free,
           whop_membership_id, stripe_subscription_id, stripe_customer_id
    FROM users
  `).all();
  let expired = 0;
  let signal = 0;
  for (const row of rows) {
    if (!flagWouldCut(row, now)) continue;
    expired += 1;
    if (
      textFilled(row.whop_membership_id)
      || textFilled(row.stripe_subscription_id)
      || textFilled(row.stripe_customer_id)
    ) signal += 1;
  }
  process.stdout.write(`expired_trialing=${expired}\n`);
  process.stdout.write(`with_payment_or_membership_signal=${signal}\n`);
} catch (err) {
  fail('could not count expired trialing rows');
} finally {
  try { db.close(); } catch (closeErr) {}
}
