// Test driver for ios/EmberNotificationService/EmberPushCrypto.swift on macOS (test/swift.test.ts builds and runs it):
// reads { "keys": <stored key JSON string>, "cases": [{ "userInfo": {...} }] } and prints one JSON result per case.
import Foundation

let input = try! JSONSerialization.jsonObject(with: try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let keys = EmberPushCrypto.parseKeys((input["keys"] as! String).data(using: .utf8)!)
var results: [[String: Any]] = []
for c in input["cases"] as! [[String: Any]] {
  let userInfo = c["userInfo"] as! [String: Any]
  guard let envelope = EmberPushCrypto.envelope(in: userInfo) else {
    results.append(["error": "noEnvelope"])
    continue
  }
  do {
    let o = try EmberPushCrypto.open(envelope: envelope, keys: keys)
    var r: [String: Any] = ["iat": o.iat]
    if let t = o.title { r["title"] = t }
    if let s = o.subtitle { r["subtitle"] = s }
    if let b = o.body { r["body"] = b }
    if let d = o.data { r["data"] = d }
    if let pub = keys.first?.publicKey { r["keyId"] = EmberPushCrypto.keyId(pub) }
    results.append(r)
  } catch {
    results.append(["error": String(describing: error)])
  }
}
print(String(data: try! JSONSerialization.data(withJSONObject: results, options: [.sortedKeys]), encoding: .utf8)!)
