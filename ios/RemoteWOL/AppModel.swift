import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var uid: String? = KeyStore.load()
    @Published private(set) var topics: [BemfaTopic] = []
    @Published private(set) var loading = false
    @Published private(set) var sending: Set<String> = []
    @Published var message: String?
    @Published var isError = false

    /// 刚发过开机指令的两分钟内快速刷新
    private(set) var fastUntil = Date.distantPast
    private let client: Bemfa

    init(client: Bemfa = Bemfa()) {
        self.client = client
    }

    var refreshInterval: Duration { Date() < fastUntil ? .seconds(5) : .seconds(20) }

    func setKey(_ value: String) -> Bool {
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Bemfa.validKey(key) else { return false }
        KeyStore.save(key)
        uid = key
        topics = []
        message = nil
        return true
    }

    func clearKey() {
        KeyStore.delete()
        uid = nil
        topics = []
        message = nil
    }

    func refresh() async {
        guard let uid else { return }
        loading = true
        defer { loading = false }
        do {
            topics = Bemfa.sortedForDisplay(try await client.listTopics(uid: uid))
            // 只清掉上次的错误；「已发送开机指令」这类提示要留着
            if isError { message = nil; isError = false }
        } catch {
            show(error.localizedDescription, error: true)
        }
    }

    func wake(_ topic: BemfaTopic) async {
        guard let uid, !sending.contains(topic.topic) else { return }
        sending.insert(topic.topic)
        defer { sending.remove(topic.topic) }
        do {
            try await client.wake(uid: uid, topic: topic.topic)
            fastUntil = Date().addingTimeInterval(120)
            show("已向「\(topic.displayName)」发送开机指令" + (topic.online ? "。" : "，但路由器当前离线，指令可能送不到。"), error: false)
        } catch {
            show("开机失败：\(error.localizedDescription)", error: true)
        }
        await refresh()
    }

    func diagnose() async throws -> [DiagnosticItem] {
        guard let uid else { throw BemfaError.invalidKey }
        let tcp: [BemfaTopic]
        do {
            tcp = try await client.listTopics(uid: uid, type: Bemfa.tcp)
        } catch BemfaError.server(let text) where text.contains("私钥") {
            tcp = []
        }
        let mqtt = try? await client.listTopics(uid: uid, type: Bemfa.mqtt)
        return Diagnostics.run(tcp: tcp, mqtt: mqtt)
    }

    private func show(_ text: String, error: Bool) {
        message = text
        isError = error
    }
}

extension Bemfa {
    /// 能进米家的主题排前面，其余按名字
    static func sortedForDisplay(_ list: [BemfaTopic]) -> [BemfaTopic] {
        list.sorted { a, b in
            let ka = miKind(a.topic) != nil, kb = miKind(b.topic) != nil
            return ka != kb ? ka : a.topic < b.topic
        }
    }
}
