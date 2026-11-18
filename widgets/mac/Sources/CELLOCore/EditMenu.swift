// A menu-bar app has no menu bar of its own, so ⌘V, ⌘C and the rest have nothing to go through and every text box
// ignores them, dictation too, since it pastes. The app installs this Edit menu as its main menu: never shown, it still
// carries the keys to whichever text box has focus. A menu titled Edit also gets macOS's own Start Dictation item.
import Foundation

public struct EditMenuItem: Equatable, Sendable {
    public let title: String
    // The standard responder action, as AppKit names it. The text box with focus answers it.
    public let action: String
    public let key: String
    public let shift: Bool

    public init(_ title: String, _ action: String, _ key: String, shift: Bool = false) {
        self.title = title
        self.action = action
        self.key = key
        self.shift = shift
    }
}

public enum EditMenu {
    public static let title = "Edit"
    // nil is a separator.
    public static let items: [EditMenuItem?] = [
        EditMenuItem("Undo", "undo:", "z"),
        EditMenuItem("Redo", "redo:", "z", shift: true),
        nil,
        EditMenuItem("Cut", "cut:", "x"),
        EditMenuItem("Copy", "copy:", "c"),
        EditMenuItem("Paste", "paste:", "v"),
        EditMenuItem("Select All", "selectAll:", "a"),
    ]
}
