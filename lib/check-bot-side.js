import {
  insertDecision,
  insertAction,
  updateDecision,
  claimDecisionForBuy,
  isDuplicateKeyError,
  findDecision,
  insertErrorLog,
} from "./mongo.js";
import { fetchOrderBook, placeBuyOrder, summarizeBuyLiquidity } from "./polymarket.js";
import { sendActionMessage, safeTelegram, escapeTelegramHtml } from "./telegram.js";
import { TRADE_SHARES } from "./time.js";

function buildSkippedAction(side, reason) {
  return {
    side,
    skipped: true,
    reason,
  };
}

function formatMaybeNumber(value, digits = 6) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return String(Number(value.toFixed(digits)));
}

function buildBaseAction({ side, price, dryRun, evaluation, retrying = false }) {
  const maxPrice = evaluation?.probability != null && evaluation?.minEdge != null
    ? evaluation.probability - evaluation.minEdge
    : price;
  const action = {
    side,
    price,
    maxPrice,
    dryRun,
    bought: false,
    probability: evaluation?.probability ?? null,
    edge: evaluation?.edge ?? null,
    supportN: evaluation?.supportN ?? null,
    source: evaluation?.source ?? null,
  };
  if (retrying) {
    action.retrying = true;
  }
  return action;
}

function buildActionText({ marketSlug, side, price, dryRun, evaluation }) {
  const maxPrice = evaluation?.probability != null && evaluation?.minEdge != null
    ? evaluation.probability - evaluation.minEdge
    : null;
  return [
    `<b>BTC 15m BUY ${side}</b>`,
    `market: ${marketSlug}`,
    `signal_price: ${price}`,
    `max_buy_price: ${formatMaybeNumber(maxPrice)}`,
    `shares: ${TRADE_SHARES}`,
    `notional_usd: ${(TRADE_SHARES * price).toFixed(3)}`,
    `probability: ${formatMaybeNumber(evaluation?.probability)}`,
    `edge: ${formatMaybeNumber(evaluation?.edge)}`,
    `support_n: ${evaluation?.supportN ?? "n/a"}`,
    `source: ${evaluation?.source ?? "n/a"}`,
    `dryRun: ${dryRun}`,
  ].join("\n");
}

function appendActionWarning(action, warning) {
  if (warning) {
    action.notificationWarning = warning;
  }
}

async function logSideError({ source, marketSlug, side, message, extra = {} }) {
  await insertErrorLog({
    created_at: new Date(),
    source,
    market_slug: marketSlug,
    side,
    message,
    ...extra,
  });
}

function canRetryFailedBuy({ existingDecision, passes, entryPrice, dryRun, autoBuyEnabled }) {
  return (
    Boolean(existingDecision) &&
    passes &&
    entryPrice != null &&
    !dryRun &&
    autoBuyEnabled &&
    existingDecision.passed === true &&
    existingDecision.buy_order_accepted !== true &&
    existingDecision.buy_completed !== true &&
    existingDecision.buy_in_progress !== true &&
    existingDecision.buy_retry_blocked !== true
  );
}

function isFilledOrderStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return normalized === "filled" || normalized === "matched";
}

export function interpretOrderResult(order) {
  const orderId = order?.orderID || order?.orderId || order?.id || null;
  const status = order?.status != null ? String(order.status) : "";
  const success = order?.success === true;
  const rejected = (Number.isFinite(Number(status)) && Number(status) >= 400) || Boolean(order?.error);
  const accepted = !rejected && (success || Boolean(orderId));
  const filled = accepted && isFilledOrderStatus(status);
  const matchedShares = Number(order?.matched_amount || order?.takingAmount || 0) || null;
  const partial = accepted && !filled && matchedShares != null && matchedShares > 0;
  return {
    rejected,
    accepted,
    filled,
    partial,
    orderId,
    orderStatus: status,
    matchedShares,
    errorMessage: order?.errorMsg || order?.error || null,
  };
}

function buildDecisionDoc({
  market,
  side,
  triggerUtc,
  entryPrice,
  bestBid,
  features,
  evaluation,
  passes,
  dryRun,
  signalSent,
}) {
  return {
    market_slug: market.slug,
    side,
    created_at: new Date(),
    trigger_utc: triggerUtc,
    side_price: entryPrice,
    best_bid: bestBid,
    best_ask: entryPrice,
    btc_start: features.btcStart,
    btc_trigger_price: features.btcTriggerPrice,
    above_start_minutes: features.aboveStartMinutes,
    below_start_minutes: features.belowStartMinutes,
    ret_10m_to_trigger: features.ret10mToTrigger,
    model_probability: evaluation?.probability ?? null,
    model_edge: evaluation?.edge ?? null,
    model_support_n: evaluation?.supportN ?? null,
    model_source: evaluation?.source ?? null,
    model_reason: evaluation?.reason ?? null,
    model_probability_field: evaluation?.probabilityField ?? null,
    model_min_edge: evaluation?.minEdge ?? null,
    model_min_support: evaluation?.minSupport ?? null,
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
  };
}

async function notifyActionAndPersist(config, { marketSlug, side, entryPrice, dryRun, evaluation }) {
  const delivery = await safeTelegram(() => sendActionMessage(config, buildActionText({
    marketSlug,
    side,
    price: entryPrice,
    dryRun,
    evaluation,
  })));
  await updateDecision({
    marketSlug,
    side,
    set: {
      telegram_action_sent: delivery.sent,
    },
  });
  if (delivery.error) {
    await logSideError({
      source: "action_telegram",
      marketSlug,
      side,
      message: delivery.error,
      extra: { dry_run: dryRun, side_price: entryPrice },
    });
  }
  return delivery;
}

async function recordExecutionMessage({ marketSlug, side, sent, error, extra = {} }) {
  await updateDecision({
    marketSlug,
    side,
    set: {
      telegram_action_sent: sent,
      ...(error ? { telegram_action_error: error } : {}),
      ...extra,
    },
  });
}

async function persistActionRecord(doc, action) {
  try {
    await insertAction(doc);
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      action.persistWarning = message;
      await logSideError({
        source: "action_persist",
        marketSlug: doc.market_slug,
        side: doc.side,
        message,
      });
    }
  }
}

async function setDecisionBuyAccepted({ marketSlug, side, orderId, orderStatus, filled, partial, matchedShares }) {
  await updateDecision({
    marketSlug,
    side,
    set: {
      buy_attempted: true,
      buy_order_accepted: true,
      buy_order_id: orderId,
      buy_order_status: orderStatus || null,
      buy_completed: filled,
      buy_partial_fill: partial,
      buy_matched_shares: matchedShares,
      buy_in_progress: false,
      buy_retry_blocked: true,
      buy_error: null,
    },
  });
}

async function setDecisionBuyFailed({ marketSlug, side, message }) {
  await updateDecision({
    marketSlug,
    side,
    set: {
      buy_attempted: true,
      buy_order_accepted: false,
      buy_completed: false,
      buy_in_progress: false,
      buy_retry_blocked: true,
      buy_error: message,
    },
  });
}

async function persistNewDecision({
  market,
  side,
  triggerUtc,
  entryPrice,
  bestBid,
  features,
  evaluation,
  passes,
  dryRun,
  signalSent,
  summary,
}) {
  const decisionDoc = buildDecisionDoc({
    market,
    side,
    triggerUtc,
    entryPrice,
    bestBid,
    features,
    evaluation,
    passes,
    dryRun,
    signalSent,
  });
  try {
    await insertDecision(decisionDoc);
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      summary.actions.push(buildSkippedAction(side, "duplicate_decision_race"));
      return false;
    }
    throw error;
  }
}

async function handlePassiveAction({
  config,
  marketSlug,
  side,
  entryPrice,
  dryRun,
  evaluation,
  action,
  summary,
}) {
  const actionDelivery = await notifyActionAndPersist(config, {
    marketSlug,
    side,
    entryPrice,
    dryRun,
    evaluation,
  });
  appendActionWarning(action, actionDelivery.error);
  summary.actions.push(action);
}

async function handleLiveBuy({
  config,
  market,
  side,
  tokenId,
  entryPrice,
  triggerUtc,
  retryFailedBuy,
  action,
  summary,
}) {
  const claimResult = await claimDecisionForBuy({
    marketSlug: market.slug,
    side,
  });
  if (!claimResult) {
    summary.actions.push(buildSkippedAction(side, "buy_already_claimed"));
    return null;
  }

  try {
    const orderBook = await fetchOrderBook(tokenId);
    const liquidity = summarizeBuyLiquidity(orderBook, action.maxPrice, TRADE_SHARES);
    action.bestAsk = liquidity.bestAsk;
    action.availableShares = liquidity.availableShares;
    if (!liquidity.canAttempt) {
      throw new Error(`no ask liquidity at or below max buy price ${formatMaybeNumber(action.maxPrice)}`);
    }

    const order = await placeBuyOrder({
      tokenId,
      maxPrice: action.maxPrice,
      shares: TRADE_SHARES,
      market,
    });
    const { rejected, accepted, filled, partial, orderId, orderStatus, matchedShares, errorMessage } = interpretOrderResult(order);
    if (rejected || !accepted) {
      throw new Error(errorMessage || "Polymarket order was not successful");
    }

    await setDecisionBuyAccepted({
      marketSlug: market.slug,
      side,
      orderId,
      orderStatus,
      filled,
      partial,
      matchedShares,
    });

    await persistActionRecord({
      market_slug: market.slug,
      side,
      created_at: new Date(),
      trigger_utc: triggerUtc,
      side_price: entryPrice,
      order_result: order,
      dry_run: false,
    }, action);

    const headline = filled ? `BUY ${side} filled` : partial ? `BUY ${side} partially filled` : `BUY ${side} submitted`;
    const executionDelivery = await safeTelegram(() => sendActionMessage(config, [
      `<b>${headline}</b>`,
      `market: ${market.slug}`,
      `signal_price: ${entryPrice}`,
      `max_buy_price: ${formatMaybeNumber(action.maxPrice)}`,
      `best_ask: ${formatMaybeNumber(action.bestAsk)}`,
      `shares: ${TRADE_SHARES}`,
      `probability: ${formatMaybeNumber(action.probability)}`,
      `edge: ${formatMaybeNumber(action.edge)}`,
      `support_n: ${action.supportN ?? "n/a"}`,
      `source: ${action.source ?? "n/a"}`,
      `matched_shares: ${formatMaybeNumber(matchedShares)}`,
    ].join("\n")));
    appendActionWarning(action, executionDelivery.error);
    await recordExecutionMessage({
      marketSlug: market.slug,
      side,
      sent: executionDelivery.sent,
      error: executionDelivery.error,
    });
    return {
      side,
      price: entryPrice,
      dryRun: false,
      bought: filled,
      submitted: true,
      partial,
      orderId: orderId || undefined,
      orderStatus: orderStatus || undefined,
      matchedShares: matchedShares || undefined,
      order,
      retrying: retryFailedBuy,
      notificationWarning: executionDelivery.error || undefined,
      persistWarning: action.persistWarning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setDecisionBuyFailed({ marketSlug: market.slug, side, message });
    await logSideError({
      source: "buy_order",
      marketSlug: market.slug,
      side,
      message,
      extra: { side_price: entryPrice, trigger_utc: triggerUtc },
    });
    const failureDelivery = await safeTelegram(() => sendActionMessage(
      config,
      `<b>BUY ${side} failed</b>\nmarket: ${escapeTelegramHtml(market.slug)}\n${escapeTelegramHtml(message)}`,
    ));
    await recordExecutionMessage({
      marketSlug: market.slug,
      side,
      sent: failureDelivery.sent,
      error: failureDelivery.error,
    });
    return {
      side,
      price: entryPrice,
      dryRun: false,
      bought: false,
      error: message,
      retrying: retryFailedBuy,
      notificationWarning: failureDelivery.error || undefined,
    };
  }
}

function shouldSkipSide({ existingDecision, retryFailedBuy }) {
  return existingDecision && !retryFailedBuy;
}

async function processSide({
  config,
  market,
  triggerUtc,
  features,
  dryRun,
  signalSent,
  sideInput,
  summary,
}) {
  const { side, tokenId, entryPrice, passes, bestBid, evaluation } = sideInput;
  const existingDecision = await findDecision({
    marketSlug: market.slug,
    side,
  });
  const retryFailedBuy = canRetryFailedBuy({
    existingDecision,
    passes,
    entryPrice,
    dryRun,
    autoBuyEnabled: config.autoBuyEnabled,
  });

  if (shouldSkipSide({ existingDecision, retryFailedBuy })) {
    summary.actions.push(buildSkippedAction(side, "duplicate_decision"));
    return;
  }

  if (!existingDecision) {
    const inserted = await persistNewDecision({
      market,
      side,
      triggerUtc,
      entryPrice,
      bestBid,
      features,
      evaluation,
      passes,
      dryRun,
      signalSent,
      summary,
    });
    if (!inserted) return;
  }

  if (!passes || entryPrice == null) {
    summary.actions.push(buildSkippedAction(side, entryPrice == null ? "missing_buy_price" : "rule_failed"));
    return;
  }

  const action = buildBaseAction({
    side,
    price: entryPrice,
    dryRun,
    evaluation,
    retrying: retryFailedBuy,
  });

  if (dryRun || !config.autoBuyEnabled) {
    await handlePassiveAction({
      config,
      marketSlug: market.slug,
      side,
      entryPrice,
      dryRun,
      evaluation,
      action,
      summary,
    });
    return;
  }

  const liveAction = await handleLiveBuy({
    config,
    market,
    side,
    tokenId,
    entryPrice,
    triggerUtc,
    retryFailedBuy,
    action,
    summary,
  });
  if (liveAction) {
    summary.actions.push(liveAction);
  }
}

export async function processSides({
  config,
  market,
  triggerUtc,
  features,
  dryRun,
  signalSent,
  summary,
  sideInputs,
}) {
  for (const sideInput of sideInputs) {
    await processSide({
      config,
      market,
      triggerUtc,
      features,
      dryRun,
      signalSent,
      sideInput,
      summary,
    });
  }
}
