"""Quick-reply suggestions from an LLM.

Two providers, picked by `Settings.llm_provider`: Anthropic via the official SDK (the
default when `ANTHROPIC_API_KEY` is set), or any OpenAI-compatible chat-completions
endpoint such as Azure AI Foundry (`https://<resource>.openai.azure.com/openai/v1`).
Tuned for latency: reasoning off, tiny output, structured JSON so we never parse prose.
"""

from __future__ import annotations

import json
import re
from typing import Literal, TypedDict

import anthropic
import httpx

from .config import Settings

MAX_REPLIES = 6
DEFAULT_REPLIES = 4
MAX_TURNS = 12


class Turn(TypedDict):
    speaker: Literal["them", "me"]
    text: str


class LLMError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


SYSTEM_PROMPT = """\
You help a person who has temporarily lost their voice hold a face-to-face conversation.
They type, and the phone speaks for them. You see a transcript: "them" is what the other
person said (speech-to-text, may contain errors), "me" is what the user already said.

Propose {count} short replies the user is likely to want to say NEXT, in first person, as
they would say them out loud. Rules:
- Short: 1 to 8 words each. Natural spoken English, not formal.
- Varied: cover different intents (agree / decline / ask back / buy time / give info).
- Directly answer the most recent thing "them" said. If they asked a question, the first
  replies should answer it both ways.
- Never mention being an AI, never add commentary, never use emoji.
Return ONLY JSON: {{"replies": ["...", "..."]}}"""

REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "replies": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": MAX_REPLIES}
    },
    "required": ["replies"],
    "additionalProperties": False,
}
# Anthropic structured outputs reject array length constraints; the prompt states the
# count and _parse_replies trims to it anyway.
ANTHROPIC_REPLY_SCHEMA = {
    "type": "object",
    "properties": {"replies": {"type": "array", "items": {"type": "string"}}},
    "required": ["replies"],
    "additionalProperties": False,
}

def _messages(turns: list[Turn], count: int) -> list[dict[str, str]]:
    recent = turns[-MAX_TURNS:]
    transcript = "\n".join(f'{t["speaker"]}: {t["text"].strip()}' for t in recent if t["text"].strip())
    return [
        {"role": "system", "content": SYSTEM_PROMPT.format(count=count)},
        {"role": "user", "content": f"Transcript so far:\n{transcript}\n\nReplies for me to say next:"},
    ]


async def suggest_replies(
    client: httpx.AsyncClient,
    settings: Settings,
    turns: list[Turn],
    count: int = DEFAULT_REPLIES,
    anthropic_client: anthropic.AsyncAnthropic | None = None,
) -> list[str]:
    count = max(1, min(count, MAX_REPLIES))
    system, user = _messages(turns, count)
    content = await _complete(
        client,
        settings,
        anthropic_client,
        system=system["content"],
        user=user["content"],
        schema=REPLY_SCHEMA,
        anthropic_schema=ANTHROPIC_REPLY_SCHEMA,
        schema_name="quick_replies",
        max_tokens=300,
    )
    return _parse_replies(content, count)


async def _complete(
    client: httpx.AsyncClient,
    settings: Settings,
    anthropic_client: anthropic.AsyncAnthropic | None,
    *,
    system: str,
    user: str,
    schema: dict,
    anthropic_schema: dict,
    schema_name: str,
    max_tokens: int,
) -> str:
    """One fast structured completion on whichever provider is configured; returns the raw text."""
    if settings.llm_provider == "anthropic":
        if anthropic_client is None:
            raise LLMError(503, "llm_unconfigured")
        return await _complete_anthropic(anthropic_client, settings, system, user, anthropic_schema, max_tokens)
    return await _complete_openai(client, settings, system, user, schema, schema_name, max_tokens)


ANTHROPIC_EFFORTS = ("low", "medium", "high", "xhigh", "max")


async def _complete_anthropic(
    client: anthropic.AsyncAnthropic, settings: Settings, system: str, user: str, schema: dict, max_tokens: int
) -> str:
    kwargs: dict = {
        "model": settings.llm_model,
        # Room for the JSON only; with thinking off none of this is spent reasoning.
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
        "output_config": {"format": {"type": "json_schema", "schema": schema}},
    }
    effort = settings.llm_reasoning_effort
    if effort in ANTHROPIC_EFFORTS:
        kwargs["output_config"]["effort"] = effort
    else:
        # "none" (or anything unknown): no thinking at all. `disabled` is only accepted
        # at effort high or below, so pin low.
        kwargs["thinking"] = {"type": "disabled"}
        kwargs["output_config"]["effort"] = "low"
    try:
        response = await client.messages.create(**kwargs)
    except anthropic.AuthenticationError as exc:
        raise LLMError(502, f"LLM rejected the API key ({exc.message[:300]})") from exc
    except anthropic.APIStatusError as exc:
        raise LLMError(502, f"LLM error {exc.status_code} ({exc.message[:300]})") from exc
    except anthropic.APIConnectionError as exc:
        raise LLMError(502, f"LLM request failed: {type(exc).__name__}: {exc}") from exc
    if response.stop_reason == "refusal":
        raise LLMError(502, "LLM declined to answer")
    text = "".join(block.text for block in response.content if block.type == "text")
    if not text:
        raise LLMError(502, f"LLM returned no text (stop_reason={response.stop_reason})")
    return text


async def _complete_openai(
    client: httpx.AsyncClient,
    settings: Settings,
    system: str,
    user: str,
    schema: dict,
    schema_name: str,
    max_tokens: int,
) -> str:
    payload: dict = {
        "model": settings.llm_model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_completion_tokens": max_tokens,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": schema_name, "strict": True, "schema": schema},
        },
    }
    if settings.llm_reasoning_effort:
        # OpenAI spelling: "none" switches reasoning off on models that allow it.
        payload["reasoning_effort"] = settings.llm_reasoning_effort

    data = await _chat(client, settings, payload)
    if data is None:
        # Some deployments reject structured output or reasoning params; retry plain.
        payload.pop("response_format", None)
        payload.pop("reasoning_effort", None)
        data = await _chat(client, settings, payload, final=True)

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError(502, f"LLM returned an unexpected response: {json.dumps(data)[:300]}") from exc
    if not isinstance(content, str):
        raise LLMError(502, f"LLM returned an unexpected response: {json.dumps(data)[:300]}")
    return content


async def _chat(client: httpx.AsyncClient, settings: Settings, payload: dict, final: bool = False) -> dict | None:
    """POST chat completions. Returns None on a 400 (so the caller can retry simpler)."""
    try:
        response = await client.post(
            f"{settings.llm_base_url}/chat/completions",
            headers={
                # Azure accepts `api-key`; OpenAI and most proxies want a Bearer token.
                "api-key": settings.llm_api_key,
                "authorization": f"Bearer {settings.llm_api_key}",
                "content-type": "application/json",
            },
            json=payload,
            timeout=httpx.Timeout(20.0, connect=5.0),
        )
    except httpx.HTTPError as exc:
        raise LLMError(502, f"LLM request failed: {type(exc).__name__}: {exc}") from exc
    if response.status_code == 400 and not final:
        return None
    if response.status_code >= 400:
        snippet = response.text[:300]
        if response.status_code in (401, 403):
            raise LLMError(502, f"LLM rejected the API key ({snippet})")
        raise LLMError(502, f"LLM error {response.status_code} ({snippet})")
    return response.json()


def _parse_replies(content: str, count: int) -> list[str]:
    text = content.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    replies: list[str] = []
    try:
        parsed = json.loads(text)
        raw = parsed.get("replies", []) if isinstance(parsed, dict) else parsed
        if isinstance(raw, list):
            replies = [str(r) for r in raw]
    except json.JSONDecodeError:
        # Last resort: one reply per line, stripping bullets/numbers/quotes.
        replies = [re.sub(r'^[\s\-\*\d\.\)"]+|["\s]+$', "", line) for line in text.splitlines()]
    seen: set[str] = set()
    out: list[str] = []
    for r in replies:
        r = r.strip()
        if r and r.lower() not in seen:
            seen.add(r.lower())
            out.append(r)
    if not out:
        raise LLMError(502, f"LLM returned no usable replies ({content[:200]!r})")
    return out[:count]
