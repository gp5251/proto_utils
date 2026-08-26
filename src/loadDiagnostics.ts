import * as vscode from 'vscode';
import { ProtoFrontend, ProtoLoadError, ProtoSchema, createImportResolver } from './runtime/protoFrontend';
import { readProtoFile } from './runtime/protoEncoding';
import { parseProtoError } from './protoErrorMessage';
import { scanProto } from './index/scanner';
import type { ScanResult } from './index/scanner';
import { toVsCodeRange } from './providers/definition';
import {
  MISSING_IMPORT_CODE,
  MissingImportFix,
  computeImportPath,
  findMissingImports,
  locateTypeRefs,
} from './analysis/missingImport';

/**
 * 诊断链路(ADR-0002):触发源 = 保存 proto 时 + 工作台加载尘埃落定后(0.3.40,
 * 见 createLoadDiagnosticsTrigger)。语法错(带 file/line)就地飘红,0.3.40 起消息带违规
 * token 且其在出错行唯一出现时收窄到 token(否则整行,无回归);语义错无位置,按精度分派:
 * duplicate name 借零语义扫描器(ADR-0003)飘红声明点,no such type 按短名反查全部
 * 引用处飘红(仿 TS),都定位不到才退回 toast。文件读取一律走 readProtoFile,
 * 与解析器同源解码(BOM/GBK),列号才不错位。
 */

/** 上一次弹过 toast 的加载错误;相同错误不重复弹(每次保存都失败会刷屏)。 */
let lastLoadErrorToast: string | null = null;

export function reportLoadError(diagnostics: vscode.DiagnosticCollection, frontend: ProtoFrontend, err: unknown): void {
  diagnostics.clear();
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ProtoLoadError && err.file) {
    reportLocatedSyntax(diagnostics, err.file, err);
    return;
  }
  const parsed = parseProtoError(message);
  if (
    parsed.duplicateName &&
    reportDuplicateNameSites(diagnostics, frontend, parsed.duplicateName, message)
  ) {
    lastLoadErrorToast = null;
    return;
  }
  if (reportUnresolvedTypeRefs(diagnostics, frontend, parsed.missingTypes, message)) {
    lastLoadErrorToast = null;
    return;
  }
  if (message === lastLoadErrorToast) return;
  lastLoadErrorToast = message;
  vscode.window.showErrorMessage(`Proto Utils: ${message}`);
}

/** 加载成功后由保存处理器调用:清空诊断并重置 toast 去重。 */
export function clearLoadErrorState(diagnostics: vscode.DiagnosticCollection): void {
  diagnostics.clear();
  lastLoadErrorToast = null;
}

/**
 * 保存与工作台两个触发源共用的防抖重诊断(0.3.40)。
 * 300ms 内多次触发只全量解析一次(load 是同步全量解析,会短暂阻塞宿主);
 * dispose 取消挂起计时。触发体即原保存处理器:load→清/报。
 * 0.3.45:不再盲 invalidate——frontend 的 mtime 指纹门按 stat 判定变更,
 * 未变更树直接复用缓存(此前每次开工作台都强制全量重析,宿主被卡数秒到数分钟,
 * 编辑器 CodeLens 请求饿死);指纹门同时覆盖 watcher 盲区(protoDir 在工作区外)。
 */
export function createLoadDiagnosticsTrigger(
  diagnostics: vscode.DiagnosticCollection,
  frontend: ProtoFrontend,
  delayMs = 300,
): { trigger(): void; dispose(): void } {
  let timer: NodeJS.Timeout | undefined;
  // 上次 settle 产物引用(0.3.45):指纹门命中时 load 返回同一缓存实例,
  // 据此跳过重复诊断——reportMissingImports/reportLoadError 都会全树重扫,
  // 不加这道门的话,每次开工作台仍是一次隐形全量扫描。
  let lastSchema: ProtoSchema | null = null;
  let lastError: unknown = null;
  return {
    trigger() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const schema = frontend.load();
          if (schema === lastSchema) return; // 树未变更:诊断保持原样
          lastSchema = schema;
          lastError = null;
          clearLoadErrorState(diagnostics);
          reportMissingImports(diagnostics, frontend, schema);
        } catch (err) {
          if (err === lastError) return; // 同一错误实例:不重复飘红
          lastError = err;
          lastSchema = null;
          reportLoadError(diagnostics, frontend, err);
        }
      }, delayMs);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

/** 语法错就地飘红;0.3.40:违规 token 在出错行唯一出现则收窄到 token,否则保持整行。 */
function reportLocatedSyntax(diagnostics: vscode.DiagnosticCollection, file: string, err: ProtoLoadError): void {
  const line = Math.max(0, (err.line ?? 1) - 1);
  let range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
  const token = parseProtoError(err.message).quotedToken;
  if (token) {
    try {
      // 必须与解析器同源解码(readProtoFile:BOM 剥离 + GBK 回退),
      // 否则 BOM/GBK 文件的列号相对解析器所见文本偏移,飘红错位
      const lineText = readProtoFile(file).split('\n')[line];
      // split 计数而非 \b 正则:token 常为标点('}'),\b 对标点两侧不生效
      if (lineText && lineText.split(token).length === 2) {
        const col = lineText.indexOf(token);
        range = new vscode.Range(line, col, line, col + token.length);
      }
    } catch {
      // 文件读不到:保持整行
    }
  }
  const diagnostic = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
  diagnostics.set(vscode.Uri.file(file), [diagnostic]);
}

/**
 * duplicate name 无位置:借扫描器定位声明点(两处重名都飘红,仿 TS duplicate identifier)。
 * kind 分派:Namespace 按全限定 container 精确匹配;Type 按父短名匹配嵌套符号
 * (字段重名不在 symbols 内,自然落空退 toast);Root 限无 package 的顶层符号;
 * Enum/Service 的重名主体是枚举值/rpc 方法,不在 symbols 内,按名匹配只会
 * 误伤同名跨种类声明——直接退 toast。
 */
function reportDuplicateNameSites(
  diagnostics: vscode.DiagnosticCollection,
  frontend: ProtoFrontend,
  dup: { name: string; kind: 'Namespace' | 'Type' | 'Enum' | 'Service' | 'Root'; container?: string },
  message: string,
): boolean {
  if (dup.kind === 'Enum' || dup.kind === 'Service') return false;
  let found = false;
  for (const file of frontend.scan()) {
    const result = scanProto(readProtoFile(file));
    const diags = [...(diagnostics.get?.(vscode.Uri.file(file)) ?? [])];
    for (const sym of result.symbols) {
      if (sym.name !== dup.name) continue;
      const parentPath = sym.qualifiedName.includes('.')
        ? sym.qualifiedName.slice(0, sym.qualifiedName.lastIndexOf('.'))
        : '';
      // 符号的父路径全限定形 = package + qualifiedName 去末段
      const parentFq = [result.packageName ?? '', parentPath].filter(Boolean).join('.');
      const hit =
        dup.kind === 'Root'
          ? parentFq === ''
          : !dup.container ||
            (dup.kind === 'Namespace' ? parentFq === dup.container : parentFq.split('.').pop() === dup.container);
      if (!hit) continue;
      const { start, end } = sym.range;
      diags.push(
        new vscode.Diagnostic(
          new vscode.Range(start.line, start.character, end.line, end.character),
          message,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }
    if (diags.length > 0) {
      diagnostics.set(vscode.Uri.file(file), diags);
      found = true;
    }
  }
  return found;
}

/**
 * load 成功路径的「漏 import」提醒(0.3.43):ProtoFrontend 全量加载下工作区内类型
 * 总能 resolve,但 runner 平面逐文件加载,漏 import 要到运行时才报 no such type——
 * 这里在保存/工作台 settled 后提前飘红。判定在纯函数层(analysis/missingImport),
 * 本函数只做 finding→Diagnostic 适配:按引用文件分组,借扫描器 typeRefs 定位,
 * 诊断挂 missingImportFix 供 Quick Fix provider 零重算读取。绝不抛。
 */
export function reportMissingImports(
  diagnostics: vscode.DiagnosticCollection,
  frontend: ProtoFrontend,
  schema: ProtoSchema,
): void {
  try {
    // 同一文件只读扫一次:imports(闭包计算)与 typeRefs(定位)共享同一份扫描结果
    const scanCache = new Map<string, ScanResult | null>();
    const scanOf = (file: string): ScanResult | null => {
      if (!scanCache.has(file)) {
        let result: ScanResult | null = null;
        try {
          result = scanProto(readProtoFile(file));
        } catch {
          result = null; // 读取失败:闭包少边只可能多报;文件此时多半本就坏掉
        }
        scanCache.set(file, result);
      }
      return scanCache.get(file) ?? null;
    };
    const findings = findMissingImports(
      schema,
      (file) => scanOf(file)?.imports ?? [],
      createImportResolver(frontend.includeDirs),
    );
    const byFile = new Map<string, typeof findings>();
    for (const finding of findings) {
      const group = byFile.get(finding.referencingFile);
      if (group) group.push(finding);
      else byFile.set(finding.referencingFile, [finding]);
    }
    for (const [file, fileFindings] of byFile) {
      const typeRefs = scanOf(file)?.typeRefs;
      if (!typeRefs) continue;
      const diags: vscode.Diagnostic[] = [];
      for (const finding of fileFindings) {
        const ranges = locateTypeRefs(typeRefs, finding.refText);
        if (ranges.length === 0) continue;
        const importPath = computeImportPath(finding.definingFile, finding.referencingFile, frontend.includeDirs);
        const message = vscode.l10n.t(
          'Type "{0}" is defined in "{1}", but this file does not import it',
          finding.typeFqn,
          importPath,
        );
        for (const range of ranges) {
          const diag: vscode.Diagnostic & { missingImportFix?: MissingImportFix } = new vscode.Diagnostic(
            toVsCodeRange(range),
            message,
            vscode.DiagnosticSeverity.Error,
          );
          diag.source = 'proto-utils';
          diag.code = MISSING_IMPORT_CODE;
          diag.missingImportFix = { importPath };
          diags.push(diag);
        }
      }
      if (diags.length > 0) diagnostics.set(vscode.Uri.file(file), diags);
    }
  } catch {
    // 检测自身出错不得把一次成功的 load 变成报错
  }
}

/**
 * no such type 无位置:按类型短名反查全部引用处飘红(0.3.30)。
 * missingTypes 由 parseProtoError 提取(冒号形 + 引号形,0.3.40 起 Field 的
 * "no such Type or Enum 'X'" 也进这里,此前只能退 toast)。
 */
function reportUnresolvedTypeRefs(
  diagnostics: vscode.DiagnosticCollection,
  frontend: ProtoFrontend,
  missingTypes: string[],
  message: string,
): boolean {
  const shortNames = new Set<string>();
  for (const name of missingTypes) {
    shortNames.add(name.slice(name.lastIndexOf('.') + 1));
  }
  if (shortNames.size === 0) return false;
  let found = false;
  for (const shortName of shortNames) {
    const refRe = new RegExp(`\\b${shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    for (const file of frontend.scan()) {
      const text = readProtoFile(file);
      const lineStarts: number[] = [0];
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
      }
      const diags = [...(diagnostics.get?.(vscode.Uri.file(file)) ?? [])];
      refRe.lastIndex = 0;
      let hit: RegExpExecArray | null;
      while ((hit = refRe.exec(text))) {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (lineStarts[mid] <= hit.index) lo = mid;
          else hi = mid - 1;
        }
        const col = hit.index - lineStarts[lo];
        const range = new vscode.Range(lo, col, lo, col + shortName.length);
        diags.push(new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error));
      }
      if (diags.length > 0) {
        diagnostics.set(vscode.Uri.file(file), diags);
        found = true;
      }
    }
  }
  return found;
}
