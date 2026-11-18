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
    private let now: () -> TimeInterval
    // The press count and time when a banner opened the panel; nil once the hold has ended, or for any other open.
    private var held: (presses: UInt64, at: TimeInterval)?
    public private(set) var watching = false
    public var close: () -> Void = {}

    // The hand-back comes about 60 ms after the banner click. Past this, the hold ends even if no press is ever
    // counted, so a press count that stops moving can't leave the panel stuck open.
    public static let holdLimit: TimeInterval = 2

    // start installs the app's mouse watchers, which report each click with click(_:). stop removes them.
    // presses counts every key and mouse button pressed on this Mac so far, in any app. now is a monotonic clock.
    public init(start: @escaping () -> Void, stop: @escaping () -> Void, presses: @escaping () -> UInt64, now: @escaping () -> TimeInterval) {
        self.start = start
        self.stop = stop
        self.presses = presses
        self.now = now
    }

    // A banner click brings the app forward, then macOS hands the front straight back to the app that had it, with no
    // key or click from the person. That isn't the person leaving. Called before the panel opens.
    public func openingFromBanner() {
        held = (presses(), now())
    }

    // Whether the panel may close now. One opened from a banner stays until a key or click comes after it opened, or
    // until holdLimit has passed.
    public func mayClose() -> Bool {
        guard let hold = held else { return true }
        guard presses() == hold.presses, now() - hold.at < Self.holdLimit else {
            held = nil
            return true
        }
        return false
    }

    public func panelShown() {
        guard !watching else { return }
        watching = true
        start()
    }

    public func panelClosed() {
        held = nil
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
