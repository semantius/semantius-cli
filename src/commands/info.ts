/**
 * Info command - Show server or tool details, with the intro.
 * The implementation is showTools; `tools` is the same call without the intro.
 */

import { type ShowToolsOptions, showTools } from './show-tools.js';

export type InfoOptions = Omit<ShowToolsOptions, 'intro'>;

export async function infoCommand(options: InfoOptions): Promise<void> {
  await showTools({ ...options, intro: true });
}
