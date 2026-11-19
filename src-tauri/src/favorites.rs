//! Saved queries from TablePlus: plain `.sql` files, grouped in folders, under
//! `~/Library/Application Support/com.tinyapp.TablePlus/Data/Favorite`.

use std::path::Path;

use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct Favorite {
    /// Folder path below the root, joined with "/"; empty at the top level.
    pub folder: String,
    pub name: String,
    pub sql: String,
}

pub fn tableplus_dir() -> Option<std::path::PathBuf> {
    Some(dirs::home_dir()?.join("Library/Application Support/com.tinyapp.TablePlus/Data/Favorite"))
}

/// Every `.sql` file below `root`, top level first, then folders by name.
/// A missing root is an empty list.
pub fn list(root: &Path) -> Vec<Favorite> {
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out.sort_by(|a, b| {
        (!a.folder.is_empty(), a.folder.to_lowercase(), a.name.to_lowercase())
            .cmp(&(!b.folder.is_empty(), b.folder.to_lowercase(), b.name.to_lowercase()))
    });
    out
}

fn walk(dir: &Path, folder: &str, out: &mut Vec<Favorite>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            let sub = if folder.is_empty() { name } else { format!("{folder}/{name}") };
            walk(&path, &sub, out);
        } else if let Some(stem) = name.strip_suffix(".sql") {
            if let Ok(sql) = std::fs::read_to_string(&path) {
                out.push(Favorite { folder: folder.to_string(), name: stem.to_string(), sql });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_sql_files_by_folder() {
        let root = std::env::temp_dir().join(format!("tv-fav-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join("shop/reports")).unwrap();
        std::fs::write(root.join("b top.sql"), "select 2").unwrap();
        std::fs::write(root.join("shop/orders.sql"), "select * from orders").unwrap();
        std::fs::write(root.join("shop/reports/daily.sql"), "select 1").unwrap();
        std::fs::write(root.join("shop/.DS_Store"), "x").unwrap();
        std::fs::write(root.join("notes.txt"), "x").unwrap();

        let got = list(&root);
        let keys: Vec<_> = got.iter().map(|f| (f.folder.as_str(), f.name.as_str())).collect();
        assert_eq!(keys, [("", "b top"), ("shop", "orders"), ("shop/reports", "daily")]);
        assert_eq!(got[1].sql, "select * from orders");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_root_is_empty() {
        assert!(list(Path::new("/nonexistent/tv-favorites")).is_empty());
    }
}
