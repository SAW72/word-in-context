import UIKit

/// Read tab: native, fully offline Bible reader over the bundled translations.
final class ReaderViewController: UITableViewController {
    private let store = BibleStore.shared
    private var translation: BibleTranslation?
    private var verses: [BibleVerse] = []
    private var bookCode = UserDefaults.standard.string(forKey: "twic.book") ?? "JHN"
    private var chapter = UserDefaults.standard.object(forKey: "twic.chapter") as? Int ?? 1
    private var highlight: Int?
    private let speechInput = SpeechInput()
    private var speakButton: UIBarButtonItem!

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.backgroundColor = TwicTheme.parchment
        tableView.separatorStyle = .none
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "verse")
        tableView.estimatedRowHeight = 60
        tableView.rowHeight = UITableView.automaticDimension
        tableView.accessibilityIdentifier = "reader.table"

        speakButton = UIBarButtonItem(image: UIImage(systemName: "speaker.wave.2"), style: .plain, target: self, action: #selector(toggleSpeak))
        speakButton.accessibilityLabel = "Read chapter aloud"
        let mic = UIBarButtonItem(image: UIImage(systemName: "mic"), style: .plain, target: self, action: #selector(listen))
        mic.accessibilityLabel = "Say a passage"
        navigationItem.rightBarButtonItems = [translationButton(), speakButton, mic]
        navigationItem.leftBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "magnifyingglass"), style: .plain, target: self, action: #selector(typeReference))
        navigationItem.leftBarButtonItem?.accessibilityLabel = "Go to a passage"

        let left = UISwipeGestureRecognizer(target: self, action: #selector(nextChapter)); left.direction = .left
        let right = UISwipeGestureRecognizer(target: self, action: #selector(previousChapter)); right.direction = .right
        tableView.addGestureRecognizer(left)
        tableView.addGestureRecognizer(right)

        SpeechReader.shared.onStateChange = { [weak self] speaking in
            self?.speakButton.image = UIImage(systemName: speaking ? "stop.circle" : "speaker.wave.2")
        }
        NotificationCenter.default.addObserver(self, selector: #selector(openReferenceNote(_:)), name: .twicOpenReference, object: nil)
        loadTranslation(store.selectedID)
    }

    private func translationButton() -> UIBarButtonItem {
        let actions = store.translations.map { t in
            UIAction(title: "\(t.short)  \(t.name)", state: t.id == store.selectedID ? .on : .off) { [weak self] _ in
                self?.store.selectedID = t.id
                Haptics.select()
                self?.loadTranslation(t.id)
            }
        }
        let note = UIAction(title: "NET Bible is online only, in the Study tab", attributes: .disabled) { _ in }
        let item = UIBarButtonItem(title: store.info(store.selectedID)?.short ?? "BSB", menu: UIMenu(title: "Translation (offline)", children: actions + [note]))
        item.accessibilityIdentifier = "reader.translation"
        return item
    }

    func loadTranslation(_ id: String) {
        navigationItem.rightBarButtonItems?[0] = translationButton()
        DispatchQueue.global(qos: .userInitiated).async {
            let t = try? self.store.translation(id)
            DispatchQueue.main.async {
                self.translation = t
                self.show(book: self.bookCode, chapter: self.chapter, highlight: self.highlight)
            }
        }
    }

    func show(book: String, chapter: Int, highlight: Int? = nil) {
        guard let t = translation, let b = t.book(book) else { return }
        bookCode = book
        self.chapter = max(1, min(chapter, b.chapters.count))
        self.highlight = highlight
        verses = t.chapter(bookCode, self.chapter)
        UserDefaults.standard.set(bookCode, forKey: "twic.book")
        UserDefaults.standard.set(self.chapter, forKey: "twic.chapter")
        let titleButton = UIButton(type: .system)
        titleButton.setTitle("\(b.name) \(self.chapter) \u{25BE}", for: .normal)
        titleButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        titleButton.addTarget(self, action: #selector(pickPassage), for: .touchUpInside)
        titleButton.accessibilityIdentifier = "reader.title"
        navigationItem.titleView = titleButton
        tableView.tableFooterView = footer()
        tableView.reloadData()
        if let h = highlight, let row = verses.firstIndex(where: { $0.number == h }) {
            tableView.scrollToRow(at: IndexPath(row: row, section: 0), at: .top, animated: false)
        } else if !verses.isEmpty {
            tableView.scrollToRow(at: IndexPath(row: 0, section: 0), at: .top, animated: false)
        }
    }

    private func footer() -> UIView {
        let prev = UIButton(type: .system); prev.setTitle("Previous", for: .normal)
        prev.addTarget(self, action: #selector(previousChapter), for: .touchUpInside)
        let next = UIButton(type: .system); next.setTitle("Next", for: .normal)
        next.addTarget(self, action: #selector(nextChapter), for: .touchUpInside)
        let credit = UILabel()
        credit.text = store.info(store.selectedID).map { "\($0.name). \($0.license)." } ?? ""
        credit.font = .preferredFont(forTextStyle: .caption2)
        credit.textColor = .secondaryLabel
        credit.numberOfLines = 0
        credit.textAlignment = .center
        let row = UIStackView(arrangedSubviews: [prev, next]); row.distribution = .fillEqually
        let stack = UIStackView(arrangedSubviews: [row, credit]); stack.axis = .vertical; stack.spacing = 8
        stack.frame = CGRect(x: 0, y: 0, width: tableView.bounds.width, height: 110)
        stack.isLayoutMarginsRelativeArrangement = true
        stack.layoutMargins = UIEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
        return stack
    }

    // MARK: Table

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { verses.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "verse", for: indexPath)
        let v = verses[indexPath.row]
        var content = cell.defaultContentConfiguration()
        let text = NSMutableAttributedString(string: "\(v.number)  ", attributes: [
            .font: UIFont.preferredFont(forTextStyle: .caption1), .foregroundColor: TwicTheme.gold, .baselineOffset: 4])
        text.append(NSAttributedString(string: v.text, attributes: [.font: TwicTheme.scriptureFont(.body), .foregroundColor: UIColor.label]))
        content.attributedText = text
        cell.contentConfiguration = content
        cell.backgroundColor = v.number == highlight ? TwicTheme.gold.withAlphaComponent(0.18) : .clear
        cell.accessibilityIdentifier = "verse.\(v.number)"
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        Haptics.select()
        let v = verses[indexPath.row]
        let ref = "\(translation?.book(bookCode)?.name ?? bookCode) \(chapter):\(v.number)"
        let sheet = UIAlertController(title: ref, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Share", style: .default) { [weak self] _ in self?.share(ref: ref, text: v.text, from: indexPath) })
        sheet.addAction(UIAlertAction(title: "Listen", style: .default) { _ in SpeechReader.shared.speak("\(ref). \(v.text)") })
        sheet.addAction(UIAlertAction(title: "Copy", style: .default) { [weak self] _ in
            UIPasteboard.general.string = VerseShare.text(reference: ref, translationShort: self?.translation?.info.short ?? "", body: v.text)
            Haptics.success()
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.sourceView = tableView.cellForRow(at: indexPath)
        present(sheet, animated: true)
    }

    private func share(ref: String, text: String, from indexPath: IndexPath) {
        let body = VerseShare.text(reference: ref, translationShort: translation?.info.short ?? "", body: text)
        let vc = UIActivityViewController(activityItems: [body], applicationActivities: nil)
        vc.completionWithItemsHandler = { _, completed, _, _ in if completed { Haptics.success() } }
        vc.popoverPresentationController?.sourceView = tableView.cellForRow(at: indexPath)
        present(vc, animated: true)
    }

    // MARK: Navigation

    @objc func nextChapter() {
        guard let t = translation, let bi = t.books.firstIndex(where: { $0.id == bookCode }) else { return }
        Haptics.tap()
        if chapter < t.books[bi].chapters.count { show(book: bookCode, chapter: chapter + 1) }
        else if bi + 1 < t.books.count { show(book: t.books[bi + 1].id, chapter: 1) }
    }

    @objc func previousChapter() {
        guard let t = translation, let bi = t.books.firstIndex(where: { $0.id == bookCode }) else { return }
        Haptics.tap()
        if chapter > 1 { show(book: bookCode, chapter: chapter - 1) }
        else if bi > 0 { show(book: t.books[bi - 1].id, chapter: t.books[bi - 1].chapters.count) }
    }

    @objc private func pickPassage() {
        guard let t = translation else { return }
        let picker = PassagePickerViewController(books: t.books) { [weak self] book, ch in
            self?.show(book: book, chapter: ch)
        }
        present(UINavigationController(rootViewController: picker), animated: true)
    }

    @objc private func toggleSpeak() {
        if SpeechReader.shared.isSpeaking { SpeechReader.shared.stop(); return }
        let name = translation?.book(bookCode)?.name ?? bookCode
        SpeechReader.shared.speak("\(name) chapter \(chapter). " + verses.map(\.text).joined(separator: " "))
    }

    @objc private func typeReference() {
        let alert = UIAlertController(title: "Go to a passage", message: "For example John 3:16 or Psalm 23", preferredStyle: .alert)
        alert.addTextField { $0.placeholder = "John 3:16"; $0.autocapitalizationType = .words }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Go", style: .default) { [weak self, weak alert] _ in
            self?.open(text: alert?.textFields?.first?.text ?? "", spoken: false)
        })
        present(alert, animated: true)
    }

    @discardableResult
    func open(text: String, spoken: Bool) -> Bool {
        let parser = ReferenceParser.shared
        guard let ref = spoken ? parser.parseSpoken(text) : parser.parse(text) else {
            let a = UIAlertController(title: "Passage not found", message: "Try a book and chapter, like Romans 8.", preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default))
            present(a, animated: true)
            return false
        }
        Haptics.success()
        show(book: ref.bookCode, chapter: ref.chapter, highlight: ref.wholeChapter ? nil : ref.verseStart)
        return true
    }

    @objc private func openReferenceNote(_ note: Notification) {
        if let ref = note.userInfo?["reference"] as? String {
            tabBarController?.selectedIndex = 0
            open(text: ref, spoken: false)
        }
    }

    @objc private func listen() {
        SpeechInput.requestAccess { [weak self] ok in
            guard let self else { return }
            guard ok else {
                let a = UIAlertController(title: "Microphone is off", message: "Turn on Microphone and Speech Recognition for The Word in Settings to say a passage.", preferredStyle: .alert)
                a.addAction(UIAlertAction(title: "OK", style: .default))
                self.present(a, animated: true)
                return
            }
            let a = UIAlertController(title: "Say a passage", message: "Listening...", preferredStyle: .alert)
            var latest = ""
            self.speechInput.onTranscript = { [weak self, weak a] text, final in
                latest = text
                a?.message = text
                if final, let self {
                    a?.dismiss(animated: true) { self.open(text: latest, spoken: true) }
                }
            }
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.speechInput.stop() })
            a.addAction(UIAlertAction(title: "Go", style: .default) { [weak self] _ in
                self?.speechInput.stop()
                self?.open(text: latest, spoken: true)
            })
            Haptics.tap()
            self.present(a, animated: true)
            do { try self.speechInput.start() } catch { a.message = "Speech recognition is not available right now." }
        }
    }
}

final class PassagePickerViewController: UITableViewController {
    private let books: [BibleBook]
    private let onPick: (String, Int) -> Void
    private var selectedBook: BibleBook?

    init(books: [BibleBook], onPick: @escaping (String, Int) -> Void) {
        self.books = books
        self.onPick = onPick
        super.init(style: .insetGrouped)
        title = "Books"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "c")
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    }

    override func numberOfSections(in tableView: UITableView) -> Int { 2 }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { section == 0 ? "Old Testament" : "New Testament" }
    private func list(_ section: Int) -> ArraySlice<BibleBook> { section == 0 ? books.prefix(39) : books.dropFirst(39) }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { list(section).count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "c", for: indexPath)
        let b = list(indexPath.section)[list(indexPath.section).startIndex + indexPath.row]
        var c = cell.defaultContentConfiguration(); c.text = b.name; c.secondaryText = "\(b.chapters.count)"
        cell.contentConfiguration = c
        cell.accessoryType = .disclosureIndicator
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        let b = list(indexPath.section)[list(indexPath.section).startIndex + indexPath.row]
        Haptics.select()
        if b.chapters.count == 1 { onPick(b.id, 1); dismiss(animated: true); return }
        let grid = ChapterGridViewController(book: b) { [weak self] ch in
            self?.onPick(b.id, ch)
            self?.dismiss(animated: true)
        }
        navigationController?.pushViewController(grid, animated: true)
    }
}

final class ChapterGridViewController: UICollectionViewController {
    private let book: BibleBook
    private let onPick: (Int) -> Void

    init(book: BibleBook, onPick: @escaping (Int) -> Void) {
        self.book = book
        self.onPick = onPick
        let layout = UICollectionViewFlowLayout()
        layout.itemSize = CGSize(width: 56, height: 48)
        layout.minimumInteritemSpacing = 8
        layout.minimumLineSpacing = 8
        layout.sectionInset = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        super.init(collectionViewLayout: layout)
        title = book.name
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        collectionView.backgroundColor = .systemGroupedBackground
        collectionView.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "c")
    }

    override func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { book.chapters.count }

    override func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "c", for: indexPath)
        var c = UIListContentConfiguration.cell()
        c.text = "\(indexPath.item + 1)"
        c.textProperties.alignment = .center
        cell.contentConfiguration = c
        var bg = UIBackgroundConfiguration.clear()
        bg.backgroundColor = .secondarySystemGroupedBackground
        bg.cornerRadius = 8
        cell.backgroundConfiguration = bg
        return cell
    }

    override func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        Haptics.select()
        onPick(indexPath.item + 1)
    }
}
