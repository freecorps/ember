// Better Auth options for this project's Auth Durable Object (PLAN §9). Ember injects the database (the DO's
// SQLite), the secret, the jwt() + bearer() plugins and the cookie prefix; do not set them here.
import { defineAuth } from "@ember/auth";
import { organization } from "@ember/auth/plugins";

export default defineAuth({
  emailAndPassword: { enabled: true },
  plugins: [organization()],
});
