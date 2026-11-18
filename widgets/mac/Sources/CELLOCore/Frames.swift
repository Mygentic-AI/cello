// The operator's door protocol (src/daemon/operator-door.ts and notifier-mac.ts in the cello repo): one JSON object a
// line, each way. This file only turns lines into values and values into lines.
import Foundation

public let operatorProtocol = 1

public enum ItemKind: String, Equatable, Sendable {
    case request, message, test
}

// Who the agent was talking to. A name the owner gave is checked by the owner; any other is the one they chose.
public struct TalkingTo: Equatable, Sendable {
    public let agentID: String
    public let name: String
    public let namedBy: String
    public let unverified: Bool

    public init(agentID: String, name: String, namedBy: String, unverified: Bool) {
        self.agentID = agentID
        self.name = name
        self.namedBy = namedBy
        self.unverified = unverified
    }
}

// One notification from an agent, as the door sends it.
public struct Item: Equatable, Identifiable, Sendable {
    public let id: Int
    public let agentID: String
    public let agent: String
    public let kind: ItemKind
    public let text: String
    public let choices: [String]
    public let sessionID: String?
    public let talkingTo: TalkingTo?
    public let sentAt: Date
    // Already on screen once, by an earlier connection: never bannered again.
    public let shown: Bool
    // Arrived while paused: the panel only, no banner and no sound.
    public let silent: Bool

    public init(id: Int, agentID: String, agent: String, kind: ItemKind, text: String, choices: [String] = [], sessionID: String? = nil, talkingTo: TalkingTo? = nil, sentAt: Date, shown: Bool = false, silent: Bool = false) {
        self.id = id
        self.agentID = agentID
        self.agent = agent
        self.kind = kind
        self.text = text
        self.choices = choices
        self.sessionID = sessionID
        self.talkingTo = talkingTo
        self.sentAt = sentAt
        self.shown = shown
        self.silent = silent
    }
}

// A question was answered, here or elsewhere. here: on this copy. where: the service it was answered on, such as Telegram.
public struct Settled: Equatable, Sendable {
    public let id: Int
    public let label: String
    public let place: String
    public let here: Bool
    public let typed: Bool

    public init(id: Int, label: String, place: String, here: Bool, typed: Bool) {
        self.id = id
        self.label = label
        self.place = place
        self.here = here
        self.typed = typed
    }
}

public struct Agent: Equatable, Sendable {
    public let agentID: String
    public let name: String

    public init(agentID: String, name: String) {
        self.agentID = agentID
        self.name = name
    }
}

// The answer to a request. fields holds whatever else the door said, such as passed_to or paused_until.
public struct Reply: @unchecked Sendable {
    public let ref: String?
    public let ok: Bool
    public let error: String?
    public let message: String?
    public let fields: [String: Any]

    public init(ref: String?, ok: Bool, error: String? = nil, message: String? = nil, fields: [String: Any] = [:]) {
        self.ref = ref
        self.ok = ok
        self.error = error
        self.message = message
        self.fields = fields
    }

    public func string(_ key: String) -> String? { fields[key] as? String }
}

public enum Frame: @unchecked Sendable {
    case result(Reply)
    case notification(Item)
    case settled(Settled)
    case agentAdded(Agent)
    case agentRemoved(agentID: String)
    // A frame this app doesn't know. Ignored, so a newer door can add one without breaking an older app.
    case unknown(op: String)
}

public enum FrameError: Error, Equatable, CustomStringConvertible {
    case notJSONObject
    case missing(op: String, field: String)

    public var description: String {
        switch self {
        case .notJSONObject: return "a line from CELLO wasn't one JSON object"
        case let .missing(op, field): return "a \(op) from CELLO had no \(field)"
        }
    }
}

private let isoFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private let isoPlain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

public func parseISODate(_ text: String) -> Date? {
    isoFractional.date(from: text) ?? isoPlain.date(from: text)
}

public func isoString(_ date: Date) -> String {
    isoFractional.string(from: date)
}

public enum FrameParser {
    public static func parse(_ line: String) throws -> Frame {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dict = object as? [String: Any] else { throw FrameError.notJSONObject }
        return try parse(dict)
    }

    public static func parse(_ dict: [String: Any]) throws -> Frame {
        let op = dict["op"] as? String ?? ""
        switch op {
        case "result":
            var fields = dict
            for key in ["op", "ref", "ok", "error", "message"] { fields.removeValue(forKey: key) }
            return .result(Reply(ref: dict["ref"] as? String, ok: dict["ok"] as? Bool ?? false, error: dict["error"] as? String, message: dict["message"] as? String, fields: fields))
        case "notification":
            return .notification(try item(dict))
        case "settled":
            let id = try int(dict, "id", op)
            return .settled(Settled(id: id, label: dict["label"] as? String ?? "", place: dict["where"] as? String ?? "", here: dict["here"] as? Bool ?? false, typed: dict["typed"] as? Bool ?? false))
        case "agent_added":
            let agentID = try string(dict, "agent_id", op)
            return .agentAdded(Agent(agentID: agentID, name: dict["agent"] as? String ?? agentID))
        case "agent_removed":
            return .agentRemoved(agentID: try string(dict, "agent_id", op))
        default:
            return .unknown(op: op)
        }
    }

    public static func agents(_ value: Any?) -> [Agent] {
        guard let list = value as? [[String: Any]] else { return [] }
        return list.compactMap { entry in
            guard let id = entry["agent_id"] as? String else { return nil }
            return Agent(agentID: id, name: entry["agent"] as? String ?? id)
        }
    }

    static func item(_ dict: [String: Any]) throws -> Item {
        let op = "notification"
        let id = try int(dict, "id", op)
        let agentID = try string(dict, "agent_id", op)
        let text = try string(dict, "text", op)
        guard let sent = (dict["sent_at"] as? String).flatMap(parseISODate) else { throw FrameError.missing(op: op, field: "sent_at") }
        var talking: TalkingTo?
        if let t = dict["talking_to"] as? [String: Any], let tid = t["agent_id"] as? String {
            talking = TalkingTo(agentID: tid, name: t["name"] as? String ?? tid, namedBy: t["named_by"] as? String ?? "nobody", unverified: t["unverified"] as? Bool ?? true)
        }
        return Item(
            id: id,
            agentID: agentID,
            agent: dict["agent"] as? String ?? agentID,
            // A kind this app doesn't know is shown as news: it never pretends to be a question.
            kind: ItemKind(rawValue: dict["kind"] as? String ?? "") ?? .message,
            text: text,
            choices: dict["choices"] as? [String] ?? [],
            sessionID: dict["session_id"] as? String,
            talkingTo: talking,
            sentAt: sent,
            shown: dict["shown"] as? Bool ?? false,
            silent: dict["silent"] as? Bool ?? false
        )
    }

    private static func int(_ dict: [String: Any], _ key: String, _ op: String) throws -> Int {
        if let n = dict[key] as? Int { return n }
        if let n = dict[key] as? NSNumber { return n.intValue }
        throw FrameError.missing(op: op, field: key)
    }

    private static func string(_ dict: [String: Any], _ key: String, _ op: String) throws -> String {
        guard let s = dict[key] as? String else { throw FrameError.missing(op: op, field: key) }
        return s
    }
}

// What the app asks of the door. Nothing else can be sent: the door refuses any other op.
public enum Request: Equatable, Sendable {
    case hello
    case subscribe
    case ack(id: Int)
    case pick(id: Int, choice: Int)
    // An answer to one notification, or a message to an agent the person picked.
    case reply(target: ReplyTarget, text: String)
    case pause(until: Date)
    case resume
    case remove

    public var op: String {
        switch self {
        case .hello: return "hello"
        case .subscribe: return "subscribe"
        case .ack: return "ack"
        case .pick: return "pick"
        case .reply: return "reply"
        case .pause: return "pause"
        case .resume: return "resume"
        case .remove: return "remove"
        }
    }

    public func object(ref: String) -> [String: Any] {
        var o: [String: Any] = ["op": op, "ref": ref]
        switch self {
        case .hello: o["protocol"] = operatorProtocol
        case .subscribe, .resume, .remove: break
        case let .ack(id): o["id"] = id
        case let .pick(id, choice):
            o["id"] = id
            o["choice"] = choice
        case let .reply(target, text):
            o["text"] = text
            switch target {
            case let .item(id): o["id"] = id
            case let .agent(agentID): o["agent"] = agentID
            }
        case let .pause(until): o["until"] = isoString(until)
        }
        return o
    }

    public func line(ref: String) -> Data {
        // Built from strings and numbers only, so this can't fail.
        var data = (try? JSONSerialization.data(withJSONObject: object(ref: ref), options: [.sortedKeys])) ?? Data()
        data.append(0x0A)
        return data
    }
}

public enum ReplyTarget: Equatable, Sendable {
    case item(Int)
    case agent(String)
}

// The door takes a reply's ref as its own id for it, so one sent again after a dropped connection reaches the agent once.
public enum Refs {
    public static func isValid(_ ref: String) -> Bool {
        guard (8...64).contains(ref.count) else { return false }
        return ref.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_" }
    }

    public static func fresh() -> String {
        "mac-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(20)
    }
}
