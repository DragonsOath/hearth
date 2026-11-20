# Voice: speak to Ember, voices and personalities (as built 2026-10-11)

Supersedes the plan in `VOICE_INPUT.md` for V1. Brief: `WARDEN_VOICE_BRIEF.md`; recovery report:
`WARDEN_STAGE_A_REPORT.md`.

## Shape

```
Browser mic (any device, https)  --16 kHz PCM-->  Hearth (the home server)  POST /api/voice/transcribe
      --Wyoming-->  Whisper on ai-box (192.168.1.50:10300, faster-whisper small.en, GPU)
  text lands in the Ember's box; you check it and press Send (same conversation, tools, approvals)
Answer text  -->  POST /api/voice/speak  --Wyoming-->  Piper on ai-box (192.168.1.50:10200)
      voice chosen by name per request  -->  WAV  -->  browser speaker (Stop any time)
```

- Hearth's server is the only client; the browser never reaches ai-box. Owner session only:
  access keys get 403 on every voice route and cannot claim a message was spoken.
- The speech services get one request's audio or text, nothing else: no tools, records, or secrets.
- A spoken question is answered aloud; "speak every answer" (speaker button, per device) reads typed
  ones too. Spoken questions put the AI in short, plain spoken style and tell it a word may be
  misheard: it asks before planning a change whose target, file name, or number looks uncertain.
- Settings > Ember > Voice: the speech machine (default from `DC_VOICE_HOST`, set to
  192.168.1.50 on the home server), whether Whisper and Piper answer, and the voice profiles.
- Text-only always works: if ai-box is off or not signed in, the mic and speaker say so.

## Voices and personalities (shared with Home Assistant)

One voice library: **Piper on ai-box**, in its `data\piper` folder. Every `.onnx` voice there is
served by name to anything that asks: Home Assistant and Hearth both. Adding a file adds a
voice everywhere; nothing is restarted and existing voices are untouched.

| Voice file | Status |
| --- | --- |
| `en_US-belle-medium` | Belle's trained voice (Mellow take 7), installed 2026-10-11 |
| `en_US-lessac-high` | stock voice Belle used before |
| `en_US-warden-medium` | Warden (Guardian), installed 2026-10-12 |
| `en_US-saoirse-medium` | Saoirse (Cork, VCTK p283), installed 2026-10-12 |
| `en_US-operator-medium` | Operator archetype, installed 2026-10-14 |
| `en_US-enchantress-medium` | Enchantress archetype (Cork, p283), installed 2026-10-14 |
| `en_US-scholar-medium`, `en_US-companion-medium` | training 2026-10-14 to 15 |

**Ember:** a profile = name + voice + personality (style only). Choosing a profile gives the
AI that name (Identity can still change it) and adds the personality to its instructions before the
rules, which never change. Add, edit, remove, hear, and switch in Settings.

**The five archetypes** are built in (`DEFAULT_VOICE_PROFILES`): Guardian (Warden, the dragon),
Operator, Enchantress, Scholar, and Companion, each with a default picture in
`apps/web/public/archetypes/` (512 px WebP; full-size originals stay in `private/`). A profile
saved before an archetype existed gains it; one the owner removed stays gone. The Home hub shows the
picture of the profile in use.

**Effects** are added when a voice plays, never trained into it: the Companion's voice box is an
ffmpeg filter (`VOICE_EFFECTS.voicebox`: rubberband pitch 1.04 with formant shift, chorus, a 3 ms
echo, band limits, loudness) run by the server on each spoken answer at the voice's own sample
rate. Without ffmpeg (or its rubberband filter) the plain voice is used and the server log says so.

**Addresses are spelled out** for speech ("one nine two dot one six eight dot one dot ten"): the
voices otherwise read an IP address as one long number or stumble over it.

**Home Assistant:** an assistant = a pipeline (its voice) + a conversation agent (its personality).
Belle is one. To change a voice: HA > Settings > Voice assistants > Belle > Text-to-speech voice
(every Piper voice is listed). To change a personality: HA > Settings > Devices & services > Ollama >
the agent > Configure > instructions. A new character for HA (Saoirse) = a new Ollama agent with her
instructions plus a new assistant using it and her voice; pick it per device or make it preferred.

**Making a new voice** (how Belle was made; tools on ai-box, `..\Ember Voices\README.md`):
Qwen3-TTS VoiceDesign auditions from a description, owner picks a take, Qwen3-TTS Base clones it
into about 1,900 lines, Whisper filters them, Piper fine-tune overnight (about 5 hours, Belle's
Ollama model unloaded meanwhile), export `.onnx` + `.onnx.json` into the Piper folder above.

## Not done yet

- Warden's voice (needs the owner's pick, then the overnight training run).
- Hands-free / wake word, streaming, interrupting (follow-ons; push-to-talk today).
- Hearth editing Home Assistant's assistants for you (needs an HA token decision, 13.2).
