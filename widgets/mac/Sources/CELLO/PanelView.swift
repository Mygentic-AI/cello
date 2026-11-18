// The CELLO panel: everything waiting, what was answered today, and a box to message any agent.
import AppKit
import CELLOCore
import SwiftUI

final class PanelModel: ObservableObject {
    let controller: Controller
    @Published var revision = 0
    @Published var drafts: [Int: String] = [:]
    @Published var problems: [Int: String] = [:]
    @Published var messageText = ""
    @Published var messageAgent = ""
    @Published var messageLine: String?
    @Published var loginItemOn = LoginItem.isOn
    var onQuit: () -> Void = {}
    var onRemove: () -> Void = {}
    var onRetry: () -> Void = {}
    var onProblem: (String) -> Void = { _ in }

    init(controller: Controller) {
        self.controller = controller
    }

    var state: AppState { controller.state }

    func refresh() {
        loginItemOn = LoginItem.isOn
        if !state.agents.contains(where: { $0.agentID == messageAgent }) { messageAgent = state.agents.first?.agentID ?? "" }
        revision += 1
    }

    func pick(_ item: Item, _ choice: Int) {
        problems[item.id] = nil
        controller.pick(item.id, choice: choice) { [weak self] problem in self?.problems[item.id] = problem }
    }

    func reply(_ item: Item) {
        let text = drafts[item.id] ?? ""
        problems[item.id] = nil
        controller.reply(item.id, text: text) { [weak self] problem in
            guard let self else { return }
            if let problem { self.problems[item.id] = problem } else { self.drafts[item.id] = nil }
        }
    }

    func sendMessage() {
        let text = messageText
        controller.message(messageAgent, text: text) { [weak self] ok, line in
            guard let self else { return }
            self.messageLine = line
            if ok { self.messageText = "" }
        }
    }

    func pause(until: Date) {
        controller.pause(until: until) { [weak self] problem in if let problem { self?.onProblem(problem) } }
    }

    func resume() {
        controller.resume { [weak self] problem in if let problem { self?.onProblem(problem) } }
    }

    func setLoginItem(_ on: Bool) {
        if let problem = LoginItem.set(on) { onProblem(problem) }
        loginItemOn = LoginItem.isOn
    }
}

private let pink = Color(red: 0xDB / 255, green: 0x27 / 255, blue: 0x77 / 255)
private let muted = Color(red: 0x6E / 255, green: 0x6E / 255, blue: 0x73 / 255)

private let clock: DateFormatter = {
    let f = DateFormatter()
    f.timeStyle = .short
    f.dateStyle = .none
    return f
}()

struct PanelView: View {
    @ObservedObject var model: PanelModel

    var body: some View {
        let now = Date()
        let state = model.state
        VStack(alignment: .leading, spacing: 0) {
            header(state, now: now)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if case let .unreachable(why) = state.connection { unreachable(why) }
                    if state.waiting.isEmpty {
                        Text(Copy.nothingWaiting).font(.system(size: 13)).foregroundColor(muted)
                    } else {
                        Text(Copy.waitingHeader(state.waiting.count)).font(.system(size: 12, weight: .semibold)).foregroundColor(muted)
                        ForEach(state.waiting.reversed()) { item in card(item, now: now) }
                    }
                    let earlier = state.earlierToday(now: now)
                    if !earlier.isEmpty {
                        Text(Copy.earlierToday).font(.system(size: 12, weight: .semibold)).foregroundColor(muted).padding(.top, 4)
                        ForEach(Array(earlier.enumerated()), id: \.offset) { _, line in
                            Text(Copy.earlierLine(agent: line.agent, what: line.what, time: clock.string(from: line.at))).font(.system(size: 13))
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 520)
            Divider()
            messageBox(state)
        }
        .frame(width: 392)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func header(_ state: AppState, now: Date) -> some View {
        HStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 24, height: 24).clipShape(RoundedRectangle(cornerRadius: 6))
            Text(Copy.appName).font(.system(size: 15, weight: .bold))
            Spacer()
            settings(state, now: now)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func settings(_ state: AppState, now: Date) -> some View {
        Menu {
            if state.isPaused(at: now), let until = state.pausedUntil {
                Text(Copy.pausedUntil(clock.string(from: until)))
                Button(Copy.resumeNow) { model.resume() }
            } else {
                Button(Copy.pauseHour) { model.pause(until: PauseTimes.anHour(from: Date())) }
                Button(Copy.pauseMorning) { model.pause(until: PauseTimes.tomorrowMorning(from: Date())) }
            }
            Divider()
            Toggle(Copy.openAtLogin, isOn: Binding(get: { model.loginItemOn }, set: { model.setLoginItem($0) }))
            Menu(Copy.agentsHere(state.agents.map(\.name))) {
                ForEach(state.agents, id: \.agentID) { agent in Text(agent.name) }
            }
            Divider()
            Button(Copy.quit) { model.onQuit() }
            Button(Copy.removeMenu) { model.onRemove() }
        } label: {
            Image(systemName: "gearshape").font(.system(size: 15))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel(Copy.settings)
    }

    private func unreachable(_ why: Unreachable) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Copy.unreachableTitle).font(.system(size: 14, weight: .bold))
            switch why {
            case .stopped:
                Text(Copy.unreachableStopped).font(.system(size: 13))
                Text(Copy.unreachableFix).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
            case .unknownInstall:
                Text(Copy.unreachableUnknownInstall).font(.system(size: 13))
                Text(Copy.unreachableFix).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
            case let .mismatch(message):
                Text(message).font(.system(size: 13))
                Text(Copy.mismatchFix).font(.system(size: 13))
            }
            Button(Copy.tryAgain) { model.onRetry() }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color(nsColor: .controlBackgroundColor)))
    }

    private func title(_ item: Item) -> String {
        switch item.kind {
        case .request: return Copy.requestTitle(item.agent)
        case .message: return Copy.messageTitle(item.agent)
        case .test: return Copy.testTitle(item.agent)
        }
    }

    private func card(_ item: Item, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(title(item)).font(.system(size: 14, weight: .bold))
                Spacer()
                Text(Copy.ageShort(now.timeIntervalSince(item.sentAt))).font(.system(size: 12)).foregroundColor(muted)
            }
            if let talking = item.talkingTo {
                Text(Copy.talkingTo(talking)).font(.system(size: 12)).foregroundColor(muted)
            }
            Text(item.text).font(.system(size: 13)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if item.kind == .request && !item.choices.isEmpty {
                VStack(spacing: 6) {
                    ForEach(Array(item.choices.enumerated()), id: \.offset) { index, label in
                        Button { model.pick(item, index) } label: {
                            Text(label).font(.system(size: 13, weight: .medium)).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).frame(height: 32)
                                .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.3)))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if item.kind != .test {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.kind == .request && !item.choices.isEmpty ? Copy.orAnswer : Copy.replyLabel).font(.system(size: 12)).foregroundColor(muted)
                    TextField(Copy.typeTo(item.agent), text: Binding(get: { model.drafts[item.id] ?? "" }, set: { model.drafts[item.id] = $0 }))
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { model.reply(item) }
                }
            }
            if let problem = model.problems[item.id] {
                Text(problem).font(.system(size: 12)).foregroundColor(pink)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color.gray.opacity(0.2)))
    }

    private func messageBox(_ state: AppState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Copy.messageAnAgent).font(.system(size: 12, weight: .semibold)).foregroundColor(muted)
            if state.agents.isEmpty {
                Text(Copy.noAgentsYet).font(.system(size: 13)).foregroundColor(muted)
            } else {
                HStack(spacing: 6) {
                    Picker(Copy.to, selection: $model.messageAgent) {
                        ForEach(state.agents, id: \.agentID) { agent in Text(agent.name).tag(agent.agentID) }
                    }
                    .fixedSize()
                    TextField(Copy.typeAMessage, text: $model.messageText)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { model.sendMessage() }
                }
                if let line = model.messageLine {
                    Text(line).font(.system(size: 12)).foregroundColor(muted)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}
