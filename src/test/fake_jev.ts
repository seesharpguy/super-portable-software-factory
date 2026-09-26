/**
 * Shared test double for `core/jev.ts`'s `JevClient` — the seam every Jev
 * decision is tested through, so no test ever touches the network (the
 * module header's invariant 8). Same role `FakeProvider`/`FakeAsker` play
 * for their own interfaces.
 *
 * A `FakeJevClient` is driven by a RESPONDER: a function from the request
 * to the response (or a thrown error). The static constructors cover the
 * shapes every feature test needs:
 *
 *   FakeJevClient.choosing("high", 0.92)        // every question answers "high" @ 0.92
 *   FakeJevClient.answering({ q0: {...} })      // exact answers per question name
 *   FakeJevClient.failing(new JevApiError(529, "overloaded"))
 *   FakeJevClient.hanging()                     // never answers; rejects with AbortError when the caller's timeout aborts
 *   FakeJevClient.scoring(2, 0.8)               // score answer at level index 2 (0-based)
 *
 * `calls` records every request, so a test can assert "disabled => zero
 * calls" or inspect the exact closed option set sent as `criteria`;
 * `signals` records each call's `AbortSignal` (same index), so a test can
 * assert the client actually observed the timeout's abort.
 *
 * Two injection routes (see `core/jev.ts`):
 *   - direct:        `createJev({ config, client: fake })`
 *   - process-wide:  `setJevClientFactory(() => fake)` for code that builds
 *                    its own `Jev` (e.g. `Run.jev` via `startRun`); ALWAYS
 *                    reset with `setJevClientFactory(null)` in a `finally`.
 */
import type { JevClient, SystemOneRequest, SystemOneResponse } from "../core/jev.js";

export type JevResponder = (request: SystemOneRequest, options: { signal: AbortSignal }) => SystemOneResponse | Promise<SystemOneResponse>;

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

export class FakeJevClient implements JevClient {
  readonly calls: SystemOneRequest[] = [];
  readonly signals: AbortSignal[] = [];
  private readonly responder: JevResponder;

  constructor(responder: JevResponder) {
    this.responder = responder;
  }

  async systemOne(request: SystemOneRequest, options: { signal: AbortSignal }): Promise<SystemOneResponse> {
    this.calls.push(request);
    this.signals.push(options.signal);
    if (options.signal.aborted) throw abortError();
    return this.responder(request, options);
  }

  /** Every question in the request answers `choice` with `confidence` (a choice-shaped answer). */
  static choosing(choice: string, confidence: number, usage = { input_tokens: 10, output_tokens: 0 }): FakeJevClient {
    return new FakeJevClient((request) => ({
      model: request.model,
      answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: "choice", choice, confidence }])),
      usage,
    }));
  }

  /** Every question answers a score at 0-based `level` with `confidence`, via a one-hot `probabilities` map. */
  static scoring(level: number, confidence: number): FakeJevClient {
    return new FakeJevClient((request) => ({
      model: request.model,
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([name, question]) => {
          const levels = question.type === "score" ? question.criteria.length : 0;
          const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === level ? 1 : 0]));
          return [name, { type: "score", score: level, probabilities, confidence }];
        }),
      ),
      usage: { input_tokens: 10, output_tokens: 0 },
    }));
  }

  /** Exact `answers` map, keyed by question name (`q0`, `q1`, ... in item order for `decideBatch`). */
  static answering(answers: Record<string, unknown>): FakeJevClient {
    return new FakeJevClient((request) => ({ model: request.model, answers, usage: { input_tokens: 10, output_tokens: 0 } }));
  }

  static failing(error: Error): FakeJevClient {
    return new FakeJevClient(() => {
      throw error;
    });
  }

  /** Never answers on its own; when the caller's timeout aborts the signal, rejects with an `AbortError` (so the promise settles and `signals[i].aborted` is true). */
  static hanging(): FakeJevClient {
    return new FakeJevClient(
      (_request, { signal }) =>
        new Promise<SystemOneResponse>((_, reject) => {
          if (signal.aborted) return reject(abortError());
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
    );
  }

  /** Answers like `choosing(choice, confidence)`, but only after `ms` — for proving a batch's deadline is its LARGEST live `timeout_ms`. */
  static delayed(ms: number, choice: string, confidence: number): FakeJevClient {
    const inner = FakeJevClient.choosing(choice, confidence);
    return new FakeJevClient(
      (request, options) =>
        new Promise<SystemOneResponse>((resolve, reject) => {
          const timer = setTimeout(() => resolve(inner.systemOne(request, options)), ms);
          options.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(abortError());
            },
            { once: true },
          );
        }),
    );
  }
}
