/**
 * Tools command - the same output as `info`, without the intro.
 * The implementation is showTools.
 */

import { type ShowToolsOptions, showTools } from './show-tools.js';

export type ToolsOptions = Omit<ShowToolsOptions, 'intro'>;

export async function toolsCommand(options: ToolsOptions): Promise<void> {
  await showTools({ ...options, intro: false });
}
