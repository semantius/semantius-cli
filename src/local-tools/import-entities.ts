import { z } from 'zod';
import { defineLocalTool } from './types.js';

export default defineLocalTool({
  name: 'import_entities',
  description:
    'Import the entities of a transfer file (from export_entities or export_module) into the host (--host) as an upsert: entities and fields are created or updated by name, records are upserted by id and overwrite any target row with the same id. ' +
    'Every step reads the target first and writes only what differs, so a re-run resumes a failed import and a re-import of unchanged data writes nothing. ' +
    'From a module file only the entities are imported, and their module must exist on the host. ' +
    'Users are matched by external_id; an unknown one is an error. The target needs the fix_id_sequence RPC (0.5.0-beta1 databases lack it until rebuilt). ' +
    "Nothing is deleted, and there is no transaction across requests. Validation rules and select_rule are written before the records, so every record must pass today's rules: a failing row stops the import with the rule's error. " +
    "Rollup and computed columns are calculated by the target, never written from the file, and a rollup's child entity must be in the file or already on the target. " +
    'Records of an is_a or has_a entity are inserted when new and patched when changed, since the platform refuses an upsert on one; a subtype record is written at its own table, an extension after the base record it attaches to. ' +
    'With check, nothing is written: the records are checked against the catalog (tables, columns, ids, required fields, enum values, the records and users a reference names) and every problem is listed in one answer. The check does not evaluate validation rules. ' +
    'A file written by hand may name a record of an entity with a TypeID key <prefix>_sr<n> (cand_sr1), in its id and in the references to it: the import writes the TypeID <prefix>_0sr<n> padded with x to 26 characters.',
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe('Transfer file path (absolute or relative to cwd)'),
    check: z
      .boolean()
      .optional()
      .describe(
        'Check the records and write nothing: every problem is listed in one answer, and the call fails when there is one',
      ),
  },
  async handler(args, extra) {
    const { runTransfer, importTransfer } = await import('./transfer/index.js');
    return runTransfer(extra, (ctx) => importTransfer(ctx, args, 'entities'));
  },
});
