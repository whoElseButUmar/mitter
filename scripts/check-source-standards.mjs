import path from 'node:path';
import { checkSourceStandards } from './source-standards.mjs';
import { errorMessage, isMainModule } from './helpers/runtime.mjs';

export async function reportSourceStandards(root) {
  const result = await checkSourceStandards(root);

  for (const violation of result.violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.message} [${violation.rule}]`);
  }

  if (result.violations.length > 0) {
    console.error(
      `Source standards failed: ${result.violations.length} violations in ${result.checked} files.`,
    );
    return false;
  }

  console.log(`Source standards passed: ${result.checked} files checked.`);
  return true;
}

if (isMainModule(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');

  try {
    const passed = await reportSourceStandards(root);

    if (!passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Could not check source standards: ' + errorMessage(error));
    process.exitCode = 1;
  }
}
