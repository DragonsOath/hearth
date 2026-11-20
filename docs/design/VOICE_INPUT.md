# Voice input for Ember: findings and roadmap (2026-10-09, not built)

> Correction 2026-10-11: a Whisper server already runs on ai-box (Belle's `belle-whisper`, faster-whisper small.en on the GPU, Wyoming on 192.168.1.50:10300, reachable from the home server), with Piper TTS on 10200. V1 does not need a new install. See `WARDEN_STAGE_A_REPORT.md`.

The owner's direction: private local speech recognition (Whisper on the AI box GPU),
Hearth on the home server receiving the text over a secure connection, microphone capture kept separate
from transcription so desktop browsers, phones, and Home Assistant/Belle can all feed it. Use
the microphone the browser or operating system already exposes, including the VirtualHere one.
Nothing in VirtualHere, USB ownership, or audio routing changes, and no voice service is
installed until the owner approves the build. This is a later phase, after the real-AI verification.

## VirtualHere: what is actually set up (checked read-only 2026-10-09)

| Machine | VirtualHere role | Detail |
| --- | --- | --- |
| ai-box (192.168.1.50) | **USB Server** 4.8.7, port 7575 | A USB microphone is physically plugged in here, with mouse, keyboard, NZXT devices, Bluetooth. Runs as a program started by hand (not a Windows service). |
| Home Vault (192.168.1.123) | **Client** 6.0.1 (the file is named `vhusbdwinw64.exe`, but it is the client) | Currently **using the microphone**: Windows shows "A USB microphone" on the VirtualHere virtual USB controller. |
| the home server (192.168.1.10) | **Client** (`virtualhere-client.service`, systemd) | Connected to ai-box's hub, sees the microphone, reports `In-use by: (Home Vault) at 192.168.1.123`. Auto-Use All is off. |

**Simultaneous access: no.** VirtualHere attaches a USB device to one client at a time. The
microphone belongs to whichever machine has it attached right now; the home server's client confirms
the other machines see it as in use. Nothing in the current configuration changes that (no
setting turns on sharing). So "one microphone, three PCs" works today by moving it between
machines, not by sharing it at the same moment.

Observation, no action taken: because the server on ai-box is started by hand, sharing
stops after ai-box restarts until it is started again.

## What this means for the design

1. **Capture where the owner is, not on the home server.** The browser asks the operating system for a
   microphone (`getUserMedia`). On whichever PC currently holds the microphone through VirtualHere,
   Chrome sees it as an ordinary microphone, with nothing VirtualHere-specific. The home server never needs
   the microphone: it has no browser session and only receives audio or text. So the current
   VirtualHere setup works without changing it, and no PC needs its own microphone.
2. **Say why the mic isn't available, instead of failing silently.** When the microphone is
   attached to another PC, the browser reports no device or a busy device. Ember should
   say: "No microphone is available on this computer. If you share it with VirtualHere, it may
   be attached to another PC right now." It should never try to grab the device or change
   VirtualHere.
3. **Pick the input device.** A small microphone choice (system default or a named device)
   remembered per device, the same way writing help is.

## Architecture: capture, transport, transcription kept separate

```
 Capture (anywhere)            Hearth (the home server)              Transcriber (ai-box)
 ------------------            ----------------------              ---------------------
 Desktop browser  --audio-->   /api/voice/transcribe   --audio-->  Whisper on the 3080
 Phone browser    --audio-->   (signed-in or access    <--text---  (faster-whisper)
 HA / Belle       --audio-->    key, size + length cap,
   (or HA sends                 no audio stored, audit
    finished text)              line without content)
                          text goes back into the message box for the owner to review
```

- **Capture** produces a short audio clip (Opus in WebM from the browser), push to talk first.
  Hands-free listening is not planned.
- **Hearth** is the only thing capture devices talk to: one sign-in, one access-key
  model, one audit trail. It caps size and length (for example 60 seconds or 2 MB), keeps no
  audio, and passes the clip to the configured transcriber. The transcriber is a provider
  setting (`whisper-remote` first; "none" means voice is off), so another engine can be added
  later without touching capture.
- **Transcription on ai-box**: a Whisper server (faster-whisper, GPU) reachable only from
  The home server. Either the tailnet with a shared key, or LAN with a firewall rule limited to the home server's
  address: the owner's choice at build time.
- **The text lands in the message box, not sent.** the owner reads it and presses send, exactly like
  typed text. Writing help can run on it. Nothing goes to a third party until they send it, the
  same as typing.
- **Home Assistant / Belle** can use the same ai-box transcriber. Home Assistant's own Assist
  speaks the Wyoming protocol, and a Wyoming faster-whisper server on ai-box could serve both
  Home Assistant and Hearth. Belle then sends finished text to Hearth's existing
  conversation endpoint. The private path for that is verified (below).

## Belle to Hearth: private path (verified read-only 2026-10-09)

The Home Assistant container on the home server resolves and reaches `https://homeserver.tail1a2b3c.ts.net`
(health 200 with valid TLS, from inside the container). The traffic stays on the home server. No public
exposure, new port, or change to Hearth's listen address is needed. Wiring it (an
access key with Talk-to-the-operator scope in Home Assistant's `secrets.yaml`, a
`rest_command`, a script) changes Home Assistant's configuration, so it waits for the owner's
approval. Details in `docs/HOME_ASSISTANT.md`.

## Phases

| Phase | What | Needs |
| --- | --- | --- |
| Now | The phone keyboard's microphone works in the message box today (goes through the keyboard maker's service). | Nothing |
| V1 | Push-to-talk button, microphone choice, clear "mic attached to another PC" message, `/api/voice/transcribe`, `whisper-remote` provider. | the owner's approval to install a Whisper server on ai-box and choose the connection (tailnet or LAN rule) |
| V2 | Belle: Home Assistant Assist uses the ai-box Wyoming server; Belle relays text to Hearth over the verified tailnet path. | Approval for the Home Assistant configuration change and an access key |
| Later | Spoken replies (local text to speech), more capture devices. | Separate decision |

## Not done, on purpose

No VirtualHere setting, USB owner, audio route, or firewall rule was changed. Nothing was
installed. The microphone stayed attached to Home Vault throughout.
