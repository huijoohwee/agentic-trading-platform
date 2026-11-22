"""Collect opt-in, attributed Bybit ETH/USDT depth from CostDepth's published API."""
import hashlib
import json
import os
import tempfile
from pathlib import Path
from time import time
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, build_opener

from archive_partitions import locked

HOST = "https://www.costdepth.io"
SOURCE = HOST + "/developers#license"
CREATOR = "Alex Wu / CostDepth"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "Unexpected provider redirect", headers, fp)


def fetch(path, limit):
    with build_opener(NoRedirect()).open(HOST + path, timeout=12) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("PROVIDER_BYTE_LIMIT")
    return data


def install_once(path, data):
    with tempfile.TemporaryDirectory(dir=path.parent) as tmp:
        staged = Path(tmp) / "receipt"
        staged.write_bytes(data)
        staged.chmod(0o600)
        os.link(staged, path)


def admit(directory):
    folder = directory / "feed"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    grant = fetch("/openapi.json", 65536)
    policy = json.loads(grant)["info"]["license"]
    if policy["url"] != SOURCE or policy["name"] != "CC BY 4.0: free to use with attribution to costdepth.io":
        raise ValueError("PUBLISHED_GRANT_CHANGED")
    digest = hashlib.sha256(grant).hexdigest()
    rights_file = folder / (digest + ".rights")
    try:
        install_once(rights_file, grant)
    except FileExistsError:
        if rights_file.is_symlink() or rights_file.read_bytes() != grant:
            raise ValueError("RIGHTS_INTEGRITY")
    admission = dict(venue="bybit", symbol="ETH.USDT", currency="USDT", source=SOURCE,
                     license="CC-BY-4.0", creator=CREATOR, hardCapUsd=0, allowPublicDisplay=True,
                     rightsDigest=digest, expires=int(time()*1000) + 30*86400000, coverage="depth")
    entries = [dict(admission, marketType="spot"), dict(admission, marketType="perpetual", settlement="USDT")]
    path = folder / "admission.json"
    with locked(folder):
        if path.is_symlink() or (path.exists() and (not path.is_file() or path.stat().st_size > 200000)):
            raise ValueError("FEED_ADMISSION")
        original = path.read_bytes() if path.exists() else None
        doc = json.loads(original) if original is not None else {"schema": "public-market-admission/v1", "markets": []}
        if doc.get("schema") != "public-market-admission/v1" or not isinstance(doc.get("markets"), list):
            raise ValueError("FEED_ADMISSION")
        changed = False
        for expected in entries:
            matches = [m for m in doc["markets"] if all(m.get(k) == expected[k] for k in ("venue", "symbol", "marketType"))]
            if not matches:
                doc["markets"].append(expected)
                changed = True
                continue
            if len(matches) != 1 or any(matches[0].get(k) != v for k, v in expected.items() if k != "expires"):
                raise ValueError("EXISTING_MARKET_BINDING_DIFFERS")
            if matches[0]["expires"] <= time() * 1000:
                matches[0]["expires"] = expected["expires"]
                changed = True
        if changed:
            body = json.dumps(doc, indent=2).encode()
            if len(body) > 200000 or len(doc["markets"]) > 1000:
                raise ValueError("FEED_ADMISSION")
            with tempfile.TemporaryDirectory(dir=folder) as tmp:
                staged = Path(tmp) / "admission.json"
                staged.write_bytes(body)
                staged.chmod(0o600)
                os.replace(staged, path)
    return digest


def collect(market, capture=None):
    if (market.get("source") != SOURCE or market.get("license") != "CC-BY-4.0"
            or market.get("creator") != CREATOR or market.get("coverage") != "depth"
            or market["venue"] != "bybit" or market["symbol"] != "ETH.USDT" or market["currency"] != "USDT"
            or (market["marketType"] == "perpetual" and market.get("settlement") != "USDT")):
        raise ValueError("REVIEWED_DEPTH_BINDING_REQUIRED")
    kind = {"spot": "spot", "perpetual": "perp"}[market["marketType"]]
    data = fetch("/api/book?ex=bybit&m=" + kind + "&c=ETH", 65536)
    raw = json.loads(data)
    if raw.get("ok") is not True or raw.get("suspect") or not raw.get("book"):
        raise ValueError("UNAVAILABLE_PROVIDER_BOOK")
    book = raw["book"]
    stamp = book["ts"]
    if type(stamp) is not int or not 0 <= int(time()*1000) - stamp <= 15000:
        raise ValueError("COLLECTOR_STALE")
    snap = {k: market[k] for k in ("venue", "marketType", "symbol", "currency", "coverage")}
    for side in ("bids", "asks"):
        snap[side] = [dict(price=p, amount=n) for p,n in book[side][:20]]
    if capture:
        with capture.open("xb") as out:
            out.write(data)
    snap.update(upstreamSha256=hashlib.sha256(data).hexdigest(), rightsDigest=market["rightsDigest"])
    return dict(snap, schema="public-market-snapshot/v1", at=stamp, bookAt=stamp, sequence=stamp, timeUnits="UTC_ms")
