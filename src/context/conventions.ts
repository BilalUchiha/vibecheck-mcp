/**
 * Convention reference.
 *
 * `follows_conventions` is the dimension most likely to produce generic advice,
 * because "matches the existing patterns" is meaningless without showing the
 * model what those patterns are. So we sample real files from the repository and
 * pass two things to Jev:
 *
 *   1. A measured style profile (casing shares, indent, quotes, semicolons),
 *      built by the same analyzer that judges the change. This is what makes
 *      concrete feedback possible - both sides are measured the same way.
 *   2. A short excerpt of real code, so the model can see patterns the profile
 *      does not capture, such as how errors are raised and how modules are laid
 *      out.
 *
 * Sampling prefers files in the same directories as the change, because the
 * convention that matters is the one used by the neighbours of the new code.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describeStyle, mergeProfiles, profileSource } from "./analyze.js";
import { shouldSkipPath } from "./filters.js";
import { listTrackedFiles, readRepoFile, type RepoInfo } from "./git.js";
import { detectLanguage, isTestFile, stripCode } from "./lang.js";
import { STATE_DIRNAME } from "../config.js";
import { log } from "../logger.js";
import type { StyleProfile } from "../types.js";

/** Per-file cap for convention samples. */
const SAMPLE_FILE_BYTES = 20_000;
/** Per-file cap for the code excerpt shown to Jev. */
const SAMPLE_EXCERPT_CHARS = 1_200;
const CACHE_VERSION = 2;

export interface ConventionSample {
  path: string;
  excerpt: string;
}

export interface ConventionReference {
  source: "auto" | "style_guide" | "off";
  baseline: StyleProfile | null;
  /** Human-readable description of the repo's conventions. */
  summary: string;
  sampleFiles: string[];
  samples: ConventionSample[];
  styleGuide: string | null;
  styleGuidePath: string | null;
  cacheHit: boolean;
  warnings: string[];
}

export interface ConventionOptions {
  projectRoot: string;
  repo: RepoInfo | null;
  changedPaths: string[];
  mode: "auto" | "file" | "off";
  styleGuide?: string | undefined;
  sampleSize: number;
  cacheTtlMs: number;
}

export function buildConventionReference(options: ConventionOptions): ConventionReference {
  const warnings: string[] = [];

  if (options.mode === "off") {
    return {
      source: "off",
      baseline: null,
      summary: "",
      sampleFiles: [],
      samples: [],
      styleGuide: null,
      styleGuidePath: null,
      cacheHit: false,
      warnings,
    };
  }

  let styleGuide: string | null = null;
  let styleGuidePath: string | null = null;
  if (options.mode === "file") {
    const relative = options.styleGuide ?? "STYLE.md";
    styleGuidePath = relative;
    try {
      const absolute = path.resolve(options.projectRoot, relative);
      const relativeToRoot = path.relative(options.projectRoot, absolute);
      if (relativeToRoot.startsWith("..")) {
        warnings.push(`style guide path escapes the project root: ${relative}`);
      } else if (fs.existsSync(absolute)) {
        styleGuide = fs.readFileSync(absolute, "utf8").slice(0, 4_000);
      } else {
        warnings.push(`style guide not found at ${relative}; falling back to sampling this repo`);
      }
    } catch (error) {
      warnings.push(`could not read style guide ${relative}: ${(error as Error).message}`);
    }
  }

  // A measured baseline is still collected in style-guide mode, because the
  // deterministic casing checks need numbers rather than prose. The summary
  // notes which source took precedence for the judgment.
  const topLevel = options.repo?.topLevel ?? options.projectRoot;
  const sampled = sampleRepo({
    topLevel,
    changedPaths: options.changedPaths,
    sampleSize: options.sampleSize,
    cacheTtlMs: options.cacheTtlMs,
    headSha: options.repo?.headSha ?? null,
    mode: options.mode,
    stateDir: path.join(options.projectRoot, STATE_DIRNAME),
  });
  warnings.push(...sampled.warnings);

  const baseline = sampled.baseline;
  const summary = baseline
    ? describeStyle(baseline)
    : "no convention sample was available for this repository";

  return {
    source: styleGuide ? "style_guide" : "auto",
    baseline,
    summary,
    sampleFiles: sampled.sampleFiles,
    samples: sampled.samples,
    styleGuide,
    styleGuidePath,
    cacheHit: sampled.cacheHit,
    warnings,
  };
}

interface SampleResult {
  baseline: StyleProfile | null;
  sampleFiles: string[];
  samples: ConventionSample[];
  cacheHit: boolean;
  warnings: string[];
}

function sampleRepo(options: {
  topLevel: string;
  changedPaths: string[];
  sampleSize: number;
  cacheTtlMs: number;
  headSha: string | null;
  mode: "auto" | "file";
  stateDir: string;
}): SampleResult {
  const warnings: string[] = [];
  const tracked = listTrackedFiles(options.topLevel).filter(
    (file) => !shouldSkipPath(file) && !isTestFile(file),
  );

  const changed = new Set(options.changedPaths.map((file) => file.replace(/\\/g, "/")));
  const byLanguage = tracked.filter((file) => {
    const language = detectLanguage(file);
    return language === "typescript" || language === "javascript" || language === "python";
  });

  const changedDirs = new Set(
    options.changedPaths
      .map((file) => path.posix.dirname(file.replace(/\\/g, "/")))
      .filter((dir) => dir !== "."),
  );

  // Neighbours of the change first: the closest convention wins.
  const neighbours = byLanguage.filter((file) => changedDirs.has(path.posix.dirname(file)));
  const others = byLanguage.filter((file) => !changedDirs.has(path.posix.dirname(file)));
  const candidates = [...neighbours, ...others].filter((file) => !changed.has(file));

  if (candidates.length === 0) {
    warnings.push("no existing source files were available to sample conventions from");
    return { baseline: null, sampleFiles: [], samples: [], cacheHit: false, warnings };
  }

  const cacheKey = hashKey([
    options.headSha ?? "no-head",
    options.mode,
    String(options.sampleSize),
    [...changedDirs].sort().join(","),
  ]);

  const cachePath = path.join(options.stateDir, "conventions.json");
  const cached = readCache(cachePath, options.cacheTtlMs);
  if (cached && cached.cacheKey === cacheKey) {
    log.debug("convention cache hit", { cacheKey, files: cached.sampleFiles.length });
    return {
      baseline: cached.baseline,
      sampleFiles: cached.sampleFiles,
      samples: cached.samples,
      cacheHit: true,
      warnings,
    };
  }

  const sampleFiles: string[] = [];
  const profiles: StyleProfile[] = [];
  const samples: ConventionSample[] = [];

  for (const file of candidates) {
    if (sampleFiles.length >= options.sampleSize) break;
    const read = readRepoFile(options.topLevel, file);
    if (!read.content || read.bytes > SAMPLE_FILE_BYTES * 4) continue;
    const language = detectLanguage(file);
    if (!language || language === "other") continue;
    const content = read.content.slice(0, SAMPLE_FILE_BYTES);
    profiles.push(profileSource(content, language));
    sampleFiles.push(file);
    samples.push({ path: file, excerpt: excerptOf(content, language) });
  }

  if (profiles.length === 0) {
    warnings.push("sampled files could not be read; convention baseline unavailable");
    return { baseline: null, sampleFiles: [], samples: [], cacheHit: false, warnings };
  }

  const baseline = mergeProfiles(profiles);
  writeCache(cachePath, {
    version: CACHE_VERSION,
    cacheKey,
    builtAt: Date.now(),
    baseline,
    sampleFiles,
    samples,
  });

  return { baseline, sampleFiles, samples, cacheHit: false, warnings };
}

/**
 * Show the first slice of a file with comments and string bodies intact - this
 * is a *style* reference, and comment style is part of style - but drop import
 * blocks and license headers, which are the least informative part of a file.
 */
function excerptOf(content: string, language: string): string {
  const lines = content.split(/\r?\n/);
  const meaningful: string[] = [];
  let seenCode = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!seenCode && /^(?:import|from|use|#include|"""|'''|\/\*|\/\/)/.test(trimmed)) {
      if (/^"""|^'''/.test(trimmed) && trimmed.length > 3) seenCode = true;
      continue;
    }
    seenCode = true;
    meaningful.push(line);
    if (meaningful.join("\n").length > SAMPLE_EXCERPT_CHARS) break;
  }
  const excerpt = meaningful.join("\n").slice(0, SAMPLE_EXCERPT_CHARS);
  // Sanity check: the excerpt should still parse as source, not as a fragment.
  const stripped = stripCode(excerpt, language === "python" ? "python" : "typescript");
  return stripped.trim().length === 0 ? "" : excerpt;
}

interface CacheShape {
  version: number;
  cacheKey: string;
  builtAt: number;
  baseline: StyleProfile;
  sampleFiles: string[];
  samples: ConventionSample[];
}

function readCache(cachePath: string, ttlMs: number): CacheShape | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const cache = parsed as CacheShape;
    if (cache.version !== CACHE_VERSION) return null;
    if (ttlMs > 0 && Date.now() - cache.builtAt > ttlMs) return null;
    if (!cache.baseline || !cache.cacheKey) return null;
    return cache;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, data: CacheShape): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data), "utf8");
  } catch (error) {
    // A cache is an optimisation; failing to write one must never fail a review.
    log.debug("could not write convention cache", { error: (error as Error).message });
  }
}

function hashKey(parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}
