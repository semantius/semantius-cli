/**
 * permission-names.ts — the permission names a rule checks, and the nearest name to a misspelled one.
 * Shared by `module-rbac-setup.ts` and `call-file.ts`; not a CLI.
 */

/** Every permission a rule checks with `has_permission` or `require_permission`. */
export function checkedPermissions(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) checkedPermissions(v, out);
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if ((key === "has_permission" || key === "require_permission") && typeof v === "string") out.add(v);
      else checkedPermissions(v, out);
    }
  }
  return out;
}

/** The entry of `pool` nearest to `name` by edit distance, when it is at most 3 edits away. */
export function closest(name: string, pool: ReadonlyArray<string>): string | undefined {
  const distance = (a: string, b: string): number => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  };
  let best: string | undefined;
  let bestDistance = 4;
  for (const p of new Set(pool)) {
    const d = distance(name, p);
    if (d < bestDistance) [best, bestDistance] = [p, d];
  }
  return best;
}
