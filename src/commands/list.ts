/**
 * List command - List the servers and their tools (`semantius` without
 * arguments), with the intro. The implementation is showTools.
 */

import { type ShowToolsOptions, showTools } from './show-tools.js';

export type ListOptions = Omit<ShowToolsOptions, 'intro' | 'server' | 'tool'>;

export async function listCommand(options: ListOptions): Promise<void> {
  await showTools({ ...options, intro: true });
}
