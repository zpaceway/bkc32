# BKC32 - Sistema EIS con ESP32/AD5933 (Modo Simulado)

Proyecto de adquisicion y analisis de espectroscopia de impedancia electroquimica (EIS) para cuantificacion de *Candida albicans*.

En esta version se habilita un flujo completo para las fases 3 y 4 sin hardware fisico:
- tarjeta de adquisicion simulada con puerto serial virtual,
- backend Python asincrono con persistencia y clasificacion,
- frontend React para visualizacion en tiempo real,
- exportacion de datos y metadatos por sesion.

## Arquitectura

```
┌─────────────────────────────┐
│ Tarjeta simulada ESP32/AD5933 │
│ src/sim_board.py            │
│ JSON serial @ /tmp/bkc32-sim-serial
└───────────────┬─────────────┘
                │
┌───────────────▼─────────────┐
│ Backend Python              │
│ src/collector.py            │
│ src/coordinator.py          │
│ server.py                   │
└───────────────┬─────────────┘
                │ WebSocket
┌───────────────▼─────────────┐
│ Frontend React              │
│ webapp/src/App.tsx          │
│ Bode, Nyquist, clasificacion│
└─────────────────────────────┘
```

## Componentes clave

- `src/sim_board.py`: emula comandos `PING`, `CFG`, `CAL`, `START`, `STOP`, `TEMP`.
- `src/collector.py`: gestiona serial, sesiones, exportacion y clasificacion.
- `src/classifier.py`: clasificador cuantico simulado por circuito de 4 qubits + comparador clasico.
- `src/coordinator.py`: puente WebSocket entre UI y colector.
- `webapp/src/App.tsx`: panel de control, graficos en vivo, historial y exportacion.

## Comandos principales

Instalacion:

```bash
make install
```

Ejecutar tarjeta simulada (terminal 1):

```bash
make sim-board
```

Ejecutar backend conectado a serial simulado (terminal 2):

```bash
make server-sim
```

Ejecutar frontend (terminal 3):

```bash
make webapp
```

Abrir http://localhost:5173

## Flujo de prueba recomendado

1. `Ping` para verificar enlace.
2. `Configure` para fijar rango y numero de puntos.
3. `Calibrate` con `R_cal`.
4. Elegir etiqueta esperada (`Candida` o `Control`).
5. `Start Sweep`.
6. Revisar Bode/Nyquist + probabilidad cuantica/clasica.
7. `Exportar ultimo` para obtener rutas de `CSV`, `metadata`, `summary` y `bundle`.

## Exportacion por sesion

Cada sesion genera directorio en `data/acquisitions/<session_id>/` con:

- `<session_id>_data.csv`
- `<session_id>_metadata.json`
- `<session_id>_summary.txt`
- `<session_id>_bundle.json`

## Variables de entorno

Definidas en `.env.example`:

- `SERIAL_PORT`
- `BAUDRATE`
- `SERVER_HOST`
- `SERVER_PORT`
- `SERIAL_TIMEOUT`
- `SERIAL_RETRY_SECONDS`
- `DATA_DIR`

Para modo simulado no hace falta editar `.env`; `make server-sim` ya usa `/tmp/bkc32-sim-serial`.

## Reportes

Los entregables latex estan en:

- `documents/deliveries/phase.1`
- `documents/deliveries/phase.2`
- `documents/deliveries/phase.3`
- `documents/deliveries/phase.4`

Compilar todos:

```bash
make docs
```
