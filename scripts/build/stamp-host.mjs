import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computeBuildId } from './identity.ts';

const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, 'dist/packages/protocol/src/build-id.js');
const digest = computeBuildId(root);
const code = await readFile(output, 'utf8');
const declaration = 'const __MITER_BUILD_ID__ = "' + digest + '";\n';
await writeFile(output, declaration + code.replace(/^const __MITER_BUILD_ID__ = "[a-f0-9]{16}";\n/, ''));
