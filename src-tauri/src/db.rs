use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;

/// 打开（必要时创建）数据库并执行迁移。
/// schema 与 DESIGN.md §3 一致；迁移框架用 PRAGMA user_version 递增。
pub fn open_db(data_dir: &PathBuf) -> Result<Connection, String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("无法创建数据目录 {:?}: {}", data_dir, e))?;
    let conn = Connection::open(data_dir.join("gm.db"))
        .map_err(|e| format!("无法打开数据库: {}", e))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("设置 WAL 失败: {}", e))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("启用外键失败: {}", e))?;
    migrate(&conn).map_err(|e| format!("数据库迁移失败: {}", e))?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    if version < 1 {
        v1(conn).map_err(|e| format!("迁移 v1 失败: {}", e))?;
    }

    conn.pragma_update(None, "user_version", 1)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn v1(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE node (
          id          TEXT PRIMARY KEY,
          parent_id   TEXT REFERENCES node(id) ON DELETE CASCADE,
          type        TEXT NOT NULL,
          name        TEXT NOT NULL,
          sort_order  REAL NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX idx_node_parent ON node(parent_id, sort_order);

        CREATE TABLE note (
          node_id  TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
          content  TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE grid_col (
          id          TEXT PRIMARY KEY,
          node_id     TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL DEFAULT 'text',
          width       INTEGER,
          sort_order  REAL NOT NULL
        );
        CREATE INDEX idx_grid_col_node ON grid_col(node_id, sort_order);

        CREATE TABLE grid_row (
          id          TEXT PRIMARY KEY,
          node_id     TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
          sort_order  REAL NOT NULL
        );
        CREATE INDEX idx_grid_row_node ON grid_row(node_id, sort_order);

        CREATE TABLE grid_cell (
          row_id  TEXT NOT NULL REFERENCES grid_row(id) ON DELETE CASCADE,
          col_id  TEXT NOT NULL REFERENCES grid_col(id) ON DELETE CASCADE,
          value   TEXT,
          PRIMARY KEY (row_id, col_id)
        );

        CREATE VIRTUAL TABLE fts USING fts5(
          text,
          ref_type UNINDEXED,
          ref_id   UNINDEXED,
          node_id  UNINDEXED,
          tokenize = 'unicode61'
        );

        CREATE TABLE trash (
          id          TEXT PRIMARY KEY,
          node_id     TEXT NOT NULL,
          name        TEXT NOT NULL,
          snapshot    TEXT NOT NULL,
          deleted_at  INTEGER NOT NULL
        );

        CREATE TABLE settings (
          key    TEXT PRIMARY KEY,
          value  TEXT NOT NULL
        );
        "#,
    )
}
