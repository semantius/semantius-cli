# Cube Tool Reference

The `cube` server exposes 4 tools implementing a **CubeJS-compatible API**. Queries follow the standard CubeJS JSON query format — measures, dimensions, filters, timeDimensions, and analysis modes (funnel, flow, retention). Always call `discover` first in every session to get the current schema and the authoritative query language reference.

---

## `discover`

**MANDATORY FIRST CALL.** Returns everything you need before constructing any query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic` | string | no | Keyword to search for relevant cubes, e.g. `"sales"`, `"employees"` |
| `intent` | string | no | Natural language goal, e.g. `"analyze productivity trends"` |
| `limit` | number | no | Max results to return. Default: `10` |
| `minScore` | number | no | Minimum relevance score 0–1. Default: `0.1` |

**Returns three things — read all before writing any query:**

| Key | What it contains |
|-----|-----------------|
| `cubes` | Available cubes with measures, dimensions, join relationships, and metadata hints (`eventStream` flag for funnels, etc.) |
| `queryLanguageReference` | **Complete** TypeScript DSL: field naming, filter operators, time dimensions, analysis modes (funnel/flow/retention). This is the authoritative source — do not construct queries from memory. |
| `dateFilteringGuide` | Decision tree for date filtering vs time grouping. Read this whenever the user mentions any time period. |

The `joins` property on each cube shows related cubes. You can include dimensions from **any** related cube in your query — the system auto-joins them.

```bash
# Broad discover
semantius call cube discover '{}'

# Targeted discover
semantius call cube discover '{"topic": "sales", "intent": "analyze revenue by region", "limit": 5}'
```

---

## `validate`

Validates a query and returns auto-corrections for any issues found.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | object | yes | A CubeQuery object to validate |

**Checks:**
- Field existence (measures and dimensions exist in schema)
- Filter syntax and operators
- Cross-cube join validity

**Returns:** corrected query (if issues found) + the generated SQL for debugging.

```bash
semantius call cube validate '{
  "query": {
    "measures": ["Sales.count"],
    "dimensions": ["Products.category"],
    "filters": [{"member": "Sales.createdAt", "operator": "inDateRange", "values": ["last 30 days"]}]
  }
}'
```

---

## `load`

Executes a semantic query and returns data. Requires `discover` to have been called first in the session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | object | yes | Semantic query object — see cube-queries.md for full DSL |

Supports regular queries (measures/dimensions), funnel, flow, and retention analysis modes.

```bash
semantius call cube load '{
  "query": {
    "measures": ["Sales.revenue"],
    "dimensions": ["Products.category"],
    "filters": [{"member": "Sales.createdAt", "operator": "inDateRange", "values": ["last quarter"]}],
    "order": {"Sales.revenue": "desc"},
    "limit": 10
  }
}'
```

---

## `chart`

Same as `load` but renders an interactive chart in the UI. Takes an additional optional `chart` configuration object.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | object | yes | Same format as `load` |
| `chart` | object | no | Chart configuration — type, axis config, display options |

**Chart configuration:**

```json
{
  "type": "bar",
  "title": "Revenue by Category",
  "chartConfig": {
    "xAxis": ["Products.category"],
    "yAxis": ["Sales.revenue"],
    "series": ["Orders.status"]
  },
  "displayConfig": {
    "stacked": false,
    "showLegend": true,
    "showGrid": true,
    "orientation": "vertical"
  }
}
```

**Chart types and when to use them:**

| Type | Use when |
|------|----------|
| `kpiNumber` | Single aggregated number |
| `kpiDelta` | Number with period-over-period change |
| `line` / `area` | Trend over time |
| `bar` | Comparing categories |
| `pie` | Part-of-whole composition |
| `scatter` / `bubble` | Correlation between two measures |
| `heatmap` | Density across two dimensions |
| `boxPlot` | Distribution / spread |
| `funnel` | Funnel analysis results |
| `sankey` / `sunburst` | Flow / path analysis |
| `waterfall` | Sequential additions and subtractions |
| `activityGrid` | Activity over time (like a GitHub contributions grid) |
| `table` | Tabular data when no chart type fits better |

```bash
semantius call cube chart '{
  "query": {
    "measures": ["Sales.revenue"],
    "dimensions": ["Products.category"]
  },
  "chart": {
    "type": "bar",
    "title": "Revenue by Category"
  }
}'
```
