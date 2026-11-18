// What the app knows and what it should do about each frame, with no screen involved. The app turns each Effect into a
// banner or an ack. Nothing here is kept on disk: the daemon keeps every notification until it's answered or cleared,
// and sends what's waiting each time the app connects.
import Foundation

public enum Unreachable: Equatable, Sendable {
    // CELLO wasn't running and starting it failed: what cello login said, kept for the log and never shown.
    case stopped(String)
    // cello login worked, and still the door for this app never appeared.
    case noDoor
    // Connecting fails for a reason other than CELLO not running, by its errno.
    case cannotConnect(Int32)
    // Connected, but the door refused to subscribe: its own words, for the log.
    case subscribeRefused(String)
    // The app was never told how to start CELLO.
    case unknownInstall
    // The door speaks another version: its own words, for the log.
    case mismatch(String)
}

public enum Connection: Equatable, Sendable {
    case connecting
    case connected
    case starting
    case unreachable(Unreachable)
}

public enum Look: String, Equatable, Sendable {
    case plain, news, waiting, paused, unreachable
}

public enum Effect: Equatable, Sendable {
    case banner(BannerPlan)
    case summary(SummaryPlan)
    // Take a banner off screen: its question was answered.
    case withdraw(itemID: Int)
    case joined(Agent)
    // Tell the door this one is in front of the person.
    case ack(itemID: Int)
}

public struct EarlierLine: Equatable, Sendable {
    public let agent: String
    public let what: String
    public let at: Date
    // Answered here: for a few seconds the panel shows this in the card's place, then the line folds into Earlier today.
    public var card: String? = nil
}

// How long an answered card stays in the panel before it folds into Earlier today.
public let answeredCardSeconds: TimeInterval = 4
// How long "paused" shows beside the mark after the person pauses here. After that the faded mark says it alone.
public let pausedWordSeconds: TimeInterval = 4

// Everything the menu-bar mark shows: the look, the word beside it, and what hovering over it says.
public struct MarkLook: Equatable, Sendable {
    public let look: Look
    public let word: String?
    public let tooltip: String?

    public init(look: Look, word: String?, tooltip: String?) {
        self.look = look
        self.word = word
        self.tooltip = tooltip
    }
}

public struct AppState {
    public var connection: Connection = .connecting
    public private(set) var turnedOn: Bool
    public private(set) var agents: [Agent] = []
    public private(set) var waiting: [Item] = []
    public private(set) var earlier: [EarlierLine] = []
    public private(set) var pausedUntil: Date?
    // When the person paused from this app. Not set by a pause the door reports on connecting, so a reconnect never
    // flashes the word again.
    public private(set) var pausedHereAt: Date?
    // News not yet looked at in the panel: the pink dot.
    public private(set) var unseenNews: Set<Int> = []
    // Told to the door as on screen, or on screen before this connection.
    public private(set) var acked: Set<Int> = []
    // Between subscribing and the end of what waited: those arrive together and get one banner.
    public private(set) var catchingUp = false
    private var held: [Int] = []
    // What was waiting before a reconnect. Whatever the door doesn't send again was answered or cleared meanwhile.
    private var stale: Set<Int> = []

    public init(turnedOn: Bool) {
        self.turnedOn = turnedOn
    }

    public func isPaused(at now: Date) -> Bool {
        guard let until = pausedUntil else { return false }
        return until > now
    }

    public func look(at now: Date) -> Look {
        if case .unreachable = connection { return .unreachable }
        if isPaused(at: now) { return .paused }
        if waiting.contains(where: { $0.kind == .request }) { return .waiting }
        if !unseenNews.isEmpty { return .news }
        return .plain
    }

    // time: how a time of day reads to the person, such as "9:00 AM".
    public func mark(at now: Date, time: (Date) -> String) -> MarkLook {
        let look = look(at: now)
        guard look == .paused, let until = pausedUntil else { return MarkLook(look: look, word: nil, tooltip: nil) }
        let fresh = pausedHereAt.map { now.timeIntervalSince($0) < pausedWordSeconds } ?? false
        return MarkLook(look: look, word: fresh ? Copy.pausedWord : nil, tooltip: Copy.pausedUntil(time(until)))
    }

    // When the word beside the mark goes, so the mark can redraw then.
    public func pausedWordEnds(now: Date) -> Date? {
        guard isPaused(at: now), let at = pausedHereAt else { return nil }
        let end = at.addingTimeInterval(pausedWordSeconds)
        return end > now ? end : nil
    }

    public func item(_ id: Int) -> Item? { waiting.first { $0.id == id } }

    public func earlierToday(now: Date, calendar: Calendar = .current) -> [EarlierLine] {
        earlier.filter { calendar.isDate($0.at, inSameDayAs: now) && !Self.showingCard($0, now: now) }.reversed()
    }

    // Just answered here, newest first: each shows as a card for a few seconds, before it's a line in Earlier today.
    public func justAnswered(now: Date) -> [EarlierLine] {
        earlier.filter { Self.showingCard($0, now: now) }.reversed()
    }

    // When the next answered card folds away, so the panel can redraw then.
    public func nextCardFold(now: Date) -> Date? {
        earlier.filter { Self.showingCard($0, now: now) }.map { $0.at.addingTimeInterval(answeredCardSeconds) }.min()
    }

    private static func showingCard(_ line: EarlierLine, now: Date) -> Bool {
        line.card != nil && now.timeIntervalSince(line.at) < answeredCardSeconds
    }

    // The door accepted subscribe: it said which agents reach the person here and whether a pause is on. What waited follows.
    public mutating func subscribed(_ reply: Reply) {
        connection = .connected
        agents = FrameParser.agents(reply.fields["agents"])
        pausedUntil = (reply.fields["paused_until"] as? String).flatMap(parseISODate)
        if pausedUntil == nil { pausedHereAt = nil }
        catchingUp = true
        held = []
        stale = Set(waiting.map(\.id))
    }

    // here: the person paused from this app just now, so the word shows for a moment.
    public mutating func setPaused(until: Date?, here: Date? = nil) {
        pausedUntil = until
        pausedHereAt = until == nil ? nil : here
    }

    public mutating func disconnected() {
        if case .unreachable = connection { return }
        connection = .connecting
        catchingUp = false
        held = []
    }

    public mutating func receive(_ item: Item) -> [Effect] {
        stale.remove(item.id)
        // An ack is a line with no answer. If the door says it's still unseen, that line never landed, so it goes again.
        let lostAck = !item.shown && acked.contains(item.id)
        if item.shown { acked.insert(item.id) }
        if let at = waiting.firstIndex(where: { $0.id == item.id }) {
            // Sent again on reconnect. Already in the panel, and already bannered if it was going to be.
            waiting[at] = item
            return lostAck ? [.ack(itemID: item.id)] : []
        }
        waiting.append(item)
        waiting.sort { $0.id < $1.id }
        if item.kind != .request && !item.shown { unseenNews.insert(item.id) }
        if catchingUp || !turnedOn {
            held.append(item.id)
            return []
        }
        if item.silent || item.shown { return [] }
        return [.banner(BannerPlan.forItem(item))]
    }

    // Everything that waited has arrived: one banner for all of it, or the usual banner for just one.
    public mutating func endCatchUp(now: Date) -> [Effect] {
        guard catchingUp else { return [] }
        catchingUp = false
        // Answered elsewhere while the app was away: its banner goes too, or its buttons would still look live.
        let gone = stale.sorted()
        for id in gone { waiting.removeAll { $0.id == id }; unseenNews.remove(id) }
        stale = []
        return gone.map { .withdraw(itemID: $0) } + releaseHeld(now: now)
    }

    // The person clicked Turn on. What arrived before that is shown now, as one banner.
    public mutating func turnOn(now: Date) -> [Effect] {
        turnedOn = true
        if catchingUp { return [] }
        return releaseHeld(now: now)
    }

    private mutating func releaseHeld(now: Date) -> [Effect] {
        guard turnedOn else { return [] }
        let fresh = held.compactMap { id in waiting.first { $0.id == id } }.filter { !$0.shown && !$0.silent }
        held = []
        if fresh.isEmpty { return [] }
        if fresh.count == 1 { return [.banner(BannerPlan.forItem(fresh[0]))] }
        let questions = fresh.filter { $0.kind == .request }.count
        let summary = SummaryPlan(
            itemIDs: fresh.map(\.id),
            title: Copy.waitedTitle(questions: questions, messages: fresh.count - questions),
            body: Copy.waitedBody(fresh.map { (agent: $0.agent, age: now.timeIntervalSince($0.sentAt)) }),
            sound: questions > 0
        )
        return [.summary(summary)]
    }

    public mutating func settled(_ s: Settled, now: Date) -> [Effect] {
        guard let item = item(s.id) else { return [] }
        // Chosen here: the door settles it before the pick's own answer comes back, so the card starts here.
        finish(item, what: Copy.settledLine(s), card: s.here ? Copy.answeredCard(s, agent: item.agent) : nil, now: now)
        return [.withdraw(itemID: s.id)]
    }

    // The door took a pick or a reply for this one. A settled frame may have done this already.
    public mutating func answered(_ id: Int, what: String, card: String? = nil, now: Date) -> [Effect] {
        guard let item = item(id) else { return [] }
        finish(item, what: what, card: card, now: now)
        return [.withdraw(itemID: id)]
    }

    private mutating func finish(_ item: Item, what: String, card: String?, now: Date) {
        waiting.removeAll { $0.id == item.id }
        unseenNews.remove(item.id)
        earlier.append(EarlierLine(agent: item.agent, what: what, at: now, card: card))
        // Memory only, and only today's are shown. A long-running app keeps a day's worth at most.
        earlier.removeAll { now.timeIntervalSince($0.at) > 24 * 60 * 60 }
    }

    public mutating func agentAdded(_ agent: Agent) -> [Effect] {
        if agents.contains(where: { $0.agentID == agent.agentID }) { return [] }
        agents.append(agent)
        return turnedOn ? [.joined(agent)] : []
    }

    public mutating func agentRemoved(_ agentID: String) -> [Effect] {
        agents.removeAll { $0.agentID == agentID }
        let gone = waiting.filter { $0.agentID == agentID }.map(\.id)
        waiting.removeAll { $0.agentID == agentID }
        for id in gone { unseenNews.remove(id) }
        return gone.map { .withdraw(itemID: $0) }
    }

    // Everything the app knew goes: the person removed CELLO from this Mac.
    public mutating func removedEverywhere() {
        agents = []
        waiting = []
        unseenNews = []
        pausedUntil = nil
        pausedHereAt = nil
    }

    // The panel is open, so everything in it is in front of the person: news is read, and the door hears each is shown.
    public mutating func panelOpened() -> [Effect] {
        unseenNews.removeAll()
        guard connection == .connected else { return [] }
        let unacked = waiting.filter { !acked.contains($0.id) }.map(\.id)
        for id in unacked { acked.insert(id) }
        return unacked.map { .ack(itemID: $0) }
    }

    public mutating func markAcked(_ id: Int) {
        acked.insert(id)
    }
}
