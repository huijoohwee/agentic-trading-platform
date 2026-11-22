"""Optional packaging check, using the same local dependencies as the ZIP inspector."""
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile

script = Path(__file__).resolve().parent.parent / 'scripts/inspect-skill.py'
with TemporaryDirectory() as temp:
    path = Path(temp) / 'rehearse.zip'
    def inspect(extra=None, metadata='rehearse', href='ref/note.md'):
        with ZipFile(path, 'w') as archive:
            archive.writestr('rehearse/SKILL.md', '---\nname: ' + metadata + '\ndescription: >-\n  A fixture.\n---\n'
                             'Read [evidence][n].\n\n[n]: ' + href + '\n')
            archive.writestr('rehearse/ref/note.md', 'Evidence\n')
            if extra:
                archive.writestr(extra, 'fixture')
        return subprocess.run([sys.executable,str(script),str(path)],capture_output=True,text=True)
    valid = inspect()
    assert valid.returncode == 0, valid.stderr
    assert json.loads(valid.stdout)['authority'] is False
    for case in [dict(extra='second/SKILL.md'), dict(extra='rehearse/.env'), dict(metadata='different'),
                 dict(href='missing.md'), dict(href='../outside.md')]:
        assert inspect(**case).returncode != 0, case
print('Six local ZIP cases passed')
