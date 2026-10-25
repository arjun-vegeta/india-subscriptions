// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "india_subscriptions",
    platforms: [
        // The iOS SDK of this repository needs iOS 15.
        .iOS("15.0")
    ],
    products: [
        .library(name: "india-subscriptions", targets: ["india_subscriptions"])
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework"),
        // The iOS SDK of this repository (sdks/ios), consumed by path. A published plugin names the SDK's repository
        // here instead (see the README). SwiftPM names a path dependency after its directory.
        .package(path: "../../../ios"),
    ],
    targets: [
        .target(
            name: "india_subscriptions",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework"),
                .product(name: "IndiaSubscriptions", package: "ios"),
            ]
        )
    ]
)
