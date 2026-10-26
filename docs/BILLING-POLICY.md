# Billing policy for past-due access

Internal policy. History: on 25 October 2026 Spencer decided that past due customers are limited. On 26 October 2026 Spencer decided that a customer who already has a paid account keeps it when the payment problem is on Whop's end. This document describes the behavior merged to main as 0b590b8684544ca64bd4fab2d7a17af0908a1d92 by PR #42 (https://github.com/SAW72/word-in-context/pull/42). That change updates the app and the server; it does not change the email text or the public terms.

## 1. Past due customers

Spencer decided on 26 October 2026: "If they already have a paid account they should keep if it's on whops end." This replaces the 25 October rule that past due customers are limited, for Whop. The behavior below is merged to main as 0b590b8684544ca64bd4fab2d7a17af0908a1d92 by PR #42 (https://github.com/SAW72/word-in-context/pull/42). Line numbers below are on main 0b590b8684544ca64bd4fab2d7a17af0908a1d92 (0b590b86).

One rule decides past due access for the app (requireAuth, server.js:326 and server.js:351), password login (server.js:1692) and the magic link (userHasAccess, server.js:677 and server.js:683). The rule is pastDueAccess (lib/security.js:497 through lib/security.js:509). Chat uses requireAuth (server.js:2995). POST /api/share-tts and POST /api/share-bg-image use userHasAccess when their own sign in setting is on (server.js:1975 and server.js:2204), so they follow the login result. When they refuse someone, the status is 401 with their own text (server.js:1976 and server.js:2205). A refused app request gets 403 with "Subscription required or trial expired." (server.js:353).

### Whop past due: keeps access while Whop retries

A Whop past due customer keeps full access to the app, password login and the magic link for up to 7 days from whop_event_at while Whop retries the payment. All of these must be true (pastDueAccess, lib/security.js:497 on 0b590b86):

1. access_granted is set.
2. status is past_due. A Whop payment.failed event sets it only for a renewal (billing_reason subscription_cycle) of the account's own stored membership that is not stale (lib/security.js:525 through lib/security.js:526 and server.js:2604 on 0b590b86).
3. whop_status is past_due. The same payment.failed event records it when the event carries a usable time and names the account's own membership (lib/security.js:394, lib/security.js:420 and lib/security.js:425 through lib/security.js:426 on 0b590b86).
4. The account has no Stripe customer id and no Stripe subscription id on file.
5. The account has a stored Whop membership id, and now is at most 7 days after whop_event_at (lib/security.js:483 and lib/security.js:501 through lib/security.js:504 on 0b590b86). The cap is checked on every request.

A stale event (older than whop_event_at) or an event for a different membership is skipped and does not mark the account past_due (lib/security.js:423 and lib/security.js:425 through lib/security.js:426 on 0b590b86). Doc note of current behavior: a skipped payment.failed still sends the payment failed email, because the email is sent after the past_due check whatever its result (server.js:2606 through server.js:2614 on 0b590b86). A Whop payment.succeeded for the account's own membership clears past_due back to active and leaves access_granted as it is (server.js:2830 through server.js:2834 on 0b590b86). Access ends after the 7 days, or when Whop deactivates or cancels the membership (server.js:2869 through server.js:2870 on 0b590b86). KNOWN GAP, pending a decision: a Whop membership event that itself reports past_due or unresolved maps to canceled and clears access (server.js:659 through server.js:663 on 0b590b86), even while Whop may still be retrying. The code is unchanged. Any unclear Whop record fails closed and the customer is limited: no Whop status recorded yet (including accounts last updated before Whop status was recorded), an unknown status, an event with no usable time, or a different membership.

### Stripe only past due: unchanged

A Stripe only past due customer has a Stripe id, no Whop membership or member id, and no Whop status. Nothing changes for them. Password login and the magic link still issue a token (lib/security.js:507 and server.js:683). The app still refuses them with "Subscription required or trial expired." because requireAuth accepts only the Whop case (server.js:347 and server.js:351). This mismatch is an open item for Spencer.

### Free forever (manual_free): never past due, never downgraded, no billing mail

A free forever account is never marked past due, is never downgraded by a billing event, and gets no billing mail. On main 0b590b86:

1. payment.failed returns before it writes status or sends the payment failed email (server.js:2601). A Stripe subscription update skips the account (server.js:2755). A Whop activation keeps its status and trial end (server.js:2512 through server.js:2513).
2. A Whop deactivation, cancel or invalid membership leaves the account unchanged (server.js:2501). A Stripe checkout leaves it unchanged (server.js:2639). An email only payment.succeeded leaves it unchanged (server.js:2883).
3. No trial ending reminder (server.js:2570), no Whop login email on activation (server.js:2540), no payment failed email (server.js:2601), and no tester go paid email (lib/tester-expiry.js:18).
4. Free forever keeps access whatever its status says (server.js:345 and server.js:683). The past due build does not change this.

An admin changes a free forever account with Remove free or by turning access off (server.js:2407 through server.js:2428; the write is server.js:2420 through server.js:2421). A Whop event can also change it. A Whop activation, or a payment.succeeded that carries a membership (server.js:2873 through server.js:2876), whose status maps to trialing or active sets access_granted to 1 and writes the Whop membership id and member id when the event carries them (server.js:2512 through server.js:2520). So the next such Whop event turns access back on after an admin turned it off. Status, trial end and the free forever flag stay as they are. Every Whop event for the account also updates its Whop status columns (whop_status, whop_trial_end, whop_event_at) (server.js:2865 and server.js:2806).

### Stripe to Whop movers: not yet covered

A customer who moved from Stripe to Whop and still has a Stripe id on file is not yet covered. While past due on Whop, they are limited the same way as today. A fix is an open item for Spencer.

## 2. Cause of a failed payment

If the customer's card caused the failure (a decline, an expired card, or insufficient funds), the customer needs to update their payment method.

What happens to access depends on the case in section 1:

1. Whop retry case (section 1, all five conditions true): the customer keeps access for up to 7 days from whop_event_at while Whop retries. Access ends after the 7 days, or when Whop deactivates or cancels the membership.
2. Every other past due row: the customer stays limited until the past_due state is resolved.

If Twic's system caused the failure, Twic is responsible: we fix the cause and the customer should not lose paid access because of it. If Whop's system caused the failure, we report it to Whop support, and under Spencer's 26 October 2026 decision a customer who already has a paid account should keep access. The manual restore process for both cases is pending Spencer (see below).

Twic cannot currently tell those causes apart. The webhook sends every Whop payment.failed event to the same handler (server.js:2897 through server.js:2898), and the handler marks the row past_due the same way (server.js:2604). It reads the email and the manage link. It does not read a failure reason.

A customer who reports a failure caused by Twic is handled by Twic support. A failure caused by Whop is reported to Whop support, and Twic stays the customer's point of contact until it is resolved.

There is no automatic detection of the cause. There is no automatic restored access beyond the Whop retry case. Any manual restore process is a separate proposal and is waiting on Spencer.

## 3. Known mismatches

These are open items. This document does not fix them. They stay as written until Spencer decides. Each states what is true on main 0b590b8684544ca64bd4fab2d7a17af0908a1d92.

1. The comment in userHasAccess now matches the rule (server.js:681 through server.js:682 on 0b590b86). The exact comment is: `past_due: pastDueAccess. A Whop retry keeps access for up to 7 days after its last Whop event; a Stripe only row keeps its old login and magic link result; every other past_due row fails closed.` This item is closed by the merge of PR #42.

2. The payment.failed log says access is kept up to 7 days while Whop retries (server.js:2605 on 0b590b86). The log text is: `marked ${email} past_due (access kept up to 7 days while Whop retries)`. That is true for the Whop retry case. It is not true for every other past due row, which stays limited, and the same line is logged for both.

3. The payment failed email tells the customer to update their payment method so access is not interrupted (server.js:2614). The exact line is: `Please update your payment method so your access isn't interrupted:`. That is true for the Whop retry case. It is not true for every other past due row, which is already limited when the email arrives. The same email includes an update payment link (server.js:2615). The app has no update payment link.

4. The Account panel. In the Whop retry case /api/me returns 200 and the panel shows the raw status text, past_due, with the trial end date when one is stored (public/index.html:7183 through public/index.html:7186 and public/index.html:5883 through public/index.html:5886). It does not say that a payment failed. For every other past due row /api/me returns 403 with only an error field, so the panel shows "Access revoked" (public/index.html:7186 and public/index.html:5886) rather than a payment message.

5. Stripe only past due: password login and the magic link issue a token, but the app refuses with 403 (section 1). This mismatch is unchanged from before.

6. KNOWN GAP: a Whop membership event that reports past_due or unresolved clears access (section 1, server.js:662).

7. Stripe to Whop movers are not yet covered (section 1).

All seven items are held pending Spencer.
