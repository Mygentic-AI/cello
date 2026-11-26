"""Loads the real Hermes plugin with stand-ins for Hermes's own modules, for notes.test.ts.

lines <page>: prints the text the plugin makes of a read that carries the agent's notes and a Reminder.
drive <scenario>: builds the plugin's adapter, answers its daemon calls from the scenario, sends it each bell through
                  its own entry point, and prints every turn it started and every call it made. Nothing of Hermes runs:
                  the stand-in gateway records the turn instead of giving it to a model. With "landing" and "bindings",
                  those Hermes sessions are open in a stand-in gateway, and a turn woken in one is recorded with chat
                  "wake:<its session id>".
"""
import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types

TURNS = []


class BasePlatformAdapter:
    def __init__(self, config, platform):
        self.config = config
        self.platform = platform
        self._message_handler = True
        self._active_sessions = {}
        self._pending_messages = {}

    def build_source(self, **fields):
        return types.SimpleNamespace(**fields)

    async def handle_message(self, event):
        TURNS.append({"chat": event.source.chat_id, "user": event.source.user_id, "text": event.text})


class MessageEvent:
    def __init__(self, **fields):
        self.__dict__.update(fields)


def stand_in(name, **names):
    module = types.ModuleType(name)
    module.__dict__.update(names)
    sys.modules[name] = module


stand_in("gateway")
stand_in("gateway.config", Platform=str, PlatformConfig=types.SimpleNamespace)
stand_in("gateway.platforms")
stand_in("gateway.platforms.base", BasePlatformAdapter=BasePlatformAdapter, MessageEvent=MessageEvent, MessageType=types.SimpleNamespace(TEXT="text"), SendResult=types.SimpleNamespace, merge_pending_message_event=lambda *a, **k: None)
stand_in("gateway.session", build_session_key=lambda source, **k: source.chat_id)
stand_in("gateway.session_context", get_session_env=lambda *a, **k: None)
HOME = tempfile.mkdtemp()
os.environ["HERMES_HOME"] = HOME
# The plugin finds its Hermes home through this, and without it would read the real one under the user's home.
stand_in("hermes_constants", get_hermes_home=lambda: HOME)


async def deliver_wake(adapter, text, session_id, source, notification_category):
    TURNS.append({"chat": "wake:" + session_id, "user": "", "text": text})


stand_in("gateway.wake", deliver_wake=deliver_wake)

spec = importlib.util.spec_from_file_location("cello_plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


async def drive(scenario):
    bindings = scenario.get("bindings") or {}
    os.makedirs(os.path.join(HOME, "cello"), exist_ok=True)
    with open(os.path.join(HOME, "cello", "session-bindings.json"), "w") as out:
        json.dump(bindings, out)
    adapter = plugin.CelloAdapter(types.SimpleNamespace(extra={"agent_name": "Ann", "session_scope": scenario["scope"], "landing_session": scenario.get("landing")}))
    open_here = [one for one in [scenario.get("landing"), *bindings.values()] if one]
    if open_here:
        origin = types.SimpleNamespace(platform="desktop")
        store = types.SimpleNamespace(list_sessions=lambda: [types.SimpleNamespace(session_id=one, origin=origin, session_key=one) for one in open_here])
        adapter.gateway_runner = types.SimpleNamespace(session_store=store, adapters={"desktop": object()})
    answers = scenario["answers"]
    calls = []

    async def call(method, params=None, timeout=None):
        calls.append({"method": method, "params": params or {}})
        queue = answers.get(method) or []
        if not queue:
            raise RuntimeError("the scenario has no answer left for " + method)
        return queue.pop(0)

    adapter._call = call
    for frame in scenario["bells"]:
        await adapter._on_notification(frame)
    return {"turns": TURNS, "calls": calls}


if sys.argv[2] == "drive":
    print(json.dumps(asyncio.run(drive(json.loads(sys.argv[3])))))
else:
    page = json.loads(sys.argv[2])
    print(json.dumps({"notes": plugin._note_lines(page), "reminders": plugin._reminder_lines(page, page.get("session"))}))
