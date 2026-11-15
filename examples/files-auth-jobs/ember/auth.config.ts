// Better Auth options for this project's Auth Durable Object. Ember adds the database, the secret, the bearer() and
// jwt() plugins; you describe the rest.
import { defineAuth } from "@freecorps/ember-auth";
import { organization } from "better-auth/plugins";

export default defineAuth({
  emailAndPassword: { enabled: true },
  // Browsers send an Origin header and Better Auth refuses origins it does not know. The Vite dev server (web/) is
  // one; add your site's origin when you deploy the web app somewhere else.
  trustedOrigins: ["http://localhost:5173"],
  user: { deleteUser: { enabled: true } },
  plugins: [
    // Organizations, members, invitations and teams. This example sends no invitation email: the invitee lists their
    // invitations (`/api/auth/organization/list-user-invitations`) and accepts one.
    organization({ teams: { enabled: true }, async sendInvitationEmail() {} }),
  ],
  ember: {
    // Each organization's Better Auth rows (organization, members, invitations, teams, and its members' users) are
    // copied into the shard `org:<organizationId>` as read-only `auth:*` tables: functions there check membership with
    // a local read (ember/orgs.ts).
    replicate: { organization: true },
  },
});
