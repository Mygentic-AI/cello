// The reply box and the message box: a few lines tall, growing as the person types. Return sends, Shift-Return (or
// Option-Return) starts a new line, and a Return that finishes typing in an input method, such as Japanese, only does that.
import Foundation

public enum ReturnAction: Equatable, Sendable {
    case send
    case newLine
    // The input method is still composing: Return belongs to it.
    case leave
}

public enum TextArea {
    public static let minLines = 3
    // Past this it scrolls inside, so a long answer never pushes the panel off the screen.
    public static let maxLines = 8

    public static func onReturn(shift: Bool, option: Bool, composing: Bool) -> ReturnAction {
        if composing { return .leave }
        return shift || option ? .newLine : .send
    }

    // The box's height for what's in it: three lines empty, growing a line at a time, eight at most.
    public static func height(contentHeight: Double, lineHeight: Double, inset: Double) -> Double {
        let lo = lineHeight * Double(minLines)
        let hi = lineHeight * Double(maxLines)
        return min(max(contentHeight, lo), hi) + inset * 2
    }
}
