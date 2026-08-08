import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineLocalTool } from './types.js';

export default defineLocalTool({
  name: 'file-date',
  description:
    'Return the last-modified date of a file as an ISO 8601 timestamp',
  inputSchema: {
    path: z.string().describe('File path (absolute or relative to cwd)'),
  },
  async handler({ path }) {
    const resolved = resolve(process.cwd(), path);
    try {
      const stats = await stat(resolved);
      // JSON-encoded (quoted) so the CLI's default output path, which
      // requires text content to parse as JSON, accepts it.
      return {
        content: [
          { type: 'text', text: JSON.stringify(stats.mtime.toISOString()) },
        ],
      };
    } catch {
      return {
        isError: true,
        content: [{ type: 'text', text: `File not found: ${resolved}` }],
      };
    }
  },
});
