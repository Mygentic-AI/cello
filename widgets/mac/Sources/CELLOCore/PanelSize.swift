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
