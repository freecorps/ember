// The chat's error codes: thrown by the functions, typed on the client (`isError(e, api.messages.send, "MessageTooLong")`).
import { defineErrors, v } from "@freecorps/ember-server";

export const errors = defineErrors({
  EmptyMessage: { message: "Empty message" },
  MessageTooLong: { data: v.object({ max: v.number() }), message: (d: { max: number }) => `Messages are limited to ${d.max} characters` },
  RoomNotFound: { data: v.object({ roomId: v.string() }), message: "No such room" },
  RoomNameRequired: { message: "A room needs a name" },
});
