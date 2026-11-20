import net, { type AddressInfo } from "node:net";
import { encodeEvent, eventReader } from "./wyoming";

/**
 * A stand-in Wyoming speech server: answers describe, hears every recording
 * as one sentence (and reports its length), and speaks known voices.
 */
export async function fakeWyoming(voices = ["en_US-warden-medium", "en_US-belle-medium"]) {
  const heard: { bytes: number; rate: number }[] = [];
  const spoken: { text: string; voice: string }[] = [];
  const server = net.createServer((socket) => {
    const read = eventReader();
    let audio = 0;
    let rate = 0;
    socket.on("data", (chunk: Buffer) => {
      for (const e of read(chunk)) {
        if (e.type === "describe")
          socket.write(
            encodeEvent("info", {
              asr: [{ name: "faster-whisper", models: [{ name: "small.en", installed: true }] }],
              tts: [
                {
                  name: "piper",
                  voices: [
                    ...voices.map((name) => ({ name, installed: true, attribution: { name: "" } })),
                    {
                      name: "en_US-lessac-high",
                      installed: true,
                      attribution: { name: "rhasspy" },
                    },
                    {
                      name: "de_DE-thorsten-high",
                      installed: true,
                      attribution: { name: "rhasspy" },
                    },
                  ],
                },
              ],
            }),
          );
        if (e.type === "audio-start") rate = Number(e.data.rate);
        if (e.type === "audio-chunk") audio += e.payload?.length ?? 0;
        if (e.type === "audio-stop") {
          heard.push({ bytes: audio, rate });
          socket.write(encodeEvent("transcript", { text: " Restart Plex please. " }));
        }
        if (e.type === "synthesize") {
          const voice = String((e.data.voice as { name?: string })?.name);
          spoken.push({ text: String(e.data.text), voice });
          const fmt = { rate: 22050, width: 2, channels: 1 };
          socket.write(encodeEvent("audio-start", fmt));
          if (voices.includes(voice) || voice === "en_US-lessac-high") {
            socket.write(encodeEvent("audio-chunk", fmt, Buffer.alloc(4410, 1)));
            socket.write(encodeEvent("audio-chunk", fmt, Buffer.alloc(4410, 2)));
          }
          socket.write(encodeEvent("audio-stop"));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { port, heard, spoken, close: () => new Promise<void>((r) => server.close(() => r())) };
}
