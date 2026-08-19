/**
 * ADW Build Review — implement, then confirm it is what was asked for.
 *
 * Usage:
 *   bun run adws/adw_build_review.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> builder -> reviewer [-> builder(revise) -> reviewer ... bounded]
 *
 * Review is not testing. Tests answer "does it run"; the reviewer answers "is this
 * the thing that was asked for" — it reads the spec (`plan.md` from a prior plan
 * phase if the session has one, else the prompt verbatim), reads the code that was
 * written, and rules on each requirement.
 *
 * Like the tester, the reviewer's phase succeeds when it RUNS and REPORTS. A
 * rejection does not fail the phase; it fails the run, checked at the end, after
 * the bounded revise loop has had its chances.
 */

import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as session from "../core/session.ts";
import { BuildOutput, ReviewOutput, makeAgentCall, makePhaseParams, type BuildOutputT, type ReviewOutputT } from "../core/data_types.ts";

const REQUIRED_AGENTS = ["builder", "reviewer"];
const MAX_REVISION_LOOPS = 3;

export async function main(prompt: string, config: string = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
  const cfg = agents.loadConfig(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adwId);

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt });
  });

  let previous: BuildOutputT = await run.phase(
    makePhaseParams({ name: "build", kind: "agent", owner: "builder", description: "Implement the request" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, gates: [gates.diffMatchesClaims] })),
  );

  let review: ReviewOutputT | null = null;
  for (let i = 1; i <= MAX_REVISION_LOOPS; i++) {
    review = await run.phase(
      makePhaseParams({
        name: `review_${i}`,
        kind: "agent",
        owner: "reviewer",
        description: "Rule on every requirement in the spec, against the code on disk",
      }),
      (ph) =>
        ph.call(
          makeAgentCall({ output_type: ReviewOutput, prompt, previous, gates: [gates.artifactsExist, gates.verdictConsistent] }),
        ),
    );

    if (review.approved) break;
    if (i === MAX_REVISION_LOOPS) break;

    previous = await run.phase(
      makePhaseParams({
        name: `revise_${i}`,
        kind: "agent",
        owner: "builder",
        retries: 1,
        description: "Close every blocking finding the reviewer named",
      }),
      (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: review!, gates: [gates.diffMatchesClaims] })),
    );
  }

  return run.finish(review !== null && review.approved, `the reviewer never approved after ${MAX_REVISION_LOOPS} revision(s)`);
}
