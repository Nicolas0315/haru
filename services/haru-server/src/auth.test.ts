import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { bearerAuth } from "./auth.js";

describe("tokenless browser origin boundary", () => {
  it("blocks cross-origin and null-origin requests while preserving local/native access", async () => {
    const app = new Hono();
    app.use("/v1/*", bearerAuth(undefined));
    app.post("/v1/mutate", (c) => c.json({ ok: true }));
    app.get("/v1/read", (c) => c.json({ ok: true }));
    expect(
      (await app.request("https://rebound.example:8700/v1/read")).status,
    ).toBe(403);
    expect((await app.request("http://127.0.0.1:8700/v1/read")).status).toBe(
      200,
    );
    for (const origin of ["http://localhost:9999", "null"]) {
      expect(
        (
          await app.request("http://127.0.0.1:8700/v1/mutate", {
            method: "POST",
            headers: { origin },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await app.request("https://rebound.example:8700/v1/mutate", {
          method: "POST",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("https://rebound.example:8700/v1/mutate", {
          method: "POST",
          headers: { origin: "https://rebound.example:8700" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request("http://127.0.0.1:8700/v1/mutate", { method: "POST" }))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request("http://127.0.0.1:8700/v1/mutate", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:8700" },
        })
      ).status,
    ).toBe(200);
  });
  it("keeps explicitly authenticated cross-origin clients working", async () => {
    const app = new Hono();
    app.use("/v1/*", bearerAuth("synthetic-token"));
    app.post("/v1/mutate", (c) => c.json({ ok: true }));
    expect(
      (
        await app.request("http://127.0.0.1:8700/v1/mutate", {
          method: "POST",
          headers: {
            origin: "http://localhost:9999",
            authorization: "Bearer synthetic-token",
          },
        })
      ).status,
    ).toBe(200);
  });
});
