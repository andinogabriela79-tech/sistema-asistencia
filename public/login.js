const formLogin = document.getElementById('form-login');
const formCambio = document.getElementById('form-cambio');
const titulo = document.getElementById('titulo');
const mensaje = document.getElementById('mensaje');

// ---------- 0. El ojito: mostrar / ocultar contraseña ----------
document.querySelectorAll('.ver-contrasena').forEach((boton) => {
    boton.addEventListener('click', () => {
        const campo = document.getElementById(boton.dataset.campo);
        const mostrar = campo.type === 'password';

        campo.type = mostrar ? 'text' : 'password';
        boton.setAttribute('aria-pressed', String(mostrar));
        boton.setAttribute('aria-label', mostrar ? 'Ocultar contraseña' : 'Mostrar contraseña');
        campo.focus();
    });
});

// Deja todas las contraseñas ocultas otra vez
function ocultarContrasenas() {
    document.querySelectorAll('.ver-contrasena').forEach((boton) => {
        document.getElementById(boton.dataset.campo).type = 'password';
        boton.setAttribute('aria-pressed', 'false');
        boton.setAttribute('aria-label', 'Mostrar contraseña');
    });
}

// Lleva a cada persona a su panel según el rol
function irAlPanel(rol) {
    if (rol === 'director') {
        window.location.href = '/director.html';
    } else {
        window.location.href = '/docente.html';
    }
}

// Cambia de la pantalla de login a la de contraseña nueva
function mostrarCambio() {
    ocultarContrasenas();
    formLogin.hidden = true;
    formCambio.hidden = false;
    titulo.textContent = 'Elige tu contraseña';
    mensaje.textContent = '';
    document.getElementById('contrasena-actual').focus();
}

// Vuelve a la pantalla normal de inicio de sesión
function mostrarLogin() {
    ocultarContrasenas();
    formCambio.hidden = true;
    formLogin.hidden = false;
    titulo.textContent = 'Inicia Sesion';
    mensaje.textContent = '';
    formCambio.reset();
    document.getElementById('usuario').focus();
}

// ---------- 1. Iniciar sesión ----------
formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    mensaje.textContent = '';

    const usuario = document.getElementById('usuario').value;
    const contrasena = document.getElementById('contrasena').value;

    try {
        const respuesta = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, contrasena })
        });

        const datos = await respuesta.json();

        if (!respuesta.ok) {
            mensaje.textContent = datos.error;
            return;
        }

        // Si la contraseña es temporal, primero se debe cambiar
        if (datos.debe_cambiar) {
            mostrarCambio();
            return;
        }

        irAlPanel(datos.rol);
    } catch (err) {
        mensaje.textContent = 'No se puede conectar con el servidor';
    }
});

// ---------- 2. Guardar la contraseña nueva ----------
formCambio.addEventListener('submit', async (e) => {
    e.preventDefault();
    mensaje.textContent = '';

    const actual = document.getElementById('contrasena-actual').value;
    const nueva = document.getElementById('contrasena-nueva').value;
    const repetir = document.getElementById('contrasena-repetir').value;

    if (nueva !== repetir) {
        mensaje.textContent = 'Las contraseñas nuevas no coinciden';
        return;
    }

    try {
        const respuesta = await fetch('/api/cambiar-contrasena', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actual, nueva })
        });

        const datos = await respuesta.json();

        if (!respuesta.ok) {
            mensaje.textContent = datos.error;
            return;
        }

        irAlPanel(datos.rol);
    } catch (err) {
        mensaje.textContent = 'No se puede conectar con el servidor';
    }
});

// ---------- 3. Usar otra cuenta (cierra la sesión pendiente) ----------
document.getElementById('btn-otra-cuenta').addEventListener('click', async () => {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (err) {
        // Si falla igual se muestra el login
    }
    mostrarLogin();
});

// ---------- 4. Al abrir la página ----------
// Si hay una sesión con contraseña temporal sin cambiar, se muestra el
// cambio de contraseña (con el botón "Usar otra cuenta" para salir de ahí).
async function revisarSesion() {
    try {
        const respuesta = await fetch('/api/sesion');
        if (!respuesta.ok) return;   // no hay sesión: se queda en el login normal

        const sesion = await respuesta.json();
        if (sesion.debe_cambiar) mostrarCambio();
    } catch (err) {
        // Sin conexión: se queda en el login normal
    }
}

revisarSesion();