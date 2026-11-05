// The email component, nothing else: mailboxes, send, delivery events, inbound.
import { defineApp } from "@freecorps/ember-server";
import { email } from "@freecorps/ember-email";

export default defineApp().use(email, { config: { rateLimit: { rate: 60, period: 60_000 } } });
