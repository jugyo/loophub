import { afterEach, describe, expect, it, vi } from "vitest";
import { bellWavDataUri, playNotificationBell } from "./notification-sound";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function decodeHeader(dataUri: string): {
  prefix: string;
  bytes: Uint8Array;
} {
  const [prefix, base64] = dataUri.split(",", 2);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { prefix, bytes };
}

describe("bellWavDataUri", () => {
  it("carries the whole sound in the bundle as a 16-bit mono WAV", () => {
    const { prefix, bytes } = decodeHeader(bellWavDataUri());
    const view = new DataView(bytes.buffer);

    expect(prefix).toBe("data:audio/wav;base64");
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    // Long enough to hear as a bell, short enough not to linger.
    const seconds = view.getUint32(40, true) / view.getUint32(28, true);
    expect(seconds).toBeGreaterThan(0.2);
    expect(seconds).toBeLessThan(2);
  });

  it("rings out: the tail is quieter than the strike", () => {
    const { bytes } = decodeHeader(bellWavDataUri());
    const view = new DataView(bytes.buffer);
    const sampleCount = view.getUint32(40, true) / 2;
    const peak = (from: number, to: number) => {
      let loudest = 0;
      for (let i = from; i < to; i++) {
        loudest = Math.max(loudest, Math.abs(view.getInt16(44 + i * 2, true)));
      }
      return loudest;
    };

    expect(peak(0, Math.round(sampleCount / 4))).toBeGreaterThan(
      peak(Math.round((sampleCount * 3) / 4), sampleCount),
    );
  });
});

describe("playNotificationBell", () => {
  it("plays the bundled bell, without any network request", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const sources: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        play = play;
        constructor(src: string) {
          sources.push(src);
        }
      },
    );

    playNotificationBell();

    expect(play).toHaveBeenCalledTimes(1);
    expect(sources).toEqual([bellWavDataUri()]);
  });

  it("reports blocked playback instead of retrying it", async () => {
    const blocked = new Error("play() failed because the user didn't interact");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "Audio",
      class {
        play = vi.fn().mockRejectedValue(blocked);
      },
    );

    playNotificationBell();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    expect(error.mock.calls[0][1]).toBe(blocked);
  });

  it("survives an environment without audio support", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "Audio",
      class {
        constructor() {
          throw new Error("no audio support");
        }
      },
    );

    expect(() => playNotificationBell()).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
