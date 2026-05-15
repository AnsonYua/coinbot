import { getConfig } from "./config.js";
import { fetchTriggerFeatures } from "./binance.js";
import {
  ensureIndexes,
  insertBotRun,
  findDecision,
  insertDecision,
  insertAction,
  updateDecision,
  claimDecisionForBuy,
  isDuplicateKeyError,
} from "./mongo.js";
import { fetchCurrentMarket, fetchOrderBook, placeBuyOrder } from "./polymarket.js";
import { evaluateYesRule, evaluateNoRule } from "./rule.js";
import { sendSignalMessage, sendActionMessage } from "./telegram.js";
import {
  TRADE_STAKE_USD,
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
    `yes ask: ${summary.yes.bestAsk ?? "n/a"}`,
    `no ask: ${summary.no.bestAsk ?? "n/a"}`,
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

function buildSkippedAction(side, reason) {
  return {
    side,
    skipped: true,
    reason,
  };
}

function buildActionText(side, price, dryRun) {
  return [
    `<b>BTC 15m BUY ${side}</b>`,
    `price: ${price}`,
    `stake_usd: ${TRADE_STAKE_USD}`,
    `dryRun: ${dryRun}`,
  ].join("\n");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function safeNotify(sendFn) {
  try {
    await sendFn();
    return { sent: true, error: null };
  } catch (error) {
    return {
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

function buildSideInputs({ market, yesPrice, yesPasses, yesBook, noPrice, noPasses, noBook }) {
  return [
    { side: "YES", tokenId: market.yesTokenId, entryPrice: yesPrice, passes: yesPasses, bestBid: yesBook.bestBid },
    { side: "NO", tokenId: market.noTokenId, entryPrice: noPrice, passes: noPasses, bestBid: noBook.bestBid },
  ];
}

function buildSummary({ market, triggerUtc, dryRun, features, yesBook, noBook, yesPrice, noPrice, yesPasses, noPasses }) {
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
      bestAsk: yesPrice,
      bestBid: yesBook.bestBid,
      passes: yesPasses,
    },
    no: {
      tokenId: market.noTokenId,
      bestAsk: noPrice,
      bestBid: noBook.bestBid,
      passes: noPasses,
    },
    actions: [],
  };
}

async function loadMarketState(marketStartTs, yesTokenId, noTokenId) {
  const features = await fetchTriggerFeatures(marketStartTs);
  const [yesBook, noBook] = await Promise.all([
    fetchOrderBook(yesTokenId),
    fetchOrderBook(noTokenId),
  ]);

  const yesPrice = yesBook.bestAsk;
  const noPrice = noBook.bestAsk;
  if (yesPrice == null && noPrice == null) {
    throw new Error("No executable best ask on either side");
  }

  const yesPasses = yesPrice != null ? evaluateYesRule({ yesPrice, features }) : false;
  const noPasses = noPrice != null ? evaluateNoRule({ noPrice, features }) : false;

  return {
    features,
    yesBook,
    noBook,
    yesPrice,
    noPrice,
    yesPasses,
    noPasses,
  };
}

async function recordSignalDelivery(config, summary) {
  const signalDelivery = await safeNotify(() => sendSignalMessage(config, buildSignalText(summary)));
  summary.signalMessageSent = signalDelivery.sent;
  if (signalDelivery.error) {
    summary.signalMessageError = signalDelivery.error;
  }
  return signalDelivery;
}

function buildDecisionDoc({
  market,
  side,
  strategyVersion,
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
    strategy_version: strategyVersion,
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

async function notifyActionAndPersist(config, { marketSlug, side, strategyVersion, entryPrice, dryRun }) {
  const delivery = await safeNotify(() => sendActionMessage(config, buildActionText(side, entryPrice, dryRun)));
  await updateDecision({
    marketSlug,
    side,
    strategyVersion,
    set: {
      telegram_action_sent: delivery.sent,
    },
  });
  return delivery;
}

async function persistNewDecision({
  market,
  side,
  strategyVersion,
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
    strategyVersion,
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

async function handleLiveBuy({
  config,
  market,
  side,
  tokenId,
  entryPrice,
  triggerUtc,
  strategyVersion,
  retryFailedBuy,
  action,
  summary,
}) {
  const claimResult = await claimDecisionForBuy({
    marketSlug: market.slug,
    side,
    strategyVersion,
  });
  if (!claimResult) {
    summary.actions.push(buildSkippedAction(side, "buy_already_claimed"));
    return null;
  }

  const postClaimActionDelivery = await notifyActionAndPersist(config, {
    marketSlug: market.slug,
    side,
    strategyVersion,
    entryPrice,
    dryRun: false,
  });
  if (postClaimActionDelivery.error) {
    action.notificationWarning = postClaimActionDelivery.error;
  }

  try {
    const order = await placeBuyOrder({
      tokenId,
      entryPrice,
      stakeUsd: TRADE_STAKE_USD,
      market,
    });
    const { accepted, filled, orderId, orderStatus } = interpretOrderResult(order);
    if (!accepted) {
      throw new Error(order?.errorMsg || order?.error || "Polymarket order was not successful");
    }
    await updateDecision({
      marketSlug: market.slug,
      side,
      strategyVersion,
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

    const actionDoc = {
      market_slug: market.slug,
      side,
      strategy_version: strategyVersion,
      created_at: new Date(),
      trigger_utc: triggerUtc,
      side_price: entryPrice,
      order_result: order,
      dry_run: false,
    };
    try {
      await insertAction(actionDoc);
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        action.persistWarning = error instanceof Error ? error.message : String(error);
      }
    }

    await safeNotify(() => sendActionMessage(config, `<b>BUY ${side} placed</b>\nmarket: ${market.slug}`));
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
    await updateDecision({
      marketSlug: market.slug,
      side,
      strategyVersion,
      set: {
        buy_attempted: true,
        buy_order_accepted: false,
        buy_completed: false,
        buy_in_progress: false,
        buy_retry_blocked: true,
        buy_error: message,
      },
    });
    await safeNotify(() => sendActionMessage(config, `<b>BUY ${side} failed</b>\n${escapeHtml(message)}`));
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

async function processSide({
  config,
  market,
  triggerUtc,
  strategyVersion,
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
    strategyVersion,
  });
  const retryFailedBuy = canRetryFailedBuy({
    existingDecision,
    passes,
    entryPrice,
    dryRun,
    autoBuyEnabled: config.autoBuyEnabled,
  });

  if (existingDecision && !retryFailedBuy) {
    summary.actions.push(buildSkippedAction(side, "duplicate_decision"));
    return;
  }

  if (!existingDecision) {
    const inserted = await persistNewDecision({
      market,
      side,
      strategyVersion,
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
    summary.actions.push(buildSkippedAction(side, entryPrice == null ? "missing_best_ask" : "rule_failed"));
    return;
  }

  const action = {
    side,
    price: entryPrice,
    dryRun,
    bought: false,
  };
  if (retryFailedBuy) {
    action.retrying = true;
  }

  if (dryRun || !config.autoBuyEnabled) {
    const actionDelivery = await notifyActionAndPersist(config, {
      marketSlug: market.slug,
      side,
      strategyVersion,
      entryPrice,
      dryRun,
    });
    if (actionDelivery.error) {
      action.notificationWarning = actionDelivery.error;
    }
    summary.actions.push(action);
    return;
  }

  const liveAction = await handleLiveBuy({
    config,
    market,
    side,
    tokenId,
    entryPrice,
    triggerUtc,
    strategyVersion,
    retryFailedBuy,
    action,
    summary,
  });
  if (liveAction) {
    summary.actions.push(liveAction);
  }
}

async function processSides({
  config,
  market,
  triggerUtc,
  strategyVersion,
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
      strategyVersion,
      features,
      dryRun,
      signalSent,
      sideInput,
      summary,
    });
  }
}

export async function runCheck({ dryRunOverride, forceMarketSlug }) {
  const config = getConfig();
  const dryRun = boolFromQuery(dryRunOverride, config.dryRunDefault);
  const strategyVersion = forceMarketSlug
    ? `${config.strategyVersion}-debug`
    : config.strategyVersion;
  await ensureIndexes();

  if (forceMarketSlug && !dryRun) {
    return {
      ok: true,
      skipped: true,
      reason: "force_market_slug_requires_dry_run",
      dryRun,
      forceMarketSlug,
    };
  }

  const market = await fetchCurrentMarket(forceMarketSlug);
  const triggerUtc = utcIso((market.startTs + TRIGGER_OFFSET_SECONDS) * 1000);
  if (!forceMarketSlug && !isExactTriggerMinute(market.startTs)) {
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
    strategy_version: strategyVersion,
    force_market_slug: forceMarketSlug || null,
  });

  const signalDelivery = await recordSignalDelivery(config, summary);

  const sideInputs = buildSideInputs({
    market,
    yesPrice: marketState.yesPrice,
    yesPasses: marketState.yesPasses,
    yesBook: marketState.yesBook,
    noPrice: marketState.noPrice,
    noPasses: marketState.noPasses,
    noBook: marketState.noBook,
  });
  await processSides({
    config,
    market,
    triggerUtc,
    strategyVersion,
    features: marketState.features,
    dryRun,
    signalSent: signalDelivery.sent,
    summary,
    sideInputs,
  });

  return summary;
}
