/**
 * Per-project configuration.
 *
 * Resolution order (later wins):
 *   1. built-in `balanced` preset
 *   2. `.vibecheck.json` in the project root
 *   3. explicit tool-call arguments
 *   4. environment variables (judge credentials only)
 *
 * Thresholds are always expressed as normalised 0-1 values where 1 is
 * unambiguously "good". For `score` questions the raw Jev score is divided by
 * (levels - 1) before comparison, so a 4-level scale maps as:
 *   level 0 -> 0.00   level 1 -> 0.33   level 2 -> 0.67   level 3 -> 1.00
 */

import fs from "node:fs";
import path from "node:path";
import { GATE_DIMENSIONS, type GateDimension } from "./types.js";

export type PresetName = "lenient" | "balanced" | "strict";
export const PRESETS: PresetName[] = ["lenient", "balanced", "strict"];

export interface QuestionConfig {
  enabled: boolean;
  /** Normalised 0-1 pass threshold; scores below this fail the dimension. */
  threshold: number;
  /** Relative importance. Orders the fix list; does not gate by itself. */
  weight: number;
}

export interface ConventionsConfig {
  /**
   * `auto`  - sample tracked repo files and build a baseline profile
   * `file`  - read an explicit style guide and use it as the reference
   * `off`   - judge conventions against general best practice only
   */
  mode: "auto" | "file" | "off";
  /** Used when mode is `file`. Path is relative to the project root. */
  styleGuide?: string;
  sampleSize: number;
  /** Rebuild the cached baseline after this many milliseconds. */
  cacheTtlMs: number;
}

/** `auto` uses TypeSafe when a key is present and the offline mock otherwise. */
export type JudgeProvider = "auto" | "typesafe" | "mock";

export interface JudgeConfig {
  provider: JudgeProvider;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  /** Transport-level retries for 429/5xx. */
  maxAttempts: number;
  /** Ask diagnostic `choice` questions that name the *kind* of failure. */
  diagnostics: boolean;
  /** Pin the exact model version that answered, for reproducible logs. */
  recordModel: boolean;
}

export interface BudgetConfig {
  /** Hard cap on the serialised Jev `state` size, in characters. */
  maxStateChars: number;
  /** Per-file cap on diff/content characters. */
  maxCharsPerFile: number;
  /** Only the largest N changed files are sent in full detail. */
  maxChangedFiles: number;
}

export interface HardGatesConfig {
  /** Supplied test output reports failures. */
  failingTests: boolean;
  /** A likely credential was introduced in the diff. */
  committedSecret: boolean;
  /** The diff the agent submitted disagrees with git's view. */
  submissionMismatch: boolean;
}

export interface VibecheckConfig {
  preset: PresetName;
  maxRetries: number;
  questions: Record<GateDimension, QuestionConfig>;
  conventions: ConventionsConfig;
  judge: JudgeConfig;
  budget: BudgetConfig;
  hardGates: HardGatesConfig;
}

export interface ResolvedConfig {
  config: VibecheckConfig;
  /** Path of the config file that was loaded, if any. */
  configPath: string | null;
  projectRoot: string;
  /** Runtime state directory (`.vibecheck/`) for logs and caches. */
  stateDir: string;
}

export const CONFIG_FILENAME = ".vibecheck.json";
export const STATE_DIRNAME = ".vibecheck";

interface PresetQuestionTable {
  thresholds: Record<GateDimension, number>;
  weights: Record<GateDimension, number>;
}

const WEIGHTS: Record<GateDimension, number> = {
  satisfies_request: 3,
  scope_appropriate: 2,
  follows_conventions: 2,
  separation_of_concerns: 2,
  introduces_debt: 2,
  readability: 1.5,
  error_handling_present: 2.5,
  test_coverage_adequate: 1.5,
};

/**
 * The default thresholds are deliberately not "pass everything" and not
 * "demand perfection". Calibration intent:
 *
 *   lenient  - prototypes and spikes; only clear-cut problems should fail.
 *   balanced - everyday application code; the default.
 *   strict   - production services, libraries, anything with users.
 *
 * `intent` dimensions sit highest because getting the wrong thing right
 * perfectly is still a failure. Subjective quality dimensions sit lower so a
 * stylistic quibble cannot block a correct change.
 */
const PRESET_THRESHOLDS: Record<PresetName, Record<GateDimension, number>> = {
  lenient: {
    satisfies_request: 0.5,
    scope_appropriate: 0.45,
    follows_conventions: 0.5,
    separation_of_concerns: 0.45,
    introduces_debt: 0.55,
    readability: 0.5,
    error_handling_present: 0.5,
    test_coverage_adequate: 0.45,
  },
  balanced: {
    satisfies_request: 0.7,
    scope_appropriate: 0.6,
    follows_conventions: 0.65,
    separation_of_concerns: 0.6,
    introduces_debt: 0.7,
    readability: 0.62,
    error_handling_present: 0.62,
    test_coverage_adequate: 0.6,
  },
  strict: {
    satisfies_request: 0.85,
    scope_appropriate: 0.75,
    follows_conventions: 0.8,
    separation_of_concerns: 0.75,
    introduces_debt: 0.85,
    readability: 0.75,
    error_handling_present: 0.75,
    test_coverage_adequate: 0.75,
  },
};

function presetQuestions(preset: PresetName): PresetQuestionTable {
  const thresholds = PRESET_THRESHOLDS[preset];
  const out = {} as PresetQuestionTable;
  out.thresholds = { ...thresholds };
  out.weights = { ...WEIGHTS };
  return out;
}

export function defaultConfig(preset: PresetName = "balanced"): VibecheckConfig {
  const table = presetQuestions(preset);
  const questions = {} as Record<GateDimension, QuestionConfig>;
  for (const dimension of GATE_DIMENSIONS) {
    questions[dimension] = {
      enabled: true,
      threshold: table.thresholds[dimension],
      weight: table.weights[dimension],
    };
  }
  return {
    preset,
    maxRetries: 3,
    questions,
    conventions: { mode: "auto", sampleSize: 8, cacheTtlMs: 6 * 60 * 60 * 1000 },
    judge: {
      provider: "auto",
      model: "jev-latest",
      baseUrl: "https://api.typesafe.ai",
      timeoutMs: 20_000,
      maxAttempts: 3,
      diagnostics: true,
      recordModel: true,
    },
    budget: { maxStateChars: 60_000, maxCharsPerFile: 6_000, maxChangedFiles: 40 },
    hardGates: { failingTests: true, committedSecret: true, submissionMismatch: true },
  };
}

/* ------------------------------------------------------------------ *
 * Partial config as written by a user or by configure_project
 * ------------------------------------------------------------------ */

export interface PartialVibecheckConfig {
  preset?: PresetName;
  maxRetries?: number;
  questions?: Partial<Record<GateDimension, Partial<QuestionConfig>>>;
  conventions?: Partial<ConventionsConfig>;
  judge?: Partial<JudgeConfig>;
  budget?: Partial<BudgetConfig>;
  hardGates?: Partial<HardGatesConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Merge the named preset with a partial config. Choosing a non-default preset
 * re-bases thresholds, so `{ preset: "strict" }` alone gives you strict
 * thresholds with everything else untouched.
 */
export function mergeConfig(
  base: VibecheckConfig,
  partial: PartialVibecheckConfig,
): { config: VibecheckConfig; errors: string[] } {
  const errors: string[] = [];
  const preset = partial.preset ?? base.preset;
  const config: VibecheckConfig = structuredClone(
    partial.preset && partial.preset !== base.preset ? defaultConfig(preset) : base,
  );
  config.preset = preset;

  if (partial.maxRetries !== undefined) {
    const n = Number(partial.maxRetries);
    if (!Number.isFinite(n) || n < 1) errors.push("maxRetries must be a number >= 1");
    config.maxRetries = clamp(Math.round(n), 1, 20);
  }

  if (partial.questions) {
    for (const [key, value] of Object.entries(partial.questions)) {
      const dimension = key as GateDimension;
      const current = config.questions[dimension];
      if (!current) {
        errors.push(`unknown question id "${key}"`);
        continue;
      }
      if (!isRecord(value)) {
        errors.push(`questions.${key} must be an object`);
        continue;
      }
      if (value.enabled !== undefined) current.enabled = Boolean(value.enabled);
      if (value.threshold !== undefined) {
        const t = Number(value.threshold);
        if (!Number.isFinite(t) || t < 0 || t > 1) {
          errors.push(`questions.${key}.threshold must be between 0 and 1`);
        } else {
          current.threshold = t;
        }
      }
      if (value.weight !== undefined) {
        const w = Number(value.weight);
        if (!Number.isFinite(w) || w <= 0) errors.push(`questions.${key}.weight must be > 0`);
        else current.weight = w;
      }
    }
  }

  if (partial.conventions) {
    const c = partial.conventions;
    if (c.mode && !["auto", "file", "off"].includes(c.mode)) {
      errors.push(`conventions.mode must be one of auto|file|off`);
    } else if (c.mode) {
      config.conventions.mode = c.mode;
    }
    if (c.styleGuide !== undefined) config.conventions.styleGuide = c.styleGuide;
    if (c.sampleSize !== undefined) config.conventions.sampleSize = clamp(Math.round(c.sampleSize), 1, 50);
    if (c.cacheTtlMs !== undefined) config.conventions.cacheTtlMs = Math.max(0, c.cacheTtlMs);
  }

  if (partial.judge) {
    const j = partial.judge;
    if (j.provider && !["auto", "typesafe", "mock"].includes(j.provider)) {
      errors.push(`judge.provider must be one of auto|typesafe|mock`);
    } else if (j.provider) {
      config.judge.provider = j.provider;
    }
    if (j.model !== undefined) config.judge.model = String(j.model);
    if (j.baseUrl !== undefined) config.judge.baseUrl = String(j.baseUrl);
    if (j.timeoutMs !== undefined) config.judge.timeoutMs = clamp(j.timeoutMs, 1000, 120_000);
    if (j.maxAttempts !== undefined) config.judge.maxAttempts = clamp(Math.round(j.maxAttempts), 1, 10);
    if (j.diagnostics !== undefined) config.judge.diagnostics = Boolean(j.diagnostics);
    if (j.recordModel !== undefined) config.judge.recordModel = Boolean(j.recordModel);
  }

  if (partial.budget) {
    const b = partial.budget;
    if (b.maxStateChars !== undefined) config.budget.maxStateChars = clamp(Math.round(b.maxStateChars), 2000, 400_000);
    if (b.maxCharsPerFile !== undefined) config.budget.maxCharsPerFile = clamp(Math.round(b.maxCharsPerFile), 500, 200_000);
    if (b.maxChangedFiles !== undefined) config.budget.maxChangedFiles = clamp(Math.round(b.maxChangedFiles), 1, 2000);
  }

  if (partial.hardGates) {
    const h = partial.hardGates;
    if (h.failingTests !== undefined) config.hardGates.failingTests = Boolean(h.failingTests);
    if (h.committedSecret !== undefined) config.hardGates.committedSecret = Boolean(h.committedSecret);
    if (h.submissionMismatch !== undefined) config.hardGates.submissionMismatch = Boolean(h.submissionMismatch);
  }

  // Credentials come from the environment, never from the config file.
  config.judge.provider = resolveJudgeProvider(config.judge.provider);
  config.judge.baseUrl = process.env.TYPESAFE_BASE_URL ?? config.judge.baseUrl;
  config.judge.model = process.env.VIBECHECK_MODEL ?? config.judge.model;

  return { config, errors };
}

/**
 * The provider is chosen by: explicit env override > config file > auto-detect.
 * Auto-detect prefers the real judge whenever a key is present; without a key
 * the mock keeps the tool usable instead of erroring on every submission.
 */
export function resolveJudgeProvider(configured: JudgeProvider): "typesafe" | "mock" {
  const override = (process.env.VIBECHECK_JUDGE ?? "").toLowerCase();
  if (override === "mock" || override === "typesafe") return override;
  if (configured === "typesafe" || configured === "mock") return configured;
  return hasApiKey() ? "typesafe" : "mock";
}

export function hasApiKey(): boolean {
  const key = process.env.TYPESAFE_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

/* ------------------------------------------------------------------ *
 * Load / save
 * ------------------------------------------------------------------ */

export interface LoadResult extends ResolvedConfig {
  warnings: string[];
}

export function loadConfig(
  projectRootInput: string | undefined,
  overrides?: PartialVibecheckConfig,
): LoadResult {
  const projectRoot = path.resolve(projectRootInput ?? process.cwd());
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  const warnings: string[] = [];

  let fileConfig: PartialVibecheckConfig = {};
  let loadedFrom: string | null = null;
  if (fs.existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (isRecord(parsed)) {
        fileConfig = parsed as PartialVibecheckConfig;
        loadedFrom = configPath;
      } else {
        warnings.push(`${CONFIG_FILENAME} must contain a JSON object; ignoring it`);
      }
    } catch (error) {
      warnings.push(
        `${CONFIG_FILENAME} is not valid JSON (${(error as Error).message}); using built-in defaults`,
      );
    }
  }

  const base = defaultConfig(fileConfig.preset ?? "balanced");
  const fromFile = mergeConfig(base, fileConfig);
  warnings.push(...fromFile.errors.map((e) => `${CONFIG_FILENAME}: ${e}`));

  // Tool-call overrides win over the file, and are not additive across presets.
  const merged = overrides ? mergeConfig(fromFile.config, overrides) : fromFile;
  warnings.push(...(overrides ? merged.errors.map((e) => `tool arguments: ${e}`) : []));

  return {
    config: merged.config,
    configPath: loadedFrom,
    projectRoot,
    stateDir: path.join(projectRoot, STATE_DIRNAME),
    warnings,
  };
}

/** Serialise the config back to disk, merging into whatever is already there. */
export function saveConfig(
  projectRoot: string,
  partial: PartialVibecheckConfig,
): { path: string; written: PartialVibecheckConfig } {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (isRecord(parsed)) existing = parsed;
    } catch {
      // A corrupt file is replaced rather than silently appended to.
      existing = {};
    }
  }

  const merged: Record<string, unknown> = { ...existing };
  if (partial.preset) merged.preset = partial.preset;
  if (partial.maxRetries !== undefined) merged.maxRetries = partial.maxRetries;
  if (partial.conventions) merged.conventions = { ...(existing.conventions as object), ...partial.conventions };
  if (partial.judge) merged.judge = { ...(existing.judge as object), ...partial.judge };
  if (partial.budget) merged.budget = { ...(existing.budget as object), ...partial.budget };
  if (partial.hardGates) merged.hardGates = { ...(existing.hardGates as object), ...partial.hardGates };
  if (partial.questions) {
    const prior = isRecord(existing.questions) ? { ...existing.questions } : {};
    for (const [key, value] of Object.entries(partial.questions)) {
      prior[key] = { ...(isRecord(prior[key]) ? prior[key] : {}), ...value };
    }
    merged.questions = prior;
  }

  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { path: configPath, written: merged as PartialVibecheckConfig };
}
