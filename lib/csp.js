/**
 * Content-Security-Policy strings.
 * ENFORCED_CSP is the header already in production. Do not tighten it here.
 * REPORT_ONLY_CSP is the candidate policy, sent as Content-Security-Policy-Report-Only.
 * There is no CSP report endpoint in this app, so the policy has no report-uri.
 */

const ENFORCED_CSP =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https: http: ws: wss:; " +
  "connect-src 'self' https: http: ws: wss:; " +
  "media-src 'self' blob: data: https:; " +
  "img-src 'self' data: https:; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
  "style-src 'self' 'unsafe-inline' https:;";

const REPORT_ONLY_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' blob: data: https://bible.helloao.org https://audio.bible.helloao.org https://cdn.jsdelivr.net https://api.x.ai https://fonts.googleapis.com https://fonts.gstatic.com",
  "media-src 'self' blob: data: https://audio.bible.helloao.org",
  "worker-src 'self' https://cdn.jsdelivr.net",
  "manifest-src 'self'",
  "base-uri 'self'",
].join('; ');

module.exports = {
  ENFORCED_CSP,
  REPORT_ONLY_CSP,
};
