"""Install source-qualified partitions under a lock shared by local data importers."""

import fcntl
import hashlib
import json
import os
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from urllib.request import HTTPRedirectHandler, build_opener


class HttpsRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise ValueError("ARCHIVE_REDIRECT")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def verified_download(path, url, size, expected):
    if not path.exists():
        if not url.startswith("https://"):
            raise ValueError("ARCHIVE_SOURCE")
        with build_opener(HttpsRedirect()).open(url, timeout=45) as response:
            body = response.read(size + 1)
        if len(body) != size or hashlib.sha256(body).hexdigest() != expected:
            raise ValueError("UPSTREAM_INTEGRITY: " + str(path))
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
            tmp.write(body)
        Path(tmp.name).replace(path)
    if path.stat().st_size != size or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError("UPSTREAM_INTEGRITY: " + str(path))
    return path


@contextmanager
def lz4_lines(path):
    with subprocess.Popen(["lz4", "-dc", str(path)], stdout=subprocess.PIPE, text=True) as proc:
        try:
            yield proc.stdout
        finally:
            proc.stdout.close()
        if proc.wait():
            raise ValueError("LZ4_INTEGRITY: " + str(path))


def encode(item):
    return json.dumps(item, allow_nan=False, separators=(",", ":"), sort_keys=True).encode()


@contextmanager
def locked(directory):
    with (directory / ".import.lock").open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def activate(directory, stage, manifest):
    dest = directory / "partitions"
    dest.mkdir(mode=0o700, exist_ok=True)
    with locked(directory):
        head = dest / "manifest.json"
        old = json.loads(head.read_bytes()) if head.exists() else {**manifest, "partitions": []}
        if (old["schema"], old["timeUnit"]) != (manifest["schema"], manifest["timeUnit"]):
            raise ValueError("EXISTING_PARTITION_MANIFEST_DIFFERS")

        def lane(p):
            return (p["venue"], p["marketType"], p["symbol"], p["kind"], p.get("frame", ""))

        entries = {(lane(p), p["first"], p["last"]): p for p in old["partitions"]}
        for p in manifest["partitions"]:
            key = (lane(p), p["first"], p["last"])
            if key in entries and entries[key] != p:
                raise ValueError("EXISTING_PARTITION_MANIFEST_DIFFERS")
            entries[key] = p
        ordered = sorted(entries)
        if any(a[0] == b[0] and a[2] >= b[1] for a, b in zip(ordered, ordered[1:])):
            raise ValueError("OVERLAPPING_PARTITIONS")
        # Preserve the original order for consumers that already hashed these inputs.
        body = encode({**old, "partitions": list(entries.values())})
        if len(body) >= 500000 or len(entries) > 4096:
            raise ValueError("PARTITION_MANIFEST_LIMIT")
        for p in manifest["partitions"]:
            name = p["file"]
            if name != p["sha256"] + ".json":
                raise ValueError("PARTITION_FILE_NAME")
            try:
                os.link(stage / name, dest / name)
            except FileExistsError:
                if hashlib.sha256((dest / name).read_bytes()).hexdigest() != p["sha256"]:
                    raise ValueError("EXISTING_PARTITION_INTEGRITY")
        (stage / "manifest.json").write_bytes(body)
        os.replace(stage / "manifest.json", head)
