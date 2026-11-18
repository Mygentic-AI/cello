// "Open CELLO when I log in", through macOS's own Login Items, where it shows as CELLO.
import Foundation
import ServiceManagement

enum LoginItem {
    static var isOn: Bool { SMAppService.mainApp.status == .enabled }

    // Turned on, but macOS wants the person's OK first, as after they once turned it off in System Settings.
    static var needsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }

    static func openSettings() { SMAppService.openSystemSettingsLoginItems() }

    // Answers nil, or why it couldn't be changed. Never opens System Settings by itself: if macOS wants an OK, the panel
    // says so and offers the button (needsApproval).
    @discardableResult
    static func set(_ on: Bool) -> String? {
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
