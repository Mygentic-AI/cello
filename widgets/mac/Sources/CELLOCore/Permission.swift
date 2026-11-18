// Where notification permission stands, and what Turn on does about it. A fresh install gets macOS's own prompt and
// nothing else; System Settings is only ever offered when the person turned notifications off before, since macOS then
// never asks again.
import Foundation

public enum NotificationPermission: Equatable, Sendable {
    case notAsked
    case denied
    case allowed
}

public enum PermissionStep: Equatable, Sendable {
    case askSystem
    case nothingToAsk
    case settingsOnly
}

public enum Permissions {
    public static func step(_ permission: NotificationPermission) -> PermissionStep {
        switch permission {
        case .notAsked: return .askSystem
        case .allowed: return .nothingToAsk
        case .denied: return .settingsOnly
        }
    }
}
