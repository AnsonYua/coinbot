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

function buildActionText(side, price, dryRun) {
  return [
    `<b>BTC 15m BUY ${side}</b>`,
    `price: ${price}`,
    `stake_usd: ${TRADE_STAKE_USD}`,
    `dryRun: ${dryRun}`,
  ].join("\n");
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

function canRetryFailedBuy({ existingDecision, passes, entryPrice, dryRun, autoBuyEnabled }) {
  return (
    Boolean(existingDecision) &&
    passes &&
    entryPrice != null &&
    !dryRun &&
    autoBuyEnabled &&
    existingDecision.passed === true &&
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
      summary.actions.push({
        side,
        skipped: true,
        reason: "duplicate_decision_race",
      });
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
    summary.actions.push({
      side,
      skipped: true,
      reason: "buy_already_claimed",
    });
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
    });
    await updateDecision({
      marketSlug: market.slug,
      side,
      strategyVersion,
      set: {
        buy_attempted: true,
        buy_completed: true,
        buy_in_progress: false,
        buy_retry_blocked: false,
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
      bought: true,
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
        buy_completed: false,
        buy_in_progress: true,
        buy_retry_blocked: true,
        buy_error: message,
      },
    });
    await safeNotify(() => sendActionMessage(config, `<b>BUY ${side} failed</b>\n${message}`));
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
    summary.actions.push({
      side,
      skipped: true,
      reason: "duplicate_decision",
    });
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
    summary.actions.push({
      side,
      skipped: true,
      reason: entryPrice == null ? "missing_best_ask" : "rule_failed",
    });
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

  const features = await fetchTriggerFeatures(market.startTs);
  const [yesBook, noBook] = await Promise.all([
    fetchOrderBook(market.yesTokenId),
    fetchOrderBook(market.noTokenId),
  ]);

  const yesPrice = yesBook.bestAsk;
  const noPrice = noBook.bestAsk;
  if (yesPrice == null && noPrice == null) {
    throw new Error("No executable best ask on either side");
  }

  const yesPasses = yesPrice != null ? evaluateYesRule({ yesPrice, features }) : false;
  const noPasses = noPrice != null ? evaluateNoRule({ noPrice, features }) : false;

  const summary = {
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

  await insertBotRun({
    created_at: new Date(),
    market_slug: market.slug,
    dry_run: dryRun,
    strategy_version: strategyVersion,
    force_market_slug: forceMarketSlug || null,
  });

  const signalDelivery = await safeNotify(() => sendSignalMessage(config, buildSignalText(summary)));
  summary.signalMessageSent = signalDelivery.sent;
  if (signalDelivery.error) {
    summary.signalMessageError = signalDelivery.error;
  }

  const sideInputs = buildSideInputs({
    market,
    yesPrice,
    yesPasses,
    yesBook,
    noPrice,
    noPasses,
    noBook,
  });

  for (const sideInput of sideInputs) {
    await processSide({
      config,
      market,
      triggerUtc,
      strategyVersion,
      features,
      dryRun,
      signalSent: signalDelivery.sent,
      sideInput,
      summary,
    });
  }

  return summary;
}
