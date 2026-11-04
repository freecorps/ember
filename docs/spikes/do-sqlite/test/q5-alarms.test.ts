import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { report, stubFor } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Q5 alarms", () => {
  it("one alarm per DO: setAlarm overwrite, deleteAlarm, past alarm", async () => {
    const stub = stubFor("q5-overwrite");
    const r = await runInDurableObject(stub, async (_i, state) => {
      const st = state.storage;
      const base = Date.now();
      await st.setAlarm(base + 60_000);
      const a1 = await st.getAlarm();
      await st.setAlarm(base + 120_000);
      const a2 = await st.getAlarm();
      await st.setAlarm(base + 30_000); // earlier overwrite also wins (last write wins, not min)
      const a3 = await st.getAlarm();
      await st.deleteAlarm();
      const a4 = await st.getAlarm();
      let dateObj: unknown;
      await st.setAlarm(new Date(base + 5_000));
      dateObj = (await st.getAlarm())! - base;
      await st.deleteAlarm();
      return { a1: a1! - base, a2: a2! - base, a3: a3! - base, afterDelete: a4, dateObjectAccepted_offset: dateObj };
    });
    report("q5.overwrite", r);
    expect(r.a2).toBe(120_000);
    expect(r.a3).toBe(30_000);
    expect(r.afterDelete).toBeNull();
  });

  it("alarm fires on its own locally (no runDurableObjectAlarm)", async () => {
    const stub = stubFor("q5-fires");
    const t0 = Date.now();
    await stub.configureRetryTest(0, 200);
    let log: any[] = [];
    for (let i = 0; i < 50 && log.length === 0; i++) { await sleep(100); log = await stub.getMemLog(); }
    const fired = log.length ? log[0].at - t0 : null;
    const after = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
    report("q5.fires", { firedAfterMs: fired, log, alarmAfterSuccess: after });
    expect(log.length).toBe(1);
  });

  it("retry behaviour when alarm() throws (3 failures then success)", async () => {
    const stub = stubFor("q5-retry");
    const t0 = Date.now();
    await stub.configureRetryTest(3, 100);
    let log: any[] = [];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(250);
      log = await stub.getMemLog();
      if (log.length >= 4) break;
    }
    await sleep(200);
    const sqlLog = await stub.alarmLog();
    const deltas = log.map((e, i) => (i === 0 ? e.at - t0 : e.at - log[i - 1].at));
    report("q5.retry", { attempts: log.length, deltasMs: deltas, memLog: log, sqlLogRowsPersisted: sqlLog });
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it.runIf(process.env.RUN_LONG === "1")("retry limit: alarm that always throws", async () => {
    const stub = stubFor("q5-retry-limit");
    const t0 = Date.now();
    await stub.configureRetryTest(1000, 100);
    let log: any[] = [];
    let lastChange = Date.now();
    const deadline = Date.now() + 280_000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const l = await stub.getMemLog();
      if (l.length !== log.length) { log = l; lastChange = Date.now(); }
      if (Date.now() - lastChange > 100_000) break; // no new attempt for 100s => gave up
    }
    const pending = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
    const deltas = log.map((e, i) => (i === 0 ? e.at - t0 : e.at - log[i - 1].at));
    report("q5.retry_limit", { attempts: log.length, deltasMs: deltas, retryCounts: log.map((e) => e.retryCount), alarmStillSet: pending });
  }, 300_000);

  it("multiplexed scheduler: 3 jobs + one scheduled during alarm execution", async () => {
    const stub = stubFor("q5-scheduler");
    const t0 = Date.now();
    await stub.schedule("job-900", 900);
    await stub.schedule("job-300", 300);
    await stub.schedule("spawner-450", 450).then(() => 0);
    // rename: the DO spawns a child when name === 'spawner'
    await stub.schedule("spawner", 500);
    await stub.schedule("job-600", 600);
    const initial = await stub.schedulerState();
    let state = initial;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      state = await stub.schedulerState();
      if (state.jobs.length === 0 && state.runs.length >= 6) break;
    }
    const runs = state.runs.map((r: any) => ({ name: r.name, dueOffset: r.run_at - t0, ranOffset: r.ran_at - t0, latenessMs: r.ran_at - r.run_at }));
    report("q5.scheduler", { initialAlarmOffset: initial.alarm! - t0, initialJobs: initial.jobs.length, runs, remainingJobs: state.jobs, alarmAfter: state.alarm });
    expect(runs.map((r) => r.name)).toEqual(["job-300", "spawner-450", "spawner", "job-600", "spawned-child", "job-900"]);
    expect(state.alarm).toBeNull();
  });
});
