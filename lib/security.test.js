'use strict';
const assert = require('assert');
const {
  MAX_CLIENT_TRIAL_DAYS,
  UPSERT_TRIAL_USER_SQL,
  UPSERT_TRIAL_USER_STRIPE_SQL,
  INSERT_PENDING_CHECKOUT_USER_SQL,
  UPDATE_TRIAL_END_SQL,
  checkoutTrialDays,
  testerInviteFromRequest,
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
  isAcceptableAccountEmail,
  ACCOUNT_EMAIL_MAX_LENGTH,
  pastDueAccess,
  WHOP_PAST_DUE_GRACE_MS,
  whopPaymentFailedMarksPastDue,
  whopPaymentSucceededClearsPastDue,
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
  assertEq(passwordHashForUpsert({ password_hash: null }, 'first-hash'), null, 'blank hash on existing email is not filled');
  assertEq(shouldWritePasswordHash({ password_hash: '' }, 'first-hash'), false, 'empty hash on existing email is not written');
  assertEq(shouldWritePasswordHash({ password_hash: null }, 'first-hash'), false, 'null hash on existing email is not written');
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
  assertEq(checkoutTrialDays(99999, 7), 7, 'paid path ignores client trialDays');
  assertEq(checkoutTrialDays(30, 7), 7);
  assertEq(checkoutTrialDays(undefined, 14), 14);

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
  assert.ok(INSERT_PENDING_CHECKOUT_USER_SQL.includes("'pending'"), 'checkout insert is pending, not trialing');
  assert.ok(INSERT_PENDING_CHECKOUT_USER_SQL.includes('0, ?'), 'checkout insert does not grant access');
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
  assertEq(testerInviteFromRequest({ inviteToken: 'from-body' }), 'from-body');
  assertEq(testerInviteFromRequest({}), '');
  assertEq(testerInviteFromRequest(null), '');
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

{
  assertEq(ACCOUNT_EMAIL_MAX_LENGTH, 254, 'the account email cap stays 254');
  assertEq(isAcceptableAccountEmail('user.name+tag@example.com'), true);
  assertEq(isAcceptableAccountEmail('User@Example.com'), true);
  assertEq(isAcceptableAccountEmail("o'brien@example.ie"), true, 'apostrophe is legal in the local part');
  assertEq(isAcceptableAccountEmail("user!#$%&*+/=?^_`{|}~name@example.com"), true, 'other atext characters are legal');
  assertEq(isAcceptableAccountEmail('a'.repeat(242) + '@example.com'), true, '254 characters is the longest account email');
  assertEq(isAcceptableAccountEmail('<img src=x onerror=alert(1)>@church.org'), false);
  assertEq(isAcceptableAccountEmail('pastor<img src=x>@church.org'), false);
  assertEq(isAcceptableAccountEmail('a<b@example.com'), false, 'a less-than sign is rejected');
  assertEq(isAcceptableAccountEmail('a>b@example.com'), false, 'a greater-than sign is rejected');
  assertEq(isAcceptableAccountEmail('user"name@example.com'), false);
  assertEq(isAcceptableAccountEmail('user name@example.com'), false);
  assertEq(isAcceptableAccountEmail('a@b@example.com'), false, 'a second @ is rejected');
  assertEq(isAcceptableAccountEmail('.user@example.com'), false, 'a leading dot is rejected');
  assertEq(isAcceptableAccountEmail('user.@example.com'), false, 'a trailing dot in the local part is rejected');
  assertEq(isAcceptableAccountEmail('user@.example.com'), false, 'a leading dot in the domain is rejected');
  assertEq(isAcceptableAccountEmail('user@example.com.'), false, 'a trailing dot in the domain is rejected');
  assertEq(isAcceptableAccountEmail('user@example..com'), false, 'consecutive dots in the domain are rejected');
  assertEq(isAcceptableAccountEmail('user..name@example.com'), false, 'consecutive dots in the local part are rejected');
  assertEq(isAcceptableAccountEmail('user\u0000name@example.com'), false, 'NUL is rejected');
  assertEq(isAcceptableAccountEmail('user\u0007name@example.com'), false, 'a control character is rejected');
  assertEq(isAcceptableAccountEmail('user\u007fname@example.com'), false, 'DEL is rejected');
  assertEq(isAcceptableAccountEmail('user\u202ename@example.com'), false, 'a bidi override is rejected');
  assertEq(isAcceptableAccountEmail('user\u2066name@example.com'), false, 'a bidi isolate is rejected');
  assertEq(isAcceptableAccountEmail('user\u200bname@example.com'), false, 'a zero-width space is rejected');
  assertEq(isAcceptableAccountEmail('user\ufeffname@example.com'), false, 'a BOM is rejected');
  assertEq(isAcceptableAccountEmail('a'.repeat(243) + '@example.com'), false, '255 characters is over the cap');
  assertEq(isAcceptableAccountEmail('a'.repeat(300) + '@example.com'), false);
  assertEq(isAcceptableAccountEmail(''), false);
  assertEq(isAcceptableAccountEmail('missing-at.example.com'), false);
  assertEq(isAcceptableAccountEmail('a@b'), false);
}

// pastDueAccess: one rule for requireAuth, userHasAccess and password login.
{
  const AT = '2026-10-20T00:00:00.000Z';
  const NOW = Date.parse(AT) + 60 * 1000;
  const row = (c) => ({ access_granted: 1, status: 'past_due', whop_status: null, whop_membership_id: null, whop_member_id: null, stripe_customer_id: null, stripe_subscription_id: null, whop_event_at: AT, ...c });
  const pastDue = (r) => pastDueAccess(r, NOW);
  assertEq(pastDue(row({ whop_status: 'past_due' })), null, 'Whop shadow past_due with no stored membership id');
  assertEq(pastDue(row({ whop_status: 'past_due', whop_membership_id: 'mem_1', whop_member_id: 'user_1' })), 'whop', 'Whop retry with Whop ids');
  assertEq(pastDue(row({ whop_status: 'past_due', stripe_customer_id: 'cus_1' })), null, 'Whop shadow plus Stripe customer id');
  assertEq(pastDue(row({ whop_status: 'past_due', stripe_subscription_id: 'sub_1' })), null, 'Whop shadow plus Stripe subscription id');
  assertEq(pastDue(row({ whop_status: 'past_due', stripe_customer_id: '' })), null, 'an empty Stripe id is not NULL');
  assertEq(pastDue(row({ whop_status: 'past_due', access_granted: 0 })), null, 'revoked');
  assertEq(pastDue(row({ whop_status: 'past_due', status: 'active' })), null, 'not past_due');
  assertEq(pastDue(row({ whop_status: 'past_due', status: 'PAST_DUE' })), null, 'status match is exact');
  assertEq(pastDue(row({ whop_status: 'PAST_DUE' })), null, 'whop_status match is exact');
  assertEq(pastDue(row({})), null, 'pre shadow row with no ids');
  assertEq(pastDue(row({ whop_membership_id: 'mem_1' })), null, 'pre shadow Whop row');
  assertEq(pastDue(row({ stripe_customer_id: 'cus_1' })), 'stripe_login', 'Stripe only, customer id');
  assertEq(pastDue(row({ stripe_subscription_id: 'sub_1' })), 'stripe_login', 'Stripe only, subscription id');
  assertEq(pastDue(row({ stripe_customer_id: 'cus_1', whop_membership_id: 'mem_1' })), null, 'Stripe plus old Whop membership id');
  assertEq(pastDue(row({ stripe_customer_id: 'cus_1', whop_member_id: 'user_1' })), null, 'Stripe plus old Whop member id');
  assertEq(pastDue(row({ stripe_customer_id: 'cus_1', whop_status: 'canceled' })), null, 'Stripe plus a Whop shadow');
  assertEq(pastDue(row({ stripe_customer_id: 'cus_1', access_granted: 0 })), null, 'revoked Stripe only');
  assertEq(pastDueAccess(null), null);
  assertEq(pastDueAccess(undefined), null);
  // Table: status x whop_status x Stripe ids x Whop ids x access_granted, against the spec written out.
  let n = 0;
  for (const status of ['past_due', 'active', 'canceled', 'trialing', null]) {
    for (const ws of [null, 'past_due', 'active', 'trialing', 'canceled', 'unknown']) {
      for (const [cus, sub] of [[null, null], ['cus_1', null], [null, 'sub_1'], ['cus_1', 'sub_1']]) {
        for (const [mem, member] of [[null, null], ['mem_1', null], [null, 'user_1']]) {
          for (const access of [1, 0]) {
            n++;
            const r = row({ status, whop_status: ws, stripe_customer_id: cus, stripe_subscription_id: sub, whop_membership_id: mem, whop_member_id: member, access_granted: access });
            let want = null;
            if (access && status === 'past_due' && ws === 'past_due' && !cus && !sub && mem) want = 'whop';
            else if (access && status === 'past_due' && (cus || sub) && ws === null && !mem && !member) want = 'stripe_login';
            assertEq(pastDue(r), want, `table ${status} ${ws} ${cus} ${sub} ${mem} ${member} ${access}`);
          }
        }
      }
    }
  }
  assertEq(n, 720, 'every table row ran');
}

// pastDueAccess: a Whop past due grant needs a stored membership id and ends 7 days after whop_event_at.
{
  const AT = '2026-10-20T00:00:00.000Z';
  const atMs = Date.parse(AT);
  const row = (c) => ({ access_granted: 1, status: 'past_due', whop_status: 'past_due', whop_membership_id: 'mem_1', whop_member_id: null, stripe_customer_id: null, stripe_subscription_id: null, whop_event_at: AT, ...c });
  assertEq(WHOP_PAST_DUE_GRACE_MS, 7 * 24 * 60 * 60 * 1000, 'grace is 7 days');
  assertEq(pastDueAccess(row({}), atMs), 'whop', 'at the event time');
  assertEq(pastDueAccess(row({}), atMs + WHOP_PAST_DUE_GRACE_MS - 1), 'whop', 'one ms before the cap');
  assertEq(pastDueAccess(row({}), atMs + WHOP_PAST_DUE_GRACE_MS), 'whop', 'exactly at the cap');
  assertEq(pastDueAccess(row({}), atMs + WHOP_PAST_DUE_GRACE_MS + 1), null, 'one ms after the cap');
  assertEq(pastDueAccess(row({}), new Date(atMs + WHOP_PAST_DUE_GRACE_MS + 1)), null, 'a Date now after the cap');
  assertEq(pastDueAccess(row({}), new Date(atMs + 1000)), 'whop', 'a Date now inside the cap');
  assertEq(pastDueAccess(row({ whop_event_at: '2021-01-01T00:00:00.000Z' }), atMs), null, 'past_due since 2021');
  assertEq(pastDueAccess(row({ whop_event_at: null }), atMs), null, 'no event time');
  assertEq(pastDueAccess(row({ whop_event_at: 'not a time' }), atMs), null, 'unusable event time');
  assertEq(pastDueAccess(row({ whop_membership_id: null }), atMs), null, 'no stored membership id');
  assertEq(pastDueAccess(row({ whop_membership_id: '' }), atMs), null, 'blank stored membership id');
  assertEq(pastDueAccess(row({ whop_membership_id: 'pay_1' }), atMs), null, 'a pay_ id is not a membership');
  assertEq(pastDueAccess(row({ whop_membership_id: null, whop_member_id: 'mber_1' }), atMs), null, 'a member id alone is not a membership');
  const realNow = Date.now;
  try {
    Date.now = () => atMs + WHOP_PAST_DUE_GRACE_MS;
    assertEq(pastDueAccess(row({})), 'whop', 'default now (stubbed Date.now) at the cap');
    Date.now = () => atMs + WHOP_PAST_DUE_GRACE_MS + 1;
    assertEq(pastDueAccess(row({})), null, 'default now (stubbed Date.now) after the cap');
  } finally {
    Date.now = realNow;
  }
}

// Whop payment events change status only for the row's own stored membership, in order.
{
  const user = (c) => ({ status: 'active', manual_free: 0, whop_membership_id: 'mem_1', ...c });
  const shadow = (reason = null, email = 'a@example.com') => ({ email, reason });
  const failed = (c) => ({ billing_reason: 'subscription_cycle', membership: { id: 'mem_1' }, ...c });
  const F = (u, d, sh, e = 'a@example.com') => whopPaymentFailedMarksPastDue(u, d, sh, e);
  assertEq(F(user({}), failed({}), shadow()), true, 'renewal failure on the own membership');
  assertEq(F(user({}), failed({ membership: undefined, membership_id: 'mem_1' }), shadow()), true, 'membership_id form');
  assertEq(F(user({}), failed({}), shadow('no_time')), true, 'untimed: status written, the shadow stays unknown and fails closed');
  assertEq(F(user({}), failed({}), shadow('unknown_status')), true);
  assertEq(F(user({ whop_membership_id: null }), failed({}), shadow()), false, 'no stored membership id (expired tester)');
  assertEq(F(user({ whop_membership_id: 'pay_1' }), failed({ membership: { id: 'pay_1' } }), shadow()), false, 'pay_ ids never match');
  assertEq(F(user({}), failed({ membership: { id: 'mem_2' } }), shadow()), false, 'another membership');
  assertEq(F(user({}), failed({ membership: undefined }), shadow()), false, 'no membership id on the event');
  for (const reason of ['subscription_create', 'one_time', undefined, 'SUBSCRIPTION_CYCLE']) {
    assertEq(F(user({}), failed({ billing_reason: reason }), shadow()), false, `billing_reason ${reason}`);
  }
  assertEq(F(user({}), failed({}), shadow('stale')), false, 'stale event');
  assertEq(F(user({}), failed({}), shadow('other_membership')), false, 'shadow says another membership');
  assertEq(F(user({}), failed({}), null), false, 'shadow update failed or did not run');
  assertEq(F(user({}), failed({}), shadow(null, 'b@example.com')), false, 'shadow ran on another email');
  assertEq(F(null, failed({}), shadow()), false, 'no row');
  assertEq(F(user({}), null, shadow()), false, 'no payload');

  const S = (u, d, sh, e = 'a@example.com') => whopPaymentSucceededClearsPastDue(u, d, sh, e);
  const paid = (c) => ({ membership: { id: 'mem_1', status: 'active' }, ...c });
  assertEq(S(user({ status: 'past_due' }), paid({}), shadow()), true, 'own membership paid after a failure');
  assertEq(S(user({ status: 'past_due' }), paid({}), shadow('unknown_status')), true, 'membership status missing');
  assertEq(S(user({ status: 'past_due' }), paid({ membership: { id: 'mem_2', status: 'active' } }), shadow()), false, 'another membership paid');
  assertEq(S(user({ status: 'past_due' }), paid({}), shadow('stale')), false, 'older than the failure');
  assertEq(S(user({ status: 'past_due' }), paid({}), shadow('no_time')), false, 'untimed success cannot be ordered');
  assertEq(S(user({ status: 'past_due' }), paid({}), null), false, 'shadow update failed');
  assertEq(S(user({ status: 'past_due', whop_membership_id: null }), paid({}), shadow()), false, 'no stored membership id');
  assertEq(S(user({ status: 'active' }), paid({}), shadow()), false, 'not past_due: normal handling');
  assertEq(S(user({ status: 'canceled' }), paid({}), shadow()), false, 'canceled: normal handling');
  assertEq(S(user({ status: 'past_due', manual_free: 1 }), paid({}), shadow()), false, 'free forever untouched');
}

console.log('lib/security.test.js passed');
