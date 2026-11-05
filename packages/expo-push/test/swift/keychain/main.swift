// Test driver (test/swift.test.ts), run inside an iOS Simulator so it hits the iOS keychain (SecDb), not the macOS
// file keychain (which silently drops a Data account and so would match anything). Three processes, like the app
// writing and the NSE reading:
//
//   write <service> <key> <value> [<group>]  stores <value> exactly the way expo-secure-store (v57/v58,
//                                            ios/SecureStoreModule.swift `set`) does for setItemAsync(key, value,
//                                            { keychainService: service, keychainAccessible:
//                                            AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, accessGroup: group }), and
//                                            "<value> legacy" under "<service>.legacy" the way versions before the
//                                            `:no-auth` suffix did
//   read <service> <key> [<group>]           reads through the extension's EmberPushCrypto.readKeychain and prints
//                                            JSON: { current, legacy, otherAccount, prefixAccount, otherService }
//   delete <service> <key> [<group>]         removes every item it wrote, then prints the JSON of `read`
//
// expo-secure-store's query, for reference: kSecClass: kSecClassGenericPassword,
// kSecAttrService: "<keychainService>:no-auth", kSecAttrGeneric: Data(key.utf8), kSecAttrAccount: Data(key.utf8),
// kSecAttrAccessGroup: accessGroup (when given). A failing write prints `status <OSStatus>` and exits 2.
import Foundation
import Security

let args = CommandLine.arguments
func group(_ i: Int) -> String? { args.count > i && !args[i].isEmpty ? args[i] : nil }

/// expo-secure-store's `query(with:options:requireAuthentication:)`.
func secureStoreQuery(_ key: String, service base: String, accessGroup: String?, requireAuthentication: Bool?) -> [String: Any] {
  var service = base
  if let requireAuthentication { service.append(":\(requireAuthentication ? "auth" : "no-auth")") }
  let encodedKey = Data(key.utf8)
  var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrGeneric as String: encodedKey,
    kSecAttrAccount as String: encodedKey,
  ]
  if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
  return query
}

/// expo-secure-store's `set(value:with:options:)` without `requireAuthentication`.
func secureStoreSet(_ value: String, key: String, service: String, accessGroup: String?, requireAuthentication: Bool?) -> OSStatus {
  var q = secureStoreQuery(key, service: service, accessGroup: accessGroup, requireAuthentication: requireAuthentication)
  q[kSecValueData as String] = value.data(using: .utf8)
  q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  return SecItemAdd(q as CFDictionary, nil)
}

func read(_ service: String, _ key: String, _ group: String?) -> String {
  func one(_ service: String, _ account: String) -> Any {
    EmberPushCrypto.readKeychain(service: service, account: account, accessGroup: group).map { String(decoding: $0, as: UTF8.self) } ?? NSNull()
  }
  let out: [String: Any] = [
    "current": one(service, key),
    "legacy": one(service + ".legacy", key),
    "otherAccount": one(service, key + ".other"),
    "prefixAccount": one(service, String(key.dropLast())),
    "otherService": one(service + ".other", key),
  ]
  return String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!
}

switch args[1] {
case "write":
  for (service, value, auth) in [(args[2], args[4], false as Bool?), (args[2] + ".legacy", args[4] + " legacy", nil)] {
    let status = secureStoreSet(value, key: args[3], service: service, accessGroup: group(5), requireAuthentication: auth)
    if status != errSecSuccess {
      print("status \(status)")
      exit(2)
    }
  }
  print("ok")
case "read":
  print(read(args[2], args[3], group(4)))
case "delete":
  for base in [args[2], args[2] + ".legacy"] {
    for suffix in ["", ":no-auth", ":auth"] {
      var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: base + suffix]
      if let g = group(4) { q[kSecAttrAccessGroup as String] = g }
      SecItemDelete(q as CFDictionary)
    }
  }
  print(read(args[2], args[3], group(4)))
default:
  print("unknown command")
  exit(64)
}
