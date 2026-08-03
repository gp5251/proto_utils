import fs from 'fs';
import path from 'path';
import { ServiceInfo, MethodInfo, FieldInfo, EnumOption } from './types';
import * as protoLoader from '@grpc/proto-loader';
import { clearPackageDefinitionCache, getPackageDefinition } from './protoCache';
import { buildProtoCommentIndex, lookupEnumValueComment, lookupFieldComment, ProtoCommentIndex } from '../utils/protoComments';
import { readProtoFile } from '../utils/protoEncoding';
import { scanProto } from '../../index/scanner';

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
      // generated/__fixtures__ 是历史约定;node_modules 必须排除——protoDir 默认是工作区根,
      // 扫进去会把依赖内部的 .proto(grpc-js/protobufjs 自带)当业务文件,报出一堆无关加载错误
      if (entry.name === 'generated' || entry.name === '__fixtures__' || entry.name === 'node_modules') continue;
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

let commentIndex: ProtoCommentIndex | null = null;

function getCommentIndex(protoFiles: string[]): ProtoCommentIndex {
  if (!commentIndex) {
    commentIndex = buildProtoCommentIndex(protoFiles);
  }
  return commentIndex;
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

  const comments = getCommentIndex(protoFiles);
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
  commentIndex = null;
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

      const reqFields = extractMessageFields(allPkgDefs, reqTypeObj, comments);
      const resFields = extractMessageFields(allPkgDefs, resTypeObj, comments);

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
  maxDepth = 8
): FieldInfo[] {
  if (!typeObj) return [];

  const typeName = typeObj.type?.name || typeObj.name;
  if (!typeName) return [];

  const msgDef = findMessageDef(allPkgDefs, typeName);
  if (!msgDef) return [];

  const type = msgDef.type as Record<string, unknown>;
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
      comment: lookupFieldComment(comments, typeName, field.name as string),
    };

    if (refName && (ft === 'TYPE_MESSAGE' || ft === 'TYPE_ENUM')) {
      const shortName = refName.replace(/^\./, '').split('.').pop();
      if (shortName) {
        fieldInfo.refType = shortName;
      }
    }

    if (ft === 'TYPE_ENUM') {
      const enumValues = extractEnumValues(allPkgDefs, refName, comments);
      if (enumValues.length > 0) {
        fieldInfo.enumValues = enumValues;
      }
    }

    if (ft === 'TYPE_MESSAGE' && refName && depth < maxDepth) {
      fieldInfo.nestedFields = extractMessageFieldsByRef(allPkgDefs, refName, comments, depth + 1, maxDepth);
    }

    fields.push(fieldInfo);
  }

  return fields;
}

function extractMessageFieldsByRef(
  allPkgDefs: protoLoader.PackageDefinition[],
  typeName: string,
  comments: ProtoCommentIndex,
  depth: number,
  maxDepth: number
): FieldInfo[] {
  const shortName = typeName.replace(/^\./, '').split('.').pop() || typeName;
  return extractMessageFields(allPkgDefs, { name: shortName }, comments, depth, maxDepth);
}

function findMessageDef(
  allPkgDefs: protoLoader.PackageDefinition[],
  typeName: string
): Record<string, unknown> | null {
  for (const pkgDef of allPkgDefs) {
    const typedPkgDef = pkgDef as Record<string, unknown>;
    for (const [key, val] of Object.entries(typedPkgDef)) {
      if (key === typeName || key.endsWith('.' + typeName)) {
        const v = val as Record<string, unknown>;
        if (v.format === 'Protocol Buffer 3 DescriptorProto' && v.type) {
          return v as Record<string, unknown>;
        }
      }
    }
  }
  return null;
}

function extractEnumValues(
  allPkgDefs: protoLoader.PackageDefinition[],
  typeName: string | undefined,
  comments: ProtoCommentIndex
): EnumOption[] {
  if (!typeName) {
    return [];
  }

  const enumName = typeName.replace(/^\./, '').split('.').pop();
  if (!enumName) {
    return [];
  }

  for (const pkgDef of allPkgDefs) {
    const typedPkgDef = pkgDef as Record<string, unknown>;
    for (const [key, val] of Object.entries(typedPkgDef)) {
      if (key !== enumName && !key.endsWith('.' + enumName)) {
        continue;
      }
      const v = val as Record<string, unknown>;
      if (v.format !== 'Protocol Buffer 3 EnumDescriptorProto' || !v.type) {
        continue;
      }
      const enumType = v.type as { value?: Array<{ name?: string; number?: number }> };
      if (!Array.isArray(enumType.value)) {
        continue;
      }
      return enumType.value
        .filter(item => typeof item.name === 'string')
        .map(item => ({
          name: item.name as string,
          number: typeof item.number === 'number' ? item.number : 0,
          comment: lookupEnumValueComment(comments, enumName, item.name as string),
        }));
    }
  }

  return [];
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
