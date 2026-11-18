// Drives a Controller, the same one the app runs, against a real operator's door, and shows nothing on screen. Commands
// arrive as JSON lines on standard input; everything that happens leaves as JSON lines on standard output. For the live
// test (live/mac-app.live.ts). A banner it's told to show counts as shown at once, as the app's does once macOS takes it.
//
//   cello-door-probe --socket <path to operator.sock>
import CELLOCore
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func out(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(2)
}

let args = CommandLine.arguments
guard let at = args.firstIndex(of: "--socket"), at + 1 < args.count else {
    fail("Usage: cello-door-probe --socket <path to operator.sock>. There is no default, so a test can never reach a person's own CELLO.")
}

func plan(_ p: BannerPlan) -> [String: Any] {
    ["item_id": p.itemID as Any, "title": p.title, "body": p.body, "buttons": p.buttons.map(\.title), "button_ids": p.buttons.map(\.identifier), "sound": p.sound, "category": p.category]
}

func describe(_ effect: Effect) -> [String: Any] {
    switch effect {
    case let .banner(p): return ["effect": "banner", "plan": plan(p)]
    case let .summary(s): return ["effect": "summary", "item_ids": s.itemIDs, "title": s.title, "body": s.body, "sound": s.sound]
    case let .withdraw(id): return ["effect": "withdraw", "item_id": id]
    case let .joined(agent): return ["effect": "joined", "agent_id": agent.agentID, "title": Copy.joinedTitle(agent.name), "body": Copy.joinedBody(agent.name)]
    case let .ack(id): return ["effect": "ack", "item_id": id]
    }
}

func snapshot(_ c: Controller) -> [String: Any] {
    let now = c.now()
    let connection: String
    switch c.state.connection {
    case .connected: connection = "connected"
    case .connecting: connection = "connecting"
    case .starting: connection = "starting"
    case let .unreachable(why): connection = "unreachable:\(why)"
    }
    return [
        "event": "state",
        "connection": connection,
        "look": c.state.look(at: now).rawValue,
        "paused_word": c.state.mark(at: now, time: isoString).word as Any,
        "tooltip": c.state.mark(at: now, time: isoString).tooltip as Any,
        "paused_until": c.state.pausedUntil.map(isoString) as Any,
        "agents": c.state.agents.map { ["agent_id": $0.agentID, "name": $0.name] },
        "waiting": c.state.waiting.map { item -> [String: Any] in
            [
                "id": item.id, "agent": item.agent, "kind": item.kind.rawValue, "text": item.text, "choices": item.choices,
                "talking": item.talkingTo.map(Copy.talkingTo) as Any, "age": Copy.ageShort(now.timeIntervalSince(item.sentAt)),
                "silent": item.silent, "shown": item.shown, "banner": plan(BannerPlan.forItem(item)),
            ]
        },
        "earlier": c.state.earlierToday(now: now).map { Copy.earlierLine(agent: $0.agent, what: $0.what, time: "") },
        "just_answered": c.state.justAnswered(now: now).map { $0.card ?? $0.what },
        "unseen_news": c.state.unseenNews.sorted(),
        "acked": c.state.acked.sorted(),
    ]
}

final class Probe: ControllerDelegate {
    func stateChanged(_ controller: Controller) {}

    func perform(_ effect: Effect, controller: Controller) {
        out(describe(effect))
        switch effect {
        case let .banner(p): if let id = p.itemID { controller.shown([id]) }
        case let .summary(s): controller.shown(s.itemIDs)
        default: break
        }
    }

    // A probe never starts CELLO: it only reports that the app would.
    func needsStart(_ controller: Controller) {
        out(["event": "needs_start"])
    }
}

let controller = Controller(socketPath: args[at + 1], turnedOn: !args.contains("--not-turned-on"))
let probe = Probe()

func answer(_ command: String, _ line: String?) {
    out(["event": "done", "do": command, "ok": line == nil, "line": line as Any])
}

func run(_ command: [String: Any]) {
    let what = command["do"] as? String ?? ""
    let id = (command["id"] as? NSNumber)?.intValue ?? -1
    switch what {
    case "state": out(snapshot(controller))
    case "panel":
        controller.panelOpened()
        answer(what, nil)
    case "turn_on":
        controller.turnOn()
        answer(what, nil)
    case "pick": controller.pick(id, choice: (command["choice"] as? NSNumber)?.intValue ?? -1) { answer(what, $0) }
    case "reply": controller.reply(id, text: command["text"] as? String ?? "") { answer(what, $0) }
    case "message":
        controller.message(command["agent"] as? String ?? "", text: command["text"] as? String ?? "") { ok, line in
            out(["event": "done", "do": what, "ok": ok, "line": line])
        }
    case "pause": controller.pause(until: Date().addingTimeInterval((command["seconds"] as? NSNumber)?.doubleValue ?? 3600)) { answer(what, $0) }
    case "resume": controller.resume { answer(what, $0) }
    case "remove": controller.remove { answer(what, $0) }
    case "remove_agent": controller.removeAgent(command["agent"] as? String ?? "") { answer(what, $0) }
    case "quit": exit(0)
    default: out(["event": "error", "message": "unknown command \(what)"])
    }
}

// Status changes are reported as they happen, so a test can wait for them.
final class Watch: ControllerDelegate {
    let inner: Probe
    var last = ""
    init(_ inner: Probe) { self.inner = inner }
    func stateChanged(_ controller: Controller) {
        let s = snapshot(controller)
        let key = "\(s["connection"] ?? "")|\(s["look"] ?? "")|\((s["waiting"] as? [Any])?.count ?? 0)|\((s["agents"] as? [Any])?.count ?? 0)"
        if key != last {
            last = key
            out(["event": "status", "connection": s["connection"] ?? "", "look": s["look"] ?? "", "waiting": (s["waiting"] as? [Any])?.count ?? 0])
        }
    }
    func perform(_ effect: Effect, controller: Controller) { inner.perform(effect, controller: controller) }
    func needsStart(_ controller: Controller) { inner.needsStart(controller) }
}

let watch = Watch(probe)
controller.delegate = watch

Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            out(["event": "error", "message": "not a JSON object"])
            continue
        }
        DispatchQueue.main.async { run(command) }
    }
    DispatchQueue.main.async { exit(0) }
}

controller.start()
dispatchMain()
