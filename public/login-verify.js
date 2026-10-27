const token = new URLSearchParams(location.search).get('token');
const adminSignin = new URLSearchParams(location.search).get('admin_signin');

function finishSignin(data) {
  if (data.token) {
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('user_email', data.email || '');
    window.location.href = '/app';
  } else {
    document.body.innerHTML = '<p>Login failed: ' + (data.error || 'unknown') + '<br><a href="/">Return to site</a></p>';
  }
}

function showLoginError() {
  document.body.innerHTML = '<p>Login error. Try the link again or <a href="/">return to the site</a>.</p>';
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
    .then(r => r.json())
    .then((data) => {
      clearAdminSigninQuery();
      finishSignin(data);
    })
    .catch(() => {
      clearAdminSigninQuery();
      showLoginError();
    });
} else if (!token) {
  document.body.innerHTML = '<p>No token provided. <a href="/">Go to The Word in Context</a></p>';
} else {
  fetch('/api/verify-magic?token=' + encodeURIComponent(token))
    .then(r => r.json())
    .then(finishSignin)
    .catch(showLoginError);
}
