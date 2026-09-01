'use strict';
const assert = require('assert');
const {
  MAX_CLIENT_TRIAL_DAYS,
  UPSERT_TRIAL_USER_SQL,
  UPSERT_TRIAL_USER_STRIPE_SQL,
  UPDATE_TRIAL_END_SQL,
  timingSafeEqualString,
  isStrongJwtSecret,
  isStrongAdminPassword,
  validateProductionAuthSecrets,
  capTrialDays,
  trialEndIsoFromDays,
  usesParameterizedTrialEnd,
  passwordHashForUpsert,
  shouldWritePasswordHash,
  inviteTokenMatches,
  createAttemptLockout,
  createFixedWindowLimiter,
  unspoofableClientIp,
  shareQuotaKey,
} = require('./security');

function assertEq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg || `${actual} !== ${expected}`);
}

// --- password overwrite ---
{
  const existing = { id: 1, email: 'a@b.com', password_hash: 'stored-hash' };
  assertEq(passwordHashForUpsert(existing, 'attacker-hash'), 'stored-hash', 'must not overwrite existing hash');
  assertEq(shouldWritePasswordHash(existing, 'attacker-hash'), false, 'must not write over existing hash');
  assertEq(passwordHashForUpsert(null, 'new-hash'), 'new-hash', 'new users get the new hash');
  assertEq(shouldWritePasswordHash(null, 'new-hash'), true, 'new users write hash');
  assertEq(passwordHashForUpsert({ password_hash: null }, 'first-hash'), 'first-hash', 'empty hash may be set once');
  assertEq(shouldWritePasswordHash({ password_hash: '' }, 'first-hash'), true, 'empty hash is not an overwrite');
  assertEq(shouldWritePasswordHash(existing, null), false, 'no hash means no write');
}

// --- trialDays cap + parameterization ---
{
  assertEq(capTrialDays(undefined, 7), 7);
  assertEq(capTrialDays(null, 14), 14);
  assertEq(capTrialDays(-3, 7), 7);
  assertEq(capTrialDays(0, 7), 7);
  assertEq(capTrialDays(3, 7), 3);
  assertEq(capTrialDays(99999, 7), MAX_CLIENT_TRIAL_DAYS, 'client trialDays must be capped');
  assertEq(capTrialDays('99999', 7), MAX_CLIENT_TRIAL_DAYS);
  assertEq(capTrialDays(1.9, 7), 1);
  assertEq(capTrialDays(40, 7, 30), 30);
  assertEq(capTrialDays(40, 7, 366), 40, 'admin max may be higher than client max');

  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const iso = trialEndIsoFromDays(10, now);
  assertEq(iso, '2026-01-11T00:00:00.000Z');
  const cappedIso = trialEndIsoFromDays(99999, now);
  const cappedDays = (Date.parse(cappedIso) - now) / 86400000;
  assert.ok(cappedDays <= 366, 'trial end must not honor huge day counts');

  assert.ok(usesParameterizedTrialEnd(UPSERT_TRIAL_USER_SQL), 'insert SQL must use bound trial_end');
  assert.ok(usesParameterizedTrialEnd(UPSERT_TRIAL_USER_STRIPE_SQL), 'stripe insert SQL must use bound trial_end');
  assert.ok(usesParameterizedTrialEnd(UPDATE_TRIAL_END_SQL), 'update SQL must use bound trial_end');
  assert.ok(
    !usesParameterizedTrialEnd("UPDATE users SET trial_end = datetime('now', '+${effectiveTrialDays} days') WHERE id = ?"),
    'interpolated day count must fail the parameterization check'
  );
  assert.ok(!UPSERT_TRIAL_USER_SQL.includes('datetime('), 'insert must not interpolate SQLite datetime modifiers');
  assert.ok(!UPSERT_TRIAL_USER_SQL.includes('${'), 'insert must not interpolate JS into SQL');
}

// --- production secrets fail closed ---
{
  const weak = validateProductionAuthSecrets({
    nodeEnv: 'production',
    jwtSecret: 'dev-secret-change-me',
    adminPassword: 'change-this',
  });
  assertEq(weak.ok, false);
  assert.ok(weak.problems.length >= 2);

  const missing = validateProductionAuthSecrets({ nodeEnv: 'production' });
  assertEq(missing.ok, false);

  const short = validateProductionAuthSecrets({
    nodeEnv: 'production',
    jwtSecret: 'too-short',
    adminPassword: 'short',
  });
  assertEq(short.ok, false);

  const ok = validateProductionAuthSecrets({
    nodeEnv: 'production',
    jwtSecret: 'a-unique-production-jwt-secret-32+',
    adminPassword: 'a-unique-admin-pass',
  });
  assertEq(ok.ok, true);

  const dev = validateProductionAuthSecrets({
    nodeEnv: 'development',
    jwtSecret: 'dev-secret-change-me',
    adminPassword: 'change-this',
  });
  assertEq(dev.ok, true, 'dev may use local fallbacks');

  assertEq(isStrongJwtSecret('dev-secret-change-me'), false);
  assertEq(isStrongAdminPassword('change-this'), false);
}

// --- timing-safe compare + invite gate ---
{
  assertEq(timingSafeEqualString('abc', 'abc'), true);
  assertEq(timingSafeEqualString('abc', 'abd'), false);
  assertEq(timingSafeEqualString('abc', 'ab'), false);
  assertEq(timingSafeEqualString('', ''), false);
  assertEq(inviteTokenMatches('invite-1', 'invite-1'), true);
  assertEq(inviteTokenMatches('invite-1', 'invite-2'), false);
  assertEq(inviteTokenMatches('invite-1', ''), false, 'missing expected token fails closed');
  assertEq(inviteTokenMatches('', 'invite-1'), false);
}

// --- admin lockout / backoff ---
{
  const lock = createAttemptLockout({ maxAttempts: 3, windowMs: 60_000, lockMs: 50 });
  const key = 'admin:1.2.3.4';
  assertEq(lock.isLocked(key).locked, false);
  assertEq(lock.recordFailure(key).locked, false);
  assertEq(lock.recordFailure(key).locked, false);
  const third = lock.recordFailure(key);
  assertEq(third.locked, true, 'third failure must lock');
  assert.ok(third.retryAfterMs > 0);
  assertEq(lock.isLocked(key).locked, true);
  lock.recordSuccess(key);
  assertEq(lock.isLocked(key).locked, false, 'success clears lock');

  const lock2 = createAttemptLockout({ maxAttempts: 2, windowMs: 60_000, lockMs: 5 });
  lock2.recordFailure('k');
  const locked = lock2.recordFailure('k');
  assertEq(locked.locked, true);
  const until = Date.now() + locked.retryAfterMs + 15;
  while (Date.now() < until) { /* wait out short lock */ }
  assertEq(lock2.isLocked('k').locked, false, 'lock expires after backoff');
}

// --- rate limiter ---
{
  const lim = createFixedWindowLimiter({ windowMs: 60_000, max: 2 });
  assertEq(lim.check('ip').allowed, true);
  assertEq(lim.check('ip').allowed, true);
  assertEq(lim.check('ip').allowed, false, 'third hit is denied');
  assertEq(lim.check('other').allowed, true, 'keys are independent');
}

// --- unspoofable identity ---
{
  const spoofed = {
    ip: '10.0.0.9',
    headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.9' },
    socket: { remoteAddress: '10.0.0.9' },
  };
  assertEq(unspoofableClientIp(spoofed), '10.0.0.9', 'must not use client-supplied X-Forwarded-For');
  assertEq(shareQuotaKey(spoofed, { id: 44 }), 'user:44');
  assertEq(shareQuotaKey(spoofed, null), 'ip:10.0.0.9');
}

console.log('lib/security.test.js passed');
