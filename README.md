# BKC32 - Sistema EIS para Candida albicans

Sistema de adquisicion, visualizacion, exportacion y analisis de espectroscopia de impedancia electroquimica (EIS) para cuantificacion de *Candida albicans* en muestras de saliva.

El reto original planteaba una solucion en LabVIEW con ESP32 + EVAL-AD5940ELCZ. Tras la primera reunion de seguimiento se acordo migrar el desarrollo a una arquitectura abierta en Python + React, manteniendo el contrato funcional del sistema embebido. La validacion final se realiza en modo simulado por indisponibilidad temporal del hardware fisico, usando una tarjeta virtual compatible con el protocolo serial definido.

## Estado final

- Backend Python asincrono para comunicacion serial, sesiones, exportacion y clasificacion.
- Tarjeta simulada ESP32/AD5933 con puerto serial virtual y modelo de Randles para Control/Candida.
- Frontend React con visualizacion en tiempo real de Bode magnitud, Bode fase y Nyquist.
- Clasificador cuantico variacional simulado de 4 qubits y comparador clasico logistico.
- Trazabilidad por sesion con `sample_id`, `assay_type`, etiqueta esperada, temperatura, calibracion y metadatos.
- Exportacion por sesion en CSV, metadata JSON, summary TXT y bundle JSON.
- Entregables documentales completos por fases en `documents/deliveries/`.

## Arquitectura

```
┌──────────────────────────────┐
│ Tarjeta simulada ESP32/AD5933│
│ src/sim_board.py             │
│ JSON serial @ /tmp/bkc32-sim-serial
└───────────────┬──────────────┘
                │ USB/Serial
┌───────────────▼──────────────┐
│ Backend Python               │
│ src/collector.py             │
│ src/coordinator.py           │
│ server.py                    │
└───────────────┬──────────────┘
                │ WebSocket
┌───────────────▼──────────────┐
│ Frontend React               │
│ webapp/src/App.tsx           │
│ Bode, Nyquist, clasificacion │
└──────────────────────────────┘
```

## Componentes clave

- `src/sim_board.py`: emula comandos `PING`, `CFG`, `CAL`, `START`, `STOP`, `TEMP` y genera espectros EIS simulados.
- `src/collector.py`: gestiona serial, sesiones, metadatos, exportacion, historial y clasificacion.
- `src/coordinator.py`: puente WebSocket entre la UI y el collector.
- `src/classifier.py`: clasificador cuantico simulado y comparador clasico.
- `webapp/src/App.tsx`: panel de control, graficos en vivo, historial y exportacion.

## Requisitos

- Python 3.14 o superior.
- `uv` para dependencias Python.
- Node.js 20 o superior.
- npm 10 o superior.

## Instalacion

```bash
make install
```

## Ejecucion en modo simulado

Terminal 1:

```bash
make sim-board
```

Terminal 2:

```bash
make server-sim
```

Terminal 3:

```bash
make webapp
```

Abrir `http://localhost:5173`.

## Flujo de prueba recomendado

1. Ejecutar `Ping` para verificar enlace.
2. Ajustar `f_min`, `f_max`, `Puntos`, `Settling` y `R_cal`.
3. Indicar `ID de muestra` y `Tipo de ensayo` (`Control`, `Sham` o `EM DC`).
4. Elegir etiqueta esperada (`Control` o `Candida`).
5. Ejecutar `Configurar`.
6. Ejecutar `Calibrar`.
7. Ejecutar `Iniciar sweep`.
8. Revisar Bode/Nyquist y probabilidades cuantica/clasica.
9. Ejecutar `Exportar ultimo` para obtener rutas de artefactos.
10. Consultar `Historial` para verificar sesiones persistidas.

## Exportacion por sesion

Cada sesion genera un directorio en `data/acquisitions/<session_id>/` con:

- `<session_id>_data.csv`: puntos EIS (`i`, `f`, `Z`, `phase`, `reZ`, `imZ`, `ts`).
- `<session_id>_metadata.json`: configuracion, calibracion, temperatura, `sample_id`, `assay_type`, etiqueta esperada, eventos y analisis.
- `<session_id>_summary.txt`: resumen textual compacto.
- `<session_id>_bundle.json`: paquete completo con metadatos, puntos y eventos.

`data/` esta ignorado por Git porque contiene adquisiciones generadas en ejecucion.

## Variables de entorno

Definidas en `.env.example`:

- `SERIAL_PORT`
- `BAUDRATE`
- `SERVER_HOST`
- `SERVER_PORT`
- `SERIAL_TIMEOUT`
- `SERIAL_RETRY_SECONDS`
- `DATA_DIR`

Para modo simulado no hace falta editar `.env`; `make server-sim` usa `/tmp/bkc32-sim-serial`.

## Entregables

- `documents/deliveries/phase.1/fase1_requerimientos.pdf`: requerimientos y diagrama de bloques.
- `documents/deliveries/phase.2/fase2_comunicacion.pdf`: protocolo Python-ESP32 y pruebas de comunicacion.
- `documents/deliveries/phase.3/fase3_adquisicion_visualizacion.pdf`: UI, adquisicion y graficas en tiempo real.
- `documents/deliveries/phase.4/fase4_registro_exportacion.pdf`: logging, metadatos, exportacion y trazabilidad.
- `documents/deliveries/phase.5/fase5_reporte_tecnico_manual_memoria.pdf`: memoria final y reporte tecnico.
- `documents/deliveries/phase.5/fase5_manual_usuario.pdf`: manual de usuario.
- `documents/deliveries/phase.5/fase5_cronograma.pdf`: cronograma de trabajo.

Compilar documentos:

```bash
make docs
```

## Verificacion rapida

```bash
python -m py_compile src/classifier.py src/collector.py src/coordinator.py src/sim_board.py server.py
cd webapp && npm run build
```
