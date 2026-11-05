# @freecorps/ember-mail-sdk

A typed client for the self-hosted Ember mail service (`apps/mail` in the
[Ember](https://github.com/freecorps/ember) repo). The service runs in your own Cloudflare account. The SDK works
like Resend's: every call resolves to `{ data, error }`.

```ts
import { EmberMail } from "@freecorps/ember-mail-sdk";

const mail = new EmberMail(process.env.MAIL_API_KEY!, { baseUrl: "https://mail.example.com" });

const { data, error } = await mail.emails.send(
  { from: "Acme <hello@acme.com>", to: "ana@example.com", subject: "Welcome", html: "<p>Hi Ana</p>" },
  { idempotencyKey: "welcome/ana" },
);
await mail.emails.get(data!.id);                       // last_event: queued → sent → delivered | bounced | ...
await mail.batch.send([{ ... }, { ... }]);
await mail.templates.create({ name: "welcome", subject: "Welcome {{name}}", html: "<p>Hi {{name}}</p>" });
await mail.emails.send({ from: "hello@acme.com", to: "bo@example.com", template: { name: "welcome", data: { name: "Bo" } } });
await mail.domains.create({ name: "mail.acme.com" });  // DNS records to check, then domains.verify(id)
await mail.inbox.threads({ mailbox: "support", status: "open" });
```

It has no dependencies and runs on Node 18+, Workers, Deno, Bun and browsers. License: MIT.
