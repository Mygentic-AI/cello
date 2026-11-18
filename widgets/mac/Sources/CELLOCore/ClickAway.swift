// The panel closes on any click outside it, whatever was clicked inside it before and whatever the menu-bar mark looks
// like. It's the app's own watch, started each time the panel opens and stopped when it closes, and doesn't rest on
// macOS's transient popover, which the owner found stops closing after a button inside the panel was clicked.
import Foundation

public enum ClickPlace: Equatable, Sendable {
    case insidePanel
    // The menu-bar mark: its own click opens or closes the panel, so the watch leaves it alone.
    case onMark
    case elsewhere
}

public final class ClickAway {
    private let start: () -> Void
    private let stop: () -> Void
    private let presses: () -> UInt64
    // The press count when a banner opened the panel; nil once anything's been pressed since, or for any other open.
    private var heldAt: UInt64?
    public private(set) var watching = false
    public var close: () -> Void = {}

    // start installs the app's mouse watchers, which report each click with click(_:). stop removes them.
    // presses counts every key and mouse button pressed on this Mac so far, in any app.
    public init(start: @escaping () -> Void, stop: @escaping () -> Void, presses: @escaping () -> UInt64) {
        self.start = start
        self.stop = stop
        self.presses = presses
    }

    // A banner click brings the app forward, then macOS hands the front straight back to the app that had it, with no
    // key or click from the person. Taken as leaving, that closed the panel as it opened. Called before it opens.
    public func openingFromBanner() {
        heldAt = presses()
    }

    // Whether the panel may close now. One opened from a banner stays until a key or click comes after it opened.
    public func mayClose() -> Bool {
        guard let held = heldAt else { return true }
        guard presses() != held else { return false }
        heldAt = nil
        return true
    }

    public func panelShown() {
        guard !watching else { return }
        watching = true
        start()
    }

    public func panelClosed() {
        heldAt = nil
        guard watching else { return }
        watching = false
        stop()
    }

    public func click(_ place: ClickPlace) {
        guard watching, place == .elsewhere else { return }
        close()
    }

    // Another app came to the front, by a click, by the keyboard, or by macOS after a banner click.
    public func appDeactivated() {
        guard watching, mayClose() else { return }
        close()
    }
}
