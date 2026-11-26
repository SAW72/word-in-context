import Foundation
import UserNotifications

/// Opt-in daily verse. Local notifications only; there is no push server.
/// Schedules the next 30 days so each day shows a different verse.
final class DailyVerseScheduler {
    static let shared = DailyVerseScheduler()
    static let referenceKey = "twic.reference"
    static let idPrefix = "twic.daily."
    static let daysAhead = 30

    private let defaults: UserDefaults
    private let store: BibleStore
    private let parser: ReferenceParser
    private let references: [String]

    init(defaults: UserDefaults = .standard, store: BibleStore = .shared, parser: ReferenceParser = .shared, bundle: Bundle = .main) {
        self.defaults = defaults
        self.store = store
        self.parser = parser
        if let u = bundle.url(forResource: "DailyVerses", withExtension: "json"),
           let d = try? Data(contentsOf: u),
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let refs = obj["references"] as? [String] {
            references = refs
        } else {
            references = ["John 3:16"]
        }
    }

    var isEnabled: Bool {
        get { defaults.bool(forKey: "twic.daily.enabled") }
        set { defaults.set(newValue, forKey: "twic.daily.enabled") }
    }
    var hour: Int {
        get { defaults.object(forKey: "twic.daily.hour") as? Int ?? 7 }
        set { defaults.set(newValue, forKey: "twic.daily.hour") }
    }
    var minute: Int {
        get { defaults.object(forKey: "twic.daily.minute") as? Int ?? 0 }
        set { defaults.set(newValue, forKey: "twic.daily.minute") }
    }

    /// Same reference for the same calendar day, cycling through DailyVerses.json.
    func reference(for date: Date, calendar: Calendar = .current) -> String {
        let day = calendar.ordinality(of: .day, in: .era, for: date) ?? 0
        return references[((day % references.count) + references.count) % references.count]
    }

    struct Planned: Equatable { let id: String; let fire: DateComponents; let title: String; let body: String; let reference: String }

    func plan(from now: Date, calendar: Calendar = .current, translation: String? = nil) -> [Planned] {
        let tid = translation ?? store.selectedID
        let short = store.info(tid)?.short ?? tid
        var out: [Planned] = []
        for offset in 0..<Self.daysAhead {
            guard let day = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: now)),
                  let fireDate = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day),
                  fireDate > now else { continue }
            let ref = reference(for: day, calendar: calendar)
            guard let parsed = parser.parse(ref), let text = store.text(for: parsed, translation: tid) else { continue }
            let body = text.count > 220 ? String(text.prefix(217)) + "..." : text
            let comps = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: fireDate)
            let key = String(format: "%04d-%02d-%02d", comps.year ?? 0, comps.month ?? 0, comps.day ?? 0)
            out.append(Planned(id: Self.idPrefix + key, fire: comps, title: "\(parsed.label) (\(short))", body: body, reference: parsed.label))
        }
        return out
    }

    func enable(_ done: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async {
                self.isEnabled = granted
                if granted { self.reschedule() }
                done(granted)
            }
        }
    }

    func disable() {
        isEnabled = false
        removeAll()
    }

    func refreshIfEnabled() {
        guard isEnabled else { return }
        UNUserNotificationCenter.current().getNotificationSettings { s in
            guard s.authorizationStatus == .authorized || s.authorizationStatus == .provisional else { return }
            DispatchQueue.main.async { self.reschedule() }
        }
    }

    func reschedule() {
        let center = UNUserNotificationCenter.current()
        let items = plan(from: Date())
        center.getPendingNotificationRequests { pending in
            let old = pending.map(\.identifier).filter { $0.hasPrefix(Self.idPrefix) }
            center.removePendingNotificationRequests(withIdentifiers: old)
            for p in items {
                let c = UNMutableNotificationContent()
                c.title = p.title
                c.body = p.body
                c.sound = .default
                c.userInfo = [Self.referenceKey: p.reference]
                let trigger = UNCalendarNotificationTrigger(dateMatching: p.fire, repeats: false)
                center.add(UNNotificationRequest(identifier: p.id, content: c, trigger: trigger))
            }
        }
    }

    private func removeAll() {
        let center = UNUserNotificationCenter.current()
        center.getPendingNotificationRequests { pending in
            center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix(Self.idPrefix) })
        }
    }
}
