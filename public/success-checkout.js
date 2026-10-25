const script = document.currentScript;
const provider = (script && script.getAttribute('data-payment-provider')) || 'stripe';
const params = new URLSearchParams(location.search);
const sessionId = params.get('session_id') || '';
let email = (params.get('email') || '').trim().toLowerCase();
try {
  if (!email) email = sessionStorage.getItem('wic_checkout_email') || '';
} catch (e) {}
const body = sessionId
  ? { sessionId }
  : (provider === 'whop' && email ? { email } : null);
if (body) {
  fetch('/api/complete-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(r => r.json())
    .then(data => {
      const el = document.getElementById('status');
      if (el) el.textContent = data.message || data.error || "Open the login link we just emailed you. Once you're in, set a password from Account.";
    })
    .catch(() => {
      const el = document.getElementById('status');
      if (el) el.textContent = "Open the login link we just emailed you. Once you're in, set a password from Account.";
    });
} else {
  const el = document.getElementById('status');
  if (el) el.textContent = "Open the login link we just emailed you. Once you're in, set a password from Account.";
}
