import { z } from 'zod';
import { defineLocalTool } from './types.js';

export default defineLocalTool({
  name: 'import_entities',
  description:
    'Import the entities of a transfer file (from export_entities or export_module) into the host (--host) as an upsert: entities and fields are created or updated by name, records are upserted by id and overwrite any target row with the same id. ' +
    'Every step reads the target first and writes only what differs, so a re-run resumes a failed import and a re-import of unchanged data writes nothing. ' +
    'From a module file only the entities are imported, and their module must exist on the host. ' +
    'Users are matched by external_id; an unknown one is an error. The target needs the fix_id_sequence RPC (0.5.0-beta1 databases lack it until rebuilt). ' +
    "Nothing is deleted, and there is no transaction across requests. Validation rules and select_rule are written before the records, so every record must pass today's rules: a failing row stops the import with the rule's error.",
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe('Transfer file path (absolute or relative to cwd)'),
  },
  async handler(args, extra) {
    const { runTransfer, importTransfer } = await import('./transfer/index.js');
    return runTransfer(extra, (ctx) => importTransfer(ctx, args, 'entities'));
  },
});
