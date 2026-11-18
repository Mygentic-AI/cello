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
    // A Focus holds CELLO back unless the person adds it to that Focus's allowed apps. No app can add itself.
    public static let focusTitle = "Let questions through Focus?"
    public static let focusBody = "When a Focus is on, macOS holds CELLO back. To let questions through, choose the Focus in Focus settings and add CELLO to its allowed apps. News always waits."
    public static let focusOpen = "Open Focus settings"
    // System Settings › Focus, the list of Focuses. There's no link to one Focus's allowed apps.
    public static let focusSettingsURL = "x-apple.systempreferences:com.apple.Focus-Settings.extension"
    // Notifications turned off for CELLO: macOS never asks again, so System Settings is the only way back.
    public static let notificationsOff = "Notifications are off for CELLO, so questions only show here."
    public static let openNotificationSettings = "Open Notifications settings"
    public static let notificationSettingsURL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.celloprotocol.cello"
    public static let loginItemNeedsOK = "Open CELLO when I log in is waiting for your OK in System Settings."
    public static let openLoginItems = "Open Login Items"
    public static func joinedTitle(_ agent: String) -> String { "\(agent) can reach you here now" }
    // The design's line, with the agent's name for "her", since the app can't know an agent's pronoun.
    public static func joinedBody(_ agent: String) -> String { "Not you? Open CELLO › Settings to remove \(agent)." }

    // The panel
    public static func waitingHeader(_ count: Int) -> String { "WAITING FOR YOU · \(count)" }
    public static let nothingWaiting = "Nothing needs you right now."
    public static let earlierToday = "EARLIER TODAY"
    public static let messageAnAgent = "Message an agent…"
    public static let closeComposer = "Close"
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
    // The card a question becomes for a few seconds once it's answered here.
    public static func answeredCard(_ s: Settled, agent: String) -> String {
        s.typed ? "\(youAnswered). \(agent) has it." : youChose(s.label, agent: agent)
    }
    public static func repliedCard(request: Bool, agent: String) -> String { "\(request ? youAnswered : youReplied). \(agent) has it." }
    public static let youAnswered = "You answered in your own words"
    public static let youReplied = "You replied"
    public static func earlierLine(agent: String, what: String, time: String) -> String { "\(agent) · \(what) · \(time)" }
    public static func passedTo(_ agent: String) -> String { "Passed to \(agent)." }
    // Typed after the question was answered on another device: it went on as a follow-up.
    public static func followUp(first: String, agent: String) -> String { "Already answered: \(first). Passed to \(agent) as a follow-up." }
    // A message to an agent no session holds: it waits for the agent's next look.
    public static func notInSession(_ agent: String) -> String { "\(agent) isn't in a session right now, so it will see this when it next checks." }

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
    // Settings › Add or remove agents: the list of every agent on this Mac.
    public static let addOrRemoveAgents = "Add or remove agents…"
    public static let reachYouHere = "CAN REACH YOU HERE"
    public static let notYet = "ON THIS MAC, NOT YET HERE"
    public static let everyAgentIsHere = "Every agent on this Mac can reach you here."
    public static let add = "Add"
    public static let done = "Done"
    public static func addLocked(_ agent: String) -> String { "\(agent) is locked against changes from here, so it can only be added from Terminal on this Mac." }
    public static func addedUntold(_ agent: String) -> String { "\(agent) can reach you here now. Your other ways of hearing from \(agent) couldn't be told about it just now." }
    public static func addFailed(_ agent: String) -> String { "\(agent) couldn't be added right now, so nothing changed. Try again in a moment." }
    public static let quit = "Quit CELLO"
    public static let quitTitle = "Quit CELLO?"
    public static let quitBody = "Your agents can't reach you on this Mac until you open CELLO again. Their questions wait for you."
    public static let removeMenu = "Remove CELLO from this Mac…"
    public static let removeTitle = "Remove CELLO from this Mac?"
    public static func removeBody(_ agents: [String]) -> String {
        if agents.isEmpty { return "Your agents won't be able to reach you here. Your phone keeps working as it does now." }
        return "\(andList(agents)) won't be able to reach you here. Your phone keeps working as it does now."
    }
    // One agent off this Mac, from the list in Settings.
    public static let removeRow = "Remove…"
    public static func removeAgentTitle(_ agent: String) -> String { "Remove \(agent) from this Mac?" }
    public static func removeAgentBody(_ agent: String) -> String { "\(agent) won't be able to reach you here. Your other agents, and your phone, keep working as they do now." }
    public static func removeAgentFailed(_ agent: String) -> String { "\(agent) couldn't be removed right now, so nothing changed. Try again in a moment." }
    public static let remove = "Remove"
    public static let cancel = "Cancel"
    // An agent locked against changes from here keeps the Mac until a person removes it in Terminal.
    public static func removeAgentLocked(_ agent: String) -> String { "\(agent) is locked against changes from here, so it can only be removed from Terminal on this Mac." }
    public static let removeLocked = "Some of your agents are locked against changes from here, so nothing was removed. Remove them from Terminal on this Mac first."
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
    // What cello login or CELLO itself said goes to the app's log only: it's worded for the command line, not for here.
    public static let unreachableRefused = "CELLO turned this app away when it asked for what's waiting."
    public static let unreachableMismatch = "This app and CELLO are different versions, so they can't talk to each other."

    // The reason and the fix the panel shows. Never anything CELLO or cello login said.
    public static func unreachable(_ why: Unreachable) -> (reason: String, fix: String) {
        switch why {
        case .stopped: return (unreachableStopped, unreachableFix)
        case .subscribeRefused: return (unreachableRefused, restartFix)
        case .cannotConnect: return (cannotConnect, restartFix)
        case .noDoor: return (unreachableNoDoor, restartFix)
        case .unknownInstall: return (unreachableUnknownInstall, unreachableFix)
        case .mismatch: return (unreachableMismatch, mismatchFix)
        }
    }
    public static let startTimedOut = "it didn't finish within a minute."
    public static let unreachableNoDoor = "CELLO is running, but this app can't reach it."
    public static let restartFix = "Open Terminal and run: cello logout, then cello login"
    // The system's reason goes to the app's log; this is what the person reads.
    public static let cannotConnect = "This app can't connect to CELLO, and starting CELLO again won't fix that by itself."
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
