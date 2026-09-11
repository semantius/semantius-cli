import { join } from 'node:path';
import { existsSync } from 'node:fs';
const daemonScript = join(import.meta.dir, 'daemon.ts');
console.log('import.meta.dir      =', import.meta.dir);
console.log('daemonScript         =', daemonScript);
console.log('exists on disk       =', existsSync(daemonScript));
console.log('bun on PATH          =', Bun.which('bun'));
try {
  const proc = Bun.spawn({ cmd: ['bun', 'run', daemonScript, '--daemon', 'crud', '{}'], stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  console.log('spawn exit code      =', code);
  console.log('spawn stderr         =', (await new Response(proc.stderr).text()).trim().slice(0, 300));
} catch (e) {
  console.log('spawn threw          =', (e as Error).message);
}
