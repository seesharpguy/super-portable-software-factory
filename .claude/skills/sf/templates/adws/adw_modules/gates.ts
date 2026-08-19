/**
 * Validation gates: verify the envelope's CLAIMS, never guesses.
 *
 * A gate is `gate(envelope, run) -> GateReport` — one check per item it looked at.
 * Violations are derived from the failed checks and sent back to the SAME agent
 * session as a correction. Every check is recorded either way, so a green gate
 * says WHAT it verified instead of only that it passed.
 *
 * Gates check what is mechanically checkable; plan quality is a reviewer's job.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { GateReport, type EnvelopeBase, type GateFn, type RunContext } from "./data_types.ts";

const TAIL_CHARS = 1000; // command output kept as evidence on a failure

function size(p: string): string {
  const n = statSync(p).size;
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

export function artifactsExist(envelope: EnvelopeBase, _run: RunContext): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    const exists = existsSync(a);
    report.check(a, exists, exists ? `exists, ${size(a)}` : "declared artifact does not exist");
  }
  return report;
}

export function filesNonEmpty(envelope: EnvelopeBase, _run: RunContext): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    if (!existsSync(a) || !statSync(a).isFile()) continue; // existence is artifactsExist's job
    const empty = statSync(a).size === 0;
    report.check(a, !empty, empty ? "declared artifact is empty" : size(a));
  }
  return report;
}

export function jsonParses(envelope: EnvelopeBase, _run: RunContext): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    if (!a.endsWith(".json") || !existsSync(a)) continue;
    try {
      const parsed = JSON.parse(readFileSync(a, "utf-8"));
      const kind = Array.isArray(parsed) ? "list" : typeof parsed === "object" && parsed !== null ? "dict" : typeof parsed;
      report.check(a, true, `parses, ${kind}`);
    } catch (error) {
      report.check(a, false, `declared JSON artifact does not parse: ${(error as Error).message}`);
    }
  }
  return report;
}

/** Every file claimed changed must exist on disk. */
export function diffMatchesClaims(envelope: EnvelopeBase, _run: RunContext): GateReport {
  const report = new GateReport();
  const changedFiles = ((envelope as any).changed_files as string[] | undefined) ?? [];
  for (const f of changedFiles) {
    const exists = existsSync(f);
    report.check(f, exists, exists ? `exists, ${size(f)}` : "claimed changed file does not exist");
  }
  return report;
}

/**
 * A review's verdict must agree with the findings it just wrote down.
 *
 * Nothing here judges the code — that is the reviewer's job. This checks the
 * envelope against itself: an approval that ships blocking items, or a
 * rejection that names no problem, is a claim the harness can refute without
 * reading a line of the diff.
 */
export function verdictConsistent(envelope: EnvelopeBase, _run: RunContext): GateReport {
  const report = new GateReport();
  const approved = Boolean((envelope as any).approved ?? false);
  const blocking = ((envelope as any).blocking as string[] | undefined) ?? [];
  const findings = ((envelope as any).findings as Array<{ met: boolean; requirement: string }> | undefined) ?? [];
  const unmet = findings.filter((f) => !f.met).map((f) => f.requirement);

  report.check(
    "approved vs blocking",
    !(approved && blocking.length > 0),
    blocking.length === 0
      ? "no blocking items"
      : approved
        ? `${blocking.length} blocking item(s) while approved=true`
        : `${blocking.length} blocking item(s), not approved`,
  );
  report.check(
    "approved vs findings",
    !(approved && unmet.length > 0),
    unmet.length === 0
      ? "every requirement met"
      : approved
        ? `${unmet.length} unmet requirement(s) while approved=true`
        : `${unmet.length} unmet requirement(s), not approved`,
  );
  report.check(
    "rejection names a problem",
    approved || blocking.length > 0 || unmet.length > 0,
    approved || blocking.length > 0 || unmet.length > 0
      ? "verdict is supported"
      : "approved=false but no blocking item or unmet requirement was given",
  );
  return report;
}

/** Gate factory: the given shell command must exit 0. */
export function testsPass(command: string): GateFn {
  const gate: GateFn = (_envelope, _run) => {
    const result = spawnSync(command, { shell: true, encoding: "utf-8" });
    const ok = result.status === 0;
    let note = `exit ${result.status}`;
    if (!ok) {
      note += "\n" + ((result.stdout || "") + (result.stderr || "")).slice(-TAIL_CHARS);
    }
    return new GateReport().check(command, ok, note);
  };
  Object.defineProperty(gate, "name", { value: `tests_pass(${command})` });
  return gate;
}
