import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeCaptureConfig(
  config: string,
  configFile: string,
  spec: string,
  outputPath: string,
) {
  await writeFile(
    config,
    `import base from ${JSON.stringify(pathToFileURL(configFile).href)};
import { captureConfig } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, 'config.ts')).href)};
export default captureConfig(base, ${JSON.stringify(configFile)}, ${JSON.stringify(spec)}, ${JSON.stringify(outputPath)});
`,
    { flag: 'wx' },
  );
}
