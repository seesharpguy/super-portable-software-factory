/**
 * `spf` — the command surface. `spf <chain-name> "<prompt>"` and
 * `spf run <chain-name> "<prompt>"` are identical; the bare form exists
 * because typing the chain name IS choosing what to run, and that's the
 * common case. Everything else is a named subcommand.
 */
import * as agentCc from "../core/agent_cc.ts";
import * as agentFlue from "../core/agent_flue.ts";
import { findChain } from "../chains/index.ts";
import { dispatchChain, usageFor } from "./commands/run.ts";
import { listCommand } from "./commands/list.ts";
import { initCommand } from "./commands/init.ts";
import { installSkillCommand } from "./commands/install-skill.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { ejectCommand } from "./commands/eject.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { phasesCommand } from "./commands/phases.ts";
import { eventsCommand } from "./commands/events.ts";
import { abortCommand } from "./commands/abort.ts";
import { uiCommand } from "./commands/ui.ts";
import { watchCommand } from "./commands/watch.ts";
import { versionCommand } from "./commands/version.ts";

const HELP = `spf — repeatable agents-plus-code workflows (ADWs)

  spf list                                  the chain registry — names, phases, what each needs
  spf <chain> "<prompt>" [options]          run a chain (spf run <chain> ... works identically)
  spf init [--force]                        seed .spf/spf.config.yaml in the current repo
  spf install-skill [--user] [--force]      install the Claude Code skill (repo-local by default)
  spf migrate [--apply] [--force]           move an old stamped adws/ tree onto .spf/ (dry run by default)
  spf eject [--target <dir>] [--force]      copy the installed engine out for reference/hand-editing
  spf doctor [--json]                       check everything that fails silently otherwise
  spf ui [--port N] [--no-open] [--db path] open the trace visualizer
  spf watch [--dry-run] [--once]            poll watch.repo for labeled issues, run watch.chain on each
  spf sessions [--limit N] [--json]         recent runs
  spf phases <adw_id> [--json]              one run's phases
  spf events <adw_id> [--follow] [--json]   one run's trace events
  spf abort <adw_id>                        signal a run's process to stop
  spf version                               print the installed version

Chain options: [--config <path>] [--adw-id <id>] [--cwd <dir>] [--agent <name>] [--base <ref>]
Run \`spf list\` to see every chain and what it needs.`;

export async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env in cwd — fine, nothing to load
  }

  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    process.exitCode = 0;
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.exitCode = versionCommand();
    return;
  }

  try {
    switch (cmd) {
      case "run": {
        const [chainName, ...chainArgs] = rest;
        const chain = chainName ? findChain(chainName) : undefined;
        if (!chain) {
          console.error(`unknown chain: ${chainName ?? "(none given)"} — run \`spf list\` to see every chain`);
          process.exitCode = 1;
          return;
        }
        process.exitCode = await dispatchChain(chain, chainArgs);
        return;
      }
      case "list":
        process.exitCode = listCommand();
        return;
      case "init":
        process.exitCode = initCommand(rest);
        return;
      case "install-skill":
        process.exitCode = installSkillCommand(rest);
        return;
      case "migrate":
        process.exitCode = migrateCommand(rest);
        return;
      case "eject":
        process.exitCode = ejectCommand(rest);
        return;
      case "doctor":
        process.exitCode = doctorCommand(rest);
        return;
      case "ui":
        process.exitCode = await uiCommand(rest);
        return;
      case "watch":
        process.exitCode = await watchCommand(rest);
        return;
      case "sessions":
        process.exitCode = sessionsCommand(rest);
        return;
      case "phases":
        process.exitCode = phasesCommand(rest);
        return;
      case "events":
        process.exitCode = await eventsCommand(rest);
        return;
      case "abort":
        process.exitCode = abortCommand(rest);
        return;
      default: {
        const chain = findChain(cmd);
        if (!chain) {
          console.error(`unknown command or chain: ${cmd}\n`);
          console.error(HELP);
          process.exitCode = 1;
          return;
        }
        if (rest.length < 1) {
          console.error(usageFor(chain));
          process.exitCode = 1;
          return;
        }
        process.exitCode = await dispatchChain(chain, rest);
        return;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    // A no-op if this invocation never touched an agent (e.g. spf quality,
    // spf list, spf doctor) — the Flue runtime only ever starts lazily, and
    // agent_cc.ts's shutdown() just kills any still-running claude children.
    await agentFlue.shutdown();
    await agentCc.shutdown();
  }
}
