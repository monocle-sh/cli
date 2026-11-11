//! ELF/DWARF reading and source bundle writing for `monocle debug-files`, compiled to WebAssembly.
//! It uses the symbolic version of the Monocle symbolicator, so the CLI reads debug files exactly as
//! the server does. The module has no imports: JavaScript passes bytes in and reads bytes out.
//!
//! Every call result is `[status: u8][length: u32 LE][payload]`, where status 0 is success with a
//! JSON or binary payload and status 1 is a UTF-8 error message.
use std::io::{self, Cursor, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use symbolic_debuginfo::sourcebundle::{SourceBundleWriter, SourceFileInfo, SourceFileType};
use symbolic_debuginfo::elf::ElfObject;

const MAX_BUNDLE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 4096;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Inspection {
    code_id: Option<String>,
    has_debug_info: bool,
    files: Vec<SourceCandidate>,
    outside_prefix: usize,
    duplicates: usize,
    non_utf8: usize,
}

#[derive(Serialize)]
struct SourceCandidate {
    /// Normalized DWARF path, the key the symbolicator looks frames up with.
    path: String,
    /// Path beneath the source root.
    relative: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleInput {
    code_id: String,
    files: Vec<BundleFile>,
}

#[derive(Deserialize)]
struct BundleFile {
    path: String,
    text: String,
}

/// Compare whole path components, never basenames or a textual prefix such as /build vs /build-other.
/// Backslashes are DWARF separators, as in symbolic's clean_path and join_path.
/// `has_root`, not `is_absolute`: on wasm32-unknown-unknown, `is_absolute` is always false.
fn relative_path(path: &str, prefix: &str) -> Option<PathBuf> {
    let path = path.replace('\\', "/");
    let prefix = prefix.replace('\\', "/");
    let prefix = Path::new(&prefix);
    let mapped = if !Path::new(&path).has_root() && prefix.has_root() {
        symbolic_common::clean_path(&symbolic_common::join_path(prefix.to_str()?, &path)).into_owned()
    } else {
        path
    };
    let path = Path::new(&mapped);
    if path.has_root() != prefix.has_root() {
        return None;
    }
    let relative = path.strip_prefix(prefix).ok()?;
    if relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return None;
    }
    Some(relative.to_owned())
}

/// clean_path("/") is empty in symbolic 13.9. Do not confuse it with a relative prefix.
fn normalize_prefix(prefix: &str) -> String {
    let normalized = symbolic_common::clean_path(prefix).into_owned();
    if normalized.is_empty() && prefix.starts_with('/') {
        "/".to_owned()
    } else {
        normalized
    }
}

fn inspect_inner(data: &[u8], prefix: Option<&str>) -> Result<Inspection, String> {
    if !ElfObject::test(data) {
        return Err("not an ELF file; only Linux ELF/DWARF is supported".into());
    }
    let object = ElfObject::parse(data).map_err(|error| format!("invalid ELF file: {error}"))?;
    let code_id = object.code_id().map(|id| id.to_string());
    let has_debug_info = object.has_debug_info();
    let mut inspection = Inspection {
        code_id,
        has_debug_info,
        files: Vec::new(),
        outside_prefix: 0,
        duplicates: 0,
        non_utf8: 0,
    };
    let Some(prefix) = prefix else { return Ok(inspection) };
    if !has_debug_info {
        return Ok(inspection);
    }
    let prefix = normalize_prefix(prefix);
    let session = object.debug_session().map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    for entry in session.files() {
        let original = entry.map_err(|error| error.to_string())?.abs_path_str();
        // symbolic exposes DWARF paths as lossy strings. Reject replacement characters rather
        // than risk reading a different local file through a lossy path collision.
        if original.contains('\u{fffd}') {
            inspection.non_utf8 += 1;
            continue;
        }
        if !seen.insert(original.clone()) {
            inspection.duplicates += 1;
            continue;
        }
        let Some(relative) = relative_path(&original, &prefix) else {
            inspection.outside_prefix += 1;
            continue;
        };
        if original.len() > MAX_PATH_BYTES {
            return Err("DWARF source path exceeds the 4096 byte limit".into());
        }
        let relative = relative.to_str().ok_or("DWARF source path is not UTF-8")?.to_owned();
        inspection.files.push(SourceCandidate { path: original, relative });
    }
    Ok(inspection)
}

/// Bound compressed output while the ZIP writer writes both contents and its manifest.
#[derive(Default)]
struct BundleBuffer(Cursor<Vec<u8>>);

impl Write for BundleBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.position() > MAX_BUNDLE_BYTES
            || bytes.len() as u64 > MAX_BUNDLE_BYTES.saturating_sub(self.0.position())
        {
            return Err(io::Error::other("compressed source bundle exceeds the 50 MiB limit"));
        }
        self.0.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for BundleBuffer {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.0.seek(from)
    }
}

fn bundle_inner(input: &[u8]) -> Result<Vec<u8>, String> {
    let input: BundleInput = serde_json::from_slice(input).map_err(|error| error.to_string())?;
    let mut output = BundleBuffer::default();
    let mut bundle = SourceBundleWriter::start(&mut output).map_err(|error| error.to_string())?;
    // code_id is the full GNU build ID. debug_id would truncate it to a UUID.
    bundle.set_attribute("code_id", &input.code_id);
    for (index, file) in input.files.iter().enumerate() {
        let mut info = SourceFileInfo::new();
        info.set_ty(SourceFileType::Source);
        // Keep the original DWARF key, not the local checkout or ZIP entry path.
        info.set_path(file.path.clone());
        bundle
            .add_file(format!("source-{}", index + 1), file.text.as_bytes(), info)
            .map_err(|error| error.to_string())?;
    }
    bundle.finish().map_err(|error| error.to_string())?;
    Ok(output.0.into_inner())
}

fn respond(result: Result<Vec<u8>, String>) -> *mut u8 {
    let (status, payload) = match result {
        Ok(bytes) => (0u8, bytes),
        Err(message) => (1u8, message.into_bytes()),
    };
    let mut response = Vec::with_capacity(payload.len() + 5);
    response.push(status);
    response.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    response.extend_from_slice(&payload);
    let mut response = response.into_boxed_slice();
    let pointer = response.as_mut_ptr();
    std::mem::forget(response);
    pointer
}

/// # Safety
/// Takes ownership of a buffer returned by `alloc` with the same length.
unsafe fn take(pointer: *mut u8, length: usize) -> Vec<u8> {
    unsafe { Vec::from_raw_parts(pointer, length, length) }
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(length: usize) -> *mut u8 {
    let mut buffer = vec![0u8; length].into_boxed_slice();
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// # Safety
/// Frees a buffer returned by `alloc`, or a response of `5 + payload length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(pointer: *mut u8, length: usize) {
    drop(unsafe { take(pointer, length) });
}

/// Reads the build ID and, with a prefix, the DWARF source files beneath it.
/// Consumes both input buffers. An empty prefix only reads the build ID and debug info presence.
///
/// # Safety
/// Both buffers must come from `alloc` with these lengths.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn inspect(
    data: *mut u8,
    data_length: usize,
    prefix: *mut u8,
    prefix_length: usize,
) -> *mut u8 {
    let data = unsafe { take(data, data_length) };
    let prefix = unsafe { take(prefix, prefix_length) };
    let result = String::from_utf8(prefix)
        .map_err(|_| "--prefix must be UTF-8".to_owned())
        .and_then(|prefix| {
            let prefix = (!prefix.is_empty()).then_some(prefix.as_str());
            let inspection = inspect_inner(&data, prefix)?;
            serde_json::to_vec(&inspection).map_err(|error| error.to_string())
        });
    drop(data);
    respond(result)
}

/// Writes a source bundle from `{ codeId, files: [{ path, text }] }` JSON. Consumes the input.
///
/// # Safety
/// The buffer must come from `alloc` with this length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bundle(input: *mut u8, length: usize) -> *mut u8 {
    let input = unsafe { take(input, length) };
    respond(bundle_inner(&input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_components_without_basename_fallback() {
        assert_eq!(relative_path("/build/src/main.rs", "/build"), Some("src/main.rs".into()));
        assert_eq!(relative_path("src/main.rs", "/build"), Some("src/main.rs".into()));
        assert_eq!(relative_path("/build-other/main.rs", "/build"), None);
        assert_eq!(relative_path("../secret", "/build"), None);
        assert_eq!(relative_path("/elsewhere/main.rs", ""), None);
        assert_eq!(relative_path("/build/src/main.rs", "/"), Some("build/src/main.rs".into()));
        assert_eq!(normalize_prefix("/"), "/");
    }

    #[test]
    fn compressed_limit_applies_to_writes_and_seeks() {
        let mut output = BundleBuffer::default();
        output.seek(SeekFrom::Start(MAX_BUNDLE_BYTES)).unwrap();
        assert!(output.write_all(b"x").is_err());
    }
}
