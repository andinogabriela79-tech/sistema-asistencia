// =====================================================================
// PANEL DEL DOCENTE
// Asistencia, estudiantes, méritos/deméritos, seguimiento y actividades
// con notas se leen y guardan en el servidor (PostgreSQL).
// =====================================================================

// ---------- Hablar con el servidor ----------
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

// ---------- Utilidades ----------
function crear(etiqueta, clase = '', texto = '') {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto) el.textContent = texto;
  return el;
}

function iniciales(nombre) {
  return nombre.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
}

function aISO(fecha) {
  const a = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${a}-${m}-${d}`;
}

function desdeISO(texto) {
  const [a, m, d] = texto.split('-').map(Number);
  return new Date(a, m - 1, d);
}

// Redondea a 2 decimales (para porcentajes y notas)
function redondear(numero) {
  return Math.round(numero * 100) / 100;
}

// Muestra el error de una acción sin romper la página
async function intentar(accion) {
  try {
    await accion();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Estado de la pantalla ----------
let seccionesDocente = [];  // GET /api/docente/secciones
let seccionActual = null;   // id de la sección elegida
let estudiantes = [];       // GET /api/docente/estudiantes
let sesion = null;          // { nombre, rol }
let cambiosSinGuardar = false;

// Actividades y notas
let materiasDocente = [];       // GET /api/docente/asignaciones
let asignacionActual = null;    // id de la materia elegida
let datosNotas = null;          // { actividades, estudiantes, notas }
let notasGuardadas = new Map(); // "actividad|alumno" -> nota guardada en el servidor
let notasSinGuardar = false;
let periodoPrevio = '1';        // para volver atrás si se cancela un cambio de trimestre

const inputFecha = document.getElementById('filtro-fecha');
const chipDia = document.getElementById('dia-semana');
const selSeccionAsistencia = document.getElementById('filtro-seccion');
const selSeccionEstudiantes = document.getElementById('filtro-seccion-estudiantes');
const cuerpoAsistencia = document.getElementById('cuerpo-asistencia');
const contenedorSemana = document.getElementById('semana');
const estadoGuardado = document.getElementById('estado-guardado');

function seccionPorId(id) {
  return seccionesDocente.find(s => s.id === Number(id));
}

// ---------- Fecha de hoy en la barra ----------
document.getElementById('fecha-actual').textContent =
  new Date().toLocaleDateString('es-SV', { weekday: 'short', day: 'numeric', month: 'short' });

// ---------- Ruta de la barra superior ----------
function actualizarRuta() {
  const hash = location.hash || '#asistencia';
  const enlace = document.querySelector(`.lateral__menu a[href="${hash}"]`);
  document.getElementById('ruta-actual').textContent = enlace ? enlace.textContent.trim() : 'Asistencia';
}

window.addEventListener('hashchange', () => {
  actualizarRuta();
  // Al abrir Actividades y notas se actualiza la lista de materias y estudiantes
  if (location.hash === '#actividades' && !notasSinGuardar) intentar(cargarMaterias);
});
actualizarRuta();

// =====================================================================
// SECCIONES
// =====================================================================
function llenarSelectSecciones(select) {
  select.replaceChildren();
  seccionesDocente.forEach(s => select.append(new Option(`${s.nombre} (${s.anio})`, s.id)));
  if (seccionActual) select.value = seccionActual;
}

function actualizarEtiquetas() {
  const s = seccionPorId(seccionActual);
  document.querySelectorAll('.etiqueta-seccion').forEach(el => {
    el.textContent = s
      ? `C.E Marcelina Viuda de Granillo · ${s.nombre}`
      : 'C.E Marcelina Viuda de Granillo';
  });
}

function confirmarDescarte() {
  if (!cambiosSinGuardar) return true;
  return confirm('Tienes asistencia sin guardar. ¿Descartar los cambios?');
}

async function cambiarSeccion(id) {
  if (!confirmarDescarte()) {
    selSeccionAsistencia.value = seccionActual;
    selSeccionEstudiantes.value = seccionActual;
    return;
  }
  seccionActual = Number(id);
  selSeccionAsistencia.value = seccionActual;
  selSeccionEstudiantes.value = seccionActual;
  actualizarEtiquetas();
  await recargarTodo();
}

selSeccionAsistencia.addEventListener('change', () => intentar(() => cambiarSeccion(selSeccionAsistencia.value)));
selSeccionEstudiantes.addEventListener('change', () => intentar(() => cambiarSeccion(selSeccionEstudiantes.value)));

async function recargarTodo() {
  if (!seccionActual) return;
  cambiosSinGuardar = false;
  estadoGuardado.textContent = '';
  await Promise.all([cargarAsistencia(), cargarEstudiantes(), cargarSeguimiento()]);
}

// =====================================================================
// ASISTENCIA
// =====================================================================
function seleccionarFecha(fecha) {
  inputFecha.value = aISO(fecha);
  chipDia.textContent = fecha.toLocaleDateString('es-SV', { weekday: 'long' });
}

async function cambiarFecha(fecha) {
  if (!confirmarDescarte()) {
    seleccionarFecha(desdeISO(inputFecha.dataset.anterior || inputFecha.value));
    return;
  }
  seleccionarFecha(fecha);
  cambiosSinGuardar = false;
  estadoGuardado.textContent = '';
  await cargarAsistencia();
}

inputFecha.addEventListener('change', () => {
  if (inputFecha.value) intentar(() => cambiarFecha(desdeISO(inputFecha.value)));
});

contenedorSemana.addEventListener('click', (e) => {
  const boton = e.target.closest('.dia');
  if (boton) intentar(() => cambiarFecha(desdeISO(boton.dataset.fecha)));
});

// La base guarda 'justificado'; en pantalla el valor es 'justificada'
function estadoParaPantalla(estado) {
  return estado === 'justificado' ? 'justificada' : estado;
}

const ESTADOS = [
  ['presente', 'P Presente'],
  ['ausente', 'A Ausente'],
  ['tarde', 'T Tarde'],
  ['justificada', 'J Justificada']
];

function filaAsistencia(e) {
  const fila = document.createElement('tr');
  fila.dataset.alumnoId = e.alumno_id;

  const celdaNombre = document.createElement('td');
  const info = document.createElement('div');
  info.append(crear('strong', '', e.nombre), crear('small', '', e.codigo || ''));
  celdaNombre.append(crear('span', 'avatar avatar--chico', iniciales(e.nombre)), info);

  const celdaEstados = document.createElement('td');
  const actual = estadoParaPantalla(e.estado);

  ESTADOS.forEach(([valor, texto]) => {
    const etiqueta = crear('label', 'estado');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `est-${e.alumno_id}`;
    radio.value = valor;
    radio.checked = actual === valor;
    etiqueta.append(radio, crear('span', '', texto));
    celdaEstados.append(etiqueta);
  });

  fila.append(celdaNombre, celdaEstados);
  return fila;
}

function actualizarConteoAsistencia() {
  const contar = valor => cuerpoAsistencia.querySelectorAll(`input[value="${valor}"]:checked`).length;
  const spans = document.querySelectorAll('#conteo-asistencia span');
  spans[0].textContent = `${contar('presente')} Presentes`;
  spans[1].textContent = `${contar('ausente')} Ausentes`;
  spans[2].textContent = `${contar('tarde')} Tarde`;
}

function pintarSemana(semana) {
  contenedorSemana.replaceChildren();
  semana.forEach(d => {
    const fecha = desdeISO(d.fecha);
    const boton = crear('button', 'dia');
    boton.type = 'button';
    boton.dataset.fecha = d.fecha;
    boton.classList.toggle('dia--activo', d.fecha === inputFecha.value);
    boton.append(
      crear('span', '', fecha.toLocaleDateString('es-SV', { weekday: 'short' }).replace('.', '')),
      crear('strong', '', String(fecha.getDate())),
      crear('small', '', `${d.registrados} registrados`)
    );
    contenedorSemana.append(boton);
  });
}

async function cargarAsistencia() {
  if (!seccionActual) return;

  const datos = await api(
    `/api/docente/asistencia?seccion_id=${seccionActual}&fecha=${inputFecha.value}`
  );

  if (datos.estudiantes.length === 0) {
    const fila = document.createElement('tr');
    const celda = crear('td', 'sin-asignaciones', 'No hay estudiantes en esta sección. Agrégalos en la pestaña Estudiantes.');
    celda.colSpan = 2;
    fila.append(celda);
    cuerpoAsistencia.replaceChildren(fila);
  } else {
    cuerpoAsistencia.replaceChildren(...datos.estudiantes.map(filaAsistencia));
  }

  pintarSemana(datos.semana);
  actualizarConteoAsistencia();
}

cuerpoAsistencia.addEventListener('change', () => {
  cambiosSinGuardar = true;
  estadoGuardado.textContent = '';
  actualizarConteoAsistencia();
});

document.getElementById('btn-todos-presentes').addEventListener('click', () => {
  cuerpoAsistencia.querySelectorAll('input[value="presente"]').forEach(r => { r.checked = true; });
  cambiosSinGuardar = true;
  estadoGuardado.textContent = '';
  actualizarConteoAsistencia();
});

document.getElementById('btn-guardar-asistencia').addEventListener('click', () => intentar(async () => {
  const filas = [...cuerpoAsistencia.querySelectorAll('tr[data-alumno-id]')];

  const registros = filas
    .map(f => {
      const marcado = f.querySelector('input:checked');
      return marcado ? { alumno_id: Number(f.dataset.alumnoId), estado: marcado.value } : null;
    })
    .filter(Boolean);

  if (registros.length === 0) {
    alert('Marca la asistencia de al menos un estudiante.');
    return;
  }

  const sinMarcar = filas.length - registros.length;
  if (sinMarcar > 0 && !confirm(`${sinMarcar} estudiante(s) sin marcar no se guardarán. ¿Continuar?`)) return;

  const totales = await api('/api/docente/asistencia', {
    method: 'PUT',
    body: { seccion_id: seccionActual, fecha: inputFecha.value, registros }
  });

  cambiosSinGuardar = false;
  estadoGuardado.textContent =
    `Guardado: ${totales.presentes} presentes, ${totales.ausentes} ausentes, ${totales.tardes} tarde.`;
  await cargarAsistencia();
}));

// =====================================================================
// ESTUDIANTES
// =====================================================================
const cuerpoEstudiantes = document.querySelector('#tabla-estudiantes tbody');

function filaEstudiante(e) {
  const fila = document.createElement('tr');
  fila.dataset.id = e.id;

  const nombre = `${e.nombres} ${e.apellidos}`;
  const celdaNombre = document.createElement('td');
  const info = document.createElement('div');
  info.append(crear('strong', '', nombre), crear('small', '', e.codigo || ''));
  celdaNombre.append(crear('span', 'avatar avatar--chico', iniciales(nombre)), info);

  const celdaMeritos = document.createElement('td');
  celdaMeritos.append(crear('span', 'insignia insignia--merito', `✦ ${e.meritos}`));

  const celdaDemeritos = document.createElement('td');
  celdaDemeritos.append(crear('span', 'insignia insignia--demerito', `${e.demeritos} registrados`));

  const boton = crear('button', 'boton-texto', '+ Registrar');
  boton.type = 'button';
  boton.dataset.registrar = e.id;
  const celdaAccion = document.createElement('td');
  celdaAccion.append(boton);

  fila.append(celdaNombre, celdaMeritos, celdaDemeritos, celdaAccion);
  return fila;
}

async function cargarEstudiantes() {
  if (!seccionActual) return;

  estudiantes = await api(`/api/docente/estudiantes?seccion_id=${seccionActual}`);

  if (estudiantes.length === 0) {
    const fila = document.createElement('tr');
    const celda = crear('td', 'sin-asignaciones', 'Aún no hay estudiantes en esta sección.');
    celda.colSpan = 4;
    fila.append(celda);
    cuerpoEstudiantes.replaceChildren(fila);
  } else {
    cuerpoEstudiantes.replaceChildren(...estudiantes.map(filaEstudiante));
  }

  document.getElementById('conteo-estudiantes').textContent =
    estudiantes.length === 1
      ? '1 estudiante en esta sección'
      : `${estudiantes.length} estudiantes en esta sección`;
}

// =====================================================================
// SEGUIMIENTO Y MEJORA
// =====================================================================
const cuerpoSeguimiento = document.querySelector('#tabla-seguimiento tbody');
const filtroSeguimiento = document.getElementById('filtro-seguimiento');

function filaSeguimiento(r) {
  const fila = document.createElement('tr');
  fila.dataset.id = r.id;

  const celdaNombre = document.createElement('td');
  const info = document.createElement('div');
  info.append(crear('strong', '', r.estudiante), crear('small', '', r.codigo || ''));
  celdaNombre.append(crear('span', 'avatar avatar--chico', iniciales(r.estudiante)), info);

  const esMerito = r.tipo === 'merito';
  const celdaTipo = document.createElement('td');
  celdaTipo.append(crear(
    'span',
    `insignia ${esMerito ? 'insignia--merito' : 'insignia--demerito'}`,
    esMerito ? 'Mérito' : 'Demérito'
  ));

  const celdaRegistro = document.createElement('td');
  const detalle = document.createElement('div');
  detalle.append(crear('strong', '', r.motivo), crear('small', '', r.detalle || ''));
  celdaRegistro.append(detalle);

  const selMejoria = document.createElement('select');
  selMejoria.setAttribute('aria-label', 'Estado de mejoría');
  selMejoria.dataset.mejoria = '';
  selMejoria.append(new Option('En seguimiento', 'en_seguimiento'), new Option('Mejoró', 'mejoro'));
  selMejoria.value = r.mejoria;
  const celdaMejoria = document.createElement('td');
  celdaMejoria.append(selMejoria);

  const eliminar = crear('button', 'boton-texto', 'Eliminar');
  eliminar.type = 'button';
  eliminar.dataset.eliminar = '';
  const celdaEliminar = document.createElement('td');
  celdaEliminar.append(eliminar);

  fila.append(celdaNombre, celdaTipo, celdaRegistro, crear('td', '', r.fecha), celdaMejoria, celdaEliminar);
  return fila;
}

async function cargarSeguimiento() {
  if (!seccionActual) return;

  const registros = await api(
    `/api/docente/seguimiento?seccion_id=${seccionActual}&mejoria=${filtroSeguimiento.value}`
  );

  if (registros.length === 0) {
    const fila = document.createElement('tr');
    const celda = crear('td', 'sin-asignaciones', 'No hay registros de seguimiento.');
    celda.colSpan = 6;
    fila.append(celda);
    cuerpoSeguimiento.replaceChildren(fila);
  } else {
    cuerpoSeguimiento.replaceChildren(...registros.map(filaSeguimiento));
  }
}

filtroSeguimiento.addEventListener('change', () => intentar(cargarSeguimiento));

cuerpoSeguimiento.addEventListener('change', (e) => {
  const select = e.target.closest('[data-mejoria]');
  if (!select) return;

  const id = select.closest('tr').dataset.id;
  intentar(async () => {
    try {
      await api(`/api/docente/registros/${id}`, { method: 'PATCH', body: { mejoria: select.value } });
    } finally {
      await cargarSeguimiento();
    }
  });
});

cuerpoSeguimiento.addEventListener('click', (e) => {
  const boton = e.target.closest('[data-eliminar]');
  if (!boton) return;

  if (!confirm('¿Eliminar este registro? No se puede deshacer.')) return;

  const id = boton.closest('tr').dataset.id;
  intentar(async () => {
    await api(`/api/docente/registros/${id}`, { method: 'DELETE' });
    await Promise.all([cargarSeguimiento(), cargarEstudiantes()]);
  });
});

// =====================================================================
// VENTANA: REGISTRAR MÉRITO / DEMÉRITO
// =====================================================================
const modalRegistro = document.getElementById('modal-registro');
const formRegistro = document.getElementById('form-registro');
const selRegistroEstudiante = document.getElementById('registro-estudiante');

function abrirModalRegistro(alumnoId = '') {
  if (estudiantes.length === 0) {
    alert('Primero agrega estudiantes a esta sección.');
    return;
  }

  formRegistro.reset();
  selRegistroEstudiante.replaceChildren(new Option('Selecciona un estudiante', ''));
  estudiantes.forEach(e => selRegistroEstudiante.append(new Option(`${e.nombres} ${e.apellidos}`, e.id)));
  selRegistroEstudiante.value = alumnoId;
  document.getElementById('registro-fecha').value = aISO(new Date());
  modalRegistro.showModal();
}

formRegistro.addEventListener('submit', (e) => {
  e.preventDefault();

  intentar(async () => {
    await api('/api/docente/registros', {
      method: 'POST',
      body: {
        alumno_id: Number(selRegistroEstudiante.value),
        tipo: formRegistro.querySelector('input[name="tipo"]:checked').value,
        motivo: document.getElementById('registro-motivo').value.trim(),
        detalle: document.getElementById('registro-detalle').value.trim(),
        fecha: document.getElementById('registro-fecha').value
      }
    });
    modalRegistro.close();
    await Promise.all([cargarEstudiantes(), cargarSeguimiento()]);
  });
});

// =====================================================================
// VENTANA: NUEVO ESTUDIANTE
// =====================================================================
const modalEstudiante = document.getElementById('modal-estudiante');
const formEstudiante = document.getElementById('form-estudiante');
const selEstSeccion = document.getElementById('est-seccion');

function abrirModalEstudiante() {
  if (!seccionActual) {
    alert('Todavía no tienes secciones asignadas.');
    return;
  }
  formEstudiante.reset();
  llenarSelectSecciones(selEstSeccion);
  selEstSeccion.value = seccionActual;
  modalEstudiante.showModal();
}

formEstudiante.addEventListener('submit', (e) => {
  e.preventDefault();

  intentar(async () => {
    const cuerpo = {
      nombres: document.getElementById('est-nombres').value.trim(),
      apellidos: document.getElementById('est-apellidos').value.trim(),
      codigo: document.getElementById('est-codigo').value.trim(),
      seccion_id: Number(selEstSeccion.value)
    };
    const nacimiento = document.getElementById('est-nacimiento').value;
    if (nacimiento) cuerpo.fecha_nacimiento = nacimiento;

    await api('/api/docente/estudiantes', { method: 'POST', body: cuerpo });
    modalEstudiante.close();

    if (cuerpo.seccion_id === seccionActual) {
      await Promise.all([cargarEstudiantes(), cargarAsistencia()]);
    }
  });
});

// =====================================================================
// CLICS: abrir y cerrar ventanas
// =====================================================================
document.addEventListener('click', (e) => {
  if (e.target.closest('#btn-registrar')) abrirModalRegistro();

  const registrar = e.target.closest('[data-registrar]');
  if (registrar) abrirModalRegistro(registrar.dataset.registrar);

  if (e.target.closest('#btn-nuevo-estudiante')) abrirModalEstudiante();

  if (e.target.closest('#modal-registro [data-cerrar]')) modalRegistro.close();
  if (e.target.closest('#modal-estudiante [data-cerrar]')) modalEstudiante.close();
});

// =====================================================================
// ACTIVIDADES Y NOTAS
// =====================================================================
const NOMBRES_TRIMESTRE = ['Primer trimestre', 'Segundo trimestre', 'Tercer trimestre'];

const selNotasMateria = document.getElementById('notas-materia');
const selNotasPeriodo = document.getElementById('notas-periodo');
const textoPorcentaje = document.getElementById('notas-porcentaje');
const avisoNotas = document.getElementById('notas-aviso');
const cuerpoActividades = document.querySelector('#tabla-actividades tbody');
const tablaNotas = document.getElementById('tabla-notas');
const estadoNotas = document.getElementById('estado-notas');
const btnNuevaActividad = document.getElementById('btn-nueva-actividad');
const btnGuardarNotas = document.getElementById('btn-guardar-notas');

function periodoActual() {
  return Number(selNotasPeriodo.value);
}

function actividadesDelPeriodo(periodo) {
  return datosNotas ? datosNotas.actividades.filter(a => a.periodo === periodo) : [];
}

// Lo que ya hay asignado en el trimestre, sin contar una actividad (al editarla)
function porcentajeAsignado(periodo, excluirId = 0) {
  return redondear(
    actividadesDelPeriodo(periodo)
      .filter(a => a.id !== excluirId)
      .reduce((suma, a) => suma + a.porcentaje, 0)
  );
}

// Si hay notas escritas sin guardar, pregunta antes de perderlas
function confirmarDescarteNotas() {
  if (!notasSinGuardar) return true;
  return confirm('Tienes notas sin guardar. ¿Descartar los cambios?');
}

// ----- Materias del docente -----
async function cargarMaterias() {
  const previa = asignacionActual;
  materiasDocente = await api('/api/docente/asignaciones');

  selNotasMateria.replaceChildren();
  materiasDocente.forEach(m => {
    selNotasMateria.append(new Option(`${m.asignatura} · ${m.seccion} (${m.anio})`, m.id));
  });

  const hayMaterias = materiasDocente.length > 0;
  avisoNotas.hidden = hayMaterias;
  btnNuevaActividad.disabled = !hayMaterias;
  btnGuardarNotas.disabled = !hayMaterias;

  if (!hayMaterias) {
    asignacionActual = null;
    datosNotas = null;
    notasSinGuardar = false;
    renderNotas();
    return;
  }

  asignacionActual = materiasDocente.some(m => m.id === previa) ? previa : materiasDocente[0].id;
  selNotasMateria.value = asignacionActual;
  await cargarNotasMateria();
}

// ----- Actividades, estudiantes y notas de la materia elegida -----
async function cargarNotasMateria() {
  if (!asignacionActual) return;

  datosNotas = await api(`/api/docente/notas?asignacion_id=${asignacionActual}`);
  notasGuardadas = new Map(datosNotas.notas.map(n => [`${n.actividad_id}|${n.alumno_id}`, n.nota]));
  notasSinGuardar = false;
  estadoNotas.textContent = '';
  renderNotas();
}

// ----- Cálculo de notas -----

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

// Lo que hay escrito en una casilla (null si está vacía o fuera de 0 a 10)
function leerNota(input) {
  if (input.value === '') return null;
  const n = Number(input.value);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
}

// Recalcula la nota del trimestre y el promedio final de cada estudiante
function actualizarPromedios() {
  const periodo = periodoActual();

  tablaNotas.querySelectorAll('tbody tr[data-alumno-id]').forEach(fila => {
    const alumnoId = Number(fila.dataset.alumnoId);

    const escritas = new Map();
    fila.querySelectorAll('.nota-input').forEach(input => {
      escritas.set(Number(input.dataset.actividadId), leerNota(input));
    });

    // Trimestre elegido: lo que está escrito ahora. Los otros: lo ya guardado.
    const trimestres = [1, 2, 3].map(p => promedioPonderado(actividadesDelPeriodo(p), a => (
      p === periodo
        ? (escritas.get(a.id) ?? null)
        : (notasGuardadas.get(`${a.id}|${alumnoId}`) ?? null)
    )));

    const delTrimestre = trimestres[periodo - 1];
    const conNota = trimestres.filter(n => n !== null);

    fila.querySelector('.celda-trimestre').textContent =
      delTrimestre === null ? '—' : delTrimestre.toFixed(2);
    fila.querySelector('.celda-final').textContent =
      conNota.length === 0 ? '—' : (conNota.reduce((s, n) => s + n, 0) / conNota.length).toFixed(2);
  });
}

// ----- Tabla de actividades -----
function filaActividad(a) {
  const fila = document.createElement('tr');
  fila.dataset.id = a.id;

  const celdaNombre = document.createElement('td');
  celdaNombre.append(crear('strong', '', a.nombre));

  const editar = crear('button', 'boton-texto', 'Editar');
  editar.type = 'button';
  editar.dataset.accion = 'editar';
  const eliminar = crear('button', 'boton-texto', 'Eliminar');
  eliminar.type = 'button';
  eliminar.dataset.accion = 'eliminar';
  const celdaAcciones = document.createElement('td');
  celdaAcciones.append(editar, eliminar);

  fila.append(celdaNombre, crear('td', '', `${a.porcentaje}%`), celdaAcciones);
  return fila;
}

function filaMensaje(mensaje) {
  const fila = document.createElement('tr');
  const celda = crear('td', 'sin-asignaciones', mensaje);
  celda.colSpan = 4;
  fila.append(celda);
  return fila;
}

// ----- Tabla de notas -----
function filaNotas(estudiante, actividades) {
  const fila = document.createElement('tr');
  fila.dataset.alumnoId = estudiante.id;

  const celdaNombre = document.createElement('td');
  const info = document.createElement('div');
  info.append(crear('strong', '', estudiante.nombre), crear('small', '', estudiante.codigo || ''));
  celdaNombre.append(crear('span', 'avatar avatar--chico', iniciales(estudiante.nombre)), info);
  fila.append(celdaNombre);

  actividades.forEach(a => {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'nota-input';
    input.min = '0';
    input.max = '10';
    input.step = '0.01';
    input.inputMode = 'decimal';
    input.style.width = '5rem';
    input.setAttribute('aria-label', `Nota de ${estudiante.nombre} en ${a.nombre}`);

    const guardada = notasGuardadas.get(`${a.id}|${estudiante.id}`);
    input.value = guardada === undefined ? '' : String(guardada);
    input.dataset.original = input.value;
    input.dataset.actividadId = a.id;

    const celda = document.createElement('td');
    celda.append(input);
    fila.append(celda);
  });

  const celdaTrimestre = crear('td', 'celda-trimestre', '—');
  celdaTrimestre.style.fontWeight = '600';
  const celdaFinal = crear('td', 'celda-final', '—');
  celdaFinal.style.fontWeight = '600';
  fila.append(celdaTrimestre, celdaFinal);

  return fila;
}

function pintarTablaNotas(actividades) {
  const encabezado = tablaNotas.querySelector('thead');
  const cuerpo = tablaNotas.querySelector('tbody');

  if (!datosNotas) {
    encabezado.replaceChildren();
    cuerpo.replaceChildren();
    return;
  }
  if (datosNotas.estudiantes.length === 0) {
    encabezado.replaceChildren();
    cuerpo.replaceChildren(filaMensaje('No hay estudiantes en esta sección. Agrégalos en la pestaña Estudiantes.'));
    return;
  }
  if (actividades.length === 0) {
    encabezado.replaceChildren();
    cuerpo.replaceChildren(filaMensaje('Crea al menos una actividad para empezar a registrar notas.'));
    return;
  }

  const filaEncabezado = document.createElement('tr');
  filaEncabezado.append(crear('th', '', 'Estudiante'));
  actividades.forEach(a => {
    const th = document.createElement('th');
    th.append(crear('span', '', a.nombre), document.createElement('br'), crear('small', '', `${a.porcentaje}%`));
    filaEncabezado.append(th);
  });
  filaEncabezado.append(crear('th', '', 'Nota del trimestre'), crear('th', '', 'Promedio final'));
  encabezado.replaceChildren(filaEncabezado);

  cuerpo.replaceChildren(...datosNotas.estudiantes.map(e => filaNotas(e, actividades)));
  actualizarPromedios();
}

// ----- Pintar toda la pestaña -----
function renderNotas() {
  if (!datosNotas) {
    textoPorcentaje.textContent = '';
    cuerpoActividades.replaceChildren();
    pintarTablaNotas([]);
    return;
  }

  const periodo = periodoActual();
  const actividades = actividadesDelPeriodo(periodo);
  const total = porcentajeAsignado(periodo);

  if (total === 0) {
    textoPorcentaje.textContent = 'Aún no hay actividades en este trimestre.';
  } else if (total >= 100) {
    textoPorcentaje.textContent = 'Porcentaje asignado: 100% (completo)';
  } else {
    textoPorcentaje.textContent = `Porcentaje asignado: ${total}% · faltan ${redondear(100 - total)}%`;
  }

  cuerpoActividades.replaceChildren(
    ...(actividades.length === 0
      ? [filaMensaje('Aún no hay actividades en este trimestre. Crea la primera con "+ Nueva actividad".')]
      : actividades.map(filaActividad))
  );

  pintarTablaNotas(actividades);
}

// ----- Cambiar de materia o de trimestre -----
selNotasMateria.addEventListener('change', () => intentar(async () => {
  if (!confirmarDescarteNotas()) {
    selNotasMateria.value = asignacionActual;
    return;
  }
  asignacionActual = Number(selNotasMateria.value);
  await cargarNotasMateria();
}));

selNotasPeriodo.addEventListener('change', () => {
  if (!confirmarDescarteNotas()) {
    selNotasPeriodo.value = periodoPrevio;
    return;
  }
  periodoPrevio = selNotasPeriodo.value;
  notasSinGuardar = false;
  estadoNotas.textContent = '';
  renderNotas();
});

// ----- Escribir notas -----
tablaNotas.addEventListener('input', (e) => {
  const input = e.target.closest('.nota-input');
  if (!input) return;

  notasSinGuardar = true;
  estadoNotas.textContent = '';
  // Borde rojo si la nota está fuera de 0 a 10
  input.style.borderColor = input.value !== '' && leerNota(input) === null ? '#b42318' : '';
  actualizarPromedios();
});

btnGuardarNotas.addEventListener('click', () => intentar(async () => {
  if (!asignacionActual || !datosNotas) return;

  const cambios = [];
  for (const input of tablaNotas.querySelectorAll('.nota-input')) {
    if (input.value !== '') {
      const n = Number(input.value);
      if (!Number.isFinite(n) || n < 0 || n > 10) {
        input.focus();
        alert('Las notas deben estar entre 0 y 10.');
        return;
      }
    }

    const nueva = input.value === '' ? null : Number(input.value);
    const original = input.dataset.original === '' ? null : Number(input.dataset.original);
    if (nueva !== original) {
      cambios.push({
        actividad_id: Number(input.dataset.actividadId),
        alumno_id: Number(input.closest('tr').dataset.alumnoId),
        nota: nueva
      });
    }
  }

  if (cambios.length === 0) {
    estadoNotas.textContent = 'No hay cambios por guardar.';
    return;
  }

  await api('/api/docente/notas', {
    method: 'PUT',
    body: { asignacion_id: asignacionActual, notas: cambios }
  });

  await cargarNotasMateria();
  estadoNotas.textContent = `Guardado: ${cambios.length} ${cambios.length === 1 ? 'cambio' : 'cambios'}.`;
}));

// ----- Ventana: nueva / editar actividad -----
const modalActividad = document.getElementById('modal-actividad');
const formActividad = document.getElementById('form-actividad');
const inputActNombre = document.getElementById('actividad-nombre');
const inputActPorcentaje = document.getElementById('actividad-porcentaje');
let actividadEnEdicion = null; // null = se está creando una nueva

function abrirModalActividad(actividad) {
  if (!asignacionActual || !datosNotas) return;
  if (!confirmarDescarteNotas()) return;
  notasSinGuardar = false;

  const periodo = periodoActual();
  const editando = actividad !== null;
  const disponible = redondear(100 - porcentajeAsignado(periodo, editando ? actividad.id : 0));

  if (!editando && disponible <= 0) {
    alert('Este trimestre ya suma 100%. Para agregar otra actividad, baja primero el porcentaje de alguna existente.');
    return;
  }

  actividadEnEdicion = actividad;
  formActividad.reset();
  document.getElementById('titulo-actividad').textContent = editando ? 'Editar actividad' : 'Nueva actividad';
  document.getElementById('btn-guardar-actividad').textContent = editando ? 'Guardar cambios' : 'Guardar actividad';
  document.getElementById('ayuda-actividad').textContent =
    `${NOMBRES_TRIMESTRE[periodo - 1]} · Puedes asignar hasta ${disponible}%`;

  inputActPorcentaje.max = String(disponible);
  inputActPorcentaje.placeholder = `Máximo ${disponible}`;

  if (editando) {
    inputActNombre.value = actividad.nombre;
    inputActPorcentaje.value = String(actividad.porcentaje);
  }

  modalActividad.showModal();
}

btnNuevaActividad.addEventListener('click', () => abrirModalActividad(null));

modalActividad.addEventListener('click', (e) => {
  if (e.target.closest('[data-cerrar]')) modalActividad.close();
});

formActividad.addEventListener('submit', (e) => {
  e.preventDefault();

  intentar(async () => {
    const cuerpo = {
      nombre: inputActNombre.value.trim(),
      porcentaje: Number(inputActPorcentaje.value)
    };

    if (actividadEnEdicion) {
      await api(`/api/docente/actividades/${actividadEnEdicion.id}`, { method: 'PUT', body: cuerpo });
    } else {
      await api('/api/docente/actividades', {
        method: 'POST',
        body: { ...cuerpo, asignacion_id: asignacionActual, periodo: periodoActual() }
      });
    }

    modalActividad.close();
    await cargarNotasMateria();
  });
});

// ----- Editar y eliminar actividades -----
document.getElementById('tabla-actividades').addEventListener('click', (e) => {
  const boton = e.target.closest('[data-accion]');
  if (!boton || !datosNotas) return;

  const id = Number(boton.closest('tr').dataset.id);
  const actividad = datosNotas.actividades.find(a => a.id === id);
  if (!actividad) return;

  if (boton.dataset.accion === 'editar') {
    abrirModalActividad(actividad);
    return;
  }

  // Eliminar
  if (!confirmarDescarteNotas()) return;
  notasSinGuardar = false;

  const cantidad = datosNotas.notas.filter(n => n.actividad_id === id).length;
  const aviso = cantidad > 0
    ? `¿Eliminar la actividad "${actividad.nombre}"?\n\nSe borrarán también las ${cantidad} nota${cantidad === 1 ? '' : 's'} que ya tiene registrada${cantidad === 1 ? '' : 's'}. No se puede deshacer.`
    : `¿Eliminar la actividad "${actividad.nombre}"? No se puede deshacer.`;
  if (!confirm(aviso)) return;

  intentar(async () => {
    await api(`/api/docente/actividades/${id}`, { method: 'DELETE' });
    await cargarNotasMateria();
  });
});

// =====================================================================
// SESIÓN: salir y arranque
// =====================================================================
document.getElementById('btn-salir').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (err) {
    // Si falla igual se vuelve al login
  }
  location.href = 'login.html';
});

async function iniciar() {
  seleccionarFecha(new Date());

  try {
    sesion = await api('/api/sesion');

    if (sesion.rol !== 'docente') {
      location.href = 'director.html';
      return;
    }

    document.getElementById('usuario-nombre').textContent = sesion.nombre;
    document.getElementById('usuario-avatar').textContent = iniciales(sesion.nombre);
    document.getElementById('barra-avatar').textContent = iniciales(sesion.nombre);

    seccionesDocente = await api('/api/docente/secciones');

    if (seccionesDocente.length === 0) {
      document.getElementById('aviso-sin-secciones').hidden = false;
      avisoNotas.hidden = false;
      btnNuevaActividad.disabled = true;
      btnGuardarNotas.disabled = true;
      return;
    }

    seccionActual = seccionesDocente[0].id;
    llenarSelectSecciones(selSeccionAsistencia);
    llenarSelectSecciones(selSeccionEstudiantes);
    actualizarEtiquetas();
    await recargarTodo();
    await cargarMaterias();
  } catch (err) {
    console.error(err);
    alert(`No se pudieron cargar los datos: ${err.message}`);
  }
}

iniciar();