#!/usr/bin/env node
// inject.mjs — reads data/linear-data.json, injects into dashboard-template.html → dashboard.html

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dir, '..');

const dataPath     = resolve(ROOT, 'data', 'linear-data.json');
const templatePath = resolve(ROOT, 'dashboard-template.html');
const outputPath   = resolve(ROOT, 'dashboard.html');

let data;
try {
  data = JSON.parse(readFileSync(dataPath, 'utf8'));
} catch {
  console.error('❌  data/linear-data.json not found — run: npm run fetch');
  process.exit(1);
}

let template;
try {
  template = readFileSync(templatePath, 'utf8');
} catch {
  console.error('❌  dashboard-template.html not found');
  process.exit(1);
}

const injected = template.replace(
  '// __LINEAR_DATA__',
  `window.__LINEAR_DATA__ = ${JSON.stringify(data)};`
);

writeFileSync(outputPath, injected);
console.log('✅  dashboard.html generated');
console.log(`    Data from: ${new Date(data.fetchedAt).toLocaleString()}`);
console.log(`    Issues: ${data.issues.length}  Projects: ${data.projects.length}`);
console.log('\nOpen dashboard.html in your browser — or run: npm run open\n');
