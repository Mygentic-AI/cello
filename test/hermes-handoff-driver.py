"""Two real processes for hermes-handoff.test.ts, with the real plugin inside a real Hermes.

client: what a 'hermes serve' backend does. Hermes loads the plugin, a desktop host is published, and the
        model opens a session from chat CHAT. Prints each turn the plugin queued, one JSON line each.
gateway: what the gateway's adapter does with a bell for that session.
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

CHAT = "20261109_165416_46dc25"
SESSION = "0123456789abcdef0123456789abcdef"


def client() -> None:
    from hermes_cli.plugins import get_plugin_manager, publish_tui_message_host

    manager = get_plugin_manager()
    manager.discover_and_load()
    module = next(m for m in sys.modules.values() if getattr(m, "CelloAdapter", None) is not None and hasattr(m, "_on_post_tool_call"))

    # The desktop's live chats. Only CHAT is open here.
    def desktop(*, session_key: str, content: str, plugin_id: str = "") -> bool:
        print(json.dumps({"session_key": session_key, "content": content}), flush=True)
        return session_key == CHAT

    publish_tui_message_host(object(), desktop)
    clients = Path(os.environ["HERMES_HOME"]) / "cello" / "clients"
    deadline = time.monotonic() + 20
    while not (clients / (str(os.getpid()) + ".sock")).exists():
        if time.monotonic() > deadline:
            raise SystemExit("the plugin never listened for the gateway")
        time.sleep(0.1)
    os.environ["HERMES_SESSION_ID"] = CHAT
    module._on_post_tool_call(
        tool_name="mcp__cello__cello_initiate_session",
        args={"agent": "Desk", "target": "f" * 64},
        result=json.dumps({"result": json.dumps({"session_id": SESSION, "state": "active"})}),
    )
    # A backend that died and left its socket behind.
    import socket
    stale = socket.socket(socket.AF_UNIX)
    stale.bind(str(Path(os.environ["HERMES_HOME"]) / "cello" / "clients" / "4000000000.sock"))
    stale.close()
    print(json.dumps({"ready": True}), flush=True)
    time.sleep(60)


async def gateway() -> None:
    from gateway.config import PlatformConfig
    from hermes_cli.plugins import get_plugin_manager

    get_plugin_manager().discover_and_load()
    module = next(m for m in sys.modules.values() if getattr(m, "CelloAdapter", None) is not None and hasattr(m, "_on_post_tool_call"))
    adapter = module.CelloAdapter(PlatformConfig(enabled=True, extra={"agent_name": "Desk"}))
    adapter._refresh_bindings()
    landing = adapter._landing_for(SESSION)
    took = await adapter._hand_to_client(landing, "[CELLO] a reply on session " + SESSION) if landing else False
    refused = await adapter._hand_to_client("20261109_000000_aaaaaa", "for a chat nobody has open")
    print(json.dumps({"landing": landing, "took": took, "refused": refused}), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "client":
        client()
    else:
        asyncio.run(gateway())
