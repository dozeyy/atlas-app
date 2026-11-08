//! Command-line flags shared by the app and the MCP binary.

use std::ffi::OsString;
use std::path::PathBuf;

/// Flags Atlas understands. Everything else on the command line is ignored
/// (the webview and the OS add their own).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchArgs {
    /// `--config-dir <path>`: treat this folder as the Claude config root.
    pub config_dir: Option<PathBuf>,
    /// `--data-dir <path>`: where Atlas keeps its own data (settings, cache,
    /// backups). Used by first-run tests so they never touch the real one.
    pub data_dir: Option<PathBuf>,
    /// `--sandbox`: start in Sandbox Mode.
    pub sandbox: bool,
    /// Problems worth showing in a log (a flag with no value, for example).
    pub warnings: Vec<String>,
}

impl LaunchArgs {
    /// `args` must not include the program name.
    pub fn parse<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let mut out = LaunchArgs::default();
        let mut it = args.into_iter().map(Into::into);
        while let Some(arg) = it.next() {
            let arg: OsString = arg;
            let text = arg.to_string_lossy().into_owned();
            match text.as_str() {
                "--config-dir" => match it.next() {
                    Some(v) if !v.is_empty() => out.config_dir = Some(PathBuf::from(v)),
                    _ => out.warnings.push("--config-dir needs a folder".into()),
                },
                "--data-dir" => match it.next() {
                    Some(v) if !v.is_empty() => out.data_dir = Some(PathBuf::from(v)),
                    _ => out.warnings.push("--data-dir needs a folder".into()),
                },
                "--sandbox" => out.sandbox = true,
                _ => {
                    if let Some(v) = text.strip_prefix("--config-dir=") {
                        if v.is_empty() {
                            out.warnings.push("--config-dir needs a folder".into());
                        } else {
                            out.config_dir = Some(PathBuf::from(v));
                        }
                    } else if let Some(v) = text.strip_prefix("--data-dir=") {
                        if v.is_empty() {
                            out.warnings.push("--data-dir needs a folder".into());
                        } else {
                            out.data_dir = Some(PathBuf::from(v));
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_separate_and_equals_forms() {
        let a = LaunchArgs::parse(["--config-dir", "C:\\x y", "--sandbox"]);
        assert_eq!(a.config_dir, Some(PathBuf::from("C:\\x y")));
        assert!(a.sandbox);
        let b = LaunchArgs::parse(["--config-dir=/tmp/c", "--data-dir=/tmp/d"]);
        assert_eq!(b.config_dir, Some(PathBuf::from("/tmp/c")));
        assert_eq!(b.data_dir, Some(PathBuf::from("/tmp/d")));
        assert!(!b.sandbox);
    }

    #[test]
    fn ignores_unknown_and_reports_missing_values() {
        let a = LaunchArgs::parse(["--inspect", "--config-dir"]);
        assert_eq!(a.config_dir, None);
        assert_eq!(a.warnings.len(), 1);
        let b = LaunchArgs::parse(["--config-dir="]);
        assert_eq!(b.config_dir, None);
        assert_eq!(b.warnings.len(), 1);
    }

    #[test]
    fn last_value_wins() {
        let a = LaunchArgs::parse(["--config-dir", "a", "--config-dir", "b"]);
        assert_eq!(a.config_dir, Some(PathBuf::from("b")));
    }
}
