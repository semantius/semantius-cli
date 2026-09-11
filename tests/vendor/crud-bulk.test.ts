import { test } from 'bun:test';
/**
 * Tests for bulk (array) support in the typed CRUD tools
 * Run with: deno test --allow-env tests/crud-bulk.test.ts
 *
 * No network access is needed: globalThis.fetch is stubbed so the tests assert on the
 * exact PostgREST request (URL, method, headers, body) each tool handler produces.
 */

import { assert, assertEquals, assertStringIncludes } from "./deno-assert.ts";
import { z } from "zod/v4";
import type { RequestContext, Tool } from "../../src/vendor/postgrest-mcp/types.ts";
import { bulkInsertOptions, keyFilter, oneOrMany } from "../../src/vendor/postgrest-mcp/src/utils/bulk.ts";
import { createEntityTool } from "../../src/vendor/postgrest-mcp/src/tools/create_entity.ts";
import { createFieldTool } from "../../src/vendor/postgrest-mcp/src/tools/create_field.ts";
import { createModuleTool } from "../../src/vendor/postgrest-mcp/src/tools/create_module.ts";
import { createPermissionTool } from "../../src/vendor/postgrest-mcp/src/tools/create_permission.ts";
import { createPermissionHierarchyTool } from "../../src/vendor/postgrest-mcp/src/tools/create_permission_hierarchy.ts";
import { createRoleTool } from "../../src/vendor/postgrest-mcp/src/tools/create_role.ts";
import { createRolePermissionTool } from "../../src/vendor/postgrest-mcp/src/tools/create_role_permission.ts";
import { createUserTool } from "../../src/vendor/postgrest-mcp/src/tools/create_user.ts";
import { createUserRoleTool } from "../../src/vendor/postgrest-mcp/src/tools/create_user_role.ts";
import { createWebhookReceiverTool } from "../../src/vendor/postgrest-mcp/src/tools/create_webhook_receiver.ts";
import { createWebhookReceiverLogTool } from "../../src/vendor/postgrest-mcp/src/tools/create_webhook_receiver_log.ts";
import { updateEntityTool } from "../../src/vendor/postgrest-mcp/src/tools/update_entity.ts";
import { updateFieldTool } from "../../src/vendor/postgrest-mcp/src/tools/update_field.ts";
import { updateModuleTool } from "../../src/vendor/postgrest-mcp/src/tools/update_module.ts";
import { updatePermissionTool } from "../../src/vendor/postgrest-mcp/src/tools/update_permission.ts";
import { updatePermissionHierarchyTool } from "../../src/vendor/postgrest-mcp/src/tools/update_permission_hierarchy.ts";
import { updateRoleTool } from "../../src/vendor/postgrest-mcp/src/tools/update_role.ts";
import { updateRolePermissionTool } from "../../src/vendor/postgrest-mcp/src/tools/update_role_permission.ts";
import { updateUserTool } from "../../src/vendor/postgrest-mcp/src/tools/update_user.ts";
import { updateUserRoleTool } from "../../src/vendor/postgrest-mcp/src/tools/update_user_role.ts";
import { updateWebhookReceiverTool } from "../../src/vendor/postgrest-mcp/src/tools/update_webhook_receiver.ts";
import { updateWebhookReceiverLogTool } from "../../src/vendor/postgrest-mcp/src/tools/update_webhook_receiver_log.ts";
import { deleteEntityTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_entity.ts";
import { deleteFieldTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_field.ts";
import { deleteModuleTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_module.ts";
import { deletePermissionTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_permission.ts";
import { deletePermissionHierarchyTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_permission_hierarchy.ts";
import { deleteRoleTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_role.ts";
import { deleteRolePermissionTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_role_permission.ts";
import { deleteUserTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_user.ts";
import { deleteUserRoleTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_user_role.ts";
import { deleteWebhookReceiverTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_webhook_receiver.ts";
import { deleteWebhookReceiverLogTool } from "../../src/vendor/postgrest-mcp/src/tools/delete_webhook_receiver_log.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Replaces globalThis.fetch for the duration of `fn`, recording every call and answering
 * with the given status/body. Restores the original fetch afterwards.
 */
async function withFetchStub<T>(
  reply: { status?: number; body?: unknown },
  fn: (calls: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | Request | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(reply.body ?? []), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Minimal request context. host=localhost short-circuits resetSchemaCache before any DB access. */
const ctx: RequestContext = {
  authInfo: { token: "tok", apiBaseUrl: "http://pg.test/rest/v1" },
  request: { method: "POST", url: "http://localhost/mcp", headers: { host: "localhost" }, query: {} },
};

function parseText(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// keyFilter
// ---------------------------------------------------------------------------

test("keyFilter: scalar keeps eq. form (numeric and string)", () => {
  assertEquals(keyFilter("id", 5), "id=eq.5");
  assertEquals(keyFilter("id", "abc"), "id=eq.abc");
  assertEquals(keyFilter("table_name", "users"), "table_name=eq.users");
});

test("keyFilter: arrays use in.() with PostgREST quoting", () => {
  assertEquals(keyFilter("id", [1, 2]), "id=in.(1,2)");
  assertEquals(keyFilter("id", ["a"]), "id=in.(a)");
  assertEquals(keyFilter("id", ["a,b", "c"]), 'id=in.("a,b",c)');
  assertEquals(keyFilter("id", ['x"y']), 'id=in.("x\\"y")');
  assertEquals(keyFilter("id", ["has space"]), 'id=in.("has space")');
  assertEquals(keyFilter("id", ["orders.customer_id"]), "id=in.(orders.customer_id)");
});

test("keyFilter: quoted values survive URL construction", () => {
  const filter = keyFilter("id", ["a,b", "c(d)", 'x"y']);
  const url = new URL(`http://pg.test/rest/v1/fields?${filter}`);
  assertEquals(decodeURIComponent(url.search), `?${filter}`);
});

// ---------------------------------------------------------------------------
// bulkInsertOptions
// ---------------------------------------------------------------------------

test("bulkInsertOptions: single object leaves path and headers unchanged", () => {
  assertEquals(bulkInsertOptions("/fields", { a: 1 }), { path: "/fields", additionalHeaders: undefined });
  assertEquals(bulkInsertOptions("/fields", { a: 1 }, "text/csv"), {
    path: "/fields",
    additionalHeaders: { accept: "text/csv" },
  });
});

test("bulkInsertOptions: array adds columns union (first-seen order) and missing=default", () => {
  const opts = bulkInsertOptions("/fields", [
    { table_name: "t", field_name: "a", title: "A", description: "d" },
    { table_name: "t", field_name: "b", title: "B", format: "number", searchable: undefined },
  ]);
  assertEquals(opts.path, "/fields?columns=table_name,field_name,title,description,format");
  assertEquals(opts.additionalHeaders, { prefer: "return=representation,missing=default" });
});

test("bulkInsertOptions: array merges accept and omits columns when no keys", () => {
  const withAccept = bulkInsertOptions("/roles", [{ name: "x" }], "application/json");
  assertEquals(withAccept.additionalHeaders, {
    prefer: "return=representation,missing=default",
    accept: "application/json",
  });
  const empty = bulkInsertOptions("/roles", [{}]);
  assertEquals(empty.path, "/roles");
});

test("bulkInsertOptions: column names needing quotes are quoted", () => {
  const opts = bulkInsertOptions("/t", [{ "we ird": 1 }]);
  assertEquals(opts.path, '/t?columns="we ird"');
});

// ---------------------------------------------------------------------------
// oneOrMany
// ---------------------------------------------------------------------------

test("oneOrMany: accepts scalar and non-empty array, rejects empty array", () => {
  const schema = oneOrMany(z.number().int());
  assertEquals(schema.safeParse(1).success, true);
  assertEquals(schema.safeParse([1, 2]).success, true);
  assertEquals(schema.safeParse([]).success, false);
  assertEquals(schema.safeParse(["a"]).success, false);
});

// ---------------------------------------------------------------------------
// create_* handler
// ---------------------------------------------------------------------------

test("create_field: single object request is unchanged (no columns, default prefer)", async () => {
  const row = { table_name: "services", field_name: "cost", title: "Cost", format: "number" } as const;
  await withFetchStub({ status: 201, body: [{ id: "services.cost", ...row }] }, async (calls) => {
    const result = await createFieldTool.handler({ data: row, accept: undefined }, ctx);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "http://pg.test/rest/v1/fields");
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].headers["prefer"], "return=representation");
    assertEquals(calls[0].headers["authorization"], "Bearer tok");
    assertEquals(calls[0].body, row);
    assertEquals(result.isError, undefined);
    assertEquals(parseText(result), [{ id: "services.cost", ...row }]);
  });
});

test("create_field: array of heterogeneous objects is one bulk POST", async () => {
  const rows = [
    { table_name: "services", field_name: "description", title: "Description", format: "text" as const, searchable: true },
    { table_name: "services", field_name: "cost", title: "Cost", format: "number" as const },
  ];
  const created = rows.map((r) => ({ id: `${r.table_name}.${r.field_name}`, ...r }));
  await withFetchStub({ status: 201, body: created }, async (calls) => {
    const result = await createFieldTool.handler({ data: rows, accept: undefined }, ctx);
    assertEquals(calls.length, 1);
    assertEquals(
      calls[0].url,
      "http://pg.test/rest/v1/fields?columns=table_name,field_name,title,format,searchable",
    );
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].headers["prefer"], "return=representation,missing=default");
    assertEquals(calls[0].body, rows);
    assertEquals(parseText(result), created);
  });
});

test("create_field: accept header is forwarded alongside bulk prefer", async () => {
  await withFetchStub({ status: 201, body: [] }, async (calls) => {
    await createFieldTool.handler(
      { data: [{ table_name: "t", field_name: "a", title: "A" }], accept: "application/json" },
      ctx,
    );
    assertEquals(calls[0].headers["accept"], "application/json");
    assertEquals(calls[0].headers["prefer"], "return=representation,missing=default");
  });
});

// ---------------------------------------------------------------------------
// update_* handler
// ---------------------------------------------------------------------------

test("update_field: scalar id keeps eq. path", async () => {
  await withFetchStub({ body: [{ id: "services.cost", title: "Price" }] }, async (calls) => {
    await updateFieldTool.handler({ id: "services.cost", data: { title: "Price" }, accept: undefined }, ctx);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "http://pg.test/rest/v1/fields?id=eq.services.cost");
    assertEquals(calls[0].method, "PATCH");
    assertEquals(calls[0].body, { title: "Price" });
  });
});

test("update_field: array of ids becomes one PATCH with in.() and the same body", async () => {
  await withFetchStub({ body: [] }, async (calls) => {
    await updateFieldTool.handler(
      { id: ["services.cost", "services.description"], data: { width: "m" }, accept: undefined },
      ctx,
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "http://pg.test/rest/v1/fields?id=in.(services.cost,services.description)");
    assertEquals(calls[0].method, "PATCH");
    assertEquals(calls[0].headers["prefer"], "return=representation");
    assertEquals(calls[0].body, { width: "m" });
  });
});

test("update_role: numeric id array", async () => {
  await withFetchStub({ body: [] }, async (calls) => {
    await updateRoleTool.handler({ id: [1, 2, 3], data: { description: "x" }, accept: undefined }, ctx);
    assertEquals(calls[0].url, "http://pg.test/rest/v1/roles?id=in.(1,2,3)");
    assertEquals(calls[0].method, "PATCH");
  });
});

test("update_entity: table_name array", async () => {
  await withFetchStub({ body: [] }, async (calls) => {
    await updateEntityTool.handler(
      { table_name: ["orders", "order_lines"], data: { view_permission: "sales:read" }, accept: undefined },
      ctx,
    );
    assertEquals(calls[0].url, "http://pg.test/rest/v1/entities?table_name=in.(orders,order_lines)");
    assertEquals(calls[0].method, "PATCH");
  });
});

// ---------------------------------------------------------------------------
// delete_* handler
// ---------------------------------------------------------------------------

test("delete_field: scalar id keeps eq. path", async () => {
  await withFetchStub({ body: [{ id: "services.cost" }] }, async (calls) => {
    await deleteFieldTool.handler({ id: "services.cost", accept: undefined }, ctx);
    assertEquals(calls[0].url, "http://pg.test/rest/v1/fields?id=eq.services.cost");
    assertEquals(calls[0].method, "DELETE");
    assertEquals(calls[0].body, undefined);
  });
});

test("delete_role: numeric id array becomes one DELETE with in.()", async () => {
  await withFetchStub({ body: [{ id: 1 }, { id: 2 }] }, async (calls) => {
    const result = await deleteRoleTool.handler({ id: [1, 2], accept: undefined }, ctx);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "http://pg.test/rest/v1/roles?id=in.(1,2)");
    assertEquals(calls[0].method, "DELETE");
    assertEquals(parseText(result), [{ id: 1 }, { id: 2 }]);
  });
});

test("delete_entity: table_name array", async () => {
  await withFetchStub({ body: [] }, async (calls) => {
    await deleteEntityTool.handler({ table_name: ["a", "b"], accept: undefined }, ctx);
    assertEquals(calls[0].url, "http://pg.test/rest/v1/entities?table_name=in.(a,b)");
    assertEquals(calls[0].method, "DELETE");
  });
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

test("PostgREST error is surfaced as isError with code and message", async () => {
  await withFetchStub(
    { status: 400, body: { code: "PGRST102", message: "All object keys must match" } },
    async () => {
      const result = await createFieldTool.handler(
        { data: [{ table_name: "t", field_name: "a", title: "A" }], accept: undefined },
        ctx,
      );
      assertEquals(result.isError, true);
      assertStringIncludes(result.content[0].text, "Error: (PGRST102) All object keys must match");
    },
  );
});

// ---------------------------------------------------------------------------
// Schema sweep over all 33 typed create/update/delete tools
// ---------------------------------------------------------------------------

const ENTITIES = [
  "entity",
  "field",
  "module",
  "permission",
  "permission_hierarchy",
  "role",
  "role_permission",
  "user",
  "user_role",
  "webhook_receiver",
  "webhook_receiver_log",
] as const;
const OPS = ["create", "update", "delete"] as const;

const TOOLS = {
  create: {
    entity: createEntityTool,
    field: createFieldTool,
    module: createModuleTool,
    permission: createPermissionTool,
    permission_hierarchy: createPermissionHierarchyTool,
    role: createRoleTool,
    role_permission: createRolePermissionTool,
    user: createUserTool,
    user_role: createUserRoleTool,
    webhook_receiver: createWebhookReceiverTool,
    webhook_receiver_log: createWebhookReceiverLogTool,
  },
  update: {
    entity: updateEntityTool,
    field: updateFieldTool,
    module: updateModuleTool,
    permission: updatePermissionTool,
    permission_hierarchy: updatePermissionHierarchyTool,
    role: updateRoleTool,
    role_permission: updateRolePermissionTool,
    user: updateUserTool,
    user_role: updateUserRoleTool,
    webhook_receiver: updateWebhookReceiverTool,
    webhook_receiver_log: updateWebhookReceiverLogTool,
  },
  delete: {
    entity: deleteEntityTool,
    field: deleteFieldTool,
    module: deleteModuleTool,
    permission: deletePermissionTool,
    permission_hierarchy: deletePermissionHierarchyTool,
    role: deleteRoleTool,
    role_permission: deleteRolePermissionTool,
    user: deleteUserTool,
    user_role: deleteUserRoleTool,
    webhook_receiver: deleteWebhookReceiverTool,
    webhook_receiver_log: deleteWebhookReceiverLogTool,
  },
};

const allTools: Array<{ op: string; entity: string; tool: Tool<Record<string, z.ZodTypeAny>, undefined> }> =
  OPS.flatMap((op) =>
    ENTITIES.map((entity) => ({
      op,
      entity,
      tool: TOOLS[op][entity] as unknown as Tool<Record<string, z.ZodTypeAny>, undefined>,
    }))
  );

test("all 33 tools are loaded for the sweep", () => {
  assertEquals(allTools.length, 33);
});

test("create_*: data accepts one object or a non-empty array (JSON schema exposes anyOf)", () => {
  for (const { entity, tool } of allTools.filter((t) => t.op === "create")) {
    const shape = tool.options.inputSchema;
    const json = z.toJSONSchema(z.object(shape)) as {
      properties: Record<string, { anyOf?: Array<{ type?: string; minItems?: number }> }>;
    };
    const anyOf = json.properties.data.anyOf;
    assert(anyOf, `create_${entity}: data should be a union`);
    assertEquals(anyOf[0].type, "object", `create_${entity}: first branch object`);
    assertEquals(anyOf[1].type, "array", `create_${entity}: second branch array`);
    assertEquals(anyOf[1].minItems, 1, `create_${entity}: array must be non-empty`);

    const full = z.object(shape);
    assertEquals(full.safeParse({ data: [] }).success, false, `create_${entity}: empty array rejected`);
    // Every record schema is a looseObject; a scalar/other type must be rejected in both branches.
    assertEquals(full.safeParse({ data: "nope" }).success, false, `create_${entity}: string rejected`);
    assertEquals(full.safeParse({ data: [1] }).success, false, `create_${entity}: array of scalars rejected`);
  }
});

test("update_*/delete_*: key accepts one value or a non-empty array of the right type", () => {
  for (const { op, entity, tool } of allTools.filter((t) => t.op !== "create")) {
    const shape = tool.options.inputSchema;
    // Most tables are keyed by an `id` column; the two that are not are addressed
    // by the key they actually have, as the tool signatures do.
    const keyName = entity === "entity"
      ? "table_name"
      : entity === "permission"
      ? "permission_name"
      : "id";
    const json = z.toJSONSchema(z.object(shape)) as {
      properties: Record<string, { anyOf?: Array<{ type?: string; minItems?: number }> }>;
    };
    const anyOf = json.properties[keyName].anyOf;
    assert(anyOf, `${op}_${entity}: ${keyName} should be a union`);
    const scalarType = anyOf[0].type;
    assert(scalarType === "string" || scalarType === "integer", `${op}_${entity}: scalar branch type`);
    assertEquals(anyOf[1].type, "array", `${op}_${entity}: array branch`);
    assertEquals(anyOf[1].minItems, 1, `${op}_${entity}: array must be non-empty`);

    const sample = scalarType === "string" ? "x" : 1;
    const wrong = scalarType === "string" ? 1 : "x";
    const extra = op === "update" ? { data: {} } : {};
    const full = z.object(shape);
    assertEquals(full.safeParse({ [keyName]: sample, ...extra }).success, true, `${op}_${entity}: scalar ok`);
    assertEquals(full.safeParse({ [keyName]: [sample, sample], ...extra }).success, true, `${op}_${entity}: array ok`);
    assertEquals(full.safeParse({ [keyName]: [], ...extra }).success, false, `${op}_${entity}: empty array rejected`);
    assertEquals(full.safeParse({ [keyName]: [wrong], ...extra }).success, false, `${op}_${entity}: wrong type rejected`);
  }
});

test("all 33 tools: accept describe warns about arrays", () => {
  for (const { op, entity, tool } of allTools) {
    const accept = tool.options.inputSchema.accept;
    assertStringIncludes(accept.description ?? "", "is an array", `${op}_${entity}: accept caveat`);
  }
});
