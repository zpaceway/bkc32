import { useEffect, useRef, useState, useCallback } from "react";
import { Line, Scatter } from "react-chartjs-2";
import {
  Chart as ChartJS,
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

interface EISDataPoint {
  i: number;
  f: number;
  Z: number;
  phase: number;
  reZ: number;
  imZ: number;
}

type Status = "disconnected" | "connected" | "sweeping" | "error";

const App = () => {
  const [fmin, setFmin] = useState(1000);
  const [fmax, setFmax] = useState(100000);
  const [npoints, setNpoints] = useState(50);
  const [settle, setSettle] = useState(15);
  const [calR, setCalR] = useState(10000);
  const [status, setStatus] = useState<Status>("disconnected");
  const [temperature, setTemperature] = useState<number | null>(null);
  const [sweepData, setSweepData] = useState<EISDataPoint[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const addLog = useCallback((msg: string) => {
    setLog((prev) => [...prev.slice(-99), msg]);
  }, []);

  const send = useCallback(
    (type: string, payload?: Record<string, unknown>) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type, payload }));
    },
    [],
  );

  useEffect(() => {
    const connect = () => {
      if (wsRef.current) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        addLog("Connected to backend");
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        const p = msg.payload;
        const type = msg.type;

        if (type === "pong") {
          addLog(`PONG: ${p.device} v${p.version}`);
        } else if (type === "ready") {
          addLog(`Device ready: ${p.device} v${p.version}`);
        } else if (type === "cfg" || type === "cfg_ok") {
          setFmin(p.fmin);
          setFmax(p.fmax);
          setNpoints(p.npoints);
          setSettle(p.settle);
          addLog(`Config: ${p.fmin}-${p.fmax} Hz, ${p.npoints} pts`);
        } else if (type === "cal") {
          addLog(`Calibrated: gain=${p.gain}, phase=${p.phase}, R=${p.R_cal}Ω`);
        } else if (type === "temp") {
          setTemperature(p.value);
          addLog(`Temperature: ${p.value}°C`);
        } else if (type === "sweep_start") {
          setSweepData([]);
          setStatus("sweeping");
          addLog(`Sweep started: ${p.points} points`);
        } else if (type === "data") {
          setSweepData((prev) => [
            ...prev,
            {
              i: p.i,
              f: p.f,
              Z: p.Z,
              phase: p.phase,
              reZ: p.reZ,
              imZ: p.imZ,
            },
          ]);
        } else if (type === "sweep_done") {
          setStatus("connected");
          addLog("Sweep complete");
        } else if (type === "sweep_stopped") {
          setStatus("connected");
          addLog("Sweep stopped by user");
        } else if (type === "error") {
          addLog(`Error: ${JSON.stringify(p)}`);
          setStatus("error");
        }
      };

      ws.onclose = () => {
        setStatus("disconnected");
        wsRef.current = null;
        addLog("Disconnected, reconnecting...");
        setTimeout(connect, 2000);
      };

      ws.onerror = () => ws.close();
    };

    connect();
  }, [addLog]);

  const statusColor = {
    disconnected: "bg-red-500",
    connected: "bg-green-500",
    sweeping: "bg-yellow-500",
    error: "bg-red-400",
  }[status];

  const btn =
    "cursor-pointer rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold">BKC32 — EIS Impedance Analyzer</h1>
        <span
          className={`${statusColor} rounded-full px-2 py-0.5 text-xs text-white`}
        >
          {status}
        </span>
        {temperature !== null && (
          <span className="text-xs text-zinc-500">{temperature}°C</span>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="f_min (Hz)" value={fmin} onChange={setFmin} />
        <Field label="f_max (Hz)" value={fmax} onChange={setFmax} />
        <Field label="Points" value={npoints} onChange={setNpoints} />
        <Field label="Settle" value={settle} onChange={setSettle} />
        <button
          className={`${btn} bg-blue-600`}
          onClick={() => send("cfg", { fmin, fmax, npoints, settle })}
        >
          Configure
        </button>
        <Field label="R_cal (Ω)" value={calR} onChange={setCalR} />
        <button
          className={`${btn} bg-orange-500`}
          onClick={() => send("cal", { resistance: calR })}
        >
          Calibrate
        </button>
        <button
          className={`${btn} bg-green-600`}
          disabled={status === "sweeping"}
          onClick={() => send("start")}
        >
          Start Sweep
        </button>
        <button
          className={`${btn} bg-red-500`}
          disabled={status !== "sweeping"}
          onClick={() => send("stop")}
        >
          Stop
        </button>
        <button className={`${btn} bg-zinc-500`} onClick={() => send("ping")}>
          Ping
        </button>
        <button className={`${btn} bg-zinc-500`} onClick={() => send("temp")}>
          Temp
        </button>
        <button
          className={`${btn} bg-zinc-400`}
          onClick={() => setSweepData([])}
        >
          Clear
        </button>
      </div>

      {/* Charts */}
      {sweepData.length > 0 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Bode Magnitude */}
          <div className="rounded border border-zinc-200 p-4">
            <Line
              data={{
                labels: sweepData.map((d) => d.f.toFixed(0)),
                datasets: [
                  {
                    label: "|Z| (Ω)",
                    data: sweepData.map((d) => d.Z),
                    borderColor: "rgb(59,130,246)",
                    pointRadius: 2,
                  },
                ],
              }}
              options={{
                animation: false,
                plugins: { title: { display: true, text: "Bode — |Z| vs f" } },
                scales: {
                  x: { title: { display: true, text: "Frequency (Hz)" } },
                  y: { title: { display: true, text: "|Z| (Ω)" } },
                },
              }}
            />
          </div>

          {/* Bode Phase */}
          <div className="rounded border border-zinc-200 p-4">
            <Line
              data={{
                labels: sweepData.map((d) => d.f.toFixed(0)),
                datasets: [
                  {
                    label: "Phase (°)",
                    data: sweepData.map((d) => d.phase),
                    borderColor: "rgb(239,68,68)",
                    pointRadius: 2,
                  },
                ],
              }}
              options={{
                animation: false,
                plugins: {
                  title: { display: true, text: "Bode — Phase vs f" },
                },
                scales: {
                  x: { title: { display: true, text: "Frequency (Hz)" } },
                  y: { title: { display: true, text: "Phase (°)" } },
                },
              }}
            />
          </div>

          {/* Nyquist */}
          <div className="rounded border border-zinc-200 p-4 lg:col-span-2">
            <Scatter
              data={{
                datasets: [
                  {
                    label: "Nyquist",
                    data: sweepData.map((d) => ({ x: d.reZ, y: -d.imZ })),
                    borderColor: "rgb(16,185,129)",
                    backgroundColor: "rgb(16,185,129)",
                    pointRadius: 3,
                    showLine: true,
                  },
                ],
              }}
              options={{
                animation: false,
                plugins: {
                  title: { display: true, text: "Nyquist — -Im(Z) vs Re(Z)" },
                },
                scales: {
                  x: { title: { display: true, text: "Re(Z) (Ω)" } },
                  y: { title: { display: true, text: "-Im(Z) (Ω)" } },
                },
              }}
            />
          </div>
        </div>
      )}

      {/* Log */}
      <div className="rounded border border-zinc-200 p-3">
        <h2 className="mb-1 text-sm font-semibold text-zinc-500">Log</h2>
        <div className="h-32 overflow-y-auto font-mono text-xs text-zinc-600">
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>
    </div>
  );
};

const Field = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) => (
  <div className="flex flex-col">
    <label className="text-xs text-zinc-500">{label}</label>
    <input
      className="w-28 rounded border border-zinc-300 px-2 py-1 text-sm"
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  </div>
);

export default App;
