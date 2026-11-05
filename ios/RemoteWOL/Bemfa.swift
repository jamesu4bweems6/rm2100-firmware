import Foundation

/// 巴法云主题：每台电脑对应一个。msg 是最后一条消息，路由器开启状态同步时每 30 秒写回 on/off。
struct BemfaTopic: Identifiable, Hashable {
    let topic: String
    let name: String
    let msg: String
    let online: Bool
    let unix: Int?

    var id: String { topic }
    var displayName: String { name.isEmpty ? topic : name }

    enum Power { case on, off, unknown }

    var power: Power { Bemfa.powerState(msg) }

    init(topic: String, name: String = "", msg: String = "", online: Bool = false, unix: Int? = nil) {
        self.topic = topic
        self.name = name
        self.msg = msg
        self.online = online
        self.unix = unix
    }

    /// 巴法云字段类型并不固定（online 可能是布尔或字符串，unix 可能是数字或字符串），逐个宽松解析
    init?(json: [String: Any]) {
        guard let topic = json["topic"].map({ "\($0)" }), !topic.isEmpty, topic != "<null>" else { return nil }
        self.topic = topic
        self.name = (json["name"] as? String) ?? ""
        if let msg = json["msg"], !(msg is NSNull) { self.msg = "\(msg)" } else { self.msg = "" }
        switch json["online"] {
        case let b as Bool: online = b
        case let n as NSNumber: online = n.intValue != 0
        case let s as String: online = s == "true" || s == "1"
        default: online = false
        }
        let raw: Int?
        switch json["unix"] {
        case let n as NSNumber: raw = n.intValue
        case let s as String: raw = Int(s)
        default: raw = nil
        }
        unix = (raw ?? 0) > 0 ? raw : nil
    }
}

enum BemfaError: LocalizedError, Equatable {
    case invalidKey
    case invalidTopic
    case network
    case badResponse(Int)
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidKey: return "私钥只包含字母和数字"
        case .invalidTopic: return "主题只能是字母和数字"
        case .network: return "连不上巴法云，请检查网络"
        case .badResponse(let status): return "巴法云返回了无法识别的数据（HTTP \(status)）"
        case .server(let message): return message
        }
    }
}

/// 巴法云 HTTP 接口。路由器连的是 bemfa.com:8344，对应接口里的 type=3（TCP 设备云）。
struct Bemfa {
    static let tcp = 3
    static let mqtt = 1
    static let api = URL(string: "https://apis.bemfa.com")!
    /// 主题名后三位决定米家里的设备类型；其他名字不会同步到米家
    static let kinds = ["001": "插座", "002": "灯", "003": "风扇", "004": "传感器", "005": "空调", "006": "开关", "009": "窗帘"]

    var session: URLSession = .shared

    static func validKey(_ s: String) -> Bool { valid(s) }

    static func valid(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 64 && s.unicodeScalars.allSatisfy { ($0.value >= 48 && $0.value <= 57) || ($0.value >= 65 && $0.value <= 90) || ($0.value >= 97 && $0.value <= 122) }
    }

    static func miKind(_ topic: String) -> String? {
        guard topic.count >= 3 else { return nil }
        return kinds[String(topic.suffix(3))]
    }

    static func powerState(_ msg: String) -> BemfaTopic.Power {
        let m = msg.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if m == "on" || m.hasPrefix("on#") { return .on }
        if m == "off" || m.hasPrefix("off#") { return .off }
        return .unknown
    }

    private func json(_ request: URLRequest) async throws -> [String: Any] {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw BemfaError.network
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BemfaError.badResponse(status)
        }
        return object
    }

    private static func code(_ object: [String: Any]) -> Int {
        (object["code"] as? NSNumber)?.intValue ?? Int("\(object["code"] ?? "")") ?? -999
    }

    /// 列出账号下某个云的全部主题
    func listTopics(uid: String, type: Int = Bemfa.tcp) async throws -> [BemfaTopic] {
        guard Bemfa.valid(uid) else { throw BemfaError.invalidKey }
        var components = URLComponents(url: Bemfa.api.appendingPathComponent("vb/api/v2/allTopic"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "openID", value: uid), URLQueryItem(name: "type", value: String(type))]
        var request = URLRequest(url: components.url!)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15
        let object = try await json(request)
        let code = Bemfa.code(object)
        guard code == 0 else {
            if code == -1 { throw BemfaError.server("获取主题失败：私钥不正确，或这个云里还没有主题") }
            throw BemfaError.server((object["msg"] as? String) ?? (object["message"] as? String) ?? "获取主题失败（\(code)）")
        }
        return Bemfa.topicList(object).compactMap(BemfaTopic.init(json:))
    }

    /// 实际返回是 {"code":0,"data":{"data":[…]}}，比官方文档示例多包一层；两种都接受
    static func topicList(_ object: [String: Any]) -> [[String: Any]] {
        if let list = object["data"] as? [[String: Any]] { return list }
        if let inner = object["data"] as? [String: Any], let list = inner["data"] as? [[String: Any]] { return list }
        return []
    }

    /// 向主题发 on：路由器收到后唤醒对应电脑
    func wake(uid: String, topic: String) async throws {
        guard Bemfa.valid(uid) else { throw BemfaError.invalidKey }
        guard Bemfa.valid(topic) else { throw BemfaError.invalidTopic }
        var request = URLRequest(url: Bemfa.api.appendingPathComponent("va/postJsonMsg"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["uid": uid, "topic": topic, "type": Bemfa.tcp, "msg": "on"])
        let object = try await json(request)
        let code = Bemfa.code(object)
        guard code == 0 else {
            throw BemfaError.server((object["message"] as? String) ?? (object["msg"] as? String) ?? "发送失败（\(code)）")
        }
    }
}
