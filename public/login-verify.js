const token = new URLSearchParams(location.search).get('token');
const adminSignin = new URLSearchParams(location.search).get('admin_signin');

const REFUSAL = {
  link_used: {
    message: 'This sign-in link was already used. If that was you, open the app. Otherwise ask for a new link.',
    href: '/app',
    label: 'Open the app',
  },
  link_invalid: {
    message: 'This sign-in link is not valid. Ask for a new link, or sign in from the home page.',
    href: '/#login',
    label: 'Go to sign in',
  },
  link_expired: {
    message: 'This sign-in link has expired. Ask for a new link, or sign in from the home page.',
    href: '/#login',
    label: 'Go to sign in',
  },
  no_access: {
    message: "Your account doesn't have access right now. Your trial may have ended. Choose a plan to keep studying.",
    href: '/#signup',
    label: 'Choose a plan',
  },
  no_account: {
    message: "We couldn't find an account for this link. Ask for a new link.",
    href: '/',
    label: 'Return to the site',
  },
  network: {
    message: "We couldn't reach the server. Check your connection, then open the link again.",
  },
};

function refusalKind(data) {
  const code = data && data.code;
  if (code && REFUSAL[code]) return code;
  const error = data && data.error;
  if (error === 'No account with that email') return 'no_account';
  if (error === 'Account access revoked' || error === 'Account access has been revoked or trial expired.') return 'no_access';
  return 'link_invalid';
}

function showLoginNotice(message, link) {
  const status = document.getElementById('login-status');
  if (status) status.textContent = '';
  let msg = document.getElementById('login-msg');
  if (!msg) {
    msg = document.createElement('p');
    msg.id = 'login-msg';
    const heading = document.querySelector('h2');
    if (heading && heading.parentNode) heading.parentNode.insertBefore(msg, heading.nextSibling);
    else document.body.appendChild(msg);
  }
  msg.setAttribute('role', 'alert');
  msg.textContent = message;
  let next = document.getElementById('login-next');
  if (!next) {
    next = document.createElement('p');
    next.id = 'login-next';
    if (msg.parentNode) msg.parentNode.insertBefore(next, msg.nextSibling);
  }
  if (next) {
    while (next.firstChild) next.removeChild(next.firstChild);
    if (link && link.href && link.label) {
      const anchor = document.createElement('a');
      anchor.className = 'login-next';
      anchor.href = link.href;
      anchor.textContent = link.label;
      next.appendChild(anchor);
    }
  }
  document.title = 'Sign-in link not valid | The Word in Context';
}

function showRefusal(kind) {
  const spec = REFUSAL[kind] || REFUSAL.link_invalid;
  const link = spec.href && spec.label ? { href: spec.href, label: spec.label } : null;
  showLoginNotice(spec.message, link);
}

function finishSignin(data) {
  if (data && data.token) {
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('user_email', data.email || '');
    window.location.href = '/app';
    return;
  }
  showRefusal(refusalKind(data));
}

function showLoginError() {
  showRefusal('network');
}

function clearAdminSigninQuery() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('admin_signin')) return;
    url.searchParams.delete('admin_signin');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch (e) {}
}

if (adminSignin) {
  clearAdminSigninQuery();
  fetch('/api/admin-signin/redeem?token=' + encodeURIComponent(adminSignin))
    .then((r) => r.json().then((data) => data).catch(() => null))
    .then((data) => {
      clearAdminSigninQuery();
      finishSignin(data);
    })
    .catch(() => {
      clearAdminSigninQuery();
      showLoginError();
    });
} else if (!token) {
  showLoginNotice('No token provided.', { href: '/', label: 'Go to The Word in Context' });
} else {
  fetch('/api/verify-magic?token=' + encodeURIComponent(token))
    .then((r) => r.json())
    .then(finishSignin)
    .catch(showLoginError);
}
