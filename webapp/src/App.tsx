import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Line, Scatter } from "react-chartjs-2";
import {
  Chart as ChartJS,
  type ChartOptions,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  LineController,
  ScatterController,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { ToastContainer, toast, type Id } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

ChartJS.register(
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  LineController,
  ScatterController,
  Title,
  Tooltip,
  Legend,
);

const WS_URL = "ws://localhost:8765";

type Status = "disconnected" | "connected" | "sweeping" | "error";
type CommandKey =
  | "ping"
  | "cfg"
  | "cal"
  | "start"
  | "stop"
  | "temp"
  | "history"
  | "export";
type ToastKind = "success" | "error" | "warning" | "info";

interface WorkflowState {
  configured: boolean;
  calibrated: boolean;
  configDirtySinceCalibration: boolean;
  lastConfigSignature: string | null;
  lastCalibrationResistance: number | null;
}

interface EISDataPoint {
  i: number;
  f: number;
  Z: number;
  phase: number;
  reZ: number;
  imZ: number;
  ts?: string;
}

interface AnalysisResult {
  quantum_probability: number;
  quantum_label: number;
  quantum_score: number;
  classical_probability: number;
  classical_label: number;
  agreement: boolean;
  expected_label: number | null;
  quantum_match: boolean | null;
  classical_match: boolean | null;
  point_count: number;
  features: Record<string, number>;
}

interface SessionHistoryItem {
  session_id: string;
  started_at: string | null;
  finished_at: string | null;
  point_count: number;
  stop_reason: string;
  expected_label: number | null;
  analysis?: AnalysisResult;
}

interface ExportResult {
  session_id: string;
  paths: {
    dir: string;
    csv: string;
    metadata: string;
    summary: string;
    bundle: string;
  };
}

const INITIAL_WORKFLOW: WorkflowState = {
  configured: false,
  calibrated: false,
  configDirtySinceCalibration: false,
  lastConfigSignature: null,
  lastCalibrationResistance: null,
};

const toNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const createConfigSignature = (
  fmin: number,
  fmax: number,
  npoints: number,
  settle: number,
): string => `${fmin.toFixed(6)}|${fmax.toFixed(6)}|${npoints}|${settle}`;

const commandLabel = (command: CommandKey): string => {
  const labels: Record<CommandKey, string> = {
    ping: "PING",
    cfg: "CFG",
    cal: "CAL",
    start: "START",
    stop: "STOP",
    temp: "TEMP",
    history: "HISTORY",
    export: "EXPORT",
  };
  return labels[command];
};

const formatBackendError = (code: string, fallbackMessage: string): string => {
  if (code === "NOT_CALIBRATED") {
    return "No se puede iniciar sweep porque falta calibrar. Ejecuta Calibrar y vuelve a intentar.";
  }
  if (code === "SWEEP_RUNNING") {
    return "Ya hay un sweep en curso. Espera a que termine o pulsa Detener.";
  }
  if (code === "NO_SESSION") {
    return "No existe una sesion terminada para exportar todavia.";
  }
  if (code === "CFG_FORMAT") {
    return "La configuracion enviada es invalida. Revisa frecuencias, puntos y settling.";
  }
  if (code === "CAL_FORMAT") {
    return "El valor de calibracion es invalido. Usa un R_cal numerico mayor que cero.";
  }
  if (code === "INVALID_EXPECTED_LABEL") {
    return "La etiqueta esperada es invalida. Usa Control (0) o Candida (1).";
  }
  if (code === "UNKNOWN_COMMAND") {
    return "El backend rechazo un comando no soportado por el dispositivo.";
  }
  if (code === "") {
    return fallbackMessage;
  }
  return `${code}: ${fallbackMessage}`;
};

const commandFromErrorCode = (code: string): CommandKey | null => {
  if (code === "NOT_CALIBRATED" || code === "SWEEP_RUNNING") {
    return "start";
  }
  if (code === "NO_SESSION") {
    return "export";
  }
  if (code === "CFG_FORMAT") {
    return "cfg";
  }
  if (code === "CAL_FORMAT") {
    return "cal";
  }
  return null;
};

const App = () => {
  const [fmin, setFmin] = useState(1000);
  const [fmax, setFmax] = useState(100000);
  const [npoints, setNpoints] = useState(50);
  const [settle, setSettle] = useState(15);
  const [calR, setCalR] = useState(10000);
  const [status, setStatus] = useState<Status>("disconnected");
  const [temperature, setTemperature] = useState<number | null>(null);
  const [expectedLabel, setExpectedLabel] = useState<0 | 1>(1);
  const [sweepData, setSweepData] = useState<EISDataPoint[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  const [history, setHistory] = useState<SessionHistoryItem[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowState>(INITIAL_WORKFLOW);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const workflowRef = useRef<WorkflowState>(INITIAL_WORKFLOW);
  const statusRef = useRef<Status>("disconnected");
  const pendingToastsRef = useRef<Map<CommandKey, Id>>(new Map());

  useEffect(() => {
    workflowRef.current = workflow;
  }, [workflow]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const addLog = useCallback((msg: string) => {
    const stamp = new Date().toLocaleTimeString("es-ES", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setLog((prev) => [...prev.slice(-149), `[${stamp}] ${msg}`]);
  }, []);

  const notify = useCallback((kind: ToastKind, message: string, toastId?: string) => {
    const options = {
      position: "bottom-right" as const,
      toastId,
      autoClose: kind === "error" ? 4200 : 3200,
    };
    if (kind === "success") {
      toast.success(message, options);
      return;
    }
    if (kind === "error") {
      toast.error(message, options);
      return;
    }
    if (kind === "warning") {
      toast.warn(message, options);
      return;
    }
    toast.info(message, options);
  }, []);

  const beginPendingToast = useCallback((command: CommandKey, message: string) => {
    const current = pendingToastsRef.current.get(command);
    if (current !== undefined) {
      toast.dismiss(current);
      pendingToastsRef.current.delete(command);
    }
    const id = toast.loading(message, {
      position: "bottom-right",
      closeOnClick: false,
    });
    pendingToastsRef.current.set(command, id);
  }, []);

  const resolvePendingToast = useCallback(
    (command: CommandKey, kind: ToastKind, message: string) => {
      const current = pendingToastsRef.current.get(command);
      if (current !== undefined) {
        toast.dismiss(current);
        pendingToastsRef.current.delete(command);
      }
      notify(kind, message);
    },
    [notify],
  );

  const failAllPending = useCallback(
    (message: string) => {
      if (pendingToastsRef.current.size === 0) {
        return;
      }
      for (const pendingId of pendingToastsRef.current.values()) {
        toast.dismiss(pendingId);
      }
      pendingToastsRef.current.clear();
      notify("error", message, "all-pending-failed");
    },
    [notify],
  );

  const sendRaw = useCallback((type: string, payload?: Record<string, unknown>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }
    wsRef.current.send(JSON.stringify({ type, payload }));
    return true;
  }, []);

  const sendCommand = useCallback(
    (
      command: CommandKey,
      payload: Record<string, unknown> | undefined,
      pendingMessage: string | undefined,
      silent: boolean,
    ): boolean => {
      if (!silent && pendingMessage) {
        beginPendingToast(command, pendingMessage);
      }

      if (!sendRaw(command, payload)) {
        addLog(`No se pudo enviar ${commandLabel(command)}: WebSocket desconectado`);
        if (!silent) {
          if (pendingMessage) {
            resolvePendingToast(
              command,
              "error",
              `No se pudo enviar ${commandLabel(command)}: backend desconectado`,
            );
          } else {
            notify("error", `No se pudo enviar ${commandLabel(command)}: backend desconectado`);
          }
        }
        return false;
      }

      addLog(`Comando enviado: ${commandLabel(command)}`);
      return true;
    },
    [addLog, beginPendingToast, notify, resolvePendingToast, sendRaw],
  );

  const requestHistory = useCallback(
    (silent: boolean) =>
      sendCommand(
        "history",
        undefined,
        silent ? undefined : "Consultando historial de sesiones...",
        silent,
      ),
    [sendCommand],
  );

  const handlePing = useCallback(() => {
    sendCommand("ping", undefined, "Verificando conectividad serial...", false);
  }, [sendCommand]);

  const handleTemp = useCallback(() => {
    sendCommand("temp", undefined, "Solicitando lectura de temperatura...", false);
  }, [sendCommand]);

  const handleHistory = useCallback(() => {
    requestHistory(false);
  }, [requestHistory]);

  const handleConfigure = useCallback(() => {
    if (statusRef.current === "sweeping") {
      notify("warning", "Deten el sweep actual antes de cambiar la configuracion.");
      return;
    }

    const nextFmin = toNumber(fmin, Number.NaN);
    const nextFmax = toNumber(fmax, Number.NaN);
    const nextNpoints = Math.round(toNumber(npoints, Number.NaN));
    const nextSettle = Math.round(toNumber(settle, Number.NaN));

    if (!Number.isFinite(nextFmin) || nextFmin <= 0) {
      notify("error", "f_min debe ser un numero mayor que 0 Hz.");
      return;
    }
    if (!Number.isFinite(nextFmax) || nextFmax <= nextFmin) {
      notify("error", "f_max debe ser mayor que f_min.");
      return;
    }
    if (!Number.isFinite(nextNpoints) || nextNpoints < 2 || nextNpoints > 500) {
      notify("error", "Puntos debe estar entre 2 y 500.");
      return;
    }
    if (!Number.isFinite(nextSettle) || nextSettle < 1 || nextSettle > 255) {
      notify("error", "Settling debe estar entre 1 y 255.");
      return;
    }

    const snapshot = workflowRef.current;
    const signature = createConfigSignature(
      nextFmin,
      nextFmax,
      nextNpoints,
      nextSettle,
    );

    if (snapshot.configured && snapshot.lastConfigSignature === signature) {
      notify("info", "La configuracion ya estaba aplicada. Se reenviara para confirmar estado.");
    }

    if (snapshot.calibrated && snapshot.lastConfigSignature !== signature) {
      notify(
        "warning",
        "Cambiar configuracion puede invalidar la calibracion actual. Recalibra antes de iniciar sweep.",
      );
    }

    sendCommand(
      "cfg",
      {
        fmin: nextFmin,
        fmax: nextFmax,
        npoints: nextNpoints,
        settle: nextSettle,
      },
      "Aplicando configuracion de sweep...",
      false,
    );
  }, [fmax, fmin, npoints, notify, sendCommand, settle]);

  const handleCalibrate = useCallback(() => {
    if (statusRef.current === "sweeping") {
      notify("warning", "No se puede calibrar durante un sweep activo. Deten el sweep primero.");
      return;
    }

    const resistance = toNumber(calR, Number.NaN);
    if (!Number.isFinite(resistance) || resistance <= 0) {
      notify("error", "R_cal debe ser un numero mayor que 0.");
      return;
    }

    const snapshot = workflowRef.current;

    if (!snapshot.configured) {
      notify(
        "warning",
        "No hay confirmacion de Configurar en esta sesion. Se calibrara con la configuracion activa del dispositivo.",
      );
    }

    if (snapshot.calibrated && !snapshot.configDirtySinceCalibration) {
      if (
        snapshot.lastCalibrationResistance !== null &&
        Math.abs(snapshot.lastCalibrationResistance - resistance) < 1e-9
      ) {
        notify(
          "info",
          "La calibracion ya estaba hecha con ese R_cal. Se vuelve a ejecutar para refrescar.",
        );
      } else {
        notify("info", "Rehaciendo calibracion con un nuevo R_cal.");
      }
    }

    if (snapshot.configDirtySinceCalibration) {
      notify(
        "info",
        "La calibracion previa quedo obsoleta por cambio de configuracion. Se recalibrara ahora.",
      );
    }

    sendCommand(
      "cal",
      { resistance },
      "Ejecutando calibracion...",
      false,
    );
  }, [calR, notify, sendCommand]);

  const handleStartSweep = useCallback(() => {
    if (statusRef.current === "sweeping") {
      notify("info", "Ya hay un sweep en curso.");
      return;
    }

    const snapshot = workflowRef.current;
    if (!snapshot.calibrated) {
      notify("error", "Falta calibrar antes de iniciar sweep.");
      if (!snapshot.configured) {
        notify(
          "warning",
          "Tambien falta confirmar configuracion. Orden recomendado: Configurar -> Calibrar -> Iniciar sweep.",
        );
      }
      return;
    }

    if (snapshot.configDirtySinceCalibration) {
      notify(
        "error",
        "La configuracion cambio despues de calibrar. Repite Calibrar antes de iniciar sweep.",
      );
      return;
    }

    if (!snapshot.configured) {
      notify(
        "warning",
        "No se confirmo Configurar desde esta interfaz. Se usara la configuracion activa del dispositivo.",
      );
    }

    const labelText = expectedLabel === 1 ? "Candida" : "Control";
    sendCommand(
      "start",
      { label: expectedLabel },
      `Iniciando sweep con etiqueta esperada ${labelText}...`,
      false,
    );
  }, [expectedLabel, notify, sendCommand]);

  const handleStopSweep = useCallback(() => {
    if (statusRef.current !== "sweeping") {
      notify("info", "No hay sweep activo para detener.");
      return;
    }
    sendCommand("stop", undefined, "Deteniendo sweep en curso...", false);
  }, [notify, sendCommand]);

  const handleExport = useCallback(() => {
    if (!analysis && !lastExport) {
      notify(
        "warning",
        "No hay sesion reciente en pantalla. Se intentara exportar la ultima sesion cerrada del backend.",
      );
    }
    sendCommand("export", undefined, "Generando rutas de exportacion...", false);
  }, [analysis, lastExport, notify, sendCommand]);

  const handleClearView = useCallback(() => {
    setSweepData([]);
    setAnalysis(null);
    addLog("Vista limpia por usuario");
    notify(
      "info",
      "Vista limpiada. Historial y exportaciones previas siguen disponibles en backend.",
    );
  }, [addLog, notify]);

  useEffect(() => {
    const connect = () => {
      if (wsRef.current) {
        return;
      }

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        addLog("Conectado al backend de adquisicion");
        notify("success", "Conexion WebSocket activa.", "ws-connected");
        requestHistory(true);
      };

      ws.onmessage = (event) => {
        let envelope: {
          type: string;
          payload: Record<string, unknown>;
          ts: string;
        };

        try {
          const parsed = JSON.parse(event.data) as {
            type?: unknown;
            payload?: unknown;
            ts?: unknown;
          };
          envelope = {
            type: String(parsed.type ?? "unknown"),
            payload:
              parsed.payload && typeof parsed.payload === "object"
                ? (parsed.payload as Record<string, unknown>)
                : {},
            ts: String(parsed.ts ?? ""),
          };
        } catch {
          addLog("Mensaje invalido recibido por WebSocket");
          notify("error", "Se recibio un mensaje invalido del backend.");
          return;
        }

        const payload = envelope.payload;
        const type = envelope.type;

        if (type === "pong") {
          addLog(`PONG recibido de ${String(payload.device ?? "equipo")}`);
          resolvePendingToast("ping", "success", "Ping correcto: enlace serial y backend activos.");
          return;
        }

        if (type === "ready") {
          addLog(`Tarjeta lista: ${String(payload.device ?? "desconocido")}`);
          notify(
            "info",
            `Tarjeta lista: ${String(payload.device ?? "BKC32")}`,
            "device-ready",
          );
          return;
        }

        if (type === "cfg" || type === "cfg_ok") {
          const nextFmin = toNumber(payload.fmin, 1000);
          const nextFmax = toNumber(payload.fmax, 100000);
          const nextNpoints = Math.round(toNumber(payload.npoints, 50));
          const nextSettle = Math.round(toNumber(payload.settle, 15));

          setFmin(nextFmin);
          setFmax(nextFmax);
          setNpoints(nextNpoints);
          setSettle(nextSettle);

          const previous = workflowRef.current;
          const nextSignature = createConfigSignature(
            nextFmin,
            nextFmax,
            nextNpoints,
            nextSettle,
          );
          const changed =
            previous.lastConfigSignature !== null &&
            previous.lastConfigSignature !== nextSignature;
          const dirtyBecauseChanged = previous.calibrated && changed;

          setWorkflow({
            configured: true,
            calibrated: previous.calibrated,
            configDirtySinceCalibration:
              previous.configDirtySinceCalibration || dirtyBecauseChanged,
            lastConfigSignature: nextSignature,
            lastCalibrationResistance: previous.lastCalibrationResistance,
          });

          addLog(
            `Configuracion activa ${nextFmin.toFixed(0)}-${nextFmax.toFixed(0)} Hz, ${nextNpoints} puntos`,
          );

          if (pendingToastsRef.current.has("cfg")) {
            resolvePendingToast(
              "cfg",
              "success",
              `Configuracion aplicada: ${nextFmin.toFixed(0)}-${nextFmax.toFixed(0)} Hz, ${nextNpoints} puntos.`,
            );
          }

          if (dirtyBecauseChanged) {
            notify(
              "warning",
              "La configuracion cambio despues de calibrar. Recalibra antes de iniciar sweep.",
              "cfg-needs-cal",
            );
          }
          return;
        }

        if (type === "cal") {
          const gain = toNumber(payload.gain, 0);
          const phase = toNumber(payload.phase, 0);
          const resistance = toNumber(payload.R_cal, 0);
          const previous = workflowRef.current;

          setWorkflow({
            configured: previous.configured,
            calibrated: true,
            configDirtySinceCalibration: false,
            lastConfigSignature: previous.lastConfigSignature,
            lastCalibrationResistance:
              resistance > 0 ? resistance : previous.lastCalibrationResistance,
          });

          addLog(
            `Calibracion OK R=${resistance.toFixed(2)} Ohm, gain=${gain.toExponential(3)}, phase=${phase.toFixed(4)}`,
          );

          if (pendingToastsRef.current.has("cal")) {
            if (previous.configDirtySinceCalibration) {
              resolvePendingToast(
                "cal",
                "success",
                "Calibracion actualizada para la nueva configuracion.",
              );
            } else {
              resolvePendingToast(
                "cal",
                "success",
                `Calibracion completada con R_cal=${resistance.toFixed(0)} Ohm.`,
              );
            }
          } else {
            notify("success", `Calibracion recibida (R_cal=${resistance.toFixed(0)} Ohm).`);
          }
          return;
        }

        if (type === "temp") {
          const temp = toNumber(payload.value, 0);
          setTemperature(temp);
          addLog(`Temperatura ${temp.toFixed(2)} C`);

          if (pendingToastsRef.current.has("temp")) {
            resolvePendingToast(
              "temp",
              "success",
              `Temperatura actual: ${temp.toFixed(2)} C`,
            );
          }
          return;
        }

        if (type === "sweep_start") {
          setSweepData([]);
          setAnalysis(null);
          setStatus("sweeping");
          const label =
            payload.label === 0 || payload.label === "0" ? "control" : "candida";
          addLog(`Sweep iniciado: ${toNumber(payload.points, 0)} puntos, etiqueta ${label}`);

          if (pendingToastsRef.current.has("start")) {
            resolvePendingToast("start", "success", `Sweep iniciado correctamente (${label}).`);
          } else {
            notify("info", `Sweep en curso (${label}).`);
          }
          return;
        }

        if (type === "data") {
          setSweepData((prev) => [
            ...prev,
            {
              i: Math.round(toNumber(payload.i, prev.length)),
              f: toNumber(payload.f, 0),
              Z: toNumber(payload.Z, 0),
              phase: toNumber(payload.phase, 0),
              reZ: toNumber(payload.reZ, 0),
              imZ: toNumber(payload.imZ, 0),
              ts: typeof payload.ts === "string" ? payload.ts : undefined,
            },
          ]);
          return;
        }

        if (type === "sweep_done") {
          setStatus("connected");
          addLog("Sweep completado");
          notify("success", "Sweep finalizado. Procesando analisis...");
          requestHistory(true);
          return;
        }

        if (type === "sweep_stopped" || type === "stopped") {
          setStatus("connected");
          addLog("Sweep detenido");
          if (pendingToastsRef.current.has("stop")) {
            resolvePendingToast("stop", "success", "Sweep detenido correctamente.");
          } else {
            notify("warning", "Sweep detenido.");
          }
          requestHistory(true);
          return;
        }

        if (type === "analysis") {
          const result = payload.result as AnalysisResult;
          setAnalysis(result);
          setLastExport(
            payload.export
              ? {
                  session_id: String(payload.session_id ?? ""),
                  paths: payload.export as ExportResult["paths"],
                }
              : null,
          );

          const qPct = (toNumber(result.quantum_probability, 0) * 100).toFixed(1);
          const cPct = (toNumber(result.classical_probability, 0) * 100).toFixed(1);
          addLog(`Analisis: Q ${qPct}% | C ${cPct}%`);

          const expected = result.expected_label;
          if (expected === 0 || expected === 1) {
            if (result.quantum_match && result.classical_match) {
              notify(
                "success",
                `Analisis listo: Q ${qPct}% y C ${cPct}%. Ambos coinciden con etiqueta esperada ${expected}.`,
              );
            } else if (!result.quantum_match && !result.classical_match) {
              notify(
                "warning",
                `Analisis listo: Q ${qPct}% y C ${cPct}%. Ninguno coincide con etiqueta esperada ${expected}.`,
              );
            } else if (result.quantum_match) {
              notify(
                "warning",
                `Analisis listo: Q ${qPct}% coincide con esperada ${expected}, C ${cPct}% no coincide.`,
              );
            } else {
              notify(
                "warning",
                `Analisis listo: C ${cPct}% coincide con esperada ${expected}, Q ${qPct}% no coincide.`,
              );
            }
          } else {
            notify("success", `Analisis listo: Q ${qPct}% | C ${cPct}%.`);
          }

          if (payload.export) {
            notify("success", "Exportacion automatica generada para la sesion cerrada.");
          }

          requestHistory(true);
          return;
        }

        if (type === "history") {
          const sessions = (payload.sessions as SessionHistoryItem[]) ?? [];
          setHistory(sessions);
          addLog(`Historial actualizado (${sessions.length} sesiones)`);
          if (pendingToastsRef.current.has("history")) {
            resolvePendingToast(
              "history",
              "success",
              `Historial cargado: ${sessions.length} sesiones.`,
            );
          }
          return;
        }

        if (type === "export") {
          setLastExport({
            session_id: String(payload.session_id ?? ""),
            paths: payload.paths as ExportResult["paths"],
          });
          addLog(`Exportacion lista para sesion ${String(payload.session_id ?? "")}`);
          resolvePendingToast(
            "export",
            "success",
            `Exportacion lista para sesion ${String(payload.session_id ?? "")}.`,
          );
          return;
        }

        if (type === "expected_label") {
          addLog(`Etiqueta esperada actualizada a ${toNumber(payload.value, -1)}`);
          return;
        }

        if (type === "error") {
          const code = String(payload.code ?? "");
          const backendMessage = String(payload.message ?? JSON.stringify(payload));
          const pretty = formatBackendError(code, backendMessage);
          addLog(`Error ${code || "BACKEND"}: ${pretty}`);

          const relatedCommand = commandFromErrorCode(code);
          if (relatedCommand) {
            resolvePendingToast(relatedCommand, "error", pretty);
          } else {
            notify("error", pretty);
          }

          if (code === "NOT_CALIBRATED") {
            setWorkflow((prev) => ({
              ...prev,
              calibrated: false,
              configDirtySinceCalibration: false,
              lastCalibrationResistance: null,
            }));
          }

          if (code === "SWEEP_RUNNING") {
            setStatus("sweeping");
          } else {
            setStatus((prev) => (prev === "disconnected" ? "disconnected" : "connected"));
          }
          return;
        }

        addLog(`Evento ${type} recibido`);
      };

      ws.onclose = () => {
        setStatus("disconnected");
        wsRef.current = null;
        failAllPending("Se perdio la conexion mientras habia acciones en curso.");
        addLog("Conexion cerrada, reintentando en 2s");
        notify("warning", "Conexion perdida. Reintentando automaticamente...", "ws-closed");
        reconnectTimerRef.current = window.setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
      wsRef.current = null;
      for (const pendingId of pendingToastsRef.current.values()) {
        toast.dismiss(pendingId);
      }
      pendingToastsRef.current.clear();
    };
  }, [addLog, failAllPending, notify, requestHistory, resolvePendingToast]);

  const statusClass = {
    disconnected: "status-pill status-disconnected",
    connected: "status-pill status-connected",
    sweeping: "status-pill status-sweeping",
    error: "status-pill status-error",
  }[status];

  const progress = useMemo(() => {
    if (npoints <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, (sweepData.length / npoints) * 100));
  }, [npoints, sweepData.length]);

  const bodeMagDataset = useMemo(
    () => ({
      labels: sweepData.map((d) => d.f),
      datasets: [
        {
          label: "|Z| (Ohm)",
          data: sweepData.map((d) => d.Z),
          borderColor: "#0ea5e9",
          backgroundColor: "#0ea5e9",
          pointRadius: 2,
          borderWidth: 2,
        },
      ],
    }),
    [sweepData],
  );

  const bodePhaseDataset = useMemo(
    () => ({
      labels: sweepData.map((d) => d.f),
      datasets: [
        {
          label: "Fase (deg)",
          data: sweepData.map((d) => d.phase),
          borderColor: "#fb7185",
          backgroundColor: "#fb7185",
          pointRadius: 2,
          borderWidth: 2,
        },
      ],
    }),
    [sweepData],
  );

  const nyquistDataset = useMemo(
    () => ({
      datasets: [
        {
          label: "Nyquist",
          data: sweepData.map((d) => ({ x: d.reZ, y: -d.imZ })),
          borderColor: "#22c55e",
          backgroundColor: "#22c55e",
          pointRadius: 3,
          showLine: true,
          borderWidth: 1.5,
        },
      ],
    }),
    [sweepData],
  );

  const lineChartCommon: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        labels: {
          color: "#e2e8f0",
        },
      },
    },
  };

  const scatterChartCommon: ChartOptions<"scatter"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        labels: {
          color: "#e2e8f0",
        },
      },
    },
  };

  const quantumPct = analysis ? (analysis.quantum_probability * 100).toFixed(2) : "0.00";
  const classicalPct = analysis ? (analysis.classical_probability * 100).toFixed(2) : "0.00";

  const workflowHints = useMemo(() => {
    if (!workflow.calibrated) {
      return "Falta calibrar antes de iniciar sweep.";
    }
    if (workflow.configDirtySinceCalibration) {
      return "La configuracion cambio despues de calibrar. Repite calibracion.";
    }
    if (!workflow.configured) {
      return "No se confirmo Configurar en esta sesion. Se usara la config activa del dispositivo.";
    }
    return "Workflow listo: Configuracion y calibracion vigentes.";
  }, [workflow.calibrated, workflow.configDirtySinceCalibration, workflow.configured]);

  return (
    <>
      <ToastContainer
        position="bottom-right"
        autoClose={3200}
        hideProgressBar={false}
        newestOnTop
        closeOnClick
        pauseOnFocusLoss={false}
        pauseOnHover
        draggable
        theme="dark"
      />

      <div className="ambient-shape ambient-shape-a" />
      <div className="ambient-shape ambient-shape-b" />

    <div className="page-grid">
      <div className="app-shell">
        <header className="hero">
          <div>
            <h1>BKC32 Adquisicion EIS</h1>
            <p>
              Adquisicion en tiempo real, visualizacion Bode/Nyquist,
              clasificacion cuantica y exportacion de datos con metadatos.
            </p>
          </div>
          <div className="hero-side">
            <span className={statusClass}>{status}</span>
            <span className="temperature-pill">
              {temperature !== null
                ? `${temperature.toFixed(2)} C`
                : "Sin lectura de temperatura"}
            </span>
          </div>
        </header>

        <div className="workspace-main">
          <section className="panel controls-panel">
            <div className="panel-title-row">
              <h2>Control de adquisicion</h2>
              <div className="progress-group">
                <span>
                  {sweepData.length} / {npoints} puntos
                </span>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
              </div>
            </div>

            <p className="muted-text">{workflowHints}</p>

            <div className="controls-grid">
              <Field label="f_min (Hz)" value={fmin} onChange={setFmin} />
              <Field label="f_max (Hz)" value={fmax} onChange={setFmax} />
              <Field label="Puntos" value={npoints} onChange={setNpoints} />
              <Field label="Settling" value={settle} onChange={setSettle} />
              <Field label="R_cal (Ohm)" value={calR} onChange={setCalR} />

              <div className="field">
                <label>Etiqueta esperada</label>
                <select
                  value={expectedLabel}
                  onChange={(e) => {
                    const next = Number(e.target.value) as 0 | 1;
                    setExpectedLabel(next);
                    notify(
                      "info",
                      `Etiqueta esperada seleccionada: ${next === 1 ? "Candida (1)" : "Control (0)"}`,
                    );
                  }}
                >
                  <option value={1}>Candida (1)</option>
                  <option value={0}>Control (0)</option>
                </select>
              </div>
            </div>

            <div className="actions-row">
              <button className="btn btn-primary" onClick={handleConfigure}>
                Configurar
              </button>
              <button className="btn btn-secondary" onClick={handleCalibrate}>
                Calibrar
              </button>
              <button
                className="btn btn-start"
                disabled={status === "sweeping"}
                onClick={handleStartSweep}
              >
                Iniciar sweep
              </button>
              <button
                className="btn btn-stop"
                disabled={status !== "sweeping"}
                onClick={handleStopSweep}
              >
                Detener
              </button>
              <button className="btn btn-neutral" onClick={handlePing}>
                Ping
              </button>
              <button className="btn btn-neutral" onClick={handleTemp}>
                Temp
              </button>
              <button className="btn btn-neutral" onClick={handleHistory}>
                Historial
              </button>
              <button className="btn btn-neutral" onClick={handleExport}>
                Exportar ultimo
              </button>
              <button className="btn btn-neutral" onClick={handleClearView}>
                Limpiar vista
              </button>
            </div>
          </section>

          <section className="panel metrics-panel">
            <h2>Clasificador cuantico vs clasico</h2>
            <div className="metric-cards">
              <article className="metric-card">
                <h3>Cuantico</h3>
                <p className="metric-value">{quantumPct}%</p>
                <p className="metric-note">
                  Label: {analysis ? analysis.quantum_label : "-"} | Score: {analysis ? analysis.quantum_score.toFixed(3) : "-"}
                </p>
              </article>
              <article className="metric-card">
                <h3>Clasico</h3>
                <p className="metric-value">{classicalPct}%</p>
                <p className="metric-note">Label: {analysis ? analysis.classical_label : "-"}</p>
              </article>
              <article className="metric-card">
                <h3>Comparacion</h3>
                <p className="metric-value">
                  {analysis ? (analysis.agreement ? "Coinciden" : "No coinciden") : "Sin datos"}
                </p>
                <p className="metric-note">
                  Match esperado: quantum {String(analysis?.quantum_match ?? "-")} | clasico {String(analysis?.classical_match ?? "-")}
                </p>
              </article>
            </div>

            <div className="feature-grid">
              {analysis
                ? Object.entries(analysis.features).map(([key, value]) => (
                    <div key={key} className="feature-item">
                      <span>{key}</span>
                      <strong>{value.toFixed(4)}</strong>
                    </div>
                  ))
                : [
                    "mag_mean_norm",
                    "mag_slope_norm",
                    "im_energy_norm",
                    "phase_span_norm",
                  ].map((key) => (
                    <div key={key} className="feature-item muted">
                      <span>{key}</span>
                      <strong>-</strong>
                    </div>
                  ))}
            </div>
          </section>

          <section className="charts-grid">
            <article className="panel chart-card">
              <h2>Bode magnitud</h2>
              <div className="chart-wrap">
                <Line
                  data={bodeMagDataset}
                  options={{
                    ...lineChartCommon,
                    scales: {
                      x: {
                        type: "logarithmic",
                        title: { display: true, text: "Frecuencia (Hz)", color: "#cbd5e1" },
                        ticks: { color: "#94a3b8" },
                        grid: { color: "rgba(148, 163, 184, 0.15)" },
                      },
                      y: {
                        title: { display: true, text: "|Z| (Ohm)", color: "#cbd5e1" },
                        ticks: { color: "#94a3b8" },
                        grid: { color: "rgba(148, 163, 184, 0.15)" },
                      },
                    },
                  }}
                />
              </div>
            </article>

            <article className="panel chart-card">
              <h2>Bode fase</h2>
              <div className="chart-wrap">
                <Line
                  data={bodePhaseDataset}
                  options={{
                    ...lineChartCommon,
                    scales: {
                      x: {
                        type: "logarithmic",
                        title: { display: true, text: "Frecuencia (Hz)", color: "#cbd5e1" },
                        ticks: { color: "#94a3b8" },
                        grid: { color: "rgba(148, 163, 184, 0.15)" },
                      },
                      y: {
                        title: { display: true, text: "Fase (deg)", color: "#cbd5e1" },
                        ticks: { color: "#94a3b8" },
                        grid: { color: "rgba(148, 163, 184, 0.15)" },
                      },
                    },
                  }}
                />
              </div>
            </article>

            <article className="panel chart-card chart-wide">
              <h2>Nyquist</h2>
              <div className="chart-wrap">
                <Scatter
                  data={nyquistDataset}
                  options={{
                    ...scatterChartCommon,
                    scales: {
                      x: {
                        title: { display: true, text: "Re(Z) (Ohm)", color: "#cbd5e1" },
                        ticks: { color: "#94a3b8" },
                        grid: { color: "rgba(148, 163, 184, 0.15)" },
                      },
                      y: {
                        title: { display: true, text: "-Im(Z) (Ohm)", color: "#cbd5e1" },
                        ticks: { color: "#94a3b8" },
                        grid: { color: "rgba(148, 163, 184, 0.15)" },
                      },
                    },
                  }}
                />
              </div>
            </article>
          </section>

          <section className="panel export-panel">
            <h2>Exportacion y metadatos</h2>
            {lastExport ? (
              <div className="export-grid">
                <PathItem label="Sesion" path={lastExport.session_id} />
                <PathItem label="Directorio" path={lastExport.paths.dir} />
                <PathItem label="CSV" path={lastExport.paths.csv} />
                <PathItem label="Metadata" path={lastExport.paths.metadata} />
                <PathItem label="Resumen" path={lastExport.paths.summary} />
                <PathItem label="Bundle JSON" path={lastExport.paths.bundle} />
              </div>
            ) : (
              <p className="muted-text">Aun no existe exportacion.</p>
            )}
          </section>
        </div>
      </div>

      <aside className="workspace-side">
        <section className="panel history-panel history-panel-compact">
          <h2>Historial de adquisiciones</h2>
          {history.length === 0 ? (
            <p className="muted-text">No hay sesiones registradas.</p>
          ) : (
            <div className="history-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Sesion</th>
                    <th>Pts</th>
                    <th>Stop</th>
                    <th>Q</th>
                    <th>C</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.session_id}>
                      <td>{entry.session_id}</td>
                      <td>{entry.point_count}</td>
                      <td>{entry.stop_reason}</td>
                      <td>
                        {entry.analysis
                          ? `${(entry.analysis.quantum_probability * 100).toFixed(1)}%`
                          : "-"}
                      </td>
                      <td>
                        {entry.analysis
                          ? `${(entry.analysis.classical_probability * 100).toFixed(1)}%`
                          : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel log-panel log-panel-compact">
          <h2>Log de eventos</h2>
          <div className="log-view">
            {log.map((item, index) => (
              <div key={`${item}-${index}`}>{item}</div>
            ))}
          </div>
        </section>
      </aside>
    </div>
    </>
  );
};

const Field = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) => (
  <div className="field">
    <label>{label}</label>
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  </div>
);

const PathItem = ({ label, path }: { label: string; path: string }) => (
  <div className="path-item">
    <span>{label}</span>
    <code>{path}</code>
  </div>
);

export default App;
