import Foundation

/// 检查账号设置，找出米家里看不到设备、远程开机不生效的原因（与网页 bemfa.js 的规则一致）。
struct DiagnosticItem: Identifiable, Hashable {
    enum Level: String { case ok, info, warn, error }
    let id = UUID()
    let level: Level
    let text: String
}

enum Diagnostics {
    static func run(tcp: [BemfaTopic], mqtt: [BemfaTopic]?) -> [DiagnosticItem] {
        var items: [DiagnosticItem] = []
        func add(_ level: DiagnosticItem.Level, _ text: String) { items.append(DiagnosticItem(level: level, text: text)) }

        if tcp.isEmpty {
            add(.error, "TCP 设备云里没有查到主题（也可能是私钥填错了）。请核对私钥，并在巴法云控制台「TCP 设备云」新建主题，名字以 001 结尾（例如 pc001），路由器「远程开机」里填同一个主题。")
        }
        var mijia = 0
        for t in tcp {
            let label = t.name.isEmpty ? t.topic : "「\(t.name)」（\(t.topic)）"
            if let kind = Bemfa.miKind(t.topic) {
                mijia += 1
                if kind != "插座" && kind != "开关" {
                    add(.info, "\(label)：在米家里会显示为「\(kind)」。电脑建议用 001（插座）或 006（开关）。")
                }
                if t.name.isEmpty {
                    add(.warn, "\(t.topic)：没有设置昵称。米家和小爱同学用昵称作设备名，建议在巴法云控制台把昵称设为「电脑」。")
                }
            } else {
                add(.error, "\(label)：主题名后三位不是 001、002 这类设备代码，不会同步到米家。请新建以 001 结尾的主题（例如 \(t.topic)001），路由器里也改成新主题。")
            }
            if !t.online {
                add(.warn, "\(label)：路由器没有在线订阅这个主题，远程开机指令送不到。请确认路由器「远程开机」已启用、填了这个主题，且运行状态显示已连接。")
            }
        }
        for t in mqtt ?? [] where Bemfa.miKind(t.topic) != nil {
            add(.info, "MQTT 设备云里的 \(t.topic) 也会同步到米家，但路由器只接收 TCP 设备云的指令。远程开机请用 TCP 设备云里的主题。")
        }
        if mijia > 0 {
            let hasError = items.contains { $0.level == .error }
            add(hasError ? .info : .ok, "有 \(mijia) 个主题符合米家同步规则。若米家里仍看不到：米家 App →「我的」→「其他平台设备」（新版为「连接其他平台」）→「巴法」→「同步设备」；同步来的设备可能只出现在「巴法」这个列表里，不在首页。新建或改名主题后都要重新同步，仍不行就解绑巴法后重新绑定。")
        }
        return items
    }
}
