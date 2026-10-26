/**
 * Auth and abuse-control helpers used by server.js.
 * Kept free of Express/DB so the overwrite, trialDays, and lockout rules can be tested.
 */
const crypto = require('crypto');

const MAX_CLIENT_TRIAL_DAYS = 30;
const MAX_ADMIN_TRIAL_DAYS = 366;
const WEAK_JWT_DEFAULTS = new Set([
  '',
  'dev-secret-change-me',
  'change-me',
  'secret',
  'jwt-secret',
]);
const WEAK_ADMIN_DEFAULTS = new Set([
  '',
  'change-this',
  'admin',
  'password',
  'changeme',
  'admin-password',
]);

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    if (left.length > 0) crypto.timingSafeEqual(left, left);
    return false;
  }
  if (left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function isStrongJwtSecret(value) {
  const s = String(value || '');
  if (s.length < 32) return false;
  if (WEAK_JWT_DEFAULTS.has(s)) return false;
  return true;
}

function isStrongAdminPassword(value) {
  const s = String(value || '');
  if (s.length < 12) return false;
  if (WEAK_ADMIN_DEFAULTS.has(s.toLowerCase())) return false;
  return true;
}

function validateProductionAuthSecrets({ nodeEnv, jwtSecret, adminPassword } = {}) {
  if (nodeEnv !== 'production') return { ok: true, problems: [] };
  const problems = [];
  if (!isStrongJwtSecret(jwtSecret)) {
    problems.push('JWT_SECRET must be set to a unique value at least 32 characters (no built-in defaults)');
  }
  if (!isStrongAdminPassword(adminPassword)) {
    problems.push('ADMIN_PASSWORD must be set to a unique value at least 12 characters (no built-in defaults)');
  }
  return { ok: problems.length === 0, problems };
}

function resolveAuthSecrets(env = process.env) {
  const check = validateProductionAuthSecrets({
    nodeEnv: env.NODE_ENV,
    jwtSecret: env.JWT_SECRET,
    adminPassword: env.ADMIN_PASSWORD,
  });
  if (!check.ok) {
    return { ok: false, problems: check.problems, jwtSecret: '', adminPassword: '' };
  }
  const jwtSecret = env.JWT_SECRET || (env.NODE_ENV === 'production' ? '' : 'dev-secret-change-me');
  const adminPassword = env.ADMIN_PASSWORD || (env.NODE_ENV === 'production' ? '' : 'change-this');
  return { ok: true, problems: [], jwtSecret, adminPassword };
}

function capTrialDays(requested, fallback = 7, max = MAX_CLIENT_TRIAL_DAYS) {
  const maxDays = Number.isFinite(Number(max)) && Number(max) > 0
    ? Math.floor(Number(max))
    : MAX_CLIENT_TRIAL_DAYS;
  const fbRaw = Number(fallback);
  const fb = Number.isFinite(fbRaw) && fbRaw > 0
    ? Math.min(Math.floor(fbRaw), maxDays)
    : Math.min(7, maxDays);
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return fb;
  return Math.min(Math.floor(n), maxDays);
}

function trialEndIsoFromDays(days, nowMs = Date.now()) {
  const safe = capTrialDays(days, 1, MAX_ADMIN_TRIAL_DAYS);
  return new Date(nowMs + safe * 24 * 60 * 60 * 1000).toISOString();
}

/** Bound-parameter INSERT — never interpolate the day count into SQL. */
const UPSERT_TRIAL_USER_SQL = `
  INSERT INTO users (email, status, trial_end, access_granted, password_hash)
  VALUES (?, 'trialing', ?, 1, ?)
`;

const UPSERT_TRIAL_USER_STRIPE_SQL = `
  INSERT INTO users (email, stripe_customer_id, status, trial_end, access_granted, password_hash)
  VALUES (?, ?, 'trialing', ?, 1, ?)
`;

/** Checkout create: store credentials only. Access is granted on the payment webhook. */
const INSERT_PENDING_CHECKOUT_USER_SQL = `
  INSERT INTO users (email, status, trial_end, access_granted, password_hash)
  VALUES (?, 'pending', NULL, 0, ?)
`;

const INSERT_PENDING_CHECKOUT_USER_STRIPE_SQL = `
  INSERT INTO users (email, stripe_customer_id, status, trial_end, access_granted, password_hash)
  VALUES (?, ?, 'pending', NULL, 0, ?)
`;

const UPDATE_TRIAL_END_SQL = `UPDATE users SET trial_end = ? WHERE id = ?`;

/** Paid-path trial length is server TRIAL_DAYS only — client trialDays is ignored. */
function checkoutTrialDays(_requested, serverDays = 7) {
  return capTrialDays(undefined, serverDays, MAX_CLIENT_TRIAL_DAYS);
}

function usesParameterizedTrialEnd(sql) {
  const s = String(sql || '');
  if (/datetime\s*\(\s*'now'\s*,\s*'\+\s*\$\{/.test(s)) return false;
  if (/datetime\s*\(\s*'now'\s*,\s*'\+\$\{/.test(s)) return false;
  if (/datetime\s*\(\s*'now'\s*,\s*'\+\$\{?/.test(s)) return false;
  return s.includes('?') && !/\$\{[^}]*[Dd]ays/.test(s);
}

/**
 * Existing emails never get a password_hash write — not even to fill a blank/null hash.
 * New users (no row) may receive a hash at insert time.
 */
function passwordHashForUpsert(existingUser, newHash) {
  if (existingUser) return existingUser.password_hash == null ? null : existingUser.password_hash;
  return newHash || null;
}

function shouldWritePasswordHash(existingUser, newHash) {
  if (!newHash) return false;
  if (existingUser) return false;
  return true;
}

/** Landing `/?invite=` POSTs inviteToken in JSON. Header/bearer invite is ignored. */
function testerInviteFromRequest(body) {
  if (!body || typeof body !== 'object') return '';
  return typeof body.inviteToken === 'string' ? body.inviteToken : '';
}

function inviteTokenMatches(provided, expected) {
  const want = String(expected || '').trim();
  if (!want) return false;
  return timingSafeEqualString(String(provided || ''), want);
}

function createAttemptLockout(opts = {}) {
  const maxAttempts = Math.max(1, parseInt(opts.maxAttempts, 10) || 5);
  const windowMs = Math.max(1000, parseInt(opts.windowMs, 10) || 15 * 60 * 1000);
  const lockMs = Math.max(1, parseInt(opts.lockMs, 10) || 15 * 60 * 1000);
  const store = new Map();

  function row(key) {
    return store.get(key) || { failures: [], lockedUntil: 0 };
  }

  function isLocked(key, now = Date.now()) {
    const cur = row(key);
    if (cur.lockedUntil && now < cur.lockedUntil) {
      return { locked: true, retryAfterMs: cur.lockedUntil - now };
    }
    return { locked: false, retryAfterMs: 0 };
  }

  function recordFailure(key, now = Date.now()) {
    const cur = row(key);
    cur.failures = cur.failures.filter((t) => now - t < windowMs);
    cur.failures.push(now);
    if (cur.failures.length >= maxAttempts) {
      const extra = Math.max(0, cur.failures.length - maxAttempts);
      const multiplier = Math.min(8, 2 ** extra);
      cur.lockedUntil = now + lockMs * multiplier;
      cur.failures = [];
    }
    store.set(key, cur);
    return isLocked(key, now);
  }

  function recordSuccess(key) {
    store.delete(key);
  }

  function reset(key) {
    if (key) store.delete(key);
    else store.clear();
  }

  return { isLocked, recordFailure, recordSuccess, reset, maxAttempts, windowMs, lockMs };
}

function createFixedWindowLimiter(opts = {}) {
  const windowMs = Math.max(1000, parseInt(opts.windowMs, 10) || 15 * 60 * 1000);
  const max = Math.max(1, parseInt(opts.max, 10) || 10);
  const hits = new Map();

  function check(key, now = Date.now()) {
    let cur = hits.get(key);
    if (!cur || now - cur.start >= windowMs) {
      cur = { start: now, count: 0 };
    }
    cur.count += 1;
    hits.set(key, cur);
    if (cur.count > max) {
      return { allowed: false, retryAfterMs: Math.max(0, cur.start + windowMs - now) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  function reset(key) {
    if (key) hits.delete(key);
    else hits.clear();
  }

  return { check, reset, windowMs, max };
}

/** Prefer Express req.ip (trust proxy). Never take the first X-Forwarded-For hop. */
function unspoofableClientIp(req) {
  if (!req) return 'unknown';
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

function shareQuotaKey(req, user) {
  if (user && (user.id || user.email)) {
    return `user:${user.id || String(user.email).toLowerCase()}`;
  }
  return `ip:${unspoofableClientIp(req)}`;
}

const ACCOUNT_EMAIL_MAX_LENGTH = 254;

// RFC 5322 atext. Unquoted dot-atom only, so a quoted local-part cannot smuggle brackets.
const ATEXT_CHAR = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]$/;

function emailCodePointForbidden(cp) {
  if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return true;
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff || cp === 0x2060) return true;
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return true;
  return false;
}

/** Signup and checkout emails: dot-atom local part, dotted hostname, no controls or invisible characters. */
function isAcceptableAccountEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length === 0 || email.length > ACCOUNT_EMAIL_MAX_LENGTH) return false;
  for (const ch of email) {
    if (emailCodePointForbidden(ch.codePointAt(0))) return false;
    if (ch.trim() === '') return false;
  }
  if (email.includes('<') || email.includes('>')) return false;
  const at = email.indexOf('@');
  if (at <= 0 || email.indexOf('@', at + 1) !== -1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || !domain || !domain.includes('.')) return false;
  if (local.startsWith('.') || local.endsWith('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  if (local.includes('..') || domain.includes('..')) return false;
  for (const ch of local) {
    if (ch === '.') continue;
    if (!ATEXT_CHAR.test(ch)) return false;
  }
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return false;
  if (domain.split('.').some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return false;
  return true;
}

/**
 * Free forever accounts (admin manual_free). Billing, trial and past due mail
 * must skip them, and payment events must never lower their status or access.
 */
function isManualFree(user) {
  return !!user && Number(user.manual_free) === 1;
}

/*
 * Whop shadow: whop_status, whop_trial_end and whop_event_at.
 * Whop events write these on every row. Two readers: admin Remove free
 * (removeFreeDecision) and past due access (pastDueAccess), which keeps access
 * only while whop_status is past_due. Normal account writes (status, trial_end,
 * access_granted, Whop ids) never read them and are never skipped, so ordering
 * below changes only those two readers.
 * whop_status values: active, trialing, past_due, canceled, or unknown (the last
 * event could not be read as a clear state). NULL means no Whop event yet, for
 * example every row last touched before the shadow existed.
 */

/** Whop membership status to a shadow value. Only explicit active or trialing are live; anything else unrecognized is unknown. */
function whopStatusFromPayload(rawStatus) {
  const s = String(rawStatus || '').toLowerCase();
  if (s === 'active' || s === 'trialing' || s === 'past_due') return s;
  if (s === 'unresolved') return 'past_due';
  if (['canceled', 'cancelled', 'expired', 'completed'].includes(s)) return 'canceled';
  return 'unknown';
}

// Times before 2000 are not real Whop times (for example a bare year read as epoch seconds).
const WHOP_MIN_TIME_MS = Date.UTC(2000, 0, 1);

/**
 * Parse a Whop time to an ISO string, or null when unusable.
 * Accepts ISO 8601 strings, and epoch numbers or digit strings: below 1e12 they
 * are seconds, otherwise milliseconds. Results before 2000 or past year 9999 are null.
 */
function whopIsoTime(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  let ms;
  const text = typeof value === 'string' ? value.trim() : null;
  if (typeof value === 'number' || (text !== null && /^\d+(\.\d+)?$/.test(text))) {
    const n = Number(value);
    ms = n < 1e12 ? n * 1000 : n;
  } else if (text !== null && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    ms = Date.parse(text);
  } else {
    return null;
  }
  if (!Number.isFinite(ms) || ms < WHOP_MIN_TIME_MS) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() > 9999) return null;
  return d.toISOString();
}

/** Whop trial end on a membership payload: renewal_period_end, or current_period_end on newer API pins. */
function whopTrialEndFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return whopIsoTime(payload.renewal_period_end) || whopIsoTime(payload.current_period_end);
}

// A body time may run at most this far past the signed webhook-timestamp header.
// 5 minutes, the same window verifyWhopWebhook allows for the header itself.
const WHOP_EVENT_SKEW_MS = 5 * 60 * 1000;

/**
 * Event time for the shadow, as an ISO string, or null when there is none.
 * Membership and payment events: data.updated_at, then data.membership.updated_at,
 * then the envelope timestamp. trial_ending_soon is a notice about an unchanged
 * membership, so it uses the envelope timestamp first. Receipt time is never used.
 * The result is capped at the signed webhook-timestamp header plus WHOP_EVENT_SKEW_MS;
 * with no usable header there is no usable time.
 */
function whopShadowEventTime(type, event, data, headerTimestamp) {
  const header = whopIsoTime(headerTimestamp);
  if (!header) return null;
  const envelope = event && event !== data ? whopIsoTime(event.timestamp) : null;
  const objectTime = whopIsoTime(data && data.updated_at) || whopIsoTime(data && data.membership && data.membership.updated_at);
  const order = type === 'membership.trial_ending_soon' ? [envelope, objectTime] : [objectTime, envelope];
  const found = order.find(Boolean);
  if (!found) return null;
  const cap = Date.parse(header) + WHOP_EVENT_SKEW_MS;
  return Date.parse(found) > cap ? new Date(cap).toISOString() : found;
}

/** A Whop membership id as a string, or null. A pay_ id is a payment, never a membership. */
function whopMembershipIdOnly(rawId) {
  return rawId && !/^pay_/.test(String(rawId)) ? String(rawId) : null;
}

/** Membership id a Whop payment event names: data.membership.id, then data.membership_id. */
function whopPaymentMembershipId(data) {
  const d = data && typeof data === 'object' ? data : {};
  const nested = d.membership && typeof d.membership === 'object' ? d.membership : null;
  return whopMembershipIdOnly((nested && nested.id) || d.membership_id);
}

const WHOP_SHADOW_ACTIVATION = ['membership.activated', 'membership.went_valid', 'membership.created'];
const WHOP_SHADOW_DEACTIVATION = ['membership.deactivated', 'membership.went_invalid', 'membership.canceled'];

/**
 * What one Whop event says for the shadow: { status, membershipId, eventAt, trialEnd }.
 * membershipId is a membership id only, never a pay_ id. payment.succeeded is live
 * only when it carries a membership object with an explicit live status.
 * trial_ending_soon never downgrades active. It sets trialing only when the shadow
 * was already trialing, or was empty and the payload says trialing; after any other
 * state (for example a cancel) it is unknown, so it never revives a non trial state.
 */
function whopShadowFromEvent(type, event, data, headerTimestamp, before) {
  const d = data && typeof data === 'object' ? data : {};
  const nested = d.membership && typeof d.membership === 'object' ? d.membership : null;
  const membershipId = type.startsWith('payment.') ? whopPaymentMembershipId(d) : whopMembershipIdOnly(d.id);
  let status = 'unknown';
  if (WHOP_SHADOW_ACTIVATION.includes(type)) status = whopStatusFromPayload(d.status);
  else if (WHOP_SHADOW_DEACTIVATION.includes(type)) status = 'canceled';
  else if (type === 'payment.succeeded') status = nested ? whopStatusFromPayload(nested.status) : 'unknown';
  else if (type === 'payment.failed') status = 'past_due';
  else if (type === 'membership.trial_ending_soon') {
    const prev = before && before.whop_status;
    if (prev === 'active') status = 'active';
    else if (prev === 'trialing' || (prev == null && whopStatusFromPayload(d.status) === 'trialing')) status = 'trialing';
  }
  const trialEnd = whopTrialEndFromPayload(d) || (nested ? whopTrialEndFromPayload(nested) : null);
  return { status, membershipId, eventAt: whopShadowEventTime(type, event, d, headerTimestamp), trialEnd, failedPayment: type === 'payment.failed' };
}

/**
 * Shadow columns to write for one event, given the row before it.
 * Returns { patch, reason }: patch is null when the event changes nothing.
 * A payment.failed on a row with no stored Whop membership id is ignored (no_membership):
 * a failed payment proves nothing about such a row (an expired tester, for example).
 * - no usable time: whop_status unknown, event time unchanged.
 * - older than whop_event_at: ignored (stale). Equal times apply.
 * - names another membership than the row's whop_membership_id (or the stored id
 *   is a pay_ id) and is not explicitly live: whop_status unknown.
 * - otherwise: the event status, its trial end (trialing only) and its time.
 */
function whopShadowUpdate(before, ev) {
  const prev = before || {};
  const prevAt = whopIsoTime(prev.whop_event_at);
  const ref = prev.whop_membership_id ? String(prev.whop_membership_id) : null;
  if (ev.failedPayment && !ref) return { patch: null, reason: 'no_membership' };
  if (!ev.eventAt) {
    return { patch: { whop_status: 'unknown', whop_trial_end: null, whop_event_at: prev.whop_event_at || null }, reason: 'no_time' };
  }
  if (prevAt && Date.parse(ev.eventAt) < Date.parse(prevAt)) return { patch: null, reason: 'stale' };
  const live = ev.status === 'active' || ev.status === 'trialing';
  const mismatch = ev.membershipId
    ? !!ref && (/^pay_/.test(ref) || ref !== ev.membershipId)
    : !!ref;
  if (mismatch && !live) {
    return { patch: { whop_status: 'unknown', whop_trial_end: null, whop_event_at: ev.eventAt }, reason: 'other_membership' };
  }
  let trialEnd = null;
  if (ev.status === 'trialing') {
    trialEnd = ev.trialEnd || (!mismatch && prev.whop_status === 'trialing' ? whopIsoTime(prev.whop_trial_end) : null);
  }
  return {
    patch: { whop_status: ev.status, whop_trial_end: trialEnd, whop_event_at: ev.eventAt },
    reason: ev.status === 'unknown' ? 'unknown_status' : null,
  };
}

const WHOP_SHADOW_STATUSES = ['active', 'trialing', 'past_due', 'canceled'];

function removeFreeWhopUnclear(reason) {
  return `Cannot remove free forever yet: the Whop membership state for this account is unclear (${reason}). Free forever is unchanged and no email was sent. The account stays free until Whop sends a membership update for it.`;
}

const REMOVE_FREE_STRIPE_MESSAGE = 'Cannot remove free forever yet: this account has a Stripe subscription on record, and its Stripe state is not tracked while the account is free forever. Free forever is unchanged and no email was sent.';

/**
 * Admin Remove free decision from the shadow. Returns { blocked } (409, write
 * nothing) when the state is not clear, else { status, trialEnd } to write.
 * Blocked: a Stripe subscription id on the row (Stripe events never update free
 * forever rows, so it may be live); NULL whop_status with Whop ids; whop_status
 * unknown or unrecognized; no usable whop_event_at; past_due; trialing with no
 * usable Whop trial end. Keeps access: active, or trialing with a Whop trial end
 * strictly after now (trial_end set to it). Canceled only for an unambiguous dead
 * state: Whop canceled, a Whop trial that has ended, or no Whop or Stripe history.
 */
function removeFreeDecision(user, now = new Date()) {
  const keep = (user && user.trial_end) || null;
  if (user.stripe_subscription_id) return { blocked: REMOVE_FREE_STRIPE_MESSAGE };
  const ws = user.whop_status;
  if (ws == null) {
    if (user.whop_membership_id || user.whop_member_id) return { blocked: removeFreeWhopUnclear('no Whop status recorded') };
    return { status: 'canceled', trialEnd: keep };
  }
  if (!WHOP_SHADOW_STATUSES.includes(ws)) {
    return { blocked: removeFreeWhopUnclear('the last Whop event had no usable time, named another membership, or had an unknown status') };
  }
  if (!whopIsoTime(user.whop_event_at)) return { blocked: removeFreeWhopUnclear('no usable Whop event time recorded') };
  if (ws === 'active') return { status: 'active', trialEnd: keep };
  if (ws === 'past_due') return { blocked: removeFreeWhopUnclear('Whop reports a failed payment that may still be retried') };
  if (ws === 'trialing') {
    const end = whopIsoTime(user.whop_trial_end);
    if (!end) return { blocked: removeFreeWhopUnclear('Whop reports a trial with no end date') };
    if (now < new Date(end)) return { status: 'trialing', trialEnd: end };
  }
  return { status: 'canceled', trialEnd: keep };
}

// A Whop past due row keeps access at most this long after its last Whop event.
// Whop retries a failed renewal for 5 days, then cancels.
const WHOP_PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Past due access, one rule for requireAuth, userHasAccess and password login.
 * Returns:
 *   'whop': keep access. access_granted, status past_due, whop_status past_due
 *     (a Whop payment failed and Whop may still retry it), no Stripe ids, a stored
 *     Whop membership id, and now is at most WHOP_PAST_DUE_GRACE_MS after whop_event_at.
 *   'stripe_login': a Stripe only past_due row (a Stripe id, no Whop id and no
 *     whop_status). Login and the magic link allow it as before; requireAuth does not.
 *   null: no past due access. Every other case fails closed, including a Whop
 *     past_due row that also has a Stripe id, and rows with whop_status NULL.
 * Stripe ids count as present unless they are NULL, so a blank id also fails closed.
 */
function pastDueAccess(user, now = Date.now()) {
  if (!user || !user.access_granted || user.status !== 'past_due') return null;
  const noStripe = user.stripe_customer_id == null && user.stripe_subscription_id == null;
  if (user.whop_status === 'past_due' && noStripe) {
    const at = whopIsoTime(user.whop_event_at);
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const inGrace = !!at && nowMs <= Date.parse(at) + WHOP_PAST_DUE_GRACE_MS;
    return whopMembershipIdOnly(user.whop_membership_id) && inGrace ? 'whop' : null;
  }
  const noWhop = user.whop_status == null && user.whop_membership_id == null && user.whop_member_id == null;
  if (!noStripe && noWhop) return 'stripe_login';
  return null;
}

/**
 * True when a Whop payment event belongs to this row: the row has a stored Whop
 * membership id, the event names that same membership, and the shadow update for
 * this event ran on this row's email and did not find it stale or for another
 * membership. shadow is { email, reason } from recordWhopShadow, or null.
 */
function whopPaymentIsForRow(user, data, shadow, email) {
  if (!user || !shadow || !email || shadow.email !== email) return false;
  if (shadow.reason === 'stale' || shadow.reason === 'other_membership') return false;
  const stored = whopMembershipIdOnly(user.whop_membership_id);
  return !!stored && stored === whopPaymentMembershipId(data);
}

/** payment.failed marks the row past_due only for a renewal of the row's own membership. */
function whopPaymentFailedMarksPastDue(user, data, shadow, email) {
  return !!data && data.billing_reason === 'subscription_cycle' && whopPaymentIsForRow(user, data, shadow, email);
}

/**
 * payment.succeeded clears past_due only for the row's own membership, and only when
 * the event has a usable time (the shadow could order it after the failure).
 */
function whopPaymentSucceededClearsPastDue(user, data, shadow, email) {
  if (!user || user.status !== 'past_due' || user.manual_free) return false;
  if (!shadow || shadow.reason === 'no_time') return false;
  return whopPaymentIsForRow(user, data, shadow, email);
}

const USER_COLUMN_TYPES = new Set(['TEXT']);

/** Additive, idempotent startup migration: one nullable users column. */
function ensureUserColumn(database, name, type) {
  if (!/^[a-z_]+$/.test(name) || !USER_COLUMN_TYPES.has(type)) throw new Error(`bad column ${name} ${type}`);
  const columns = database.prepare('PRAGMA table_info(users)').all();
  if (columns.some((c) => c.name === name)) return false;
  database.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  return true;
}

/** Additive, idempotent startup migration: nullable users.whop_status. */
function ensureWhopStatusColumn(database) {
  return ensureUserColumn(database, 'whop_status', 'TEXT');
}

/** Additive, idempotent startup migration: nullable users.whop_trial_end (last Whop trial end seen). */
function ensureWhopTrialEndColumn(database) {
  return ensureUserColumn(database, 'whop_trial_end', 'TEXT');
}

/** Additive, idempotent startup migration: nullable users.whop_event_at (time of the last applied Whop event). */
function ensureWhopEventAtColumn(database) {
  return ensureUserColumn(database, 'whop_event_at', 'TEXT');
}

/** Additive, idempotent startup migration: nullable users.tester_expired_email_at (when the one go paid email was claimed). */
function ensureTesterExpiredEmailColumn(database) {
  return ensureUserColumn(database, 'tester_expired_email_at', 'TEXT');
}

module.exports = {
  isManualFree,
  whopStatusFromPayload,
  whopIsoTime,
  whopTrialEndFromPayload,
  whopShadowEventTime,
  whopShadowFromEvent,
  whopShadowUpdate,
  removeFreeDecision,
  pastDueAccess,
  WHOP_PAST_DUE_GRACE_MS,
  whopPaymentFailedMarksPastDue,
  whopPaymentSucceededClearsPastDue,
  WHOP_EVENT_SKEW_MS,
  ensureUserColumn,
  ensureTesterExpiredEmailColumn,
  ensureWhopStatusColumn,
  ensureWhopTrialEndColumn,
  ensureWhopEventAtColumn,
  MAX_CLIENT_TRIAL_DAYS,
  MAX_ADMIN_TRIAL_DAYS,
  UPSERT_TRIAL_USER_SQL,
  UPSERT_TRIAL_USER_STRIPE_SQL,
  INSERT_PENDING_CHECKOUT_USER_SQL,
  INSERT_PENDING_CHECKOUT_USER_STRIPE_SQL,
  UPDATE_TRIAL_END_SQL,
  checkoutTrialDays,
  timingSafeEqualString,
  isStrongJwtSecret,
  isStrongAdminPassword,
  validateProductionAuthSecrets,
  resolveAuthSecrets,
  capTrialDays,
  trialEndIsoFromDays,
  usesParameterizedTrialEnd,
  passwordHashForUpsert,
  shouldWritePasswordHash,
  inviteTokenMatches,
  testerInviteFromRequest,
  createAttemptLockout,
  createFixedWindowLimiter,
  unspoofableClientIp,
  shareQuotaKey,
  ACCOUNT_EMAIL_MAX_LENGTH,
  isAcceptableAccountEmail,
};
