import * as grpc from '@grpc/grpc-js';

interface GrpcLikeError extends Error {
  code?: number;
  details?: string;
  metadata?: grpc.Metadata;
  cause?: unknown;
}

export function formatGrpcError(err: unknown, server?: string): string {
  if (err === null || err === undefined) {
    return '未知错误';
  }

  if (!(err instanceof Error)) {
    return String(err);
  }

  const lines: string[] = [];
  const serviceErr = err as GrpcLikeError;

  if (typeof serviceErr.code === 'number') {
    const codeName = grpc.status[serviceErr.code] ?? 'UNKNOWN';
    lines.push(`状态码: ${codeName} (${serviceErr.code})`);
  }

  if (serviceErr.details) {
    lines.push(`详情: ${serviceErr.details}`);
  }

  if (serviceErr.message && serviceErr.message !== serviceErr.details) {
    lines.push(`消息: ${serviceErr.message}`);
  }

  if (server) {
    lines.push(`服务器: ${server}`);
  }

  const hint = getHint(serviceErr.code, server);
  if (hint) {
    lines.push(`提示: ${hint}`);
  }

  if (serviceErr.metadata) {
    const metaLines = formatMetadata(serviceErr.metadata);
    if (metaLines.length > 0) {
      lines.push('元数据:');
      lines.push(...metaLines);
    }
  }

  const cause = serviceErr.cause;
  if (cause) {
    const causeText = cause instanceof Error ? cause.message : String(cause);
    if (causeText && !lines.some(line => line.includes(causeText))) {
      lines.push(`原因: ${causeText}`);
    }
  }

  if (lines.length === 0) {
    return err.message || String(err);
  }

  return lines.join('\n');
}

function getHint(code: number | undefined, server?: string): string | null {
  if (code === undefined) {
    return null;
  }

  switch (code) {
    case grpc.status.UNAVAILABLE:
      return server
        ? `请确认 gRPC 服务 ${server} 已启动且可访问`
        : '请确认 gRPC 服务已启动且可访问';
    case grpc.status.DEADLINE_EXCEEDED:
      return '请求超时，请检查网络或服务响应时间';
    case grpc.status.UNAUTHENTICATED:
      return '未通过身份验证';
    case grpc.status.PERMISSION_DENIED:
      return '无权限执行此 RPC';
    case grpc.status.NOT_FOUND:
      return '服务或方法在服务端不存在';
    case grpc.status.INVALID_ARGUMENT:
      return '请求参数无效，请检查表单字段';
    case grpc.status.INTERNAL:
      return '服务端内部错误';
    default:
      return null;
  }
}

function formatMetadata(metadata: grpc.Metadata): string[] {
  const lines: string[] = [];
  try {
    const map = metadata.getMap();
    for (const [key, value] of Object.entries(map)) {
      lines.push(`  ${key}: ${value}`);
    }
  } catch {
    // ignore malformed metadata
  }
  return lines;
}
