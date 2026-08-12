import * as vscode from 'vscode';
import { SymbolIndex } from '../index/symbolIndex';
import { Range, ServicePoint } from '../index/symbols';

/**
 * CodeLens 入口(ADR-0006):每个 rpc 方法上方渲染「▶ 调用」。
 * client/bidi 流方法(requestStream)也出 lens——工作台内发送按钮禁用并提示暂不支持,
 * 比没有入口更能传达"方法存在但暂不可调"(ADR-0007 的调用面限制不变)。
 */

export interface CallTarget {
  /** package.Service;无 package 时为裸服务名 */
  serviceFullName: string;
  method: string;
  range: Range;
}

/** 纯选择逻辑(vscode 无关,测试接缝) */
export function callableMethods(entry: { packageName: string | null; services: ServicePoint[] }): CallTarget[] {
  const targets: CallTarget[] = [];
  for (const service of entry.services) {
    const serviceFullName = entry.packageName ? `${entry.packageName}.${service.name}` : service.name;
    for (const method of service.methods) {
      targets.push({ serviceFullName, method: method.name, range: method.range });
    }
  }
  return targets;
}

export class ProtoCallLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this.changeEmitter.event;

  constructor(private readonly index: SymbolIndex) {}

  /** 全量索引完成后由 activate 调用,让 VS Code 重新拉取 lens。 */
  refresh(): void {
    this.changeEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    this.index.updateFromDocument(document);
    const entry = this.index.getFile(document.uri);
    if (!entry) return [];

    return callableMethods(entry).map((target) => {
      const range = new vscode.Range(
        target.range.start.line,
        target.range.start.character,
        target.range.end.line,
        target.range.end.character,
      );
      return new vscode.CodeLens(range, {
        title: `▶ ${vscode.l10n.t('Call')} ${target.method}`,
        command: 'protoUtils.callMethod',
        arguments: [{ service: target.serviceFullName, method: target.method }],
      });
    });
  }
}
