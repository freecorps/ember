// The todo app's error codes: thrown by the functions with their message, typed on the client
// (`isError(e, api.lists.create, "ListNameRequired")`).
import { defineErrors } from "@freecorps/ember-server";

export const errors = defineErrors({
  ListNameRequired: { message: "A list needs a name" },
  TodoTextRequired: { message: "A todo needs some text" },
  ListNotFound: { message: "No such list" },
});
