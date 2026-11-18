// The connection to the operator's door: a Unix socket, one JSON object a line. It says hello, keeps reconnecting while
// CELLO is away, and matches each answer to its request by ref. Events arrive on the queue given, in order.
import Foundation

public enum ConnectFailure: Equatable, Sendable {
    // No socket file, or nothing listening on it: CELLO isn't running.
    case notRunning
    case other(Int32)
}

public enum ClientEvent: @unchecked Sendable {
    // Connected and hello accepted: requests can go.
    case ready
    case connectFailed(ConnectFailure)
    case disconnected
    // The door speaks another version. The client stops trying until start() is called again.
    case refused(String)
    case frame(Frame)
    // A line that couldn't be read. The connection carries on.
    case badLine(String)
}

public final class OperatorClient: @unchecked Sendable {
    public let socketPath: String
    public var retryInterval: TimeInterval = 1
    private let queue: DispatchQueue
    private let handler: (ClientEvent) -> Void
    private let lock = NSLock()
    private var fd: Int32 = -1
    private var running = false
    private var helloRef: String?
    private var pending: [String: (Reply) -> Void] = [:]
    private var thread: Thread?

    public init(socketPath: String, queue: DispatchQueue = .main, handler: @escaping (ClientEvent) -> Void) {
        self.socketPath = socketPath
        self.queue = queue
        self.handler = handler
    }

    public func start() {
        lock.lock()
        defer { lock.unlock() }
        guard !running else { return }
        running = true
        let t = Thread { [weak self] in self?.loop() }
        t.name = "CELLO operator door"
        thread = t
        t.start()
    }

    public func stop() {
        lock.lock()
        running = false
        let current = fd
        lock.unlock()
        if current >= 0 { shutdown(current, SHUT_RDWR) }
    }

    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return running
    }

    // Sends a request with a fresh ref, or the one given (a reply's ref is its id at the door). The completion runs on the
    // queue: with the door's answer, or with ok false and error "not_connected" if it couldn't go or the line dropped.
    @discardableResult
    public func send(_ request: Request, ref given: String? = nil, completion: ((Reply) -> Void)? = nil) -> String {
        let ref = given ?? Refs.fresh()
        lock.lock()
        let current = fd
        let ready = current >= 0 && helloRef == nil
        if ready, let completion { pending[ref] = completion }
        lock.unlock()
        guard ready, write(request.line(ref: ref), to: current) else {
            lock.lock()
            pending.removeValue(forKey: ref)
            lock.unlock()
            if let completion { queue.async { completion(Reply(ref: ref, ok: false, error: "not_connected")) } }
            return ref
        }
        return ref
    }

    private func emit(_ event: ClientEvent) {
        queue.async { [handler] in handler(event) }
    }

    private func loop() {
        var failures = 0
        while isRunning {
            let (socketFD, failure) = connectSocket()
            guard let socketFD else {
                if let failure { emit(.connectFailed(failure)) }
                failures += 1
                Thread.sleep(forTimeInterval: failures < 30 ? retryInterval : retryInterval * 5)
                continue
            }
            failures = 0
            let hello = Refs.fresh()
            lock.lock()
            fd = socketFD
            helloRef = hello
            lock.unlock()
            _ = write(Request.hello.line(ref: hello), to: socketFD)
            readLines(socketFD)
            lock.lock()
            fd = -1
            helloRef = nil
            let dropped = pending
            pending = [:]
            lock.unlock()
            close(socketFD)
            for (ref, completion) in dropped {
                queue.async { completion(Reply(ref: ref, ok: false, error: "not_connected")) }
            }
            if isRunning { emit(.disconnected) }
            if isRunning { Thread.sleep(forTimeInterval: retryInterval) }
        }
    }

    private func connectSocket() -> (Int32?, ConnectFailure?) {
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return (nil, .other(errno)) }
        var on: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else {
            close(s)
            return (nil, .other(ENAMETOOLONG))
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            buf.copyBytes(from: pathBytes)
            buf[pathBytes.count] = 0
        }
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if result != 0 {
            let code = errno
            close(s)
            return (nil, code == ENOENT || code == ECONNREFUSED ? .notRunning : .other(code))
        }
        return (s, nil)
    }

    private func readLines(_ socketFD: Int32) {
        var pending = Data()
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(socketFD, &buffer, buffer.count)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return }
            pending.append(contentsOf: buffer[0..<n])
            while let newline = pending.firstIndex(of: 0x0A) {
                let line = String(decoding: pending[pending.startIndex..<newline], as: UTF8.self)
                pending.removeSubrange(pending.startIndex...newline)
                if !handle(line) { return }
            }
            // A line this long is a fault, as the door treats one from the app.
            if pending.count > 8 * 1024 * 1024 { return }
        }
    }

    // false: stop reading this connection.
    private func handle(_ line: String) -> Bool {
        if line.trimmingCharacters(in: .whitespaces).isEmpty { return true }
        let frame: Frame
        do {
            frame = try FrameParser.parse(line)
        } catch {
            emit(.badLine(String(describing: error)))
            return true
        }
        if case let .result(reply) = frame, let ref = reply.ref {
            lock.lock()
            let isHello = ref == helloRef
            if isHello && reply.ok { helloRef = nil }
            let completion = isHello ? nil : pending.removeValue(forKey: ref)
            lock.unlock()
            if isHello {
                if reply.ok {
                    emit(.ready)
                    return true
                }
                lock.lock()
                running = false
                lock.unlock()
                emit(.refused(reply.message ?? reply.error ?? "refused"))
                return false
            }
            if let completion {
                queue.async { completion(reply) }
                return true
            }
        }
        emit(.frame(frame))
        return true
    }

    private func write(_ data: Data, to socketFD: Int32) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return data.withUnsafeBytes { raw -> Bool in
            guard var base = raw.baseAddress else { return false }
            var left = raw.count
            while left > 0 {
                let n = Darwin.write(socketFD, base, left)
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { return false }
                left -= n
                base = base.advanced(by: n)
            }
            return true
        }
    }
}
