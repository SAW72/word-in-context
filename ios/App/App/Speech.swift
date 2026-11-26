import AVFoundation
import Speech

/// Reads verses aloud with the on-device AVSpeechSynthesizer. No network.
final class SpeechReader: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = SpeechReader()
    private let synth = AVSpeechSynthesizer()
    var onStateChange: ((Bool) -> Void)?

    override init() {
        super.init()
        synth.delegate = self
    }

    var isSpeaking: Bool { synth.isSpeaking }

    static var rate: Float {
        get { UserDefaults.standard.object(forKey: "twic.ttsRate") as? Float ?? AVSpeechUtteranceDefaultSpeechRate }
        set { UserDefaults.standard.set(newValue, forKey: "twic.ttsRate") }
    }

    func speak(_ text: String) {
        stop()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = AVSpeechUtterance(string: text)
        u.rate = Self.rate
        u.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode()) ?? AVSpeechSynthesisVoice(language: "en-US")
        synth.speak(u)
        onStateChange?(true)
    }

    func stop() {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finish() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { finish() }

    private func finish() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        DispatchQueue.main.async { self.onStateChange?(false) }
    }
}

/// Speech to text for "say a passage". Uses on-device recognition when the
/// iPhone supports it; otherwise Apple's speech service handles the audio.
final class SpeechInput {
    enum Failure: Error { case notAuthorized, unavailable }

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    var onTranscript: ((String, Bool) -> Void)?

    static func requestAccess(_ done: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else { DispatchQueue.main.async { done(false) }; return }
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async { done(granted) }
            }
        }
    }

    var usesOnDevice: Bool { recognizer?.supportsOnDeviceRecognition ?? false }

    func start() throws {
        guard let recognizer, recognizer.isAvailable else { throw Failure.unavailable }
        stop()
        SpeechReader.shared.stop()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        req.contextualStrings = ["Genesis", "Psalm", "Proverbs", "Isaiah", "Matthew", "John", "Romans", "Corinthians", "Hebrews", "Revelation"]
        request = req
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
        engine.prepare()
        try engine.start()
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            if let result {
                let text = result.bestTranscription.formattedString
                DispatchQueue.main.async { self?.onTranscript?(text, result.isFinal) }
                if result.isFinal { self?.stop() }
            } else if error != nil {
                self?.stop()
            }
        }
    }

    func stop() {
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
