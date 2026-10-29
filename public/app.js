const DATABASE_NAME = "servitech-field";
const DATABASE_VERSION = 1;
const STORE_NAME = "reports";

const connectionStatus = document.querySelector("#connectionStatus");
const connectionText = document.querySelector("#connectionText");
const notice = document.querySelector("#notice");
const reportForm = document.querySelector("#reportForm");
const saveButton = document.querySelector("#saveButton");
const syncButton = document.querySelector("#syncButton");
const installButton = document.querySelector("#installButton");
const pendingBadge = document.querySelector("#pendingBadge");
const reportsList = document.querySelector("#reportsList");

let database;
let deferredInstallPrompt;
let syncTask;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("syncState", "syncState");
      store.createIndex("createdAt", "createdAt");
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("No se pudo abrir IndexedDB.")), {
      once: true,
    });
    request.addEventListener("blocked", () => {
      reject(new Error("Cierra otras pestañas de ServiTech para actualizar la base de datos local."));
    }, { once: true });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Falló la transacción local.")), {
      once: true,
    });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Se canceló la transacción local.")), {
      once: true,
    });
  });
}

async function getAllReports() {
  const transaction = database.transaction(STORE_NAME, "readonly");
  const result = transaction.objectStore(STORE_NAME).getAll();
  const done = transactionComplete(transaction);
  const reports = await new Promise((resolve, reject) => {
    result.addEventListener("success", () => resolve(result.result), { once: true });
    result.addEventListener("error", () => reject(result.error ?? new Error("No se pudieron leer los reportes.")), {
      once: true,
    });
  });
  await done;
  return reports;
}

async function saveLocalReport(report) {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put(report);
  await transactionComplete(transaction);
}

async function saveLocalReports(reports) {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const report of reports) {
    store.put(report);
  }
  await transactionComplete(transaction);
}

function showNotice(message, type = "error") {
  notice.textContent = message;
  notice.classList.toggle("is-success", type === "success");
  notice.hidden = false;
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = "";
  notice.classList.remove("is-success");
}

function updateConnectionStatus() {
  const offline = !navigator.onLine;
  connectionStatus.classList.toggle("is-offline", offline);
  connectionText.textContent = offline
    ? "Sin conexión: los reportes se guardan en este dispositivo."
    : "En línea: los reportes se sincronizan con el servidor.";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function createReportCard(report) {
  const article = document.createElement("article");
  article.className = "report-card";

  const header = document.createElement("div");
  header.className = "report-card-header";
  const titleGroup = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = report.serviceType;
  const meta = document.createElement("p");
  meta.className = "report-meta";
  meta.textContent = `${report.technicianName} · ${report.location} · Prioridad ${report.priority} · ${formatDate(report.createdAt)}`;
  titleGroup.append(title, meta);

  const status = document.createElement("span");
  const synced = report.syncState === "synced";
  status.className = `sync-state${synced ? " is-synced" : ""}`;
  status.textContent = synced ? "Enviado" : "Pendiente";
  header.append(titleGroup, status);

  const description = document.createElement("p");
  description.className = "report-description";
  description.textContent = report.description;
  article.append(header, description);
  return article;
}

async function renderReports() {
  const reports = await getAllReports();
  reports.sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));
  const pendingCount = reports.filter((report) => report.syncState === "pending").length;
  pendingBadge.textContent = `${pendingCount} pendiente${pendingCount === 1 ? "" : "s"}`;
  pendingBadge.classList.toggle("is-clear", pendingCount === 0);
  syncButton.disabled = pendingCount === 0 || !navigator.onLine;

  reportsList.replaceChildren();
  if (reports.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "Todavía no hay reportes guardados en este dispositivo.";
    reportsList.append(emptyState);
    return;
  }
  reportsList.append(...reports.map(createReportCard));
}

async function requestJson(path, options) {
  const response = await fetch(path, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("El servidor devolvió una respuesta que no es JSON válido.");
  }

  if (!response.ok) {
    const message = payload?.error?.message ?? `La solicitud falló (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return payload;
}

async function syncPendingReports() {
  let sentCount = 0;
  while (true) {
    const reports = await getAllReports();
    const pending = reports.filter((report) => report.syncState === "pending");
    if (pending.length === 0) {
      break;
    }

    for (const report of pending) {
      await requestJson("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: report.id,
          technicianName: report.technicianName,
          location: report.location,
          serviceType: report.serviceType,
          priority: report.priority,
          description: report.description,
          createdAt: report.createdAt,
        }),
      });
      await saveLocalReport({ ...report, syncState: "synced" });
      sentCount += 1;
    }
  }
  return sentCount;
}

async function synchronize() {
  if (!navigator.onLine) {
    await renderReports();
    return;
  }
  if (syncTask) {
    await syncTask;
    return;
  }

  syncButton.disabled = true;
  syncTask = syncPendingReports();
  try {
    const sentCount = await syncTask;
    if (sentCount > 0) {
      showNotice(
        `${sentCount} reporte${sentCount === 1 ? "" : "s"} sincronizado${sentCount === 1 ? "" : "s"} correctamente.`,
        "success",
      );
    }
  } finally {
    syncTask = undefined;
    await renderReports();
  }
}

async function loadServerReports() {
  const payload = await requestJson("/api/reports");
  if (!Array.isArray(payload.reports)) {
    throw new Error("La respuesta de la API no contiene una lista de reportes válida.");
  }
  await saveLocalReports(payload.reports.map((report) => ({ ...report, syncState: "synced" })));
}

async function handleOnline() {
  updateConnectionStatus();
  try {
    await loadServerReports();
    await synchronize();
    await renderReports();
  } catch (error) {
    showNotice(`No se pudo completar la sincronización: ${error.message}`);
    await renderReports();
  }
}

reportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice();
  saveButton.disabled = true;

  const formData = new FormData(reportForm);
  const report = {
    id: crypto.randomUUID(),
    technicianName: String(formData.get("technicianName")).trim(),
    location: String(formData.get("location")).trim(),
    serviceType: String(formData.get("serviceType")),
    priority: String(formData.get("priority")),
    description: String(formData.get("description")).trim(),
    createdAt: new Date().toISOString(),
    syncState: "pending",
  };

  try {
    await saveLocalReport(report);
    reportForm.reset();
    await renderReports();
    if (navigator.onLine) {
      await synchronize();
    } else {
      showNotice("Reporte guardado en este dispositivo. Se enviará al recuperar la conexión.", "success");
    }
  } catch (error) {
    showNotice(`No se pudo guardar el reporte: ${error.message}`);
  } finally {
    saveButton.disabled = false;
  }
});

syncButton.addEventListener("click", async () => {
  clearNotice();
  try {
    await loadServerReports();
    await synchronize();
  } catch (error) {
    showNotice(`No se pudo sincronizar: ${error.message}`);
    await renderReports();
  }
});

window.addEventListener("online", () => {
  void handleOnline();
});
window.addEventListener("offline", () => {
  updateConnectionStatus();
  void renderReports().catch((error) => showNotice(`No se pudieron actualizar los reportes: ${error.message}`));
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = undefined;
  installButton.hidden = true;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = undefined;
  installButton.hidden = true;
});

async function initialize() {
  updateConnectionStatus();
  try {
    database = await openDatabase();
    await renderReports();
    if (navigator.onLine) {
      await handleOnline();
    }
  } catch (error) {
    showNotice(`No se pudo iniciar el almacenamiento local: ${error.message}`);
    saveButton.disabled = true;
    syncButton.disabled = true;
  }

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("/sw.js");
    } catch (error) {
      showNotice(`No se pudo activar el modo offline de la aplicación: ${error.message}`);
    }
  } else {
    showNotice("Este navegador no permite habilitar el modo offline con Service Worker.");
  }
}

void initialize();
