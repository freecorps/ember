// Better Auth options for this project's Auth Durable Object. Ember adds the database, the secret, the bearer() and
// jwt() plugins; you describe the rest. Email + password is enough for this example.
import { defineAuth } from "@freecorps/ember-auth";

export default defineAuth({
  emailAndPassword: { enabled: true },
  // Browsers send an Origin header and Better Auth refuses origins it does not know. The Vite dev server (web/) is
  // one; add your site's origin when you deploy the web app somewhere else.
  trustedOrigins: ["http://localhost:5173"],
});
