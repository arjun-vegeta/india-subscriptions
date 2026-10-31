require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "IndiaSubscriptionsReactNative"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/arjun-vegeta/ffu4"
  s.license      = package["license"]
  s.authors      = "india-subscriptions contributors"

  s.platforms    = { :ios => "15.0" }
  s.source       = { :git => "https://github.com/arjun-vegeta/ffu4.git", :tag => "v#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift,cpp}"
  s.private_header_files = "ios/**/*.h"

  # The bridge's own Swift is written for the Swift 5 language mode; the SDK it calls builds in Swift 6 mode as a package.
  s.swift_version = "5.0"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  install_modules_dependencies(s)

  # The iOS SDK is a Swift package, not a pod. React Native's `spm_dependency` helper links a Swift package product into
  # this pod. In this repository the package is next to the bridge (`sdks/ios`) and is used by path; a published
  # package of the bridge asks for the released package instead.
  sdk_products = ["IndiaSubscriptions"]
  sdk_path = File.expand_path(File.join(__dir__, "..", "ios"))
  if File.exist?(File.join(sdk_path, "Package.swift"))
    spm_dependency(s, url: sdk_path, requirement: {}, products: sdk_products)
  else
    spm_dependency(
      s,
      url: "https://github.com/arjun-vegeta/ffu4",
      requirement: { kind: "upToNextMajorVersion", minimumVersion: "0.1.0" },
      products: sdk_products
    )
  end
end
