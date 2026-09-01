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

const UPDATE_TRIAL_END_SQL = `UPDATE users SET trial_end = ? WHERE id = ?`;

function usesParameterizedTrialEnd(sql) {
  const s = String(sql || '');
  if (/datetime\s*\(\s*'now'\s*,\s*'\+\s*\$\{/.test(s)) return false;
  if (/datetime\s*\(\s*'now'\s*,\s*'\+\$\{/.test(s)) return false;
  if (/datetime\s*\(\s*'now'\s*,\s*'\+\$\{?/.test(s)) return false;
  return s.includes('?') && !/\$\{[^}]*[Dd]ays/.test(s);
}

/**
 * Existing users keep their password_hash.
 * A hash is only written when creating a user or when the stored hash is empty.
 */
function passwordHashForUpsert(existingUser, newHash) {
  if (!existingUser) return newHash || null;
  if (existingUser.password_hash) return existingUser.password_hash;
  return newHash || null;
}

function shouldWritePasswordHash(existingUser, newHash) {
  if (!newHash) return false;
  if (!existingUser) return true;
  return !existingUser.password_hash;
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

module.exports = {
  MAX_CLIENT_TRIAL_DAYS,
  MAX_ADMIN_TRIAL_DAYS,
  UPSERT_TRIAL_USER_SQL,
  UPSERT_TRIAL_USER_STRIPE_SQL,
  UPDATE_TRIAL_END_SQL,
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
  createAttemptLockout,
  createFixedWindowLimiter,
  unspoofableClientIp,
  shareQuotaKey,
};
