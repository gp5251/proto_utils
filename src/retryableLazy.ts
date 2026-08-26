/**
 * 可重试的懒单例:并发共享一次构建,成功后复用;失败即弃,下次 get 重新构建。
 * extension.ts 的 LazyWorkbench 借此保证:动态 import/依赖构建失败不毒化后续打开。
 */
export class RetryableLazy<T> {
  private promise: Promise<T> | null = null;

  constructor(private readonly build: () => Promise<T>) {}

  /** 是否已有进行中/成功的实例(供调用方决定要不要包进度提示)。 */
  get started(): boolean {
    return this.promise !== null;
  }

  get(): Promise<T> {
    if (!this.promise) {
      this.promise = this.build().catch((err: unknown) => {
        // 失败即弃:清掉 rejected promise,下次 get 重新构建(不毒化)
        this.promise = null;
        throw err;
      });
    }
    return this.promise;
  }
}
