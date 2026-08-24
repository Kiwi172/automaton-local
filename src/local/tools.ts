/**
 * Local Mode Tool Filtering
 *
 * Tools that can only work against the Conway control plane are removed from
 * the agent's tool list in local mode. Leaving them in place costs turns: a
 * small local model will happily call register_domain, read the failure, and
 * try again with different arguments.
 *
 * Set AUTOMATON_LOCAL_ALLOW_CLOUD_TOOLS=1 to keep them — useful if you have
 * funded the wallet and provisioned a Conway key but still want local
 * inference and local execution.
 */

import type { AutomatonTool } from "../types.js";

/**
 * Tools removed in local mode, and why.
 *
 * Kept deliberately: exec/file/git/skill/memory/soul tools (all local),
 * enter_low_compute (still meaningful — it selects a smaller model), and
 * list_models/switch_model (they enumerate what the local endpoint serves).
 */
export const CLOUD_ONLY_TOOLS: readonly string[] = [
  // Sandbox rental — there is no control plane to rent from.
  "create_sandbox",
  "delete_sandbox",
  "list_sandboxes",
  // Credits and payments — no metered balance, no funded wallet by default.
  "check_credits",
  "check_usdc_balance",
  "topup_credits",
  "transfer_credits",
  "distress_signal",
  "x402_fetch",
  // Replication — every child needs a sandbox of its own.
  "spawn_child",
  "list_children",
  "fund_child",
  "start_child",
  "check_child_status",
  "message_child",
  "verify_child_constitution",
  "prune_dead_children",
  // Domains and DNS — Conway registrar operations.
  "search_domains",
  "register_domain",
  "manage_dns",
  // On-chain identity and reputation — needs a funded wallet and an RPC.
  "register_erc8004",
  "update_agent_card",
  "discover_agents",
  "give_feedback",
  "check_reputation",
];

const CLOUD_ONLY = new Set(CLOUD_ONLY_TOOLS);

function cloudToolsAllowed(): boolean {
  const raw = process.env.AUTOMATON_LOCAL_ALLOW_CLOUD_TOOLS;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Drop cloud-only tools. Returns the list unchanged when the override is set. */
export function filterToolsForLocalMode(tools: AutomatonTool[]): AutomatonTool[] {
  if (cloudToolsAllowed()) return tools;
  return tools.filter((tool) => !CLOUD_ONLY.has(tool.name));
}
