# Automaton — self-contained local runtime.
#
# One image, everything inside it: the agent runtime, an Ollama server for
# inference, and monero-wallet-rpc for the donation wallet. `docker compose up`
# needs nothing else on the host — no Node, no Ollama install, no Conway
# account, no API key.
#
# The container is the security boundary. The agent has root, a shell, network
# access and the ability to rewrite its own source inside this image, exactly as
# it would inside a Conway sandbox. Nothing from the host is mounted except
# named volumes, so the blast radius is the container and its state.
#
# HOME is /root because tool path confinement (src/agent/tools.ts) resolves
# writes against /root. Changing the user means changing that constant too.

# ─── Stage 1: build the runtime ───────────────────────────────────
FROM node:20-bookworm-slim AS build

WORKDIR /build

# better-sqlite3 compiles a native addon.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

RUN npm prune --omit=dev

# ─── Stage 2: fetch third-party binaries ──────────────────────────
FROM debian:bookworm-slim AS binaries

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates bzip2 zstd tar \
    && rm -rf /var/lib/apt/lists/*

# Ollama. Pinned — "latest" moves under you, and release asset names have
# changed format before (.tgz -> .tar.zst).
ARG OLLAMA_VERSION=v0.32.15
RUN curl -fsSL -o /tmp/ollama.tar.zst \
      "https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-linux-amd64.tar.zst" \
    && mkdir -p /opt/ollama \
    && tar -C /opt/ollama --zstd -xf /tmp/ollama.tar.zst \
    && rm /tmp/ollama.tar.zst

# monero-wallet-rpc. Only the wallet daemon is kept — no monerod, since the
# wallet talks to a remote node rather than syncing the chain itself.
#
# The default hash is the one published in Monero's signed hashes.txt for this
# version (cross-checked against getmonero.org and the monero-site repo). When
# bumping MONERO_VERSION, take the new hash from the same place:
#   https://www.getmonero.org/downloads/hashes.txt
# and verify its PGP signature if you care about the supply chain, which you
# should — this binary will hold your agent's keys.
ARG MONERO_VERSION=v0.18.5.1
ARG MONERO_URL=https://downloads.getmonero.org/cli/monero-linux-x64-${MONERO_VERSION}.tar.bz2
ARG MONERO_SHA256=22a7dda7b0cb699fdd6b7674c3b4a4465b337cc98a54983523b759e1e7cc9958
RUN curl -fsSL -o /tmp/monero.tar.bz2 "${MONERO_URL}" \
    && echo "${MONERO_SHA256}  /tmp/monero.tar.bz2" | sha256sum -c - \
    && mkdir -p /tmp/monero /opt/monero \
    && tar -C /tmp/monero -xjf /tmp/monero.tar.bz2 --strip-components=1 \
    && cp /tmp/monero/monero-wallet-rpc /opt/monero/ \
    && chmod +x /opt/monero/monero-wallet-rpc \
    && rm -rf /tmp/monero /tmp/monero.tar.bz2

# ─── Stage 3: runtime ─────────────────────────────────────────────
FROM node:20-bookworm-slim

# git:        the agent versions its own state and can pull upstream
# curl:       readiness probes and the agent's own network use
# python3/make/g++: the agent can install npm packages with native addons
# procps:     the entrypoint supervises background daemons
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates python3 make g++ procps \
    && rm -rf /var/lib/apt/lists/*

COPY --from=binaries /opt/ollama/bin/ollama /usr/local/bin/ollama
COPY --from=binaries /opt/ollama/lib/ollama /usr/local/lib/ollama
COPY --from=binaries /opt/monero/monero-wallet-rpc /usr/local/bin/monero-wallet-rpc

WORKDIR /app

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
# Read at setup time, then copied into ~/.automaton read-only.
COPY constitution.md ./
COPY docker/entrypoint.sh /usr/local/bin/automaton-entrypoint
RUN chmod +x /usr/local/bin/automaton-entrypoint

# Identity, database, SOUL.md, WORKLOG.md, skills. Mount a volume here or the
# agent forgets everything on rebuild.
VOLUME ["/root/.automaton"]
# Downloaded model weights — several GB. Separate volume so rebuilding the
# agent does not re-download the model.
VOLUME ["/root/.ollama"]
# Monero wallet keys.
VOLUME ["/root/.monero-wallets"]

# Defaults that differ between the CPU and GPU tags.
#
# The image itself is identical either way — Ollama's bundle already contains
# the CUDA runners, and it uses a GPU automatically when the container is given
# one. What actually needs to change is what is sensible to expect from the
# hardware: a GPU makes a larger model practical, and makes a 15-minute
# inference budget absurd, since on a GPU a turn that slow means something has
# hung rather than that the machine is thinking.
ARG DEFAULT_MODEL=qwen2.5:7b
ARG DEFAULT_INFERENCE_TIMEOUT_MS=900000
ARG VARIANT=cpu

ENV HOME=/root \
    AUTOMATON_LOCAL_MODE=1 \
    AUTOMATON_ROLE=all \
    AUTOMATON_VARIANT=${VARIANT} \
    AUTOMATON_LOCAL_MODEL=${DEFAULT_MODEL} \
    AUTOMATON_LOCAL_INFERENCE_TIMEOUT_MS=${DEFAULT_INFERENCE_TIMEOUT_MS} \
    OLLAMA_BASE_URL=http://127.0.0.1:11434 \
    OLLAMA_HOST=127.0.0.1:11434 \
    AUTOMATON_MONERO_WALLET_RPC_URL=http://127.0.0.1:18082 \
    NODE_ENV=production

# git refuses to operate on repos it considers foreign-owned; the agent's state
# repo is created by root inside the container.
RUN git config --global user.email "automaton@localhost" \
    && git config --global user.name "automaton" \
    && git config --global --add safe.directory '*'

ENTRYPOINT ["automaton-entrypoint"]
