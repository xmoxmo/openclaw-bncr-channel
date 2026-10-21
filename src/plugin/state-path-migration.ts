import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BNCR_STATE_FILE = 'bncr-bridge-state.json';
const BNCR_SQLITE_FILE = 'bncr.sqlite3';
const LEGACY_BACKUP_PATTERNS = [/^bncr-bridge-state\.pre-sqlite-.*\.json$/, /^bncr-state\.json$/];
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type BncrStatePaths = {
  stateDir: string;
  legacyStatePath: string;
  legacySqlitePath: string;
  pluginStateDir: string;
  statePath: string;
  sqlitePath: string;
  backupDir: string;
};

export type BncrStatePreparation = {
  paths: BncrStatePaths;
  copied: string[];
};

export function resolveBncrStatePaths(stateDir: string): BncrStatePaths {
  const pluginStateDir = path.join(stateDir, 'plugins', 'bncr');
  return {
    stateDir,
    legacyStatePath: path.join(stateDir, BNCR_STATE_FILE),
    legacySqlitePath: path.join(stateDir, BNCR_SQLITE_FILE),
    pluginStateDir,
    statePath: path.join(pluginStateDir, BNCR_STATE_FILE),
    sqlitePath: path.join(pluginStateDir, BNCR_SQLITE_FILE),
    backupDir: path.join(pluginStateDir, 'backups'),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function publishFileExclusive(temporary: string, destination: string): Promise<boolean> {
  try {
    await link(temporary, destination);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EXDEV' && code !== 'ENOTSUP') {
      throw error;
    }
  }

  try {
    await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function copyFileIfMissing(source: string, destination: string): Promise<boolean> {
  if (!(await pathExists(source)) || (await pathExists(destination))) return false;

  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, PRIVATE_FILE_MODE);
    return await publishFileExclusive(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function hardenFilePermissionsIfPresent(filePath: string): Promise<void> {
  if (await pathExists(filePath)) await chmod(filePath, PRIVATE_FILE_MODE);
}

function quoteSqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function validateSqliteCopy(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (row?.quick_check !== 'ok') {
      throw new Error(
        `bncr sqlite migration verification failed: ${row?.quick_check ?? 'unknown'}`,
      );
    }
  } finally {
    db.close();
  }
}

async function migrateSqliteIfMissing(source: string, destination: string): Promise<boolean> {
  if (!(await pathExists(source)) || (await pathExists(destination))) return false;

  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  const sourceDb = new DatabaseSync(source);
  try {
    sourceDb.exec('PRAGMA busy_timeout=5000');
    // VACUUM INTO reads a consistent snapshot, including committed rows in WAL.
    sourceDb.exec(`VACUUM INTO ${quoteSqliteString(temporary)}`);
  } finally {
    sourceDb.close();
  }

  try {
    await chmod(temporary, PRIVATE_FILE_MODE);
    await validateSqliteCopy(temporary);
    return await publishFileExclusive(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function prepareBncrStateDirectory(stateDir: string): Promise<BncrStatePreparation> {
  const paths = resolveBncrStatePaths(stateDir);
  await mkdir(paths.pluginStateDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(paths.pluginStateDir, PRIVATE_DIRECTORY_MODE);
  await mkdir(paths.backupDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(paths.backupDir, PRIVATE_DIRECTORY_MODE);

  const copied: string[] = [];
  if (await copyFileIfMissing(paths.legacyStatePath, paths.statePath)) {
    copied.push(paths.statePath);
  }
  if (await migrateSqliteIfMissing(paths.legacySqlitePath, paths.sqlitePath)) {
    copied.push(paths.sqlitePath);
  }

  const legacyEntries = await readdir(paths.stateDir, { withFileTypes: true });
  for (const entry of legacyEntries) {
    if (!entry.isFile() || !LEGACY_BACKUP_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      continue;
    }
    const source = path.join(paths.stateDir, entry.name);
    const destination = path.join(paths.backupDir, entry.name);
    if (await copyFileIfMissing(source, destination)) copied.push(destination);
    await hardenFilePermissionsIfPresent(destination);
  }

  await hardenFilePermissionsIfPresent(paths.statePath);
  await hardenFilePermissionsIfPresent(paths.sqlitePath);

  return { paths, copied };
}
