# ServiTech Field

PWA para capturar reportes de servicio técnico desde teléfonos y tabletas, incluso en zonas sin cobertura. Los reportes se guardan primero en IndexedDB y se envían a la API cuando vuelve la conexión.

## Requisitos

- Node.js 20 o posterior.
- Navegador moderno con IndexedDB y Service Worker.

## Ejecutar localmente

```bash
npm start
```

Abre <http://localhost:3000>. La aplicación está separada en archivos: el HTML está en `public/index.html`, los estilos en `public/styles.css`, la lógica del navegador en `public/app.js`, el Service Worker en `public/sw.js` y la configuración PWA en `public/manifest.webmanifest`. El archivo `aplicacion_web_progresiva_de_reportes_t_cnicos.html` conserva el nombre del prototipo y carga esos mismos recursos externos.

`localhost` es un origen seguro para desarrollo; para probar en otros dispositivos o desplegar, publica el servidor detrás de HTTPS.

Los datos de la API se guardan en `data/reports.json`, que se crea al iniciar el servidor. El archivo está excluido de Git para evitar subir reportes locales.

## API REST

Todos los endpoints usan el mismo origen que la aplicación.

### `GET /api/health`

Comprueba que el servidor está activo.

Respuesta `200`:

```json
{ "status": "ok" }
```

### `GET /api/reports`

Devuelve los reportes en orden descendente por fecha de creación.

Respuesta `200`:

```json
{ "reports": [] }
```

### `POST /api/reports`

Guarda un reporte. Requiere `Content-Type: application/json`.

Ejemplo de cuerpo:

```json
{
  "id": "41e51f65-cd43-47bc-bbc9-0327ad8a4c10",
  "technicianName": "Carlos Ramírez",
  "location": "Comunidad El Norte",
  "serviceType": "Mantenimiento Preventivo",
  "priority": "Media",
  "description": "Se revisó el equipo y se sustituyó el filtro.",
  "createdAt": "2026-10-28T15:30:00.000Z"
}
```

Respuesta `201` al crear:

```json
{ "report": { "...": "..." } }
```

Reenviar el mismo identificador y contenido es idempotente y responde `200`. Si se reutiliza el identificador con contenido distinto, responde `409`. Las entradas inválidas devuelven un error JSON con `error.code` y `error.message`.

## Funcionamiento offline

- El Service Worker precarga la interfaz y aplica Stale-While-Revalidate a los recursos de la aplicación.
- El formulario guarda cada reporte en IndexedDB antes de intentar enviarlo.
- Los reportes pendientes se sincronizan al recuperar la conectividad o al pulsar **Sincronizar**.
- La interfaz muestra el estado de conexión y cuántos reportes siguen pendientes.

En iOS, la instalación se realiza desde **Compartir > Añadir a pantalla de inicio**. En navegadores compatibles de escritorio y Android se puede usar el botón de instalación que ofrece el navegador.

## Validación

```bash
npm test
```

Para comprobar la instalación y el modo offline, abre la aplicación mediante `localhost` o HTTPS y utiliza el panel **Application** y Lighthouse en Chrome o Edge DevTools.
