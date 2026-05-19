#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import pathlib
import statistics
import time
from datetime import datetime, timezone


PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT_DIR = PROJECT_ROOT / ".cache" / "probability_map"
DEFAULT_BTC_CACHE = PROJECT_ROOT / ".cache" / "binance" / "binance_btcusdt_1m_20250516T1141_20260516T1141.json"
MARKET_SECONDS = 900
TRIGGER_OFFSET_SECONDS = 13 * 60

COARSE_DELTA_BINS = [
    (0, 20, "0_19"),
    (20, 50, "20_49"),
    (50, 100, "50_99"),
    (100, 10**9, "100_plus"),
]
COARSE_RET10_BINS = [
    (0.0, 0.0001, "0_9bp"),
    (0.0001, 0.0004, "10_39bp"),
    (0.0004, 1.0, "40bp_plus"),
]
TRIGGER_VOLUME_RATIO_BINS = [
    (0.0, 0.5, "lt_0_5x"),
    (0.5, 1.2, "0_5x_1_2x"),
    (1.2, 10**9, "1_2x_plus"),
]


def parse_args():
    parser = argparse.ArgumentParser(description="Build a coarser BTC-only probability map from a cached Binance 1m file.")
    parser.add_argument("--cache-file", default=str(DEFAULT_BTC_CACHE))
    parser.add_argument("--label", default="365d_coarse", help="Suffix label for output filenames.")
    parser.add_argument("--copy-to", default="", help="Optional destination file path to copy the final JSON into.")
    return parser.parse_args()


def iso_utc(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def wilson_lower_bound(wins: int, n: int, z: float = 1.96) -> float:
    if n == 0:
        return 0.0
    phat = wins / n
    denom = 1 + z * z / n
    center = phat + z * z / (2 * n)
    margin = z * math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n)
    return (center - margin) / denom


def load_btc_cache(cache_file: pathlib.Path):
    with cache_file.open() as f:
        rows = json.load(f)
    return {int(row[0]): row for row in rows}


def build_resolved_dataset(cache_file: pathlib.Path):
    candle_map = load_btc_cache(cache_file)
    start_ms = min(candle_map)
    end_ms = max(candle_map)
    first_start_ts = start_ms // 1000
    last_start_ts = (end_ms // 1000) - 14 * 60
    first_eligible_start_ts = first_start_ts + 60 * 60
    timestamps = list(range(first_eligible_start_ts, last_start_ts + 1, MARKET_SECONDS))

    rows = []
    missing_candles = 0
    for start_ts in timestamps:
      seq = []
      ok = True
      for i in range(15):
          candle = candle_map.get(start_ts * 1000 + i * 60_000)
          if candle is None:
              ok = False
              break
          seq.append(candle)
      if not ok:
          missing_candles += 1
          continue

      prev_seq = []
      for i in range(60, 0, -1):
          candle = candle_map.get(start_ts * 1000 - i * 60_000)
          if candle is None:
              ok = False
              break
          prev_seq.append(candle)
      if not ok:
          missing_candles += 1
          continue

      start_price = float(seq[0][1])
      closes = [float(c[4]) for c in seq]
      volumes = [float(c[5]) for c in seq]
      prev_60m_avg_volume = statistics.mean(float(c[5]) for c in prev_seq) if prev_seq else 0.0
      trigger_price = closes[12]
      end_price = closes[14]
      above = sum(1 for p in closes[:13] if p > start_price)
      below = sum(1 for p in closes[:13] if p < start_price)
      ret10 = (trigger_price / closes[9] - 1.0) if closes[9] else 0.0
      delta_points = trigger_price - start_price
      trigger_volume_ratio = (volumes[12] / prev_60m_avg_volume) if prev_60m_avg_volume > 0 else 0.0
      direction = "YES" if delta_points > 0 else "NO" if delta_points < 0 else "FLAT"
      yes_win = end_price > start_price
      won = yes_win if direction == "YES" else (not yes_win) if direction == "NO" else False

      rows.append(
          {
              "start_ts": start_ts,
              "trigger_ts": start_ts + TRIGGER_OFFSET_SECONDS,
              "direction": direction,
              "btc_start": start_price,
              "btc_trigger": trigger_price,
              "btc_end": end_price,
              "abs_delta_points": abs(delta_points),
              "above_mins": above,
              "below_mins": below,
              "ret10m_to_trigger": abs(ret10),
              "trigger_volume_ratio_1m": trigger_volume_ratio,
              "won": won,
          }
      )

    return {
        "rows": rows,
        "first_start_ts": first_eligible_start_ts,
        "last_start_ts": last_start_ts,
        "missing_candles": missing_candles,
    }


def summarize_group(group_rows):
    n = len(group_rows)
    wins = sum(1 for row in group_rows if row["won"])
    win_rate = wins / n if n else None
    return {
        "n": n,
        "wins": wins,
        "losses": n - wins,
        "win_rate": round(win_rate, 6) if win_rate is not None else None,
        "wilson_lower_95": round(wilson_lower_bound(wins, n), 6) if n else None,
        "avg_abs_delta_points": round(statistics.mean(row["abs_delta_points"] for row in group_rows), 4) if n else None,
        "avg_abs_ret10m_to_trigger": round(statistics.mean(row["ret10m_to_trigger"] for row in group_rows), 6) if n else None,
        "avg_trigger_volume_ratio_1m": round(statistics.mean(row["trigger_volume_ratio_1m"] for row in group_rows), 4) if n else None,
    }


def summarize_ns(ns):
    if not ns:
        return {
            "bucket_count": 0,
            "min_n": 0,
            "median_n": 0,
            "mean_n": 0,
            "p25_n": None,
            "p75_n": None,
        }
    return {
        "bucket_count": len(ns),
        "min_n": min(ns),
        "median_n": statistics.median(ns),
        "mean_n": round(statistics.mean(ns), 2),
        "p25_n": round(statistics.quantiles(ns, n=4)[0], 2) if len(ns) >= 4 else None,
        "p75_n": round(statistics.quantiles(ns, n=4)[2], 2) if len(ns) >= 4 else None,
    }


def build_probability_map(rows):
    threshold = {"YES": {}, "NO": {}}
    fallback = {"YES": {}, "NO": {}}
    all_ret10_ns = []
    volume_all_ret10_ns = []
    ret_bucket_ns = []

    directional = [row for row in rows if row["direction"] in ("YES", "NO")]
    for side in ("YES", "NO"):
        side_rows = [row for row in directional if row["direction"] == side]
        minute_key = "above_mins" if side == "YES" else "below_mins"

        for mins in range(0, 14):
            subset = [row for row in side_rows if row[minute_key] >= mins]
            if not subset:
                continue

            fallback[side][f"mins_at_least_{mins}"] = summarize_group(subset)
            threshold[side][str(mins)] = {}

            for lo, hi, delta_label in COARSE_DELTA_BINS:
                delta_rows = [row for row in subset if lo <= row["abs_delta_points"] < hi]
                if not delta_rows:
                    continue

                threshold[side][str(mins)][delta_label] = {"all_ret10": summarize_group(delta_rows), "ret10": {}, "volume": {}}
                all_ret10_ns.append(len(delta_rows))

                for rlo, rhi, ret_label in COARSE_RET10_BINS:
                    ret_rows = [
                        row for row in delta_rows
                        if rlo <= row["ret10m_to_trigger"] < rhi
                    ]
                    if not ret_rows:
                        continue

                    threshold[side][str(mins)][delta_label]["ret10"][ret_label] = summarize_group(ret_rows)
                    ret_bucket_ns.append(len(ret_rows))

                for vlo, vhi, volume_label in TRIGGER_VOLUME_RATIO_BINS:
                    volume_rows = [
                        row for row in delta_rows
                        if vlo <= row["trigger_volume_ratio_1m"] < vhi
                    ]
                    if not volume_rows:
                        continue

                    threshold[side][str(mins)][delta_label]["volume"][volume_label] = {
                        "all_ret10": summarize_group(volume_rows),
                    }
                    volume_all_ret10_ns.append(len(volume_rows))

                    for rlo, rhi, ret_label in COARSE_RET10_BINS:
                        cell_rows = [
                            row for row in volume_rows
                            if rlo <= row["ret10m_to_trigger"] < rhi
                        ]
                        if not cell_rows:
                            continue

                        threshold[side][str(mins)][delta_label]["volume"][volume_label][ret_label] = summarize_group(cell_rows)

    quality = {
        "all_ret10": summarize_ns(all_ret10_ns),
        "volume_all_ret10": summarize_ns(volume_all_ret10_ns),
        "ret_bucket": summarize_ns(ret_bucket_ns),
    }

    return {"threshold": threshold, "fallback": fallback, "quality": quality}


def main():
    args = parse_args()
    cache_file = pathlib.Path(args.cache_file)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    dataset = build_resolved_dataset(cache_file)
    probability_map = build_probability_map(dataset["rows"])

    map_output = {
        "generated_at_utc": iso_utc(int(time.time())),
        "source": {
            "btc_cache_file": str(cache_file),
            "market_results_source": "BTC cache only; outcome inferred from 15m end price vs start price",
            "window_start_utc": iso_utc(dataset["first_start_ts"]),
            "window_end_utc": iso_utc(dataset["last_start_ts"] + MARKET_SECONDS),
            "resolved_rows": len(dataset["rows"]),
            "missing_candles": dataset["missing_candles"],
        },
        "binning": {
            "delta_points": [label for _, _, label in COARSE_DELTA_BINS],
            "ret10_abs": [label for _, _, label in COARSE_RET10_BINS],
            "trigger_volume_ratio_1m": [label for _, _, label in TRIGGER_VOLUME_RATIO_BINS],
            "minutes_field": {
                "YES": "above_mins",
                "NO": "below_mins",
            },
            "minutes_mode": "at_least",
        },
        "map": probability_map,
    }

    map_path = OUTPUT_DIR / f"btc_probability_map_{args.label}.json"
    map_path.write_text(json.dumps(map_output, indent=2))

    if args.copy_to:
        copy_path = pathlib.Path(args.copy_to)
        copy_path.parent.mkdir(parents=True, exist_ok=True)
        copy_path.write_text(json.dumps(map_output, indent=2))

    print(json.dumps({"map_path": str(map_path), "copy_to": args.copy_to or None}, indent=2))


if __name__ == "__main__":
    main()
