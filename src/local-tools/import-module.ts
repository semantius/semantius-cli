import { z } from 'zod';
import { defineLocalTool } from './types.js';

export default defineLocalTool({
  name: 'import_module',
  description:
    'Import a module file (from export_module) into the host (--host) as an upsert: the module, its permissions, permission_hierarchy, roles and role_permissions (matched by name and slug; new grants are granted by the importing user), then its entities as import_entities does. ' +
    'Every step reads the target first and writes only what differs, so a re-run resumes a failed import and a re-import of unchanged data writes nothing. ' +
    'Records are upserted by id and overwrite any target row with the same id; users are matched by external_id. The target needs the fix_id_sequence RPC (0.5.0-beta1 databases lack it until rebuilt). ' +
    "Nothing is deleted, and there is no transaction across requests. Validation rules and select_rule are written before the records, so every record must pass today's rules: a failing row stops the import with the rule's error. " +
    "Rollup and computed columns are calculated by the target, never written from the file, and a rollup's child entity must be in the file or already on the target. " +
    'When two modules depend on each other through a rollup, neither can be restored first: import each, then import each again. The first pass stops with errors, 90262 at the rollup and a foreign key error at the records, and the re-runs complete it.',
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe('Module transfer file path (absolute or relative to cwd)'),
  },
  async handler(args, extra) {
    const { runTransfer, importTransfer } = await import('./transfer/index.js');
    return runTransfer(extra, (ctx) => importTransfer(ctx, args, 'module'));
  },
});
