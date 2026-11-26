import Foundation
import WebKit
import Capacitor

/// App Store 3.1.1: the iPhone app never shows or opens purchase pages.
/// Pure rules here are unit tested (TwicTests/PurchaseGuardTests).
enum PurchaseGuard {
    enum Decision: Equatable { case allow, block, openStudy }

    static let blockedHosts = ["whop.com", "stripe.com", "checkout.stripe.com", "buy.stripe.com", "billing.stripe.com"]
    /// Landing (/) and checkout pages on our own site show prices and trial offers.
    static let blockedOwnPaths: Set<String> = ["/", "/success", "/success-checkout.js", "/landing.html"]

    static func decide(_ url: URL?) -> Decision {
        guard let url, let host = url.host?.lowercased() else { return .allow }
        if blockedHosts.contains(where: { host == $0 || host.hasSuffix("." + $0) }) { return .block }
        if host == TwicConfig.host || host == "www." + TwicConfig.host {
            let path = url.path.isEmpty ? "/" : url.path
            if blockedOwnPaths.contains(path) { return .openStudy }
            if url.fragment?.lowercased() == "signup" { return .openStudy }
        }
        return .allow
    }

    /// Injected at document start in the Study tab. Hides prices, trial
    /// offers, and billing notes; keeps Log in for existing accounts
    /// (3.1.3(b) multiplatform access).
    static let hideScript = #"""
    (function () {
      if (window.__twicPurchaseGuard) return; window.__twicPurchaseGuard = true;
      var css = '.settings-subscription-box,#tester-ended-subscribe,a[href*="whop.com"],a[href*="stripe.com"],a[href^="/#signup"],a[href="/success"],[data-purchase],#pwa-install-banner{display:none!important}';
      var priceRe = /(\$\s?\d|whop|free trial|per month|per year|subscribe|subscription)/i;
      function style() {
        if (document.getElementById('twic-ios-guard')) return;
        var s = document.createElement('style'); s.id = 'twic-ios-guard'; s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
        document.documentElement.classList.add('twic-ios');
      }
      function scrub() {
        style();
        var banner = document.getElementById('demo-banner');
        if (banner && !banner.dataset.twic) {
          banner.dataset.twic = '1';
          banner.textContent = 'Log in with your existing account to chat with John. The Read tab is always free and works offline.';
        }
        document.querySelectorAll('.demo-signup-prompt').forEach(function (el) {
          if (el.dataset.twic) return; el.dataset.twic = '1';
          el.textContent = 'Chat with John needs an account. Already have one? Tap Log in above.';
        });
        var input = document.getElementById('user-input');
        if (input && /sign up/i.test(input.placeholder || '')) input.placeholder = 'Log in to chat with John';
        var scopes = document.querySelectorAll('#subscribe-modal, #voice-modal, #account-status, .settings-subscription-box');
        scopes.forEach(function (scope) {
          scope.querySelectorAll('p, span, small, li, label, a, strong').forEach(function (el) {
            if (el.children.length === 0 && priceRe.test(el.textContent || '')) el.style.setProperty('display', 'none', 'important');
          });
        });
      }
      document.addEventListener('DOMContentLoaded', scrub);
      new MutationObserver(scrub).observe(document.documentElement, { childList: true, subtree: true });
      scrub();
    })();
    """#
}

/// Cancels navigation to purchase pages before Capacitor would hand an
/// unknown host to Safari.
@objc(TwicPurchaseGuardPlugin)
final class PurchaseGuardPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "TwicPurchaseGuardPlugin"
    let jsName = "TwicPurchaseGuard"
    let pluginMethods: [CAPPluginMethod] = []

    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        switch PurchaseGuard.decide(navigationAction.request.url) {
        case .allow:
            return nil
        case .block:
            return true
        case .openStudy:
            DispatchQueue.main.async { [weak self] in
                self?.bridge?.webView?.load(URLRequest(url: TwicConfig.studyURL))
            }
            return true
        }
    }
}
