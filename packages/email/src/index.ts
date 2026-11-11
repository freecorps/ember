export { email, emailFunctions, setEmailTransport, type EmailInstallConfig, type SendInput, type SendResult, type CountBlock, type CountsByStatus } from "./component.ts";
export { Email, type EmailComponentApi, type EmailRecord, type InboxAttachment, type InboxCounts, type PresenceRecord, type ScheduledEmail, type TagRecord, type ThreadEventKind, type ThreadEventRecord, type ThreadRecord } from "./client.ts";
export { emailSchema, TAG_COLORS, type TagColor } from "./schema.ts";
export * from "./address.ts";
export { parseDeliveryEvent, nextStatus, type DeliveryEvent, type EmailStatus, type EventType } from "./events.ts";
export { parseInbound, authResultsFrom, snippetOf, type ParsedInbound, type InboundAttachment, type AuthResults } from "./mime.ts";
export {
  renderTemplate,
  renderStored,
  checkTemplate,
  emailLayout,
  emailButton,
  escapeHtml,
  htmlToText,
  textToHtml,
  linkify,
  conversationLayout,
  conversationEmail,
  defaultQuoteHeader,
  TemplateError,
  type LayoutOptions,
  type StoredTemplate,
  type EmailSignature,
  type EmailQuote,
} from "./template.ts";
export { sanitizeEmailHtml, safeHref } from "./sanitize.ts";
export { bindingTransport, restTransport, bindingMessage, isPermanentCode, TransportError, type Transport, type OutboundMessage, type OutboundAttachment } from "./transport.ts";
