import UIKit

/// Native tabs: Read (offline Bible), Study (web chat), Settings.
final class MainTabBarController: UITabBarController {
    let reader = ReaderViewController(style: .plain)
    let study = StudyWebViewController()
    let settings = SettingsViewController(style: .insetGrouped)

    override func viewDidLoad() {
        super.viewDidLoad()
        let readNav = UINavigationController(rootViewController: reader)
        readNav.tabBarItem = UITabBarItem(title: "Read", image: UIImage(systemName: "book"), tag: 0)
        study.tabBarItem = UITabBarItem(title: "Study", image: UIImage(systemName: "text.bubble"), tag: 1)
        let settingsNav = UINavigationController(rootViewController: settings)
        settingsNav.tabBarItem = UITabBarItem(title: "Settings", image: UIImage(systemName: "gearshape"), tag: 2)
        viewControllers = [readNav, study, settingsNav]
        if ProcessInfo.processInfo.arguments.contains("-TwicTab"),
           let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-TwicTab"),
           i + 1 < ProcessInfo.processInfo.arguments.count, let tab = Int(ProcessInfo.processInfo.arguments[i + 1]) {
            selectedIndex = tab
        }
    }

    override func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        Haptics.select()
    }
}
