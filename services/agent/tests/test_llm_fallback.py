"""Brand Brain LLM: thinking off for reasoning models, <think> dropped, River -> NIM fallback."""
import asyncio
import sys
import types

from app.llm import LLM, TokenBudget, _ThinkFilter, _thinks


def _chunks(texts):
    async def gen():
        for t in texts:
            yield types.SimpleNamespace(choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content=t))])
    return gen()


def _fake_litellm(monkeypatch, behaviour):
    calls = []

    async def acompletion(**kw):
        calls.append(kw)
        b = behaviour[len(calls) - 1]
        if isinstance(b, Exception):
            raise b
        return _chunks(b)

    monkeypatch.setitem(sys.modules, "litellm", types.SimpleNamespace(acompletion=acompletion))
    return calls


def _run(llm):
    return asyncio.run(llm.complete("org1", "ask", {}, "q?"))


def test_think_filter_drops_reasoning_across_pieces():
    f = _ThinkFilter()
    out = "".join(f.feed(p) for p in ["<thi", "nk>plan the", " answer</th", "ink>Use the ", "logo <b>", " always"]) + f.flush()
    assert out == "Use the logo <b> always"
    assert _thinks("nvidia/nemotron-3.5-lightning-30b-a3b") and _thinks("Qwen/Qwen3.8-27B-FP8") and not _thinks("gpt-4o-mini")


def test_chain_falls_through_river_402_and_empty_to_nim(monkeypatch):
    monkeypatch.setenv("LLM_CHAIN", "river,nim")
    llm = LLM(TokenBudget(limit=10**9))
    llm.model = "chain"
    calls = _fake_litellm(monkeypatch, [RuntimeError("402 Payment Required"), ["Answer from NIM."]])
    assert _run(llm) == "Answer from NIM."
    assert [c["model"].split("/")[1] for c in calls] == ["Qwen", "nvidia"]
    assert calls[1]["extra_body"] == {"chat_template_kwargs": {"enable_thinking": False}}

    calls = _fake_litellm(monkeypatch, [["<think>only thinking</think>", "  "], ["Final."]])
    assert _run(llm) == "Final."


def test_single_nemotron_model_turns_thinking_off(monkeypatch):
    llm = LLM(TokenBudget(limit=10**9))
    llm.model = "openai/nvidia/nemotron-3.5-lightning-30b-a3b"
    calls = _fake_litellm(monkeypatch, [["Hi", " there"]])
    assert _run(llm) == "Hi there"
    assert calls[0]["extra_body"] == {"chat_template_kwargs": {"enable_thinking": False}}
