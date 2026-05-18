const BINANCE_BASE = "https://api.binance.com/api/v3";

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "btc-15m-wp-style-bot/1.0",
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

export async function fetchTriggerFeatures(marketStartTs) {
  const startMs = marketStartTs * 1000;
  const endMs = startMs + 13 * 60 * 1000;
  const params = new URLSearchParams({
    symbol: "BTCUSDT",
    interval: "1m",
    startTime: String(startMs),
    endTime: String(endMs),
    limit: "13",
  });
  const url = `${BINANCE_BASE}/klines?${params.toString()}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length < 13) {
    throw new Error(`Expected 13 BTC 1m candles, got ${Array.isArray(rows) ? rows.length : "invalid"}`);
  }

  const startPrice = Number(rows[0][1]);
  const minuteCloses = rows.slice(0, 13).map((row) => Number(row[4]));
  const triggerPrice = minuteCloses[12];
  const close10m = minuteCloses[9];
  const aboveStartMinutes = minuteCloses.filter((price) => price > startPrice).length;
  const belowStartMinutes = minuteCloses.filter((price) => price < startPrice).length;
  const ret10mToTrigger = close10m > 0 ? (triggerPrice / close10m) - 1 : 0;

  return {
    btcStart: startPrice,
    btcTriggerPrice: triggerPrice,
    aboveStartMinutes,
    belowStartMinutes,
    ret10mToTrigger,
    rawCandles: rows,
  };
}

export async function fetch5mTriggerFeatures(marketStartTs) {
  const startMs = marketStartTs * 1000;
  const endMs = startMs + 4 * 60 * 1000;
  const params = new URLSearchParams({
    symbol: "BTCUSDT",
    interval: "1m",
    startTime: String(startMs),
    endTime: String(endMs),
    limit: "4",
  });
  const url = `${BINANCE_BASE}/klines?${params.toString()}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows) || rows.length < 4) {
    throw new Error(`Expected 4 BTC 1m candles for 5m check, got ${Array.isArray(rows) ? rows.length : "invalid"}`);
  }

  const startPrice = Number(rows[0][1]);
  const minuteCloses = rows.slice(0, 4).map((row) => Number(row[4]));
  const triggerPrice = minuteCloses[3];
  const previousMinuteClose = minuteCloses[2];
  const btcDistance = startPrice > 0 ? (triggerPrice / startPrice) - 1 : 0;
  const btcMomentum60 = previousMinuteClose > 0 ? (triggerPrice / previousMinuteClose) - 1 : 0;

  return {
    btcStart: startPrice,
    btcTriggerPrice: triggerPrice,
    btcDistance,
    btcMomentum60,
    rawCandles: rows,
  };
}
