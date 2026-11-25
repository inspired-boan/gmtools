use base64::Engine;
use rusqlite::params;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

use crate::tree::Db;

pub struct ImagesDir(pub PathBuf);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub id: String,
    pub ext: String,
}

const ALLOWED_EXT: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// 保存图片：base64 入参 → 数据目录 images/<uuid>.<ext>，元数据入库。
#[tauri::command]
pub fn save_image(
    db: State<Db>,
    images: State<ImagesDir>,
    data_base64: String,
    ext: String,
) -> Result<ImageRef, String> {
    let ext = ext.to_lowercase();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return Err(format!("不支持的图片格式: {}", ext));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|_| "图片数据解码失败".to_string())?;
    if bytes.is_empty() {
        return Err("图片数据为空".to_string());
    }
    // 20MB 上限，防误粘超大文件
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("图片超过 20MB 上限".to_string());
    }

    let id = Uuid::new_v4().to_string();
    let dir = images.0.join("images");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建图片目录: {}", e))?;
    fs::write(dir.join(format!("{}.{}", id, ext)), &bytes)
        .map_err(|e| format!("写入图片文件失败: {}", e))?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let conn: std::sync::MutexGuard<rusqlite::Connection> = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO image (id, ext, created_at) VALUES (?1, ?2, ?3)",
        params![id, ext, ts],
    )
    .map_err(|e| e.to_string())?;
    Ok(ImageRef { id, ext })
}
