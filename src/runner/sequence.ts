import JSON5 from 'json5';
import type { CallRunner, CallResultPayload } from './callHandler';
import type { SerializedService, ServiceRegistry } from './serviceRegistry';
import type { MetadataEntry } from './config';
import type { Sequence, SequenceStep } from './sequenceStore';
import { resolveDeep, PlaceholderError } from './utils/placeholder';

/**
 * 调用序列编排引擎(0.3.59,ADR-0012)。宿主侧,UI 无关:依序跑 steps,
 * 每步先用占位符解析入参(引用前序步输出)再复用 CallRunner 发起;
 * 首个失败步即中止整条;服务端流步骤双通道推进(自然结束或手动结束都算成功并继续);
 * 运行前用 registry 整体校验所有步方法存在,任一失效则不启动。
 * 通过 onEvent 逐步发事件,由 Session 翻译成 webview 消息(阶段 4)。
 */

/** 运行前校验命中不到的步。 */
export interface MissingStep {
  index: number;
  service: string;
  method: string;
}

export type SequenceEvent =
  /** 运行前整体校验失败:列出失效步,序列不启动。 */
  | { type: 'validationFailed'; missing: MissingStep[] }
  /** 某步开始:values 为占位符已解析的实际入参(供报告展示"发出的请求")。 */
  | { type: 'stepStart'; index: number; service: string; method: string; responseStream: boolean; values: Record<string, unknown> }
  /** 流步骤实时 chunk。 */
  | { type: 'stepChunk'; index: number; data: unknown }
  /** 一元步骤结果(成功或 gRPC 错误都在 payload.result 里)。 */
  | { type: 'stepUnaryResult'; index: number; payload: CallResultPayload }
  /** 流步骤收尾:ok=自然/手动结束,fail=流出错。 */
  | { type: 'stepStreamEnd'; index: number; ok: boolean; error?: string; chunkCount: number; durationMs: number }
  /** 发起前就失败(占位符取空/JSON 非法/意外抛错)。 */
  | { type: 'stepFailed'; index: number; error: string }
  /** 整条结束:completed=全成功,aborted=某步失败中止,stopped=用户停止。 */
  | { type: 'end'; status: 'completed' | 'aborted' | 'stopped' };

export interface SequenceRunnerDeps {
  runner: CallRunner;
  registry: Pick<ServiceRegistry, 'load'>;
  getConfig(): { protoDir: string; metadata: MetadataEntry[] };
  onEvent(event: SequenceEvent): void;
}

/** 服务/方法命中:与 GrpcCallRunner.findMethod 同规则(裸名或全限定名)。 */
function methodExists(services: SerializedService[], service: string, method: string): boolean {
  const svc = services.find((s) => s.name === service || s.fullName === service);
  return Boolean(svc?.methods.some((m) => m.name === method));
}

/**
 * 把一步的入参快照解析为喂给 CallRunner 的 values 记录:
 * - json 模式:JSON5 解析 jsonText → resolveDeep(占位符替换)。
 * - form 模式:直接 resolveDeep(values)。
 * 解析失败(JSON 非法/占位符取空)抛错,由 run 循环捕获为该步失败。
 */
function resolveStepValues(step: SequenceStep, outputs: Record<number, unknown>, index: number): Record<string, unknown> {
  if (step.mode === 'json') {
    const text = (step.jsonText ?? '').trim();
    const parsed: unknown = text === '' ? {} : JSON5.parse(text);
    const resolved = resolveDeep(parsed, outputs, index);
    if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) {
      throw new PlaceholderError('JSON 入参顶层必须是对象', '', '顶层非对象');
    }
    return resolved as Record<string, unknown>;
  }
  const resolved = resolveDeep(step.values ?? {}, outputs, index);
  return (resolved ?? {}) as Record<string, unknown>;
}

export class SequenceRunner {
  private stopped = false;
  private outputs: Record<number, unknown> = {};
  /**
   * 进行中的流步骤句柄。endNow = 手动结束:立即把该步判成功并推进,
   * 不等传输层取消回执(真实 grpc 取消后 onEnd/onError 是否到达不可靠,
   * 被动等待会让该步 Promise 永不 resolve,表现为“接收中”卡死)。
   */
  private activeStream: { cancel(): void; endNow(): void } | null = null;

  constructor(private readonly deps: SequenceRunnerDeps) {}

  /** 用户停止整条序列:当前流步骤立即收尾,后续丢弃。 */
  stop(): void {
    this.stopped = true;
    this.activeStream?.endNow();
  }

  /** 手动结束当前流步骤(双通道推进):立即判成功并继续下一步,同时取消底层流。 */
  endCurrentStream(): void {
    this.activeStream?.endNow();
  }

  async run(seq: Sequence): Promise<void> {
    this.stopped = false;
    this.outputs = {};
    this.activeStream = null;
    const cfg = this.deps.getConfig();

    // 运行前整体校验:任一步方法失效则不启动(ADR/共识:跑一半才发现死方法太浪费)
    const { services } = await this.deps.registry.load(cfg.protoDir);
    const missing: MissingStep[] = [];
    seq.steps.forEach((step, i) => {
      if (!methodExists(services, step.service, step.method)) {
        missing.push({ index: i, service: step.service, method: step.method });
      }
    });
    if (missing.length > 0) {
      this.deps.onEvent({ type: 'validationFailed', missing });
      this.deps.onEvent({ type: 'end', status: 'aborted' });
      return;
    }

    for (let i = 0; i < seq.steps.length; i++) {
      if (this.stopped) break;
      const step = seq.steps[i];

      let values: Record<string, unknown>;
      try {
        values = resolveStepValues(step, this.outputs, i);
      } catch (err) {
        this.deps.onEvent({ type: 'stepFailed', index: i, error: errText(err) });
        this.deps.onEvent({ type: 'end', status: 'aborted' });
        return;
      }

      this.deps.onEvent({
        type: 'stepStart',
        index: i,
        service: step.service,
        method: step.method,
        responseStream: step.responseStream,
        values,
      });

      const ok = step.responseStream
        ? await this.runStreamStep(i, step, values, cfg.metadata)
        : await this.runUnaryStep(i, step, values, cfg.metadata);

      if (!ok) {
        this.deps.onEvent({ type: 'end', status: 'aborted' });
        return;
      }
      if (this.stopped) break;
    }

    this.deps.onEvent({ type: 'end', status: this.stopped ? 'stopped' : 'completed' });
  }

  /** 一元步:成功记 outputs[i]={data};gRPC 错误或抛错都判失败(返回 false 触发中止)。 */
  private async runUnaryStep(
    index: number,
    step: SequenceStep,
    values: Record<string, unknown>,
    metadata: MetadataEntry[],
  ): Promise<boolean> {
    try {
      const payload = await this.deps.runner.callUnary(step.service, step.method, values, metadata);
      this.deps.onEvent({ type: 'stepUnaryResult', index, payload });
      if (payload.result.status === 'ok') {
        this.outputs[index] = { data: payload.result.data };
        return true;
      }
      return false;
    } catch (err) {
      this.deps.onEvent({ type: 'stepFailed', index, error: errText(err) });
      return false;
    }
  }

  /**
   * 流步骤:双通道推进——自然 onEnd 或手动 cancel(onError CANCELLED)都算成功并继续;
   * 非手动的 onError 判失败中止。成功记 outputs[index]={chunks:[{data}...]}。
   */
  private runStreamStep(
    index: number,
    step: SequenceStep,
    values: Record<string, unknown>,
    metadata: MetadataEntry[],
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const chunks: unknown[] = [];
      const startedAt = Date.now();
      let settled = false;
      let manual = false;

      const finish = (ok: boolean, error?: string): void => {
        if (settled) return;
        settled = true;
        this.activeStream = null;
        if (ok) {
          this.outputs[index] = { chunks: chunks.map((data) => ({ data })) };
        }
        this.deps.onEvent({
          type: 'stepStreamEnd',
          index,
          ok,
          error,
          chunkCount: chunks.length,
          durationMs: Date.now() - startedAt,
        });
        resolve(ok);
      };

      try {
        const handle = this.deps.runner.callServerStream(
          step.service,
          step.method,
          values,
          {
            onData: (data: unknown) => {
              chunks.push(data);
              this.deps.onEvent({ type: 'stepChunk', index, data });
            },
            onError: (message: string) => {
              // 手动结束常以 CANCELLED 错误收场:视作成功推进,不算失败
              if (manual) finish(true);
              else finish(false, message);
            },
            onEnd: () => finish(true),
          },
          metadata,
        );
        this.activeStream = {
          cancel: () => {
            manual = true;
            handle.cancel();
          },
          // 手动结束是用户决定:立即 finish(true) 推进;传输层后续事件由 settled 守卫忽略
          endNow: () => {
            manual = true;
            handle.cancel();
            finish(true);
          },
        };
        // run 期间可能已 stop:句柄一挂上就补收尾
        if (this.stopped) this.activeStream.endNow();
      } catch (err) {
        finish(false, errText(err));
      }
    });
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
