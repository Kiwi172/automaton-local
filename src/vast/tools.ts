/**
 * Vast Tools
 *
 * What the agent can do with a GPU marketplace: ask a bigger model, see what it
 * is renting and what that costs, spawn a child, and stop paying for things.
 *
 * Every tool that spends money reports refusals as plain sentences rather than
 * throwing, because the caller is a language model deciding what to do next and
 * "the budget said no" is information it can act on.
 */

import type { AutomatonTool } from "../types.js";
import { createLogger } from "../observability/logger.js";
import type { VastSettings } from "./config.js";
import { VastClient } from "./client.js";
import { askBigModel, reapIdleInstances } from "./escalation.js";
import {
  destroyVastChild,
  getVastChildren,
  initReplicationTables,
  spawnChildOnVast,
} from "./replication.js";
import {
  getActiveRentals,
  getSpendSince,
  initVastLedger,
  recordRentalEnd,
} from "./spend.js";

const logger = createLogger("vast-tools");

export function createVastTools(settings: VastSettings): AutomatonTool[] {
  const client = new VastClient({ apiKey: settings.apiKey, dryRun: settings.dryRun });
  const dryRunNote = settings.dryRun ? " (DRY RUN: nothing is actually rented)" : "";

  return [
    {
      name: "ask_bigger_model",
      description:
        `Ask a larger model (${settings.escalation.model}) a question your own reasoning cannot ` +
        `settle. This rents a GPU, which costs real money and takes 5-15 minutes to become ` +
        `ready the first time. Worth it for a genuinely hard problem; wasteful for a passing ` +
        `thought. Follow-up questions reuse the same instance and are fast.${dryRunNote}`,
      category: "conway",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question. Be specific and self-contained — the bigger model has no memory " +
              "of your situation beyond what you tell it here.",
          },
          context: {
            type: "string",
            description:
              "Relevant background: what you tried, what happened, what constraints apply.",
          },
        },
        required: ["question"],
      },
      execute: async (args, ctx) => {
        initVastLedger(ctx.db.raw);
        const outcome = await askBigModel(
          { db: ctx.db.raw, settings, client },
          {
            question: args.question as string,
            context: typeof args.context === "string" ? args.context : undefined,
          },
        );
        if (outcome.status === "refused") {
          return `No answer. ${outcome.reason}`;
        }
        return `${outcome.model} says:\n\n${outcome.answer}`;
      },
    },

    {
      name: "vast_status",
      description:
        "See what you are renting on Vast right now, what it costs per hour, and what you " +
        "have spent in the last hour and day.",
      category: "conway",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        initVastLedger(ctx.db.raw);
        const active = getActiveRentals(ctx.db.raw);
        const hourSpend = getSpendSince(ctx.db.raw, new Date(Date.now() - 3_600_000));
        const daySpend = getSpendSince(ctx.db.raw, new Date(Date.now() - 24 * 3_600_000));

        const lines = [
          `Active instances: ${active.length} / ${settings.limits.maxConcurrentInstances} allowed`,
        ];
        for (const rental of active) {
          lines.push(
            `  #${rental.instanceId} ${rental.purpose} — $${rental.dollarsPerHour.toFixed(3)}/hr ` +
              `since ${rental.startedAt}${rental.label ? ` (${rental.label})` : ""}`,
          );
        }
        lines.push(
          `Spent last hour: $${hourSpend.toFixed(2)} / $${settings.limits.maxHourlySpend.toFixed(2)} cap`,
          `Spent last 24h:  $${daySpend.toFixed(2)} / $${settings.limits.maxDailySpend.toFixed(2)} cap`,
        );

        try {
          lines.push(`Vast account balance: $${(await client.getBalance()).toFixed(2)}`);
        } catch (err: any) {
          lines.push(`Vast account balance: unavailable (${err.message})`);
        }

        return lines.join("\n");
      },
    },

    {
      name: "spawn_child_on_vast",
      description:
        `Start a new automaton on a rented Vast instance with its own genesis prompt and its ` +
        `own API key. Keys come from a pool your creator provisions — you cannot create them, ` +
        `so if the pool is empty you cannot replicate.${dryRunNote}`,
      category: "replication",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name for the child." },
          genesis_prompt: {
            type: "string",
            description:
              "The child's purpose. It will not inherit yours, so state it fully and concretely.",
          },
        },
        required: ["name", "genesis_prompt"],
      },
      execute: async (args, ctx) => {
        initVastLedger(ctx.db.raw);
        initReplicationTables(ctx.db.raw);
        const outcome = await spawnChildOnVast(
          { db: ctx.db.raw, settings, client },
          {
            name: args.name as string,
            genesisPrompt: args.genesis_prompt as string,
            creatorAddress: ctx.config.creatorAddress,
          },
        );
        if (outcome.status === "refused") {
          return `No child spawned. ${outcome.reason}`;
        }
        return (
          `Spawned "${outcome.child.name}" as Vast instance ${outcome.child.instanceId}.\n` +
          outcome.endpointHint
        );
      },
    },

    {
      name: "list_vast_children",
      description: "List the automatons you have spawned on Vast and their status.",
      category: "replication",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        initReplicationTables(ctx.db.raw);
        const children = getVastChildren(ctx.db.raw);
        if (children.length === 0) return "You have no children on Vast.";
        return children
          .map(
            (c) =>
              `#${c.instanceId} ${c.name} — ${c.status}, created ${c.createdAt}\n    purpose: ${c.genesisPrompt.slice(0, 120)}`,
          )
          .join("\n");
      },
    },

    {
      name: "destroy_vast_instance",
      description:
        "Destroy a Vast instance you are renting and stop paying for it. Use this on an " +
        "escalation instance you are done with, or a child that has finished its work.",
      category: "conway",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          instance_id: { type: "number", description: "The instance id from vast_status." },
        },
        required: ["instance_id"],
      },
      execute: async (args, ctx) => {
        initVastLedger(ctx.db.raw);
        initReplicationTables(ctx.db.raw);
        const instanceId = Number(args.instance_id);
        if (!Number.isFinite(instanceId)) return "ERROR: instance_id must be a number.";
        try {
          await destroyVastChild({ db: ctx.db.raw, settings, client }, instanceId);
          recordRentalEnd(ctx.db.raw, instanceId);
          return `Instance ${instanceId} destroyed. Billing for it has stopped.`;
        } catch (err: any) {
          return `ERROR: could not destroy instance ${instanceId}: ${err.message}`;
        }
      },
    },
  ];
}

/**
 * Destroy idle escalation instances.
 *
 * Exported for the heartbeat, which is the point: this has to keep running
 * while the agent sleeps, because that is exactly when a forgotten rental would
 * otherwise keep billing.
 */
export async function runIdleReaper(
  db: any,
  settings: VastSettings,
): Promise<number> {
  const client = new VastClient({ apiKey: settings.apiKey, dryRun: settings.dryRun });
  initVastLedger(db);
  try {
    return await reapIdleInstances({ db, settings, client });
  } catch (err: any) {
    logger.warn(`Idle reaper failed: ${err.message}`);
    return 0;
  }
}
