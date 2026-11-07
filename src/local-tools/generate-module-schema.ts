import { z } from 'zod';
import { version as VERSION } from '../../package.json' with { type: 'json' };
import { defineLocalTool } from './types.js';

export default defineLocalTool({
  name: 'generate_module_schema',
  description:
    'Write the JSON Schema (draft-07) of the transfer file that export_module / export_entities write and import_module / import_entities read: the module, permissions, permission_hierarchy, roles, role_permissions, then each entity with its fields and records, keyed by names and never by host ids. ' +
    "It is built from this CLI's own column lists and the vendored tool schemas, so it matches what this CLI writes and reads, and makes no request to any host (no login used). " +
    'Use it to write or check a transfer file by hand (an editor can take it through a "$schema" key at the top of the file). A record is only "an object": its columns are the entity\'s own fields. ' +
    'Returns the path written and its size.',
  inputSchema: {
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Output file path (absolute or relative to cwd); replaced if it exists. Default: semantius-transfer.schema.json in the current directory',
      ),
  },
  async handler({ path }) {
    // zod's converter and the vendored schemas stay out of the listTools path.
    const { writeTransferSchema, DEFAULT_SCHEMA_PATH } = await import(
      './transfer/schema.js'
    );
    try {
      const written = await writeTransferSchema(
        path ?? DEFAULT_SCHEMA_PATH,
        VERSION,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(written, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${message}` }],
      };
    }
  },
});
