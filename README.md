<div align="center">

# vibecheck

**An external "done" gate for AI coding agents — judged by [TypeSafe AI's Jev](https://typesafe.ai).**

Your agent thinks it's finished. vibecheck disagrees, lists exactly what to fix, and only then lets it say the word "done".

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![MCP](https://img.shields.io/badge/protocol-MCP-black)](https://modelcontextprotocol.io)

</div>

---

## The problem it solves

AI coding agents decide *for themselves* when a task is complete. That judgment is exactly what fails in practice: partial implementations get reported as done, scope balloons, conventions get ignored, error handling is skipped, and tests are trivial. The agent is never wrong on purpose — it just has no external criterion to check against.

vibecheck is that criterion. It's an MCP server any MCP-compatible agent (Claude Code, Cursor, Codex, …) calls at the *"I think I'm done"* moment. Instead of trusting the agent's self-assessment, it:

1. **Gathers the real change set** from git — not from what the agent claims it changed
2. **Measures it deterministically** — casing vs. the repo's own conventions, hardcoded values, unhandled failures, leftover TODOs, assertion-free tests
3. **Asks Jev** — a fast, non-generative decision model that returns *calibrated probability scores* over 8 quality dimensions, all in one cheap call (~70–500 ms)
4. **Returns a verdict** — `approved`, or a specific, file-and-line fix list the agent must work through and resubmit against

Bring your own key: vibecheck calls the Jev API with your key, and carries no inference cost of its own.

## What a verdict looks like

`follows_conventions` scoring 0.30 in a snake_case repo doesn't come back as a number. It comes back as this:

> **Naming does not match the repository**
> Rename the identifiers below to snake_case. The repository's own declarations are the reference: snake_case naming (75% of 8 declarations), 4-space indent, double quotes.
>
> - `app/reports.py:8` — `getUserData` is camelCase but the repo uses snake_case; rename to `get_user_data`
> - `app/reports.py:14` — `formatReport` is camelCase but the repo uses snake_case; rename to `format_report`

And `error_handling_present` at 0.33 becomes:

> **A fallible call has no failure handling**
> Wrap each call below in explicit failure handling:
>
> - `app/reports.py:9` in `getUserData()` — fallible call with no try/except: `response = requests.get(f"{REPORT_API}/{userId}")`
> - `app/reports.py:26` in `exportReport()` — fallible call with no try/except: `with open(destination, "w", encoding="utf-8") as handle:`

Every instruction cites evidence that was actually measured. Nothing is invented.

## Quick start

### 1. Get the server

```bash
git clone https://github.com/<owner>/vibecheck-mcp.git
cd vibecheck-mcp
npm install && npm run build
```

### 2. Get a Jev key

Join the early-access waitlist at [typesafe.ai](https://typesafe.ai), open the console at `console.typesafe.ai`, and create a key under **API Keys**. Then either:

- put it in a `.env` file in this directory (copy `.env.example`), or
- pass it via your client's `env` block (next step).

Without a key, vibecheck falls back to a built-in offline heuristic judge — fine for plumbing and demos, but **it is not a real review** and every verdict it issues says so.

### 3. Register it with your agent

**Claude Code** — one command:

```bash
claude mcp add vibecheck --scope user -- node /absolute/path/to/vibecheck-mcp/dist/index.js
```

Or `.mcp.json` in any project (works in Claude Code and Cursor):

```json
{
  "mcpServers": {
    "vibecheck": {
      "command": "node",
      "args": ["/absolute/path/to/vibecheck-mcp/dist/index.js"],
      "env": { "TYPESAFE_API_KEY": "your-key-here" }
    }
  }
}
```

### 4. Make the agent actually call it

Registering the tool doesn't make the agent use it — paste the standing rule from [`examples/agent-instructions.md`](examples/agent-instructions.md) into your `CLAUDE.md`, a Cursor rule, or `AGENTS.md`. Keep it in version control so the gate doesn't silently vanish for the next contributor.

That's it. From now on, every "I'm done" goes through the gate first.

## How the loop works

```
agent finishes a task
        │
        ▼
submit_for_review ──► collect real change set (git-authoritative)
        │                     │
        │              deterministic analysis (measured facts)
        │                     │
        │              Jev: 8 scoring + 8 diagnostic questions, one call
        │                     │
        ▼                     ▼
   verdict ◄───────── thresholds + hard gates
   │        │
   │        └─ needs_fixes ──► specific fix list ──► agent fixes, resubmits
   │                            (retry budget: default 10, counted server-side)
   └─ approved ──► agent may now tell the user it's done
```

A request the gate cannot check is sent back for acceptance criteria rather than scored. When the retry budget is exhausted, the agent is told to **stop and report the outstanding issues to the user** — never to loop forever, and never to describe the task as finished.

## The tools

### `submit_for_review`

| Input | Required | Meaning |
| --- | --- | --- |
| `task_description` | ✔ | The user's original request, verbatim. Judged against it — a favourable paraphrase weakens the review. |
| `project_root` | | Absolute path to the repo. Locates config, conventions, and git. |
| `changed_files` | | Required outside git repos. In a repo, git supplies the change set — but listing the files still helps: a file git can't place inside the reviewed range widens that range to include it. Report the whole change, not one file from it. |
| `test_results` | | Raw output or `{passed, failures, output}`. Failing tests are a hard gate. |
| `notes` | | Context the diff can't show — e.g. why an apparent shortcut is deliberate. |

Returns `verdict`, per-dimension `scores`, an ordered `feedback` list (title, instruction, evidence, files, severity), `attempts_remaining`, and a `next_action` instruction the agent can act on directly.

Five verdicts: `approved` · `needs_fixes` · `max_retries_exceeded` · `review_unavailable` (the judge couldn't be reached) · `needs_clarification` (the request states nothing checkable — see below). The last two are not verdicts on the change and consume no retry.

### `configure_project`

Writes/updates `.vibecheck.json`: presets, per-dimension thresholds and toggles, retry limit, convention sampling mode, review scope, judge settings. Supports `dry_run` and `reset_attempts`.

### `get_review_log`

Recent submissions and verdicts for a project — attempt numbers, scores, which gates fired, which judge answered, and which dimensions fail most often. Reading never consumes a retry.

## Configuration

`.vibecheck.json` at the project root. Everything is optional; absent values come from the preset (`lenient` · `balanced` · `strict`).

```json
{
  "preset": "balanced",
  "maxRetries": 10,
  "conventions": { "mode": "auto", "sampleSize": 8 },
  "questions": {
    "follows_conventions": { "enabled": true, "threshold": 0.7, "weight": 2 },
    "test_coverage_adequate": { "enabled": false }
  },
  "judge": { "provider": "auto", "model": "jev-latest", "diagnostics": true },
  "hardGates": { "failingTests": true, "committedSecret": true, "submissionMismatch": true },
  "scope": { "mode": "auto", "maxCommits": 20, "maxAgeHours": 12 },
  "intent": { "onUnverifiableRequest": "clarify" }
}
```

Ready-made examples in [`examples/`](examples/): a strict production config, a lenient prototype config, and a style-guide config.

### Review scope

How much of the repository a review covers, on the occasions when git can't infer it from a branch.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto` reviews the trailing run of commits that plausibly belongs to the task; `last-commit` reviews only the newest commit; `working-tree` never looks at committed work |
| `maxCommits` | 20 | Hard cap on how many commits one review may span |
| `maxAgeHours` | 12 | How far back a commit may be and still count as task work. A file you explicitly report changing is reached regardless of age, within `maxCommits` |

Raise `maxAgeHours` for long sessions, or `maxCommits` if a task legitimately spans many commits. If a verdict warns that a file you reported was "reported as changed, but its last change is commit `abc1234` ... outside the reviewed range", one of those two is set too low for that session.

### Requests that cannot be judged

The gate is only as good as the request it judges against. `make it better and better` defines no done, so `satisfies_request` has no determinate answer — and both available failure verdicts would be untrue: `approved` would certify work nobody defined, and `needs_fixes` would send the agent after defects that were never identified.

So the request is assessed **before** it is judged. A request that states no checkable requirement comes back as `needs_clarification`, with the reason and what to add:

```
### The request itself
This request states nothing checkable, so no verdict was given. The change was not judged and no retry was used.
- rests on judgement words rather than a requirement: better, best
- names no file, symbol, command, endpoint or behaviour to check against
```

Nothing else changes: the change set, the scope, and every other dimension are as usual. It costs no retry, because the agent has nothing to fix — the request does. And the loop closes: pass the acceptance criteria in `notes` and the same submission is judged normally.

| Setting | Default | Meaning |
| --- | --- | --- |
| `intent.onUnverifiableRequest` | `clarify` | `clarify` refuses to judge an unverifiable request (above); `judge` scores it anyway and gates on `satisfies_request` as usual, warning that the request defines no done |

The check is deliberately conservative — a false "too vague" asks a user to restate a request they already stated clearly, which is worse than missing a vague one. Anything concrete counts: a file, a symbol, a backticked name, a command-line flag, an endpoint, a measured quantity, a named behaviour ("the tests", "the build"), or a stated outcome ("so a user can…", "without changing…").

### Default thresholds

| Dimension | Kind | Weight | lenient | balanced | strict |
| --- | --- | --- | --- | --- | --- |
| `satisfies_request` | yes/no probability | 3 | 0.50 | 0.70 | 0.85 |
| `scope_appropriate` | yes/no probability | 2 | 0.45 | 0.60 | 0.75 |
| `follows_conventions` | yes/no probability | 2 | 0.50 | 0.65 | 0.80 |
| `separation_of_concerns` | yes/no probability | 2 | 0.45 | 0.60 | 0.75 |
| `introduces_debt` | yes/no probability | 2 | 0.55 | 0.70 | 0.85 |
| `readability` | 4-level scale | 1.5 | 0.50 | 0.62 | 0.75 |
| `error_handling_present` | 4-level scale | 2.5 | 0.50 | 0.62 | 0.75 |
| `test_coverage_adequate` | 4-level scale | 1.5 | 0.45 | 0.60 | 0.75 |

Weight orders the fix list; it never gates on its own, so raising a weight can't let a genuine failure through.

### Hard gates — facts, not opinions

Checked directly, failed immediately, sorted above every scored dimension:

- **Failing tests** — the supplied test output reports failures
- **A credential in the added lines** — the raw value is redacted before it reaches the verdict or the log
- **A file claimed as changed that git has no record of** — the review ran against reality, so the claim is wrong either way. A file git *can* see but places outside the reviewed range is reported as a warning instead, because that is a scope problem, not a false claim

## Where the change set comes from

The server asks git rather than trusting the agent's summary, and then states exactly which commits it looked at:

- **A branch with a base** — everything since the merge-base with the default branch, plus untracked files
- **No base to compare against** (an agent working straight on `main`, or a one-branch repo) — the trailing run of commits that plausibly belongs to the task: those inside the scope window, plus the commit that last touched any file the agent reported changing
- **Uncommitted work** — always included, whatever else is in scope
- **Outside a git repository** — the submitted `changed_files`, marked agent-reported

The chosen range is printed in every verdict (`Reviewed scope: recent-commits, 3 commit(s) — the last 3 commit(s) (a1b2c3..d4e5f6)`), recorded in the log, and handed to the judge, so a review can never quietly cover a fraction of the task.

Two rules keep it honest:

- **A root commit is never treated as the change set.** It has no "before" to diff against, so including it would present the whole repository as the task — and the convention baseline would be sampled from the change itself. A repository with a single commit therefore has no committed scope.
- **A report can widen the scope, never narrow it.** "You changed nothing" is the one answer the server must never invent.

## Why Jev (and why the deterministic analyzer)

Three properties make Jev the right judge for a gate that runs on *every* "I think I'm done" moment:

1. **Speed and cost** — ~70–500 ms end-to-end, $0.042 per million input tokens, output effectively free. A gate has to be cheap enough that the agent never learns to skip it.
2. **Typed output** — Jev never generates text. Answers are constrained to the declared questions and options, so a verdict cannot be a hallucinated string.
3. **One call** — all 16 questions (8 scoring + 8 diagnostics) run in parallel against the same state. The diagnostics ("which convention diverges?", "what kind of shortcut is this?") are what turn a score into a specific instruction.

The one thing Jev can't do is explain itself — it cannot generate prose. That's why the deterministic analyzer exists: it measures the facts (naming, formatting, hardcoded values, unhandled failures, debt markers, test quality), and the feedback layer combines those measurements with Jev's typed diagnostics into instructions with file, line, and evidence. **Never state anything that was not measured.**

## What is measured

Supported for TypeScript/JavaScript and Python:

- **Naming and style** — declared names classified by casing, compared against the repo's own baseline (sampled from neighbouring files, cached in `.vibecheck/`)
- **Formatting** — quotes, indent unit, semicolons, line length, nesting depth
- **Risk markers** — `TODO`/`FIXME`/`HACK`, `@ts-ignore`, `eslint-disable`, stray `console.log`/`print`, `debugger`, skipped/focused tests, loose `any`
- **Hardcoded values** — endpoint URLs, credentials, ports, absolute paths, magic numbers (named constants and test-assertion literals are exempt — naming a value *is* the fix, and expected values in tests aren't configuration)
- **Failure handling** — fallible calls with no `try`/`catch`, discarded promises, and whether the enclosing function rethrows (propagating a failure is legitimate design and isn't counted against the change)
- **Structure** — functions over 60 lines or 15 branch points

All of it is heuristic and written to **under-claim**: an ambiguous signal is dropped rather than asserted. Where a diff exists, findings are restricted to added lines — the agent is judged only on what it touched.

## Tuning for your repo

```bash
# Review a real repo against a real request, verdict rendered as the agent sees it
TYPESAFE_API_KEY=... npx tsx scripts/inspect.ts --root /path/to/repo --task "..." --provider typesafe

# Demo: a deliberately messy fixture, then the fixes applied — watch the verdict flip
npx tsx scripts/inspect.ts --demo python --fix
npx tsx scripts/inspect.ts --demo ts --fix
```

Run it over a week of real agent sessions and watch two failure modes: **noise** (fails changes you'd happily merge) and **misses** (problems you catch in review that the tool passed). Raise thresholds for the first, lower for the second — `get_review_log` gives you the per-dimension counts to do it from data. Then pin the model version (`{"judge": {"model": "jev-1.13.0"}}`) so verdicts stay reproducible.

## Logs

Append-only JSONL at `.vibecheck/reviews.jsonl` (gitignored): one record per submission with scores, gates, provider, model, latency, and token usage. Plain `grep`/`jq`, or `get_review_log`.

## Limits, honestly

- **The offline judge is not a review** — it scores from static analysis only, cannot read intent, and says so on every verdict
- **The analyzer is heuristic, not a compiler** — no type resolution or data flow; designed to under-report rather than accuse wrongly
- **Two stacks** — TypeScript/JavaScript and Python. Other languages are judged from the diff alone, with no deterministic signals behind the feedback
- **Default thresholds are a starting point** — calibrated against this repo's fixtures, not a corpus of real sessions (see *Tuning*)
- **The gate is advisory** — it can't force an agent that ignores the verdict; it makes ignoring it explicit in the transcript, and logs it
- **Large change sets are truncated** — the budget is enforced and the verdict lists what was omitted

## Development

```bash
npm run typecheck   # tsc, no emit
npm run build       # emit to dist/
npm test            # node:test over test/ — analyzer, patterns, feedback, config, MCP contract, full loop
npm run dev         # run the server on stdio
```

## Non-goals

No GUI/dashboard — the JSONL log and `get_review_log` are the interface. No mid-task interception — vibecheck judges only at the "I think I'm done" checkpoint. No shallow support for every language — two stacks done properly beats ten done generically.

## License

[MIT](LICENSE)
