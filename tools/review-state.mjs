#!/usr/bin/env node
// 复核状态指纹工具（对齐 bncr-dev WORKFLOW.md 第 5 节）
// 用法：
//   node tools/review-state.mjs check memory/<target>-review-state.json
//   node tools/review-state.mjs fingerprint memory/<target>-review-state.json

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(root, 'memory', 'review-index.json');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function normalizeRelativePath(input) {
  return path.relative(root, path.resolve(root, input)).split(path.sep).join('/');
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function computeScopeFingerprint(scopePaths) {
  const paths = [...new Set(scopePaths.map(normalizeRelativePath))].sort();
  const digest = createHash('sha256');
  for (const relativePath of paths) {
    const absolutePath = path.join(root, relativePath);
    digest.update(`${relativePath}\n`);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      digest.update('MISSING\n');
      continue;
    }
    digest.update(`${fileSha256(absolutePath)}\n`);
  }
  return digest.digest('hex');
}

function requireStatePath(input) {
  if (!input) throw new Error('state file path is required');
  const absolutePath = path.resolve(root, input);
  const expectedDirectory = path.join(root, 'memory');
  if (path.dirname(absolutePath) !== expectedDirectory) {
    throw new Error(`state file must be under memory/: ${input}`);
  }
  return absolutePath;
}

function inspectState(statePath) {
  const state = readJson(statePath);
  const index = readJson(indexPath);
  const relativeStatePath = normalizeRelativePath(statePath);
  const targetConfig = index.targets?.[relativeStatePath];
  const requiredFields = Array.isArray(index.state?.requiredFields) ? index.state.requiredFields : [];
  const extensions = Array.isArray(index.scope?.extensions) ? index.scope.extensions : ['.ts'];

  const errors = [];
  const missingFields = requiredFields.filter((field) => state[field] === undefined);
  if (state.schemaVersion !== index.state?.requiredSchemaVersion) {
    errors.push(`schemaVersion must be ${index.state?.requiredSchemaVersion}`);
  }
  if (missingFields.length > 0) errors.push(`missing fields: ${missingFields.join(', ')}`);
  if (!targetConfig) errors.push(`target is not registered in ${indexPath}`);
  if (targetConfig && state.target !== targetConfig.target) {
    errors.push(`target mismatch: state=${state.target} index=${targetConfig.target}`);
  }
  if (targetConfig && state.coverageProfile !== targetConfig.coverageProfile) {
    errors.push(
      `coverageProfile mismatch: state=${state.coverageProfile} index=${targetConfig.coverageProfile}`,
    );
  }

  const declaredPaths = Array.isArray(state.scopePaths) ? state.scopePaths : [];
  const configuredPaths = Array.isArray(targetConfig?.scopePaths) ? targetConfig.scopePaths : [];
  if (JSON.stringify([...declaredPaths].sort()) !== JSON.stringify([...configuredPaths].sort())) {
    errors.push('scopePaths do not match review-index target config');
  }

  const scopeRoots = Array.isArray(targetConfig?.scopeRoots) ? targetConfig.scopeRoots : [];
  const omitted = [];
  for (const scopeRoot of scopeRoots) {
    const absoluteRoot = path.resolve(root, scopeRoot);
    if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
      errors.push(`scope root is missing or not a directory: ${scopeRoot}`);
      continue;
    }
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absoluteEntry = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(absoluteEntry);
        } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
          const relativeEntry = normalizeRelativePath(absoluteEntry);
          if (!declaredPaths.includes(relativeEntry)) omitted.push(relativeEntry);
        }
      }
    };
    walk(absoluteRoot);
  }
  if (omitted.length > 0) errors.push(`scopePaths omit files under scopeRoots: ${omitted.sort().join(', ')}`);

  const currentFingerprint = computeScopeFingerprint(declaredPaths);
  const fingerprintMatches = state.scopeFingerprint === currentFingerprint;
  if (!fingerprintMatches) {
    errors.push(`scopeFingerprint mismatch: state=${state.scopeFingerprint} current=${currentFingerprint}`);
  }

  const targetPath = path.join(root, targetConfig?.target || state.target || '');
  const currentSourceSha256 =
    existsSync(targetPath) && statSync(targetPath).isFile() ? fileSha256(targetPath) : null;
  const sourceMatches = state.sourceSha256 === currentSourceSha256;
  if (!sourceMatches) {
    errors.push(`sourceSha256 mismatch: state=${state.sourceSha256} current=${currentSourceSha256}`);
  }

  return {
    statePath: relativeStatePath,
    target: state.target,
    coverageProfile: state.coverageProfile,
    status: state.status,
    consecutiveNoLeakRounds: state.consecutiveNoLeakRounds,
    scopeFingerprint: { declared: state.scopeFingerprint, current: currentFingerprint, matches: fingerprintMatches },
    sourceSha256: { declared: state.sourceSha256, current: currentSourceSha256, matches: sourceMatches },
    errors,
  };
}

function usage() {
  console.error('usage: node tools/review-state.mjs <check|fingerprint> <state-file...>');
  console.error('example: node tools/review-state.mjs check memory/stale-scenes-review-state.json');
}

const [command, ...inputs] = process.argv.slice(2);
if (!['check', 'fingerprint'].includes(command) || inputs.length === 0) {
  usage();
  process.exit(1);
}

let failed = false;
for (const input of inputs) {
  try {
    const result = inspectState(requireStatePath(input));
    if (command === 'fingerprint') {
      console.log(JSON.stringify(result, null, 2));
      continue;
    }
    if (result.errors.length > 0) {
      failed = true;
      console.error(`${result.statePath}: FAIL`);
      for (const error of result.errors) console.error(`- ${error}`);
      continue;
    }
    console.log(
      `${result.statePath}: OK profile=${result.coverageProfile} status=${result.status} rounds=${result.consecutiveNoLeakRounds}`,
    );
  } catch (error) {
    failed = true;
    console.error(`${input}: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(failed ? 2 : 0);

