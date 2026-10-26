'use strict';
/**
 * Copy for the one email a tester gets when tester access ends.
 * Spencer reviews this text before merge. Plain words only, no dashes in the prose.
 */
const SUBJECT = 'Your tester access has ended. Start your free trial of The Word in Context';

function testerExpiredEmail({ appBaseUrl }) {
  const base = String(appBaseUrl || '').replace(/\/$/, '');
  // The signup section opens with the paid plan checkout form; #pricing leads with the tester card.
  const subscribeUrl = `${base}/#signup`;
  const html = `
    <p>Thank you for testing <strong>The Word in Context</strong>.</p>
    <p>Your free tester access has now ended, so the app is locked on your account.</p>
    <p>To keep studying, start your 7-day free trial of Pro. Pick monthly or yearly; a card is required, and billing starts when the trial ends. Use the same email address so your account carries over.</p>
    <p><a href="${subscribeUrl}">Start my 7-day free trial</a></p>
    <p>Thank you for your help and feedback while testing.</p>
    <p><small>Need help? Email <a href="mailto:hello@stewardoftheking.com">hello@stewardoftheking.com</a>.</small></p>
  `;
  return { subject: SUBJECT, html, subscribeUrl };
}

testerExpiredEmail.SUBJECT = SUBJECT;
module.exports = testerExpiredEmail;
