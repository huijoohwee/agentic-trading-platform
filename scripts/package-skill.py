"""Package one reviewed local source without network, installation or skill execution."""
import argparse
from collections import Counter
from contextlib import ExitStack
from datetime import datetime
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
from zipfile import ZipFile, ZipInfo, ZIP_STORED

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('skill_inspector', Path(__file__).with_name('inspect-skill.py'))
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)
REVIEW_LIMIT = 1_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def sha(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate review JSON key')
        result[key] = value
    return result


def load_review(path):
    raw = inspector.read_local(path, REVIEW_LIMIT)
    inspector.check_secret(raw)
    review = json.loads(raw, object_pairs_hook=unique_object)
    require(isinstance(review, dict) and review.get('schema') == 'skill-package-review/v1',
            'Explicit reviewed manifest required')
    upstream = review.get('upstream', {})
    require(isinstance(upstream, dict) and text(upstream.get('repository'))
            and isinstance(upstream.get('revision'), str)
            and re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', upstream['revision']),
            'Exact upstream revision required')
    require(sha(review.get('source_sha256')), 'Compressed source SHA-256 required')
    files = review.get('source_files')
    require(isinstance(files, dict) and files and all(sha(v) for v in files.values()),
            'Complete source inventory with SHA-256 digests required')
    inspector.check_paths([(p, False) for p in files])
    inspector.clean_path(review.get('skill_path'))
    name = review.get('name')
    require(isinstance(name, str) and len(name) <= 64 and re.fullmatch(r'[a-z0-9][a-z0-9_-]*', name),
            'Selected YAML identity required')
    record = review.get('review', {})
    require(isinstance(record, dict) and text(record.get('owner')) and text(record.get('observed_at')),
            'Review owner and observation time required')
    observed = datetime.fromisoformat(record['observed_at'].replace('Z', '+00:00'))
    require(observed.tzinfo is not None, 'Review observation must include timezone')
    rights, runtime = record.get('rights', {}), record.get('runtime', {})
    require(isinstance(rights, dict) and rights.get('decision') == 'approved',
            'Explicit approved rights decision required; unknown rights block packaging')
    require(isinstance(runtime, dict) and runtime.get('decision') == 'compatible'
            and runtime.get('direct_write') is False and runtime.get('cost') == 'reviewed'
            and text(runtime.get('transport')) and text(runtime.get('authentication')),
            'Compatible runtime, auth, cost and no direct-write path must be reviewed')
    deps = runtime.get('dependencies')
    require(isinstance(deps, list) and all(isinstance(d, dict) and text(d.get('name'))
            and text(d.get('version')) and re.fullmatch(r'[0-9][A-Za-z0-9._+-]*', d['version'])
            for d in deps), 'Explicit exact dependency versions required (empty if none)')
    for decision in (rights, runtime):
        evidence = decision.get('evidence')
        require(isinstance(evidence, list) and evidence, 'Local rights/runtime review evidence required')
        for item in evidence:
            require(isinstance(item, dict) and sha(item.get('sha256')), 'Evidence digest required')
            inspector.clean_path(item.get('path'))
            body = inspector.read_local(path.parent / item['path'], REVIEW_LIMIT)
            inspector.check_secret(body)
            require(body.strip() and inspector.digest(body) == item['sha256'], 'Review evidence digest mismatch')
    require(isinstance(review.get('relocations'), dict) and isinstance(review.get('link_edits'), list),
            'Explicit relocation map and reviewed link edits required (may be empty)')
    return review, inspector.digest(raw)


def read_tree(path):
    files, entries, total = {}, [], 0

    def walk(fd, prefix):
        nonlocal total
        for name in sorted(os.listdir(fd)):
            relative = prefix + name
            inspector.clean_path(relative)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            directory = stat.S_ISDIR(info.st_mode)
            entries.append((relative, directory))
            require(len(entries) <= inspector.MAX_ENTRIES, 'Source tree entry budget exceeded')
            if directory:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    walk(child, relative + '/')
                finally:
                    os.close(child)
            else:
                require(stat.S_ISREG(info.st_mode), 'Source symlink or special file rejected')
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(child, 'rb') as stream:
                    require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'Source must remain regular')
                    data = stream.read(inspector.LIMIT - total)
                total += len(data)
                require(total < inspector.LIMIT, 'Source tree byte budget exceeded')
                inspector.check_secret(data)
                files[relative] = data

    with inspector.parent_fd(path) as (parent, name):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            walk(fd, '')
        finally:
            os.close(fd)
    inspector.check_paths(entries)
    return files


def source_files(source, archive_path, review):
    if source.is_dir():
        require(archive_path is not None, 'Tree input requires retained --source-archive ZIP')
        body = inspector.read_local(archive_path)
    else:
        require(archive_path is None, '--source-archive is only used with a source tree')
        body = inspector.read_local(source)
    require(inspector.digest(body) == review['source_sha256'], 'Compressed source digest mismatch')
    files, _ = inspector.read_zip(body)
    require(inspector.inventory(files) == review['source_files'], 'Source inventory mismatch')
    if source.is_dir():
        require(inspector.inventory(read_tree(source)) == review['source_files'], 'Source tree inventory mismatch')
    return files


def link_destination_spans(data):
    # Only simple inline destinations and reference definitions are editable.
    inline = rb'\]\((?P<url>[^\s()<>]+)\)'
    reference = rb'(?m)^ {0,3}\[[^\]\r\n]+\]:[ \t]*<?(?P<url>[^\s<>]+)>?[ \t]*\r?$'
    return {(m.start('url'), m.end('url')) for pattern in (inline, reference)
            for m in re.finditer(pattern, data)}


def stage(files, review):
    prefix, name = review['skill_path'] + '/', review['name']
    mapping = {p: name + '/' + p[len(prefix):] for p in files if p.startswith(prefix)}
    require(prefix + 'SKILL.md' in mapping, 'Selected source SKILL.md missing')
    for source, target in review['relocations'].items():
        inspector.clean_path(source)
        parts = inspector.clean_path(target)
        require(source in files and source not in mapping, 'Relocation must name an external source file once')
        require(parts[0] in ('references', 'scripts', 'assets') and len(parts) > 1,
                'External references must relocate into references/scripts/assets')
        mapping[source] = name + '/' + target
    inspector.check_paths([(target, False) for target in mapping.values()])
    for target in mapping.values():
        parts = target.split('/')[1:]
        require(parts == ['SKILL.md'] or (len(parts) > 1 and parts[0] in ('references', 'scripts', 'assets')),
                'Package may contain only SKILL.md and references/scripts/assets')
    edits, diffs, staged = {}, [], {}
    for edit in review['link_edits']:
        require(isinstance(edit, dict) and edit.get('path') in mapping, 'Unknown edited source path')
        require(type(edit.get('offset')) is int and edit['offset'] >= 0
                and text(edit.get('before')) and text(edit.get('after')), 'Invalid reviewed link edit')
        require(edit['before'] != edit['after'], 'Link edit must change a destination')
        edits.setdefault(edit['path'], []).append(edit)
    for source, target in sorted(mapping.items()):
        original, data = files[source], files[source]
        end = len(data)
        spans = link_destination_spans(data)
        for edit in sorted(edits.get(source, []), key=lambda e: e['offset'], reverse=True):
            before, after = edit['before'].encode(), edit['after'].encode()
            start, stop = edit['offset'], edit['offset'] + len(before)
            require(source.lower().endswith('.md') and stop <= end and (start, stop) in spans
                    and original[start:stop] == before, 'Only exact, nonoverlapping reviewed link destinations may change')
            require(not re.search(rb'[\s()<>]', after), 'Unsupported replacement link syntax')
            old_resource = inspector.local_target(source, edit['before'])
            new_resource = inspector.local_target(target, edit['after'])
            require(old_resource in mapping and new_resource == mapping[old_resource],
                    'Reviewed link must preserve the mapped resource')
            from urllib.parse import urlsplit
            old_ref, new_ref = urlsplit(edit['before']), urlsplit(edit['after'])
            require((old_ref.query, old_ref.fragment) == (new_ref.query, new_ref.fragment),
                    'Reviewed link must preserve query and fragment')
            data = data[:start] + after + data[stop:]
            end = start
        staged[target] = data
        if data != original:
            diff = ''.join(difflib.unified_diff(original.decode('utf-8').splitlines(keepends=True),
                                               data.decode('utf-8').splitlines(keepends=True),
                                               fromfile=source, tofile=target))
            diffs.append(dict(source=source, target=target, diff=diff,
                              source_sha256=inspector.digest(original), sha256=inspector.digest(data)))
    require(len(staged) <= inspector.MAX_ENTRIES and sum(map(len, staged.values())) < inspector.LIMIT,
            'Staged package exceeds inspection budget')
    return staged, mapping, diffs


def validate_edited_links(files, staged, mapping, review):
    _, MarkdownIt = inspector.dependencies()
    parser = MarkdownIt('commonmark')
    parser.validateLink = lambda _: True

    def links(data):
        return Counter(inspector.destinations(parser.parse(data.decode('utf-8'))))

    for source in {edit['path'] for edit in review['link_edits']}:
        original = files[source]
        original_links = links(original)
        expected = original_links.copy()
        for edit in (e for e in review['link_edits'] if e['path'] == source):
            before = links(('[x](' + edit['before'] + ')').encode())
            after = links(('[x](' + edit['after'] + ')').encode())
            require(sum(before.values()) == sum(after.values()) == 1,
                    'Reviewed edit must be a Markdown link')
            require(before != after, 'Reviewed edit must change a parsed destination')
            # Independent edits prevent reciprocal code changes from cancelling out.
            individual = original_links.copy()
            individual.subtract(before)
            individual.update(after)
            start = edit['offset']
            stop = start + len(edit['before'].encode())
            changed = original[:start] + edit['after'].encode() + original[stop:]
            require(all(count >= 0 for count in individual.values())
                    and +individual == links(changed),
                    'Reviewed edits must change actual links, not code or safety prose')
            expected.subtract(before)
            expected.update(after)
        require(all(count >= 0 for count in expected.values())
                and +expected == links(staged[mapping[source]]),
                'Reviewed edits must change actual links, not code or safety prose')


def zip_bytes(files):
    buffer = io.BytesIO()
    with ZipFile(buffer, 'w', compression=ZIP_STORED, allowZip64=False) as archive:
        for name, data in sorted(files.items()):
            entry = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(entry, data)
    body = buffer.getvalue()
    require(len(body) < inspector.LIMIT, 'Packaged ZIP must be under 50 MB')
    return body


def write_pair(output, body, manifest):
    sidecar = output.with_name(output.name + '.manifest.json')
    created = []
    with ExitStack() as stack:
        try:
            for path, data in ((output, body), (sidecar, manifest)):
                parent, name = stack.enter_context(inspector.parent_fd(path))
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=parent)
                created.append((parent, name, os.fstat(fd)))
                stream = stack.enter_context(os.fdopen(fd, 'wb'))
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            for parent, name, original in reversed(created):
                try:
                    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino):
                        os.unlink(name, dir_fd=parent)
                except FileNotFoundError:
                    pass
            raise
    return sidecar


def package(source, review_path, output, archive_path=None):
    require(output.suffix == '.zip', 'Output must have .zip suffix')
    review, review_sha = load_review(review_path)
    for protected in (source, archive_path, review_path):
        if protected is not None:
            require(output.resolve() != protected.resolve(), 'Output must not replace a source or review')
    if source.is_dir():
        require(not output.resolve().is_relative_to(source.resolve()), 'Output must be outside source tree')
    files = source_files(source, archive_path, review)
    staged, mapping, diffs = stage(files, review)
    body = zip_bytes(staged)
    result = inspector.inspect_bytes(body)
    validate_edited_links(files, staged, mapping, review)
    manifest = dict(schema='skill-package-manifest/v1', status='PACKAGE_VALIDATED', authority=False,
                    runtime_ready=False, review_verification='supplied local evidence; not independent approval',
                    upstream=review['upstream'], name=review['name'], review=review['review'],
                    review_sha256=review_sha, source_sha256=review['source_sha256'],
                    source_files=review['source_files'], file_sha256=inspector.inventory(staged),
                    source_to_package=mapping, relocations=review['relocations'],
                    link_edits=review['link_edits'], relocation_diff=diffs, sha256=result['sha256'],
                    limits=dict(bytes_exclusive=inspector.LIMIT, entries=inspector.MAX_ENTRIES))
    encoded = (json.dumps(manifest, sort_keys=True, indent=2, ensure_ascii=False) + '\n').encode()
    sidecar = write_pair(output, body, encoded)
    return dict(status='PACKAGE_VALIDATED', authority=False, runtime_ready=False,
                sha256=result['sha256'], output=str(output.absolute()), manifest=str(sidecar.absolute()))


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--source-archive', type=Path)
    parser.add_argument('--review', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.source, args.review, args.output, args.source_archive), sort_keys=True))
    except Exception as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
