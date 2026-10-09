# autoforge serve: manual end-to-end checklist

Run against a real Linear test team and a throwaway repo before merging changes to
`autoforge serve`. Paste it into the PR description and tick it there.

## Setup

- [ ] Throwaway repo `<you>/autoforge-e2e` with a README; `docker build -t autoforge-claude examples`
- [ ] `~/.autoforge/config.json` with `defaultRepo` = the throwaway repo, `pollSeconds` 10
- [ ] `~/.autoforge/env` with LINEAR_API_KEY, GITHUB_TOKEN (fine-grained, this repo only), ANTHROPIC_API_KEY
- [ ] `chmod 644 ~/.autoforge/env`: `autoforge serve` refuses with the chmod hint; back to 600

## Happy path

- [ ] `autoforge serve` logs `started`
- [ ] New issue "Fix a typo in README", assigned to me, label `autoforge`: "Queued (position 1)", issue moves to the first started state, "Running on ...", result with the patch excerpt
- [ ] Issue with a `repo:<you>/autoforge-e2e@main` label routes there
- [ ] A second Linear user comments `/publish`: nothing happens
- [ ] I reply `/retry make it shorter`: queued again, new result, the run's task ends with the feedback
- [ ] I reply `/publish`: draft PR in the repo, "Draft PR opened" comment, PR attached on the issue
- [ ] The PR title is the issue title and the PR body is only `<identifier>: <title>` plus "Opened by autoforge from Linear issue <identifier>." (no description, comments or feedback)
- [ ] I reply `/publish` again: one-line wrong-state reply
- [ ] `/publish` posted as a threaded reply (not a top-level comment) is seen and handled

## Linear API assumptions (unverified by unit tests)

- [ ] Marker round-trip: Linear keeps `<!-- autoforge -->` at the top of the daemon's comment body (check via the API) and hides it in the UI
- [ ] The `or` filter with `id: { in: [...] }` is accepted, and an issue unassigned while queued is dropped with a comment
- [ ] Query complexity: a first poll with many assigned issues and a long tracked-id list is accepted (no complexity error)
- [ ] On an issue with more than 100 comments, the newest `/publish` is seen within one poll (`comments(last: 100)` order)
- [ ] Does a new comment bump `issue.updatedAt`? Reply `/retry` on a finished issue after `approvalExpiryDays`: note whether it is seen
- [ ] Archive, then delete, an issue while it is queued, while it runs, and while it awaits approval: note what the daemon does each time
- [ ] Rate limit: trigger or simulate a rate-limited response; note its shape (status, `Retry-After`, GraphQL error code) and that the daemon backs off and recovers
- [ ] `moveToStarted` on teams with triage enabled, with a custom started state, and with no started state: note the result (a failure only logs `move_failed`)
- [ ] `attachmentCreate` shows the PR link on the issue, also with Linear's GitHub integration installed

## Lifecycle

- [ ] New issue, `/discard`: "Discarded"; remove the label, wait one poll, re-add it: starts over
- [ ] Unassign an issue while it runs: "stopped the run", no result comment
- [ ] Quit Docker, label an issue: one "Waiting for Docker" comment; start Docker: it runs
- [ ] Ctrl-C the daemon mid-run, start it again: "restarted during the run", runs again
- [ ] `dailyRunLimit` 1 with two issues: the second waits with one comment
- [ ] Two instances: a second `autoforge serve` on the same `--dir` exits with "autoforge serve is already running (pid N)."
- [ ] Secret in the patch: an agent that writes a secret value into a file gets a result comment with `***` and the warning; `/publish` is refused and nothing is pushed

## Status and service

- [ ] `autoforge status` lists the issues
- [ ] `curl http://127.0.0.1:<port>/runs` without the token: 401; with `-H "Origin: x"`: 403
- [ ] `autoforge service install`: daemon runs under launchd (or `systemctl --user status autoforge`), `daemon.log` fills, docker is found
- [ ] macOS: `autoforge service install` twice in a row succeeds and leaves one running daemon
- [ ] Break `config.json` while running under the service: the error lands in `daemon.log`; note how launchd or systemd restarts it
- [ ] Log out and in (or reboot): still running; `autoforge service uninstall`: gone, `~/.autoforge` intact

## Secrets

- [ ] `grep` for each secret value in `daemon.log`, `state.json`, `status.json`, the issue comments, and the PR title and body: no hits
