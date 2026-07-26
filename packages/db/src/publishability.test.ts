import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Publishability gate. AGENTS.md requires this repo carry no specific
 * model or GPU names in code, seeds, or example layouts (workloads are
 * pure data). That rule was enforced by human review only; this scans
 * the source + shipped data for a denylist so a leak fails CI.
 *
 * The forbidden identifiers live in `publishability-denylist.txt`, a
 * governed policy DATA file - NOT a scanned source file - so no specific
 * model or GPU name is embedded in this (or any) code the gate governs.
 * The denylists are necessarily heuristic (a gate, not a proof) but cover
 * the current-generation datacenter accelerators and common open-weight
 * model families, so the obvious leaks fail loudly.
 *
 * Deliberately NOT flagged: `nvidia-smi` (a required CLI tool name) and
 * `vLLM` (the inference engine). The private-repo/infra half of the rule
 * stays human-reviewed: the only org name in the tree is the repo's own
 * publisher (in LICENSE/CONTRIBUTING).
 */
const DENYLIST_PATH = fileURLToPath(
  new URL("publishability-denylist.txt", import.meta.url),
);

interface DenylistRule {
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * Parse the policy text into rules. Pure (text in, rules out) so the
 * malformed-input handling below is testable without filesystem I/O.
 *
 * Every failure mode here THROWS rather than dropping a rule: a policy
 * file that silently parses to fewer (or zero) rules would leave the gate
 * green while enforcing nothing, which is the one outcome a guardrail
 * must never have. The `\r` strip matters for the same reason - on a CRLF
 * checkout the carriage return would otherwise land inside every pattern
 * and make each rule match nothing.
 */
function parseDenylist(text: string): readonly DenylistRule[] {
  const rules: DenylistRule[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    const where = `publishability denylist line ${String(index + 1)}`;
    const tab = line.indexOf("\t");
    if (tab === -1) {
      throw new Error(
        `${where} has no TAB separator (expected ${String.raw`"label\tregex"`})`,
      );
    }
    const source = line.slice(tab + 1);
    if (source === "") {
      throw new Error(`${where} has an empty pattern`);
    }
    rules.push({ label: line.slice(0, tab), pattern: new RegExp(source, "i") });
  }
  if (rules.length === 0) {
    throw new Error("publishability denylist parsed to zero rules");
  }
  return rules;
}

const DENYLIST = parseDenylist(readFileSync(DENYLIST_PATH, "utf8"));

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCAN_ROOTS = ["packages", "services"];
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  "drizzle",
]);
// Every module extension the repo ships (nodenext ESM/CJS + the .mjs
// generator scripts), so the gate governs ALL code, not only .ts.
const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"];

function isScannable(name: string): boolean {
  if (SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return true;
  }
  // Shipped data (layouts, seeds, generated schemas), but not the
  // build/config JSON, which carries no workload data.
  return (
    name.endsWith(".json") &&
    name !== "package.json" &&
    !name.startsWith("tsconfig")
  );
}

function scannableFiles(directory: string): string[] {
  const found: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        found.push(...scannableFiles(path));
      }
    } else if (isScannable(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function violationsInFile(file: string): string[] {
  const content = readFileSync(file, "utf8");
  // Fast path: almost every file matches nothing, so test the whole file
  // once and only walk lines (to name the offending line) on a real hit.
  // Patterns carry no `g` flag, so `.test` and `.exec` share no lastIndex.
  if (DENYLIST.every(({ pattern }) => !pattern.test(content))) {
    return [];
  }
  const relative = file.slice(REPO_ROOT.length);
  const found: string[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    // Escape hatch: a line with a legitimate token that collides with a
    // denylist word opts out with a `publishability-allow` marker. None
    // exist today.
    if (line.includes("publishability-allow")) {
      continue;
    }
    for (const { label, pattern } of DENYLIST) {
      const match = pattern.exec(line);
      if (match) {
        found.push(`${relative}:${String(index + 1)} ${label}: "${match[0]}"`);
      }
    }
  }
  return found;
}

describe("publishability", () => {
  it("carries no specific GPU or LLM model names in code or layouts", () => {
    const violations = SCAN_ROOTS.flatMap((root) =>
      scannableFiles(`${REPO_ROOT}${root}`).flatMap((file) =>
        violationsInFile(file),
      ),
    );
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("scans the governed roots and its matcher is non-vacuous (positive control)", () => {
    // A green `toEqual([])` above must mean "no leaks", not "scanned
    // nothing" or "the matcher is vacuous". Prove coverage with explicit
    // sentinels - representative governed files that MUST be scanned,
    // spanning both roots and every kind (.ts, .mjs, .json data) - so a
    // REPO_ROOT / isScannable regression cannot silently scan nothing.
    const scanned = new Set(
      SCAN_ROOTS.flatMap((root) => scannableFiles(`${REPO_ROOT}${root}`)),
    );
    for (const relative of [
      "packages/db/src/seed.ts",
      "packages/protocol/scripts/generate-schemas.mjs",
      "services/haru-server/src/environment.ts",
      "packages/db/examples/fleet.example.json",
      "packages/protocol/schemas/fleet-layout.schema.json",
    ]) {
      expect(
        scanned.has(`${REPO_ROOT}${relative}`),
        `scanner must cover ${relative}`,
      ).toBe(true);
    }
    // The policy file itself is intentionally NOT scanned (it is the one
    // governed home for the names).
    expect(scanned.has(DENYLIST_PATH)).toBe(false);
    // ...which makes it the perfect end-to-end probe: it CONTAINS the very
    // tokens, so running the REAL pipeline (readFileSync -> whole-file fast
    // path -> allow-marker skip -> per-line matcher -> report) over it must
    // produce a hit for every rule. Asserting through `violationsInFile`,
    // not the raw regexes, is what fails if the scanner itself regresses.
    const detected = violationsInFile(DENYLIST_PATH);
    expect(detected.length).toBeGreaterThan(0);
    for (const { label } of DENYLIST) {
      expect(
        detected.some((violation) => violation.includes(label)),
        `${label} must be reported through the scan pipeline`,
      ).toBe(true);
    }
  });

  it("rejects a malformed policy file instead of silently disabling itself", () => {
    // Each of these once produced a SILENTLY weaker gate: no rules at all,
    // or a rule whose pattern is dead (the whole line compiled as the
    // regex, or a \r glued onto it) yet still self-consistent enough to
    // look fine. They must throw instead.
    expect(() => parseDenylist("# comments only\n")).toThrow(/zero rules/);
    expect(() => parseDenylist("")).toThrow(/zero rules/);
    expect(() => parseDenylist("label with spaces not a tab\n")).toThrow(/TAB/);
    expect(() => parseDenylist("label\t\n")).toThrow(/empty pattern/);
    // A CRLF checkout must still yield a WORKING pattern, not one with a
    // trailing carriage return that can never match real source.
    const [rule] = parseDenylist("gpu\t\\bTEST-ACCEL\\b\r\n");
    expect(rule?.pattern.test('const a = "TEST-ACCEL";')).toBe(true);
  });
});
