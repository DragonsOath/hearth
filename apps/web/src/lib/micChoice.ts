import { useEffect, useState } from "react";

/**
 * Which microphone Hearth listens to, chosen in the conversation when the browser's default one
 * gives only silence (a remote-desktop or virtual mic is a common culprit). Kept in this
 * browser only; nothing else depends on it, so a missing or blocked store just means "default".
 */

const KEY = "dc-mic-device";
const CHANGED = "dc-mic-changed";

export function chosenMic(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function chooseMic(id: string | undefined) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    // Not kept past this page; it still applies now.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** The chosen microphone, following changes made anywhere on the page. */
export function useMicChoice(): string | undefined {
  const [id, setId] = useState(chosenMic);
  useEffect(() => {
    const on = () => setId(chosenMic());
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, []);
  return id;
}

const AUDIO = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Opens the chosen microphone, or the default one when the chosen one is gone. */
export async function openMic(): Promise<MediaStream> {
  const id = chosenMic();
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...AUDIO, deviceId: { exact: id } },
      });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "OverconstrainedError")) throw e;
      chooseMic(undefined);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: AUDIO });
}

/** The microphones this browser can use (names appear once the site may use the mic). */
export async function listMics(): Promise<{ id: string; name: string }[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "audioinput" && d.deviceId)
    .map((d, i) => ({ id: d.deviceId, name: d.label || `Microphone ${i + 1}` }));
}
