// Foto tomada en el momento: se reduce a 1280 px y se le imprime el sello (folio, fecha, hora y usuario).
(function () {
  const MAX = 1280, CALIDAD = 0.72, MAX_ANTIGUEDAD_MIN = 15;

  function cargarImagen(file) {
    return new Promise((ok, ko) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('No se pudo leer la foto')); };
      img.src = url;
    });
  }

  function fechaTexto(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /**
   * Procesa el archivo que entrega la cámara.
   * Rechaza fotos viejas (de galería): el archivo debe haberse creado hace menos de 15 minutos.
   */
  async function procesar(file, sello) {
    if (!file) throw new Error('No se tomó ninguna foto');
    if (!/^image\//.test(file.type || 'image/')) throw new Error('El archivo no es una imagen');
    const edadMin = (Date.now() - (file.lastModified || Date.now())) / 60000;
    if (edadMin > MAX_ANTIGUEDAD_MIN) throw new Error('La foto debe tomarse en este momento con la cámara, no desde la galería');
    const img = await cargarImagen(file);
    const esc = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * esc), h = Math.round(img.naturalHeight * esc);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0, w, h);
    // Sello
    const fs = Math.max(16, Math.round(w / 40));
    const texto = `${sello.referencia} · ${fechaTexto(new Date())} · ${sello.usuario}`;
    cx.font = `600 ${fs}px system-ui, sans-serif`;
    const bh = fs * 1.9;
    cx.fillStyle = 'rgba(0,0,0,0.62)';
    cx.fillRect(0, h - bh, w, bh);
    cx.fillStyle = '#fff';
    cx.textBaseline = 'middle';
    cx.fillText(texto, fs * 0.6, h - bh / 2, w - fs * 1.2);
    return cv.toDataURL('image/jpeg', CALIDAD);
  }

  window.Foto = {procesar};
})();
