import test from "node:test";
import assert from "node:assert/strict";

import { STRATEGY_KEY_5M_V2 } from "../lib/config.js";
import {
  calculate5mV2KellySizing,
  evaluate5mV2EntryPrice,
  runCheck5mV2,
  select5mV2TradeSide,
} from "../lib/check-bot-5m-v2.js";

function seedEnv() {
  process.env.CRON_SECRET = "topsecret";
  process.env.MONGODB_URI = "mongodb://localhost:27017/test";
  process.env.TELEGRAM_SIGNAL_BOT_TOKEN = "sig";
  process.env.TELEGRAM_SIGNAL_CHAT_ID = "100";
  process.env.TELEGRAM_ACTION_BOT_TOKEN = "act";
  process.env.TELEGRAM_ACTION_CHAT_ID = "200";
  process.env.TELEGRAM_SIGNAL_5M_BOT_TOKEN = "sig5";
  process.env.TELEGRAM_SIGNAL_5M_CHAT_ID = "300";
  process.env.TELEGRAM_ACTION_5M_BOT_TOKEN = "act5";
  process.env.TELEGRAM_ACTION_5M_CHAT_ID = "400";
  process.env.POLYMARKET_PRIVATE_KEY = "0xabc";
  process.env.POLYMARKET_FUNDER_ADDRESS = "0xdef";
  process.env.POLYMARKET_USER_ADDRESS = "0xdef";
  process.env.DRY_RUN_DEFAULT = "true";
}

const btcFeatures = {
  btcStart: 100,
  btcTriggerPrice: 100.04,
  btcDistance: 0.0004,
  btcMomentum60: 0.0001,
  btcRsi14: 55,
  btcEmaTrend: 0.0002,
  btcBollingerZ20: 0.4,
};

const mapPayload = {
  lookup_order: [{ source: "global", min_support: 0 }],
  buckets: {
    balanced: {},
    coarse: {},
    simple: {},
  },
  global: {
    n: 80,
    up_wins: 56,
    down_wins: 24,
    up_probability: 0.7,
    down_probability: 0.3,
    up_wilson_lower_68: 0.65,
    down_wilson_lower_68: 0.25,
  },
};

const bothSidesPassMapPayload = {
  ...mapPayload,
  global: {
    n: 100,
    up_wins: 70,
    down_wins: 30,
    up_probability: 0.7,
    down_probability: 0.65,
    up_wilson_lower_68: 0.65,
    down_wilson_lower_68: 0.6,
  },
};

test("5m v2 TA rule passes with price, conservative edge, and support", () => {
  const result = evaluate5mV2EntryPrice(0.5, "YES", btcFeatures, mapPayload);
  assert.equal(result.passes, true);
  assert.equal(result.reason, "ta_edge_passed");
  assert.equal(result.probability, 0.7);
  assert.equal(result.conservativeProbability, 0.65);
  assert.equal(Number(result.conservativeEdge.toFixed(2)), 0.15);
  assert.equal(result.supportN, 80);
});

test("5m v2 TA rule skips low support", () => {
  const lowSupportMap = {
    ...mapPayload,
    global: {
      ...mapPayload.global,
      n: 10,
    },
  };
  const result = evaluate5mV2EntryPrice(0.5, "YES", btcFeatures, lowSupportMap);
  assert.equal(result.passes, false);
  assert.equal(result.reason, "support_below_min");
});

test("5m v2 TA rule skips prices outside band", () => {
  assert.equal(evaluate5mV2EntryPrice(0.29, "YES", btcFeatures, mapPayload).reason, "price_outside_band");
  assert.equal(evaluate5mV2EntryPrice(0.61, "YES", btcFeatures, mapPayload).reason, "price_outside_band");
});

test("5m v2 Kelly sizing uses 1/10 Kelly with 5-share floor", () => {
  const result = calculate5mV2KellySizing({
    entryPrice: 0.5,
    conservativeProbability: 0.65,
    bankrollUsd: 30,
  });
  assert.equal(result.fullKellyFraction, 0.3);
  assert.equal(result.usedKellyFraction, 0.03);
  assert.equal(result.rawStakeUsd, 0.9);
  assert.equal(result.rawShares, 1.8);
  assert.equal(result.minSharesApplied, true);
  assert.equal(result.shares, 5);
  assert.equal(result.stakeUsd, 2.5);
});

test("5m v2 selects only the passing side with the best conservative edge", () => {
  const selected = select5mV2TradeSide({
    yes: {
      passes: true,
      price: 0.5,
      conservativeProbability: 0.65,
      conservativeEdge: 0.15,
    },
    no: {
      passes: true,
      price: 0.4,
      conservativeProbability: 0.6,
      conservativeEdge: 0.2,
    },
  });
  assert.equal(selected, "NO");
});

test("runCheck5mV2 only previews the best side when both sides pass", async () => {
  seedEnv();
  process.env.DRY_RUN_DEFAULT = "true";

  const insertedDecisions = [];
  const updates = [];
  const tradeAlerts = [];
  const result = await runCheck5mV2({
    deps: {
      nowSeconds: 1_440,
      now: new Date("2026-05-18T00:00:00Z"),
      ensureIndexesImpl: async () => {},
      resolveTriggerMarketStartTsImpl: () => 1_200,
      load5mTaProbabilityMapImpl: async () => bothSidesPassMapPayload,
      fetchMarketByStartTsImpl: async () => ({
        slug: "btc-updown-5m-1200",
        startTs: 1_200,
        question: "Bitcoin Up or Down - test",
        yesTokenId: "yes-token",
        noTokenId: "no-token",
        tickSize: "0.01",
        orderMinSize: 5,
        negRisk: false,
      }),
      fetchMarketPriceImpl: async (tokenId) => (tokenId === "yes-token" ? 0.5 : 0.4),
      fetch5mTaTriggerFeaturesImpl: async () => btcFeatures,
      insertBotRunImpl: async () => {},
      sendSignalMessageImpl: async () => {},
      findDecisionImpl: async () => null,
      insertDecisionImpl: async (doc) => {
        insertedDecisions.push(doc);
      },
      listDecisionsForDayImpl: async () => [],
      updateDecisionImpl: async (update) => {
        updates.push(update);
      },
      insertActionImpl: async () => {},
      sendTradeAlertImpl: async (_cfg, payload) => {
        tradeAlerts.push(payload);
        return { sent: true, error: null };
      },
      settleTradesImpl: async () => ({
        settled: [],
        summary: {
          wins: 0,
          losses: 0,
          unresolved: 0,
          profitUsd: 0,
          lossUsd: 0,
          realizedPnlUsd: 0,
          totalRealizedPnlUsd: 0,
          unresolvedStakeUsd: 0,
          stakeUsd: 0,
          totalStakeUsd: 0,
          remainingBankrollUsd: 30,
          roi: null,
          winRate: null,
        },
      }),
      sendOutcomeSummaryImpl: async () => ({ sent: true, error: null }),
    },
  });

  assert.equal(result.yes.passes, true);
  assert.equal(result.no.passes, true);
  assert.equal(result.selectedTradeSide, "NO");
  assert.deepEqual(result.actions.map((action) => [action.side, action.reason ?? action.skipped]), [
    ["YES", "not_best_side"],
    ["NO", undefined],
  ]);
  assert.equal(tradeAlerts.length, 1);
  assert.equal(tradeAlerts[0].side, "NO");
  assert.equal(insertedDecisions.length, 2);
  assert.equal(insertedDecisions.find((doc) => doc.side === "YES").selected_for_trade, false);
  assert.equal(insertedDecisions.find((doc) => doc.side === "YES").passed, false);
  assert.equal(insertedDecisions.find((doc) => doc.side === "NO").selected_for_trade, true);
  assert.equal(insertedDecisions.find((doc) => doc.side === "NO").passed, true);
  assert.equal(updates.some((update) => update.side === "YES" && update.set.buy_error === "not_best_side"), true);
});

test("runCheck5mV2 dry run sends preview and stores v2 decision fields", async () => {
  seedEnv();
  process.env.DRY_RUN_DEFAULT = "true";

  const insertedDecisions = [];
  const tradeAlerts = [];
  const result = await runCheck5mV2({
    deps: {
      nowSeconds: 1_440,
      now: new Date("2026-05-18T00:00:00Z"),
      ensureIndexesImpl: async () => {},
      resolveTriggerMarketStartTsImpl: () => 1_200,
      load5mTaProbabilityMapImpl: async () => mapPayload,
      fetchMarketByStartTsImpl: async () => ({
        slug: "btc-updown-5m-1200",
        startTs: 1_200,
        question: "Bitcoin Up or Down - test",
        yesTokenId: "yes-token",
        noTokenId: "no-token",
        tickSize: "0.01",
        orderMinSize: 5,
        negRisk: false,
      }),
      fetchMarketPriceImpl: async (tokenId) => (tokenId === "yes-token" ? 0.5 : 0.5),
      fetch5mTaTriggerFeaturesImpl: async () => btcFeatures,
      insertBotRunImpl: async () => {},
      sendSignalMessageImpl: async () => {},
      findDecisionImpl: async () => null,
      insertDecisionImpl: async (doc) => {
        insertedDecisions.push(doc);
      },
      listDecisionsForDayImpl: async () => [],
      updateDecisionImpl: async () => {},
      insertActionImpl: async () => {},
      sendTradeAlertImpl: async (_cfg, payload) => {
        tradeAlerts.push(payload);
        return { sent: true, error: null };
      },
      settleTradesImpl: async () => ({
        settled: [],
        summary: {
          wins: 0,
          losses: 0,
          unresolved: 0,
          profitUsd: 0,
          lossUsd: 0,
          realizedPnlUsd: 0,
          totalRealizedPnlUsd: 0,
          unresolvedStakeUsd: 0,
          stakeUsd: 0,
          totalStakeUsd: 0,
          remainingBankrollUsd: 30,
          roi: null,
          winRate: null,
        },
      }),
      sendOutcomeSummaryImpl: async () => ({ sent: true, error: null }),
    },
  });

  assert.equal(result.strategyKey, STRATEGY_KEY_5M_V2);
  assert.equal(result.yes.passes, true);
  assert.equal(result.no.passes, false);
  assert.equal(tradeAlerts.length, 1);
  assert.equal(tradeAlerts[0].side, "YES");
  assert.equal(tradeAlerts[0].dryRun, true);
  assert.equal(tradeAlerts[0].shares, 5);
  assert.equal(tradeAlerts[0].estimatedNotional, 2.5);
  assert.equal(insertedDecisions.length, 2);
  assert.equal(insertedDecisions[0].strategy_key, STRATEGY_KEY_5M_V2);
  assert.equal(insertedDecisions[0].model_source, "btc_5m_ta_probability_map_90d");
  assert.equal(insertedDecisions[0].model_probability, 0.7);
  assert.equal(insertedDecisions[0].model_conservative_probability, 0.65);
  assert.equal(insertedDecisions[0].model_support_n, 80);
  assert.equal(insertedDecisions[0].min_entry_price, 0.3);
  assert.equal(insertedDecisions[0].max_entry_price, 0.6);
  assert.equal(insertedDecisions[0].min_conservative_edge, 0.06);
  assert.equal(insertedDecisions[0].min_support, 25);
  assert.equal(insertedDecisions[0].sizing_method, "kelly_1_10");
  assert.equal(insertedDecisions[0].kelly_bankroll_usd, 30);
  assert.equal(insertedDecisions[0].kelly_full_fraction, 0.3);
  assert.equal(insertedDecisions[0].kelly_used_fraction, 0.03);
  assert.equal(insertedDecisions[0].kelly_raw_notional_usd, 0.9);
  assert.equal(insertedDecisions[0].kelly_raw_shares, 1.8);
  assert.equal(insertedDecisions[0].kelly_min_shares, 5);
  assert.equal(insertedDecisions[0].kelly_min_shares_applied, true);
  assert.equal(insertedDecisions[0].buy_target_notional_usd, 2.5);
  assert.equal(insertedDecisions[0].buy_target_shares, 5);
});
