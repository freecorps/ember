import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../src/config.ts";
import { CfClient } from "../src/deploy/cf.ts";
import { waitForShards } from "../src/deploy/wait.ts";
import { envGet } from "../src/env.ts";
import { AdminClient } from "../src/import-convex.ts";
import { rotateKeys } from "../src/keys.ts";
import { listBookmarks } from "../src/restore.ts";
import { resolveBaseUrl, run } from "../src/run.ts";
import { checkCredentialUrl, isLoopbackHost } from "../src/secure-url.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const noEnv = { env: {} };

describe("checkCredentialUrl", () => {
  it("accepts https anywhere, with or without a path prefix", () => {
    expect(checkCredentialUrl("https://app.example.com", noEnv).host).toBe("app.example.com");
    expect(checkCredentialUrl("https://app.example.com/ember/", noEnv).pathname).toBe("/ember/");
    expect(checkCredentialUrl("https://10.0.0.5:8443", noEnv).hostname).toBe("10.0.0.5");
  });

  it("accepts plain http only on loopback (what `ember dev` binds)", () => {
    for (const u of [
      "http://127.0.0.1:8787",
      "http://localhost:8787",
      "http://LOCALHOST:8787/",
      "http://localhost.:8787",
      "http://127.0.0.2:9000",
      "http://[::1]:8787",
      "http://[::1]:8787/prefix/path",
      "http://[0:0:0:0:0:0:0:1]:8787",
      "http://[::ffff:127.0.0.1]:8787",
    ]) {
      expect(() => checkCredentialUrl(u, noEnv), u).not.toThrow();
    }
  });

  it("refuses plain http to any other host, saying why and how to proceed", () => {
    for (const u of [
      "http://app.example.com",
      "http://app.example.com/ember",
      "http://192.168.1.20:8787",
      "http://0.0.0.0:8787",
      "http://[::2]:8787",
      "http://[fe80::1]:8787",
      "http://localhost.example.com",
      "http://127.0.0.1.nip.io",
      "http://[::ffff:10.0.0.1]",
    ]) {
      expect(() => checkCredentialUrl(u, noEnv), u).toThrow(/plain http.*EMBER_ALLOW_INSECURE_HTTP=1/s);
    }
    expect(() => checkCredentialUrl("http://x.example", { ...noEnv, what: "the Convex deploy key" })).toThrow(/Refusing to send the Convex deploy key/);
  });

  it("refuses other schemes and invalid URLs", () => {
    expect(() => checkCredentialUrl("ftp://x.example", noEnv)).toThrow(/only https/);
    expect(() => checkCredentialUrl("x.example:8787", noEnv)).toThrow();
    expect(() => checkCredentialUrl("not a url", noEnv)).toThrow(/not a valid URL/);
  });

  it("EMBER_ALLOW_INSECURE_HTTP=1 allows remote http with one warning per origin", () => {
    const lines: string[] = [];
    const opts = { env: { EMBER_ALLOW_INSECURE_HTTP: "1" }, warn: (l: string) => lines.push(l) };
    expect(checkCredentialUrl("http://192.168.77.5:8787", opts).hostname).toBe("192.168.77.5");
    checkCredentialUrl("http://192.168.77.5:8787/again", opts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/warning: sending the admin token to http:\/\/192\.168\.77\.5:8787 over plain http/);
    expect(() => checkCredentialUrl("http://192.168.77.6", { env: { EMBER_ALLOW_INSECURE_HTTP: "0" } })).toThrow(/plain http/);
    // Loopback and https never warn.
    checkCredentialUrl("http://127.0.0.1:1", opts);
    checkCredentialUrl("https://x.example", opts);
    expect(lines).toHaveLength(1);
  });

  it("isLoopbackHost takes URL hostnames (bracketed IPv6) and bare ones", () => {
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("127.255.0.1")).toBe(true);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
  });
});

describe("admin-token senders refuse before any request", () => {
  let project: Project;
  const prev = process.env.EMBER_ALLOW_INSECURE_HTTP;
  beforeAll(() => {
    project = sampleProject("secure-url");
    delete process.env.EMBER_ALLOW_INSECURE_HTTP;
  });
  afterAll(() => {
    cleanup(project);
    if (prev !== undefined) process.env.EMBER_ALLOW_INSECURE_HTTP = prev;
  });

  // Every request (Cloudflare API or Worker) lands here: none may reach the plain-http URL.
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.href);
    return Response.json({ success: true, errors: [], result: [{ name: "X" }] });
  }) as typeof fetch;
  const client = () => new CfClient({ accountId: "acc", token: "t", fetch: fetchImpl, sleep: async () => {} });
  const remote = "http://ember.example";

  it("deploy --wait", async () => {
    requests.length = 0;
    await expect(waitForShards({ url: remote, adminToken: "t", expectedVersion: "v", fetch: fetchImpl, log: () => {} })).rejects.toThrow(/plain http/);
    expect(requests).toEqual([]);
  });

  it("env get --reveal", async () => {
    requests.length = 0;
    await expect(envGet({ client: client(), project, env: "prod", worker: "w" }, "X", { reveal: true, url: remote, adminToken: "t", fetch: fetchImpl })).rejects.toThrow(/plain http/);
    expect(requests.some((r) => r.startsWith(remote))).toBe(false);
  });

  it("keys rotate (before any Cloudflare call)", async () => {
    requests.length = 0;
    await expect(rotateKeys({ client: client(), worker: "w", url: remote, adminToken: "t", kinds: ["jwt"], fetch: fetchImpl, log: () => {} })).rejects.toThrow(/plain http/);
    expect(requests).toEqual([]);
  });

  it("import / export / restore / migrations (resolveBaseUrl and the admin clients)", async () => {
    requests.length = 0;
    expect(() => resolveBaseUrl(project, { url: remote })).toThrow(/plain http/);
    expect(resolveBaseUrl(project, { url: "http://[::1]:8787/base" })).toBe("http://[::1]:8787/base");
    expect(() => new AdminClient({ url: `${remote}/prefix`, adminToken: "t", fetch: fetchImpl })).toThrow(/plain http/);
    await expect(listBookmarks({ url: remote, adminToken: "t", fetch: fetchImpl }, "global:main")).rejects.toThrow(/plain http/);
    expect(requests).toEqual([]);
  });

  it("`ember run --token` checks the URL; without a token it does not", async () => {
    requests.length = 0;
    await expect(run(project, { fn: "messages:list", kind: "query", url: remote, token: "jwt", fetch: fetchImpl })).rejects.toThrow(/Refusing to send the --token bearer token/);
    expect(requests).toEqual([]);
    await run(project, { fn: "messages:list", kind: "query", url: remote, fetch: fetchImpl });
    expect(requests).toEqual([`${remote}/api/query`]);
  });
});
