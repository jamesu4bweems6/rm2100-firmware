import XCTest
@testable import RemoteWOL

/// 拦截 URLSession 请求，返回预设的巴法云响应；不访问外网
final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest, Data?) -> (Int, Data))?
    static var requests: [(URLRequest, Data?)] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            let size = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
            while stream.hasBytesAvailable {
                let n = stream.read(buffer, maxLength: size)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            buffer.deallocate()
            stream.close()
            body = data
        }
        StubProtocol.requests.append((request, body))
        guard let handler = StubProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let (status, data) = handler(request, body)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class RemoteWOLTests: XCTestCase {
    let uid = "0123456789abcdef0123456789abcdef"

    func client() -> Bemfa {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return Bemfa(session: URLSession(configuration: config))
    }

    override func setUp() {
        StubProtocol.handler = nil
        StubProtocol.requests = []
    }

    func testMiKindAndValidation() {
        XCTAssertEqual(Bemfa.miKind("pc001"), "插座")
        XCTAssertEqual(Bemfa.miKind("desk006"), "开关")
        XCTAssertNil(Bemfa.miKind("pc"))
        XCTAssertNil(Bemfa.miKind("pc007"))
        XCTAssertTrue(Bemfa.validKey(uid))
        XCTAssertFalse(Bemfa.validKey("bad uid"))
        XCTAssertFalse(Bemfa.validKey(""))
        XCTAssertFalse(Bemfa.validKey("中文"))
        XCTAssertFalse(Bemfa.validKey(String(repeating: "a", count: 65)))
    }

    func testPowerState() {
        XCTAssertEqual(Bemfa.powerState("on"), .on)
        XCTAssertEqual(Bemfa.powerState(" ON "), .on)
        XCTAssertEqual(Bemfa.powerState("on#1"), .on)
        XCTAssertEqual(Bemfa.powerState("off"), .off)
        XCTAssertEqual(Bemfa.powerState(""), .unknown)
        XCTAssertEqual(Bemfa.powerState("hello"), .unknown)
    }

    func testTopicParsingIsLenient() {
        let a = BemfaTopic(json: ["topic": "pc001", "name": "电脑", "msg": "on", "online": true, "unix": 1700000000])
        XCTAssertEqual(a, BemfaTopic(topic: "pc001", name: "电脑", msg: "on", online: true, unix: 1700000000))
        let b = BemfaTopic(json: ["topic": "nas", "online": "false", "unix": "0", "msg": NSNull()])
        XCTAssertEqual(b, BemfaTopic(topic: "nas"))
        let c = BemfaTopic(json: ["topic": "x1", "online": 1, "unix": "1700000001"])
        XCTAssertEqual(c?.online, true)
        XCTAssertEqual(c?.unix, 1700000001)
        XCTAssertNil(BemfaTopic(json: ["msg": "on"]))
        XCTAssertNil(BemfaTopic(json: ["topic": ""]))
    }

    func testListTopicsRequestAndErrors() async throws {
        StubProtocol.handler = { _, _ in
            (200, Data(#"{"code":0,"data":[{"topic":"pc001","name":"电脑","msg":"off","online":true,"unix":1700000000},{"topic":""}]}"#.utf8))
        }
        let topics = try await client().listTopics(uid: uid)
        XCTAssertEqual(topics.map(\.topic), ["pc001"])
        let url = try XCTUnwrap(StubProtocol.requests.first?.0.url)
        XCTAssertEqual(url.host, "apis.bemfa.com")
        XCTAssertEqual(url.path, "/vb/api/v2/allTopic")
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(query.first { $0.name == "openID" }?.value, uid)
        XCTAssertEqual(query.first { $0.name == "type" }?.value, "3")

        StubProtocol.handler = { _, _ in (200, Data(#"{"code":-1,"msg":"获取失败","data":""}"#.utf8)) }
        do { _ = try await client().listTopics(uid: uid); XCTFail("应当报错") } catch {
            XCTAssertTrue(error.localizedDescription.contains("私钥不正确"))
        }
        StubProtocol.handler = { _, _ in (502, Data("<html>".utf8)) }
        do { _ = try await client().listTopics(uid: uid); XCTFail("应当报错") } catch {
            XCTAssertEqual(error as? BemfaError, .badResponse(502))
        }
        StubProtocol.handler = nil
        do { _ = try await client().listTopics(uid: uid); XCTFail("应当报错") } catch {
            XCTAssertEqual(error as? BemfaError, .network)
        }
        do { _ = try await client().listTopics(uid: "bad uid"); XCTFail("应当报错") } catch {
            XCTAssertEqual(error as? BemfaError, .invalidKey)
        }
    }

    func testWakeSendsOnToTcpTopic() async throws {
        StubProtocol.handler = { _, _ in (200, Data(#"{"code":0,"message":"OK","data":0}"#.utf8)) }
        try await client().wake(uid: uid, topic: "pc001")
        let (request, body) = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://apis.bemfa.com/va/postJsonMsg")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(body)) as? [String: Any])
        XCTAssertEqual(json["uid"] as? String, uid)
        XCTAssertEqual(json["topic"] as? String, "pc001")
        XCTAssertEqual(json["type"] as? Int, 3)
        XCTAssertEqual(json["msg"] as? String, "on")

        StubProtocol.handler = { _, _ in (200, Data(#"{"code":40004,"message":"Uid or topic err"}"#.utf8)) }
        do { try await client().wake(uid: uid, topic: "pc001"); XCTFail("应当报错") } catch {
            XCTAssertEqual(error.localizedDescription, "Uid or topic err")
        }
        do { try await client().wake(uid: uid, topic: "pc/001"); XCTFail("应当报错") } catch {
            XCTAssertEqual(error as? BemfaError, .invalidTopic)
        }
    }

    func testDiagnostics() {
        let empty = Diagnostics.run(tcp: [], mqtt: nil)
        XCTAssertEqual(empty.first?.level, .error)
        XCTAssertTrue(empty.first?.text.contains("没有查到主题") == true)

        let good = Diagnostics.run(tcp: [BemfaTopic(topic: "pc001", name: "电脑", online: true)], mqtt: [])
        XCTAssertEqual(good.map(\.level), [.ok])
        XCTAssertTrue(good[0].text.contains("同步设备"))

        let bad = Diagnostics.run(
            tcp: [BemfaTopic(topic: "pc"), BemfaTopic(topic: "fan003", online: true)],
            mqtt: [BemfaTopic(topic: "light002"), BemfaTopic(topic: "raw")])
        let text = bad.map { "\($0.level.rawValue):\($0.text)" }.joined(separator: "\n")
        XCTAssertTrue(text.contains("error:pc：主题名后三位不是"))
        XCTAssertTrue(text.contains("warn:pc：路由器没有在线订阅"))
        XCTAssertTrue(text.contains("info:fan003：在米家里会显示为「风扇」"))
        XCTAssertTrue(text.contains("warn:fan003：没有设置昵称"))
        XCTAssertTrue(text.contains("MQTT 设备云里的 light002"))
        XCTAssertFalse(text.contains("raw"))
        XCTAssertEqual(bad.last?.level, .info, "有错误时总结不标记为正常")
    }

    func testSortPutsMijiaTopicsFirst() {
        let sorted = Bemfa.sortedForDisplay([BemfaTopic(topic: "zz"), BemfaTopic(topic: "pc001"), BemfaTopic(topic: "aa"), BemfaTopic(topic: "nas006")])
        XCTAssertEqual(sorted.map(\.topic), ["nas006", "pc001", "aa", "zz"])
    }

    @MainActor
    func testModelKeepsWakeMessageAfterRefresh() async throws {
        KeyStore.delete()
        defer { KeyStore.delete() }
        var posted = false
        StubProtocol.handler = { request, _ in
            if request.url?.path == "/va/postJsonMsg" {
                posted = true
                return (200, Data(#"{"code":0}"#.utf8))
            }
            return (200, Data(#"{"code":0,"data":[{"topic":"pc001","name":"电脑","msg":"on","online":true}]}"#.utf8))
        }
        let model = AppModel(client: client())
        XCTAssertFalse(model.setKey("bad uid"))
        XCTAssertTrue(model.setKey(" \(uid) "))
        XCTAssertEqual(KeyStore.load(), uid, "私钥写入钥匙串")
        await model.refresh()
        XCTAssertEqual(model.topics.first?.power, .on)
        await model.wake(model.topics[0])
        XCTAssertTrue(posted)
        XCTAssertEqual(model.message, "已向「电脑」发送开机指令。", "刷新后仍保留发送成功的提示")
        XCTAssertFalse(model.isError)
        XCTAssertTrue(model.sending.isEmpty)
        model.clearKey()
        XCTAssertNil(KeyStore.load())
        XCTAssertTrue(model.topics.isEmpty)
    }
}
