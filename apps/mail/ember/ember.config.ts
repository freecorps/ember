// The mail service = the email component + push (the mobile inbox gets a push per new message).
import { createFunctionHandle, defineApp } from "@freecorps/ember-server";
import { email } from "@freecorps/ember-email";
import { pushComponent } from "@freecorps/ember-push";

export default defineApp()
  .use(email, {
    config: {
      // Per sending project (API key tenant). Mailbox replies use the project "mailbox:<name>".
      rateLimit: { rate: 600, period: 60_000, capacity: 600 },
      hooks: { onInbound: createFunctionHandle("support:onInbound") },
    },
  })
  .use(pushComponent);
