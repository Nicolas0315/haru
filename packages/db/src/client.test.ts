import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it } from "vitest";

import { DEFAULT_QUERY_BUDGET_MS, withQueryBudget } from "./client.js";
import { fleets } from "./schema/index.js";

interface RecordedCall {
  readonly query: string;
  readonly params: unknown[] | undefined;
  readonly options: Record<string, unknown> | undefined;
}

/**
 * A stand-in for the Neon HTTP client that records what it was handed.
 * The budget is asserted against the call the driver would really make,
 * so a wrapper that misses the path drizzle takes cannot pass.
 */
function fakeClient(
  behavior: (signal: AbortSignal | undefined) => Promise<unknown> = () =>
    Promise.resolve([]),
) {
  const calls: RecordedCall[] = [];
  const client = {
    query: async (
      query: string,
      parameters?: unknown[],
      options?: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ query, params: parameters, options });
      const fetchOptions = options?.fetchOptions as
        | { signal?: AbortSignal }
        | undefined;
      return behavior(fetchOptions?.signal);
    },
    // Present so the "everything else passes through" assertion has
    // something to reach for, and to mirror the real client's shape.
    unsafe: (text: string) => text,
  };
  return { client, calls };
}

/** Reject when the signal aborts, mirroring how fetch behaves. */
async function hangUntilAborted(signal: AbortSignal | undefined) {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
  });
}

function activeTimerCount(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
}

/**
 * Read the fetch options off a recorded call, failing the test rather
 * than returning undefined: every assertion below is about what the
 * wrapper HANDED the client, so a missing call is a failure, not a
 * nullable value to thread around.
 */
function fetchOptionsOf(call: RecordedCall | undefined): {
  readonly signal: AbortSignal;
  readonly [key: string]: unknown;
} {
  const options = call?.options?.fetchOptions;
  expect(options).toBeDefined();
  return options as { readonly signal: AbortSignal };
}

describe("withQueryBudget", () => {
  it("attaches a per-call AbortSignal to the query drizzle actually issues", async () => {
    const { client, calls } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);

    await budgeted.query("select 1", []);

    expect(calls).toHaveLength(1);
    const fetchOptions = fetchOptionsOf(calls[0]);
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(fetchOptions.signal.aborted).toBe(false);
  });

  it("gives each call its own signal", async () => {
    const { client, calls } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);

    await budgeted.query("select 1", []);
    await budgeted.query("select 2", []);

    const first = fetchOptionsOf(calls[0]).signal;
    const second = fetchOptionsOf(calls[1]).signal;
    // A shared signal would abort every later query the moment the first
    // budget expired.
    expect(first).not.toBe(second);
  });

  // A tiny real budget rather than fake timers: the assertion is that a
  // promise rejects, and a 20ms wait states that more directly than
  // driving the clock would.
  it("rejects once the budget elapses, so a hung store surfaces as a throw", async () => {
    const { client } = fakeClient(hangUntilAborted);
    const budgeted = withQueryBudget(client, 20);

    await expect(budgeted.query("select 1", [])).rejects.toThrow();
  });

  it("leaves a query that answers inside the budget untouched", async () => {
    const { client, calls } = fakeClient(() => Promise.resolve([{ ok: true }]));
    const budgeted = withQueryBudget(client, 10_000);

    await expect(budgeted.query("select 1", [])).resolves.toEqual([
      { ok: true },
    ]);
    const fetchOptions = fetchOptionsOf(calls[0]);
    // The signal is scoped to the attempt: a query that answered is never
    // reported as aborted, whatever the budget was.
    expect(fetchOptions.signal.aborted).toBe(false);
  });

  it("preserves the options drizzle sets and merges caller fetchOptions", async () => {
    const { client, calls } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);

    await budgeted.query("select 1", ["a"], {
      arrayMode: true,
      fullResults: true,
      authToken: "token",
      fetchOptions: { priority: "high" },
    });

    const options = calls[0]?.options;
    expect(options?.arrayMode).toBe(true);
    expect(options?.fullResults).toBe(true);
    expect(options?.authToken).toBe("token");
    const fetchOptions = fetchOptionsOf(calls[0]);
    // Replacing fetchOptions instead of merging would silently drop
    // whatever the caller had set.
    expect(fetchOptions.priority).toBe("high");
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.params).toEqual(["a"]);
  });

  it("composes a caller-supplied signal instead of dropping it", async () => {
    const { client, calls } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);
    const callerController = new AbortController();

    await budgeted.query("select 1", [], {
      fetchOptions: { signal: callerController.signal },
    });

    const { signal } = fetchOptionsOf(calls[0]);
    expect(signal.aborted).toBe(false);
    // Overwriting the caller's signal would make their cancellation a
    // no-op, silently.
    callerController.abort(new Error("caller cancelled"));
    expect(signal.aborted).toBe(true);
  });

  it("clears the budget timer once the query settles", async () => {
    const { client } = fakeClient();
    const budgeted = withQueryBudget(client, 60_000);
    const timersBefore = activeTimerCount();

    for (let attempt = 0; attempt < 5; attempt++) {
      await budgeted.query("select 1", []);
    }

    // Measured as a delta because the test runner keeps timers of its
    // own. A leak would hold one 60s timer per query, so five queries
    // would leave five behind and keep the event loop alive.
    expect(activeTimerCount()).toBe(timersBefore);
  });

  it("passes every other property through untouched", () => {
    const { client } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);

    expect(budgeted.unsafe("raw")).toBe("raw");
  });

  // The load-bearing test: drizzle resolves `client.query ?? client` once
  // at construction, so a wrapper that budgets the wrong path compiles,
  // passes every unit test above, and never applies to a real query.
  // Only driving real drizzle proves which path is taken.
  it("applies the budget to the query real drizzle issues", async () => {
    const { client, calls } = fakeClient();
    const database = drizzle({
      client: withQueryBudget(client, 5000) as never,
      schema: { fleets },
    });

    // The fake returns [] rather than a Neon result envelope, so drizzle
    // may reject while mapping it. Irrelevant here: the recording happens
    // when the query is ISSUED, which is what is under test.
    try {
      await database.select().from(fleets).limit(1);
    } catch {
      // response-shape mismatch only
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("fleets");
    expect(fetchOptionsOf(calls[0]).signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults to a budget that is bounded and well under undici's", () => {
    // The point of the constant is that it exists and is small; pinning
    // the exact number would just restate the source.
    expect(DEFAULT_QUERY_BUDGET_MS).toBeGreaterThan(0);
    expect(DEFAULT_QUERY_BUDGET_MS).toBeLessThanOrEqual(30_000);
  });
});

/**
 * Everything above asserts what the wrapper HANDS the client, against a
 * fake. That is only meaningful while the fake reproduces the real
 * driver's contract, and nothing above checks THAT: a fake which invents
 * a parameter the driver ignores would keep every assertion green while
 * production stayed unbounded.
 *
 * So this pins the assumption itself against the installed driver: that
 * `fetchOptions` passed as the third argument to `query` reaches the
 * fetch layer. If a future release moves it to construction-time only,
 * this fails instead of the budget quietly becoming a no-op.
 */
describe("the driver contract the budget depends on", () => {
  it("delivers query-level fetchOptions to the fetch layer", async () => {
    const originalFetchFunction = neonConfig.fetchFunction as unknown;
    let received: RequestInit | undefined;
    neonConfig.fetchFunction = (_url: string, options: RequestInit) => {
      received = options;
      return Promise.resolve(
        Response.json(
          {
            command: "SELECT",
            fields: [],
            rows: [],
            rowCount: 0,
          },
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    try {
      const sql = neon("postgresql://user:pass@example.neon.tech/db");
      const controller = new AbortController();

      await sql.query("select 1", [], {
        fetchOptions: { signal: controller.signal },
      });

      expect(received?.signal).toBe(controller.signal);
    } finally {
      // `neonConfig` is process-global; leaving a stub installed would
      // silently rewrite every later query in this worker.
      neonConfig.fetchFunction = originalFetchFunction;
    }
  });
});
