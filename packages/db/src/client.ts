import { timeoutSignal } from "@haru/protocol";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema/index.js";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * Driver-agnostic database handle. Production uses the Neon HTTP
 * driver; tests use PGlite. Both drivers satisfy this type, which is
 * why the repository layer sticks to single-statement queries: the
 * Neon HTTP transport has no interactive transactions, so every state
 * transition is a compare-and-swap UPDATE that behaves identically on
 * both drivers.
 */
export type HaruDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Wall-clock bound on one database round trip.
 *
 * Every other network call here carries an explicit budget (heartbeat
 * 5s, per-nudge supervisor call 10s, chat TTFB 30s). The database
 * transport did not, so it inherited undici's defaults, which matters in
 * exactly the mode this system exists to survive: a store that accepts
 * TCP and never answers. A refused connection fails fast either way, but
 * a hung one made every caller wait on the transport, and the routing
 * pointer is read both on the chat hot path and inside
 * `resolveStepTimeout`, where the reconciler decides whether a timed-out
 * promotion actually committed.
 *
 * 10s matches the supervisor-call budget rather than sitting just above a
 * healthy p99 (a single statement over Neon HTTP is tens of
 * milliseconds): the bound is there to make an outage unmistakable, not
 * to police latency. It also does not exceed `switchActiveTimeoutMs`, so
 * a hung pointer read cannot outlive the step that issued it.
 */
export const DEFAULT_QUERY_BUDGET_MS = 10_000;

export interface CreateDatabaseOptions {
  /** Override {@link DEFAULT_QUERY_BUDGET_MS}. Deliberately not an env knob. */
  queryBudgetMs?: number;
}

/**
 * The shape `drizzle-orm/neon-http` actually calls. Its session resolves
 * `client.query ?? client` once at construction, and the Neon client does
 * expose `query`, so `query` is the only path a repository read or CAS
 * ever takes. Budgeting the callable form instead would compile, pass its
 * own tests, and never apply to a real query.
 */
interface NeonQueryClient {
  query: (
    query: string,
    parameters?: unknown[],
    options?: Record<string, unknown>,
  ) => unknown;
  transaction?: (
    queries: unknown[],
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * Merge a per-call budget signal into whatever fetch options are already
 * there, composing rather than replacing a signal the caller supplied.
 */
function budgetedOptions(
  options: Record<string, unknown> | undefined,
  budgetMs: number,
): { merged: Record<string, unknown>; timer: ReturnType<typeof setTimeout> } {
  const callerFetchOptions =
    (options?.fetchOptions as Record<string, unknown> | undefined) ?? {};
  const existing = callerFetchOptions.signal;
  const { signal, timer } = timeoutSignal(
    budgetMs,
    undefined,
    existing instanceof AbortSignal ? existing : undefined,
  );
  return {
    merged: {
      ...options,
      fetchOptions: { ...callerFetchOptions, signal },
    },
    timer,
  };
}

/**
 * Release the budget timer when the query settles, WITHOUT changing what
 * the caller gets back.
 *
 * Drizzle's `batch` path calls `client.query(...)` per statement and
 * hands the resulting lazy `NeonQueryPromise` objects straight to
 * `client.transaction()`, which reads `queryData` and `opts` off them.
 * Returning `result.finally(...)` - or making the wrapper `async` - would
 * hand it bare promises instead and break batch silently. So when the
 * driver returns a lazy query, its `execute` is wrapped in place and the
 * object itself is returned untouched.
 */
function clearTimerWhenSettled<T>(
  result: T,
  timer: ReturnType<typeof setTimeout>,
): T {
  const clear = () => {
    clearTimeout(timer);
  };
  const lazy = result as {
    execute?: (...arguments_: unknown[]) => Promise<unknown>;
  };
  if (typeof lazy.execute === "function") {
    const execute = lazy.execute.bind(lazy);
    lazy.execute = async (...arguments_: unknown[]) => {
      try {
        return await execute(...arguments_);
      } finally {
        clear();
      }
    };
    return result;
  }
  // Anything else (a fake, another driver) is an ordinary promise, and
  // nothing reads properties off it.
  const settle = async (): Promise<unknown> => {
    try {
      return await result;
    } finally {
      clear();
    }
  };
  return settle() as T;
}

/**
 * Give every query its own abort budget.
 *
 * The signal is per call and rides Neon's `fetchOptions`, so an expired
 * budget aborts the underlying fetch. Racing a timer against the promise
 * would stop the waiting without cancelling the request, accumulating one
 * abandoned socket per attempt during a hang-mode outage, which is the
 * failure this is meant to contain.
 *
 * An expired budget surfaces as a REJECTION, indistinguishable to callers
 * from any other transport failure. That is required rather than
 * incidental: `cachedSnapshot` in haru-server reads a throw from the
 * pointer read as "the store is unreachable", and that throw is the only
 * thing licensing a stale route. A budget that resolved to a sentinel
 * would defeat the contract silently.
 *
 * Exported for tests: production goes through `createDatabase`, but the
 * budget has to be provable against a fake client with no live endpoint.
 */
export function withQueryBudget<T extends NeonQueryClient>(
  client: T,
  budgetMs: number,
): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      // `transaction` is the batch path's single HTTP request, so it
      // needs its own budget: budgeting only `query` would leave the one
      // call that actually goes over the wire unbounded.
      if (
        property === "transaction" &&
        typeof target.transaction === "function"
      ) {
        const transaction = target.transaction.bind(target);
        return async (
          queries: unknown[],
          options?: Record<string, unknown>,
        ) => {
          const { merged, timer } = budgetedOptions(options, budgetMs);
          try {
            return await transaction(queries, merged);
          } finally {
            clearTimeout(timer);
          }
        };
      }
      if (property !== "query") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      // Synchronous on purpose: an async wrapper would await the lazy
      // query and return a bare promise, which is what breaks batch.
      return (
        query: string,
        parameters?: unknown[],
        options?: Record<string, unknown>,
      ): unknown => {
        const { merged, timer } = budgetedOptions(options, budgetMs);
        return clearTimerWhenSettled(
          target.query(query, parameters, merged),
          timer,
        );
      };
    },
  });
}

/** Create a Neon-backed database handle (the documented production target). */
export function createDatabase(
  databaseUrl: string,
  options: CreateDatabaseOptions = {},
): HaruDatabase {
  const sql = neon(databaseUrl);
  const budgeted = withQueryBudget(
    sql as unknown as NeonQueryClient,
    options.queryBudgetMs ?? DEFAULT_QUERY_BUDGET_MS,
  );
  return drizzle({ client: budgeted as unknown as typeof sql, schema });
}
