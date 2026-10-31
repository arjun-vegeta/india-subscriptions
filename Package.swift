// swift-tools-version: 6.0
//
// The iOS SDK as a package at the repository root, so that an app or a plugin can depend on it by this repository's URL:
//
//     .package(url: "<this repository's URL>", from: "0.1.0")
//     .product(name: "IndiaSubscriptions", package: "<repository name>")
//
// The sources are the ones of sdks/ios, which keeps its own Package.swift (and the tests) for development by path.
// Only the paths below are part of this package; nothing else in the repository is read by SwiftPM.
import PackageDescription

let package = Package(
    name: "IndiaSubscriptions",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(name: "IndiaSubscriptions", targets: ["IndiaSubscriptions"]),
    ],
    targets: [
        .target(
            name: "IndiaSubscriptions",
            path: "sdks/ios/Sources/IndiaSubscriptions"
        ),
    ],
    swiftLanguageModes: [.v6]
)
