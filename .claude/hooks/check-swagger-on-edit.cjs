#!/usr/bin/env node
/* eslint-disable */
/**
 * Claude Code PostToolUse hook — runs after Write/Edit on a NestJS controller.
 * Reads the hook payload from stdin, extracts the modified file path, and
 * forwards it to backend/scripts/check-swagger.js. On violation, exits 2
 * which surfaces stderr back to Claude so it can self-correct in the same
 * turn rather than at commit time.
 *
 * Hook payload schema (Claude Code):
 *   { tool_name, tool_input: { file_path }, tool_response, ... }
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }

  const filePath = payload?.tool_input?.file_path || payload?.tool_input?.path;
  if (!filePath || !/\.controller\.ts$/.test(filePath)) {
    process.exit(0);
  }

  const scriptPath = path.resolve(__dirname, '..', '..', 'backend', 'scripts', 'check-swagger.js');
  const result = spawnSync('node', [scriptPath, filePath], { stdio: 'inherit' });

  if (result.status !== 0) {
    process.stderr.write(
      '\nHook check-swagger-on-edit blocked this change. ' +
      'Add @ApiTags / @ApiOperation annotations or revert the controller edit. ' +
      'AGENTS.md §7 requires API docs to be kept in sync.\n',
    );
    // Exit code 2 = block + surface stderr to Claude. Exit 1 would only log.
    process.exit(2);
  }
  process.exit(0);
});
