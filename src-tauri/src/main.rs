#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager, State as TState};

mod audio;
use audio::{analyze, cut_mp3, Analysis, BUCKETS};

const AUDIO_EXT: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "ogg"];
const IMG_EXT: &[&str] = &["jpg", "jpeg", "png", "webp"];


#[derive(Serialize, Deserialize, Clone)]
struct CacheEntry {
    size: u64,
    mtime: u64,
    analysis: Analysis,
}

#[derive(Serialize, Clone)]
struct FileInfo {
    id: String,
    path: String,
    name: String,
    ext: String,
    size: u64,
    mtime: u64,
    analysis: Option<Analysis>,
}

#[derive(Serialize, Clone)]
struct Photo {
    key: String,
    path: String,
}

#[derive(Default)]
struct Inner {
    folder: PathBuf,
    library: Value,
    cache: HashMap<String, CacheEntry>,
    files: Vec<FileInfo>,
}

struct App {
    inner: Mutex<Inner>,
    generation: AtomicU64,
}

type AppState = Arc<App>;

// ---------- paths / persistence ----------

fn data_dir(folder: &Path) -> PathBuf {
    folder.join(".clasificador")
}

fn ensure_data_dir(folder: &Path) {
    let d = data_dir(folder);
    if !d.exists() {
        let _ = fs::create_dir_all(&d);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("attrib")
                .arg("+h")
                .arg(&d)
                .creation_flags(0x08000000)
                .status();
        }
    }
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn load_folder(app: &tauri::AppHandle) -> Option<PathBuf> {
    let p = config_path(app)?;
    let s = fs::read_to_string(&p).ok()?;
    let v = serde_json::from_str::<Value>(&s).ok()?;
    let pb = PathBuf::from(v.get("folder")?.as_str()?);
    if pb.is_dir() { Some(pb) } else { None }
}

/// Estado vacío para la primera apertura: todavía no se eligió carpeta.
fn empty_state() -> Value {
    json!({
        "folder": "",
        "files": [],
        "photos": [],
        "library": default_library(),
        "pending": 0,
        "needs_folder": true
    })
}

fn save_folder(app: &tauri::AppHandle, folder: &Path) {
    if let Some(p) = config_path(app) {
        if let Some(d) = p.parent() {
            let _ = fs::create_dir_all(d);
        }
        let _ = fs::write(p, json!({ "folder": folder.to_string_lossy() }).to_string());
    }
}

fn load_library(folder: &Path) -> Value {
    let p = data_dir(folder).join("biblioteca.json");
    if let Ok(s) = fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            if v.get("categories").is_some() {
                return v;
            }
        }
    }
    default_library()
}

/// Days since 1970-01-01 → "YYYY-MM-DD" (Howard Hinnant's civil_from_days).
fn ymd(days: i64) -> String {
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Keeps one copy of the tags per day (last 14 days), in case something goes wrong.
fn daily_backup(folder: &Path) {
    let src = data_dir(folder).join("biblioteca.json");
    if !src.is_file() {
        return;
    }
    let dir = data_dir(folder).join("respaldos");
    let secs = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let day = ymd((secs - 3 * 3600).div_euclid(86400)); // Argentina (UTC-3)
    let dest = dir.join(format!("biblioteca-{}.json", day));
    if dest.exists() {
        return;
    }
    let _ = fs::create_dir_all(&dir);
    let _ = fs::copy(&src, &dest);
    if let Ok(rd) = fs::read_dir(&dir) {
        let mut olds: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "json").unwrap_or(false)).collect();
        olds.sort();
        while olds.len() > 14 {
            let _ = fs::remove_file(olds.remove(0));
        }
    }
}

fn save_library_file(folder: &Path, lib: &Value) {
    ensure_data_dir(folder);
    daily_backup(folder);
    let p = data_dir(folder).join("biblioteca.json");
    if let Ok(s) = serde_json::to_vec_pretty(lib) {
        let _ = write_atomic(&p, &s);
    }
}

fn load_cache(folder: &Path) -> HashMap<String, CacheEntry> {
    let p = data_dir(folder).join("ondas.json");
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cache_file(folder: &Path, cache: &HashMap<String, CacheEntry>) {
    ensure_data_dir(folder);
    let p = data_dir(folder).join("ondas.json");
    if let Ok(s) = serde_json::to_vec(cache) {
        let _ = write_atomic(&p, &s);
    }
}

// ---------- default library + automatic suggestions ----------

fn cat(id: &str, name: &str, color: &str, multi: bool, values: &[&str]) -> Value {
    json!({ "id": id, "name": name, "color": color, "multi": multi, "values": values })
}

fn default_library() -> Value {
    json!({
        "version": 1,
        "categories": [
            cat("artista", "Artista", "#c9a24a", false, &[]),
            cat("tipo", "Tipo", "#6fa8dc", true, &["Académica", "OST anime", "OST videojuego", "OST película", "OST serie", "Tango", "Beat"]),
            cat("emocion", "Emoción", "#e06666", true, &["Épico", "Tenso", "Oscuro", "Melancólico", "Nostálgico", "Triunfal", "Tierno", "Misterioso", "Agresivo", "Solemne"]),
            cat("copy", "Tendencia de copy", "#93c47d", true, &[]),
            cat("copyright", "Reclamos", "#b4a7d6", true, &["Sin reclamos YouTube", "Sin reclamos TikTok", "Reclamo YouTube", "Reclamo TikTok"]),
            cat("usado", "Usado en", "#f6b26b", true, &["Dante Donadel", "MAGA", "FyL", "IPL", "Canal propio"])
        ],
        "tracks": {}
    })
}

/// Guess artist / type from Sergio's naming habits ("DN ...", "FMAB ...", composer first).
fn suggest(name: &str) -> Option<(Option<&'static str>, Option<&'static str>)> {
    let first = name.split_whitespace().next().unwrap_or("");
    let lower = name.to_lowercase();
    let prefixes: &[(&str, &str, &str)] = &[
        ("DN", "Death Note", "OST anime"),
        ("FMAB", "Fullmetal Alchemist: Brotherhood", "OST anime"),
        ("GI", "Genshin Impact", "OST videojuego"),
        ("HH", "Hunter x Hunter", "OST anime"),
        ("Kizu", "Kizumonogatari", "OST anime"),
        ("Bake", "Bakemonogatari", "OST anime"),
        ("Monogatari", "Monogatari", "OST anime"),
        ("Silk", "Silksong", "OST videojuego"),
        ("HMC", "Howl's Moving Castle", "OST película"),
    ];
    for (p, a, t) in prefixes {
        if first == *p {
            return Some((Some(a), Some(t)));
        }
    }
    let composers: &[(&str, &str)] = &[
        ("bach", "Bach"), ("beethoven", "Beethoven"), ("brahms", "Brahms"), ("chopin", "Chopin"),
        ("dvorak", "Dvořák"), ("gershwin", "Gershwin"), ("guastavino", "Guastavino"),
        ("handel", "Händel"), ("holst", "Holst"), ("liszt", "Liszt"), ("mahler", "Mahler"),
        ("moszkowski", "Moszkowski"), ("mozart", "Mozart"), ("k. 626", "Mozart"),
        ("rachmanin", "Rachmaninov"), ("shostakovich", "Shostakovich"), ("sibelius", "Sibelius"),
        ("tchaikovsky", "Tchaikovsky"), ("vivaldi", "Vivaldi"), ("rv 119", "Vivaldi"),
        ("wagner", "Wagner"), ("cello concerto no 2 op 119", "Saint-Saëns"),
    ];
    for (k, a) in composers {
        if lower.starts_with(k) || (k.contains(' ') && lower.contains(k)) {
            return Some((Some(a), Some("Académica")));
        }
    }
    let others: &[(&str, Option<&str>, &str)] = &[
        ("great grey wolf sif", Some("Dark Souls"), "OST videojuego"),
        ("who will know", Some("Shin Godzilla"), "OST película"),
        ("black panther", Some("Black Panther: Wakanda Forever"), "OST película"),
        ("over the garden wall", Some("Over the Garden Wall"), "OST serie"),
        ("café domínguez", Some("Ángel D'Agostino"), "Tango"),
        ("tango ", None, "Tango"),
        ("type beat", None, "Beat"),
    ];
    for (k, a, t) in others {
        if lower.contains(k) {
            return Some((*a, Some(t)));
        }
    }
    if lower.starts_with("mancini") {
        return Some((Some("Mancini"), None));
    }
    None
}

fn add_value(lib: &mut Value, cat_id: &str, v: &str) {
    if let Some(cats) = lib.get_mut("categories").and_then(|c| c.as_array_mut()) {
        for c in cats {
            if c.get("id").and_then(|i| i.as_str()) == Some(cat_id) {
                if let Some(vals) = c.get_mut("values").and_then(|x| x.as_array_mut()) {
                    if !vals.iter().any(|x| x.as_str() == Some(v)) {
                        vals.push(json!(v));
                    }
                }
            }
        }
    }
}

// ---------- scanning ----------

fn mtime_of(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

fn walk(dir: &Path, root: &Path, files: &mut Vec<FileInfo>, photos: &mut Vec<Photo>, depth: u32) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let fname = e.file_name().to_string_lossy().to_string();
        if fname.starts_with('.') {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            if depth < 6 {
                walk(&p, root, files, photos, depth + 1);
            }
            continue;
        }
        let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        let stem = p.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        if AUDIO_EXT.contains(&ext.as_str()) {
            let id = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            files.push(FileInfo {
                id,
                path: p.to_string_lossy().to_string(),
                name: stem,
                ext,
                size: meta.len(),
                mtime: mtime_of(&meta),
                analysis: None,
            });
        } else if IMG_EXT.contains(&ext.as_str()) {
            let key = stem.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.').trim().to_lowercase();
            photos.push(Photo { key, path: p.to_string_lossy().to_string() });
        }
    }
}

/// Rescans the folder, migrates tags of renamed files (same size), seeds suggestions.
fn scan(inner: &mut Inner) -> Vec<Photo> {
    let mut files = Vec::new();
    let mut photos = Vec::new();
    let root = inner.folder.clone();
    walk(&root, &root, &mut files, &mut photos, 0);
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let ids: HashSet<String> = files.iter().map(|f| f.id.clone()).collect();
    let mut lib_changed = false;
    let mut cache_changed = false;

    // Migrate renamed files: an orphaned library/cache entry whose cached size matches a new file.
    let orphan_cache: Vec<(String, u64)> = inner
        .cache
        .iter()
        .filter(|(k, _)| !ids.contains(*k))
        .map(|(k, v)| (k.clone(), v.size))
        .collect();
    for (old, size) in orphan_cache {
        let candidates: Vec<&FileInfo> = files
            .iter()
            .filter(|f| f.size == size && !inner.cache.contains_key(&f.id))
            .collect();
        if candidates.len() == 1 {
            let new_id = candidates[0].id.clone();
            if let Some(mut entry) = inner.cache.remove(&old) {
                entry.mtime = candidates[0].mtime;
                inner.cache.insert(new_id.clone(), entry);
                cache_changed = true;
            }
            if let Some(tracks) = inner.library.get_mut("tracks").and_then(|t| t.as_object_mut()) {
                if let Some(t) = tracks.remove(&old) {
                    tracks.entry(new_id).or_insert(t);
                    lib_changed = true;
                }
            }
        }
    }

    // Seed artist/type suggestions for files that never had an entry.
    let seed: Vec<(String, Option<&str>, Option<&str>, String)> = files
        .iter()
        .filter(|f| inner.library.get("tracks").and_then(|t| t.get(&f.id)).is_none())
        .filter_map(|f| suggest(&f.name).map(|(a, t)| (f.id.clone(), a, t, f.name.clone())))
        .collect();
    for (id, a, t, name) in seed {
        let mut tags = Map::new();
        if let Some(a) = a {
            tags.insert("artista".into(), json!([a]));
            add_value(&mut inner.library, "artista", a);
        }
        if let Some(t) = t {
            tags.insert("tipo".into(), json!([t]));
            add_value(&mut inner.library, "tipo", t);
        }
        let mut claims = vec![];
        if name.starts_with("FMAB") {
            claims.push("Sin reclamos YouTube");
        }
        if name == "HH Requiem Aranea" {
            claims.push("Reclamo TikTok");
        }
        if !claims.is_empty() {
            tags.insert("copyright".into(), json!(claims));
        }
        if let Some(tracks) = inner.library.get_mut("tracks").and_then(|t| t.as_object_mut()) {
            tracks.insert(id, json!({ "tags": tags, "notes": "", "fav": false, "moments": [] }));
            lib_changed = true;
        }
    }

    for f in files.iter_mut() {
        if let Some(c) = inner.cache.get(&f.id) {
            if c.size == f.size {
                f.analysis = Some(c.analysis.clone());
            }
        }
    }
    inner.files = files;
    if lib_changed {
        save_library_file(&root, &inner.library);
    }
    if cache_changed {
        save_cache_file(&root, &inner.cache);
    }
    photos
}

fn state_json(inner: &Inner, photos: &[Photo]) -> Value {
    let pending = inner.files.iter().filter(|f| f.analysis.is_none()).count();
    json!({
        "folder": inner.folder.to_string_lossy(),
        "files": inner.files,
        "photos": photos,
        "library": inner.library,
        "pending": pending
    })
}

fn spawn_analysis(app: tauri::AppHandle, st: AppState) {
    let gen = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let (todo, folder) = {
            let inner = st.inner.lock().unwrap();
            let todo: Vec<FileInfo> = inner.files.iter().filter(|f| f.analysis.is_none()).cloned().collect();
            (todo, inner.folder.clone())
        };
        if todo.is_empty() {
            let _ = app.emit("analysis_done", json!({}));
            return;
        }
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).saturating_sub(1).clamp(1, 3);
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        let done = AtomicU64::new(0);
        pool.install(|| {
            use rayon::prelude::*;
            todo.par_iter().for_each(|f| {
                if st.generation.load(Ordering::SeqCst) != gen {
                    return;
                }
                let a = analyze(Path::new(&f.path)).unwrap_or(Analysis {
                    duration: 0.0,
                    bpm: None,
                    peaks: vec![0; BUCKETS],
                    rms: vec![0; BUCKETS],
                });
                let n = {
                    let mut inner = st.inner.lock().unwrap();
                    if inner.folder != folder {
                        return;
                    }
                    inner.cache.insert(f.id.clone(), CacheEntry { size: f.size, mtime: f.mtime, analysis: a.clone() });
                    if let Some(fi) = inner.files.iter_mut().find(|x| x.id == f.id) {
                        fi.analysis = Some(a.clone());
                    }
                    let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                    if n % 10 == 0 {
                        save_cache_file(&inner.folder, &inner.cache);
                    }
                    n
                };
                let _ = n;
                let _ = app.emit("analysis", json!({ "id": f.id, "analysis": a }));
            });
        });
        let inner = st.inner.lock().unwrap();
        if inner.folder == folder {
            save_cache_file(&inner.folder, &inner.cache);
        }
        let _ = app.emit("analysis_done", json!({}));
    });
}

// ---------- commands ----------

fn load_and_scan(app: &tauri::AppHandle, st: &AppState, folder: PathBuf) -> Value {
    let v = {
        let mut inner = st.inner.lock().unwrap();
        if inner.folder != folder || inner.library.is_null() {
            inner.folder = folder.clone();
            inner.library = load_library(&folder);
            inner.cache = load_cache(&folder);
        }
        let photos = scan(&mut inner);
        state_json(&inner, &photos)
    };
    spawn_analysis(app.clone(), st.clone());
    v
}

#[tauri::command]
async fn get_state(app: tauri::AppHandle, st: TState<'_, AppState>) -> Result<Value, String> {
    let st = st.inner().clone();
    let folder = {
        let inner = st.inner.lock().unwrap();
        if inner.library.is_null() { None } else { Some(inner.folder.clone()) }
    };
    let folder = match folder.or_else(|| load_folder(&app)) {
        Some(f) => f,
        None => return Ok(empty_state()),
    };
    Ok(load_and_scan(&app, &st, folder))
}

#[tauri::command]
async fn rescan(app: tauri::AppHandle, st: TState<'_, AppState>) -> Result<Value, String> {
    let st = st.inner().clone();
    let folder = st.inner.lock().unwrap().folder.clone();
    if folder.as_os_str().is_empty() {
        return Ok(empty_state());
    }
    Ok(load_and_scan(&app, &st, folder))
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, st: TState<'_, AppState>) -> Result<Option<Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    let st = st.inner().clone();
    let current = st.inner.lock().unwrap().folder.clone();
    let mut dlg = app.dialog().file();
    if current.is_dir() {
        dlg = dlg.set_directory(&current);
    } else if let Ok(a) = app.path().audio_dir() {
        dlg = dlg.set_directory(a);
    }
    let picked = dlg.blocking_pick_folder();
    let Some(p) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    save_folder(&app, &p);
    Ok(Some(load_and_scan(&app, &st, p)))
}

#[tauri::command]
async fn save_library(library: Value, st: TState<'_, AppState>) -> Result<(), String> {
    let mut inner = st.inner.lock().unwrap();
    inner.library = library;
    save_library_file(&inner.folder.clone(), &inner.library);
    Ok(())
}

static DRAG_ICON: &[u8] = include_bytes!("../icons/icon.png");

#[tauri::command]
fn start_drag(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("No encuentro el archivo".into());
    }
    let w = window.clone();
    app.run_on_main_thread(move || {
        let _ = drag::start_drag(
            &w,
            drag::DragItem::Files(vec![p]),
            drag::Image::Raw(DRAG_ICON.to_vec()),
            |_, _| {},
            drag::Options::default(),
        );
    })
    .map_err(|e| e.to_string())
}


fn fmt_t(t: f64) -> String {
    let d = (t.max(0.0) * 10.0).round() as u64; // tenths of a second
    let (m, s, f) = (d / 600, (d / 10) % 60, d % 10);
    if f == 0 { format!("{}m{:02}s", m, s) } else { format!("{}m{:02}.{}s", m, s, f) }
}

/// Path where the fragment [start, end) of a track is stored.
fn fragment_path(folder: &Path, file: &FileInfo, start: f64, end: Option<f64>, ext: &str) -> PathBuf {
    let safe: String = file.name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) { '_' } else { c }).collect();
    let span = match end {
        Some(e) if e > start => format!("{}-{}", fmt_t(start), fmt_t(e)),
        _ => format!("{}-fin", fmt_t(start)),
    };
    data_dir(folder).join("fragmentos").join(format!("{} ({}).{}", safe, span, ext))
}

fn is_real_mp3(path: &Path) -> bool {
    let mut b = [0u8; 3];
    use std::io::Read;
    fs::File::open(path).and_then(|mut f| f.read_exact(&mut b)).is_ok() && (&b == b"ID3" || (b[0] == 0xFF && (b[1] & 0xE0) == 0xE0))
}

fn file_and_folder(st: &AppState, id: &str) -> Result<(FileInfo, PathBuf), String> {
    let inner = st.inner.lock().unwrap();
    let f = inner.files.iter().find(|f| f.id == id).cloned().ok_or("No encuentro el tema")?;
    Ok((f, inner.folder.clone()))
}

fn native_drag(app: &tauri::AppHandle, window: &tauri::WebviewWindow, p: PathBuf) -> Result<(), String> {
    let w = window.clone();
    app.run_on_main_thread(move || {
        let _ = drag::start_drag(&w, drag::DragItem::Files(vec![p]), drag::Image::Raw(DRAG_ICON.to_vec()), |_, _| {}, drag::Options::default());
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn drag_fragment(app: tauri::AppHandle, window: tauri::WebviewWindow, st: TState<'_, AppState>, id: String, start: f64, end: Option<f64>) -> Result<(), String> {
    let (f, folder) = file_and_folder(st.inner(), &id)?;
    let src = PathBuf::from(&f.path);
    ensure_data_dir(&folder);
    let wav = fragment_path(&folder, &f, start, end, "wav");
    if wav.is_file() {
        return native_drag(&app, &window, wav);
    }
    if !is_real_mp3(&src) {
        return Err("NEEDS_WAV".into());
    }
    let out = fragment_path(&folder, &f, start, end, "mp3");
    if !out.is_file() {
        cut_mp3(&src, start, end.unwrap_or(-1.0), &out)?;
    }
    native_drag(&app, &window, out)
}

#[tauri::command]
fn save_fragment_wav(st: TState<'_, AppState>, id: String, start: f64, end: Option<f64>, data: String) -> Result<String, String> {
    use base64::Engine;
    let (f, folder) = file_and_folder(st.inner(), &id)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string())?;
    ensure_data_dir(&folder);
    let out = fragment_path(&folder, &f, start, end, "wav");
    if let Some(d) = out.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    fs::write(&out, bytes).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

#[tauri::command]
fn save_analysis(st: TState<'_, AppState>, id: String, analysis: Analysis) -> Result<(), String> {
    let mut inner = st.inner.lock().unwrap();
    let Some(fi) = inner.files.iter_mut().find(|x| x.id == id) else { return Ok(()) };
    fi.analysis = Some(analysis.clone());
    let (size, mtime) = (fi.size, fi.mtime);
    inner.cache.insert(id, CacheEntry { size, mtime, analysis });
    let folder = inner.folder.clone();
    save_cache_file(&folder, &inner.cache);
    Ok(())
}


#[tauri::command]
async fn import_files(app: tauri::AppHandle, st: TState<'_, AppState>, paths: Vec<String>) -> Result<Value, String> {
    let st = st.inner().clone();
    let folder = st.inner.lock().unwrap().folder.clone();
    if folder.as_os_str().is_empty() {
        return Err("Primero elegí la carpeta de tu música".into());
    }
    let (mut added, mut skipped) = (0, 0);
    let mut queue: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    while let Some(p) = queue.pop() {
        if p.is_dir() {
            if let Ok(rd) = fs::read_dir(&p) {
                queue.extend(rd.flatten().map(|e| e.path()));
            }
            continue;
        }
        let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !AUDIO_EXT.contains(&ext.as_str()) || p.starts_with(&folder) {
            skipped += 1;
            continue;
        }
        let Some(name) = p.file_name() else { continue };
        let dest = folder.join(name);
        if dest.exists() {
            skipped += 1;
            continue;
        }
        if fs::copy(&p, &dest).is_ok() {
            added += 1;
        } else {
            skipped += 1;
        }
    }
    let state = load_and_scan(&app, &st, folder);
    Ok(json!({ "state": state, "added": added, "skipped": skipped }))
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
    Ok(())
}

fn main() {
    let st: AppState = Arc::new(App { inner: Mutex::new(Inner { library: Value::Null, ..Default::default() }), generation: AtomicU64::new(0) });
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(st)
        .on_window_event(|window, event| {
            // Give the UI a moment to save pending edits before the window closes.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                static CLOSING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
                if !CLOSING.swap(true, Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("app-closing", ());
                    let app = window.app_handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        app.exit(0);
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_state, rescan, pick_folder, save_library, start_drag, reveal, drag_fragment, save_fragment_wav, save_analysis, import_files, quit])
        .run(tauri::generate_context!())
        .expect("error al iniciar la app");
}
