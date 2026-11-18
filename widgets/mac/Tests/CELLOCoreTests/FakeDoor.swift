// A scripted operator's door on a real Unix socket, for the cases a real daemon won't produce on demand: a refused
// subscribe, a line dropped before its answer. The live test covers the real door.
import Foundation

final class FakeDoor: @unchecked Sendable {
    let path: String
    private let lock = NSLock()
    private var listener: Int32 = -1
    private var client: Int32 = -1
    private var received: [[String: Any]] = []
    // Given each request, the answer to write, or nil to drop the connection without one.
    var answer: ([String: Any]) -> [String: Any]? = { request in ["op": "result", "ref": request["ref"] ?? "", "ok": true] }
    // Given each request, frames pushed after its answer, such as the notifications a subscribe brings.
    var then: ([String: Any]) -> [[String: Any]] = { _ in [] }

    init() {
        path = "/tmp/cello-fake-\(UUID().uuidString.prefix(8)).sock"
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            buf.copyBytes(from: bytes)
            buf[bytes.count] = 0
        }
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        listen(listener, 4)
        Thread.detachNewThread { [self] in serve() }
    }

    var requests: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return received
    }

    func close() {
        Darwin.close(listener)
        unlink(path)
    }

    private func serve() {
        while true {
            let fd = accept(listener, nil, nil)
            if fd < 0 { return }
            var pending = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            reading: while true {
                let n = read(fd, &buffer, buffer.count)
                if n <= 0 { break }
                pending.append(contentsOf: buffer[0..<n])
                while let nl = pending.firstIndex(of: 0x0A) {
                    let line = pending[pending.startIndex..<nl]
                    pending.removeSubrange(pending.startIndex...nl)
                    guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    lock.lock()
                    received.append(request)
                    lock.unlock()
                    guard let reply = answer(request) else { break reading }
                    for frame in [reply] + then(request) {
                        guard var data = try? JSONSerialization.data(withJSONObject: frame) else { continue }
                        data.append(0x0A)
                        _ = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
                    }
                }
            }
            Darwin.close(fd)
        }
    }
}

func waitUntil(_ timeout: TimeInterval = 10, _ check: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !check() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    return check()
}
