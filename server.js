import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIRECTORY = join(ROOT, "public");
const DEFAULT_DATA_FILE = join(ROOT, "data", "reports.json");
const LEGACY_ENTRY_FILE = "aplicacion_web_progresiva_de_reportes_t_cnicos.html";
const MAX_BODY_BYTES = 32 * 1024;
const SERVICE_TYPES = new Set([
  "Mantenimiento Preventivo",
  "Reparación Correctiva",
  "Instalación de Equipo",
  "Inspección de Red",
]);
const PRIORITIES = new Set(["Baja", "Media", "Alta", "Urgente"]);
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readReports(dataFile) {
  if (sql) {
    const rows = await sql`
      SELECT 
        id, 
        technician_name AS "technicianName", 
        location, 
        service_type AS "serviceType", 
        priority, 
        description, 
        created_at AS "createdAt"
      FROM reports
      ORDER BY created_at DESC;
    `;
    return rows.map(r => ({
      ...r,
      createdAt: new Date(r.createdAt).toISOString()
    }));
  }

  const content = readFileSync(dataFile, "utf8");
  const reports = JSON.parse(content);
  if (!Array.isArray(reports)) {
    throw new Error("El archivo de reportes debe contener un arreglo JSON.");
  }
  return reports;
}

async function writeReport(dataFile, report) {
  if (sql) {
    const existing = await sql`SELECT * FROM reports WHERE id = ${report.id}::uuid`;
    if (existing.length > 0) {
      const e = existing[0];
      const match = 
        e.id === report.id &&
        e.technician_name === report.technicianName &&
        e.location === report.location &&
        e.service_type === report.serviceType &&
        e.priority === report.priority &&
        e.description === report.description &&
        new Date(e.created_at).toISOString() === new Date(report.createdAt).toISOString();

      if (!match) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Ya existe un reporte con este identificador y contenido distinto."
        );
      }
      return { report, isNew: false };
    }

    await sql`
      INSERT INTO reports (id, technician_name, location, service_type, priority, description, created_at)
      VALUES (${report.id}::uuid, ${report.technicianName}, ${report.location}, ${report.serviceType}, ${report.priority}, ${report.description}, ${report.createdAt}::timestamptz)
    `;
    return { report, isNew: true };
  }

  const reports = JSON.parse(readFileSync(dataFile, "utf8"));
  const existing = reports.find((savedReport) => savedReport.id === report.id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(report)) {
      throw new HttpError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Ya existe un reporte con este identificador y contenido distinto."
      );
    }
    return { report: existing, isNew: false };
  }

  reports.push(report);
  const temporaryFile = `${dataFile}.${randomUUID()}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(reports, null, 2)}\n`, "utf8");
  renameSync(temporaryFile, dataFile);
  return { report, isNew: true };
}

async function readJsonBody(request) {
  if (!request.headers["content-type"]?.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "El cuerpo debe enviarse como JSON.");
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "El reporte supera el tamaño permitido.");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "El cuerpo de la solicitud no contiene JSON válido.");
  }
}

function normalizeReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REPORT", "El reporte debe ser un objeto JSON.");
  }

  const { id, technicianName, location, serviceType, priority, description, createdAt } = value;
  const requiredTextFields = [
    ["technicianName", technicianName, 120],
    ["location", location, 160],
    ["description", description, 2000],
  ];

  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, "INVALID_REPORT", "El identificador del reporte debe ser un UUID válido.");
  }

  for (const [field, fieldValue, maximumLength] of requiredTextFields) {
    if (typeof fieldValue !== "string" || !fieldValue.trim() || fieldValue.length > maximumLength) {
      throw new HttpError(
        400,
        "INVALID_REPORT",
        `El campo ${field} es obligatorio y no debe superar ${maximumLength} caracteres.`,
      );
    }
  }

  if (!SERVICE_TYPES.has(serviceType)) {
    throw new HttpError(400, "INVALID_REPORT", "El tipo de servicio no es válido.");
  }
  if (!PRIORITIES.has(priority)) {
    throw new HttpError(400, "INVALID_REPORT", "La prioridad no es válida.");
  }
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw new HttpError(400, "INVALID_REPORT", "La fecha de creación no es válida.");
  }

  return {
    id,
    technicianName: technicianName.trim(),
    location: location.trim(),
    serviceType,
    priority,
    description: description.trim(),
    createdAt: new Date(createdAt).toISOString(),
  };
}

function jsonResponseHeaders() {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function serveStatic(request, response, pathname, publicDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", ...jsonResponseHeaders() });
    response.end();
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: { code: "INVALID_PATH", message: "La ruta no es válida." } });
    return;
  }

  const relativePath = decodedPath === "/" ? "index.html" : normalize(decodedPath).replace(/^([/\\])+/, "");
  const filePath = resolve(publicDirectory, relativePath);
  if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${sep}`)) {
    sendJson(response, 403, { error: { code: "FORBIDDEN", message: "La ruta solicitada no está permitida." } });
    return;
  }

  if (!existsSync(filePath)) {
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "El recurso solicitado no existe." } });
    return;
  }

  const headers = {
    ...jsonResponseHeaders(),
    "Content-Type": CONTENT_TYPES.get(extname(filePath)) ?? "application/octet-stream",
    "Cache-Control": ["index.html", "app.js", "styles.css", "sw.js", "manifest.webmanifest"].includes(basename(filePath))
      ? "no-cache"
      : "public, max-age=86400",
  };
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(readFileSync(filePath));
}

async function handleRequest(request, response, dataFile, publicDirectory) {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const pathname = requestUrl.pathname;

  if (pathname === "/api/health") {
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET", ...jsonResponseHeaders() });
      response.end();
      return;
    }
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (pathname === "/api/reports") {
    if (request.method === "GET") {
      const reports = await readReports(dataFile);
      sendJson(response, 200, { reports });
      return;
    }

    if (request.method === "POST") {
      const report = normalizeReport(await readJsonBody(request));
      const { report: savedReport, isNew } = await writeReport(dataFile, report);
      sendJson(response, isNew ? 201 : 200, { report: savedReport });
      return;
    }

    response.writeHead(405, { Allow: "GET, POST", ...jsonResponseHeaders() });
    response.end();
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "El endpoint solicitado no existe." } });
    return;
  }

  if (pathname === `/${LEGACY_ENTRY_FILE}`) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", ...jsonResponseHeaders() });
      response.end();
      return;
    }

    response.writeHead(200, {
      ...jsonResponseHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : readFileSync(join(ROOT, LEGACY_ENTRY_FILE)));
    return;
  }

  serveStatic(request, response, pathname, publicDirectory);
}

const requestHandler = (request, response) => {
  response.on("error", (error) => {
    console.error("Error al enviar la respuesta HTTP:", error);
  });
  void handleRequest(request, response, DEFAULT_DATA_FILE, DEFAULT_PUBLIC_DIRECTORY).catch((error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    if (error instanceof HttpError) {
      sendJson(response, error.status, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    console.error("Error al procesar la solicitud HTTP:", error);
    sendJson(response, 500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Ocurrió un error interno del servidor." },
    });
  });
};

export function createServer({
  dataFile = DEFAULT_DATA_FILE,
  publicDirectory = DEFAULT_PUBLIC_DIRECTORY,
} = {}) {
  if (!sql) {
    mkdirSync(dirname(dataFile), { recursive: true });
    if (!existsSync(dataFile)) {
      writeFileSync(dataFile, "[]\n", "utf8");
    }
  }

  return createHttpServer(requestHandler);
}

// Exportación por defecto requerida por Vercel para Serverless Functions
// Instancia del servidor para Vercel (Serverless)
const server = createServer();
export default server;

export function startServer() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT debe ser un número entero entre 0 y 65535.");
  }

  const server = createHttpServer(requestHandler);
  server.listen(port, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`ServiTech disponible en http://localhost:${actualPort}`);
    if (sql) {
      console.log("Conectado exitosamente a la base de datos Neon (PostgreSQL).");
    } else {
      console.log("Modo local: usando persistencia JSON.");
    }
  });
  server.on("error", (error) => {
    console.error("No se pudo iniciar el servidor:", error);
    process.exitCode = 1;
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}