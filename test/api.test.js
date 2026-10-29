import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "../server.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "servitech-test-"));
const server = createServer({
  dataFile: join(temporaryDirectory, "reports.json"),
});
let baseUrl;

before(async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

const validReport = {
  id: "41e51f65-cd43-47bc-bbc9-0327ad8a4c10",
  technicianName: "Carlos Ramírez",
  location: "Comunidad El Norte",
  serviceType: "Mantenimiento Preventivo",
  priority: "Media",
  description: "Se revisó el equipo.",
  createdAt: "2026-10-28T15:30:00.000Z",
};

test("health endpoint reports server status", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("reports can be created, retrieved, and retried idempotently", async () => {
  const create = () => fetch(`${baseUrl}/api/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validReport),
  });

  const firstResponse = await create();
  assert.equal(firstResponse.status, 201);
  assert.deepEqual((await firstResponse.json()).report, validReport);

  const retryResponse = await create();
  assert.equal(retryResponse.status, 200);

  const listResponse = await fetch(`${baseUrl}/api/reports`);
  assert.equal(listResponse.status, 200);
  assert.deepEqual((await listResponse.json()).reports, [validReport]);
});

test("rejects invalid reports and conflicting idempotency keys", async () => {
  const invalidResponse = await fetch(`${baseUrl}/api/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...validReport, priority: "Crítica" }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error.code, "INVALID_REPORT");

  const conflictingResponse = await fetch(`${baseUrl}/api/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...validReport, description: "Contenido distinto." }),
  });
  assert.equal(conflictingResponse.status, 409);
  assert.equal((await conflictingResponse.json()).error.code, "IDEMPOTENCY_CONFLICT");
});

test("serves the application shell for the PWA", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /ServiTech Field/);
});

test("the named HTML entry point loads its external stylesheet and script", async () => {
  const response = await fetch(`${baseUrl}/aplicacion_web_progresiva_de_reportes_t_cnicos.html`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);

  const [stylesheet, script] = await Promise.all([
    fetch(`${baseUrl}/styles.css`),
    fetch(`${baseUrl}/app.js`),
  ]);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type"), /text\/css/);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
});
