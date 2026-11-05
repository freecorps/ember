// Ember Notification Service Extension (generated into the app by the @freecorps/ember-expo-push config plugin).
//
// For a push with `mutable-content: 1` and an `ember` envelope, replaces the fallback title/body APNs delivered with
// the decrypted title, subtitle and body, and puts the decrypted `data` where expo-notifications reads it
// (`userInfo["body"]`). When anything fails (no key yet, iOS 16, malformed or foreign envelope, out of time) the
// fallback text stays: never an empty notification. Logs the failing step, never content.

import UserNotifications
import os

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?
  private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "EmberNotificationService", category: "push")

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    bestAttempt = content
    guard let envelope = EmberPushCrypto.envelope(in: content.userInfo) else {
      contentHandler(content)  // not an Ember sealed push
      return
    }
    let info = Bundle.main.infoDictionary ?? [:]
    let service = info["EmberPushKeychainService"] as? String ?? "ember.push"
    let account = info["EmberPushKeyName"] as? String ?? "ember.push.keys.v1"
    let group = info["EmberPushAppGroup"] as? String
    do {
      guard let stored = EmberPushCrypto.readKeychain(service: service, account: account, accessGroup: group) else {
        throw EmberPushError.noKeys
      }
      let opened = try EmberPushCrypto.open(envelope: envelope, keys: EmberPushCrypto.parseKeys(stored))
      if let t = opened.title { content.title = t }
      if let s = opened.subtitle { content.subtitle = s }
      if let b = opened.body { content.body = b }
      var userInfo = content.userInfo
      userInfo.removeValue(forKey: "ember")
      if let data = opened.data { userInfo["body"] = data }
      content.userInfo = userInfo
      log.info("push decrypted")
    } catch {
      log.error("push not decrypted: \(String(describing: error), privacy: .public)")
    }
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let bestAttempt { contentHandler(bestAttempt) }
  }
}
