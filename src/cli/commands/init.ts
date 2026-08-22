/**
 * `spf init` — seed a `.spf/` override directory. Everything else is
 * inherited from the packaged defaults.
 *
 * On a TTY (and without `--template`/`--yes`), this runs an interview
 * instead of writing the all-comments starter file: it asks which coding
 * agent, model/provider, quality checks, and (if wanted) `spf watch`
 * tracker/host to use, collects the secrets those answers imply, and
 * appends them to `.env` (already auto-loaded by every command — see
 * `src/cli/index.ts`). Piped input, `--yes`, or `--template <name>` all
 * fall through to the original non-interactive behavior unchanged — a
 * scripted `spf init` must never hang waiting on stdin.
 *
 * Every path here also installs the repo-local Claude Code skill (the same
 * work `spf install-skill` does by hand) unless `--no-skills` is passed —
 * on every run, not just the first: `install-skill` is idempotent (a no-op
 * once the skill is already up to date), so this never re-does work or
 * clobbers a locally-edited skill file. `--user` (installing to
 * `~/.claude/skills/spf` instead) stays a `spf install-skill` invocation of
 * its own; `init` only ever writes the repo-local default.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import * as paths from "../../core/paths.ts";
import * as agents from "../../core/agents.ts";
import { ensureGitignore } from "../gitignore.ts";
import { parseCli } from "../../core/utils.ts";
import { paint } from "../../core/console.ts";
import { createAsker, isInteractive, InterviewAborted } from "../ask.ts";
import { gatherContext, runInterview } from "../interview.ts";
import { readEnvFile, upsertEnvFile, writeEnvExample } from "../env_file.ts";
import { installSkillCommand } from "./install-skill.ts";

const TEMPLATE_SUFFIX = ".spf.config.yaml";

/** Every template's short name (e.g. "ts-cc"), derived from disk rather than hand-maintained — never drifts from what's actually packaged. */
function listTemplates(): string[] {
  if (!existsSync(paths.TEMPLATES_DIR)) return [];
  return readdirSync(paths.TEMPLATES_DIR)
    .filter((f) => f.endsWith(TEMPLATE_SUFFIX))
    .map((f) => f.slice(0, -TEMPLATE_SUFFIX.length))
    .sort();
}

function loadTemplate(name: string): string {
  const templatePath = path.join(paths.TEMPLATES_DIR, `${name}${TEMPLATE_SUFFIX}`);
  if (!existsSync(templatePath)) {
    const available = listTemplates();
    throw new Error(
      `unknown template ${JSON.stringify(name)} — available: ${available.length > 0 ? available.join(", ") : "(none packaged)"}`,
    );
  }
  return readFileSync(templatePath, "utf-8");
}

const STARTER_CONFIG = `# .spf/spf.config.yaml — merged ON TOP of spf's packaged built-in defaults.
# List only what you want to CHANGE; everything else (the roster, prompts,
# models) is inherited. Run \`spf doctor\` any time to see what's actually in
# effect for this repo, and where each value came from.

# Uncomment to enable a quality-gated chain (build-test, plan-build-test,
# plan-build-test-quality, quality, simple-sdlc) — an unconfigured suite
# fails loudly before anything runs, on purpose, rather than reporting a
# placeholder green.
# quality:
#   checks:
#     - {name: test, operation: build, argv: ["npm", "test"], timeout_seconds: 600}
#   suites:
#     test: [test]
#     all: [test]

# agents:
#   - name: builder
#     model: anthropic/claude-sonnet-4-6
#     coding_agent: claude_code   # run this agent on Claude Code instead of Flue
#     model: sonnet               # claude_code's own alias, NOT provider/model-id
#
# Switching coding_agent globally, in defaults: above, instead of per-agent?
# The packaged default roster pins planner/reviewer/documenter to their own
# explicit Flue-style provider/model-id strings, and an agent's own model
# always wins over defaults.model — so those three keep running on whatever
# backend you just switched to, with a model id it can't resolve, unless
# you override their model here too (builder/scout/refiner have no model of
# their own in the packaged roster, so they need no override). See
# assets/templates/ts.spf.config.yaml (or --template ts) for the full
# working pattern.

# Uncomment to enable \`spf watch\` — polls an issue tracker labeled
# <label_prefix>:ready and runs \`chain\` against each in its own worktree.
# issue_provider and code_host default to "github" and are independent —
# a Jira tracker against a Bitbucket repo is just issue_provider: jira +
# code_host: bitbucket + a watch.jira: {base_url, project_key} block. See
# README.md's "spf watch" section for every combination's env vars and
# required scopes. \`spf doctor\` checks whatever this resolves to.
# watch:
#   issue_provider: github   # github | jira
#   code_host: github        # github | bitbucket
#   repo: owner/name          # the CODE HOST's repo — "owner/name" (github) or "workspace/repo_slug" (bitbucket)
#   # issue_repo: owner/name  # ONLY for issue_provider: github + code_host: bitbucket, when
#   #                         # the tracker and code host are genuinely different repos
#   label_prefix: spf
#   chain: plan-build-test
#   base_branch: main
#   # Optional second lane: decompose a spf:spec-ready product spec into a
#   # feature/story-or-bug tree of real issues. Off by default; needs
#   # issue_provider: github — issue authoring isn't implemented for Jira yet.
#   refine:
#     enabled: true
#     chain: refine
#     concurrency: 1

# Uncomment to push notifications for unattended work — spf watch's daemon
# lifecycle, and every chain run (spf <chain> / spf run, including watch's
# own per-issue runs). Interactive commands (doctor, list, sessions, ...)
# never notify — you're already looking at the terminal for those. events:
# "errors" sends only failures/blocked issues; "all" adds every milestone
# (run started, issue claimed, PR opened, ...). The URL is a secret and
# lives only in .env — never in this file. See README.md's "Notifications"
# section for how to get each webhook URL.
# notifications:
#   events: errors            # off (default) | errors | all
#   channels:
#     - kind: slack            # slack | teams | webhook
#       webhook_url_env: SLACK_WEBHOOK_URL   # default for slack; TEAMS_WEBHOOK_URL / SPF_WEBHOOK_URL for the others

# Uncomment to change the human sign-off gate in front of simple-sdlc's
# commit_build phase — the one place an AI reviewer's approved flag alone
# can gate a commit. See assets/skill/references/config.md's "review"
# section for the full behavior.
# review:
#   require_human_signoff: false   # true = an unattended simple-sdlc run fails closed instead of committing on the reviewer's verdict alone
#   signoff_timeout_seconds: 300
`;

// .spf/spf.config.yaml and .spf/prompt_engineering/ stay tracked — they're
// shared project config, same as package.json. Only runtime/generated
// content is ignored: session traces (data/), a hand-editable engine copy
// (engine/, from `spf eject`), and secrets (.env).
//
// `.spf/chains/` is deliberately NOT in this list. A chain file is DATA
// that decides what the disposer runs (see repo_chains.ts's module comment)
// — the same trust boundary `defaults.protected_files` exists to guard.
// Gitignoring it would let anyone (or any agent) rewrite what "spf plan-
// build-test" or a watch.chain even means, invisibly to `git diff`/PR
// review, in a repo that otherwise protects every other file that judges
// agent output. Chain files stay tracked so `protected_files` covers the
// chain that judges the agents, not just the code it judges.
const GITIGNORE_ENTRIES = [".spf/data/", ".spf/engine/", ".env"];

/**
 * Scaffolded once by `spf init` — fully commented out, so every line is a
 * `#` comment and `parseYaml` reads the whole file as an empty document;
 * `loadOne` (repo_chains.ts) treats that as "declares no chain" and skips it
 * silently — no chain registered, but also no problem reported against
 * spf's own scaffold. It exists to show the shape (naming existing
 * `chains/steps.ts` factories as data, never importing repo code — params
 * are flat siblings of `step:`, never nested under a `params:` key) and to
 * carry the one divergence an author needs to know before writing a real
 * one.
 */
export const EXAMPLE_CHAIN_YAML = `# .spf/chains/example.yaml — a repo-local chain, loaded as DATA.
#
# This file NAMES existing step factories from spf's own chains/steps.ts
# (request, plan, build, fixLoop, commit, ...) — it never imports or runs
# code from this repo. "Agent proposes, code disposes," and the code that
# disposes is always SPF's own, packaged code; a chain file only ever picks
# which of ITS steps run, in which order, with which params. See
# .claude/skills/spf/cookbooks/authoring_chains.md (installed by \`spf init\`
# into THIS repo) for the full step vocabulary — its "Repo-local chains"
# section is written for exactly this file.
#
# WATCH DIVERGENCE: \`spf watch\` registers chains from the MAIN repo anchor
# once, at daemon start — not per-issue, not per-worktree. A chain file
# edited on an issue branch (inside the worktree \`spf watch\` checks that
# branch out into) is NOT what runs for that issue; the daemon keeps using
# whatever \`.spf/chains/\` looked like in the main repo when it started. The
# disposer stays the OPERATOR's, never the branch's — exactly the property
# that keeps an agent from being able to rewrite its own quality gate mid-run
# by editing a chain file as part of the change it's making.
#
# Uncomment and edit to register this chain (spf list / spf doctor will
# then show it). Every field below is required unless noted.
#
# name: example                  # spf example "<prompt>" / spf run example "<prompt>"
# describe: small build+fix example chain — build, then a bounded test-fix loop
# steps:
#   - step: request               # every chain opens with this
#   - step: build
#     fromPlan: false              # no preceding plan() step in this chain
#   - step: fixLoop
#     suite: test                  # must name a key under quality.suites in spf.config.yaml
#     owner: builder               # must name an agent in the roster (cfg.agents)
#     max: 3                       # optional — defaults to 3 if omitted
#   - step: commit
#     onlyIfAccepted: true
`;

const GENERATED_HEADER = `# .spf/spf.config.yaml — written by \`spf init\`'s interview, merged ON TOP of
# spf's packaged built-in defaults. Only what you changed is here; run
# \`spf doctor\` any time to see what's actually in effect for this repo, and
# where each value came from. Secrets this config implies live in .env
# (gitignored) — .env.example lists the key names only.
`;

export async function initCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["cwd", "template"], ["force", "yes", "no-skills"]);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const sfDir = path.join(anchor.repo_root, ".spf");
  mkdirSync(sfDir, { recursive: true });

  // Scaffold `.spf/chains/` unconditionally, on every path below (interview
  // or not) — same idempotent shape as installSkill(): never overwrites a
  // file that's already there (an author may have started editing the
  // example, or written their own chains alongside it), so this is always
  // safe to run again on a repo that already has one.
  const chainsDir = path.join(sfDir, "chains");
  mkdirSync(chainsDir, { recursive: true });
  const exampleChainPath = path.join(chainsDir, "example.yaml");
  if (!existsSync(exampleChainPath)) {
    writeFileSync(exampleChainPath, EXAMPLE_CHAIN_YAML);
  }

  // Idempotent (a no-op once the skill is already up to date, a `.new`
  // sibling rather than an overwrite for a locally-edited file) — safe to
  // call on every `spf init`, not just the first.
  const installSkill = () => {
    if (flags["no-skills"]) return;
    installSkillCommand(options["cwd"] ? ["--cwd", options["cwd"]] : []);
  };

  const configPath = path.join(sfDir, "spf.config.yaml");
  const templateName = options["template"];
  const interactive = !templateName && !flags["yes"] && isInteractive();

  if (!interactive) {
    if (existsSync(configPath) && !flags["force"]) {
      console.log(`${configPath} already exists — leaving it alone (--force to overwrite)`);
    } else {
      const content = templateName ? loadTemplate(templateName) : STARTER_CONFIG;
      writeFileSync(configPath, content);
      console.log(`wrote ${configPath}${templateName ? ` (from template "${templateName}")` : ""}`);
    }
    installSkill();
  } else {
    const asker = createAsker();
    try {
      if (existsSync(configPath) && !flags["force"]) {
        const overwrite = await asker.confirm(`${configPath} already exists — overwrite it?`, false);
        if (!overwrite) {
          console.log("leaving the existing config alone (--force to skip this prompt)");
          asker.close();
          installSkill();
          ensureGitignore(anchor.repo_root, GITIGNORE_ENTRIES);
          return 0;
        }
      }

      const envPath = path.join(anchor.repo_root, ".env");
      const ctx = gatherContext(anchor.repo_root, readEnvFile(envPath));
      const result = await runInterview(asker, ctx);
      asker.close();
      if (!result) {
        console.log("init cancelled — nothing written");
        return 1;
      }

      writeFileSync(configPath, GENERATED_HEADER + stringify(result.config));
      console.log(`wrote ${configPath}`);
      if (Object.keys(result.env).length > 0) upsertEnvFile(anchor.repo_root, result.env);
      writeEnvExample(anchor.repo_root, result.envExampleKeys);
      installSkill();

      // The same merge-then-validate pipeline `spf doctor` runs — catches a
      // bad answer (e.g. a suite naming an unconfigured check) right after
      // writing, not at the user's first real chain run. Non-fatal: the
      // config is already written either way, and `spf doctor` gives the
      // full picture.
      try {
        const cfg = agents.loadConfig([paths.BUILTIN_CONFIG_PATH, configPath]);
        agents.validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), anchor.cwd);
      } catch (error) {
        console.log(paint("yellow", `warning: ${(error as Error).message}\nrun \`spf doctor\` for the full picture.`));
      }
    } catch (error) {
      asker.close();
      if (error instanceof InterviewAborted) {
        console.log("\ninit interrupted — nothing written");
        return 130;
      }
      throw error;
    }
  }

  ensureGitignore(anchor.repo_root, GITIGNORE_ENTRIES);
  const templates = listTemplates();
  if (templates.length > 0) {
    console.log(`templates available via --template: ${templates.join(", ")}`);
  }
  console.log(`\nnext: spf doctor   (confirm everything resolves), then spf scout "describe this repo"`);
  console.log(
    paint(
      "yellow",
      `warning: spf ui reads .spf/data/spf.db, which doesn't exist until a run creates it — run spf scout (or any chain) at least once before spf ui.`,
    ),
  );
  return 0;
}
