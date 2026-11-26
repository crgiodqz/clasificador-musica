//! Portadas: lectura/escritura de la imagen frontal dentro de los archivos de audio (crate `lofty`).

use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::Tag;
use std::path::Path;

/// FNV-1a de 64 bits sobre una lista de trozos de bytes (separados por 0xFF).
pub fn fnv1a(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for b in p.iter() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h ^= 0xFF;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Extension de imagen segun los primeros bytes (jpg, png, webp, gif, bmp).
pub fn sniff_ext(d: &[u8]) -> Option<&'static str> {
    if d.len() >= 3 && d[0] == 0xFF && d[1] == 0xD8 && d[2] == 0xFF {
        Some("jpg")
    } else if d.len() >= 8 && d[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        Some("png")
    } else if d.len() >= 12 && &d[0..4] == b"RIFF" && &d[8..12] == b"WEBP" {
        Some("webp")
    } else if d.len() >= 6 && (&d[0..6] == b"GIF87a" || &d[0..6] == b"GIF89a") {
        Some("gif")
    } else if d.len() >= 2 && &d[0..2] == b"BM" {
        Some("bmp")
    } else {
        None
    }
}

/// Lee solo las etiquetas (sin propiedades de audio) y devuelve la portada frontal
/// (o la primera imagen que haya) con su extension.
pub fn extract_embedded(path: &Path) -> Option<(Vec<u8>, &'static str)> {
    let opts = ParseOptions::new().read_properties(false);
    let probe = Probe::open(path).ok()?.options(opts).guess_file_type().ok()?;
    let tf = probe.read().ok()?;
    let mut best: Option<&Picture> = None;
    for tag in tf.tags() {
        if let Some(p) = tag.get_picture_type(PictureType::CoverFront) {
            if !p.data().is_empty() {
                best = Some(p);
                break;
            }
        }
    }
    if best.is_none() {
        for tag in tf.tags() {
            if let Some(p) = tag.pictures().iter().find(|p| !p.data().is_empty()) {
                best = Some(p);
                break;
            }
        }
    }
    let p = best?;
    let ext = sniff_ext(p.data())?;
    Some((p.data().to_vec(), ext))
}

/// Escribe `data` como portada frontal dentro del archivo, reemplazando la frontal existente.
pub fn write_front_cover(path: &Path, data: &[u8], ext: &str) -> Result<(), String> {
    let probe = Probe::open(path).map_err(|e| e.to_string())?.guess_file_type().map_err(|e| e.to_string())?;
    let mut tf = probe.read().map_err(|e| e.to_string())?;
    if tf.primary_tag().is_none() {
        let tt = tf.primary_tag_type();
        tf.insert_tag(Tag::new(tt));
    }
    let tag = tf.primary_tag_mut().ok_or_else(|| "sin etiquetas".to_string())?;
    let mime = match ext {
        "jpg" | "jpeg" => MimeType::Jpeg,
        "png" => MimeType::Png,
        "gif" => MimeType::Gif,
        "bmp" => MimeType::Bmp,
        other => MimeType::Unknown(format!("image/{}", other)),
    };
    tag.remove_picture_type(PictureType::CoverFront);
    tag.push_picture(Picture::unchecked(data.to_vec()).pic_type(PictureType::CoverFront).mime_type(mime).build());
    tf.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())
}
