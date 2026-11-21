"""Replayable, timestamped BTC book snapshots and matching prints from a single archived hour."""

import argparse
import hashlib
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

from archive_partitions import activate, encode, lz4_lines, verified_download

BASE = "https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/hyperliquid/mainnet/"
BOOK = "market_data/20250323/8/l2Book/BTC.lz4"
BOOK_SHA = "a12a5ef6ba9483d562adaa0109d2e4953df14aa8ec9556c7dfb355c3daefa3b2"
HOUR = int(datetime(2025, 3, 23, 8, tzinfo=timezone.utc).timestamp()) * 1000
RIGHTS = "https://github.com/aws-samples/digital-assets-examples/blob/main/LICENSE"


def records(path):
    with lz4_lines(path) as lines:
        for line in lines:
            yield json.loads(line)


def install(directory, cache):
    cache.mkdir(parents=True, mode=0o700, exist_ok=True)
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    file = verified_download(cache / "btc-book-08.lz4", BASE + BOOK, 533372, BOOK_SHA)
    books = []
    for offset, msg in enumerate(records(file)):
        b = msg["raw"]["data"]
        if msg["raw"]["channel"] != "l2Book" or b["coin"] != "BTC":
            raise ValueError("BOOK_BINDING")
        if not HOUR <= b["time"] < HOUR + 3600000:
            continue
        levels = [[[float(v["px"]), float(v["sz"])] for v in side[:10]] for side in b["levels"]]
        if not all(
            len(side) == 10 and all(10000 <= p < 100000 and p.is_integer() for p, q in side)
            for side in levels
        ):
            raise ValueError("UNSUPPORTED_TICK_REGIME")
        # All reviewed prices have five digits before the decimal. The venue permits five significant figures.
        books.append(
            {"time": b["time"], "sequence": offset, "tickSize": 1, "bids": levels[0], "asks": levels[1]}
        )
    raw = []
    inventory = json.loads(Path(__file__).with_name("hyperliquid-20250323.json").read_bytes())
    objects = [
        r for r in inventory if r["key"] in {f"node_trades/hourly/20250323/{h}.lz4" for h in (7, 8, 9)}
    ]
    for obj in objects:
        path = verified_download(
            cache / obj["key"].replace("/", "_"), BASE + obj["key"], obj["bytes"], obj["sha256"]
        )
        for msg in records(path):
            if msg["coin"] != "BTC" or not msg["time"].startswith("2025-03-23T08:"):
                continue
            ts = msg["time"]
            t = HOUR + (int(ts[14:16]) * 60 + int(ts[17:19])) * 1000 + int((ts[20:] + "000")[:3])
            if msg["side"] not in ("B", "A"):
                raise ValueError("UNKNOWN_AGGRESSOR")
            raw.append(
                (
                    ts,
                    {
                        "time": t,
                        "qty": float(msg["sz"]),
                        "price": float(msg["px"]),
                        "aggressor": "buyer" if msg["side"] == "B" else "seller",
                    },
                )
            )
    tape = []
    for i, (_, r) in enumerate(sorted(raw, key=lambda x: x[0])):
        tape.append(dict(**r, sequence=i))
    if not books or not tape:
        raise ValueError("MISSING_BOOK_OR_TRADES")
    gaps = [b["time"] - a["time"] for a, b in zip(books, books[1:])]
    if min(gaps) <= 0:
        raise ValueError("BOOK_TIME_ORDER")
    with tempfile.TemporaryDirectory(dir=directory) as tmp:
        dest = Path(tmp)
        parts = []
        for kind, mapping, rows, upstream, length in [
            ("depth", "top10-snapshot/v1", books, BOOK_SHA, 800),
            ("trades", "aggressor-trade/v1", tape, hashlib.sha256(encode(objects)).hexdigest(), 2400),
        ]:
            i = 0
            while i < len(rows):
                end = min(i + length, len(rows))
                # Keep simultaneous prints together so adjacent partition spans never overlap.
                while end < len(rows) and rows[end]["time"] == rows[end - 1]["time"]:
                    end += 1
                group = rows[i:end]
                i = end
                body = encode(group)
                if len(body) >= 500000:
                    raise ValueError("PARTITION_BYTE_LIMIT")
                h = hashlib.sha256(body).hexdigest()
                name = h + ".json"
                (dest / name).write_bytes(body)
                parts.append(
                    {
                        "kind": kind,
                        "mapping": mapping,
                        "venue": "hyperliquid",
                        "symbol": "BTC.USDT",
                        "marketType": "perpetual",
                        "settlement": "USDC",
                        "source": "https://registry.opendata.aws/aws-public-blockchain/",
                        "license": "MIT",
                        "licenseUrl": RIGHTS,
                        "creator": "Hyperliquid",
                        "upstreamPrefix": BASE,
                        "upstreamInventorySha256": upstream,
                        "sequenceScope": "archived snapshot or trade ordinal",
                        "first": group[0]["time"],
                        "last": group[-1]["time"],
                        "file": name,
                        "sha256": h,
                    }
                )
        activate(
            directory, dest, {"schema": "trading-partitions/v1", "timeUnit": "UTC_ms", "partitions": parts}
        )
    print(
        json.dumps(
            {
                "bookObject": BOOK,
                "bookSha256": BOOK_SHA,
                "tradeObjects": objects,
                "snapshots": len(books),
                "prints": len(tape),
                "minGapMs": min(gaps),
                "medianGapMs": median(gaps),
                "maxGapMs": max(gaps),
                "start": books[0]["time"],
                "last": books[-1]["time"],
                "hardCapUsd": 0,
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("cache", type=Path)
    args = parser.parse_args()
    install(args.directory, args.cache)
