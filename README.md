# Clasificador de música

Una app para Windows que te ayuda a ordenar y encontrar rápido la música que usás para editar videos. Elegís tu carpeta de música y la app te deja etiquetar cada tema (artista, emoción, tipo, tendencia de copy, lo que quieras), ver su forma de onda, marcar momentos y arrastrarlos directo a tu editor (CapCut, Premiere, DaVinci, etc.).

No necesitás saber de programación. No se instala nada: se descarga un solo archivo y se abre.

## Cómo descargarla

1. Hacé clic acá para descargar: **[Clasificador-de-musica.zip](https://github.com/crgiodqz/clasificador-musica/releases/latest/download/Clasificador-de-musica.zip)**.
2. Abrí el archivo descargado, hacé clic derecho y elegí **Extraer todo**. Va a quedar `Clasificador-de-musica.exe`.
3. Movelo donde quieras (por ejemplo, el Escritorio) y abrilo con doble clic.

### Si Windows muestra "Windows protegió su PC"

Es un aviso normal en apps hechas por una sola persona, que no pagan la firma digital de Microsoft. No quiere decir que tenga un virus. Para abrirla:

1. Hacé clic en **Más información**.
2. Hacé clic en **Ejecutar de todas formas**.

Solo te lo pide la primera vez. Si preferís no confiar, podés leer todo el código en esta misma página: no hace nada más que lo que se describe acá.

## Primer uso

1. Al abrirla, elegí la carpeta donde tenés tu música. Con un clic en **Elegir carpeta de música**.
2. Los temas aparecen enseguida con su forma de onda y su duración. El análisis de los BPM se completa solo en segundo plano.
3. Hacé clic en un tema para escucharlo al instante. Hacé clic sobre la onda de abajo para saltar a cualquier parte.
4. En el panel de la derecha le ponés las etiquetas que quieras. Las categorías y sus valores se crean, se cambian y se borran desde "Gestionar categorías".
5. Para buscar, combinás filtros en la columna de la izquierda.

Apretá **?** dentro de la app para ver todos los atajos de teclado.

## Qué podés hacer

- **Escuchar sin esperas** y moverte por el tema con la onda. Se ve dónde es tranquilo y dónde explota.
- **Marcar momentos:** mientras suena, con **I** marcás el inicio y con **O** el final. Cada momento tiene nombre y etiquetas propias.
- **Arrastrar al editor:** el tema entero, o solo un momento recortado, se arrastra desde la app hasta la línea de tiempo de tu editor.
- **Filtrar:** por cualquier combinación de etiquetas. Si un filtro coincide con un momento, la lista te muestra ese fragmento.
- **Agregar temas nuevos:** soltá audios sobre la ventana y se copian a tu carpeta. Lo que descargues a la carpeta aparece solo al volver a la app.
- **Varias carpetas:** en Configuración podés agregar carpetas extra y destildar las subcarpetas que no querés ver.
- **Portadas:** se muestra la que trae el archivo. Podés cambiarla (botón, pegar o soltar una imagen) y elegir si se guarda dentro del archivo o solo en la app.
- **Renombrar temas:** doble clic en el nombre. Se renombra el archivo y no perdés etiquetas ni momentos.
- **Silencio inicial:** la app detecta cuando un tema arranca con silencio y puede saltearlo al reproducir.
- **Zoom en la onda:** Ctrl + rueda o pellizco del touchpad.
- **Descubrir:** botón **Al azar** (tecla R) para sacar un tema al azar.

## Tus archivos están a salvo

- La app **no mueve ni borra** tu música. Solo toca un archivo si vos le pedís cambiarle el nombre o guardarle una portada adentro.
- Sus datos (etiquetas, ondas, momentos) se guardan en una carpeta oculta llamada `.clasificador` dentro de tu carpeta de música. Si copiás esa carpeta, te llevás todo.
- Una vez por día guarda una copia de las etiquetas (se conservan las de los últimos 14 días).
- No usa internet ni envía nada a ningún lado.

## Detalles a tener en cuenta

- Solo funciona en **Windows 10 u 11**.
- Los BPM son aproximados, sobre todo en música académica o con tempo libre.
- Los fragmentos de mp3 se cortan sin perder calidad. Los de otros formatos (wav, m4a, etc.) salen en wav, y al arrastrarlos por primera vez la app los prepara y hay que arrastrarlos una segunda vez.
- Algunos archivos tienen la extensión equivocada (por ejemplo, un archivo `.mp3` que en realidad es otro formato). Se reproducen igual, pero sin BPM.

---

## Para programadores

Hecha con [Tauri](https://tauri.app) v2: backend en Rust (symphonia para decodificar y analizar el audio, lofty para las portadas, rayon para el análisis en segundo plano) e interfaz en HTML, CSS y JavaScript sin librerías. Tipografía Host Grotesk incluida. El contrato entre la interfaz y el backend está en `SPEC.md`.

Para compilar:

    cd src-tauri
    cargo build --release

Desde Linux, para generar el .exe de Windows: `cargo xwin build --release --target x86_64-pc-windows-msvc`.
