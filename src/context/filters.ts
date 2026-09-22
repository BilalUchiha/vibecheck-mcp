/**
 * Path filtering.
 *
 * Generated, vendored and lock files add tokens, dilute Jev's attention and
 * produce meaningless findings (nobody should be told that a lockfile has
 * inconsistent naming). They are skipped for both the review state and the
 * convention sample.
 */

const SKIP_SEGMENTS = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".git",
  ".vibecheck",
  "__pycache__",
  ".venv",
  "venv",
  "site-packages",
  ".mypy_cache",
  ".pytest_cache",
  ".idea",
  ".vscode",
]);

const SKIP_FILE_PATTERNS: RegExp[] = [
  /\.min\.(?:js|css)$/i,
  /\.bundle\.js$/i,
  /\.(?:lock|lockb)$/i,
  /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|Cargo\.lock)$/i,
  /\.(?:map|snap|snapshot)$/i,
  /\.(?:png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|otf|pdf|zip|gz|tar|mp4|mov|webm|wasm|so|dll|dylib|exe|bin|pyc|class|jar)$/i,
  /\.d\.ts$/i,
  /(?:^|\/)generated\//,
  /(?:^|\/)migrations?\//, // usually machine-written; noise for convention purposes
];

export function shouldSkipPath(filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalised.split("/");
  for (const segment of segments) {
    if (SKIP_SEGMENTS.has(segment)) return true;
  }
  return SKIP_FILE_PATTERNS.some((pattern) => pattern.test(normalised));
}

/** Cap on how much of a single file we are willing to read into memory. */
export const MAX_FILE_BYTES = 400_000;
