# Running `spf watch` inside herdr

[herdr](https://herdr.dev) is a terminal multiplexer for coding agents: panes
that survive disconnects, a remote mode, and a sidebar that shows which agent
in which pane is working, blocked, or idle. This cookbook puts `spf watch` in
it, in two steps. The first needs no config at all; the second adds one
notifications channel.

**The rule this cookbook protects: herdr shows the factory, it never runs
it.** herdr's own signature pattern is agents driving other agents through
its socket. spf exists to keep that job in code — the chain owns sequencing,
retries, and acceptance. So nothing here lets an agent touch herdr, and spf
never reads herdr back to decide anything. herdr is where you watch and step
in; the chain is still the only thing that decides.

Needs herdr 0.7.5 or later (socket API protocol 17).

## (a) No config: a persistent control room

`spf watch` is a long-lived foreground daemon, and Ctrl-C drains in-flight
claims before exiting. A dropped SSH session or a closed laptop lid is the
failure this step fixes: run the daemon in a herdr session and it keeps
going.

```bash
herdr --session factory          # a named, persistent session
# pane 1:
spf watch
# split right (pane 2):
spf ui                           # the trace visualizer
# split down (pane 3), once an issue is claimed:
spf events issue-42 --follow     # the single-lane run for issue #42
```

Detach whenever you like. `herdr session attach factory` brings the whole
layout back with every process still running.

**On a remote box.** Run the factory where the compute and credentials live,
and attach from your laptop:

```bash
herdr --remote you@buildbox --session factory
```

The `.env` secrets, the worktrees under `~/.spf/watch/<repo>/worktrees`, and
the trace db all stay on the remote box; only the terminal crosses the wire.

## (b) One channel: the factory board

Add a `herdr` channel and `spf watch` drives the sidebar itself: a pane per
claimed issue, labelled with the issue, tailing that issue's run, and
reporting its state the same way herdr's built-in agent integrations do.

```yaml
# .spf/spf.config.yaml
notifications:
  events: attention          # anything but "off" — "off" turns every channel off
  channels:
    - kind: herdr            # no webhook, no env key; defaults to events: all
    - kind: slack            # optional; channels are independent
```

Then start `spf watch` **from a herdr pane** (issue panes open to the right
of spf's own pane, so it has to be running in one). Outside herdr the
channel is skipped with one warning, the same way a Slack channel with no
`SLACK_WEBHOOK_URL` is, and everything else runs as normal. `spf doctor`
reports which of the two you're in.

What each milestone does in herdr:

| Milestone | herdr |
|---|---|
| `watch_started` | spf's own pane → `idle`, labelled "watching" |
| `issue_claimed` | New pane split right, named `<issue> <title>`, → `working` |
| `run_started` (single lane) | Types `spf events issue-<id> --follow` into the issue's pane |
| `phase_retry` / `phase_failed` | Issue pane stays `working`; the message shows the phase |
| `pr_opened` / `pr_updated` | Issue pane → `idle`, labelled "in review" |
| `issue_blocked`, `spec_needs_feedback`, `spec_split_proposed` | Issue pane → `blocked`, plus a herdr notification |
| `issue_done` / `spec_done` | Issue pane closes |
| `watch_stopped` | spf releases its own pane back to herdr's own detection |
| `watch_error`, other notices/errors | A herdr notification |

The sidebar then answers "which of my N in-flight issues needs me?" at a
glance: the blocked ones.

**Outside `spf watch`.** Typing a one-off run into a herdr pane
(`spf build "..."`) reports on that pane instead: `working` while it runs,
then `idle` labelled "done" or "failed" (a failure also raises a
notification).

### Honest edges

- **Fan-out.** With `watch.fanout.n > 1`, the issue's pane still gets state
  and phase messages from every attempt, but no trace tail: N sibling
  attempts share one pane, so there's no single run to follow. Use
  `spf sessions` / `spf ui`.
- **Tracker ids that aren't shell-safe.** The tail is typed into a shell, so
  an issue id with anything outside `[A-Za-z0-9._-]` gets a pane and state
  but no tail. GitHub numbers and Jira keys (`PROJ-12`) are fine.
- **Panes you close by hand** are re-created on the next claim of that issue
  (a `<prefix>:feedback` revision, say). spf never errors because a pane is
  gone; a failed herdr request logs one line and is swallowed like any
  failed notification.
- **Notifications** respect herdr's own config. If `herdr notification show`
  does nothing, check `config.toml`.
- **There's no `done` state.** herdr's states are `idle` / `working` /
  `blocked` / `unknown`, so "in review" and "done" are `idle` plus a label.
