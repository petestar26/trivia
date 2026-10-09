import { describe, expect, it, vi } from 'vitest';
import { createFootballAudio } from './audio';

function fakeContext() {
  const calls = { created: 0, oscillators: 0, sources: 0, closed: 0 };
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
  });
  const node = (extra: object = {}) => {
    const n: Record<string, unknown> = { connect: vi.fn((to: unknown) => to), ...extra };
    return n;
  };
  class Ctx {
    state = 'suspended';
    sampleRate = 8000;
    currentTime = 0;
    destination = node();
    constructor() {
      calls.created++;
    }
    resume = vi.fn(async () => void (this.state = 'running'));
    close = vi.fn(async () => void calls.closed++);
    createBuffer = () => ({ getChannelData: () => new Float32Array(16000) });
    createGain = () => node({ gain: param() });
    createBiquadFilter = () => node({ frequency: param(), Q: param(), type: '' });
    createBufferSource = () => {
      calls.sources++;
      return node({ start: vi.fn(), stop: vi.fn(), loop: false, buffer: null });
    };
    createOscillator = () => {
      calls.oscillators++;
      return node({ start: vi.fn(), stop: vi.fn(), frequency: param(), type: '' });
    };
  }
  return { Ctx: Ctx as unknown as new () => AudioContext, calls };
}

describe('football audio', () => {
  it('is silent and creates no audio context until the member switches sound on', () => {
    const { Ctx, calls } = fakeContext();
    const audio = createFootballAudio(Ctx);
    audio.whistle('kickoff');
    audio.goal();
    audio.crowd(1);
    expect(calls.created).toBe(0);
    expect(audio.enabled).toBe(false);
  });

  it('plays only while enabled and goes quiet when disabled', async () => {
    const { Ctx, calls } = fakeContext();
    const audio = createFootballAudio(Ctx);
    expect(await audio.enable()).toBe(true);
    expect(audio.enabled).toBe(true);
    const sources = calls.sources;
    audio.whistle('full');
    expect(calls.oscillators).toBe(6); // three blasts, each a tone plus vibrato
    audio.goal();
    expect(calls.sources).toBe(sources + 1);
    audio.disable();
    audio.whistle('kickoff');
    audio.goal();
    expect(calls.oscillators).toBe(6);
    expect(calls.sources).toBe(sources + 1);
    audio.dispose();
    expect(calls.closed).toBe(1);
  });

  it('reports unavailable audio instead of throwing', async () => {
    expect(await createFootballAudio(undefined).enable()).toBe(false);
    class Broken {
      constructor() {
        throw new Error('blocked');
      }
    }
    expect(await createFootballAudio(Broken as unknown as new () => AudioContext).enable()).toBe(
      false
    );
  });
});
