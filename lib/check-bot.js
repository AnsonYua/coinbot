import { getConfig } from "./config.js";
import { fetchTriggerFeatures } from "./binance.js";
import {
  ensureIndexes,
  insertBotRun,
  updateDecisionsForMarket,
  insertErrorLog,
} from "./mongo.js";
import { fetchCurrentMarket, fetchMarketByStartTs, fetchMarketPrice } from "./polymarket.js";
import { processSides } from "./check-bot-side.js";
import { evaluateProbabilitySide } from "./probability-map.js";
import { sendSignalMessage, safeTelegram } from "./telegram.js";
import {
  TRIGGER_OFFSET_SECONDS,
  utcIso,
  resolveTriggerMarketStartTs,
} from "./time.js";

function boolFromQuery(value, fallback) {
  if (value == null || value === "") return fallback;
  return value === "1" || String(value).toLowerCase() === "true";
}

function formatMaybeNumber(value, digits = 6) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return String(Number(value.toFixed(digits)));
}

function buildModelLine(label, sideSummary) {
  return `${label}: p=${formatMaybeNumber(sideSummary.probability)} edge=${formatMaybeNumber(sideSummary.edge)} n=${sideSummary.supportN ?? "n/a"} src=${sideSummary.source ?? "n/a"} reason=${sideSummary.reason ?? "n/a"} pass=${sideSummary.passes}`;
}

function buildSignalText(summary) {
  return [
    `<b>BTC 15m check</b>`,
    `market: ${summary.marketSlug}`,
    `trigger: ${summary.triggerUtc}`,
    `question: ${summary.question}`,
    `yes buy price: ${summary.yes.price ?? "n/a"}`,
    `no buy price: ${summary.no.price ?? "n/a"}`,
    `btc start: ${summary.features.btcStart}`,
    `btc trigger: ${summary.features.btcTriggerPrice}`,
    `above mins: ${summary.features.aboveStartMinutes}`,
    `below mins: ${summary.features.belowStartMinutes}`,
    `ret10->trigger: ${summary.features.ret10mToTrigger}`,
    buildModelLine("YES", summary.yes),
    buildModelLine("NO", summary.no),
    `dryRun: ${summary.dryRun}`,
  ].join("\n");
}

function buildSideInputs({ market, yesPrice, yesEvaluation, noPrice, noEvaluation }) {
  return [
    {
      side: "YES",
      tokenId: market.yesTokenId,
      entryPrice: yesPrice,
      passes: yesEvaluation.passes,
      evaluation: yesEvaluation,
      bestBid: null,
    },
    {
      side: "NO",
      tokenId: market.noTokenId,
      entryPrice: noPrice,
      passes: noEvaluation.passes,
      evaluation: noEvaluation,
      bestBid: null,
    },
  ];
}

function buildSummary({ market, triggerUtc, dryRun, features, yesPrice, noPrice, yesEvaluation, noEvaluation }) {
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
      passes: yesEvaluation.passes,
      probability: yesEvaluation.probability != null ? Number(yesEvaluation.probability.toFixed(6)) : null,
      edge: yesEvaluation.edge != null ? Number(yesEvaluation.edge.toFixed(6)) : null,
      supportN: yesEvaluation.supportN ?? null,
      source: yesEvaluation.source ?? null,
      reason: yesEvaluation.reason ?? null,
    },
    no: {
      tokenId: market.noTokenId,
      price: noPrice,
      passes: noEvaluation.passes,
      probability: noEvaluation.probability != null ? Number(noEvaluation.probability.toFixed(6)) : null,
      edge: noEvaluation.edge != null ? Number(noEvaluation.edge.toFixed(6)) : null,
      supportN: noEvaluation.supportN ?? null,
      source: noEvaluation.source ?? null,
      reason: noEvaluation.reason ?? null,
    },
    actions: [],
  };
}

async function loadMarketState(config, marketStartTs, yesTokenId, noTokenId) {
  const features = await fetchTriggerFeatures(marketStartTs);
  const [yesPrice, noPrice] = await Promise.all([
    fetchMarketPrice(yesTokenId, "BUY"),
    fetchMarketPrice(noTokenId, "BUY"),
  ]);
  if (yesPrice == null && noPrice == null) {
    throw new Error("No executable buy price on either side");
  }

  const evaluateSide = (side, entryPrice) => evaluateProbabilitySide({
    side,
    entryPrice,
    features,
    mapPath: config.probabilityMapPath,
    minEdge: config.minModelEdge,
    minProbability: config.minModelProbability,
    minSupport: config.minProbabilitySupport,
    probabilityField: config.probabilityField,
  });

  const [yesEvaluation, noEvaluation] = await Promise.all([
    evaluateSide("YES", yesPrice),
    evaluateSide("NO", noPrice),
  ]);

  return {
    features,
    yesPrice,
    noPrice,
    yesEvaluation,
    noEvaluation,
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

  const resolvedMarketStartTs = resolveTriggerMarketStartTs();
  if (resolvedMarketStartTs == null) {
    const market = await fetchCurrentMarket();
    const triggerUtc = utcIso((market.startTs + TRIGGER_OFFSET_SECONDS) * 1000);
    return {
      ok: true,
      skipped: true,
      reason: "outside_trigger_window",
      marketSlug: market.slug,
      marketStartUtc: utcIso(market.startTs * 1000),
      triggerUtc,
      dryRun,
    };
  }
  const market = await fetchMarketByStartTs(resolvedMarketStartTs);
  const triggerUtc = utcIso((market.startTs + TRIGGER_OFFSET_SECONDS) * 1000);

  const marketState = await loadMarketState(
    config,
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

  const signalDelivery = await recordSignalDelivery(config, summary);

  const sideInputs = buildSideInputs({
    market,
    yesPrice: marketState.yesPrice,
    yesEvaluation: marketState.yesEvaluation,
    noPrice: marketState.noPrice,
    noEvaluation: marketState.noEvaluation,
  });
  await processSides({
    config,
    market,
    triggerUtc,
    features: marketState.features,
    dryRun,
    signalSent: signalDelivery.sent,
    summary,
    sideInputs,
  });
  await updateDecisionsForMarket({
    marketSlug: market.slug,
    set: {
      telegram_signal_sent: signalDelivery.sent,
    },
  });

  return summary;
}
