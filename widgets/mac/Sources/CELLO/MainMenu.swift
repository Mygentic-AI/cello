// The main menu of a menu-bar app: never on screen, but it is where AppKit looks for ⌘V and the other editing keys.
import AppKit
import CELLOCore

enum MainMenu {
    static func make() -> NSMenu {
        let main = NSMenu()
        // The first item is always the app's own menu. It stays empty: Quit has its confirm in Settings.
        main.addItem(NSMenuItem())
        main.items[0].submenu = NSMenu(title: Copy.appName)
        let edit = NSMenu(title: EditMenu.title)
        for entry in EditMenu.items {
            guard let entry else {
                edit.addItem(.separator())
                continue
            }
            let item = NSMenuItem(title: entry.title, action: NSSelectorFromString(entry.action), keyEquivalent: entry.key)
            item.keyEquivalentModifierMask = entry.shift ? [.command, .shift] : [.command]
            // No target: the action goes to whatever has focus, the text box being typed in.
            edit.addItem(item)
        }
        let editItem = NSMenuItem(title: EditMenu.title, action: nil, keyEquivalent: "")
        editItem.submenu = edit
        main.addItem(editItem)
        return main
    }
}
