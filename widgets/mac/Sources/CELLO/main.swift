// The CELLO app: a menu-bar mark, native banners and a panel, for when the person's agents need them.
import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// A menu-bar app: no Dock icon, no menu bar of its own. Info.plist says so too, with LSUIElement.
app.setActivationPolicy(.accessory)
app.run()
