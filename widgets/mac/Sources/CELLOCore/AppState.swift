// What the app knows and what it should do about each frame, with no screen involved. The app turns each Effect into a
// banner or an ack. Nothing here is kept on disk: the daemon keeps every notification until it's answered or cleared,
// and sends what's waiting each time the app connects.
import Foundation

public enum Unreachable: Equatable, Sendable {
    // CELLO wasn't running and starting it failed.
    case stopped
    // The app was never told how to start CELLO.
    case unknownInstall
    // The door speaks another version: its own words say which side to update.
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
}

public struct AppState {
    public var connection: Connection = .connecting
    public private(set) var turnedOn: Bool
    public private(set) var agents: [Agent] = []
    public private(set) var waiting: [Item] = []
    public private(set) var earlier: [EarlierLine] = []
    public private(set) var pausedUntil: Date?
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

    public func item(_ id: Int) -> Item? { waiting.first { $0.id == id } }

    public func earlierToday(now: Date, calendar: Calendar = .current) -> [EarlierLine] {
        earlier.filter { calendar.isDate($0.at, inSameDayAs: now) }.reversed()
    }

    // The door accepted subscribe: it said which agents reach the person here and whether a pause is on. What waited follows.
    public mutating func subscribed(_ reply: Reply) {
        connection = .connected
        agents = FrameParser.agents(reply.fields["agents"])
        pausedUntil = (reply.fields["paused_until"] as? String).flatMap(parseISODate)
        catchingUp = true
        held = []
        stale = Set(waiting.map(\.id))
    }

    public mutating func setPaused(until: Date?) {
        pausedUntil = until
    }

    public mutating func disconnected() {
        if case .unreachable = connection { return }
        connection = .connecting
        catchingUp = false
        held = []
    }

    public mutating func receive(_ item: Item) -> [Effect] {
        stale.remove(item.id)
        if item.shown { acked.insert(item.id) }
        if let at = waiting.firstIndex(where: { $0.id == item.id }) {
            // Sent again on reconnect. Already in the panel, and already bannered if it was going to be.
            waiting[at] = item
            return []
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
        for id in stale { waiting.removeAll { $0.id == id }; unseenNews.remove(id) }
        stale = []
        return releaseHeld(now: now)
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
        finish(item, what: Copy.settledLine(s), now: now)
        return [.withdraw(itemID: s.id)]
    }

    // The door took a pick or a reply for this one. A settled frame may have done this already.
    public mutating func answered(_ id: Int, what: String, now: Date) -> [Effect] {
        guard let item = item(id) else { return [] }
        finish(item, what: what, now: now)
        return [.withdraw(itemID: id)]
    }

    private mutating func finish(_ item: Item, what: String, now: Date) {
        waiting.removeAll { $0.id == item.id }
        unseenNews.remove(item.id)
        earlier.append(EarlierLine(agent: item.agent, what: what, at: now))
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
