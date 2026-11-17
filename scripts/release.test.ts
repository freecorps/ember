// `publish` in release.ts with the outside replaced: which packages go out when one cannot be published.
//   bun test ./scripts/
import { expect, test } from "bun:test";
import { publish, type PublishIo, type Staged } from "./release.ts";

const pkg = (name: string): Staged => ({ name, version: "1.0.0", dir: name }) as Staged;

function run(opts: { deps?: Record<string, string[]>; fails?: string[]; published?: string[]; dryRun?: boolean }) {
  const sent: string[] = [];
  const lines: string[] = [];
  const io: PublishIo = {
    published: (name) => (opts.published ?? []).includes(name),
    npmPublish: (args, dir) => {
      if ((opts.fails ?? []).includes(dir)) throw new Error(`npm ${args.join(" ")} failed in ${dir}`);
      sent.push(dir);
    },
    requiredDeps: (dir) => opts.deps?.[dir] ?? [],
    log: (l) => lines.push(l),
  };
  // In dependency order, as `stage()` returns them.
  const staged = ["values", "server", "client", "agent", "agent-ui", "agent-kit", "runtime", "cli"].map(pkg);
  let error: Error | null = null;
  try {
    publish(staged, { provenance: true, tag: "latest", ...(opts.dryRun ? { dryRun: true } : {}) }, io);
  } catch (e) {
    error = e as Error;
  }
  return { sent, lines, error };
}

const deps = { server: ["values"], client: ["values"], agent: ["server"], "agent-ui": ["agent"], "agent-kit": ["agent-ui"], runtime: ["values", "server"], cli: ["server"] };

test("everything publishes, in order, when nothing fails", () => {
  const r = run({ deps });
  expect(r.error).toBeNull();
  expect(r.sent).toEqual(["values", "server", "client", "agent", "agent-ui", "agent-kit", "runtime", "cli"]);
});

test("a package that fails, and what needs it (directly or through another), is left out; the rest still goes", () => {
  const r = run({ deps, fails: ["agent"] });
  expect(r.sent).toEqual(["values", "server", "client", "runtime", "cli"]);
  expect(r.error?.message).toBe("3 package(s) not published: agent, agent-ui, agent-kit (fix the cause and run again: published versions are skipped)");
  expect(r.lines).toContain("not published: agent-ui@1.0.0 (depends on agent, which was not published)");
  expect(r.lines).toContain("not published: agent-kit@1.0.0 (depends on agent-ui, which was not published)");
});

test("published versions are skipped, so a second run sends only what was left", () => {
  const r = run({ deps, published: ["values", "server", "client", "runtime", "cli"] });
  expect(r.sent).toEqual(["agent", "agent-ui", "agent-kit"]);
  expect(r.error).toBeNull();
});

test("a dependency that is already published does not block, even when it was skipped", () => {
  const r = run({ deps, published: ["values"], fails: ["client"] });
  expect(r.sent).toEqual(["server", "agent", "agent-ui", "agent-kit", "runtime", "cli"]);
  expect(r.error?.message).toMatch(/^1 package\(s\) not published: client /);
});
