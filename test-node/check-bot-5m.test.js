import test from "node:test";
import assert from "node:assert/strict";

import {
  build5mOutcomeSummaryText,
  build5mTradeAlertText,
  evaluate5mEntryPrice,
  extractMarketStartTsFromSlug,
  is5mEntryPriceEligible,
  isDecisionEligibleFor5mSettlement,
  runCheck5m,
  summarize5mOutcomes,
} from "../lib/check-bot-5m.js";

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

test("5m price band is strict at both edges", () => {
  assert.equal(is5mEntryPriceEligible(0.8), false);
  assert.equal(is5mEntryPriceEligible(0.95), false);
  assert.equal(is5mEntryPriceEligible(0.81), true);
  assert.equal(is5mEntryPriceEligible(0.94), true);
  assert.equal(evaluate5mEntryPrice(0.79).reason, "price_outside_band");
});

test("5m trade alert text includes executed order details", () => {
  const text = build5mTradeAlertText({
    title: "BTC 5m BUY filled",
    marketSlug: "btc-updown-5m-123",
    question: "Bitcoin Up or Down?",
    side: "YES",
    tokenId: "12345",
    signalPrice: 0.84,
    shares: 5,
    estimatedNotional: 4.2,
    maxBuyPrice: 0.84,
    dryRun: false,
    accepted: true,
    orderId: "ord-1",
    orderStatus: "matched",
  });

  assert.match(text, /side: UP \(YES\)/);
  assert.match(text, /token_id: 12345/);
  assert.match(text, /order_id: ord-1/);
  assert.match(text, /order_status: matched/);
});

test("outcome summary text reports today win loss totals", () => {
  const text = build5mOutcomeSummaryText({
    summary: {
      wins: 2,
      losses: 1,
      unresolved: 3,
      profitUsd: 1.25,
      lossUsd: 4.1,
      realizedPnlUsd: -2.85,
      unresolvedStakeUsd: 12.6,
      totalStakeUsd: 18.9,
      winRate: 2 / 3,
    },
    settled: [
      { marketSlug: "m1", side: "YES", outcomeStatus: "win" },
    ],
  });
  assert.match(text, /realized_pnl_usd: -2.850/);
  assert.match(text, /profit_usd: 1.250/);
  assert.match(text, /loss_usd: 4.100/);
  assert.match(text, /settled: m1 YES -> win/);
});

test("summarize5mOutcomes uses money-based pnl", () => {
  const summary = summarize5mOutcomes([
    { outcome_status: "win", side_price: 0.84, buy_matched_shares: 5 },
    { outcome_status: "loss", side_price: 0.81, buy_matched_shares: 5 },
    { outcome_status: null, side_price: 0.9, buy_matched_shares: 5 },
    { outcome_status: "unresolved", side_price: 0.88, buy_matched_shares: 5 },
  ]);

  assert.deepEqual(summary, {
    wins: 1,
    losses: 1,
    unresolved: 2,
    profitUsd: 0.8,
    lossUsd: 4.05,
    realizedPnlUsd: -3.25,
    unresolvedStakeUsd: 8.9,
    totalStakeUsd: 17.15,
    winRate: 0.5,
  });
});

test("extractMarketStartTsFromSlug parses the Polymarket slug suffix", () => {
  assert.equal(extractMarketStartTsFromSlug("btc-updown-5m-1779038400"), 1779038400);
  assert.equal(extractMarketStartTsFromSlug("bad-slug"), null);
});

test("5m settlement eligibility uses market timestamp rather than created_at", () => {
  const lateRecordedOldTrade = {
    market_slug: "btc-updown-5m-1000",
    created_at: new Date("2099-01-01T00:00:00Z"),
  };
  const futureTrade = {
    market_slug: "btc-updown-5m-1300",
    created_at: new Date("2000-01-01T00:00:00Z"),
  };

  assert.equal(isDecisionEligibleFor5mSettlement(lateRecordedOldTrade, 1200), true);
  assert.equal(isDecisionEligibleFor5mSettlement(futureTrade, 1200), false);
});

test("runCheck5m skips outside trigger window", async () => {
  seedEnv();
  const sentSignals = [];
  const result = await runCheck5m({
    deps: {
      nowSeconds: 1_234,
      resolveTriggerMarketStartTsImpl: () => null,
      ensureIndexesImpl: async () => {},
      sendSignalMessageImpl: async (_cfg, text) => {
        sentSignals.push(text);
      },
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "outside_trigger_window");
  assert.match(result.marketSlug, /^btc-updown-5m-/);
  assert.equal(result.signalMessageSent, true);
  assert.equal(sentSignals.length, 1);
  assert.match(sentSignals[0], /BTC 5m check skipped/);
});

test("runCheck5m assumes a successful paper fill when auto buy is disabled", async () => {
  seedEnv();
  process.env.AUTO_BUY_5M_ENABLED = "false";
  process.env.DRY_RUN_DEFAULT = "false";

  const insertedDecisions = [];
  const decisionUpdates = [];
  const tradeAlerts = [];
  const actionRecords = [];
  const result = await runCheck5m({
    deps: {
      nowSeconds: 1_440,
      now: new Date("2026-05-18T00:00:00Z"),
      ensureIndexesImpl: async () => {},
      resolveTriggerMarketStartTsImpl: () => 1_200,
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
      fetchMarketPriceImpl: async (tokenId) => (tokenId === "yes-token" ? 0.84 : 0.95),
      insertBotRunImpl: async () => {},
      sendSignalMessageImpl: async () => {},
      findDecisionImpl: async () => null,
      insertDecisionImpl: async (doc) => {
        insertedDecisions.push(doc);
      },
      updateDecisionImpl: async (payload) => {
        decisionUpdates.push(payload);
      },
      insertActionImpl: async (doc) => {
        actionRecords.push(doc);
      },
      sendTradeAlertImpl: async (_cfg, payload) => {
        tradeAlerts.push(payload);
        return { sent: true, error: null };
      },
      settleTradesImpl: async () => ({
        settled: [
          { marketSlug: "older", side: "YES", outcomeStatus: "win" },
        ],
        summary: {
          wins: 1,
          losses: 0,
          unresolved: 0,
          profitUsd: 0.8,
          lossUsd: 0,
          realizedPnlUsd: 0.8,
          unresolvedStakeUsd: 0,
          totalStakeUsd: 4.2,
          winRate: 1,
        },
      }),
      sendOutcomeSummaryImpl: async () => ({ sent: true, error: null }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(insertedDecisions.length, 2);
  assert.equal(result.yes.passes, true);
  assert.equal(result.no.passes, false);
  assert.equal(tradeAlerts.length, 1);
  assert.equal(tradeAlerts[0].side, "YES");
  assert.equal(tradeAlerts[0].dryRun, false);
  assert.equal(tradeAlerts[0].accepted, true);
  assert.equal(decisionUpdates.length, 2);
  assert.equal(actionRecords.length, 1);
  assert.equal(result.actions[0].side, "YES");
  assert.equal(result.actions[0].accepted, true);
  assert.equal(result.actions[0].bought, true);
  assert.equal(result.actions[0].assumedFill, true);
  assert.equal(result.outcomeSummary.wins, 1);
  assert.equal(result.outcomeSummary.realizedPnlUsd, 0.8);
});

test("runCheck5m settles previous trades after accepted buy", async () => {
  seedEnv();
  process.env.AUTO_BUY_5M_ENABLED = "true";
  process.env.DRY_RUN_DEFAULT = "false";

  const tradeAlerts = [];
  const result = await runCheck5m({
    deps: {
      nowSeconds: 1_440,
      now: new Date("2026-05-18T00:00:00Z"),
      ensureIndexesImpl: async () => {},
      resolveTriggerMarketStartTsImpl: () => 1_200,
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
      fetchMarketPriceImpl: async (tokenId) => (tokenId === "yes-token" ? 0.84 : 0.70),
      fetchBookImpl: async () => ({
        asks: [{ price: 0.84, size: 100 }],
        bestAsk: 0.84,
      }),
      submitOrderImpl: async () => ({
        success: true,
        orderID: "ord-1",
        status: "matched",
      }),
      insertBotRunImpl: async () => {},
      sendSignalMessageImpl: async () => {},
      findDecisionImpl: async () => null,
      insertDecisionImpl: async () => {},
      claimDecisionForBuyImpl: async () => ({ ok: true }),
      updateDecisionImpl: async () => {},
      insertActionImpl: async () => {},
      sendTradeAlertImpl: async (_cfg, payload) => {
        tradeAlerts.push(payload);
        return { sent: true, error: null };
      },
      settleTradesImpl: async () => ({
        settled: [
          { marketSlug: "older", side: "YES", outcomeStatus: "win" },
        ],
        summary: {
          wins: 1,
          losses: 0,
          unresolved: 0,
          profitUsd: 0.8,
          lossUsd: 0,
          realizedPnlUsd: 0.8,
          unresolvedStakeUsd: 0,
          totalStakeUsd: 4.2,
          winRate: 1,
        },
      }),
      sendOutcomeSummaryImpl: async () => ({ sent: true, error: null }),
    },
  });

  assert.equal(tradeAlerts.length, 1);
  assert.equal(tradeAlerts[0].accepted, true);
  assert.equal(result.actions[0].orderId, "ord-1");
  assert.equal(result.outcomeSummary.wins, 1);
  assert.equal(result.outcomeSummary.realizedPnlUsd, 0.8);
  assert.equal(result.outcomeSummary.settled.length, 1);
});
