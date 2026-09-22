/**
 * Judge selection.
 *
 * The provider is chosen in this order:
 *   1. VIBECHECK_JUDGE environment override
 *   2. the project config
 *   3. auto-detection: TypeSafe when a key is present, otherwise the offline mock
 *
 * Auto-detection deliberately falls back to the mock rather than failing, so a
 * project that has not yet obtained a key still gets a working (if clearly
 * caveated) loop instead of a tool that errors on every submission.
 */

import { hasApiKey, resolveJudgeProvider, type VibecheckConfig } from "../config.js";
import { log } from "../logger.js";
import { HttpJudge, JevError, remediationFor, type Judge } from "./client.js";
import { MockJudge } from "./mock.js";

export { HttpJudge, JevError, remediationFor, MockJudge };
export type { Judge, JudgeRequest, JudgeResult, JudgeQuestionSpec } from "./client.js";

export function createJudge(config: VibecheckConfig): Judge {
  const provider = resolveJudgeProvider(config.judge.provider);

  if (provider === "typesafe") {
    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) {
      log.warn("Typesafe provider selected but TYPESAFE_API_KEY is not set; using the offline mock");
      return new MockJudge();
    }
    log.debug("using TypeSafe judge", { model: config.judge.model, baseUrl: config.judge.baseUrl });
    return new HttpJudge({
      baseUrl: config.judge.baseUrl,
      apiKey,
      timeoutMs: config.judge.timeoutMs,
      maxAttempts: config.judge.maxAttempts,
    });
  }

  log.debug("using offline mock judge", { apiKeyPresent: hasApiKey() });
  return new MockJudge();
}
