import * as grpc from '@grpc/grpc-js';
import { l10n } from 'vscode';

interface GrpcLikeError extends Error {
  code?: number;
  details?: string;
  metadata?: grpc.Metadata;
  cause?: unknown;
}

/**
 * gRPC 错误 → 多行人类可读文本(0.3.44 起全部走 l10n:文案随显示语言,
 * 不再出现「界面英文 + 错误中文」的混排)。测试环境 vscode 替身恒等返回源串。
 */
export function formatGrpcError(err: unknown, server?: string): string {
  if (err === null || err === undefined) {
    return l10n.t('Unknown error');
  }

  if (!(err instanceof Error)) {
    return String(err);
  }

  const lines: string[] = [];
  const serviceErr = err as GrpcLikeError;

  if (typeof serviceErr.code === 'number') {
    const codeName = grpc.status[serviceErr.code] ?? 'UNKNOWN';
    lines.push(l10n.t('Status code: {0} ({1})', codeName, String(serviceErr.code)));
  }

  if (serviceErr.details) {
    lines.push(l10n.t('Details: {0}', serviceErr.details));
  }

  if (serviceErr.message && serviceErr.message !== serviceErr.details) {
    lines.push(l10n.t('Message: {0}', serviceErr.message));
  }

  if (server) {
    lines.push(l10n.t('Server: {0}', server));
  }

  const hint = getHint(serviceErr.code, server);
  if (hint) {
    lines.push(l10n.t('Hint: {0}', hint));
  }

  if (serviceErr.metadata) {
    const metaLines = formatMetadata(serviceErr.metadata);
    if (metaLines.length > 0) {
      lines.push(l10n.t('Metadata:'));
      lines.push(...metaLines);
    }
  }

  const cause = serviceErr.cause;
  if (cause) {
    const causeText = cause instanceof Error ? cause.message : String(cause);
    if (causeText && !lines.some(line => line.includes(causeText))) {
      lines.push(l10n.t('Cause: {0}', causeText));
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
        ? l10n.t('Check that the gRPC server {0} is up and reachable', server)
        : l10n.t('Check that the gRPC server is up and reachable');
    case grpc.status.DEADLINE_EXCEEDED:
      return l10n.t('Request timed out. Check network or server latency');
    case grpc.status.UNAUTHENTICATED:
      return l10n.t('Authentication failed');
    case grpc.status.PERMISSION_DENIED:
      return l10n.t('Permission denied for this RPC');
    case grpc.status.NOT_FOUND:
      return l10n.t('Service or method does not exist on the server');
    case grpc.status.INVALID_ARGUMENT:
      return l10n.t('Invalid request arguments. Check the form fields');
    case grpc.status.INTERNAL:
      return l10n.t('Internal server error');
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
