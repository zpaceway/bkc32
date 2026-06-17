# BKC32 Webapp

Frontend React + TypeScript + Vite para el sistema EIS BKC32.

La aplicacion se conecta al backend WebSocket en `ws://localhost:8765` y permite:

- configurar barridos EIS (`f_min`, `f_max`, puntos, settling y `R_cal`),
- registrar `ID de muestra` y `Tipo de ensayo` (`Control`, `Sham`, `EM DC`),
- ejecutar calibracion y barridos en tiempo real,
- visualizar Bode magnitud, Bode fase y Nyquist,
- comparar clasificador cuantico vs clasico,
- consultar historial y exportaciones por sesion.

## Desarrollo

Desde la raiz del proyecto:

```bash
make webapp
```

O dentro de `webapp/`:

```bash
npm install
npm run dev
```

Abrir `http://localhost:5173`.

## Build

```bash
npm run build
```

## Notas

El flujo completo requiere que el backend este activo. Para validacion sin hardware, iniciar tambien `make sim-board` y `make server-sim` desde la raiz del repositorio.
