"""Build a local, fixed-inventory ZIP from the sealed browser output and headless replay."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from zipfile import ZIP_BZIP2, ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent.parent
build = Path(subprocess.check_output(['node', 'scripts/build.mjs'], cwd=root, text=True).strip())
manifest = json.loads((build / 'asset-manifest.json').read_bytes())
sha = lambda body: hashlib.sha256(body).hexdigest()
if build.name != manifest['id']:
    raise ValueError('Sealed build identity changed')
# Include only the builder's checked files and explicit CLI inputs. Never walk the working tree.
files = {}
for name, digest in manifest['files'].items():
    body = (build / name).read_bytes()
    if sha(body) != digest:
        raise ValueError('Sealed file changed: ' + name)
    files[name] = body
files['asset-manifest.json'] = (build / 'asset-manifest.json').read_bytes()
for name in ['scripts/local-file.mjs', 'scripts/rehearse.mjs', 'scripts/audit.mjs', 'test/rehearsal.test.mjs', 'test/forward-schedule.test.mjs',
             'test/local-audit.test.mjs', 'test/cash-oracle.py', 'src/forward-bindings.mjs', 'src/binding-fixture.json',
             'scripts/local-server.mjs', 'scripts/serve-package.mjs', 'runtime/practice-http.mjs',
             'scripts/import-pool-history.py','scripts/collect-public-market.py','scripts/check-pool-history.mjs','scripts/verify-pool-history.py','scripts/verify-pool-rotation.py','scripts/publish-market-snapshot.mjs',
             'scripts/observer-server.mjs','runtime/observer.mjs','runtime/desk-reads.mjs','runtime/market-library.mjs','runtime/public-feed.mjs','runtime/practice-prices.mjs',
             'runtime/research-service.mjs','runtime/research-worker.mjs','runtime/research-artifact.mjs','runtime/research-data.mjs','runtime/research-engine.mjs',
             'runtime/research-signals.mjs','runtime/research-events.mjs','runtime/research-portfolio.mjs','runtime/research-statistics.mjs','runtime/practice-domain.mjs', 'runtime/practice-replay.mjs', 'runtime/strategy-worker.mjs',
             'runtime/gateway.mjs', 'runtime/gateway-mcp.mjs', 'runtime/paper-guard.mjs', 'runtime/store.mjs', 'runtime/core.mjs']:
    files[name] = (root / name).read_bytes()
files['server-policy.json'] = subprocess.check_output([
    'node', '--input-type=module', '-e',
    "import {loadCommercePolicies} from './scripts/serve.mjs'; console.log(JSON.stringify((await loadCommercePolicies()).LOCAL_FIRST_CSP))",
], cwd=root)
files['README.md'] = b'''# Offline trading replay

Use Node 22.22+ and Python 3. The samples use synthetic paper observations.
From the extracted directory run these checks without accounts or package installation.

    node --test test/*.test.mjs
    node scripts/rehearse.mjs
    node scripts/rehearse.mjs --schedule
    node scripts/rehearse.mjs --bindings
    node scripts/audit.mjs

Run A records 23 practice events. Run B records 26 competition-fixture events and
100835371050 millionths of a USD in final ranked equity. Both check 59 rule examples.

For the dashboard, run the following local server and open http://127.0.0.1:4181.
After Offline ready, disconnect and open the two rehearsal disclosures.

    node scripts/serve-package.mjs

Open /desk.html for the paper trading desk. The loopback process saves anonymous
practice sessions in .runtime-private/desk. Its price path, market events, strategy
worker and journal run locally. Keep the folder private when backing up a session.

The sealed site includes its source-owner manifest and notices. SHA256SUMS covers
every file except the checksum list itself. Verify with shasum -a 256 -c SHA256SUMS.
The package provides local replay evidence. Entrant eligibility, hosted runs, actual
simulator results, judge access and a Qoder-generated presentation require separate evidence.
'''
files['SHA256SUMS'] = ''.join(sha(body) + '  ' + name + '\n' for name, body in sorted(files.items())).encode()
if any(len(body) >= 500_000 for body in files.values()):
    raise ValueError('A package input exceeds the chunk budget')
with tempfile.NamedTemporaryFile(dir=build.parent, suffix='.zip') as stage:
    with ZipFile(stage, 'w', compression=ZIP_DEFLATED) as archive:
        for name, body in sorted(files.items()):
            entry = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            # Use standard ZIP method 12 for the two largest sealed assets.
            # Python's zipfile and libarchive extract both methods without add-ons.
            dense = name in ('owners/base/packages/views-react/dist/browser-data-view.js',
                             'qualification/moomoo/route-inventory.json')
            archive.writestr(entry, body, compress_type=ZIP_BZIP2 if dense else ZIP_DEFLATED, compresslevel=9)
    stage.flush()
    body = Path(stage.name).read_bytes()
    if len(body) >= 500_000:
        raise ValueError(f'Replay package exceeds the chunk budget ({len(body)} bytes)')
    destination = build.parent / ('trading-replay-' + sha(body) + '.zip')
    try:
        os.link(stage.name, destination)
    except FileExistsError:
        if destination.is_symlink() or destination.read_bytes() != body:
            raise ValueError('Retained package differs')
print(destination)
