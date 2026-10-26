'use strict';
/**
 * Copy for the one email a tester gets when tester access ends.
 * Spencer reviews this text before merge. Plain words only, no dashes in the prose.
 */
const SUBJECT = 'Your tester access to The Word in Context has ended';

function testerExpiredEmail({ appBaseUrl }) {
  const base = String(appBaseUrl || '').replace(/\/$/, '');
  const subscribeUrl = `${base}/#pricing`;
  const html = `
    <p>Thank you for testing <strong>The Word in Context</strong>.</p>
    <p>Your free tester access has now ended, so the app is locked on your account.</p>
    <p>To keep studying, please sign up for a paid subscription (monthly or yearly). Use the same email address so your account carries over.</p>
    <p><a href="${subscribeUrl}">Choose a plan and subscribe</a></p>
    <p>Thank you for your help and feedback while testing.</p>
    <p><small>Need help? Email <a href="mailto:hello@stewardoftheking.com">hello@stewardoftheking.com</a>.</small></p>
  `;
  return { subject: SUBJECT, html, subscribeUrl };
}

testerExpiredEmail.SUBJECT = SUBJECT;
module.exports = testerExpiredEmail;
