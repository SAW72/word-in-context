'use strict';
/**
 * Tester accounts (invite or admin tester access, no card) end when trial_end passes.
 *
 * A tester row is a trialing row that no billing system has ever touched: no Whop
 * membership or member id, no Whop shadow status, no Stripe customer or subscription.
 * Whop and Stripe trials always carry one of those, because the webhook that grants
 * them writes it. Those trials keep the requireAuth grace while billing catches up;
 * a tester has no billing that could ever move it, so its trial_end is final.
 * Free forever (manual_free=1) is never a tester here and is never cut off or mailed.
 */
const { isManualFree } = require('./security');
const testerExpiredEmail = require('./tester-expired-email');

const BILLING_LINK_COLUMNS = ['whop_membership_id', 'whop_member_id', 'whop_status', 'stripe_customer_id', 'stripe_subscription_id'];

function isBillingFreeTester(user) {
  if (!user || isManualFree(user) || user.status !== 'trialing') return false;
  return BILLING_LINK_COLUMNS.every((col) => user[col] == null || String(user[col]).trim() === '');
}

/** Same date rule as login and userHasAccess: no valid future trial_end means over. */
function testerTrialOver(user, now = new Date()) {
  if (!isBillingFreeTester(user)) return false;
  const end = user.trial_end ? new Date(user.trial_end) : null;
  return !(end && now < end);
}

/** Cut off with the go paid email: an expired tester whose access was not revoked by an admin. */
function isExpiredTester(user, now = new Date()) {
  return !!user && Number(user.access_granted) === 1 && testerTrialOver(user, now);
}

/**
 * Claim the one go paid email for this row, atomically. The read and the conditional
 * UPDATE run in one IMMEDIATE transaction, so two requests (or two processes on the
 * same SQLite file) can never both claim it. Returns the claimed row and stamp, or null.
 */
function claimTesterExpiredEmail(database, userId, now = new Date()) {
  // Cheap read first: once the email is claimed, later cut off requests skip the write lock.
  // The conditional UPDATE below stays the real once guard.
  const seen = database.prepare('SELECT tester_expired_email_at FROM users WHERE id = ?').get(userId);
  if (!seen || seen.tester_expired_email_at != null) return null;
  const claim = database.transaction(() => {
    const row = database.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row || !isExpiredTester(row, now)) return null;
    const stamp = now.toISOString();
    const res = database.prepare('UPDATE users SET tester_expired_email_at = ? WHERE id = ? AND tester_expired_email_at IS NULL').run(stamp, userId);
    return res.changes === 1 ? { row, stamp } : null;
  });
  return claim.immediate();
}

/** Undo our own claim only (same stamp), so a failed send can be retried on a later request. */
function releaseTesterExpiredEmail(database, userId, stamp) {
  return database.prepare('UPDATE users SET tester_expired_email_at = NULL WHERE id = ? AND tester_expired_email_at = ?').run(userId, stamp).changes === 1;
}

/**
 * A log safe summary of a mailer or database error: its name and code only, never the
 * message, because a provider message can include the recipient address. Never throws.
 */
function safeErrorSummary(err) {
  const clean = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(v) ? v : null);
  const parts = [];
  let name;
  let code;
  try {
    // A hostile or broken error (throwing getter, Proxy trap) must not break the caller's catch.
    name = err && clean(err.name);
    code = err && clean(typeof err.code === 'number' ? String(err.code) : err.code);
  } catch (readErr) {
    return 'unknown error';
  }
  if (name) parts.push(name);
  if (code && code !== name) parts.push(code);
  return parts.length ? parts.join(' ') : 'unknown error';
}

/**
 * Send the go paid email once for an expired tester. The marker is claimed before the
 * send. If the mailer throws or reports an error, the claim is released so the next
 * cut off request tries again; a send that succeeds keeps the marker forever.
 * Returns 'sent', 'skipped' or 'failed'. Never throws. Log lines name the user id only,
 * never the email address or a raw mailer message.
 */
async function notifyExpiredTester(database, user, send, { appBaseUrl, now = new Date(), log = console } = {}) {
  let claimed = null;
  const userId = user && user.id;
  try {
    if (!user || !isExpiredTester(user, now)) return 'skipped';
    claimed = claimTesterExpiredEmail(database, user.id, now);
    if (!claimed) return 'skipped';
    const email = testerExpiredEmail({ appBaseUrl });
    const result = await send(claimed.row.email, email);
    if (result && result.error) {
      throw Object.assign(new Error('mailer error result'), { name: (result.error && result.error.name) || 'mailer_error', code: result.error && result.error.code });
    }
    log.log(`[tester] go paid email sent for user ${claimed.row.id}`);
    return 'sent';
  } catch (err) {
    const why = safeErrorSummary(err);
    if (!claimed) {
      log.error(`[tester] go paid email failed for user ${userId} before a claim (${why}); will retry on a later request`);
      return 'failed';
    }
    let released = false;
    try {
      released = releaseTesterExpiredEmail(database, claimed.row.id, claimed.stamp);
    } catch (releaseErr) {
      log.error(`[tester] go paid email failed for user ${claimed.row.id} (${why}); could not release the claim (${safeErrorSummary(releaseErr)}), no retry until it is cleared`);
      return 'failed';
    }
    if (released) {
      log.error(`[tester] go paid email failed for user ${claimed.row.id} (${why}); will retry on a later request`);
    } else {
      log.error(`[tester] go paid email failed for user ${claimed.row.id} (${why}); claim was not released because the marker changed after our claim, so no retry from here`);
    }
    return 'failed';
  }
}

module.exports = {
  BILLING_LINK_COLUMNS,
  isBillingFreeTester,
  testerTrialOver,
  isExpiredTester,
  claimTesterExpiredEmail,
  releaseTesterExpiredEmail,
  notifyExpiredTester,
  safeErrorSummary,
};
