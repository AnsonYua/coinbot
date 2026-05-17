export const MARKET_SECONDS = 900;
export const TRIGGER_OFFSET_SECONDS = 13 * 60;
export const TRIGGER_GRACE_SECONDS = 180;
export const TRADE_SHARES = 5;
export const MARKET_5M_SECONDS = 300;
export const TRIGGER_5M_OFFSET_SECONDS = 4 * 60;
export const TRIGGER_5M_GRACE_SECONDS = 120;
export const HKT_UTC_OFFSET_MINUTES = 8 * 60;

export function utcIso(date) {
  return new Date(date).toISOString();
}

export function floorToQuarterHour(epochSeconds) {
  return Math.floor(epochSeconds / MARKET_SECONDS) * MARKET_SECONDS;
}

export function floorToFiveMinutes(epochSeconds) {
  return Math.floor(epochSeconds / MARKET_5M_SECONDS) * MARKET_5M_SECONDS;
}

export function activeMarketStartTs(nowSeconds = Math.floor(Date.now() / 1000)) {
  return floorToQuarterHour(nowSeconds);
}

export function activeMarketSlug(nowSeconds = Math.floor(Date.now() / 1000)) {
  return `btc-updown-15m-${activeMarketStartTs(nowSeconds)}`;
}

export function active5mMarketStartTs(nowSeconds = Math.floor(Date.now() / 1000)) {
  return floorToFiveMinutes(nowSeconds);
}

export function active5mMarketSlug(nowSeconds = Math.floor(Date.now() / 1000)) {
  return `btc-updown-5m-${active5mMarketStartTs(nowSeconds)}`;
}

export function triggerTs(marketStartTs) {
  return marketStartTs + TRIGGER_OFFSET_SECONDS;
}

export function isExactTriggerMinute(marketStartTs, nowSeconds = Math.floor(Date.now() / 1000)) {
  return Math.floor(nowSeconds / 60) === Math.floor(triggerTs(marketStartTs) / 60);
}

export function isInTriggerWindow(
  marketStartTs,
  nowSeconds = Math.floor(Date.now() / 1000),
  graceSeconds = TRIGGER_GRACE_SECONDS,
) {
  const trigger = triggerTs(marketStartTs);
  return nowSeconds >= trigger && nowSeconds <= trigger + graceSeconds;
}

export function resolveTriggerMarketStartTs(
  nowSeconds = Math.floor(Date.now() / 1000),
  graceSeconds = TRIGGER_GRACE_SECONDS,
) {
  const current = floorToQuarterHour(nowSeconds);
  const previous = current - MARKET_SECONDS;
  if (isInTriggerWindow(current, nowSeconds, graceSeconds)) {
    return current;
  }
  if (isInTriggerWindow(previous, nowSeconds, graceSeconds)) {
    return previous;
  }
  return null;
}

export function trigger5mTs(marketStartTs) {
  return marketStartTs + TRIGGER_5M_OFFSET_SECONDS;
}

export function isIn5mTriggerWindow(
  marketStartTs,
  nowSeconds = Math.floor(Date.now() / 1000),
  graceSeconds = TRIGGER_5M_GRACE_SECONDS,
) {
  const trigger = trigger5mTs(marketStartTs);
  return nowSeconds >= trigger && nowSeconds <= trigger + graceSeconds;
}

export function resolve5mTriggerMarketStartTs(
  nowSeconds = Math.floor(Date.now() / 1000),
  graceSeconds = TRIGGER_5M_GRACE_SECONDS,
) {
  const current = floorToFiveMinutes(nowSeconds);
  const previous = current - MARKET_5M_SECONDS;
  if (isIn5mTriggerWindow(current, nowSeconds, graceSeconds)) {
    return current;
  }
  if (isIn5mTriggerWindow(previous, nowSeconds, graceSeconds)) {
    return previous;
  }
  return null;
}

export function hktDayBounds(now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const shifted = nowMs + (HKT_UTC_OFFSET_MINUTES * 60 * 1000);
  const shiftedDate = new Date(shifted);
  const startShifted = Date.UTC(
    shiftedDate.getUTCFullYear(),
    shiftedDate.getUTCMonth(),
    shiftedDate.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  const startUtcMs = startShifted - (HKT_UTC_OFFSET_MINUTES * 60 * 1000);
  return {
    start: new Date(startUtcMs),
    end: new Date(startUtcMs + (24 * 60 * 60 * 1000)),
  };
}
