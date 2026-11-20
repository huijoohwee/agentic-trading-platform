"""Check one operator-selected local skill archive; writes and uploads nothing."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import sys
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile

try:
    import yaml
    from markdown_it import MarkdownIt
except ImportError:
    sys.exit('The optional ZIP inspector needs locally installed PyYAML and markdown-it-py')

LIMIT = 50_000_000
# The provider ZIP limit and this local expanded-byte/entry inspection budget are separate.
MAX_ENTRIES = 4096
PRIVATE_FILES = {'.git', '.svn', '__MACOSX', '.DS_Store', 'Thumbs.db', '__pycache__', '.npmrc', '.pypirc'}
def destinations(tokens):
    for token in tokens:
        if token.type in ('link_open', 'image'):
            yield token.attrGet('href' if token.type == 'link_open' else 'src')
        if token.children:
            yield from destinations(token.children)

def inspect(path):
    with path.open('rb') as source:
        body = source.read(LIMIT)
    if len(body) >= LIMIT:
        raise ValueError('ZIP must be under 50 MB')
    with ZipFile(io.BytesIO(body)) as archive:
        infos = archive.infolist()
        if not 1 <= len(infos) <= MAX_ENTRIES or sum(i.file_size for i in infos) >= LIMIT:
            raise ValueError('Archive exceeds local inspection budget')
        files, seen, roots, markdown = set(), set(), set(), {}
        for entry in infos:
            name = entry.filename.removesuffix('/')
            parts = name.split('/')
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if (not name or any(p in ('', '.', '..') or p in PRIVATE_FILES or p.startswith(('.env', '._'))
                                or p.lower().endswith(('.pem', '.key')) for p in parts)
                    or '\\' in name or ':' in name or any(ord(c) < 32 for c in name)
                    or mode not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.flag_bits & 1):
                raise ValueError('Invalid archive member')
            if name.casefold() in seen:
                raise ValueError('Duplicate archive member')
            seen.add(name.casefold())
            roots.add(parts[0])
            if not entry.is_dir():
                if len(parts) == 1:
                    raise ValueError('Expected one skill directory')
                data = archive.read(entry)  # verifies CRC without extracting or executing content
                files.add(name)
                if re.search(rb'-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|(?:ghp_|github_pat_|xox[bap]-)[A-Za-z0-9_-]{16,}', data):
                    raise ValueError('Secret material detected')
                if name.lower().endswith('.md'):
                    markdown[name] = data.decode('utf-8')
        if any(str(parent) in files for name in files for parent in PurePosixPath(name).parents):
            raise ValueError('A file also appears as a directory')
        if len(roots) != 1:
            raise ValueError('Expected one top-level skill directory')
        folder = roots.pop()
        entrypoint = folder + '/SKILL.md'
        if [n for n in files if PurePosixPath(n).name == 'SKILL.md'] != [entrypoint]:
            raise ValueError('Expected one SKILL.md at the root of the selected skill')
        source = markdown[entrypoint].replace('\r\n','\n')
        match = re.match(r'\A---\n(.*?)\n---(?:\n|$)', source, re.S)
        if not match or len(match[1].encode()) > 8192:
            raise ValueError('Missing or oversized YAML frontmatter')
        front = yaml.safe_load(match[1])
        if not isinstance(front, dict):
            raise ValueError('Invalid skill frontmatter')
        name, description = front.get('name'), front.get('description')
        if name != folder or not isinstance(description,str) or not description.strip():
            raise ValueError('Skill name or description does not match the package contract')
        parser = MarkdownIt('commonmark')
        for doc, source in markdown.items():
            for href in destinations(parser.parse(source)):
                ref = urlsplit(href)
                if ref.scheme in ('https','http','mailto'):
                    continue
                if ref.scheme or ref.netloc:
                    raise ValueError('Unexpected URI scheme or authority')
                if not ref.path:
                    continue
                target = posixpath.normpath(posixpath.join(posixpath.dirname(doc), unquote(ref.path)))
                if not target.startswith(folder+'/') or target not in files:
                    raise ValueError('Unresolved relative resource in ' + doc)
    return dict(name=name, files=len(files), sha256=hashlib.sha256(body).hexdigest(),
                scope='local ZIP structure and Markdown resources', authority=False)

if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('Usage: python3 scripts/inspect-skill.py SKILL.zip')
    try:
        print(json.dumps(inspect(Path(sys.argv[1]))))
    except Exception as error:
        sys.exit(str(error))
