'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CODE,
  analyzeTypeScript,
  checkName,
  splitSqlStatements,
  validate,
} = require('./migration-validator');

const CLI = path.join(__dirname, 'migration-validator.js');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migration-validator-'));
}

function write(dir, name, content) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function scan(dir, options = {}) {
  return validate({ paths: [dir], quiet: true, ...options });
}

function codesOf(findings) {
  return findings.map((finding) => finding.code);
}

test('clean TypeORM migration passes', () => {
  const dir = makeDir();
  write(
    dir,
    '1700000000000-create-users-table.ts',
    `import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class CreateUsersTable1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({ name: 'users', columns: [{ name: 'id', type: 'uuid' }] }),
      true,
    );
    await queryRunner.query('CREATE INDEX IDX_USERS_EMAIL ON users (email)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('users');
  }
}
`,
  );

  const report = scan(dir);
  assert.deepEqual(report.findings, []);
  assert.equal(report.exitCode, 0);
  assert.equal(report.ok, true);
});

test('destructive and data-loss operations in up() are reported', () => {
  const dir = makeDir();
  write(
    dir,
    '1700000000001-remove-legacy-data.ts',
    `import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveLegacyData1700000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE legacy_events');
    await queryRunner.query('ALTER TABLE users DROP COLUMN nickname');
    await queryRunner.dropColumn('users', 'legacy_id');
    await queryRunner.query('TRUNCATE TABLE sessions');
    await queryRunner.query('DELETE FROM audit_log');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE TABLE legacy_events (id int)');
  }
}
`,
  );

  const report = scan(dir);
  assert.equal(report.counts.errors, 3); // DROP TABLE, TRUNCATE, DELETE
  assert.equal(report.counts.warnings, 2); // DROP COLUMN + dropColumn()
  assert.equal(report.exitCode, 1);

  for (const finding of report.findings) {
    assert.equal(finding.file, path.relative(process.cwd(), path.join(dir, '1700000000001-remove-legacy-data.ts')));
    assert.ok(finding.line > 1);
  }
});

test('destructive keywords in comments and strings do not trigger findings', () => {
  const dir = makeDir();
  write(
    dir,
    '1700000000002-add-status-column.ts',
    `import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStatusColumn1700000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // DROP TABLE users would be bad here
    await queryRunner.query("ALTER TABLE users ADD COLUMN status varchar DEFAULT 'DROP TABLE'");
    /* TRUNCATE TABLE users; */
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE users DROP COLUMN status');
  }
}
`,
  );

  const report = scan(dir);
  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    [],
  );
});

test('down() DROP TABLE is treated as rollback, not destruction', () => {
  const dir = makeDir();
  write(
    dir,
    '1700000000003-create-orders-table.ts',
    `export class CreateOrdersTable1700000000003 {
  async up(queryRunner) {
    await queryRunner.createTable({ name: 'orders' });
  }
  async down(queryRunner) {
    await queryRunner.dropTable('orders');
  }
}
`,
  );

  const report = scan(dir);
  assert.deepEqual(report.findings, []);
});

test('missing and empty down() are both reported', () => {
  const dir = makeDir();
  write(
    dir,
    '1700000000004-missing-down.ts',
    `export class MissingDown1700000000004 {
  async up(queryRunner) {
    await queryRunner.query('CREATE TABLE a (id int)');
  }
}
`,
  );
  write(
    dir,
    '1700000000005-empty-down.ts',
    `export class EmptyDown1700000000005 {
  async up(queryRunner) {
    await queryRunner.query('CREATE TABLE b (id int)');
  }
  async down(queryRunner) {
    // TODO
  }
}
`,
  );

  const report = scan(dir);
  assert.deepEqual(codesOf(report.findings), [
    CODE.MISSING_ROLLBACK,
    CODE.EMPTY_ROLLBACK,
  ]);
});

test('invalid migration file names are rejected', () => {
  assert.ok(checkName('backend/x/add-users-table.ts'));
  assert.ok(checkName('migrations/xxxx-create-achievements-table.ts'));
  assert.ok(checkName('migrations/1700000000000-AddUsers.ts'));
  assert.equal(checkName('migrations/1700000000000-add-users-table.ts'), null);
  assert.equal(checkName('migrations/1700000000000_add_users_table.js'), null);
  assert.equal(checkName('migrations/20240101120000_add-users.up.sql'), null);
});

test('standalone SQL needs a migrate-down marker', () => {
  const missing = makeDir();
  write(missing, '1700000000000-create-widgets.sql', 'CREATE TABLE widgets (id int);\n');
  const missingReport = scan(missing);
  assert.deepEqual(codesOf(missingReport.findings), [CODE.MISSING_ROLLBACK]);

  const paired = makeDir();
  write(
    paired,
    '1700000000000-create-widgets.sql',
    `-- +migrate Up
CREATE TABLE widgets (id int);

-- +migrate Down
DROP TABLE widgets;
`,
  );
  const pairedReport = scan(paired);
  assert.deepEqual(pairedReport.findings, []);
  assert.equal(pairedReport.exitCode, 0);
});

test('SQL destructive statements and DELETE without WHERE are errors', () => {
  const dir = makeDir();
  write(
    dir,
    '1700000000000-purge-data.sql',
    `-- +migrate Up
TRUNCATE TABLE sessions;
DELETE FROM audit_log;
DROP TABLE legacy;
ALTER TABLE users DROP COLUMN nickname;
DROP INDEX idx_users_email;

-- +migrate Down
SELECT 1;
`,
  );

  const report = scan(dir);
  assert.equal(report.counts.errors, 3);
  assert.equal(report.counts.warnings, 2);
  assert.equal(report.exitCode, 1);
});

test('.up.sql without .down.sql fails; with it passes', () => {
  const dir = makeDir();
  write(dir, '1700000000000-add-email-index.up.sql', 'CREATE INDEX idx ON users (email);\n');
  assert.deepEqual(codesOf(scan(dir).findings), [CODE.MISSING_ROLLBACK]);

  write(dir, '1700000000000-add-email-index.down.sql', 'DROP INDEX idx;\n');
  assert.deepEqual(scan(dir).findings, []);
});

test('allow-destructive suppresses intentional cleanup findings', () => {
  const dir = makeDir();
  write(
    dir,
    '1700000000000-drop-stale-tables.ts',
    `// migration-validator: allow-destructive -- stale tables removed on purpose
export class DropStaleTables1700000000000 {
  async up(queryRunner) {
    await queryRunner.query('DROP TABLE stale_a');
  }
  async down(queryRunner) {
    await queryRunner.query('CREATE TABLE stale_a (id int)');
  }
}
`,
  );

  assert.deepEqual(scan(dir).findings, []);
});

test('--fail-on warning makes warnings blocking, default does not', () => {
  const dir = makeDir();
  write(
    dir,
    '1700000000000-drop-column.ts',
    `export class DropColumn1700000000000 {
  async up(queryRunner) {
    await queryRunner.query('ALTER TABLE users DROP COLUMN nickname');
  }
  async down(queryRunner) {
    await queryRunner.query('ALTER TABLE users ADD COLUMN nickname text');
  }
}
`,
  );

  const defaultRun = scan(dir);
  assert.equal(defaultRun.counts.warnings, 1);
  assert.equal(defaultRun.exitCode, 0);

  const strictRun = scan(dir, { failOn: 'warning' });
  assert.equal(strictRun.exitCode, 1);

  const neverRun = scan(dir, { failOn: 'never' });
  assert.equal(neverRun.exitCode, 0);
});

test('CLI emits a JSON report and sets the exit status', () => {
  const dir = makeDir();
  write(
    dir,
    'bad-name.ts',
    `export class BadName1700000000000 {
  async up(queryRunner) {}
  async down(queryRunner) {}
}
`,
  );

  const result = runCli(['--path', dir, '--json']);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.filesScanned, 1);
  assert.equal(report.counts.errors, 2); // invalid name + empty down
  assert.ok(Array.isArray(report.findings));
  assert.equal(report.findings[0].file.endsWith('bad-name.ts'), true);
});

test('CLI reports usage errors with exit code 2', () => {
  assert.equal(runCli([]).code, 2);
  assert.equal(runCli(['--path', '/definitely/not/a/dir']).code, 2);
  assert.equal(runCli(['--bogus']).code, 2);
  assert.equal(runCli(['--path', '.', '--fail-on', 'sometimes']).code, 2);
});

test('SQL splitter ignores semicolons inside strings and comments', () => {
  const statements = splitSqlStatements(
    "INSERT INTO t VALUES ('a;b'); -- trailing; comment\n" +
      "/* block ; comment */ SELECT 1;",
  );
  assert.equal(statements.length, 2);
});
