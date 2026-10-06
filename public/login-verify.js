const token = new URLSearchParams(location.search).get('token');
if (!token) {
  document.body.innerHTML = '<p>No token provided. <a href="/">Go to The Word in Context</a></p>';
} else {
  fetch('/api/verify-magic?token=' + encodeURIComponent(token))
    .then(r => r.json())
    .then(data => {
      if (data.token) {
        localStorage.setItem('auth_token', data.token);
        localStorage.setItem('user_email', data.email || '');
        window.location.href = '/app';
      } else {
        document.body.innerHTML = '<p>Login failed: ' + (data.error || 'unknown') + '<br><a href="/">Return to site</a></p>';
      }
    })
    .catch(() => document.body.innerHTML = '<p>Login error. Try the link again or <a href="/">return to the site</a>.</p>');
}
