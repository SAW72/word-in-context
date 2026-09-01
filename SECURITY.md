# Security notes

## Rotate `WHOP_WEBHOOK_SECRET` off-repo

A historical git commit message included a truncated webhook-secret prefix. **Do not put a live `WHOP_WEBHOOK_SECRET` in git, pull requests, or comments.**

Rotate it in the Whop dashboard (Developer → Webhooks) and paste the **full** new value only into Render as a Secret env var, then redeploy. Membership activation will fail until the new secret is on both sides.

## Production auth secrets

When `NODE_ENV=production`, the server exits if `JWT_SECRET` or `ADMIN_PASSWORD` is missing, shorter than the minimum, or still a built-in default.

## Tester signup

`POST /api/tester-signup` is invite-only. The landing `/?invite=` flow copies the query value into the form and POSTs it as JSON `inviteToken` (not an `Authorization` or `X-Tester-Invite` header). An admin JWT still works. The endpoint never overwrites an existing password (including a blank hash) and never returns a session JWT.

**Remaining risk:** `TESTER_INVITE_TOKEN` is a shared capability. Anyone who has the landing link (or the token value) can create **new** tester accounts until you rotate the env var off-repo. That is inherent to a single shared invite on `/?invite=` — do not put a new token in git. Rate limits and the existing-email `409` bound the blast radius. Rotate the token in Render if a link leaks.

## Checkout access

`POST /api/create-checkout` may store a new email + password as `status=pending`, `access_granted=0`. It ignores client `trialDays` (server `TRIAL_DAYS` only) and does not grant access. The Whop (or Stripe) webhook grants `access_granted` and `trial_end` after payment.

## Share endpoints

`/api/share-tts` and `/api/share-bg-image` default to requiring a signed-in user. Quotas use `req.ip` (Express `trust proxy`) or the user id — not the first `X-Forwarded-For` hop. `/api/share-transcode` requires auth and is size- and rate-limited.
