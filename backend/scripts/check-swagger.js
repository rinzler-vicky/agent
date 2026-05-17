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

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const violations = [];

  let hasController = false;
  let hasApiTags = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/@Controller\s*\(/.test(line)) hasController = true;
    if (/@ApiTags\s*\(/.test(line)) hasApiTags = true;

    // Find HTTP verb decorators and look back for @ApiOperation in the same
    // decorator block (a contiguous run of lines starting with @).
    const verbMatch = line.match(/^\s*(@[A-Z][a-zA-Z]+)\s*\(/);
    if (verbMatch && HTTP_VERB_DECORATORS.has(verbMatch[1])) {
      let foundOp = false;
      // Look at decorators above AND below this verb decorator. NestJS
      // tolerates either order; what matters is that the same method has
      // a matching @ApiOperation in its decorator stack.
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim();
        if (prev === '') break;
        if (/@ApiOperation\s*\(/.test(prev)) { foundOp = true; break; }
        if (!prev.startsWith('@') && !prev.startsWith(')')) break;
      }
      if (!foundOp) {
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (next === '') break;
          if (/@ApiOperation\s*\(/.test(next)) { foundOp = true; break; }
          if (!next.startsWith('@') && !next.startsWith(')')) break;
        }
      }
      if (!foundOp) {
        violations.push({
          line: i + 1,
          message: `${verbMatch[1]} method is missing @ApiOperation`,
        });
      }
    }
  }

  if (hasController && !hasApiTags) {
    violations.push({ line: 1, message: '@Controller class is missing @ApiTags' });
  }

  return { hasController, violations };
}

function main() {
  const argv = process.argv.slice(2);
  const explicitFiles = argv.filter((a) => !a.startsWith('-'));
  const targets =
    explicitFiles.length > 0
      ? explicitFiles.filter((f) => /\.controller\.ts$/.test(f) && fs.existsSync(f))
      : findControllers(path.resolve(__dirname, '..', 'src'));

  let totalViolations = 0;
  const report = [];

  for (const file of targets) {
    const { hasController, violations } = checkFile(file);
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
