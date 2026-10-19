# Rules warden

Holds the agent to your project's rules and to proof. It steers the agent rather than stopping
you: the agent hears what it got wrong and fixes it itself.

## Rules judge (opt in)

`/warden judge on` turns it on. Before each `write_file` or `edit_file`, the change is judged
against your project rules by one short call to the session model (or a cheaper model,
`/warden model <id>`). A change that introduces a violation is held, and the agent gets the rule it
broke and why:

```
rules-warden held this change to src/api.ts: it breaks a project rule.
- "Errors are not swallowed" (warden.md): the catch block is empty. Rule: A `catch` block must ...
Change it so it follows the rule, or tell the user why it cannot.
```

It is off by default because it costs one model call per write a rule applies to. Nothing is
sent when there is no rules file, when no rule applies to the file, or for a file outside the
project. When the judge cannot answer, or its answer does not parse, the change goes through.

### Rules

`warden.md` at the project root (`/warden init` writes a starter). Every `#` heading is one rule;
the text under it is what the judge reads. Header lines under a heading tune it:

```markdown
# Errors never reach the user raw
paths: src/api/**/*.ts
threshold: 0.8
severity: high
Catch errors at the handler and return a message a user can act on.
```

- `paths:` limits the rule to matching files (`**/` any depth, `*` within a folder).
- `threshold:` how sure the judge must be to hold (default 0.7, `/warden threshold`).
- `severity:` `high`, `normal`, or `low`: the order rules are listed in when several break.

Without `warden.md`, the first of `AGENTS.md`, `CLAUDE.md`, `README.md` is used when it reads like
rules (bullets, or "must", "never", "always" lines), judged as one document. A prose-only file is
not judged.

## Done-check (on, free)

When a run ends with a reply that says the work is done, but files changed and no test, build, or
lint run has passed since the last change, the agent is sent back once:

```
rules-warden: reports completion after 2 file changes with no test, build, or lint run since the
last change. Run npm run test on what you changed. Then report the actual result. If no check
exists or can run, say so explicitly instead of presenting the work as done.
```

It runs offline. A shell command counts as a check only when a test, type-check, lint, or build
runner starts it (`grep -n jest package.json` does not count), and its result comes from the
runner's own summary or exit code. A runner whose exit code the shell hides (`npm test | tail -1`)
with no summary to read does not count. The command suggested is the project's `check` or `test`
script, or the same Makefile target.

## Commands

```
/warden                        status
/warden judge on|off
/warden done on|off
/warden model <id>|default
/warden threshold <0-1>
/warden rules                  the rules in force and where they came from
/warden init                   write a starter warden.md
```

## Not included

- The action guard (holding destructive commands such as `git push --force`): the built-in
  permission checks cover dangerous commands.
- `when: turn` rules judged once per run against the whole diff, rules at turn start, and the
  soft double-check tier.
- The checks that need the original's dedicated judge service: the cause-check, slop and security
  scans, the stuck and runaway guards, the visual check after UI changes, and the context saver.
- Deciding whether a reply claims "done" by asking a model: a phrase match is used, so it costs
  nothing.
