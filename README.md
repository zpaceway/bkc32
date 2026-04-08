# BKC32 — EIS Impedance Measurement System

Electrochemical Impedance Spectroscopy (EIS) system for **Candida albicans** detection in saliva samples. Built with ESP32 + AD5933 hardware, a Python async backend, and a React web interface.

## Architecture

```
┌─────────────────────┐
│  Electrochemical    │
│  Cell (4 electrodes)│
│  1 mL saliva sample │
└────────┬────────────┘
         │ Impedance
┌────────▼────────────┐
│  AD5933             │
│  Impedance Analyzer │
│  I²C @ 0x0D        │
└────────┬────────────┘
         │ I²C (SDA=GPIO21, SCL=GPIO22)
┌────────▼────────────┐
│  ESP32 DevKit V1    │
│  Firmware (Arduino) │
│  JSON serial @ 115200 baud
└────────┬────────────┘
         │ USB Serial
┌────────▼────────────┐
│  Python Backend     │
│  collector.py       │──── pyserial (serial ↔ JSON)
│  coordinator.py     │──── websockets (async server)
│  server.py          │──── asyncio event loop
└────────┬────────────┘
         │ WebSocket ws://localhost:8765
┌────────▼────────────┐
│  React Web App      │
│  Bode & Nyquist     │
│  Real-time plots    │
└─────────────────────┘
```

## Hardware Connections

| ESP32 Pin | AD5933 Pin | Function          |
| --------- | ---------- | ----------------- |
| GPIO 21   | SDA        | I²C Data          |
| GPIO 22   | SCL        | I²C Clock         |
| 3.3V      | VDD        | Power             |
| GND       | GND        | Ground            |
| —         | VOUT       | Excitation → Cell |
| —         | VIN        | Response ← Cell   |

A **10 kΩ calibration resistor** connects between VOUT and VIN for system calibration before measurements.

## Serial Protocol

The ESP32 accepts text commands (terminated by `\n`) and responds with JSON:

| Command | Format                            | Description                                                               |
| ------- | --------------------------------- | ------------------------------------------------------------------------- |
| `PING`  | `PING`                            | Check connection → `{"type":"pong","device":"BKC32-EIS","version":"1.0"}` |
| `CFG`   | `CFG` or `CFG:fmin,fmax,n,settle` | Get/set sweep config                                                      |
| `CAL`   | `CAL` or `CAL:R`                  | Calibrate with known resistance (Ω)                                       |
| `START` | `START` or `SWEEP`                | Run frequency sweep                                                       |
| `STOP`  | `STOP`                            | Abort running sweep                                                       |
| `TEMP`  | `TEMP`                            | Read AD5933 temperature                                                   |

### Data Frame (per frequency point)

```json
{
  "type": "data",
  "i": 0,
  "f": 1000.0,
  "Z": 9876.54,
  "phase": -5.12,
  "reZ": 9835.12,
  "imZ": -882.45
}
```

| Field   | Description                   |
| ------- | ----------------------------- |
| `f`     | Frequency (Hz)                |
| `Z`     | Impedance magnitude \|Z\| (Ω) |
| `phase` | Phase angle (degrees)         |
| `reZ`   | Real part Re(Z) (Ω)           |
| `imZ`   | Imaginary part Im(Z) (Ω)      |

## Project Structure

```
bkc32/
├── arduino/bkc32/
│   └── bkc32.ino            # ESP32 + AD5933 firmware
├── src/
│   ├── collector.py          # Serial communication with ESP32
│   ├── coordinator.py        # WebSocket server (relays data to web clients)
│   ├── settings.py           # Environment configuration
│   └── utls.py               # Logger and env utilities
├── server.py                 # Entry point — runs collector + WebSocket server
├── webapp/
│   ├── src/
│   │   ├── App.tsx           # EIS dashboard (controls + Bode/Nyquist plots)
│   │   ├── main.tsx          # React entry point
│   │   └── index.css         # Tailwind CSS
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── documents/
│   ├── deliveries/
│   │   ├── phase.1/          # Phase 1: Requirements + block diagram
│   │   └── phase.2/          # Phase 2: Communication protocol + quantum classification
│   ├── template/             # UNIR LaTeX template (do not modify)
│   ├── intiail.pdf           # Original challenge specification
│   └── notes.txt             # Phase descriptions
├── Makefile
├── pyproject.toml
└── .env.example
```

## Prerequisites

- **Python** ≥ 3.14 + [uv](https://docs.astral.sh/uv/)
- **Node.js** ≥ 18
- **Arduino IDE** or **PlatformIO** (for ESP32 firmware upload)
- **pdflatex** (optional, for rebuilding reports)
- ESP32 DevKit V1 + AD5933 evaluation board

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url> && cd bkc32
cp .env.example .env          # edit SERIAL_PORT if needed
make install                  # installs Python + Node dependencies
```

### 2. Flash the ESP32

Open `arduino/bkc32/bkc32.ino` in Arduino IDE, select **ESP32 Dev Module**, and upload.

### 3. Run the backend

```bash
make server
```

### 4. Run the web UI

```bash
make webapp
```

Open http://localhost:5173 in your browser.

### 5. Measurement workflow

1. Click **Ping** to verify the ESP32 connection
2. Set frequency range (f_min, f_max), number of points, and settling cycles → **Configure**
3. Connect the **calibration resistor** (10 kΩ) → **Calibrate**
4. Replace resistor with the **electrochemical cell** containing the saliva sample
5. Click **Start Sweep** — observe Bode magnitude, Bode phase, and Nyquist plots in real time
6. Export data for quantum/classical classification analysis

## Web Interface

The dashboard provides:

- **Controls**: f_min, f_max, points, settle time, calibration resistance
- **Actions**: Configure, Calibrate, Start Sweep, Stop, Ping, Temp, Clear
- **Bode Magnitude**: |Z| vs frequency
- **Bode Phase**: φ vs frequency
- **Nyquist Plot**: -Im(Z) vs Re(Z)
- **Status indicator**: disconnected / connected / sweeping / error
- **Temperature display** from the AD5933 sensor
- **Event log** with timestamped messages

## Quantum Classification (VQC)

As part of the Quantum Computing Master's program, this project includes a **Variational Quantum Classifier (VQC)** implemented with [PennyLane](https://pennylane.ai/) to classify EIS spectra (Candida present vs. control).

**Pipeline**: EIS data → normalize → PCA (4 features) → angle encoding (R_Y) → variational circuit (R_Y, R_Z, CNOT layers) → measurement → binary classification

**Classical comparison**: SVM (RBF kernel) and Random Forest, evaluated with accuracy, precision, recall, and AUC-ROC.

See the Phase 2 report for the full algorithm description and code example.

## Building Reports

```bash
make docs                     # builds Phase 1 and Phase 2 PDFs
make clean                    # removes LaTeX build artifacts
```

## Environment Variables

| Variable      | Default        | Description           |
| ------------- | -------------- | --------------------- |
| `SERIAL_PORT` | `/dev/ttyUSB0` | ESP32 serial port     |
| `BAUDRATE`    | `115200`       | Serial baud rate      |
| `SERVER_HOST` | `localhost`    | WebSocket server host |
| `SERVER_PORT` | `8765`         | WebSocket server port |

## License

Academic project — Universidad Internacional de la Rioja (UNIR), Master in Quantum Computing.
