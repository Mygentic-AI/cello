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
        let one = try decoded(.removeAgent(agentID: "beef"))
        XCTAssertEqual([one["op"] as? String, one["agent"] as? String], ["remove_agent", "beef"])
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
        // Chosen here: a card for a few seconds, then a line. Answered elsewhere: a line at once.
        XCTAssertEqual(s.justAnswered(now: t0.addingTimeInterval(2)).map(\.card), ["You chose “Agree”. Ann has it."])
        XCTAssertEqual(s.earlierToday(now: t0.addingTimeInterval(2)).map(\.what), ["Answered on Telegram: “Not yet”"])
        XCTAssertEqual(s.nextCardFold(now: t0.addingTimeInterval(2)), t0.addingTimeInterval(1 + answeredCardSeconds))
        XCTAssertEqual(s.justAnswered(now: t0.addingTimeInterval(1 + answeredCardSeconds)), [])
        XCTAssertEqual(s.earlierToday(now: t0.addingTimeInterval(1 + answeredCardSeconds)).map(\.what), ["You chose “Agree”", "Answered on Telegram: “Not yet”"])
        XCTAssertEqual(s.earlierToday(now: t0.addingTimeInterval(2 * 86400)), [], "only today's")
    }

    func testATypedAnswerHereShowsItsCardThenFolds() {
        var s = live()
        _ = s.receive(item(3, choices: ["Agree", "Disagree"]))
        _ = s.settled(Settled(id: 3, label: "a typed answer", place: "Mac", here: true, typed: true), now: t0)
        XCTAssertEqual(s.justAnswered(now: t0).map(\.card), ["You answered in your own words. Ann has it."])
        _ = s.receive(item(4, kind: .message))
        _ = s.answered(4, what: Copy.youReplied, card: Copy.repliedCard(request: false, agent: "Ann"), now: t0)
        XCTAssertEqual(s.justAnswered(now: t0.addingTimeInterval(1)).map(\.card), ["You replied. Ann has it.", "You answered in your own words. Ann has it."])
        XCTAssertEqual(s.earlierToday(now: t0.addingTimeInterval(1)), [])
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
        // Kept for the log, never shown: what the panel says is the app's own words.
        if case let .unreachable(why) = c.state.connection {
            let shown = Copy.unreachable(why)
            XCTAssertEqual([shown.reason, shown.fix], [Copy.unreachableStopped, Copy.unreachableFix])
        }
        // Exactly the app's own lines, whatever the payload says.
        let cases: [(Unreachable, String, String)] = [
            (.stopped("daemon said x"), Copy.unreachableStopped, Copy.unreachableFix),
            (.subscribeRefused("That failed inside CELLO: daemon x"), Copy.unreachableRefused, Copy.restartFix),
            (.mismatch("daemon speaks 2"), Copy.unreachableMismatch, Copy.mismatchFix),
            (.cannotConnect(EACCES), Copy.cannotConnect, Copy.restartFix),
        ]
        for (why, reason, fix) in cases {
            let shown = Copy.unreachable(why)
            XCTAssertEqual([shown.reason, shown.fix], [reason, fix], "\(why)")
        }
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
        // The system's reason is in the log; the person reads the app's own line.
        XCTAssertEqual(Copy.unreachable(.cannotConnect(ENAMETOOLONG)).reason, Copy.cannotConnect)
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

    // An answered card folds with nothing from the door, so the Controller has to redraw by itself when it does.
    func testTheControllerRedrawsWhenAnAnsweredCardFolds() {
        // Each redraw, and whether the panel would then find the card folded.
        final class Counter: ControllerDelegate {
            var redraws: [(at: Date, folded: Bool)] = []
            func stateChanged(_ controller: Controller) { redraws.append((Date(), controller.state.justAnswered(now: Date()).isEmpty)) }
            func perform(_ effect: Effect, controller: Controller) {}
            func needsStart(_ controller: Controller) {}
        }
        let door = FakeDoor()
        defer { door.close() }
        let news: [String: Any] = ["op": "notification", "id": 8, "agent_id": "aa", "agent": "Ann", "kind": "message", "text": "Done.", "choices": [String](), "session_id": NSNull(), "talking_to": NSNull(), "sent_at": "2026-11-18T10:01:00Z", "age_seconds": 0, "shown": false, "silent": false]
        door.answer = { r in
            r["op"] as? String == "subscribe"
                ? ["op": "result", "ref": r["ref"] ?? "", "ok": true, "agents": [["agent_id": "aa", "agent": "Ann"]], "paused_until": NSNull()]
                : ["op": "result", "ref": r["ref"] ?? "", "ok": true, "passed_to": "Ann"]
        }
        door.then = { r in r["op"] as? String == "subscribe" ? [news] : [] }
        let counter = Counter()
        let c = Controller(socketPath: door.path, turnedOn: true)
        c.delegate = counter
        c.start()
        defer { c.stop() }
        XCTAssertTrue(waitUntil { c.state.item(8) != nil })
        // Past the catch-up window, whose own redraw would otherwise be counted.
        XCTAssertTrue(waitUntil(3) { !c.state.catchingUp })
        var done = false
        c.reply(8, text: "Thanks.") { _ in done = true }
        XCTAssertTrue(waitUntil { done })
        XCTAssertEqual(c.state.justAnswered(now: Date()).count, 1)
        let answeredAt = Date()
        counter.redraws = []
        XCTAssertTrue(waitUntil(answeredCardSeconds + 3) { counter.redraws.contains { $0.folded } }, "no redraw when the card folded")
        let fold = counter.redraws.first { $0.folded }
        XCTAssertGreaterThanOrEqual(fold?.at.timeIntervalSince(answeredAt) ?? 0, answeredCardSeconds - 0.5)
    }

    // A typed answer to a question already answered elsewhere goes on as a follow-up. The panel keeps the app's own line
    // for it, from the first answer the door names, never the door's words. Otherwise it's the usual line.
    func testAReplyKeepsTheFollowUpLineInTheAppsWordsAndOtherwiseTheUsualOne() {
        let door = FakeDoor()
        defer { door.close() }
        let question: [String: Any] = ["op": "notification", "id": 7, "agent_id": "aa", "agent": "Ann", "kind": "request", "text": "Wine?", "choices": ["Red", "White"], "session_id": NSNull(), "talking_to": NSNull(), "sent_at": "2026-11-18T10:00:00Z", "age_seconds": 0, "shown": false, "silent": false]
        let news: [String: Any] = ["op": "notification", "id": 8, "agent_id": "aa", "agent": "Ann", "kind": "message", "text": "Done.", "choices": [String](), "session_id": NSNull(), "talking_to": NSNull(), "sent_at": "2026-11-18T10:01:00Z", "age_seconds": 0, "shown": false, "silent": false]
        door.answer = { r in
            switch r["op"] as? String {
            case "subscribe":
                return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "agents": [["agent_id": "aa", "agent": "Ann"]], "paused_until": NSNull()]
            case "reply" where r["id"] as? Int == 7:
                return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "passed_to": "Ann", "follow_up": true, "first_answer": "White", "said": "The door's own words, never shown."]
            default:
                return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "passed_to": "Ann"]
            }
        }
        door.then = { r in r["op"] as? String == "subscribe" ? [question, news] : [] }
        let c = Controller(socketPath: door.path, turnedOn: true)
        c.start()
        defer { c.stop() }
        XCTAssertTrue(waitUntil { c.state.item(7) != nil && c.state.item(8) != nil })
        var done = 0
        c.reply(7, text: "Actually red.") { _ in done += 1 }
        c.reply(8, text: "Thanks.") { _ in done += 1 }
        XCTAssertTrue(waitUntil { done == 2 })
        XCTAssertEqual(c.state.earlier.map(\.what), ["Already answered: White. Passed to Ann as a follow-up.", Copy.youReplied])
    }
}

final class EditMenuTests: XCTestCase {
    // Without these the text boxes take no paste, so dictation, which pastes, does nothing either.
    func testEveryEditingKeyGoesToTheStandardActionOfTheBoxWithFocus() {
        let keys = EditMenu.items.compactMap { $0 }.map { "\($0.shift ? "⇧" : "")⌘\($0.key.uppercased()) \($0.action)" }
        XCTAssertEqual(keys, ["⌘Z undo:", "⇧⌘Z redo:", "⌘X cut:", "⌘C copy:", "⌘V paste:", "⌘A selectAll:"])
        // macOS adds Start Dictation only to a menu with this title.
        XCTAssertEqual(EditMenu.title, "Edit")
    }

    func testTheAppInstallsItAsItsMainMenu() throws {
        let main = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/CELLO/main.swift").standardized
        let text = try String(contentsOf: main, encoding: .utf8)
        XCTAssertTrue(text.contains("app.mainMenu = MainMenu.make()"), "main.swift must install the Edit menu")
    }
}

final class TextAreaTests: XCTestCase {
    func testReturnSendsShiftOrOptionReturnStartsALineAndComposingTextKeepsIt() {
        XCTAssertEqual(TextArea.onReturn(shift: false, option: false, composing: false), .send)
        XCTAssertEqual(TextArea.onReturn(shift: true, option: false, composing: false), .newLine)
        XCTAssertEqual(TextArea.onReturn(shift: false, option: true, composing: false), .newLine)
        // Finishing a word in an input method must never send half an answer.
        XCTAssertEqual(TextArea.onReturn(shift: false, option: false, composing: true), .leave)
    }

    func testTheBoxIsThreeLinesEmptyGrowsWithTheTextAndStopsAtEight() {
        let line = 16.0
        XCTAssertEqual(TextArea.height(contentHeight: 0, lineHeight: line, inset: 5), 3 * line + 10)
        XCTAssertEqual(TextArea.height(contentHeight: 5 * line, lineHeight: line, inset: 5), 5 * line + 10)
        XCTAssertEqual(TextArea.height(contentHeight: 40 * line, lineHeight: line, inset: 5), 8 * line + 10)
    }

    // Both boxes are the growing one: a single-line field is what the owner found too short.
    func testTheReplyBoxAndTheMessageBoxAreBothTextAreas() throws {
        let panel = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/CELLO/PanelView.swift").standardized
        let text = try String(contentsOf: panel, encoding: .utf8)
        XCTAssertFalse(text.contains("TextField("), "no single-line field left in the panel")
        XCTAssertEqual(text.components(separatedBy: "GrowingTextArea(").count - 1, 2)
    }
}

final class PanelSizeTests: XCTestCase {
    func testTheListIsAsTallAsWhatsInItUntilThePanelPassesTwoThirdsOfTheScreen() {
        // A question with eight choices, about 460 points, on a 1000-point screen with 170 of header and message box.
        XCTAssertEqual(PanelSize.listHeight(content: 460, chrome: 170, screen: 1000), 460)
        // More than fits: the panel stops at two-thirds, 666, and the list scrolls inside it.
        XCTAssertEqual(PanelSize.listHeight(content: 1400, chrome: 170, screen: 1000), 1000 * 2 / 3 - 170, accuracy: 0.001)
        // Nothing waiting: it doesn't hold space it has no use for.
        XCTAssertEqual(PanelSize.listHeight(content: 40, chrome: 170, screen: 1000), 40)
        // A tiny screen still leaves the list room to scroll.
        XCTAssertEqual(PanelSize.listHeight(content: 900, chrome: 400, screen: 500), PanelSize.smallestList)
    }

    // A question with eight choices, the card's reply box under them, and the composer closed, fits without scrolling.
    // The text heights in the sum are the system font's line heights, not read from a drawn panel, so the margin is small
    // by design: an eye on the real panel is the last word.
    func testEightChoicesAndTheReplyBoxFitOnALaptopScreen() {
        // The owner's MacBook Pro: 982 high, less a 33-point menu bar and a 79-point Dock, as macOS logged it.
        let owners = 870.0
        // A 13-inch MacBook Air at its default size: 956 high, less the menu bar and the Dock.
        let air = 840.0
        func fits(_ screen: Double, questionLines: Int) -> Bool {
            let whole = PanelLayout.oneQuestion(choices: 8, questionLines: questionLines, talkingTo: true)
            let list = whole - PanelLayout.chrome
            return PanelSize.listHeight(content: list, chrome: PanelLayout.chrome, screen: screen) == list
        }
        XCTAssertTrue(fits(owners, questionLines: 2), "\(PanelLayout.oneQuestion(choices: 8, questionLines: 2, talkingTo: true)) against \(owners * PanelSize.screenShare)")
        XCTAssertTrue(fits(air, questionLines: 1), "\(PanelLayout.oneQuestion(choices: 8, questionLines: 1, talkingTo: true)) against \(air * PanelSize.screenShare)")
        // Still easy to hit with a mouse.
        XCTAssertGreaterThanOrEqual(PanelLayout.choiceHeight, 28)
    }

    // The sum above is only worth something if the panel is drawn from the same numbers.
    func testThePanelIsDrawnFromTheNumbersTheSumUses() throws {
        let panel = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/CELLO/PanelView.swift").standardized
        let text = try String(contentsOf: panel, encoding: .utf8)
        for name in ["choiceHeight", "choiceGap", "cardPadding", "cardSpacing", "listPadding", "listSpacing", "headerPadding", "headerIcon", "composerPadding", "replyLinesUnderChoices"] {
            XCTAssertTrue(text.contains("PanelLayout.\(name)"), "PanelView doesn't use PanelLayout.\(name)")
        }
        XCTAssertFalse(text.contains("MESSAGE AN AGENT"))
    }
}

final class ClickAwayTests: XCTestCase {
    // The owner's repro: it closed until a button inside it was clicked, and after that an outside click did nothing.
    func testAnOutsideClickClosesThePanelAfterAClickInsideItAndAfterTheMarkChanged() {
        var started = 0, stopped = 0, closed = 0
        let away = ClickAway(start: { started += 1 }, stop: { stopped += 1 })
        away.close = { closed += 1 }
        away.panelShown()
        away.click(.insidePanel)      // answered Yes
        away.click(.insidePanel)      // and picked a pause in Settings
        XCTAssertEqual(closed, 0)
        XCTAssertTrue(away.watching, "a click inside never stops the watch")
        away.click(.elsewhere)
        XCTAssertEqual(closed, 1)
        away.panelClosed()
        XCTAssertEqual([started, stopped], [1, 1])
    }

    func testTheWatchStartsAgainEachTimeThePanelOpensAndIsIdleWhileItIsShut() {
        var started = 0, stopped = 0, closed = 0
        let away = ClickAway(start: { started += 1 }, stop: { stopped += 1 })
        away.close = { closed += 1 }
        away.click(.elsewhere)
        away.appDeactivated()
        XCTAssertEqual(closed, 0, "nothing to close while shut")
        for _ in 0..<3 {
            away.panelShown()
            away.panelShown()          // shown twice, as from a banner while open: one watch
            away.click(.onMark)        // the mark's own click toggles it; the watch leaves it alone
            away.appDeactivated()      // another app came forward
            away.panelClosed()
            away.panelClosed()
        }
        XCTAssertEqual([started, stopped, closed], [3, 3, 3])
    }
}

final class PausedMarkTests: XCTestCase {
    private let time: (Date) -> String = { _ in "9:00 AM" }

    func testPausedShowsTheWordForAFewSecondsThenOnlyTheFadedMarkWithUntilWhenOnHover() {
        var s = live()
        s.setPaused(until: t0.addingTimeInterval(3600), here: t0)
        XCTAssertEqual(s.mark(at: t0.addingTimeInterval(1), time: time), MarkLook(look: .paused, word: "paused", tooltip: "Paused until 9:00 AM"))
        XCTAssertEqual(s.pausedWordEnds(now: t0.addingTimeInterval(1)), t0.addingTimeInterval(pausedWordSeconds))
        XCTAssertEqual(s.mark(at: t0.addingTimeInterval(pausedWordSeconds + 0.1), time: time), MarkLook(look: .paused, word: nil, tooltip: "Paused until 9:00 AM"))
        XCTAssertNil(s.pausedWordEnds(now: t0.addingTimeInterval(pausedWordSeconds + 0.1)))
        // Resumed: no word and nothing on hover.
        s.setPaused(until: nil)
        XCTAssertEqual(s.mark(at: t0.addingTimeInterval(10), time: time), MarkLook(look: .plain, word: nil, tooltip: nil))
    }

    // A pause CELLO reports when the app connects was set earlier, so the word doesn't flash on every reconnect.
    func testAPauseFoundOnConnectingShowsOnlyTheFadedMark() {
        var s = AppState(turnedOn: true)
        s.subscribed(subscribeReply(pausedUntil: isoString(Date().addingTimeInterval(3600))))
        let mark = s.mark(at: Date(), time: time)
        XCTAssertEqual([mark.look.rawValue, mark.word ?? "none", mark.tooltip ?? "none"], ["paused", "none", "Paused until 9:00 AM"])
    }

    func testOtherLooksSayNothingOnHover() {
        var s = live()
        _ = s.receive(item(1, choices: ["Yes", "No"]))
        XCTAssertEqual(s.mark(at: t0, time: time), MarkLook(look: .waiting, word: nil, tooltip: nil))
    }

    // The word goes with nothing from the door, so the Controller redraws by itself when it does.
    func testTheControllerRedrawsWhenTheWordGoes() {
        final class Marks: ControllerDelegate {
            var seen: [(at: Date, word: String?)] = []
            func stateChanged(_ controller: Controller) { seen.append((Date(), controller.state.mark(at: Date(), time: { _ in "" }).word)) }
            func perform(_ effect: Effect, controller: Controller) {}
            func needsStart(_ controller: Controller) {}
        }
        let door = FakeDoor()
        defer { door.close() }
        let until = isoString(Date().addingTimeInterval(3600))
        door.answer = { r in
            switch r["op"] as? String {
            case "subscribe": return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "agents": [["agent_id": "aa", "agent": "Ann"]], "paused_until": NSNull()]
            case "pause": return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "paused_until": until]
            default: return ["op": "result", "ref": r["ref"] ?? "", "ok": true]
            }
        }
        let marks = Marks()
        let c = Controller(socketPath: door.path, turnedOn: true)
        c.delegate = marks
        c.start()
        defer { c.stop() }
        XCTAssertTrue(waitUntil(3) { c.state.connection == .connected && !c.state.catchingUp })
        var done = false
        let pausedAt = Date()
        c.pause(until: Date().addingTimeInterval(3600)) { _ in done = true }
        XCTAssertTrue(waitUntil { done })
        XCTAssertEqual(marks.seen.last?.word, "paused")
        XCTAssertTrue(waitUntil(pausedWordSeconds + 3) { marks.seen.last?.word == nil }, "no redraw when the word went")
        XCTAssertGreaterThanOrEqual(marks.seen.last!.at.timeIntervalSince(pausedAt), pausedWordSeconds - 0.5)
    }
}

final class FocusTests: XCTestCase {
    // A Focus that lets CELLO through lets its active notifications through. News is passive, so it waits regardless.
    func testQuestionsComeThroughAFocusThatLetsCelloThroughAndNewsAlwaysWaits() {
        XCTAssertTrue(BannerPlan.forItem(item(1, choices: ["Yes", "No"])).breaksThrough)
        XCTAssertTrue(BannerPlan.forItem(item(2, choices: [])).breaksThrough)
        XCTAssertFalse(BannerPlan.forItem(item(3, kind: .message)).breaksThrough)
        // A test is the person checking it arrives, not news.
        XCTAssertTrue(BannerPlan.forItem(item(4, kind: .test)).breaksThrough)
        XCTAssertTrue(SummaryPlan(itemIDs: [1, 3], title: "", body: "", sound: true).breaksThrough)
        XCTAssertFalse(SummaryPlan(itemIDs: [3], title: "", body: "", sound: false).breaksThrough)
    }

    func testEveryBannerTheAppPostsCarriesItsLevelAndFirstRunOpensFocusSettings() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/CELLO").standardized
        let banners = try String(contentsOf: app.appendingPathComponent("Banners.swift"), encoding: .utf8)
        XCTAssertEqual(banners.components(separatedBy: "UNMutableNotificationContent()").count, banners.components(separatedBy: "content.interruptionLevel = ").count)
        XCTAssertTrue(banners.contains("breaksThrough ? .active : .passive"))
        let firstRun = try String(contentsOf: app.appendingPathComponent("FirstRun.swift"), encoding: .utf8)
        XCTAssertTrue(firstRun.contains("Copy.focusSettingsURL"))
        // The extension macOS 14 and later registers for System Settings › Focus.
        XCTAssertEqual(Copy.focusSettingsURL, "x-apple.systempreferences:com.apple.Focus-Settings.extension")
        // The gear menu has the same way there, for someone who closed first run without it.
        let panel = try String(contentsOf: app.appendingPathComponent("PanelView.swift"), encoding: .utf8)
        XCTAssertTrue(panel.contains("Button(Copy.focusMenu) { FocusSettings.open() }"))
    }
}

final class PermissionTests: XCTestCase {
    func testOnlyAFreshInstallIsAskedAndSettingsIsOfferedOnlyWhenNotificationsWereTurnedOff() {
        XCTAssertEqual(Permissions.step(.notAsked), .askSystem)
        XCTAssertEqual(Permissions.step(.allowed), .nothingToAsk)
        XCTAssertEqual(Permissions.step(.denied), .settingsOnly)
    }

    // The one path that opened System Settings by itself was the login item's, inside Turn on. Settings now opens only
    // from a button the person clicks.
    func testNothingOpensSystemSettingsWithoutAClick() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/CELLO").standardized
        let login = try String(contentsOf: app.appendingPathComponent("LoginItem.swift"), encoding: .utf8)
        let set = login.components(separatedBy: "static func set(").last ?? ""
        XCTAssertFalse(set.contains("openSystemSettings"), "turning the login item on must not open System Settings")
        let delegate = try String(contentsOf: app.appendingPathComponent("AppDelegate.swift"), encoding: .utf8)
        XCTAssertFalse(delegate.contains("openSettings()"), "the app opens Settings only from the panel's buttons")
        XCTAssertEqual(delegate.components(separatedBy: "requestPermission(").count - 1, 1, "the system prompt is asked for in one place")
        XCTAssertTrue(delegate.contains("case .askSystem: self?.banners.requestPermission(done)"))
    }
}

final class AddAgentTests: XCTestCase {
    // Every item in Settings is short enough to find at a glance. The long "Agents that can reach you here: …" wasn't.
    func testEverySettingsItemIsShort() {
        for line in [Copy.pauseHour, Copy.pauseMorning, Copy.resumeNow, Copy.openAtLogin, Copy.addOrRemoveAgents, Copy.quit, Copy.removeMenu] {
            XCTAssertLessThanOrEqual(line.count, 30, line)
        }
    }

    func testTheDoorsWordsForTheListAndForAdding() throws {
        XCTAssertEqual(Request.agents.object(ref: "r1") as NSDictionary, ["op": "agents", "ref": "r1"])
        XCTAssertEqual(Request.addAgent(agentID: "bb").object(ref: "r2") as NSDictionary, ["op": "add_agent", "ref": "r2", "agent": "bb"])
        XCTAssertEqual(FrameParser.others([["agent_id": "bb", "agent": "Bea", "locked": false], ["agent_id": "cc", "agent": "Cy", "locked": true]]), [LocalAgent(agentID: "bb", name: "Bea", locked: false), LocalAgent(agentID: "cc", name: "Cy", locked: true)])
    }

    // The door says Bea joined before it answers the add, so without this the person who just added her would be asked
    // "Not you?" about their own click.
    func testAnAgentThePersonAddsJoinsQuietlyAndOneAddedElsewhereStillSaysSo() {
        var s = live()
        s.addingStarted("bb")
        XCTAssertEqual(s.agentAdded(Agent(agentID: "bb", name: "Bea")), [])
        s.addingEnded("bb")
        XCTAssertEqual(s.agentAdded(Agent(agentID: "cc", name: "Cy")), [.joined(Agent(agentID: "cc", name: "Cy"))])
        XCTAssertEqual(s.agents.map(\.name), ["Ann", "Bea", "Cy"])
    }

    func testAddingThroughTheDoorJoinsQuietlyAndALockedAgentIsRefusedByName() {
        final class Effects: ControllerDelegate {
            var seen: [Effect] = []
            func stateChanged(_ controller: Controller) {}
            func perform(_ effect: Effect, controller: Controller) { seen.append(effect) }
            func needsStart(_ controller: Controller) {}
        }
        let door = FakeDoor()
        defer { door.close() }
        door.answer = { r in
            switch (r["op"] as? String, r["agent"] as? String) {
            case ("subscribe", _): return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "agents": [["agent_id": "aa", "agent": "Ann"]], "paused_until": NSNull()]
            case ("add_agent", "cc"): return ["op": "result", "ref": r["ref"] ?? "", "ok": false, "error": "notifiers_locked", "message": "The door's words, for the command line."]
            case ("add_agent", "dd"): return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "added": ["agent_id": "dd", "agent": "Dan"], "told_existing": [String](), "could_not_tell": ["telegram"]]
            case ("add_agent", "ee"): return ["op": "result", "ref": r["ref"] ?? "", "ok": false, "error": "notifier_exists", "message": "Eve already has a notifier named mac."]
            case ("add_agent", _): return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "added": ["agent_id": "bb", "agent": "Bea"]]
            default: return ["op": "result", "ref": r["ref"] ?? "", "ok": true]
            }
        }
        // As the real door does: agent_added is written before the add's own answer. Here it follows, which the app
        // must handle too, so the frame is checked after the answer as well.
        door.then = { r in r["op"] as? String == "add_agent" && r["agent"] as? String == "bb" ? [["op": "agent_added", "agent_id": "bb", "agent": "Bea"]] : [] }
        let effects = Effects()
        let c = Controller(socketPath: door.path, turnedOn: true)
        c.delegate = effects
        c.start()
        defer { c.stop() }
        XCTAssertTrue(waitUntil(3) { c.state.connection == .connected && !c.state.catchingUp })
        var answer: String?? = .none
        c.addAgent("cc", name: "Cy") { problem, _ in answer = .some(problem) }
        XCTAssertTrue(waitUntil { answer != nil })
        XCTAssertEqual(answer, .some(Copy.addLocked("Cy")))
        answer = .none
        c.addAgent("bb", name: "Bea") { problem, _ in answer = .some(problem) }
        XCTAssertTrue(waitUntil { answer != nil })
        XCTAssertEqual(answer, .some(nil))
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(c.state.agents.map(\.name), ["Ann", "Bea"])
        XCTAssertFalse(effects.seen.contains { if case .joined = $0 { return true } else { return false } }, "no Not you? banner for the agent just added")
        // Added, but a route it already had couldn't be told: said, never a clean success.
        var note: String?? = .none
        c.addAgent("dd", name: "Dan") { _, n in note = .some(n) }
        XCTAssertTrue(waitUntil { note != nil })
        XCTAssertEqual(note, .some(Copy.addedUntold("Dan")))
        // "Already exists" counts as done only when the agent really is on the Mac now.
        answer = .none
        c.addAgent("ee", name: "Eve") { problem, _ in answer = .some(problem) }
        XCTAssertTrue(waitUntil { answer != nil })
        XCTAssertEqual(answer, .some(Copy.addFailed("Eve")))
    }
}

final class LockedRemoveTests: XCTestCase {
    // The door refuses a locked agent; the person gets the app's own line, and the app isn't taken away.
    func testALockedRemoveSaysSoInTheAppsWords() {
        let door = FakeDoor()
        defer { door.close() }
        door.answer = { r in
            switch r["op"] as? String {
            case "subscribe": return ["op": "result", "ref": r["ref"] ?? "", "ok": true, "agents": [["agent_id": "aa", "agent": "Ann"]], "paused_until": NSNull()]
            case "remove", "remove_agent": return ["op": "result", "ref": r["ref"] ?? "", "ok": false, "error": "notifiers_locked", "message": "The door's words."]
            default: return ["op": "result", "ref": r["ref"] ?? "", "ok": true]
            }
        }
        let c = Controller(socketPath: door.path, turnedOn: true)
        c.start()
        defer { c.stop() }
        XCTAssertTrue(waitUntil(3) { c.state.connection == .connected && !c.state.catchingUp })
        var one: String?, all: String?
        c.removeAgent("aa") { one = $0 }
        c.remove { all = $0 }
        XCTAssertTrue(waitUntil { one != nil && all != nil })
        XCTAssertEqual([one, all], [Copy.removeAgentLocked("Ann"), Copy.removeLocked])
        XCTAssertEqual(c.state.agents.map(\.name), ["Ann"], "nothing removed")
    }
}
