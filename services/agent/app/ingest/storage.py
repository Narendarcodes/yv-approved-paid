"""Object storage (S3/R2-compatible; MinIO locally). Keys look like s3://bucket/key."""
from __future__ import annotations
import os
import tempfile

from ..config import get_settings


def _client():
    import boto3

    s = get_settings()
    return boto3.client("s3", endpoint_url=s.s3_endpoint, aws_access_key_id=s.s3_access_key, aws_secret_access_key=s.s3_secret_key, region_name="us-east-1")


def split(key: str) -> tuple[str, str]:
    if not key.startswith("s3://"):
        raise ValueError(f"not an s3 key: {key}")
    bucket, _, path = key[5:].partition("/")
    return bucket, path


def download(key: str) -> str:
    """Return a local path for the object (file paths are passed through)."""
    if key.startswith("file://"):
        return key[7:]
    if os.path.exists(key):
        return key
    bucket, path = split(key)
    fd, local = tempfile.mkstemp(suffix=os.path.splitext(path)[1] or ".bin")
    os.close(fd)
    _client().download_file(bucket, path, local)
    return local


def upload(local: str, key: str) -> str:
    bucket, path = split(key)
    c = _client()
    try:
        c.head_bucket(Bucket=bucket)
    except Exception:
        c.create_bucket(Bucket=bucket)
    c.upload_file(local, bucket, path)
    return key
