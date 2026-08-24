/**
 * Local Setup
 *
 * Non-interactive first-run setup for local-hardware mode. The interactive
 * wizard asks for a Conway API key, a creator wallet address and provider keys;
 * none of that applies here, and none of it can be answered by a container
 * starting under `docker compose up`.
 *
 * Everything is read from the environment, with defaults that produce a
 * working automaton. Re-running is safe: an existing config is updated in
 * place rather than replaced, so a rebuild never resets the agent's identity.
 */

import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { AutomatonConfig, HeartbeatConfig } from "../types.js";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY } from "../types.js";
import { getAutomatonDir, getWallet } from "../identity/wallet.js";
import { loadConfig, saveConfig } from "../config.js";
import { saveHeartbeatConfig } from "../heartbeat/config.js";
import { resolveLocalModeSettings } from "../local/mode.js";
import { resolveMoneroSettings } from "../local/monero/config.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("local-setup");

const DEFAULT_GENESIS_PROMPT = `You are running on your creator's own hardware.
Read WORKLOG.md to see where you left off, then pick the smallest useful next
step toward the purpose your creator gave you, do it, and write down what
happened. If no purpose has been set yet, say so plainly in WORKLOG.md and wait
rather than inventing one.`;

/**
 * Heartbeat schedule for local mode.
 *
 * The cloud default pings Conway, polls a credit balance and watches a USDC
 * wallet for top-ups. Locally those either no-op or fail every few minutes, so
 * only the two tasks that still mean something are enabled.
 */
const LOCAL_HEARTBEAT_CONFIG: HeartbeatConfig = {
  entries: [
    { name: "health_check", schedule: "*/30 * * * *", task: "health_check", enabled: true },
    { name: "check_for_updates", schedule: "0 */4 * * *", task: "check_for_updates", enabled: true },
  ],
  defaultIntervalMs: 60_000,
  lowComputeMultiplier: 4,
};

function generateLocalSoulMd(params: {
  name: string;
  address: string;
  creator: string;
  genesis: string;
  model: string;
}): string {
  return `# ${params.name}

## Identity
- Name: ${params.name}
- Address: ${params.address}
- Creator: ${params.creator}
- Born: ${new Date().toISOString()}
- Runs on: local hardware, thinking with ${params.model}

## Mission
${params.genesis}

## Values
- Be useful: the work is the point, not the continuing to exist
- Be honest: never deny what you are or misrepresent what you did
- Be legible: leave your creator a record they can follow in WORKLOG.md
- Be careful: this machine belongs to someone; act like a guest on it

## Capabilities
- Shell execution, file I/O and local servers on this machine
- Local inference through an OpenAI-compatible endpoint
- Self-modification with an audit trail
- Heartbeat system for periodic tasks
- Git-versioned state

## Not available here
- No Conway sandboxes, credits, domains, or payments
- No replication: children need infrastructure this setup does not have

## Log
- Genesis: configured for local mode
`;
}

export async function runLocalSetup(): Promise<AutomatonConfig> {
  const settings = resolveLocalModeSettings(loadConfig());
  const automatonDir = getAutomatonDir();
  if (!fs.existsSync(automatonDir)) {
    fs.mkdirSync(automatonDir, { recursive: true, mode: 0o700 });
  }

  // The wallet is generated offline. It stays the automaton's identity even
  // though there is no chain interaction in local mode.
  const { chainIdentity, isNew } = await getWallet("evm");
  const walletAddress = chainIdentity.address;

  const existing = loadConfig();
  const name = process.env.AUTOMATON_NAME || existing?.name || "automaton";
  const genesisPrompt =
    process.env.AUTOMATON_GENESIS_PROMPT || existing?.genesisPrompt || DEFAULT_GENESIS_PROMPT;
  const creatorAddress =
    process.env.AUTOMATON_CREATOR_ADDRESS || existing?.creatorAddress || "local-operator";
  const creatorMessage = process.env.AUTOMATON_CREATOR_MESSAGE || existing?.creatorMessage;
  // Persist the donation destination so it survives a run without the env var
  // set. Absent = donations stay off and the tools are never offered.
  const monero = resolveMoneroSettings(existing);

  const config: AutomatonConfig = {
    ...DEFAULT_CONFIG,
    ...(existing ?? {}),
    name,
    genesisPrompt,
    creatorMessage,
    creatorAddress,
    localMode: true,
    registeredWithConway: false,
    // Empty sandbox id is what tells the rest of the runtime it is not in a
    // Conway sandbox.
    sandboxId: "",
    conwayApiUrl: DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: "",
    ollamaBaseUrl: settings.inferenceBaseUrl,
    inferenceModel: settings.model,
    maxTokensPerTurn: existing?.maxTokensPerTurn ?? DEFAULT_CONFIG.maxTokensPerTurn ?? 4096,
    heartbeatConfigPath:
      existing?.heartbeatConfigPath || DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: existing?.dbPath || DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: existing?.logLevel || (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: existing?.skillsDir || DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: 0,
    creatorMoneroAddress: monero?.policy.creatorAddress,
    moneroWalletRpcUrl: monero?.walletRpcUrl,
    treasuryPolicy: existing?.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    chainType: "evm",
  } as AutomatonConfig;

  saveConfig(config);

  // Heartbeat: only write defaults on first run, so an operator's edits to
  // heartbeat.yml survive a container rebuild.
  const heartbeatPath = path.join(automatonDir, "heartbeat.yml");
  if (!fs.existsSync(heartbeatPath)) {
    saveHeartbeatConfig(LOCAL_HEARTBEAT_CONFIG, heartbeatPath);
  }

  // The constitution is immutable and protected from self-modification.
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSrc) && !fs.existsSync(constitutionDst)) {
    fs.copyFileSync(constitutionSrc, constitutionDst);
    fs.chmodSync(constitutionDst, 0o444);
  }

  const soulPath = path.join(automatonDir, "SOUL.md");
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(
      soulPath,
      generateLocalSoulMd({
        name,
        address: walletAddress,
        creator: creatorAddress,
        genesis: genesisPrompt,
        model: settings.model,
      }),
      { mode: 0o600 },
    );
  }

  // WORKLOG.md is the agent's channel to its operator; seed it so the first
  // turn has somewhere to write.
  const worklogPath = path.join(automatonDir, "WORKLOG.md");
  if (!fs.existsSync(worklogPath)) {
    fs.writeFileSync(
      worklogPath,
      `# Worklog\n\nNothing yet. First boot at ${new Date().toISOString()}.\n`,
      { mode: 0o600 },
    );
  }

  // The bundled default skills are all Conway-specific (compute, payments,
  // survival economics) and would be misleading here, so none are installed.

  console.log(chalk.green(`  Local mode configured for "${name}"`));
  console.log(chalk.dim(`  Wallet:    ${walletAddress}${isNew ? " (new)" : ""}`));
  console.log(chalk.dim(`  Model:     ${settings.model}`));
  console.log(chalk.dim(`  Endpoint:  ${settings.inferenceBaseUrl}`));
  console.log(chalk.dim(`  State:     ${automatonDir}`));
  if (monero) {
    console.log(
      chalk.dim(
        `  Donations: ${monero.policy.defaultSharePercent}% default (agent may pick ${monero.policy.minSharePercent}–${monero.policy.maxSharePercent}%) to ${monero.policy.creatorAddress.slice(0, 12)}…`,
      ),
    );
  } else {
    console.log(chalk.dim("  Donations: off (no creator Monero address set)"));
  }
  logger.info(`Local setup complete for ${name}`);

  return config;
}
