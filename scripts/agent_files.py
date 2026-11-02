#!/usr/bin/env python3
"""Private files for agent jobs.

The repo is public, so anything Dylan attaches to a job (files, links) is
encrypted in his browser to the agent's PUBLIC key in data/agent-files-key.json
before it is committed under data/uploads/<job-id>/. Only an agent run that
holds the matching private key (env AGENT_FILES_KEY, "ak1-...") can open them.

Results for those jobs are encrypted the other way: to the public key in
data/grades-key.json, whose private half only lives on Dylan's devices, so the
dashboard can show them and nobody else can.

Usage (run from the repo root):
  python3 scripts/agent_files.py open <job-id> <out-dir>
      Decrypt the job's uploads into <out-dir> (keep it OUTSIDE the repo).
  python3 scripts/agent_files.py seal-result <job-id> <markdown-file>
      Encrypt a result to Dylan's key -> agent/results/<job-id>.enc.json
  python3 scripts/agent_files.py keygen
      New agent key pair: writes the public half, prints the private half once.

Formats (shared with js/app.js):
  upload  {v, kid, epk, iv, ct}; plaintext = 4-byte big-endian meta length,
          meta JSON {name, type, size, kind: "file"|"links"}, then the bytes.
          HKDF info "dashboard-agent-files-v1".
  result  {v, kid, epk, iv, ct}; plaintext = UTF-8 Markdown.
          HKDF info "dashboard-agent-result-v1".
"""

import base64
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

FILES_INFO = b"dashboard-agent-files-v1"
RESULT_INFO = b"dashboard-agent-result-v1"
AGENT_PUB = Path("data/agent-files-key.json")
DYLAN_PUB = Path("data/grades-key.json")


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def int_b64u(n: int) -> str:
    return b64u(n.to_bytes(32, "big"))


def pub_from_jwk(jwk: dict) -> ec.EllipticCurvePublicKey:
    return ec.EllipticCurvePublicNumbers(
        int.from_bytes(unb64u(jwk["x"]), "big"), int.from_bytes(unb64u(jwk["y"]), "big"), ec.SECP256R1()
    ).public_key()


def aes_key(shared: bytes, info: bytes) -> AESGCM:
    return AESGCM(HKDF(algorithm=hashes.SHA256(), length=32, salt=bytes(32), info=info).derive(shared))


def seal(plain: bytes, jwk: dict, info: bytes) -> dict:
    eph = ec.generate_private_key(ec.SECP256R1())
    shared = eph.exchange(ec.ECDH(), pub_from_jwk(jwk))
    iv = os.urandom(12)
    ct = aes_key(shared, info).encrypt(iv, plain, None)
    n = eph.public_key().public_numbers()
    return {
        "v": 1,
        "kid": jwk["x"][:12],
        "epk": {"kty": "EC", "crv": "P-256", "x": int_b64u(n.x), "y": int_b64u(n.y)},
        "iv": b64u(iv),
        "ct": b64u(ct),
    }


def unseal(enc: dict, priv: ec.EllipticCurvePrivateKey, info: bytes) -> bytes:
    shared = priv.exchange(ec.ECDH(), pub_from_jwk(enc["epk"]))
    return aes_key(shared, info).decrypt(unb64u(enc["iv"]), unb64u(enc["ct"]), None)


def agent_private_key() -> ec.EllipticCurvePrivateKey:
    raw = os.environ.get("AGENT_FILES_KEY", "").strip()
    if not raw:
        sys.exit("AGENT_FILES_KEY is not set. It's in the 'Dashboard agents' scheduled task instructions.")
    d = int.from_bytes(unb64u(raw.removeprefix("ak1-")), "big")
    priv = ec.derive_private_key(d, ec.SECP256R1())
    pub = json.loads(AGENT_PUB.read_text())
    if int_b64u(priv.public_key().public_numbers().x) != pub["x"]:
        sys.exit("AGENT_FILES_KEY doesn't match data/agent-files-key.json.")
    return priv


def safe_name(name: str, used: set) -> str:
    name = re.sub(r"[^\w.\- ()]+", "_", Path(name or "file").name).strip(" .") or "file"
    stem, suffix = os.path.splitext(name)
    candidate, i = name, 2
    while candidate.lower() in used:
        candidate, i = f"{stem} ({i}){suffix}", i + 1
    used.add(candidate.lower())
    return candidate


def cmd_open(job_id: str, out_dir: str) -> None:
    src = Path("data/uploads") / job_id
    out = Path(out_dir).resolve()
    if Path.cwd().resolve() in [out, *out.parents]:
        sys.exit("Write decrypted files OUTSIDE the repo (e.g. /tmp/agent-files/<job-id>).")
    if not src.is_dir():
        print(f"No uploads for {job_id}.")
        return
    priv = agent_private_key()
    out.mkdir(parents=True, exist_ok=True)
    used: set = set()
    for path in sorted(src.glob("*.enc.json")):
        plain = unseal(json.loads(path.read_text()), priv, FILES_INFO)
        meta_len = int.from_bytes(plain[:4], "big")
        meta = json.loads(plain[4 : 4 + meta_len])
        body = plain[4 + meta_len :]
        name = "links.txt" if meta.get("kind") == "links" else meta.get("name", path.stem)
        target = out / safe_name(name, used)
        target.write_bytes(body)
        print(f"{path.name} -> {target}  ({meta.get('kind', 'file')}, {meta.get('type') or 'unknown type'}, {len(body):,} bytes)")


def cmd_seal_result(job_id: str, md_file: str) -> None:
    jwk = json.loads(DYLAN_PUB.read_text())
    if not jwk.get("x"):
        sys.exit("data/grades-key.json has no key; Dylan needs to tap Grades -> Create key.")
    enc = seal(Path(md_file).read_bytes(), jwk, RESULT_INFO)
    target = Path("agent/results") / f"{job_id}.enc.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(enc) + "\n")
    print(target)


def cmd_keygen() -> None:
    priv = ec.generate_private_key(ec.SECP256R1())
    n = priv.public_key().public_numbers()
    AGENT_PUB.write_text(json.dumps({
        "kty": "EC", "crv": "P-256", "x": int_b64u(n.x), "y": int_b64u(n.y),
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "Public half only. Browser encrypts job uploads to this; the agent run holds the private half.",
    }, indent=2) + "\n")
    print("ak1-" + int_b64u(priv.private_numbers().private_value))


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["open"] and len(args) == 3:
        cmd_open(args[1], args[2])
    elif args[:1] == ["seal-result"] and len(args) == 3:
        cmd_seal_result(args[1], args[2])
    elif args == ["keygen"]:
        cmd_keygen()
    else:
        sys.exit(__doc__)
