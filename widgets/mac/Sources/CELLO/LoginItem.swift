// "Open CELLO when I log in", through macOS's own Login Items, where it shows as CELLO.
import Foundation
import ServiceManagement

enum LoginItem {
    static var isOn: Bool { SMAppService.mainApp.status == .enabled }

    // Answers nil, or why it couldn't be changed. macOS may ask the person to approve it in System Settings.
    @discardableResult
    static func set(_ on: Bool) -> String? {
        do {
            if on {
                try SMAppService.mainApp.register()
                if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            } else {
                try SMAppService.mainApp.unregister()
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
