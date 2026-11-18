// The first time CELLO opens: what it will do, before macOS asks about notifications, and one click to turn it on.
import AppKit
import CELLOCore
import SwiftUI

final class FirstRunModel: ObservableObject {
    @Published var agents: [String] = []
    @Published var openAtLogin = true
    var onTurnOn: (_ openAtLogin: Bool) -> Void = { _ in }
}

private let pink = Color(red: 0xDB / 255, green: 0x27 / 255, blue: 0x77 / 255)

struct FirstRunView: View {
    @ObservedObject var model: FirstRunModel

    var body: some View {
        VStack(spacing: 14) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 64, height: 64)
            Text(Copy.firstRunTitle).font(.system(size: 20, weight: .bold)).multilineTextAlignment(.center)
            Text(Copy.firstRunBody(model.agents)).font(.system(size: 13)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            Text(Copy.firstRunNext).font(.system(size: 13)).foregroundColor(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            // A Focus holds every app's notifications back unless the person lets that app through. No app can add
            // itself, so this opens the place to do it.
            VStack(spacing: 6) {
                Text(Copy.focusTitle).font(.system(size: 13, weight: .semibold))
                Text(Copy.focusBody).font(.system(size: 12)).foregroundColor(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                Button(Copy.focusOpen) { FocusSettings.open() }
            }
            .padding(12)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 9).fill(Color(nsColor: .controlBackgroundColor)))
            Toggle(Copy.openAtLogin, isOn: $model.openAtLogin).toggleStyle(.checkbox)
            Button { model.onTurnOn(model.openAtLogin) } label: {
                Text(Copy.turnOn).font(.system(size: 14, weight: .semibold)).foregroundColor(.white).frame(maxWidth: .infinity).frame(height: 36)
                    .background(RoundedRectangle(cornerRadius: 9).fill(pink))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
        }
        .padding(28)
        .frame(width: 400)
    }
}

final class FirstRunWindow {
    private var window: NSWindow?

    func show(_ model: FirstRunModel) {
        let hosting = NSHostingController(rootView: FirstRunView(model: model))
        let window = NSWindow(contentViewController: hosting)
        window.title = Copy.appName
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        window.center()
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func close() {
        window?.close()
        window = nil
    }

    var isShown: Bool { window?.isVisible ?? false }
}

// System Settings › Focus. It lands on the list of Focuses, not inside one: macOS has no link to a Focus's allowed apps,
// and no way for an app to add itself there.
enum FocusSettings {
    static func open() {
        guard let url = URL(string: Copy.focusSettingsURL) else { return }
        NSWorkspace.shared.open(url)
    }
}
