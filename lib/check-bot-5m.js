import { getConfig, get5mTelegramConfig, STRATEGY_KEY_5M } from "./config.js";
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

const MIN_ENTRY_PRICE_EXCLUSIVE = 0.80;
const MAX_ENTRY_PRICE_EXCLUSIVE = 0.95;

function boolFromQuery(value, fallback) {
  if (value == null || value === "") return fallback;
  return value === "1" || String(value).toLowerCase() === "true";
}

function formatMaybeNumber(value, digits = 6) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return String(Number(value.toFixed(digits)));
}

export function is5mEntryPriceEligible(price) {
  return Number.isFinite(price) && price > MIN_ENTRY_PRICE_EXCLUSIVE && price < MAX_ENTRY_PRICE_EXCLUSIVE;
}

export function evaluate5mEntryPrice(price) {
  return buildPriceBandEvaluation(price);
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

function buildPriceBandEvaluation(price) {
  return {
    passes: is5mEntryPriceEligible(price),
    reason: price == null
      ? "missing_buy_price"
      : is5mEntryPriceEligible(price)
        ? "price_band_passed"
        : "price_outside_band",
    minExclusive: MIN_ENTRY_PRICE_EXCLUSIVE,
    maxExclusive: MAX_ENTRY_PRICE_EXCLUSIVE,
  };
}

export function buildSignalText(summary) {
  return [
    `<b>BTC 5m check</b>`,
    `market: ${summary.marketSlug}`,
    `trigger: ${summary.triggerUtc}`,
    `question: ${escapeTelegramHtml(summary.question)}`,
    `yes buy price: ${summary.yes.price ?? "n/a"}`,
    `no buy price: ${summary.no.price ?? "n/a"}`,
    `band: &gt;${MIN_ENTRY_PRICE_EXCLUSIVE} and &lt;${MAX_ENTRY_PRICE_EXCLUSIVE}`,
    `yes pass: ${summary.yes.passes}`,
    `no pass: ${summary.no.passes}`,
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
  return TRADE_SHARES;
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

export function summarize5mOutcomes(decisions) {
  const wins = decisions.filter((item) => item.outcome_status === "win");
  const losses = decisions.filter((item) => item.outcome_status === "loss");
  const unresolved = decisions.filter((item) => item.outcome_status == null || item.outcome_status === "unresolved");
  const profitUsd = wins.reduce((sum, item) => sum + realizedPnlUsdForDecision(item), 0);
  const lossUsd = losses.reduce((sum, item) => sum + Math.abs(realizedPnlUsdForDecision(item)), 0);
  const realizedPnlUsd = profitUsd - lossUsd;
  const unresolvedStakeUsd = unresolved.reduce((sum, item) => sum + stakeUsdForDecision(item), 0);
  const stakeUsd = decisions.reduce((sum, item) => sum + stakeUsdForDecision(item), 0);
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
    `<b>BTC 5m results today</b>`,
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

function buildSkippedSignalText({ marketSlug, marketStartUtc, triggerUtc, dryRun }) {
  return [
    `<b>BTC 5m check skipped</b>`,
    `reason: outside_trigger_window`,
    `market: ${marketSlug}`,
    `market_start: ${marketStartUtc}`,
    `trigger: ${triggerUtc}`,
    `dryRun: ${dryRun}`,
  ].join("\n");
}

function buildSummary({ market, triggerUtc, dryRun, yesPrice, noPrice }) {
  return {
    ok: true,
    strategyKey: STRATEGY_KEY_5M,
    marketSlug: market.slug,
    question: market.question,
    marketStartUtc: utcIso(market.startTs * 1000),
    triggerUtc,
    dryRun,
    yes: {
      tokenId: market.yesTokenId,
      price: yesPrice,
      passes: is5mEntryPriceEligible(yesPrice),
    },
    no: {
      tokenId: market.noTokenId,
      price: noPrice,
      passes: is5mEntryPriceEligible(noPrice),
    },
    actions: [],
  };
}

function buildDecisionDoc({
  market,
  side,
  triggerUtc,
  entryPrice,
  passes,
  dryRun,
  signalSent,
}) {
  return {
    strategy_key: STRATEGY_KEY_5M,
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
    model_probability: null,
    model_edge: null,
    model_support_n: null,
    model_source: "price_band",
    model_reason: passes ? "price_band_passed" : "price_outside_band",
    model_probability_field: null,
    model_min_probability: null,
    model_min_edge: null,
    model_min_support: null,
    buy_target_shares: TRADE_SHARES,
    passed: passes,
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
}) {
  const settlement = await settleTrades({
    now,
    marketStartTs,
    startingBankrollUsd,
  });
  if (settlement.settled.length > 0 || settlement.summary) {
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
    strategyKey: STRATEGY_KEY_5M,
  });
  const settled = [];
  for (const decision of unsettled.filter((item) => isDecisionEligibleFor5mSettlement(item, marketStartTs))) {
    const market = await fetchMarketBySlug(decision.market_slug);
    const winningSide = resolveWinningSideFromGammaMarket(market);
    if (!winningSide) {
      await updateDecision({
        marketSlug: decision.market_slug,
        side: decision.side,
        strategyKey: STRATEGY_KEY_5M,
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
      strategyKey: STRATEGY_KEY_5M,
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
    strategyKey: STRATEGY_KEY_5M,
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
  market,
  triggerUtc,
  dryRun,
  signalSent,
  side,
  tokenId,
  entryPrice,
  summary,
  fetchBook = fetchOrderBook,
  submitOrder = placeBuyOrder,
  settleTrades = settlePrevious5mTrades,
  findDecisionImpl = findDecisionByStrategy,
  insertDecisionImpl = insertDecision,
  claimDecisionForBuyImpl = claimDecisionForBuy,
  updateDecisionImpl = updateDecision,
  insertErrorLogImpl = insertErrorLog,
  insertActionImpl = insertAction,
  sendTradeAlertImpl = sendTradeAlert,
  sendOutcomeSummaryImpl = async (cfg, text) => safeTelegram(() => sendAction5mMessage(cfg, text)),
  now = new Date(),
}) {
  const evaluation = buildPriceBandEvaluation(entryPrice);
  const existingDecision = await findDecisionImpl({
    marketSlug: market.slug,
    side,
    strategyKey: STRATEGY_KEY_5M,
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
      passes: evaluation.passes,
      dryRun,
      signalSent,
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

  const baseAction = {
    side,
    displaySide: sideLabel(side),
    tokenId,
    price: entryPrice,
    maxPrice: entryPrice,
    shares: TRADE_SHARES,
    estimatedNotional: TRADE_SHARES * entryPrice,
    dryRun,
    bought: false,
    accepted: false,
  };

  if (dryRun) {
    const delivery = await sendTradeAlertImpl(telegramConfig, {
      title: "BTC 5m BUY preview",
      marketSlug: market.slug,
      question: market.question,
      side,
      tokenId,
      signalPrice: entryPrice,
      shares: TRADE_SHARES,
      estimatedNotional: TRADE_SHARES * entryPrice,
      maxBuyPrice: entryPrice,
      dryRun,
      accepted: false,
      orderId: null,
      orderStatus: "dry_run",
    });
    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M,
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
      strategyKey: STRATEGY_KEY_5M,
      set: {
        buy_attempted: true,
        buy_order_accepted: true,
        buy_order_id: null,
        buy_order_status: "assumed_filled_auto_buy_disabled",
        buy_completed: true,
        buy_partial_fill: false,
        buy_matched_shares: TRADE_SHARES,
        buy_in_progress: false,
        buy_retry_blocked: true,
        buy_error: null,
        assumed_fill: true,
      },
    });
    const delivery = await sendTradeAlertImpl(telegramConfig, {
      title: "BTC 5m BUY assumed filled",
      marketSlug: market.slug,
      question: market.question,
      side,
      tokenId,
      signalPrice: entryPrice,
      shares: TRADE_SHARES,
      estimatedNotional: TRADE_SHARES * entryPrice,
      maxBuyPrice: entryPrice,
      dryRun: false,
      accepted: true,
      orderId: null,
      orderStatus: "assumed_filled_auto_buy_disabled",
    });
    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M,
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
      matchedShares: TRADE_SHARES,
      assumedFill: true,
      orderStatus: "assumed_filled_auto_buy_disabled",
    };
    if (delivery.error) action.notificationWarning = delivery.error;
    await persistAction({
      strategy_key: STRATEGY_KEY_5M,
      market_slug: market.slug,
      side,
      created_at: now,
      trigger_utc: triggerUtc,
      side_price: entryPrice,
      order_result: {
        assumed_fill: true,
        status: "assumed_filled_auto_buy_disabled",
        matched_amount: TRADE_SHARES,
      },
      dry_run: false,
    }, action, insertActionImpl);
    summary.actions.push(action);
    await finalize5mOutcomeSummary({
      telegramConfig,
      summary,
      now,
      marketStartTs: market.startTs,
      startingBankrollUsd: config.bankroll5mStartUsd,
      settleTrades,
      sendOutcomeSummaryImpl,
    });
    return { boughtAccepted: true };
  }

  const claimed = await claimDecisionForBuyImpl({
    marketSlug: market.slug,
    side,
    strategyKey: STRATEGY_KEY_5M,
  });
  if (!claimed) {
    summary.actions.push(buildSkippedAction(side, "buy_already_claimed"));
    return { boughtAccepted: false };
  }

  try {
    const orderBook = await fetchBook(tokenId);
    const liquidity = summarizeBuyLiquidity(orderBook, entryPrice, TRADE_SHARES);
    if (!liquidity.canAttempt) {
      throw new Error(`no ask liquidity at or below ${formatMaybeNumber(entryPrice)}`);
    }
    const order = await submitOrder({
      tokenId,
      maxPrice: entryPrice,
      shares: TRADE_SHARES,
      market,
    });
    const result = interpretOrderResult(order);
    if (result.rejected || !result.accepted) {
      throw new Error(result.errorMessage || "Polymarket order was not successful");
    }

    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M,
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
      title: result.filled ? "BTC 5m BUY filled" : "BTC 5m BUY submitted",
      marketSlug: market.slug,
      question: market.question,
      side,
      tokenId,
      signalPrice: entryPrice,
      shares: TRADE_SHARES,
      estimatedNotional: TRADE_SHARES * entryPrice,
      maxBuyPrice: entryPrice,
      dryRun: false,
      accepted: true,
      orderId: result.orderId,
      orderStatus: result.orderStatus,
    });

    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M,
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
      strategy_key: STRATEGY_KEY_5M,
      market_slug: market.slug,
      side,
      created_at: now,
      trigger_utc: triggerUtc,
      side_price: entryPrice,
      order_result: order,
      dry_run: false,
    }, action, insertActionImpl);
    summary.actions.push(action);

    await finalize5mOutcomeSummary({
      telegramConfig,
      summary,
      now,
      marketStartTs: market.startTs,
      startingBankrollUsd: config.bankroll5mStartUsd,
      settleTrades,
      sendOutcomeSummaryImpl,
    });
    return { boughtAccepted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateDecisionImpl({
      marketSlug: market.slug,
      side,
      strategyKey: STRATEGY_KEY_5M,
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
      source: "buy_order_5m",
      market_slug: market.slug,
      side,
      message,
      side_price: entryPrice,
      trigger_utc: triggerUtc,
    });
    const delivery = await safeTelegram(() => sendAction5mMessage(
      telegramConfig,
      `<b>BTC 5m BUY failed</b>\nmarket: ${escapeTelegramHtml(market.slug)}\n${escapeTelegramHtml(message)}`,
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

export async function runCheck5m({ dryRunOverride, deps = {} } = {}) {
  const {
    nowSeconds = Math.floor(Date.now() / 1000),
    ensureIndexesImpl = ensureIndexes,
    fetchMarketByStartTsImpl = fetch5mMarketByStartTs,
    fetchMarketPriceImpl = fetchMarketPrice,
    fetchBookImpl = fetchOrderBook,
    submitOrderImpl = placeBuyOrder,
    settleTradesImpl = settlePrevious5mTrades,
    findDecisionImpl = findDecisionByStrategy,
    insertDecisionImpl = insertDecision,
    claimDecisionForBuyImpl = claimDecisionForBuy,
    updateDecisionImpl = updateDecision,
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
        source: "signal_telegram_5m",
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
  const summary = buildSummary({
    market,
    triggerUtc,
    dryRun,
    yesPrice,
    noPrice,
  });

  await insertBotRunImpl({
    created_at: now,
    market_slug: market.slug,
    dry_run: dryRun,
    strategy_key: STRATEGY_KEY_5M,
  });

  const signalDelivery = await safeTelegram(() => sendSignalMessageImpl(telegramConfig, buildSignalText(summary)));
  summary.signalMessageSent = signalDelivery.sent;
  if (signalDelivery.error) {
    summary.signalMessageError = signalDelivery.error;
    await insertErrorLogImpl({
      created_at: now,
      source: "signal_telegram_5m",
      market_slug: summary.marketSlug,
      message: signalDelivery.error,
    });
  }

  const sideInputs = [
    { side: "YES", tokenId: market.yesTokenId, entryPrice: yesPrice },
    { side: "NO", tokenId: market.noTokenId, entryPrice: noPrice },
  ];
  for (const sideInput of sideInputs) {
    await process5mSide({
      config,
      telegramConfig,
      market,
      triggerUtc,
      dryRun,
      signalSent: signalDelivery.sent,
      summary,
      now,
      fetchBook: fetchBookImpl,
      submitOrder: submitOrderImpl,
      settleTrades: settleTradesImpl,
      findDecisionImpl,
      insertDecisionImpl,
      claimDecisionForBuyImpl,
      updateDecisionImpl,
      insertErrorLogImpl,
      insertActionImpl,
      sendTradeAlertImpl,
      sendOutcomeSummaryImpl,
      ...sideInput,
    });
  }

  return summary;
}
