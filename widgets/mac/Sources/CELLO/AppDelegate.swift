// Wires the pieces: the menu-bar mark, the panel, banners, the first-run window, and the Controller that talks to CELLO.
import AppKit
import CELLOCore
import os
import SwiftUI

private let log = Logger(subsystem: "com.celloprotocol.cello", category: "app")
private let turnedOnKey = "turnedOn"
private let markClock: DateFormatter = {
    let f = DateFormatter()
    f.timeStyle = .short
    f.dateStyle = .none
    return f
}()

final class AppDelegate: NSObject, NSApplicationDelegate, ControllerDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var controller: Controller!
    private var panel: PanelModel!
    private let banners = Banners()
    private let firstRun = FirstRunWindow()
    private let firstRunModel = FirstRunModel()
    private var launch = LaunchInfo(celloHome: (NSHomeDirectory() as NSString).appendingPathComponent(".cello"), start: nil)
    private var ticker: Timer?
    private var clickAway: ClickAway!
    private var mouseWatchers: [Any] = []
    // The look last put on the mark. The mark is only touched when it changes: resizing the item the panel hangs from,
    // on every redraw, is the likeliest reason the panel stopped closing on an outside click.
    private var shownLook: MarkLook?

    func applicationDidFinishLaunching(_ notification: Notification) {
        var unreadable = false
        do {
            launch = try LaunchInfo.load(from: LaunchInfo.defaultURL())
        } catch {
            log.error("launch.json unreadable: \(String(describing: error), privacy: .public)")
            unreadable = true
        }
        let turnedOn = UserDefaults.standard.bool(forKey: turnedOnKey)
        controller = Controller(socketPath: launch.socketPath, turnedOn: turnedOn)
        controller.delegate = self
        panel = PanelModel(controller: controller)
        panel.onQuit = { [weak self] in self?.confirmQuit() }
        panel.onRemove = { [weak self] in self?.confirmRemove() }
        panel.onRemoveAgent = { [weak self] agent in self?.confirmRemoveAgent(agent) }
        panel.onRetry = { [weak self] in self?.controller.retryStart() }
        panel.onProblem = { [weak self] line in self?.say(line) }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        MenuBarIcon.apply(MarkLook(look: .plain, word: nil, tooltip: nil), to: statusItem.button!)

        popover.behavior = .transient
        popover.delegate = self
        let hosting = NSHostingController(rootView: PanelView(model: panel))
        // The panel follows its content's size, so it grows with what's waiting and with a long reply.
        hosting.sizingOptions = [.preferredContentSize]
        popover.contentViewController = hosting
        clickAway = ClickAway(start: { [weak self] in self?.watchMouse() }, stop: { [weak self] in self?.unwatchMouse() })
        clickAway.close = { [weak self] in self?.popover.performClose(nil) }
        NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.clickAway.appDeactivated()
        }

        banners.onOpenPanel = { [weak self] in self?.showPanel() }
        banners.onPick = { [weak self] id, choice in self?.pickFromBanner(id, choice) }
        banners.onReply = { [weak self] id, text in self?.replyFromBanner(id, text) }

        if unreadable {
            controller.markUnreachable(.unknownInstall)
        } else {
            controller.start()
        }
        if !turnedOn { showFirstRun() }
    }

    // MARK: ControllerDelegate

    func stateChanged(_ controller: Controller) {
        let look = controller.state.mark(at: Date(), time: { markClock.string(from: $0) })
        if let button = statusItem.button, look != shownLook {
            shownLook = look
            MenuBarIcon.apply(look, to: button)
        }
        firstRunModel.agents = controller.state.agents.map(\.name)
        panel.refresh()
    }

    func perform(_ effect: Effect, controller: Controller) {
        switch effect {
        case let .banner(plan):
            banners.post(plan) { [weak controller] shown in
                if shown, let id = plan.itemID { controller?.shown([id]) }
            }
        case let .summary(summary):
            banners.post(summary) { [weak controller] shown in if shown { controller?.shown(summary.itemIDs) } }
        case let .withdraw(itemID):
            banners.withdraw(itemID)
        case let .joined(agent):
            banners.postQuiet(title: Copy.joinedTitle(agent.name), body: Copy.joinedBody(agent.name))
        case .ack:
            break
        }
    }

    func needsStart(_ controller: Controller) {
        let info = launch
        log.info("CELLO isn't running here; starting it")
        DispatchQueue.global(qos: .userInitiated).async {
            let result = CelloStarter.start(info)
            if case let .failure(error) = result { log.error("starting CELLO failed: \(String(describing: error), privacy: .public)") }
            DispatchQueue.main.async { controller.startFinished(result) }
        }
    }

    // MARK: Panel

    @objc private func togglePanel() {
        if popover.isShown { popover.performClose(nil) } else { showPanel() }
    }

    private func showPanel() {
        guard let button = statusItem.button else { return }
        // The screen the mark is on, which is where the panel opens, not whichever screen has the focus.
        if let screen = button.window?.screen ?? NSScreen.main { panel.screenHeight = Double(screen.visibleFrame.height) }
        NSApp.activate(ignoringOtherApps: true)
        if !popover.isShown { popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
    }

    // Clicks in other apps, on the desktop or in another of this app's windows close the panel. Mouse clicks elsewhere
    // need no Accessibility permission to watch; only keys would.
    private func watchMouse() {
        let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: clicks, handler: { [weak self] _ in self?.clickAway.click(.elsewhere) }) {
            mouseWatchers.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: clicks, handler: { [weak self] event in
            self?.clickAway.click(self?.place(of: event) ?? .insidePanel)
            return event
        }) {
            mouseWatchers.append(local)
        }
    }

    private func unwatchMouse() {
        for watcher in mouseWatchers { NSEvent.removeMonitor(watcher) }
        mouseWatchers = []
    }

    // Within this app, only a click in one of its own titled windows, such as first run, counts as outside. A menu
    // opened from the panel, like Settings, has no title bar and is part of it.
    private func place(of event: NSEvent) -> ClickPlace {
        guard let window = event.window else { return .insidePanel }
        if window === statusItem.button?.window { return .onMark }
        if window === popover.contentViewController?.view.window { return .insidePanel }
        return window.styleMask.contains(.titled) ? .elsewhere : .insidePanel
    }

    func popoverDidShow(_ notification: Notification) {
        clickAway.panelShown()
        controller.panelOpened()
        // Ages tick over while it's open.
        ticker = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.panel.refresh() }
    }

    func popoverDidClose(_ notification: Notification) {
        clickAway.panelClosed()
        ticker?.invalidate()
        ticker = nil
    }

    // MARK: Banner answers

    private func pickFromBanner(_ itemID: Int, _ choice: Int) {
        let agent = controller.state.item(itemID)?.agent ?? Copy.appName
        controller.pick(itemID, choice: choice) { [weak self] problem in
            if let problem { self?.banners.postQuiet(title: agent, body: problem) }
        }
    }

    private func replyFromBanner(_ itemID: Int, _ text: String) {
        let agent = controller.state.item(itemID)?.agent ?? Copy.appName
        controller.reply(itemID, text: text) { [weak self] problem in
            guard let self, let problem else { return }
            // The words aren't lost: they wait in the card's box, to send again from the panel.
            self.panel.drafts[itemID] = text
            self.banners.postQuiet(title: agent, body: problem)
        }
    }

    private func say(_ line: String) {
        banners.postQuiet(title: Copy.appName, body: line)
    }

    // MARK: First run

    private func showFirstRun() {
        firstRunModel.agents = controller.state.agents.map(\.name)
        firstRunModel.onTurnOn = { [weak self] openAtLogin in self?.turnOn(openAtLogin: openAtLogin) }
        firstRun.show(firstRunModel)
    }

    private func turnOn(openAtLogin: Bool) {
        banners.requestPermission { [weak self] granted in
            guard let self else { return }
            log.info("notifications allowed: \(granted, privacy: .public)")
            if openAtLogin, let problem = LoginItem.set(true) { log.error("login item: \(problem, privacy: .public)") }
            UserDefaults.standard.set(true, forKey: turnedOnKey)
            self.firstRun.close()
            if granted {
                self.banners.postQuiet(title: Copy.allSetTitle, body: Copy.allSetBody(self.controller.state.agents.map(\.name)), sound: true)
            }
            self.controller.turnOn()
            self.panel.refresh()
        }
    }

    // MARK: Quit and remove

    private func alert(title: String, body: String, confirm: String) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.icon = NSApp.applicationIconImage
        alert.addButton(withTitle: confirm)
        alert.addButton(withTitle: Copy.cancel)
        return alert
    }

    private func confirmQuit() {
        popover.performClose(nil)
        NSApp.activate(ignoringOtherApps: true)
        if alert(title: Copy.quitTitle, body: Copy.quitBody, confirm: Copy.quit).runModal() == .alertFirstButtonReturn {
            NSApp.terminate(nil)
        }
    }

    private func confirmRemove() {
        popover.performClose(nil)
        NSApp.activate(ignoringOtherApps: true)
        let confirm = alert(title: Copy.removeTitle, body: Copy.removeBody(controller.state.agents.map(\.name)), confirm: Copy.remove)
        confirm.buttons.first?.hasDestructiveAction = true
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        controller.remove { [weak self] problem in
            guard let self else { return }
            if let problem {
                self.say(problem)
                return
            }
            self.removeFromThisMac()
        }
    }

    // One agent off this Mac. The app stays, for every other agent.
    private func confirmRemoveAgent(_ agent: Agent) {
        popover.performClose(nil)
        NSApp.activate(ignoringOtherApps: true)
        let confirm = alert(title: Copy.removeAgentTitle(agent.name), body: Copy.removeAgentBody(agent.name), confirm: Copy.remove)
        confirm.buttons.first?.hasDestructiveAction = true
        guard confirm.runModal() == .alertFirstButtonReturn else { return }
        controller.removeAgent(agent.agentID) { [weak self] problem in
            if let problem { self?.say(problem) }
        }
    }

    // The agents are off already. What's left is this app's own: its login item, its settings, its launch file, itself.
    private func removeFromThisMac() {
        LoginItem.set(false)
        UserDefaults.standard.removeObject(forKey: turnedOnKey)
        try? FileManager.default.removeItem(at: LaunchInfo.defaultURL().deletingLastPathComponent())
        NSWorkspace.shared.recycle([Bundle.main.bundleURL]) { _, error in
            if let error { log.error("moving CELLO to the Trash failed: \(error.localizedDescription, privacy: .public)") }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}
