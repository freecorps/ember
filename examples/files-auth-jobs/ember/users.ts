import { query } from "./_generated/server";

/**
 * Who is calling, as the Worker verified the JWT. `null` when signed out: the query still runs (the client decides
 * what to show), so a page can render its signed-out state from the same subscription.
 */
export const me = query({
  handler: (ctx) => {
    const identity = ctx.auth.getUserIdentity();
    if (!identity) return null;
    return {
      id: identity.subject,
      email: typeof identity.claims?.email === "string" ? identity.claims.email : null,
      name: typeof identity.claims?.name === "string" ? identity.claims.name : null,
    };
  },
});
