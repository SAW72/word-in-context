import Foundation

/// Offline Bible text bundled with the app (ios/App/App/Bible).
/// Built by ios/scripts/build-bible-bundle.js from bible.helloao.org with the
/// web app's own flattenVerseContent (lib/bible-fetch.js).
struct TranslationInfo: Equatable {
    let id: String
    let short: String
    let name: String
    let license: String
    let source: String
    let file: String
    let verses: Int
}

struct BibleVerse: Equatable {
    let number: Int
    let text: String
}

struct BibleBook {
    let id: String
    let name: String
    let chapters: [[BibleVerse]]
}

final class BibleTranslation {
    let info: TranslationInfo
    let books: [BibleBook]
    private let index: [String: Int]

    init(info: TranslationInfo, books: [BibleBook]) {
        self.info = info
        self.books = books
        var idx: [String: Int] = [:]
        for (i, b) in books.enumerated() { idx[b.id] = i }
        index = idx
    }

    func book(_ code: String) -> BibleBook? { index[code].map { books[$0] } }

    func chapter(_ code: String, _ chapter: Int) -> [BibleVerse] {
        guard let b = book(code), chapter >= 1, chapter <= b.chapters.count else { return [] }
        return b.chapters[chapter - 1]
    }

    func verses(_ code: String, _ chapter: Int, from start: Int, to end: Int) -> [BibleVerse] {
        self.chapter(code, chapter).filter { $0.number >= start && $0.number <= end }
    }
}

enum BibleStoreError: Error { case missingManifest, missingFile(String), badData(String) }

final class BibleStore {
    static let shared = BibleStore()
    static let defaultTranslationKey = "twic.translation"

    let bundle: Bundle
    private(set) var translations: [TranslationInfo] = []
    private(set) var defaultID = "BSB"
    private var cache: [String: BibleTranslation] = [:]
    private let lock = NSLock()

    init(bundle: Bundle = .main) {
        self.bundle = bundle
        try? loadManifest()
    }

    private func url(for name: String) -> URL? {
        bundle.url(forResource: name, withExtension: nil, subdirectory: "Bible")
            ?? bundle.url(forResource: name, withExtension: nil)
    }

    func loadManifest() throws {
        guard let u = url(for: "manifest.json") else { throw BibleStoreError.missingManifest }
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: u)) as? [String: Any] ?? [:]
        defaultID = obj["default"] as? String ?? "BSB"
        let list = obj["translations"] as? [[String: Any]] ?? []
        translations = list.compactMap { t in
            guard let id = t["id"] as? String, let short = t["short"] as? String, let file = t["file"] as? String else { return nil }
            return TranslationInfo(id: id, short: short, name: t["name"] as? String ?? short,
                                   license: t["license"] as? String ?? "", source: t["source"] as? String ?? "",
                                   file: file, verses: t["verses"] as? Int ?? 0)
        }
    }

    var selectedID: String {
        get {
            let saved = UserDefaults.standard.string(forKey: Self.defaultTranslationKey)
            return translations.contains { $0.id == saved } ? saved! : defaultID
        }
        set { UserDefaults.standard.set(newValue, forKey: Self.defaultTranslationKey) }
    }

    func info(_ id: String) -> TranslationInfo? { translations.first { $0.id == id } }

    func translation(_ id: String) throws -> BibleTranslation {
        lock.lock(); defer { lock.unlock() }
        if let hit = cache[id] { return hit }
        guard let info = info(id) else { throw BibleStoreError.missingFile(id) }
        guard let u = url(for: info.file) else { throw BibleStoreError.missingFile(info.file) }
        let raw = try NSData(contentsOf: u).decompressed(using: .zlib) as Data
        guard let obj = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let books = obj["books"] as? [[String: Any]] else { throw BibleStoreError.badData(id) }
        let parsed: [BibleBook] = books.map { b in
            let chapters = (b["chapters"] as? [[[Any]]] ?? []).map { ch in
                ch.compactMap { pair -> BibleVerse? in
                    guard pair.count == 2, let n = (pair[0] as? NSNumber)?.intValue, let text = pair[1] as? String else { return nil }
                    return BibleVerse(number: n, text: text)
                }
            }
            return BibleBook(id: b["id"] as? String ?? "", name: b["name"] as? String ?? "", chapters: chapters)
        }
        let t = BibleTranslation(info: info, books: parsed)
        cache[id] = t
        return t
    }

    /// Text for a parsed reference, or nil if the translation omits it.
    func text(for ref: ParsedReference, translation id: String) -> String? {
        guard let t = try? translation(id) else { return nil }
        let end = ref.verseEnd ?? Int.max
        let verses = ref.wholeChapter ? t.chapter(ref.bookCode, ref.chapter) : t.verses(ref.bookCode, ref.chapter, from: ref.verseStart, to: end)
        guard !verses.isEmpty else { return nil }
        if verses.count == 1 { return verses[0].text }
        return verses.map { "\($0.number) \($0.text)" }.joined(separator: " ")
    }
}
