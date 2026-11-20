# Voices

Hearth has two ways to give Ember a voice (Settings > Ember > Voice > Where the voice comes from).

**Standard** (the default for a new install): one clear voice built into Hearth, chosen by the
owner of the project for every Hearth (Kokoro's warm American woman). Nothing to install and no
graphics card: the first time voice is needed, Hearth downloads its voice pack by itself (about
500 MB, once) into its data folder (`voice-pack`), with a progress bar, and from then on it works
offline on this computer's processor. It speaks with Kokoro (82M, Apache 2.0) and listens with
Whisper base.en (Apache 2.0), in a helper process that stops after ten idle minutes so its memory
comes back. The pinned packages are in `apps/server/voice-pack`; the model revisions are pinned in
`apps/server/src/voice/runner.ts`.

**Advanced**: your own speech machine (Piper and Whisper), with the five voice agents below. An
install that already had a speech machine set up keeps using it.

The play button on the AI's messages (the Lair, the Ask page, the War Room) reads that message
aloud in whichever voice is in use.

# The five voices (Advanced)

Hearth comes with five voice agents. Each is a voice and a way of talking; the AI is
the same assistant whichever one is chosen, with the same tools, memory, and approvals.

| Voice | Sounds like | Looks that suit it |
| --- | --- | --- |
| Guardian | a calm, deliberate man | the Guardian's, the Scholar's, the robots |
| Operator | a composed woman, an operations commander | the Operator's, the Enchantress's, the robots, the dragon |
| Enchantress | a warm Irish woman | the same as the Operator |
| Scholar | an older British man | the same as the Guardian |
| Companion | a friendly robot (a man's voice with a voice box) | the same as the Guardian |

A look that is clearly a man or a woman only goes with a voice of the same kind. The dragon, the
armoured dragon knight, the hooded figure, the robots, and your own uploaded picture go with any
voice. A voice you add yourself goes with any look until you say how it sounds (Settings >
Voice > Sounds like).

## Getting them

**From Hearth itself (the normal way):** Settings > Ember > Voice, or the welcome's voice step.
Hearth looks for speech services on this computer and your home network and offers the ones it
finds (one click). When there are none, **Set up voice on this computer** downloads the five
voices, starts the speech programs in Docker, waits until they answer, and switches voice on,
showing each step. No terminal, no addresses to type.

They are not in the repository (about 63 MB each). They are attached to the GitHub release
`voices-v2`, listed with their checksums in `deploy/speech/voices.json`. The same steps are
available from a terminal, for installing agents and scripts:

```sh
pnpm voices check              # what this machine can run (changes nothing)
pnpm voices download           # the five voices, each checked against its checksum
pnpm voices start [--gpu]      # Piper and Whisper in Docker, on ports 10200 and 10300
```

Each takes `--dry-run`. An AI agent installing Hearth asks the person before each piece
(AI_README.md, Step 3b). The speech programs are the same Wyoming services Home Assistant uses,
so one setup can serve both.

## What a machine needs

A graphics card is only needed to make new voices, never to use them.

| Level | Needs | Gives |
| --- | --- | --- |
| No voice | under 4 GB of memory, or a 32-bit processor | typing only |
| Speaking only | a 64-bit processor and 4 GB of memory | the AI speaks; you type |
| Full voice | 4+ processor cores, 8 GB of memory, about 3 GB free disk | talk and listen, with a short pause |
| Best | full voice plus an NVIDIA card with 4 GB+ | listening feels instant |

Measured on 2026-10-15 on an 8-core AMD mini PC with no graphics card (Docker, CPU only): Piper
spoke a 3.9-second sentence in the Scholar's voice in 0.9 seconds, and Whisper (small, int8)
transcribed it in 1.2 seconds. The "Speaking only" and "Best" levels are working targets, not
yet measured on such machines. The GPU setup (`deploy/speech/compose.gpu.yml`) has not yet been
tested in Hearth's own runs.

## How they were made

Each voice is a Piper "medium" model (22,050 Hz), fine-tuned for 300 epochs from Piper's
`ljspeech` medium checkpoint on about 250 to 1,900 short lines. That checkpoint was trained from
scratch on the LJ Speech dataset, which is in the public domain (Keith Ito and Linda Johnson,
2017, https://keithito.com/LJ-Speech-Dataset/; checkpoint from rhasspy/piper-checkpoints). The lines were spoken by
Qwen3-TTS (Apache 2.0), cloning a take chosen by the owner from auditions that were themselves
generated from written descriptions ("a composed woman commanding a starship bridge"). No real
person's voice was cloned, except as below. Every line was checked by Whisper for the right
words, pitch, and pace before training.

- **Enchantress:** built from Irish women speakers in the VCTK corpus. VCTK is licensed under
  CC BY 4.0: Yamagishi, J., Veaux, C., and MacDonald, K. (2019), "CSTR VCTK Corpus: English
  Multi-speaker Corpus for CSTR Voice Cloning Toolkit (version 0.92)", University of Edinburgh,
  The Centre for Speech Technology Research (CSTR).
- **Companion:** trained on a plain voice; its voice box is a sound effect added when it plays
  (ffmpeg), never trained into the model.

**Retrained 2026-10-20 (voices-v2).** The first release, `voices-v1`, started from Piper's
`lessac` checkpoint, whose recordings are licensed for research only. All five were retrained from
the public-domain `ljspeech` checkpoint on their same lines, and checked by Whisper reading back
test sentences. Use `voices-v2`; `voices-v1` must not be used or redistributed.
