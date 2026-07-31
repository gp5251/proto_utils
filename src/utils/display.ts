import { CallResult } from '../call/types';

export function formatResponse(result: CallResult): string {
  const lines: string[] = [];

  if (result.status === 'ok') {
    lines.push('=== Response (OK) ===');
  } else {
    lines.push('=== Response (ERROR) ===');
    lines.push(`  Error: ${result.error}`);
  }

  lines.push(`  Duration: ${result.durationMs}ms`);

  if (result.status === 'ok' && result.data !== null && result.data !== undefined) {
    lines.push('  Data:');
    lines.push(JSON.stringify(result.data, null, 2)
      .split('\n')
      .map(line => '  ' + line)
      .join('\n'));
  }

  return lines.join('\n');
}
