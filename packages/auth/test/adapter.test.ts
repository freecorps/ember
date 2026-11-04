/**
 * Better Auth's official adapter conformance suite (@better-auth/test-utils) against DO SQLite.
 * Each adapter call runs inside the DO via runInDurableObject; transactions use
 * ctx.storage.transaction(). FKs are off here (the suite inserts dangling references, like other
 * SQL adapters' suites); the Auth DO itself runs with FKs (covered by flows.test.ts).
 */
import { env, runInDurableObject } from "cloudflare:test";
import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  joinsTestSuite,
  normalTestSuite,
  numberIdTestSuite,
  testAdapter,
  transactionsTestSuite,
  uuidTestSuite,
} from "@better-auth/test-utils/adapter";
import { doSqliteAdapter, sqlStorageExecutor, type SqlExecutor } from "../src/adapter.ts";
import { migrate } from "../src/ddl.ts";

const stub = env.SQLBOX.get(env.SQLBOX.idFromName("adapter-conformance"));

const executor: SqlExecutor = {
  exec: (query, params) =>
    runInDurableObject(stub, (_i, state) => {
      const c = state.storage.sql.exec(query, ...params);
      return { rows: c.toArray() as Record<string, unknown>[], rowsWritten: c.rowsWritten };
    }),
  transaction: (fn) => runInDurableObject(stub, (_i, state) => state.storage.transaction(() => fn(sqlStorageExecutor(state.storage.sql)))),
};

const { execute } = await testAdapter({
  adapter: () => doSqliteAdapter(executor, { debugLogs: { isRunningAdapterTests: true } }),
  runMigrations: (options) =>
    runInDurableObject(stub, (_i, state) => {
      migrate(state.storage.sql, options, { destructive: true, withReferences: false });
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
