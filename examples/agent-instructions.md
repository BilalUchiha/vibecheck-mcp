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
- `test_results`: the raw output if you ran tests.
- `notes`: only for context the diff cannot show, such as why an apparent
  shortcut is deliberate.

Then act on `verdict`:

- `approved` — report the task as done.
- `needs_fixes` — fix every issue in `feedback`, then call `submit_for_review`
  again. Report nothing to the user as complete while fixes are outstanding, and
  do not hand the issues back to the user to resolve.
- `max_retries_exceeded` — stop editing. Tell the user the change did not pass
  review, list the outstanding issues, and let them decide what happens next.
- `review_unavailable` — the judge could not be reached. This is not a failed
  review; say that the check did not run and why.

Do not describe a `needs_fixes` verdict as an approval, and do not skip the call
because you believe the change is small, obvious, or already reviewed.
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
