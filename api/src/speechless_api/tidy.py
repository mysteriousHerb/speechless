"""Dictionary-based typo fixing for typed messages, run just before they are spoken.

Deliberately not an LLM: a model rewrites, this cannot. It walks the text word by word
with SymSpell (a frequency dictionary plus edit-distance lookup, about a millisecond per
sentence) and only replaces a word when it is confident the person fat-fingered a real
word. Everything it is unsure about is left exactly as typed, because a wrong "fix" of a
name or a bit of slang is worse than the voice reading one typo aloud.

Rules, in order:
- Words the person listed as "never change", chat shorthand (lol, dont, im...), words with
  digits or apostrophes, ALL-CAPS tokens and Capitalised words that are not the first word
  of a sentence (names) are left alone.
- Words already in the dictionary are left alone (so real-word slips like "form"/"from"
  are not caught; that is the price of never rewriting).
- Short words (under MIN_LEN letters) are only fixed when swapping two adjacent letters
  yields a dictionary word ("teh" -> "the", "hwo" -> "how", "adn" -> "and"), the single
  most common fast-typing error.
- Longer words accept the most frequent dictionary word within one edit (two edits for
  words of 7+ letters), preferring an adjacent-letter swap when one exists.
"""

from __future__ import annotations

import re
from importlib import resources
from threading import Lock

from symspellpy import SymSpell, Verbosity

MIN_LEN = 4
LONG_WORD = 7
# Below this corpus frequency a suggestion is too obscure to trust over what was typed.
MIN_SUGGESTION_COUNT = 1_000_000

# Spoken-English shorthand that is not in the dictionary (or is, as something else).
CHAT_WORDS = frozenset(
    """
    ok okay lol omg btw idk brb tbh imo fyi asap ppl pls plz thx ty tmrw tho cuz ya yeah yep yup
    nope nah hmm ugh meh wow yay oops aw aww hey hiya yo sec mins hr hrs min dont cant wont didnt
    doesnt isnt wasnt arent werent havent hasnt hadnt couldnt wouldnt shouldnt im ive ill id
    youre youve youll youd theyre theyve theyll thats whats whos hes shes its lets gonna wanna
    gotta kinda sorta dunno gimme lemme innit
    """.split()
)

_WORD = re.compile(r"[A-Za-z][A-Za-z']*")
_SENTENCE_END = re.compile(r"[.!?]\s*$")

_sym: SymSpell | None = None
_lock = Lock()


def load() -> SymSpell:
    """Load the English frequency dictionary once (about a second); safe to call early."""
    global _sym
    if _sym is None:
        with _lock:
            if _sym is None:
                sym = SymSpell(max_dictionary_edit_distance=2, prefix_length=7)
                path = resources.files("symspellpy") / "frequency_dictionary_en_82_765.txt"
                sym.load_dictionary(str(path), term_index=0, count_index=1)
                _sym = sym
    return _sym


def tidy_text(text: str, keep: set[str] | frozenset[str] = frozenset()) -> str:
    """Return `text` with confident typo fixes applied; spacing and punctuation untouched."""
    sym = load()
    keep_lower = {w.lower() for w in keep}
    out: list[str] = []
    last = 0
    for m in _WORD.finditer(text):
        word = m.group()
        before = text[last : m.start()]
        out.append(before)
        at_sentence_start = last == 0 or _SENTENCE_END.search(text[:m.start()]) is not None
        out.append(_fix_word(sym, word, keep_lower, at_sentence_start))
        last = m.end()
    out.append(text[last:])
    return "".join(out)


def _fix_word(sym: SymSpell, word: str, keep: set[str], at_sentence_start: bool) -> str:
    lower = word.lower()
    if lower in keep or lower in CHAT_WORDS or "'" in word:
        return word
    if word.isupper() and len(word) > 1:
        return word  # acronym or shouting
    if word[0].isupper() and not at_sentence_start:
        return word  # a name
    if sym.words.get(lower):
        return word  # already a word
    fixed = _swap_fix(sym, lower)
    if fixed is None and len(lower) >= MIN_LEN:
        distance = 2 if len(lower) >= LONG_WORD else 1
        hits = sym.lookup(lower, Verbosity.TOP, max_edit_distance=distance)
        if hits and hits[0].count >= MIN_SUGGESTION_COUNT:
            fixed = hits[0].term
    if fixed is None or fixed == lower:
        return word
    return _match_case(word, fixed)


def _swap_fix(sym: SymSpell, lower: str) -> str | None:
    """The dictionary word, if any, reached by swapping one pair of adjacent letters."""
    best: tuple[int, str] | None = None
    for i in range(len(lower) - 1):
        if lower[i] == lower[i + 1]:
            continue
        candidate = lower[:i] + lower[i + 1] + lower[i] + lower[i + 2 :]
        count = sym.words.get(candidate, 0)
        if count >= MIN_SUGGESTION_COUNT and (best is None or count > best[0]):
            best = (count, candidate)
    return best[1] if best else None


def _match_case(original: str, fixed: str) -> str:
    if original[0].isupper():
        return fixed[0].upper() + fixed[1:]
    return fixed
