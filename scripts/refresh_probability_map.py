#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import subprocess
import sys
from datetime import datetime, timezone


PROJECT_ROOT = pathlib.Path("/Users/hello/Desktop/bitcoinbot/coinbot-publish")
REPO_ROOT = pathlib.Path("/Users/hello/Desktop/bitcoinbot/repo")
CACHE_TOOL = REPO_ROOT / "tools" / "cache_binance_btc_1m.py"
COARSE_TOOL = REPO_ROOT / "tools" / "build_btc_probability_map_coarse.py"
PROJECT_DATA_FILE = PROJECT_ROOT / "data" / "btc_probability_map_365d_coarse.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh the coarse BTC probability map with the latest Binance 1m data.")
    parser.add_argument("--days", type=int, default=365, help="Lookback window in days. Default: 365")
    parser.add_argument("--force", action="store_true", help="Refetch Binance cache even if the current cache file exists.")
    return parser.parse_args()


def run(cmd: list[str]) -> dict:
    proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)


def load_module(module_path: pathlib.Path, name: str):
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def iso_to_ms(iso_value: str) -> int:
    return int(datetime.fromisoformat(iso_value.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp() * 1000)


def try_incremental_cache(days: int) -> str | None:
    if not PROJECT_DATA_FILE.exists():
        return None

    existing_map = json.loads(PROJECT_DATA_FILE.read_text())
    source = existing_map.get("source", {})
    old_cache_file = source.get("btc_cache_file")
    window_start_utc = source.get("window_start_utc")
    if not old_cache_file or not window_start_utc:
        return None

    old_cache_path = pathlib.Path(old_cache_file)
    if not old_cache_path.exists():
        return None

    cache_mod = load_module(CACHE_TOOL, "cache_binance_btc_1m")
    old_rows = json.loads(old_cache_path.read_text())
    if not old_rows:
        return None

    start_ms = iso_to_ms(window_start_utc)
    latest_end_ms = cache_mod.latest_completed_minute_ms()
    current_end_ms = int(old_rows[-1][0]) + cache_mod.MINUTE_MS
    if latest_end_ms <= current_end_ms:
        return str(old_cache_path)

    delta_rows = cache_mod.fetch_binance_1m(current_end_ms, latest_end_ms)
    merged_rows = old_rows + delta_rows
    target_path = cache_mod.cache_path(start_ms, latest_end_ms)
    target_path.write_text(json.dumps(merged_rows))
    return str(target_path)


def main() -> None:
    args = parse_args()

    cache_file = None
    latest = None

    if not args.force:
        cache_file = try_incremental_cache(args.days)

    if cache_file is None:
        cache_cmd = [
            sys.executable,
            str(CACHE_TOOL),
            "--days",
            str(args.days),
        ]
        if args.force:
            cache_cmd.append("--force")
        cache_result = run(cache_cmd)
        latest = cache_result["results"][-1]
        cache_file = latest["cache_file"]
    else:
        cache_path = pathlib.Path(cache_file)
        rows = json.loads(cache_path.read_text())
        latest = {
            "days": args.days,
            "cache_file": cache_file,
            "existed": True,
            "rows": len(rows),
            "start_utc": datetime.fromtimestamp(int(rows[0][0]) / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            "end_utc": datetime.fromtimestamp((int(rows[-1][0]) + 60_000) / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        }

    build_cmd = [
        sys.executable,
        str(COARSE_TOOL),
        "--cache-file",
        cache_file,
        "--label",
        f"{args.days}d_coarse",
        "--copy-to",
        str(PROJECT_DATA_FILE),
    ]
    build_result = run(build_cmd)

    summary = {
        "cache": latest,
        "map_path": build_result["map_path"],
        "project_data_file": str(PROJECT_DATA_FILE),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
