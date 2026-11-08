//! The live price file `<data dir>/pricing.json` (D20, D21).
//!
//! First run copies the bundled seed. An edit reprices instantly (the engine
//! watches the file). A file that fails validation is ignored and the last good
//! table stays in force. A newer seed replaces the file only if the user never
//! edited it; otherwise the app just says a newer list is available.

use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::fsutil::atomic_write;
use crate::usage::pricing::{PriceTable, SEED_JSON};

pub const FILE_NAME: &str = "pricing.json";
const SIDECAR: &str = "pricing.seed-hash";

pub fn live_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone)]
pub struct Loaded {
    pub table: PriceTable,
    /// Why the live file was not used, if it was not.
    pub error: Option<String>,
    pub newer_seed_available: bool,
}

/// Create the live file from the seed, or upgrade it (D21), then load it.
pub fn init(data_dir: &Path, last_good: Option<&PriceTable>) -> Loaded {
    init_with_seed(data_dir, SEED_JSON, last_good)
}

pub fn init_with_seed(data_dir: &Path, seed_json: &str, last_good: Option<&PriceTable>) -> Loaded {
    let mut newer = false;
    if let Err(e) = prepare(data_dir, seed_json, &mut newer) {
        let mut l = load(data_dir, last_good);
        l.error.get_or_insert(format!("could not prepare the price file: {e}"));
        l.newer_seed_available = newer;
        return l;
    }
    let mut l = load(data_dir, last_good);
    l.newer_seed_available = newer;
    l
}

fn prepare(data_dir: &Path, seed_json: &str, newer: &mut bool) -> io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let live = live_path(data_dir);
    let sidecar = data_dir.join(SIDECAR);
    let seed_hash = sha_hex(seed_json.as_bytes());
    let Ok(live_bytes) = std::fs::read(&live) else {
        atomic_write(&live, seed_json.as_bytes())?;
        atomic_write(&sidecar, seed_hash.as_bytes())?;
        return Ok(());
    };
    let (Ok(seed), Ok(cur)) =
        (PriceTable::parse(seed_json), PriceTable::parse(&String::from_utf8_lossy(&live_bytes)))
    else {
        return Ok(()); // a broken live file is reported by `load`; nothing to upgrade
    };
    if seed.updated > cur.updated {
        let recorded = std::fs::read_to_string(&sidecar).unwrap_or_default();
        if recorded.trim() == sha_hex(&live_bytes) {
            atomic_write(&live, seed_json.as_bytes())?;
            atomic_write(&sidecar, seed_hash.as_bytes())?;
        } else {
            *newer = true;
        }
    }
    Ok(())
}

/// Read and validate the live file. On any problem the last good table (or the
/// seed) stays in force and `error` says why.
pub fn load(data_dir: &Path, last_good: Option<&PriceTable>) -> Loaded {
    let fallback = || last_good.cloned().unwrap_or_else(PriceTable::seed);
    match std::fs::read(live_path(data_dir)) {
        Ok(bytes) => match PriceTable::parse(&String::from_utf8_lossy(&bytes)) {
            Ok(table) => Loaded { table, error: None, newer_seed_available: false },
            Err(e) => Loaded { table: fallback(), error: Some(e), newer_seed_available: false },
        },
        Err(e) => Loaded {
            table: fallback(),
            error: Some(format!("could not read the price file: {e}")),
            newer_seed_available: false,
        },
    }
}
