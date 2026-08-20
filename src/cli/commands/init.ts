/** `spf init` — seed a `.spf/` override directory. Everything else is inherited from the packaged defaults. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as paths from "../../core/paths.ts";
import { ensureGitignore } from "../gitignore.ts";
import { parseCli } from "../../core/utils.ts";
import { paint } from "../../core/console.ts";

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
# you override their model here too (builder/scout have no model of their
# own in the packaged roster, so they need no override). See
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
#   repo: owner/name          # "owner/name" (github) or "workspace/repo_slug" (bitbucket)
#   label_prefix: spf
#   chain: plan-build-test
#   base_branch: main
`;

// .spf/spf.config.yaml and .spf/prompt_engineering/ stay tracked — they're
// shared project config, same as package.json. Only runtime/generated
// content is ignored: session traces (data/), a hand-editable engine copy
// (engine/, from `spf eject`), and secrets (.env).
const GITIGNORE_ENTRIES = [".spf/data/", ".spf/engine/", ".env"];

export function initCommand(argv: string[]): number {
  const { options, flags } = parseCli(argv, ["cwd", "template"], ["force"]);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const sfDir = path.join(anchor.repo_root, ".spf");
  mkdirSync(sfDir, { recursive: true });

  const configPath = path.join(sfDir, "spf.config.yaml");
  if (existsSync(configPath) && !flags["force"]) {
    console.log(`${configPath} already exists — leaving it alone (--force to overwrite)`);
  } else {
    const templateName = options["template"];
    const content = templateName ? loadTemplate(templateName) : STARTER_CONFIG;
    writeFileSync(configPath, content);
    console.log(`wrote ${configPath}${templateName ? ` (from template "${templateName}")` : ""}`);
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
