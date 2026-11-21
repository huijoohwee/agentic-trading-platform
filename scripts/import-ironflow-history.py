"""Install the October 2026 vintage of Ironflow's CC BY historical datasets."""

import argparse
import hashlib
import json
import tempfile
from collections import defaultdict
from pathlib import Path

import duckdb
from archive_partitions import activate, encode, verified_download

ROOT = "https://huggingface.co/datasets/ironflow/hyperliquid-"
INVENTORY = Path(__file__).with_name("ironflow-202610.json")
UNIVERSE = [
    "AAVE",
    "ADA",
    "APT",
    "AR",
    "ARB",
    "ATOM",
    "AVAX",
    "BCH",
    "BNB",
    "BTC",
    "DOGE",
    "DOT",
    "ETH",
    "FIL",
    "INJ",
    "LINK",
    "LTC",
    "NEAR",
    "OP",
    "SOL",
    "XRP",
]
SPOT = ["UBTC/USDC", "UETH/USDC", "USOL/USDC"]


def acquire(cache):
    groups = defaultdict(list)
    for obj in json.loads(INVENTORY.read_bytes()):
        name = obj["dataset"]
        if obj["published"] >= "2026-11-10":
            raise ValueError("PUBLISHED_GRANT_REQUIRED")
        dest = cache / (name + "-" + Path(obj["path"]).name)
        url = ROOT + name + "/resolve/" + obj["revision"] + "/" + obj["path"]
        verified_download(dest, url, obj["bytes"], obj["sha256"])
        groups[name].append((obj, str(dest)))
    return groups


def install(directory, cache):
    cache.mkdir(parents=True, mode=0o700, exist_ok=True)
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    groups = acquire(cache)
    totals, parts = {}, []
    columns = {
        "candles-1h": (
            "ohlcv",
            "epoch_ms(timestamp), open, high, low, close, volume",
            ["open", "high", "low", "close", "volume"],
        ),
        "funding": ("funding", "epoch_ms(timestamp), funding_rate", ["rate"]),
        "open-interest": ("openInterest", "epoch_ms(timestamp) + 3600000, open_interest", ["value"]),
        "liquidations": ("liquidations", "epoch_ms(timestamp), sum(notional_usd)", ["notional"]),
    }
    with tempfile.TemporaryDirectory(dir=directory) as tmp, duckdb.connect() as con:
        stage = Path(tmp)
        con.execute("set threads=2")
        for name, files in groups.items():
            records, paths = zip(*files)
            kind, query, fields = columns[name]
            collection = ROOT + name + "/tree/" + records[0]["revision"]
            inputs_hash = hashlib.sha256(encode(records)).hexdigest()
            con.from_parquet(list(paths)).create_view("history", replace=True)
            markets = [base + "-PERP" for base in UNIVERSE] + (SPOT if kind == "ohlcv" else [])
            # Query and discard one market at a time. The loader keeps the canonical UTC clock.
            for market in markets:
                spot = market in SPOT
                base = market.split("/")[0] if spot else market[:-5]
                quote = "USDC" if spot else "USDT"
                extra = ""
                if kind == "openInterest":
                    extra = " and open_interest is not null"
                if kind == "liquidations":
                    extra = " group by timestamp"
                if kind == "funding" and base not in ("BTC", "ETH", "SOL"):
                    extra = " and timestamp >= timestamptz '2025-05-25 00:00:00+00'"
                sql = "select " + query + " from history where market = ?" + extra + " order by 1"
                cursor = con.execute(sql, [market])
                while chunk := cursor.fetchmany(2400):
                    rows = [dict(time=r[0], **dict(zip(fields, r[1:]))) for r in chunk]
                    if kind == "funding":
                        for row in rows:
                            row["settled"] = True
                    data = encode(rows)
                    if len(data) >= 500000:
                        raise ValueError("PARTITION_BYTE_LIMIT")
                    h = hashlib.sha256(data).hexdigest()
                    file = h + ".json"
                    (stage / file).write_bytes(data)
                    part = {
                        "kind": kind,
                        "venue": "hyperliquid",
                        "symbol": base + "." + quote,
                        "marketType": "spot" if spot else "perpetual",
                        "quote": quote,
                        "creator": "Ironflow (ironflow.sh)",
                        "license": "CC-BY-4.0",
                        "source": collection,
                        "upstreamInventorySha256": inputs_hash,
                        "licenseUrl": ROOT + name + "/blob/" + records[0]["revision"] + "/README.md",
                        "file": file,
                        "sha256": h,
                        "first": chunk[0][0],
                        "last": chunk[-1][0],
                    }
                    if not spot:
                        part["settlement"] = "USDC"
                    if kind == "ohlcv":
                        part.update(frame="1h", volumeUnit=base)
                    elif kind == "openInterest":
                        part.update(amountUnit=base, observedAt="hour-close")
                    elif kind == "liquidations":
                        part.update(mapping="liquidation-event/v1", eventType="liquidated-position")
                    parts.append(part)
                    totals[kind] = totals.get(kind, 0) + len(rows)
        activate(
            directory, stage, {"schema": "trading-partitions/v1", "timeUnit": "UTC_ms", "partitions": parts}
        )
    print(
        json.dumps(
            {
                "creator": "Ironflow (ironflow.sh)",
                "license": "CC-BY-4.0",
                "hardCapUsd": 0,
                "cutoff": "2026-11-01T00:00:00Z",
                "parts": len(parts),
                "rows": totals,
                "inventorySha256": hashlib.sha256(INVENTORY.read_bytes()).hexdigest(),
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("cache", type=Path)
    args = parser.parse_args()
    install(args.directory, args.cache)
