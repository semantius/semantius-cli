/**
 * Write order for an import: which table goes first, which columns wait for a
 * second pass, and how a self-referencing table meets rows whose parent comes
 * later.
 *
 * A foreign key needs its target row to exist, so a referenced table is
 * written before the tables that reference it. Tables that reference each
 * other in a cycle cannot all go first: pass 1 leaves one `reference` column
 * per cycle out, pass 2 writes it. Only `reference`, `date` and `date-time`
 * columns are nullable, so a `parent` column can never be the one left out,
 * and a cycle made only of parent columns could not have been filled on the
 * source either.
 */

import type { Row } from './format.js';

/** A reference/parent field between two tables of the import. */
export interface Reference {
  table: string;
  column: string;
  target: string;
  format: 'reference' | 'parent';
}

export interface WriteStep {
  table: string;
  pass: 1 | 2;
}

export interface WritePlan {
  steps: WriteStep[];
  /** Per table, the columns pass 1 leaves out and pass 2 writes. */
  deferred: Map<string, string[]>;
  /** Per table, its references to itself (see SelfReferences). */
  selfReferences: Map<string, Reference[]>;
}

/**
 * Plan the writes of `tables` (in the order given, which breaks ties) linked
 * by `references`. References to tables outside `tables` are ignored: their
 * targets already exist or the database's foreign keys say so.
 */
export function planWrites(
  tables: readonly string[],
  references: readonly Reference[],
): WritePlan {
  const rank = new Map(tables.map((t, i) => [t, i]));
  const byRank = (a: string, b: string) =>
    (rank.get(a) as number) - (rank.get(b) as number);
  const inside = references.filter(
    (r) => rank.has(r.table) && rank.has(r.target),
  );

  const selfReferences = new Map<string, Reference[]>();
  // from → to → the columns linking them
  const edges = new Map<string, Map<string, Reference[]>>();
  for (const table of tables) edges.set(table, new Map());
  for (const ref of inside) {
    if (ref.table === ref.target) {
      selfReferences.set(ref.table, [
        ...(selfReferences.get(ref.table) ?? []),
        ref,
      ]);
      continue;
    }
    const out = edges.get(ref.table) as Map<string, Reference[]>;
    out.set(ref.target, [...(out.get(ref.target) ?? []), ref]);
  }

  const steps: WriteStep[] = [];
  const deferred = new Map<string, string[]>();
  for (const component of stronglyConnected(tables, edges, byRank)) {
    if (component.length === 1) {
      steps.push({ table: component[0], pass: 1 });
      continue;
    }
    const order = breakCycles(component, edges, deferred, byRank);
    for (const table of order) steps.push({ table, pass: 1 });
    for (const table of order) {
      if (deferred.has(table)) steps.push({ table, pass: 2 });
    }
  }
  return { steps, deferred, selfReferences };
}

/**
 * Tarjan's strongly connected components, dependencies first: a component
 * comes out after every component it references.
 */
function stronglyConnected(
  tables: readonly string[],
  edges: Map<string, Map<string, Reference[]>>,
  byRank: (a: string, b: string) => number,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let next = 0;

  const visit = (table: string) => {
    index.set(table, next);
    low.set(table, next);
    next++;
    stack.push(table);
    onStack.add(table);
    const targets = [...(edges.get(table)?.keys() ?? [])].sort(byRank);
    for (const target of targets) {
      if (!index.has(target)) {
        visit(target);
        low.set(
          table,
          Math.min(low.get(table) as number, low.get(target) as number),
        );
      } else if (onStack.has(target)) {
        low.set(
          table,
          Math.min(low.get(table) as number, index.get(target) as number),
        );
      }
    }
    if (low.get(table) === index.get(table)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop() as string;
        onStack.delete(member);
        component.push(member);
        if (member === table) break;
      }
      out.push(component.sort(byRank));
    }
  };
  for (const table of tables) if (!index.has(table)) visit(table);
  return out;
}

/**
 * Remove one all-`reference` link per cycle inside `component`, recording
 * its columns in `deferred`, and return the component's tables in write
 * order.
 */
function breakCycles(
  component: string[],
  edges: Map<string, Map<string, Reference[]>>,
  deferred: Map<string, string[]>,
  byRank: (a: string, b: string) => number,
): string[] {
  const members = new Set(component);
  const live = new Map<string, Map<string, Reference[]>>();
  for (const table of component) {
    const out = new Map<string, Reference[]>();
    for (const [target, refs] of edges.get(table) ?? []) {
      if (members.has(target)) out.set(target, refs);
    }
    live.set(table, out);
  }

  for (;;) {
    const cycle = findCycle(component, live, byRank);
    if (!cycle) break;
    let broken = false;
    for (let i = 0; i < cycle.length; i++) {
      const from = cycle[i];
      const to = cycle[(i + 1) % cycle.length];
      const refs = live.get(from)?.get(to) ?? [];
      if (!refs.every((r) => r.format === 'reference')) continue;
      deferred.set(from, [
        ...(deferred.get(from) ?? []),
        ...refs.map((r) => r.column),
      ]);
      live.get(from)?.delete(to);
      broken = true;
      break;
    }
    if (!broken) {
      const links = cycle
        .map((from, i) => {
          const to = cycle[(i + 1) % cycle.length];
          const columns = (live.get(from)?.get(to) ?? []).map((r) => r.column);
          return `${from}.${columns.join('/')} → ${to}`;
        })
        .join(', ');
      throw new Error(
        `these tables reference each other only through parent columns, so none of their rows can be written first: ${links}`,
      );
    }
  }

  // Kahn over what is left: a table waits for the tables it references.
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < component.length) {
    const ready = component
      .filter(
        (t) =>
          !done.has(t) &&
          [...(live.get(t)?.keys() ?? [])].every((target) => done.has(target)),
      )
      .sort(byRank);
    // breakCycles left no cycle, so something is always ready.
    const table = ready[0];
    order.push(table);
    done.add(table);
  }
  return order;
}

/** A cycle among `nodes` as the list of its tables, or undefined. */
function findCycle(
  nodes: readonly string[],
  edges: Map<string, Map<string, Reference[]>>,
  byRank: (a: string, b: string) => number,
): string[] | undefined {
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (node: string): string[] | undefined => {
    state.set(node, 'open');
    path.push(node);
    for (const target of [...(edges.get(node)?.keys() ?? [])].sort(byRank)) {
      if (state.get(target) === 'open') {
        return path.slice(path.indexOf(target));
      }
      if (!state.has(target)) {
        const cycle = visit(target);
        if (cycle) return cycle;
      }
    }
    path.pop();
    state.set(node, 'done');
    return undefined;
  };
  for (const node of nodes) {
    if (state.has(node)) continue;
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

/**
 * The references of a self-referencing table, batch by batch.
 *
 * PostgreSQL checks a (non-deferrable) foreign key at the end of each
 * statement, so the rows of one batch may point at each other in any order,
 * cycles included. Only a changed row whose parent exists neither on the
 * target nor in its own batch needs care — its parent comes later in the file
 * (records are in id order), or is held back itself:
 *
 *   - through a `reference` column: the row is written with that column null,
 *     and `relink` asks for a second pass that writes the real value once
 *     every row exists;
 *   - through a `parent` column (NOT NULL): the row is held back and written
 *     after the table's last batch.
 *
 * Unchanged rows are never written, so a re-import of unchanged data sends
 * nothing, and nothing but the held rows (a `parent` pointing forward, which
 * is rare) stays in memory.
 */
export class SelfReferences {
  /** A reference column was written null: pass 2 must write the rows in full. */
  relink = false;
  private readonly held = new Map<string, Row>();
  private lastId: number | undefined;

  constructor(
    private readonly table: string,
    private readonly idColumn: string,
    private readonly references: readonly Reference[],
  ) {}

  get size(): number {
    return this.held.size;
  }

  /**
   * Check a batch (all its rows, in file order) and return its highest id.
   * Records must be in ascending id order: "later in the file" is "higher".
   */
  observe(rows: readonly Row[]): number {
    for (const row of rows) {
      const id = row[this.idColumn];
      if (typeof id !== 'number') {
        throw new Error(
          `${this.table}: record ${this.idColumn} ${JSON.stringify(id)} is not a number`,
        );
      }
      if (this.lastId !== undefined && id <= this.lastId) {
        throw new Error(
          `the records of ${this.table} are not in ascending ${this.idColumn} order (${id} after ${this.lastId}); export the table again`,
        );
      }
      this.lastId = id;
    }
    return this.lastId as number;
  }

  /**
   * The parents of `changed` that may not exist when the batch is written:
   * later in the file than the batch (`high`), or held back. The caller reads
   * which of them the target has.
   */
  unknownParents(changed: readonly Row[], high: number): unknown[] {
    const ids = new Set(changed.map((r) => String(r[this.idColumn])));
    const out = new Set<unknown>();
    for (const row of changed) {
      for (const ref of this.references) {
        const parent = row[ref.column];
        if (parent === null || parent === undefined) continue;
        if (ids.has(String(parent))) continue;
        if (
          (typeof parent === 'number' && parent > high) ||
          this.held.has(String(parent))
        ) {
          out.add(parent);
        }
      }
    }
    return [...out];
  }

  /**
   * The rows of a batch to write now, parent-first: rows with a missing
   * parent through a parent column are held back (and so are the rows below
   * them), reference columns to a missing parent are nulled.
   */
  split(
    changed: readonly Row[],
    high: number,
    onTarget: (id: unknown) => boolean,
  ): Row[] {
    const writing = new Map(changed.map((r) => [key(r[this.idColumn]), r]));
    const missing = (parent: unknown): boolean => {
      if (parent === null || parent === undefined) return false;
      if (writing.has(key(parent)) || onTarget(parent)) return false;
      return (
        (typeof parent === 'number' && parent > high) ||
        this.held.has(key(parent))
      );
    };
    const parents = this.references.filter((r) => r.format === 'parent');
    const below = this.children(changed, parents);

    // Hold the rows that miss a parent, then, breadth first, the rows below
    // them in the batch (unless the held row is on the target already).
    const queue: Row[] = [];
    const hold = (row: Row) => {
      const id = key(row[this.idColumn]);
      if (!writing.delete(id)) return;
      this.held.set(id, row);
      queue.push(row);
    };
    for (const row of changed) {
      if (parents.some((ref) => missing(row[ref.column]))) hold(row);
    }
    while (queue.length) {
      const row = queue.pop() as Row;
      if (onTarget(row[this.idColumn])) continue;
      for (const child of below.get(key(row[this.idColumn])) ?? []) hold(child);
    }

    const rows = [...writing.values()].map((row) => {
      let copy: Row | undefined;
      for (const ref of this.references) {
        if (ref.format !== 'reference' || !missing(row[ref.column])) continue;
        copy ??= { ...row };
        copy[ref.column] = null;
        this.relink = true;
      }
      return copy ?? row;
    });
    return this.parentFirst(rows);
  }

  /**
   * The held rows in write order, after the table's last batch, `chunk` rows
   * at a time and parent-first through the parent columns. Rows in a cycle of
   * parent columns (and the rows between such cycles) go in one statement;
   * the rows that merely wait below a cycle follow it in chunks. A reference
   * column pointing at a held row of a later chunk is nulled (and relinked).
   */
  drain(chunk: number): Row[][] {
    const rows = [...this.held.values()];
    this.held.clear();
    const byId = new Map(rows.map((r) => [key(r[this.idColumn]), r]));
    const parents = this.references.filter((r) => r.format === 'parent');
    const parentsOf = (row: Row): Row[] =>
      parents
        .map((ref) => row[ref.column])
        .filter(
          (p) => p !== null && p !== undefined && p !== row[this.idColumn],
        )
        .map((p) => byId.get(key(p)))
        .filter((p): p is Row => p !== undefined);

    // Kahn over the parent columns: the rows whose parents come first.
    const waiting = new Map(rows.map((r) => [r, parentsOf(r).length]));
    const below = this.children(rows, parents);
    const order = rows.filter((r) => waiting.get(r) === 0);
    for (let i = 0; i < order.length; i++) {
      for (const child of below.get(key(order[i][this.idColumn])) ?? []) {
        const left = (waiting.get(child) as number) - 1;
        waiting.set(child, left);
        if (left === 0) order.push(child);
      }
    }

    // What is left waits on a cycle. Peel off, bottom up, the rows no other
    // left row hangs below: they follow the cycle rather than join it.
    const left = rows.filter((r) => (waiting.get(r) as number) > 0);
    const hangers = new Map<Row, number>(left.map((r) => [r, 0]));
    for (const row of left) {
      for (const p of parentsOf(row)) {
        if (hangers.has(p)) hangers.set(p, (hangers.get(p) as number) + 1);
      }
    }
    const peeled: Row[] = [];
    const queue = left.filter((r) => hangers.get(r) === 0);
    while (queue.length) {
      const row = queue.pop() as Row;
      peeled.push(row);
      for (const p of parentsOf(row)) {
        if (!hangers.has(p)) continue;
        const count = (hangers.get(p) as number) - 1;
        hangers.set(p, count);
        if (count === 0) queue.push(p);
      }
    }
    const peeledSet = new Set(peeled);
    const core = left.filter((r) => !peeledSet.has(r));

    const chunks: Row[][] = [];
    const push = (list: Row[]) => {
      for (let i = 0; i < list.length; i += chunk) {
        chunks.push(list.slice(i, i + chunk));
      }
    };
    push(order);
    if (core.length) chunks.push(core);
    push(peeled.reverse());

    const chunkOf = new Map<string, number>();
    chunks.forEach((rowsOfChunk, i) => {
      for (const row of rowsOfChunk) chunkOf.set(key(row[this.idColumn]), i);
    });
    return chunks.map((rowsOfChunk, i) =>
      this.parentFirst(
        rowsOfChunk.map((row) => {
          let copy: Row | undefined;
          for (const ref of this.references) {
            if (ref.format !== 'reference') continue;
            const at = chunkOf.get(key(row[ref.column]));
            if (at === undefined || at <= i) continue;
            copy ??= { ...row };
            copy[ref.column] = null;
            this.relink = true;
          }
          return copy ?? row;
        }),
      ),
    );
  }

  /** Per row id, the rows that point at it through `references`. */
  private children(
    rows: readonly Row[],
    references: readonly Reference[],
  ): Map<string, Row[]> {
    const ids = new Set(rows.map((r) => key(r[this.idColumn])));
    const out = new Map<string, Row[]>();
    for (const row of rows) {
      for (const ref of references) {
        const parent = row[ref.column];
        if (parent === null || parent === undefined) continue;
        if (parent === row[this.idColumn] || !ids.has(key(parent))) continue;
        const list = out.get(key(parent)) ?? [];
        list.push(row);
        out.set(key(parent), list);
      }
    }
    return out;
  }

  /**
   * `rows` with each parent before the rows that point at it, where no cycle
   * prevents it (cycles keep file order). A foreign key does not need this —
   * it is checked at the end of the statement — but a BEFORE trigger does:
   * computed fields and validation rules that read the parent (set_record)
   * see the rows inserted earlier in the statement, never the later ones.
   */
  private parentFirst(rows: Row[]): Row[] {
    const below = this.children(rows, this.references);
    const waiting = new Map<Row, number>(rows.map((r) => [r, 0]));
    for (const children of below.values()) {
      for (const child of children) {
        waiting.set(child, (waiting.get(child) as number) + 1);
      }
    }
    const order = rows.filter((r) => waiting.get(r) === 0);
    for (let i = 0; i < order.length; i++) {
      for (const child of below.get(key(order[i][this.idColumn])) ?? []) {
        const count = (waiting.get(child) as number) - 1;
        waiting.set(child, count);
        if (count === 0) order.push(child);
      }
    }
    if (order.length === rows.length) return order;
    const placed = new Set(order);
    return [...order, ...rows.filter((r) => !placed.has(r))];
  }
}

const key = (id: unknown): string => String(id);
