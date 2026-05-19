import { getConfig, get5mTelegramConfig, STRATEGY_KEY_5M_V2 } from "./config.js";
import {
  claimDecisionForBuy,
  ensureIndexes,
  findDecisionByStrategy,
  findUnsettledAcceptedDecisions,
  insertAction,
  insertBotRun,
  insertDecision,
  insertErrorLog,
  isDuplicateKeyError,
  listDecisionsForDay,
  updateDecision,
} from "./mongo.js";
import {
  fetch5mMarketByStartTs,
  fetchGammaMarketBySlug,
  fetchMarketPrice,
  fetchOrderBook,
  placeBuyOrder,
  resolveWinningSideFromGammaMarket,
  summarizeBuyLiquidity,
} from "./polymarket.js";
import { interpretOrderResult } from "./check-bot-side.js";
import { fetch5mTaTriggerFeatures } from "./binance.js";
import {
  active5mMarketSlug,
  active5mMarketStartTs,
  hktDayBounds,
  resolve5mTriggerMarketStartTs,
  TRADE_SHARES,
  trigger5mTs,
  utcIso,
} from "./time.js";
import {
  escapeTelegramHtml,
  safeTelegram,
  sendAction5mMessage,
  sendSignal5mMessage,
} from "./telegram.js";
import {
  build5mTaFeatures,
  evaluate5mTaSide,
  load5mTaProbabilityMap,
  TA_5M_MAX_ENTRY_PRICE,
  TA_5M_MIN_CONSERVATIVE_EDGE,
  TA_5M_MIN_ENTRY_PRICE,
  TA_5M_MIN_SUPPORT,
  TA_5M_MODEL_SOURCE,
} from "./ta-5m-probability.js";

function boolFromQuery(value, fallback) {
  if (value == null || value === "") return fallback;
  return value === "1" || String(value).toLowerCase() === "true";
}

function formatMaybeNumber(value, digits = 6) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return String(Number(value.toFixed(digits)));
}

export const KELLY_5M_V2_FRACTION = 0.1;
export const KELLY_5M_V2_MIN_SHARES = TRADE_SHARES;

export function is5mEntryPriceEligible(price) {
  return Number.isFinite(price) && price >= TA_5M_MIN_ENTRY_PRICE && price <= TA_5M_MAX_ENTRY_PRICE;
}

export function evaluate5mV2EntryPrice(price, side, btcFeatures, mapPayload) {
  return build5mEvaluation(price, side, btcFeatures, mapPayload);
}

function sideLabel(side) {
  return side === "YES" ? "UP" : "DOWN";
}

function buildSkippedAction(side, reason) {
  return {
    side,
    displaySide: sideLabel(side),
    skipped: true,
    reason,
  };
}

function build5mEvaluation(price, side, btcFeatures, mapPayload) {
  if (!mapPayload) {
    return {
      side,
      passes: false,
      reason: "missing_probability_map",
    };
  }
  return evaluate5mTaSide({
    side,
    entryPrice: price,
    features: btcFeatures,
    mapPayload,
  });
}

function sideSummaryFor(summary, side) {
  return side === "YES" ? summary.yes : summary.no;
}

export function select5mV2TradeSide(summary) {
  const candidates = ["YES", "NO"]
    .map((side) => ({ side, data: sideSummaryFor(summary, side) }))
    .filter(({ data }) => data?.passes);
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const edgeDiff = Number(right.data.conservativeEdge ?? -Infinity) - Number(left.data.conservativeEdge ?? -Infinity);
    if (edgeDiff !== 0) return edgeDiff;
    const probabilityDiff = Number(right.data.conservativeProbability ?? -Infinity) - Number(left.data.conservativeProbability ?? -Infinity);
    if (probabilityDiff !== 0) return probabilityDiff;
    return Number(left.data.price ?? Infinity) - Number(right.data.price ?? Infinity);
  });
  return candidates[0].side;
}

export function buildSignalText(summary) {
  return [
    `<b>BTC 5m V2 TA check</b>`,
    `market: ${summary.marketSlug}`,
    `trigger: ${summary.triggerUtc}`,
    `question: ${escapeTelegramHtml(summary.question)}`,
    `yes buy price: ${summary.yes.price ?? "n/a"}`,
    `no buy price: ${summary.no.price ?? "n/a"}`,
    `price band: ${TA_5M_MIN_ENTRY_PRICE} to ${TA_5M_MAX_ENTRY_PRICE}`,
    `min conservative edge: ${formatMaybeNumber(TA_5M_MIN_CONSERVATIVE_EDGE, 3)}`,
    `min support: ${TA_5M_MIN_SUPPORT}`,
    `btc start: ${formatMaybeNumber(summary.btc?.btcStart, 2)}`,
    `btc trigger: ${formatMaybeNumber(summary.btc?.btcTriggerPrice, 2)}`,
    `btc distance: ${formatMaybeNumber(summary.btc?.btcDistance == null ? null : summary.btc.btcDistance * 100, 3)}%`,
    `btc momentum 60s: ${formatMaybeNumber(summary.btc?.btcMomentum60 == null ? null : summary.btc.btcMomentum60 * 100, 3)}%`,
    `btc rsi14: ${formatMaybeNumber(summary.btc?.btcRsi14, 2)}`,
    `btc ema trend: ${formatMaybeNumber(summary.btc?.btcEmaTrend == null ? null : summary.btc.btcEmaTrend * 100, 4)}%`,
    `btc bollinger z20: ${formatMaybeNumber(summary.btc?.btcBollingerZ20, 3)}`,
    `btc volume 1m: ${formatMaybeNumber(summary.btc?.btcVolume1m, 2)}`,
    `btc volume 1m ratio: ${formatMaybeNumber(summary.btc?.btcVolume1mRatio, 3)}`,
    `btc volume 4m: ${formatMaybeNumber(summary.btc?.btcVolume4m, 2)}`,
    `btc volume 4m ratio: ${formatMaybeNumber(summary.btc?.btcVolume4mRatio, 3)}`,
    ...(summary.btcFeatureError ? [`btc feature error: ${escapeTelegramHtml(summary.btcFeatureError)}`] : []),
    `yes pass: ${summary.yes.passes}`,
    `yes reason: ${summary.yes.reason}`,
    `yes probability: ${formatMaybeNumber(summary.yes.probability, 4)}`,
    `yes conservative probability: ${formatMaybeNumber(summary.yes.conservativeProbability, 4)}`,
    `yes conservative edge: ${formatMaybeNumber(summary.yes.conservativeEdge, 4)}`,
    `yes support: ${summary.yes.supportN ?? "n/a"}`,
    `no pass: ${summary.no.passes}`,
    `no reason: ${summary.no.reason}`,
    `no probability: ${formatMaybeNumber(summary.no.probability, 4)}`,
    `no conservative probability: ${formatMaybeNumber(summary.no.conservativeProbability, 4)}`,
    `no conservative edge: ${formatMaybeNumber(summary.no.conservativeEdge, 4)}`,
    `no support: ${summary.no.supportN ?? "n/a"}`,
    `selected side: ${summary.selectedTradeSide ?? "none"}`,
    `dryRun: ${summary.dryRun}`,
  ].join("\n");
}

export function build5mTradeAlertText({
  title,
  marketSlug,
  question,
  side,
  tokenId,
  signalPrice,
  shares,
  estimatedNotional,
  sizing,
  maxBuyPrice,
  dryRun,
  accepted,
  orderId,
  orderStatus,
}) {
  return [
    `<b>${title}</b>`,
    `market: ${marketSlug}`,
    `question: ${escapeTelegramHtml(question)}`,
    `side: ${sideLabel(side)} (${side})`,
    `token_id: ${tokenId}`,
    `signal_price: ${formatMaybeNumber(signalPrice)}`,
    `shares: ${shares}`,
    `estimated_notional_usd: ${formatMaybeNumber(estimatedNotional, 3)}`,
    ...(sizing ? [
      `kelly_bankroll_usd: ${formatMaybeNumber(sizing.bankrollUsd, 3)}`,
      `kelly_full: ${formatMaybeNumber(sizing.fullKellyFraction * 100, 2)}%`,
      `kelly_used: ${formatMaybeNumber(sizing.usedKellyFraction * 100, 2)}%`,
      `kelly_raw_shares: ${formatMaybeNumber(sizing.rawShares, 6)}`,
      `kelly_min_5_shares_applied: ${sizing.minSharesApplied}`,
    ] : []),
    `max_buy_price: ${formatMaybeNumber(maxBuyPrice)}`,
    `order_accepted: ${accepted}`,
    `order_id: ${orderId || "n/a"}`,
    `order_status: ${orderStatus || "n/a"}`,
    `dryRun: ${dryRun}`,
  ].join("\n");
}

function matchedSharesForDecision(decision) {
  const matched = Number(decision?.buy_matched_shares);
  if (Number.isFinite(matched) && matched > 0) return matched;
  const target = Number(decision?.buy_target_shares);
  if (Number.isFinite(target) && target > 0) return target;
  return 0;
}

function stakeUsdForDecision(decision) {
  const shares = matchedSharesForDecision(decision);
  const price = Number(decision?.side_price);
  if (!Number.isFinite(price) || price < 0) {
    return 0;
  }
  return shares * price;
}

function realizedPnlUsdForDecision(decision) {
  const shares = matchedSharesForDecision(decision);
  const stake = stakeUsdForDecision(decision);
  if (decision?.outcome_status === "win") {
    return shares - stake;
  }
  if (decision?.outcome_status === "loss") {
    return -stake;
  }
  return 0;
}

function formatMoney(value) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return value.toFixed(3);
}

function roundMoney(value) {
  return Number(value.toFixed(6));
}

function roundShares(value) {
  return Number(value.toFixed(6));
}

function isAccepted5mPosition(decision) {
  return Boolean(
    decision?.buy_order_accepted ||
    decision?.buy_completed ||
    decision?.buy_partial_fill ||
    Number(decision?.buy_matched_shares) > 0 ||
    decision?.assumed_fill,
  );
}

export function calculate5mV2KellySizing({
  entryPrice,
  conservativeProbability,
  bankrollUsd,
  kellyFraction = KELLY_5M_V2_FRACTION,
  minShares = KELLY_5M_V2_MIN_SHARES,
}) {
  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    entryPrice >= 1 ||
    !Number.isFinite(conservativeProbability) ||
    conservativeProbability <= 0 ||
    !Number.isFinite(bankrollUsd) ||
    bankrollUsd <= 0
  ) {
    return {
      bankrollUsd: Number.isFinite(bankrollUsd) ? roundMoney(Math.max(0, bankrollUsd)) : 0,
      fullKellyFraction: 0,
      kellyFraction,
      usedKellyFraction: 0,
      stakeUsd: 0,
      shares: 0,
      rawStakeUsd: 0,
      rawShares: 0,
      minShares,
      minSharesApplied: false,
    };
  }

  const fullKellyFraction = Math.max(0, (conservativeProbability - entryPrice) / (1 - entryPrice));
  const usedKellyFraction = Math.max(0, fullKellyFraction * kellyFraction);
  const rawStakeUsd = bankrollUsd * usedKellyFraction;
  const rawShares = rawStakeUsd / entryPrice;
  const minSharesApplied = Number.isFinite(minShares) && minShares > 0 && rawShares > 0 && rawShares < minShares;
  const shares = minSharesApplied ? minShares : rawShares;
  const stakeUsd = shares * entryPrice;
  return {
    bankrollUsd: roundMoney(bankrollUsd),
    fullKellyFraction: roundMoney(fullKellyFraction),
    kellyFraction,
    usedKellyFraction: roundMoney(usedKellyFraction),
    rawStakeUsd: roundMoney(rawStakeUsd),
    rawShares: roundShares(rawShares),
    minShares,
    minSharesApplied,
    stakeUsd: roundMoney(stakeUsd),
    shares: roundShares(shares),
  };
}

export function summarize5mOutcomes(decisions) {
  const accepted = decisions.filter(isAccepted5mPosition);
  const wins = accepted.filter((item) => item.outcome_status === "win");
  const losses = accepted.filter((item) => item.outcome_status === "loss");
  const unresolved = accepted.filter((item) => item.outcome_status == null || item.outcome_status === "unresolved");
  const profitUsd = wins.reduce((sum, item) => sum + realizedPnlUsdForDecision(item), 0);
  const lossUsd = losses.reduce((sum, item) => sum + Math.abs(realizedPnlUsdForDecision(item)), 0);
  const realizedPnlUsd = profitUsd - lossUsd;
  const unresolvedStakeUsd = unresolved.reduce((sum, item) => sum + stakeUsdForDecision(item), 0);
  const stakeUsd = accepted.reduce((sum, item) => sum + stakeUsdForDecision(item), 0);
  const denominator = wins.length + losses.length;
  return {
    wins: wins.length,
    losses: losses.length,
    unresolved: unresolved.length,
    profitUsd: roundMoney(profitUsd),
    lossUsd: roundMoney(lossUsd),
    realizedPnlUsd: roundMoney(realizedPnlUsd),
    totalRealizedPnlUsd: roundMoney(realizedPnlUsd),
    unresolvedStakeUsd: roundMoney(unresolvedStakeUsd),
    stakeUsd: roundMoney(stakeUsd),
    totalStakeUsd: roundMoney(stakeUsd),
    winRate: denominator > 0 ? wins.length / denominator : null,
  };
}

export function extractMarketStartTsFromSlug(slug) {
  const value = Number(String(slug || "").split("-").at(-1));
  return Number.isFinite(value) ? value : null;
}

export function isDecisionEligibleFor5mSettlement(decision, currentMarketStartTs) {
  const decisionMarketStartTs = Number.isFinite(Number(decision?.market_start_ts))
    ? Number(decision.market_start_ts)
    : extractMarketStartTsFromSlug(decision?.market_slug);
  return decisionMarketStartTs != null && decisionMarketStartTs < currentMarketStartTs;
}

export function build5mOutcomeSummaryText({ summary }) {
  const roiText = summary.roi == null ? "n/a" : `${(summary.roi * 100).toFixed(2)}%`;
  const lines = [
    `<b>BTC 5m V2 results today</b>`,
    `remaining_bankroll_usd: ${formatMoney(summary.remainingBankrollUsd)}`,
    `stake_usd: ${formatMoney(summary.stakeUsd)}`,
    `unresolved_stake_usd: ${formatMoney(summary.unresolvedStakeUsd)}`,
    `total_realized_pnl_usd: ${formatMoney(summary.totalRealizedPnlUsd)}`,
    `total_win_usd: ${formatMoney(summary.profitUsd)}`,
    `total_loss_usd: ${formatMoney(summary.lossUsd)}`,
    `win_count: ${summary.wins}`,
    `loss_count: ${summary.losses}`,
    `roi: ${roiText}`,
  ];
  return lines.join("\n");
}

function with5mBankrollSummary(summary, startingBankrollUsd) {
  const remainingBankrollUsd = startingBankrollUsd + summary.realizedPnlUsd - summary.unresolvedStakeUsd;
  return {
    ...summary,
    remainingBankrollUsd: roundMoney(remainingBankrollUsd),
    roi: summary.stakeUsd > 0 ? roundMoney(summary.realizedPnlUsd / summary.stakeUsd) : null,
  };
}

async function resolve5mV2BankrollUsd({
  now,
  startingBankrollUsd,
  listDecisionsForDayImpl = listDecisionsForDay,
}) {
  const { start, end } = hktDayBounds(now);
  const todaysTrades = await listDecisionsForDayImpl({
    strategyKey: STRATEGY_KEY_5M_V2,
    start,
    end,
  });
  return with5mBankrollSummary(summarize5mOutcomes(todaysTrades), startingBankrollUsd).remainingBankrollUsd;
}

function buildSkippedSignalText({ marketSlug, marketStartUtc, triggerUtc, dryRun }) {
  return [
    `<b>BTC 5m V2 TA check skipped</b>`,
    `reason: outside_trigger_window`,
    `market: ${marketSlug}`,
    `market_start: ${marketStartUtc}`,
    `trigger: ${triggerUtc}`,
    `dryRun: ${dryRun}`,
  ].join("\n");
}

function buildSummary({ market, triggerUtc, dryRun, yesPrice, noPrice, btcFeatures, btcFeatureError, mapPayload }) {
  const yesEvaluation = build5mEvaluation(yesPrice, "YES", btcFeatures, mapPayload);
  const noEvaluation = build5mEvaluation(noPrice, "NO", btcFeatures, mapPayload);
  return {
    ok: true,
    strategyKey: STRATEGY_KEY_5M_V2,
    marketSlug: market.slug,
    question: market.question,
    marketStartUtc: utcIso(market.startTs * 1000),
    triggerUtc,
    dryRun,
    btc: btcFeatures,
    btcFeatureError,
    yes: {
      tokenId: market.yesTokenId,
      price: yesPrice,
      passes: yesEvaluation.passes,
      reason: yesEvaluation.reason,
      probability: yesEvaluation.probability,
      conservativeProbability: yesEvaluation.conservativeProbability,
      edge: yesEvaluation.edge,
      conservativeEdge: yesEvaluation.conservativeEdge,
      supportN: yesEvaluation.supportN,
      bucket: yesEvaluation.bucket,
      bucketSource: yesEvaluation.bucketSource,
    },
    no: {
      tokenId: market.noTokenId,
      price: noPrice,
      passes: noEvaluation.passes,
      reason: noEvaluation.reason,
      probability: noEvaluation.probability,
      conservativeProbability: noEvaluation.conservativeProbability,
      edge: noEvaluation.edge,
      conservativeEdge: noEvaluation.conservativeEdge,
      supportN: noEvaluation.supportN,
      bucket: noEvaluation.bucket,
      bucketSource: noEvaluation.bucketSource,
    },
    actions: [],
  };
}

function buildDecisionDoc({
  market,
  side,
  triggerUtc,
  entryPrice,
  evaluation,
  btcFeatures,
  dryRun,
  signalSent,
  sizing,
  selectedForTrade,
}) {
  return {
    strategy_key: STRATEGY_KEY_5M_V2,
    timeframe_minutes: 5,
    market_slug: market.slug,
    market_start_ts: market.startTs,
    market_question: market.question,
    side,
    created_at: new Date(),
    trigger_utc: triggerUtc,
    side_price: entryPrice,
    best_bid: null,
    best_ask: entryPrice,
    model_probability: evaluation.probability ?? null,
    model_conservative_probability: evaluation.conservativeProbability ?? null,
    model_edge: evaluation.edge ?? null,
    model_conservative_edge: evaluation.conservativeEdge ?? null,
    model_support_n: evaluation.supportN ?? null,
    model_bucket: evaluation.bucket ?? null,
    model_bucket_source: evaluation.bucketSource ?? null,
    model_source: TA_5M_MODEL_SOURCE,
    model_reason: evaluation.reason,
    model_probability_field: null,
    model_min_probability: null,
    model_min_edge: TA_5M_MIN_CONSERVATIVE_EDGE,
    model_min_support: TA_5M_MIN_SUPPORT,
    btc_start_price: btcFeatures?.btcStart ?? null,
    btc_trigger_price: btcFeatures?.btcTriggerPrice ?? null,
    btc_distance: btcFeatures?.btcDistance ?? null,
    btc_momentum_60: btcFeatures?.btcMomentum60 ?? null,
    btc_rsi_14: btcFeatures?.btcRsi14 ?? null,
    btc_ema_trend: btcFeatures?.btcEmaTrend ?? null,
    btc_bollinger_z20: btcFeatures?.btcBollingerZ20 ?? null,
    btc_volume_1m: btcFeatures?.btcVolume1m ?? null,
    btc_volume_1m_ratio: btcFeatures?.btcVolume1mRatio ?? null,
    btc_volume_4m: btcFeatures?.btcVolume4m ?? null,
    btc_volume_4m_ratio: btcFeatures?.btcVolume4mRatio ?? null,
    min_entry_price: TA_5M_MIN_ENTRY_PRICE,
    max_entry_price: TA_5M_MAX_ENTRY_PRICE,
    min_conservative_edge: TA_5M_MIN_CONSERVATIVE_EDGE,
    min_support: TA_5M_MIN_SUPPORT,
    sizing_method: "kelly_1_10",
    kelly_bankroll_usd: sizing?.bankrollUsd ?? null,
    kelly_full_fraction: sizing?.fullKellyFraction ?? null,
    kelly_fraction: sizing?.kellyFraction ?? KELLY_5M_V2_FRACTION,
    kelly_used_fraction: sizing?.usedKellyFraction ?? null,
    kelly_raw_notional_usd: sizing?.rawStakeUsd ?? null,
    kelly_raw_shares: sizing?.rawShares ?? null,
    kelly_min_shares: sizing?.minShares ?? KELLY_5M_V2_MIN_SHARES,
    kelly_min_shares_applied: sizing?.minSharesApplied ?? false,
    buy_target_notional_usd: sizing?.stakeUsd ?? null,
    buy_target_shares: sizing?.shares ?? 0,
    selected_for_trade: selectedForTrade,
    passed: evaluation.passes && selectedForTrade,
    dry_run: dryRun,
    telegram_signal_sent: signalSent,
    telegram_action_sent: false,
    buy_attempted: false,
    buy_order_accepted: false,
    buy_order_id: null,
    buy_order_status: null,
    buy_completed: false,
    buy_in_progress: false,
    buy_retry_blocked: false,
    buy_error: null,
    outcome_status: null,
    winning_side: null,
    resolved_at: null,
  };
}

async function sendTradeAlert(telegramConfig, payload) {
  return safeTelegram(() => sendAction5mMessage(telegramConfig, build5mTradeAlertText(payload)));
}

async function persistAction(actionDoc, summaryAction, insertActionImpl = insertAction) {
  try {
    await insertActionImpl(actionDoc);
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      summaryAction.persistWarning = message;
    }
  }
}

async function finalize5mOutcomeSummary({
  telegramConfig,
  summary,
  now,
  marketStartTs,
  startingBankrollUsd,
  settleTrades,
  sendOutcomeSummaryImpl,
  forceSummary = false,
}) {
  const settlement = await settleTrades({
    now,
    marketStartTs,
    startingBankrollUsd,
  });
  if (settlement.settled.length > 0 || (forceSummary && settlement.summary)) {
    const outcomeDelivery = await sendOutcomeSummaryImpl(
      telegramConfig,
      build5mOutcomeSummaryText(settlement),
    );
    summary.outcomeSummary = {
      ...settlement.summary,
      settled: settlement.settled,
      sent: outcomeDelivery.sent,
      error: outcomeDelivery.error,
    };
  }
}

async function settlePrevious5mTrades({
  now,
  marketStartTs,
  startingBankrollUsd = 30,
  fetchMarketBySlug = fetchGammaMarketBySlug,
}) {
  const unsettled = await findUnsettledAcceptedDecisions({
    strategyKey: STRATEGY_KEY_5M_V2,
  });
  const settled = [];
  for (const decision of unsettled.filter((item) => isDecisionEligibleFor5mSettlement(item, marketStartTs))) {
    const market = await fetchMarketBySlug(decision.market_slug);
    const winningSide = resolveWinningSideFromGammaMarket(market);
    if (!winningSide) {
      await updateDecision({
        marketSlug: decision.market_slug,
        side: decision.side,
        strategyKey: STRATEGY_KEY_5M_V2,
        set: {
          outcome_status: "unresolved",
        },
      });
      continue;
    }
    const outcomeStatus = decision.side === winningSide ? "win" : "loss";
    await updateDecision({
      marketSlug: decision.market_slug,
      side: decision.side,
      strategyKey: STRATEGY_KEY_5M_V2,
      set: {
        outcome_status: outcomeStatus,
        winning_side: winningSide,
        resolved_at: now,
      },
    });
    settled.push({
      marketSlug: decision.market_slug,
      side: decision.side,
      outcomeStatus,
      winningSide,
    });
  }

  const { start, end } = hktDayBounds(now);
  const todaysTrades = await listDecisionsForDay({
    strategyKey: STRATEGY_KEY_5M_V2,
    start,
    end,
  });
  return {
    settled,
    summary: with5mBankrollSummary(summarize5mOutcomes(todaysTrades), startingBankrollUsd),
  };
}

async function process5mSide({
  config,
  telegramConfig,
  bankrollUsd,
  market,
  triggerUtc,
  dryRun,
  signalSent,
  side,
  tokenId,
  entryPrice,
  btcFeatures,
  mapPayload,
  summary,
  selectedForTrade = true,
  fetchBook = fetchOrderBook,
  submitOrder = placeBuyOrder,
  findDecisionImpl = findDecisionByStrategy,
  insertDecisionImpl = insertDecision,
  claimDecisionForBuyImpl = claimDecisionForBuy,
  updateDecisionImpl = updateDecision,
  insertErrorLogImpl = insertErrorLog,
  insertActionImpl = insertAction,
  sendTradeAlertImpl = sendTradeAlert,
  now = new Date(),
}) {
  const evaluation = build5mEvaluation(entryPrice, side, btcFeatures, mapPayload);
  const sizing = calculate5mV2KellySizing({
    entryPrice,
    conservativeProbability: evaluation.conservativeProbability,
    bankrollUsd,
  });
  const existingDecision = await findDecisionImpl({
    marketSlug: market.slug,
    side,
    strategyKey: STRATEGY_KEY_5M_V2,
  });
  if (existingDecision) {
    summary.actions.push(buildSkippedAction(side, "duplicate_decision"));
    return { boughtAccepted: false };
  }

  try {
    await insertDecisionImpl(buildDecisionDoc({
      market,
      side,
      triggerUtc,
      entryPrice,
      evaluation,
      btcFeatures,
      dryRun,
      signalSent,
      sizing,
      selectedForTrade,
    }));
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      summary.actions.push(buildSkippedAction(side, "duplicate_decision_race"));
      return { boughtAccepted: false };
    }
    throw error;
  }

  if (!evaluation.passes) {
    summary.actions.push(buildSkippedAction(side, evaluation.reason));
    return { boughtAccepted: false };
  }

  if (!selectedForTrade) {
    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M_V2,
      set: {
        buy_retry_blocked: true,
        buy_error: "not_best_side",
      },
    });
    summary.actions.push(buildSkippedAction(side, "not_best_side"));
    return { boughtAccepted: false };
  }

  if (!(sizing.shares > 0)) {
    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M_V2,
      set: {
        buy_retry_blocked: true,
        buy_error: "kelly_size_zero",
      },
    });
    summary.actions.push(buildSkippedAction(side, "kelly_size_zero"));
    return { boughtAccepted: false };
  }

  const baseAction = {
    side,
    displaySide: sideLabel(side),
    tokenId,
    price: entryPrice,
    maxPrice: entryPrice,
    shares: sizing.shares,
    estimatedNotional: sizing.stakeUsd,
    sizing,
    dryRun,
    bought: false,
    accepted: false,
  };

  if (dryRun) {
    const delivery = await sendTradeAlertImpl(telegramConfig, {
      title: "BTC 5m V2 BUY preview",
      marketSlug: market.slug,
      question: market.question,
      side,
      tokenId,
      signalPrice: entryPrice,
      shares: sizing.shares,
      estimatedNotional: sizing.stakeUsd,
      sizing,
      maxBuyPrice: entryPrice,
      dryRun,
      accepted: false,
      orderId: null,
      orderStatus: "dry_run",
    });
    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M_V2,
      set: {
        telegram_action_sent: delivery.sent,
        telegram_action_error: delivery.error || null,
      },
    });
    if (delivery.error) baseAction.notificationWarning = delivery.error;
    summary.actions.push(baseAction);
    return { boughtAccepted: false };
  }

  if (!config.autoBuy5mEnabled) {
    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M_V2,
      set: {
        buy_attempted: true,
        buy_order_accepted: true,
        buy_order_id: null,
        buy_order_status: "assumed_filled_auto_buy_disabled",
        buy_completed: true,
        buy_partial_fill: false,
        buy_matched_shares: sizing.shares,
        buy_in_progress: false,
        buy_retry_blocked: true,
        buy_error: null,
        assumed_fill: true,
      },
    });
    const delivery = await sendTradeAlertImpl(telegramConfig, {
      title: "BTC 5m V2 BUY assumed filled",
      marketSlug: market.slug,
      question: market.question,
      side,
      tokenId,
      signalPrice: entryPrice,
      shares: sizing.shares,
      estimatedNotional: sizing.stakeUsd,
      sizing,
      maxBuyPrice: entryPrice,
      dryRun: false,
      accepted: true,
      orderId: null,
      orderStatus: "assumed_filled_auto_buy_disabled",
    });
    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M_V2,
      set: {
        telegram_action_sent: delivery.sent,
        telegram_action_error: delivery.error || null,
      },
    });
    const action = {
      ...baseAction,
      dryRun: false,
      bought: true,
      accepted: true,
      submitted: true,
      matchedShares: sizing.shares,
      assumedFill: true,
      orderStatus: "assumed_filled_auto_buy_disabled",
    };
    if (delivery.error) action.notificationWarning = delivery.error;
    await persistAction({
      strategy_key: STRATEGY_KEY_5M_V2,
      market_slug: market.slug,
      side,
      created_at: now,
      trigger_utc: triggerUtc,
      side_price: entryPrice,
      order_result: {
        assumed_fill: true,
        status: "assumed_filled_auto_buy_disabled",
        matched_amount: sizing.shares,
      },
      dry_run: false,
    }, action, insertActionImpl);
    summary.actions.push(action);
    return { boughtAccepted: true, stakeUsd: sizing.stakeUsd };
  }

  const claimed = await claimDecisionForBuyImpl({
    marketSlug: market.slug,
    side,
    strategyKey: STRATEGY_KEY_5M_V2,
  });
  if (!claimed) {
    summary.actions.push(buildSkippedAction(side, "buy_already_claimed"));
    return { boughtAccepted: false };
  }

  try {
    if (market.orderMinSize && sizing.shares < market.orderMinSize) {
      throw new Error(`Kelly buy size ${sizing.shares} is below market minimum ${market.orderMinSize}`);
    }
    const orderBook = await fetchBook(tokenId);
    const liquidity = summarizeBuyLiquidity(orderBook, entryPrice, sizing.shares);
    if (!liquidity.canFullyFill) {
      throw new Error(
        `not enough ask liquidity at or below ${formatMaybeNumber(entryPrice)}: ` +
        `${formatMaybeNumber(liquidity.availableShares, 3)} available, need ${sizing.shares}`,
      );
    }
    const order = await submitOrder({
      tokenId,
      maxPrice: entryPrice,
      shares: sizing.shares,
      market,
    });
    const result = interpretOrderResult(order);
    if (result.rejected || !result.accepted) {
      throw new Error(result.errorMessage || "Polymarket order was not successful");
    }

    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M_V2,
      set: {
        buy_attempted: true,
        buy_order_accepted: true,
        buy_order_id: result.orderId,
        buy_order_status: result.orderStatus || null,
        buy_completed: result.filled,
        buy_partial_fill: result.partial,
        buy_matched_shares: result.matchedShares,
        buy_in_progress: false,
        buy_retry_blocked: true,
        buy_error: null,
      },
    });

    const delivery = await sendTradeAlertImpl(telegramConfig, {
      title: result.filled ? "BTC 5m V2 BUY filled" : "BTC 5m V2 BUY submitted",
      marketSlug: market.slug,
      question: market.question,
      side,
      tokenId,
      signalPrice: entryPrice,
      shares: sizing.shares,
      estimatedNotional: sizing.stakeUsd,
      sizing,
      maxBuyPrice: entryPrice,
      dryRun: false,
      accepted: true,
      orderId: result.orderId,
      orderStatus: result.orderStatus,
    });

    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M_V2,
      set: {
        telegram_action_sent: delivery.sent,
        telegram_action_error: delivery.error || null,
      },
    });

    const action = {
      ...baseAction,
      dryRun: false,
      bought: result.filled,
      accepted: true,
      submitted: true,
      orderId: result.orderId || undefined,
      orderStatus: result.orderStatus || undefined,
      matchedShares: result.matchedShares || undefined,
    };
    if (delivery.error) action.notificationWarning = delivery.error;
    await persistAction({
      strategy_key: STRATEGY_KEY_5M_V2,
      market_slug: market.slug,
      side,
      created_at: now,
      trigger_utc: triggerUtc,
      side_price: entryPrice,
      order_result: order,
      dry_run: false,
    }, action, insertActionImpl);
    summary.actions.push(action);
    return { boughtAccepted: true, stakeUsd: sizing.stakeUsd };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M_V2,
      set: {
        buy_attempted: true,
        buy_order_accepted: false,
        buy_completed: false,
        buy_in_progress: false,
        buy_retry_blocked: true,
        buy_error: message,
      },
    });
    await insertErrorLogImpl({
      created_at: now,
      source: "buy_order_5m_v2",
      market_slug: market.slug,
      side,
      message,
      side_price: entryPrice,
      trigger_utc: triggerUtc,
    });
    const delivery = await safeTelegram(() => sendAction5mMessage(
      telegramConfig,
      `<b>BTC 5m V2 BUY failed</b>\nmarket: ${escapeTelegramHtml(market.slug)}\n${escapeTelegramHtml(message)}`,
    ));
    summary.actions.push({
      ...baseAction,
      dryRun: false,
      error: message,
      notificationWarning: delivery.error || undefined,
    });
    return { boughtAccepted: false };
  }
}

export async function runCheck5mV2({ dryRunOverride, deps = {} } = {}) {
  const {
    nowSeconds = Math.floor(Date.now() / 1000),
    ensureIndexesImpl = ensureIndexes,
    fetchMarketByStartTsImpl = fetch5mMarketByStartTs,
    fetchMarketPriceImpl = fetchMarketPrice,
    fetch5mTaTriggerFeaturesImpl = fetch5mTaTriggerFeatures,
    load5mTaProbabilityMapImpl = load5mTaProbabilityMap,
    fetchBookImpl = fetchOrderBook,
    submitOrderImpl = placeBuyOrder,
    settleTradesImpl = settlePrevious5mTrades,
    findDecisionImpl = findDecisionByStrategy,
    insertDecisionImpl = insertDecision,
    claimDecisionForBuyImpl = claimDecisionForBuy,
    updateDecisionImpl = updateDecision,
    listDecisionsForDayImpl = listDecisionsForDay,
    insertErrorLogImpl = insertErrorLog,
    insertActionImpl = insertAction,
    sendTradeAlertImpl = sendTradeAlert,
    sendOutcomeSummaryImpl = async (cfg, text) => safeTelegram(() => sendAction5mMessage(cfg, text)),
    resolveTriggerMarketStartTsImpl = resolve5mTriggerMarketStartTs,
    insertBotRunImpl = insertBotRun,
    sendSignalMessageImpl = sendSignal5mMessage,
    now = new Date(),
  } = deps;

  const config = getConfig();
  const telegramConfig = get5mTelegramConfig(config);
  const dryRun = boolFromQuery(dryRunOverride, config.dryRunDefault);
  await ensureIndexesImpl();
  const mapPayload = await load5mTaProbabilityMapImpl(config.ta5mProbabilityMapPath);

  const resolvedMarketStartTs = resolveTriggerMarketStartTsImpl(nowSeconds);
  if (resolvedMarketStartTs == null) {
    const marketStartTs = active5mMarketStartTs(nowSeconds);
    const skipped = {
      ok: true,
      skipped: true,
      reason: "outside_trigger_window",
      marketSlug: active5mMarketSlug(nowSeconds),
      marketStartUtc: utcIso(marketStartTs * 1000),
      triggerUtc: utcIso(trigger5mTs(marketStartTs) * 1000),
      dryRun,
    };
    const signalDelivery = await safeTelegram(() => sendSignalMessageImpl(
      telegramConfig,
      buildSkippedSignalText(skipped),
    ));
    skipped.signalMessageSent = signalDelivery.sent;
    if (signalDelivery.error) {
      skipped.signalMessageError = signalDelivery.error;
      await insertErrorLogImpl({
        created_at: now,
        source: "signal_telegram_5m_v2",
        market_slug: skipped.marketSlug,
        message: signalDelivery.error,
      });
    }
    return skipped;
  }

  const market = await fetchMarketByStartTsImpl(resolvedMarketStartTs);
  const triggerUtc = utcIso(trigger5mTs(market.startTs) * 1000);
  const [yesPrice, noPrice] = await Promise.all([
    fetchMarketPriceImpl(market.yesTokenId, "BUY"),
    fetchMarketPriceImpl(market.noTokenId, "BUY"),
  ]);
  let btcFeatures = null;
  let btcFeatureError = null;
  try {
    const fetchedFeatures = await fetch5mTaTriggerFeaturesImpl(market.startTs);
    btcFeatures = fetchedFeatures?.btcStart
      ? fetchedFeatures
      : build5mTaFeatures(fetchedFeatures?.rawCandles ?? fetchedFeatures);
  } catch (error) {
    btcFeatureError = error instanceof Error ? error.message : String(error);
    await insertErrorLogImpl({
      created_at: now,
      source: "binance_features_5m_v2",
      market_slug: market.slug,
      message: btcFeatureError,
      trigger_utc: triggerUtc,
    });
  }
  const summary = buildSummary({
    market,
    triggerUtc,
    dryRun,
    yesPrice,
    noPrice,
    btcFeatures,
    btcFeatureError,
    mapPayload,
  });
  summary.selectedTradeSide = select5mV2TradeSide(summary);

  await insertBotRunImpl({
    created_at: now,
    market_slug: market.slug,
    dry_run: dryRun,
    strategy_key: STRATEGY_KEY_5M_V2,
  });

  const signalDelivery = await safeTelegram(() => sendSignalMessageImpl(telegramConfig, buildSignalText(summary)));
  summary.signalMessageSent = signalDelivery.sent;
  if (signalDelivery.error) {
    summary.signalMessageError = signalDelivery.error;
    await insertErrorLogImpl({
      created_at: now,
      source: "signal_telegram_5m_v2",
      market_slug: summary.marketSlug,
      message: signalDelivery.error,
    });
  }

  const sideInputs = [
    { side: "YES", tokenId: market.yesTokenId, entryPrice: yesPrice },
    { side: "NO", tokenId: market.noTokenId, entryPrice: noPrice },
  ];
  let remainingBankrollUsd = await resolve5mV2BankrollUsd({
    now,
    startingBankrollUsd: config.bankroll5mStartUsd,
    listDecisionsForDayImpl,
  });
  let boughtAccepted = false;
  for (const sideInput of sideInputs) {
    const sideResult = await process5mSide({
      config,
      telegramConfig,
      bankrollUsd: remainingBankrollUsd,
      market,
      triggerUtc,
      dryRun,
      signalSent: signalDelivery.sent,
      btcFeatures,
      mapPayload,
      summary,
      selectedForTrade: sideInput.side === summary.selectedTradeSide,
      now,
      fetchBook: fetchBookImpl,
      submitOrder: submitOrderImpl,
      findDecisionImpl,
      insertDecisionImpl,
      claimDecisionForBuyImpl,
      updateDecisionImpl,
      insertErrorLogImpl,
      insertActionImpl,
      sendTradeAlertImpl,
      ...sideInput,
    });
    boughtAccepted = boughtAccepted || sideResult.boughtAccepted;
    if (sideResult.boughtAccepted && Number.isFinite(sideResult.stakeUsd)) {
      remainingBankrollUsd = roundMoney(Math.max(0, remainingBankrollUsd - sideResult.stakeUsd));
    }
  }

  await finalize5mOutcomeSummary({
    telegramConfig,
    summary,
    now,
    marketStartTs: market.startTs,
    startingBankrollUsd: config.bankroll5mStartUsd,
    settleTrades: settleTradesImpl,
    sendOutcomeSummaryImpl,
    forceSummary: boughtAccepted,
  });

  return summary;
}
