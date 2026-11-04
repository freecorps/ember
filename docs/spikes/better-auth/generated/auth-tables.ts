// AUTO-GENERATED from Better Auth options. Do not edit.
import { defineTable, v } from "@engine/schema";

export const authTables = {
  "user": defineTable({
    name: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.union(v.null(), v.string())),
    createdAt: v.number() /* epoch ms */,
    updatedAt: v.number() /* epoch ms */,
    twoFactorEnabled: v.optional(v.union(v.null(), v.boolean())),
  }, { table: "user", owner: "auth", readonly: true })
    .unique("email"),
  "session": defineTable({
    expiresAt: v.number() /* epoch ms */,
    token: v.string(),
    createdAt: v.number() /* epoch ms */,
    updatedAt: v.number() /* epoch ms */,
    ipAddress: v.optional(v.union(v.null(), v.string())),
    userAgent: v.optional(v.union(v.null(), v.string())),
    userId: v.id("user") /* cascade */,
    activeOrganizationId: v.optional(v.union(v.null(), v.string())),
  }, { table: "session", owner: "auth", readonly: true })
    .index("session_userId_idx", ["userId"])
    .unique("token"),
  "account": defineTable({
    accountId: v.string(),
    providerId: v.string(),
    userId: v.id("user") /* cascade */,
    accessToken: v.optional(v.union(v.null(), v.string())),
    refreshToken: v.optional(v.union(v.null(), v.string())),
    idToken: v.optional(v.union(v.null(), v.string())),
    accessTokenExpiresAt: v.optional(v.union(v.null(), v.number() /* epoch ms */)),
    refreshTokenExpiresAt: v.optional(v.union(v.null(), v.number() /* epoch ms */)),
    scope: v.optional(v.union(v.null(), v.string())),
    password: v.optional(v.union(v.null(), v.string())),
    createdAt: v.number() /* epoch ms */,
    updatedAt: v.number() /* epoch ms */,
  }, { table: "account", owner: "auth", readonly: true })
    .index("account_userId_idx", ["userId"]),
  "verification": defineTable({
    identifier: v.string(),
    value: v.string(),
    expiresAt: v.number() /* epoch ms */,
    createdAt: v.number() /* epoch ms */,
    updatedAt: v.number() /* epoch ms */,
  }, { table: "verification", owner: "auth", readonly: true })
    .index("verification_identifier_idx", ["identifier"]),
  "organization": defineTable({
    name: v.string(),
    slug: v.string(),
    logo: v.optional(v.union(v.null(), v.string())),
    createdAt: v.number() /* epoch ms */,
    metadata: v.optional(v.union(v.null(), v.string())),
  }, { table: "organization", owner: "auth", readonly: true })
    .unique("slug"),
  "member": defineTable({
    organizationId: v.id("organization") /* cascade */,
    userId: v.id("user") /* cascade */,
    role: v.string(),
    createdAt: v.number() /* epoch ms */,
  }, { table: "member", owner: "auth", readonly: true })
    .index("member_organizationId_idx", ["organizationId"])
    .index("member_userId_idx", ["userId"]),
  "invitation": defineTable({
    organizationId: v.id("organization") /* cascade */,
    email: v.string(),
    role: v.optional(v.union(v.null(), v.string())),
    status: v.string(),
    expiresAt: v.number() /* epoch ms */,
    createdAt: v.number() /* epoch ms */,
    inviterId: v.id("user") /* cascade */,
  }, { table: "invitation", owner: "auth", readonly: true })
    .index("invitation_organizationId_idx", ["organizationId"])
    .index("invitation_email_idx", ["email"]),
  "jwks": defineTable({
    publicKey: v.string(),
    privateKey: v.string(),
    createdAt: v.number() /* epoch ms */,
    expiresAt: v.optional(v.union(v.null(), v.number() /* epoch ms */)),
    alg: v.optional(v.union(v.null(), v.string())),
    crv: v.optional(v.union(v.null(), v.string())),
  }, { table: "jwks", owner: "auth", readonly: true }),
  "twoFactor": defineTable({
    secret: v.string(),
    backupCodes: v.string(),
    userId: v.id("user") /* cascade */,
    verified: v.optional(v.union(v.null(), v.boolean())),
    failedVerificationCount: v.optional(v.union(v.null(), v.number())),
    lockedUntil: v.optional(v.union(v.null(), v.number() /* epoch ms */)),
  }, { table: "twoFactor", owner: "auth", readonly: true })
    .index("twoFactor_secret_idx", ["secret"])
    .index("twoFactor_userId_idx", ["userId"]),
};
