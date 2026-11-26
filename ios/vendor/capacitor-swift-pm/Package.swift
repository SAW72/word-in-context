// swift-tools-version:5.3
import PackageDescription

// Local pin of ionic-team/capacitor-swift-pm 8.6.3.
// Path binary targets are used so xcodebuild does not download GitHub release
// zips (that download asks the macOS keychain for HTTP credentials and can hang
// while another codesign is waiting on the Apple Distribution dialog).
let package = Package(
    name: "capacitor-swift-pm",
    products: [
        .library(name: "Capacitor", targets: ["Capacitor"]),
        .library(name: "Cordova", targets: ["Cordova"])
    ],
    dependencies: [],
    targets: [
        .binaryTarget(name: "Capacitor", path: "Capacitor.xcframework"),
        .binaryTarget(name: "Cordova", path: "Cordova.xcframework")
    ]
)
