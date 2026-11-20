/**
 * Voice for the War Room, from EMBER: the microphone to 16 kHz PCM with a simple level-based
 * end-of-speech detector (EMBER's Whisper turns it into text), and playback of spoken replies with
 * a level meter for the orb.
 */

const WORKLET = `
  class Tap extends AudioWorkletProcessor {
    process(inputs) { const c = inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
  }
  registerProcessor("ember-tap", Tap);`;

const SPEECH = 0.02;
const SILENCE_MS = 1300;
const MAX_MS = 30000;
const NO_SPEECH_MS = 7000;

export class EmberVoice {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private mute: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private rec = false;
  private heard = false;
  private silentFor = 0;
  private startedAt = 0;
  private onDone: ((pcm: Int16Array) => void) | null = null;
  private onLevel: ((l: number) => void) | null = null;
  private current: AudioBufferSourceNode | null = null;

  get recording() {
    return this.rec;
  }
  get playing() {
    return Boolean(this.current);
  }
  get state() {
    return this.ctx ? this.ctx.state : "none";
  }

  /** Browsers only start audio from a click or key press: open it on the first one. */
  unlock = () => {
    this.ensure().catch(() => undefined);
  };

  private async ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  private downsample(buf: Float32Array, from: number) {
    const ratio = from / 16000;
    const out = new Int16Array(Math.floor(buf.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const s = Math.max(-1, Math.min(1, buf[Math.floor(i * ratio)] ?? 0));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  async start(done: (pcm: Int16Array) => void, level: (l: number) => void) {
    const ctx = await this.ensure();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, "ember-tap");
    this.chunks = [];
    this.rec = true;
    this.heard = false;
    this.silentFor = 0;
    this.startedAt = performance.now();
    this.onDone = done;
    this.onLevel = level;
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.rec) return;
      const f = e.data;
      this.chunks.push(f);
      let sum = 0;
      for (let i = 0; i < f.length; i++) sum += (f[i] ?? 0) * (f[i] ?? 0);
      const rms = Math.sqrt(sum / f.length);
      this.onLevel?.(Math.min(1, rms * 12));
      const ms = (f.length / ctx.sampleRate) * 1000;
      const el = performance.now() - this.startedAt;
      if (rms > SPEECH) {
        this.heard = true;
        this.silentFor = 0;
      } else this.silentFor += ms;
      if (
        (this.heard && this.silentFor > SILENCE_MS) ||
        el > MAX_MS ||
        (!this.heard && el > NO_SPEECH_MS)
      )
        this.stop();
    };
    this.src.connect(this.node);
    this.mute = ctx.createGain();
    this.mute.gain.value = 0; // keeps the tap pulled by the audio graph
    this.node.connect(this.mute);
    this.mute.connect(ctx.destination);
  }

  stop() {
    if (!this.rec || !this.ctx) return;
    this.rec = false;
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.mute?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.onLevel?.(0);
    const len = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(len);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const pcm = this.heard ? this.downsample(all, this.ctx.sampleRate) : new Int16Array(0);
    this.onDone?.(pcm);
  }

  /** Closes the mic and throws away what it heard. */
  abort() {
    if (!this.rec) return;
    this.onDone = null;
    this.stop();
  }

  async play(blob: Blob, level: (l: number) => void) {
    const ctx = await Promise.race([
      this.ensure(),
      new Promise<never>((_, no) =>
        setTimeout(
          () =>
            no(
              new Error("the browser is holding sound until you click or press a key on this page"),
            ),
          3000,
        ),
      ),
    ]);
    this.stopPlayback();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const s = ctx.createBufferSource();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    s.buffer = buf;
    s.connect(an);
    an.connect(ctx.destination);
    const data = new Uint8Array(an.fftSize);
    let raf = 0;
    const meter = () => {
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      level(Math.min(1, Math.sqrt(sum / data.length) * 5));
      raf = requestAnimationFrame(meter);
    };
    return new Promise<void>((resolve) => {
      // Only the clip still current clears the flag; one stopped by a newer clip must not.
      s.onended = () => {
        cancelAnimationFrame(raf);
        if (this.current === s) {
          this.current = null;
          level(0);
        }
        resolve();
      };
      this.current = s;
      s.start();
      meter();
    });
  }

  stopPlayback() {
    if (this.current) {
      try {
        this.current.stop();
      } catch {
        /* already ended */
      }
      this.current = null;
    }
  }
}
