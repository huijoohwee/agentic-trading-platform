"""Install rights-reviewed hourly pool observations as immutable UTC partitions."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

import duckdb

RECORD = 'https://zenodo.org/records/17302324'
SOURCE = RECORD + '/files/pool_hourly_data.parquet'
DIGEST = 'ed88166e388b3acf000783c354ba5888434f4c22a50c8e120cd8a6bb3dbdc58f'
CREATORS = 'Zhou Qingran, Liu Eric and Alessio Brini'
# Price in the publisher's table is token0 units per token1. Keep base-unit volume.
POOLS = {
    'USDC_WETH_500': [('WETH', 'USDC', False), ('USDC', 'WETH', True)],
    'DAI_WETH_500': [('WETH', 'DAI', False), ('DAI', 'WETH', True)],
    'WETH_USDT_500': [('WETH', 'USDT', True)],
    'WBTC_WETH_500': [('WBTC', 'WETH', True)],
}


def encode(item):
    return json.dumps(item, allow_nan=False, separators=(',', ':'), sort_keys=True).encode()


@contextmanager
def locked(directory):
    with (directory / '.import.lock').open('a+b') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def activate(directory, stage, manifest):
    dest = directory / 'partitions'
    dest.mkdir(mode=0o700, exist_ok=True)
    entries = {p['file']: p for p in manifest['partitions']}
    with locked(directory):
        head = dest / 'manifest.json'
        if head.exists():
            old = json.loads(head.read_bytes())
            if old.get('schema') != manifest['schema'] or any(entries.get(p['file']) != p for p in old['partitions']):
                raise ValueError('EXISTING_PARTITION_MANIFEST_DIFFERS')
        for name, part in entries.items():
            try:
                os.link(stage / name, dest / name)
            except FileExistsError:
                if hashlib.sha256((dest / name).read_bytes()).hexdigest() != part['sha256']:
                    raise ValueError('EXISTING_PARTITION_INTEGRITY')
        (stage / 'manifest.json').write_bytes(encode(manifest))
        os.replace(stage / 'manifest.json', head)


def install(directory, local_file):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=directory, prefix='.pools-') as tmp:
        stage = Path(tmp)
        file = local_file or stage / 'data.parquet'
        if not local_file:
            subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--max-redirs', '2',
                            '--proto', '=https', '--proto-redir', '=https', '--max-filesize', '16000000',
                            '--max-time', '90', '--output', str(file), SOURCE + '?download=1'], check=True)
        if file.stat().st_size > 16_000_000 or hashlib.sha256(file.read_bytes()).hexdigest() != DIGEST:
            raise ValueError('ARCHIVE_DIGEST_MISMATCH')
        manifest = {'schema': 'trading-partitions/v1', 'timeUnit': 'UTC_ms', 'partitions': []}
        with duckdb.connect() as con:
            for name, markets in POOLS.items():
                rows = con.execute("""select epoch_ms(periodStartUnix), open, high, low, close,
                    volumeToken0, volumeToken1, poolId, missing from read_parquet(?)
                    where pool_name=? order by periodStartUnix""", [str(file), name]).fetchall()
                for base, quote, invert in markets:
                    bars = []
                    for t, o, h, l, c, v0, v1, pool, missing in rows:
                        if missing or min(o, h, l, c) <= 0 or h < max(o, c) or l > min(o, c):
                            continue
                        if invert:
                            o, h, l, c = 1/o, 1/l, 1/h, 1/c
                        bars.append(dict(time=t, open=o, high=h, low=l, close=c, volume=v0 if invert else v1))
                    for pos in range(0, len(bars), 1500):
                        chunk = bars[pos:pos+1500]
                        body = encode(chunk)
                        if len(body) >= 500000:
                            raise ValueError('PARTITION_BYTE_LIMIT')
                        digest = hashlib.sha256(body).hexdigest()
                        filename = digest + '.json'
                        (stage / filename).write_bytes(body)
                        manifest['partitions'].append(dict(
                            kind='ohlcv', frame='1h', venue='uniswap-v3-500', symbol=base+'.'+quote,
                            marketType='spot', poolId=rows[0][7], feeTier=500, volumeUnit=base, quote=quote,
                            source=RECORD, upstreamSha256=DIGEST, creator=CREATORS, license='CC-BY-4.0',
                            file=filename, sha256=digest, first=chunk[0]['time'], last=chunk[-1]['time'],
                            sourceExcluded=len(rows)-len(bars)))
        activate(directory, stage, manifest)
        print(json.dumps({'source': RECORD, 'sha256': DIGEST, 'manifestSha256': hashlib.sha256(encode(manifest)).hexdigest(),
                          'venue': 'uniswap-v3-500', 'partitions': len(manifest['partitions']), 'license': 'CC-BY-4.0', 'hardCapUsd': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path('.runtime-private/desk'))
    parser.add_argument('--file', type=Path)
    args = parser.parse_args()
    install(args.directory, args.file)
