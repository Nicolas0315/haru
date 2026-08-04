import { describe, expect, it } from "vitest";

import { DEFAULT_QUERY_BUDGET_MS, withQueryBudget } from "./client.js";

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

  // These two run on REAL timers with a tiny budget. `AbortSignal.timeout`
  // is implemented natively and is not intercepted by vitest's fake
  // timers, and keeping the production path on a real signal (so the
  // fetch is genuinely cancelled) is worth more than a fakeable one.
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

  it("passes every other property through untouched", () => {
    const { client } = fakeClient();
    const budgeted = withQueryBudget(client, 5000);

    expect(budgeted.unsafe("raw")).toBe("raw");
  });

  it("defaults to a budget that is bounded and well under undici's", () => {
    // The point of the constant is that it exists and is small; pinning
    // the exact number would just restate the source.
    expect(DEFAULT_QUERY_BUDGET_MS).toBeGreaterThan(0);
    expect(DEFAULT_QUERY_BUDGET_MS).toBeLessThanOrEqual(30_000);
  });
});
