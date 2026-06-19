/* Shared auth API helpers — safe JSON parsing + clearer offline/server errors */
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
    try {
      data = JSON.parse(text);
    } catch (_) {
      const hint = res.status >= 500
        ? `Server error (${res.status}). Wait a moment and try again.`
        : 'Unexpected server response. Hard-refresh the page (Cmd+Shift+R) and try again.';
      throw new Error(hint);
    }
  }
  return { res, data };
}