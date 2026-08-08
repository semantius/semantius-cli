import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineLocalTool } from './types.js';

export default defineLocalTool({
  name: 'file-size',
  description: 'Return the size of a file in bytes',
  inputSchema: {
    path: z.string().describe('File path (absolute or relative to cwd)'),
  },
  async handler({ path }) {
    const resolved = resolve(process.cwd(), path);
    try {
      const stats = await stat(resolved);
      return { content: [{ type: 'text', text: String(stats.size) }] };
    } catch {
      return {
        isError: true,
        content: [{ type: 'text', text: `File not found: ${resolved}` }],
      };
    }
  },
});
