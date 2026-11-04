/**
 * Better Auth's OFFICIAL adapter conformance suite (@better-auth/test-utils),
 * run inside workerd against a real SQLite-backed Durable Object.
 *
 * Each adapter call is executed inside the DO's I/O context via
 * runInDurableObject; transactions use ctx.storage.transaction().
 */
import { env, runInDurableObject } from "cloudflare:test";
import {
  testAdapter,
  normalTestSuite,
  transactionsTestSuite,
  authFlowTestSuite,
  joinsTestSuite,
  numberIdTestSuite,
  uuidTestSuite,
  caseInsensitiveTestSuite,
} from "@better-auth/test-utils/adapter";
import { doSqliteAdapter, sqlStorageExecutor, type SqlExecutor } from "../src/do-sqlite-adapter";
import { migrate } from "../src/ddl";

// DO SQLite enforces foreign keys (cannot be disabled; only deferred). The
// conformance suite inserts rows with dangling references, like other SQL
// adapters' suites do with FK enforcement off, so FK constraints are opt-in.
declare const __WITH_FK__: string;
const WITH_FK = __WITH_FK__ === "1";
console.log(`[adapter-conformance] foreign keys: ${WITH_FK}`);

const stub = env.AUTH_SHARD.get(env.AUTH_SHARD.idFromName("adapter-conformance"));

const executor: SqlExecutor = {
  exec: (query, params) =>
    runInDurableObject(stub, (_i, state) => {
      const c = state.storage.sql.exec(query, ...params);
      return { rows: c.toArray() as Record<string, unknown>[], rowsWritten: c.rowsWritten };
    }),
  transaction: (fn) =>
    runInDurableObject(stub, (_i, state) =>
      state.storage.transaction(() => fn(sqlStorageExecutor(state.storage.sql))),
    ),
};

const { execute } = await testAdapter({
  adapter: () => doSqliteAdapter(executor, { debugLogs: { isRunningAdapterTests: true } }),
  runMigrations: (options) =>
    runInDurableObject(stub, (_i, state) => {
      migrate(state.storage.sql, options, { destructive: true, withReferences: WITH_FK });
    }),
  tests: [
    normalTestSuite(),
    transactionsTestSuite(),
    authFlowTestSuite(),
    joinsTestSuite(),
    numberIdTestSuite(),
    uuidTestSuite(),
    caseInsensitiveTestSuite(),
  ],
});

execute();
