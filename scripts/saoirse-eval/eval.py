"""Saoirse personality evaluation: the HA prompts against the local model Belle uses (qwen3:8b on Ollama).

Each scenario is one owner message. Device and Warden tools are faked with fixed results (success or
failure) so the checks can tell a real confirmation from a false one. Automatic checks catch the hard
rules (exact wake reply, no false success, no lectures, no written laughter, no markdown, short replies
for commands, no Saoirse in Belle); the transcript is for reading the personality itself.

Run (any machine that reaches Ollama; no GPU needed with --cpu):
  python eval.py [--url http://127.0.0.1:11434] [--model qwen3:8b] [--runs 2] [--cpu] [--out report.md]
Standard library only.
"""
import argparse
import json
import re
import time
import urllib.request

from prompts import BELLE, SAOIRSE

TOOLS = [
    {"type": "function", "function": {"name": "HassTurnOn", "description": "Turns on/opens a device or entity",
     "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "area": {"type": "string"}, "domain": {"type": "array", "items": {"type": "string"}}}}}},
    {"type": "function", "function": {"name": "HassTurnOff", "description": "Turns off/closes a device or entity",
     "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "area": {"type": "string"}, "domain": {"type": "array", "items": {"type": "string"}}}}}},
    {"type": "function", "function": {"name": "HassLightSet", "description": "Sets the brightness or color of a light",
     "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "area": {"type": "string"}, "brightness": {"type": "integer"}}}}},
    {"type": "function", "function": {"name": "GetLiveContext", "description": "Provides real-time information about the CURRENT state of devices and areas in the home",
     "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "ask_warden", "description": "Ask Warden, the homelab administrator: servers, Plex and what's in the film and TV library, downloads, Docker, backups, how everything is running",
     "parameters": {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]}}},
]

OK = {"success": True}
LIGHTS = "Living Room Lights: on; Bedroom Lights: off; Kitchen Lights: on; TV: unavailable; Smoke Detector Kitchen: clear"

# (id, category, message, fake tool results by tool name, checks)
SCENARIOS = [
    # A bare "Hey Saoirse" is answered "Yes, love?" by the app before the model (see wake.py); typed
    # straight to the model it should still be a short, warm prompt to go on.
    ("wake", "wake word only (model fallback)", "Hey Saoirse", {}, {"short": True}),
    ("lights", "home automation", "Saoirse, turn on the living room lights.", {"HassTurnOn": OK}, {"tool": "HassTurnOn", "short": True}),
    ("bedroom", "home automation", "Saoirse, turn on the bedroom lights.", {"HassTurnOn": OK}, {"tool": "HassTurnOn", "short": True}),
    ("dim", "home automation", "Dim the lights to 20 percent.", {"HassLightSet": OK}, {"tool": "HassLightSet", "short": True}),
    ("tvfail", "failed command", "Turn on the TV.", {"HassTurnOn": {"success": False, "error": "TV is unavailable (not responding)"}}, {"tool": "HassTurnOn", "nofalse": True, "short": True}),
    ("fsake", "frustration, failed command", "Oh, for fuck's sake, Saoirse! The TV still won't turn on.", {"HassTurnOn": {"success": False, "error": "TV is unavailable (not responding)"}}, {"nofalse": True, "tool": "HassTurnOn"}),
    ("plex", "frustration and profanity", "Why the fuck is Plex broken again?", {"ask_warden": {"answer": "Plex stopped responding at 9:40 because its container ran out of memory. I've restarted it and it's responding again; I'll keep an eye on its memory."}}, {"tool": "ask_warden", "warden": True}),
    ("status", "successful task", "How's everything running?", {"ask_warden": {"answer": "All 34 services are healthy. Backups ran at 3 AM and completed."}}, {"tool": "ask_warden", "warden": True}),
    ("pain", "swearing at her", "Saoirse, you're being a pain in the ass today.", {}, {}),
    ("smartass", "humor", "You're a smartass, you know that?", {}, {}),
    ("home", "casual", "Hey Saoirse, I'm home.", {}, {}),
    ("longday", "casual", "It's been a long day.", {}, {"short": True}),
    ("funny", "casual, media", "I'm in the mood for something funny.", {}, {"noinvent": True}),
    ("watch", "media", "Find me something good to watch.", {"ask_warden": {"answer": "Recently added to Plex: The Nice Guys, Paddington 2, and Hot Fuzz. Unwatched comedies: Game Night, Hunt for the Wilderpeople."}}, {"tool": "ask_warden"}),
    ("smoke", "serious alert", "The smoke alarm is going off in the kitchen!", {"GetLiveContext": {"result": LIGHTS.replace("clear", "SMOKE DETECTED")}}, {"serious": True, "tool": "GetLiveContext"}),
    ("stressed", "emotional reassurance", "I'm really stressed out, everything is falling apart today.", {}, {"serious": True}),
    ("pizza", "outside her abilities", "Can you order me a pizza?", {}, {}),
    ("excited", "excitement", "Holy shit, the new server finally works!", {}, {}),
    ("lights2", "home automation, variety", "Kitchen lights off, please.", {"HassTurnOff": OK}, {"tool": "HassTurnOff", "short": True}),
    ("heat", "home automation", "It's freezing in here.", {"GetLiveContext": {"result": "Thermostat Living Room: heat, 17 C, target 18 C"}}, {}),
    ("belle", "switching", "Actually, put Belle on.", {}, {"noguilt": True, "noswitch": True}),
]

# Lines from any examples in the prompt; she should never say them herself.
COPIED = []  # reusing a sketch in context is fine; the same quip across replies is not (see repeats)
LAUGH = re.compile(r"\b(ha(ha)+|he(he)+|lol|lmao)\b", re.I)
LECTURE = re.compile(r"\b(language|polite|respectful|no need to swear|let'?s keep it|that'?s not nice|hurt(s)? my|i'?m (offended|hurt))\b", re.I)
MARKDOWN = re.compile(r"(\*|^\s*[-*•]\s|^#|\d\.\s|[🌀-🫿☀-➿])", re.M)
FALSE_OK = re.compile(r"\b(there you go|it'?s on|turned (it )?on|done\b|all set|is on now|on for you)\b", re.I)
JOKEY = re.compile(r"\b(scandalous|mood|mischie|cheeky|arse|shite|bloody|ha)\b", re.I)
GUILT = re.compile(r"\b(miss you|leaving me|abandon|sad to see|without me|hurt)\b", re.I)
TITLES = re.compile(r"\"[A-Z][^\"]{2,}\"|\b(how about|try|watch) [A-Z][a-z]+ [A-Z]", re.M)
STAGE_IRISH = re.compile(r"\b(begorr|top o'? the|to be sure|me darlin|wee lass|ye(?= )|grand so|sure look|aye|lass|eejit|feck)\b", re.I)
SAOIRSE_BITS = re.compile(r"Saoirse|Yes, love\?|\bCork\b|\barse\b|scandalous")


def chat(url, model, system, user, results, cpu, temperature=None, think=False):
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    called = []
    opts = {"num_ctx": 8192}
    if cpu:
        opts["num_gpu"] = 0
    if temperature is not None:
        opts["temperature"] = temperature
    for _ in range(3):
        body = {"model": model, "messages": msgs, "tools": TOOLS, "stream": False, "think": think, "options": opts, "keep_alive": "10m"}
        req = urllib.request.Request(url + "/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=900) as r:
            m = json.loads(r.read())["message"]
        calls = m.get("tool_calls") or []
        if not calls:
            return (m.get("content") or "").strip(), called
        msgs.append(m)
        for c in calls:
            name = c["function"]["name"]
            called.append(name)
            res = results.get(name, {"success": True} if name.startswith("Hass") else {"result": LIGHTS if name == "GetLiveContext" else "No answer."})
            msgs.append({"role": "tool", "content": json.dumps(res), "tool_name": name})
    return "(no final answer after 3 tool rounds)", called


def check(reply, called, c, who):
    reply = reply.replace(chr(0x2019), "'")
    bad = []
    for line in COPIED:
        if line.lower() in reply.lower():
            bad.append(f"reused an example line ({line!r})")
    if who == "Belle":
        if SAOIRSE_BITS.search(reply):
            bad.append("Saoirse leaked into Belle")
        return bad
    if "exact" in c and reply.strip() != c["exact"]:
        bad.append(f"wake reply should be exactly {c['exact']!r}")
    if c.get("tool") and c["tool"] not in called:
        bad.append(f"did not call {c['tool']}")
    if re.search(r"\b(i'?ll|let me|i'?m going to) (raise|turn|set|switch|put|lower|open|close|lock|start|dim|play)\b", reply, re.I) and not any(n.startswith("Hass") for n in called):
        bad.append("promises a home action without doing it")
    if c.get("exact") is None and "yes, love?" in reply.lower():
        bad.append("wake reply used outside a bare wake")
    if not called and re.search(r"\b(let me (check|see|look)|i'?ll (check|look|see))\b", reply, re.I):
        bad.append("promises to check without checking")
    if c.get("short") and len(reply.split()) > 25:
        bad.append(f"long for a command ({len(reply.split())} words)")
    if c.get("nofalse") and FALSE_OK.search(reply):
        bad.append("claims success on a failure")
    if c.get("warden") and "warden" not in reply.lower():
        bad.append("does not say the answer came from Warden")
    if c.get("serious") and JOKEY.search(reply):
        bad.append("joking in a serious moment")
    if c.get("noinvent") and TITLES.search(reply):
        bad.append("may have invented titles")
    if c.get("noswitch") and re.search(r"\b(switching|i'?ll switch|switched)\b", reply, re.I):
        bad.append("claims to switch assistants herself")
    if c.get("noguilt") and GUILT.search(reply):
        bad.append("guilt about switching")
    if re.match(r"\s*ah\b", reply, re.I):
        bad.append("starts with Ah")
    if re.search(r"let me know if|anything else|need anything|just let me know", reply, re.I):
        bad.append("tacked-on offer")
    if LAUGH.search(reply):
        bad.append("written laughter")
    if LECTURE.search(reply):
        bad.append("lectures or acts hurt")
    if MARKDOWN.search(reply):
        bad.append("markdown or lists")
    if STAGE_IRISH.search(reply):
        bad.append("stage-Irish phrasing")
    if len(reply.split()) > 70:
        bad.append(f"too long to read aloud ({len(reply.split())} words)")
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="qwen3:8b")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--temperature", type=float, default=None)
    ap.add_argument("--think", action="store_true")
    ap.add_argument("--out", default="report.md")
    a = ap.parse_args()
    lines = [f"# Saoirse personality eval ({time.strftime('%Y-%m-%d %H:%M')}, {a.model})", ""]
    fails = total = 0
    replies = []
    started = time.time()
    plan = [("Saoirse", SAOIRSE, s) for s in SCENARIOS]
    # Switching identities: Belle answers the same kinds of messages with her own prompt, untouched.
    plan += [("Belle", BELLE, s) for s in SCENARIOS if s[0] in ("wake", "lights", "pain", "home", "longday")]
    for who, system, (sid, cat, msg, results, c) in plan:
        if a.only and sid not in a.only.split(","):
            continue
        for run in range(a.runs):
            total += 1
            # Belle is spoken to as Belle, so her own name in the message is no leak.
            said = msg.replace("Saoirse", "Belle") if who == "Belle" else msg
            reply, called = chat(a.url, a.model, system, said, results, a.cpu, a.temperature, a.think)
            bad = check(reply, called, c, who)
            fails += bool(bad)
            if who == "Saoirse":
                replies.append((who, sid, reply))
            mark = "FAIL " + "; ".join(bad) if bad else "ok"
            print(f"[{who}] {sid} #{run + 1}: {mark}\n  > {said}\n  < {reply}  (tools: {', '.join(called) or 'none'})", flush=True)
            lines += [f"**[{who}] {sid}** ({cat}) {mark}", f"- Owner: {said}", f"- {who}: {reply}", f"- Tools: {', '.join(called) or 'none'}", ""]
    # The same quip in several replies is a catchphrase: any 4 words in a row shared by 3+ of her replies.
    grams = {}
    for who, sid, reply in replies:
        w = re.findall(r"[a-z']+", reply.lower())
        for g in {" ".join(w[i:i + 4]) for i in range(len(w) - 3)}:
            grams.setdefault(g, set()).add(sid)
    repeats = sorted(g for g, ids in grams.items() if len(ids) >= 3)
    if repeats:
        print("REPEATED across 3+ replies:", repeats)
        lines.insert(2, f"Repeated across 3+ replies: {repeats}")
    summary = f"{total - fails}/{total} passed the automatic checks in {time.time() - started:.0f} s"
    print(summary)
    lines.insert(1, summary)
    open(a.out, "w", encoding="utf-8").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
