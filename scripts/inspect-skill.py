"""Inspect local ZIP bytes only; never extract, execute, install or grant authority."""
import argparse
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import unicodedata
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile, ZIP_STORED, ZIP_DEFLATED

LIMIT = 50_000_000  # Strictly below the conservative decimal-byte boundary.
MAX_ENTRIES = 4096
PRIVATE_FILES = {'.git', '.gitignore', '.gitattributes', '.gitmodules', '.svn', '.hg',
                 '__macosx', '.ds_store', 'thumbs.db', '__pycache__', '.npmrc', '.pypirc',
                 '.aws', '.ssh', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519',
                 '.netrc', '_netrc', '.git-credentials', '.dockercfg', '.docker',
                 '.boto', '.s3cfg', '.pgpass', 'pgpass.conf', '.my.cnf', '.mylogin.cnf',
                 'application_default_credentials.json', 'credentials.db', 'access_tokens.db'}
SECRET = re.compile(
    rb'-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}'
    rb'|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-[A-Za-z0-9_-]{20,}'
    rb'|(?i:(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)[\"\']?\s*[:=]\s*'
    rb'[\"\']?[A-Za-z0-9/+_=-]{16,})')


def digest(body):
    return hashlib.sha256(body).hexdigest()


def inventory(files):
    return {name: digest(files[name]) for name in sorted(files)}


def clean_path(name):
    if not isinstance(name, str) or not name or len(name.encode('utf-8')) > 1024:
        raise ValueError('Invalid member path')
    parts = name.split('/')
    if ('\\' in name or ':' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(p in ('', '.', '..') or p.endswith((' ', '.')) for p in parts)):
        raise ValueError('Unsafe member path')
    for part in parts:
        key = part.casefold()
        if (key in PRIVATE_FILES or key.startswith(('.env', '._', '.git'))
                or key.endswith(('.pem', '.key', '.p12', '.pfx', '.pyc'))):
            raise ValueError('Private file or Git/OS debris')
    return parts


def check_paths(entries):
    explicit, nodes = set(), {}
    for name, directory in entries:
        parts = clean_path(name)
        key = unicodedata.normalize('NFC', name).casefold()
        if key in explicit:
            raise ValueError('Duplicate archive member')
        explicit.add(key)
        for index in range(1, len(parts) + 1):
            path = '/'.join(parts[:index])
            folded = unicodedata.normalize('NFC', path).casefold()
            is_dir = index < len(parts) or directory
            previous = nodes.get(folded)
            if previous is not None and previous != (path, is_dir):
                raise ValueError('Casefold collision or file-directory conflict')
            nodes[folded] = (path, is_dir)


@contextmanager
def parent_fd(path):
    path = Path(path).absolute()
    if '..' in path.parts:
        raise ValueError('Parent traversal in local path')
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd, path.name
    finally:
        os.close(fd)


def read_local(path, limit=LIMIT):
    with parent_fd(path) as (parent, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise ValueError('Expected a regular local file')
            body = source.read(limit)
    if len(body) >= limit:
        raise ValueError('Local file must be below byte limit')
    return body


def check_secret(data):
    if SECRET.search(data):
        raise ValueError('Secret material detected')


def read_zip(body):
    if len(body) >= LIMIT:
        raise ValueError('ZIP must be under 50 MB (50,000,000 bytes)')
    with ZipFile(io.BytesIO(body)) as archive:
        check_secret(archive.comment)
        infos = archive.infolist()
        if not 1 <= len(infos) <= MAX_ENTRIES or sum(i.file_size for i in infos) >= LIMIT:
            raise ValueError('Archive exceeds local inspection budget')
        entries = []
        for entry in infos:
            check_secret(entry.comment)
            check_secret(entry.extra)
            mode = stat.S_IFMT(entry.external_attr >> 16)
            directory = entry.is_dir()
            if (entry.orig_filename != entry.filename or entry.flag_bits & 1
                    or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED)
                    or mode not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or (mode == stat.S_IFDIR and not directory)
                    or (mode == stat.S_IFREG and directory)
                    or (directory and entry.file_size)):
                raise ValueError('Invalid archive member type or encoding')
            entries.append((entry.filename[:-1] if directory else entry.filename, directory))
        check_paths(entries)
        files, expanded = {}, 0
        for entry in infos:
            with archive.open(entry) as stream:
                data = stream.read(LIMIT - expanded)
            expanded += len(data)
            if expanded >= LIMIT or len(data) != entry.file_size:
                raise ValueError('Expanded ZIP exceeds inspection budget')
            check_secret(data)
            if not entry.is_dir():
                files[entry.filename] = data
        return files, entries


def dependencies():
    try:
        import yaml
        from markdown_it import MarkdownIt
    except ImportError as error:
        raise ValueError('Optional dependencies unavailable: locally installed PyYAML and markdown-it-py required') from error
    return yaml, MarkdownIt


def metadata(body):
    yaml, _ = dependencies()

    class StrictLoader(yaml.SafeLoader):
        def compose_node(self, parent, index):
            if self.check_event(yaml.AliasEvent):
                raise ValueError('YAML aliases are not allowed')
            return super().compose_node(parent, index)

        def construct_mapping(self, node, deep=False):
            result = {}
            for key_node, value_node in node.value:
                key = self.construct_object(key_node, deep=deep)
                if not isinstance(key, str) or key in result or key == '<<':
                    raise ValueError('Duplicate or invalid YAML key')
                result[key] = self.construct_object(value_node, deep=deep)
            return result

    source = body.decode('utf-8').replace('\r\n', '\n')
    match = re.match(r'\A---\n(.*?)\n---(?:\n|$)', source, re.S)
    if not match or len(match[1].encode()) > 8192:
        raise ValueError('Missing or oversized YAML frontmatter')
    front = yaml.load(match[1], Loader=StrictLoader)
    if not isinstance(front, dict):
        raise ValueError('Invalid skill frontmatter')
    name, description = front.get('name'), front.get('description')
    if (not isinstance(name, str) or len(name) > 64
            or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', name)
            or not isinstance(description, str) or not description.strip() or len(description) > 5120):
        raise ValueError('Invalid skill name or description')
    return front


def destinations(tokens):
    for token in tokens:
        if token.type in ('link_open', 'image'):
            yield token.attrGet('href' if token.type == 'link_open' else 'src')
        if token.children:
            yield from destinations(token.children)


def local_target(doc, href):
    ref = urlsplit(href)
    if ref.scheme in ('https', 'http', 'mailto'):
        return None
    if ref.scheme or ref.netloc:
        raise ValueError('Unexpected URI scheme or authority')
    path = unquote(ref.path, errors='strict')
    if not path:
        return None
    if path.startswith('/') or '\\' in path or ':' in path or any(ord(c) < 32 for c in path):
        raise ValueError('Unsafe relative resource')
    return posixpath.normpath(posixpath.join(posixpath.dirname(doc), path))


def validate_files(files, entries=None):
    check_paths(entries if entries is not None else [(n, False) for n in files])
    roots = {n.split('/')[0] for n, _ in (entries or [(n, False) for n in files])}
    if len(roots) != 1 or any('/' not in n for n in files):
        raise ValueError('Expected one top-level skill directory')
    folder = roots.pop()
    entrypoint = folder + '/SKILL.md'
    if sorted(n for n in files if PurePosixPath(n).name.casefold() == 'skill.md') != [entrypoint]:
        raise ValueError('Expected one SKILL.md at the root of the selected skill')
    front = metadata(files[entrypoint])
    if front['name'] != folder:
        raise ValueError('Skill name does not match package folder')
    _, MarkdownIt = dependencies()
    parser = MarkdownIt('commonmark')
    for doc, data in files.items():
        check_secret(data)
        if not doc.lower().endswith('.md'):
            continue
        # Parse prohibited schemes too, rather than silently treating them as plain text.
        parser.validateLink = lambda _: True
        for href in destinations(parser.parse(data.decode('utf-8'))):
            target = local_target(doc, href)
            if target is not None and (not target.startswith(folder + '/') or target not in files):
                raise ValueError('Unresolved relative resource in ' + doc)
    return front['name']


def inspect_bytes(body):
    files, entries = read_zip(body)
    name = validate_files(files, entries)
    return dict(name=name, files=len(files), sha256=digest(body), file_sha256=inventory(files),
                status='PACKAGE_VALIDATED', runtime_ready=False,
                scope='local ZIP structure and Markdown resources only; no rights or runtime approval',
                authority=False)


def inspect(path):
    return inspect_bytes(read_local(path))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.archive), sort_keys=True))
    except Exception as error:
        parser.exit(1, str(error) + '\n')
