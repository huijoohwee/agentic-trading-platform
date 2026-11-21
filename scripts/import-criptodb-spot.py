"""Install complete UTC spot days from the CC BY 4.0 CriptoDB May 2025 BitMEX deposit."""

import argparse
import gzip
import hashlib
import json
import math
import tempfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from archive_partitions import activate, encode, verified_download

SOURCE = "https://doi.org/10.21950/HFPJ2F"
FILE = "https://edatos.consorciomadrono.es/api/access/datafile/38928"
DIGEST = "ed71f78293a540a1da767d281302fa3e8f626ad6a779841e2d45c99f17487b78"
UNITS = {"btc__usdt": 10**8, "eth__usdt": 10**9, "sol__usdt": 10**9}
DAY = 86_400_000


def spot_minutes(file):
    markets = defaultdict(dict)
    with gzip.open(file, "rt", encoding="utf-8") as lines:
        for line in lines:
            row = line.rstrip("\n").split("\t")
            instrument = row[-1]
            if instrument not in UNITS:
                continue
            stamp, _, high, low, close, size, count, base_volume, _ = row
            if stamp.endswith("+00"):
                stamp += ":00"
            date = datetime.fromisoformat(stamp)
            if date.utcoffset() is None or date.utcoffset().total_seconds() != 0:
                raise ValueError("ARCHIVE_UTC_TIME_REQUIRED")
            time = int(date.timestamp() * 1000)
            if time % 60_000 or time in markets[instrument]:
                raise ValueError("ARCHIVE_MINUTE_BINDING")
            high, low, close, size, base_volume = map(float, (high, low, close, size, base_volume))
            count = int(count)
            if (not all(map(math.isfinite, (high, low, close, size, base_volume)))
                    or not 0 < low <= close <= high or size < 0 or count < 0
                    or (count > 0) != (size > 0)
                    or not math.isclose(size / UNITS[instrument], base_volume, rel_tol=1e-10)):
                raise ValueError("ARCHIVE_SPOT_UNITS")
            markets[instrument][time] = (high, low, close, base_volume)
    return markets


def complete_days(minutes):
    result = []
    first = min(minutes) // DAY * DAY
    for start in range(first, max(minutes), DAY):
        end = start + DAY
        # Both boundary minutes must be present and empty. The trades then belong
        # to this UTC day under either a start-stamped or end-stamped archive.
        if any(t not in minutes or minutes[t][3] != 0 for t in (start, end)):
            continue
        window = [minutes.get(t) for t in range(start, end, 60_000)]
        if None in window:
            continue
        trades = [bar for bar in window if bar[3] > 0]
        # The venue's published open is the previous close. A first nonempty
        # minute with a single price identifies the observed daily opening trade.
        if not trades or trades[0][0] != trades[0][1]:
            continue
        result.append(dict(time=start, open=trades[0][0], high=max(b[0] for b in trades),
                           low=min(b[1] for b in trades), close=trades[-1][2],
                           volume=math.fsum(b[3] for b in trades)))
    return result


def install(directory, cache):
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    cache.mkdir(parents=True, mode=0o700, exist_ok=True)
    file = verified_download(cache / "14119.dat.gz", FILE, 19_160_644, DIGEST)
    markets = spot_minutes(file)
    with tempfile.TemporaryDirectory(dir=directory) as tmp:
        stage = Path(tmp)
        parts = []
        for instrument in UNITS:
            rows = complete_days(markets[instrument])
            if not rows:
                raise ValueError("NO_VERIFIED_DAILY_BARS")
            body = encode(rows)
            digest = hashlib.sha256(body).hexdigest()
            name = digest + ".json"
            (stage / name).write_bytes(body)
            base = instrument.split("__")[0].upper()
            parts.append(dict(venue="bitmex", symbol=base + ".USDT", marketType="spot", kind="ohlcv",
                              frame="1d", quote="USDT", volumeUnit=base, source=SOURCE, sourceFile=FILE,
                              creator="Ángel Hernando-Veciana (CriptoDB)", license="CC-BY-4.0",
                              licenseUrl="https://creativecommons.org/licenses/by/4.0/", upstreamSha256=DIGEST,
                              file=name, sha256=digest, first=rows[0]["time"], last=rows[-1]["time"],
                              observedMinutes=len(markets[instrument]), completeDays=len(rows)))
        activate(directory, stage, {"schema": "trading-partitions/v1", "timeUnit": "UTC_ms", "partitions": parts})
    return {p["symbol"]: p["completeDays"] for p in parts}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("cache", type=Path)
    args = parser.parse_args()
    print(json.dumps(install(args.directory, args.cache)))
