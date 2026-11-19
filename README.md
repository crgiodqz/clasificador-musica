# Clasificador de música

App de escritorio liviana (Windows) para clasificar la música de producción de videos: etiquetas propias (artista, emoción, tipo, tendencia de copy, reclamos, usado en), forma de onda, BPM aproximado, momentos marcados por tema y arrastre directo al editor (CapCut).

## Qué hace
- Lee una carpeta de música y guarda todo en una carpeta oculta `.clasificador/` dentro de ella. No modifica los audios.
- Reproducción instantánea y barra con forma de onda para moverse por el tema.
- Momentos (atajos I / O) con nombre y etiquetas; cada uno se arrastra al editor como fragmento recortado (mp3 sin pérdida).
- Categorías y valores personalizables, filtros combinables, botón al azar, arrastrar audios nuevos a la ventana.
- Interfaz carbón y marfil, tipografía Host Grotesk.

## Tecnología
Tauri v2: backend en Rust (symphonia, rayon) e interfaz en HTML, CSS y JavaScript sin librerías.

## Compilar
Carpeta por defecto: se cambia en `DEFAULT_FOLDER` de `src-tauri/src/main.rs` (o con el botón de elegir carpeta dentro de la app).

    cd src-tauri
    cargo build --release

Desde Linux, para generar el .exe: `cargo xwin build --release --target x86_64-pc-windows-msvc`.

Contrato entre interfaz y backend: ver `SPEC.md`.
