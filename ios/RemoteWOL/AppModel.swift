import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var uid: String? = KeyStore.load()
    @Published private(set) var topics: [BemfaTopic] = []
    @Published private(set) var loading = false
    @Published private(set) var sending: Set<String> = []
    @Published var message: String?
    @Published var isError = false
    /// 本机发出、还没确认的开机指令（按主题）
    @Published private(set) var wakes: [String: WakeTrack] = [:]

    /// 每台电脑当前该显示什么：开机指令发出后先显示「开机中」，路由器确认后才显示「已开机」
    func view(for topic: BemfaTopic, now: Date = Date()) -> WakeView {
        Bemfa.wakeView(topic, wakes[topic.topic], now: now)
    }

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
            updateWakes()
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
            wakes[topic.topic] = WakeTrack(sentAt: Date())
            fastUntil = Date().addingTimeInterval(Bemfa.wakeWait)
            show("已向「\(topic.displayName)」发送开机指令，正在等待电脑响应（通常 30 秒到 1 分钟）" + (topic.online ? "。" : "；但路由器当前离线，指令可能送不到。"), error: false)
        } catch {
            show("开机失败：\(error.localizedDescription)", error: true)
        }
        await refresh()
    }

    /// 记录指令那条 on 的服务器时间，确认或超时后忘掉；电脑没响应时给出排查提示
    private func updateWakes(now: Date = Date()) {
        for t in topics {
            guard var w = wakes[t.topic] else { continue }
            Bemfa.trackWake(&w, t)
            let v = Bemfa.wakeView(t, w, now: now)
            wakes[t.topic] = v.done ? nil : w
            // 每次刷新都重新给出（刷新开头会清掉上一次的错误提示）
            if v.level == .fail {
                show("「\(t.displayName)」没有响应开机指令。路由器已发出唤醒包，请检查电脑：网线是否连在路由器上、网卡属性里是否开启「魔术包唤醒」和「关机网络唤醒」、网卡 MAC 是否被手动改过（关机后网卡只认出厂 MAC）。", error: true)
            }
        }
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
