# Telling the agent to use the gate

Registering the MCP server only makes the tool *available*. An agent will still
declare "done" on its own judgment unless you write the rule down, so paste the
block below into the file your client treats as standing instructions:

| Client | File |
| --- | --- |
| Claude Code | `CLAUDE.md` in the project root, or `~/.claude/CLAUDE.md` for every project |
| Cursor | `.cursor/rules/vibecheck.mdc`, or **Settings → Rules** |
| Codex / other AGENTS.md clients | `AGENTS.md` |

Keep the block in version control. A review gate that lives only in someone's
personal config is a gate that silently stops working for the next person.

---

## The block to paste

```markdown
## Completion review

Before you tell the user a coding task is finished, call the `vibecheck` MCP
server's `submit_for_review` tool:

- `task_description`: the user's original request, as they wrote it. Never
  substitute a paraphrase that your change happens to satisfy.
- `project_root`: the absolute path to this repository.
- `changed_files`: every file this task changed, including ones you committed in
  earlier steps. Git supplies the change set in a repository, but reporting the
  files widens the reviewed range to cover work git would otherwise place
  outside it. Do not list a file you did not change: a claim git cannot place at
  all fails the review outright.
- `test_results`: the raw output if you ran tests.
- `notes`: only for context the diff cannot show, such as why an apparent
  shortcut is deliberate. When the user's request is open-ended (`make it
  better`, `improve the error handling`), this is where the acceptance criteria
  you are working to belong — an open-ended request with explicit criteria is
  judged normally, and without them the gate will ask for them instead of
  guessing.

Then act on `verdict`:

- `approved` — report the task as done.
- `needs_fixes` — fix every issue in `feedback`, then call `submit_for_review`
  again. Report nothing to the user as complete while fixes are outstanding, and
  do not hand the issues back to the user to resolve.
- `max_retries_exceeded` — stop editing. Tell the user the change did not pass
  review, list the outstanding issues, and let them decide what happens next.
- `needs_clarification` — the request states nothing checkable, so the change was
  not judged and no retry was used. This is not a failed review and not a pass.
  Say briefly what you took the request to mean, then resubmit the same request
  with those acceptance criteria in `notes`.
- `review_unavailable` — the judge could not be reached. This is not a failed
  review; say that the check did not run and why.

Do not describe a `needs_fixes` verdict as an approval, and do not skip the call
because you believe the change is small, obvious, or already reviewed.

Read the verdict's `Reviewed scope:` line before you act on the feedback. It
names the commits the review actually covered. If it is narrower than your work —
for example you committed a step more than `scope.maxAgeHours` ago and did not
list its files — report the missing files and submit again rather than treating
the verdict as a judgment on work it never saw.
```

---

## Making the source of the task description precise

The strongest signal Jev gets is `task_description`, and the weakest version of
it is a summary the agent writes after the fact — an agent that misread the
request will misdescribe it in exactly the same way. Two habits fix this:

1. Ask for the user's request verbatim, including constraints like "only touch
   the parser" or "no new dependencies". Those are the lines that catch scope
   creep.
2. When you want a rule enforced on every change (`scope_appropriate` on,
   `test_coverage_adequate` off, strict thresholds), put it in `.vibecheck.json`
   rather than in the prompt. Config is enforced by the server; prose is not.
