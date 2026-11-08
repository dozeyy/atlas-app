//! Atlas MCP server. Phase 1 stub: resolves the config root the same way the
//! app does and exits. The rmcp stdio server and its tools arrive in Phase 5.

use atlas_core::launch::LaunchArgs;
use atlas_core::paths::{ConfigInputs, resolve_config_root};

fn main() {
    let args = LaunchArgs::parse(std::env::args().skip(1));
    let home = atlas_core::paths::home_dir().expect("no home directory");
    let cwd = std::env::current_dir().expect("no current directory");
    let env = std::env::var_os("CLAUDE_CONFIG_DIR");
    let root = resolve_config_root(&ConfigInputs {
        flag: args.config_dir.as_deref(),
        settings_override: None,
        env: env.as_deref(),
        home: &home,
        cwd: &cwd,
    });
    eprintln!(
        "atlas-mcp {}: stub, no tools yet. Config root: {} ({:?})",
        env!("CARGO_PKG_VERSION"),
        root.dir.display(),
        root.source
    );
}
