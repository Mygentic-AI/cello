// The CELLO app: a menu-bar mark, native banners and a panel, for when the person's agents need them.
import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// A menu-bar app: no Dock icon, and no menu bar on screen. Info.plist says so too, with LSUIElement.
app.setActivationPolicy(.accessory)
// Not shown, but it carries ⌘V, ⌘C, ⌘X, ⌘A and ⌘Z to every text box, and lets dictation paste.
app.mainMenu = MainMenu.make()
app.run()
