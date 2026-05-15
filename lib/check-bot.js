import { getConfig } from "./config.js";
import { fetchTriggerFeatures } from "./binance.js";
import {
  ensureIndexes,
  insertBotRun,
  updateDecisionsForMarket,
  insertErrorLog,
} from "./mongo.js";
import { fetchCurrentMarket, fetchMarketPrice } from "./polymarket.js";
import { processSides } from "./check-bot-side.js";
import { evaluateYesRule, evaluateNoRule } from "./rule.js";
import { sendSignalMessage, safeTelegram } from "./telegram.js";
import {
  TRIGGER_OFFSET_SECONDS,
  utcIso,
  isExactTriggerMinute,
} from "./time.js";

function boolFromQuery(value, fallback) {
  if (value == null || value === "") return fallback;
  return value === "1" || String(value).toLowerCase() === "true";
}

function buildSignalText(summary) {
  return [
    `<b>BTC 15m check</b>`,
    `market: ${summary.marketSlug}`,
    `trigger: ${summary.triggerUtc}`,
    `yes buy price: ${summary.yes.price ?? "n/a"}`,
    `no buy price: ${summary.no.price ?? "n/a"}`,
    `btc start: ${summary.features.btcStart}`,
    `btc trigger: ${summary.features.btcTriggerPrice}`,
    `above mins: ${summary.features.aboveStartMinutes}`,
    `below mins: ${summary.features.belowStartMinutes}`,
    `ret10->trigger: ${summary.features.ret10mToTrigger}`,
    `yes pass: ${summary.yes.passes}`,
    `no pass: ${summary.no.passes}`,
    `dryRun: ${summary.dryRun}`,
  ].join("\n");
}

function buildSideInputs({ market, yesPrice, yesPasses, noPrice, noPasses }) {
  return [
    { side: "YES", tokenId: market.yesTokenId, entryPrice: yesPrice, passes: yesPasses, bestBid: null },
    { side: "NO", tokenId: market.noTokenId, entryPrice: noPrice, passes: noPasses, bestBid: null },
  ];
}

function buildSummary({ market, triggerUtc, dryRun, features, yesPrice, noPrice, yesPasses, noPasses }) {
  return {
    ok: true,
    marketSlug: market.slug,
    question: market.question,
    marketStartUtc: utcIso(market.startTs * 1000),
    triggerUtc,
    dryRun,
    features: {
      btcStart: Number(features.btcStart.toFixed(2)),
      btcTriggerPrice: Number(features.btcTriggerPrice.toFixed(2)),
      aboveStartMinutes: features.aboveStartMinutes,
      belowStartMinutes: features.belowStartMinutes,
      ret10mToTrigger: Number(features.ret10mToTrigger.toFixed(6)),
    },
    yes: {
      tokenId: market.yesTokenId,
      price: yesPrice,
      passes: yesPasses,
    },
    no: {
      tokenId: market.noTokenId,
      price: noPrice,
      passes: noPasses,
    },
    actions: [],
  };
}

async function loadMarketState(marketStartTs, yesTokenId, noTokenId) {
  const features = await fetchTriggerFeatures(marketStartTs);
  const [yesPrice, noPrice] = await Promise.all([
    fetchMarketPrice(yesTokenId, "BUY"),
    fetchMarketPrice(noTokenId, "BUY"),
  ]);
  if (yesPrice == null && noPrice == null) {
    throw new Error("No executable buy price on either side");
  }

  const yesPasses = yesPrice != null ? evaluateYesRule({ yesPrice, features }) : false;
  const noPasses = noPrice != null ? evaluateNoRule({ noPrice, features }) : false;

  return {
    features,
    yesPrice,
    noPrice,
    yesPasses,
    noPasses,
  };
}

async function recordSignalDelivery(config, summary) {
  const signalDelivery = await safeTelegram(() => sendSignalMessage(config, buildSignalText(summary)));
  summary.signalMessageSent = signalDelivery.sent;
  if (signalDelivery.error) {
    summary.signalMessageError = signalDelivery.error;
    await insertErrorLog({
      created_at: new Date(),
      source: "signal_telegram",
      market_slug: summary.marketSlug,
      message: signalDelivery.error,
    });
  }
  return signalDelivery;
}

export async function runCheck({ dryRunOverride }) {
  const config = getConfig();
  const dryRun = boolFromQuery(dryRunOverride, config.dryRunDefault);
  await ensureIndexes();

  const market = await fetchCurrentMarket();
  const triggerUtc = utcIso((market.startTs + TRIGGER_OFFSET_SECONDS) * 1000);
  if (!isExactTriggerMinute(market.startTs)) {
    return {
      ok: true,
      skipped: true,
      reason: "outside_trigger_minute",
      marketSlug: market.slug,
      marketStartUtc: utcIso(market.startTs * 1000),
      triggerUtc,
      dryRun,
    };
  }

  const marketState = await loadMarketState(
    market.startTs,
    market.yesTokenId,
    market.noTokenId,
  );
  const summary = buildSummary({
    market,
    triggerUtc,
    dryRun,
    ...marketState,
  });

  await insertBotRun({
    created_at: new Date(),
    market_slug: market.slug,
    dry_run: dryRun,
  });

  const sideInputs = buildSideInputs({
    market,
    yesPrice: marketState.yesPrice,
    yesPasses: marketState.yesPasses,
    noPrice: marketState.noPrice,
    noPasses: marketState.noPasses,
  });
  await processSides({
    config,
    market,
    triggerUtc,
    features: marketState.features,
    dryRun,
    signalSent: false,
    summary,
    sideInputs,
  });

  const signalDelivery = await recordSignalDelivery(config, summary);
  await updateDecisionsForMarket({
    marketSlug: market.slug,
    set: {
      telegram_signal_sent: signalDelivery.sent,
    },
  });

  return summary;
}
