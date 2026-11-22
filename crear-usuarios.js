const bcrypt = require('bcrypt');
const pool = require('./db');

async function crearUsuario(nombre, usuario, contrasena, rol) {
  const hash = await bcrypt.hash(contrasena, 10);
  await pool.query(
    'INSERT INTO usuarios (nombre, usuario, contrasena_hash, rol) VALUES ($1, $2, $3, $4)',
    [nombre, usuario, hash, rol]
  );
  console.log(`Usuario creado: ${usuario} (${rol})`);
}

async function main() {
  try {
    await crearUsuario('Director de Prueba', 'director1', 'Director123', 'director');
    await crearUsuario('Docente de Prueba', 'docente1', 'Docente123', 'docente');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

main();