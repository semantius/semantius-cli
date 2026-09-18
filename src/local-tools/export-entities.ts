import { z } from 'zod';
import { defineLocalTool } from './types.js';

export default defineLocalTool({
  name: 'export_entities',
  description:
    'Export entities of the host (--host) into one JSON transfer file: their schema (entity and fields, keyed by name) and all their records, for import_entities on another host. ' +
    'Records keep their ids; references to users are written as {"external_id": …}, references to other tables keep their ids. ' +
    'Metadata and system tables (modules, entities, fields, permissions, roles, users, …) are refused. ' +
    'The export contains only the rows this user can see, and is not a snapshot: writes during the export can make it inconsistent. ' +
    'Returns the path and, per entity, the number of fields and records written.',
  inputSchema: {
    names: z
      .string()
      .min(1)
      .describe(
        'Table names to export, comma-separated (e.g. "accounts,contacts")',
      ),
    exclude_schema: z
      .boolean()
      .optional()
      .describe('Leave out the entity and field definitions: records only'),
    exclude_data: z
      .boolean()
      .optional()
      .describe('Leave out the records: schema only'),
    path: z
      .string()
      .min(1)
      .describe(
        'Output file path (absolute or relative to cwd); replaced if it exists',
      ),
  },
  async handler(args, extra) {
    const { runTransfer, exportEntities } = await import('./transfer/index.js');
    return runTransfer(extra, (ctx) => exportEntities(ctx, args));
  },
});
