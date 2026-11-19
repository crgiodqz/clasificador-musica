use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const BUCKETS: usize = 800;

#[derive(Serialize, Deserialize, Clone)]
pub struct Analysis {
    pub duration: f64,
    pub bpm: Option<u32>,
    pub peaks: Vec<u8>,
    pub rms: Vec<u8>,
}

// ---------- audio analysis ----------

pub fn analyze(path: &Path) -> Option<Analysis> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(e) = path.extension() {
        hint.with_extension(&e.to_string_lossy());
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let mut format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let track_id = track.id;
    let mut rate = track.codec_params.sample_rate.unwrap_or(44100) as f64;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).ok()?;

    const BLOCK: usize = 1024;
    let mut block_max: Vec<f32> = Vec::with_capacity(20000);
    let mut block_sq: Vec<f32> = Vec::with_capacity(20000);
    let (mut cur_max, mut cur_sq, mut cur_n) = (0f32, 0f32, 0usize);
    let mut total: u64 = 0;
    let mut buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => break,
        };
        let spec = *decoded.spec();
        rate = spec.rate as f64;
        let ch = spec.channels.count().max(1);
        let need = decoded.capacity() as u64;
        if buf.as_ref().map(|b| (b.capacity() as u64) < need * ch as u64).unwrap_or(true) {
            buf = Some(SampleBuffer::<f32>::new(need, spec));
        }
        let b = buf.as_mut().unwrap();
        b.copy_interleaved_ref(decoded);
        for frame in b.samples().chunks(ch) {
            let s = frame.iter().sum::<f32>() / ch as f32;
            let a = s.abs();
            if a > cur_max {
                cur_max = a;
            }
            cur_sq += s * s;
            cur_n += 1;
            total += 1;
            if cur_n == BLOCK {
                block_max.push(cur_max);
                block_sq.push(cur_sq / BLOCK as f32);
                cur_max = 0.0;
                cur_sq = 0.0;
                cur_n = 0;
            }
        }
    }
    if cur_n > 0 {
        block_max.push(cur_max);
        block_sq.push(cur_sq / cur_n as f32);
    }
    if block_max.is_empty() {
        return None;
    }
    let duration = total as f64 / rate;

    // Resample block stats into fixed buckets.
    let nb = block_max.len();
    let mut peaks = vec![0f32; BUCKETS];
    let mut rms = vec![0f32; BUCKETS];
    for i in 0..BUCKETS {
        let a = i * nb / BUCKETS;
        let b = (((i + 1) * nb) / BUCKETS).max(a + 1).min(nb);
        let mut m = 0f32;
        let mut sq = 0f32;
        for j in a..b {
            m = m.max(block_max[j]);
            sq += block_sq[j];
        }
        peaks[i] = m;
        rms[i] = (sq / (b - a) as f32).sqrt();
    }
    let pmax = peaks.iter().cloned().fold(1e-6, f32::max);
    let rmax = rms.iter().cloned().fold(1e-6, f32::max);
    let peaks_u8 = peaks.iter().map(|v| ((v / pmax) * 255.0).round().clamp(0.0, 255.0) as u8).collect();
    // perceptual-ish curve so quiet passages stay readable
    let rms_u8 = rms.iter().map(|v| ((v / rmax).powf(0.6) * 255.0).round().clamp(0.0, 255.0) as u8).collect();

    let bpm = estimate_bpm(&block_sq, rate / BLOCK as f64);
    Some(Analysis { duration, bpm, peaks: peaks_u8, rms: rms_u8 })
}

/// Onset-envelope autocorrelation tempo estimate (rough; labelled "~" in the UI).
fn estimate_bpm(energy: &[f32], fps: f64) -> Option<u32> {
    if energy.len() < (fps * 8.0) as usize {
        return None;
    }
    let start = energy.len() / 10;
    let end = (start + (fps * 120.0) as usize).min(energy.len());
    let e: Vec<f32> = energy[start..end].iter().map(|v| (v + 1e-9).ln()).collect();
    let mut onset: Vec<f32> = e.windows(2).map(|w| (w[1] - w[0]).max(0.0)).collect();
    let mean = onset.iter().sum::<f32>() / onset.len() as f32;
    for o in onset.iter_mut() {
        *o -= mean;
    }
    let lag_min = (fps * 60.0 / 180.0).floor() as usize;
    let lag_max = (fps * 60.0 / 65.0).ceil() as usize;
    let mut best = (0usize, f32::MIN);
    for lag in lag_min.max(1)..=lag_max.min(onset.len() / 2) {
        let mut s = 0f32;
        for i in 0..onset.len() - lag {
            s += onset[i] * onset[i + lag];
        }
        s /= (onset.len() - lag) as f32;
        let bpm = fps * 60.0 / lag as f64;
        // mild preference for the 90-140 range
        let w = (-((bpm.ln() - 115f64.ln()).powi(2)) / (2.0 * 0.5f64.powi(2))).exp() as f32;
        let score = s * (0.6 + 0.4 * w);
        if score > best.1 {
            best = (lag, score);
        }
    }
    if best.0 == 0 || best.1 <= 0.0 {
        return None;
    }
    Some((fps * 60.0 / best.0 as f64).round() as u32)
}


// ---------- lossless mp3 fragment cutting (frame-level, no re-encode) ----------

struct Frame {
    pos: usize,
    len: usize,
    secs: f64,
}

fn mp3_frame_at(d: &[u8], i: usize) -> Option<(usize, f64)> {
    if i + 4 > d.len() || d[i] != 0xFF || (d[i + 1] & 0xE0) != 0xE0 {
        return None;
    }
    let ver = (d[i + 1] >> 3) & 0b11; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    let layer = (d[i + 1] >> 1) & 0b11; // 1 = Layer III
    if ver == 1 || layer != 1 {
        return None;
    }
    let br_idx = (d[i + 2] >> 4) as usize;
    let sr_idx = ((d[i + 2] >> 2) & 0b11) as usize;
    let pad = ((d[i + 2] >> 1) & 1) as usize;
    if br_idx == 0 || br_idx == 15 || sr_idx == 3 {
        return None;
    }
    const BR1: [usize; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    const BR2: [usize; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const SR: [[usize; 3]; 4] = [[11025, 12000, 8000], [0, 0, 0], [22050, 24000, 16000], [44100, 48000, 32000]];
    let sr = SR[ver as usize][sr_idx];
    let (br, coef, spf) = if ver == 3 { (BR1[br_idx], 144, 1152.0) } else { (BR2[br_idx], 72, 576.0) };
    let len = coef * br * 1000 / sr + pad;
    if len < 24 {
        return None;
    }
    Some((len, spf / sr as f64))
}

fn mp3_frames(d: &[u8]) -> Vec<Frame> {
    let mut i = 0usize;
    if d.len() > 10 && &d[0..3] == b"ID3" {
        let sz = ((d[6] as usize & 0x7F) << 21) | ((d[7] as usize & 0x7F) << 14) | ((d[8] as usize & 0x7F) << 7) | (d[9] as usize & 0x7F);
        i = 10 + sz + if d[5] & 0x10 != 0 { 10 } else { 0 };
    }
    let mut frames = Vec::new();
    let mut t = 0.0;
    let mut first = true;
    while i + 4 <= d.len() {
        if let Some((len, dur)) = mp3_frame_at(d, i) {
            // require the next frame to line up (avoids false syncs), except at EOF
            let next_ok = i + len >= d.len() || mp3_frame_at(d, i + len).is_some();
            if next_ok && i + len <= d.len() {
                let body = &d[i..(i + len).min(i + 64)];
                let is_info = first && body.windows(4).any(|w| w == b"Xing" || w == b"Info" || w == b"VBRI");
                first = false;
                if !is_info {
                    frames.push(Frame { pos: i, len, secs: t });
                    t += dur;
                }
                i += len;
                continue;
            }
        }
        i += 1;
    }
    frames
}

/// Writes the [start, end) range of an mp3 to `out` without re-encoding.
pub fn cut_mp3(src: &Path, start: f64, end: f64, out: &Path) -> Result<(), String> {
    let d = fs::read(src).map_err(|e| e.to_string())?;
    let frames = mp3_frames(&d);
    if frames.is_empty() {
        return Err("No pude leer el mp3".into());
    }
    let (s, e) = if end > start { (start, end) } else { (start, f64::MAX) };
    let mut buf = Vec::with_capacity(d.len() / 4);
    // two extra frames before the start feed the bit reservoir, so the cut starts clean
    let first = frames.iter().position(|f| f.secs >= s).unwrap_or(frames.len()).saturating_sub(2);
    for f in &frames[first..] {
        if f.secs >= e {
            break;
        }
        buf.extend_from_slice(&d[f.pos..f.pos + f.len]);
    }
    if buf.is_empty() {
        return Err("El fragmento quedó vacío".into());
    }
    if let Some(dir) = out.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(out, buf).map_err(|e| e.to_string())
}
