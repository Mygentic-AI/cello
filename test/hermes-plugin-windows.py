"""Loads the real Hermes plugin with stand-ins for Hermes's own modules, and prints what windows.test.ts compares with
the TypeScript side: the daemon's pipe name and the key file for a Windows home, and the proof for a fixed key and nonce."""
import asyncio
import importlib.util
import json
import sys
import types

for name in ("gateway", "gateway.config", "gateway.platforms", "gateway.platforms.base", "gateway.session", "gateway.session_context"):
    module = types.ModuleType(name)
    module.__getattr__ = lambda attr: type(attr, (), {"__init__": lambda self, *a, **k: None})
    sys.modules[name] = module

spec = importlib.util.spec_from_file_location("cello_plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

home, key_hex, nonce_hex, key_file = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]


class Fake:
    """Only what _verify_daemon touches."""

    def __init__(self, proof):
        self._socket = "pipe"
        self._ipc_key_file = key_file
        self._proof = proof

    async def _call(self, method, params, timeout=0):
        self.sent = params["nonce"]
        return {"proof": self._proof(params["nonce"])}


import hashlib
import hmac


def proof_for(nonce_hex_seen):
    return hmac.new(bytes.fromhex(key_hex), b"cello-daemon-ipc-v1\0" + bytes.fromhex(nonce_hex_seen), hashlib.sha256).hexdigest()


def run(fake):
    try:
        asyncio.run(plugin.CelloAdapter._verify_daemon(fake))
        return "accepted"
    except ConnectionError:
        return "refused"


print(json.dumps({
    "pipe": plugin._socket_path(home, "win32"),
    "key_file": plugin._ipc_key_path(home),
    "proof": proof_for(nonce_hex),
    "real": run(Fake(proof_for)),
    "squatter": run(Fake(lambda n: "0" * 64)),
}))
