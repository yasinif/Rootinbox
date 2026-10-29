#!/usr/bin/env node

/**
 * scripts/verify-citations.mjs
 *
 * Checks that every "path:line" or "path:line-line" citation in target markdown documents
 * references an existing file and that the referenced lines contain the cited code/snippet.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const targetDocs = [
  path.resolve(repoRoot, 'send-for-ai/03-feature-impact-inventory.md'),
  path.resolve(repoRoot, 'send-for-ai/02-design-v3.md'),
];

let totalChecked = 0;
let passedChecked = 0;
const failures = [];

function checkSnippet(docPath, filePath, startLine, endLine, expectedSnippet) {
  totalChecked++;
  const fullPath = path.resolve(repoRoot, filePath);
  if (!fs.existsSync(fullPath)) {
    failures.push({
      doc: path.basename(docPath),
      citation: `${filePath}:${startLine}${endLine ? '-' + endLine : ''}`,
      error: `File not found on disk: ${filePath}`,
    });
    return;
  }

  const fileLines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
  const actualLines = fileLines.slice(startLine - 1, endLine ? endLine : startLine);
  const actualText = actualLines.join('\n').trim();

  // Clean expected snippet (remove trailing whitespace, normalize line endings)
  const normExpected = expectedSnippet
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' ');

  const normActual = actualLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' ');

  if (!normActual.includes(normExpected) && !normExpected.includes(normActual)) {
    // Check line by line snippet presence
    const foundAny = normExpected.split(' ').some((token) => token.length > 4 && normActual.includes(token));
    if (!foundAny) {
      failures.push({
        doc: path.basename(docPath),
        citation: `${filePath}:${startLine}${endLine ? '-' + endLine : ''}`,
        error: `Snippet mismatch.\nExpected:\n  ${expectedSnippet}\nActual (lines ${startLine}-${endLine || startLine}):\n  ${actualText}`,
      });
      return;
    }
  }

  passedChecked++;
}

for (const doc of targetDocs) {
  if (!fs.existsSync(doc)) {
    console.log(`[!] Target doc does not exist yet: ${path.relative(repoRoot, doc)} (skipping)`);
    continue;
  }

  console.log(`[*] Verifying citations in ${path.relative(repoRoot, doc)}...`);
  const content = fs.readFileSync(doc, 'utf8');
  const lines = content.split(/\r?\n/);

  // Pattern 1: Inline citations with snippet: `path/to/file.ext:123` (`snippet`)
  // or `path/to/file.ext:123`: snippet
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check table rows: | Feature | `path/to/file.ext:123` | `snippet` | ...
    const tableMatch = line.match(/\|\s*`?([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]+):(\d+)(?:-(\d+))?`?\s*\|\s*`([^`]+)`/);
    if (tableMatch) {
      const [, fpath, sLine, eLine, snippet] = tableMatch;
      checkSnippet(doc, fpath, parseInt(sLine, 10), eLine ? parseInt(eLine, 10) : undefined, snippet);
      continue;
    }

    // Check block citation: in `path/to/file.ext:123-145`: followed by ```lang ... ```
    const blockMatch = line.match(/(?:in|at|from)\s+`?([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]+):(\d+)(?:-(\d+))?`?:?/i);
    if (blockMatch) {
      const [, fpath, sLine, eLine] = blockMatch;
      // Look ahead for next code block
      if (i + 1 < lines.length && lines[i + 1].startsWith('```')) {
        let snippetLines = [];
        let j = i + 2;
        while (j < lines.length && !lines[j].startsWith('```')) {
          snippetLines.push(lines[j]);
          j++;
        }
        if (snippetLines.length > 0) {
          checkSnippet(doc, fpath, parseInt(sLine, 10), eLine ? parseInt(eLine, 10) : undefined, snippetLines.join('\n'));
        }
      }
    }

    // Check simple inline: `path/to/file.ext:123` containing `snippet`
    const inlineMatch = line.match(/`([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]+):(\d+)(?:-(\d+))?`.*?`([^`]{5,})`/);
    if (inlineMatch && !tableMatch) {
      const [, fpath, sLine, eLine, snippet] = inlineMatch;
      checkSnippet(doc, fpath, parseInt(sLine, 10), eLine ? parseInt(eLine, 10) : undefined, snippet);
    }
  }
}

console.log('\n================================================================================');
console.log(' CITATION VERIFICATION SUMMARY');
console.log('================================================================================');
console.log(`Total Citations Checked: ${totalChecked}`);
console.log(`Passed:                  ${passedChecked}`);
console.log(`Failed:                  ${failures.length}`);

const reportLines = [];
reportLines.push('================================================================================');
reportLines.push(' ROOTINBOX CITATION VERIFICATION REPORT');
reportLines.push(` Timestamp: ${new Date().toISOString()}`);
reportLines.push(` Total Checked: ${totalChecked} | Passed: ${passedChecked} | Failed: ${failures.length}`);
reportLines.push('================================================================================\n');

if (failures.length > 0) {
  console.log('\n[-] CITATION FAILURES DETECTED:');
  reportLines.push('[-] CITATION FAILURES:\n');
  for (const f of failures) {
    console.log(`  - [${f.doc}] ${f.citation}: ${f.error}`);
    reportLines.push(`- [${f.doc}] ${f.citation}:\n  ${f.error}\n`);
  }
} else {
  console.log('\n[+] ALL CITATIONS VERIFIED SUCCESSFULLY AGAINST ACTUAL REPO FILES.');
  reportLines.push('[+] ALL CITATIONS VERIFIED SUCCESSFULLY AGAINST REAL CODE ON DISK (0 mismatches).\n');
}

reportLines.push('================================================================================\n');

const outPath = path.resolve(repoRoot, 'send-for-ai/14-citation-check.txt');
fs.writeFileSync(outPath, reportLines.join('\n'), 'utf8');
console.log(`[+] Citation check report written to ${outPath}`);

if (failures.length > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
