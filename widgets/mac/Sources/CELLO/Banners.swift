// Native banners, through macOS's notification centre. What each one shows is decided in CELLOCore (BannerPlan); this
// posts it, says when it's really on screen, and turns a button or a typed reply back into a pick or a reply.
import AppKit
import CELLOCore
import UserNotifications

final class Banners: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private var categories: [String: UNNotificationCategory] = [:]
    var onOpenPanel: () -> Void = {}
    var onPick: (_ itemID: Int, _ choice: Int) -> Void = { _, _ in }
    var onReply: (_ itemID: Int, _ text: String) -> Void = { _, _ in }

    static let summaryCategory = "summary"
    static let openAction = "open"

    override init() {
        super.init()
        center.delegate = self
        register(UNNotificationCategory(identifier: Self.summaryCategory, actions: [UNNotificationAction(identifier: Self.openAction, title: Copy.openCello, options: [.foreground])], intentIdentifiers: []))
    }

    // Where notifications stand, without asking. Only notAsked gets the system prompt; once denied, macOS never shows
    // it again and System Settings is the only way back.
    func permission(_ done: @escaping (NotificationPermission) -> Void) {
        center.getNotificationSettings { settings in
            let permission: NotificationPermission
            switch settings.authorizationStatus {
            case .notDetermined: permission = .notAsked
            case .denied: permission = .denied
            default: permission = .allowed
            }
            DispatchQueue.main.async { done(permission) }
        }
    }

    static func openSettings() {
        guard let url = URL(string: Copy.notificationSettingsURL) else { return }
        NSWorkspace.shared.open(url)
    }

    func requestPermission(_ done: @escaping (Bool) -> Void) {
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async { done(granted) }
        }
    }

    // Banners can show: allowed, and set to banners or alerts. Otherwise the panel is the only place, and nothing is
    // reported as on screen until the panel is opened.
    private func canShow(_ done: @escaping (Bool) -> Void) {
        center.getNotificationSettings { settings in
            let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            DispatchQueue.main.async { done(allowed && settings.alertStyle != .none) }
        }
    }

    private func register(_ category: UNNotificationCategory) {
        guard categories[category.identifier] == nil else { return }
        categories[category.identifier] = category
        center.setNotificationCategories(Set(categories.values))
    }

    private func category(for plan: BannerPlan) -> String {
        let actions: [UNNotificationAction] = plan.buttons.map { button in
            switch button {
            case .choice:
                return UNNotificationAction(identifier: button.identifier, title: button.title, options: [])
            case .choose:
                return UNNotificationAction(identifier: button.identifier, title: button.title, options: [.foreground])
            case .reply:
                return UNTextInputNotificationAction(identifier: button.identifier, title: button.title, options: [], textInputButtonTitle: Copy.send, textInputPlaceholder: Copy.typeTo(plan.replyTo ?? Copy.appName))
            }
        }
        register(UNNotificationCategory(identifier: plan.category, actions: actions, intentIdentifiers: []))
        return plan.category
    }

    static func identifier(_ itemID: Int) -> String { "item-\(itemID)" }

    // A question comes through a Focus that lets CELLO through. News is passive: it never breaks through a Focus, even
    // one that lets CELLO through, and waits in Notification Center and the panel.
    static func level(_ breaksThrough: Bool) -> UNNotificationInterruptionLevel { breaksThrough ? .active : .passive }

    // shown: called with true once macOS has it and banners are allowed.
    func post(_ plan: BannerPlan, shown: @escaping (Bool) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = plan.title
        content.body = plan.body
        content.sound = plan.sound ? .default : nil
        content.interruptionLevel = Self.level(plan.breaksThrough)
        content.categoryIdentifier = category(for: plan)
        if let id = plan.itemID { content.userInfo = ["item": id] }
        let identifier = plan.itemID.map(Self.identifier) ?? UUID().uuidString
        add(identifier, content, shown)
    }

    func post(_ summary: SummaryPlan, shown: @escaping (Bool) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = summary.title
        content.body = summary.body
        content.sound = summary.sound ? .default : nil
        content.interruptionLevel = Self.level(summary.breaksThrough)
        content.categoryIdentifier = Self.summaryCategory
        add("summary-\(UUID().uuidString)", content, shown)
    }

    // A banner about the app itself, with no sound: an agent joined, an answer didn't go, the first hello.
    // breaksThrough: false for news about the app, such as an agent joining, which waits through a Focus like any news.
    func postQuiet(title: String, body: String, sound: Bool = false, breaksThrough: Bool = true) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = sound ? .default : nil
        content.interruptionLevel = Self.level(breaksThrough)
        add(UUID().uuidString, content) { _ in }
    }

    private func add(_ identifier: String, _ content: UNMutableNotificationContent, _ shown: @escaping (Bool) -> Void) {
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) { [weak self] error in
            guard error == nil, let self else {
                DispatchQueue.main.async { shown(false) }
                return
            }
            self.canShow(shown)
        }
    }

    func withdraw(_ itemID: Int) {
        center.removeDeliveredNotifications(withIdentifiers: [Self.identifier(itemID)])
        center.removePendingNotificationRequests(withIdentifiers: [Self.identifier(itemID)])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let itemID = response.notification.request.content.userInfo["item"] as? Int
        let action = response.actionIdentifier
        let typed = (response as? UNTextInputNotificationResponse)?.userText
        DispatchQueue.main.async { [self] in
            if let itemID, action.hasPrefix("choice."), let index = Int(action.dropFirst("choice.".count)) {
                onPick(itemID, index)
            } else if let itemID, action == "reply", let typed {
                onReply(itemID, typed)
            } else if action != UNNotificationDismissActionIdentifier {
                // The banner itself, Choose, or Open CELLO.
                onOpenPanel()
            }
            completionHandler()
        }
    }
}
