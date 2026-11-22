// =====================================================================
// SERVIDOR - Sistema de asistencia
// Centro Escolar Marcelina Viuda de Granillo
// =====================================================================

// ===== 1. LIBRERÍAS =====
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);   // sesiones en PostgreSQL
const bcrypt = require('bcrypt');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;   // el hosting define el puerto con PORT

// ===== 2. CONFIGURACIÓN =====
app.use(express.json());

// "producción" = cuando el sitio está publicado (se activa con NODE_ENV=production)
const EN_PRODUCCION = process.env.NODE_ENV === 'production';

// Detrás del proxy del hosting, para que la cookie segura funcione con HTTPS
if (EN_PRODUCCION) app.set('trust proxy', 1);

if (!process.env.SESSION_SECRET) {
  if (EN_PRODUCCION) {
    console.error('ERROR: falta SESSION_SECRET. Defínelo en las variables de entorno del hosting.');
    process.exit(1);
  }
  console.warn('AVISO: falta SESSION_SECRET en el archivo .env');
}

app.use(session({
  // Las sesiones se guardan en la tabla "sesiones" y sobreviven a los reinicios
  store: new pgSession({
    pool,
    tableName: 'sesiones',
    createTableIfMissing: false,    // la tabla se crea en prepararBaseDeDatos()
    pruneSessionInterval: false     // la limpieza la hacemos nosotros (ver el arranque)
  }),
  secret: process.env.SESSION_SECRET || 'cambia-esto-por-una-frase',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: EN_PRODUCCION,           // en producción solo viaja por HTTPS
    maxAge: 1000 * 60 * 60 * 2       // la sesión dura 2 horas
  }
}));

app.use(express.static('public'));

// Mientras la cuenta tenga contraseña temporal, solo se permiten estas rutas.
// Todo lo demás responde 401 y la pantalla vuelve al login, donde se le pide
// elegir una contraseña nueva.
const RUTAS_SIN_CAMBIO = [
  '/api/login',
  '/api/sesion',
  '/api/logout',
  '/api/cambiar-contrasena'
];

app.use('/api', (req, res, next) => {
  const usuario = req.session.usuario;
  if (usuario && usuario.debe_cambiar && !RUTAS_SIN_CAMBIO.includes(req.baseUrl + req.path)) {
    return res.status(401).json({ error: 'Debes cambiar tu contraseña primero', debe_cambiar: true });
  }
  next();
});

// ===== 3. FUNCIONES DE APOYO =====
const ESTADOS = ['presente', 'ausente', 'tarde', 'justificado'];

// "Hoy" según la hora de El Salvador (para no depender de la zona del servidor)
const HOY = "(NOW() AT TIME ZONE 'America/El_Salvador')::date";

// Error con código HTTP; el mensaje se muestra en pantalla
class ErrorHttp extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}

// Convierte cualquier error en una respuesta JSON
function fallo(res, err) {
  if (err instanceof ErrorHttp) return res.status(err.estado).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'Ese dato ya existe (correo, código o sección repetidos)' });
  if (err.code === '23503') return res.status(400).json({ error: 'Hay una sección, materia o docente que no existe' });
  console.error(err);
  res.status(500).json({ error: 'Error del servidor' });
}

// Envuelve una ruta para que cualquier error vaya a fallo()
const ruta = (fn) => (req, res) => fn(req, res).catch(err => fallo(res, err));

// Ejecuta varias consultas como una sola: se guarda todo o nada
async function enTransaccion(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
}

// Revisa que haya sesión iniciada
function requerirLogin(req, res, next) {
  if (!req.session.usuario) {
    return res.status(401).json({ error: 'No hay sesión activa' });
  }
  next();
}

// Revisa que el usuario tenga uno de los roles permitidos
function requerirRol(...roles) {
  return (req, res, next) => {
    if (!req.session.usuario) {
      return res.status(401).json({ error: 'No hay sesión activa' });
    }
    if (!roles.includes(req.session.usuario.rol)) {
      return res.status(403).json({ error: 'No tienes permiso' });
    }
    next();
  };
}

// Cierra todas las sesiones abiertas de una persona (en cualquier dispositivo)
async function cerrarSesionesDeUsuario(usuarioId) {
  await pool.query(
    "DELETE FROM sesiones WHERE sess->'usuario'->>'id' = $1",
    [String(usuarioId)]
  );
}

// ----- Lectura segura de datos -----
const texto = (v) => String(v ?? '').trim();

// Número entero positivo; devuelve 0 si no sirve
function entero(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// Fecha AAAA-MM-DD que realmente existe
function fechaValida(txt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txt || '')) return false;
  const [a, m, d] = txt.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

function sumarDias(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

// Lunes de la semana de una fecha (el domingo cuenta como final de semana)
function lunesDe(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay();   // 0 = domingo
  return sumarDias(iso, dia === 0 ? -6 : 1 - dia);
}

// Contraseña temporal legible (sin letras que se confunden)
function claveTemporal() {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let clave = '';
  for (const b of crypto.randomBytes(10)) clave += letras[b % letras.length];
  return clave;
}

// ----- Permisos del docente: solo trabaja con SU área -----
async function exigirSeccionDelDocente(usuarioId, seccionId) {
  const r = await pool.query(
    `SELECT 1
       FROM asignaciones a
       JOIN docentes d ON d.id = a.docente_id
      WHERE d.usuario_id = $1 AND a.seccion_id = $2
      LIMIT 1`,
    [usuarioId, seccionId]
  );
  if (r.rowCount === 0) throw new ErrorHttp(403, 'Esa sección no es de tu área');
}

async function exigirAlumnoDelDocente(usuarioId, alumnoId) {
  const r = await pool.query(
    `SELECT 1
       FROM alumnos al
       JOIN asignaciones a ON a.seccion_id = al.seccion_id
       JOIN docentes d ON d.id = a.docente_id
      WHERE al.id = $1 AND d.usuario_id = $2
      LIMIT 1`,
    [alumnoId, usuarioId]
  );
  if (r.rowCount === 0) throw new ErrorHttp(403, 'Ese estudiante no es de tu área');
}

// NUEVO: la materia (asignación) debe ser de este docente. "db" es el pool o un cliente
// de transacción. Devuelve { id, seccion_id }.
async function exigirAsignacionDelDocente(db, usuarioId, asignacionId) {
  const r = await db.query(
    `SELECT a.id, a.seccion_id
       FROM asignaciones a
       JOIN docentes d ON d.id = a.docente_id
      WHERE a.id = $1 AND d.usuario_id = $2`,
    [asignacionId, usuarioId]
  );
  if (r.rowCount === 0) throw new ErrorHttp(403, 'Esa materia no es de tu área');
  return r.rows[0];
}

// NUEVO: ¿esta materia de esta sección ya tiene actividades o notas guardadas?
// Si las tiene, no se puede quitar (se perderían las notas de los estudiantes).
async function asignacionTieneNotas(db, asignacionId) {
  const r = await db.query(
    `SELECT (SELECT COUNT(*) FROM actividades  WHERE asignacion_id = $1)::int AS actividades,
            (SELECT COUNT(*) FROM evaluaciones WHERE asignacion_id = $1)::int AS evaluaciones`,
    [asignacionId]
  );
  return r.rows[0].actividades > 0 || r.rows[0].evaluaciones > 0;
}

// ----- Validación de docentes, secciones y asignaciones -----
function leerDatosDocente(body) {
  const nombre = texto(body.nombre);
  const correo = texto(body.correo).toLowerCase();
  const especialidad = texto(body.especialidad) || null;
  const telefono = texto(body.telefono) || null;

  if (!nombre) throw new ErrorHttp(400, 'El nombre es obligatorio');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw new ErrorHttp(400, 'Escribe un correo válido');
  if (nombre.length > 100 || correo.length > 100 || (especialidad || '').length > 100 || (telefono || '').length > 20) {
    throw new ErrorHttp(400, 'Algún dato es demasiado largo');
  }
  return { nombre, correo, especialidad, telefono };
}

// Lista de { seccion_id, asignatura_id }; null si no se envió
function leerAsignaciones(lista) {
  if (lista === undefined) return null;
  if (!Array.isArray(lista)) throw new ErrorHttp(400, 'Asignaciones inválidas');

  const pares = lista.map(a => ({
    seccion_id: entero(a.seccion_id),
    asignatura_id: entero(a.asignatura_id)
  }));
  if (pares.some(p => !p.seccion_id || !p.asignatura_id)) {
    throw new ErrorHttp(400, 'Cada asignación necesita sección y materia');
  }
  if (new Set(pares.map(p => `${p.seccion_id}|${p.asignatura_id}`)).size !== pares.length) {
    throw new ErrorHttp(400, 'Hay asignaciones repetidas');
  }
  return pares;
}

function leerDatosSeccion(body) {
  const nombre = texto(body.nombre);
  const grado = texto(body.grado);
  const anio = Number(body.anio);

  if (!nombre || !grado) throw new ErrorHttp(400, 'El nombre y el grado son obligatorios');
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw new ErrorHttp(400, 'Año inválido');
  if (nombre.length > 50 || grado.length > 30) throw new ErrorHttp(400, 'Algún dato es demasiado largo');
  return { nombre, grado, anio };
}

// Lista de { asignatura_id, docente_id }; null si no se envió
function leerMaterias(lista) {
  if (lista === undefined) return null;
  if (!Array.isArray(lista)) throw new ErrorHttp(400, 'Materias inválidas');

  const materias = lista.map(m => ({
    asignatura_id: entero(m.asignatura_id),
    docente_id: entero(m.docente_id)
  }));
  if (materias.some(m => !m.asignatura_id || !m.docente_id)) {
    throw new ErrorHttp(400, 'Cada materia necesita su docente');
  }
  if (new Set(materias.map(m => m.asignatura_id)).size !== materias.length) {
    throw new ErrorHttp(400, 'Hay una materia repetida: cada materia tiene un solo docente en la sección');
  }
  return materias;
}

// Deja las asignaciones de un docente exactamente como se pidieron
// (solo borra las que sobran y agrega las nuevas, no toca las demás)
async function sincronizarAsignacionesDocente(c, docenteId, deseadas) {
  const actuales = (await c.query(
    'SELECT id, seccion_id, asignatura_id FROM asignaciones WHERE docente_id = $1', [docenteId]
  )).rows;

  const clave = (s, a) => `${s}|${a}`;
  const deseadasSet = new Set(deseadas.map(d => clave(d.seccion_id, d.asignatura_id)));
  const actualesSet = new Set(actuales.map(a => clave(a.seccion_id, a.asignatura_id)));

  for (const a of actuales) {
    if (!deseadasSet.has(clave(a.seccion_id, a.asignatura_id))) {
      // NUEVO: no se puede quitar una materia que ya tiene actividades o notas
      if (await asignacionTieneNotas(c, a.id)) {
        throw new ErrorHttp(409, 'No se puede quitar una materia que ya tiene actividades o notas registradas. ' +
          'Si es otro docente quien la dará, cámbialo desde la pestaña Secciones.');
      }
      await c.query('DELETE FROM asignaciones WHERE id = $1', [a.id]);
    }
  }
  for (const d of deseadas) {
    if (actualesSet.has(clave(d.seccion_id, d.asignatura_id))) continue;
    const r = await c.query(
      `INSERT INTO asignaciones (docente_id, seccion_id, asignatura_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (seccion_id, asignatura_id) DO NOTHING
       RETURNING id`,
      [docenteId, d.seccion_id, d.asignatura_id]
    );
    if (r.rowCount === 0) {
      throw new ErrorHttp(409, 'Una de esas materias ya tiene otro docente en esa sección. Cámbialo desde la pestaña Secciones.');
    }
  }
}

// Deja las materias de una sección exactamente como se pidieron
async function sincronizarMateriasSeccion(c, seccionId, materias) {
  const actuales = (await c.query(
    'SELECT id, asignatura_id, docente_id FROM asignaciones WHERE seccion_id = $1', [seccionId]
  )).rows;

  const deseadas = new Map(materias.map(m => [m.asignatura_id, m.docente_id]));
  const porMateria = new Map(actuales.map(a => [a.asignatura_id, a]));

  for (const a of actuales) {
    if (!deseadas.has(a.asignatura_id)) {
      // NUEVO: no se puede quitar una materia que ya tiene actividades o notas
      if (await asignacionTieneNotas(c, a.id)) {
        throw new ErrorHttp(409, 'No se puede quitar una materia que ya tiene actividades o notas registradas. ' +
          'Puedes cambiar el docente, pero no quitar la materia.');
      }
      await c.query('DELETE FROM asignaciones WHERE id = $1', [a.id]);
    }
  }
  for (const [asignaturaId, docenteId] of deseadas) {
    const existente = porMateria.get(asignaturaId);
    if (!existente) {
      await c.query(
        'INSERT INTO asignaciones (docente_id, seccion_id, asignatura_id) VALUES ($1, $2, $3)',
        [docenteId, seccionId, asignaturaId]
      );
    } else if (existente.docente_id !== docenteId) {
      await c.query('UPDATE asignaciones SET docente_id = $1 WHERE id = $2', [docenteId, existente.id]);
    }
  }
}

// ----- NUEVO: actividades y notas -----

// Nombre y porcentaje de una actividad
function leerActividad(body) {
  const nombre = texto(body.nombre);
  const porcentaje = Number(body.porcentaje);

  if (!nombre) throw new ErrorHttp(400, 'El nombre de la actividad es obligatorio');
  if (nombre.length > 100) throw new ErrorHttp(400, 'El nombre de la actividad es demasiado largo');
  if (!Number.isFinite(porcentaje) || porcentaje <= 0 || porcentaje > 100) {
    throw new ErrorHttp(400, 'El porcentaje debe ser mayor que 0 y no pasar de 100');
  }
  return { nombre, porcentaje: Math.round(porcentaje * 100) / 100 };
}

function leerPeriodo(valor) {
  const periodo = Number(valor);
  if (![1, 2, 3].includes(periodo)) throw new ErrorHttp(400, 'El trimestre debe ser 1, 2 o 3');
  return periodo;
}

// Los porcentajes de un trimestre no pueden sumar más de 100.
// "excluirId" sirve al editar una actividad (para no contarla dos veces).
async function validarPorcentaje(c, asignacionId, periodo, porcentaje, excluirId) {
  const r = await c.query(
    `SELECT COALESCE(SUM(porcentaje), 0)::float AS total
       FROM actividades
      WHERE asignacion_id = $1 AND periodo = $2 AND id <> $3`,
    [asignacionId, periodo, excluirId]
  );
  const total = Math.round(r.rows[0].total * 100) / 100;
  if (total + porcentaje > 100.001) {
    const restante = Math.round((100 - total) * 100) / 100;
    throw new ErrorHttp(
      409,
      `Con ese porcentaje el trimestre pasaría de 100%. Solo quedan ${restante}% disponibles.`
    );
  }
}

// Lista de { actividadId, alumnoId, nota } (nota = null significa "quitar la nota")
function leerNotas(lista) {
  if (!Array.isArray(lista) || lista.length === 0) throw new ErrorHttp(400, 'No hay notas para guardar');
  if (lista.length > 5000) throw new ErrorHttp(400, 'Son demasiadas notas a la vez');

  return lista.map(n => {
    const actividadId = entero(n.actividad_id);
    const alumnoId = entero(n.alumno_id);
    if (!actividadId || !alumnoId) throw new ErrorHttp(400, 'Hay una nota con datos inválidos');

    if (n.nota === null || n.nota === undefined || texto(n.nota) === '') {
      return { actividadId, alumnoId, nota: null };
    }
    const nota = Number(n.nota);
    if (!Number.isFinite(nota) || nota < 0 || nota > 10) {
      throw new ErrorHttp(400, 'Las notas deben estar entre 0 y 10');
    }
    return { actividadId, alumnoId, nota: Math.round(nota * 100) / 100 };
  });
}

// Actividades, estudiantes y notas de una materia (lo usan el docente y el director)
async function cargarNotas(asignacionId) {
  const a = await pool.query('SELECT seccion_id FROM asignaciones WHERE id = $1', [asignacionId]);
  const seccionId = a.rows[0].seccion_id;

  const actividades = await pool.query(
    `SELECT id, periodo, nombre, porcentaje::float AS porcentaje
       FROM actividades
      WHERE asignacion_id = $1
      ORDER BY periodo, id`,
    [asignacionId]
  );
  const estudiantes = await pool.query(
    `SELECT id, nombres || ' ' || apellidos AS nombre, codigo
       FROM alumnos
      WHERE seccion_id = $1 AND activo = TRUE
      ORDER BY apellidos, nombres`,
    [seccionId]
  );
  const notas = await pool.query(
    `SELECT n.actividad_id, n.alumno_id, n.nota::float AS nota
       FROM notas_actividad n
       JOIN actividades ac ON ac.id = n.actividad_id
      WHERE ac.asignacion_id = $1`,
    [asignacionId]
  );

  return { actividades: actividades.rows, estudiantes: estudiantes.rows, notas: notas.rows };
}

// ----- Filtros de los reportes del director -----
function agregarFiltro(cond, params, sql, valor) {
  params.push(valor);
  cond.push(sql.replace('?', '$' + params.length));
}

function filtrosAsistencia(q) {
  const cond = [];
  const params = [];
  if (fechaValida(q.desde))        agregarFiltro(cond, params, 'a.fecha >= ?', q.desde);
  if (fechaValida(q.hasta))        agregarFiltro(cond, params, 'a.fecha <= ?', q.hasta);
  if (entero(q.seccion_id))        agregarFiltro(cond, params, 'al.seccion_id = ?', entero(q.seccion_id));
  if (entero(q.alumno_id))         agregarFiltro(cond, params, 'a.alumno_id = ?', entero(q.alumno_id));
  if (ESTADOS.includes(q.estado))  agregarFiltro(cond, params, 'a.estado = ?', q.estado);
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params };
}

function filtrosMeritos(q) {
  const cond = [];
  const params = [];
  if (fechaValida(q.desde))        agregarFiltro(cond, params, 'm.fecha >= ?', q.desde);
  if (fechaValida(q.hasta))        agregarFiltro(cond, params, 'm.fecha <= ?', q.hasta);
  if (entero(q.seccion_id))        agregarFiltro(cond, params, 'al.seccion_id = ?', entero(q.seccion_id));
  if (entero(q.alumno_id))         agregarFiltro(cond, params, 'm.alumno_id = ?', entero(q.alumno_id));
  if (['merito', 'demerito'].includes(q.tipo)) agregarFiltro(cond, params, 'm.tipo = ?', q.tipo);
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params };
}

// ----- CSV para el documento de cada jornada -----
function celdaCsv(valor) {
  let t = String(valor ?? '');
  if (/^[=+\-@]/.test(t)) t = "'" + t;                 // evita fórmulas en Excel
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

const ETIQUETA_ESTADO = {
  presente: 'Presente', ausente: 'Ausente', tarde: 'Tarde', justificado: 'Justificada'
};

// ===== 4. PREPARAR LA BASE DE DATOS =====
// Agrega lo que las pantallas necesitan y no estaba en la base.
// Es seguro correrlo muchas veces: solo crea lo que falta.
async function prepararBaseDeDatos() {
  const sentencias = [
    // Usuarios: inicio de sesión por correo (ya vienen en tu base-de-datos.sql)
    'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS correo VARCHAR(100)',
    'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS debe_cambiar BOOLEAN NOT NULL DEFAULT FALSE',
    'ALTER TABLE usuarios ALTER COLUMN usuario DROP NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS usuarios_correo_unico ON usuarios (LOWER(correo))',
    // Código del estudiante (lo piden las pantallas)
    'ALTER TABLE alumnos ADD COLUMN IF NOT EXISTS codigo VARCHAR(30)',
    'CREATE UNIQUE INDEX IF NOT EXISTS alumnos_codigo_unico ON alumnos (codigo) WHERE codigo IS NOT NULL',
    // Seguimiento de méritos y deméritos
    'ALTER TABLE meritos_demeritos ADD COLUMN IF NOT EXISTS detalle TEXT',
    `ALTER TABLE meritos_demeritos
       ADD COLUMN IF NOT EXISTS mejoria VARCHAR(20) NOT NULL DEFAULT 'en_seguimiento'
       CHECK (mejoria IN ('en_seguimiento', 'mejoro'))`,
    // Tabla de sesiones (la misma que ya trae tu base-de-datos.sql)
    `CREATE TABLE IF NOT EXISTS sesiones (
       sid    VARCHAR(128) PRIMARY KEY,
       sess   JSONB        NOT NULL,
       expire TIMESTAMP    NOT NULL
     )`,
    'CREATE INDEX IF NOT EXISTS sesiones_expire_idx ON sesiones (expire)',
    // Estas dos tablas ya vienen en tu base-de-datos.sql. Se aseguran aquí
    // porque la revisión previa a eliminar o quitar materias las consulta.
    `CREATE TABLE IF NOT EXISTS evaluaciones (
       asignacion_id INTEGER  NOT NULL REFERENCES asignaciones(id) ON DELETE CASCADE,
       alumno_id     INTEGER  NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
       periodo       SMALLINT NOT NULL CHECK (periodo BETWEEN 1 AND 3),
       cot1          NUMERIC(4,2) CHECK (cot1 BETWEEN 0 AND 10),
       cot2          NUMERIC(4,2) CHECK (cot2 BETWEEN 0 AND 10),
       cot3          NUMERIC(4,2) CHECK (cot3 BETWEEN 0 AND 10),
       integradora   NUMERIC(4,2) CHECK (integradora BETWEEN 0 AND 10),
       objetiva      NUMERIC(4,2) CHECK (objetiva BETWEEN 0 AND 10),
       recuperacion  NUMERIC(4,2) CHECK (recuperacion BETWEEN 0 AND 10),
       PRIMARY KEY (asignacion_id, alumno_id, periodo)
     )`,
    `CREATE TABLE IF NOT EXISTS documentos_enviados (
       id             SERIAL PRIMARY KEY,
       tipo           VARCHAR(10)  NOT NULL CHECK (tipo IN ('notas', 'ficha')),
       titulo         VARCHAR(200) NOT NULL,
       asignacion_id  INTEGER REFERENCES asignaciones(id) ON DELETE SET NULL,
       alumno_id      INTEGER REFERENCES alumnos(id)      ON DELETE SET NULL,
       periodo        SMALLINT,
       docente_id     INTEGER NOT NULL REFERENCES docentes(id),
       seccion_id     INTEGER REFERENCES secciones(id)    ON DELETE SET NULL,
       nombre_archivo VARCHAR(200) NOT NULL,
       archivo        BYTEA        NOT NULL,
       enviado_en     TIMESTAMP    NOT NULL DEFAULT NOW(),
       leido_en       TIMESTAMP,
       leido_por      INTEGER REFERENCES usuarios(id)
     )`,
    // NUEVO: actividades que crea cada docente (por materia, sección y trimestre)
    `CREATE TABLE IF NOT EXISTS actividades (
       id            SERIAL PRIMARY KEY,
       asignacion_id INTEGER      NOT NULL REFERENCES asignaciones(id) ON DELETE CASCADE,
       periodo       SMALLINT     NOT NULL CHECK (periodo BETWEEN 1 AND 3),
       nombre        VARCHAR(100) NOT NULL,
       porcentaje    NUMERIC(5,2) NOT NULL CHECK (porcentaje > 0 AND porcentaje <= 100),
       creado_en     TIMESTAMP    NOT NULL DEFAULT NOW()
     )`,
    'CREATE INDEX IF NOT EXISTS actividades_asignacion_idx ON actividades (asignacion_id, periodo)',
    // NUEVO: la nota de cada estudiante en cada actividad (de 0 a 10)
    `CREATE TABLE IF NOT EXISTS notas_actividad (
       actividad_id   INTEGER      NOT NULL REFERENCES actividades(id) ON DELETE CASCADE,
       alumno_id      INTEGER      NOT NULL REFERENCES alumnos(id)     ON DELETE CASCADE,
       nota           NUMERIC(4,2) NOT NULL CHECK (nota BETWEEN 0 AND 10),
       registrado_por INTEGER REFERENCES usuarios(id),
       actualizado_en TIMESTAMP    NOT NULL DEFAULT NOW(),
       PRIMARY KEY (actividad_id, alumno_id)
     )`,
    'CREATE INDEX IF NOT EXISTS notas_actividad_alumno_idx ON notas_actividad (alumno_id)'
  ];
  for (const sentencia of sentencias) await pool.query(sentencia);
}

// ===== 5. RUTAS: SESIÓN =====

// Se puede entrar con el correo o con el usuario
app.post('/api/login', ruta(async (req, res) => {
  const identificador = texto(req.body.usuario);
  const contrasena = String(req.body.contrasena ?? '');

  if (!identificador || !contrasena) throw new ErrorHttp(400, 'Faltan datos');

  const r = await pool.query(
    `SELECT id, nombre, contrasena_hash, rol, debe_cambiar
       FROM usuarios
      WHERE (LOWER(correo) = LOWER($1) OR LOWER(usuario) = LOWER($1)) AND activo = TRUE
      LIMIT 1`,
    [identificador]
  );

  const user = r.rows[0];
  const valida = user && await bcrypt.compare(contrasena, user.contrasena_hash);
  if (!valida) throw new ErrorHttp(401, 'Usuario o contraseña incorrectos');

  // Todo docente debe tener su fila en la tabla docentes (para que el director lo vea)
  if (user.rol === 'docente') {
    await pool.query(
      'INSERT INTO docentes (usuario_id) VALUES ($1) ON CONFLICT (usuario_id) DO NOTHING',
      [user.id]
    );
  }

  // La sesión recuerda si la cuenta todavía tiene contraseña temporal
  req.session.usuario = {
    id: user.id,
    nombre: user.nombre,
    rol: user.rol,
    debe_cambiar: user.debe_cambiar
  };
  res.json({ rol: user.rol, debe_cambiar: user.debe_cambiar });
}));

app.get('/api/sesion', requerirLogin, (req, res) => {
  res.json(req.session.usuario);
});

// Elegir una contraseña nueva (obligatorio con contraseña temporal)
app.post('/api/cambiar-contrasena', requerirLogin, ruta(async (req, res) => {
  const actual = String(req.body.actual ?? '');
  const nueva = String(req.body.nueva ?? '');

  if (!actual || !nueva) throw new ErrorHttp(400, 'Faltan datos');
  if (nueva.length < 8) throw new ErrorHttp(400, 'La contraseña nueva debe tener al menos 8 caracteres');
  if (Buffer.byteLength(nueva) > 72) throw new ErrorHttp(400, 'La contraseña nueva es demasiado larga');
  if (nueva === actual) throw new ErrorHttp(400, 'La contraseña nueva debe ser distinta a la actual');

  const usuarioId = req.session.usuario.id;
  const r = await pool.query(
    'SELECT contrasena_hash FROM usuarios WHERE id = $1 AND activo = TRUE',
    [usuarioId]
  );
  const correcta = r.rowCount > 0 && await bcrypt.compare(actual, r.rows[0].contrasena_hash);
  if (!correcta) throw new ErrorHttp(400, 'La contraseña actual no es correcta');

  const hash = await bcrypt.hash(nueva, 10);
  await pool.query(
    'UPDATE usuarios SET contrasena_hash = $1, debe_cambiar = FALSE WHERE id = $2',
    [hash, usuarioId]
  );

  req.session.usuario.debe_cambiar = false;
  res.json({ ok: true, rol: req.session.usuario.rol });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// ===== 6. RUTAS: DIRECTOR - ASISTENCIA SEMANAL =====

// Jornadas de los últimos 7 días (una fila por fecha y sección)
app.get('/api/director/asistencias', requerirRol('director'), ruta(async (req, res) => {
  const r = await pool.query(
    `SELECT to_char(a.fecha, 'YYYY-MM-DD') AS fecha,
            s.id AS seccion_id,
            s.nombre AS seccion,
            string_agg(DISTINCT u.nombre, ', ') AS docente,
            COUNT(*) FILTER (WHERE a.estado = 'presente')::int    AS presentes,
            COUNT(*) FILTER (WHERE a.estado = 'ausente')::int     AS ausencias,
            COUNT(*) FILTER (WHERE a.estado = 'tarde')::int       AS tardes,
            COUNT(*) FILTER (WHERE a.estado = 'justificado')::int AS justificadas
       FROM asistencias a
       JOIN alumnos al ON al.id = a.alumno_id
       JOIN secciones s ON s.id = al.seccion_id
       JOIN usuarios u ON u.id = a.registrado_por
      WHERE a.fecha >= ${HOY} - 6
      GROUP BY a.fecha, s.id, s.nombre
      ORDER BY a.fecha DESC, s.nombre`
  );
  res.json(r.rows);
}));

// Documento de una jornada (se descarga como archivo CSV, abre en Excel)
app.get('/api/director/asistencias/:fecha/:seccionId/documento', requerirRol('director'), ruta(async (req, res) => {
  const fecha = req.params.fecha;
  const seccionId = entero(req.params.seccionId);
  if (!fechaValida(fecha) || !seccionId) throw new ErrorHttp(400, 'Fecha o sección inválida');

  const sec = await pool.query('SELECT nombre, grado, anio FROM secciones WHERE id = $1', [seccionId]);
  if (sec.rowCount === 0) throw new ErrorHttp(404, 'Sección no encontrada');

  const alumnos = await pool.query(
    `SELECT al.nombres, al.apellidos, al.codigo, a.estado, a.observacion
       FROM alumnos al
       LEFT JOIN asistencias a ON a.alumno_id = al.id AND a.fecha = $2
      WHERE al.seccion_id = $1 AND al.activo = TRUE
      ORDER BY al.apellidos, al.nombres`,
    [seccionId, fecha]
  );

  const doc = await pool.query(
    `SELECT string_agg(DISTINCT u.nombre, ', ') AS docente
       FROM asistencias a
       JOIN alumnos al ON al.id = a.alumno_id
       JOIN usuarios u ON u.id = a.registrado_por
      WHERE al.seccion_id = $1 AND a.fecha = $2`,
    [seccionId, fecha]
  );

  const s = sec.rows[0];
  const lineas = [
    ['Centro Escolar Marcelina Viuda de Granillo'],
    ['Asistencia del día', fecha],
    ['Sección', `${s.grado} ${s.nombre} (${s.anio})`],
    ['Registrada por', doc.rows[0].docente || ''],
    [],
    ['Estudiante', 'Código', 'Estado', 'Observación'],
    ...alumnos.rows.map(a => [
      `${a.apellidos}, ${a.nombres}`,
      a.codigo || '',
      a.estado ? ETIQUETA_ESTADO[a.estado] : 'Sin registrar',
      a.observacion || ''
    ])
  ].map(fila => fila.map(celdaCsv).join(','));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="asistencia-${fecha}-seccion-${seccionId}.csv"`);
  res.send('\uFEFF' + lineas.join('\r\n'));   // \uFEFF para que Excel respete las tildes
}));

// ===== 7. RUTAS: DIRECTOR - DOCENTES, SECCIONES Y MATERIAS =====

app.get('/api/director/asignaturas', requerirRol('director'), ruta(async (req, res) => {
  const r = await pool.query('SELECT id, nombre FROM asignaturas ORDER BY nombre');
  res.json(r.rows);
}));

// Lista de docentes con sus asignaciones
app.get('/api/docentes', requerirRol('director'), ruta(async (req, res) => {
  const r = await pool.query(
    `SELECT d.id, u.nombre, u.correo, u.activo, d.especialidad, d.telefono,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'seccion_id', a.seccion_id,
                       'asignatura_id', a.asignatura_id,
                       'seccion', s.nombre,
                       'asignatura', asg.nombre
                     ) ORDER BY asg.nombre, s.nombre)
                FROM asignaciones a
                JOIN secciones s ON s.id = a.seccion_id
                JOIN asignaturas asg ON asg.id = a.asignatura_id
               WHERE a.docente_id = d.id
            ), '[]'::json) AS asignaciones
       FROM docentes d
       JOIN usuarios u ON u.id = d.usuario_id
      ORDER BY u.nombre`
  );
  res.json(r.rows);
}));

// Crear docente (devuelve una contraseña temporal que se muestra una sola vez)
app.post('/api/docentes', requerirRol('director'), ruta(async (req, res) => {
  const datos = leerDatosDocente(req.body);
  const asignaciones = leerAsignaciones(req.body.asignaciones) || [];
  const clave = claveTemporal();
  const hash = await bcrypt.hash(clave, 10);

  const id = await enTransaccion(async (c) => {
    const u = await c.query(
      `INSERT INTO usuarios (nombre, correo, contrasena_hash, rol, debe_cambiar)
       VALUES ($1, $2, $3, 'docente', TRUE)
       RETURNING id`,
      [datos.nombre, datos.correo, hash]
    );
    const d = await c.query(
      `INSERT INTO docentes (usuario_id, especialidad, telefono)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [u.rows[0].id, datos.especialidad, datos.telefono]
    );
    await sincronizarAsignacionesDocente(c, d.rows[0].id, asignaciones);
    return d.rows[0].id;
  });

  res.status(201).json({ id, clave_temporal: clave });
}));

// Editar docente
app.put('/api/docentes/:id', requerirRol('director'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  if (!id) throw new ErrorHttp(400, 'Docente inválido');

  const datos = leerDatosDocente(req.body);
  const asignaciones = leerAsignaciones(req.body.asignaciones);

  await enTransaccion(async (c) => {
    const d = await c.query('SELECT usuario_id FROM docentes WHERE id = $1', [id]);
    if (d.rowCount === 0) throw new ErrorHttp(404, 'Docente no encontrado');

    await c.query('UPDATE usuarios SET nombre = $1, correo = $2 WHERE id = $3',
      [datos.nombre, datos.correo, d.rows[0].usuario_id]);
    await c.query('UPDATE docentes SET especialidad = $1, telefono = $2 WHERE id = $3',
      [datos.especialidad, datos.telefono, id]);
    if (asignaciones) await sincronizarAsignacionesDocente(c, id, asignaciones);
  });

  res.json({ ok: true });
}));

// Activar / desactivar docente (su historial se conserva)
app.patch('/api/docentes/:id/estado', requerirRol('director'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  if (!id || typeof req.body.activo !== 'boolean') throw new ErrorHttp(400, 'Datos inválidos');

  const r = await pool.query(
    'UPDATE usuarios SET activo = $1 WHERE id = (SELECT usuario_id FROM docentes WHERE id = $2) RETURNING id',
    [req.body.activo, id]
  );
  if (r.rowCount === 0) throw new ErrorHttp(404, 'Docente no encontrado');

  // Si se desactiva, se le cierra la sesión de inmediato
  if (!req.body.activo) await cerrarSesionesDeUsuario(r.rows[0].id);

  res.json({ ok: true });
}));

// Restablecer la contraseña de un docente (olvidó la suya)
// Genera otra contraseña temporal, cierra sus sesiones y le exige elegir una nueva al entrar
app.post('/api/docentes/:id/restablecer-contrasena', requerirRol('director'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  if (!id) throw new ErrorHttp(400, 'Docente inválido');

  const clave = claveTemporal();
  const hash = await bcrypt.hash(clave, 10);

  const r = await pool.query(
    `UPDATE usuarios
        SET contrasena_hash = $1, debe_cambiar = TRUE
      WHERE id = (SELECT usuario_id FROM docentes WHERE id = $2) AND rol = 'docente'
      RETURNING id`,
    [hash, id]
  );
  if (r.rowCount === 0) throw new ErrorHttp(404, 'Docente no encontrado');

  await cerrarSesionesDeUsuario(r.rows[0].id);
  res.json({ clave_temporal: clave });
}));

// Eliminar un docente.
// Solo se permite si no tiene historial (asistencia, méritos, documentos, actividades o notas).
// Si lo tiene, se rechaza y se pide desactivarlo, para no dejar registros sin autor.
app.delete('/api/docentes/:id', requerirRol('director'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  if (!id) throw new ErrorHttp(400, 'Docente inválido');

  const usuarioId = await enTransaccion(async (c) => {
    const d = await c.query(
      `SELECT d.usuario_id, u.nombre
         FROM docentes d
         JOIN usuarios u ON u.id = d.usuario_id
        WHERE d.id = $1 AND u.rol = 'docente'`,
      [id]
    );
    if (d.rowCount === 0) throw new ErrorHttp(404, 'Docente no encontrado');
    const { usuario_id, nombre } = d.rows[0];

    // ¿Tiene algo guardado a su nombre?
    const h = (await c.query(
      `SELECT
         (SELECT COUNT(*) FROM asistencias         WHERE registrado_por = $1)::int AS asistencias,
         (SELECT COUNT(*) FROM meritos_demeritos   WHERE registrado_por = $1)::int AS meritos,
         (SELECT COUNT(*) FROM documentos_enviados WHERE docente_id = $2)::int     AS documentos,
         (SELECT COUNT(*)
            FROM evaluaciones ev
            JOIN asignaciones a ON a.id = ev.asignacion_id
           WHERE a.docente_id = $2)::int                                          AS evaluaciones,
         (SELECT COUNT(*)
            FROM actividades ac
            JOIN asignaciones a ON a.id = ac.asignacion_id
           WHERE a.docente_id = $2)::int                                          AS actividades,
         (SELECT COUNT(*) FROM notas_actividad     WHERE registrado_por = $1)::int AS notas`,
      [usuario_id, id]
    )).rows[0];

    const partes = [];
    if (h.asistencias) partes.push('asistencia');
    if (h.meritos)     partes.push('méritos y deméritos');
    if (h.documentos)  partes.push('documentos enviados');
    if (h.evaluaciones || h.notas) partes.push('notas');
    if (h.actividades) partes.push('actividades');

    if (partes.length > 0) {
      throw new ErrorHttp(
        409,
        `No se puede eliminar a ${nombre} porque tiene registros de ${partes.join(', ')}. ` +
        'Para conservar el historial, desactívalo en lugar de eliminarlo.'
      );
    }

    // Sin historial: se borran sus asignaciones, su ficha de docente y su cuenta
    await c.query('DELETE FROM asignaciones WHERE docente_id = $1', [id]);
    await c.query('DELETE FROM docentes WHERE id = $1', [id]);
    await c.query('DELETE FROM usuarios WHERE id = $1', [usuario_id]);
    return usuario_id;
  }).catch((err) => {
    // Si justo apareció un registro mientras se eliminaba, la base lo impide
    if (err.code === '23503') {
      throw new ErrorHttp(409, 'No se puede eliminar porque tiene registros asociados. Desactívalo en su lugar.');
    }
    throw err;
  });

  await cerrarSesionesDeUsuario(usuarioId);
  res.json({ ok: true });
}));

// Lista de secciones con sus materias y cantidad de estudiantes
app.get('/api/secciones', requerirRol('director'), ruta(async (req, res) => {
  const r = await pool.query(
    `SELECT s.id, s.nombre, s.grado, s.anio,
            (SELECT COUNT(*) FROM alumnos al WHERE al.seccion_id = s.id AND al.activo)::int AS estudiantes,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'asignatura_id', a.asignatura_id,
                       'asignatura', asg.nombre,
                       'docente_id', d.id,
                       'docente', u.nombre
                     ) ORDER BY asg.nombre)
                FROM asignaciones a
                JOIN asignaturas asg ON asg.id = a.asignatura_id
                JOIN docentes d ON d.id = a.docente_id
                JOIN usuarios u ON u.id = d.usuario_id
               WHERE a.seccion_id = s.id
            ), '[]'::json) AS materias
       FROM secciones s
      ORDER BY s.anio DESC, s.grado, s.nombre`
  );
  res.json(r.rows);
}));

app.post('/api/secciones', requerirRol('director'), ruta(async (req, res) => {
  const datos = leerDatosSeccion(req.body);
  const materias = leerMaterias(req.body.materias) || [];

  const id = await enTransaccion(async (c) => {
    const s = await c.query(
      'INSERT INTO secciones (nombre, grado, anio) VALUES ($1, $2, $3) RETURNING id',
      [datos.nombre, datos.grado, datos.anio]
    );
    await sincronizarMateriasSeccion(c, s.rows[0].id, materias);
    return s.rows[0].id;
  });

  res.status(201).json({ id });
}));

app.put('/api/secciones/:id', requerirRol('director'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  if (!id) throw new ErrorHttp(400, 'Sección inválida');

  const datos = leerDatosSeccion(req.body);
  const materias = leerMaterias(req.body.materias);

  await enTransaccion(async (c) => {
    const r = await c.query(
      'UPDATE secciones SET nombre = $1, grado = $2, anio = $3 WHERE id = $4',
      [datos.nombre, datos.grado, datos.anio, id]
    );
    if (r.rowCount === 0) throw new ErrorHttp(404, 'Sección no encontrada');
    if (materias) await sincronizarMateriasSeccion(c, id, materias);
  });

  res.json({ ok: true });
}));

// Eliminar una sección.
// Solo se permite si no tiene estudiantes, notas ni actividades. Sus materias asignadas se quitan con ella.
app.delete('/api/secciones/:id', requerirRol('director'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  if (!id) throw new ErrorHttp(400, 'Sección inválida');

  await enTransaccion(async (c) => {
    const s = await c.query('SELECT nombre, anio FROM secciones WHERE id = $1', [id]);
    if (s.rowCount === 0) throw new ErrorHttp(404, 'Sección no encontrada');
    const { nombre, anio } = s.rows[0];

    const h = (await c.query(
      `SELECT
         (SELECT COUNT(*) FROM alumnos WHERE seccion_id = $1)::int AS estudiantes,
         (SELECT COUNT(*)
            FROM evaluaciones ev
            JOIN asignaciones a ON a.id = ev.asignacion_id
           WHERE a.seccion_id = $1)::int                           AS notas,
         (SELECT COUNT(*)
            FROM actividades ac
            JOIN asignaciones a ON a.id = ac.asignacion_id
           WHERE a.seccion_id = $1)::int                           AS actividades`,
      [id]
    )).rows[0];

    if (h.estudiantes > 0) {
      throw new ErrorHttp(
        409,
        `No se puede eliminar la sección ${nombre} (${anio}) porque tiene ${h.estudiantes} ` +
        `estudiante${h.estudiantes === 1 ? '' : 's'} registrado${h.estudiantes === 1 ? '' : 's'}. ` +
        'Solo se pueden eliminar secciones sin estudiantes.'
      );
    }
    if (h.notas > 0) {
      throw new ErrorHttp(409, `No se puede eliminar la sección ${nombre} (${anio}) porque tiene notas guardadas.`);
    }
    // NUEVO: tampoco si los docentes ya crearon actividades en ella
    if (h.actividades > 0) {
      throw new ErrorHttp(
        409,
        `No se puede eliminar la sección ${nombre} (${anio}) porque tiene actividades de notas creadas. ` +
        'Pide al docente que las elimine primero.'
      );
    }

    await c.query('DELETE FROM asignaciones WHERE seccion_id = $1', [id]);
    await c.query('DELETE FROM secciones WHERE id = $1', [id]);
  }).catch((err) => {
    if (err.code === '23503') {
      throw new ErrorHttp(409, 'No se puede eliminar porque la sección tiene registros asociados.');
    }
    throw err;
  });

  res.json({ ok: true });
}));

// ===== 8. RUTAS: DIRECTOR - REPORTES DE ASISTENCIA, MÉRITOS Y NOTAS =====

app.get('/api/director/reportes/asistencia', requerirRol('director'), ruta(async (req, res) => {
  const { where, params } = filtrosAsistencia(req.query);
  const r = await pool.query(
    `SELECT a.id, to_char(a.fecha, 'YYYY-MM-DD') AS fecha, a.estado, a.observacion,
            al.id AS alumno_id, al.nombres, al.apellidos,
            s.nombre AS seccion, s.grado,
            u.nombre AS registrado_por
       FROM asistencias a
       JOIN alumnos al ON al.id = a.alumno_id
       LEFT JOIN secciones s ON s.id = al.seccion_id
       JOIN usuarios u ON u.id = a.registrado_por
       ${where}
      ORDER BY a.fecha DESC, al.apellidos, al.nombres
      LIMIT 1000`,
    params
  );
  res.json(r.rows);
}));

app.get('/api/director/reportes/asistencia/resumen', requerirRol('director'), ruta(async (req, res) => {
  const { where, params } = filtrosAsistencia(req.query);
  const r = await pool.query(
    `SELECT al.id AS alumno_id, al.nombres, al.apellidos, s.nombre AS seccion, s.grado,
            COUNT(*) FILTER (WHERE a.estado = 'presente')::int    AS presentes,
            COUNT(*) FILTER (WHERE a.estado = 'ausente')::int     AS ausentes,
            COUNT(*) FILTER (WHERE a.estado = 'tarde')::int       AS tardes,
            COUNT(*) FILTER (WHERE a.estado = 'justificado')::int AS justificados
       FROM asistencias a
       JOIN alumnos al ON al.id = a.alumno_id
       LEFT JOIN secciones s ON s.id = al.seccion_id
       ${where}
      GROUP BY al.id, s.nombre, s.grado
      ORDER BY s.grado, s.nombre, al.apellidos, al.nombres`,
    params
  );
  res.json(r.rows);
}));

app.get('/api/director/reportes/meritos', requerirRol('director'), ruta(async (req, res) => {
  const { where, params } = filtrosMeritos(req.query);
  const r = await pool.query(
    `SELECT m.id, m.tipo, m.motivo, m.detalle, m.puntos, m.mejoria,
            to_char(m.fecha, 'YYYY-MM-DD') AS fecha,
            al.id AS alumno_id, al.nombres, al.apellidos,
            s.nombre AS seccion, s.grado,
            u.nombre AS registrado_por
       FROM meritos_demeritos m
       JOIN alumnos al ON al.id = m.alumno_id
       LEFT JOIN secciones s ON s.id = al.seccion_id
       JOIN usuarios u ON u.id = m.registrado_por
       ${where}
      ORDER BY m.fecha DESC, m.id DESC
      LIMIT 1000`,
    params
  );
  res.json(r.rows);
}));

app.get('/api/director/reportes/meritos/resumen', requerirRol('director'), ruta(async (req, res) => {
  const { where, params } = filtrosMeritos(req.query);
  const r = await pool.query(
    `SELECT al.id AS alumno_id, al.nombres, al.apellidos, s.nombre AS seccion, s.grado,
            COALESCE(SUM(m.puntos) FILTER (WHERE m.tipo = 'merito'), 0)::int   AS puntos_meritos,
            COALESCE(SUM(m.puntos) FILTER (WHERE m.tipo = 'demerito'), 0)::int AS puntos_demeritos,
            (COALESCE(SUM(m.puntos) FILTER (WHERE m.tipo = 'merito'), 0)
           - COALESCE(SUM(m.puntos) FILTER (WHERE m.tipo = 'demerito'), 0))::int AS balance
       FROM meritos_demeritos m
       JOIN alumnos al ON al.id = m.alumno_id
       LEFT JOIN secciones s ON s.id = al.seccion_id
       ${where}
      GROUP BY al.id, s.nombre, s.grado
      ORDER BY s.grado, s.nombre, al.apellidos, al.nombres`,
    params
  );
  res.json(r.rows);
}));

// NUEVO: todas las materias de todas las secciones (para los filtros del director)
app.get('/api/director/notas/asignaciones', requerirRol('director'), ruta(async (req, res) => {
  const r = await pool.query(
    `SELECT a.id,
            s.id AS seccion_id, s.nombre AS seccion, s.grado, s.anio,
            asg.nombre AS asignatura,
            u.nombre AS docente,
            (SELECT COUNT(*) FROM actividades ac WHERE ac.asignacion_id = a.id)::int AS actividades
       FROM asignaciones a
       JOIN secciones s ON s.id = a.seccion_id
       JOIN asignaturas asg ON asg.id = a.asignatura_id
       JOIN docentes d ON d.id = a.docente_id
       JOIN usuarios u ON u.id = d.usuario_id
      ORDER BY s.anio DESC, s.grado, s.nombre, asg.nombre`
  );
  res.json(r.rows);
}));

// NUEVO: actividades, estudiantes y notas de una materia (solo consulta)
app.get('/api/director/notas', requerirRol('director'), ruta(async (req, res) => {
  const asignacionId = entero(req.query.asignacion_id);
  if (!asignacionId) throw new ErrorHttp(400, 'Falta asignacion_id');

  const info = await pool.query(
    `SELECT a.id, s.nombre AS seccion, s.grado, s.anio,
            asg.nombre AS asignatura, u.nombre AS docente
       FROM asignaciones a
       JOIN secciones s ON s.id = a.seccion_id
       JOIN asignaturas asg ON asg.id = a.asignatura_id
       JOIN docentes d ON d.id = a.docente_id
       JOIN usuarios u ON u.id = d.usuario_id
      WHERE a.id = $1`,
    [asignacionId]
  );
  if (info.rowCount === 0) throw new ErrorHttp(404, 'Materia no encontrada');

  res.json({ asignacion: info.rows[0], ...(await cargarNotas(asignacionId)) });
}));

// ===== 9. RUTAS: DOCENTE =====

// Secciones asignadas al docente
app.get('/api/docente/secciones', requerirRol('docente'), ruta(async (req, res) => {
  const r = await pool.query(
    `SELECT DISTINCT s.id, s.nombre, s.grado, s.anio
       FROM asignaciones a
       JOIN docentes d ON d.id = a.docente_id
       JOIN secciones s ON s.id = a.seccion_id
      WHERE d.usuario_id = $1
      ORDER BY s.anio DESC, s.grado, s.nombre`,
    [req.session.usuario.id]
  );
  res.json(r.rows);
}));

// Asistencia de una sección en una fecha + resumen de la semana (lunes a viernes)
app.get('/api/docente/asistencia', requerirRol('docente'), ruta(async (req, res) => {
  const seccionId = entero(req.query.seccion_id);
  const fecha = req.query.fecha;
  if (!seccionId || !fechaValida(fecha)) throw new ErrorHttp(400, 'Faltan seccion_id o fecha (AAAA-MM-DD)');
  await exigirSeccionDelDocente(req.session.usuario.id, seccionId);

  const est = await pool.query(
    `SELECT al.id AS alumno_id,
            al.nombres || ' ' || al.apellidos AS nombre,
            al.codigo, a.estado
       FROM alumnos al
       LEFT JOIN asistencias a ON a.alumno_id = al.id AND a.fecha = $2
      WHERE al.seccion_id = $1 AND al.activo = TRUE
      ORDER BY al.apellidos, al.nombres`,
    [seccionId, fecha]
  );

  const dias = [0, 1, 2, 3, 4].map(i => sumarDias(lunesDe(fecha), i));
  const conteos = await pool.query(
    `SELECT to_char(a.fecha, 'YYYY-MM-DD') AS fecha, COUNT(*)::int AS registrados
       FROM asistencias a
       JOIN alumnos al ON al.id = a.alumno_id
      WHERE al.seccion_id = $1 AND a.fecha BETWEEN $2 AND $3
      GROUP BY a.fecha`,
    [seccionId, dias[0], dias[4]]
  );
  const mapa = new Map(conteos.rows.map(c => [c.fecha, c.registrados]));

  res.json({
    estudiantes: est.rows,
    semana: dias.map(d => ({ fecha: d, registrados: mapa.get(d) || 0 }))
  });
}));

// Guardar la asistencia de una sección en una fecha
app.put('/api/docente/asistencia', requerirRol('docente'), ruta(async (req, res) => {
  const seccionId = entero(req.body.seccion_id);
  const fecha = req.body.fecha;
  const registros = req.body.registros;

  if (!seccionId || !fechaValida(fecha) || !Array.isArray(registros) || registros.length === 0) {
    throw new ErrorHttp(400, 'Datos incompletos');
  }

  // La pantalla dice "justificada"; la base guarda "justificado"
  const lista = registros.map(r => ({
    alumno_id: entero(r.alumno_id),
    estado: r.estado === 'justificada' ? 'justificado' : r.estado,
    observacion: texto(r.observacion) || null
  }));
  if (lista.some(r => !r.alumno_id || !ESTADOS.includes(r.estado))) {
    throw new ErrorHttp(400, 'Hay un registro con datos inválidos');
  }

  await exigirSeccionDelDocente(req.session.usuario.id, seccionId);

  const validos = await pool.query(
    'SELECT id FROM alumnos WHERE seccion_id = $1 AND activo = TRUE', [seccionId]
  );
  const ids = new Set(validos.rows.map(a => a.id));
  if (!lista.every(r => ids.has(r.alumno_id))) {
    throw new ErrorHttp(400, 'Hay estudiantes que no pertenecen a esa sección');
  }

  await enTransaccion(async (c) => {
    for (const r of lista) {
      await c.query(
        `INSERT INTO asistencias (alumno_id, fecha, estado, observacion, registrado_por)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (alumno_id, fecha) DO UPDATE
           SET estado = EXCLUDED.estado,
               observacion = COALESCE(EXCLUDED.observacion, asistencias.observacion),
               registrado_por = EXCLUDED.registrado_por`,
        [r.alumno_id, fecha, r.estado, r.observacion, req.session.usuario.id]
      );
    }
  });

  // Totales de toda la sección en esa fecha
  const t = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE a.estado = 'presente')::int    AS presentes,
            COUNT(*) FILTER (WHERE a.estado = 'ausente')::int     AS ausentes,
            COUNT(*) FILTER (WHERE a.estado = 'tarde')::int       AS tardes,
            COUNT(*) FILTER (WHERE a.estado = 'justificado')::int AS justificadas
       FROM asistencias a
       JOIN alumnos al ON al.id = a.alumno_id
      WHERE al.seccion_id = $1 AND a.fecha = $2`,
    [seccionId, fecha]
  );
  res.json(t.rows[0]);
}));

// Estudiantes de una sección con su cantidad de méritos y deméritos
app.get('/api/docente/estudiantes', requerirRol('docente'), ruta(async (req, res) => {
  const seccionId = entero(req.query.seccion_id);
  if (!seccionId) throw new ErrorHttp(400, 'Falta seccion_id');
  await exigirSeccionDelDocente(req.session.usuario.id, seccionId);

  const r = await pool.query(
    `SELECT al.id, al.nombres, al.apellidos, al.codigo,
            COUNT(m.id) FILTER (WHERE m.tipo = 'merito')::int   AS meritos,
            COUNT(m.id) FILTER (WHERE m.tipo = 'demerito')::int AS demeritos
       FROM alumnos al
       LEFT JOIN meritos_demeritos m ON m.alumno_id = al.id
      WHERE al.seccion_id = $1 AND al.activo = TRUE
      GROUP BY al.id
      ORDER BY al.apellidos, al.nombres`,
    [seccionId]
  );
  res.json(r.rows);
}));

// Agregar un estudiante a una sección del docente
app.post('/api/docente/estudiantes', requerirRol('docente'), ruta(async (req, res) => {
  const nombres = texto(req.body.nombres);
  const apellidos = texto(req.body.apellidos);
  const codigo = texto(req.body.codigo) || null;
  const seccionId = entero(req.body.seccion_id);
  const nacimiento = req.body.fecha_nacimiento;

  if (!nombres || !apellidos || !seccionId) throw new ErrorHttp(400, 'Faltan nombres, apellidos o sección');
  if (nombres.length > 100 || apellidos.length > 100 || (codigo || '').length > 30) {
    throw new ErrorHttp(400, 'Algún dato es demasiado largo');
  }
  if (nacimiento !== undefined && !fechaValida(nacimiento)) throw new ErrorHttp(400, 'Fecha de nacimiento inválida');

  await exigirSeccionDelDocente(req.session.usuario.id, seccionId);

  const r = await pool.query(
    `INSERT INTO alumnos (nombres, apellidos, codigo, fecha_nacimiento, seccion_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [nombres, apellidos, codigo, nacimiento || null, seccionId]
  );
  res.status(201).json({ id: r.rows[0].id });
}));

// Registros de méritos y deméritos de una sección (filtro opcional: mejoria)
app.get('/api/docente/seguimiento', requerirRol('docente'), ruta(async (req, res) => {
  const seccionId = entero(req.query.seccion_id);
  if (!seccionId) throw new ErrorHttp(400, 'Falta seccion_id');
  await exigirSeccionDelDocente(req.session.usuario.id, seccionId);

  const params = [seccionId];
  let filtro = '';
  if (['en_seguimiento', 'mejoro'].includes(req.query.mejoria)) {
    params.push(req.query.mejoria);
    filtro = 'AND m.mejoria = $2';
  }

  const r = await pool.query(
    `SELECT m.id,
            al.nombres || ' ' || al.apellidos AS estudiante,
            al.codigo, m.tipo, m.motivo, m.detalle, m.mejoria,
            to_char(m.fecha, 'YYYY-MM-DD') AS fecha
       FROM meritos_demeritos m
       JOIN alumnos al ON al.id = m.alumno_id
      WHERE al.seccion_id = $1 ${filtro}
      ORDER BY m.fecha DESC, m.id DESC
      LIMIT 500`,
    params
  );
  res.json(r.rows);
}));

// Registrar un mérito o demérito
app.post('/api/docente/registros', requerirRol('docente'), ruta(async (req, res) => {
  const alumnoId = entero(req.body.alumno_id);
  const tipo = req.body.tipo;
  const motivo = texto(req.body.motivo);
  const detalle = texto(req.body.detalle) || null;
  const fecha = req.body.fecha;

  if (!alumnoId || !['merito', 'demerito'].includes(tipo) || !motivo) {
    throw new ErrorHttp(400, 'Faltan datos: estudiante, tipo y motivo');
  }
  if (!fechaValida(fecha)) throw new ErrorHttp(400, 'Fecha inválida');

  await exigirAlumnoDelDocente(req.session.usuario.id, alumnoId);

  const r = await pool.query(
    `INSERT INTO meritos_demeritos (alumno_id, tipo, motivo, detalle, fecha, registrado_por)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [alumnoId, tipo, motivo, detalle, fecha, req.session.usuario.id]
  );
  res.status(201).json({ id: r.rows[0].id });
}));

// Marcar un registro como "En seguimiento" o "Mejoró" (solo el docente que lo hizo)
app.patch('/api/docente/registros/:id', requerirRol('docente'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  const mejoria = req.body.mejoria;
  if (!id || !['en_seguimiento', 'mejoro'].includes(mejoria)) throw new ErrorHttp(400, 'Datos inválidos');

  const r = await pool.query(
    'UPDATE meritos_demeritos SET mejoria = $1 WHERE id = $2 AND registrado_por = $3',
    [mejoria, id, req.session.usuario.id]
  );
  if (r.rowCount === 0) throw new ErrorHttp(403, 'Solo puedes cambiar los registros que hiciste tú');
  res.json({ ok: true });
}));

// Eliminar un registro (solo el docente que lo hizo)
app.delete('/api/docente/registros/:id', requerirRol('docente'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  if (!id) throw new ErrorHttp(400, 'Registro inválido');

  const r = await pool.query(
    'DELETE FROM meritos_demeritos WHERE id = $1 AND registrado_por = $2',
    [id, req.session.usuario.id]
  );
  if (r.rowCount === 0) throw new ErrorHttp(403, 'Solo puedes eliminar los registros que hiciste tú');
  res.json({ ok: true });
}));

// ===== 9B. NUEVO - RUTAS: DOCENTE - ACTIVIDADES Y NOTAS =====

// Las materias del docente (cada una es una materia en una sección)
app.get('/api/docente/asignaciones', requerirRol('docente'), ruta(async (req, res) => {
  const r = await pool.query(
    `SELECT a.id,
            s.id AS seccion_id, s.nombre AS seccion, s.grado, s.anio,
            asg.id AS asignatura_id, asg.nombre AS asignatura
       FROM asignaciones a
       JOIN docentes d ON d.id = a.docente_id
       JOIN secciones s ON s.id = a.seccion_id
       JOIN asignaturas asg ON asg.id = a.asignatura_id
      WHERE d.usuario_id = $1
      ORDER BY s.anio DESC, s.grado, s.nombre, asg.nombre`,
    [req.session.usuario.id]
  );
  res.json(r.rows);
}));

// Actividades, estudiantes y notas de una materia del docente
app.get('/api/docente/notas', requerirRol('docente'), ruta(async (req, res) => {
  const asignacionId = entero(req.query.asignacion_id);
  if (!asignacionId) throw new ErrorHttp(400, 'Falta asignacion_id');
  await exigirAsignacionDelDocente(pool, req.session.usuario.id, asignacionId);

  res.json(await cargarNotas(asignacionId));
}));

// Crear una actividad: { asignacion_id, periodo, nombre, porcentaje }
app.post('/api/docente/actividades', requerirRol('docente'), ruta(async (req, res) => {
  const asignacionId = entero(req.body.asignacion_id);
  if (!asignacionId) throw new ErrorHttp(400, 'Falta la materia');
  const periodo = leerPeriodo(req.body.periodo);
  const datos = leerActividad(req.body);

  const id = await enTransaccion(async (c) => {
    await exigirAsignacionDelDocente(c, req.session.usuario.id, asignacionId);
    // Se bloquea la materia para que dos pantallas no sumen más de 100% a la vez
    await c.query('SELECT id FROM asignaciones WHERE id = $1 FOR UPDATE', [asignacionId]);
    await validarPorcentaje(c, asignacionId, periodo, datos.porcentaje, 0);

    const r = await c.query(
      `INSERT INTO actividades (asignacion_id, periodo, nombre, porcentaje)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [asignacionId, periodo, datos.nombre, datos.porcentaje]
    );
    return r.rows[0].id;
  });

  res.status(201).json({ id });
}));

// Cambiar el nombre o el porcentaje de una actividad
app.put('/api/docente/actividades/:id', requerirRol('docente'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  if (!id) throw new ErrorHttp(400, 'Actividad inválida');
  const datos = leerActividad(req.body);

  await enTransaccion(async (c) => {
    const act = await c.query('SELECT asignacion_id, periodo FROM actividades WHERE id = $1', [id]);
    if (act.rowCount === 0) throw new ErrorHttp(404, 'Actividad no encontrada');
    const { asignacion_id, periodo } = act.rows[0];

    await exigirAsignacionDelDocente(c, req.session.usuario.id, asignacion_id);
    await c.query('SELECT id FROM asignaciones WHERE id = $1 FOR UPDATE', [asignacion_id]);
    await validarPorcentaje(c, asignacion_id, periodo, datos.porcentaje, id);

    await c.query(
      'UPDATE actividades SET nombre = $1, porcentaje = $2 WHERE id = $3',
      [datos.nombre, datos.porcentaje, id]
    );
  });

  res.json({ ok: true });
}));

// Eliminar una actividad (también se borran las notas que tenía)
app.delete('/api/docente/actividades/:id', requerirRol('docente'), ruta(async (req, res) => {
  const id = entero(req.params.id);
  if (!id) throw new ErrorHttp(400, 'Actividad inválida');

  await enTransaccion(async (c) => {
    const act = await c.query('SELECT asignacion_id FROM actividades WHERE id = $1', [id]);
    if (act.rowCount === 0) throw new ErrorHttp(404, 'Actividad no encontrada');

    await exigirAsignacionDelDocente(c, req.session.usuario.id, act.rows[0].asignacion_id);
    await c.query('DELETE FROM actividades WHERE id = $1', [id]);
  });

  res.json({ ok: true });
}));

// Guardar notas: { asignacion_id, notas: [ { actividad_id, alumno_id, nota } ] }
// Una nota vacía (null o "") quita la nota de ese estudiante en esa actividad.
app.put('/api/docente/notas', requerirRol('docente'), ruta(async (req, res) => {
  const asignacionId = entero(req.body.asignacion_id);
  if (!asignacionId) throw new ErrorHttp(400, 'Falta la materia');
  const lista = leerNotas(req.body.notas);

  await enTransaccion(async (c) => {
    const asignacion = await exigirAsignacionDelDocente(c, req.session.usuario.id, asignacionId);

    // Las actividades y los estudiantes deben ser de esta materia y de su sección
    const acts = await c.query('SELECT id FROM actividades WHERE asignacion_id = $1', [asignacionId]);
    const alumnos = await c.query(
      'SELECT id FROM alumnos WHERE seccion_id = $1 AND activo = TRUE', [asignacion.seccion_id]
    );
    const actividadesValidas = new Set(acts.rows.map(a => a.id));
    const alumnosValidos = new Set(alumnos.rows.map(a => a.id));

    for (const n of lista) {
      if (!actividadesValidas.has(n.actividadId)) throw new ErrorHttp(400, 'Hay una actividad que no es de esta materia');
      if (!alumnosValidos.has(n.alumnoId)) throw new ErrorHttp(400, 'Hay un estudiante que no es de esta sección');
    }

    for (const n of lista) {
      if (n.nota === null) {
        await c.query(
          'DELETE FROM notas_actividad WHERE actividad_id = $1 AND alumno_id = $2',
          [n.actividadId, n.alumnoId]
        );
      } else {
        await c.query(
          `INSERT INTO notas_actividad (actividad_id, alumno_id, nota, registrado_por)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (actividad_id, alumno_id) DO UPDATE
             SET nota = EXCLUDED.nota,
                 registrado_por = EXCLUDED.registrado_por,
                 actualizado_en = NOW()`,
          [n.actividadId, n.alumnoId, n.nota, req.session.usuario.id]
        );
      }
    }
  });

  res.json({ ok: true, guardadas: lista.length });
}));

// ===== 10. RUTAS QUE NO EXISTEN =====
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ===== 11. ARRANQUE =====
prepararBaseDeDatos()
  .then(() => {
    // Cada 15 minutos se borran las sesiones vencidas
    setInterval(() => {
      pool.query('DELETE FROM sesiones WHERE expire < NOW()')
        .catch(err => console.error('No se pudieron limpiar las sesiones vencidas:', err.message));
    }, 15 * 60 * 1000).unref();

    app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('No se pudo preparar la base de datos:', err.message);
    process.exit(1);
  });