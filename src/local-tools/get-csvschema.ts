import { z } from 'zod';
import { defineLocalTool } from './types.js';

export default defineLocalTool({
  name: 'get_csvschema',
  description:
    'Inspect a local CSV file and write its field schema to <file>.csvschema.json, returning the output path and the schema (id_mode, record_count, and one entry per column in fields)',
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe('CSV file path (absolute or relative to cwd)'),
    maxRecords: z
      .number()
      .int()
      .min(-1)
      .optional()
      .describe(
        'Data records to inspect; -1 (the default) reads the whole file',
      ),
  },
  async handler({ path, maxRecords }) {
    // Vendored csv-schema pulls in csv-parse, so keep it out of the listTools path.
    const { writeSchemaFile, toErrorJson } = await import('./csv-schema.js');
    try {
      // undefined outputPath keeps the library default: `${path}.csvschema.json`.
      const { outputPath, schema } = await writeSchemaFile(path, undefined, {
        maxRecords,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ outputPath, schema }, null, 2),
          },
        ],
      };
    } catch (error) {
      // The library never writes an output file when inspection fails, so an
      // error result leaves nothing behind on disk.
      return {
        isError: true,
        content: [
          { type: 'text', text: JSON.stringify(toErrorJson(error), null, 2) },
        ],
      };
    }
  },
});
