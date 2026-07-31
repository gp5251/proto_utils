import * as vscode from 'vscode';
import { SymbolIndex } from '../index/symbolIndex';
import { Range, ServicePoint } from '../index/symbols';

/**
 * CodeLens 入口(ADR-0006):每个可调用 rpc 方法上方渲染「▶ 调用」。
 * ADR-0007:只覆盖一元 + 服务端流;client/bidi 流方法(requestStream)不出 lens。
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
      if (method.requestStream) continue;
      targets.push({ serviceFullName, method: method.name, range: method.range });
    }
  }
  return targets;
}

export class ProtoCallLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly index: SymbolIndex) {}

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
        title: `▶ 调用 ${target.method}`,
        command: 'protoUtils.callMethod',
        arguments: [{ service: target.serviceFullName, method: target.method }],
      });
    });
  }
}
