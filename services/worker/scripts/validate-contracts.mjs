import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readdir, readFile } from 'node:fs/promises';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

let validatedSchemas = 0;
for (const directory of ['events', 'db']) {
  const directoryPath = new URL(`../../../contracts/${directory}/`, import.meta.url);
  const entries = await readdir(directoryPath);
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const schemaPath = new URL(`../../../contracts/${directory}/${entry}`, import.meta.url);
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    const validate = ajv.compile(schema);

    for (const [index, example] of (schema.examples ?? []).entries()) {
      if (!validate(example)) {
        throw new Error(`${directory}/${entry} example ${index + 1} failed: ${ajv.errorsText(validate.errors)}`);
      }
    }

    for (const [index, example] of (schema.invalidExamples ?? []).entries()) {
      if (validate(example)) {
        throw new Error(`${directory}/${entry} invalid example ${index + 1} unexpectedly passed`);
      }
    }

    validatedSchemas += 1;
  }
}

if (validatedSchemas === 0) throw new Error('No contract schemas were found');
process.stdout.write(`Validated ${validatedSchemas} JSON contract schemas and their examples.\n`);
