# Clasificador de música — contrato entre interfaz y motor

App de escritorio Windows (Tauri v2, sin bundler). La interfaz es HTML/CSS/JS vanilla en `ui/`
(index.html, style.css, app.js). Se usa `window.__TAURI__` (withGlobalTauri = true).
- invoke: `window.__TAURI__.core.invoke(cmd, args)`
- audio: `window.__TAURI__.core.convertFileSrc(absPath)` → URL para <audio src>
- eventos: `window.__TAURI__.event.listen(name, cb)` (cb recibe {payload})

## Comandos
- `get_state()` → State
- `pick_folder()` → State | null   (abre diálogo de carpeta, cambia la carpeta, reescanea)
- `rescan()` → State
- `save_library({ library })` → null   (guarda biblioteca.json; la interfaz debe hacer debounce ~400ms)
- `start_drag({ path })` → null   (arrastre nativo del archivo hacia CapCut/Explorador; llamarlo en `mousedown`+movimiento >5px sobre la fila o un "asa" de arrastre; NO usar drag HTML5)
- `reveal({ path })` → null   (abre el Explorador con el archivo seleccionado)

## State
{
  folder: "C:\\...\\Musica",
  files: [ { id: "GI/Overture of Storms.mp3",  // ruta relativa, clave estable
             path: "C:\\...\\Musica\\GI\\Overture of Storms.mp3",
             name: "Overture of Storms",       // sin extensión
             ext: "mp3", size: 1234, mtime: 1700000000,
             analysis: null | { duration: 183.4, bpm: 128 | null,
                                peaks: [0..255 x 800], rms: [0..255 x 800] } } ],
  photos: [ { key: "bach", path: "C:\\...\\fotito\\1.bach.jpg" } ],  // key = nombre en minúscula sin "1." ni extensión
  library: Library,
  pending: 12   // cuántos archivos faltan analizar
}

## Eventos
- `analysis` payload { id, analysis }  → se emite cada vez que termina de analizar un tema (onda + duración + BPM). Actualizar la fila/la onda en vivo.
- `analysis_done` payload { }  

## Library (lo que la interfaz edita y manda a save_library)
{
  version: 1,
  categories: [ { id: "artista", name: "Artista", color: "#c9a24a", multi: false, values: ["Death Note", ...] }, ... ],
  tracks: { "<file id>": {
      tags: { "<catId>": ["valor", ...] },
      notes: "",
      fav: false,
      moments: [ { id: "m1", start: 192.0, end: 220.5 | null, label: "clímax", tags: { "<catId>": [..] } } ]
  } }
}
Categorías por defecto (el usuario puede crear, renombrar, recolorear, borrar categorías y valores):
artista (single), tipo, emocion, copy ("Tendencia de copy"), copyright ("Reclamos"), usado ("Usado en").
Un track sin entrada en `tracks` = sin etiquetas.

## Comandos nuevos (v2)
- `drag_fragment({ id, start, end })` → null | error
  Corta el tramo [start, end) del tema (segundos; end puede ser null = hasta el final) a un archivo aparte
  en `<carpeta>/.clasificador/fragmentos/` y arranca el arrastre nativo de ESE archivo (igual que start_drag).
  Si el archivo del fragmento ya existe, lo reutiliza. Para mp3 corta sin recodificar (instantáneo).
  Si el tema NO es mp3 real, devuelve el error exacto "NEEDS_WAV".
- `save_fragment_wav({ id, start, end, data })` → path
  `data` = WAV completo en base64 (sin prefijo data:). Lo guarda con el mismo nombre que usaría drag_fragment
  (extensión .wav), así el próximo drag_fragment de ese tramo lo encuentra y arrastra directo.
- `save_analysis({ id, analysis })` → null
  Para temas que el motor no pudo decodificar: llegan con analysis.duration === 0 (peaks todo en 0).
  La interfaz los decodifica ella misma y manda el resultado para que quede cacheado.
- `import_files({ paths })` → { state, added, skipped }  (copia audios soltados en la ventana a la carpeta)
