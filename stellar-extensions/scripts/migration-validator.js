#!/usr/bin/env node
'use strict';

/**
 * migration-validator.js
 * ----------------------
 * Static safety checks for database migrations.
 *
 * Understands both plain SQL migrations and TypeORM-style TypeScript/JavaScript
 * migrations (up/down methods). Every check is heuristic, but the parser is
 * skip-aware: keywords inside comments or string literals never trigger a
 * finding, and `down()` methods are treated as rollback code rather than
 * forward migrations.
 *
 * Checks
 *   1. Destructive forward operations: DROP TABLE / DROP DATABASE / DROP SCHEMA,
 *      TRUNCATE, DELETE without WHERE (errors).
 *   2. Potential data loss: DROP COLUMN, dropColumn(), DROP INDEX / CONSTRAINT /
 *      VIEW / TYPE / SEQUENCE (warnings).
 *   3. Missing or empty rollback: no down() method, empty down() body, an
 *      *.up.sql without a matching *.down.sql, or no "-- +migrate Down" marker
 *      in a standalone .sql file (errors).
 *   4. Naming conventions: files must start with a 10-14 digit timestamp and a
 *      kebab/snake_case description.
 *
 * Usage
 *   node migration-validator.js --path <migrations-dir> [options]
 *
 * Options
 *   -p, --path <dir>        Migration directory to scan (repeatable)
 *       --fail-on <level>   error (default) | warning | never
 *       --json              Machine-readable report on stdout
 *       --quiet             Suppress the human-readable report
 *   -h, --help              Show this help
 *       --version           Show the version
 *
 * Exit codes
 *   0  no blocking findings
 *   1  blocking findings (errors, or warnings with --fail-on warning)
 *   2  invalid usage / unreadable path
 *
 * Suppressing a single file: add a comment containing
 * `migration-validator: allow-destructive` to intentionally permit destructive
 * forward operations (e.g. an explicit cleanup migration).
 */

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';

const ERROR = 'error';
const WARNING = 'warning';

const CODE = {
  DESTRUCTIVE: 'destructive-operation',
  DATA_LOSS: 'potential-data-loss',
  MISSING_ROLLBACK: 'missing-rollback',
  EMPTY_ROLLBACK: 'empty-rollback',
  INVALID_NAME: 'invalid-name',
};

const TS_NAME_RE =
  /^(\d{10,14})[-_][a-z0-9]+(?:[-_][a-z0-9]+)*\.(ts|js)$/;
const SQL_NAME_RE =
  /^(\d{10,14})[-_][a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.(up|down))?\.sql$/;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
]);

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const USAGE = `Usage: node migration-validator.js --path <migrations-dir> [options]

Validates database migrations for destructive operations, missing rollbacks,
data-loss risks and naming convention violations.

Options:
  -p, --path <dir>      Migration directory to scan (repeatable)
      --fail-on <level> error (default) | warning | never
      --json            Machine-readable JSON report on stdout
      --quiet           Suppress the human-readable report
  -h, --help            Show this help
      --version         Show the version

Exit codes: 0 clean, 1 blocking findings, 2 invalid usage.`;

function parseArgs(argv) {
  const args = {
    paths: [],
    failOn: ERROR,
    json: false,
    quiet: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--version') {
      args.version = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--quiet') {
      args.quiet = true;
    } else if (arg === '-p' || arg === '--path') {
      const value = argv[++i];
      if (!value) throw new UsageError(`${arg} requires a directory`);
      args.paths.push(value);
    } else if (arg.startsWith('--path=')) {
      args.paths.push(arg.slice('--path='.length));
    } else if (arg === '--fail-on') {
      const value = argv[++i];
      if (!value) throw new UsageError('--fail-on requires a level');
      args.failOn = parseFailOn(value);
    } else if (arg.startsWith('--fail-on=')) {
      args.failOn = parseFailOn(arg.slice('--fail-on='.length));
    } else if (!arg.startsWith('-') && args.paths.length === 0) {
      args.paths.push(arg);
    } else {
      throw new UsageError(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function parseFailOn(value) {
  if (value === ERROR || value === WARNING || value === 'never') return value;
  throw new UsageError(
    `Invalid --fail-on value "${value}" (expected error, warning or never)`,
  );
}

class UsageError extends Error {}

/* -------------------------------------------------------------------------- */
/* Source masking                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Returns a same-length copy of `src` in which the *contents* of comments and
 * string literals are replaced by spaces (newlines preserved). This keeps byte
 * offsets stable, so a match on the masked text maps straight back to a line in
 * the original file.
 *
 * `dialect` is "sql" or "js".
 */
function maskSource(src, dialect, options = {}) {
  const keepStrings = options.keepStrings === true;
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // Line comment
    if (ch === '-' && next === '-' && dialect === 'sql') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    // PostgreSQL dollar-quoted string
    if (dialect === 'sql' && ch === '$') {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(src.slice(i, i + 64));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = src.indexOf(tag, i + tag.length);
        if (end === -1) break;
        blank(i + tag.length, end);
        i = end + tag.length;
        continue;
      }
    }

    // Quoted strings
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\' && (dialect === 'js' || src[j + 1] === "'")) {
          j += 2;
          continue;
        }
        if (src[j] === ch) {
          if (src[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      if (!keepStrings) blank(i + 1, j);
      i = j + 1;
      continue;
    }

    // Template literals (JS): blank the whole body, including interpolations.
    if (ch === '`' && dialect === 'js') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '`') break;
        j += 1;
      }
      if (!keepStrings) blank(i + 1, j);
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function lineStartsOf(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function stripForEmptiness(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function hasSuppression(src) {
  return /migration-validator:\s*allow-destructive/i.test(src);
}

/* -------------------------------------------------------------------------- */
/* SQL analysis                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Masks comments/string literals and splits the SQL into statements, preserving
 * each statement's offset in the original source.
 */
function splitSqlStatements(sql) {
  const masked = maskSource(sql, 'sql');
  const statements = [];
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === ';') {
      const text = masked.slice(start, i);
      if (text.trim()) statements.push({ text, start });
      start = i + 1;
    }
  }
  const tail = masked.slice(start);
  if (tail.trim()) statements.push({ text: tail, start });
  return statements;
}

function inspectSql(text) {
  const found = [];
  const add = (code, severity, message) => found.push({ code, severity, message });

  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(text)) {
    add(CODE.DESTRUCTIVE, ERROR, 'DROP TABLE/DATABASE/SCHEMA destroys data and cannot be rolled back safely');
  }
  if (/\bTRUNCATE\b/i.test(text)) {
    add(CODE.DESTRUCTIVE, ERROR, 'TRUNCATE removes all rows from a table');
  }
  if (/\bDELETE\s+FROM\b/i.test(text) && !/\bWHERE\b/i.test(text)) {
    add(CODE.DESTRUCTIVE, ERROR, 'DELETE without a WHERE clause removes every row');
  }
  if (/\bDROP\s+COLUMN\b/i.test(text)) {
    add(CODE.DATA_LOSS, WARNING, 'DROP COLUMN permanently removes column data');
  }
  if (/\bDROP\s+(INDEX|CONSTRAINT|VIEW|TYPE|SEQUENCE)\b/i.test(text)) {
    add(CODE.DATA_LOSS, WARNING, 'DROP INDEX/CONSTRAINT/VIEW/TYPE/SEQUENCE may break dependents');
  }

  return found;
}

/* -------------------------------------------------------------------------- */
/* TypeORM-style analysis                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Finds a method definition by name and returns its body plus the original
 * offsets. Uses the masked source so braces inside strings/comments are ignored.
 */
function extractMethodBody(src, masked, name) {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let match;
  while ((match = re.exec(masked))) {
    const before = masked[match.index - 1];
    if (before === '.' || /[\w$]/.test(before || '')) continue;

    const openParen = masked.indexOf('(', match.index);
    const closeParen = matchBrace(masked, openParen, '(', ')');
    if (closeParen === -1) continue;

    // Between `)` and `{` only a return type annotation may appear.
    const rest = masked.slice(closeParen + 1);
    const bridge = rest.match(/^\s*(?::[^{;]*)?\{/);
    if (!bridge) continue;

    const openBrace = closeParen + 1 + bridge[0].lastIndexOf('{');
    const closeBrace = matchBrace(masked, openBrace, '{', '}');
    if (closeBrace === -1) continue;

    return {
      body: src.slice(openBrace + 1, closeBrace),
      maskedBody: masked.slice(openBrace + 1, closeBrace),
      start: openBrace + 1,
      end: closeBrace,
    };
  }
  return null;
}

function matchBrace(src, openIndex, openCh, closeCh) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === openCh) depth += 1;
    else if (src[i] === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extracts SQL passed to `queryRunner.query('...')` (or `.manager.query`).
 * Expects a body with comments masked but string contents intact, so the SQL
 * text is recoverable without picking up commented-out code.
 */
function extractQueryStrings(commentMaskedBody) {
  const calls = [];
  const re = /\.query\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  let match;
  while ((match = re.exec(commentMaskedBody))) {
    calls.push({ sql: match[2], index: match.index });
  }
  return calls;
}

function analyzeTypeScript(content) {
  const findings = [];
  const starts = lineStartsOf(content);
  const masked = maskSource(content, 'js');
  const commentsMasked = maskSource(content, 'js', { keepStrings: true });
  const suppressed = hasSuppression(content);

  const add = (code, severity, message, index) => {
    findings.push({
      code,
      severity,
      message,
      line: lineAt(starts, index),
    });
  };

  const up = extractMethodBody(content, masked, 'up');
  const down = extractMethodBody(content, masked, 'down');

  // Destructive / data-loss checks run on the forward migration only; down()
  // is expected to drop what up() created.
  if (up) {
    const queryBody = commentsMasked.slice(up.start, up.end);
    for (const call of extractQueryStrings(queryBody)) {
      const sql = maskSource(call.sql, 'sql');
      if (!suppressed) {
        for (const finding of inspectSql(sql)) {
          add(finding.code, finding.severity, finding.message, up.start + call.index);
        }
      }
    }

    if (!suppressed) {
      const dropTable = /\bdropTable\s*\(/.exec(up.maskedBody);
      if (dropTable) {
        add(CODE.DESTRUCTIVE, ERROR, 'dropTable() destroys a table and its data', up.start + dropTable.index);
      }
      const dropColumn = /\bdropColumn\s*\(/.exec(up.maskedBody);
      if (dropColumn) {
        add(CODE.DATA_LOSS, WARNING, 'dropColumn() permanently removes column data', up.start + dropColumn.index);
      }
      const truncate = /\b(?:queryRunner\.)?(?:clearTable|truncate)\s*\(/.exec(up.maskedBody);
      if (truncate) {
        add(CODE.DESTRUCTIVE, ERROR, 'clearTable()/truncate() removes every row', up.start + truncate.index);
      }
    }
  }

  // Rollback checks.
  if (!down) {
    add(CODE.MISSING_ROLLBACK, ERROR, 'Migration has no down() method; it cannot be rolled back', 0);
  } else if (!stripForEmptiness(down.maskedBody).trim()) {
    add(CODE.EMPTY_ROLLBACK, ERROR, 'down() is empty; the migration cannot be rolled back', down.start);
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* SQL file analysis                                                          */
/* -------------------------------------------------------------------------- */

const DOWN_MARKER_RE = /^\s*--\s*\+?migrate\s+down\b/im;

function analyzeSqlFile(filePath, content) {
  const findings = [];
  const starts = lineStartsOf(content);
  const isDownFile = /\.down\.sql$/i.test(filePath);
  const isUpFile = /\.up\.sql$/i.test(filePath);
  const suppressed = hasSuppression(content);

  const add = (code, severity, message, index) => {
    findings.push({
      code,
      severity,
      message,
      line: lineAt(starts, index),
    });
  };

  // Rollback must exist for forward SQL migrations.
  if (isUpFile) {
    const downPath = filePath.replace(/\.up\.sql$/i, '.down.sql');
    const downExists =
      fs.existsSync(downPath) &&
      !!stripForEmptiness(fs.readFileSync(downPath, 'utf8')).trim();
    if (!downExists) {
      add(
        CODE.MISSING_ROLLBACK,
        ERROR,
        `Missing rollback file: ${path.basename(downPath)}`,
        0,
      );
    }
  } else if (!isDownFile) {
    const marker = DOWN_MARKER_RE.exec(content);
    if (!marker) {
      add(
        CODE.MISSING_ROLLBACK,
        ERROR,
        'No rollback found; add a "-- +migrate Down" section or a matching .down.sql file',
        0,
      );
    }
  }

  // Rollback files and down-sections are not forward migrations.
  if (isDownFile) return findings;

  const marker = DOWN_MARKER_RE.exec(content);
  const forward = marker ? content.slice(0, marker.index) : content;
  if (suppressed) return findings;

  for (const statement of splitSqlStatements(forward)) {
    for (const finding of inspectSql(statement.text)) {
      add(finding.code, finding.severity, finding.message, statement.start);
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Discovery and naming                                                       */
/* -------------------------------------------------------------------------- */

function findMigrationFiles(dir) {
  const files = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(sql|ts|js)$/i.test(entry.name)) continue;
      if (/\.(test|spec)\.[a-z]+$/i.test(entry.name)) continue;
      if (/\.d\.ts$/i.test(entry.name)) continue;
      files.push(full);
    }
  };
  walk(dir);
  return files.sort();
}

function checkName(filePath) {
  const base = path.basename(filePath);
  const isSql = /\.sql$/i.test(base);
  const withoutSuffix = base.replace(/\.(up|down)\.sql$/i, '.sql');
  const valid = (isSql ? SQL_NAME_RE : TS_NAME_RE).test(isSql ? withoutSuffix : base);

  if (valid) return null;
  return {
    code: CODE.INVALID_NAME,
    severity: ERROR,
    line: 1,
    message:
      'Migration names must be <10-14 digit timestamp>[-_]<kebab-or-snake-description>' +
      (isSql ? '[.up|.down].sql' : '.ts|.js') +
      ` (got "${base}")`,
  };
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

function validate({ paths: dirs, failOn = ERROR, json = false, quiet = false, cwd = process.cwd() }) {
  const findings = [];
  const scannedFiles = [];

  for (const dir of dirs) {
    const stat = fs.existsSync(dir) ? fs.statSync(dir) : null;
    if (!stat || !stat.isDirectory()) {
      throw new UsageError(`Not a directory: ${dir}`);
    }

    for (const filePath of findMigrationFiles(dir)) {
      scannedFiles.push(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const relative = path.relative(cwd, filePath) || filePath;

      const nameFinding = checkName(filePath);
      if (nameFinding) findings.push({ file: relative, ...nameFinding });

      const fileFindings = /\.sql$/i.test(filePath)
        ? analyzeSqlFile(filePath, content, scannedFiles)
        : analyzeTypeScript(content);

      for (const finding of fileFindings) {
        findings.push({ file: relative, ...finding });
      }
    }
  }

  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );

  const errors = findings.filter((f) => f.severity === ERROR).length;
  const warnings = findings.filter((f) => f.severity === WARNING).length;
  const blocking =
    failOn === 'never'
      ? false
      : failOn === WARNING
        ? errors + warnings > 0
        : errors > 0;

  const report = {
    path: dirs,
    filesScanned: scannedFiles.length,
    counts: { errors, warnings },
    findings,
    ok: errors === 0,
    exitCode: blocking ? 1 : 0,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!quiet) {
    process.stdout.write(formatReport(report));
  }

  return report;
}

function formatReport(report) {
  const lines = [];
  lines.push('Migration safety report');
  lines.push(`Path: ${report.path.join(', ')}`);
  lines.push(`Files scanned: ${report.filesScanned}`);
  lines.push(`Errors: ${report.counts.errors}  Warnings: ${report.counts.warnings}`);
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('No issues found.');
  } else {
    for (const finding of report.findings) {
      lines.push(
        `${finding.severity.toUpperCase().padEnd(7)} ${finding.code}  ${finding.file}:${finding.line}`,
      );
      lines.push(`        ${finding.message}`);
    }
  }

  lines.push('');
  lines.push(report.exitCode === 0 ? 'Result: PASSED' : 'Result: FAILED');
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.paths.length === 0) {
    process.stderr.write(`--path is required\n\n${USAGE}\n`);
    return 2;
  }

  try {
    const report = validate({
      paths: args.paths,
      failOn: args.failOn,
      json: args.json,
      quiet: args.quiet,
    });
    return report.exitCode;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  CODE,
  ERROR,
  WARNING,
  analyzeSqlFile,
  analyzeTypeScript,
  checkName,
  findMigrationFiles,
  main,
  maskSource,
  parseArgs,
  splitSqlStatements,
  validate,
};
