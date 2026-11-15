// From the ConvexError codes found by `ember migrate convex` (one per code). The payload is the one the Convex code
// threw (`{ code, ... }` or a string), so clients reading `error.data` keep working; refine each `v.any()` into the
// payload's validator and give the errors messages of their own (docs/design/dx.md §3.2).
import { defineErrors, v } from "@freecorps/ember-server";

/** The payload's `message` (or the payload itself when it is a string), else the code. */
const messageOf =
  (code: string) =>
  (data: unknown): string =>
    typeof data === "string"
      ? data
      : typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : code;

export const errors = defineErrors({
  /** from "not-a-member": lib/teams.ts:28 */
  NotAMember: { data: v.any() /* refine */, message: messageOf("NotAMember") },
  /** from "NOTE_TOO_LONG": notes.ts:61 */
  NoteTooLong: { data: v.any() /* refine */, message: messageOf("NoteTooLong") },
  /** from "TEAM_NOT_FOUND": lib/teams.ts:21 */
  TeamNotFound: { data: v.any() /* refine */, message: messageOf("TeamNotFound") },
  /** from "UNAUTHENTICATED": lib/auth.ts:17 */
  Unauthenticated: { data: v.any() /* refine */, message: messageOf("Unauthenticated") },
  /** ConvexError without a code (data: the original payload): notes.ts:62 */
  AppError: { data: v.any() /* refine */, message: messageOf("AppError") },
});
