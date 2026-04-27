# Semantius Cube Query Reference

The `cube` server implements a **CubeJS-compatible API** over your Semantius data model. If you know CubeJS, the query DSL is the same. Use it whenever PostgREST alone is insufficient:

| Use cube when... | Example |
|-----------------|---------|
| Query spans multiple tables | Revenue by customer region (orders JOIN customers) |
| Need aggregations | Total revenue, average order value, count by status |
| Time-series or trends | Monthly signups, weekly active users |
| Top-N rankings | Top 10 products by sales |
| Complex metrics | Retention, funnels, conversion rates |
| Pre-defined measures | Reuse metric definitions from the semantic model |

For simple single-table reads — filtering one table, fetching a record by ID — use `postgrestRequest` instead (Layer 2).

---

## Mandatory Workflow

**Always follow this sequence — never skip `discover`:**

```
1. discover  →  2. (validate)  →  3. load / chart
```

1. **`discover`** — Returns available cubes, the complete query DSL (`queryLanguageReference`), and the `dateFilteringGuide`. Read all three before constructing any query.
2. **`validate`** (optional) — Auto-corrects field names, filter syntax, and join validity. Returns corrected query + generated SQL for debugging.
3. **`load`** — Executes the query and returns data.
4. **`chart`** — Same as `load` but renders an interactive chart UI.

```bash
# Step 1 — always first, supports optional filtering
semantius call cube discover '{}'
# Or narrow by topic/intent:
semantius call cube discover '{"topic": "sales", "intent": "analyze revenue trends", "limit": 10, "minScore": 0.1}'
```

**`discover` returns three things — read all before querying:**
- `cubes` — available cubes with measures, dimensions, join relationships, and metadata hints
- `queryLanguageReference` — the **complete** TypeScript DSL, filter operators, analysis modes. This is the source of truth — do not construct queries from memory.
- `dateFilteringGuide` — decision tree for date filtering vs time grouping. Read this whenever the user mentions any time period.

```bash
# Step 2 — optional: validate auto-corrects field names and returns generated SQL
semantius call cube validate '{"query": {"measures": ["Sales.count"], "dimensions": ["Products.category"]}}'
# Returns: corrected query + SQL for debugging

# Step 3 — execute
semantius call cube load '{"query": {"measures": ["Sales.count"], "dimensions": ["Products.category"]}}'
```

---

## Field Naming Rules

Fields are **exactly** `CubeName.fieldName` — two parts, one dot. Copy verbatim from `discover` output.

| Wrong | Right |
|-------|-------|
| `Sales.Sales.count` | `Sales.count` |
| `Sales_count` | `Sales.count` |
| `sales` | `Sales.count` |

---

## The #1 Mistake: Totals vs Time Series

This is the most common source of incorrect queries.

| Goal | Correct approach | Wrong approach |
|------|-----------------|----------------|
| Aggregated total over a period ("total sales last 6 months") | `filters` with `inDateRange` | `timeDimensions` without granularity |
| Time series ("sales by month") | `timeDimensions` with `granularity` | `filters` with `inDateRange` |

```bash
# ✅ CORRECT: Aggregated total — use filters
semantius call cube load '{
  "query": {
    "measures": ["Sales.revenue"],
    "filters": [{"member": "Sales.createdAt", "operator": "inDateRange", "values": ["last 6 months"]}]
  }
}'

# ✅ CORRECT: Time series by month — use timeDimensions with granularity
semantius call cube load '{
  "query": {
    "measures": ["Sales.revenue"],
    "timeDimensions": [{"dimension": "Sales.createdAt", "dateRange": "last 6 months", "granularity": "month"}]
  }
}'

# ❌ WRONG: timeDimensions without granularity returns daily rows
semantius call cube load '{
  "query": {
    "measures": ["Sales.revenue"],
    "timeDimensions": [{"dimension": "Sales.createdAt", "dateRange": "last 6 months"}]
  }
}'
```

Always read the `dateFilteringGuide` returned by `discover` — it is the authoritative decision tree.

---

## Query Structure

```json
{
  "measures": ["CubeName.measureName"],
  "dimensions": ["CubeName.dimensionName"],
  "filters": [
    {"member": "CubeName.field", "operator": "equals", "values": ["value"]}
  ],
  "timeDimensions": [
    {
      "dimension": "CubeName.createdAt",
      "dateRange": "last 7 days",
      "granularity": "day",
      "fillMissingDates": true
    }
  ],
  "order": {"CubeName.revenue": "desc"},
  "limit": 10,
  "offset": 0
}
```

### `timeDimensions` Options

| Property | Notes |
|----------|-------|
| `dimension` | Required — e.g. `"Sales.createdAt"` |
| `dateRange` | Relative (`"last 7 days"`, `"this month"`, `"last quarter"`) or absolute `["2024-01-01","2024-06-30"]` |
| `granularity` | `second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year` — **required for time series**; omit only when using as a date range filter |
| `fillMissingDates` | `true` (default) fills gaps in the series with zero/null. Set `false` to skip empty periods. Requires `granularity` + `dateRange`. |
| `compareDateRange` | Period-over-period comparison: array of date ranges, e.g. `["last 30 days", ["2024-01-01","2024-01-30"]]` |

### Period-over-Period Comparison Example

```bash
semantius call cube load '{
  "query": {
    "measures": ["Sales.revenue"],
    "timeDimensions": [{
      "dimension": "Sales.createdAt",
      "compareDateRange": ["this month", "last month"],
      "granularity": "day"
    }]
  }
}'
```

### Filter Operators

Common operators (see `queryLanguageReference` from `discover` for the full list):

| Operator | Example |
|----------|---------|
| `equals` | `{"operator": "equals", "values": ["active"]}` |
| `notEquals` | `{"operator": "notEquals", "values": ["draft"]}` |
| `contains` | `{"operator": "contains", "values": ["smith"]}` |
| `gt` / `gte` / `lt` / `lte` | `{"operator": "gt", "values": ["100"]}` |
| `inDateRange` | `{"operator": "inDateRange", "values": ["last 30 days"]}` |
| `beforeDate` / `afterDate` | `{"operator": "afterDate", "values": ["2024-01-01"]}` |
| `set` / `notSet` | `{"operator": "set"}` (no values needed) |

### AND/OR Logic

```json
{
  "filters": [
    {"and": [
      {"member": "Orders.status", "operator": "equals", "values": ["active"]},
      {"member": "Orders.amount", "operator": "gt", "values": ["100"]}
    ]}
  ]
}
```

---

## Cross-Cube Joins

The `joins` property in each `discover` result lists related cubes. Include dimensions from related cubes freely — the system auto-joins them.

```bash
# Discover shows: Productivity joins to Employees
# So you can mix fields freely:
semantius call cube load '{
  "query": {
    "measures": ["Productivity.totalPullRequests"],
    "dimensions": ["Employees.name", "Employees.department"]
  }
}'
```

---

## Analysis Modes

### Funnel Analysis

```bash
semantius call cube load '{
  "query": {
    "funnel": {
      "bindingKey": "Events.userId",
      "timeDimension": "Events.timestamp",
      "steps": [
        {"name": "Sign Up", "filter": {"member": "Events.eventType", "operator": "equals", "values": ["signup"]}},
        {"name": "First Purchase", "filter": {"member": "Events.eventType", "operator": "equals", "values": ["purchase"]}, "timeToConvert": "P7D"}
      ]
    }
  }
}'
```

### Flow / Path Analysis

```bash
semantius call cube load '{
  "query": {
    "flow": {
      "bindingKey": "Events.userId",
      "timeDimension": "Events.timestamp",
      "eventDimension": "Events.eventType",
      "startingStep": {"name": "Checkout", "filter": {"member": "Events.eventType", "operator": "equals", "values": ["checkout"]}},
      "stepsAfter": 3,
      "stepsBefore": 2
    }
  }
}'
```

### Retention Analysis

```bash
semantius call cube load '{
  "query": {
    "retention": {
      "bindingKey": "Events.userId",
      "timeDimension": "Events.timestamp",
      "dateRange": {"start": "2024-01-01", "end": "2024-06-30"},
      "granularity": "week",
      "periods": 12,
      "retentionType": "classic"
    }
  }
}'
```

---

## Chart Types

When using `cube chart` (or the `Cube:chart` tool in session):

| Data shape | Chart type |
|------------|-----------|
| Single number | `kpiNumber` |
| Trend over time | `line` or `area` |
| Categories | `bar` |
| Part-of-whole | `pie` |
| Correlation | `scatter` or `bubble` |
| Distribution | `boxPlot` |
| Funnel | `funnel` |
| Flow | `sankey` or `sunburst` |

---

## Raw / Ungrouped Queries

To get row-level data without aggregation (requires at least one dimension; incompatible with `count`/`countDistinct`):

```json
{
  "dimensions": ["Orders.id", "Orders.createdAt", "Orders.status"],
  "ungrouped": true,
  "limit": 100
}
```
