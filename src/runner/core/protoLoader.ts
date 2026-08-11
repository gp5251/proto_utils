import fs from 'fs';
import path from 'path';
import { ServiceInfo, MethodInfo, FieldInfo, EnumOption } from './types';
import * as protoLoader from '@grpc/proto-loader';
import { clearPackageDefinitionCache, getPackageDefinition } from './protoCache';
import { buildProtoCommentIndex, lookupEnumValueComment, lookupFieldComment, ProtoCommentIndex } from '../utils/protoComments';
import { readProtoFile } from '../../runtime/protoEncoding';
import { scanProto } from '../../index/scanner';
import { SCAN_EXCLUDED_DIRS } from '../../runtime/protoFrontend';

export function scanProtoFiles(protoDir: string): string[] {
  if (!fs.existsSync(protoDir)) return [];
  const results: string[] = [];
  walkDir(protoDir, results);
  return results;
}

function walkDir(dir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 构建产物/历史约定目录必须排除(与 ProtoFrontend.scan 同一清单):
      // 扫进 out/ 等拷贝会让服务列表/诊断出现 duplicate name
      if (entry.name.startsWith('.') || (SCAN_EXCLUDED_DIRS as readonly string[]).includes(entry.name)) continue;
      walkDir(fullPath, results);
    } else if (entry.name.endsWith('.proto')) {
      results.push(fullPath);
    }
  }
}

export interface ProtoLoadResult {
  services: ServiceInfo[];
  errors: string[];
}

export function loadProtoDefinitions(protoFiles: string[], protoDir: string): ProtoLoadResult {
  if (protoFiles.length === 0) return { services: [], errors: [] };

  const allPkgDefs: protoLoader.PackageDefinition[] = [];
  const errors: string[] = [];
  for (const file of protoFiles) {
    try {
      const def = getPackageDefinition(file, protoDir);
      allPkgDefs.push(def);
    } catch (e: unknown) {
      const err = e as Error;
      errors.push(`${file}: ${err.message || String(e)}`);
    }
  }

  if (allPkgDefs.length === 0) return { services: [], errors };

  // 注释索引随本次文件集现建:模块级缓存会在 protoDir 切换/测试间串污染
  const comments = buildProtoCommentIndex(protoFiles);
  const serviceMap = new Map<string, ServiceInfo>();

  for (const pkgDef of allPkgDefs) {
    extractServices(pkgDef, serviceMap, allPkgDefs, comments);
  }

  return { services: Array.from(serviceMap.values()), errors };
}

export function findProtoFileForService(protoDir: string, serviceName: string): string | null {
  const protoFiles = scanProtoFiles(protoDir);

  let bestFile: string | null = null;
  let bestMethodCount = -1;

  for (const file of protoFiles) {
    let content: string;
    try {
      content = readProtoFile(file);
    } catch {
      continue;
    }

    const methodCount = scanProto(content).services.find((s) => s.name === serviceName)?.methods.length ?? 0;
    if (methodCount > bestMethodCount) {
      bestFile = file;
      bestMethodCount = methodCount;
    }
  }

  return bestMethodCount > 0 ? bestFile : null;
}

export function resetProtoLoaderCache(): void {
  clearPackageDefinitionCache();
}

function isMethodDef(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && 'requestType' in value && 'responseType' in value;
}

function extractServices(
  pkgDef: Record<string, unknown>,
  serviceMap: Map<string, ServiceInfo>,
  allPkgDefs: protoLoader.PackageDefinition[],
  comments: ProtoCommentIndex
): void {
  for (const [fqn, value] of Object.entries(pkgDef)) {
    if (typeof value !== 'object' || value === null) continue;
    const ns = value as Record<string, unknown>;

    const methodEntries = Object.entries(ns).filter(([, v]) => isMethodDef(v));
    if (methodEntries.length === 0) continue;

    const segments = fqn.split('.');
    const svcName = segments[segments.length - 1];
    const pkg = segments.slice(0, -1).join('.');

    const methodInfos: MethodInfo[] = [];
    for (const [methodName, methodDef] of methodEntries) {
      const m = methodDef as Record<string, unknown>;
      const reqTypeObj = m.requestType as { name?: string; type?: { name?: string } } | null;
      const resTypeObj = m.responseType as { name?: string; type?: { name?: string } } | null;

      const reqType = reqTypeObj?.type?.name || reqTypeObj?.name || 'unknown';
      const resType = resTypeObj?.type?.name || resTypeObj?.name || 'unknown';

      const reqFields = extractMessageFields(allPkgDefs, reqTypeObj, comments, 0, 8, pkg);
      const resFields = extractMessageFields(allPkgDefs, resTypeObj, comments, 0, 8, pkg);

      methodInfos.push({
        name: methodName,
        requestType: reqType,
        responseType: resType,
        requestStream: m.requestStream === true,
        responseStream: m.responseStream === true,
        requestFields: reqFields,
        responseFields: resFields,
      });
    }

    const fullName = pkg ? `${pkg}.${svcName}` : svcName;

    const existing = serviceMap.get(fullName);
    if (existing) {
      const methodMap = new Map(existing.methods.map(m => [m.name, m]));
      for (const m of methodInfos) {
        methodMap.set(m.name, m);
      }
      serviceMap.set(fullName, {
        ...existing,
        methods: Array.from(methodMap.values()),
      });
      continue;
    }

    serviceMap.set(fullName, {
      name: svcName,
      fullName,
      package: pkg,
      methods: methodInfos,
    });
  }
}

function extractMessageFields(
  allPkgDefs: protoLoader.PackageDefinition[],
  typeObj: { name?: string; type?: { name?: string } } | null,
  comments: ProtoCommentIndex,
  depth = 0,
  maxDepth = 8,
  scopeHint?: string
): FieldInfo[] {
  if (!typeObj) return [];

  // typeName:service 面是短名(descriptor 只带短名,靠 scopeHint=service 包消歧);
  // nested 面是源码原样书写的引用名(同包短名/相对名/带点绝对名都可能)。
  const typeName = typeObj.type?.name || typeObj.name;
  if (!typeName) return [];

  const resolved = findTypeDef(allPkgDefs, typeName, 'Protocol Buffer 3 DescriptorProto', scopeHint);
  if (!resolved) return [];

  const type = resolved.def.type as Record<string, unknown>;
  if (!type || !Array.isArray(type.field)) return [];

  const fields: FieldInfo[] = [];
  for (const field of type.field as Array<Record<string, unknown>>) {
    const ft = field.type as string;
    const fl = field.label as string;
    const refName = field.typeName as string | undefined;
    const fieldInfo: FieldInfo = {
      name: field.name as string,
      type: mapProtoType(ft),
      required: fl === 'LABEL_REQUIRED',
      label: fl.replace('LABEL_', '').toLowerCase(),
      protoType: ft,
      optional: field.options != null,
      comment: lookupFieldComment(comments, resolved.fqn, field.name as string),
    };

    if (refName && (ft === 'TYPE_MESSAGE' || ft === 'TYPE_ENUM')) {
      const shortName = refName.replace(/^\./, '').split('.').pop();
      if (shortName) {
        fieldInfo.refType = shortName;
      }
    }

    if (ft === 'TYPE_ENUM') {
      const enumValues = extractEnumValues(allPkgDefs, refName, comments, resolved.fqn);
      if (enumValues.length > 0) {
        fieldInfo.enumValues = enumValues;
      }
    }

    if (ft === 'TYPE_MESSAGE' && refName && depth < maxDepth) {
      // 相对引用必须在容器 message 的作用域里解析:跨包同名 message
      // (如 var.global/ldprog 各有 LDElemt_Info)短名首中即错配。
      fieldInfo.nestedFields = extractMessageFields(allPkgDefs, { name: refName }, comments, depth + 1, maxDepth, resolved.fqn);
    }

    fields.push(fieldInfo);
  }

  return fields;
}

/**
 * 跨包类型解析:pkgDef 键是全限定名,而 descriptor 的 typeName 是源码原样名。
 * 按 protobuf 作用域外扩语义解析:绝对名(.)只精确匹配;相对名从 scopeHint
 * (容器 message 或 service 所在包)逐层外扩精确匹配;最后退回短名 endsWith
 * (历史行为,兼容 req/res 类型与 service 不同包)。
 */
function findTypeDef(
  allPkgDefs: protoLoader.PackageDefinition[],
  typeName: string,
  format: 'Protocol Buffer 3 DescriptorProto' | 'Protocol Buffer 3 EnumDescriptorProto',
  scopeHint?: string
): { def: Record<string, unknown>; fqn: string } | null {
  const absolute = typeName.startsWith('.');
  const bare = absolute ? typeName.slice(1) : typeName;
  const shortName = bare.split('.').pop() || bare;

  const tryKeys: string[] = [];
  if (absolute) {
    tryKeys.push(bare);
  } else {
    let scope = scopeHint ?? '';
    while (scope !== '') {
      tryKeys.push(`${scope}.${bare}`);
      const dot = scope.lastIndexOf('.');
      scope = dot > 0 ? scope.slice(0, dot) : '';
    }
    tryKeys.push(bare);
  }

  for (const want of tryKeys) {
    for (const pkgDef of allPkgDefs) {
      for (const [key, val] of Object.entries(pkgDef as Record<string, unknown>)) {
        if (key !== want) continue;
        const v = val as Record<string, unknown>;
        if (v.format === format && v.type) {
          return { def: v, fqn: want };
        }
      }
    }
  }

  for (const pkgDef of allPkgDefs) {
    for (const [key, val] of Object.entries(pkgDef as Record<string, unknown>)) {
      if (key === shortName || key.endsWith('.' + shortName)) {
        const v = val as Record<string, unknown>;
        if (v.format === format && v.type) {
          return { def: v, fqn: key };
        }
      }
    }
  }
  return null;
}

function extractEnumValues(
  allPkgDefs: protoLoader.PackageDefinition[],
  typeName: string | undefined,
  comments: ProtoCommentIndex,
  scopeHint?: string
): EnumOption[] {
  if (!typeName) {
    return [];
  }

  const bare = typeName.replace(/^\./, '');
  if (!bare) {
    return [];
  }

  const resolved = findTypeDef(allPkgDefs, typeName, 'Protocol Buffer 3 EnumDescriptorProto', scopeHint);
  if (!resolved) {
    return [];
  }
  const enumType = resolved.def.type as { value?: Array<{ name?: string; number?: number }> };
  if (!Array.isArray(enumType.value)) {
    return [];
  }
  return enumType.value
    .filter(item => typeof item.name === 'string')
    .map(item => ({
      name: item.name as string,
      number: typeof item.number === 'number' ? item.number : 0,
      comment: lookupEnumValueComment(comments, resolved.fqn, item.name as string),
    }));
}

const TYPE_LABEL_BY_PROTO: Record<string, string> = {
  TYPE_STRING: 'string',
  TYPE_INT32: 'number',
  TYPE_INT64: 'number',
  TYPE_UINT32: 'number',
  TYPE_UINT64: 'number',
  TYPE_SINT32: 'number',
  TYPE_SINT64: 'number',
  TYPE_FIXED32: 'number',
  TYPE_FIXED64: 'number',
  TYPE_SFIXED32: 'number',
  TYPE_SFIXED64: 'number',
  TYPE_BOOL: 'boolean',
  TYPE_DOUBLE: 'number',
  TYPE_FLOAT: 'number',
  TYPE_BYTES: 'bytes',
  TYPE_ENUM: 'enum',
  TYPE_MESSAGE: 'message',
};

function mapProtoType(protoType: string): string {
  return TYPE_LABEL_BY_PROTO[protoType] ?? 'string';
}
