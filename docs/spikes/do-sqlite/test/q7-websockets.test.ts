import { SELF, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { report, stubFor } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(doName: string, tags: string[]) {
  const qs = new URLSearchParams([["do", doName], ...tags.map((t) => ["tag", t])]);
  const res = await SELF.fetch(`http://spike/ws?${qs}`, { headers: { Upgrade: "websocket" } });
  if (!res.webSocket) return { ws: null as WebSocket | null, status: res.status, text: await res.text() };
  const ws = res.webSocket;
  ws.accept();
  return { ws, status: res.status, text: "" };
}

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.addEventListener("message", (e) => { clearTimeout(t); resolve(String(e.data)); }, { once: true });
  });
}

describe("Q7 WebSocket hibernation", () => {
  it("tags, getWebSockets(tag), auto-response ping/pong, attachment, hibernation survival", async () => {
    const doName = "q7-basic";
    const stub = stubFor(doName);
    const a = await connect(doName, ["room:1", "user:a"]);
    const b = await connect(doName, ["room:2"]);
    const info1 = await stub.wsInfo("room:1");

    const pongP = nextMessage(a.ws!);
    a.ws!.send("ping");
    const pong = await pongP;
    await sleep(50);
    const info2 = await stub.wsInfo("room:1");

    const whoP = nextMessage(a.ws!);
    a.ws!.send("whoami");
    const whoBefore = await whoP;

    const constructedBefore = await stub.constructedCount();
    await evictDurableObject(stub); // default: hibernate websockets
    const who2P = nextMessage(a.ws!);
    a.ws!.send("whoami");
    const whoAfter = await who2P.catch((e) => `ERR ${e.message}`);
    const constructedAfter = await stub.constructedCount();
    const infoAfter = await stub.wsInfo("room:1");

    // tag limits
    const tooManyTags = await connect(doName, Array.from({ length: 11 }, (_, i) => `t${i}`));
    const tenTags = await connect(doName, Array.from({ length: 10 }, (_, i) => `t${i}`));
    const longTag = await connect(doName, ["x".repeat(257)]);
    const tag256 = await connect(doName, ["x".repeat(256)]);

    report("q7.basic", {
      taggedRoom1: info1.tagged, all: info1.all, tagsOfFirst: info1.tagsOfFirst, autoResponse: info1.autoResponse,
      pong, autoResponseTimestamps: info2.autoResponseTs, messagesSeenByHandler: info2.msgs,
      attachmentBeforeEvict: whoBefore, attachmentAfterEvict: whoAfter,
      constructorRuns: { before: constructedBefore, after: constructedAfter },
      socketsAfterEvict: infoAfter.all,
      tags11: tooManyTags.ws ? "accepted" : `${tooManyTags.status} ${tooManyTags.text}`,
      tags10: tenTags.ws ? "accepted" : `${tenTags.status} ${tenTags.text}`,
      tag257chars: longTag.ws ? "accepted" : `${longTag.status} ${longTag.text}`,
      tag256chars: tag256.ws ? "accepted" : `${tag256.status} ${tag256.text}`,
    });
    expect(pong).toBe("pong");
    expect(info1.tagged).toBe(1);
    expect(info2.msgs).not.toContain("ping");
  });

  it("serializeAttachment size limit", async () => {
    const doName = "q7-attach";
    const stub = stubFor(doName);
    await connect(doName, []);
    const r = await stub.attachmentLimits([1024, 2000, 2048, 2049, 4096, 16_000, 16_384, 16_385, 65_536, 1 << 20]);
    report("q7.attachment", r);
  });

  it("broadcast to N=200 sockets", async () => {
    const doName = "q7-broadcast";
    const stub = stubFor(doName);
    const N = 200;
    const tc0 = Date.now();
    const sockets: WebSocket[] = [];
    for (let i = 0; i < N; i++) sockets.push((await connect(doName, [i % 2 ? "odd" : "even"])).ws!);
    const connectMs = Date.now() - tc0;
    const results: any = { connectMs_sequential: connectMs };
    for (const [label, size] of [["small_32B", 32], ["1KB", 1024], ["64KB", 65536]] as const) {
      const msg = "m".repeat(size);
      const received = sockets.map((ws) => nextMessage(ws, 10_000));
      const t0 = Date.now();
      const r = await stub.broadcast(null, msg);
      const rpcMs = Date.now() - t0;
      await Promise.all(received);
      results[label] = { count: r.count, innerSendLoopMs: r.innerMs, rpcReturnMs: rpcMs, allReceivedMs: Date.now() - t0 };
    }
    const odd = sockets.filter((_, i) => i % 2).map((ws) => nextMessage(ws, 5000));
    const t1 = Date.now();
    const r2 = await stub.broadcast("odd", "odd-only");
    await Promise.all(odd);
    results.tagged_odd = { count: r2.count, allReceivedMs: Date.now() - t1 };
    report("q7.broadcast", results);
    expect(results.small_32B.count).toBe(N);
  });
});
