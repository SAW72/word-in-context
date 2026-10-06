  let adminToken = null;
  const base = '';

  async function adminLogin() {
    const pass = document.getElementById('admin-pass').value;
    const status = document.getElementById('login-status');
    status.textContent = 'Checking...';
    try {
      const r = await fetch(base + '/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass })
      });
      const data = await r.json();
      if (r.ok && data.token) {
        adminToken = data.token;
        sessionStorage.setItem('admin_token', adminToken);
        document.getElementById('login-panel').style.display = 'none';
        document.getElementById('admin-panel').style.display = 'block';
        loadUsers();
        if (typeof loadShareTtsSettings === 'function') loadShareTtsSettings();
        if (typeof loadShareAiBgSettings === 'function') loadShareAiBgSettings();
      } else {
        status.textContent = data.error || 'Login failed';
      }
    } catch (e) {
      status.textContent = 'Network error';
    }
  }

  function logoutAdmin() {
    adminToken = null;
    sessionStorage.removeItem('admin_token');
    document.getElementById('admin-panel').style.display = 'none';
    document.getElementById('login-panel').style.display = 'block';
    document.getElementById('login-status').textContent = '';
  }

  function fillAdminUserRow(tr, u) {
    const emailTd = document.createElement('td');
    emailTd.textContent = u.email || '';
    tr.appendChild(emailTd);

    const statusTd = document.createElement('td');
    statusTd.textContent = u.status || '';
    tr.appendChild(statusTd);

    const trialTd = document.createElement('td');
    trialTd.className = 'small';
    trialTd.textContent = u.trial_end ? new Date(u.trial_end).toLocaleDateString() : '-';
    tr.appendChild(trialTd);

    const groupTd = document.createElement('td');
    if (u.group_name) {
      const span = document.createElement('span');
      span.className = 'small';
      span.textContent = u.group_name;
      groupTd.appendChild(span);
    } else {
      groupTd.textContent = '—';
    }
    tr.appendChild(groupTd);

    const accessTd = document.createElement('td');
    accessTd.textContent = u.access_granted ? '✅' : '❌';
    tr.appendChild(accessTd);

    const freeTd = document.createElement('td');
    freeTd.textContent = u.manual_free ? '✅' : '—';
    tr.appendChild(freeTd);

    const createdTd = document.createElement('td');
    createdTd.className = 'small';
    createdTd.textContent = (u.created_at || '').slice(0, 10);
    tr.appendChild(createdTd);

    const actionsTd = document.createElement('td');
    tr.appendChild(actionsTd);
    return actionsTd;
  }

  function setTextParts(el, parts) {
    if (!el) return;
    el.replaceChildren();
    parts.forEach((part) => {
      if (part && typeof part === 'object') {
        const node = document.createElement(part.tag);
        node.textContent = part.text == null ? '' : String(part.text);
        el.appendChild(node);
      } else {
        el.appendChild(document.createTextNode(part == null ? '' : String(part)));
      }
    });
  }

  async function loadUsers() {
    const tbody = document.getElementById('users-tbody');
    const status = document.getElementById('admin-status');
    status.textContent = 'Loading users...';
    tbody.replaceChildren();
    try {
      const r = await fetch(base + '/api/admin/users', {
        headers: { 'Authorization': 'Bearer ' + adminToken }
      });
      if (!r.ok) throw new Error('auth');
      const users = await r.json();
      status.textContent = users.length + ' users';
      users.forEach(u => {
        const tr = document.createElement('tr');
        tr.className = 'user-row';
        tr.dataset.email = u.email;
        const actionsTd = fillAdminUserRow(tr, u);

        const mkBtn = (text, cls, onClick) => {
          const b = document.createElement('button');
          b.className = cls || 'btn';
          b.textContent = text;
          b.onclick = (e) => { e.preventDefault(); onClick(); };
          actionsTd.appendChild(b);
          return b;
        };

        mkBtn('Grant access', 'btn', () => setAccess(u.email, 1, u.manual_free ? 1 : 0));
        mkBtn('Revoke', 'btn danger', () => setAccess(u.email, 0, u.manual_free ? 1 : 0));
        mkBtn('Make free forever', 'btn', () => setAccess(u.email, u.access_granted ? 1 : 0, 1));
        mkBtn('Remove free', 'btn gray', () => setAccess(u.email, u.access_granted ? 1 : 0, 0));
        mkBtn('The Word in Context Special offer', 'btn', () => { if (window.sendRetention) window.sendRetention(u.email); });
        mkBtn('Delete', 'btn danger', () => deleteUser(u.email));

        tbody.appendChild(tr);
      });
    } catch (e) {
      status.textContent = 'Failed to load (bad or expired admin token?)';
      logoutAdmin();
    }
  }

  async function deleteUser(email) {
    if (!confirm('Permanently delete ' + email + '?\n\nThey can sign up again with the same email. Magic login links for this address will stop working.')) return;
    const status = document.getElementById('admin-status');
    status.textContent = 'Deleting ' + email + '...';
    try {
      const r = await fetch(base + '/api/admin/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
        body: JSON.stringify({ email })
      });
      const data = await r.json();
      if (r.ok) {
        status.textContent = 'Deleted ' + email;
        loadUsers();
      } else {
        status.textContent = data.error || 'Delete failed';
      }
    } catch (e) {
      status.textContent = 'Error deleting user';
    }
  }

  async function setAccess(email, access_granted, manual_free) {
    const status = document.getElementById('admin-status');
    status.textContent = 'Updating ' + email + '...';
    try {
      const r = await fetch(base + '/api/admin/set-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
        body: JSON.stringify({ email, access_granted: !!access_granted, manual_free: !!manual_free })
      });
      const data = await r.json();
      if (r.ok) {
        status.textContent = 'Updated ' + email;
        loadUsers();
      } else {
        status.textContent = data.error || 'Update failed';
      }
    } catch (e) {
      status.textContent = 'Error updating';
    }
  }

  function applyShareTtsForm(settings) {
    if (!settings) return;
    const enabled = document.getElementById('stts-enabled');
    const requireAuth = document.getElementById('stts-require-auth');
    const daily = document.getElementById('stts-daily');
    const maxChars = document.getElementById('stts-maxchars');
    const preset = document.getElementById('stts-voice-preset');
    const custom = document.getElementById('stts-voice-custom');
    const customWrap = document.getElementById('stts-custom-wrap');
    const line = document.getElementById('stts-status-line');
    if (enabled) enabled.checked = !!settings.enabled;
    if (requireAuth) requireAuth.checked = !!settings.requireAuth;
    if (daily) daily.value = String(settings.dailyLimit ?? 12);
    if (maxChars) maxChars.value = String(settings.maxChars ?? 4000);
    const voice = String(settings.voice || 'leo');
    const builtins = ['leo', 'rex', 'ara', 'sal', 'eve'];
    if (builtins.includes(voice.toLowerCase())) {
      if (preset) preset.value = voice.toLowerCase();
      if (customWrap) customWrap.style.display = 'none';
      if (custom) custom.value = '';
    } else {
      if (preset) preset.value = '__custom';
      if (customWrap) customWrap.style.display = 'block';
      if (custom) custom.value = voice;
    }
    if (line) {
      const ok = settings.available ? 'READY' : 'OFF / unavailable';
      const shownVoice = voice.length > 24 ? voice.slice(0, 12) + '…' : voice;
      setTextParts(line, [
        'Status: ',
        { tag: 'strong', text: ok },
        ' · xAI key: ' + (settings.hasXaiKey ? 'yes' : 'NO') + ' · voice: ',
        { tag: 'code', text: shownVoice },
      ]);
    }
  }

  async function loadShareTtsSettings() {
    const status = document.getElementById('stts-save-status');
    if (!adminToken) return;
    try {
      const r = await fetch(base + '/api/admin/share-tts', {
        headers: { 'Authorization': 'Bearer ' + adminToken }
      });
      if (!r.ok) throw new Error('auth');
      const data = await r.json();
      applyShareTtsForm(data);
      if (status) status.textContent = '';
    } catch (e) {
      if (status) status.textContent = 'Could not load voice-video settings';
    }
  }

  async function saveShareTtsSettings() {
    const status = document.getElementById('stts-save-status');
    status.textContent = 'Saving…';
    const preset = document.getElementById('stts-voice-preset').value;
    const custom = document.getElementById('stts-voice-custom').value.trim();
    const voice = preset === '__custom' ? custom : preset;
    if (!voice) {
      status.textContent = 'Pick a voice or paste a custom/cloned voice ID';
      return;
    }
    try {
      const r = await fetch(base + '/api/admin/share-tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + adminToken
        },
        body: JSON.stringify({
          enabled: document.getElementById('stts-enabled').checked,
          requireAuth: document.getElementById('stts-require-auth').checked,
          dailyLimit: parseInt(document.getElementById('stts-daily').value, 10),
          maxChars: parseInt(document.getElementById('stts-maxchars').value, 10),
          voice
        })
      });
      const data = await r.json();
      if (!r.ok) {
        status.textContent = data.error || 'Save failed';
        return;
      }
      applyShareTtsForm(data.settings);
      status.textContent = 'Saved. Changes apply immediately (no redeploy).';
    } catch (e) {
      status.textContent = 'Network error saving settings';
    }
  }

  function applyShareAiBgForm(settings) {
    if (!settings) return;
    const en = document.getElementById('saibg-enabled');
    const ra = document.getElementById('saibg-require-auth');
    const daily = document.getElementById('saibg-daily');
    const line = document.getElementById('saibg-status-line');
    if (en) en.checked = !!settings.enabled;
    if (ra) ra.checked = !!settings.requireAuth;
    if (daily) daily.value = String(settings.dailyLimit ?? 8);
    if (line) {
      setTextParts(line, [
        'Status: ',
        { tag: 'strong', text: settings.available ? 'READY' : 'OFF' },
        ' · ~$',
        { tag: 'span', text: String(settings.approxCostUsd || 0.02) },
        '/image · model ',
        { tag: 'code', text: settings.model || 'grok-imagine-image' },
      ]);
    }
  }

  async function loadShareAiBgSettings() {
    if (!adminToken) return;
    try {
      const r = await fetch(base + '/api/admin/share-ai-bg', {
        headers: { 'Authorization': 'Bearer ' + adminToken }
      });
      if (!r.ok) throw new Error('auth');
      applyShareAiBgForm(await r.json());
    } catch (e) {
      const s = document.getElementById('saibg-save-status');
      if (s) s.textContent = 'Could not load AI background settings';
    }
  }

  async function saveShareAiBgSettings() {
    const status = document.getElementById('saibg-save-status');
    status.textContent = 'Saving…';
    try {
      const r = await fetch(base + '/api/admin/share-ai-bg', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + adminToken
        },
        body: JSON.stringify({
          enabled: document.getElementById('saibg-enabled').checked,
          requireAuth: document.getElementById('saibg-require-auth').checked,
          dailyLimit: parseInt(document.getElementById('saibg-daily').value, 10)
        })
      });
      const data = await r.json();
      if (!r.ok) {
        status.textContent = data.error || 'Save failed';
        return;
      }
      applyShareAiBgForm(data.settings);
      status.textContent = 'Saved. Applies immediately.';
    } catch (e) {
      status.textContent = 'Network error';
    }
  }

  // Auto-restore admin session
  window.onload = () => {
    const saved = sessionStorage.getItem('admin_token');
    if (saved) {
      adminToken = saved;
      document.getElementById('login-panel').style.display = 'none';
      document.getElementById('admin-panel').style.display = 'block';
      loadUsers();
      loadShareTtsSettings();
      loadShareAiBgSettings();
    }
    // Also load a hint of config
    fetch(base + '/api/config').then(r=>r.json()).then(c => {
      const s = document.getElementById('admin-status');
      if (s && !s.textContent) {
        const st = c.shareTts || {};
        s.textContent = 'Demo limit: ' + (c.demoLimit||10) + ' • Normal trial: ' + (c.trialDays||7) + 'd • Tester trial: ' + (c.testerTrialDays||14) + 'd • Voice video: ' + (st.enabled ? 'ON' : 'OFF');
      }
    }).catch(()=>{});

    // Wire static top buttons safely (avoids any inline onclick timing/scope issues)
    const reloadBtn = document.getElementById('reload-users-btn');
    if (reloadBtn) reloadBtn.onclick = () => loadUsers();
    const sttsSave = document.getElementById('stts-save-btn');
    if (sttsSave) sttsSave.onclick = () => saveShareTtsSettings();
    const sttsReload = document.getElementById('stts-reload-btn');
    if (sttsReload) sttsReload.onclick = () => loadShareTtsSettings();
    const saibgSave = document.getElementById('saibg-save-btn');
    if (saibgSave) saibgSave.onclick = () => saveShareAiBgSettings();
    const saibgReload = document.getElementById('saibg-reload-btn');
    if (saibgReload) saibgReload.onclick = () => loadShareAiBgSettings();
    const preset = document.getElementById('stts-voice-preset');
    if (preset) {
      preset.onchange = () => {
        const wrap = document.getElementById('stts-custom-wrap');
        if (wrap) wrap.style.display = preset.value === '__custom' ? 'block' : 'none';
      };
    }

    // —— AI content → Buffer (Bible Q&A) ——
    function setContentStatus(text) {
      const el = document.getElementById('content-status');
      if (el) el.value = text || '';
    }
    function setContentMsg(text, ok) {
      const el = document.getElementById('content-msg');
      if (!el) return;
      el.textContent = text || '';
      el.style.color = ok === false ? '#c94e4e' : (ok ? '#2d6a3e' : '');
    }
    async function contentApi(path, opts = {}) {
      const res = await fetch(base + path, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + adminToken,
          ...(opts.headers || {}),
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.result?.error || ('HTTP ' + res.status));
      return data;
    }
    document.getElementById('btn-content-status')?.addEventListener('click', async () => {
      try {
        setContentMsg('Loading…', true);
        const st = await contentApi('/api/content/status');
        const t = await contentApi('/api/content/buffer/test').catch((e) => ({ ok: false, error: e.message }));
        const q = st.queue?.byStatus || {};
        setContentStatus(
          'Brand: ' + (st.brand?.name || '') + ' · format: Bible Q&A\n' +
          'Networks: ' + ((st.brand?.networks || []).join(', ')) + '\n' +
          'Buffer: ' + (st.bufferConfigured ? 'key set' : 'NO KEY') + '\n' +
          'XAI: ' + (st.xaiConfigured ? 'yes' : 'no') + '\n' +
          (st.buffer?.facebook ? 'FB: ' + st.buffer.facebook + '\n' : '') +
          (st.buffer?.instagram ? 'IG: ' + st.buffer.instagram + '\n' : '') +
          (st.buffer?.error ? 'Buffer err: ' + st.buffer.error + '\n' : '') +
          'Test: ' + (t.ok ? 'OK' : (t.error || 'fail')) + '\n' +
          'Video ffmpeg: ' + (st.video?.ffmpeg ? 'yes' : 'NO') +
          (st.video?.videoCount != null ? ' · files: ' + st.video.videoCount : '') +
          (st.video?.note ? '\n' + st.video.note : '') + '\n' +
          'Queue: ' + (st.queue?.total || 0) +
          (q.queued ? ' · ' + q.queued + ' queued' : '') +
          (q.scheduled ? ' · ' + q.scheduled + ' scheduled' : '') +
          (q.failed ? ' · ' + q.failed + ' failed' : '')
        );
        setContentMsg(t.ok ? 'Buffer ready' : (t.error || 'Check BUFFER_API_KEY'), !!t.ok);
      } catch (e) {
        setContentStatus(String(e.message));
        setContentMsg(e.message, false);
      }
    });
    document.getElementById('btn-content-smoke')?.addEventListener('click', async () => {
      try {
        setContentMsg('Smoke posting…', true);
        setContentStatus('Smoke…');
        const r = await contentApi('/api/content/buffer/smoke', { method: 'POST', body: '{}' });
        setContentStatus(r.ok
          ? ('Smoke OK ' + JSON.stringify(r.result?.externalIds || {}) + '\n' + (r.tip || ''))
          : ('Smoke failed: ' + (r.result?.error || r.error || r.tip || '')));
        setContentMsg(r.ok ? 'Smoke OK — check Buffer' : 'Smoke failed', !!r.ok);
      } catch (e) {
        setContentStatus(String(e.message));
        setContentMsg(e.message, false);
      }
    });
    document.getElementById('btn-content-generate')?.addEventListener('click', async () => {
      try {
        setContentMsg('Generating week (15–60s)…', true);
        setContentStatus('Generating Q&A posts…');
        const r = await contentApi('/api/content/generate', {
          method: 'POST',
          body: JSON.stringify({ days: 7, mode: 'replace' }),
        });
        setContentStatus(
          'Created ' + (r.summary?.created || 0) + ' · pending ' + (r.summary?.pendingPublish || 0) + '\n' +
          (r.tip || '') + '\n' + (r.warnings || []).slice(0, 6).join('\n')
        );
        setContentMsg(r.tip || ('Created ' + (r.summary?.created || 0)), true);
      } catch (e) {
        setContentStatus(String(e.message));
        setContentMsg(e.message, false);
      }
    });
    document.getElementById('btn-content-videos')?.addEventListener('click', async () => {
      try {
        setContentMsg('Building reels (voice + image)… keep tab open.', true);
        setContentStatus('Generating videos… TTS + ffmpeg. Keep this open.');
        const r = await contentApi('/api/content/generate-videos', {
          method: 'POST',
          body: JSON.stringify({ limit: 1, publish: false }),
        });
        const ok = r.summary?.ok ?? 0;
        const fail = r.summary?.failed ?? 0;
        const vidLinks = (r.results || [])
          .filter((x) => x.ok && x.videoUrl)
          .map((x) => x.videoUrl)
          .join('\n');
        setContentStatus(
          (r.tip || ('Videos: ' + ok + ' ok, ' + fail + ' failed')) +
          (vidLinks ? '\n\nDownload MP4:\n' + vidLinks : '') +
          (r.videoStatus
            ? '\nffmpeg: ' + r.videoStatus.ffmpeg + ' · files: ' + r.videoStatus.videoCount +
              (r.videoStatus.note ? '\n' + r.videoStatus.note : '')
            : '') +
          (r.results || []).filter((x) => !x.ok).slice(0, 3).map((x) => '\n' + (x.error || '')).join('')
        );
        setContentMsg(
          ok > 0
            ? ok + ' reel(s) ready — use Download reels (Mac) or Publish'
            : (r.tip || r.error || 'No videos — Generate week first'),
          ok > 0
        );
      } catch (e) {
        setContentStatus(String(e.message));
        setContentMsg(e.message, false);
      }
    });
    document.getElementById('btn-content-download-reels')?.addEventListener('click', async () => {
      try {
        setContentMsg('Listing reels…', true);
        const r = await contentApi('/api/content/videos');
        const files = r.files || [];
        if (!files.length) {
          setContentStatus(r.tip || 'No reels on disk. Generate videos first.');
          setContentMsg('No reels yet — Generate videos first', false);
          return;
        }
        const lines = files.map((f, i) =>
          (i + 1) + '. ' + f.fileName + ' (' + Math.round((f.bytes || 0) / 1024) + ' KB)\n   ' + (f.downloadUrl || f.url)
        ).join('\n');
        setContentStatus(
          files.length + ' reel(s) on server.\nZIP download starts next.\n\n' + lines
        );
        const res = await fetch(base + '/api/content/videos/zip', {
          headers: { Authorization: 'Bearer ' + adminToken },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || ('Zip failed ' + res.status));
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'word-in-context-reels-' + new Date().toISOString().slice(0, 10) + '.zip';
        a.click();
        URL.revokeObjectURL(url);
        setContentMsg(
          'Downloaded ' + files.length + ' reel(s) as ZIP. Unzip on Mac, upload MP4s in Buffer.',
          true
        );
      } catch (e) {
        setContentStatus(String(e.message));
        setContentMsg(e.message, false);
      }
    });
    document.getElementById('btn-content-requeue-ig')?.addEventListener('click', async () => {
      try {
        setContentMsg('Requeueing for Instagram only…', true);
        setContentStatus('Requeue Instagram only…');
        const r = await contentApi('/api/content/requeue-instagram', {
          method: 'POST',
          body: JSON.stringify({ limit: 14 }),
        });
        setContentStatus(
          (r.tip || ('Requeued ' + (r.requeued || 0) + ' posts for Instagram only')) +
          (r.skipped ? '\n' + r.skipped + ' skipped' : '')
        );
        setContentMsg(
          r.requeued > 0
            ? r.requeued + ' posts → Instagram only. Next: Publish queued.'
            : (r.tip || 'Nothing to requeue — Generate week first.'),
          r.requeued > 0
        );
      } catch (e) {
        setContentStatus(String(e.message));
        setContentMsg(e.message, false);
      }
    });
    document.getElementById('btn-content-publish')?.addEventListener('click', async () => {
      try {
        setContentMsg('Publishing…', true);
        setContentStatus('Publishing to Buffer…');
        const r = await contentApi('/api/content/publish', { method: 'POST', body: '{}' });
        const ok = r.summary?.ok ?? 0;
        const fail = r.summary?.failed ?? 0;
        const full = r.summary?.channelsFull || [];
        setContentStatus(
          'Publish via ' + r.publisher + ': ' + ok + ' ok, ' + fail + ' failed' +
          (full.length ? '\nFull channels (at ~10): ' + full.join(', ') : '') +
          (r.tip ? '\n' + r.tip : '') +
          (r.firstError ? '\n' + r.firstError : '')
        );
        setContentMsg(
          r.tip || (fail && !ok ? 'Publish failed' : ('Filled slots · ' + ok + ' ok')),
          !!(ok || full.length)
        );
      } catch (e) {
        setContentStatus(String(e.message));
        setContentMsg(e.message, false);
      }
    });
    document.getElementById('btn-content-export')?.addEventListener('click', async () => {
      try {
        const r = await contentApi('/api/content/export');
        const pack = document.getElementById('content-pack');
        if (pack) { pack.hidden = false; pack.value = r.pack || ''; }
        setContentStatus('Export ready · ' + (r.count || 0) + ' posts');
        setContentMsg((r.count || 0) + ' posts in export box', true);
      } catch (e) {
        setContentMsg(e.message, false);
      }
    });
    document.getElementById('btn-content-copy')?.addEventListener('click', async () => {
      const text = document.getElementById('content-status')?.value ||
        document.getElementById('content-pack')?.value || '';
      try {
        await navigator.clipboard.writeText(text);
        setContentMsg('Copied', true);
      } catch {
        setContentMsg('Select text and copy manually', false);
      }
    });
  };



  async function createSpecialTester() {
    const status = document.getElementById('special-status');
    const email = document.getElementById('special-email').value.trim();
    const days = document.getElementById('special-days').value;
    const group = document.getElementById('special-group').value.trim();
    if (!email) { status.textContent = 'Email required'; return; }
    status.textContent = 'Creating...';
    try {
      const r = await fetch(base + '/api/admin/create-special-tester', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
        body: JSON.stringify({ email, days: parseInt(days) || 30, group_name: group || null })
      });
      const data = await r.json();
      status.textContent = data.message || data.error || 'Done';
      if (r.ok) loadUsers();
    } catch (e) { status.textContent = 'Error'; }
  }

  async function bulkGroupGrant() {
    const status = document.getElementById('bulk-status');
    const group = document.getElementById('bulk-group').value.trim();
    const emailsText = document.getElementById('bulk-emails').value.trim();
    const days = document.getElementById('bulk-days').value;
    if (!group || !emailsText) { status.textContent = 'Group name and emails required'; return; }
    const emails = emailsText.split(/\r?\n/).map(e => e.trim()).filter(Boolean);
    status.textContent = 'Granting for ' + emails.length + ' emails...';
    try {
      const r = await fetch(base + '/api/admin/bulk-group-grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
        body: JSON.stringify({ group_name: group, emails, days: days ? parseInt(days) : null })
      });
      const data = await r.json();
      status.textContent = data.success ? `Granted for ${data.granted} users in ${group}` : (data.error || 'Failed');
      if (data.success) loadUsers();
    } catch (e) { status.textContent = 'Error'; }
  }

  // Retention offer button (call manually or extend table)
  window.sendRetention = async function(email) {
    if (!confirm('Send The Word in Context Special (discounted $3/mo) offer to ' + email + '?')) return;
    const status = document.getElementById('admin-status');
    status.textContent = 'Sending The Word in Context Special offer to ' + email + '...';
    try {
      const r = await fetch(base + '/api/admin/send-retention-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
        body: JSON.stringify({ email })
      });
      const data = await r.json();
      status.textContent = data.message || data.error || 'Sent';
    } catch (e) { status.textContent = 'Error sending offer'; }
  };

document.getElementById('admin-login-btn')?.addEventListener('click', () => adminLogin());
document.getElementById('admin-logout-btn')?.addEventListener('click', () => logoutAdmin());
document.getElementById('create-special-tester-btn')?.addEventListener('click', () => createSpecialTester());
document.getElementById('bulk-group-grant-btn')?.addEventListener('click', () => bulkGroupGrant());
