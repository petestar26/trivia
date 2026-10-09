/**
 * Optional match sound, synthesised in the browser: no audio files, no licensed recordings.
 * It is silent and creates no audio context until the member explicitly switches sound on.
 */
export interface FootballAudio {
  /** Must be called from a user gesture. Resolves false when audio is unavailable. */
  enable(): Promise<boolean>;
  disable(): void;
  readonly enabled: boolean;
  whistle(kind: 'kickoff' | 'half' | 'full'): void;
  goal(): void;
  /** 0..1 background crowd level. */
  crowd(level: number): void;
  dispose(): void;
}

type ContextCtor = new () => AudioContext;

export function createFootballAudio(
  contextCtor: ContextCtor | undefined = typeof window === 'undefined'
    ? undefined
    : ((window as unknown as { AudioContext?: ContextCtor; webkitAudioContext?: ContextCtor })
        .AudioContext ??
      (window as unknown as { webkitAudioContext?: ContextCtor }).webkitAudioContext)
): FootballAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let crowdGain: GainNode | null = null;
  let crowdSource: AudioBufferSourceNode | null = null;
  let on = false;

  const noise = (context: AudioContext) => {
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
    return buffer;
  };

  function startCrowd(context: AudioContext, destination: AudioNode) {
    const source = context.createBufferSource();
    source.buffer = noise(context);
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 520;
    filter.Q.value = 0.5;
    crowdGain = context.createGain();
    crowdGain.gain.value = 0.03;
    source.connect(filter).connect(crowdGain).connect(destination);
    source.start();
    crowdSource = source;
  }

  const api: FootballAudio = {
    get enabled() {
      return on;
    },
    async enable() {
      if (!contextCtor) return false;
      try {
        ctx ??= new contextCtor();
        if (ctx.state === 'suspended') await ctx.resume();
        if (!master) {
          master = ctx.createGain();
          master.gain.value = 0.5;
          master.connect(ctx.destination);
          startCrowd(ctx, master);
        }
        master.gain.setTargetAtTime(0.5, ctx.currentTime, 0.05);
        on = true;
        return true;
      } catch {
        on = false;
        return false;
      }
    },
    disable() {
      on = false;
      if (ctx && master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    },
    whistle(kind) {
      if (!on || !ctx || !master) return;
      const bursts = kind === 'full' ? 3 : 1;
      for (let i = 0; i < bursts; i++) {
        const start = ctx.currentTime + i * 0.42;
        const osc = ctx.createOscillator();
        const vibrato = ctx.createOscillator();
        const vibratoGain = ctx.createGain();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = 2850;
        vibrato.frequency.value = 32;
        vibratoGain.gain.value = 55;
        vibrato.connect(vibratoGain).connect(osc.frequency);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + (kind === 'kickoff' ? 0.5 : 0.32));
        osc.connect(gain).connect(master);
        osc.start(start);
        vibrato.start(start);
        osc.stop(start + 0.6);
        vibrato.stop(start + 0.6);
      }
    },
    goal() {
      if (!on || !ctx || !master) return;
      const start = ctx.currentTime;
      const source = ctx.createBufferSource();
      source.buffer = noise(ctx);
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 0.8;
      filter.frequency.setValueAtTime(500, start);
      filter.frequency.exponentialRampToValueAtTime(1500, start + 0.8);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.32, start + 0.5);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 3);
      source.connect(filter).connect(gain).connect(master);
      source.start(start);
      source.stop(start + 3.2);
    },
    crowd(level) {
      if (!ctx || !crowdGain) return;
      const clamped = Math.max(0, Math.min(1, level));
      crowdGain.gain.setTargetAtTime(0.025 + clamped * 0.07, ctx.currentTime, 0.4);
    },
    dispose() {
      on = false;
      try {
        crowdSource?.stop();
      } catch {
        /* already stopped */
      }
      void ctx?.close().catch(() => undefined);
      ctx = null;
      master = null;
      crowdGain = null;
      crowdSource = null;
    },
  };
  return api;
}
