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
    public private(set) var watching = false
    public var close: () -> Void = {}

    // start installs the app's mouse watchers, which report each click with click(_:). stop removes them.
    public init(start: @escaping () -> Void, stop: @escaping () -> Void) {
        self.start = start
        self.stop = stop
    }

    public func panelShown() {
        guard !watching else { return }
        watching = true
        start()
    }

    public func panelClosed() {
        guard watching else { return }
        watching = false
        stop()
    }

    public func click(_ place: ClickPlace) {
        guard watching, place == .elsewhere else { return }
        close()
    }

    // Another app came to the front, by a click or by the keyboard.
    public func appDeactivated() {
        guard watching else { return }
        close()
    }
}
