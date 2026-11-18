// Every line the person sees, in one place, worded as in the approved design. A test reads this file and fails on the
// words the design rules out.
import Foundation

public enum Copy {
    public static let appName = "CELLO"

    // Banners
    public static func requestTitle(_ agent: String) -> String { "\(agent) needs your decision" }
    public static func messageTitle(_ agent: String) -> String { "\(agent) has news for you" }
    public static func testTitle(_ agent: String) -> String { "A test from \(agent)" }
    public static let choose = "Choose…"
    public static let reply = "Reply…"
    public static let send = "Send"
    public static func typeTo(_ agent: String) -> String { "Type to \(agent)…" }
    public static let openCello = "Open CELLO"

    // Back at the Mac: one banner for everything that waited.
    public static func waitedTitle(questions: Int, messages: Int) -> String {
        if questions > 0 { return questions == 1 ? "1 question waited while you were away" : "\(questions) questions waited while you were away" }
        return messages == 1 ? "1 message waited while you were away" : "\(messages) messages waited while you were away"
    }

    public static func waitedBody(_ items: [(agent: String, age: TimeInterval)]) -> String {
        items.map { "\($0.agent), \(agoLong($0.age))." }.joined(separator: " ")
    }

    public static func agoLong(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "just now" }
        let m = s / 60
        if m < 60 { return m == 1 ? "1 minute ago" : "\(m) minutes ago" }
        let h = m / 60
        if h < 24 { return h == 1 ? "1 hour ago" : "\(h) hours ago" }
        let d = h / 24
        return d == 1 ? "1 day ago" : "\(d) days ago"
    }

    // A card's age, as in the panel: "4 min", "2 h".
    public static func ageShort(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "now" }
        let m = s / 60
        if m < 60 { return "\(m) min" }
        let h = m / 60
        if h < 24 { return "\(h) h" }
        return "\(h / 24) d"
    }

    // The first time
    public static let firstRunTitle = "Let your agents reach you here"
    public static func firstRunBody(_ agents: [String]) -> String {
        if agents.isEmpty {
            return "When one of your agents needs a decision and you're not in its session, it will ask you on this Mac. You answer in one click."
        }
        let names = orList(agents)
        return "When \(names) needs a decision and you're not in their session, they'll ask you on this Mac. You answer in one click."
    }
    public static let firstRunNext = "Next, macOS asks if CELLO may show notifications. Choose Allow."
    public static let openAtLogin = "Open CELLO when I log in"
    public static let turnOn = "Turn on"
    public static let allSetTitle = "You're all set"
    public static func allSetBody(_ agents: [String]) -> String {
        if agents.isEmpty { return "Your agents can reach you here. This is how a question from them will look." }
        return "\(andList(agents)) can reach you here. This is how a question from them will look."
    }
    public static func joinedTitle(_ agent: String) -> String { "\(agent) can reach you here now" }
    // The design's line is "Not you? Open CELLO › Settings to remove her." Settings can't remove one agent yet (the door
    // only removes the Mac from all of them), so this says only what Settings does. Andre's call which way to close it.
    public static let joinedBody = "Not you? Open CELLO › Settings to see every agent that can reach you here."

    // The panel
    public static func waitingHeader(_ count: Int) -> String { "WAITING FOR YOU · \(count)" }
    public static let nothingWaiting = "Nothing needs you right now."
    public static let earlierToday = "EARLIER TODAY"
    public static let messageAnAgent = "MESSAGE AN AGENT"
    public static let to = "To"
    public static let typeAMessage = "Type a message…"
    public static let orAnswer = "Or answer in your own words"
    public static let replyLabel = "Reply"
    public static let settings = "Settings"
    public static let noAgentsYet = "No agent can reach you here yet."

    public static func talkingTo(_ t: TalkingTo) -> String {
        if t.namedBy == "you" && !t.unverified { return "Talking to \(t.name), from your contacts" }
        if t.namedBy == "nobody" { return "Talking to an agent that gave no name" }
        return "Talking to “\(t.name)”, a name it gave itself, not checked"
    }

    // Settled questions, folded into Earlier today, and the line on a card just answered.
    public static func settledLine(_ s: Settled) -> String {
        switch (s.here, s.typed) {
        case (true, false): return "You chose “\(s.label)”"
        case (true, true): return "You answered in your own words"
        case (false, true): return "Answered on \(s.place) in your own words"
        case (false, false): return "Answered on \(s.place): “\(s.label)”"
        }
    }
    public static func youChose(_ label: String, agent: String) -> String { "You chose “\(label)”. \(agent) has it." }
    public static let youAnswered = "You answered in your own words"
    public static let youReplied = "You replied"
    public static func earlierLine(agent: String, what: String, time: String) -> String { "\(agent) · \(what) · \(time)" }
    public static func passedTo(_ agent: String) -> String { "Passed to \(agent)." }

    // Failures of an answer, worded here rather than passed through.
    public static func didNotReach(_ agent: String) -> String { "That didn't reach \(agent). Try again from the CELLO panel." }
    public static let alreadyAnswered = "This was already answered."
    public static let noLongerWaiting = "This was already answered or cleared."
    public static func agentGone(_ agent: String) -> String { "\(agent) is no longer on this Mac." }
    public static func agentNotHere(_ agent: String) -> String { "\(agent) can't reach you here any more." }
    public static let notConnected = "CELLO isn't connected right now, so nothing was sent. It will be back in a moment."

    // Settings
    public static let pauseHour = "Pause for an hour"
    public static let pauseMorning = "Pause until tomorrow morning"
    public static func pausedUntil(_ time: String) -> String { "Paused until \(time)" }
    public static let resumeNow = "Resume now"
    public static func agentsHere(_ names: [String]) -> String {
        if names.isEmpty { return "Agents that can reach you here: none yet" }
        let shown = names.prefix(3).joined(separator: ", ")
        return "Agents that can reach you here: \(shown)\(names.count > 3 ? "…" : "")"
    }
    public static let quit = "Quit CELLO"
    public static let quitTitle = "Quit CELLO?"
    public static let quitBody = "Your agents can't reach you on this Mac until you open CELLO again. Their questions wait for you."
    public static let removeMenu = "Remove CELLO from this Mac…"
    public static let removeTitle = "Remove CELLO from this Mac?"
    public static func removeBody(_ agents: [String]) -> String {
        if agents.isEmpty { return "Your agents won't be able to reach you here. Your phone keeps working as it does now." }
        return "\(andList(agents)) won't be able to reach you here. Your phone keeps working as it does now."
    }
    public static let remove = "Remove"
    public static let cancel = "Cancel"
    public static let removeFailed = "CELLO couldn't be removed right now, so nothing changed. Try again in a moment."

    // The menu-bar looks, for VoiceOver.
    public static let lookPlain = "CELLO, nothing waiting"
    public static let lookNews = "CELLO, news to read"
    public static let lookWaiting = "CELLO, a decision is waiting"
    public static let lookPaused = "CELLO, paused"
    public static let lookUnreachable = "CELLO, can't reach your agents"
    public static let pausedWord = "paused"

    // Can't reach your agents: the reason and the one fix.
    public static let unreachableTitle = "Can't reach your agents"
    public static let unreachableStopped = "CELLO stopped in the background and couldn't start again."
    public static let unreachableUnknownInstall = "This app doesn't know where CELLO is installed, so it couldn't start it."
    public static let unreachableFix = "Open Terminal and run: cello login"
    public static func loginSaid(_ said: String) -> String { "cello login said: \(said)" }
    public static let startTimedOut = "it didn't finish within a minute."
    public static let unreachableNoDoor = "CELLO is running, but this app can't reach it."
    public static let restartFix = "Open Terminal and run: cello logout, then cello login"
    public static func cannotConnect(_ code: Int32) -> String { "This app can't connect to CELLO: \(String(cString: strerror(code)))." }
    public static let tryAgain = "Try again"
    public static let mismatchFix = "Update CELLO so this app and CELLO match."

    public static func andList(_ names: [String]) -> String { join(names, last: "and") }
    public static func orList(_ names: [String]) -> String { join(names, last: "or") }

    private static func join(_ names: [String], last: String) -> String {
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        case 2: return "\(names[0]) \(last) \(names[1])"
        default: return names.dropLast().joined(separator: ", ") + " \(last) " + names[names.count - 1]
        }
    }
}
