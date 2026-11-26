import UIKit
import SafariServices

final class SettingsViewController: UITableViewController {
    private enum Row { case translation, daily, dailyTime, haptics, speechRate, sources, privacy, terms, support, version }
    private let sections: [(String, [Row])] = [
        ("Reading", [.translation, .speechRate, .haptics]),
        ("Daily verse", [.daily, .dailyTime]),
        ("About", [.sources, .privacy, .terms, .support, .version]),
    ]
    private let scheduler = DailyVerseScheduler.shared

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Settings"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "c")
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        tableView.reloadData()
    }

    override func numberOfSections(in tableView: UITableView) -> Int { sections.count }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { sections[section].0 }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        switch section {
        case 0: return "BSB, KJV, ASV, YLT, Darby, and WEB are stored on this iPhone and work offline. NET Bible is online only, in the Study tab."
        case 1: return "A local reminder on this iPhone. Nothing is sent to a server."
        default: return nil
        }
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { sections[section].1.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
        cell.accessoryView = nil
        cell.accessoryType = .none
        cell.selectionStyle = .default
        var c = UIListContentConfiguration.valueCell()
        switch sections[indexPath.section].1[indexPath.row] {
        case .translation:
            c.text = "Translation"
            c.secondaryText = BibleStore.shared.info(BibleStore.shared.selectedID)?.short
            cell.accessoryType = .disclosureIndicator
        case .speechRate:
            c.text = "Reading speed"
            let slider = UISlider(frame: CGRect(x: 0, y: 0, width: 150, height: 30))
            slider.minimumValue = 0.3; slider.maximumValue = 0.6; slider.value = SpeechReader.rate
            slider.addAction(UIAction { a in SpeechReader.rate = (a.sender as? UISlider)?.value ?? 0.5 }, for: .valueChanged)
            slider.accessibilityLabel = "Reading speed"
            cell.accessoryView = slider; cell.selectionStyle = .none
        case .haptics:
            c.text = "Haptics"
            let sw = UISwitch(); sw.isOn = Haptics.enabled
            sw.addAction(UIAction { a in Haptics.enabled = (a.sender as? UISwitch)?.isOn ?? true }, for: .valueChanged)
            cell.accessoryView = sw; cell.selectionStyle = .none
        case .daily:
            c.text = "Daily verse notification"
            let sw = UISwitch(); sw.isOn = scheduler.isEnabled
            sw.accessibilityIdentifier = "settings.daily"
            sw.addAction(UIAction { [weak self] a in
                guard let sw = a.sender as? UISwitch, let self else { return }
                if sw.isOn {
                    self.scheduler.enable { granted in
                        sw.setOn(granted, animated: true)
                        if !granted { self.alert("Notifications are off", "Turn on notifications for The Word in iPhone Settings to get a daily verse.") }
                        else { Haptics.success() }
                    }
                } else { self.scheduler.disable() }
            }, for: .valueChanged)
            cell.accessoryView = sw; cell.selectionStyle = .none
        case .dailyTime:
            c.text = "Time"
            let picker = UIDatePicker(); picker.datePickerMode = .time; picker.preferredDatePickerStyle = .compact
            picker.date = Calendar.current.date(bySettingHour: scheduler.hour, minute: scheduler.minute, second: 0, of: Date()) ?? Date()
            picker.addAction(UIAction { [weak self] a in
                guard let p = a.sender as? UIDatePicker, let self else { return }
                let comps = Calendar.current.dateComponents([.hour, .minute], from: p.date)
                self.scheduler.hour = comps.hour ?? 7; self.scheduler.minute = comps.minute ?? 0
                self.scheduler.refreshIfEnabled()
            }, for: .valueChanged)
            cell.accessoryView = picker; cell.selectionStyle = .none
        case .sources:
            c.text = "Bible sources and licenses"; cell.accessoryType = .disclosureIndicator
        case .privacy:
            c.text = "Privacy policy"; cell.accessoryType = .disclosureIndicator
        case .terms:
            c.text = "Terms"; cell.accessoryType = .disclosureIndicator
        case .support:
            c.text = "Contact"; c.secondaryText = TwicConfig.supportEmail
        case .version:
            let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
            let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
            c.text = "Version"; c.secondaryText = "\(v) (\(b))"; cell.selectionStyle = .none
        }
        cell.contentConfiguration = c
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        switch sections[indexPath.section].1[indexPath.row] {
        case .translation: pickTranslation()
        case .sources: navigationController?.pushViewController(SourcesViewController(style: .insetGrouped), animated: true)
        case .privacy: present(SFSafariViewController(url: TwicConfig.privacyURL), animated: true)
        case .terms: present(SFSafariViewController(url: TwicConfig.termsURL), animated: true)
        case .support:
            if let u = URL(string: "mailto:\(TwicConfig.supportEmail)") { UIApplication.shared.open(u) }
        default: break
        }
    }

    private func pickTranslation() {
        let sheet = UIAlertController(title: "Translation", message: "Stored on this iPhone", preferredStyle: .actionSheet)
        for t in BibleStore.shared.translations {
            sheet.addAction(UIAlertAction(title: "\(t.short)  \(t.name)", style: .default) { [weak self] _ in
                BibleStore.shared.selectedID = t.id
                Haptics.select()
                (self?.tabBarController as? MainTabBarController)?.reader.loadTranslation(t.id)
                self?.scheduler.refreshIfEnabled()
                self?.tableView.reloadData()
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        present(sheet, animated: true)
    }

    private func alert(_ title: String, _ message: String) {
        let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        present(a, animated: true)
    }
}

final class SourcesViewController: UITableViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Sources"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "c")
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { BibleStore.shared.translations.count }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        "Text from the Free Use Bible API (bible.helloao.org), stored on this iPhone. Original language study in the Study tab uses SBL Greek NT and the Westminster Leningrad Codex."
    }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let t = BibleStore.shared.translations[indexPath.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
        var c = UIListContentConfiguration.subtitleCell()
        c.text = "\(t.short)  \(t.name)"
        c.secondaryText = "\(t.license)\n\(t.source)"
        c.secondaryTextProperties.numberOfLines = 0
        cell.contentConfiguration = c
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        if let u = URL(string: BibleStore.shared.translations[indexPath.row].source) {
            present(SFSafariViewController(url: u), animated: true)
        }
    }
}
