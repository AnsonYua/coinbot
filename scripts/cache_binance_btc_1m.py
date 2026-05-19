#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, List
from urllib.error import HTTPError, URLError


PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / ".cache" / "binance"
BINANCE_BASES = [
    "https://api.binance.com/api/v3/klines",
    "https://api1.binance.com/api/v3/klines",
    "https://api-gcp.binance.com/api/v3/klines",
]
USER_AGENT = "Codex Binance BTC Cache Builder"
MINUTE_MS = 60_000
DAY_MS = 24 * 60 * 60 * 1000


def fetch_json(urls: list[str]) -> Any:
    last_error = None
    for attempt in range(5):
        for url in urls:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except (HTTPError, URLError, TimeoutError) as exc:
                last_error = exc
        time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch after retries: {urls[0]}") from last_error


def cache_path(start_ms: int, end_ms: int) -> pathlib.Path:
    start_label = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).strftime("%Y%m%dT%H%M")
    end_label = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).strftime("%Y%m%dT%H%M")
    return CACHE_DIR / f"binance_btcusdt_1m_{start_label}_{end_label}.json"


def fetch_binance_1m(start_ms: int, end_ms: int) -> List[list]:
    candles: List[list] = []
    cursor = start_ms
    while cursor < end_ms:
        params = urllib.parse.urlencode(
            {
                "symbol": "BTCUSDT",
                "interval": "1m",
                "startTime": cursor,
                "endTime": end_ms,
                "limit": 1000,
            }
        )
        batch = fetch_json([f"{base}?{params}" for base in BINANCE_BASES])
        if not batch:
            break
        candles.extend(batch)
        cursor = int(batch[-1][0]) + MINUTE_MS
        if len(batch) < 1000:
            break
        time.sleep(0.05)
    return candles


def latest_completed_minute_ms() -> int:
    now_ms = int(time.time() * 1000)
    return (now_ms // MINUTE_MS) * MINUTE_MS


def parse_utc_minute(label: str) -> int:
    return int(datetime.strptime(label, "%Y%m%dT%H%M").replace(tzinfo=timezone.utc).timestamp() * 1000)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cache Binance BTCUSDT 1m data for one or more day windows.")
    parser.add_argument("--days", type=int, nargs="+", help="One or more lookback windows in days.")
    parser.add_argument("--start-utc", help="Explicit UTC start minute in YYYYMMDDTHHMM format.")
    parser.add_argument("--end-utc", help="Explicit UTC end minute in YYYYMMDDTHHMM format.")
    parser.add_argument("--force", action="store_true", help="Refetch even if the target cache file already exists.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    windows = []

    if args.start_utc or args.end_utc:
        if not (args.start_utc and args.end_utc):
            raise SystemExit("--start-utc and --end-utc must be provided together")
        windows.append((None, parse_utc_minute(args.start_utc), parse_utc_minute(args.end_utc)))
    elif args.days:
        end_ms = latest_completed_minute_ms()
        for days in args.days:
            windows.append((days, end_ms - days * DAY_MS, end_ms))
    else:
        raise SystemExit("Provide either --days or both --start-utc and --end-utc")

    for days, start_ms, end_ms in windows:
        path = cache_path(start_ms, end_ms)
        existed = path.exists()
        if existed and not args.force:
            candles = json.loads(path.read_text())
        else:
            candles = fetch_binance_1m(start_ms, end_ms)
            path.write_text(json.dumps(candles))

        results.append(
            {
                "days": days,
                "cache_file": str(path),
                "existed": existed,
                "rows": len(candles),
                "start_utc": datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
                "end_utc": datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        )

    print(json.dumps({"generated_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "results": results}, indent=2))


if __name__ == "__main__":
    main()
