use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const KEYCHAIN_SERVICE: &str = "TableView";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Postgres,
    Mysql,
    Sqlite,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub file_path: String,
    #[serde(default)]
    pub ssl_mode: String,
    #[serde(default)]
    pub env: String,
    #[serde(default)]
    pub read_only: bool,
    /// Whether Claude (over MCP or the chat panel) may query this connection.
    #[serde(default = "default_true")]
    pub allow_claude: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSettings {
    pub side: String,
    pub width: u32,
    pub model: String,
    pub extra_instructions: String,
    pub claude_path: String,
}

impl Default for ChatSettings {
    fn default() -> Self {
        ChatSettings {
            side: "right".into(),
            width: 380,
            model: "".into(),
            extra_instructions: "".into(),
            claude_path: "".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub mcp_token: String,
    pub mcp_port: u16,
    #[serde(default)]
    pub chat: ChatSettings,
    /// Display and behavior preferences. The frontend owns their keys and
    /// defaults, so a new setting needs no backend change.
    #[serde(default)]
    pub prefs: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub updates: UpdateSettings,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        UpdateSettings {
            source_dir: String::new(),
            signing_identity: String::new(),
            auto_merge: true,
        }
    }
}

/// Where the feedback loop finds TableView's own source, and how it rebuilds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSettings {
    /// Git checkout TableView was built from. Empty means the folder this build came from.
    #[serde(default)]
    pub source_dir: String,
    /// Optional codesign identity for rebuilds (name or SHA-1), so the Keychain keeps trusting the app.
    #[serde(default)]
    pub signing_identity: String,
    /// Merge feedback PRs once TableView's own checks pass, then update.
    #[serde(default = "default_true")]
    pub auto_merge: bool,
}

pub struct Store {
    dir: PathBuf,
}

fn random_token() -> String {
    use rand::RngExt;
    let bytes: [u8; 24] = rand::rng().random();
    hex::encode(bytes)
}

impl Store {
    pub fn new(dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        // Holds the MCP token and connection details: owner only.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Store { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Writes a file only the owner can read. It is created 0600, so the
    /// contents are never readable by others, not even for a moment.
    pub fn write_private(path: &Path, data: &[u8]) -> anyhow::Result<()> {
        use std::io::Write;
        let tmp = path.with_extension("tmp");
        let _ = std::fs::remove_file(&tmp);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn connections(&self) -> anyhow::Result<Vec<ConnectionConfig>> {
        let p = self.dir.join("connections.json");
        if !p.exists() {
            return Ok(vec![]);
        }
        Ok(serde_json::from_slice(&std::fs::read(p)?)?)
    }

    pub fn save_connections(&self, list: &[ConnectionConfig]) -> anyhow::Result<()> {
        Self::write_private(
            &self.dir.join("connections.json"),
            &serde_json::to_vec_pretty(list)?,
        )
    }

    pub fn settings(&self) -> anyhow::Result<Settings> {
        let p = self.dir.join("settings.json");
        if p.exists()
            && let Ok(s) = serde_json::from_slice::<Settings>(&std::fs::read(&p)?)
        {
            return Ok(s);
        }
        let s = Settings {
            mcp_token: random_token(),
            mcp_port: 47821,
            chat: ChatSettings::default(),
            prefs: Default::default(),
            updates: UpdateSettings::default(),
        };
        self.save_settings(&s)?;
        Ok(s)
    }

    pub fn save_settings(&self, s: &Settings) -> anyhow::Result<()> {
        Self::write_private(
            &self.dir.join("settings.json"),
            &serde_json::to_vec_pretty(s)?,
        )
    }
}

pub fn set_password(id: &str, password: &str) -> anyhow::Result<()> {
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, id, password.as_bytes())?;
    Ok(())
}

pub fn get_password(id: &str) -> Option<String> {
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, id)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
}

pub fn delete_password(id: &str) {
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, id);
}
