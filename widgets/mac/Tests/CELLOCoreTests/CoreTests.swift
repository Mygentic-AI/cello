import Foundation
import XCTest
@testable import CELLOCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func item(_ id: Int, kind: ItemKind = .request, choices: [String] = [], agent: String = "Ann", shown: Bool = false, silent: Bool = false, sent: Date = t0) -> Item {
    Item(id: id, agentID: String(repeating: "a", count: 64), agent: agent, kind: kind, text: "Bob's agent wants Friday. May I agree?", choices: choices, sentAt: sent, shown: shown, silent: silent)
}

private func subscribeReply(agents: [String] = ["Ann"], pausedUntil: String? = nil) -> Reply {
    Reply(ref: "r", ok: true, fields: ["agents": agents.map { ["agent_id": $0.lowercased(), "agent": $0, "notifier": "mac"] }, "paused_until": pausedUntil ?? NSNull()])
}

// A state that has subscribed and finished catching up, so frames count as live.
private func live(turnedOn: Bool = true) -> AppState {
    var s = AppState(turnedOn: turnedOn)
    s.subscribed(subscribeReply())
    _ = s.endCatchUp(now: t0)
    return s
}

final class FrameTests: XCTestCase {
    func testParsesANotificationAsTheDoorSendsIt() throws {
        let line = #"{"op":"notification","id":7,"agent_id":"ab12","agent":"Ann","kind":"request","text":"Which day?","choices":["Mon","Tue","Wed"],"session_id":"ff00","talking_to":{"agent_id":"cd34","name":"Northwind Sales","named_by":"itself","unverified":true},"sent_at":"2026-11-18T13:32:00.123Z","age_seconds":240,"shown":false,"silent":true}"#
        guard case let .notification(i) = try FrameParser.parse(line) else { return XCTFail("not a notification") }
        XCTAssertEqual(i.id, 7)
        XCTAssertEqual(i.agent, "Ann")
        XCTAssertEqual(i.kind, .request)
        XCTAssertEqual(i.choices, ["Mon", "Tue", "Wed"])
        XCTAssertEqual(i.sessionID, "ff00")
        XCTAssertEqual(i.talkingTo, TalkingTo(agentID: "cd34", name: "Northwind Sales", namedBy: "itself", unverified: true))
        XCTAssertEqual(i.sentAt, parseISODate("2026-11-18T13:32:00.123Z"))
        XCTAssertTrue(i.silent)
        XCTAssertFalse(i.shown)
    }

    func testANotificationWithoutTheFieldsItNeedsIsRefusedByName() {
        XCTAssertThrowsError(try FrameParser.parse(#"{"op":"notification","id":1,"agent_id":"a","text":"x"}"#)) { error in
            XCTAssertEqual(error as? FrameError, .missing(op: "notification", field: "sent_at"))
        }
        XCTAssertThrowsError(try FrameParser.parse("[1,2]")) { XCTAssertEqual($0 as? FrameError, .notJSONObject) }
        XCTAssertThrowsError(try FrameParser.parse("not json")) { XCTAssertEqual($0 as? FrameError, .notJSONObject) }
    }

    func testAKindThisAppDoesNotKnowIsNewsNeverAQuestion() throws {
        guard case let .notification(i) = try FrameParser.parse(#"{"op":"notification","id":1,"agent_id":"a","text":"x","kind":"surprise","sent_at":"2026-11-18T13:32:00Z"}"#) else { return XCTFail() }
        XCTAssertEqual(i.kind, .message)
    }

    func testParsesResultsSettledAndAgents() throws {
        guard case let .result(r) = try FrameParser.parse(#"{"op":"result","ref":"abc","ok":false,"error":"already_answered","message":"x","said":"y"}"#) else { return XCTFail() }
        XCTAssertEqual(r.ref, "abc")
        XCTAssertFalse(r.ok)
        XCTAssertEqual(r.error, "already_answered")
        XCTAssertEqual(r.string("said"), "y")
        XCTAssertNil(r.fields["op"])
        guard case let .settled(s) = try FrameParser.parse(#"{"op":"settled","id":3,"label":"Not yet","where":"Telegram","here":false,"typed":false}"#) else { return XCTFail() }
        XCTAssertEqual(s, Settled(id: 3, label: "Not yet", place: "Telegram", here: false, typed: false))
        guard case let .agentAdded(a) = try FrameParser.parse(#"{"op":"agent_added","agent_id":"bb","agent":"Bea"}"#) else { return XCTFail() }
        XCTAssertEqual(a, Agent(agentID: "bb", name: "Bea"))
        guard case let .agentRemoved(id) = try FrameParser.parse(#"{"op":"agent_removed","agent_id":"bb"}"#) else { return XCTFail() }
        XCTAssertEqual(id, "bb")
        guard case let .unknown(op) = try FrameParser.parse(#"{"op":"later_thing"}"#) else { return XCTFail() }
        XCTAssertEqual(op, "later_thing")
    }

    func testRequestsAreTheDoorsOwnWords() throws {
        func decoded(_ r: Request, _ ref: String = "ref-12345678") throws -> [String: Any] {
            let data = r.line(ref: ref)
            XCTAssertEqual(data.last, 0x0A, "one line each")
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data.dropLast()) as? [String: Any])
        }
        XCTAssertEqual(try decoded(.hello)["protocol"] as? Int, 1)
        let pick = try decoded(.pick(id: 4, choice: 1))
        XCTAssertEqual(pick["op"] as? String, "pick")
        XCTAssertEqual(pick["id"] as? Int, 4)
        XCTAssertEqual(pick["choice"] as? Int, 1)
        let answer = try decoded(.reply(target: .item(9), text: "Yes"))
        XCTAssertEqual(answer["id"] as? Int, 9)
        XCTAssertNil(answer["agent"])
        let message = try decoded(.reply(target: .agent("beef"), text: "Hi"))
        XCTAssertEqual(message["agent"] as? String, "beef")
        XCTAssertNil(message["id"])
        let pause = try decoded(.pause(until: t0))
        XCTAssertEqual((pause["until"] as? String).flatMap(parseISODate), t0)
        XCTAssertEqual(try decoded(.remove)["ref"] as? String, "ref-12345678")
    }

    func testFreshRefsAreOnesTheDoorTakesForAReply() {
        for _ in 0..<50 { XCTAssertTrue(Refs.isValid(Refs.fresh())) }
        XCTAssertFalse(Refs.isValid("short"))
        XCTAssertFalse(Refs.isValid("has space in it"))
        XCTAssertFalse(Refs.isValid("ünïcode-letters"))
        XCTAssertFalse(Refs.isValid(String(repeating: "a", count: 65)))
    }
}

final class LookTests: XCTestCase {
    func testEachStateHasOneLook() {
        var s = live()
        XCTAssertEqual(s.look(at: t0), .plain, "nothing waiting")
        _ = s.receive(item(1, kind: .message))
        XCTAssertEqual(s.look(at: t0), .news, "news: the dot")
        _ = s.receive(item(2, kind: .request))
        XCTAssertEqual(s.look(at: t0), .waiting, "a decision outranks news")
        s.setPaused(until: t0.addingTimeInterval(60))
        XCTAssertEqual(s.look(at: t0), .paused, "paused outranks a waiting question")
        XCTAssertEqual(s.look(at: t0.addingTimeInterval(61)), .waiting, "a pause ends by itself at its time")
        s.connection = .unreachable(.stopped("exit 1"))
        XCTAssertEqual(s.look(at: t0), .unreachable, "struck through outranks everything")
    }

    func testStartingOrReconnectingIsNeverStruckThrough() {
        var s = live()
        _ = s.receive(item(1))
        s.connection = .starting
        XCTAssertEqual(s.look(at: t0), .waiting)
        s.disconnected()
        XCTAssertEqual(s.look(at: t0), .waiting)
    }

    func testTheDotGoesOnceThePanelIsOpenedButAQuestionStaysPinkUntilAnswered() {
        var s = live()
        _ = s.receive(item(1, kind: .message))
        _ = s.receive(item(2, kind: .request))
        _ = s.panelOpened()
        XCTAssertEqual(s.look(at: t0), .waiting)
        _ = s.answered(2, what: Copy.youAnswered, now: t0)
        XCTAssertEqual(s.look(at: t0), .plain)
    }
}

final class BannerTests: XCTestCase {
    func testUpToTwoChoicesGoOnTheBannerWithReply() {
        let one = BannerPlan.forItem(item(1, choices: ["Agree"]))
        XCTAssertEqual(one.buttons, [.choice(index: 0, label: "Agree"), .reply])
        let two = BannerPlan.forItem(item(1, choices: ["Agree", "Disagree"]))
        XCTAssertEqual(two.buttons.map(\.title), ["Agree", "Disagree", "Reply…"])
        XCTAssertEqual(two.title, "Ann needs your decision")
        XCTAssertTrue(two.sound)
    }

    func testThreeOrMoreChoicesGetOneChooseThatOpensThePanel() {
        for count in 3...8 {
            let plan = BannerPlan.forItem(item(1, choices: (1...count).map { "Option \($0)" }))
            XCTAssertEqual(plan.buttons, [.choose, .reply], "\(count) choices")
            XCTAssertEqual(plan.buttons.map(\.title), ["Choose…", "Reply…"])
        }
    }

    func testOnlyADecisionMakesASound() {
        let news = BannerPlan.forItem(item(1, kind: .message))
        XCTAssertFalse(news.sound)
        XCTAssertEqual(news.title, "Ann has news for you")
        XCTAssertEqual(news.buttons, [.reply])
        XCTAssertFalse(BannerPlan.forItem(item(1, kind: .test)).sound)
        XCTAssertTrue(BannerPlan.forItem(item(1, kind: .request)).sound)
    }

    func testBannersWithTheSameButtonsShareACategoryAndOthersDoNot() {
        let a = BannerPlan.forItem(item(1, choices: ["Agree", "Disagree"]))
        let b = BannerPlan.forItem(item(2, choices: ["Agree", "Disagree"]))
        let c = BannerPlan.forItem(item(3, choices: ["Yes", "No"]))
        let d = BannerPlan.forItem(item(4, choices: ["Agree", "Disagree"], agent: "Rex"))
        XCTAssertEqual(a.category, b.category)
        XCTAssertNotEqual(a.category, c.category)
        XCTAssertNotEqual(a.category, d.category, "the Reply box names another agent")
    }
}

final class StateTests: XCTestCase {
    func testALiveQuestionGetsABanner() {
        var s = live()
        XCTAssertEqual(s.receive(item(1, choices: ["A", "B"])), [.banner(BannerPlan.forItem(item(1, choices: ["A", "B"])))])
    }

    func testASilentOneGoesToThePanelOnlyAndIsAckedWhenThePanelOpens() {
        var s = live()
        XCTAssertEqual(s.receive(item(1, silent: true)), [], "paused: no banner and no sound")
        XCTAssertEqual(s.waiting.map(\.id), [1])
        XCTAssertFalse(s.acked.contains(1), "not on screen yet, so the door isn't told it is")
        XCTAssertEqual(s.panelOpened(), [.ack(itemID: 1)])
        XCTAssertEqual(s.panelOpened(), [], "acked once")
    }

    func testOneShownBeforeIsNeverBanneredAgain() {
        var s = live()
        XCTAssertEqual(s.receive(item(1, shown: true)), [])
        XCTAssertTrue(s.acked.contains(1))
    }

    func testTheSameNotificationSentAgainOnReconnectIsNotBanneredTwice() {
        var s = live()
        _ = s.receive(item(1))
        XCTAssertEqual(s.receive(item(1)), [])
        XCTAssertEqual(s.waiting.count, 1)
    }

    func testWhatWaitedWhileAwayGetsOneBannerSayingHowMany() {
        var s = AppState(turnedOn: true)
        s.subscribed(subscribeReply(agents: ["Ann", "Rex"]))
        XCTAssertEqual(s.receive(item(1, agent: "Ann", sent: t0.addingTimeInterval(-7200))), [])
        XCTAssertEqual(s.receive(item(2, agent: "Rex", sent: t0.addingTimeInterval(-2400))), [])
        XCTAssertEqual(s.receive(item(3, kind: .message, agent: "Rex", shown: true)), [], "seen before")
        let effects = s.endCatchUp(now: t0)
        XCTAssertEqual(effects, [.summary(SummaryPlan(itemIDs: [1, 2], title: "2 questions waited while you were away", body: "Ann, 2 hours ago. Rex, 40 minutes ago.", sound: true))])
    }

    func testOneThatWaitedAloneGetsItsOwnBanner() {
        var s = AppState(turnedOn: true)
        s.subscribed(subscribeReply())
        _ = s.receive(item(1, choices: ["A", "B"]))
        XCTAssertEqual(s.endCatchUp(now: t0), [.banner(BannerPlan.forItem(item(1, choices: ["A", "B"])))])
    }

    func testNewsThatWaitedIsSummarisedWithoutASound() {
        var s = AppState(turnedOn: true)
        s.subscribed(subscribeReply())
        _ = s.receive(item(1, kind: .message, sent: t0.addingTimeInterval(-60)))
        _ = s.receive(item(2, kind: .message, sent: t0.addingTimeInterval(-30)))
        guard case let .summary(plan)? = s.endCatchUp(now: t0).first else { return XCTFail() }
        XCTAssertEqual(plan.title, "2 messages waited while you were away")
        XCTAssertFalse(plan.sound)
    }

    func testWhatWaitedDuringAPauseStaysSilent() {
        var s = AppState(turnedOn: true)
        s.subscribed(subscribeReply(pausedUntil: isoString(t0.addingTimeInterval(3600))))
        _ = s.receive(item(1, silent: true))
        _ = s.receive(item(2, silent: true))
        XCTAssertEqual(s.endCatchUp(now: t0), [])
        XCTAssertEqual(s.look(at: t0), .paused)
    }

    func testOneAnsweredWhileTheAppWasAwayIsDroppedOnReconnect() {
        var s = live()
        _ = s.receive(item(1))
        _ = s.receive(item(2))
        s.disconnected()
        s.subscribed(subscribeReply())
        _ = s.receive(item(2))
        XCTAssertEqual(s.endCatchUp(now: t0), [.withdraw(itemID: 1)], "its banner goes too")
        XCTAssertEqual(s.waiting.map(\.id), [2])
    }

    func testAnAckTheDoorNeverGotIsSentAgainWhenItSaysTheOneIsStillUnseen() {
        var s = live()
        _ = s.receive(item(1))
        s.markAcked(1)
        s.disconnected()
        s.subscribed(subscribeReply())
        XCTAssertEqual(s.receive(item(1, shown: false)), [.ack(itemID: 1)], "the door restarted before the ack landed")
        XCTAssertEqual(s.receive(item(1, shown: true)), [], "once it has it, nothing more")
    }

    func testBeforeTurnOnNothingIsBanneredThenItAllComesAsOne() {
        var s = AppState(turnedOn: false)
        s.subscribed(subscribeReply())
        _ = s.receive(item(1))
        XCTAssertEqual(s.endCatchUp(now: t0), [])
        XCTAssertEqual(s.receive(item(2)), [], "still not turned on")
        XCTAssertEqual(s.agentAdded(Agent(agentID: "bb", name: "Bea")), [], "no joined banner before Turn on")
        guard case let .summary(plan)? = s.turnOn(now: t0).first else { return XCTFail() }
        XCTAssertEqual(plan.itemIDs, [1, 2])
    }

    func testSettledFoldsIntoEarlierTodayWithWhereItWasAnswered() {
        var s = live()
        _ = s.receive(item(1, agent: "Rex"))
        _ = s.receive(item(2, agent: "Ann"))
        XCTAssertEqual(s.settled(Settled(id: 1, label: "Not yet", place: "Telegram", here: false, typed: false), now: t0), [.withdraw(itemID: 1)])
        XCTAssertEqual(s.settled(Settled(id: 2, label: "Agree", place: "Mac", here: true, typed: false), now: t0.addingTimeInterval(1)), [.withdraw(itemID: 2)])
        XCTAssertEqual(s.settled(Settled(id: 2, label: "Agree", place: "Mac", here: true, typed: false), now: t0), [], "once")
        XCTAssertEqual(s.earlierToday(now: t0.addingTimeInterval(2)).map(\.what), ["You chose “Agree”", "Answered on Telegram: “Not yet”"])
        XCTAssertEqual(s.earlierToday(now: t0.addingTimeInterval(2 * 86400)), [], "only today's")
    }

    func testSettledLinesForEveryWayAQuestionIsAnswered() {
        XCTAssertEqual(Copy.settledLine(Settled(id: 1, label: "Agree", place: "Mac", here: true, typed: false)), "You chose “Agree”")
        XCTAssertEqual(Copy.settledLine(Settled(id: 1, label: "a typed answer", place: "Mac", here: true, typed: true)), "You answered in your own words")
        XCTAssertEqual(Copy.settledLine(Settled(id: 1, label: "Not yet", place: "Telegram", here: false, typed: false)), "Answered on Telegram: “Not yet”")
        XCTAssertEqual(Copy.settledLine(Settled(id: 1, label: "a typed answer", place: "Telegram", here: false, typed: true)), "Answered on Telegram in your own words")
    }

    func testANewAgentJoinsQuietlyAndOneRemovedTakesItsCardsWithIt() {
        var s = live()
        XCTAssertEqual(s.agentAdded(Agent(agentID: "bb", name: "Bea")), [.joined(Agent(agentID: "bb", name: "Bea"))])
        XCTAssertEqual(s.agentAdded(Agent(agentID: "bb", name: "Bea")), [])
        _ = s.receive(item(5))
        XCTAssertEqual(s.agentRemoved(String(repeating: "a", count: 64)), [.withdraw(itemID: 5)])
        XCTAssertTrue(s.waiting.isEmpty)
    }

    func testNothingIsAckedWhileDisconnected() {
        var s = live()
        _ = s.receive(item(1, silent: true))
        s.disconnected()
        XCTAssertEqual(s.panelOpened(), [])
    }
}

final class CopyTests: XCTestCase {
    func testAgesReadAsInTheDesign() {
        XCTAssertEqual(Copy.ageShort(240), "4 min")
        XCTAssertEqual(Copy.ageShort(18 * 60), "18 min")
        XCTAssertEqual(Copy.ageShort(2 * 3600 + 5), "2 h")
        XCTAssertEqual(Copy.ageShort(20), "now")
        XCTAssertEqual(Copy.agoLong(2 * 3600), "2 hours ago")
        XCTAssertEqual(Copy.agoLong(40 * 60), "40 minutes ago")
        XCTAssertEqual(Copy.agoLong(61), "1 minute ago")
    }

    func testWhoTheAgentIsTalkingTo() {
        XCTAssertEqual(Copy.talkingTo(TalkingTo(agentID: "x", name: "Bob Lee", namedBy: "you", unverified: false)), "Talking to Bob Lee, from your contacts")
        XCTAssertEqual(Copy.talkingTo(TalkingTo(agentID: "x", name: "Northwind Sales", namedBy: "itself", unverified: true)), "Talking to “Northwind Sales”, a name it gave itself, not checked")
    }

    func testListsOfNames() {
        XCTAssertEqual(Copy.firstRunBody(["Ann", "Rex"]), "When Ann or Rex needs a decision and you're not in their session, they'll ask you on this Mac. You answer in one click.")
        XCTAssertEqual(Copy.allSetBody(["Ann", "Rex"]), "Ann and Rex can reach you here. This is how a question from them will look.")
        XCTAssertEqual(Copy.removeBody(["Ann", "Rex", "Bea"]), "Ann, Rex and Bea won't be able to reach you here. Your phone keeps working as it does now.")
        XCTAssertEqual(Copy.agentsHere(["Ann", "Rex", "Bea", "Cy"]), "Agents that can reach you here: Ann, Rex, Bea…")
    }

    // The design never says these to the person. Every line the app shows is in Copy.swift or the app's own sources.
    func testNoLineThePersonSeesUsesTheWordsTheDesignRulesOut() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources").standardized
        let files = try FileManager.default.subpathsOfDirectory(atPath: sources.path).filter { $0.hasSuffix(".swift") }
        XCTAssertFalse(files.isEmpty)
        let banned = try NSRegularExpression(pattern: #"\b(notifiers?|daemons?|queued|paired)\b"#, options: [.caseInsensitive])
        let literal = try NSRegularExpression(pattern: #""(?:[^"\\]|\\.)*""#)
        for file in files {
            let text = try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
            for line in text.components(separatedBy: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                let ns = line as NSString
                for match in literal.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
                    let quoted = ns.substring(with: match.range)
                    let hit = banned.firstMatch(in: quoted, range: NSRange(location: 0, length: (quoted as NSString).length))
                    XCTAssertNil(hit, "\(file): \(quoted)")
                }
            }
        }
    }
}

final class PauseTests: XCTestCase {
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    func testTomorrowMorningIsNineTomorrowOrNineTodayInTheSmallHours() {
        let evening = parseISODate("2026-11-18T21:30:00Z")!
        XCTAssertEqual(PauseTimes.tomorrowMorning(from: evening, calendar: utc), parseISODate("2026-11-19T09:00:00Z"))
        let smallHours = parseISODate("2026-11-19T02:00:00Z")!
        XCTAssertEqual(PauseTimes.tomorrowMorning(from: smallHours, calendar: utc), parseISODate("2026-11-19T09:00:00Z"))
        XCTAssertEqual(PauseTimes.anHour(from: evening), parseISODate("2026-11-18T22:30:00Z"))
    }
}

final class LaunchTests: XCTestCase {
    private func temp() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cello-launch-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testReadsWhereCelloLivesAndHowToStartIt() throws {
        let dir = temp()
        let file = dir.appendingPathComponent("launch.json")
        try #"{"cello_home":"/Users/x/.cello-test","start":["/usr/local/bin/node","/opt/cello/dist/cli.js","login"]}"#.write(to: file, atomically: true, encoding: .utf8)
        let info = try LaunchInfo.load(from: file, home: "/Users/x")
        XCTAssertEqual(info.celloHome, "/Users/x/.cello-test")
        XCTAssertEqual(info.socketPath, "/Users/x/.cello-test/operator.sock")
        XCTAssertEqual(info.start, ["/usr/local/bin/node", "/opt/cello/dist/cli.js", "login"])
    }

    func testWithNoFileItUsesCellosOwnFolderAndKnowsItCannotStartIt() throws {
        let info = try LaunchInfo.load(from: temp().appendingPathComponent("absent.json"), home: "/Users/x")
        XCTAssertEqual(info.socketPath, "/Users/x/.cello/operator.sock")
        XCTAssertNil(info.start)
        guard case .failure(.notInstalled) = CelloStarter.start(info) else { return XCTFail("starting with no command must fail by name") }
    }

    func testAStartThatFailsSaysSoAndOneThatWorksSaysSo() {
        let failing = LaunchInfo(celloHome: "/tmp/none", start: ["/bin/sh", "-c", "echo nope; exit 3"])
        guard case let .failure(.exited(code, said)) = CelloStarter.start(failing) else { return XCTFail() }
        XCTAssertEqual(code, 3)
        XCTAssertEqual(said, "nope")
        let home = temp().path
        let working = LaunchInfo(celloHome: home, start: ["/bin/sh", "-c", "test \"$CELLO_HOME\" = \"\(home)\""])
        guard case .success = CelloStarter.start(working) else { return XCTFail("CELLO_HOME reaches the command") }
        let gone = LaunchInfo(celloHome: home, start: ["/nonexistent/node", "cli.js", "login"])
        guard case .failure(.notInstalled("/nonexistent/node")) = CelloStarter.start(gone) else { return XCTFail() }
    }
}

final class ControllerStartTests: XCTestCase {
    // No socket is opened: start() is never called.
    func testAFailedStartKeepsWhatCelloLoginSaid() {
        let c = Controller(socketPath: "/nonexistent/operator.sock", turnedOn: true)
        c.startFinished(.failure(.exited(1, "A daemon is already running for wss://x. Run: cello logout")))
        XCTAssertEqual(c.state.connection, .unreachable(.stopped("A daemon is already running for wss://x. Run: cello logout")))
        c.startFinished(.failure(.notInstalled("/opt/node")))
        XCTAssertEqual(c.state.connection, .unreachable(.unknownInstall))
        c.startFinished(.failure(.timedOut))
        XCTAssertEqual(c.state.connection, .unreachable(.stopped(Copy.startTimedOut)))
    }
}

final class ControllerConnectTests: XCTestCase {
    // A path too long for a Unix socket can never connect, and starting CELLO wouldn't help: it's said, not waited on.
    func testAConnectFailureOtherThanNotRunningEndsStruckThroughWithItsReason() {
        let c = Controller(socketPath: "/tmp/" + String(repeating: "x", count: 200) + "/operator.sock", turnedOn: true)
        c.failuresAfterStart = 2
        c.start()
        defer { c.stop() }
        let deadline = Date().addingTimeInterval(10)
        while c.state.connection != .unreachable(.cannotConnect(ENAMETOOLONG)) && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        XCTAssertEqual(c.state.connection, .unreachable(.cannotConnect(ENAMETOOLONG)))
        XCTAssertEqual(c.state.look(at: Date()), .unreachable)
        XCTAssertTrue(Copy.cannotConnect(ENAMETOOLONG).hasPrefix("This app can't connect to CELLO: "))
    }
}

final class ControllerDoorTests: XCTestCase {
    func testARefusedSubscribeIsSaidNotShownAsConnected() {
        let door = FakeDoor()
        defer { door.close() }
        door.answer = { r in
            r["op"] as? String == "subscribe"
                ? ["op": "result", "ref": r["ref"] ?? "", "ok": false, "error": "internal_error", "message": "That failed inside CELLO: disk full"]
                : ["op": "result", "ref": r["ref"] ?? "", "ok": true]
        }
        let c = Controller(socketPath: door.path, turnedOn: true)
        c.start()
        defer { c.stop() }
        XCTAssertTrue(waitUntil { c.state.connection == .unreachable(.subscribeRefused("That failed inside CELLO: disk full")) }, "\(c.state.connection)")
        XCTAssertEqual(c.state.look(at: Date()), .unreachable)
    }

    // The door takes a reply's ref as its id, so a line dropped before the answer is resent with the same ref and
    // reaches the agent once.
    func testAReplyResentAfterADroppedLineKeepsItsRef() {
        let door = FakeDoor()
        defer { door.close() }
        var dropped = false
        door.answer = { r in
            switch r["op"] as? String {
            case "subscribe":
                return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "agents": [["agent_id": "aa", "agent": "Ann"]], "paused_until": NSNull()]
            case "reply" where !dropped:
                dropped = true
                return nil
            default:
                return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "passed_to": "Ann"]
            }
        }
        let c = Controller(socketPath: door.path, turnedOn: true)
        c.start()
        defer { c.stop() }
        XCTAssertTrue(waitUntil { c.state.agents.count == 1 })
        var first: Bool?
        c.message("aa", text: "Book the room.") { ok, _ in first = ok }
        XCTAssertTrue(waitUntil { first != nil })
        XCTAssertEqual(first, false, "the line dropped before an answer")
        XCTAssertTrue(waitUntil { c.state.connection == .connected && door.requests.filter { $0["op"] as? String == "subscribe" }.count == 2 })
        var second: Bool?
        c.message("aa", text: "Book the room.") { ok, _ in second = ok }
        XCTAssertTrue(waitUntil { second != nil })
        XCTAssertEqual(second, true)
        let refs = door.requests.filter { $0["op"] as? String == "reply" }.map { $0["ref"] as? String }
        XCTAssertEqual(refs.count, 2)
        XCTAssertEqual(refs[0], refs[1], "the same ref both times")
        var third: Bool?
        c.message("aa", text: "Book the room.") { ok, _ in third = ok }
        XCTAssertTrue(waitUntil { third != nil })
        let after = door.requests.filter { $0["op"] as? String == "reply" }.map { $0["ref"] as? String }
        XCTAssertNotEqual(after[2], after[0], "once taken, the same words again are a new message")
    }
}
