//! Reading a GitHub tarball that nobody vouches for (D15).
//!
//! The archive is untrusted. Only plain files and folders are accepted; a link, a device, a path
//! that leaves its folder, a Windows-reserved name, too many files or too many bytes refuses the
//! whole archive with one sentence and leaves nothing behind. The files land in a temp folder
//! beside the final place and are moved in with one rename, so a staging folder either holds a
//! whole checked repository or does not exist.

use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use flate2::read::GzDecoder;
use tar::{Archive, EntryType};

pub const MAX_COMPRESSED: u64 = 25 * 1024 * 1024;
pub const MAX_UNPACKED: u64 = 50 * 1024 * 1024;
pub const MAX_FILE: u64 = 5 * 1024 * 1024;
pub const MAX_FILES: usize = 2000;
pub const MAX_DEPTH: usize = 12;

pub const TOO_BIG: &str = "That repository is too big for Atlas to read (the limit is 25 MB to download and 50 MB unpacked).";
pub const UNSAFE: &str = "That archive has an unsafe file (a link, a path that leaves its folder, or a reserved name), so Atlas did not read it.";
pub const TOO_MANY: &str = "That repository has more than 2,000 files, so Atlas did not read it.";
pub const FILE_TOO_BIG: &str = "That repository has a file over 5 MB, so Atlas did not read it.";
pub const NOT_ARCHIVE: &str = "GitHub sent something that is not a repository archive.";

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A staged repository.
#[derive(Debug, Clone)]
pub struct Unpacked {
    pub dir: PathBuf,
    /// The commit the archive was made from (GitHub's pax header), when it said.
    pub sha: Option<String>,
    pub files: usize,
    pub bytes: u64,
}

/// A reader that stops with an error (and says so) once `left` bytes have been read.
struct Cap<R> {
    inner: R,
    left: u64,
    hit: Arc<AtomicBool>,
}

impl<R: Read> Read for Cap<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.left == 0 {
            // Anything more than the cap is too much; one more byte tells whether there is more.
            let mut one = [0u8; 1];
            return match self.inner.read(&mut one)? {
                0 => Ok(0),
                _ => {
                    self.hit.store(true, Ordering::Relaxed);
                    Err(io::Error::other("too big"))
                }
            };
        }
        let n = buf.len().min(self.left.min(usize::MAX as u64) as usize);
        let got = self.inner.read(&mut buf[..n])?;
        self.left -= got as u64;
        Ok(got)
    }
}

/// Windows refuses these names, and a repository that has one is not one to trust.
fn bad_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 200 || name.ends_with('.') || name.ends_with(' ') {
        return true;
    }
    if name.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/')) {
        return true;
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit())
}

/// The commit sha out of a pax global header (`<len> comment=<sha>\n` records).
fn sha_from_pax(data: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(data).ok()?;
    for rec in text.split('\n') {
        let rest = rec.split_once(' ').map(|(_, r)| r).unwrap_or(rec);
        if let Some(v) = rest.strip_prefix("comment=") {
            let v = v.trim();
            if (v.len() == 40 || v.len() == 64) && v.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(v.to_ascii_lowercase());
            }
        }
    }
    None
}

struct Done {
    sha: Option<String>,
    files: usize,
    bytes: u64,
}

fn unpack_into(reader: impl Read, tmp: &Path) -> Result<Done, String> {
    let hit = Arc::new(AtomicBool::new(false));
    let gz = GzDecoder::new(Cap { inner: reader, left: MAX_COMPRESSED, hit: hit.clone() });
    // Tar headers and padding come on top of the files themselves.
    let mut ar = Archive::new(Cap { inner: gz, left: MAX_UNPACKED + 8 * 1024 * 1024, hit: hit.clone() });
    let too_big = || if hit.load(Ordering::Relaxed) { TOO_BIG.to_string() } else { NOT_ARCHIVE.to_string() };
    let entries = ar.entries().map_err(|_| too_big())?;
    let (mut sha, mut files, mut total) = (None, 0usize, 0u64);
    for entry in entries {
        let mut e = entry.map_err(|_| too_big())?;
        let kind = e.header().entry_type();
        if kind == EntryType::XGlobalHeader {
            let mut data = Vec::new();
            let _ = (&mut e).take(64 * 1024).read_to_end(&mut data);
            if sha.is_none() {
                sha = sha_from_pax(&data);
            }
            continue;
        }
        let is_dir = match kind {
            EntryType::Directory => true,
            EntryType::Regular | EntryType::Continuous => false,
            _ => return Err(UNSAFE.into()),
        };
        let path = e.path().map_err(|_| UNSAFE.to_string())?.into_owned();
        let mut parts: Vec<String> = Vec::new();
        for c in path.components() {
            match c {
                Component::Normal(n) => parts.push(n.to_str().ok_or_else(|| UNSAFE.to_string())?.to_string()),
                Component::CurDir => {}
                _ => return Err(UNSAFE.into()),
            }
        }
        // The first part is GitHub's own folder (`repo-sha`); everything is stored below it.
        if parts.is_empty() {
            continue;
        }
        let top = parts.remove(0);
        if bad_name(&top) {
            return Err(UNSAFE.into());
        }
        if parts.is_empty() {
            if is_dir {
                continue;
            }
            return Err(UNSAFE.into());
        }
        if parts.len() > MAX_DEPTH || parts.iter().any(|p| bad_name(p)) {
            return Err(UNSAFE.into());
        }
        let mut dest = tmp.to_path_buf();
        for p in &parts {
            dest.push(p);
        }
        // Belt and braces: every part is a plain name, so this holds; refuse if it ever does not.
        if !dest.starts_with(tmp) {
            return Err(UNSAFE.into());
        }
        if is_dir {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            continue;
        }
        files += 1;
        if files > MAX_FILES {
            return Err(TOO_MANY.into());
        }
        if e.header().size().unwrap_or(u64::MAX) > MAX_FILE {
            return Err(FILE_TOO_BIG.into());
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&dest).map_err(|_| UNSAFE.to_string())?;
        let n = io::copy(&mut (&mut e).take(MAX_FILE + 1), &mut out).map_err(|_| too_big())?;
        if n > MAX_FILE {
            return Err(FILE_TOO_BIG.into());
        }
        total += n;
        if total > MAX_UNPACKED {
            return Err(TOO_BIG.into());
        }
    }
    if files == 0 {
        return Err(NOT_ARCHIVE.into());
    }
    Ok(Done { sha, files, bytes: total })
}

/// Unpack a `.tar.gz` stream into `<staging_root>/<prefix>-<sha12>/` (reused when it is already
/// there). On any refusal nothing is left in `staging_root`.
pub fn unpack(reader: impl Read, staging_root: &Path, prefix: &str) -> Result<Unpacked, String> {
    fs::create_dir_all(staging_root).map_err(|e| e.to_string())?;
    let tmp = staging_root.join(format!(".part-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir(&tmp).map_err(|e| e.to_string())?;
    let done = match unpack_into(reader, &tmp) {
        Ok(d) => d,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(e);
        }
    };
    let tag = match &done.sha {
        Some(s) => s.chars().take(12).collect::<String>(),
        None => {
            // The server named no commit: a name that is unique to this download.
            let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            format!("t{ms:x}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
        }
    };
    let dir = staging_root.join(format!("{prefix}-{tag}"));
    if dir.exists() {
        // Content-addressed: the same commit is already staged.
        let _ = fs::remove_dir_all(&tmp);
    } else if let Err(e) = fs::rename(&tmp, &dir) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e.to_string());
    }
    Ok(Unpacked { dir, sha: done.sha, files: done.files, bytes: done.bytes })
}

const USED_MARK: &str = ".atlas-used";

/// Remove staged repositories nobody has used for `max_age` (and any half-made `.part-*`).
pub fn prune(staging_root: &Path, max_age: std::time::Duration) {
    let Ok(rd) = fs::read_dir(staging_root) else { return };
    let now = std::time::SystemTime::now();
    for e in rd.flatten() {
        let p = e.path();
        let used = fs::metadata(p.join(USED_MARK)).or_else(|_| e.metadata()).and_then(|m| m.modified());
        let stale = used.ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|d| d > max_age);
        if stale && p.is_dir() {
            let _ = fs::remove_dir_all(&p);
        }
    }
}

/// Mark a staged folder as used now, so `prune` keeps it.
pub fn touch(dir: &Path) {
    let _ = fs::write(dir.join(USED_MARK), b"");
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use tar::{Builder, Header};

    pub const SHA: &str = "0412be76f50ab4f4f8abff3753efa9269fbbca5b";

    /// A raw tar entry with exactly this name (the builder would refuse `..` and absolute names).
    pub fn raw(b: &mut Builder<Vec<u8>>, name: &str, kind: EntryType, data: &[u8], link: Option<&str>) {
        let mut h = Header::new_gnu();
        h.set_entry_type(kind);
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        let n = name.as_bytes();
        h.as_old_mut().name[..n.len()].copy_from_slice(n);
        if let Some(l) = link {
            h.as_old_mut().linkname[..l.len()].copy_from_slice(l.as_bytes());
        }
        h.set_cksum();
        b.append(&h, data).unwrap();
    }

    pub fn global_header(b: &mut Builder<Vec<u8>>, sha: &str) {
        let rec = format!(" comment={sha}\n");
        // The length in front counts itself.
        let total = (1..5).map(|d| rec.len() + d).find(|t| t.to_string().len() == t - rec.len()).unwrap();
        let body = format!("{total}{rec}");
        raw(b, "pax_global_header", EntryType::XGlobalHeader, body.as_bytes(), None);
    }

    pub fn gz(b: Builder<Vec<u8>>) -> Vec<u8> {
        let tar = b.into_inner().unwrap();
        let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
        enc.write_all(&tar).unwrap();
        enc.finish().unwrap()
    }

    /// A good repository: `repo-<sha>/` with a skill folder and an agent.
    pub fn good() -> Vec<u8> {
        let mut b = Builder::new(Vec::new());
        global_header(&mut b, SHA);
        raw(&mut b, "repo-0412be7/", EntryType::Directory, b"", None);
        raw(&mut b, "repo-0412be7/skills/pdf/SKILL.md", EntryType::Regular, b"---\nname: pdf\n---\nRead pdfs\n", None);
        raw(&mut b, "repo-0412be7/skills/pdf/run.py", EntryType::Regular, b"print('hi')\n", None);
        raw(&mut b, "repo-0412be7/agents/a.md", EntryType::Regular, b"agent\n", None);
        gz(b)
    }

    fn staging() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn left_over(root: &Path) -> Vec<String> {
        fs::read_dir(root).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
    }

    #[test]
    fn a_good_archive_is_staged_under_its_commit_with_the_top_folder_stripped() {
        let t = staging();
        let u = unpack(&good()[..], t.path(), "o-r").unwrap();
        assert_eq!(u.sha.as_deref(), Some(SHA));
        assert_eq!(u.files, 3);
        assert_eq!(u.dir.file_name().unwrap().to_string_lossy(), "o-r-0412be76f50a");
        assert_eq!(fs::read(u.dir.join("skills/pdf/run.py")).unwrap(), b"print('hi')\n");
        // The same commit again is reused, not staged twice.
        let again = unpack(&good()[..], t.path(), "o-r").unwrap();
        assert_eq!(again.dir, u.dir);
        assert_eq!(left_over(t.path()), vec!["o-r-0412be76f50a"]);
    }

    #[test]
    fn every_malicious_archive_is_refused_and_leaves_no_staging_folder() {
        let mut cases: Vec<(&str, Vec<u8>, &str)> = Vec::new();
        let mut b = Builder::new(Vec::new());
        raw(&mut b, "r/a.md", EntryType::Regular, b"x", None);
        raw(&mut b, "r/link", EntryType::Symlink, b"", Some("/etc/passwd"));
        cases.push(("symlink", gz(b), UNSAFE));
        let mut b = Builder::new(Vec::new());
        raw(&mut b, "r/a.md", EntryType::Regular, b"x", None);
        raw(&mut b, "r/hard", EntryType::Link, b"", Some("r/a.md"));
        cases.push(("hard link", gz(b), UNSAFE));
        let mut b = Builder::new(Vec::new());
        raw(&mut b, "r/../x", EntryType::Regular, b"x", None);
        cases.push(("dot dot", gz(b), UNSAFE));
        let mut b = Builder::new(Vec::new());
        raw(&mut b, "/abs/x", EntryType::Regular, b"x", None);
        cases.push(("absolute", gz(b), UNSAFE));
        let mut b = Builder::new(Vec::new());
        raw(&mut b, "r/CON", EntryType::Regular, b"x", None);
        cases.push(("CON", gz(b), UNSAFE));
        let mut b = Builder::new(Vec::new());
        raw(&mut b, "r/nul.txt", EntryType::Regular, b"x", None);
        cases.push(("nul.txt", gz(b), UNSAFE));
        let mut b = Builder::new(Vec::new());
        raw(&mut b, "r/a:stream", EntryType::Regular, b"x", None);
        cases.push(("colon", gz(b), UNSAFE));
        let mut b = Builder::new(Vec::new());
        raw(&mut b, "r/dev", EntryType::Char, b"", None);
        cases.push(("device", gz(b), UNSAFE));
        let mut b = Builder::new(Vec::new());
        for i in 0..2001 {
            raw(&mut b, &format!("r/f{i}.txt"), EntryType::Regular, b"x", None);
        }
        cases.push(("2001 files", gz(b), TOO_MANY));
        let mut b = Builder::new(Vec::new());
        for i in 0..11 {
            raw(&mut b, &format!("r/big{i}.bin"), EntryType::Regular, &vec![0u8; 4_900_000], None);
        }
        cases.push(("51 MB", gz(b), TOO_BIG));
        let mut b = Builder::new(Vec::new());
        raw(&mut b, "r/six.bin", EntryType::Regular, &vec![0u8; 6 * 1024 * 1024], None);
        cases.push(("6 MB file", gz(b), FILE_TOO_BIG));
        let deep = format!("r/{}/x.md", vec!["d"; 13].join("/"));
        let mut b = Builder::new(Vec::new());
        raw(&mut b, &deep, EntryType::Regular, b"x", None);
        cases.push(("13 deep", gz(b), UNSAFE));
        cases.push(("not gzip", b"hello this is not an archive".to_vec(), NOT_ARCHIVE));
        for (what, bytes, want) in cases {
            let t = staging();
            let root = t.path().join("fetch");
            let err = unpack(&bytes[..], &root, "o-r").unwrap_err();
            assert_eq!(err, want, "{what}");
            assert!(left_over(&root).is_empty(), "{what} left {:?}", left_over(&root));
        }
    }

    #[test]
    fn a_download_over_the_compressed_cap_is_refused() {
        // Six files that do not compress (random bytes): 29 MB unpacked, over 25 MB compressed.
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut b = Builder::new(Vec::new());
        for i in 0..6 {
            let data: Vec<u8> = (0..4_900_000).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x as u8 }).collect();
            raw(&mut b, &format!("r/rand{i}.bin"), EntryType::Regular, &data, None);
        }
        let bytes = gz(b);
        assert!(bytes.len() as u64 > MAX_COMPRESSED, "the test archive is {} bytes", bytes.len());
        let t = staging();
        assert_eq!(unpack(&bytes[..], t.path(), "o-r").unwrap_err(), TOO_BIG);
        assert!(left_over(t.path()).is_empty());
    }

    #[test]
    fn the_reserved_name_table() {
        for bad in ["CON", "con", "NUL.txt", "aux", "COM1", "lpt9.md", "x.", "x ", "a:b", "a\\b", ""] {
            assert!(bad_name(bad), "{bad:?}");
        }
        for ok in ["SKILL.md", "console.js", "COM10", "comma", "a-b_c.d", ".claude", ".mcp.json"] {
            assert!(!bad_name(ok), "{ok:?}");
        }
    }
}
