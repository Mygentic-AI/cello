// What a banner shows, decided here so the rule can be tested: up to two choices go on the banner as buttons, with Reply.
// Three or more get one Choose, which opens the panel, so nothing depends on how many buttons macOS shows.
import Foundation

public enum BannerButton: Equatable, Sendable {
    case choice(index: Int, label: String)
    case choose
    case reply

    public var identifier: String {
        switch self {
        case let .choice(index, _): return "choice.\(index)"
        case .choose: return "choose"
        case .reply: return "reply"
        }
    }

    public var title: String {
        switch self {
        case let .choice(_, label): return label
        case .choose: return Copy.choose
        case .reply: return Copy.reply
        }
    }
}

public struct BannerPlan: Equatable, Sendable {
    // The notification's id, or nil for a banner about the app itself.
    public let itemID: Int?
    public let title: String
    public let body: String
    public let buttons: [BannerButton]
    public let sound: Bool
    // For Reply: the agent the text box names.
    public let replyTo: String?

    // Banners with the same buttons share one category, so each distinct set of buttons is registered once.
    public var category: String {
        if buttons.isEmpty { return "plain" }
        // The Reply box names the agent, so that's part of the set too.
        let key = buttons.map { "\($0.identifier)=\($0.title)" }.joined(separator: "|") + "|to=\(replyTo ?? "")"
        var hash: UInt64 = 1469598103934665603
        for byte in key.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        return "b-" + String(hash, radix: 16)
    }

    public init(itemID: Int?, title: String, body: String, buttons: [BannerButton], sound: Bool, replyTo: String?) {
        self.itemID = itemID
        self.title = title
        self.body = body
        self.buttons = buttons
        self.sound = sound
        self.replyTo = replyTo
    }

    public static let maxBannerChoices = 2

    public static func forItem(_ item: Item) -> BannerPlan {
        switch item.kind {
        case .request:
            var buttons: [BannerButton]
            if item.choices.isEmpty {
                buttons = []
            } else if item.choices.count <= maxBannerChoices {
                buttons = item.choices.enumerated().map { BannerButton.choice(index: $0.offset, label: $0.element) }
            } else {
                buttons = [.choose]
            }
            buttons.append(.reply)
            // Only a decision makes a sound.
            return BannerPlan(itemID: item.id, title: Copy.requestTitle(item.agent), body: item.text, buttons: buttons, sound: true, replyTo: item.agent)
        case .message:
            return BannerPlan(itemID: item.id, title: Copy.messageTitle(item.agent), body: item.text, buttons: [.reply], sound: false, replyTo: item.agent)
        case .test:
            return BannerPlan(itemID: item.id, title: Copy.testTitle(item.agent), body: item.text, buttons: [], sound: false, replyTo: nil)
        }
    }
}

// One banner for everything that waited while the Mac was away: how many, with one sound if any was a question.
public struct SummaryPlan: Equatable, Sendable {
    public let itemIDs: [Int]
    public let title: String
    public let body: String
    public let sound: Bool

    public init(itemIDs: [Int], title: String, body: String, sound: Bool) {
        self.itemIDs = itemIDs
        self.title = title
        self.body = body
        self.sound = sound
    }
}
