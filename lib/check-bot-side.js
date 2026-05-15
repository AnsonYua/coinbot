import {
  insertDecision,
  insertAction,
  updateDecision,
  claimDecisionForBuy,
  isDuplicateKeyError,
  findDecision,
  insertErrorLog,
} from "./mongo.js";
import { placeBuyOrder } from "./polymarket.js";
import { sendActionMessage, safeTelegram, escapeTelegramHtml } from "./telegram.js";
import { TRADE_SHARES } from "./time.js";

function buildSkippedAction(side, reason) {
  return {
    side,
    skipped: true,
    reason,
  };
}

function buildBaseAction({ side, price, dryRun, retrying = false }) {
  const action = {
    side,
    price,
    dryRun,
    bought: false,
  };
  if (retrying) {
    action.retrying = true;
  }
  return action;
}

function buildActionText(side, price, dryRun) {
  return [
    `<b>BTC 15m BUY ${side}</b>`,
    `price: ${price}`,
    `shares: ${TRADE_SHARES}`,
    `notional_usd: ${(TRADE_SHARES * price).toFixed(3)}`,
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
  const status = order?.status ? String(order.status) : "";
  const success = order?.success === true;
  const accepted = success || Boolean(orderId);
  const filled = accepted && isFilledOrderStatus(status);
  return {
    accepted,
    filled,
    orderId,
    orderStatus: status,
  };
}

function buildDecisionDoc({
  market,
  side,
  triggerUtc,
  entryPrice,
  bestBid,
  features,
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

async function notifyActionAndPersist(config, { marketSlug, side, entryPrice, dryRun }) {
  const delivery = await safeTelegram(() => sendActionMessage(config, buildActionText(side, entryPrice, dryRun)));
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

async function setDecisionBuyAccepted({ marketSlug, side, orderId, orderStatus, filled }) {
  await updateDecision({
    marketSlug,
    side,
    set: {
      buy_attempted: true,
      buy_order_accepted: true,
      buy_order_id: orderId,
      buy_order_status: orderStatus || null,
      buy_completed: filled,
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
  action,
  summary,
}) {
  const actionDelivery = await notifyActionAndPersist(config, {
    marketSlug,
    side,
    entryPrice,
    dryRun,
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

  const postClaimActionDelivery = await notifyActionAndPersist(config, {
    marketSlug: market.slug,
    side,
    entryPrice,
    dryRun: false,
  });
  appendActionWarning(action, postClaimActionDelivery.error);

  try {
    const order = await placeBuyOrder({
      tokenId,
      entryPrice,
      shares: TRADE_SHARES,
      market,
    });
    const { accepted, filled, orderId, orderStatus } = interpretOrderResult(order);
    if (!accepted) {
      throw new Error(order?.errorMsg || order?.error || "Polymarket order was not successful");
    }

    await setDecisionBuyAccepted({
      marketSlug: market.slug,
      side,
      orderId,
      orderStatus,
      filled,
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

    await safeTelegram(() => sendActionMessage(config, `<b>BUY ${side} placed</b>\nmarket: ${market.slug}`));
    return {
      side,
      price: entryPrice,
      dryRun: false,
      bought: filled,
      placed: true,
      orderId: orderId || undefined,
      orderStatus: orderStatus || undefined,
      order,
      retrying: retryFailedBuy,
      notificationWarning: postClaimActionDelivery.error || undefined,
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
    await safeTelegram(() => sendActionMessage(config, `<b>BUY ${side} failed</b>\n${escapeTelegramHtml(message)}`));
    return {
      side,
      price: entryPrice,
      dryRun: false,
      bought: false,
      error: message,
      retrying: retryFailedBuy,
      notificationWarning: postClaimActionDelivery.error || undefined,
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
  const { side, tokenId, entryPrice, passes, bestBid } = sideInput;
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
    retrying: retryFailedBuy,
  });

  if (dryRun || !config.autoBuyEnabled) {
    await handlePassiveAction({
      config,
      marketSlug: market.slug,
      side,
      entryPrice,
      dryRun,
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
