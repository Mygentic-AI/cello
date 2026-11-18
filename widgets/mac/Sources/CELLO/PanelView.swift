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
    // "Message an agent…" is one line until clicked, so a question's choices and reply box get the room.
    @Published var composing = false
    @Published var loginItemOn = LoginItem.isOn
    // The Mac's own settings standing in the way: notifications turned off, or open at login waiting for an OK.
    @Published var notificationsOff = false
    @Published var loginNeedsOK = false
    // Settings › Add or remove agents: the panel shows the list of agents on this Mac in place of what's waiting.
    @Published var showingAgents = false
    @Published var others: [LocalAgent] = []
    @Published var agentsLine: String?
    @Published var agentProblems: [String: String] = [:]
    // The height of the screen the panel opens on, set each time it opens.
    @Published var screenHeight: Double = 900
    var onQuit: () -> Void = {}
    var onRemove: () -> Void = {}
    var onRemoveAgent: (Agent) -> Void = { _ in }
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
            // Sent: it folds back to one line, with the line saying where it went. Not sent: it stays open on the draft.
            if ok {
                self.messageText = ""
                self.composing = false
            }
        }
    }

    func openComposer() {
        messageLine = nil
        composing = true
    }

    func showAgents() {
        agentProblems = [:]
        agentsLine = nil
        showingAgents = true
        loadAgents()
    }

    // keepLine: a note from an add just made stays, unless the list itself fails.
    func loadAgents(keepLine: Bool = false) {
        controller.listAgents { [weak self] _, others, problem in
            self?.others = others
            if problem != nil || !keepLine { self?.agentsLine = problem }
        }
    }

    func addAgent(_ agent: LocalAgent) {
        agentProblems[agent.agentID] = nil
        controller.addAgent(agent.agentID, name: agent.name) { [weak self] problem, note in
            guard let self else { return }
            if let problem {
                self.agentProblems[agent.agentID] = problem
            } else {
                self.agentsLine = note
                self.loadAgents(keepLine: note != nil)
            }
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
        loginNeedsOK = LoginItem.needsApproval
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

private struct HeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private extension View {
    // Reports this view's height, so the panel can size its list to what's in it.
    func measured(_ height: Binding<CGFloat>) -> some View {
        background(GeometryReader { proxy in Color.clear.preference(key: HeightKey.self, value: proxy.size.height) })
            .onPreferenceChange(HeightKey.self) { height.wrappedValue = $0 }
    }
}

struct PanelView: View {
    @ObservedObject var model: PanelModel
    @State private var listContent: CGFloat = 0
    @State private var headerHeight: CGFloat = 0
    @State private var boxHeight: CGFloat = 0

    var body: some View {
        let now = Date()
        let state = model.state
        VStack(alignment: .leading, spacing: 0) {
            header(state, now: now).measured($headerHeight)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: PanelLayout.listSpacing) {
                    if model.showingAgents {
                        agentsList(state)
                    } else {
                        home(state, now: now)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, PanelLayout.listPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
                .measured($listContent)
            }
            // As tall as what's in it, until the whole panel would pass two-thirds of the screen.
            .frame(height: CGFloat(PanelSize.listHeight(content: Double(listContent), chrome: Double(headerHeight + boxHeight + 2), screen: model.screenHeight)))
            Divider()
            messageBox(state).measured($boxHeight)
        }
        .frame(width: 392)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // Everything waiting, what was answered today, and anything on the Mac that's in the way.
    @ViewBuilder
    private func home(_ state: AppState, now: Date) -> some View {
                    if case let .unreachable(why) = state.connection { unreachable(why) }
                    if model.notificationsOff { settingsLine(Copy.notificationsOff, button: Copy.openNotificationSettings) { Banners.openSettings() } }
                    if model.loginNeedsOK { settingsLine(Copy.loginItemNeedsOK, button: Copy.openLoginItems) { LoginItem.openSettings() } }
                    // Answered here a moment ago: the card says so for a few seconds, then folds into Earlier today.
                    ForEach(Array(state.justAnswered(now: now).enumerated()), id: \.offset) { _, line in answeredCard(line) }
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

    // Every agent on this Mac: Remove for each that can reach the person here, Add for each that can't yet.
    @ViewBuilder
    private func agentsList(_ state: AppState) -> some View {
        HStack {
            Text(Copy.addOrRemoveAgents.replacingOccurrences(of: "…", with: "")).font(.system(size: 14, weight: .bold))
            Spacer()
            Button(Copy.done) { model.showingAgents = false }
        }
        if let line = model.agentsLine {
            Text(line).font(.system(size: 12)).foregroundColor(pink)
        }
        Text(Copy.reachYouHere).font(.system(size: 12, weight: .semibold)).foregroundColor(muted)
        if state.agents.isEmpty { Text(Copy.noAgentsYet).font(.system(size: 13)).foregroundColor(muted) }
        ForEach(state.agents, id: \.agentID) { agent in
            HStack {
                Text(agent.name).font(.system(size: 13))
                Spacer()
                Button(Copy.removeRow) { model.onRemoveAgent(agent) }
            }
        }
        Text(Copy.notYet).font(.system(size: 12, weight: .semibold)).foregroundColor(muted).padding(.top, 4)
        let others = model.others.filter { other in !state.agents.contains { $0.agentID == other.agentID } }
        if others.isEmpty && model.agentsLine == nil { Text(Copy.everyAgentIsHere).font(.system(size: 13)).foregroundColor(muted) }
        ForEach(others, id: \.agentID) { agent in
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(agent.name).font(.system(size: 13))
                    Spacer()
                    // A locked agent takes a person at a terminal, so there's no button to press and be refused.
                    if !agent.locked { Button(Copy.add) { model.addAgent(agent) } }
                }
                if agent.locked {
                    Text(Copy.addLocked(agent.name)).font(.system(size: 12)).foregroundColor(muted).fixedSize(horizontal: false, vertical: true)
                } else if let problem = model.agentProblems[agent.agentID] {
                    Text(problem).font(.system(size: 12)).foregroundColor(pink).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func header(_ state: AppState, now: Date) -> some View {
        HStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: PanelLayout.headerIcon, height: PanelLayout.headerIcon).clipShape(RoundedRectangle(cornerRadius: 6))
            Text(Copy.appName).font(.system(size: 15, weight: .bold))
            Spacer()
            settings(state, now: now)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, PanelLayout.headerPadding)
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
            Button(Copy.addOrRemoveAgents) { model.showAgents() }
            Button(Copy.focusMenu) { FocusSettings.open() }
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

    // A setting on the Mac that's in the way, with the one button that opens it. Opened only when the person clicks.
    private func settingsLine(_ line: String, button: String, open: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(line).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
            Button(button, action: open)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color(nsColor: .controlBackgroundColor)))
    }

    private func unreachable(_ why: Unreachable) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Copy.unreachableTitle).font(.system(size: 14, weight: .bold))
            // What cello login or CELLO said is in the app's log, never here: it's worded for the command line.
            let said = Copy.unreachable(why)
            Text(said.reason).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
            Text(said.fix).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
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
        VStack(alignment: .leading, spacing: PanelLayout.cardSpacing) {
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
                VStack(spacing: PanelLayout.choiceGap) {
                    ForEach(Array(item.choices.enumerated()), id: \.offset) { index, label in
                        Button { model.pick(item, index) } label: {
                            Text(label).font(.system(size: 13, weight: .medium)).lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10).frame(height: PanelLayout.choiceHeight)
                                .background(RoundedRectangle(cornerRadius: 7).fill(Color(nsColor: .controlBackgroundColor)))
                                .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.gray.opacity(0.3)))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(label)
                    }
                }
            }
            if item.kind != .test {
                let underChoices = item.kind == .request && !item.choices.isEmpty
                VStack(alignment: .leading, spacing: 4) {
                    Text(underChoices ? Copy.orAnswer : Copy.replyLabel).font(.system(size: 12)).foregroundColor(muted)
                    GrowingTextArea(placeholder: Copy.typeTo(item.agent), text: Binding(get: { model.drafts[item.id] ?? "" }, set: { model.drafts[item.id] = $0 }), minLines: underChoices ? PanelLayout.replyLinesUnderChoices : TextArea.minLines) { model.reply(item) }
                }
            }
            if let problem = model.problems[item.id] {
                Text(problem).font(.system(size: 12)).foregroundColor(pink)
            }
        }
        .padding(PanelLayout.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color.gray.opacity(0.2)))
    }

    private func answeredCard(_ line: EarlierLine) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
            Text(line.card ?? line.what).font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color.gray.opacity(0.2)))
    }

    // One line, "Message an agent…", until clicked. Open: who to, and the box. Escape or a sent message folds it back.
    private func messageBox(_ state: AppState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if state.agents.isEmpty {
                Text(Copy.noAgentsYet).font(.system(size: 13)).foregroundColor(muted)
            } else if model.composing {
                HStack {
                    Picker(Copy.to, selection: $model.messageAgent) {
                        ForEach(state.agents, id: \.agentID) { agent in Text(agent.name).tag(agent.agentID) }
                    }
                    .fixedSize()
                    Spacer()
                    Button { model.composing = false } label: { Image(systemName: "chevron.down") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(Copy.closeComposer)
                }
                GrowingTextArea(placeholder: Copy.typeAMessage, text: $model.messageText, focused: true, onCancel: { model.composing = false }) { model.sendMessage() }
            } else {
                Button { model.openComposer() } label: {
                    Text(Copy.messageAnAgent).font(.system(size: 13)).foregroundColor(muted)
                        .frame(maxWidth: .infinity, minHeight: PanelLayout.line13 + 4, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if let line = model.messageLine, !state.agents.isEmpty {
                Text(line).font(.system(size: 12)).foregroundColor(muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, PanelLayout.composerPadding)
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}
