# Multi-shard load benchmark on Cloudflare (Phase 4 done-criterion)

Run on 2026-11-05 between 01:30 and 01:36 UTC on the FreeCorps account (`<ACCOUNT_ID>`), against
`https://ember-spike-ops-test.<subdomain>.workers.dev`. Every resource was named `ember-spike-*` and deleted at the end
(see `ops-e2e.md`, Cleanup).

- **Target.** A real Ember project (`ember init --auth`, project `spike-ops`, env `test`) deployed with `ember deploy`:
  Shard/System/Auth Durable Objects, the current runtime from this branch, metrics disabled (no Analytics Engine
  writes in the hot path). Table `items { n, sentAt, body }` with index `by_n`. Functions:
  - `bench:put`: insert one 64-byte row, so each mutation writes the document, its index key and the change log;
  - `bench:recent`: `withIndex("by_n").order("desc").take(10)`;
  - `bench:latest`: the newest row.
- **Load generator.** `docs/spikes/remote/workers/loadgen.js`, deployed as `ember-spike-ops-loadgen`.
  - Each task runs in its own Durable Object "agent", so each has its own isolate, CPU and connection budget.
  - Agents drive the target over its public workers.dev URL. Mutations use the real WebSocket protocol
    (`hello`, pipelined `mut` frames, `mres` acks); queries use `sub`/`snap`/`unsub` and `POST /api/query`.
  - The coordinator ran in GIG. Agents landed in **IAD and EWR**, and so did the shards they created (DOs are placed
    near their first request).
  - The laptop only started the runs, so the numbers are not bounded by its link.
- **Reproduce.** `bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/ops-e2e.ts deploy bench cleanup`.
  `BENCH_ONLY=B1,B4` runs a subset.
- **Latency.** Wall clock in the agent, from send to receive. In Workers, `Date.now()` advances with I/O, so a receive
  event reads the current time.
- **Raw numbers.** `evidence/ops-bench.json`. `evidence/ops-e2e-bench.txt` is the log of the B4 rerun only: the first
  run's log was overwritten, and its B1–B3 numbers were kept in the JSON.
- **Load.** About 2.5 minutes of load in total, at moderate rates.

## Results

### B1. Mutations across many shards (1 WebSocket per shard, 50 in flight, 20 s)

| Shards | Total mutations | Mutations/s | Ack p50 / p95 / p99 (ms) | Per shard: mutations/s min / p50 / max | Mutations per commit | Errors |
|---|---|---|---|---|---|---|
| 8 | 114,563 | **5,683** | 59 / 111 / 137 | 457 / 810 / 978 | 25.0 | 0 |
| 32 | 465,679 | **23,158** | 59 / 123 / 152 | 331 / 780 / 1,098 | 27.7 | 0 |

- **Throughput scales linearly with shards.** Each shard does about 0.7–0.8k mutations/s at 50 in flight, with
  group commit merging about 26 mutations per durable commit.
- **Acks.** The ack p50 is 59 ms at both sizes, and per-shard ack p50s are flat (p95 across shards is 103–130 ms).
  Shards do not slow each other down (PLAN §19, "Previsibilidade").
- **"Mutations per commit"** is the mutations acknowledged divided by how much the shard's `version` advanced, read
  from `/api/_ember/status` before and after the run. One version step is one group-committed `transactionSync` with
  changes.

### B2. One hot shard, group commit

| In flight (6 sockets × window) | Mutations/s | Ack p50 / p95 / p99 (ms) | Mutations per commit | Commits/s |
|---|---|---|---|---|
| 60 (6×10) | 660 | 87 / 112 / 149 | 10.7 | 62 |
| 600 (6×100) | **1,479** | 380 / 522 / 639 | **96.8** | 15 |

- **Group commit does its job.** With 10× more in flight, the batch grows from 11 to 97 mutations per commit and
  throughput goes up 2.2×.
- **The hot shard is bound by per-batch work.** 97 mutations take about 65 ms per commit cycle. About 30 ms of that is
  the durable write (X2), so the rest, roughly 0.3 ms per mutation, is runtime work: decoding the frame, validation,
  index keys, the change log, dedup rows, `mres`/patch frames.
- **Compared with the X1 microbenchmark.** X1 measured about 20 µs per raw 3-row insert. The full Ember path costs about
  10× more per mutation. This is the next optimisation target for a single hot shard; profiling is needed. Today a hot
  shard sustains about 1.5k mutations/s with an ack p50 of 0.4 s.
- **Takeaway.** Scale throughput by spreading writes over shards: B1 shows 23k/s with 32 shards.

### B3. Queries

| Mode | Shards | Queries/s | Latency p50 / p95 / p99 (ms) | Per shard: q/s min / p50 / max | Errors |
|---|---|---|---|---|---|
| WebSocket `sub` → `snap` → `unsub` (1 socket per shard, 20 in flight) | 32 | **11,671** | 46 / 94 / 126 | 195 / 395 / 601 | 0 |
| HTTP `POST /api/query` (16 agents × 8 concurrent) | 8 | 1,618 | 44 / 91 / 180 | 101 / 175 / 436 | 0 |

- **Each WebSocket query cycle is a subscription.** It registers the subscription in `_ember_subs`, runs the query
  with distinct args (no shared cache), sends the snapshot and unregisters, so it costs more than a bare query.
- **The HTTP number is bound by the client, not the shards.** 128 concurrent requests × 44 ms ≈ 2.9k/s at most. An
  agent also has a budget of subrequests and simultaneous connections (see the limits below).

### B4. Subscription fan-out

One shard; N sockets subscribe to `bench:latest`; one writer sends 20 mutations 500 ms apart, carrying
`sentAt = Date.now()`. Delivery is the time from the writer's send to the `patch` arriving at each subscriber.
Subscribers and the writer run on different agents, so cross-machine clock skew (NTP, normally a few ms) is part of
the number.

| Subscribers | Patches received / expected | Delivery p50 / p95 / p99 / max (ms) | Writer ack p50 / p95 (ms) |
|---|---|---|---|
| 100 | 2,000 / 2,000 | 44 / 60 / 115 / 305 | 46 / 61 |
| 430 (of 500 attempted) | 8,600 / 8,600 | **61 / 86 / 91** / 196 | 65 / 97 |

- **No patch was lost.** At 430 subscribers the slowest patch arrived within 91 ms (p99). R4 measured ~100 µs per socket
  for the send loop, so 430 sockets add about 40 ms on the DO, which matches the 17 ms rise in p50 over the
  100-subscriber run.
- **The 500 run connected 430 subscribers.** 14 of its 100 agents could not open their sockets within 20 s. All 500
  upgrades hit one shard within about a second. The target Worker and DO accepted 430 of them in that window, and
  the rest timed out on the agents.
- **Stagger socket opens in benchmarks.** Real clients spread their connects. The 100-subscriber run's `subscribeMs`
  max of 6.3 s points the same way: a connection burst queues up.

### Load-generator limits found on the way

- **An invocation holds at most 6 open outgoing connections, and established WebSockets count toward that.**
  - A probe opened 12 sockets from one agent for a 3 s run. It took 3.7 s: 6 sockets ran, and the other 6 opened only
    after those closed.
  - The fan-out runs therefore use 5 sockets per agent and up to 100 agents.
  - This constrains any Worker-side client of Ember too: an action that opens WebSockets to shards (for example to
    subscribe) can hold 6 at a time.
- **HTTP benchmarks are capped by subrequests.** Each agent stops after 900 `fetch` calls to stay under the
  per-invocation subrequest cap. WebSocket messages are not subrequests, which is why the mutation and query runs use
  WebSockets.

## What this means (PLAN §19, §20)

- **Phase 4 done-criterion.** Multi-shard load is met: 23k mutations/s on 32 shards with linear scaling, 11.7k
  query cycles/s, fan-out to 430 subscribers with p99 < 100 ms, and zero errors in every run.
- **Per shard.**
  - About 0.8k mutations/s at moderate concurrency, and about 1.5k/s when hot (with 600 in flight).
  - The ~1k req/s per DO guideline in PLAN §15 holds for the full Ember path.
  - Group commit lifts a hot shard 2.2×. It is CPU-bound per batch, not output-gate-bound.
- **Latency inside a region** (client and DO in IAD/EWR):
  - mutation ack p50 59 ms (includes the ~30 ms output gate and the Worker hop);
  - query p50 44–46 ms;
  - patch fan-out p50 44–61 ms.
- **Next optimisation.** Per-mutation runtime overhead on a hot shard (~0.3 ms vs 20 µs of SQL). The likely
  candidates are JSON encode/decode of frames and the change log, plus the dedup insert per WebSocket mutation.
