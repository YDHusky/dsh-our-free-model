#!/usr/bin/env python3
"""Push one image from an OCI archive while reusing public registry blobs."""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import ssl
import sys
import tarfile
import tempfile
import time
from typing import BinaryIO
import urllib.error
import urllib.parse
import urllib.request


def required(name: str) -> str:
    value = os.environ.get(name, '').strip()
    if not value:
        raise RuntimeError(f'{name} is required')
    return value


registry = required('REGISTRY')
repository = required('IMAGE_NAME').strip('/')
archive = Path(required('OCI_ARCHIVE'))
username = required('REGISTRY_USERNAME')
password = required('REGISTRY_PASSWORD')
tags = [line.strip() for line in required('IMAGE_TAGS').splitlines() if line.strip()]
service = os.environ.get('REGISTRY_SERVICE', 'harbor-registry')
registry_url = f'https://{registry}'


def json_request(url: str, *, headers: dict[str, str] | None = None) -> dict:
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def bearer_token(actions: str, *, authenticated: bool) -> str:
    query = urllib.parse.urlencode({
        'service': service,
        'scope': f'repository:{repository}:{actions}',
        **({'account': username} if authenticated else {}),
    })
    headers: dict[str, str] = {}
    if authenticated:
        basic = base64.b64encode(f'{username}:{password}'.encode()).decode()
        headers['Authorization'] = f'Basic {basic}'
    payload = json_request(f'{registry_url}/service/token?{query}', headers=headers)
    token = payload.get('token') or payload.get('access_token')
    if not isinstance(token, str) or not token:
        raise RuntimeError('Registry token response did not contain a token')
    return token


def status_request(url: str, *, method: str, token: str, data: bytes | None = None,
                   content_type: str | None = None) -> tuple[int, dict[str, str], bytes]:
    headers = {'Authorization': f'Bearer {token}'}
    if content_type:
        headers['Content-Type'] = content_type
        headers['Accept'] = content_type
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()


def blob_exists(digest: str, *tokens: str) -> bool:
    url = f'{registry_url}/v2/{repository}/blobs/{urllib.parse.quote(digest, safe=":")}'
    for token in tokens:
        status, _, _ = status_request(url, method='HEAD', token=token)
        if status == 200:
            return True
        if status == 404:
            return False
        if status not in (401, 403):
            raise RuntimeError(f'Unexpected blob HEAD status for {digest}: {status}')
    return False


def resolve_location(location: str) -> str:
    return urllib.parse.urljoin(f'{registry_url}/', location)


class ProgressReader:
    def __init__(self, source: BinaryIO, size: int, digest: str):
        self.source = source
        self.size = size
        self.digest = digest
        self.sent = 0
        self.next_report = time.monotonic() + 30

    def read(self, amount: int = -1) -> bytes:
        chunk = self.source.read(amount)
        self.sent += len(chunk)
        now = time.monotonic()
        if chunk and now >= self.next_report:
            print(f'  {self.digest[:19]}: sent {self.sent}/{self.size} bytes', flush=True)
            self.next_report = now + 30
        return chunk


def streaming_put(url: str, file: Path, token: str, digest: str) -> tuple[int, dict[str, str], bytes]:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https':
        raise RuntimeError('Registry upload redirected away from HTTPS')
    path = urllib.parse.urlunsplit(('', '', parsed.path, parsed.query, ''))
    size = file.stat().st_size
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443,
                                              timeout=1800, context=ssl.create_default_context())
    try:
        with file.open('rb') as source:
            body = ProgressReader(source, size, digest)
            headers = {
                'Content-Length': str(size),
                'Content-Type': 'application/octet-stream',
            }
            if parsed.hostname == registry:
                headers['Authorization'] = f'Bearer {token}'
            connection.request('PUT', path, body=body, headers=headers)
            response = connection.getresponse()
            result = response.read()
            return response.status, dict(response.headers.items()), result
    finally:
        connection.close()


def upload_blob(file: Path, digest: str, token: str) -> None:
    size = file.stat().st_size
    for attempt in range(1, 4):
        start_url = f'{registry_url}/v2/{repository}/blobs/uploads/'
        status, headers, body = status_request(start_url, method='POST', token=token, data=b'')
        if status != 202:
            detail = body.decode(errors='replace')[:300]
            raise RuntimeError(f'Could not start blob upload ({status}): {detail}')
        location = headers.get('Location') or headers.get('location')
        if not location:
            raise RuntimeError('Registry did not return an upload location')
        upload_url = resolve_location(location)
        separator = '&' if urllib.parse.urlsplit(upload_url).query else '?'
        upload_url += separator + urllib.parse.urlencode({'digest': digest})
        print(f'Uploading {digest} ({size} bytes), attempt {attempt}/3', flush=True)
        try:
            status, response_headers, response_body = streaming_put(upload_url, file, token, digest)
        except (OSError, TimeoutError, http.client.HTTPException) as error:
            if attempt == 3:
                raise RuntimeError(f'Blob upload failed after 3 attempts: {type(error).__name__}') from error
            print(f'Upload connection failed; retrying ({type(error).__name__})', flush=True)
            time.sleep(attempt * 3)
            continue
        if status == 201:
            reported = response_headers.get('Docker-Content-Digest') or response_headers.get('docker-content-digest')
            if reported and reported != digest:
                raise RuntimeError(f'Registry reported the wrong blob digest: {reported}')
            return
        detail = response_body.decode(errors='replace')[:300]
        if attempt == 3 or status not in (408, 429, 500, 502, 503, 504):
            raise RuntimeError(f'Blob upload failed ({status}): {detail}')
        print(f'Registry returned {status}; retrying', flush=True)
        time.sleep(attempt * 3)


def digest_path(root: Path, digest: str) -> Path:
    algorithm, value = digest.split(':', 1)
    if algorithm != 'sha256' or len(value) != 64:
        raise RuntimeError(f'Unsupported OCI digest: {digest}')
    file = root / 'blobs' / algorithm / value
    if not file.is_file():
        raise RuntimeError(f'OCI archive is missing {digest}')
    return file


def verify_descriptor(root: Path, descriptor: dict) -> Path:
    digest = descriptor['digest']
    file = digest_path(root, digest)
    if file.stat().st_size != descriptor['size']:
        raise RuntimeError(f'OCI size mismatch for {digest}')
    actual = 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()
    if actual != digest:
        raise RuntimeError(f'OCI digest mismatch for {digest}')
    return file


def one_unique_descriptor(candidates: list[dict], label: str) -> dict:
    unique = {item['digest']: item for item in candidates}
    if len(unique) != 1:
        raise RuntimeError(f'OCI archive must contain one {label}; found {len(unique)}')
    return next(iter(unique.values()))


def select_image_manifest(root: Path, descriptor: dict) -> tuple[dict, Path, dict]:
    while descriptor['mediaType'] in (
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
    ):
        index_file = verify_descriptor(root, descriptor)
        index = json.loads(index_file.read_bytes())
        candidates = [item for item in index['manifests']
                      if item.get('platform', {}).get('os') == 'linux'
                      and item.get('platform', {}).get('architecture') == 'amd64']
        descriptor = one_unique_descriptor(candidates, 'linux/amd64 image')
    manifest_file = verify_descriptor(root, descriptor)
    manifest = json.loads(manifest_file.read_bytes())
    return descriptor, manifest_file, manifest


def main() -> None:
    if not archive.is_file():
        raise RuntimeError(f'OCI archive does not exist: {archive}')
    work = Path(tempfile.mkdtemp(prefix='ofm-oci-'))
    with tarfile.open(archive) as bundle:
        for member in bundle.getmembers():
            target = (work / member.name).resolve()
            if work.resolve() not in target.parents and target != work.resolve():
                raise RuntimeError(f'Unsafe OCI archive path: {member.name}')
        bundle.extractall(work, filter='data')

    index = json.loads((work / 'index.json').read_bytes())
    top = [item for item in index['manifests']
           if item.get('platform', {}).get('os', 'linux') == 'linux'
           and item.get('platform', {}).get('architecture', 'amd64') == 'amd64']
    descriptor = one_unique_descriptor(top, 'top-level linux/amd64 descriptor')
    descriptor, manifest_file, manifest = select_image_manifest(work, descriptor)
    manifest_digest = descriptor['digest']

    try:
        pull_token = bearer_token('pull', authenticated=False)
    except (RuntimeError, urllib.error.URLError):
        pull_token = ''
    push_token = bearer_token('pull,push', authenticated=True)
    lookup_tokens = tuple(token for token in (pull_token, push_token) if token)

    descriptors = [manifest['config'], *manifest['layers']]
    total = sum(item['size'] for item in descriptors)
    missing = 0
    for item in descriptors:
        file = verify_descriptor(work, item)
        digest = item['digest']
        if blob_exists(digest, *lookup_tokens):
            print(f'Reusing {digest} ({item["size"]} bytes)', flush=True)
            continue
        missing += item['size']
        upload_blob(file, digest, push_token)

    print(f'Blob plan complete: {missing} of {total} bytes uploaded', flush=True)
    media_type = descriptor['mediaType']
    manifest_bytes = manifest_file.read_bytes()
    for tag in tags:
        expected_prefix = f'{registry}/{repository}:'
        if tag.startswith(expected_prefix):
            tag = tag[len(expected_prefix):]
        if not tag or '/' in tag or ':' in tag:
            raise RuntimeError(f'Invalid target tag: {tag}')
        url = f'{registry_url}/v2/{repository}/manifests/{urllib.parse.quote(tag, safe="")}'
        status, headers, body = status_request(url, method='PUT', token=push_token,
                                               data=manifest_bytes, content_type=media_type)
        if status != 201:
            detail = body.decode(errors='replace')[:300]
            raise RuntimeError(f'Manifest push failed for {tag} ({status}): {detail}')
        reported = headers.get('Docker-Content-Digest') or headers.get('docker-content-digest')
        if reported and reported != manifest_digest:
            raise RuntimeError(f'Registry reported the wrong manifest digest: {reported}')
        print(f'Published {registry}/{repository}:{tag}', flush=True)

    if pull_token:
        for tag in tags:
            short_tag = tag.removeprefix(f'{registry}/{repository}:')
            url = f'{registry_url}/v2/{repository}/manifests/{urllib.parse.quote(short_tag, safe="")}'
            status, headers, _ = status_request(url, method='HEAD', token=pull_token,
                                                content_type=media_type)
            reported = headers.get('Docker-Content-Digest') or headers.get('docker-content-digest')
            if status != 200 or reported != manifest_digest:
                raise RuntimeError(f'Published manifest verification failed for {short_tag}')

    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf-8') as stream:
            stream.write(f'digest={manifest_digest}\n')
    print(f'Published digest: {manifest_digest}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'OCI publish failed: {error}', file=sys.stderr)
        raise SystemExit(1)
