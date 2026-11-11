# Aegis

Tiered model router for Claude Code (terminal, and the Code surface of the Claude desktop app).

Each prompt you submit goes to Claude Haiku 5.5 first, which labels it SIMPLE, STANDARD, COMPLEX or FRONTIER.
The turn then runs on Haiku 5.5, Sonnet 5.5, Opus 5.5 or Fable 5.2. Effort is set for every request in the turn:

| Model | Effort |
|---|---|
| Haiku 5.5, Sonnet 5.5 | `calculate_effort(prompt_length, code_block_count)`: low / medium / high |
| Opus 5.5, Fable 5.2 | fixed at medium |

Fable 5.2 is allowed until 2026-11-16 23:59:59 PT (2026-11-17T07:59:59.999Z). The check runs on every request. After that time, FRONTIER routes to Opus 5.5, even partway through a turn, and the pane grays out Fable and shows a "Limit Expired" badge.

Commands: `/aegis status`, `/aegis on`, `/aegis off`, `/aegis pane`.

Subagent requests, slash commands and prompts typed during a running turn are not rerouted. If the gatekeeper times out (8 s) or gives no label it can read, the prompt routes to STANDARD.

Run the tests with `claude plugin test <this folder>`.

## Install

```bash
/plugin marketplace add mohammed-051/aegis
/plugin install aegis@aegis
```

Or in one step on Claude Code 2.1.275 or later:

```bash
/plugin install aegis --marketplace mohammed-051/aegis
```
