export const MARKET_SECONDS = 900;
export const TRIGGER_OFFSET_SECONDS = 13 * 60;
export const TRADE_SHARES = 5;

export function utcIso(date) {
  return new Date(date).toISOString();
}

export function floorToQuarterHour(epochSeconds) {
  return Math.floor(epochSeconds / MARKET_SECONDS) * MARKET_SECONDS;
}

export function activeMarketStartTs(nowSeconds = Math.floor(Date.now() / 1000)) {
  return floorToQuarterHour(nowSeconds);
}

export function activeMarketSlug(nowSeconds = Math.floor(Date.now() / 1000)) {
  return `btc-updown-15m-${activeMarketStartTs(nowSeconds)}`;
}

export function triggerTs(marketStartTs) {
  return marketStartTs + TRIGGER_OFFSET_SECONDS;
}

export function isExactTriggerMinute(marketStartTs, nowSeconds = Math.floor(Date.now() / 1000)) {
  return Math.floor(nowSeconds / 60) === Math.floor(triggerTs(marketStartTs) / 60);
}
