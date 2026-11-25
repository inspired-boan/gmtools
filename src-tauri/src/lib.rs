mod db;
mod tree;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let conn = db::open_db(&data_dir).map_err(std::io::Error::other)?;
            app.manage(tree::Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tree::get_tree,
            tree::create_node,
            tree::rename_node,
            tree::move_node,
            tree::copy_node,
            tree::delete_node,
        ])
        .run(tauri::generate_context!())
        .expect("gmtools 启动失败");
}
