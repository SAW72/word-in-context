# Security notes

## Rotate `WHOP_WEBHOOK_SECRET` off-repo

A historical git commit message included a truncated webhook-secret prefix. **Do not put a live `WHOP_WEBHOOK_SECRET` in git, pull requests, or comments.**

Rotate it in the Whop dashboard (Developer → Webhooks) and paste the **full** new value only into Render as a Secret env var, then redeploy. Membership activation will fail until the new secret is on both sides.

## Production auth secrets

When `NODE_ENV=production`, the server exits if `JWT_SECRET` or `ADMIN_PASSWORD` is missing, shorter than the minimum, or still a built-in default.

## Tester signup

`POST /api/tester-signup` is invite-only (`TESTER_INVITE_TOKEN` or an admin JWT). It never overwrites an existing password and never returns a session JWT.

## Share endpoints

`/api/share-tts` and `/api/share-bg-image` default to requiring a signed-in user. Quotas use `req.ip` (Express `trust proxy`) or the user id — not the first `X-Forwarded-For` hop. `/api/share-transcode` requires auth and is size- and rate-limited.
