import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const PHASE5_IMG = process.env.PHASE5_IMG ?? resolve(REPO_ROOT, "documents", "deliveries", "phase.5", "img");
const URL = process.env.WEBAPP_URL ?? "http://localhost:5173";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const save = async (page, name) => {
  const buffer = await page.screenshot({ fullPage: true });
  await mkdir(PHASE5_IMG, { recursive: true });
  const path = resolve(PHASE5_IMG, `${name}.png`);
  await writeFile(path, buffer);
  console.log(`saved ${path}`);
};

const createBackendTracker = (page) => {
  const received = [];
  const listeners = [];
  page.on("websocket", (ws) => {
    if (!ws.url().includes(":8765")) return;
    ws.on("framereceived", (p) => {
      const raw = String(p.payload);
      let type = "";
      try {
        type = JSON.parse(raw).type ?? "";
      } catch {}
      received.push({ type, raw, at: Date.now() });
      for (const cb of listeners) cb(type, raw);
    });
  });
  const waitFor = (predicate, timeout = 30000) =>
    new Promise((resolveP, rejectP) => {
      for (const entry of received) {
        if (predicate(entry.type, entry.raw)) {
          resolveP(entry);
          return;
        }
      }
      const timer = setTimeout(() => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
        rejectP(new Error(`timed out waiting for backend event`));
      }, timeout);
      const listener = (type, raw) => {
        if (predicate(type, raw)) {
          clearTimeout(timer);
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
          resolveP({ type, raw, at: Date.now() });
        }
      };
      listeners.push(listener);
    });
  const clear = () => {
    received.length = 0;
  };
  return { waitFor, clear };
};

const waitConnected = async (page) => {
  await page.waitForSelector(".status-pill.status-connected", { timeout: 30000 });
};

const dismissAllToasts = async (page) => {
  await page.mouse.move(10, 10);
  await sleep(3600);
};

const clickButton = async (page, name) => {
  await page.getByRole("button", { name, exact: true }).click();
};

const main = async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1050 },
    deviceScaleFactor: 1.25,
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    console.log(`browser ${msg.type()}:`, msg.text());
  });
  page.on("pageerror", (err) => {
    console.log("browser pageerror:", err.message);
  });
  const tracker = createBackendTracker(page);

  try {
    await run(page, tracker);
  } catch (err) {
    try {
      await mkdir(PHASE5_IMG, { recursive: true });
      await page.screenshot({
        path: resolve(PHASE5_IMG, "_debug_failure.png"),
        fullPage: true,
      });
      console.error("saved failure screenshot");
    } catch {}
    throw err;
  } finally {
    await browser.close();
  }
  console.log("phase.5 screenshots captured successfully");
};

const run = async (page, tracker) => {
  console.log(`opening ${URL}`);
  await page.goto(URL, { waitUntil: "networkidle" });
  await waitConnected(page);
  await sleep(4000);
  await dismissAllToasts(page);
  await sleep(500);
  tracker.clear();

  // 1. Estado inicial (para manual)
  await save(page, "01_estado_inicial");

  // 2. Configuracion aplicada
  tracker.clear();
  await clickButton(page, "Configurar");
  await tracker.waitFor((t) => t === "cfg_ok" || t === "cfg");
  await sleep(800);
  await save(page, "02_configuracion_aplicada");
  await dismissAllToasts(page);

  // 3. Calibracion completada
  tracker.clear();
  await clickButton(page, "Calibrar");
  await tracker.waitFor((t) => t === "cal");
  await sleep(800);
  await save(page, "03_calibracion_completada");
  await dismissAllToasts(page);

  // 4. Sweep en curso
  tracker.clear();
  await page.waitForSelector("select");
  await page.selectOption("select", "1");
  await clickButton(page, "Iniciar sweep");
  await tracker.waitFor((t) => t === "sweep_start");
  await sleep(1500);
  await save(page, "04_sweep_en_curso");

  // 5. Sweep completado con analisis
  await tracker.waitFor((t) => t === "analysis", 60000);
  await sleep(1000);
  await save(page, "05_sweep_completado_analisis");
  await dismissAllToasts(page);

  // Run extra sweeps to populate history
  for (let i = 0; i < 2; i += 1) {
    tracker.clear();
    const label = i === 0 ? "0" : "1";
    await page.selectOption("select", label);
    await clickButton(page, "Iniciar sweep");
    await tracker.waitFor((t) => t === "sweep_start");
    await tracker.waitFor((t) => t === "analysis", 60000);
    await sleep(800);
  }

  // 6. Historial de sesiones
  tracker.clear();
  await clickButton(page, "Historial");
  await tracker.waitFor((t) => t === "history");
  await sleep(800);
  await save(page, "06_historial_sesiones");
  await dismissAllToasts(page);

  // 7. Exportacion generada
  tracker.clear();
  await clickButton(page, "Exportar ultimo");
  await tracker.waitFor((t) => t === "export" || t === "analysis");
  await sleep(1000);
  await save(page, "07_exportacion_generada");
  await dismissAllToasts(page);

  // 8. Vista limpia (para manual)
  tracker.clear();
  await clickButton(page, "Limpiar vista");
  await sleep(800);
  await save(page, "08_vista_limpia");
};

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
