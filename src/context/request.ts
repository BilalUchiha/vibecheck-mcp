/**
 * Request verifiability.
 *
 * The task description is the input the whole review hinges on: it is what
 * "satisfies the request" is judged against. When it states no checkable
 * requirement, that question has no determinate answer, and both outcomes
 * available to the gate are wrong - `approved` certifies work nobody defined,
 * and `needs_fixes` sends the agent to fix problems that were never identified.
 * A vague request is therefore detected *before* it is judged, so it can be sent
 * back for acceptance criteria instead of being scored.
 *
 * The check is deliberately conservative. A false "too vague" costs a round trip
 * and asks the user to restate a request they already stated clearly, which is
 * worse than missing a vaguely-worded one. So the default answer is "verifiable",
 * and anything concrete about the work - a file, a symbol, a command, an endpoint,
 * a measured quantity, a stated outcome - counts as concrete.
 */

export interface RequestAssessment {
  verifiable: boolean;
  /** Why the assessment came out this way, phrased for the agent to read. */
  signals: string[];
  /** What to add so the request can be judged. Empty when it already can be. */
  suggestions: string[];
}

/**
 * Quality judgements rather than requirements: "better", "clean up", "improve".
 * They describe a direction of travel, not a condition anything can be checked
 * against, so a request resting on them is unverifiable however long it is.
 */
const VAGUE_WORDS = [
  "better", "best", "improve", "improves", "improved", "improvement",
  "nicer", "nice", "good", "gooder", "great", "greater", "happier", "happy",
  "cleaner", "clean", "simpler", "faster", "smarter", "smoother",
  "tidy", "polish", "optimi", "optimise", "optimize", "refactor",
  "modernise", "modernize", "enhance", "tweak", "revamp", "upgrade",
  "awesome", "awesomer", "robustness", "robust", "quality", "solid", "proper", "properly",
];

const VAGUE_PHRASES = ["clean up", "clean-up", "more robust", "higher quality", "more usable", "more maintainable"];

const VAGUE_SET = new Set([...VAGUE_WORDS, ...VAGUE_PHRASES]);

const VAGUE_TERMS = new RegExp(
  `\\b(?:${[...VAGUE_SET].sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|").replace(/ /g, "\\s+")})\\b`,
  "gi",
);

/** Words that carry no requirement on their own, used only to weigh a clause. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could", "do", "does",
  "for", "from", "has", "have", "if", "in", "into", "is", "it", "its", "may", "might", "more", "must",
  "no", "not", "of", "on", "or", "our", "out", "should", "so", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "those", "to", "up", "us", "was", "we", "were", "will",
  "with", "would", "you", "your",
]);

/**
 * Things that make a request checkable. Each is a signal that the request points
 * at something an observer could look at, so any single match settles it.
 */
const ANCHORS: { label: string; pattern: RegExp }[] = [
  { label: "a backticked name", pattern: /`[^`\n]+`/ },
  {
    label: "a file or path",
    pattern:
      /\b[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|json|jsonc|ya?ml|toml|md|css|scss|html|sh|sql|tf)\b/i,
  },
  {
    label: "a code identifier",
    pattern: /\b[a-z][a-z0-9]*[A-Z]\w+|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[a-zA-Z_]\w*\(\)/,
  },
  { label: "an HTTP call", pattern: /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/|https?:\/\/\S+/i },
  { label: "a command-line flag", pattern: /(?:^|\s)--[a-z][\w-]*/i },
  {
    label: "a measured quantity",
    pattern: /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|min|minutes|hours?|kb|mb|gb|%|x|times|rows|items|lines|files)\b/i,
  },
  {
    // A named artefact or behaviour is checkable even without a symbol name, so
    // these are anchors rather than vague words.
    label: "a named behaviour",
    pattern:
      /\b(?:tests?|test suite|typecheck|type check|lint(?:ing)?|build|compil\w*|snapshot|logs?|stdout|stderr|exit code|endpoints?|routes?|apis?|cli|commands?|flags?|config(?:uration)?|settings?|schemas?|migrations?|indexes?|indices|queries|timeouts?|retr(?:y|ies)|error messages?|exceptions?|status codes?|interfaces?|signatures?|getters?|setters?|validat\w+|escap\w+)\b/i,
  },
];

/**
 * Politeness and generic verbs. They make a sentence longer without making it
 * checkable - "please make it better" must not pass just because "please" and
 * "make" survive the word filters.
 */
const FILLER_WORDS = new Set([
  "please", "kindly", "make", "makes", "making", "made", "get", "gets", "got", "give", "let", "want",
  "wants", "like", "liked", "work", "works", "thing", "things", "stuff", "something", "anything",
  "everything", "nothing", "some", "most", "very", "really", "quite", "just", "also", "again", "still",
  "now", "here", "there", "more", "less", "much", "many", "all", "any", "each", "every", "help",
]);

/** Words that introduce an outcome or a constraint the work must meet. */
const CLAUSE_MARKER =
  /\b(?:so that|so|because|in order to|instead of|rather than|without|should|must|needs? to|has to|at most|at least|no more than|when)\b/i;

/**
 * Words are counted crudely on purpose: this only has to distinguish a one-line
 * aside from a sentence that describes work.
 */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word)).length;
}

/**
 * True when the outcome clause states something an observer could check.
 *
 * The distinction this draws is the whole point of the check: "so a user can
 * download their report" is a condition, whereas "so it is nicer" only restates
 * a quality judgement, and a request built on the second is no more verifiable
 * for having the word "so" in it. The test is whether anything concrete survives
 * once the clause markers and the judgement words are removed.
 */
function clauseStatesSomethingCheckable(text: string): boolean {
  const match = CLAUSE_MARKER.exec(text);
  if (!match) return false;
  const rest = text.slice(match.index + match[0].length).toLowerCase();
  const content = new Set(
    rest
      .split(/[^a-z0-9_]+/)
      .filter(
        (word) =>
          word.length >= 3 && !STOPWORDS.has(word) && !FILLER_WORDS.has(word) && !VAGUE_SET.has(word),
      ),
  );
  return content.size >= 2;
}

/**
 * Assess whether a request states anything a reviewer could check.
 *
 * `acceptanceCriteria` is the agent's own statement of what it took the request
 * to mean - the documented way to make an open-ended request judgeable, so it is
 * assessed as part of the request rather than separately.
 */
export function assessRequest(taskDescription: string, acceptanceCriteria?: string | null): RequestAssessment {
  const request = taskDescription.trim();
  const criteria = (acceptanceCriteria ?? "").trim();
  const assessed = criteria ? `${request}\n${criteria}` : request;

  const anchors = ANCHORS.filter((anchor) => anchor.pattern.test(assessed)).map((anchor) => anchor.label);
  if (anchors.length > 0) {
    return {
      verifiable: true,
      signals: [`names something concrete: ${anchors.slice(0, 4).join(", ")}`],
      suggestions: [],
    };
  }

  if (clauseStatesSomethingCheckable(assessed)) {
    return {
      verifiable: true,
      signals: ["states an outcome or constraint to check the change against"],
      suggestions: [],
    };
  }

  const words = wordCount(assessed);
  const vague = [...new Set((assessed.match(VAGUE_TERMS) ?? []).map((term) => term.toLowerCase()))];

  // Long enough to describe work, with nothing in it that only judges quality.
  if (vague.length === 0 && words >= 6) {
    return {
      verifiable: true,
      signals: ["describes the work in its own terms rather than resting on a quality judgement"],
      suggestions: [],
    };
  }

  return {
    verifiable: false,
    signals: [
      vague.length > 0
        ? `rests on judgement words rather than a requirement: ${vague.slice(0, 6).join(", ")}`
        : `only ${words} word(s) long, with no requirement stated`,
      criteria
        ? "the acceptance criteria in `notes` do not name anything checkable either"
        : "names no file, symbol, command, endpoint or behaviour to check against",
    ],
    suggestions: [
      "name the file, symbol or behaviour the change should produce",
      "say how the result can be observed: a command to run, an endpoint to call, a value to expect",
      "or state the acceptance criteria you are working to in `notes` and resubmit - a vague request with explicit criteria in `notes` is judged normally",
    ],
  };
}
