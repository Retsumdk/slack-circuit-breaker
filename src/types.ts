export interface Sample {
  at: number;
  ok: boolean;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve()),
};
