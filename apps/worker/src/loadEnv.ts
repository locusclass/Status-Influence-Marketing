import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDir, '..');
const repoRoot = path.resolve(appRoot, '..', '..');

const candidatePaths = [
  path.join(repoRoot, '.env'),
  path.join(appRoot, '.env'),
  path.join(repoRoot, 'apps', 'api', '.env'),
  path.join(process.cwd(), '.env'),
];

const seen = new Set<string>();
for (const candidate of candidatePaths) {
  const resolved = path.resolve(candidate);
  if (seen.has(resolved) || !fs.existsSync(resolved)) {
    continue;
  }
  seen.add(resolved);
  dotenv.config({ path: resolved, quiet: true });
}
