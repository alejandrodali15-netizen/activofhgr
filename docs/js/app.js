// Inventario de Activo Fijo — app sin conexión.
(function () {
  'use strict';
  const ESTADOS = ['Funcional', 'No funcional', 'En espera de baja'];
  const $ = sel => document.querySelector(sel);
  const app = () => $('#app');

  const S = {
    ses: null, meta: null, disp: null,
    bienes: new Map(), grupos: new Map(), remotas: [], sobrantes: [], cola: [],
    vista: 'areas', p: {}, filtro: {texto: '', subarea: '', ver: 'pendientes'},
    foto: {}, sincronizando: false, ultimoSync: null
  };

  // ---------------------------------------------------------------- utilidades
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))).replace(/-/g, '');
  const fmt = n => Number(n || 0).toLocaleString('es-MX');
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const esJefe = () => S.ses && (S.ses.rol === 'jefe' || S.ses.rol === 'dev');
  const fechaCorta = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('es-MX', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'}); };

  function toast(msg, tipo) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast visible ' + (tipo || '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, tipo === 'error' ? 6000 : 3000);
  }

  // ---------------------------------------------------------------- carga de datos locales
  async function cargarLocal() {
    S.ses = await DB.kvGet('sesion');
    S.meta = await DB.kvGet('meta');
    S.disp = await DB.kvGet('dispositivo');
    if (!S.disp) { S.disp = Math.random().toString(36).slice(2, 6).toUpperCase(); await DB.kvSet('dispositivo', S.disp); }
    const [bienes, grupos, remotas, sobrantes, cola] = await Promise.all(['bienes', 'grupos', 'remotas', 'sobrantes', 'cola'].map(s => DB.all(s)));
    S.bienes = new Map(bienes.map(b => [b.folio, b]));
    S.grupos = new Map(grupos.map(g => [g.id, g]));
    S.remotas = remotas; S.sobrantes = sobrantes; S.cola = cola;
    S.ultimoSync = await DB.kvGet('ultimoSync');
  }

  async function descargarPadron() {
    const r = await API.llamar('getPadron', {token: S.ses.token}, 120000);
    if (!r.ok) throw new Error(r.error || 'No se pudo descargar el padrón');
    const bienes = r.bienes.map(a => { const o = {}; r.campos.forEach((c, i) => { o[c] = a[i]; }); return o; });
    const grupos = r.grupos.map(a => ({id: a[0], padron: a[1], area: a[2], desc: a[3], cantidad: a[4], resg: a[5]}));
    await DB.reemplazar('bienes', bienes);
    await DB.reemplazar('grupos', grupos);
    await DB.reemplazar('remotas', r.validaciones);
    await DB.reemplazar('sobrantes', r.sobrantes);
    S.meta = {ciclo: r.ciclo, areas: r.areas, misAreas: r.misAreas, generado: r.generado};
    await DB.kvSet('meta', S.meta);
    await DB.kvSet('ultimoSync', new Date().toISOString());
  }

  async function refrescarValidaciones() {
    const r = await API.llamar('getValidaciones', {token: S.ses.token}, 90000);
    if (!r.ok) throw new Error(r.error);
    await DB.reemplazar('remotas', r.validaciones);
    await DB.reemplazar('sobrantes', r.sobrantes);
    S.remotas = r.validaciones; S.sobrantes = r.sobrantes;
    S.ultimoSync = new Date().toISOString();
    await DB.kvSet('ultimoSync', S.ultimoSync);
  }

  // ---------------------------------------------------------------- estado vigente de cada bien o grupo
  /** Devuelve un índice clave → última validación (servidor + teléfono) y los conflictos detectados. */
  function indice() {
    const todos = S.remotas.map(v => Object.assign({local: false}, v))
      .concat(S.cola.filter(c => c.tipo !== 'SOBRANTE').map(c => Object.assign({local: true}, c)));
    const idx = new Map(), porClave = new Map();
    todos.forEach(v => {
      const k = v.tipo === 'GRUPO' ? 'G:' + v.grupo : 'B:' + v.folio;
      const prev = idx.get(k);
      if (!prev || String(v.fechaCaptura) > String(prev.fechaCaptura)) idx.set(k, v);
      if (!porClave.has(k)) porClave.set(k, []);
      porClave.get(k).push(v);
    });
    const conflictos = [];
    porClave.forEach((lista, k) => {
      const usuarios = new Set(lista.map(v => v.usuario));
      if (usuarios.size < 2) return;
      const firmas = new Set(lista.map(v => [v.tipo, v.estado, v.area, v.encontrada].join('|')));
      if (firmas.size > 1) conflictos.push({clave: k, lista});
    });
    return {idx, conflictos};
  }

  function itemsDeArea(area) {
    const items = [];
    S.bienes.forEach(b => { if (b.area === area && b.modo !== 'Grupo') items.push({tipo: 'B', b}); });
    S.grupos.forEach(g => { if (g.area === area) items.push({tipo: 'G', g}); });
    return items;
  }

  function avanceArea(area, idx) {
    let total = 0, ok = 0, noLoc = 0;
    itemsDeArea(area).forEach(it => {
      if (it.tipo === 'B') {
        total++;
        const v = idx.get('B:' + it.b.folio);
        if (v) { if (v.tipo === 'NO_LOCALIZADO') noLoc++; else ok++; }
      } else {
        total += it.g.cantidad;
        const v = idx.get('G:' + it.g.id);
        if (v) { const enc = Math.min(Number(v.encontrada) || 0, it.g.cantidad); ok += enc; noLoc += it.g.cantidad - enc; }
      }
    });
    return {total, ok, noLoc, pend: total - ok - noLoc};
  }

  // ---------------------------------------------------------------- navegación y render
  function ir(vista, p) {
    S.vista = vista; S.p = p || {};
    if (vista !== 'bien' && vista !== 'grupo' && vista !== 'sobrante') S.foto = {};
    history.pushState({vista, p: S.p}, '');
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', e => {
    if (e.state && S.ses) { S.vista = e.state.vista; S.p = e.state.p || {}; S.foto = {}; render(); }
  });

  function cabecera(titulo, atras) {
    const pend = S.cola.length;
    const enLinea = navigator.onLine;
    return `<header class="barra">
      ${atras ? `<button class="icono" data-act="atras" aria-label="Regresar">‹</button>` : '<span class="logo">AF</span>'}
      <h1>${esc(titulo)}</h1>
      <button class="sync ${pend ? 'hay' : ''} ${S.sincronizando ? 'girando' : ''}" data-act="sync" title="Sincronizar">
        <span class="punto ${enLinea ? 'on' : 'off'}"></span>${pend ? `<b>${pend}</b> por subir` : (enLinea ? 'Al día' : 'Sin señal')}
      </button>
    </header>`;
  }

  function render() {
    if (!S.ses) return vLogin();
    if (!S.meta) return vDescarga();
    const vistas = {areas: vAreas, area: vArea, bien: vBien, grupo: vGrupo, sobrante: vSobrante, tablero: vTablero,
                    usuarios: vUsuarios, usuario: vUsuario, pendientes: vPendientes, menu: vMenu};
    (vistas[S.vista] || vAreas)();
  }

  // ---------------------------------------------------------------- vistas
  function vLogin() {
    app().innerHTML = `<main class="login">
      <div class="marca"><span class="logo grande">AF</span><h1>Inventario de Activo Fijo</h1><p>${esc(window.CONFIG.HOSPITAL)}</p></div>
      <form id="f-login" class="tarjeta">
        <label>Usuario<input id="l-usuario" autocomplete="username" autocapitalize="none" required></label>
        <label>Contraseña<input id="l-pass" type="password" autocomplete="current-password" required></label>
        <button class="primario" type="submit">Entrar</button>
        <p class="nota">El primer inicio de sesión necesita internet. Después la app funciona sin señal.</p>
      </form>
      <p class="version">v${esc(window.CONFIG.VERSION)}</p></main>`;
  }

  function vDescarga() {
    app().innerHTML = `${cabecera('Preparar el teléfono')}<main>
      <div class="tarjeta centrado">
        <h2>Descargar el padrón</h2>
        <p>Antes del recorrido, con internet, descarga los bienes de tus áreas. Después podrás trabajar en modo avión.</p>
        <button class="primario" data-act="descargar">Descargar ahora</button>
        <button class="secundario" data-act="salir">Cerrar sesión</button>
      </div></main>`;
  }

  function vAreas() {
    const {idx} = indice();
    const mis = S.meta.misAreas || [];
    const filas = mis.map(a => {
      const av = avanceArea(a, idx);
      const pct = av.total ? Math.round((av.ok + av.noLoc) * 100 / av.total) : 0;
      return `<button class="fila-area" data-act="area" data-area="${esc(a)}">
        <div class="fa-top"><b>${esc(a)}</b><span>${fmt(av.ok + av.noLoc)} de ${fmt(av.total)}</span></div>
        <div class="progreso"><i style="width:${pct}%"></i></div>
        ${av.noLoc ? `<small class="alerta">${fmt(av.noLoc)} no localizados</small>` : ''}
      </button>`;
    }).join('');
    app().innerHTML = `${cabecera('Mis áreas')}<main>
      <div class="saludo"><span>${esc(S.ses.nombre)} · ciclo ${esc(S.meta.ciclo)}</span><button class="enlace" data-act="menu">Menú</button></div>
      ${S.cola.some(c => c.error) ? `<button class="aviso error" data-act="pendientes">Hay cambios rechazados por el servidor. Revisar</button>` : ''}
      ${mis.length ? `<input id="buscar-areas" class="buscador" placeholder="Buscar área…" value="">` : ''}
      <div id="lista-areas">${filas || '<p class="vacio">No tienes áreas asignadas. Pide al jefe de servicio que te asigne áreas.</p>'}</div>
    </main>`;
  }

  function vArea() {
    const area = S.p.area;
    const {idx} = indice();
    const av = avanceArea(area, idx);
    const items = itemsDeArea(area);
    const subareas = [...new Set(items.map(it => it.tipo === 'B' ? it.b.subarea : '').filter(Boolean))].sort();
    app().innerHTML = `${cabecera(area, true)}<main>
      <div class="resumen-area">
        <div><b>${fmt(av.ok)}</b><span>validados</span></div>
        <div><b>${fmt(av.noLoc)}</b><span>no localizados</span></div>
        <div><b>${fmt(av.pend)}</b><span>pendientes</span></div>
      </div>
      <div class="filtros">
        <input id="buscar" class="buscador" placeholder="Buscar por descripción, serie o inventario" value="${esc(S.filtro.texto)}">
        ${subareas.length ? `<select id="f-subarea"><option value="">Todas las subáreas</option>${subareas.map(s => `<option ${s === S.filtro.subarea ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
        <div class="pestanas">
          <button data-act="ver" data-ver="pendientes" class="${S.filtro.ver === 'pendientes' ? 'activa' : ''}">Pendientes</button>
          <button data-act="ver" data-ver="validados" class="${S.filtro.ver === 'validados' ? 'activa' : ''}">Revisados</button>
          <button data-act="ver" data-ver="todos" class="${S.filtro.ver === 'todos' ? 'activa' : ''}">Todos</button>
        </div>
      </div>
      <div id="lista"></div>
      <button class="flotante" data-act="nuevo-sobrante">+ Bien no registrado</button>
    </main>`;
    pintarLista();
  }

  function pintarLista() {
    const area = S.p.area, {idx} = indice();
    const q = norm(S.filtro.texto).trim();
    const items = itemsDeArea(area).filter(it => {
      const v = idx.get(it.tipo === 'B' ? 'B:' + it.b.folio : 'G:' + it.g.id);
      if (S.filtro.ver === 'pendientes' && v) return false;
      if (S.filtro.ver === 'validados' && !v) return false;
      if (S.filtro.subarea && (it.tipo !== 'B' || it.b.subarea !== S.filtro.subarea)) return false;
      if (!q) return true;
      const txt = it.tipo === 'B' ? [it.b.desc, it.b.serie, it.b.inv, it.b.folio, it.b.marca, it.b.resg].join(' ') : [it.g.desc, it.g.id].join(' ');
      return q.split(/\s+/).every(p => norm(txt).includes(p));
    });
    const MAX = 150;
    const html = items.slice(0, MAX).map(it => {
      if (it.tipo === 'B') {
        const b = it.b, v = idx.get('B:' + b.folio);
        return `<button class="item" data-act="bien" data-folio="${esc(b.folio)}">
          <div class="item-top"><span class="folio">${esc(b.inv || b.folio)}</span>${chipEstado(v)}</div>
          <p>${esc(b.desc)}</p>
          <small>${[b.serie && 'Serie ' + b.serie, b.subarea, b.resg].filter(Boolean).map(esc).join(' · ')}</small>
        </button>`;
      }
      const g = it.g, v = idx.get('G:' + g.id);
      return `<button class="item grupo" data-act="grupo" data-grupo="${esc(g.id)}">
        <div class="item-top"><span class="folio">Grupo · ${fmt(g.cantidad)} piezas</span>${chipEstado(v, g.cantidad)}</div>
        <p>${esc(g.desc)}</p>
        <small>${esc(g.resg)}</small>
      </button>`;
    }).join('');
    $('#lista').innerHTML = (html || '<p class="vacio">Nada que mostrar con estos filtros.</p>') +
      (items.length > MAX ? `<p class="vacio">Se muestran ${MAX} de ${fmt(items.length)}. Usa el buscador para encontrar el resto.</p>` : '');
  }

  function chipEstado(v, cantidad) {
    if (!v) return '<span class="chip pend">Pendiente</span>';
    const sub = v.local ? ' · sin subir' : '';
    if (v.tipo === 'NO_LOCALIZADO') return `<span class="chip noloc">No localizado${sub}</span>`;
    if (v.tipo === 'GRUPO') {
      const falt = cantidad - (Number(v.encontrada) || 0);
      return `<span class="chip ${falt > 0 ? 'noloc' : 'ok'}">${fmt(v.encontrada)} de ${fmt(cantidad)}${sub}</span>`;
    }
    const cls = v.estado === 'Funcional' ? 'ok' : (v.estado === 'No funcional' ? 'mal' : 'baja');
    return `<span class="chip ${cls}">${esc(v.estado)}${sub}</span>`;
  }

  function bloqueFoto(campo, titulo, obligatoria) {
    const f = S.foto[campo];
    return `<div class="foto-caja">
      <span class="etiqueta">${esc(titulo)}${obligatoria ? ' *' : ''}</span>
      ${f ? `<img src="${f}" alt="${esc(titulo)}"><button class="secundario chico" data-act="foto" data-campo="${campo}">Tomar otra</button>`
          : `<button class="camara" data-act="foto" data-campo="${campo}">📷 Tomar foto</button>`}
    </div>`;
  }

  function opcionesAreas(actual) {
    const todas = (S.meta.areas || []).map(a => a.area);
    if (actual && !todas.includes(actual)) todas.push(actual);
    return todas.map(a => `<option ${a === actual ? 'selected' : ''}>${esc(a)}</option>`).join('');
  }

  function vBien() {
    const b = S.bienes.get(S.p.folio);
    if (!b) return ir('areas');
    const {idx} = indice();
    const v = idx.get('B:' + b.folio);
    const estadoIni = S.p.estado || (v && v.estado) || (ESTADOS.includes(b.estado) ? b.estado : '');
    app().innerHTML = `${cabecera(b.inv || b.folio, true)}<main>
      <div class="tarjeta ficha">
        <p class="desc">${esc(b.desc)}</p>
        <dl>
          ${dato('Folio', b.folio)}${dato('No. inventario', b.inv)}${dato('Serie', b.serie)}${dato('Marca', b.marca)}${dato('Modelo', b.modelo)}
          ${dato('Padrón', b.padron)}${dato('Estado en padrón', b.estado)}
        </dl>
        ${v ? `<p class="previa">Última revisión: ${chipEstado(v)} por ${esc(v.usuario || S.ses.usuario)} ${esc(fechaCorta(v.fechaCaptura))}</p>` : ''}
      </div>
      <form id="f-bien" class="tarjeta">
        ${bloqueFoto('foto', 'Foto del bien', true)}
        ${bloqueFoto('foto2', 'Foto de placa o serie (opcional)', false)}
        <fieldset class="estados"><legend>Estado *</legend>
          ${ESTADOS.map(e => `<label class="opcion"><input type="radio" name="estado" value="${e}" ${e === estadoIni ? 'checked' : ''}><span>${e}</span></label>`).join('')}
        </fieldset>
        <details ${S.p.corregir ? 'open' : ''}><summary>¿Cambió de lugar o de resguardante?</summary>
          <label>Área<select id="b-area">${opcionesAreas(b.area)}</select></label>
          <label>Subárea<input id="b-subarea" value="${esc(b.subarea)}"></label>
          <label>Resguardante<input id="b-resg" value="${esc(b.resg)}"></label>
        </details>
        <label>Notas<textarea id="b-notas" rows="2" placeholder="Opcional"></textarea></label>
        <button class="primario" type="submit">Guardar validación</button>
        <button class="peligro" type="button" data-act="no-localizado">No lo encontré</button>
      </form></main>`;
  }

  const dato = (k, v) => v ? `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>` : '';

  function vGrupo() {
    const g = S.grupos.get(S.p.grupo);
    if (!g) return ir('areas');
    const {idx} = indice();
    const v = idx.get('G:' + g.id);
    app().innerHTML = `${cabecera('Grupo', true)}<main>
      <div class="tarjeta ficha">
        <p class="desc">${esc(g.desc)}</p>
        <dl>${dato('Área', g.area)}${dato('Resguardante', g.resg)}${dato('Padrón', g.padron)}${dato('Cantidad esperada', fmt(g.cantidad))}</dl>
        ${v ? `<p class="previa">Último conteo: ${chipEstado(v, g.cantidad)} por ${esc(v.usuario || S.ses.usuario)} ${esc(fechaCorta(v.fechaCaptura))}</p>` : ''}
      </div>
      <form id="f-grupo" class="tarjeta">
        ${bloqueFoto('foto', 'Foto del lote', true)}
        <p class="nota">Cuenta las piezas y anota cuántas hay en cada estado. Se esperan <b>${fmt(g.cantidad)}</b>.</p>
        <div class="conteo">
          <label>Funcional<input id="g-fun" type="number" min="0" inputmode="numeric" value="0"></label>
          <label>No funcional<input id="g-nofun" type="number" min="0" inputmode="numeric" value="0"></label>
          <label>En espera de baja<input id="g-baja" type="number" min="0" inputmode="numeric" value="0"></label>
        </div>
        <p id="g-total" class="total-conteo"></p>
        <label>Notas<textarea id="g-notas" rows="2" placeholder="Opcional"></textarea></label>
        <button class="primario" type="submit">Guardar conteo</button>
      </form></main>`;
    actualizarTotalGrupo();
  }

  function actualizarTotalGrupo() {
    const g = S.grupos.get(S.p.grupo); if (!g || !$('#g-total')) return;
    const t = ['#g-fun', '#g-nofun', '#g-baja'].reduce((s, id) => s + (parseInt($(id).value, 10) || 0), 0);
    const dif = t - g.cantidad;
    $('#g-total').innerHTML = `Encontradas: <b>${fmt(t)}</b> de ${fmt(g.cantidad)} ${dif < 0 ? `<span class="alerta">· faltan ${fmt(-dif)}</span>` : dif > 0 ? `<span class="alerta">· sobran ${fmt(dif)}</span>` : '<span class="bien">· completo</span>'}`;
  }

  function vSobrante() {
    const area = S.p.area;
    app().innerHTML = `${cabecera('Bien no registrado', true)}<main>
      <form id="f-sobrante" class="tarjeta">
        <p class="nota">Registra aquí un bien que está en el área pero no aparece en el padrón.</p>
        ${bloqueFoto('foto', 'Foto del bien', true)}
        ${bloqueFoto('foto2', 'Foto de placa o serie (opcional)', false)}
        <label>Descripción *<textarea id="s-desc" rows="2" required></textarea></label>
        <div class="dos"><label>Marca<input id="s-marca"></label><label>Modelo<input id="s-modelo"></label></div>
        <div class="dos"><label>Serie<input id="s-serie"></label><label>No. inventario<input id="s-inv"></label></div>
        <label>Área<select id="s-area">${opcionesAreas(area)}</select></label>
        <label>Subárea<input id="s-subarea"></label>
        <label>Resguardante<input id="s-resg"></label>
        <fieldset class="estados"><legend>Estado *</legend>
          ${ESTADOS.map(e => `<label class="opcion"><input type="radio" name="estado" value="${e}"><span>${e}</span></label>`).join('')}
        </fieldset>
        <label>Notas<textarea id="s-notas" rows="2"></textarea></label>
        <button class="primario" type="submit">Guardar bien no registrado</button>
      </form></main>`;
  }

  function vMenu() {
    app().innerHTML = `${cabecera('Menú', true)}<main><div class="menu">
      <p class="nota">${esc(S.ses.nombre)} (${esc(S.ses.rol)}) · teléfono ${esc(S.disp)}<br>Última sincronización: ${esc(fechaCorta(S.ultimoSync) || 'nunca')}</p>
      ${esJefe() ? '<button class="opcion-menu" data-act="tablero">Tablero de avance</button>' : '<button class="opcion-menu" data-act="tablero">Mi avance</button>'}
      ${esJefe() ? '<button class="opcion-menu" data-act="usuarios">Usuarios y áreas</button>' : ''}
      <button class="opcion-menu" data-act="pendientes">Cambios sin subir (${S.cola.length})</button>
      <button class="opcion-menu" data-act="actualizar">Volver a descargar el padrón</button>
      <button class="opcion-menu" data-act="respaldo">Descargar respaldo de pendientes</button>
      <button class="opcion-menu peligro" data-act="salir">Cerrar sesión</button>
    </div></main>`;
  }

  function vTablero() {
    const {idx, conflictos} = indice();
    const areas = esJefe() ? (S.meta.areas || []).map(a => a.area) : (S.meta.misAreas || []);
    let T = {total: 0, ok: 0, noLoc: 0, pend: 0};
    const filas = areas.map(a => {
      const av = avanceArea(a, idx);
      Object.keys(T).forEach(k => { T[k] += av[k]; });
      const pct = av.total ? Math.round((av.ok + av.noLoc) * 100 / av.total) : 0;
      return {a, av, pct};
    }).filter(f => f.av.total).sort((x, y) => x.pct - y.pct);
    const est = {Funcional: 0, 'No funcional': 0, 'En espera de baja': 0};
    idx.forEach(v => {
      if (v.tipo === 'INDIVIDUAL' && est[v.estado] != null) est[v.estado]++;
      if (v.tipo === 'GRUPO') { est.Funcional += Number(v.funcional) || 0; est['No funcional'] += Number(v.noFuncional) || 0; est['En espera de baja'] += Number(v.baja) || 0; }
    });
    const sobPend = S.sobrantes.filter(s => s.decision === 'Pendiente' || !s.decision);
    const pctT = T.total ? Math.round((T.ok + T.noLoc) * 100 / T.total) : 0;
    app().innerHTML = `${cabecera(esJefe() ? 'Tablero' : 'Mi avance', true)}<main>
      <div class="tarjeta">
        <h2>${pctT}% revisado</h2>
        <div class="progreso grande"><i style="width:${pctT}%"></i></div>
        <div class="resumen-area">
          <div><b>${fmt(T.ok)}</b><span>validados</span></div><div><b>${fmt(T.noLoc)}</b><span>no localizados</span></div><div><b>${fmt(T.pend)}</b><span>pendientes</span></div>
        </div>
        <div class="resumen-area">
          <div><b>${fmt(est.Funcional)}</b><span>funcionales</span></div><div><b>${fmt(est['No funcional'])}</b><span>no funcionales</span></div><div><b>${fmt(est['En espera de baja'])}</b><span>espera de baja</span></div>
        </div>
        <p class="nota">Datos al ${esc(fechaCorta(S.ultimoSync) || '—')} más lo capturado en este teléfono.</p>
      </div>
      ${esJefe() && conflictos.length ? `<div class="tarjeta"><h3>Datos contradictorios (${conflictos.length})</h3>${conflictos.slice(0, 30).map(c => {
        const ref = c.clave.slice(2), b = S.bienes.get(ref), g = S.grupos.get(ref);
        return `<button class="item" data-act="${c.clave[0] === 'B' ? 'bien' : 'grupo'}" ${c.clave[0] === 'B' ? `data-folio="${esc(ref)}"` : `data-grupo="${esc(ref)}"`}>
          <p>${esc((b && b.desc) || (g && g.desc) || ref)}</p>
          <small>${c.lista.map(v => `${esc(v.usuario)}: ${esc(v.tipo === 'GRUPO' ? v.encontrada + ' pzas' : (v.estado || 'No localizado'))} (${esc(v.area)})`).join(' · ')}</small></button>`;
      }).join('')}<p class="nota">Se toma como vigente la captura más reciente. Para corregir, valida el bien de nuevo.</p></div>` : ''}
      ${esJefe() && sobPend.length ? `<div class="tarjeta"><h3>Bienes no registrados por decidir (${sobPend.length})</h3>${sobPend.map(s => `
        <div class="sobrante"><p><b>${esc(s.folio)}</b> · ${esc(s.desc)}</p><small>${esc(s.area)} · ${esc(s.estado)} · ${esc(s.usuario)}</small>
        <div class="acciones"><button class="secundario chico" data-act="ver-foto" data-id="${esc(s.id)}">Ver foto</button>
        <button class="secundario chico" data-act="decidir" data-id="${esc(s.id)}" data-d="Alta">Dar de alta</button>
        <button class="secundario chico" data-act="decidir" data-id="${esc(s.id)}" data-d="Rechazado">Rechazar</button></div></div>`).join('')}</div>` : ''}
      ${esJefe() ? `<div class="tarjeta"><h3>Reportes</h3>
        <p class="nota">Se generan en el servidor con lo sincronizado hasta ahora. Pueden tardar uno o dos minutos.</p>
        <button class="secundario" data-act="gen-reportes">Reportes del levantamiento</button>
        <button class="secundario" data-act="gen-formato">Formato de la Coordinación Estatal</button>
        <button class="enlace" data-act="lista-reportes">Ver reportes generados</button>
        <div id="reportes"></div></div>` : ''}
      <div class="tarjeta"><h3>Avance por área</h3>
        ${filas.map(f => `<button class="fila-area" data-act="area" data-area="${esc(f.a)}">
          <div class="fa-top"><b>${esc(f.a)}</b><span>${f.pct}% · ${fmt(f.av.ok + f.av.noLoc)} de ${fmt(f.av.total)}</span></div>
          <div class="progreso"><i style="width:${f.pct}%"></i></div></button>`).join('')}
      </div>
      <div id="visor" class="visor" hidden></div>
    </main>`;
  }

  function vPendientes() {
    const filas = S.cola.slice().sort((a, b) => b.creado.localeCompare(a.creado)).map(c => {
      const ref = c.tipo === 'SOBRANTE' ? c.folioProvisional : (c.tipo === 'GRUPO' ? 'Grupo ' + c.grupo : (S.bienes.get(c.folio) || {}).inv || c.folio);
      const etapa = c.error ? `<span class="chip mal">Rechazado: ${esc(c.error)}</span>` : (c.datosOk ? `<span class="chip baja">Faltan ${c.fotosPend.length} foto(s)</span>` : '<span class="chip pend">Sin subir</span>');
      return `<div class="item"><div class="item-top"><span class="folio">${esc(ref)}</span>${etapa}</div>
        <small>${esc(c.tipo)} · ${esc(c.area)} · ${esc(fechaCorta(c.fechaCaptura))}</small>
        ${c.error ? `<div class="acciones"><button class="peligro chico" data-act="descartar" data-id="${esc(c.id)}">Descartar</button></div>` : ''}</div>`;
    }).join('');
    app().innerHTML = `${cabecera('Cambios sin subir', true)}<main>
      <div class="tarjeta"><p class="nota">Estos cambios están guardados solo en este teléfono. Se suben solos cuando hay señal. No borres los datos del navegador ni desinstales la app mientras haya pendientes.</p>
      <button class="primario" data-act="sync">Sincronizar ahora</button></div>
      ${filas || '<p class="vacio">No hay nada pendiente.</p>'}</main>`;
  }

  async function vUsuarios() {
    app().innerHTML = `${cabecera('Usuarios y áreas', true)}<main><p class="vacio">Cargando…</p></main>`;
    try {
      const r = await API.llamar('getUsuarios', {token: S.ses.token});
      if (!r.ok) throw new Error(r.error);
      S.usuarios = r.usuarios;
      $('main').innerHTML = `<button class="primario" data-act="usuario" data-u="">+ Nuevo validador</button>
        ${r.usuarios.map(u => `<button class="item" data-act="usuario" data-u="${esc(u.usuario)}">
          <div class="item-top"><span class="folio">${esc(u.nombre)}</span><span class="chip ${u.activo ? 'ok' : 'mal'}">${esc(u.rol)}${u.activo ? '' : ' · inactivo'}</span></div>
          <small>${esc(u.usuario)} · ${u.rol === 'validador' ? (u.areas.length ? esc(u.areas.join(', ')) : 'sin áreas') : 'todas las áreas'}</small></button>`).join('')}`;
    } catch (e) {
      $('main').innerHTML = `<p class="vacio">Se necesita internet para administrar usuarios.<br>${esc(e.message)}</p>`;
    }
  }

  function vUsuario() {
    const u = (S.usuarios || []).find(x => x.usuario === S.p.u) || {usuario: '', nombre: '', rol: 'validador', activo: true, areas: []};
    const nuevo = !u.usuario;
    app().innerHTML = `${cabecera(nuevo ? 'Nuevo validador' : u.nombre, true)}<main>
      <form id="f-usuario" class="tarjeta">
        <label>Usuario<input id="u-usuario" value="${esc(u.usuario)}" ${nuevo ? '' : 'readonly'} autocapitalize="none" required></label>
        <label>Nombre<input id="u-nombre" value="${esc(u.nombre)}" required></label>
        ${S.ses.rol === 'dev' ? `<label>Rol<select id="u-rol">${['validador', 'jefe', 'dev'].map(r => `<option ${r === u.rol ? 'selected' : ''}>${r}</option>`).join('')}</select></label>` : ''}
        <label>${nuevo ? 'Contraseña (mínimo 8)' : 'Nueva contraseña (vacía = no cambiar)'}<input id="u-pass" type="text" autocomplete="off" ${nuevo ? 'required minlength="8"' : ''}></label>
        <label class="opcion"><input type="checkbox" id="u-activo" ${u.activo ? 'checked' : ''}><span>Activo</span></label>
        <fieldset><legend>Áreas asignadas</legend><div class="lista-check">
          ${(S.meta.areas || []).map(a => `<label class="opcion"><input type="checkbox" name="u-area" value="${esc(a.area)}" ${u.areas.includes(a.area) ? 'checked' : ''}><span>${esc(a.area)} <small>(${fmt(a.bienes)})</small></span></label>`).join('')}
        </div></fieldset>
        <button class="primario" type="submit">Guardar</button>
      </form></main>`;
  }

  // ---------------------------------------------------------------- acciones
  async function guardar(cambio, fotos) {
    cambio.id = nuevoId();
    cambio.creado = new Date().toISOString();
    cambio.fechaCaptura = cambio.creado;
    cambio.dispositivo = S.disp;
    cambio.datosOk = false;
    cambio.fotosPend = fotos.map(f => f.campo);
    await DB.guardarCambio(cambio, fotos.map(f => ({key: cambio.id + '|' + f.campo, id: cambio.id, campo: f.campo, dataUrl: f.dataUrl})));
    S.cola.push(cambio);
    S.foto = {};
    toast('Guardado en el teléfono', 'ok');
    if (navigator.onLine) sincronizar(true);
  }

  async function sincronizar(silencioso) {
    if (!S.ses || S.sincronizando) return;
    if (!navigator.onLine) { if (!silencioso) toast('Sin señal. Los cambios quedan guardados en el teléfono.'); return; }
    S.sincronizando = true; refrescarCabecera();
    const r = await API.sincronizar(S.ses.token, S.disp, msg => { if (!silencioso) toast(msg); });
    S.cola = await DB.all('cola');
    if (!r.error) { try { await refrescarValidaciones(); } catch (e) { r.error = e; } }
    S.sincronizando = false;
    if (r.error && r.error.sesion) { toast(r.error.message, 'error'); return salir(true); }
    if (r.error) { if (!silencioso) toast('No se completó: ' + r.error.message + '. Se reintentará.', 'error'); }
    else if (r.rechazados.length) toast(`${r.rechazados.length} cambio(s) rechazados. Revisa en Menú › Cambios sin subir.`, 'error');
    else if (!silencioso || r.datos || r.fotos) toast(`Sincronizado: ${r.datos} cambios, ${r.fotos} fotos`, 'ok');
    const enFormulario = ['bien', 'grupo', 'sobrante', 'usuario'].includes(S.vista);
    if (enFormulario) refrescarCabecera(); else render();
  }

  function refrescarCabecera() {
    const h = document.querySelector('header.barra');
    if (!h) return;
    const tmp = document.createElement('div');
    const atras = !!h.querySelector('[data-act="atras"]');
    tmp.innerHTML = cabecera(h.querySelector('h1').textContent, atras);
    h.replaceWith(tmp.firstElementChild);
  }

  async function salir(forzado) {
    if (!forzado && S.cola.length && !confirm(`Hay ${S.cola.length} cambios sin subir. Si cierras sesión se conservarán en el teléfono, pero solo se suben cuando vuelvas a entrar con este mismo usuario. ¿Cerrar sesión?`)) return;
    S.ses = null;
    await DB.del('kv', 'sesion');
    render();
  }

  function descargarRespaldo() {
    Promise.all([DB.all('cola'), DB.all('fotos')]).then(([cola, fotos]) => {
      const blob = new Blob([JSON.stringify({dispositivo: S.disp, usuario: S.ses.usuario, fecha: new Date().toISOString(), cola, fotos})], {type: 'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `respaldo-activo-fijo-${S.ses.usuario}-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  }

  function pintarArchivos(archivos, titulo, extra) {
    const div = $('#reportes'); if (!div) return;
    div.innerHTML = `<p class="nota"><b>${esc(titulo)}</b>${extra ? ' · ' + esc(extra) : ''}</p>` + (archivos.length ? archivos.map(a => `
      <div class="sobrante"><p>${esc(a.nombre)}</p>${a.renglones != null ? `<small>${fmt(a.renglones)} renglones actualizados</small>` : ''}
      <div class="acciones"><button class="secundario chico" data-act="bajar-xlsx" data-id="${esc(a.id)}">Descargar Excel</button>
      <a class="secundario chico boton-enlace" href="${esc(a.url)}" target="_blank" rel="noopener">Abrir en Google</a></div></div>`).join('') : '<p class="vacio">Sin archivos.</p>');
  }

  async function generarArchivos(el, accion) {
    if (!navigator.onLine) return toast('Se necesita internet');
    if (S.cola.length) await sincronizar(true);
    const txt = el.textContent; el.disabled = true; el.textContent = 'Generando… no cierres la app';
    try {
      const r = await API.llamar(accion, {token: S.ses.token}, 330000);
      if (!r.ok) throw new Error(r.error);
      let extra = '';
      if (r.archivos[0] && r.archivos[0].resumen) { const x = r.archivos[0].resumen; extra = `${fmt(x.faltantes)} faltantes, ${fmt(x.sobrantes)} no registrados, ${fmt(x.cambios)} cambios, ${fmt(x.contradictorios)} contradictorios`; }
      if (r.faltanPlantillas && r.faltanPlantillas.length) extra = 'Faltan plantillas en Config: ' + r.faltanPlantillas.join(', ');
      pintarArchivos(r.archivos, 'Listo', extra);
      toast('Archivos generados', 'ok');
    } catch (e) { toast(e.message, 'error'); } finally { el.disabled = false; el.textContent = txt; }
  }

  const ACCIONES = {
    atras: () => history.back(),
    sync: () => sincronizar(false),
    menu: () => ir('menu'),
    area: el => { S.filtro = {texto: '', subarea: '', ver: 'pendientes'}; ir('area', {area: el.dataset.area}); },
    bien: el => ir('bien', {folio: el.dataset.folio}),
    grupo: el => ir('grupo', {grupo: el.dataset.grupo}),
    ver: el => { S.filtro.ver = el.dataset.ver; document.querySelectorAll('.pestanas button').forEach(b => b.classList.toggle('activa', b === el)); pintarLista(); },
    'nuevo-sobrante': () => ir('sobrante', {area: S.p.area}),
    tablero: () => ir('tablero'),
    usuarios: () => ir('usuarios'),
    usuario: el => ir('usuario', {u: el.dataset.u}),
    pendientes: () => ir('pendientes'),
    respaldo: () => descargarRespaldo(),
    salir: () => salir(false),
    foto: el => { const i = $('#camara'); i.dataset.campo = el.dataset.campo; i.value = ''; i.click(); },
    descargar: async el => {
      el.disabled = true; el.textContent = 'Descargando…';
      try { await descargarPadron(); await cargarLocal(); toast('Padrón descargado. Ya puedes trabajar sin señal.', 'ok'); ir('areas'); }
      catch (e) { toast(e.message, 'error'); if (e.sesion) salir(true); el.disabled = false; el.textContent = 'Descargar ahora'; }
    },
    actualizar: async el => {
      if (!navigator.onLine) return toast('Se necesita internet');
      el.disabled = true; el.textContent = 'Descargando…';
      try { await sincronizar(true); await descargarPadron(); await cargarLocal(); toast('Padrón actualizado', 'ok'); ir('areas'); }
      catch (e) { toast(e.message, 'error'); el.disabled = false; }
    },
    'no-localizado': async () => {
      const b = S.bienes.get(S.p.folio);
      const notas = $('#b-notas').value.trim();
      if (!confirm('¿Marcar este bien como NO LOCALIZADO?')) return;
      await guardar({tipo: 'NO_LOCALIZADO', folio: b.folio, area: b.area, subarea: b.subarea, resg: b.resg, notas}, []);
      history.back();
    },
    descartar: async el => {
      if (!confirm('¿Descartar este cambio? Se borrará del teléfono.')) return;
      await DB.del('cola', el.dataset.id);
      const c = S.cola.find(x => x.id === el.dataset.id);
      if (c) for (const campo of c.fotosPend || []) await DB.del('fotos', el.dataset.id + '|' + campo);
      S.cola = await DB.all('cola'); render();
    },
    decidir: async el => {
      if (!navigator.onLine) return toast('Se necesita internet');
      try {
        const r = await API.llamar('decidirSobrante', {token: S.ses.token, id: el.dataset.id, decision: el.dataset.d});
        if (!r.ok) throw new Error(r.error);
        await refrescarValidaciones(); toast('Decisión guardada', 'ok'); render();
      } catch (e) { toast(e.message, 'error'); }
    },
    'ver-foto': async el => {
      if (!navigator.onLine) return toast('Se necesita internet');
      const vis = $('#visor');
      vis.hidden = false; vis.innerHTML = '<p>Cargando foto…</p>';
      try {
        const r = await API.llamar('getFoto', {token: S.ses.token, id: el.dataset.id});
        if (!r.ok) throw new Error(r.error);
        vis.innerHTML = `<img src="${r.dataUrl}" alt="Foto"><button class="secundario" data-act="cerrar-visor">Cerrar</button>`;
      } catch (e) { vis.innerHTML = `<p>${esc(e.message)}</p><button class="secundario" data-act="cerrar-visor">Cerrar</button>`; }
    },
    'gen-reportes': el => generarArchivos(el, 'generarReportes'),
    'gen-formato': el => generarArchivos(el, 'generarFormato'),
    'lista-reportes': async el => {
      if (!navigator.onLine) return toast('Se necesita internet');
      el.disabled = true;
      try {
        const r = await API.llamar('listarReportes', {token: S.ses.token});
        if (!r.ok) throw new Error(r.error);
        pintarArchivos(r.archivos, 'Generados');
      } catch (e) { toast(e.message, 'error'); } finally { el.disabled = false; }
    },
    'bajar-xlsx': async el => {
      if (!navigator.onLine) return toast('Se necesita internet');
      const txt = el.textContent; el.disabled = true; el.textContent = 'Preparando Excel…';
      try {
        const r = await API.llamar('descargarXlsx', {token: S.ses.token, id: el.dataset.id}, 180000);
        if (!r.ok) throw new Error(r.error);
        const bytes = Uint8Array.from(atob(r.base64), c => c.charCodeAt(0));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
        a.download = r.nombre.replace(/[\\/:*?"<>|]/g, '_');
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch (e) { toast(e.message, 'error'); } finally { el.disabled = false; el.textContent = txt; }
    },
    'cerrar-visor': () => { const v = $('#visor'); v.hidden = true; v.innerHTML = ''; }
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = ACCIONES[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el); }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'buscar') { S.filtro.texto = e.target.value; clearTimeout(pintarLista._t); pintarLista._t = setTimeout(pintarLista, 150); }
    if (e.target.id === 'buscar-areas') {
      const q = norm(e.target.value);
      document.querySelectorAll('#lista-areas .fila-area').forEach(b => { b.hidden = !norm(b.dataset.area).includes(q); });
    }
    if (['g-fun', 'g-nofun', 'g-baja'].includes(e.target.id)) actualizarTotalGrupo();
  });

  document.addEventListener('change', async e => {
    if (e.target.id === 'f-subarea') { S.filtro.subarea = e.target.value; pintarLista(); }
    if (e.target.id === 'camara') {
      const campo = e.target.dataset.campo;
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const ref = S.vista === 'bien' ? (S.bienes.get(S.p.folio).inv || S.p.folio) : S.vista === 'grupo' ? S.p.grupo : 'NUEVO ' + S.p.area;
      try {
        S.foto[campo] = await Foto.procesar(file, {referencia: ref, usuario: S.ses.usuario});
        const caja = document.querySelector(`.foto-caja [data-campo="${campo}"]`).closest('.foto-caja');
        const tmp = document.createElement('div');
        const titulo = caja.querySelector('.etiqueta').textContent.replace(' *', '');
        tmp.innerHTML = bloqueFoto(campo, titulo, campo === 'foto');
        caja.replaceWith(tmp.firstElementChild);
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  document.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    try {
      if (btn) btn.disabled = true;
      if (f.id === 'f-login') {
        if (!navigator.onLine) throw new Error('El primer inicio de sesión necesita internet');
        const r = await API.llamar('login', {usuario: $('#l-usuario').value.trim(), password: $('#l-pass').value});
        if (!r.ok) throw new Error(r.error);
        const previo = await DB.kvGet('usuarioDatos');
        if (previo && previo !== r.usuario) {
          const pend = await DB.count('cola');
          if (pend) throw new Error(`Este teléfono tiene ${pend} cambios sin subir de otro usuario (${previo}). Entra con ese usuario para subirlos.`);
          await DB.borrarTodo();
          S.disp = null;
        }
        S.ses = {token: r.token, usuario: r.usuario, nombre: r.nombre, rol: r.rol, areas: r.areas};
        await DB.kvSet('sesion', S.ses);
        await DB.kvSet('usuarioDatos', r.usuario);
        await DB.pedirPersistencia();
        await cargarLocal();
        S.vista = 'areas';
        render();
        return;
      }
      if (f.id === 'f-bien') {
        const b = S.bienes.get(S.p.folio);
        const estado = (f.querySelector('input[name="estado"]:checked') || {}).value;
        if (!S.foto.foto) throw new Error('Falta la foto del bien');
        if (!estado) throw new Error('Elige el estado');
        const fotos = [{campo: 'foto', dataUrl: S.foto.foto}];
        if (S.foto.foto2) fotos.push({campo: 'foto2', dataUrl: S.foto.foto2});
        await guardar({tipo: 'INDIVIDUAL', folio: b.folio, estado, area: $('#b-area').value, subarea: $('#b-subarea').value.trim(),
                       resg: $('#b-resg').value.trim(), notas: $('#b-notas').value.trim()}, fotos);
        history.back();
        return;
      }
      if (f.id === 'f-grupo') {
        const g = S.grupos.get(S.p.grupo);
        if (!S.foto.foto) throw new Error('Falta la foto del lote');
        const n = id => Math.max(0, parseInt($(id).value, 10) || 0);
        const fun = n('#g-fun'), nofun = n('#g-nofun'), baja = n('#g-baja');
        const enc = fun + nofun + baja;
        if (enc !== g.cantidad && !confirm(`Contaste ${enc} de ${g.cantidad} esperadas. ¿Guardar así?`)) return;
        await guardar({tipo: 'GRUPO', grupo: g.id, esperada: g.cantidad, encontrada: enc, funcional: fun, noFuncional: nofun, baja,
                       area: g.area, resg: g.resg, notas: $('#g-notas').value.trim()}, [{campo: 'foto', dataUrl: S.foto.foto}]);
        history.back();
        return;
      }
      if (f.id === 'f-sobrante') {
        const estado = (f.querySelector('input[name="estado"]:checked') || {}).value;
        if (!S.foto.foto) throw new Error('Falta la foto del bien');
        if (!estado) throw new Error('Elige el estado');
        const n = ((await DB.kvGet('contadorSobrante')) || 0) + 1;
        await DB.kvSet('contadorSobrante', n);
        const fotos = [{campo: 'foto', dataUrl: S.foto.foto}];
        if (S.foto.foto2) fotos.push({campo: 'foto2', dataUrl: S.foto.foto2});
        await guardar({tipo: 'SOBRANTE', folioProvisional: `S-${S.disp}-${String(n).padStart(3, '0')}`, desc: $('#s-desc').value.trim(),
                       marca: $('#s-marca').value.trim(), modelo: $('#s-modelo').value.trim(), serie: $('#s-serie').value.trim(),
                       inv: $('#s-inv').value.trim(), area: $('#s-area').value, subarea: $('#s-subarea').value.trim(),
                       resg: $('#s-resg').value.trim(), estado, notas: $('#s-notas').value.trim()}, fotos);
        history.back();
        return;
      }
      if (f.id === 'f-usuario') {
        if (!navigator.onLine) throw new Error('Se necesita internet');
        const datos = {usuario: $('#u-usuario').value.trim().toLowerCase(), nombre: $('#u-nombre').value.trim(),
                       rol: $('#u-rol') ? $('#u-rol').value : 'validador', password: $('#u-pass').value, activo: $('#u-activo').checked,
                       areas: [...document.querySelectorAll('input[name="u-area"]:checked')].map(i => i.value)};
        const r = await API.llamar('guardarUsuario', {token: S.ses.token, usuarioDatos: datos});
        if (!r.ok) throw new Error(r.error);
        toast('Usuario guardado', 'ok');
        history.back();
      }
    } catch (err) {
      toast(err.message, 'error');
      if (err.sesion) salir(true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  window.addEventListener('online', () => { refrescarCabecera(); sincronizar(true); });
  window.addEventListener('offline', () => refrescarCabecera());
  setInterval(() => { if (S.ses && S.cola.length && navigator.onLine) sincronizar(true); }, 120000);

  // ---------------------------------------------------------------- arranque
  (async function iniciar() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    try { await cargarLocal(); } catch (e) { app().innerHTML = `<p class="vacio">Este navegador no permite guardar datos: ${esc(e.message)}</p>`; return; }
    history.replaceState({vista: 'areas', p: {}}, '');
    render();
    if (S.ses && S.meta && navigator.onLine) sincronizar(true);
  })();

  window._AF = S; // para diagnóstico
})();
