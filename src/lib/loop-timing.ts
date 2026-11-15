import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { threadId } from "node:worker_threads";

export interface LoopTimingToken {
  requestId: string;
}

interface TimingContext extends LoopTimingToken {
  scope: "http" | "worker";
  counts: Record<string, number>;
  externalCallsByHost: Record<string, number>;
}

const storage = new AsyncLocalStorage<TimingContext>();
type Details = Record<string, string | number | boolean>;

/** Opt-in only. Never record coordinates, URLs, keys, or response contents. */
export function loopTimingToken(): LoopTimingToken | undefined {
  const context = storage.getStore();
  return context ? { requestId: context.requestId } : undefined;
}

export function loopCount(name: string, amount = 1): void {
  const context = storage.getStore();
  if (context) context.counts[name] = (context.counts[name] ?? 0) + amount;
}

/** Call at the actual fetch site, after auth validation and cache checks. */
export function loopExternalCall(host: string): void {
  const context = storage.getStore();
  if (context) {
    context.externalCallsByHost[host] = (context.externalCallsByHost[host] ?? 0) + 1;
  }
}

/** Header latency only; enclosing API stages also include body parsing/backoff. */
export function loopFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!storage.getStore()) return fetch(input, init);
  const host = new URL(input).host;
  loopExternalCall(host);
  const end = startLoopStage("external.fetchHeaders", { host });
  return fetch(input, init).then(
    (response) => { end?.({ status: response.status }); return response; },
    (error: unknown) => { end?.({ error: true }); throw error; },
  );
}

/** Captures context now, so scheduler callbacks cannot attribute a different job. */
export function startLoopStage(stage: string, details: Details = {}) {
  const context = storage.getStore();
  if (!context) return undefined;
  const started = performance.now();
  let ended = false;
  return (extra: Details = {}) => {
    if (ended) return;
    ended = true;
    try {
      console.log(JSON.stringify({
        event: "fundrive.loop.timing",
        requestId: context.requestId,
        scope: context.scope,
        pid: process.pid,
        threadId,
        stage,
        ms: Math.round((performance.now() - started) * 1000) / 1000,
        counts: { ...context.counts },
        externalCallsByHost: { ...context.externalCallsByHost },
        ...details,
        ...extra,
      }));
    } catch {
      // Observability must not turn successful routing into an error.
    }
  };
}

/** Scheduler may start this job from the previous request's completion callback. */
export function deferLoopStage(stage: string) {
  const context = storage.getStore();
  return context ? () => storage.run(context, () => startLoopStage(stage)) : undefined;
}

/** No wrapper Promise, clock read, ID, or log when disabled. */
export function withLoopTiming<T>(
  requestId: string | null | undefined,
  scope: TimingContext["scope"],
  operation: () => T,
): T {
  if (process.env.FUNDRIVE_LOOP_TIMING !== "1") return operation();
  const id = requestId && /^[a-zA-Z0-9_-]{1,80}$/.test(requestId) ? requestId : randomUUID();
  return storage.run({ requestId: id, scope, counts: {}, externalCallsByHost: {} }, operation);
}
