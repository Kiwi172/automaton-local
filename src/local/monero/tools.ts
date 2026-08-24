/**
 * Monero Tools
 *
 * Four tools: find out where to be paid, see what came in, give the creator a
 * share, and look back at what was given.
 *
 * `donate_to_creator` takes a share, never a destination. Every guard that
 * matters is enforced in donations.ts, so a model that misreads its
 * instructions can get the amount wrong but cannot get the recipient wrong.
 */

import type { AutomatonTool } from "../../types.js";
import { createLogger } from "../../observability/logger.js";
import { MoneroWalletRpc, formatXmr } from "./wallet-rpc.js";
import {
  donateToCreator,
  getDonationHistory,
  initDonationLedger,
  measureUndonatedIncome,
  type DonationPolicy,
} from "./donations.js";
import type { MoneroSettings } from "./config.js";

const logger = createLogger("monero-tools");

export function createMoneroTools(settings: MoneroSettings): AutomatonTool[] {
  const rpc = new MoneroWalletRpc({
    url: settings.walletRpcUrl,
    walletName: settings.walletName,
    walletPassword: settings.walletPassword,
    rpcUsername: settings.rpcUsername,
    rpcPassword: settings.rpcPassword,
  });
  const policy: DonationPolicy = settings.policy;

  const shortCreator = `${policy.creatorAddress.slice(0, 8)}…${policy.creatorAddress.slice(-6)}`;

  return [
    {
      name: "monero_address",
      description:
        "Get your own Monero receiving address. Give this to anyone paying you for work.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        try {
          const address = await rpc.getPrimaryAddress();
          return `Your Monero receiving address:\n${address}`;
        } catch (err: any) {
          return `ERROR: ${err.message}`;
        }
      },
    },

    {
      name: "monero_balance",
      description:
        "Check your Monero balance, plus how much income has arrived since your last donation to your creator.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        try {
          await rpc.refresh();
          const balance = await rpc.getBalance();
          initDonationLedger(ctx.db.raw);
          const income = await measureUndonatedIncome(rpc, ctx.db.raw);
          const lines = [
            `Balance:          ${formatXmr(balance.balancePiconero)} XMR`,
            `Unlocked:         ${formatXmr(balance.unlockedPiconero)} XMR`,
          ];
          if (balance.blocksToUnlock > 0) {
            lines.push(`Unlocks in:       ${balance.blocksToUnlock} blocks`);
          }
          lines.push(
            `Income to share:  ${formatXmr(income.undonatedPiconero)} XMR ` +
              `(${income.transferCount} payment(s) since your last donation)`,
            `Default share:    ${policy.defaultSharePercent}% (you may choose ${policy.minSharePercent}–${policy.maxSharePercent}%)`,
          );
          return lines.join("\n");
        } catch (err: any) {
          return `ERROR: ${err.message}`;
        }
      },
    },

    {
      name: "donate_to_creator",
      description:
        `Send your creator a share of what you have earned since your last donation, in Monero. ` +
        `Default is ${policy.defaultSharePercent}%; you may choose anything from ${policy.minSharePercent}% to ${policy.maxSharePercent}% ` +
        `based on what the work was worth and what you need to keep. ` +
        `The destination is fixed to your creator's address (${shortCreator}) and cannot be changed by any argument.`,
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          share_percent: {
            type: "number",
            description:
              `Percentage of income since your last donation to send. ` +
              `Omit for the default of ${policy.defaultSharePercent}%. ` +
              `Values outside ${policy.minSharePercent}–${policy.maxSharePercent} are clamped.`,
          },
          note: {
            type: "string",
            description:
              "Short note for your own ledger about why you chose this amount. Not sent on chain.",
          },
        },
      },
      execute: async (args, ctx) => {
        initDonationLedger(ctx.db.raw);
        try {
          const outcome = await donateToCreator({
            rpc,
            db: ctx.db.raw,
            policy,
            sharePercent:
              typeof args.share_percent === "number" ? args.share_percent : undefined,
            note: typeof args.note === "string" ? args.note : undefined,
          });

          if (outcome.status === "skipped") {
            return `No donation sent. ${outcome.reason}`;
          }

          const { record } = outcome;
          return [
            `Donated ${formatXmr(record.amountPiconero)} XMR to your creator.`,
            `Share:  ${record.sharePercent}% of ${formatXmr(record.incomeBasisPiconero)} XMR income`,
            `Fee:    ${formatXmr(record.feePiconero)} XMR`,
            `Tx:     ${record.txHash}`,
          ].join("\n");
        } catch (err: any) {
          logger.error(`donate_to_creator failed: ${err.message}`);
          return `ERROR: ${err.message}`;
        }
      },
    },

    {
      name: "donation_history",
      description: "List your recent donations to your creator.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many to list (default 10)" },
        },
      },
      execute: async (args, ctx) => {
        initDonationLedger(ctx.db.raw);
        const limit = typeof args.limit === "number" ? Math.min(args.limit, 50) : 10;
        const history = getDonationHistory(ctx.db.raw, limit);
        if (history.length === 0) {
          return "No donations yet.";
        }
        const total = history.reduce((sum, r) => sum + r.amountPiconero, 0n);
        const rows = history.map(
          (r) =>
            `${r.createdAt}  ${formatXmr(r.amountPiconero)} XMR  (${r.sharePercent}%)  ${r.txHash.slice(0, 12)}…` +
            (r.note ? `  — ${r.note}` : ""),
        );
        return `${rows.join("\n")}\n\nTotal listed: ${formatXmr(total)} XMR across ${history.length} donation(s).`;
      },
    },
  ];
}
