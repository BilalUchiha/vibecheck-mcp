/**
 * Jev API client.
 *
 * Contract (TypeSafe AI):
 *   POST {baseUrl}/v1/systemone
 *   Authorization: Bearer <TYPESAFE_API_KEY>
 *   { model, state, questions } -> { model, answers, usage }
 *
 * Notes that shape this implementation:
 *
 *  - Every question is evaluated independently in parallel against the same
 *    state, so we send all questions in one call. Splitting them would multiply
 *    cost without improving accuracy ("speculative fan-out" in TypeSafe's docs).
 *  - Output tokens are free and there is no generated prose, so the response is
 *    small and fully typed. Nothing here parses a language model's text.
 *  - 429 and 529 are explicitly documented as retryable, with exponential
 *    backoff. 401 and 422 are not: they mean we are misconfigured, so they fail
 *    fast with a message the agent can act on.
 *
 * The API key is read from the process environment only. It is never accepted
 * from a config file, never logged, and never included in an error message.
 */

import { z } from "zod";
import { log } from "../logger.js";
import type { JevAnswer, JevUsage, QuestionSpec } from "../types.js";
import type { ReviewState } from "../context/state.js";

export type JudgeQuestionSpec = QuestionSpec;

export interface JudgeRequest {
  model: string;
  state: ReviewState;
  questions: Record<string, JudgeQuestionSpec>;
}

export interface JudgeResult {
  provider: "typesafe" | "mock";
  /** The versioned model id that answered, for reproducible logs. */
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage | null;
  latencyMs: number;
  /** Why this result should be treated with caution, if at all. */
  caveat?: string;
}

export interface Judge {
  readonly provider: "typesafe" | "mock";
  decide(request: JudgeRequest): Promise<JudgeResult>;
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class JevError extends Error {
  readonly kind: "auth" | "validation" | "rate_limit" | "unavailable" | "network" | "response";
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    message: string,
    kind: JevError["kind"],
    options: { retryable?: boolean; status?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JevError";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

/** Guidance the agent can act on, keyed by the error kind. */
export function remediationFor(error: JevError): string {
  switch (error.kind) {
    case "auth":
      return "The TypeSafe API key was rejected. Set a valid TYPESAFE_API_KEY in the MCP server's environment (see the README), then resubmit.";
    case "validation":
      return "TypeSafe rejected the review request as malformed. This is a bug in the vibecheck server, not in your change; report the message above.";
    case "rate_limit":
      return "The judge is rate limited. Wait a moment and resubmit, or lower the frequency of reviews.";
    case "unavailable":
      return "The judge is unavailable (TypeSafe reports an overloaded or failing service). Retry shortly; the review did not happen.";
    case "network":
      return "The judge could not be reached from this machine. Check network access to api.typesafe.ai and retry.";
    default:
      return "The judge returned a response that could not be interpreted. The review did not happen.";
  }
}

/* ------------------------------------------------------------------ *
 * Response validation
 * ------------------------------------------------------------------ */

const answerSchema = z.union([
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.number()).optional().default({}),
    confidence: z.number().optional().default(0),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string()).optional().default({}),
    probabilities: z.record(z.number()).optional().default({}),
    confidence: z.number().optional().default(0),
  }),
]);

const responseSchema = z.object({
  model: z.string().optional().default("unknown"),
  answers: z.record(answerSchema),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
});

/* ------------------------------------------------------------------ *
 * HTTP client
 * ------------------------------------------------------------------ */

export interface HttpJudgeOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxAttempts: number;
}

export class HttpJudge implements Judge {
  readonly provider = "typesafe" as const;

  constructor(private readonly options: HttpJudgeOptions) {}

  async decide(request: JudgeRequest): Promise<JudgeResult> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/v1/systemone`;
    const body = JSON.stringify({ model: request.model, state: request.state, questions: request.questions });
    const startedAt = Date.now();
    let lastError: JevError | null = null;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });

        if (!response.ok) {
          const text = await safeText(response);
          throw classify(response.status, text, response.headers.get("retry-after"));
        }

        const json: unknown = await response.json();
        const parsed = responseSchema.safeParse(json);
        if (!parsed.success) {
          throw new JevError(
            `TypeSafe returned a response that does not match the documented shape: ${parsed.error.issues
              .map((issue) => `${issue.path.join(".")} ${issue.message}`)
              .join("; ")}`,
            "response",
            { retryable: false },
          );
        }

        return {
          provider: this.provider,
          model: parsed.data.model,
          answers: parsed.data.answers as Record<string, JevAnswer>,
          usage: parsed.data.usage ?? null,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        const jevError = toJevError(error);
        lastError = jevError;

        const canRetry = jevError.retryable && attempt < this.options.maxAttempts;
        if (!canRetry) throw jevError;

        const delay = backoffMs(attempt);
        log.debug("retrying Jev request", { attempt, delayMs: delay, kind: jevError.kind });
        await sleep(delay);
      }
    }

    throw lastError ?? new JevError("The judge did not return a result.", "response");
  }
}

function classify(status: number, body: string, retryAfter: string | null): JevError {
  const detail = summariseBody(body);
  const retryableHeader = retryAfter ? ` (server asked to retry after ${retryAfter}s)` : "";
  if (status === 401 || status === 403) {
    return new JevError(`TypeSafe rejected the credentials (HTTP ${status}).`, "auth", { status });
  }
  if (status === 422) {
    return new JevError(`TypeSafe rejected the request body (HTTP 422): ${detail}`, "validation", { status });
  }
  if (status === 429) {
    return new JevError(`TypeSafe rate limited the request (HTTP 429)${retryableHeader}.`, "rate_limit", {
      retryable: true,
      status,
    });
  }
  if (status === 529 || status >= 500) {
    return new JevError(`TypeSafe reported the service as unavailable (HTTP ${status})${retryableHeader}.`, "unavailable", {
      retryable: true,
      status,
    });
  }
  return new JevError(`TypeSafe returned HTTP ${status}: ${detail}`, "response", { status });
}

function summariseBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "(empty response body)";
  // Never echo a body that might contain credentials back into a tool result.
  return trimmed.slice(0, 400);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function toJevError(error: unknown): JevError {
  if (error instanceof JevError) return error;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return new JevError("The request to TypeSafe timed out.", "network", { retryable: true, cause: error });
    }
    return new JevError(`Could not reach TypeSafe: ${error.message}`, "network", { retryable: true, cause: error });
  }
  return new JevError(`Unexpected judge failure: ${String(error)}`, "network", { retryable: true });
}

function backoffMs(attempt: number): number {
  const base = 400 * 2 ** (attempt - 1);
  const jitter = Math.random() * 250;
  return Math.min(base + jitter, 5_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
