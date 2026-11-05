import AppIntents
import Foundation

/// Siri / 快捷指令：「用远程开机打开电脑」。米家里看不到设备时也能语音开机。
struct WakeComputerIntent: AppIntent {
    static let title: LocalizedStringResource = "打开电脑"
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let uid = KeyStore.load() else {
            throw IntentMessage("请先打开「远程开机」App 填写巴法云私钥。")
        }
        let client = Bemfa()
        var topic = UserDefaults.standard.string(forKey: "defaultTopic") ?? ""
        var name = topic
        let topics = try? await client.listTopics(uid: uid)
        if let topics {
            if let match = topics.first(where: { $0.topic == topic }) {
                name = match.displayName
            } else {
                // 没选默认电脑，或默认的主题已被删除：用列表里第一台
                guard let first = Bemfa.sortedForDisplay(topics).first else {
                    throw IntentMessage("巴法云 TCP 设备云里还没有主题，请先在控制台新建（例如 pc001）。")
                }
                topic = first.topic
                name = first.displayName
            }
        } else if topic.isEmpty {
            // 读不到主题列表又没设默认电脑，无从选择
            throw BemfaError.network
        }
        try await client.wake(uid: uid, topic: topic)
        return .result(dialog: "已向\(name)发送开机指令，电脑大约 1 分钟内开机。")
    }
}

struct IntentMessage: LocalizedError {
    let text: String
    init(_ text: String) { self.text = text }
    var errorDescription: String? { text }
}

struct RemoteWOLShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: WakeComputerIntent(),
            phrases: [
                "用\(.applicationName)打开电脑",
                "\(.applicationName)开机"
            ],
            shortTitle: "打开电脑",
            systemImageName: "power"
        )
    }
}
