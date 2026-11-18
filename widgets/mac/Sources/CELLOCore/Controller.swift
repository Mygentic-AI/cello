// Joins the connection to the state, and holds everything the app does that isn't drawing: what each frame means, what
// each click sends, when to start CELLO again. The app and the probe both drive one, so the live test runs this code.
import Foundation
import os

private let log = Logger(subsystem: "com.celloprotocol.cello", category: "door")

public protocol ControllerDelegate: AnyObject {
    func stateChanged(_ controller: Controller)
    // Show a banner or take one away. Call controller.shown(_:) once a banner is really on screen.
    func perform(_ effect: Effect, controller: Controller)
    // CELLO isn't running. Start it off the main thread, then call controller.startFinished(_:).
    func needsStart(_ controller: Controller)
}

public final class Controller {
    public private(set) var state: AppState
    public weak var delegate: ControllerDelegate?
    public let socketPath: String
    public var now: () -> Date = Date.init
    // How long after subscribe the waiting notifications are taken to have all arrived. The door writes them straight
    // after its answer, so this only has to cover reading them.
    public var catchUpWindow: TimeInterval = 0.4
    // Failed connects before CELLO is taken to be stopped, and how many more after starting it before giving up.
    public var failuresBeforeStart = 2
    public var failuresAfterStart = 20
    private var client: OperatorClient!
    private var failures = 0
    private var startTried = false
    private var failuresSinceStart: Int?
    // A reply keeps its ref until it's taken, so one sent again after a dropped line reaches the agent once.
    private var replyRefs: [String: String] = [:]
    private var pauseTimer: DispatchWorkItem?

    public init(socketPath: String, turnedOn: Bool) {
        self.socketPath = socketPath
        self.state = AppState(turnedOn: turnedOn)
        self.client = OperatorClient(socketPath: socketPath, queue: .main) { [weak self] event in self?.handle(event) }
    }

    public func start() { client.start() }
    public func stop() { client.stop() }

    private func changed() {
        schedulePauseEnd()
        delegate?.stateChanged(self)
    }

    private func run(_ effects: [Effect]) {
        for effect in effects {
            if case let .ack(id) = effect {
                client.send(.ack(id: id))
                state.markAcked(id)
            } else {
                delegate?.perform(effect, controller: self)
            }
        }
    }

    private func handle(_ event: ClientEvent) {
        switch event {
        case .ready:
            failures = 0
            startTried = false
            failuresSinceStart = nil
            state.connection = .connected
            client.send(.subscribe) { [weak self] reply in self?.subscribed(reply) }
            changed()
        case let .connectFailed(failure):
            failures += 1
            if let since = failuresSinceStart {
                failuresSinceStart = since + 1
                if since + 1 >= failuresAfterStart, state.connection == .starting {
                    // cello login said it was running, and still there's no door for this app.
                    state.connection = .unreachable(.noDoor)
                    changed()
                }
            } else if failure == .notRunning, failures >= failuresBeforeStart, !startTried {
                askToStart()
            } else if case let .other(code) = failure, failures >= failuresAfterStart, state.connection != .unreachable(.cannotConnect(code)) {
                // Not "nothing there" but a refusal starting CELLO can't fix, such as permissions. Said, not waited on.
                state.connection = .unreachable(.cannotConnect(code))
                changed()
            }
        case .disconnected:
            state.disconnected()
            changed()
        case let .refused(message):
            state.connection = .unreachable(.mismatch(message))
            changed()
        case let .frame(frame):
            apply(frame)
        case let .badLine(why):
            // Never the line itself: it can hold an agent's words. What was wrong with it is enough to find the cause.
            log.error("a line from CELLO couldn't be read: \(why, privacy: .public)")
        }
    }

    private func askToStart() {
        startTried = true
        if case .unreachable = state.connection {} else { state.connection = .starting }
        changed()
        delegate?.needsStart(self)
    }

    // Known before connecting, such as launch.json being unreadable.
    public func markUnreachable(_ why: Unreachable) {
        state.connection = .unreachable(why)
        changed()
    }

    // The person clicked Try again on the struck-through look.
    public func retryStart() {
        if case .unreachable(.subscribeRefused) = state.connection {
            state.connection = .connected
            changed()
            client.send(.subscribe) { [weak self] reply in self?.subscribed(reply) }
            return
        }
        if case .unreachable(.mismatch) = state.connection {
            state.connection = .connecting
            changed()
            client.start()
            return
        }
        askToStart()
    }

    public func startFinished(_ result: Result<Void, LaunchError>) {
        switch result {
        case .success:
            // It started: the connection loop finds it. If it never answers, that's said after a while.
            failuresSinceStart = 0
        case let .failure(error):
            failuresSinceStart = nil
            switch error {
            case .notInstalled, .unreadable: state.connection = .unreachable(.unknownInstall)
            case let .exited(_, said): state.connection = .unreachable(.stopped(said))
            case .timedOut: state.connection = .unreachable(.stopped(Copy.startTimedOut))
            }
            changed()
        }
    }

    private func subscribed(_ reply: Reply) {
        guard reply.ok else {
            // A dropped line reconnects and subscribes again. A refusal would leave the app looking connected with
            // nothing able to arrive, so it's said.
            if reply.error != "not_connected" {
                state.connection = .unreachable(.subscribeRefused(reply.message ?? reply.error ?? "refused"))
                changed()
            }
            return
        }
        state.subscribed(reply)
        changed()
        DispatchQueue.main.asyncAfter(deadline: .now() + catchUpWindow) { [weak self] in
            guard let self else { return }
            self.run(self.state.endCatchUp(now: self.now()))
            self.changed()
        }
    }

    private func apply(_ frame: Frame) {
        switch frame {
        case let .notification(item): run(state.receive(item))
        case let .settled(s): run(state.settled(s, now: now()))
        case let .agentAdded(agent): run(state.agentAdded(agent))
        case let .agentRemoved(agentID): run(state.agentRemoved(agentID))
        case .result, .unknown: return
        }
        changed()
    }

    // A banner is on screen: the door hears so, and the agent's notify answers that its operator has it.
    public func shown(_ itemIDs: [Int]) {
        for id in itemIDs where !state.acked.contains(id) && state.item(id) != nil {
            client.send(.ack(id: id))
            state.markAcked(id)
        }
    }

    public func panelOpened() {
        run(state.panelOpened())
        changed()
    }

    public func turnOn() {
        run(state.turnOn(now: now()))
        changed()
    }

    // Each action answers nil when the door took it, or the line to show the person.
    public func pick(_ itemID: Int, choice: Int, done: @escaping (String?) -> Void) {
        guard let item = state.item(itemID), choice >= 0, choice < item.choices.count else {
            done(Copy.noLongerWaiting)
            return
        }
        client.send(.pick(id: itemID, choice: choice)) { [weak self] reply in
            guard let self else { return }
            if reply.ok {
                self.run(self.state.answered(itemID, what: Copy.settledLine(Settled(id: itemID, label: item.choices[choice], place: "Mac", here: true, typed: false)), now: self.now()))
                self.changed()
                done(nil)
            } else {
                done(Self.problem(reply, agent: item.agent))
            }
        }
    }

    public func reply(_ itemID: Int, text: String, done: @escaping (String?) -> Void) {
        guard let item = state.item(itemID) else {
            done(Copy.noLongerWaiting)
            return
        }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        let key = "item:\(itemID)|\(words)"
        let ref = replyRefs[key] ?? Refs.fresh()
        replyRefs[key] = ref
        client.send(.reply(target: .item(itemID), text: words), ref: ref) { [weak self] reply in
            guard let self else { return }
            if reply.ok {
                self.replyRefs.removeValue(forKey: key)
                // Answered on another device first: CELLO says it went as a follow-up, and that's the line kept.
                self.run(self.state.answered(itemID, what: reply.string("said") ?? (item.kind == .request ? Copy.youAnswered : Copy.youReplied), now: self.now()))
                self.changed()
                done(nil)
            } else {
                // Only a line that never arrived keeps its ref for sending again.
                if reply.error != "not_connected" { self.replyRefs.removeValue(forKey: key) }
                done(Self.problem(reply, agent: item.agent))
            }
        }
    }

    // A message to an agent the person picked. Answers the line to show: passed on, or why not.
    public func message(_ agentID: String, text: String, done: @escaping (_ ok: Bool, _ line: String) -> Void) {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = state.agents.first { $0.agentID == agentID }?.name ?? agentID
        guard !words.isEmpty else { return }
        let key = "agent:\(agentID)|\(words)"
        let ref = replyRefs[key] ?? Refs.fresh()
        replyRefs[key] = ref
        client.send(.reply(target: .agent(agentID), text: words), ref: ref) { [weak self] reply in
            guard let self else { return }
            if reply.ok {
                self.replyRefs.removeValue(forKey: key)
                let passed = Copy.passedTo(reply.string("passed_to") ?? name)
                done(true, reply.string("note").map { "\(passed) \($0)" } ?? passed)
            } else {
                if reply.error != "not_connected" { self.replyRefs.removeValue(forKey: key) }
                done(false, Self.problem(reply, agent: name))
            }
        }
    }

    public func pause(until: Date, done: @escaping (String?) -> Void) {
        client.send(.pause(until: until)) { [weak self] reply in
            guard let self else { return }
            if reply.ok {
                self.state.setPaused(until: reply.string("paused_until").flatMap(parseISODate) ?? until)
                self.changed()
                done(nil)
            } else {
                done(reply.error == "not_connected" ? Copy.notConnected : Copy.didNotReach(Copy.appName))
            }
        }
    }

    public func resume(done: @escaping (String?) -> Void) {
        client.send(.resume) { [weak self] reply in
            guard let self else { return }
            if reply.ok {
                self.state.setPaused(until: nil)
                self.changed()
                done(nil)
            } else {
                done(reply.error == "not_connected" ? Copy.notConnected : Copy.didNotReach(Copy.appName))
            }
        }
    }

    // Takes this Mac off every agent. The app quits afterwards; this only says whether the door did it.
    public func remove(done: @escaping (String?) -> Void) {
        client.send(.remove) { [weak self] reply in
            guard let self else { return }
            if reply.ok {
                self.state.removedEverywhere()
                self.changed()
                done(nil)
            } else {
                done(reply.error == "not_connected" ? Copy.notConnected : Copy.removeFailed)
            }
        }
    }

    // Takes the Mac off one agent. Its cards go at once; the door's agent_removed frame then finds nothing left to do.
    public func removeAgent(_ agentID: String, done: @escaping (String?) -> Void) {
        let name = state.agents.first { $0.agentID == agentID }?.name ?? agentID
        client.send(.removeAgent(agentID: agentID)) { [weak self] reply in
            guard let self else { return }
            if reply.ok {
                self.run(self.state.agentRemoved(agentID))
                self.changed()
                done(nil)
            } else {
                done(reply.error == "not_connected" ? Copy.notConnected : reply.error == "no_such_agent" ? Copy.agentNotHere(name) : Copy.removeAgentFailed(name))
            }
        }
    }

    // The door's own message is for agents and the command line, so the person gets a line worded for them.
    public static func problem(_ reply: Reply, agent: String) -> String {
        switch reply.error {
        case "not_connected": return Copy.notConnected
        case "already_answered": return Copy.alreadyAnswered
        case "not_waiting": return Copy.noLongerWaiting
        case "no_agent": return Copy.agentGone(agent)
        case "no_such_agent": return Copy.agentNotHere(agent)
        default: return Copy.didNotReach(agent)
        }
    }

    // A pause ends at its time with nothing from the door, so the look changes back by itself.
    private func schedulePauseEnd() {
        pauseTimer?.cancel()
        pauseTimer = nil
        guard let until = state.pausedUntil else { return }
        let wait = until.timeIntervalSince(now())
        guard wait > 0 else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.delegate?.stateChanged(self)
        }
        pauseTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + wait + 1, execute: work)
    }
}
