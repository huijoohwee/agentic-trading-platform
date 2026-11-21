"""Import one reviewable UTC session from the sponsored mainnet archive."""

import argparse
import csv
import hashlib
import json
import math
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from archive_partitions import activate, encode, lz4_lines, verified_download

ROOT = "https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/hyperliquid/mainnet/"
REGISTRY = "https://registry.opendata.aws/aws-public-blockchain/"
RIGHTS = "https://github.com/aws-samples/digital-assets-examples/blob/main/LICENSE"
INVENTORY = Path(__file__).with_name("hyperliquid-20250323.json")
START = int(datetime(2025, 3, 23, tzinfo=timezone.utc).timestamp()) * 1000
END = START + 86400000
MAJORS = {"BTC", "ETH", "SOL"}
UNIVERSE = MAJORS | set(
    [
        "AAVE",
        "ADA",
        "APT",
        "AR",
        "ARB",
        "ATOM",
        "AVAX",
        "BCH",
        "BNB",
        "DOGE",
        "DOT",
        "FIL",
        "INJ",
        "LINK",
        "LTC",
        "NEAR",
        "OP",
        "XRP",
    ]
)
FRAMES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def timestamp(s):
    return int(datetime.fromisoformat(s[:19]).replace(tzinfo=timezone.utc).timestamp()) * 1000 + (
        int((s[20:23] + "000")[:3]) if s[19:20] == "." else 0
    )


def install(directory, cache):
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    inventory = INVENTORY.read_bytes()
    objlist = json.loads(inventory)
    bars, flow, liquidations, interests = defaultdict(dict), {}, defaultdict(dict), defaultdict(list)
    count = 0
    for obj in objlist:
        key = obj["key"]
        path = verified_download(cache / key.replace("/", "_"), ROOT + key, obj["bytes"], obj["sha256"])
        with lz4_lines(path) as file:
            if obj["key"].startswith("asset_ctxs/"):
                for row in csv.DictReader(file):
                    t, coin = timestamp(row["time"]), row["coin"]
                    if coin in UNIVERSE and START <= t < END:
                        interests[coin].append({"time": t, "value": float(row["open_interest"])})
                continue
            for line in file:
                trade = json.loads(line)
                coin, s = trade["coin"], trade["time"]
                if coin not in UNIVERSE or not s.startswith("2025-03-23T"):
                    continue
                t, p, qty = timestamp(s), float(trade["px"]), float(trade["sz"])
                if not all(math.isfinite(x) and x > 0 for x in (p, qty)) or trade["side"] not in ("B", "A"):
                    raise ValueError("INVALID_TRADE")
                count += 1
                for frame in FRAMES if coin in MAJORS else ("1h", "1d"):
                    step = FRAMES[frame] * 60000
                    start = t - t % step
                    lane = bars[coin, frame]
                    if start not in lane:
                        lane[start] = {
                            "time": start,
                            "open": p,
                            "high": p,
                            "low": p,
                            "close": p,
                            "volume": 0,
                            "first": s,
                            "last": s,
                        }
                    b = lane[start]
                    if s < b["first"]:
                        b["first"], b["open"] = s, p
                    if s >= b["last"]:
                        b["last"], b["close"] = s, p
                    b["high"], b["low"] = max(p, b["high"]), min(p, b["low"])
                    b["volume"] += qty
                if coin == "BTC":
                    # A full minute's aggressor volume becomes observable at its CLOSE.
                    close = (t // 60000 + 1) * 60000
                    totals = flow.setdefault(close, {"time": close, "buy": 0, "sell": 0})
                    totals["buy" if trade["side"] == "B" else "sell"] += qty
                if trade["trade_dir_override"] == "LiquidatedMarket":
                    group = liquidations[coin]
                    group[t] = group.get(t, 0) + p * qty
    with tempfile.TemporaryDirectory(dir=directory) as temp:
        stage, parts = Path(temp), []

        def add(coin, kind, rows, **attrs):
            ordered = sorted(rows, key=lambda row: row["time"])
            for i in range(0, len(ordered), 1200):
                chunk = ordered[i : i + 1200]
                body = encode(chunk)
                if len(body) >= 500000:
                    raise ValueError("PARTITION_BYTE_LIMIT")
                fingerprint = digest(body)
                name = fingerprint + ".json"
                (stage / name).write_bytes(body)
                parts.append(
                    dict(
                        kind=kind,
                        venue="hyperliquid",
                        marketType="perpetual",
                        symbol=coin + ".USDT",
                        quote="USDT",
                        settlement="USDC",
                        source=REGISTRY,
                        creator="Hyperliquid",
                        license="MIT",
                        licenseUrl=RIGHTS,
                        upstreamInventorySha256=digest(inventory),
                        upstreamPrefix=ROOT,
                        file=name,
                        sha256=fingerprint,
                        first=chunk[0]["time"],
                        last=chunk[-1]["time"],
                        **attrs,
                    )
                )

        for (coin, frame), lane in sorted(bars.items()):
            for b in lane.values():
                del b["first"], b["last"]
            add(coin, "ohlcv", lane.values(), frame=frame, volumeUnit=coin)
        add("BTC", "taker", flow.values(), amountUnit="BTC", observedAt="minute-close")
        for coin in sorted(interests):
            add(coin, "openInterest", interests[coin], amountUnit=coin)
        for coin, events in sorted(liquidations.items()):
            add(
                coin,
                "liquidations",
                [{"time": t, "notional": n} for t, n in events.items()],
                mapping="liquidation-event/v1",
                eventType="LiquidatedMarket",
            )
        manifest = {"schema": "trading-partitions/v1", "timeUnit": "UTC_ms", "partitions": parts}
        activate(directory, stage, manifest)
    print(
        json.dumps(
            {
                "source": REGISTRY,
                "creator": "Hyperliquid",
                "license": "MIT",
                "hardCapUsd": 0,
                "upstreamInventorySha256": digest(inventory),
                "rawBytes": sum(o["bytes"] for o in objlist),
                "prints": count,
                "contracts": len(interests),
                "parts": len(parts),
                "start": START,
                "endExclusive": END,
                "liquidationContracts": sorted(liquidations),
                "expectedFundingIncluded": False,
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("cache", type=Path)
    args = parser.parse_args()
    install(args.directory, args.cache)
