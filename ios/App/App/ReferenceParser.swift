import Foundation
import JavaScriptCore

struct ParsedReference: Equatable {
    let bookCode: String
    let bookDisplay: String
    let chapter: Int
    let verseStart: Int
    /// nil means the whole chapter (Infinity in the web parser).
    let verseEnd: Int?
    let wholeChapter: Bool

    var label: String {
        if wholeChapter { return "\(bookDisplay) \(chapter)" }
        if let end = verseEnd, end != verseStart { return "\(bookDisplay) \(chapter):\(verseStart)-\(end)" }
        return "\(bookDisplay) \(chapter):\(verseStart)"
    }
}

/// Runs the web app's own lib/scripture-refs.js (bundled unchanged) in
/// JavaScriptCore, so spoken and typed references parse exactly like the web.
/// Web source: lib/scripture-refs.js parseReference.
final class ReferenceParser {
    static let shared = ReferenceParser()
    private let context: JSContext?
    private let parseFn: JSValue?

    init(bundle: Bundle = .main) {
        guard let url = bundle.url(forResource: "scripture-refs", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8),
              let ctx = JSContext() else {
            context = nil; parseFn = nil; return
        }
        ctx.evaluateScript("var module = { exports: {} }; var exports = module.exports;")
        ctx.evaluateScript(source)
        context = ctx
        parseFn = ctx.evaluateScript("module.exports.parseReference")
    }

    var isReady: Bool { parseFn?.isObject == true }

    func parse(_ text: String) -> ParsedReference? {
        guard let fn = parseFn, let result = fn.call(withArguments: [text]), result.isObject else { return nil }
        guard let code = result.forProperty("bookCode")?.toString(), !code.isEmpty else { return nil }
        let display = result.forProperty("bookDisplay")?.toString() ?? code
        let chapter = Int(result.forProperty("chapter")?.toInt32() ?? 0)
        let start = Int(result.forProperty("verseStart")?.toInt32() ?? 1)
        let endRaw = result.forProperty("verseEnd")?.toDouble() ?? .infinity
        let whole = result.forProperty("wholeChapter")?.toBool() ?? false
        return ParsedReference(bookCode: code, bookDisplay: display, chapter: chapter, verseStart: start,
                               verseEnd: endRaw.isFinite ? Int(endRaw) : nil, wholeChapter: whole)
    }

    /// Speech often comes back as "John 3 16." or "go to Psalm 23". Strip filler, then parse.
    func parseSpoken(_ transcript: String) -> ParsedReference? {
        var t = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        t = t.replacingOccurrences(of: #"[.,!?;]+$"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"^(?i)(go to|open|read|turn to|show me)\s+"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"(?i)\b(chapter|verse|verses)\b"#, with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return parse(t)
    }
}

enum VerseShare {
    /// Plain text used for the share sheet and Copy. No links to purchase pages.
    static func text(reference: String, translationShort: String, body: String) -> String {
        "\u{201C}\(body)\u{201D}\n\(reference) (\(translationShort))\n\nRead in The Word in Context"
    }
}
