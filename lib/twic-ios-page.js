'use strict';

/**
 * Study page variant for the iOS app (User-Agent contains TwicIOS).
 * Browser responses stay the file on disk. The iOS response drops commerce
 * regions marked in public/index.html and keeps login plus account deletion.
 *
 * HTML regions use comments named twic-ios-omit:start and twic-ios-omit:end.
 * An optional twic-ios-alt comment inside the region is the iOS replacement.
 * Inline script and style use the same names as block comments, so a browser
 * still runs the statements between the markers. Alt text must not contain
 * a block-comment closer.
 */

function isTwicIOS(ua) {
  return /\bTwicIOS\b/.test(String(ua || ''));
}

function renderTwicIOSPage(html) {
  let out = String(html == null ? '' : html);
  out = out.replace(/<!--\s*twic-ios-omit:start\s*-->([\s\S]*?)<!--\s*twic-ios-omit:end\s*-->/g, (_, inner) => {
    const alt = String(inner).match(/<!--\s*twic-ios-alt:\s*([\s\S]*?)-->/);
    return alt ? alt[1] : '';
  });
  out = out.replace(/\/\*\s*twic-ios-omit:start\s*\*\/([\s\S]*?)\/\*\s*twic-ios-omit:end\s*\*\//g, (_, inner) => {
    const alt = String(inner).match(/\/\*\s*twic-ios-alt:\s*([\s\S]*?)\*\//);
    return alt ? alt[1] : '';
  });
  return out;
}

module.exports = {
  isTwicIOS,
  renderTwicIOSPage,
};
