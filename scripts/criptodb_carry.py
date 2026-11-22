"""Map the May 2025 CriptoDB Binance deposit to matched hourly BTC/USDT inputs."""

import gzip
import hashlib
import math
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from archive_partitions import activate, encode, verified_download

HOUR = 3_600_000
MINUTE = 60_000
BARS = (39130, 332785405, "786b52c1a314def166c9c1618a30dc1db111eb675c72382c4c92e09a9f7da36e")
FUNDING = (38731, 7108534, "f5ae020813a3b30947fbddc1762b90d447fbb33456b75d9d9129dcb772f73e57")
# The publisher omits all three May 20 settlements. End before the first missing payment.
END = 1747699200000  # May 20 2025, 00:00 UTC
LEGS = {b"btc__usdt": "spot", b"btc__usdt__perp": "perpetual"}


def utc(value):
    text = value.decode()
    text += ":00" if text.endswith("+00") else ""
    stamp = datetime.strptime(text, "%Y-%m-%d %H:%M:%S.%f%z") if "." in text else datetime.fromisoformat(text)
    if stamp.utcoffset() != timedelta(0) or stamp.microsecond % 1000:
        raise ValueError("ARCHIVE_UTC_TIME_REQUIRED")
    return int(stamp.timestamp()) * 1000 + stamp.microsecond // 1000


def hourly(path):
    minutes = {leg: defaultdict(dict) for leg in LEGS.values()}
    with gzip.open(path, "rb") as lines:
        for line in lines:
            if b"\tbtc__usdt" not in line:
                continue
            fields = line.rstrip().split(b"\t")
            leg = LEGS.get(fields[-1])
            if not leg:
                continue
            stamp, op, hi, lo, cl, vol, count, turnover, _ = fields
            t = utc(stamp)
            if t >= END:
                continue
            o, h, l, c, v, q = map(float, (op, hi, lo, cl, vol, turnover))
            group = minutes[leg][t // HOUR * HOUR]
            if (t % MINUTE or t in group or not all(map(math.isfinite, (o, h, l, c, v, q)))
                    or not 0 < l <= min(o, c) <= max(o, c) <= h or v < 0 or q < 0
                    or int(count) < 0 or (int(count) > 0) != (v > 0)
                    or not l * v - 0.0001 <= q <= h * v + 0.0001):
                raise ValueError("ARCHIVE_MINUTE_BINDING")
            group[t] = (o, h, l, c, v, q)
    bars = {}
    amounts = {}
    for leg, groups in minutes.items():
        bars[leg], amounts[leg] = [], {}
        for t, group in sorted(groups.items()):
            if len(group) != 60:
                continue
            values = [group[t + i * MINUTE] for i in range(60)]
            bars[leg].append(dict(time=t, open=values[0][0], high=max(r[1] for r in values),
                                  low=min(r[2] for r in values), close=values[-1][3],
                                  volume=math.fsum(r[4] for r in values)))
            amounts[leg][t] = math.fsum(r[5] for r in values)
    common = sorted(amounts["spot"].keys() & amounts["perpetual"].keys())
    if not common:
        raise ValueError("ARCHIVE_NO_MATCHED_HOURS")
    liquidity = [dict(time=t + HOUR, spotTurnover=amounts["spot"][t],
                      perpetualTurnover=amounts["perpetual"][t]) for t in common]
    return bars, liquidity


def settlements(path, first, last):
    events = {}
    with gzip.open(path, "rb") as lines:
        for line in lines:
            if not line.rstrip().endswith(b"\tbtc__usdt"):
                continue
            stamp, rate, _ = line.rstrip().split(b"\t")
            t = utc(stamp)
            if first <= t <= last:
                r = float(rate)
                if not math.isfinite(r) or t in events or t % (8 * HOUR) > 1000:
                    raise ValueError("ARCHIVE_FUNDING_SETTLEMENT")
                events[t] = dict(time=t, rate=r, settled=True, settlementHours=8)
    result = [v for _, v in sorted(events.items())]
    if not result or any(b["time"] // (8 * HOUR) - a["time"] // (8 * HOUR) != 1
                         for a, b in zip(result, result[1:])):
        raise ValueError("ARCHIVE_FUNDING_GAP")
    return result


def install(directory, cache, source):
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    cache.mkdir(parents=True, mode=0o700, exist_ok=True)
    root = "https://edatos.consorciomadrono.es/api/access/datafile/"
    def fetch(spec):
        number, size, digest = spec
        return verified_download(cache / (str(number) + ".dat.gz"), root + str(number), size, digest)
    bars, liquidity = hourly(fetch(BARS))
    funding = settlements(fetch(FUNDING), liquidity[0]["time"] - 8 * 24 * HOUR, liquidity[-1]["time"])
    with tempfile.TemporaryDirectory(dir=directory) as tmp:
        stage, parts = Path(tmp), []
        def stage_rows(leg, kind, rows, spec, **meta):
            body = encode(rows)
            if len(body) >= 500000:
                raise ValueError("PARTITION_BYTE_LIMIT")
            digest = hashlib.sha256(body).hexdigest()
            name = digest + ".json"
            (stage / name).write_bytes(body)
            parts.append(dict(venue="binance", symbol="BTC.USDT", marketType=leg, kind=kind, source=source,
                              creator="Ángel Hernando-Veciana (CriptoDB)", license="CC-BY-4.0",
                              licenseUrl="https://creativecommons.org/licenses/by/4.0/",
                              sourceFile=root + str(spec[0]), upstreamSha256=spec[2], file=name, sha256=digest,
                              first=rows[0]["time"], last=rows[-1]["time"], **meta))
        for leg, rows in bars.items():
            stage_rows(leg, "ohlcv", rows, BARS, frame="1h", volumeUnit="BTC",
                       **({"settlement": "USDT"} if leg == "perpetual" else {}))
        stage_rows("perpetual", "liquidity", liquidity, BARS, mapping="matched-hour-turnover/v1")
        stage_rows("perpetual", "funding", funding, FUNDING)
        activate(directory, stage, {"schema": "trading-partitions/v1", "timeUnit": "UTC_ms", "partitions": parts})
    return {"hours": {key: len(rows) for key, rows in bars.items()}, "matchedHours": len(liquidity),
            "settlements": len(funding)}
