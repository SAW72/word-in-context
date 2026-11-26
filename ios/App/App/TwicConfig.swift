import UIKit

enum TwicConfig {
    /// Appended to the web view user agent so the web app can tell it runs in the iPhone shell.
    static let userAgentMarker = "TwicIOS/1.0"
    static let host = "thewordincontext.org"
    static let studyURL = URL(string: "https://thewordincontext.org/app")!
    static let privacyURL = URL(string: "https://thewordincontext.org/privacy")!
    static let termsURL = URL(string: "https://thewordincontext.org/terms")!
    static let attributionsURL = URL(string: "https://thewordincontext.org/attributions.html")!
    static let supportEmail = "hello@stewardoftheking.com"
}

enum TwicTheme {
    static let navy = UIColor(red: 0x2c / 255, green: 0x3e / 255, blue: 0x50 / 255, alpha: 1)
    static let gold = UIColor(red: 0xc9 / 255, green: 0xa2 / 255, blue: 0x27 / 255, alpha: 1)
    static let parchment = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1)
            : UIColor(red: 0xf8 / 255, green: 0xf5 / 255, blue: 0xf2 / 255, alpha: 1)
    }

    static func scriptureFont(_ style: UIFont.TextStyle) -> UIFont {
        let base = UIFont.preferredFont(forTextStyle: style)
        guard let serif = base.fontDescriptor.withDesign(.serif) else { return base }
        return UIFont(descriptor: serif, size: 0)
    }
}

enum Haptics {
    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "twic.haptics") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "twic.haptics") }
    }
    static func select() { guard enabled else { return }; UISelectionFeedbackGenerator().selectionChanged() }
    static func tap() { guard enabled else { return }; UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func success() { guard enabled else { return }; UINotificationFeedbackGenerator().notificationOccurred(.success) }
}
