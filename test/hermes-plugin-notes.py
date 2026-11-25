"""Loads the real Hermes plugin with stand-ins for Hermes's own modules, and prints the text it makes of a read that
carries the agent's notes and a Reminder, for notes.test.ts to check the two are kept apart."""
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

page = json.loads(sys.argv[2])
print(json.dumps({"notes": plugin._note_lines(page), "reminders": plugin._reminder_lines(page, page.get("session"))}))
