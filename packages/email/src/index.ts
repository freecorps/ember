export { email, emailFunctions, setEmailTransport, type EmailInstallConfig, type SendInput, type SendResult } from "./component.ts";
export { Email, type EmailComponentApi, type EmailRecord, type ThreadRecord } from "./client.ts";
export { emailSchema } from "./schema.ts";
export * from "./address.ts";
export { parseDeliveryEvent, nextStatus, type DeliveryEvent, type EmailStatus, type EventType } from "./events.ts";
export { parseInbound, authResultsFrom, snippetOf, type ParsedInbound, type InboundAttachment, type AuthResults } from "./mime.ts";
export { renderTemplate, renderStored, checkTemplate, emailLayout, emailButton, escapeHtml, htmlToText, textToHtml, TemplateError, type LayoutOptions, type StoredTemplate } from "./template.ts";
export { bindingTransport, restTransport, bindingMessage, isPermanentCode, TransportError, type Transport, type OutboundMessage, type OutboundAttachment } from "./transport.ts";
