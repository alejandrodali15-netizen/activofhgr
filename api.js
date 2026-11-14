// Comunicación con el servidor (Apps Script) y sincronización de la cola de cambios.
(function () {
  const LOTE = 50;

  async function llamar(action, datos = {}, timeoutMs = 45000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(window.CONFIG.WEBAPP_URL, {
        method: 'POST',
        headers: {'Content-Type': 'text/plain;charset=utf-8'},   // evita el preflight CORS de Apps Script
        body: JSON.stringify(Object.assign({action}, datos)),
        signal: ctrl.signal,
        redirect: 'follow'
      });
      if (!r.ok) throw new Error('El servidor respondió ' + r.status);
      const j = await r.json();
      if (j && j.error === 'SESION') { const e = new Error(j.mensaje || 'Sesión vencida'); e.sesion = true; throw e; }
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Sin respuesta del servidor (señal débil)');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  let enCurso = null;

  /**
   * Sube la cola: primero los datos (ligeros), después las fotos una por una.
   * Un cambio solo se borra del teléfono cuando el servidor confirmó datos y fotos.
   */
  async function sincronizar(token, dispositivo, avisar) {
    if (enCurso) return enCurso;
    enCurso = (async () => {
      const res = {datos: 0, fotos: 0, rechazados: [], error: null};
      try {
        // 1) Datos
        let pendientes = (await DB.all('cola')).filter(c => !c.datosOk).sort((a, b) => a.creado.localeCompare(b.creado));
        for (let i = 0; i < pendientes.length; i += LOTE) {
          const lote = pendientes.slice(i, i + LOTE);
          avisar && avisar(`Subiendo datos ${Math.min(i + LOTE, pendientes.length)} de ${pendientes.length}…`);
          const enviar = lote.map(c => { const o = Object.assign({}, c); delete o.datosOk; delete o.fotosPend; delete o.creado; delete o.error; return o; });
          const r = await llamar('sync', {token, dispositivo, cambios: enviar});
          if (!r.ok) throw new Error(r.error || 'Error al sincronizar');
          const ok = new Set(r.recibidos);
          const rech = new Map((r.rechazados || []).map(x => [x.id, x.motivo]));
          for (const c of lote) {
            if (ok.has(c.id)) { c.datosOk = true; delete c.error; await DB.put('cola', c); res.datos++; }
            else if (rech.has(c.id)) { c.error = rech.get(c.id); await DB.put('cola', c); res.rechazados.push(c); }
          }
        }
        // 2) Fotos
        const conFotos = (await DB.all('cola')).filter(c => c.datosOk && c.fotosPend && c.fotosPend.length);
        let n = 0;
        const totalFotos = conFotos.reduce((s, c) => s + c.fotosPend.length, 0);
        for (const c of conFotos) {
          for (const campo of c.fotosPend.slice()) {
            n++;
            avisar && avisar(`Subiendo foto ${n} de ${totalFotos}…`);
            const f = await DB.get('fotos', c.id + '|' + campo);
            if (f) {
              const r = await llamar('subirFoto', {token, id: c.id, campo, dataUrl: f.dataUrl, nombre: c.folio || c.grupo || c.folioProvisional || c.id}, 90000);
              if (!r.ok) throw new Error(r.mensaje || r.error || 'Error al subir foto');
              await DB.del('fotos', f.key);
              res.fotos++;
            }
            c.fotosPend = c.fotosPend.filter(x => x !== campo);
            await DB.put('cola', c);
          }
        }
        // 3) Limpia lo que ya quedó completo
        for (const c of await DB.all('cola')) {
          if (c.datosOk && (!c.fotosPend || !c.fotosPend.length)) await DB.del('cola', c.id);
        }
      } catch (e) {
        res.error = e;
      }
      return res;
    })();
    try { return await enCurso; } finally { enCurso = null; }
  }

  window.API = {llamar, sincronizar, ocupado: () => !!enCurso};
})();
