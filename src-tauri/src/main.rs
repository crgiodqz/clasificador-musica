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
mod covers;
use audio::{analyze, cut_mp3, Analysis, BUCKETS};

const AUDIO_EXT: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "ogg"];
const IMG_EXT: &[&str] = &["jpg", "jpeg", "png", "webp"];
const MAX_COVER_BYTES: usize = 15 * 1024 * 1024;

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
    root: String,
    rel: String,
    cover: Option<String>,
    analysis: Option<Analysis>,
}

#[derive(Serialize, Clone)]
struct Photo {
    key: String,
    path: String,
}

/// Una carpeta de musica. La primera (key "") es la principal y guarda `.clasificador/`.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Root {
    #[serde(default)]
    path: String,
    #[serde(default)]
    key: String,
    #[serde(default)]
    excluded: Vec<String>,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    roots: Vec<Root>,
    ui: Value,
    /// carpeta principal (roots[0]) o vacia si no hay
    folder: PathBuf,
    /// carpeta principal para la que estan cargados biblioteca/cache/portadas
    data_root: PathBuf,
    library: Value,
    cache: HashMap<String, CacheEntry>,
    app_covers: HashMap<String, String>,
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

fn norm_rel(s: &str) -> String {
    s.replace('\\', "/").trim_matches('/').to_string()
}

/// Lee config.json (formato v3 `roots`+`ui`, o el viejo `{folder}`).
fn load_config(app: &tauri::AppHandle) -> (Vec<Root>, Value) {
    let mut roots: Vec<Root> = Vec::new();
    let mut ui = json!({});
    let Some(p) = config_path(app) else { return (roots, ui) };
    let Ok(s) = fs::read_to_string(&p) else { return (roots, ui) };
    let Ok(v) = serde_json::from_str::<Value>(&s) else { return (roots, ui) };
    if let Some(arr) = v.get("roots").and_then(|r| r.as_array()) {
        for r in arr {
            if let Ok(mut root) = serde_json::from_value::<Root>(r.clone()) {
                if root.path.is_empty() {
                    continue;
                }
                root.excluded = root.excluded.iter().map(|e| norm_rel(e)).filter(|e| !e.is_empty()).collect();
                roots.push(root);
            }
        }
        // la principal siempre es la primera y con key vacia
        if let Some(first) = roots.first_mut() {
            first.key = String::new();
        }
        let mut seen = HashSet::new();
        let mut i = 0;
        roots.retain(|r| {
            let first = i == 0;
            i += 1;
            first || (!r.key.is_empty() && seen.insert(r.key.clone()))
        });
    } else if let Some(f) = v.get("folder").and_then(|f| f.as_str()) {
        if !f.is_empty() {
            roots.push(Root { path: f.to_string(), key: String::new(), excluded: vec![] });
        }
    }
    if let Some(u) = v.get("ui") {
        if u.is_object() {
            ui = u.clone();
        }
    }
    (roots, ui)
}

fn save_config(app: &tauri::AppHandle, inner: &Inner) {
    if let Some(p) = config_path(app) {
        if let Some(d) = p.parent() {
            let _ = fs::create_dir_all(d);
        }
        let main = inner.roots.first().map(|r| r.path.clone()).unwrap_or_default();
        let v = json!({ "folder": main, "roots": inner.roots, "ui": inner.ui });
        if let Ok(s) = serde_json::to_vec_pretty(&v) {
            let _ = write_atomic(&p, &s);
        }
    }
}

fn root_key_of(id: &str) -> &str {
    match id.find("::") {
        Some(i) => &id[..i],
        None => "",
    }
}

fn make_id(key: &str, rel: &str) -> String {
    if key.is_empty() { rel.to_string() } else { format!("{}::{}", key, rel) }
}

fn is_excluded(root: &Root, rel_dir: &str) -> bool {
    root.excluded.iter().any(|x| rel_dir == x || rel_dir.starts_with(&format!("{}/", x)))
}

/// Ruta absoluta de un id (para saber si el archivo sigue existiendo).
fn path_of_id(roots: &[Root], id: &str) -> Option<PathBuf> {
    let key = root_key_of(id);
    let rel = if key.is_empty() { id } else { &id[key.len() + 2..] };
    roots.iter().find(|r| r.key == key).map(|r| Path::new(&r.path).join(rel))
}

fn main_ok(inner: &Inner) -> bool {
    !inner.folder.as_os_str().is_empty() && inner.folder.is_dir()
}

fn sync_main(inner: &mut Inner) {
    inner.folder = inner.roots.first().map(|r| PathBuf::from(&r.path)).unwrap_or_default();
}

fn new_key(roots: &[Root], path: &str) -> String {
    let base = covers::fnv1a(&[path.to_lowercase().as_bytes()]);
    let mut n = base;
    loop {
        let k = format!("{:06x}", n & 0xFFFFFF);
        if !roots.iter().any(|r| r.key == k) {
            return k;
        }
        n = n.wrapping_add(1);
    }
}

fn empty_state(inner: &Inner) -> Value {
    json!({
        "folder": inner.folder.to_string_lossy(),
        "files": [],
        "photos": [],
        "library": default_library(),
        "pending": 0,
        "needs_folder": true,
        "roots": roots_json(inner),
        "ui": inner.ui
    })
}

fn roots_json(inner: &Inner) -> Value {
    Value::Array(
        inner
            .roots
            .iter()
            .map(|r| json!({ "path": r.path, "key": r.key, "excluded": r.excluded, "exists": Path::new(&r.path).is_dir() }))
            .collect(),
    )
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

/// Lee ondas.json. Las entradas sin `lead` (analisis viejos) se descartan: se re-analizan en segundo plano.
fn load_cache(folder: &Path) -> HashMap<String, CacheEntry> {
    let p = data_dir(folder).join("ondas.json");
    let mut out = HashMap::new();
    let Some(v) = fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { return out };
    let Some(obj) = v.as_object() else { return out };
    for (k, e) in obj {
        let has_lead = e.get("analysis").and_then(|a| a.get("lead")).map(|l| l.is_number()).unwrap_or(false);
        if !has_lead {
            continue;
        }
        if let Ok(ce) = serde_json::from_value::<CacheEntry>(e.clone()) {
            out.insert(k.clone(), ce);
        }
    }
    out
}

fn load_app_covers(folder: &Path) -> HashMap<String, String> {
    let p = data_dir(folder).join("portadas").join("portadas.json");
    fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_app_covers(folder: &Path, m: &HashMap<String, String>) {
    let dir = data_dir(folder).join("portadas");
    let _ = fs::create_dir_all(&dir);
    if let Ok(s) = serde_json::to_vec_pretty(m) {
        let _ = write_atomic(&dir.join("portadas.json"), &s);
    }
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
            cat("copyright", "Reclamos", "#b4a7d6", true, &["Sin reclamos YouTube", "Sin reclamos TikTok", "Reclamo YouTube", "Reclamo TikTok"]),
            cat("usado", "Usado en", "#f6b26b", true, &[])
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

fn walk(dir: &Path, rel_dir: &str, root: &Root, files: &mut Vec<FileInfo>, photos: &mut Vec<Photo>, depth: u32) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let fname = e.file_name().to_string_lossy().to_string();
        if fname.starts_with('.') {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let rel = if rel_dir.is_empty() { fname.clone() } else { format!("{}/{}", rel_dir, fname) };
        if meta.is_dir() {
            if depth < 6 && !is_excluded(root, &rel) {
                walk(&p, &rel, root, files, photos, depth + 1);
            }
            continue;
        }
        let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        let stem = p.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        if AUDIO_EXT.contains(&ext.as_str()) {
            files.push(FileInfo {
                id: make_id(&root.key, &rel),
                path: p.to_string_lossy().to_string(),
                name: stem,
                ext,
                size: meta.len(),
                mtime: mtime_of(&meta),
                root: root.key.clone(),
                rel,
                cover: None,
                analysis: None,
            });
        } else if IMG_EXT.contains(&ext.as_str()) {
            let key = stem.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.').trim().to_lowercase();
            photos.push(Photo { key, path: p.to_string_lossy().to_string() });
        }
    }
}

fn emb_hash(f: &FileInfo) -> String {
    format!("{:016x}", covers::fnv1a(&[f.id.as_bytes(), f.size.to_string().as_bytes(), f.mtime.to_string().as_bytes()]))
}

/// Asigna `cover` a cada archivo: portada de la app > embebida (extraida una sola vez) > null.
fn resolve_covers(inner: &mut Inner) {
    let data = data_dir(&inner.folder);
    let emb = data.join("portadas").join("emb");
    // indice de lo ya extraido: hash -> extension ("none" = sin portada)
    let mut idx: HashMap<String, String> = HashMap::new();
    if let Ok(rd) = fs::read_dir(&emb) {
        for e in rd.flatten() {
            let p = e.path();
            if let (Some(stem), Some(ext)) = (p.file_stem(), p.extension()) {
                idx.insert(stem.to_string_lossy().to_string(), ext.to_string_lossy().to_string());
            }
        }
    }
    let todo: Vec<(String, String)> = inner
        .files
        .iter()
        .map(|f| (emb_hash(f), f.path.clone()))
        .filter(|(h, _)| !idx.contains_key(h))
        .collect();
    if !todo.is_empty() {
        let _ = fs::create_dir_all(&emb);
        use rayon::prelude::*;
        let found: Vec<(String, String)> = todo
            .par_iter()
            .map(|(h, path)| {
                let ext = match std::panic::catch_unwind(|| covers::extract_embedded(Path::new(path))) {
                    Ok(Some((bytes, ext))) => {
                        if fs::write(emb.join(format!("{}.{}", h, ext)), bytes).is_ok() { ext.to_string() } else { "none".to_string() }
                    }
                    _ => "none".to_string(),
                };
                if ext == "none" {
                    let _ = fs::write(emb.join(format!("{}.none", h)), b"");
                }
                (h.clone(), ext)
            })
            .collect();
        for (h, e) in found {
            idx.insert(h, e);
        }
    }
    let portadas = data.join("portadas");
    for f in inner.files.iter_mut() {
        f.cover = None;
        if let Some(name) = inner.app_covers.get(&f.id) {
            let p = portadas.join(name);
            if p.is_file() {
                f.cover = Some(p.to_string_lossy().to_string());
                continue;
            }
        }
        let h = emb_hash(f);
        if let Some(ext) = idx.get(&h) {
            if ext != "none" {
                f.cover = Some(emb.join(format!("{}.{}", h, ext)).to_string_lossy().to_string());
            }
        }
    }
}

/// Rescans every root, migrates tags of renamed files (same size, same root), seeds suggestions.
fn scan(inner: &mut Inner) -> Vec<Photo> {
    let mut files = Vec::new();
    let mut photos = Vec::new();
    let main = inner.folder.clone();
    for r in inner.roots.iter() {
        let rp = Path::new(&r.path);
        if rp.is_dir() {
            walk(rp, "", r, &mut files, &mut photos, 0);
        }
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let ids: HashSet<String> = files.iter().map(|f| f.id.clone()).collect();
    let mut lib_changed = false;
    let mut cache_changed = false;

    // Migrate renamed files: an orphaned cache entry (its file is gone) whose size matches ONE new file of the same root.
    let orphan_cache: Vec<(String, u64)> = inner
        .cache
        .iter()
        .filter(|(k, _)| !ids.contains(*k))
        .filter(|(k, _)| path_of_id(&inner.roots, k).map(|p| !p.exists()).unwrap_or(false))
        .map(|(k, v)| (k.clone(), v.size))
        .collect();
    for (old, size) in orphan_cache {
        let old_root = root_key_of(&old).to_string();
        let candidates: Vec<&FileInfo> = files
            .iter()
            .filter(|f| f.root == old_root && f.size == size && !inner.cache.contains_key(&f.id))
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
                    tracks.entry(new_id.clone()).or_insert(t);
                    lib_changed = true;
                }
            }
            if let Some(c) = inner.app_covers.remove(&old) {
                inner.app_covers.insert(new_id, c);
                save_app_covers(&main, &inner.app_covers);
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
    resolve_covers(inner);
    if lib_changed {
        save_library_file(&main, &inner.library);
    }
    if cache_changed {
        save_cache_file(&main, &inner.cache);
    }
    photos
}

fn state_json(inner: &Inner, photos: &[Photo]) -> Value {
    let pending = inner.files.iter().filter(|f| f.analysis.is_none()).count();
    let library = if inner.library.is_null() { default_library() } else { inner.library.clone() };
    json!({
        "folder": inner.folder.to_string_lossy(),
        "files": inner.files,
        "photos": photos,
        "library": library,
        "pending": pending,
        "needs_folder": !main_ok(inner),
        "roots": roots_json(inner),
        "ui": inner.ui
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
                    lead: 0.0,
                });
                {
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
                }
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

/// Carga la config la primera vez, (re)carga los datos de la carpeta principal si cambio, y escanea.
fn refresh(app: &tauri::AppHandle, st: &AppState) -> Value {
    let v = {
        let mut inner = st.inner.lock().unwrap();
        if !inner.loaded {
            let (roots, ui) = load_config(app);
            inner.roots = roots;
            inner.ui = ui;
            inner.loaded = true;
        }
        sync_main(&mut inner);
        if !main_ok(&inner) {
            inner.files.clear();
            empty_state(&inner)
        } else {
            if inner.data_root != inner.folder || inner.library.is_null() {
                let f = inner.folder.clone();
                inner.library = load_library(&f);
                inner.cache = load_cache(&f);
                inner.app_covers = load_app_covers(&f);
                inner.data_root = f;
            }
            let photos = scan(&mut inner);
            state_json(&inner, &photos)
        }
    };
    spawn_analysis(app.clone(), st.clone());
    v
}

#[tauri::command]
async fn get_state(app: tauri::AppHandle, st: TState<'_, AppState>) -> Result<Value, String> {
    let st = st.inner().clone();
    Ok(refresh(&app, &st))
}

#[tauri::command]
async fn rescan(app: tauri::AppHandle, st: TState<'_, AppState>) -> Result<Value, String> {
    let st = st.inner().clone();
    Ok(refresh(&app, &st))
}

fn pick_dir(app: &tauri::AppHandle, start: Option<PathBuf>) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let mut dlg = app.dialog().file();
    match start {
        Some(d) if d.is_dir() => dlg = dlg.set_directory(&d),
        _ => {
            if let Ok(a) = app.path().audio_dir() {
                dlg = dlg.set_directory(a);
            }
        }
    }
    dlg.blocking_pick_folder().and_then(|p| p.into_path().ok())
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, st: TState<'_, AppState>) -> Result<Option<Value>, String> {
    let st = st.inner().clone();
    ensure_config(&app, &st);
    let current = st.inner.lock().unwrap().folder.clone();
    let Some(p) = pick_dir(&app, Some(current)) else { return Ok(None) };
    {
        let mut inner = st.inner.lock().unwrap();
        let ps = p.to_string_lossy().to_string();
        // si la carpeta elegida ya era una extra, deja de ser extra
        inner.roots.retain(|r| r.key.is_empty() || r.path != ps);
        if inner.roots.is_empty() {
            inner.roots.push(Root { path: ps, key: String::new(), excluded: vec![] });
        } else if inner.roots[0].path != ps {
            inner.roots[0] = Root { path: ps, key: String::new(), excluded: vec![] };
        }
        save_config(&app, &inner);
    }
    Ok(Some(refresh(&app, &st)))
}

fn ensure_config(app: &tauri::AppHandle, st: &AppState) {
    let mut inner = st.inner.lock().unwrap();
    if !inner.loaded {
        let (roots, ui) = load_config(app);
        inner.roots = roots;
        inner.ui = ui;
        inner.loaded = true;
        sync_main(&mut inner);
    }
}

#[tauri::command]
async fn add_root(app: tauri::AppHandle, st: TState<'_, AppState>) -> Result<Option<Value>, String> {
    let st = st.inner().clone();
    ensure_config(&app, &st);
    {
        let inner = st.inner.lock().unwrap();
        if inner.roots.is_empty() {
            return Err("Primero elegí la carpeta principal de tu música".into());
        }
    }
    let Some(p) = pick_dir(&app, None) else { return Ok(None) };
    {
        let mut inner = st.inner.lock().unwrap();
        let ps = p.to_string_lossy().to_string();
        if !inner.roots.iter().any(|r| r.path.eq_ignore_ascii_case(&ps)) {
            let key = new_key(&inner.roots, &ps);
            inner.roots.push(Root { path: ps, key, excluded: vec![] });
            save_config(&app, &inner);
        }
    }
    Ok(Some(refresh(&app, &st)))
}

#[tauri::command]
async fn remove_root(app: tauri::AppHandle, st: TState<'_, AppState>, key: String) -> Result<Value, String> {
    let st = st.inner().clone();
    ensure_config(&app, &st);
    if key.is_empty() {
        return Err("La carpeta principal no se quita: cambiala con \"Cambiar carpeta principal\".".into());
    }
    {
        let mut inner = st.inner.lock().unwrap();
        inner.roots.retain(|r| r.key != key);
        save_config(&app, &inner);
    }
    Ok(refresh(&app, &st))
}

#[tauri::command]
async fn set_excluded(app: tauri::AppHandle, st: TState<'_, AppState>, key: String, excluded: Vec<String>) -> Result<Value, String> {
    let st = st.inner().clone();
    ensure_config(&app, &st);
    {
        let mut inner = st.inner.lock().unwrap();
        let mut list: Vec<String> = Vec::new();
        for e in excluded.iter().map(|e| norm_rel(e)) {
            if !e.is_empty() && !list.contains(&e) {
                list.push(e);
            }
        }
        let Some(r) = inner.roots.iter_mut().find(|r| r.key == key) else { return Err("No encuentro esa carpeta".into()) };
        r.excluded = list;
        save_config(&app, &inner);
    }
    Ok(refresh(&app, &st))
}

/// Pre-orden: cada subcarpeta (con audios en ella o debajo) con su profundidad y los audios que tiene directamente.
fn subs_rec(dir: &Path, rel: &str, depth: u32, out: &mut Vec<Value>) -> u64 {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    let mut direct = 0u64;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            dirs.push((name, e.path()));
        } else if let Some(x) = e.path().extension() {
            if AUDIO_EXT.contains(&x.to_string_lossy().to_lowercase().as_str()) {
                direct += 1;
            }
        }
    }
    dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    let mut total = direct;
    for (name, p) in dirs {
        if depth >= 6 {
            break;
        }
        let child = if rel.is_empty() { name } else { format!("{}/{}", rel, name) };
        let idx = out.len();
        out.push(Value::Null);
        let sub = subs_rec(&p, &child, depth + 1, out);
        // audios directos de la hija = total de la hija menos los de sus propias hijas; se recalculan al leer
        let own = count_audio(&p);
        if sub == 0 {
            out.truncate(idx);
        } else {
            out[idx] = json!({ "rel": child, "depth": depth, "audio": own });
        }
        total += sub;
    }
    total
}

fn count_audio(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .filter(|e| {
                    e.path().extension().map(|x| AUDIO_EXT.contains(&x.to_string_lossy().to_lowercase().as_str())).unwrap_or(false)
                        && e.metadata().map(|m| m.is_file()).unwrap_or(false)
                })
                .count() as u64
        })
        .unwrap_or(0)
}

#[tauri::command]
async fn list_subfolders(app: tauri::AppHandle, st: TState<'_, AppState>, key: String) -> Result<Vec<Value>, String> {
    let st = st.inner().clone();
    ensure_config(&app, &st);
    let path = {
        let inner = st.inner.lock().unwrap();
        inner.roots.iter().find(|r| r.key == key).map(|r| PathBuf::from(&r.path))
    };
    let Some(path) = path else { return Err("No encuentro esa carpeta".into()) };
    if !path.is_dir() {
        return Err("No encuentro la carpeta (¿el disco está conectado?)".into());
    }
    let mut out = Vec::new();
    subs_rec(&path, "", 0, &mut out);
    Ok(out)
}

#[tauri::command]
async fn save_ui_settings(app: tauri::AppHandle, st: TState<'_, AppState>, ui: Value) -> Result<(), String> {
    let st = st.inner().clone();
    ensure_config(&app, &st);
    let mut inner = st.inner.lock().unwrap();
    inner.ui = ui;
    save_config(&app, &inner);
    Ok(())
}

#[tauri::command]
async fn save_library(library: Value, st: TState<'_, AppState>) -> Result<(), String> {
    let mut inner = st.inner.lock().unwrap();
    inner.library = library;
    save_library_file(&inner.folder.clone(), &inner.library);
    Ok(())
}

// ---------- portadas y renombrar ----------

fn is_bad_name_char(c: char) -> bool {
    matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 32
}

#[tauri::command]
async fn rename_track(app: tauri::AppHandle, st: TState<'_, AppState>, id: String, name: String) -> Result<Value, String> {
    let st = st.inner().clone();
    let name = name.trim().to_string();
    let new_id = {
        let mut inner = st.inner.lock().unwrap();
        let f = inner.files.iter().find(|f| f.id == id).cloned().ok_or("No encuentro el tema")?;
        if name.is_empty() {
            return Err("El nombre no puede estar vacío".into());
        }
        if name.chars().any(is_bad_name_char) {
            return Err("El nombre tiene caracteres que Windows no permite: \\ / : * ? \" < > |".into());
        }
        if name.ends_with('.') || name.chars().count() > 180 {
            return Err("El nombre no es válido (no puede terminar en punto ni ser tan largo)".into());
        }
        let old_path = PathBuf::from(&f.path);
        let ext = old_path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        let file_name = if ext.is_empty() { name.clone() } else { format!("{}.{}", name, ext) };
        let new_path = old_path.with_file_name(&file_name);
        if new_path != old_path {
            let same_file_other_case = new_path.to_string_lossy().to_lowercase() == old_path.to_string_lossy().to_lowercase();
            if new_path.exists() && !same_file_other_case {
                return Err("Ya existe un tema con ese nombre".into());
            }
            fs::rename(&old_path, &new_path)
                .map_err(|e| format!("No pude renombrar el archivo (¿está abierto en otro programa?): {}", e))?;
        }
        let new_rel = match f.rel.rfind('/') {
            Some(i) => format!("{}/{}", &f.rel[..i], file_name),
            None => file_name.clone(),
        };
        let new_id = make_id(&f.root, &new_rel);
        if new_id != id {
            if let Some(tracks) = inner.library.get_mut("tracks").and_then(|t| t.as_object_mut()) {
                if let Some(t) = tracks.remove(&id) {
                    tracks.insert(new_id.clone(), t);
                }
            }
            if let Some(c) = inner.cache.remove(&id) {
                inner.cache.insert(new_id.clone(), c);
            }
            if let Some(c) = inner.app_covers.remove(&id) {
                inner.app_covers.insert(new_id.clone(), c);
            }
        }
        let main = inner.folder.clone();
        save_library_file(&main, &inner.library);
        save_cache_file(&main, &inner.cache);
        save_app_covers(&main, &inner.app_covers);
        new_id
    };
    let state = refresh(&app, &st);
    Ok(json!({ "id": new_id, "state": state }))
}

#[tauri::command]
async fn set_cover(
    st: TState<'_, AppState>,
    id: String,
    mode: String,
    path: Option<String>,
    data: Option<String>,
    ext: Option<String>,
) -> Result<Value, String> {
    use base64::Engine;
    let st = st.inner().clone();
    let bytes: Vec<u8> = if let Some(d) = data {
        base64::engine::general_purpose::STANDARD.decode(d.trim()).map_err(|_| "La imagen no se pudo leer".to_string())?
    } else if let Some(p) = path {
        let meta = fs::metadata(&p).map_err(|_| "No pude abrir la imagen".to_string())?;
        if meta.len() as usize > MAX_COVER_BYTES {
            return Err("La imagen es demasiado grande (máximo 15 MB)".into());
        }
        fs::read(&p).map_err(|_| "No pude abrir la imagen".to_string())?
    } else {
        return Err("No llegó ninguna imagen".into());
    };
    if bytes.is_empty() {
        return Err("La imagen está vacía".into());
    }
    if bytes.len() > MAX_COVER_BYTES {
        return Err("La imagen es demasiado grande (máximo 15 MB)".into());
    }
    let _ = ext;
    let img_ext: &str = match covers::sniff_ext(&bytes) {
        Some(e) if e == "jpg" || e == "png" || e == "webp" => e,
        _ => return Err("La imagen no es válida (usá JPG, PNG o WebP)".into()),
    };

    let mut inner = st.inner.lock().unwrap();
    let main = inner.folder.clone();
    if !main_ok(&inner) {
        return Err("Primero elegí la carpeta de tu música".into());
    }
    let idx = inner.files.iter().position(|f| f.id == id).ok_or("No encuentro el tema")?;
    let f = inner.files[idx].clone();
    let mut warning: Option<&str> = None;
    let mut in_file = false;

    if mode == "file" {
        let supported = ["mp3", "m4a", "flac", "ogg"].contains(&f.ext.as_str());
        let res = if supported {
            let p = Path::new(&f.path);
            covers::write_front_cover(p, &bytes, img_ext).and_then(|_| {
                if covers::extract_embedded(p).is_some() { Ok(()) } else { Err("no quedó".to_string()) }
            })
        } else {
            Err("formato sin portada interna".to_string())
        };
        match res {
            Ok(()) => in_file = true,
            Err(_) => warning = Some("No pude guardar la portada dentro del archivo; quedó guardada solo en la app."),
        }
    }

    ensure_data_dir(&main);
    let portadas = data_dir(&main).join("portadas");
    let _ = fs::create_dir_all(&portadas);
    if in_file {
        // el archivo cambio: actualizar size/mtime para que no se re-analice ni se tome como renombre
        if let Ok(meta) = fs::metadata(&f.path) {
            let (size, mtime) = (meta.len(), mtime_of(&meta));
            inner.files[idx].size = size;
            inner.files[idx].mtime = mtime;
            if let Some(c) = inner.cache.get_mut(&id) {
                c.size = size;
                c.mtime = mtime;
            }
            let h = emb_hash(&inner.files[idx]);
            let emb = portadas.join("emb");
            let _ = fs::create_dir_all(&emb);
            let target = emb.join(format!("{}.{}", h, img_ext));
            let _ = fs::write(&target, &bytes);
            inner.files[idx].cover = Some(target.to_string_lossy().to_string());
        }
        // la portada del archivo manda: se saca la de la app
        if let Some(old) = inner.app_covers.remove(&id) {
            let _ = fs::remove_file(portadas.join(old));
            save_app_covers(&main, &inner.app_covers);
        }
        save_cache_file(&main, &inner.cache);
    } else {
        let name = format!("app-{:016x}.{}", covers::fnv1a(&[id.as_bytes()]), img_ext);
        let target = portadas.join(&name);
        fs::write(&target, &bytes).map_err(|e| format!("No pude guardar la portada: {}", e))?;
        if let Some(old) = inner.app_covers.insert(id.clone(), name.clone()) {
            if old != name {
                let _ = fs::remove_file(portadas.join(old));
            }
        }
        save_app_covers(&main, &inner.app_covers);
        inner.files[idx].cover = Some(target.to_string_lossy().to_string());
    }

    let mut out = json!({
        "file": inner.files[idx],
        "mode": if in_file { "file" } else { "app" },
        "library": inner.library
    });
    if let Some(w) = warning {
        out["warning"] = json!(w);
    }
    Ok(out)
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
    ensure_config(&app, &st);
    let folder = st.inner.lock().unwrap().folder.clone();
    if !folder.is_dir() {
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
    let state = refresh(&app, &st);
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
    let st: AppState = Arc::new(App { inner: Mutex::new(Inner { library: Value::Null, ui: json!({}), ..Default::default() }), generation: AtomicU64::new(0) });
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
        .setup(|app| {
            // Sin zoom de la pagina con pellizco: la interfaz usa el gesto para hacer zoom en la onda.
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.with_webview(|wv| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings5;
                    use windows_core::Interface;
                    if let Ok(core) = wv.controller().CoreWebView2() {
                        if let Ok(settings) = core.Settings() {
                            if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
                                let _ = s5.SetIsPinchZoomEnabled(false);
                            }
                        }
                    }
                });
            }
            let _ = app;
            Ok(())
        })
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
        .invoke_handler(tauri::generate_handler![
            get_state, rescan, pick_folder, save_library, start_drag, reveal, drag_fragment, save_fragment_wav, save_analysis, import_files, quit,
            add_root, remove_root, set_excluded, list_subfolders, save_ui_settings, set_cover, rename_track
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la app");
}
