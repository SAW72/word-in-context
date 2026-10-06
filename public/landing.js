    (function hydrateWicConfig() {
      const el = document.getElementById('wic-config');
      if (!el) return;
      try {
        const cfg = JSON.parse(el.textContent);
        window.__WIC_CONFIG__ = cfg;
        if (cfg && cfg.assetVersion != null) window.__WIC_ASSET_V__ = cfg.assetVersion;
      } catch (e) {}
    })();

    async function apiPost(path, body) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('You appear to be offline. Connect to the internet and try again.');
      }
      let res;
      try {
        res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (_) {
        const host = (typeof location !== 'undefined' && location.hostname) || '';
        const onLocal = host === 'localhost' || host === '127.0.0.1';
        if (onLocal) {
          throw new Error('Cannot reach the local server. Run npm start in the project folder, then reload.');
        }
        throw new Error('Cannot reach the server. Open https://www.thewordincontext.org and try again.');
      }
      const text = await res.text();
      let data = {};
      if (text) {
        try { data = JSON.parse(text); } catch (_) {
          const hint = res.status >= 500
            ? `Server error (${res.status}). Wait a moment and try again.`
            : 'Unexpected server response. Hard-refresh the page (Cmd+Shift+R) and try again.';
          throw new Error(hint);
        }
      }
      return { res, data };
    }

    function showLoginModal() {
      const modal = document.getElementById('login-modal');
      if (modal) {
        modal.style.display = 'flex';
        const trialEmail = document.getElementById('trial-email');
        const testerEmail = document.getElementById('tester-email');
        const modalEmail = document.getElementById('modal-login-email');
        if (modalEmail) {
          if (trialEmail && trialEmail.value) modalEmail.value = trialEmail.value;
          else if (testerEmail && testerEmail.value) modalEmail.value = testerEmail.value;
          setTimeout(() => modalEmail.focus(), 50);
        }
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
      const pwInputs = document.querySelectorAll('input[type="password"]');
      pwInputs.forEach(input => {
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
            toggle.setAttribute('aria-label', 'Hide password');
          } else {
            input.type = 'password';
            toggle.textContent = '🙈';
            toggle.setAttribute('aria-label', 'Show password');
          }
        });
      });
    }

    document.addEventListener('DOMContentLoaded', function() {
    const headerLoginBtn = document.getElementById('header-login-btn');
    if (headerLoginBtn) headerLoginBtn.addEventListener('click', showLoginModal);
    const loginModalClose = document.getElementById('login-modal-close');
    if (loginModalClose) loginModalClose.addEventListener('click', closeLoginModal);
    // === 7-Day Trial (Whop checkout) — creates account locally, then redirects to Whop. No auto-login. ===
    const trialForm = document.getElementById('trial-form');
    if (trialForm) {
      trialForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        const email = document.getElementById('trial-email').value;
        const password = document.getElementById('trial-password').value;
        const billingInput = document.querySelector('input[name="trial-billing"]:checked');
        const billing = billingInput ? billingInput.value : 'monthly';
        try {
          const { res, data } = await apiPost('/api/create-checkout', { email, password, billing });
          if (data.url) {
            try { sessionStorage.setItem('wic_checkout_email', email.trim().toLowerCase()); } catch (err) {}
            window.location.href = data.url;
          } else {
            alert(data.error || 'Something went wrong.');
          }
        } catch (err) {
          alert(err.message || 'Network error. Please try again later.');
        }
      });
    }

    // === 14-day Tester signup — creates the account, sends magic link for convenience,
    // then immediately auto-logs the user in with a JWT and redirects to /app.
    // This matches the 7-day paid trial experience the user requested.
    const testerSignupForm = document.getElementById('tester-signup-form');
    try {
      const inviteFromUrl = new URLSearchParams(window.location.search || '').get('invite');
      const inviteInput = document.getElementById('tester-invite');
      if (inviteFromUrl && inviteInput) {
        inviteInput.value = inviteFromUrl;
        inviteInput.style.display = 'none';
      }
    } catch (e) {}
    if (testerSignupForm) {
      testerSignupForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        const email = document.getElementById('tester-email').value;
        const password = document.getElementById('tester-password').value;
        const errDiv = document.getElementById('tester-signup-error');
        const successDiv = document.getElementById('tester-signup-success');
        if (errDiv) errDiv.style.display = 'none';
        if (successDiv) successDiv.style.display = 'none';

        try {
          const inviteInput = document.getElementById('tester-invite');
          let inviteToken = inviteInput ? inviteInput.value.trim() : '';
          try {
            const q = new URLSearchParams(window.location.search || '');
            if (!inviteToken && q.get('invite')) inviteToken = q.get('invite');
          } catch (e) {}
          const { res, data } = await apiPost('/api/tester-signup', { email, password, inviteToken });

          if (res.ok) {
            if (testerSignupForm) testerSignupForm.style.display = 'none';
            if (successDiv) {
              successDiv.innerHTML = `Tester account created for <strong>${email}</strong>.<br>Use the Log in button at the top with your password, or check your email for a magic link.`;
              successDiv.style.display = 'block';
            }
          } else {
            if (errDiv) {
              errDiv.textContent = data.error || 'Something went wrong.';
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
    }

    // Unified password login inside the modal (works for both 7-day trial and 14-day tester accounts)
    const modalLoginForm = document.getElementById('modal-login-form');
    if (modalLoginForm) {
      modalLoginForm.addEventListener('submit', async function(e) {
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
            setTimeout(() => {
              window.location.href = '/app';
            }, 550);
          } else {
            const errText = (data && data.error) || 'Login failed. Check email/password or use magic link.';
            // Graceful fallback for accounts that have no password_hash yet (e.g. some admin-created accounts)
            if (/no password set|no account with that email/i.test(errText)) {
              if (errDiv) errDiv.style.display = 'none';
              if (successDiv) {
                successDiv.textContent = 'No password on file — sending a magic login link to your email...';
                successDiv.style.display = 'block';
              }
              try {
                const { res: magicRes, data: magicData } = await apiPost('/api/request-login', { email });
                if (magicRes.ok && successDiv) {
                  successDiv.textContent = magicData.message || 'Check your email for the secure magic login link.';
                } else if (successDiv) {
                  successDiv.textContent = (magicData && magicData.error) || 'Could not send magic link.';
                }
              } catch (magicErr) {
                if (successDiv) successDiv.textContent = magicErr.message || 'Could not send magic link right now.';
              }
            } else {
              if (errDiv) {
                errDiv.textContent = errText;
                errDiv.style.display = 'block';
              }
            }
          }
        } catch (err) {
          if (errDiv) {
            errDiv.textContent = err.message || 'Network error. Please try again later.';
            errDiv.style.display = 'block';
          }
        }
      });
    }

    // Magic link from inside the login modal
    const modalMagicLink = document.getElementById('modal-magic-link');
    if (modalMagicLink) {
      modalMagicLink.addEventListener('click', async function(e) {
        e.preventDefault();
        const emailInput = document.getElementById('modal-login-email');
        const email = emailInput ? emailInput.value.trim() : '';
        const errDiv = document.getElementById('modal-login-error');
        const successDiv = document.getElementById('modal-login-success');
        if (errDiv) errDiv.style.display = 'none';
        if (successDiv) successDiv.style.display = 'none';

        if (!email) {
          alert('Enter your email first.');
          return;
        }
        try {
          const { res, data } = await apiPost('/api/request-login', { email });
          if (res.ok) {
            if (successDiv) {
              successDiv.textContent = data.message || 'Check your email for the magic login link.';
              successDiv.style.display = 'block';
            }
          } else {
            if (errDiv) {
              errDiv.textContent = data.error || 'Could not send link.';
              errDiv.style.display = 'block';
            }
          }
        } catch (err) {
          if (errDiv) {
            errDiv.textContent = err.message || 'Network error.';
            errDiv.style.display = 'block';
          }
        }
      });
    }

    // Close modal when clicking outside the content box
    const loginModal = document.getElementById('login-modal');
    if (loginModal) {
      loginModal.addEventListener('click', function(e) {
        if (e.target === loginModal) closeLoginModal();
      });
    }

    const cfg = window.__WIC_CONFIG__ || {};
    const normalDays = cfg.trialDays || 7;
    const trialBtn = document.querySelector('#trial-form button');
    if (trialBtn) trialBtn.textContent = `Start ${normalDays}-Day Free Trial (card required after)`;

    // Invite gate is on in production; default required if config is missing (static file / stale cache).
    const inviteRequired = cfg.testerSignupInviteRequired !== false;
    const inviteInput = document.getElementById('tester-invite');
    if (inviteInput && inviteRequired) {
      inviteInput.required = true;
      inviteInput.setAttribute('aria-required', 'true');
      inviteInput.placeholder = 'Invite code (required)';
      if (!inviteInput.getAttribute('aria-label')) {
        inviteInput.setAttribute('aria-label', 'Invite code (required)');
      }
    }

    addPasswordToggles();

    const askJohnBtn = document.getElementById('btn-ask-john');
    if (askJohnBtn) {
      askJohnBtn.addEventListener('click', function(e) {
        e.preventDefault();
        function openJohn() {
          if (window.JohnPopup) window.JohnPopup.open('demo');
        }
        if (window.JohnPopup) {
          openJohn();
          return;
        }
        const av = (window.__WIC_ASSET_V__ || (window.__WIC_CONFIG__ && window.__WIC_CONFIG__.assetVersion) || '2');
        const s = document.createElement('script');
        s.src = '/john-popup.js?v=' + av;
        s.onload = openJohn;
        document.body.appendChild(s);
      });
    }
    });

    window.addEventListener('load', function() {
      const run = function() {
        const av = (window.__WIC_ASSET_V__ || (window.__WIC_CONFIG__ && window.__WIC_CONFIG__.assetVersion) || '2');
        const s = document.createElement('script');
        s.src = '/pwa.js?v=' + av;
        document.body.appendChild(s);
      };
      if ('requestIdleCallback' in window) {
        requestIdleCallback(run, { timeout: 3000 });
      } else {
        setTimeout(run, 1500);
      }
    });
  