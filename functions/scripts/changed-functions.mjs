#!/usr/bin/env node
/**
 * Lists Cloud Functions affected by git changes under functions/.
 * Used by CI to deploy only updated or new functions (not the entire codebase).
 *
 * Usage:
 *   node functions/scripts/changed-functions.mjs --base HEAD~1
 *   node functions/scripts/changed-functions.mjs --base origin/main
 *
 * Output (stdout):
 *   skip=true                          — nothing under functions/ changed
 *   skip=false deploy_all=true         — shared deps changed; deploy entire codebase
 *   skip=false deploy_only=functions:a,functions:b,...
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(FUNCTIONS_DIR, 'index.js');
const LIB_DIR = path.join(FUNCTIONS_DIR, 'lib');

const DEPLOY_ALL_FILES = new Set([
  'functions/package.json',
  'functions/package-lock.json',
]);

const IGNORE_FILES = [
  /^functions\/scripts\//,
  /^functions\/\.env/,
];

function parseArgs() {
  const args = process.argv.slice(2);
  let base = 'HEAD~1';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--base' && args[i + 1]) {
      base = args[i + 1];
      i += 1;
    }
  }
  return { base };
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function gitRun(command) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitCommitExists(ref) {
  try {
    gitRun(`git rev-parse --verify ${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function ensureBaseAvailable(base) {
  if (gitCommitExists(base)) return base;
  try {
    gitRun(`git fetch --depth=1 origin ${base}`);
  } catch {
    // CI may not have network in some contexts; fall through to other strategies.
  }
  if (gitCommitExists(base)) return base;
  if (base !== 'HEAD~1' && gitCommitExists('HEAD~1')) return 'HEAD~1';
  return null;
}

function gitChangedFilesFromCommit() {
  try {
    const out = gitRun('git diff-tree --no-commit-id --name-only -r HEAD -- functions/');
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(normalizePath);
  } catch {
    return null;
  }
}

function gitChangedFiles(base) {
  const resolvedBase = ensureBaseAvailable(base);
  if (resolvedBase) {
    try {
      const out = gitRun(`git diff --name-only ${resolvedBase} HEAD -- functions/`);
      return {
        files: out.trim().split('\n').filter(Boolean).map(normalizePath),
        diffBase: resolvedBase,
      };
    } catch {
      // fall through
    }
  }

  const commitFiles = gitChangedFilesFromCommit();
  if (commitFiles !== null) {
    return { files: commitFiles, diffBase: 'HEAD' };
  }

  return null;
}

function gitChangedIndexLines(base, diffBase) {
  const resolvedBase = diffBase === 'HEAD'
    ? `${base}^`
    : (ensureBaseAvailable(base) ?? base);

  const diffCmd = diffBase === 'HEAD'
    ? 'git show -U0 HEAD -- functions/index.js'
    : `git diff -U0 ${resolvedBase} HEAD -- functions/index.js`;

  try {
    const out = gitRun(diffCmd);
    const lines = new Set();
    for (const hunk of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(hunk[1]);
      const count = Number(hunk[2] ?? '1');
      for (let line = start; line < start + count; line += 1) {
        lines.add(line);
      }
    }
    return lines;
  } catch {
    return null;
  }
}

function parseLibImports(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const deps = new Set();
  for (const match of content.matchAll(/from '\.\/([^']+\.js)'/g)) {
    deps.add(`lib/${match[1]}`);
  }
  return [...deps];
}

function buildLibGraph() {
  const graph = {};
  for (const file of readdirSync(LIB_DIR).filter(name => name.endsWith('.js'))) {
    graph[`lib/${file}`] = parseLibImports(path.join(LIB_DIR, file));
  }
  return graph;
}

/** If lib B changed, any lib that imports B (transitively) is also affected. */
function expandAffectedLibs(changedLibs, graph) {
  const affected = new Set(changedLibs);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [lib, deps] of Object.entries(graph)) {
      if (affected.has(lib)) continue;
      if (deps.some(dep => affected.has(dep))) {
        affected.add(lib);
        grew = true;
      }
    }
  }
  return affected;
}

function parseIndexImports(content) {
  /** @type {Record<string, string>} */
  const importMap = {};
  const importRe = /import\s+\{([^}]+)\}\s+from\s+'\.\/(lib\/[^']+)';/gs;
  for (const match of content.matchAll(importRe)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch) {
        importMap[asMatch[2]] = match[2];
      } else {
        importMap[trimmed.split(/\s+/)[0]] = match[2];
      }
    }
  }
  return importMap;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function parseIndexExports(content) {
  const importMap = parseIndexImports(content);
  const exports = [];
  const re = /export const (\w+) = /g;
  /** @type {{ name: string, start: number, end: number, body: string, startLine: number, endLine: number }[]} */
  const hits = [];
  let match = re.exec(content);
  while (match) {
    hits.push({ name: match[1], start: match.index });
    match = re.exec(content);
  }

  for (let i = 0; i < hits.length; i += 1) {
    const end = i + 1 < hits.length ? hits[i + 1].start : content.length;
    const body = content.slice(hits[i].start, end);
    const libsUsed = new Set();
    for (const [symbol, libPath] of Object.entries(importMap)) {
      if (new RegExp(`\\b${symbol}\\b`).test(body)) {
        libsUsed.add(libPath);
      }
    }
    exports.push({
      name: hits[i].name,
      start: hits[i].start,
      end,
      body,
      startLine: lineNumberAt(content, hits[i].start),
      endLine: lineNumberAt(content, end),
      libsUsed,
    });
  }
  return exports;
}

function functionsForLibChanges(affectedLibs, exports) {
  const names = new Set();
  for (const exp of exports) {
    for (const lib of exp.libsUsed) {
      if (affectedLibs.has(lib)) {
        names.add(exp.name);
      }
    }
  }
  return names;
}

function functionsForIndexChanges(changedLines, exports) {
  const names = new Set();
  if (!changedLines || changedLines.size === 0) return names;
  for (const exp of exports) {
    for (const line of changedLines) {
      if (line >= exp.startLine && line <= exp.endLine) {
        names.add(exp.name);
        break;
      }
    }
  }
  return names;
}

function main() {
  const { base } = parseArgs();
  const diffResult = gitChangedFiles(base);

  if (diffResult === null) {
    console.log('skip=true');
    console.log('reason=could not determine functions changes (skipping deploy)');
    return;
  }

  const { files: changedFiles, diffBase } = diffResult;

  const relevant = changedFiles.filter(file => !IGNORE_FILES.some(re => re.test(file)));
  if (relevant.length === 0) {
    console.log('skip=true');
    console.log('reason=no relevant functions changes');
    return;
  }

  if (relevant.some(file => DEPLOY_ALL_FILES.has(file))) {
    console.log('skip=false');
    console.log('deploy_all=true');
    console.log(`reason=shared dependency changed (${relevant.join(', ')})`);
    return;
  }

  const indexContent = readFileSync(INDEX_PATH, 'utf8');
  const exports = parseIndexExports(indexContent);
  const libGraph = buildLibGraph();

  const changedLibs = relevant
    .filter(file => file.startsWith('functions/lib/') && file.endsWith('.js'))
    .map(file => file.slice('functions/'.length));

  const indexChanged = relevant.includes('functions/index.js');
  const affectedLibs = expandAffectedLibs(new Set(changedLibs), libGraph);

  const names = new Set();

  if (changedLibs.length > 0) {
    for (const name of functionsForLibChanges(affectedLibs, exports)) {
      names.add(name);
    }
  }

  if (indexChanged) {
    const changedLines = gitChangedIndexLines(base, diffBase);
    if (changedLines === null || changedLines.size === 0) {
      console.log('skip=false');
      console.log('deploy_all=true');
      console.log('reason=functions/index.js changed (full redeploy)');
      return;
    }

    const indexOnlyNames = functionsForIndexChanges(changedLines, exports);
    if (indexOnlyNames.size === 0 && changedLibs.length === 0) {
      // Shared helpers at top of index.js (auth, filterCatalogItems, etc.) — all functions share that bundle entry.
      console.log('skip=false');
      console.log('deploy_all=true');
      console.log('reason=shared index.js code changed');
      return;
    }
    for (const name of indexOnlyNames) {
      names.add(name);
    }
  }

  if (names.size === 0) {
    console.log('skip=true');
    console.log('reason=no deployable function changes detected');
    return;
  }

  const deployOnly = [...names]
    .sort()
    .map(name => `functions:${name}`)
    .join(',');

  console.log('skip=false');
  console.log(`deploy_only=${deployOnly}`);
  console.log(`count=${names.size}`);
  console.log(`functions=${[...names].sort().join(',')}`);
}

main();
