import { z } from 'zod';
import { defineLocalTool } from './types.js';

export default defineLocalTool({
  name: 'export_module',
  description:
    'Export a module of the host (--host) into one JSON transfer file, for import_module on another host: the module, its permissions and permission_hierarchy, its roles and role_permissions (keyed by permission name and role slug, never by host id), then its entities with their fields and records, as export_entities writes them. ' +
    "The hierarchy rows that link the module to other modules' permissions are included; those permissions must exist where the file is imported. " +
    'The export contains only the rows this user can see, and is not a snapshot: writes during the export can make it inconsistent. ' +
    'Returns the path and, per entity, the number of fields and records written.',
  inputSchema: {
    name: z.string().min(1).describe('The module_name of the module to export'),
    exclude_data: z
      .boolean()
      .optional()
      .describe('Leave out the records: schema and access control only'),
    path: z
      .string()
      .min(1)
      .describe(
        'Output file path (absolute or relative to cwd); replaced if it exists',
      ),
  },
  async handler(args, extra) {
    const { runTransfer, exportModule } = await import('./transfer/index.js');
    return runTransfer(extra, (ctx) => exportModule(ctx, args));
  },
});
