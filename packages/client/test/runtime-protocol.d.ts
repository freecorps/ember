declare module "#runtime-protocol" {
  import type { ClientMessage } from "../src/protocol.ts";
  export function decodeClientMessage(raw: string | ArrayBuffer): ClientMessage;
}
