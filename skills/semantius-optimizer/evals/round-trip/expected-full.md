---
artifact: semantic-spec
version: "5.5"
system_name: Demo Ops Pro
tagline: "Demo operations tracker (governed)"
icon_name: wrench
system_slug: demo-ops-pro
module_type: domain
module_kind: domain
access_scope: full
domain_code: DEMOPRO
naming_mode: agent-optimized
logo_color: #2563eb
deployed_version: 4
deployed_version_date: "2026-08-02T09:30:00+00:00"
entities:
  - vendors
  - assets
  - asset_vendors
  - users
---

# Demo Ops Pro: Semantic Model

## 1. Overview

Demo operations tracker (governed).

## 2. Entity summary

| # | Table name | Singular label | Purpose |
|---|---|---|---|
| 1 | `vendors` | Vendor | A supplier the team buys assets from. |
| 2 | `assets` | Asset | A physical or virtual item the team tracks. |
| 3 | `asset_vendors` | Asset Vendor | Links an asset to a secondary vendor. |
| 4 | `users` | User | Users and agents |

### Entity-relationship diagram

```mermaid
flowchart LR
    classDef builtin fill:#c8e6c9,stroke:#1b5e20,stroke-width:2px,color:#1a4d2e;
    vendors -->|supplies| assets
    users -->|owns| assets
    assets --> asset_vendors
    vendors --> asset_vendors
    class users builtin;
```

## 3. Entities

### 3.1 `vendors` - Vendor

**Plural label:** Vendors
**Label column:** `vendor_name`
**Audit log:** no
**Edit permission:** admin
**Cube mode:** disabled
**Catalog entity code:** `vendors`
**Entity type:** catalog
**Description:** A supplier the team buys assets from.

**Fields**

| Field name | Format | Required | Label | Description | Reference / Notes |
|---|---|---|---|---|---|
| `vendor_name` | `string` | yes | Vendor Name | | `label_column` |
| `tier` | `enum` | no | Tier | | enum_values: `preferred`, `approved`, `blocked`, cube_type: dimension |

**Relationships**

- A `vendors` record may have many `assets` (1:N, via `assets.vendor_id`).
- `vendors` ↔ `assets` is many-to-many through the `asset_vendors` junction table.

### 3.2 `assets` - Asset

**Plural label:** Assets
**Label column:** `asset_tag`
**Order column:** `sort_key`
**Audit log:** yes
**Edit mode:** sidebar
**Icon URL:** https://example.invalid/asset.svg
**Catalog entity code:** `assets`
**Entity type:** operational_workflow
**Label parent:** `vendor_id`
**Description:** A physical or virtual item the team tracks.

**Fields**

| Field name | Format | Required | Label | Description | Reference / Notes |
|---|---|---|---|---|---|
| `asset_tag` | `string` | yes | Asset Tag | | `label_column`, `unique` |
| `workflow_state` | `enum` | yes | Status | | enum_values: `in_stock`, `deployed`, `retired`; default: "in_stock" |
| `vendor_id` | `reference` | yes | Vendor | | → `vendors` (N:1), relationship_label: "supplies" |
| `owner_id` | `reference` | no | Owner | | → `users` (N:1), relationship_label: "owns" |
| `sort_key` | `integer` | no | Sort Key | | width: s |

**Relationships**

- An `assets` record belongs to one `vendors` via `vendor_id` (N:1, required, restrict on delete).
- An `assets` record may belong to one `users` via `owner_id` (N:1, optional, clear on delete).
- `assets` ↔ `vendors` is many-to-many through the `asset_vendors` junction table.

**Validation rules**

```json
[
  {
    "code": "retire_needs_permission",
    "message": "Only asset managers can retire an asset.",
    "description": "Retiring is a gated transition.",
    "jsonlogic": {
      "if": [
        {
          "==": [
            {
              "var": "workflow_state"
            },
            "retired"
          ]
        },
        {
          "require_permission": "demo-ops-pro:retire_asset"
        },
        true
      ]
    }
  }
]
```

**Input type rules**

```json
[
  {
    "field": "owner_id",
    "jsonlogic": {
      "if": [
        {
          "==": [
            {
              "var": "workflow_state"
            },
            "retired"
          ]
        },
        "readonly",
        "default"
      ]
    }
  }
]
```

**Select rule**

```json
{
  "or": [
    {
      "==": [
        {
          "var": "owner_id"
        },
        {
          "var": "$user_id"
        }
      ]
    },
    {
      "has_permission": "demo-ops-pro:view_all_assets"
    }
  ]
}
```

### 3.3 `asset_vendors` - Asset Vendor

**Plural label:** Asset Vendors
**Audit log:** no
**Edit permission:** link
**Catalog entity code:** `asset_vendors`
**Entity type:** junction
**Description:** Links an asset to a secondary vendor.

**Fields**

| Field name | Format | Required | Label | Description | Reference / Notes |
|---|---|---|---|---|---|
| `asset_id` | `parent` | yes | Asset | | ↳ `assets` (N:1) |
| `vendor_id` | `parent` | yes | Vendor | | ↳ `vendors` (N:1) |

**Relationships**

- Each `asset_vendors` links one `assets` to one `vendors` (junction, both legs cascade on delete).

### 3.4 `users` - User

**Plural label:** Users
**Label column:** `email`
**Reconciliation:** reuse-from semantius_builtin.users
**Description:** Users and agents

**Relationships**

- An `users` record may have many `assets` (1:N, via `assets.owner_id`).

---

## 4. Relationship summary

| From | Field | To | Cardinality | Kind | fk_format | Delete behavior |
|---|---|---|---|---|---|---|
| `assets` | `vendor_id` | `vendors` | N:1 | reference | reference | restrict |
| `assets` | `owner_id` | `users` | N:1 | reference | reference | clear |
| `asset_vendors` | `asset_id` | `assets` | N:1 | junction | parent | cascade |
| `asset_vendors` | `vendor_id` | `vendors` | N:1 | junction | parent | cascade |

## 5. Enumerations

### `assets.workflow_state`
- `in_stock`
- `deployed`
- `retired`

### `vendors.tier`
- `preferred`
- `approved`
- `blocked`

## 6. Cross-model link suggestions

_(none: live extraction is reverse-engineering; every cross-module FK already exists as a §3 reference)_

### Outbound handoffs

_(none: not extracted from live state by semantius-optimizer; carried from the blueprint when one exists)_

### Inbound handoffs

_(none: not extracted from live state by semantius-optimizer; carried from the blueprint when one exists)_

## 7. Open questions

### 7.1 🔴 Decisions needed (blockers)

_(none: reverse-engineered from a live module; nothing blocks redeployment)_

### 7.2 🟡 Future considerations (deferred scope)

_(none: reverse-engineered from a live module)_

## 8.1 Permissions catalog

| permission | tier | description | included in `:admin`? | reconciliation |
| --- | --- | --- | --- | --- |
| `demo-ops-pro:read` | baseline-read | Read access to every record in the module. | ✓ | (none) |
| `demo-ops-pro:manage` | baseline-manage | Create and edit records in the module. | ✓ | (none) |
| `demo-ops-pro:admin` | baseline-admin | Administer reference data and settings. | - | (none) |
| `demo-ops-pro:approve_vendor` | workflow-gate (lifecycle) | Approve a vendor for use. | - | (none) |
| `demo-ops-pro:link` | narrow | Link assets to secondary vendors. | ✓ | (none) |
| `demo-ops-pro:retire_asset` | workflow-gate (rule) | Retire an asset. | ✓ | (none) |
| `demo-ops-pro:view_all_assets` | override | See every asset, not only your own. | ✓ | (none) |

## 8.2 Business rules

_(none: not extracted from live state by semantius-optimizer; author by hand)_

## 9. Governance

### 9.1 `DEMO-OPS-PRO`

**Baseline roles:**

| role | baseline grant | origin | catalog role code | reconciliation |
| --- | --- | --- | --- | --- |
| `demo_ops_pro_viewer` | `demo-ops-pro:read` | model | demo_ops_pro_viewer | ♻ exists |
| `demo_ops_pro_manager` | `demo-ops-pro:manage` | model | | ♻ exists |
| `demo_ops_pro_admin` | `demo-ops-pro:admin` | model | | ♻ exists |

**Permission hierarchy:**

| permission | includes | reconciliation |
| --- | --- | --- |
| `demo-ops-pro:admin` | `demo-ops-pro:manage` | ♻ exists |
| `demo-ops-pro:manage` | `demo-ops-pro:read` | ♻ exists |
| `demo-ops-pro:admin` | `demo-ops-pro:retire_asset` | ♻ exists |
| `demo-ops-pro:admin` | `demo-ops-pro:view_all_assets` | ♻ exists |
| `demo-ops-pro:manage` | `demo-ops-pro:link` | ♻ exists |

**Processes:**

| process_key | name | description | ordering |
| --- | --- | --- | --- |
| asset_lifecycle | Asset lifecycle | Procure, deploy, and retire assets. | 10 |

### 9.2 Functional ownership and default grants

_(none: not extracted from live state by semantius-optimizer; author by hand)_
