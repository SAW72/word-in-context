import XCTest
@testable import Twic

/// Fixtures live in ios/fixtures and are shared with ios/tests/ios-bundle.test.js.
private func fixture(_ name: String) throws -> [String: Any] {
    let url = try XCTUnwrap(Bundle(for: ReferenceParserTests.self).url(forResource: name, withExtension: "json"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
}

/// Web source: lib/scripture-refs.js parseReference (run unchanged in JavaScriptCore).
final class ReferenceParserTests: XCTestCase {
    func testSharedFixtureMatchesWebParser() throws {
        let parser = ReferenceParser(bundle: .main)
        XCTAssertTrue(parser.isReady)
        let cases = try XCTUnwrap(fixture("scripture-refs")["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 10)
        for c in cases {
            let input = c["input"] as? String ?? ""
            let got = parser.parse(input)
            guard let exp = c["expected"] as? [String: Any] else { XCTAssertNil(got, input); continue }
            let g = try XCTUnwrap(got, input)
            XCTAssertEqual(g.bookCode, exp["bookCode"] as? String, input)
            XCTAssertEqual(g.bookDisplay, exp["bookDisplay"] as? String, input)
            XCTAssertEqual(g.chapter, exp["chapter"] as? Int, input)
            XCTAssertEqual(g.verseStart, exp["verseStart"] as? Int, input)
            XCTAssertEqual(g.verseEnd, exp["verseEnd"] as? Int, input)
            XCTAssertEqual(g.wholeChapter, exp["wholeChapter"] as? Bool, input)
        }
    }

    func testSpokenCleanup() {
        let p = ReferenceParser(bundle: .main)
        XCTAssertEqual(p.parseSpoken("Go to John chapter 3 verse 16.")?.label, "John 3:16")
        XCTAssertEqual(p.parseSpoken("Open Psalm 23.")?.label, "Psalm 23")
        // Same as the web parser: "twenty three" reads as chapter 20 verse 3 (web quirk, reported).
        XCTAssertEqual(p.parseSpoken("Psalm twenty three")?.label, "Psalm 20:3")
        XCTAssertNil(p.parseSpoken("hello there"))
    }
}

/// Web source: lib/bible-fetch.js flattenVerseContent (applied at bundle build time).
final class BibleStoreTests: XCTestCase {
    func testManifestHasSixOfflineTranslationsAndNoESV() {
        let store = BibleStore(bundle: .main)
        XCTAssertEqual(store.translations.map(\.short), ["BSB", "KJV", "ASV", "YLT", "DBY", "WEB"])
        XCTAssertEqual(store.defaultID, "BSB")
        XCTAssertFalse(store.translations.contains { $0.id.uppercased().contains("ESV") || $0.short.uppercased().contains("ESV") })
    }

    func testVerseFixturesMatchBundledText() throws {
        let store = BibleStore(bundle: .main)
        let parser = ReferenceParser(bundle: .main)
        let verses = try XCTUnwrap(fixture("bible-verses")["verses"] as? [[String: Any]])
        for v in verses {
            let ref = try XCTUnwrap(parser.parse(v["reference"] as? String ?? ""))
            let got = store.text(for: ref, translation: v["translation"] as? String ?? "")
            XCTAssertEqual(got, v["text"] as? String, "\(ref.label) \(v["translation"] ?? "")")
        }
    }

    func testEveryTranslationLoadsAllBooks() throws {
        let store = BibleStore(bundle: .main)
        for info in store.translations {
            let t = try store.translation(info.id)
            XCTAssertEqual(t.books.count, 66, info.id)
            XCTAssertEqual(t.books.reduce(0) { $0 + $1.chapters.reduce(0) { $0 + $1.count } }, info.verses, info.id)
        }
    }
}

final class DailyVerseTests: XCTestCase {
    func testPlansThirtyDistinctLocalNotifications() {
        let defaults = UserDefaults(suiteName: "twic.tests.daily")!
        defaults.removePersistentDomain(forName: "twic.tests.daily")
        let s = DailyVerseScheduler(defaults: defaults, store: BibleStore(bundle: .main), parser: ReferenceParser(bundle: .main), bundle: .main)
        s.hour = 7; s.minute = 0
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/New_York")!
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 25, hour: 23, minute: 30))!
        let plan = s.plan(from: now, calendar: cal, translation: "BSB")
        XCTAssertEqual(plan.count, 29, "today 7:00 already passed, so 29 of the next 30 days")
        XCTAssertEqual(Set(plan.map(\.id)).count, plan.count)
        XCTAssertEqual(plan.first?.fire.day, 26)
        XCTAssertTrue(plan.allSatisfy { !$0.body.isEmpty && $0.title.hasSuffix("(BSB)") })
        XCTAssertEqual(s.reference(for: now, calendar: cal), s.reference(for: now.addingTimeInterval(-3600), calendar: cal))
    }
}

final class PurchaseGuardTests: XCTestCase {
    func testBlocksPurchaseHostsAndLanding() {
        XCTAssertEqual(PurchaseGuard.decide(URL(string: "https://whop.com/checkout/abc")), .block)
        XCTAssertEqual(PurchaseGuard.decide(URL(string: "https://sub.whop.com/x")), .block)
        XCTAssertEqual(PurchaseGuard.decide(URL(string: "https://checkout.stripe.com/c/pay")), .block)
        XCTAssertEqual(PurchaseGuard.decide(URL(string: "https://thewordincontext.org/")), .openStudy)
        XCTAssertEqual(PurchaseGuard.decide(URL(string: "https://thewordincontext.org/#signup")), .openStudy)
        XCTAssertEqual(PurchaseGuard.decide(URL(string: "https://thewordincontext.org/success")), .openStudy)
        XCTAssertEqual(PurchaseGuard.decide(URL(string: "https://thewordincontext.org/app")), .allow)
        XCTAssertEqual(PurchaseGuard.decide(URL(string: "https://thewordincontext.org/read#John/3")), .allow)
        XCTAssertEqual(PurchaseGuard.decide(URL(string: "https://bible.helloao.org/api/BSB/JHN/3.json")), .allow)
    }

    func testShareTextHasNoLinksOrPrices() {
        let t = VerseShare.text(reference: "John 3:16", translationShort: "BSB", body: "For God so loved the world")
        XCTAssertTrue(t.contains("John 3:16 (BSB)"))
        XCTAssertFalse(t.contains("http"))
        XCTAssertFalse(t.contains("$"))
    }
}
