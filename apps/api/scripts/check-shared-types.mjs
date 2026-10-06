import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Use the real API compiler configuration and full program graph. New shared
// modules must resolve to the built declarations, never outside API rootDir.
// This is a boundary check; unrelated legacy type errors are not declared clean.
const apiDir = fileURLToPath(new URL('../', import.meta.url));
const configFile = ts.readConfigFile(path.join(apiDir, 'tsconfig.json'), ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, apiDir);
if (configFile.error || config.errors.length) {
  throw new Error('Unable to read the API TypeScript configuration');
}
const program = ts.createProgram(config.fileNames, config.options);
const sharedDir = path.resolve(apiDir, '../../packages/shared');
const shared = program.getSourceFiles().filter((file) => {
  const relative = path.relative(sharedDir, file.fileName);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
});
if (!shared.length || shared.some((file) => !file.isDeclarationFile)) {
  throw new Error(
    'API shared types must resolve to built declarations. Run build:packages and check API paths.'
  );
}
console.log(
  `API shared declaration boundary: ${shared.length} declarations, zero shared source files`
);
