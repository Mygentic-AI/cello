// How tall the panel is. It grows to show everything waiting, the top question with all its choices included, and only
// scrolls once the whole panel would pass two-thirds of the screen it opens on.
import Foundation

public enum PanelSize {
    public static let screenShare = 2.0 / 3.0
    // On a screen too small for even that, the list still gets this much.
    public static let smallestList = 120.0

    // content: the list's own height. chrome: the header and the message box, which never scroll.
    public static func listHeight(content: Double, chrome: Double, screen: Double) -> Double {
        let room = max(smallestList, screen * screenShare - chrome)
        return min(content, room)
    }
}

// The panel's spacing, read by the view so a test can add up what a question takes. Text heights are the system font's
// line heights at each size, measured, not set: they're here only for that sum.
public enum PanelLayout {
    public static let choiceHeight = 28.0
    public static let choiceGap = 4.0
    public static let cardPadding = 12.0
    public static let cardSpacing = 8.0
    public static let listPadding = 12.0
    public static let listSpacing = 10.0
    public static let headerPadding = 12.0
    public static let headerIcon = 24.0
    public static let composerPadding = 8.0
    // A reply box under choices starts smaller: the choices are the main way to answer. It still grows as he types.
    public static let replyLinesUnderChoices = 2

    public static let line12 = 15.0
    public static let line13 = 16.0
    public static let line14 = 17.0

    public static var header: Double { headerPadding * 2 + headerIcon }
    // "Message an agent…", one line until clicked.
    public static var closedComposer: Double { composerPadding * 2 + line13 + 4 }
    // The header, the closed composer, and the two dividers between them and the list.
    public static var chrome: Double { header + closedComposer + 2 }

    public static func choices(_ count: Int) -> Double {
        count == 0 ? 0 : Double(count) * choiceHeight + Double(count - 1) * choiceGap
    }

    // One question card: title, who it's talking to, the question, its choices and the reply box under them.
    public static func questionCard(choices count: Int, questionLines: Int, talkingTo: Bool) -> Double {
        let reply = line12 + 4 + TextArea.height(contentHeight: 0, lineHeight: line13, inset: 5, minLines: count == 0 ? TextArea.minLines : replyLinesUnderChoices)
        var parts = [line14, Double(questionLines) * line13, reply]
        if talkingTo { parts.append(line12) }
        if count > 0 { parts.append(choices(count)) }
        return cardPadding * 2 + parts.reduce(0, +) + cardSpacing * Double(parts.count - 1)
    }

    // The whole panel with one question waiting and the composer closed.
    public static func oneQuestion(choices count: Int, questionLines: Int, talkingTo: Bool) -> Double {
        let list = listPadding * 2 + line12 + listSpacing + questionCard(choices: count, questionLines: questionLines, talkingTo: talkingTo)
        return chrome + list
    }
}
