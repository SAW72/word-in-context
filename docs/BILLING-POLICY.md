# Billing policy for past-due access

Internal policy. History: on 25 October 2026 Spencer decided that past due customers are limited. On 26 October 2026 Spencer decided that a customer who already has a paid account keeps it when the payment problem is on Whop's end. This document describes the behavior that arrives with commit 5424604142e991be19f84d64e015f797a1489260 once it is merged. That commit changes the app and the server; it does not change the email text or the public terms.

## 1. Past due customers

Spencer decided on 26 October 2026: "If they already have a paid account they should keep if it's on whops end." This replaces the 25 October rule that past due customers are limited, for Whop. The behavior below is built in commit 5424604142e991be19f84d64e015f797a1489260 on top of main cbe3dad30331661132bf41cddae8ec7234801ddf. That commit is not merged yet. Until it merges, main still limits Whop past due customers. Line numbers below are on that commit unless they say cbe3dad3.

One rule decides past due access for the app (requireAuth, server.js:324 and server.js:349), password login (server.js:1690) and the magic link (userHasAccess, server.js:675 and server.js:681). The rule is pastDueAccess (lib/security.js:478 through lib/security.js:485). Chat uses requireAuth (server.js:2970). POST /api/share-tts and POST /api/share-bg-image use userHasAccess when their own sign in setting is on (server.js:1973 and server.js:2202), so they follow the login result. When they refuse someone, the status is 401 with their own text (server.js:1975 and server.js:2203). A refused app request gets 403 with "Subscription required or trial expired." (server.js:351).

### Whop past due: keeps access while Whop retries

A Whop past due customer keeps full access to the app, password login and the magic link while Whop retries the payment. All of these must be true (lib/security.js:479 through lib/security.js:481):

1. access_granted is set.
2. status is past_due. A Whop payment.failed event sets it (server.js:2601).
3. whop_status is past_due. The same payment.failed event records it when the event carries a usable time and names the account's own membership (lib/security.js:383 and lib/security.js:408).
4. The account has no Stripe customer id and no Stripe subscription id on file.

Access ends when Whop deactivates or cancels the membership (server.js:2847). KNOWN GAP, pending a decision: a Whop membership event that itself reports past_due or unresolved maps to canceled and clears access (server.js:657 through server.js:661), even while Whop may still be retrying. The code is unchanged. Any unclear Whop record fails closed and the customer is limited: no Whop status recorded yet (including accounts last updated before Whop status was recorded), an unknown status, an event with no usable time, or a different membership.

### Stripe only past due: unchanged

A Stripe only past due customer has a Stripe id, no Whop membership or member id, and no Whop status. Nothing changes for them. Password login and the magic link still issue a token (lib/security.js:483 and server.js:681). The app still refuses them with "Subscription required or trial expired." because requireAuth accepts only the Whop case (server.js:345 and server.js:349). This mismatch is an open item for Spencer.

### Free forever (manual_free): never past due, never downgraded, no billing mail

A free forever account is never marked past due, is never downgraded by a billing event, and gets no billing mail. On main cbe3dad3:

1. payment.failed returns before it writes status or sends the payment failed email (server.js:2599 on cbe3dad3). A Stripe subscription update skips the account (server.js:2750 on cbe3dad3). A Whop activation keeps its status and trial end (server.js:2510 on cbe3dad3).
2. A Whop deactivation, cancel or invalid membership leaves the account unchanged (server.js:2499 on cbe3dad3). A Stripe checkout leaves it unchanged (server.js:2634 on cbe3dad3). An email only payment.succeeded leaves it unchanged (server.js:2858 on cbe3dad3).
3. No trial ending reminder (server.js:2568 on cbe3dad3), no Whop login email on activation (server.js:2538 on cbe3dad3), no payment failed email (server.js:2599 on cbe3dad3), and no tester go paid email (lib/tester-expiry.js:18 on cbe3dad3).
4. Free forever keeps access whatever its status says (server.js:342 and server.js:677 on cbe3dad3). The past due build does not change this.

Only an admin can change a free forever account: Remove free (server.js:2410 through server.js:2422 on cbe3dad3) or turning access off (server.js:2418 on cbe3dad3).

### Stripe to Whop movers: not yet covered

A customer who moved from Stripe to Whop and still has a Stripe id on file is not yet covered. While past due on Whop, they are limited the same way as today. A fix is an open item for Spencer.

## 2. Cause of a failed payment

If the customer's card caused the failure, that is on the customer. Card causes include a decline, an expired card, and insufficient funds. What happens to access depends on the case in section 1:

1. Whop retry case (section 1, all four conditions true): the customer keeps access while Whop retries. Access ends when Whop deactivates or cancels the membership.
2. Every other past due row: the customer stays limited until the past_due state is resolved.

If Twic's system or Whop's system caused the failure, Whop has to figure it out.

Twic cannot currently tell those causes apart. The webhook sends every Whop payment.failed event to the same handler (server.js:2872), and the handler marks the row past_due the same way (server.js:2601). It reads the email and the manage link. It does not read a failure reason. A customer who reports a failure caused by Twic or by Whop is escalated to Whop.

There is no automatic detection of the cause. There is no automatic restored access beyond the Whop retry case. Any manual restore process is a separate proposal and is waiting on Spencer.

## 3. Known mismatches

These are open items. This document does not fix them. They stay as written until Spencer decides. Each states what is true after commit 5424604.

1. The comment in userHasAccess now matches the rule (server.js:679 through server.js:680). The exact comment is: `past_due: pastDueAccess. A Whop retry keeps access until membership.deactivated; a Stripe only row keeps its old login and magic link result; every other past_due row fails closed.` This item is closed once the commit is merged.

2. The payment.failed log says access is kept until Whop deactivates the membership (server.js:2602). The log text is: `marked ${email} past_due (access kept until Whop deactivates membership)`. That is true for the Whop retry case. It is not true for every other past due row, which stays limited, and the same line is logged for both.

3. The payment failed email tells the customer to update their payment method so access is not interrupted (server.js:2609). The exact line is: `Please update your payment method so your access isn't interrupted:`. That is true for the Whop retry case. It is not true for every other past due row, which is already limited when the email arrives. The same email includes an update payment link (server.js:2610). The app has no update payment link.

4. The Account panel. In the Whop retry case /api/me returns 200 and the panel shows the raw status text, past_due, with the trial end date when one is stored (public/index.html:7183 through public/index.html:7186 and public/index.html:5883 through public/index.html:5886). It does not say that a payment failed. For every other past due row /api/me returns 403 with only an error field, so the panel shows "Access revoked" (public/index.html:7186 and public/index.html:5886) rather than a payment message.

5. Stripe only past due: password login and the magic link issue a token, but the app refuses with 403 (section 1). This mismatch is unchanged from before.

6. KNOWN GAP: a Whop membership event that reports past_due or unresolved clears access (section 1, server.js:657).

7. Stripe to Whop movers are not yet covered (section 1).

All seven items are held pending Spencer.
