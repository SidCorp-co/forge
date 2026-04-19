#!/usr/bin/env python3
"""
Sync production Strapi data into local SQLite database.
Fetches projects, issues, comments, skills, and memories from production API
and inserts them into the local .tmp/data.db SQLite database.
"""

import json
import sqlite3
import ssl
import urllib.request
import urllib.error
import sys
import os

BASE_URL = os.environ.get("STRAPI_URL", "http://localhost:1337/api")
TOKEN = os.environ.get("STRAPI_TOKEN")
if not TOKEN:
    sys.exit("STRAPI_TOKEN env var required (generate at /admin → Settings → API Tokens)")
FORGE_API_KEY = os.environ.get("FORGE_API_KEY")
if not FORGE_API_KEY:
    sys.exit("FORGE_API_KEY env var required")
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".tmp", "data.db")

HEADERS = {
    "X-Forge-API-Key": FORGE_API_KEY,
    "User-Agent": "forge-skill-sync/1.0",
}

# Content types config: (name, endpoint, populate, db_columns, relation_config)
# relation_config: (relation_field_in_api, link_table, local_col, foreign_col)
CONTENT_TYPES = [
    {
        "name": "projects",
        "endpoint": "/projects",
        "populate": "populate=*",
        "table": "projects",
        "columns": [
            "id", "document_id", "name", "slug", "description", "api_key",
            "default_provider", "agent_prompt", "agent_provider", "agent_memory_enabled",
            "knowledge_index", "repos", "created_at", "updated_at", "published_at",
            "locale", "coolify_url", "coolify_api_key", "coolify_resources",
            "webhook_url", "webhook_secret", "webhook_statuses", "sentry_project",
            "rolling_stats",
        ],
        "json_columns": ["knowledge_index", "repos", "coolify_resources", "webhook_statuses", "rolling_stats"],
        "relations": [],
    },
    {
        "name": "issues",
        "endpoint": "/issues",
        "populate": "populate=project",
        "table": "issues",
        "columns": [
            "id", "document_id", "title", "description", "status", "priority",
            "category", "reported_by", "ai_summary", "ai_suggested_solution",
            "ai_acceptance_criteria", "ai_confidence", "is_agent_task", "agent_status",
            "agent_log", "created_at", "updated_at", "published_at", "locale",
            "change_history", "acceptance_criteria", "suggested_solution", "plan", "relations",
        ],
        "json_columns": ["ai_acceptance_criteria", "agent_log", "change_history", "relations"],
        "relations": [
            {
                "api_field": "project",
                "link_table": "issues_project_lnk",
                "local_col": "issue_id",
                "foreign_col": "project_id",
            }
        ],
    },
    {
        "name": "comments",
        "endpoint": "/comments",
        "populate": "populate=issue",
        "table": "comments",
        "columns": [
            "id", "document_id", "body", "author", "is_ai",
            "created_at", "updated_at", "published_at", "locale",
        ],
        "json_columns": [],
        "relations": [
            {
                "api_field": "issue",
                "link_table": "comments_issue_lnk",
                "local_col": "comment_id",
                "foreign_col": "issue_id",
            }
        ],
    },
    {
        "name": "skills",
        "endpoint": "/skills",
        "populate": "",
        "table": "skills",
        "columns": [
            "id", "document_id", "name", "description", "version", "skill_md",
            "files", "is_global", "created_at", "updated_at", "published_at",
            "locale", "target",
        ],
        "json_columns": ["files"],
        "relations": [],
    },
    {
        "name": "memories",
        "endpoint": "/memories",
        "populate": "populate=project",
        "table": "memories",
        "columns": [
            "id", "document_id", "user_key", "category", "content", "source",
            "use_count", "last_used_at", "created_at", "updated_at", "published_at",
            "locale", "scope",
        ],
        "json_columns": [],
        "relations": [
            {
                "api_field": "project",
                "link_table": "memories_project_lnk",
                "local_col": "memory_id",
                "foreign_col": "project_id",
            }
        ],
    },
]


def fetch_all_pages(endpoint, populate="", page_size=100):
    """Fetch all pages from a Strapi API endpoint."""
    all_data = []
    page = 1
    ssl_ctx = ssl.create_default_context()

    while True:
        url = f"{BASE_URL}{endpoint}?pagination[pageSize]={page_size}&pagination[page]={page}"
        if populate:
            url += f"&{populate}"

        req = urllib.request.Request(url, headers=HEADERS)
        try:
            resp = urllib.request.urlopen(req, context=ssl_ctx)
            body = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            error_body = e.read().decode() if e.fp else ""
            print(f"  HTTP {e.code} fetching {url}: {error_body[:200]}")
            raise
        except Exception as e:
            print(f"  Error fetching {url}: {e}")
            raise

        data = body.get("data", [])
        meta = body.get("meta", {}).get("pagination", {})
        all_data.extend(data)

        total_pages = meta.get("pageCount", 1)
        print(f"  Page {page}/{total_pages} - got {len(data)} records")

        if page >= total_pages:
            break
        page += 1

    return all_data


def snake_to_camel(name):
    """Convert snake_case to camelCase."""
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def get_field_value(item, col, json_columns):
    """Extract a field value from a Strapi 5 response item (flat format)."""
    # Strapi 5 API returns camelCase, DB uses snake_case
    if col == "document_id":
        return item.get("documentId")

    # Try snake_case first (direct match), then camelCase
    val = item.get(col)
    if val is None:
        val = item.get(snake_to_camel(col))

    if col in json_columns and val is not None and not isinstance(val, str):
        val = json.dumps(val)
    return val


def sync_content_type(conn, ct):
    """Sync a single content type from production to local DB."""
    name = ct["name"]
    print(f"\nSyncing {name}...")

    try:
        records = fetch_all_pages(ct["endpoint"], ct["populate"])
    except Exception as e:
        print(f"  FAILED to fetch {name}: {e}")
        return 0

    if not records:
        print(f"  No records found for {name}")
        return 0

    # Build INSERT OR REPLACE statement
    columns = ct["columns"]
    placeholders = ", ".join(["?"] * len(columns))
    col_names = ", ".join([f"`{c}`" for c in columns])
    sql = f"INSERT OR REPLACE INTO `{ct['table']}` ({col_names}) VALUES ({placeholders})"

    inserted = 0
    relation_rows = []

    for item in records:
        values = [get_field_value(item, col, ct["json_columns"]) for col in columns]
        try:
            conn.execute(sql, values)
            inserted += 1
        except Exception as e:
            print(f"  Error inserting {name} id={item.get('id')}: {e}")
            continue

        # Collect relation link rows
        for rel in ct["relations"]:
            related = item.get(rel["api_field"])
            if related and isinstance(related, dict) and related.get("id"):
                relation_rows.append((rel, item["id"], related["id"]))

    # Insert relation links
    for rel_config, local_id, foreign_id in relation_rows:
        link_sql = (
            f"INSERT OR REPLACE INTO `{rel_config['link_table']}` "
            f"(`{rel_config['local_col']}`, `{rel_config['foreign_col']}`) "
            f"VALUES (?, ?)"
        )
        try:
            conn.execute(link_sql, (local_id, foreign_id))
        except Exception as e:
            print(f"  Error inserting link {rel_config['link_table']} ({local_id}, {foreign_id}): {e}")

    conn.commit()
    print(f"  Synced {inserted}/{len(records)} {name}")
    return inserted


def main():
    print(f"Database: {DB_PATH}")
    if not os.path.exists(DB_PATH):
        print(f"ERROR: Database not found at {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=OFF")  # Avoid FK issues during bulk insert

    total = 0
    for ct in CONTENT_TYPES:
        count = sync_content_type(conn, ct)
        total += count

    conn.execute("PRAGMA foreign_keys=ON")
    conn.close()
    print(f"\nDone! Total records synced: {total}")


if __name__ == "__main__":
    main()
