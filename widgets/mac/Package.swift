// swift-tools-version:5.10
// The CELLO app for a Mac. SwiftPM is for development and tests. The app itself is built by scripts/assemble.sh with
// swiftc directly, one architecture at a time, so it needs only the command-line tools.
import PackageDescription

let package = Package(
    name: "CELLO",
    platforms: [.macOS(.v14)],
    targets: [
        // Everything that can be tested without a screen: the protocol, the state, the looks and every line of copy.
        .target(name: "CELLOCore", path: "Sources/CELLOCore"),
        .executableTarget(name: "CELLO", dependencies: ["CELLOCore"], path: "Sources/CELLO"),
        // Speaks to the operator's door through CELLOCore, driven by JSON lines, for the live test. Shows nothing.
        .executableTarget(name: "cello-door-probe", dependencies: ["CELLOCore"], path: "Sources/cello-door-probe"),
        .testTarget(name: "CELLOCoreTests", dependencies: ["CELLOCore"], path: "Tests/CELLOCoreTests"),
    ]
)
