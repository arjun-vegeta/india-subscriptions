// swift-tools-version: 6.0
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
        .target(name: "IndiaSubscriptions"),
        // Models, the HTTP backend and the persisted record store. Needs no StoreKit environment: `swift test` runs it.
        .testTarget(
            name: "IndiaSubscriptionsTests",
            dependencies: ["IndiaSubscriptions"],
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
