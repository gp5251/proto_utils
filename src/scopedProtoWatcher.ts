/** VS Code FileSystemWatcher 的最小面,便于在无扩展宿主环境里验证生命周期。 */
export interface ScopedFileWatcher {
  onDidCreate(listener: () => void): unknown;
  onDidChange(listener: () => void): unknown;
  onDidDelete(listener: () => void): unknown;
  dispose(): void;
}

/**
 * 跟随当前单文件作用域的精确 watcher。
 * 全局 **\/*.proto 只覆盖工作区;CodeLens 钉住的目录外文件必须单独监听,
 * 否则编辑器里的定义已改,工作台仍展示并调用旧 schema。
 */
export class ScopedProtoWatcher {
  private file: string | null = null;
  private watcher: ScopedFileWatcher | null = null;

  constructor(
    private readonly createWatcher: (file: string) => ScopedFileWatcher,
    private readonly onChanged: () => void,
  ) {}

  sync(file: string | null): void {
    if (this.file === file) {
      return;
    }
    this.watcher?.dispose();
    this.watcher = null;
    this.file = file;
    if (!file) {
      return;
    }
    const watcher = this.createWatcher(file);
    watcher.onDidCreate(this.onChanged);
    watcher.onDidChange(this.onChanged);
    watcher.onDidDelete(this.onChanged);
    this.watcher = watcher;
  }

  dispose(): void {
    this.sync(null);
  }
}
