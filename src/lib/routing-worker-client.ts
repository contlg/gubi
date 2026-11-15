import "server-only";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { deferLoopStage, loopCount, loopTimingToken, startLoopStage, type LoopTimingToken } from "@/lib/loop-timing";
import { preloadRoadBinaries } from "@/lib/shared-road-binaries";

import type {
  DirectionsRoutingInput,
  LocalRouteRoutingInput,
  LocalRouteRoutingResult,
  LoopRoutingInput,
  NavFallbackRoutingInput,
  NavFallbackRoutingResult,
  NavGuidanceRoutingInput,
  NavGuidanceRoutingResult,
  NavRerouteRoutingInput,
  NavRerouteRoutingResult,
  RouteTrafficRoutingInput,
  RouteTrafficRoutingResult,
  RoutingJob,
  RoutingJobResult,
  RoutingResult,
} from "@/lib/routing-jobs";

/** 큐까지 꽬 때 API가 429로 응답할 수 있게 구분하는 오류. */
export class RoutingBusyError extends Error {
  constructor() {
    super("다른 코스를 계산 중이에요. 잠시 후 다시 시도해주세요.");
    this.name = "RoutingBusyError";
  }
}

export function isRoutingBusyError(error: unknown): error is RoutingBusyError {
  return error instanceof Error && error.name === "RoutingBusyError";
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: RoutingJobResult;
  error?: string;
}

interface PendingJob {
  id: number;
  job: RoutingJob;
  resolve: (result: RoutingJobResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  aborted: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  timing?: LoopTimingToken;
  endQueueTiming?: ReturnType<typeof startLoopStage>;
  endWorkTiming?: ReturnType<typeof startLoopStage>;
  startWorkTiming?: ReturnType<typeof deferLoopStage>;
}

const MAX_TOTAL_JOBS = 3; // 실행 1 + 짧은 대기 2. 그 이상은 즉시 429.
const JOB_TIMEOUT_MS = 120_000;

class RoutingScheduler {
  private worker: Worker | null = null;
  private active: PendingJob | null = null;
  private readonly queue: PendingJob[] = [];
  private nextId = 1;

  run(job: RoutingJob, signal?: AbortSignal): Promise<RoutingJobResult> {
    if (signal?.aborted) return Promise.reject(this.abortError());
    if (this.queue.length + (this.active ? 1 : 0) >= MAX_TOTAL_JOBS) {
      return Promise.reject(new RoutingBusyError());
    }

    return new Promise<RoutingJobResult>((resolve, reject) => {
      const pending: PendingJob = {
        id: this.nextId++,
        job,
        resolve,
        reject,
        signal,
        aborted: false,
        timing: loopTimingToken(),
        endQueueTiming: startLoopStage("scheduler.queue"),
        startWorkTiming: deferLoopStage("scheduler.workerRoundTrip"),
      };
      loopCount("workerJobs");
      if (signal) {
        pending.onAbort = () => this.abort(pending);
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.pump();
    });
  }

  private abortError(): Error {
    return new DOMException("요청이 취소됐습니다", "AbortError");
  }

  private abort(pending: PendingJob): void {
    if (pending.aborted) return;
    pending.aborted = true;
    pending.endQueueTiming?.({ aborted: true });
    pending.endWorkTiming?.({ aborted: true });
    const queuedIndex = this.queue.indexOf(pending);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.detach(pending);
    }
    // 이미 worker에서 계산 중이면 계산은 안전하게 끝내되 HTTP 요청 Promise만
    // 바로 닫는다. 응답이 오면 scheduler가 다음 대기 작업을 이어서 실행한다.
    pending.reject(this.abortError());
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const distName = process.env.NEXT_DIST_DIR || ".next";
    const builtPath = join(
      process.cwd(),
      distName,
      "routing-worker",
      "entry.mjs",
    );
    const useSource = process.env.NODE_ENV !== "production";
    if (!useSource && !existsSync(builtPath)) {
      throw new Error("routing worker 빌드가 없습니다. npm run build를 다시 실행하세요.");
    }
    const workerPath = pathToFileURL(
      useSource ? join(process.cwd(), "src/lib/routing-worker.mjs") : builtPath,
    );
    // Next 16.2 Turbopack의 서버 worker asset 해석 회귀를 피하고, 프로덕션에선
    // Next 산출물과 같은 세대에 컴파일된 worker snapshot을 Node가 직접 연다.
    const worker = new Worker(
      /* turbopackIgnore: true */ workerPath,
      {
        workerData: { sharedRoadBinaries: preloadRoadBinaries() },
        ...(useSource
          ? {
              execArgv: [
                "--experimental-strip-types",
                "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
              ],
            }
          : {}),
      },
    );
    worker.unref();
    worker.on("message", (message: WorkerResponse) => {
      if (this.worker !== worker) return;
      this.onMessage(message);
    });
    worker.on("error", (error) => {
      if (this.worker !== worker) return;
      this.failWorker(error);
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.failWorker(new Error(`코스 계산 worker 종료(code ${code})`));
    });
    this.worker = worker;
    return worker;
  }

  private pump(): void {
    if (this.active) return;
    let pending = this.queue.shift();
    while (pending?.aborted) pending = this.queue.shift();
    if (!pending) return;
    this.active = pending;
    pending.endQueueTiming?.();
    // Capture the pending request's context even if pump follows another job.
    pending.endWorkTiming = pending.startWorkTiming?.();
    pending.timer = setTimeout(() => {
      if (this.active !== pending) return;
      pending.endWorkTiming?.({ timeout: true });
      if (!pending.aborted) pending.reject(new Error("코스 계산 시간이 초과됐습니다"));
      this.detach(pending);
      this.active = null;
      const timedOutWorker = this.worker;
      this.worker = null;
      void timedOutWorker?.terminate();
      this.pump();
    }, JOB_TIMEOUT_MS);
    try {
      this.ensureWorker().postMessage({ id: pending.id, job: pending.job, timing: pending.timing });
    } catch (error) {
      pending.endWorkTiming?.({ error: true });
      this.active = null;
      this.detach(pending);
      if (!pending.aborted) {
        pending.reject(error instanceof Error ? error : new Error("worker 시작 실패"));
      }
      this.pump();
    }
  }

  private onMessage(message: WorkerResponse): void {
    const pending = this.active;
    if (!pending || pending.id !== message.id) return;
    pending.endWorkTiming?.({ ok: message.ok });
    this.active = null;
    this.detach(pending);
    if (!pending.aborted) {
      if (message.ok && message.result !== undefined) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "코스 계산 worker 오류"));
    }
    this.pump();
  }

  private failWorker(error: Error): void {
    this.worker = null;
    const pending = this.active;
    this.active = null;
    if (pending) {
      pending.endWorkTiming?.({ error: true });
      this.detach(pending);
      if (!pending.aborted) pending.reject(error);
    }
    this.pump();
  }

  private detach(pending: PendingJob): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }
}

const globalRouting = globalThis as typeof globalThis & {
  __drivePlannerRoutingScheduler?: RoutingScheduler;
  __driveNavigationRoutingScheduler?: RoutingScheduler;
};
const plannerScheduler =
  globalRouting.__drivePlannerRoutingScheduler ??
  (globalRouting.__drivePlannerRoutingScheduler = new RoutingScheduler());
// 주행 중 이탈 재탐색·ITS 폴백은 긴 코스 추천 뒤에서 기다리면 안 된다. 별도
// worker 한 개를 늦게 생성해, 실제 내비 기능을 쓸 때만 추가 메모리를 쓴다.
const navigationScheduler =
  globalRouting.__driveNavigationRoutingScheduler ??
  (globalRouting.__driveNavigationRoutingScheduler = new RoutingScheduler());

export function runLoopRouting(
  input: Omit<LoopRoutingInput, "kind">,
  signal?: AbortSignal,
): Promise<RoutingResult> {
  return plannerScheduler.run({ kind: "loop", ...input }, signal) as Promise<RoutingResult>;
}

export function runDirectionsRouting(
  input: Omit<DirectionsRoutingInput, "kind">,
  signal?: AbortSignal,
): Promise<RoutingResult> {
  return plannerScheduler.run(
    { kind: "directions", ...input },
    signal,
  ) as Promise<RoutingResult>;
}

export function runLocalRouteRouting(
  input: Omit<LocalRouteRoutingInput, "kind">,
  signal?: AbortSignal,
): Promise<LocalRouteRoutingResult> {
  return plannerScheduler.run(
    { kind: "local-route", ...input },
    signal,
  ) as Promise<LocalRouteRoutingResult>;
}

export function runRouteTrafficRouting(
  input: Omit<RouteTrafficRoutingInput, "kind">,
  signal?: AbortSignal,
): Promise<RouteTrafficRoutingResult | null> {
  return navigationScheduler.run(
    { kind: "route-traffic", ...input },
    signal,
  ) as Promise<RouteTrafficRoutingResult | null>;
}

export function runNavFallbackRouting(
  input: Omit<NavFallbackRoutingInput, "kind">,
  signal?: AbortSignal,
): Promise<NavFallbackRoutingResult> {
  return navigationScheduler.run(
    { kind: "nav-fallback", ...input },
    signal,
  ) as Promise<NavFallbackRoutingResult>;
}

export function runNavRerouteRouting(
  input: Omit<NavRerouteRoutingInput, "kind">,
  signal?: AbortSignal,
): Promise<NavRerouteRoutingResult> {
  return navigationScheduler.run(
    { kind: "nav-reroute", ...input },
    signal,
  ) as Promise<NavRerouteRoutingResult>;
}

export function runNavGuidanceRouting(
  input: Omit<NavGuidanceRoutingInput, "kind">,
  signal?: AbortSignal,
): Promise<NavGuidanceRoutingResult> {
  return navigationScheduler.run(
    { kind: "nav-guidance", ...input },
    signal,
  ) as Promise<NavGuidanceRoutingResult>;
}
