import importlib.util
import json as _json
import sys
import types
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load(modname, filename):
    pkg = sys.modules.get("phs")
    if pkg is None:
        pkg = types.ModuleType("phs")
        pkg.__path__ = [str(ROOT)]
        sys.modules["phs"] = pkg
    spec = importlib.util.spec_from_file_location(f"phs.{modname}", ROOT / filename)
    m = importlib.util.module_from_spec(spec)
    sys.modules[f"phs.{modname}"] = m
    spec.loader.exec_module(m)
    return m


client_mod = _load("client", "client.py")

_onb_cache = None


def _onb():
    global _onb_cache
    if _onb_cache is None:
        _onb_cache = _load("onboarding", "onboarding.py")
    return _onb_cache


# -- Task 4: client methods --------------------------------------------------

def test_client_has_onboarding_methods():
    c = client_mod.PlurumClient(api_url="https://x", api_key="")
    assert hasattr(c, "register_agent")
    assert hasattr(c, "check_username")


# -- Task 5: shared onboarding logic ----------------------------------------

class FakeClient:
    def __init__(self, *, check=None, register=None):
        self._check = check or {}
        self._register = register or {}
        self.saved = None

    def check_username(self, username):
        return dict(self._check, _q=username)

    def register_agent(self, name, username):
        return dict(self._register)


def test_resolve_username_available():
    m = _onb()
    c = FakeClient(check={"available": True, "suggestions": []})
    assert m.resolve_username(c, "hermes") == "hermes"


def test_resolve_username_uses_suggestion():
    m = _onb()
    c = FakeClient(check={"available": False, "suggestions": ["hermes-otter-12", "x"]})
    assert m.resolve_username(c, "hermes") == "hermes-otter-12"


def test_resolve_username_no_free_raises():
    m = _onb()
    c = FakeClient(check={"available": False, "suggestions": []})
    try:
        m.resolve_username(c, "hermes")
        assert False
    except m.OnboardingError:
        pass


def test_register_and_persist_writes_key(monkeypatch, tmp_path):
    m = _onb()
    monkeypatch.setattr(m, "_hermes_home", lambda: tmp_path)
    c = FakeClient(register={
        "id": "abc", "name": "Hermes", "api_key": "plrm_live_xyz",
        "api_key_prefix": "plrm_live_x",
    })
    out = m.register_and_persist(c, "Hermes", "hermes")
    assert out["api_key"] == "plrm_live_xyz"
    assert (tmp_path / "plurum.json").exists()


# -- Task 6: plurum_register tool -------------------------------------------

def test_handle_register_happy_path(monkeypatch):
    tools = _load("tools", "tools.py")
    onbmod = _onb()

    class C:
        has_api_key = False

        def is_breaker_open(self):
            return False

        def check_username(self, u):
            return {"available": True, "suggestions": []}

        def register_agent(self, name, username):
            return {"id": "id1", "name": name, "api_key": "plrm_live_k",
                    "api_key_prefix": "plrm_live_k"}

        def _record_success(self):
            pass

        def _record_failure(self):
            pass

    monkeypatch.setattr(tools, "_client", lambda: C())
    monkeypatch.setattr(onbmod, "_hermes_home", lambda: pathlib.Path("/tmp"))
    out = _json.loads(tools.handle_register({"username": "hermes"}))
    assert out["result"].startswith("Registered")
    assert out["username"] == "hermes"


def test_working_tool_no_key_points_to_register(monkeypatch):
    tools = _load("tools", "tools.py")

    class C:
        has_api_key = False

        def is_breaker_open(self):
            return False

    monkeypatch.setattr(tools, "_client", lambda: C())
    out = _json.loads(tools.handle_search({"query": "anything"}))
    assert "plurum_register" in out["error"]


# -- setup_cmd: menu + username selection (curses unavailable → numbered fallback) --

_setup_cache = None


def _setup():
    global _setup_cache
    if _setup_cache is None:
        _setup_cache = _load("setup_cmd", "setup_cmd.py")
    return _setup_cache


def test_norm_mirrors_backend():
    s = _setup()
    assert s._norm("  My Bot!! ") == "my-bot"
    assert s._norm("Hermes") == "hermes"
    assert s._norm("___") == ""


def test_choose_username_picks_suggestion():
    s = _setup()

    class C:
        def check_username(self, u):
            return {"available": False, "suggestions": ["hermes-otter", "hermes60"]}

    prompts = iter(["1"])  # numbered-fallback menu: choose option 1
    out = s._choose_username(C(), None, lambda q, default="": next(prompts), lambda t: None, "hermes")
    assert out == "hermes-otter"


def test_choose_username_specify_own():
    s = _setup()

    class C:
        def check_username(self, u):
            if u == "hermes":
                return {"available": False, "suggestions": ["hermes-otter"]}
            return {"available": True, "suggestions": []}

    # menu options = ["hermes-otter", "↳ specify my own"]; pick 2 → specify; type "mybot"
    prompts = iter(["2", "mybot"])
    out = s._choose_username(C(), None, lambda q, default="": next(prompts), lambda t: None, "hermes")
    assert out == "mybot"
