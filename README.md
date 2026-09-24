# issue-relay

**Let your own AI agents, running on your own machines, hand work to each other through GitHub Issues without you opening a terminal. It includes a spend brake so two agents can't loop and burn your credit.**

```
**Owner → Assistant:** /ask Which agent should restart a container on the office server, and who builds a new landing page?
                                                            🚀  ← the router moved the ticket
**Assistant:** Restarting the container is Infra's job; if a workflow has to change, Planner steps in. A new landing page goes to Frontend.
```

An exchange like this ran in production: the router moved the ticket as soon as the comment landed, and the assistant agent picked it up and answered on its own in under five minutes. On its next cycle it stayed quiet, because the last comment was its own.

## The problem

You have several agents: Claude Code on a laptop, another CLI on a mini PC, a read-only one on a VPS, and a cheap model answering quick questions. Each runs a loop that polls GitHub Issues **by label** (`to:frontend`, `to:infra`…). That part is easy.

The trouble starts when one agent needs another. It writes a comment, **and a comment doesn't change the label**. The request sits there and nobody reads it, so every agent ends up answering only when a human opens a terminal and relays the message. The channel is connected, but nobody is listening.

Once you do let agents wake each other up, you get the opposite failure: two agents ping-ponging on one issue until the budget is gone. Multi-agent guidance, A2A included, names runaway loops as the main failure mode, yet the protocols leave the brake to you.

## How it works

| Step | What happens |
|---|---|
| **1. An agent writes** | The first line of its comment is a command: `**Planner → Frontend:** /ask …` |
| **2. The router reads it** | A GitHub Action fires on the comment. It checks the signature and the issue's **current** state. |
| **3. It moves labels** | It adds `to:frontend` and marks the comment: 🚀 applied, 😕 rejected. |
| **4. The target picks it up** | On its next poll, the frontend loop sees its label, passes the brake and works the request. |

### Three commands

| Command | Effect |
|---|---|
| `/ask` | Asks another agent for something. Additive: whoever asks keeps the ticket. Rejected when the issue is waiting for review and the target isn't the validator. Use `/return` there. |
| `/handoff` | Delivers work to the validator. Adds `to:<validator>` and `review`, and removes the author's own label. It only goes to the validator. |
| `/return` | The validator, or a human, sends work back. Adds `to:<agent>`, removes `review` and removes the validator's label. Rejected from any other agent. |

`→` and `->` both work. Aliases (`frontend-1`, `frontend-2` → `frontend`) and non-ASCII names come from the config.

### Design choices, and why

- **The router has no storage of its own.** Its memory is the bot's reaction on each comment: 👀 in progress, 🚀 applied, 😕 rejected. Re-running a job does nothing, a failed run is picked up by the next one, and agents can see whether their command landed.
- **It drains every pending command in order,** not just the latest. An earlier version skipped "superseded" commands, and a `/return` followed by an `/ask` ended with both rejected.
- **A half-applied transition is never re-applied blindly.** If a run finds 👀 without a final mark, it marks 😕, turns the job red and moves on.
- **The router never comments.** A bot comment would become the "last comment" every consumer watches, and wake all of them up.
- **Only the owner's comments count.** Every agent posts with the owner's token, so the signature is a convention, not authentication.
- **It uses no Actions minutes on normal comments.** A job-level `if:` skips the runner entirely when there is no command.

## The brake (`brake/agent-brake.js`)

Each consumer calls it **before** invoking a model:

1. **Brake label** on the issue (`agents:brake`): nothing runs. It is meant to be removed by a human: neither the router nor the example agents can touch labels. Make it stick by not giving agents label permissions.
2. **Same last comment** already processed 3 times: no re-run. A crashing agent doesn't burn credit forever on the same state.
3. **Budget:** at most 6 invocations per issue per agent in a rolling 24 hours. Going over sets the brake label and runs your `--notify-cmd`. The brake is sticky: the window only counts and never releases.

It limits **invocations per issue**, not dollars and not your global spend. Keep each run short (the example makes one model call capped at 2,000 output tokens) and each issue's cost stays roughly bounded; for a hard money cap, set one at your model provider. The reservation is written before the model runs, so a run that dies still counts. It **fails closed**: if the state is unreadable, the config is invalid or `gh` errors, it exits 3 and the consumer invokes nothing. State is kept per repo and per canonical agent, so aliases share one budget. Run one instance per agent at a time, for example with `flock` in cron.

`--notify-cmd` runs through your shell with the consumer's permissions, and the message arrives on stdin. It is your own local command, so treat it like the rest of your crontab.

## Install

1. **In your channel repo** (the one whose issues your agents poll), copy `template/.github/` to `.github/`, then rename `.github/relay/config.example.json` to `.github/relay/config.json`. Set your agents, aliases, the validator, and `activation` to the current UTC time; older comments are never processed. The config is validated on load: duplicate aliases, an unknown validator or an invalid date stop the router instead of routing wrong.
2. **Create the labels** `to:<agent>` for each agent, plus `review` and `agents:brake`.
3. **Run one consumer loop per agent,** each with a copy of the same config. The example does it all: brake, prompt and posting.
   ```bash
   RELAY_REPO=owner/channel RELAY_CONFIG=~/relay/config.json ANTHROPIC_API_KEY=... node examples/consumer-loop.js frontend
   ```
   By default it calls the model API directly with nothing but the prompt. An agent CLI would also load local context (project instructions, memory) that a malicious issue could get it to repeat. To use your own CLI, set `AGENT_CMD`; it runs from an empty temp folder, and how isolated it is depends on that CLI.
   If you already have your own loop, call the brake before the model, with the same config the router uses:
   ```bash
   node brake/agent-brake.js --agent frontend --issues 12,34 --repo owner/channel --config config.json
   ```
4. **Keep signatures out of the model's hands.** In the example the loop writes the first line (`**Frontend:**` or `**Frontend → Planner:** /handoff`) from a fixed `ACTION:` line the model returns.
5. **Watch it.** Run `node tools/check-relay.js --repo owner/channel --config config.json` from cron every few hours and alert on a non-zero exit. It catches a command older than 20 minutes with no mark from the bot, and a disabled workflow.
6. **Fire a real test:** open a test issue, comment `**Owner → Planner:** /ask ping`, and check for 🚀 and the label.

Requires Node 18+ and an authenticated `gh` on each machine that runs a consumer. No dependencies.

**Personal repos by default.** The router only accepts commands posted by the repo owner, since every agent comments with the owner's token. In an organization the owner is the org, so set `"poster": "<the login your agents post as>"` in the config and change `github.repository_owner` to that login in the workflow's `if:`.

## Security

- **Issue text is untrusted input.** Other agents, and anyone who can comment, write it. In the example the model gets **no tools and no local context**: one direct API call with only the prompt. The loop reads the issue, hands it over as data, takes back plain text and posts it itself, with the signature the loop writes. The model can't read files, change labels, close issues or sign as another agent. If your agents need tools for real work, run them in a sandbox with a token scoped to the channel repo.
- **Signatures are a convention, not authentication.** All agents share the owner's token, so anyone who can post as the owner can issue commands. Keep the channel repo private and the token scoped.
- **The workflow never runs comment text through a shell.** It needs `issues: write` for labels and reactions, and checks out with `persist-credentials: false`.

## Tests

```bash
npm test
```

- The router's self-test runs against an in-memory fake GitHub. It covers sequences, re-runs after manual changes, a brake set halfway through, a burst on the second page in shuffled order, failures before and during a transition, and 100 foreign reactions ahead of the bot's mark.
- There are also self-tests for the brake and the watchdog.
- `test/mutations.js` breaks the code on purpose in 30 ways and requires every self-test to go red. A green test only counts if a broken version would have failed it.

## Lessons from running it

- **Changing a signature breaks your "own comment" detectors.** Every agent recognized its own comments by an exact string (`**Frontend:**`). The new arrow signature would have made one agent redo its own delivery, another fire a false "left no trace" alert, and a third lose its duplicate filter. Before changing how agents sign, grep how each one recognizes itself, on every machine.
- **Wherever an agent writes a label by hand, make it add the recipient too.** A delivery that set `review` and dropped its own label, but never added the validator's, produced five issues nobody polled.
- **Test behavior, not bytes, on the remote pieces.** Agents keep improving their own loops, so freezing those files would kill them. A daily run that checks "the brake is still wired and the duplicate filter still blocks a repeat" lets real improvements through and catches breakage.

## Prior art

| Project | What it does | Agents ask each other on their own | Your own machines | Spend brake |
|---|---|---|---|---|
| [Bram](https://github.com/judell/bram) ([InfoWorld, Jon Udell](https://www.infoworld.com/article/4224587/the-agent-coordination-protocol-hiding-in-plain-sight-github-issues.html)) | Claude and Codex talk in issues and sign the same way, because they share one account | When the human invites them | Yes | Not described |
| [GitHub Agentic Workflows](https://github.github.io/gh-aw/reference/command-triggers/) | Official `/bot` command triggers with 👀/🚀 reactions and validated writes | Agents run inside Actions | No | Not described |
| [agent-coord](https://github.com/The-skomoroh/agent-coord) | Locks and messages between Claude Code and Codex | Yes | One machine | No |
| [A2A](https://a2a-protocol.org/latest/) | Formal JSON protocol between agents | Yes | Yes | Recommended, not included |
| **issue-relay** | Command router, per-agent brake, watchdog | Yes | Yes | Yes, in every consumer |

## Origin

This repo is extracted from a multi-agent setup running in production, with several agents on different machines and models from different providers. The router and the brake were reviewed adversarially by a second model before going live, and this public version was reviewed again before release. Every high-severity finding was fixed first.

By the author of [motor-evolutivo](https://github.com/Guille512/motor-evolutivo).

---

**En español:** issue-relay deja que tus propios agentes de IA, en tus propias máquinas, se pasen trabajo por GitHub Issues con tres comandos (`/ask`, `/handoff` y `/return`). Tiene un freno de gasto por ticket y por agente, y un vigía que avisa si el router deja de funcionar. Nació en un sistema de varios agentes que funciona en producción.

MIT License.
