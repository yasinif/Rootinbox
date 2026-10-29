import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.resolve('send-for-ai');
const manifestPath = path.join(dir, 'MANIFEST.sha256');

if (!fs.existsSync(manifestPath)) {
  console.error(`[-] ERROR: Manifest not found at ${manifestPath}`);
  process.exit(1);
}

const lines = fs.readFileSync(manifestPath, 'utf-8').split(/\r?\n/).filter(Boolean);
let passed = 0;
let failed = 0;

console.log(`Verifying ${lines.length} files in ${dir}...`);

for (const line of lines) {
  const [expectedHash, filename] = line.trim().split(/\s+/);
  const filePath = path.join(dir, filename);

  if (!fs.existsSync(filePath)) {
    console.error(`[-] MISSING FILE: ${filename}`);
    failed++;
    continue;
  }

  const content = fs.readFileSync(filePath);
  const size = content.length;

  if (size > 400 * 1024) {
    console.error(`[-] RULE O1 VIOLATION: ${filename} is ${size} bytes (> 400 KB)`);
    failed++;
  }

  const actualHash = crypto.createHash('sha256').update(content).digest('hex');
  if (actualHash !== expectedHash) {
    console.error(`[-] HASH MISMATCH for ${filename}: expected ${expectedHash}, got ${actualHash}`);
    failed++;
  } else {
    console.log(`[+] OK (${(size / 1024).toFixed(1)} KB): ${filename}`);
    passed++;
  }
}

console.log('--------------------------------------------------');
if (failed > 0) {
  console.error(`[-] BUNDLE VERIFICATION FAILED: ${failed} errors, ${passed} passed.`);
  process.exit(1);
} else {
  console.log(`[+] ALL ${passed} FILES VERIFIED SUCCESSFULLY WITH 100% CHECKSUM MATCH!`);
  process.exit(0);
}
