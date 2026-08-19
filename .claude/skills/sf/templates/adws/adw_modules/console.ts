/**
 * Console reporter: one narrative, two destinations.
 *
 * Every line an ADW prints ALSO lands in the db as a `log` event, so the swim-lane
 * UI reads the same story the terminal does. Both go through `emit` — print and
 * trace cannot drift. Plain sequential lines only: no spinners, no live displays,
 * so a CI log reads exactly like a terminal.
 */

import type { EnvelopeBase, EventRecord, GateReport, Phase } from "./data_types.ts";
import { makeEventRecord } from "./data_types.ts";

const KIND_COLOR: Record<string, string> = { engineer: "cyan", agent: "magenta", code: "yellow" };
const MAX_LINE = 160; // dynamic text (summaries, violations, errors) is clipped

const RESET = "\x1b[0m";
const CODES: Record<string, string> = {
  bold: "1",
  dim: "2",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
};

function paint(style: string, text: string): string {
  const codes = style.split(" ").map((s) => CODES[s]).filter(Boolean);
  if (codes.length === 0) return text;
  return `\x1b[${codes.join(";")}m${text}${RESET}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function clip(text: unknown, limit: number = MAX_LINE): string {
  const joined = String(text).split(/\s+/).filter(Boolean).join(" ");
  return joined.length <= limit ? joined : joined.slice(0, limit - 1) + "…";
}

function panel(lines: string[], title: string, borderColor: "green" | "red"): string {
  const contentWidth = Math.max(...lines.map((l) => stripAnsi(l).length), stripAnsi(title).length + 2);
  const top = paint(`bold ${borderColor}`, `╭─ ${title} ${"─".repeat(Math.max(0, contentWidth - title.length - 1))}╮`);
  const bottom = paint(`bold ${borderColor}`, `╰${"─".repeat(contentWidth + 3)}╯`);
  const body = lines.map((l) => `${paint(borderColor, "│")} ${l}${" ".repeat(Math.max(0, contentWidth - stripAnsi(l).length))} ${paint(borderColor, "│")}`);
  return [top, ...body, bottom].join("\n");
}

interface Tracer {
  event(record: EventRecord): string;
}

/** Bound to one run's tracer. Reachable as `run.console` everywhere. */
export class Console {
  private phaseId = ""; // current lane — log events attach to it
  private phaseName = "";
  private results: string[] = []; // phase statuses, for the summary
  private finished = false; // the summary panel prints once

  constructor(private tracer: Tracer, private adwId: string) {}

  // ── the one helper: print AND trace, always together ────────────────────
  private emit(line: string, level: string = "info"): void {
    console.log(line);
    this.tracer.event(
      makeEventRecord({
        adw_id: this.adwId,
        phase_id: this.phaseId,
        type: "log",
        name: this.phaseName || "console",
        payload: { message: stripAnsi(line), level },
      }),
    );
  }

  // ── session ─────────────────────────────────────────────────────────────
  sessionStarted(adwId: string, engineer: string): void {
    this.emit(`${paint("bold cyan", "adw_id:")} ${paint("bold", adwId)}   ${paint("dim", "engineer")} ${engineer}`);
  }

  sessionFinished(ok: boolean, tokens: number, cost: number, dbPath: string): void {
    if (this.finished) return;
    this.finished = true;
    const passed = this.results.filter((r) => r === "success").length;
    const status = ok ? paint("green", "✓ success") : paint("red", "✗ fail");
    const rows = [
      ` ${paint("dim", "status")}   ${status}`,
      ` ${paint("dim", "phases")}   ${passed}/${this.results.length} passed`,
      ` ${paint("dim", "tokens")}   ${tokens.toLocaleString()}`,
      ` ${paint("dim", "cost")}     $${cost.toFixed(4)}`,
      ` ${paint("dim", "adw_id")}   ${this.adwId}`,
      ` ${paint("dim", "db")}       ${dbPath}`,
      ` ${paint("dim", "next")}     ${paint("bold", `just phases ${this.adwId}`)}`,
    ];
    const rendered = panel(rows, "ADW complete", ok ? "green" : "red");
    console.log(rendered);
    const plain = `session ${this.adwId} ${ok ? "success" : "fail"} · ${passed}/${this.results.length} phases · ${tokens.toLocaleString()} tokens · $${cost.toFixed(4)}`;
    this.tracer.event(
      makeEventRecord({
        adw_id: this.adwId,
        phase_id: this.phaseId,
        type: "log",
        name: this.phaseName || "console",
        payload: { message: plain, level: ok ? "info" : "error" },
      }),
    );
  }

  // ── phases ──────────────────────────────────────────────────────────────
  phaseStarted(phase: Phase): void {
    this.phaseId = phase.phase_id;
    this.phaseName = phase.params.name;
    const p = phase.params;
    const color = KIND_COLOR[p.kind] || "white";
    let line =
      paint(`bold ${color}`, `▶ ${String(phase.seq).padStart(2, "0")} ${p.name}`) +
      `  ${paint(color, p.kind)} ${paint("dim", `· ${p.owner}`)}`;
    if (p.description) line += `  ${paint("dim", clip(p.description))}`;
    this.emit(line);
  }

  phaseEnded(phase: Phase, seconds: number): void {
    const ok = phase.status === "success";
    this.results.push(phase.status);
    let line = `  ${ok ? paint("green", "✓") : paint("red", "✗")} ${phase.params.name} ${paint("dim", `${seconds.toFixed(1)}s`)}`;
    if (!ok && phase.error) line += `  ${paint("red", clip(phase.error))}`;
    this.emit(line, ok ? "info" : "error");
    this.phaseId = "";
    this.phaseName = "";
  }

  /** Free-form detail inside the current phase — what `ph.log()` recorded. */
  note(message: string): void {
    this.emit(`  ${paint("dim", `· ${clip(message)}`)}`);
  }

  // ── agents ──────────────────────────────────────────────────────────────
  agentStarted(name: string, model: string, sessionId: string): void {
    this.emit(`  ${paint("magenta", "▸")} ${name} ${paint("dim", model)}  ${paint("dim", `session ${sessionId}`)}`);
  }

  agentFinished(name: string, tokens: number, cost: number): void {
    this.emit(`  ${paint("dim", `└ ${name} used ${tokens.toLocaleString()} tokens · $${cost.toFixed(4)}`)}`);
  }

  retry(name: string, attempt: number, limit: number, reason: string): void {
    this.emit(
      `  ${paint("yellow", "⟳")} ${name} retry ${attempt}/${limit} ${paint("dim", `— same session · ${clip(reason)}`)}`,
      "warn",
    );
  }

  // ── verification ────────────────────────────────────────────────────────
  /** A gate reports WHAT it checked, not just whether it passed. */
  gateResult(name: string, report: GateReport): void {
    const ok = report.passed;
    const mark = ok ? paint("green", "✓") : paint("red", "✗");
    const summary = ok
      ? `${report.checks.length} checked`
      : paint("red", `${report.violations.length} of ${report.checks.length} failed`);
    this.emit(`  ${mark} gate ${paint("dim", name)} ${paint("dim", summary)}`, ok ? "info" : "error");
    for (const check of report.checks) {
      const style = check.ok ? "dim" : "dim red";
      const detail = check.note ? ` — ${clip(check.note)}` : "";
      this.emit(`    ${paint(style, `${check.ok ? "·" : "✗"} ${clip(check.item)}${detail}`)}`, check.ok ? "info" : "error");
    }
  }

  envelopeSummary(envelope: EnvelopeBase, typeName: string): void {
    const ok = envelope.status === "success";
    const line = `  ${ok ? paint("green", "✓") : paint("red", "✗")} ${typeName} ${paint("dim", clip(envelope.summary))}`;
    this.emit(line, ok ? "info" : "error");
    if (envelope.artifacts.length > 0) {
      this.emit(`    ${paint("dim", `artifacts: ${clip(envelope.artifacts.join(", "))}`)}`);
    }
  }
}
