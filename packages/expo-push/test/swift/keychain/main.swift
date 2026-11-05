// Test driver (test/swift.test.ts), run inside an iOS Simulator so it hits the iOS keychain (SecDb), not the macOS
// file keychain (which silently drops a Data account and so would match anything).
//
//   write <service> <key> <value> [<accessGroup>]   stores the item exactly the way expo-secure-store (v57/v58,
//                                                   ios/SecureStoreModule.swift `set`) does for
//                                                   setItemAsync(key, value, { keychainService, keychainAccessible:
//                                                   AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, accessGroup })
//   write-legacy <service> <key> <value> [<group>]  same, for items saved before the `:no-auth` suffix existed
//   read <service> <key> [<accessGroup>]            reads it through the extension's EmberPushCrypto.readKeychain,
//                                                   prints the value or `null`
//   delete <service> [<accessGroup>]                removes every item of the service (all three aliases)
//
// expo-secure-store's query, for reference: kSecClass: kSecClassGenericPassword,
// kSecAttrService: "<keychainService>:no-auth", kSecAttrGeneric: Data(key.utf8), kSecAttrAccount: Data(key.utf8),
// kSecAttrAccessGroup: accessGroup (when given). Prints `status <OSStatus>` and exits 2 when a write fails.
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

switch args[1] {
case "write", "write-legacy":
  let status = secureStoreSet(args[4], key: args[3], service: args[2], accessGroup: group(5), requireAuthentication: args[1] == "write" ? false : nil)
  if status != errSecSuccess {
    print("status \(status)")
    exit(2)
  }
  print("ok")
case "read":
  let data = EmberPushCrypto.readKeychain(service: args[2], account: args[3], accessGroup: group(4))
  print(data.map { String(decoding: $0, as: UTF8.self) } ?? "null")
case "delete":
  for suffix in ["", ":no-auth", ":auth"] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: args[2] + suffix]
    if let g = group(3) { q[kSecAttrAccessGroup as String] = g }
    SecItemDelete(q as CFDictionary)
  }
  print("ok")
default:
  print("unknown command")
  exit(64)
}
