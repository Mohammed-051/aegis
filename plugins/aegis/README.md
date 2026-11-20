# Aegis

Model dispatcher for Claude Code: in the terminal, and in the Code tab of the Claude desktop app.

Every prompt you submit first goes to a high-cost **router model**, Claude Opus 5.5 by default or Claude Fable 5.2 if you choose it. The router reads the request, the last few messages and the model currently in use. It then decides two things for the turn:

- **model**: Haiku 5.5, Sonnet 5.5, Opus 5.5 or Fable 5.2
- **effort**: low, medium, high, or xhigh (xhigh is allowed for Sonnet only)

The router answers at low effort with a single line of JSON, so it's quick and costs little per prompt.

Router categories: **Haiku** for simple edits, log reading, classification, queries, summaries, browser automation and lookups; **Sonnet** for everyday engineering and frontend work, bug fixes, tests and docs; **Opus** for serious or ambiguous coding, architecture, hard debugging, deep review, performance and security; **Fable** only for the hardest open-ended work (large migrations, multi-agent orchestration, research). Security work never goes to Fable.

## Guardrails (enforced in code, not left to the router)

| Rule | Behaviour |
|---|---|
| Effort caps | Haiku ≤ high, Sonnet ≤ xhigh, Opus ≤ high, **Fable ≤ medium** (protects Fable's usage limit) |
| Cache stickiness | The router is told which model is current and to switch only when the task needs it, which keeps the prompt cache warm |
| Follow-ups | `yes`, `continue`, `go ahead`, `do it` and similar keep the previous route **without calling the router** |
| Fable chain | Only when the router is Fable. If the Fable router call fails or times out (20 s), it is retried once on Opus 5.5. Fable is then marked unavailable for 10 minutes: the router starts on Opus and any Fable pick is demoted to Opus. `/aegis status` shows the window |
| Fallback | If Opus also fails, or any router reply can't be parsed (no Opus retry for that), the turn runs on Sonnet 5.5 with effort chosen by a length and code-block heuristic |
| Scope | Subagents, slash commands and prompts typed during a running turn are not rerouted |

## Pane

The pane shows:
- the router model, with a spinner while it decides and its one-line reason afterwards
- all four models, with a spinner and `[Tier] Model Active... effort X` on the active one
- the turn count, router tokens spent and router latency

## Commands

```
/aegis status                     routing state, last route, router spend
/aegis on | off                   enable or disable routing
/aegis router opus|fable|default  choose the router for this session (default = setting, Opus unless changed)
/aegis pane                       reopen the pane
```

To set the router permanently, use the `router` option in the plugin config menu (`opus`, the default, or `fable`).

## Install

```bash
/plugin marketplace add mohammed-051/aegis
/plugin install aegis@aegis
```

Or in one step on Claude Code 2.1.275 or later:

```bash
/plugin install aegis --marketplace mohammed-051/aegis
```

Tests: `claude plugin test plugins/aegis`.
