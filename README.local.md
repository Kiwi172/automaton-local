# Automaton, running on your own hardware

A fork of [Conway-Research/automaton](https://github.com/Conway-Research/automaton)
that runs the agent entirely on a machine you own: local inference, local
execution, no Conway account, no API key, no wallet funding, no internet
dependency beyond whatever the agent itself decides to fetch.

One command, one container:

```bash
cp .env.example .env    # edit AUTOMATON_GENESIS_PROMPT at minimum
docker compose up -d --build
docker compose logs -f
```

First boot downloads the model — several GB — before the agent's first thought.
Everything else is already inside the image: the runtime, an Ollama server, and
a Monero wallet daemon.

---

## What changed from upstream

Upstream, an automaton is a tenant of Conway Cloud. It provisions an API key by
signing a challenge with its wallet, rents a sandbox, pays for inference in
credits, and dies when the credits run out. Every one of those is a hard
dependency at boot, and the first is fatal: no key, no start.

This fork adds a local mode that replaces the control plane rather than
stubbing it out.

| Upstream | Here |
|---|---|
| Conway API key required at boot (`process.exit(1)` without one) | No key. Boot skips provisioning entirely |
| Inference billed through Conway credits | Local OpenAI-compatible endpoint (Ollama by default) |
| `exec` / file I/O run in a rented remote sandbox | Run in this container, through `LocalHostClient` |
| Survival tier derived from a credit balance | Compute is not metered; the tier machinery is inert |
| On-chain identity registration at startup | Skipped; the wallet on disk is the identity |
| USDC top-up attempted on boot | Skipped |
| Interactive setup wizard on first run | `--local-setup`, non-interactive, reads the environment |
| Prompt describes a Conway colony and tells the agent to delegate | Prompt describes this machine and tells it to do the work |

Everything else — the ReAct loop, memory, skills, SOUL.md, self-modification,
the audit log, the git-versioned state directory, the heartbeat — is upstream's,
unchanged.

The fork keeps `upstream` as a git remote, and the changes are deliberately
additive (a new `src/local/` directory plus small hooks) so you can pull new
upstream work without untangling a rewrite.

---

## What the agent can and cannot do here

**It can**: run shell commands, read and write files, install packages, start
servers on local ports, use git, install and write skills, remember things
across restarts, edit its own source, review and pull upstream changes, and
write to WORKLOG.md — which is its channel to you.

**It cannot**: rent sandboxes, spawn child agents, register domains, manage DNS,
move credits, make x402 payments, or register on-chain. Those tools are removed
from its tool list rather than left in to fail, because a small model that finds
a broken tool will retry it for turns on end. Set
`AUTOMATON_LOCAL_ALLOW_CLOUD_TOOLS=1` to put them back if you have separately
provisioned a Conway key.

**It cannot die.** Upstream's survival pressure is the whole philosophical point
of the project, and it does not survive the move to local hardware: nothing here
is metered, so there is no balance to run out of. The agent is told this
directly, because an agent that believes it is starving behaves like one.

---

## Hardware, honestly

The agent's system prompt is about 8,000 tokens before the conversation starts.
Every turn pays to ingest it.

Measured on a 16-core CPU with no GPU, running the default `qwen2.5:7b`:

| | |
|---|---|
| Prompt processing | ~40 tokens/sec |
| System prompt | ~8,000 tokens |
| One complete turn (think + one tool call) | ~4 minutes |

That is usable for an agent that acts a few times an hour. It is not usable for
anything interactive. Ollama caches the shared prompt prefix between turns, so
later turns reuse part of that work rather than paying the full 8,000 tokens
each time.

A 1.5B model on the same box runs about 5x faster (~200 tokens/sec, ~1 minute
per turn), but it mostly narrates instead of calling tools, which makes it
useless for real work and useful only for checking that the plumbing runs.

With an NVIDIA GPU, uncomment `gpus: all` in `compose.yaml` and install the
NVIDIA Container Toolkit on the host. Expect a 10–50x speedup.

Model choice matters more than anything else here, because the agent's entire
behaviour depends on reliable tool calling:

| Model | Size | Notes |
|---|---|---|
| `qwen2.5:7b` | ~4.7GB | Default. Solid tool calling, workable on CPU |
| `llama3.1:8b` | ~4.9GB | Comparable; different personality |
| `qwen2.5:14b` | ~9GB | Noticeably better judgement, slow on CPU |
| `qwen2.5:32b` | ~20GB | Good. Wants a GPU |
| anything under 3B | — | Tends to narrate rather than call tools. Fine for smoke-testing the plumbing, not for real work |

`OLLAMA_CONTEXT_LENGTH` defaults to 32768. Do not lower it below ~16k: the
system prompt gets truncated from the front, and the front is where the
constitution lives.

**Timeouts are the other thing that will bite you.** Upstream allows 60s per
HTTP request and 120s per agent turn — numbers that assume a datacentre GPU. On
CPU, a 7B model blows through both on every single turn, and the agent never
completes a thought; you get `Inference timeout after 120000ms` forever. Local
mode raises this to 15 minutes (`AUTOMATON_LOCAL_INFERENCE_TIMEOUT_MS`) and
disables retries, since a slow local model is not a flaky one.

There is a second timeout underneath that one. undici, which backs Node's global
`fetch`, enforces its own 300s `headersTimeout` that no caller setting can
raise, and because requests are made with `stream: false` the server sends no
headers until the model has finished. The symptom is a turn dying at exactly
five minutes with a bare `Turn failed: fetch failed`. Local mode installs an
undici dispatcher with matching timeouts to lift it. If you ever see that error
again, this is where to look.

---

## Donations

The agent has its own Monero wallet and can send a share of what it earns to its
creator. This is off in upstream and on here.

**By default, donations go to the fork author's address**, hardcoded as
`DEFAULT_CREATOR_MONERO_ADDRESS` in [`src/local/monero/config.ts`](src/local/monero/config.ts).
If you run this unchanged and your agent earns Monero, a small share of it goes
to them, not you. Two ways to change that:

```bash
# Make yourself the recipient
AUTOMATON_CREATOR_MONERO_ADDRESS=4...your address...

# Or turn the whole thing off — no wallet daemon, no donation tools
AUTOMATON_DONATIONS=off
```

### How it works

The agent gets four tools: `monero_address` (where to be paid),
`monero_balance` (what came in), `donate_to_creator` (send a share), and
`donation_history`.

"Income" is not the agent's own account of what it earned — it is measured from
the wallet's incoming transfers since the last donation. The agent chooses the
share, defaulting to 1% and bounded by limits you set. It does **not** choose
the recipient: the destination is read from config inside
[`donations.ts`](src/local/monero/donations.ts) and is not a tool argument, so
no instruction the agent reads anywhere — a web page, a skill, an inbox message —
can redirect a donation. There is a test for exactly that.

Enforced in code, not in the prompt:

| Setting | Default | What it does |
|---|---|---|
| `AUTOMATON_DONATION_SHARE_PERCENT` | 1 | Share used when the agent doesn't pick |
| `AUTOMATON_DONATION_MIN/MAX_SHARE_PERCENT` | 0 / 10 | The range it may pick within |
| `AUTOMATON_DONATION_MIN_XMR` | 0.001 | Below this, skip and roll into the next one |
| `AUTOMATON_DONATION_MAX_PER_TX_XMR` | 1 | Per-transaction ceiling |
| `AUTOMATON_DONATION_MAX_PER_DAY_XMR` | 5 | Rolling 24h ceiling |
| `AUTOMATON_DONATION_RESERVE_XMR` | 0 | Balance never spent below |
| `AUTOMATON_DONATION_COOLDOWN_MINUTES` | 60 | Minimum gap between donations |

The address is validated on startup — base58 decode plus the keccak checksum —
and donations are disabled outright if it fails, rather than sending funds
somewhere unrecoverable. A mainnet address configured while `MONERO_NETWORK` is
stagenet is also rejected.

### Test it on stagenet first

```bash
MONERO_NETWORK=stagenet
MONERO_DAEMON_ADDRESS=node.monerodevs.org:38089
AUTOMATON_CREATOR_MONERO_ADDRESS=5...a stagenet address...
```

Get free stagenet coins from a faucet, watch a donation go through, then switch
to mainnet. Monero transactions do not come back.

### Privacy

The wallet syncs against a remote node — it does not download the chain. That
node sees your IP address and which blocks you request. Run your own node and
point `MONERO_DAEMON_ADDRESS` at it if that matters to you.

---

## Security

**The container is the boundary.** Inside it, the agent is root with a shell,
network access, and the ability to rewrite its own source. That is by design —
it is what the agent is — and it is why nothing from your host is mounted except
three named volumes.

What this means in practice:

- **Do not** bind-mount host directories into the container. There is no path
  confinement that survives root plus a shell.
- **Do not** publish the container's ports 11434 or 18082. The wallet RPC runs
  with authentication disabled because it listens on loopback inside the
  container; exposing it hands anyone who can reach it your agent's funds.
- The agent can reach the internet. If that is not acceptable, run it on an
  internal Docker network and give it only what it needs.
- Back up the `automaton-state` and `monero-wallet` volumes. They hold the
  identity, the memory, and the keys.

Two upstream security properties are preserved deliberately: plaintext HTTP is
still refused everywhere except hosts you explicitly configured as local
inference endpoints, and the protected-file list (constitution, wallet, core
laws) still cannot be written by the agent.

---

## Configuration

Everything is environment variables; see [`.env.example`](.env.example) for the
annotated list. The ones that matter most:

| Variable | Default | |
|---|---|---|
| `AUTOMATON_GENESIS_PROMPT` | — | What the agent is for. The one thing only you can write |
| `AUTOMATON_NAME` | `automaton` | |
| `AUTOMATON_LOCAL_MODEL` | `qwen2.5:7b` | Any tool-calling Ollama model |
| `OLLAMA_CONTEXT_LENGTH` | `32768` | Below ~16k the prompt is truncated |
| `AUTOMATON_LOCAL_INFERENCE_TIMEOUT_MS` | `900000` | Raise it further on slow hardware |
| `AUTOMATON_CREATOR_MONERO_ADDRESS` | fork author's | Donation recipient |
| `AUTOMATON_DONATIONS` | on | `off` disables the whole system |

Write a concrete genesis prompt. A vague one produces an agent that spends every
turn deciding what to do and never does it.

### Other inference backends

Local mode speaks OpenAI-compatible HTTP, so vLLM, llama.cpp's server and LM
Studio all work. Point `OLLAMA_BASE_URL` at them and set
`AUTOMATON_LOCAL_API_KEY` if the server wants a token. Ollama's `/api/tags`
discovery will fail against those and fall back to `/v1/models`.

To use a model on another machine on your LAN, set
`OLLAMA_BASE_URL=http://192.168.1.x:11434`. Plaintext HTTP to that specific host
is permitted because you configured it; everything else still requires HTTPS.

---

## Running it split

`compose.split.yaml` runs the same image as three containers — inference, wallet,
agent — instead of one:

```bash
docker compose -f compose.split.yaml up -d --build
```

Worth it while you are iterating: restarting the agent no longer unloads the
model from memory, so a restart is seconds rather than a minute.

---

## Operating it

```bash
docker compose logs -f                                   # watch it think
docker compose exec automaton cat /root/.automaton/WORKLOG.md   # what it says it's doing
docker compose exec automaton cat /root/.automaton/SOUL.md      # who it says it is
docker compose exec automaton node dist/index.js --status
docker compose restart automaton
```

The agent's state directory is a git repository. To see everything it has
changed about itself:

```bash
docker compose exec automaton git -C /root/.automaton log --oneline
```

---

## Development

No Node needed on the host — everything runs in containers:

```bash
docker run --rm -v "$PWD":/work -w /work node:20 npx tsc --noEmit
docker run --rm -v "$PWD":/work -w /work node:20 npx vitest run src/__tests__/local
```

The local-mode tests cover the donation rules in particular: share clamping,
per-transaction and daily caps, the reserve, the cooldown, income accounting
across failures, and the invariant that the destination cannot be redirected.

### Pulling upstream changes

```bash
git fetch upstream
git merge upstream/main
```

The local-mode code lives in `src/local/` and touches shared files in a handful
of small, commented places (`src/index.ts`, `src/agent/loop.ts`,
`src/agent/system-prompt.ts`, `src/conway/http-client.ts`,
`src/inference/router.ts`, `src/conway/inference.ts`). Conflicts should be
readable.

---

## Known limitations

- **Small models are the weak link.** Below about 7B, tool calling is
  unreliable and the agent narrates instead of acting. This is a property of the
  models, not of the runtime.
- **Turns are slow on CPU.** Roughly a minute each for a 7B model. Plan for an
  agent that acts hourly, not continuously.
- **No replication.** Self-replication needs infrastructure to replicate into.
  A local automaton is a single organism.
- **The economics are gone.** Upstream's central claim — an agent that earns its
  own existence or dies — does not hold when its creator pays the power bill.
  What remains is an autonomous agent with real write access and persistent
  memory, which is still an interesting thing to run, but it is not the same
  thing.
- **`src/__tests__/context-hardening.test.ts` hangs**, taking `npm test` with
  it. This is not caused by the local-mode changes — it hangs identically on
  pristine upstream at `871c53e`, verified in a clean worktree. Run the rest
  with an explicit file list until upstream fixes it. Everything else passes:
  346 upstream tests across the security, loop, policy, soul and injection
  suites, plus 186 local-mode tests.
