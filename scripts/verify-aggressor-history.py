"""Independent BTC minute replay from source executions and minute-open interest."""

import argparse
import csv
import gzip
import hashlib
import json
import subprocess
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from math import isclose
from pathlib import Path


def verify(cache, archive_cache, artifact):
    raw = gzip.decompress(artifact.read_bytes())
    assert hashlib.sha256(raw).hexdigest() == artifact.name.split(".")[0], "ARTIFACT_DIGEST"
    report = json.loads(raw)
    row = next(r for r in report["rows"] if r["id"] == 18)
    assert row["market"] == {
        "symbol": "BTC.USDT",
        "frame": "1m",
        "marketType": "perpetual",
        "venue": "hyperliquid",
    }
    assert row["capitalUnit"] == "USDC"
    base = datetime(2025, 3, 23, tzinfo=timezone.utc)
    origin = int(base.timestamp()) * 1000
    bars, interest = defaultdict(list), {}
    files = json.loads(Path(__file__).with_name("hyperliquid-20250323.json").read_bytes())
    for obj in files:
        path = cache / obj["key"].replace("/", "_")
        assert hashlib.sha256(path.read_bytes()).hexdigest() == obj["sha256"], "SOURCE_DIGEST"
        with subprocess.Popen(["lz4", "-dc", str(path)], stdout=subprocess.PIPE, text=True) as proc:
            if "asset_ctxs/" in obj["key"]:
                for r in csv.DictReader(proc.stdout):
                    if r["coin"] == "BTC":
                        stamp = datetime.fromisoformat(r["time"].replace("Z", "+00:00"))
                        interest[int(stamp.timestamp()) * 1000] = Decimal(r["open_interest"])
            else:
                for line in proc.stdout:
                    r = json.loads(line)
                    if r["coin"] != "BTC" or r["time"][:10] != "2025-03-23":
                        continue
                    minute = int(r["time"][11:13]) * 60 + int(r["time"][14:16])
                    bars[minute].append((r["time"], Decimal(r["px"]), Decimal(r["sz"]), r["side"]))
            assert proc.wait() == 0
    assert sorted(bars) == list(range(1440)), "MISSING_BTC_MINUTE"
    rows, cvd, wap = [], [], []
    volume, weighted, signed = Decimal(0), Decimal(0), Decimal(0)
    for i in range(1440):
        ticks = sorted(bars[i], key=lambda r: r[0])
        price = [r[1] for r in ticks]
        o, h, low, c = price[0], max(price), min(price), price[-1]
        v = sum(r[2] for r in ticks)
        signed += sum(r[2] if r[3] == "B" else -r[2] for r in ticks)
        weighted += v * (h + low + c) / 3
        volume += v
        rows.append(tuple(map(float, (o, h, low, c))))
        cvd.append(signed)
        wap.append(float(weighted / volume))
    oi_times = sorted(interest)

    def oi(t):
        j = bisect_right(oi_times, t) - 1
        return interest[oi_times[j]] if j >= 0 and t - oi_times[j] <= 60000 else None

    def plan(i):
        if i < 13:
            return None
        t = origin + (i + 1) * 60000
        new, old = oi(t), oi(t - 300000)
        if None in (new, old) or new >= old:
            return None
        k = i - 2
        close = rows[i][3]
        for side, col, opposite in [(1, 2, 1), (-1, 1, 2)]:
            rank = min if side == 1 else max
            prev = rank(range(i - 11, i - 4), key=lambda j: rows[j][col])
            stop = rows[k][col]
            if (
                side * (stop - rows[prev][col]) < 0
                and side * (cvd[k] - cvd[prev]) > 0
                and stop == rank(r[col] for r in rows[k - 2 : k + 3])
                and side * (close - rows[i - 1][opposite]) > 0
                and side * (close - stop) > 0
            ):
                target = wap[i] if side * (wap[i] - close) > 0 else close + side * 2.5 * abs(close - stop)
                return side, stop, target
        return None

    import duckdb

    monthly = next(
        o
        for o in json.loads(Path(__file__).with_name("ironflow-202610.json").read_bytes())
        if o["dataset"] == "funding" and o["path"] == "data/2025-03.parquet"
    )
    funding_path = archive_cache / "funding-2025-03.parquet"
    assert hashlib.sha256(funding_path.read_bytes()).hexdigest() == monthly["sha256"], "FUNDING_SOURCE_DIGEST"
    with duckdb.connect() as db:
        payments = db.execute(
            "select epoch_ms(timestamp),funding_rate from read_parquet(?) where market='BTC-PERP' and epoch_ms(timestamp)>=? and epoch_ms(timestamp)<? order by timestamp",
            [str(funding_path), origin, origin + 86400000],
        ).fetchall()
    event_index = 0
    paid = 0
    position_paid = 0
    capital = report["capital"]
    cash, pos, trades = capital, None, []
    friction = 0.0006

    def exit_position(i, price, position):
        side, qty, entry, _stop, _target, j = position
        trades.append(
            (
                origin + j * 60000,
                origin + i * 60000,
                qty,
                entry,
                price,
                qty * (side * (price - entry) - (entry + price) * friction) - position_paid,
            )
        )
        return qty * (side * (price - entry) - price * friction)

    for i, (o, h, low, c) in enumerate(rows):
        if i == 0:
            continue
        while event_index < len(payments) and payments[event_index][0] <= origin + i * 60000:
            event_time, rate = payments[event_index]
            if pos and event_time > origin + pos[5] * 60000:
                debit = pos[0] * pos[1] * o * rate
                cash -= debit
                position_paid += debit
                paid += debit
            event_index += 1
        if pos:
            side, _, _, stop, target, _ = pos
            if side * (o - stop) <= 0 or side * (o - target) >= 0:
                cash += exit_position(i, o, pos)
                pos = None
        intent = plan(i - 1)
        if pos is None and intent:
            side, stop, target = intent
            if side * (o - stop) > 0 and side * (target - o) > 0:
                qty = min(cash * 0.005 / abs(o - stop), cash * 2 / (o * (1 + 2 * friction)))
                cash -= qty * o * friction
                pos = (side, qty, o, stop, target, i)
                position_paid = 0
        if pos:
            side, qty, _entry, stop, target, _j = pos
            adverse, favorable = (low, h) if side > 0 else (h, low)
            exit_price = (
                stop if side * (adverse - stop) <= 0 else target if side * (favorable - target) >= 0 else None
            )
            if exit_price is not None:
                cash += exit_position(i, exit_price, pos)
                pos = None
    equity = cash + (pos[0] * pos[1] * (rows[-1][3] - pos[2]) if pos else 0)
    assert len(trades) == len(row["trades"]), "TRADE_COUNT"
    for a, b in zip(trades, row["trades"]):
        for actual, key in zip(a, ["entry", "exit", "qty", "open", "price", "pnl"]):
            assert isclose(actual, b[key], rel_tol=1e-10, abs_tol=1e-6), key
    assert isclose(equity / capital - 1, row["return"], abs_tol=1e-10), "RETURN"
    return {
        "venue": "hyperliquid",
        "minutes": len(rows),
        "btcPrints": sum(map(len, bars.values())),
        "openInterestObservations": len(interest),
        "matchedTrades": len(trades),
        "netReturn": equity / capital - 1,
        "fundingEvents": len(payments),
        "fundingCashflow": paid,
        "scientificHash": artifact.name.split(".")[0],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    parser.add_argument("archive_cache", type=Path)
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.cache, args.archive_cache, args.artifact)))
