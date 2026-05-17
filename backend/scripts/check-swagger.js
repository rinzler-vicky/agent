#!/usr/bin/env node
/* eslint-disable */
/**
 * check-swagger.js — fails CI / pre-commit when a NestJS controller is
 * added or modified without OpenAPI annotations.
 *
 * Rules enforced (in order of severity):
 *   1. Every class decorated with @Controller(...) MUST carry @ApiTags(...).
 *   2. Every HTTP-verb method decorator (@Get/@Post/@Put/@Patch/@Delete/
 *      @Options/@Head/@All) MUST be preceded by @ApiOperation(...) within
 *      the same decorator block (no blank line between).
 *
 * Why this exists: AGENTS.md §7 ("Documentation") already requires API
 * docs to be updated when behavior changes, but the rule is unenforced
 * and a recent PR (#61, Phase 2.3 n8n adapter) shipped a new route
 * without Swagger annotations and was only caught by human review.
 * See the self-evolution issue linked from this PR for the postmortem.
 *
 * Usage:
 *   node backend/scripts/check-swagger.js               # scans all controllers
 *   node backend/scripts/check-swagger.js file1 file2   # scans only those files
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HTTP_VERB_DECORATORS = new Set([
  '@Get',
  '@Post',
  '@Put',
  '@Patch',
  '@Delete',
  '@Options',
  '@Head',
  '@All',
]);

function findControllers(root) {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(p);
      } else if (entry.isFile() && /\.controller\.ts$/.test(entry.name)) {
        out.push(p);
      }
    }
  })(root);
  return out;
}

/**
 * Scan backward from line `origin` (0-based) looking for `pattern`.
 * Correctly handles multi-line decorator arguments by tracking paren depth:
 *   - scanning backward: ')' enters a deeper level (depth++), '(' exits (depth--)
 *   - while depth > 0 we are inside a decorator's argument list → keep scanning
 *   - once depth returns to 0 a non-decorator line terminates the block
 */
function scanBackward(lines, origin, pattern) {
  let depth = 0;
  for (let j = origin - 1; j >= 0; j--) {
    const prev = lines[j].trim();
    if (pattern.test(prev)) return true;
    for (const ch of prev) {
      if (ch === ')') depth++;
      else if (ch === '(') depth--;
    }
    if (depth < 0) break;
    if (depth === 0 && prev === '') break;
    if (depth === 0 && !prev.startsWith('@')) break;
  }
  return false;
}

/**
 * Scan forward from line `origin` (0-based) looking for `pattern`.
 * Tracks paren depth to traverse multi-line decorator arguments:
 *   - scanning forward: '(' increases depth, ')' decreases
 *   - prevDepth tracks the depth BEFORE the current line's parens are counted
 *     so that a standalone ')' closing a multi-line decorator (prevDepth > 0,
 *     newDepth = 0) does not trigger the "non-decorator" break.
 */
function scanForward(lines, origin, pattern) {
  let depth = 0;
  for (let j = origin + 1; j < lines.length; j++) {
    const next = lines[j].trim();
    if (next === '' && depth === 0) break;
    if (pattern.test(next)) return true;
    const prevDepth = depth;
    for (const ch of next) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth < 0) break;
    // Only break on non-decorator lines that were themselves at depth 0 (i.e. not
    // closing-paren lines that brought us from depth>0 back to 0).
    if (depth === 0 && prevDepth === 0 && !next.startsWith('@') && next !== '') break;
  }
  return false;
}

function checkFile(file, readContent) {
  const text = readContent(file);
  const lines = text.split(/\r?\n/);
  const violations = [];
  let hasController = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Per-class @ApiTags check: every @Controller class must carry @ApiTags in
    // its own decorator block.  A file-level flag would miss the second class in
    // a file that has two controllers where only one is annotated.
    if (/@Controller\s*\(/.test(line)) {
      hasController = true;
      if (!scanBackward(lines, i, /@ApiTags\s*\(/)) {
        violations.push({ line: i + 1, message: '@Controller class is missing @ApiTags' });
      }
    }

    // Per-route @ApiOperation check
    const verbMatch = line.match(/^\s*(@[A-Z][a-zA-Z]+)\s*\(/);
    if (verbMatch && HTTP_VERB_DECORATORS.has(verbMatch[1])) {
      const op = /@ApiOperation\s*\(/;
      if (!scanBackward(lines, i, op) && !scanForward(lines, i, op)) {
        violations.push({
          line: i + 1,
          message: `${verbMatch[1]} method is missing @ApiOperation`,
        });
      }
    }
  }

  return { hasController, violations };
}

function main() {
  const argv = process.argv.slice(2);
  const useStaged = argv.includes('--staged');
  const explicitFiles = argv.filter((a) => !a.startsWith('-'));
  const targets =
    explicitFiles.length > 0
      ? explicitFiles.filter((f) => /\.controller\.ts$/.test(f) && fs.existsSync(f))
      : findControllers(path.resolve(__dirname, '..', 'src'));

  /**
   * Read file content: when --staged is passed, read the indexed (staged) copy
   * from the git object store so that the pre-commit hook validates what will
   * actually be committed, not the potentially-modified working-tree version.
   */
  function readContent(file) {
    if (useStaged) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
      try {
        // execFileSync avoids shell interpretation of rel; the only expected
        // failure is "path not in index" (new file) → fall through to readFileSync.
        return execFileSync('git', ['show', `:${rel}`], { encoding: 'utf8' });
      } catch {
        // New file not yet tracked in the index — fall back to working tree.
      }
    }
    return fs.readFileSync(file, 'utf8');
  }

  let totalViolations = 0;
  const report = [];

  for (const file of targets) {
    const { hasController, violations } = checkFile(file, readContent);
    if (!hasController) continue;
    if (violations.length === 0) continue;
    totalViolations += violations.length;
    report.push({ file, violations });
  }

  if (totalViolations === 0) {
    if (targets.length > 0 && process.env.CHECK_SWAGGER_VERBOSE) {
      console.log(`check-swagger: ${targets.length} controller file(s) scanned, 0 violations.`);
    }
    process.exit(0);
  }

  console.error('\ncheck-swagger: missing OpenAPI annotations\n');
  for (const { file, violations } of report) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
    for (const v of violations) {
      console.error(`  ${rel}:${v.line}  ${v.message}`);
    }
  }
  console.error('\nFix: add @ApiTags(...) on the controller class and @ApiOperation(...) on');
  console.error('every HTTP-verb route. See backend/src/storage/storage.controller.ts for the pattern.');
  console.error('Rationale: AGENTS.md §7 requires API docs to be updated when routes change.');
  console.error(`\nTotal violations: ${totalViolations}\n`);
  process.exit(1);
}

main();
