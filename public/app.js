// =====================================================================
// PANEL DEL DIRECTOR
// Asistencia semanal, Méritos y deméritos, Notas, Docentes y Secciones
// se leen y se guardan en el servidor (PostgreSQL).
// =====================================================================

// ---------- Hablar con el servidor ----------
// Envia y recibe JSON. Si la sesion venció, manda al login.
async function api(url, opciones = {}) {
  const respuesta = await fetch(url, {
    ...opciones,
    headers: { 'Content-Type': 'application/json' },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined
  });

  if (respuesta.status === 401) {
    location.href = 'login.html';
    throw new Error('Sesión vencida');
  }

  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw new Error(datos.error || 'Error del servidor');
  return datos;
}

// Crea un elemento con clase y texto (el texto va con textContent: seguro)
function crear(etiqueta, clase = '', texto = '') {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto) el.textContent = texto;
  return el;
}

function iniciales(nombre) {
  return nombre.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
}

// Para que "maria" también encuentre "María"
function sinTildes(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// ---------- Fecha de hoy ----------
function textoFecha() {
  const texto = new Date().toLocaleDateString('es-SV', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

const fechaBarra = document.getElementById('fecha-actual');
if (fechaBarra) fechaBarra.textContent = textoFecha();

// Fecha de hoy como AAAA-MM-DD (para el nombre de los archivos)
function hoyISO() {
  const h = new Date();
  const mes = String(h.getMonth() + 1).padStart(2, '0');
  const dia = String(h.getDate()).padStart(2, '0');
  return `${h.getFullYear()}-${mes}-${dia}`;
}

// ---------- Ruta de la barra superior ----------
function actualizarRuta() {
  const hash = location.hash || '#asistencias';
  const enlace = document.querySelector(`.lateral__menu a[href="${hash}"]`);
  const ruta = document.getElementById('ruta-actual');
  if (ruta) ruta.textContent = enlace ? enlace.textContent.trim() : 'Asistencia';
}

window.addEventListener('hashchange', actualizarRuta);
actualizarRuta();

// ---------- Asistencia semanal (últimos 7 días, desde el servidor) ----------
const tablaJornadas = document.getElementById('tabla-jornadas');
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// "2026-11-04" -> "04 nov 2026"
function fechaCorta(iso) {
  const [anio, mes, dia] = iso.split('-');
  return `${dia} ${MESES_CORTOS[Number(mes) - 1]} ${anio}`;
}

function celdaNumero(valor, clase = '') {
  const td = document.createElement('td');
  td.append(clase ? crear('span', `insignia ${clase}`, String(valor)) : String(valor));
  return td;
}

function filaJornada(j) {
  const fila = document.createElement('tr');
  fila.dataset.fecha = j.fecha;
  fila.dataset.seccionId = j.seccion_id;

  const celdaSeccion = document.createElement('td');
  celdaSeccion.append(crear('strong', '', j.seccion));

  const boton = crear('button', 'boton-mini', '↓ Descargar');
  boton.type = 'button';
  boton.dataset.descargarJornada = '';
  const celdaDescarga = document.createElement('td');
  celdaDescarga.append(boton);

  const total = j.presentes + j.ausencias + j.tardes + j.justificadas;

  fila.append(
    crear('td', '', fechaCorta(j.fecha)),
    celdaSeccion,
    crear('td', '', j.docente),
    celdaNumero(j.presentes, 'insignia--merito'),
    celdaNumero(j.ausencias, 'insignia--demerito'),
    celdaNumero(j.tardes),
    celdaNumero(j.justificadas),
    celdaNumero(total),
    celdaDescarga
  );
  return fila;
}

async function cargarJornadas() {
  if (!tablaJornadas) return;

  const jornadas = await api('/api/director/asistencias');
  const cuerpo = tablaJornadas.querySelector('tbody');

  if (jornadas.length === 0) {
    const fila = document.createElement('tr');
    const celda = crear('td', 'sin-asignaciones', 'Aún no hay jornadas registradas en los últimos 7 días.');
    celda.colSpan = 9;
    fila.append(celda);
    cuerpo.replaceChildren(fila);
  } else {
    cuerpo.replaceChildren(...jornadas.map(filaJornada));
  }

  document.getElementById('conteo-jornadas').textContent =
    jornadas.length === 1
      ? '1 jornada registrada en los últimos 7 días'
      : `${jornadas.length} jornadas registradas en los últimos 7 días`;
}

// Descargar el documento de una jornada (el servidor lo entrega como archivo)
tablaJornadas?.addEventListener('click', (e) => {
  const boton = e.target.closest('[data-descargar-jornada]');
  if (!boton) return;

  const fila = boton.closest('tr');
  window.location.href = `/api/director/asistencias/${fila.dataset.fecha}/${fila.dataset.seccionId}/documento`;
});

// Al volver a la pestaña de Asistencia se actualiza la lista
window.addEventListener('hashchange', () => {
  if (!location.hash || location.hash === '#asistencias') {
    cargarJornadas().catch(console.error);
  }
});

// =====================================================================
// DATOS QUE VIENEN DEL SERVIDOR
// =====================================================================
let docentes = [];     // GET /api/docentes
let secciones = [];    // GET /api/secciones
let asignaturas = [];  // GET /api/director/asignaturas

async function cargarDatos() {
  [docentes, secciones, asignaturas] = await Promise.all([
    api('/api/docentes'),
    api('/api/secciones'),
    api('/api/director/asignaturas')
  ]);
  renderDocentes();
  renderSecciones();
  llenarFiltroMeritosSeccion();
}

// =====================================================================
// MÉRITOS Y DEMÉRITOS (con filtros y descarga)
// =====================================================================
const tablaMeritos = document.getElementById('tabla-meritos');
const tablaResumenMeritos = document.getElementById('tabla-resumen-meritos');
const filtroMeritosSeccion = document.getElementById('meritos-seccion');
const filtroMeritosTipo = document.getElementById('meritos-tipo');
const filtroMeritosDesde = document.getElementById('meritos-desde');
const filtroMeritosHasta = document.getElementById('meritos-hasta');

const LIMITE_MERITOS = 1000;   // el servidor entrega como máximo 1000 registros
let registrosMeritos = [];     // lo que se ve en pantalla (también se usa para descargar)

// Llena el filtro de secciones con las que hay en la base de datos
function llenarFiltroMeritosSeccion() {
  if (!filtroMeritosSeccion) return;
  const actual = filtroMeritosSeccion.value;

  filtroMeritosSeccion.replaceChildren(new Option('Todas las secciones', ''));
  secciones.forEach(s => filtroMeritosSeccion.append(new Option(`${s.nombre} (${s.anio})`, s.id)));
  filtroMeritosSeccion.value = [...filtroMeritosSeccion.options].some(o => o.value === actual) ? actual : '';
}

// Arma el texto de filtros para la dirección: ?seccion_id=2&tipo=demerito
function consultaMeritos() {
  const p = new URLSearchParams();
  if (filtroMeritosSeccion.value) p.set('seccion_id', filtroMeritosSeccion.value);
  if (filtroMeritosTipo.value) p.set('tipo', filtroMeritosTipo.value);
  if (filtroMeritosDesde.value) p.set('desde', filtroMeritosDesde.value);
  if (filtroMeritosHasta.value) p.set('hasta', filtroMeritosHasta.value);
  const texto = p.toString();
  return texto ? `?${texto}` : '';
}

function textoSeguimiento(m) {
  if (m.tipo !== 'demerito') return '—';
  return m.mejoria === 'mejoro' ? 'Mejoró' : 'En seguimiento';
}

function filaMerito(m) {
  const fila = document.createElement('tr');
  const nombre = `${m.nombres} ${m.apellidos}`;

  const celdaEstudiante = document.createElement('td');
  celdaEstudiante.append(crear('span', 'avatar avatar--chico', iniciales(nombre)), crear('strong', '', nombre));

  const esMerito = m.tipo === 'merito';
  const celdaTipo = document.createElement('td');
  celdaTipo.append(crear(
    'span',
    `insignia ${esMerito ? 'insignia--merito' : 'insignia--demerito'}`,
    esMerito ? 'Mérito' : 'Demérito'
  ));

  const celdaMotivo = document.createElement('td');
  const detalle = document.createElement('div');
  detalle.append(crear('strong', '', m.motivo), crear('small', '', m.detalle || ''));
  celdaMotivo.append(detalle);

  fila.append(
    crear('td', '', fechaCorta(m.fecha)),
    celdaEstudiante,
    crear('td', '', m.seccion || ''),
    celdaTipo,
    celdaMotivo,
    crear('td', '', m.registrado_por),
    crear('td', '', textoSeguimiento(m))
  );
  return fila;
}

function filaResumenMerito(r) {
  const fila = document.createElement('tr');
  const nombre = `${r.nombres} ${r.apellidos}`;

  const celdaEstudiante = document.createElement('td');
  celdaEstudiante.append(crear('span', 'avatar avatar--chico', iniciales(nombre)), crear('strong', '', nombre));

  fila.append(
    celdaEstudiante,
    crear('td', '', r.seccion || ''),
    celdaNumero(r.puntos_meritos, 'insignia--merito'),
    celdaNumero(r.puntos_demeritos, 'insignia--demerito'),
    crear('td', '', r.balance > 0 ? `+${r.balance}` : String(r.balance))
  );
  return fila;
}

function filaVacia(texto, columnas) {
  const fila = document.createElement('tr');
  const celda = crear('td', 'sin-asignaciones', texto);
  celda.colSpan = columnas;
  fila.append(celda);
  return fila;
}

async function cargarMeritos() {
  if (!tablaMeritos) return;

  const consulta = consultaMeritos();
  const [registros, resumen] = await Promise.all([
    api(`/api/director/reportes/meritos${consulta}`),
    api(`/api/director/reportes/meritos/resumen${consulta}`)
  ]);
  registrosMeritos = registros;

  tablaMeritos.querySelector('tbody').replaceChildren(
    ...(registros.length === 0
      ? [filaVacia('No hay méritos ni deméritos con estos filtros.', 7)]
      : registros.map(filaMerito))
  );

  tablaResumenMeritos.querySelector('tbody').replaceChildren(
    ...(resumen.length === 0
      ? [filaVacia('Sin datos para resumir.', 5)]
      : resumen.map(filaResumenMerito))
  );

  let conteo = registros.length === 1 ? '1 registro' : `${registros.length} registros`;
  if (registros.length >= LIMITE_MERITOS) {
    conteo += ` (se muestran los primeros ${LIMITE_MERITOS}; usa los filtros para ver el resto)`;
  }
  document.getElementById('conteo-meritos').textContent = conteo;
}

function actualizarMeritos() {
  cargarMeritos().catch(err => {
    console.error(err);
    alert(`No se pudieron cargar los méritos y deméritos: ${err.message}`);
  });
}

[filtroMeritosSeccion, filtroMeritosTipo, filtroMeritosDesde, filtroMeritosHasta]
  .forEach(el => el?.addEventListener('change', actualizarMeritos));

document.getElementById('meritos-limpiar')?.addEventListener('click', () => {
  filtroMeritosSeccion.value = '';
  filtroMeritosTipo.value = '';
  filtroMeritosDesde.value = '';
  filtroMeritosHasta.value = '';
  actualizarMeritos();
});

// Al abrir la pestaña de Méritos y deméritos se actualiza la lista
window.addEventListener('hashchange', () => {
  if (location.hash === '#meritos') actualizarMeritos();
});

// ----- Descargar el documento (CSV, se abre en Excel) -----
function celdaCsv(valor) {
  let texto = String(valor ?? '');
  if (/^[=+\-@]/.test(texto)) texto = "'" + texto;   // evita que Excel lo tome como fórmula
  return /[",\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function textoOpcion(select, vacio) {
  return select.value ? select.options[select.selectedIndex].text : vacio;
}

document.getElementById('meritos-descargar')?.addEventListener('click', () => {
  if (registrosMeritos.length === 0) {
    alert('No hay registros para descargar con estos filtros.');
    return;
  }

  const lineas = [
    ['Centro Escolar Marcelina Viuda de Granillo'],
    ['Méritos y deméritos'],
    ['Generado el', hoyISO()],
    ['Sección', textoOpcion(filtroMeritosSeccion, 'Todas')],
    ['Tipo', textoOpcion(filtroMeritosTipo, 'Méritos y deméritos')],
    ['Desde', filtroMeritosDesde.value || '—'],
    ['Hasta', filtroMeritosHasta.value || '—'],
    [],
    ['Fecha', 'Estudiante', 'Sección', 'Grado', 'Tipo', 'Motivo', 'Detalle', 'Registrado por', 'Seguimiento'],
    ...registrosMeritos.map(m => [
      m.fecha,
      `${m.apellidos}, ${m.nombres}`,
      m.seccion || '',
      m.grado || '',
      m.tipo === 'merito' ? 'Mérito' : 'Demérito',
      m.motivo,
      m.detalle || '',
      m.registrado_por,
      textoSeguimiento(m)
    ])
  ].map(fila => fila.map(celdaCsv).join(','));

  // \uFEFF al inicio para que Excel respete las tildes
  const blob = new Blob(['\uFEFF' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(blob);
  enlace.download = `meritos-demeritos-${hoyISO()}.csv`;
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(enlace.href), 1000);
});

// =====================================================================
// NOTAS (el director solo consulta y descarga)
// =====================================================================
const NOMBRES_TRIMESTRE = ['Primer trimestre', 'Segundo trimestre', 'Tercer trimestre'];

const tablaNotas = document.getElementById('tabla-notas');
const selNotasSeccion = document.getElementById('notas-seccion');
const selNotasMateria = document.getElementById('notas-materia');
const selNotasPeriodo = document.getElementById('notas-periodo');
const textoNotasInfo = document.getElementById('notas-info');

let materiasNotas = [];   // GET /api/director/notas/asignaciones
let datosNotas = null;    // { asignacion, actividades, estudiantes, notas } de la materia elegida

function redondear(numero) {
  return Math.round(numero * 100) / 100;
}

// Promedio ponderado de las actividades que ya tienen nota (null si no hay ninguna)
function promedioPonderado(actividades, notaDe) {
  let suma = 0;
  let pesos = 0;
  actividades.forEach(a => {
    const nota = notaDe(a);
    if (nota === null) return;
    suma += nota * a.porcentaje;
    pesos += a.porcentaje;
  });
  return pesos > 0 ? suma / pesos : null;
}

function textoNota(nota) {
  return nota === null ? '—' : nota.toFixed(2);
}

// Nota de cada trimestre y promedio final (simple, de los trimestres que ya tienen notas)
function resumenNotas(alumnoId, actividades, mapaNotas) {
  const trimestres = [1, 2, 3].map(p => promedioPonderado(
    actividades.filter(a => a.periodo === p),
    a => mapaNotas.get(`${a.id}|${alumnoId}`) ?? null
  ));
  const conNota = trimestres.filter(n => n !== null);
  const promedioFinal = conNota.length === 0
    ? null
    : conNota.reduce((suma, n) => suma + n, 0) / conNota.length;
  return { trimestres, promedioFinal };
}

// Llena el filtro de secciones (solo las que tienen materias asignadas)
async function cargarMateriasNotas() {
  if (!tablaNotas) return;

  const previa = selNotasSeccion.value;
  materiasNotas = await api('/api/director/notas/asignaciones');

  const seccionesConMaterias = new Map();
  materiasNotas.forEach(m => {
    if (!seccionesConMaterias.has(m.seccion_id)) {
      seccionesConMaterias.set(m.seccion_id, `${m.seccion} (${m.anio})`);
    }
  });

  selNotasSeccion.replaceChildren(new Option('Selecciona una sección', ''));
  seccionesConMaterias.forEach((nombre, id) => selNotasSeccion.append(new Option(nombre, id)));
  selNotasSeccion.value = seccionesConMaterias.has(Number(previa)) ? previa : '';

  llenarMateriasNotas();
  await cargarTablaNotas();
}

// Llena el filtro de materias según la sección elegida
function llenarMateriasNotas() {
  const previa = selNotasMateria.value;
  const seccionId = Number(selNotasSeccion.value);

  selNotasMateria.replaceChildren(new Option('Selecciona una materia', ''));
  materiasNotas
    .filter(m => m.seccion_id === seccionId)
    .forEach(m => {
      const sufijo = m.actividades === 0 ? ' · sin actividades' : '';
      selNotasMateria.append(new Option(`${m.asignatura} · ${m.docente}${sufijo}`, m.id));
    });

  selNotasMateria.value = [...selNotasMateria.options].some(o => o.value === previa) ? previa : '';
}

// Trae las actividades y notas de la materia elegida
async function cargarTablaNotas() {
  const id = Number(selNotasMateria.value);
  datosNotas = id ? await api(`/api/director/notas?asignacion_id=${id}`) : null;
  renderNotas();
}

function renderNotas() {
  const encabezado = tablaNotas.querySelector('thead');
  const cuerpo = tablaNotas.querySelector('tbody');

  if (!datosNotas) {
    textoNotasInfo.textContent = 'Selecciona una sección y una materia para ver las notas.';
    encabezado.replaceChildren();
    cuerpo.replaceChildren();
    return;
  }

  const { asignacion, actividades, estudiantes, notas } = datosNotas;
  const periodo = Number(selNotasPeriodo.value);
  const delPeriodo = actividades.filter(a => a.periodo === periodo);
  const total = redondear(delPeriodo.reduce((suma, a) => suma + a.porcentaje, 0));

  const estadoPeriodo = delPeriodo.length === 0
    ? `${NOMBRES_TRIMESTRE[periodo - 1]}: sin actividades`
    : `${NOMBRES_TRIMESTRE[periodo - 1]}: ${total}% asignado`;
  textoNotasInfo.textContent =
    `${asignacion.asignatura} · ${asignacion.grado} ${asignacion.seccion} (${asignacion.anio}) · ` +
    `Docente: ${asignacion.docente} · ${estadoPeriodo}`;

  if (estudiantes.length === 0) {
    encabezado.replaceChildren();
    cuerpo.replaceChildren(filaVacia('No hay estudiantes en esta sección.', 5));
    return;
  }

  const mapaNotas = new Map(notas.map(n => [`${n.actividad_id}|${n.alumno_id}`, n.nota]));

  const filaEncabezado = document.createElement('tr');
  filaEncabezado.append(crear('th', '', 'Estudiante'));
  delPeriodo.forEach(a => {
    const th = document.createElement('th');
    th.append(crear('span', '', a.nombre), document.createElement('br'), crear('small', '', `${a.porcentaje}%`));
    filaEncabezado.append(th);
  });
  filaEncabezado.append(
    crear('th', '', 'Trimestre 1'),
    crear('th', '', 'Trimestre 2'),
    crear('th', '', 'Trimestre 3'),
    crear('th', '', 'Promedio final')
  );
  encabezado.replaceChildren(filaEncabezado);

  cuerpo.replaceChildren(...estudiantes.map(e => {
    const fila = document.createElement('tr');

    const celdaNombre = document.createElement('td');
    const info = document.createElement('div');
    info.append(crear('strong', '', e.nombre), crear('small', '', e.codigo || ''));
    celdaNombre.append(crear('span', 'avatar avatar--chico', iniciales(e.nombre)), info);
    fila.append(celdaNombre);

    delPeriodo.forEach(a => {
      const nota = mapaNotas.get(`${a.id}|${e.id}`);
      fila.append(crear('td', '', nota === undefined ? '—' : nota.toFixed(2)));
    });

    const { trimestres, promedioFinal } = resumenNotas(e.id, actividades, mapaNotas);
    trimestres.forEach(n => fila.append(crear('td', '', textoNota(n))));
    fila.append(crear('td', '', textoNota(promedioFinal)));
    fila.lastChild.style.fontWeight = '600';

    return fila;
  }));
}

function actualizarNotas() {
  cargarMateriasNotas().catch(err => {
    console.error(err);
    alert(`No se pudieron cargar las notas: ${err.message}`);
  });
}

selNotasSeccion?.addEventListener('change', () => {
  llenarMateriasNotas();
  cargarTablaNotas().catch(err => alert(err.message));
});
selNotasMateria?.addEventListener('change', () => {
  cargarTablaNotas().catch(err => alert(err.message));
});
selNotasPeriodo?.addEventListener('change', renderNotas);

// Al abrir la pestaña de Notas se actualiza la información
window.addEventListener('hashchange', () => {
  if (location.hash === '#notas') actualizarNotas();
});

// ----- Descargar el documento de notas (CSV, se abre en Excel) -----
document.getElementById('notas-descargar')?.addEventListener('click', () => {
  if (!datosNotas || datosNotas.estudiantes.length === 0) {
    alert('Selecciona una materia con estudiantes para descargar el documento.');
    return;
  }

  const { asignacion, actividades, estudiantes, notas } = datosNotas;
  const periodo = Number(selNotasPeriodo.value);
  const delPeriodo = actividades.filter(a => a.periodo === periodo);
  const mapaNotas = new Map(notas.map(n => [`${n.actividad_id}|${n.alumno_id}`, n.nota]));

  const lineas = [
    ['Centro Escolar Marcelina Viuda de Granillo'],
    ['Notas por materia'],
    ['Generado el', hoyISO()],
    ['Sección', `${asignacion.grado} ${asignacion.seccion} (${asignacion.anio})`],
    ['Materia', asignacion.asignatura],
    ['Docente', asignacion.docente],
    ['Actividades mostradas', NOMBRES_TRIMESTRE[periodo - 1]],
    [],
    [
      'Estudiante', 'Código',
      ...delPeriodo.map(a => `${a.nombre} (${a.porcentaje}%)`),
      'Trimestre 1', 'Trimestre 2', 'Trimestre 3', 'Promedio final'
    ],
    ...estudiantes.map(e => {
      const { trimestres, promedioFinal } = resumenNotas(e.id, actividades, mapaNotas);
      return [
        e.nombre,
        e.codigo || '',
        ...delPeriodo.map(a => {
          const nota = mapaNotas.get(`${a.id}|${e.id}`);
          return nota === undefined ? '' : nota.toFixed(2);
        }),
        ...trimestres.map(n => (n === null ? '' : n.toFixed(2))),
        promedioFinal === null ? '' : promedioFinal.toFixed(2)
      ];
    })
  ].map(fila => fila.map(celdaCsv).join(','));

  const nombreArchivo = sinTildes(`${asignacion.asignatura}-${asignacion.seccion}`)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // \uFEFF al inicio para que Excel respete las tildes
  const blob = new Blob(['\uFEFF' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(blob);
  enlace.download = `notas-${nombreArchivo}-${hoyISO()}.csv`;
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(enlace.href), 1000);
});

// =====================================================================
// DOCENTES: tabla, buscador y filtro
// =====================================================================
const tablaDocentes = document.getElementById('tabla-docentes');
const buscador = document.getElementById('buscar-docente');
const filtroEstado = document.getElementById('filtro-estado-docente');

// Agrupa las asignaciones por materia: { "Matemática": ["6° A", "6° B"] }
function agruparPorMateria(asignaciones) {
  const porMateria = {};
  asignaciones.forEach(a => (porMateria[a.asignatura] ??= []).push(a.seccion));
  return porMateria;
}

function celdaAsignacionesDocente(asignaciones) {
  const celda = document.createElement('td');
  const entradas = Object.entries(agruparPorMateria(asignaciones));

  if (entradas.length === 0) {
    celda.append(crear('span', 'sin-asignaciones', 'Sin asignaciones'));
    return celda;
  }

  const lista = crear('ul', 'asignaciones');
  entradas.forEach(([materia, nombresSeccion]) => {
    const li = document.createElement('li');
    li.append(crear('strong', '', materia), ` · ${nombresSeccion.join(', ')}`);
    lista.append(li);
  });
  celda.append(lista);
  return celda;
}

function filaDocente(d) {
  const fila = document.createElement('tr');
  fila.dataset.id = d.id;
  fila.dataset.estado = d.activo ? 'activo' : 'inactivo';

  const celdaNombre = document.createElement('td');
  const info = document.createElement('div');
  info.append(crear('strong', '', d.nombre), crear('small', '', d.correo || ''));
  celdaNombre.append(crear('span', 'avatar avatar--chico', iniciales(d.nombre)), info);

  const celdaEstado = document.createElement('td');
  celdaEstado.append(crear(
    'span',
    `insignia ${d.activo ? 'insignia--activo' : 'insignia--inactivo'}`,
    d.activo ? 'Activo' : 'Inactivo'
  ));

  const celdaAcciones = document.createElement('td');
  const editar = crear('button', 'boton-texto', 'Editar');
  editar.type = 'button';
  editar.dataset.accion = 'editar';
  const estado = crear('button', 'boton-texto', d.activo ? 'Desactivar' : 'Activar');
  estado.type = 'button';
  estado.dataset.accion = 'estado';
  const restablecer = crear('button', 'boton-texto', 'Restablecer contraseña');
  restablecer.type = 'button';
  restablecer.dataset.accion = 'restablecer';
  const eliminar = crear('button', 'boton-texto', 'Eliminar');
  eliminar.type = 'button';
  eliminar.dataset.accion = 'eliminar';
  celdaAcciones.append(editar, estado, restablecer, eliminar);

  fila.append(
    celdaNombre,
    celdaAsignacionesDocente(d.asignaciones),
    crear('td', '', d.especialidad || ''),
    crear('td', '', d.telefono || ''),
    celdaEstado,
    celdaAcciones
  );
  return fila;
}

function renderDocentes() {
  if (!tablaDocentes) return;

  const texto = sinTildes(buscador.value.trim());
  const estado = filtroEstado.value;

  const visibles = docentes.filter(d => {
    const coincide = sinTildes(`${d.nombre} ${d.correo || ''}`).includes(texto);
    const estadoDocente = d.activo ? 'activo' : 'inactivo';
    return coincide && (estado === 'todos' || estado === estadoDocente);
  });

  const cuerpo = tablaDocentes.querySelector('tbody');
  cuerpo.replaceChildren(...visibles.map(filaDocente));

  document.getElementById('conteo-docentes').textContent =
    visibles.length === 1 ? '1 docente' : `${visibles.length} docentes`;
}

buscador?.addEventListener('input', renderDocentes);
filtroEstado?.addEventListener('change', renderDocentes);

// Activar / desactivar
tablaDocentes?.addEventListener('click', async (e) => {
  const boton = e.target.closest('[data-accion="estado"]');
  if (!boton) return;

  const docente = docentes.find(d => d.id === Number(boton.closest('tr').dataset.id));
  if (!docente) return;

  const activar = !docente.activo;
  if (!activar && !confirm(`¿Desactivar a ${docente.nombre}? Su historial se conserva y se le cerrará la sesión.`)) return;

  try {
    await api(`/api/docentes/${docente.id}/estado`, {
      method: 'PATCH',
      body: { activo: activar }
    });
    await cargarDatos();
  } catch (err) {
    alert(err.message);
  }
});

// Restablecer contraseña (genera otra clave temporal)
tablaDocentes?.addEventListener('click', async (e) => {
  const boton = e.target.closest('[data-accion="restablecer"]');
  if (!boton) return;

  const docente = docentes.find(d => d.id === Number(boton.closest('tr').dataset.id));
  if (!docente) return;

  const aviso = `¿Restablecer la contraseña de ${docente.nombre}?\n\n` +
    'Se cerrará su sesión y deberá elegir una contraseña nueva al entrar.';
  if (!confirm(aviso)) return;

  try {
    const resultado = await api(`/api/docentes/${docente.id}/restablecer-contrasena`, { method: 'POST' });
    alert(
      `Contraseña restablecida para ${docente.nombre}.\n\n` +
      `Contraseña temporal: ${resultado.clave_temporal}\n\n` +
      'Cópiala ahora: no se volverá a mostrar.'
    );
  } catch (err) {
    alert(err.message);
  }
});

// Eliminar docente (el servidor lo rechaza si tiene historial)
tablaDocentes?.addEventListener('click', async (e) => {
  const boton = e.target.closest('[data-accion="eliminar"]');
  if (!boton) return;

  const docente = docentes.find(d => d.id === Number(boton.closest('tr').dataset.id));
  if (!docente) return;

  const aviso = `¿Eliminar a ${docente.nombre}?\n\n` +
    'Se borrará su cuenta y se quitarán sus asignaciones. Esta acción no se puede deshacer.\n\n' +
    'Si solo quieres que deje de entrar al sistema, usa "Desactivar".';
  if (!confirm(aviso)) return;

  try {
    await api(`/api/docentes/${docente.id}`, { method: 'DELETE' });
    await cargarDatos();
  } catch (err) {
    alert(err.message);
  }
});

// =====================================================================
// SECCIONES: tabla
// =====================================================================
const tablaSecciones = document.getElementById('tabla-secciones');
const filtroAnio = document.getElementById('filtro-anio');

function llenarFiltroAnio() {
  if (!filtroAnio) return;
  const actual = filtroAnio.value;
  const anios = [...new Set(secciones.map(s => s.anio))].sort((a, b) => b - a);

  filtroAnio.replaceChildren(new Option('Todos los años', 'todos'));
  anios.forEach(a => filtroAnio.append(new Option(a, a)));
  filtroAnio.value = [...filtroAnio.options].some(o => o.value === actual) ? actual : 'todos';
}

function filaSeccion(s) {
  const fila = document.createElement('tr');
  fila.dataset.id = s.id;

  const celdaNombre = document.createElement('td');
  celdaNombre.append(crear('strong', '', s.nombre));

  const celdaMaterias = document.createElement('td');
  if (s.materias.length === 0) {
    celdaMaterias.append(crear('span', 'sin-asignaciones', 'Sin materias asignadas'));
  } else {
    const lista = crear('ul', 'asignaciones');
    s.materias.forEach(m => {
      const li = document.createElement('li');
      li.append(crear('strong', '', m.asignatura), ` · ${m.docente}`);
      lista.append(li);
    });
    celdaMaterias.append(lista);
  }

  const celdaAcciones = document.createElement('td');
  const editar = crear('button', 'boton-texto', 'Editar');
  editar.type = 'button';
  editar.dataset.accion = 'editar';
  const eliminar = crear('button', 'boton-texto', 'Eliminar');
  eliminar.type = 'button';
  eliminar.dataset.accion = 'eliminar';
  celdaAcciones.append(editar, eliminar);

  fila.append(
    celdaNombre,
    crear('td', '', s.grado),
    crear('td', '', String(s.anio)),
    crear('td', '', String(s.estudiantes)),
    celdaMaterias,
    celdaAcciones
  );
  return fila;
}

function renderSecciones() {
  if (!tablaSecciones) return;

  llenarFiltroAnio();
  const anio = filtroAnio.value;
  const visibles = secciones.filter(s => anio === 'todos' || s.anio === Number(anio));

  tablaSecciones.querySelector('tbody').replaceChildren(...visibles.map(filaSeccion));
  document.getElementById('conteo-secciones').textContent =
    visibles.length === 1 ? '1 sección' : `${visibles.length} secciones`;
}

filtroAnio?.addEventListener('change', renderSecciones);

// Eliminar sección (el servidor lo rechaza si tiene estudiantes, notas o actividades)
tablaSecciones?.addEventListener('click', async (e) => {
  const boton = e.target.closest('[data-accion="eliminar"]');
  if (!boton) return;

  const seccion = secciones.find(s => s.id === Number(boton.closest('tr').dataset.id));
  if (!seccion) return;

  const aviso = `¿Eliminar la sección ${seccion.nombre} (${seccion.anio})?\n\n` +
    'Se quitarán sus materias y docentes asignados. Esta acción no se puede deshacer.';
  if (!confirm(aviso)) return;

  try {
    await api(`/api/secciones/${seccion.id}`, { method: 'DELETE' });
    await cargarDatos();
  } catch (err) {
    alert(err.message);
  }
});

// =====================================================================
// VENTANA: NUEVO / EDITAR DOCENTE
// =====================================================================
const modalDocente = document.getElementById('modal-docente');
const formDocente = document.getElementById('form-docente');
const listaAsignaciones = document.getElementById('lista-asignaciones');
const plantillaAsignacion = document.getElementById('plantilla-asignacion');
let docenteEnEdicion = null; // null = se está creando uno nuevo

// Una fila "sección + materia"; los valores son los id de la base de datos
function agregarFilaAsignacion(seccionId = '', asignaturaId = '') {
  const fila = plantillaAsignacion.content.cloneNode(true);

  const selSeccion = fila.querySelector('.asig-seccion');
  selSeccion.replaceChildren(new Option('Sección', ''));
  secciones.forEach(s => selSeccion.append(new Option(`${s.nombre} (${s.anio})`, s.id)));
  selSeccion.value = seccionId;

  const selMateria = fila.querySelector('.asig-materia');
  selMateria.replaceChildren(new Option('Materia', ''));
  asignaturas.forEach(a => selMateria.append(new Option(a.nombre, a.id)));
  selMateria.value = asignaturaId;

  listaAsignaciones.appendChild(fila);
}

function abrirModalDocente(docente) {
  docenteEnEdicion = docente;
  formDocente.reset();
  listaAsignaciones.replaceChildren();

  const editando = docente !== null;
  document.getElementById('titulo-docente').textContent = editando ? 'Editar docente' : 'Nuevo docente';
  document.getElementById('btn-guardar-docente').textContent = editando ? 'Guardar cambios' : 'Guardar docente';

  if (editando) {
    document.getElementById('doc-nombre').value = docente.nombre;
    document.getElementById('doc-correo').value = docente.correo || '';
    document.getElementById('doc-especialidad').value = docente.especialidad || '';
    document.getElementById('doc-telefono').value = docente.telefono || '';
    docente.asignaciones.forEach(a => agregarFilaAsignacion(a.seccion_id, a.asignatura_id));
  }

  modalDocente.showModal();
}

formDocente?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const asignacionesForm = [...listaAsignaciones.querySelectorAll('.asignacion-fila')].map(f => ({
    seccion_id: Number(f.querySelector('.asig-seccion').value),
    asignatura_id: Number(f.querySelector('.asig-materia').value)
  }));

  // La misma materia en la misma sección no puede repetirse
  const claves = asignacionesForm.map(a => `${a.seccion_id}|${a.asignatura_id}`);
  if (new Set(claves).size !== claves.length) {
    alert('Hay asignaciones repetidas: la misma materia en la misma sección.');
    return;
  }

  const cuerpo = {
    nombre: document.getElementById('doc-nombre').value.trim(),
    correo: document.getElementById('doc-correo').value.trim(),
    especialidad: document.getElementById('doc-especialidad').value.trim(),
    telefono: document.getElementById('doc-telefono').value.trim(),
    asignaciones: asignacionesForm
  };

  try {
    if (docenteEnEdicion) {
      await api(`/api/docentes/${docenteEnEdicion.id}`, { method: 'PUT', body: cuerpo });
    } else {
      const creado = await api('/api/docentes', { method: 'POST', body: cuerpo });
      // El servidor devuelve la contraseña temporal una sola vez
      if (creado.clave_temporal) {
        alert(`Docente creado.\n\nContraseña temporal: ${creado.clave_temporal}\n\nCópiala ahora: no se volverá a mostrar.`);
      }
    }
    modalDocente.close();
    await cargarDatos();
  } catch (err) {
    alert(err.message);
  }
});

// =====================================================================
// VENTANA: NUEVA / EDITAR SECCIÓN
// =====================================================================
const modalSeccion = document.getElementById('modal-seccion');
const formSeccion = document.getElementById('form-seccion');
const listaMaterias = document.getElementById('lista-materias');
const plantillaMateria = document.getElementById('plantilla-materia');
let seccionEnEdicion = null; // null = se está creando una nueva

function nuevaFilaMateria(asignaturaId = '', docenteId = '') {
  const fila = plantillaMateria.content.cloneNode(true);

  const selMateria = fila.querySelector('.mat-materia');
  selMateria.replaceChildren(new Option('Materia', ''));
  asignaturas.forEach(a => selMateria.append(new Option(a.nombre, a.id)));
  selMateria.value = asignaturaId;

  const selDocente = fila.querySelector('.mat-docente');
  selDocente.replaceChildren(new Option('Docente', ''));
  // Solo docentes activos; si el docente asignado ya no lo está, igual se
  // muestra para no perder la asignación al editar
  docentes
    .filter(d => d.activo || d.id === Number(docenteId))
    .forEach(d => selDocente.append(new Option(d.nombre, d.id)));
  selDocente.value = docenteId;

  listaMaterias.appendChild(fila);
}

function abrirModalSeccion(seccion) {
  seccionEnEdicion = seccion;
  formSeccion.reset();
  listaMaterias.replaceChildren();

  const editando = seccion !== null;
  document.getElementById('titulo-seccion').textContent = editando ? 'Editar sección' : 'Nueva sección';
  document.getElementById('btn-guardar-seccion').textContent = editando ? 'Guardar cambios' : 'Guardar sección';

  if (editando) {
    document.getElementById('sec-nombre').value = seccion.nombre;
    document.getElementById('sec-grado').value = seccion.grado;
    document.getElementById('sec-anio').value = seccion.anio;
    seccion.materias.forEach(m => nuevaFilaMateria(m.asignatura_id, m.docente_id));
  } else {
    document.getElementById('sec-anio').value = new Date().getFullYear();
  }

  modalSeccion.showModal();
}

formSeccion?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const materias = [...listaMaterias.querySelectorAll('.asignacion-fila')].map(f => ({
    asignatura_id: Number(f.querySelector('.mat-materia').value),
    docente_id: Number(f.querySelector('.mat-docente').value)
  }));

  // Una materia solo puede tener un docente en la misma sección
  if (new Set(materias.map(m => m.asignatura_id)).size !== materias.length) {
    alert('Hay una materia repetida: cada materia tiene un solo docente en la sección.');
    return;
  }

  const cuerpo = {
    nombre: document.getElementById('sec-nombre').value.trim(),
    grado: document.getElementById('sec-grado').value.trim(),
    anio: Number(document.getElementById('sec-anio').value),
    materias
  };

  try {
    if (seccionEnEdicion) {
      await api(`/api/secciones/${seccionEnEdicion.id}`, { method: 'PUT', body: cuerpo });
    } else {
      await api('/api/secciones', { method: 'POST', body: cuerpo });
    }
    modalSeccion.close();
    await cargarDatos();
  } catch (err) {
    alert(err.message);
  }
});

// =====================================================================
// CLICS: abrir y cerrar ventanas
// =====================================================================
document.addEventListener('click', (e) => {
  // Docentes
  if (e.target.closest('#btn-nuevo-docente')) abrirModalDocente(null);

  const editarDocente = e.target.closest('#tabla-docentes [data-accion="editar"]');
  if (editarDocente) {
    const id = Number(editarDocente.closest('tr').dataset.id);
    abrirModalDocente(docentes.find(d => d.id === id) || null);
  }

  if (e.target.closest('#modal-docente [data-cerrar]')) modalDocente.close();
  if (e.target.closest('#btn-agregar-asignacion')) {
    if (secciones.length === 0) {
      alert('Primero crea al menos una sección. Puedes guardar el docente sin asignaciones y asignárselas después.');
    } else if (asignaturas.length === 0) {
      alert('No hay materias cargadas en el sistema (tabla asignaturas). Guarda el docente sin asignaciones por ahora.');
    } else {
      agregarFilaAsignacion();
    }
  }

  const quitarAsignacion = e.target.closest('[data-quitar-asignacion]');
  if (quitarAsignacion) quitarAsignacion.closest('.asignacion-fila').remove();

  // Secciones
  if (e.target.closest('#btn-nueva-seccion')) abrirModalSeccion(null);

  const editarSeccion = e.target.closest('#tabla-secciones [data-accion="editar"]');
  if (editarSeccion) {
    const id = Number(editarSeccion.closest('tr').dataset.id);
    abrirModalSeccion(secciones.find(s => s.id === id) || null);
  }

  if (e.target.closest('#modal-seccion [data-cerrar]')) modalSeccion.close();
  if (e.target.closest('#btn-agregar-materia')) {
    if (asignaturas.length === 0) {
      alert('No hay materias cargadas en el sistema (tabla asignaturas). Guarda la sección sin materias por ahora.');
    } else if (!docentes.some(d => d.activo)) {
      alert('Primero crea al menos un docente activo. Puedes guardar la sección sin materias y asignarlas después.');
    } else {
      nuevaFilaMateria();
    }
  }

  const quitarMateria = e.target.closest('[data-quitar-materia]');
  if (quitarMateria) quitarMateria.closest('.asignacion-fila').remove();
});

// =====================================================================
// MENÚ DESPLEGABLE (celular)
// =====================================================================
const menuBoton = document.getElementById('btn-menu');
const menuLateral = document.querySelector('.lateral');

menuBoton?.addEventListener('click', () => {
  const abierto = menuLateral.classList.toggle('lateral--abierto');
  menuBoton.setAttribute('aria-expanded', abierto);
});

// Al elegir una opción, el menú se cierra para mostrar la sección
document.querySelector('.lateral__menu')?.addEventListener('click', (e) => {
  if (e.target.closest('a')) {
    menuLateral.classList.remove('lateral--abierto');
    menuBoton?.setAttribute('aria-expanded', 'false');
  }
});

// =====================================================================
// SESIÓN: salir y arranque
// =====================================================================
document.getElementById('btn-salir')?.addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (err) {
    // Si falla igual se vuelve al login
  }
  location.href = 'login.html';
});

async function iniciar() {
  try {
    const sesion = await api('/api/sesion');

    if (sesion.rol !== 'director') {
      location.href = 'docente.html';
      return;
    }

    document.getElementById('usuario-nombre').textContent = sesion.nombre;
    await cargarDatos();
    await cargarJornadas();
    await cargarMeritos().catch(console.error);
    await cargarMateriasNotas().catch(console.error);
  } catch (err) {
    console.error(err);
    alert(`No se pudieron cargar los datos: ${err.message}`);
  }
}

iniciar();