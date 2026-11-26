import UIKit
import WebKit
import Capacitor

/// Study tab: the Word in Context chat at https://thewordincontext.org/app in
/// a Capacitor bridge. User agent gets TwicIOS/1.0 (capacitor.config.json).
final class StudyWebViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = TwicTheme.parchment
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(PurchaseGuardPlugin())
        // Capacitor swaps in its own WKUserContentController after
        // webViewConfiguration(for:), so the guard script is added here,
        // before Capacitor loads server.url.
        let script = WKUserScript(source: PurchaseGuard.hideScript, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        webView?.configuration.userContentController.addUserScript(script)
    }

    func reload() {
        webView?.load(URLRequest(url: TwicConfig.studyURL))
    }
}
