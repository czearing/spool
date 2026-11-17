import json
import os
import runpy
import sys
import time
import uuid

from msal_extensions import CrossPlatLock, FilePersistenceWithDataProtection


def atomic_copy(source, destination):
    temporary = destination + "." + uuid.uuid4().hex + ".tmp"
    try:
        with open(source, "rb") as reader:
            data = reader.read()
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "wb") as writer:
            writer.write(data)
            writer.flush()
            os.fsync(writer.fileno())
        for attempt in range(5):
            try:
                os.replace(temporary, destination)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.02 * 2**attempt)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate(location):
    value = json.loads(FilePersistenceWithDataProtection(location).load())
    if not isinstance(value, dict):
        raise ValueError("Invalid encrypted Azure token cache")


def prepare_cache(location, recover=True):
    backup = location + ".spool-last-good"
    with CrossPlatLock(location + ".lockfile"):
        if not os.path.exists(location):
            return False
        if os.stat(location).st_size == 0:
            if not recover or not os.path.exists(backup):
                return False
            validate(backup)
            atomic_copy(backup, location)
            return True
        validate(location)
        atomic_copy(location, backup)
        return False


def main():
    directory = os.environ.get("AZURE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".azure")
    location = os.path.join(directory, "msal_token_cache.bin")
    try:
        if prepare_cache(location):
            print("[Azure auth] Recovered an empty cache from its encrypted snapshot.", file=sys.stderr)
    except Exception:
        print("[Azure auth] Cache recovery unavailable; normal Azure sign-in is still required.", file=sys.stderr)
    code = 0
    try:
        sys.argv[0] = "az"
        runpy.run_module("azure.cli", run_name="__main__")
    except SystemExit as error:
        code = error.code
    if code in (None, 0):
        try:
            prepare_cache(location, recover=False)
        except Exception:
            print("[Azure auth] Could not update the encrypted recovery snapshot.", file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
