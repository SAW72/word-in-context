# Billing policy for past-due access

Internal policy. Spencer decided this on 25 October 2026. It describes current behavior on main at 32f3a3fdac47438f89b4bc3b11f0b46d894f32fe. It does not change the app, the server, the email, or the public terms.

## 1. Past-due customers are limited

Past-due customers are limited. This retires the old idea that a past-due customer keeps access until Whop cancels the membership.

A past-due customer can log in with a password or a magic link and stay signed in. The app does not sign them out because they are past-due, and it does not send them to a payment page. The stored token is removed only when they choose Log out (public/index.html:7375).

Password login allows status past_due when access_granted is set (server.js:1661 through server.js:1667). That token lasts 30 days (server.js:1666). The landing page and the app store the token and then open /app (public/landing.html:1200 through public/landing.html:1208, public/index.html:7234 through public/index.html:7241).

A magic link checks only access_granted. It does not check status (server.js:1685 through server.js:1697). That token lasts 7 days (server.js:1691). The browser stores it and opens /app (public/login-verify.js:5 through public/login-verify.js:11).

On /app, startup does not call /api/me. When a token is already stored, the question box, send button, and microphone stay enabled (public/index.html:2505 through public/index.html:2529). A failed chat call does not clear the token (public/index.html:5834 through public/index.html:5876).

### What is denied

These routes use requireAuth (server.js:310 through server.js:337). For a past_due row with access_granted set and manual_free unset, requireAuth returns 403 with the text "Subscription required or trial expired." (server.js:329 through server.js:331).

POST /api/chat with a bearer token calls requireAuth (server.js:2843 through server.js:2844). The chat shows that server text as an assistant bubble (public/index.html:5827 through public/index.html:5829) and drops the user message from the thread (public/index.html:5830). A landing teaser request ignores any stored token and uses the anonymous preview cap instead (server.js:2819 through server.js:2820).

GET /api/me uses requireAuth (server.js:1705). The 403 body is only an error field. It has no email and no access_granted. The Account panel still reads that body as a normal account payload. The email line becomes "Logged in" and the status line becomes "Access revoked" (public/index.html:7157 through public/index.html:7165). Chat opens the same panel and uses the same wording (public/index.html:5858 through public/index.html:5865). The row itself still has access_granted set. The payment.failed handler does not clear that column (server.js:2536).

POST /api/share-transcode uses requireAuth (server.js:1007), so the conversion request fails with that same 403. The share code throws when the response is not ok (public/share-video.js:191 through public/share-video.js:202). On iOS the Facebook export then continues with the unconverted file, marked convertFailed and preferImageForFacebook (public/share-video.js:245 through public/share-video.js:255). The export is degraded. It is not blocked. Other browsers then try a local conversion (public/share-video.js:257).

A row with manual_free set still passes requireAuth even when status is past_due (server.js:329). If access_granted is 0, requireAuth stops first with "Account access has been revoked. Contact support." (server.js:324 through server.js:326). payment.failed does not set access_granted to 0.

### What is still allowed

POST /api/share-tts and POST /api/share-bg-image call userHasAccess when their own requireAuth setting is on. userHasAccess treats past_due as allowed when access_granted is set (server.js:651 through server.js:657). They stay subject to their usual limits. The feature must be enabled, the daily limit must be above zero, the server must have an XAI key, and the daily quota still applies (server.js:1926 through server.js:1945 and server.js:1962 through server.js:1964 for voice; server.js:2163 through server.js:2169 and server.js:2183 through server.js:2185 for backgrounds).

When those two routes refuse someone, the status is 401, not the chat 403. Voice says "Sign in with an active account to create voice videos." (server.js:1940 through server.js:1943). Backgrounds say "Sign in to use AI verse backgrounds." (server.js:2169).

### No card prompt in the app

Nothing in the app asks the customer to update their card. There is no update-payment link in the app. The public HTML and JavaScript contain no update payment text and no past_due text. The only update payment link is inside the payment-failed email (server.js:2545). That email is an open mismatch, listed below. This document does not change it.

### How someone becomes past_due today

On current main, a Whop payment.failed event sets status to past_due and does not change access_granted (server.js:2536). The webhook calls that handler for payment.failed (server.js:2747 through server.js:2748).

Whop membership events that the server actually handles treat past_due differently. mapWhopStatusToUserStatus maps past_due to canceled (server.js:636). activateWhopMembership then sets access_granted to 0 unless the mapped status is trialing or active (server.js:2441 through server.js:2442 and server.js:2460 through server.js:2468). The handled membership events are membership.activated, membership.went_valid, and membership.created (server.js:2723 through server.js:2724). membership.deactivated, membership.went_invalid, and membership.canceled are forced to canceled before that same function runs (server.js:2725 through server.js:2726). membership.updated is not handled. It is ignored (server.js:2749 through server.js:2750). A payment.succeeded event that carries a membership object also runs activateWhopMembership (server.js:2727 through server.js:2730), so that path uses the same map.

A Stripe customer.subscription.updated or customer.subscription.deleted event can also copy the Stripe subscription status onto the row as Stripe sent it (server.js:2680 through server.js:2691). If Stripe sends past_due, the row status becomes past_due. The Whop cause path in this policy is payment.failed.

Draft pull request 32 (https://github.com/SAW72/word-in-context/pull/32, head 2e98537354e32f0dd3ce72096cf46535f74aa82f) proposes aligning the membership path. On that draft, mapWhopStatusToUserStatus returns past_due for a past_due membership (server.js:648 on that commit). An existing account is then set to status past_due without writing access_granted (server.js:2501 through server.js:2510 on that commit). The pull request is still a draft. It has not merged. Until it merges, main keeps the behavior above: handled membership events map past_due to canceled and clear access.

## 2. Cause of a failed payment

If the customer's card caused the failure, that is on the customer and limited access stands. Card causes include a decline, an expired card, and insufficient funds.

If Twic's system or Whop's system caused the failure, Whop has to figure it out.

Twic cannot currently tell those causes apart. Every Whop payment.failed event marks the row past_due the same way (server.js:2536). The handler reads the email and the manage link. It does not read a failure reason. The customer stays limited until the past_due state is resolved. A customer who reports a failure caused by Twic or by Whop is escalated to Whop.

There is no automatic detection of the cause. There is no automatic restored access. Any manual restore process is a separate proposal and is waiting on Spencer.

## 3. Known mismatches

These are open items. This document does not fix them. They stay as written until Spencer decides.

1. The comment in userHasAccess says past_due access is kept while Whop retries billing, and that membership.deactivated cuts access off (server.js:655). The exact comment is: `past_due: keep access while Whop retries billing; membership.deactivated cuts access off`. Chat is already denied for a past_due customer who is not manual_free.

2. The payment.failed log says access is kept until Whop deactivates the membership (server.js:2537). The log text is: `marked ${email} past_due (access kept until Whop deactivates membership)`. requireAuth does not keep chat access for that status.

3. The payment-failed email tells the customer to update their payment method so access is not interrupted (server.js:2544). The exact line is: `Please update your payment method so your access isn't interrupted:`. That is not true today. Chat already returns "Subscription required or trial expired." The same email includes an update payment link (server.js:2545). The app does not.

4. The Account panel says "Access revoked" (public/index.html:5865 and public/index.html:7164) rather than a payment message. That wording shows up because the 403 body has no access_granted field, so the panel treats the account as revoked. The panel does not say that a payment failed.

All four items are held pending Spencer.
