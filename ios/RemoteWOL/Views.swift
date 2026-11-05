import SwiftUI

@main
struct RemoteWOLApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSettings = false
    @State private var showDiagnostics = false

    var body: some View {
        NavigationStack {
            List {
                if model.uid == nil {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("先填写巴法云私钥").font(.headline)
                            Text("在 cloud.bemfa.com 控制台左上角复制私钥（UID）。App 通过巴法云给家里的路由器发指令，路由器再唤醒网线连接的电脑。")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Button("填写私钥") { showSettings = true }
                                .buttonStyle(.borderedProminent)
                                .padding(.top, 4)
                        }
                        .padding(.vertical, 6)
                    }
                } else {
                    Section {
                        if model.topics.isEmpty {
                            Text(model.loading ? "正在读取…" : "TCP 设备云里还没有主题。请先在巴法云控制台新建主题（例如 pc001），并在路由器「远程开机」页面填同一个主题。")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(model.topics) { topic in
                            TopicRow(topic: topic, view: model.view(for: topic), sending: model.sending.contains(topic.topic)) {
                                Task { await model.wake(topic) }
                            }
                        }
                    } header: {
                        Text("电脑")
                    } footer: {
                        Text("状态由路由器每 30 秒检测一次并同步到巴法云；开机通常需要 30 秒到 1 分钟。")
                    }

                    if let message = model.message {
                        Section {
                            Text(message)
                                .font(.subheadline)
                                .foregroundStyle(model.isError ? Color.red : Color.primary)
                        }
                    }

                    Section {
                        Button {
                            showDiagnostics = true
                        } label: {
                            Label("米家里看不到设备？检查巴法云", systemImage: "stethoscope")
                        }
                    }
                }
            }
            .navigationTitle("远程开机")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("设置")
                }
            }
            .refreshable { await model.refresh() }
            .sheet(isPresented: $showSettings) { SettingsView().environmentObject(model) }
            .sheet(isPresented: $showDiagnostics) { DiagnosticsView().environmentObject(model) }
            // 前台时定时刷新；换了私钥或回到前台会重新开始
            .task(id: "\(model.uid ?? "")|\(scenePhase == .active)") {
                guard scenePhase == .active, model.uid != nil else { return }
                while !Task.isCancelled {
                    await model.refresh()
                    try? await Task.sleep(for: model.refreshInterval)
                }
            }
        }
    }
}

struct TopicRow: View {
    let topic: BemfaTopic
    /// 由 AppModel.view(for:) 给出：开机指令发出后先是「开机中」，路由器确认后才是「已开机」
    let view: WakeView
    let sending: Bool
    let action: () -> Void

    private var subtitle: String {
        var parts: [String] = []
        if !topic.name.isEmpty { parts.append(topic.topic) }
        parts.append(view.label)
        // 开机过程中不显示「多久前」：那是指令本身的时间，容易误会
        if let unix = topic.unix, view.level == .ok || view.level == .off {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .short
            parts.append(formatter.localizedString(for: Date(timeIntervalSince1970: TimeInterval(unix)), relativeTo: Date()))
        }
        return parts.joined(separator: " · ")
    }

    private var dotColor: Color {
        switch view.level {
        case .ok: return .green
        case .wait: return .orange
        case .fail: return .red
        case .off, .unknown: return Color.gray.opacity(0.45)
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(dotColor)
                .frame(width: 12, height: 12)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(topic.displayName).font(.body.weight(.semibold))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
                Text(topic.online ? "路由器在线" : "路由器离线")
                    .font(.caption)
                    .foregroundStyle(topic.online ? Color.secondary : Color.orange)
            }
            Spacer(minLength: 8)
            Button(sending ? "发送中…" : "开机", action: action)
                .buttonStyle(.borderedProminent)
                .disabled(sending)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    @State private var error: String?
    @AppStorage("defaultTopic") private var defaultTopic = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField(model.uid == nil ? "32 位字母和数字" : "已保存（重新输入可替换）", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("保存") {
                        if model.setKey(key) {
                            key = ""
                            error = nil
                            dismiss()
                        } else {
                            error = "私钥只包含字母和数字"
                        }
                    }
                    .disabled(key.isEmpty)
                    if let error {
                        Text(error).foregroundStyle(.red)
                    }
                } header: {
                    Text("巴法云私钥")
                } footer: {
                    Text("在 cloud.bemfa.com 控制台左上角复制私钥（UID）。私钥只保存在这台设备的钥匙串里。")
                }

                Section {
                    Picker("Siri 默认开哪台", selection: $defaultTopic) {
                        Text("列表里第一台").tag("")
                        ForEach(model.topics) { topic in
                            Text(topic.displayName).tag(topic.topic)
                        }
                    }
                } header: {
                    Text("Siri 与快捷指令")
                } footer: {
                    Text("对 Siri 说「用远程开机打开电脑」，或在「快捷指令」App 里添加「打开电脑」，米家用不了时也能语音开机。")
                }

                if model.uid != nil {
                    Section {
                        Button("清除私钥", role: .destructive) {
                            model.clearKey()
                            defaultTopic = ""
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}

struct DiagnosticsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var items: [DiagnosticItem] = []
    @State private var running = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("检查主题命名、昵称和路由器在线状态，找出米家不显示设备、远程开机不生效的原因。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if running {
                    HStack {
                        ProgressView()
                        Text("正在查询巴法云…").foregroundStyle(.secondary)
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                ForEach(items) { item in
                    Label {
                        Text(item.text).font(.subheadline)
                    } icon: {
                        Image(systemName: icon(item.level)).foregroundStyle(color(item.level))
                    }
                }
            }
            .navigationTitle("检查巴法云")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .refreshable { await run() }
            .task { await run() }
        }
    }

    private func run() async {
        running = true
        error = nil
        defer { running = false }
        do {
            items = try await model.diagnose()
        } catch {
            items = []
            self.error = error.localizedDescription
        }
    }

    private func icon(_ level: DiagnosticItem.Level) -> String {
        switch level {
        case .ok: return "checkmark.circle.fill"
        case .info: return "info.circle.fill"
        case .warn: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }

    private func color(_ level: DiagnosticItem.Level) -> Color {
        switch level {
        case .ok: return .green
        case .info: return .gray
        case .warn: return .orange
        case .error: return .red
        }
    }
}
