// Where CELLO lives and how to start it. `cello notifier-add mac` writes launch.json, because an app opened from Finder
// or at login gets a bare PATH and couldn't find node or cello by itself.
import Foundation

public struct LaunchInfo: Equatable, Sendable {
    public let celloHome: String
    // The command that starts CELLO in the background: node, the cello command's script, and "login". nil when the app
    // was never told, and then it says so rather than guessing.
    public let start: [String]?

    public var socketPath: String { (celloHome as NSString).appendingPathComponent("operator.sock") }

    public init(celloHome: String, start: [String]?) {
        self.celloHome = celloHome
        self.start = start
    }

    public static func defaultURL(home: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/CELLO/launch.json")
    }

    // No file: CELLO's own default folder, as the cello command uses, and no way to start it.
    public static func load(from url: URL, home: String = NSHomeDirectory()) throws -> LaunchInfo {
        let fallbackHome = (home as NSString).appendingPathComponent(".cello")
        guard FileManager.default.fileExists(atPath: url.path) else { return LaunchInfo(celloHome: fallbackHome, start: nil) }
        let data = try Data(contentsOf: url)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LaunchError.unreadable(url.path)
        }
        let celloHome = dict["cello_home"] as? String ?? fallbackHome
        let start = (dict["start"] as? [String]).flatMap { $0.isEmpty ? nil : $0 }
        return LaunchInfo(celloHome: celloHome, start: start)
    }
}

public enum LaunchError: Error, Equatable, CustomStringConvertible {
    case unreadable(String)
    case notInstalled(String)
    case exited(Int32, String)
    case timedOut

    public var description: String {
        switch self {
        case let .unreadable(path): return "\(path) isn't a JSON object"
        case let .notInstalled(path): return "\(path) isn't there any more"
        case let .exited(code, output): return "cello login exited with \(code): \(output)"
        case .timedOut: return "cello login didn't finish in time"
        }
    }
}

public enum CelloStarter {
    // Runs the start command and waits for it, at most `timeout` seconds. cello login itself waits for CELLO to answer.
    public static func start(_ info: LaunchInfo, timeout: TimeInterval = 60) -> Result<Void, LaunchError> {
        guard let command = info.start, let executable = command.first else { return .failure(.notInstalled("launch.json")) }
        guard FileManager.default.isExecutableFile(atPath: executable) else { return .failure(.notInstalled(executable)) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(command.dropFirst())
        var env = ProcessInfo.processInfo.environment
        env["CELLO_HOME"] = info.celloHome
        // Not an agent's shell: the person's own app.
        env.removeValue(forKey: "CELLO_CALLER")
        process.environment = env
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        process.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        do {
            try process.run()
        } catch {
            return .failure(.notInstalled(executable))
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            return .failure(.timedOut)
        }
        let said = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return process.terminationStatus == 0 ? .success(()) : .failure(.exited(process.terminationStatus, said))
    }
}
