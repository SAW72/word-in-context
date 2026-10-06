    function isDarkMode() {
      return localStorage.getItem('dark_mode') === 'true';
    }

    function applyDarkMode(enabled) {
      document.documentElement.setAttribute('data-theme', enabled ? 'dark' : 'light');
      localStorage.setItem('dark_mode', enabled ? 'true' : 'false');
      const btn = document.getElementById('dark-mode-btn');
      if (btn) btn.textContent = enabled ? '☀️' : '🌙';
      const metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) metaTheme.setAttribute('content', enabled ? '#0f1419' : '#2c3e50');
    }

    function initDarkMode() {
      applyDarkMode(isDarkMode());
      const btn = document.getElementById('dark-mode-btn');
      if (btn) btn.addEventListener('click', () => applyDarkMode(!isDarkMode()));
    }

    function showLoginModal() {
      const modal = document.getElementById('login-modal');
      if (modal) {
        modal.style.display = 'flex';
        const emailInput = document.getElementById('modal-login-email');
        if (emailInput) setTimeout(() => emailInput.focus(), 50);
        setTimeout(addPasswordToggles, 50);
      }
    }

    function closeLoginModal() {
      const modal = document.getElementById('login-modal');
      if (modal) modal.style.display = 'none';
      const err = document.getElementById('modal-login-error');
      const suc = document.getElementById('modal-login-success');
      if (err) err.style.display = 'none';
      if (suc) suc.style.display = 'none';
    }

    function addPasswordToggles() {
      document.querySelectorAll('input[type="password"]').forEach(input => {
        if (input.parentElement && input.parentElement.classList.contains('password-wrapper')) return;
        const wrapper = document.createElement('span');
        wrapper.className = 'password-wrapper';
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);
        const toggle = document.createElement('span');
        toggle.className = 'password-toggle';
        toggle.textContent = '🙈';
        toggle.setAttribute('aria-label', 'Show password');
        wrapper.appendChild(toggle);
        toggle.addEventListener('click', () => {
          if (input.type === 'password') {
            input.type = 'text';
            toggle.textContent = '👁';
          } else {
            input.type = 'password';
            toggle.textContent = '🙈';
          }
        });
      });
    }

    document.getElementById('login-btn')?.addEventListener('click', showLoginModal);

    document.getElementById('modal-login-form')?.addEventListener('submit', async function(e) {
      e.preventDefault();
      const email = document.getElementById('modal-login-email').value;
      const password = document.getElementById('modal-login-password').value;
      const errDiv = document.getElementById('modal-login-error');
      const successDiv = document.getElementById('modal-login-success');
      if (errDiv) errDiv.style.display = 'none';
      if (successDiv) successDiv.style.display = 'none';
      try {
        const { res, data } = await apiPost('/api/login', { email, password });
        if (res.ok && data.token) {
          localStorage.setItem('auth_token', data.token);
          localStorage.setItem('user_email', data.email || email);
          if (successDiv) {
            successDiv.textContent = 'Logged in! Redirecting to the app...';
            successDiv.style.display = 'block';
          }
          setTimeout(() => { window.location.href = '/app'; }, 550);
        } else {
          const errText = (data && data.error) || 'Login failed. Check email/password or use magic link.';
          if (errDiv) {
            errDiv.textContent = errText;
            errDiv.style.display = 'block';
          }
        }
      } catch (err) {
        if (errDiv) {
          errDiv.textContent = err.message || 'Network error. Please try again later.';
          errDiv.style.display = 'block';
        }
      }
    });

    document.getElementById('modal-magic-link')?.addEventListener('click', async function(e) {
      e.preventDefault();
      const email = document.getElementById('modal-login-email')?.value.trim();
      const errDiv = document.getElementById('modal-login-error');
      const successDiv = document.getElementById('modal-login-success');
      if (errDiv) errDiv.style.display = 'none';
      if (successDiv) successDiv.style.display = 'none';
      if (!email) { alert('Enter your email first.'); return; }
      try {
        const { res, data } = await apiPost('/api/request-login', { email });
        if (res.ok && successDiv) {
          successDiv.textContent = data.message || 'Check your email for the magic login link.';
          successDiv.style.display = 'block';
        } else if (errDiv) {
          errDiv.textContent = (data && data.error) || 'Could not send link.';
          errDiv.style.display = 'block';
        }
      } catch (err) {
        if (errDiv) {
          errDiv.textContent = err.message || 'Network error.';
          errDiv.style.display = 'block';
        }
      }
    });

    document.getElementById('login-modal')?.addEventListener('click', function(e) {
      if (e.target === this) closeLoginModal();
    });

    initDarkMode();
    addPasswordToggles();
  
document.getElementById('login-modal-close')?.addEventListener('click', closeLoginModal);
