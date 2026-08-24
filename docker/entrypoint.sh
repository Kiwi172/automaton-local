#!/usr/bin/env bash
# Bring up the local automaton.
#
# AUTOMATON_ROLE selects what this container is:
#   all    (default) inference server + wallet daemon + agent, all in one
#   ollama just the inference server
#   wallet just monero-wallet-rpc
#   agent  just the agent, expecting the other two to be reachable
#
# The "all" role is the point of this image: one container, nothing else needed.
set -euo pipefail

ROLE="${AUTOMATON_ROLE:-all}"
BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
MODEL="${AUTOMATON_LOCAL_MODEL:-qwen2.5:7b}"
WALLET_RPC_URL="${AUTOMATON_MONERO_WALLET_RPC_URL:-http://127.0.0.1:18082}"
WAIT_SECONDS="${AUTOMATON_INFERENCE_WAIT_SECONDS:-600}"

log() { echo "[entrypoint] $*"; }
die() { log "ERROR: $*"; exit 1; }

pids=()
shutdown() {
  log "shutting down"
  for pid in "${pids[@]:-}"; do
    [ -n "${pid}" ] && kill "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap shutdown SIGTERM SIGINT

# ─── Inference server ─────────────────────────────────────────────

start_ollama() {
  # A long context matters more here than anywhere else: the agent's system
  # prompt alone runs to several thousand tokens, and Ollama's default context
  # silently truncates the front of it — which is where the constitution and
  # the environment description live.
  export OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-32768}"
  export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
  log "starting ollama on ${OLLAMA_HOST} (context ${OLLAMA_CONTEXT_LENGTH})"
  ollama serve &
  pids+=($!)
}

wait_for_inference() {
  log "waiting for inference endpoint at ${BASE_URL} (up to ${WAIT_SECONDS}s)"
  local deadline=$(( $(date +%s) + WAIT_SECONDS ))
  until curl -sf "${BASE_URL}/api/tags" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      die "${BASE_URL} never became reachable. Check the logs above."
    fi
    sleep 2
  done
  log "inference endpoint is up"
}

ensure_model() {
  if curl -sf "${BASE_URL}/api/tags" | grep -q "\"${MODEL}\""; then
    log "model ${MODEL} already present"
    return
  fi
  log "pulling ${MODEL} — first run downloads several GB, this takes a while"
  curl -sf -X POST "${BASE_URL}/api/pull" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${MODEL}\"}" | tail -c 2000 \
    || die "failed to pull ${MODEL}. Check the name at https://ollama.com/library"
  echo
  log "pull complete"
}

# ─── Monero wallet daemon ─────────────────────────────────────────

donations_off() {
  # Mirrors donationsDisabled() in src/local/monero/config.ts. Donations are on
  # by default, using the built-in creator address, unless switched off here.
  case "$(echo "${AUTOMATON_DONATIONS:-}" | tr '[:upper:]' '[:lower:]')" in
    off|0|false|no) return 0 ;;
  esac
  # An address explicitly set to empty means "none", unlike leaving it unset.
  if [ "${AUTOMATON_CREATOR_MONERO_ADDRESS+set}" = "set" ] && [ -z "${AUTOMATON_CREATOR_MONERO_ADDRESS}" ]; then
    return 0
  fi
  return 1
}

start_wallet_rpc() {
  if donations_off; then
    log "donations off — wallet daemon not started"
    return
  fi

  local node="${MONERO_DAEMON_ADDRESS:-node.monerodevs.org:18089}"
  local wallet_dir="${MONERO_WALLET_DIR:-/root/.monero-wallets}"
  local port="${MONERO_WALLET_RPC_PORT:-18082}"
  local net_flag=""
  [ "${MONERO_NETWORK:-mainnet}" = "stagenet" ] && net_flag="--stagenet"
  [ "${MONERO_NETWORK:-mainnet}" = "testnet" ] && net_flag="--testnet"

  mkdir -p "${wallet_dir}"
  log "starting monero-wallet-rpc on :${port} against node ${node} (${MONERO_NETWORK:-mainnet})"
  # --disable-rpc-login is safe only because the RPC binds to loopback inside
  # this container. Do not publish port 18082 to the host or the network.
  monero-wallet-rpc \
    ${net_flag} \
    --rpc-bind-ip 127.0.0.1 \
    --rpc-bind-port "${port}" \
    --disable-rpc-login \
    --wallet-dir "${wallet_dir}" \
    --daemon-address "${node}" \
    --untrusted-daemon \
    --log-level 0 &
  pids+=($!)

  log "waiting for wallet rpc at ${WALLET_RPC_URL}"
  local deadline=$(( $(date +%s) + 120 ))
  until curl -sf "${WALLET_RPC_URL}/json_rpc" \
          -H 'Content-Type: application/json' \
          -d '{"jsonrpc":"2.0","id":"0","method":"get_version"}' >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      log "WARNING: wallet rpc did not come up in time. Donations will fail until it does."
      return
    fi
    sleep 2
  done
  log "wallet rpc is up"
}

# ─── Agent ────────────────────────────────────────────────────────

run_agent() {
  log "configuring (idempotent — existing identity and state are preserved)"
  node /app/dist/index.js --local-setup
  log "starting agent loop"
  exec node /app/dist/index.js --run
}

case "${ROLE}" in
  ollama)
    start_ollama
    wait_for_inference
    ensure_model
    wait -n
    ;;
  wallet)
    start_wallet_rpc
    wait -n
    ;;
  agent)
    wait_for_inference
    ensure_model
    run_agent
    ;;
  all)
    start_ollama
    start_wallet_rpc
    wait_for_inference
    ensure_model
    run_agent
    ;;
  *)
    die "unknown AUTOMATON_ROLE '${ROLE}' (expected: all, ollama, wallet, agent)"
    ;;
esac
