// Ember end-to-end encrypted pushes, device side (iOS Notification Service Extension).
//
// Opens the `ember` envelope `{ v: 1, k, enc, ct }` that @freecorps/ember-push seals: HPKE (RFC 9180) base mode,
// DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM, info "freecorps.ember push v1" — CryptoKit's HPKE (iOS 17+).
// The suite is the one Freecorps Brigade chose in its spike S1 (one CryptoKit call); this file is written for Ember.
//
// The device keys are the JSON the app stored with expo-secure-store (@freecorps/ember-expo-push `ensurePushKey`):
// `{ "v": 1, "keys": [{ "d": <raw P-256 scalar>, "pub": <uncompressed public key> }] }`, base64url, in the keychain as a
// generic password (service "<keychainService>:no-auth", account "<keyName>") in the App Group's access group.
//
// Pure Foundation + CryptoKit + Security, so it compiles and is tested on macOS too (test/swift).

import CryptoKit
import Foundation
import Security

public struct EmberPushContent {
  public var title: String?
  public var subtitle: String?
  public var body: String?
  public var data: [String: Any]?
  public var iat: Int
}

public enum EmberPushError: Error, CustomStringConvertible {
  case noEnvelope, malformedEnvelope, noKeys, unsupportedOS, notOpened, malformedContent

  public var description: String {
    switch self {
    case .noEnvelope: return "noEnvelope"
    case .malformedEnvelope: return "malformedEnvelope"
    case .noKeys: return "noKeys"
    case .unsupportedOS: return "unsupportedOS"
    case .notOpened: return "notOpened"
    case .malformedContent: return "malformedContent"
    }
  }
}

public struct EmberPushKey {
  public let privateKey: Data  // 32-byte scalar
  public let publicKey: Data  // 65-byte uncompressed point
}

public enum EmberPushCrypto {
  public static let info = Data("freecorps.ember push v1".utf8)
  public static let envelopeVersion = 1

  public static func base64url(_ string: String) -> Data? {
    var s = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    return Data(base64Encoded: s)
  }

  public static func base64urlString(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// The key id an envelope names: base64url of SHA-256(public key)'s first 6 bytes (same as the server's `pushKeyId`).
  public static func keyId(_ publicKey: Data) -> String {
    base64urlString(Data(SHA256.hash(data: publicKey).prefix(6)))
  }

  /// The stored key JSON → keys (current first). Malformed entries are skipped.
  public static func parseKeys(_ json: Data) -> [EmberPushKey] {
    guard let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
      (obj["v"] as? Int) == 1, let list = obj["keys"] as? [[String: Any]]
    else { return [] }
    return list.compactMap { entry in
      guard let d = (entry["d"] as? String).flatMap(base64url), let pub = (entry["pub"] as? String).flatMap(base64url),
        d.count == 32, pub.count == 65
      else { return nil }
      return EmberPushKey(privateKey: d, publicKey: pub)
    }
  }

  /// The envelope in a notification's userInfo (`ember`), as a dictionary or a JSON string.
  public static func envelope(in userInfo: [AnyHashable: Any]) -> [String: Any]? {
    if let e = userInfo["ember"] as? [String: Any] { return e }
    if let s = userInfo["ember"] as? String, let d = s.data(using: .utf8) {
      return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }
    return nil
  }

  /// Opens an envelope with the device keys (the one named by `k` first). Throws `EmberPushError`.
  public static func open(envelope: [String: Any], keys: [EmberPushKey]) throws -> EmberPushContent {
    guard (envelope["v"] as? Int) == envelopeVersion, let k = envelope["k"] as? String,
      let enc = (envelope["enc"] as? String).flatMap(base64url), let ct = (envelope["ct"] as? String).flatMap(base64url),
      enc.count == 65, ct.count >= 16
    else { throw EmberPushError.malformedEnvelope }
    guard !keys.isEmpty else { throw EmberPushError.noKeys }
    guard #available(iOS 17.0, macOS 14.0, *) else { throw EmberPushError.unsupportedOS }
    let ordered = keys.filter { keyId($0.publicKey) == k } + keys.filter { keyId($0.publicKey) != k }
    for key in ordered {
      guard let plaintext = try? hpkeOpen(privateKey: key.privateKey, enc: enc, ct: ct) else { continue }
      return try parseContent(plaintext)
    }
    throw EmberPushError.notOpened
  }

  @available(iOS 17.0, macOS 14.0, *)
  static func hpkeOpen(privateKey: Data, enc: Data, ct: Data) throws -> Data {
    let sk = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
    let suite = HPKE.Ciphersuite(kem: .P256_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_128)
    var recipient = try HPKE.Recipient(privateKey: sk, ciphersuite: suite, info: info, encapsulatedKey: enc)
    return try recipient.open(ct)
  }

  static func parseContent(_ plaintext: Data) throws -> EmberPushContent {
    guard let obj = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any], let iat = obj["iat"] as? Int else {
      throw EmberPushError.malformedContent
    }
    func str(_ k: String) throws -> String? {
      guard let v = obj[k], !(v is NSNull) else { return nil }
      guard let s = v as? String else { throw EmberPushError.malformedContent }
      return s
    }
    var data: [String: Any]? = nil
    if let d = obj["data"], !(d is NSNull) {
      guard let dict = d as? [String: Any] else { throw EmberPushError.malformedContent }
      data = dict
    }
    return EmberPushContent(title: try str("title"), subtitle: try str("subtitle"), body: try str("body"), data: data, iat: iat)
  }

  /// Reads the stored key JSON from the keychain (expo-secure-store's layout), or nil.
  public static func readKeychain(service: String, account: String, accessGroup: String?) -> Data? {
    for svc in ["\(service):no-auth", service] {
      var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: svc,
        kSecAttrAccount as String: Data(account.utf8),
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
      ]
      if let group = accessGroup, !group.isEmpty { query[kSecAttrAccessGroup as String] = group }
      var out: CFTypeRef?
      if SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data { return data }
    }
    return nil
  }
}
