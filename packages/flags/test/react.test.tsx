// @vitest-environment happy-dom
// `@freecorps/ember-flags/react` against the client's FakeEmberServer: `useFlag` reads the live values of the app's
// forClient query (fallback while loading, when missing or of another type), and follows changes.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { EmberClient, anyApi, unsafeRef } from "@freecorps/ember-client";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { EmberProvider } from "@freecorps/ember-react";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { evaluateAll, type FlagDefinition } from "../src/eval.ts";
import { FlagsProvider, useFlag, useFlags, type FlagsQuery } from "../src/react.ts";

const api = anyApi as unknown as { flags: { forClient: FlagsQuery<{ context: { unitId: string } }> } };

afterEach(cleanup);

function setup() {
  const server = new FakeEmberServer({
    queries: {
      // What `ff.forClient(ctx, context)` returns: the client-visible flags, evaluated by the same pure evaluator.
      "flags:forClient": (db, a: any) => evaluateAll(db.all<FlagDefinition & { clientVisible: boolean }>("flags").filter((f) => f.clientVisible), a.context),
    },
    mutations: {
      "t:set": (db, f: any) => {
        const cur = db.all<any>("flags").find((x) => x.key === f.key);
        if (cur) db.patch("flags", cur._id, f);
        else db.insert("flags", { rules: [], enabled: true, clientVisible: true, ...f });
        return null;
      },
    },
  });
  const client = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, heartbeat: false, defaultShard: "global:main", backoff: { initialMs: 5, maxMs: 10 } });
  return { client, set: (f: Record<string, unknown>) => client.mutation(unsafeRef<"mutation">("t:set"), f) };
}

function Checkout() {
  const fresh = useFlag("newCheckout", false);
  const theme = useFlag("theme", "classic");
  const limit = useFlag("limit", 10);
  const { loading } = useFlags();
  return <p data-testid="out">{`${loading ? "loading" : "ready"}:${fresh}:${theme}:${limit}`}</p>;
}

describe("useFlag", () => {
  it("fallbacks while loading and for missing flags; live values; a value of another type keeps the fallback", async () => {
    const { client, set } = setup();
    try {
      await set({ key: "theme", type: "string", defaultValue: "classic", value: "fresh" });
      await set({ key: "limit", type: "string", defaultValue: "lots" });
      render(
        <EmberProvider client={client}>
          <FlagsProvider query={api.flags.forClient} args={{ context: { unitId: "u1" } }}>
            <Checkout />
          </FlagsProvider>
        </EmberProvider>,
      );
      expect(screen.getByTestId("out").textContent).toBe("loading:false:classic:10");
      await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("ready:false:fresh:10"));
      await act(() => set({ key: "newCheckout", type: "boolean", defaultValue: false }));
      await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("ready:true:fresh:10"));
      await act(() => set({ key: "newCheckout", enabled: false }));
      await waitFor(() => expect(screen.getByTestId("out").textContent).toBe("ready:false:fresh:10"));
    } finally {
      client.close();
    }
  });

  it("a null fallback accepts any value (typed unknown); a query that declares errors fits FlagsProvider", async () => {
    const { client, set } = setup();
    function Any() {
      const theme = useFlag("theme", null);
      // @ts-expect-error unknown: narrow it before use
      const upper: string = theme;
      void upper;
      return <p data-testid="any">{typeof theme === "string" ? theme : "none"}</p>;
    }
    // A generated reference keeps its declared errors and shard kind.
    const withErrors = api.flags.forClient as unknown as import("@freecorps/ember-values").FunctionReference<"query", "public", { context: { unitId: string } }, Record<string, unknown>, import("@freecorps/ember-values").ErrorSpec<"Forbidden", null>, { kind: "org" }>;
    try {
      await set({ key: "theme", type: "string", defaultValue: "classic", value: "fresh" });
      render(
        <EmberProvider client={client}>
          <FlagsProvider query={withErrors} args={{ context: { unitId: "u1" } }}>
            <Any />
          </FlagsProvider>
        </EmberProvider>,
      );
      await waitFor(() => expect(screen.getByTestId("any").textContent).toBe("fresh"));
    } finally {
      client.close();
    }
  });

  it("primitive fallbacks widen: a \"classic\" fallback is a string (compared with \"fresh\"), 10 a number, false a boolean", () => {
    // Types only (never called): `const` would otherwise keep the fallback's literal type.
    const typed = () => {
      const theme = useFlag("theme", "classic");
      const limit = useFlag("limit", 10);
      const fresh = useFlag("newCheckout", false);
      expectTypeOf(theme).toEqualTypeOf<string>();
      expectTypeOf(limit).toEqualTypeOf<number>();
      expectTypeOf(fresh).toEqualTypeOf<boolean>();
      expectTypeOf(useFlag("x", { a: 1 })).toEqualTypeOf<{ a: number }>();
      return theme === "fresh" && limit === 20 && fresh === true;
    };
    void typed;
  });

  it("outside a FlagsProvider: a clear error", () => {
    function Bare() {
      useFlag("x", 1);
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/FlagsProvider/);
  });
});
