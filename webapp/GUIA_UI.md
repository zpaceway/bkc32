# BKC32 - Guia de la interfaz de adquisicion EIS

## Parametros de configuracion

### f_min (Hz)

Frecuencia minima del barrido. El AD5933 genera una excitacion senoidal que inicia en esta frecuencia. Para detectar fenomenos electroquimicos de baja frecuencia (como difusion de Warburg) se usan valores de decenas o cientos de Hz. Para un rango tipico de biodecteccion se parte de 1 kHz.

### f_max (Hz)

Frecuencia maxima del barrido. Define el extremo superior de la ventana espectral. Frecuencias altas (100 kHz) capturan la respuesta resistiva de la solucion (R_s). La combinacion f_min/f_max determina la resolucion del espectro de impedancia.

### Puntos

Cantidad de frecuencias equiespaciadas en escala logaritmica entre f_min y f_max. Mas puntos producen un espectro mas detallado a costa de mayor tiempo de adquisicion. Valores tipicos: 30-100.

### Settling

Numero de ciclos de asentamiento que el AD5933 espera antes de medir en cada punto de frecuencia. Valores mas altos permiten que la senal se estabilice (util para impedancias grandes o capacitivas), pero aumentan la duracion del barrido. Rango valido: 1-255.

### R_cal (Ohm)

Resistencia de calibracion conocida. Se conecta fisicamente entre los terminales del sensor y se usa para calcular el factor de ganancia (gain) y el desfase de referencia (phase) del sistema. El AD5933 necesita esta referencia para convertir sus registros internos de magnitud/fase en valores reales de impedancia. Un valor tipico es 10 kOhm, pero debe elegirse cercano a la impedancia esperada de la muestra.

### Etiqueta esperada

Clasificacion esperada de la muestra que se va a medir. Las opciones son:

- **Control (0)**: muestra sin presencia del analito (linea base).
- **Candida (1)**: muestra con presencia de Candida albicans.

Esta etiqueta se adjunta a la sesion de medicion y se compara con la prediccion del clasificador para evaluar su rendimiento. No afecta la adquisicion, solo el analisis posterior.

---

## Botones de accion

### Configurar

Envia los parametros f_min, f_max, puntos y settling al dispositivo. El dispositivo confirma la configuracion activa. Si se cambia la configuracion despues de calibrar, la calibracion queda invalidada y debe repetirse.

### Calibrar

Ejecuta la calibracion del AD5933 con la resistencia R_cal indicada. El dispositivo mide la impedancia de la resistencia conocida y calcula:

- **Gain**: factor de transimpedancia que convierte las cuentas internas del AD5933 a Ohms reales.
- **Phase**: desfase de referencia del hardware, que se resta de cada medicion posterior para obtener la fase real.

Debe ejecutarse despues de configurar y antes de iniciar un barrido.

### Iniciar sweep

Lanza un barrido completo de impedancia. El dispositivo recorre todas las frecuencias configuradas, midiendo magnitud y fase en cada punto. Los datos llegan en tiempo real y se grafican conforme se reciben. Requiere calibracion vigente.

### Detener

Aborta un barrido en curso. Los puntos adquiridos hasta ese momento se conservan y la sesion se cierra con razon de parada "stopped".

### Ping

Verifica la conectividad serial entre el backend y el dispositivo. Si la tarjeta responde, confirma que el enlace fisico esta activo.

### Temp

Solicita una lectura de temperatura del sensor integrado en la tarjeta. El AD5933 incluye un sensor de temperatura interno que reporta la temperatura ambiente del circuito.

### Historial

Consulta todas las sesiones de adquisicion almacenadas en el backend, mostrando para cada una el numero de puntos, la razon de parada y los resultados del clasificador si estan disponibles.

### Exportar ultimo

Genera los archivos de exportacion de la ultima sesion cerrada:

- **CSV**: datos crudos de impedancia (frecuencia, magnitud, fase, parte real, parte imaginaria).
- **Metadata JSON**: configuracion, calibracion, timestamps, etiqueta esperada.
- **Summary JSON**: resultados del clasificador y features extraidas.
- **Bundle JSON**: paquete completo con datos + metadata + analisis.

### Limpiar vista

Borra los datos y graficas de la pantalla sin eliminar nada del backend. El historial y las exportaciones previas siguen disponibles.

---

## Clasificador cuantico vs clasico

Despues de cada barrido completo, el sistema ejecuta dos clasificadores en paralelo sobre el espectro de impedancia adquirido:

### Clasificador cuantico

Utiliza un circuito cuantico variacional de 4 qubits simulado con algebra de estados. Las 4 primeras features normalizadas (mag_mean_norm, mag_slope_norm, im_energy_norm, phase_span_norm) se convierten en angulos de rotacion con la formula:

```
angulo = (feature + 1.0) * pi / 2
```

Esto mapea el rango [-1, 1] de cada feature al rango [0, pi] de rotacion. Los angulos se aplican como puertas RY a los 4 qubits, seguidas de puertas CNOT de entrelazamiento (0->1, 1->2, 2->3, 3->0). Luego se ejecutan 2 capas de rotaciones parametrizadas RY + RZ con pesos preentrenados, mas puertas CNOT adicionales.

Del estado cuantico final se miden los valores esperados Z de los qubits 0 y 2 (z0, z2), y se combinan con un promedio ponderado de las 6 features:

```
feature_drive = 0.35 * mag_mean_norm
              + 0.25 * im_energy_norm
              + 0.15 * phase_span_norm
              + 0.10 * phase_std_norm
              + 0.10 * mag_slope_norm
              + 0.05 * low_high_ratio_norm

score = clamp(-0.35 * z0 - 0.20 * z2 + 0.45 * feature_drive, -1, 1)
probabilidad = (score + 1.0) / 2.0
```

- **probabilidad >= 0.5** -> label = 1 (Candida)
- **probabilidad < 0.5** -> label = 0 (Control)

El porcentaje mostrado en la UI es `probabilidad * 100`. Un valor de 78% significa que el circuito cuantico asigna un 78% de probabilidad a la clase Candida.

### Clasificador clasico

Utiliza una regresion logistica con pesos fijos sobre las 6 features normalizadas:

```
logit = 1.60 * mag_mean_norm
      + 0.70 * mag_slope_norm
      + 1.20 * im_energy_norm
      + 0.90 * phase_span_norm
      + 0.80 * phase_std_norm
      + 0.60 * low_high_ratio_norm
      + 0.05

probabilidad = 1 / (1 + exp(-logit))
```

La funcion sigmoide convierte el logit en una probabilidad entre 0 y 1:

- **probabilidad >= 0.5** -> label = 1 (Candida)
- **probabilidad < 0.5** -> label = 0 (Control)

El porcentaje mostrado es `probabilidad * 100`. Un valor de 92% significa que el clasificador clasico asigna un 92% de confianza a la clase Candida.

### Interpretacion de los porcentajes

| Rango del porcentaje | Label | Interpretacion |
|---|---|---|
| 0% - 20% | 0 (Control) | Alta confianza de que la muestra es control |
| 20% - 40% | 0 (Control) | Confianza moderada de control |
| 40% - 50% | 0 (Control) | Zona de incertidumbre, tendencia a control |
| 50% - 60% | 1 (Candida) | Zona de incertidumbre, tendencia a candida |
| 60% - 80% | 1 (Candida) | Confianza moderada de candida |
| 80% - 100% | 1 (Candida) | Alta confianza de que la muestra tiene candida |

El umbral de decision es exactamente 50%. Ambos clasificadores usan el mismo umbral pero llegan a la probabilidad por caminos distintos (circuito cuantico vs regresion logistica), por lo que pueden discrepar.

### Comparacion

- **Coinciden**: ambos clasificadores predicen la misma clase.
- **No coinciden**: hay desacuerdo entre los clasificadores, lo que indica una muestra en zona de frontera o que uno de los clasificadores es mas sensible a ciertas features.
- **Match esperado**: indica si cada clasificador acerto respecto a la etiqueta esperada que se asigno al iniciar el barrido.

---

## Features normalizadas

Cada feature se extrae del espectro de impedancia y se normaliza al rango [-1, 1] usando `tanh(valor / escala)`. El centro de cada normalizacion es el valor empirico de frontera entre las clases control y candida. Un resultado positivo tiende a indicar Candida (label 1) y negativo Control (label 0).

### De donde salen los valores de centro y escala

Los centros y escalas de normalizacion se derivan del modelo electroquimico que genera los espectros de impedancia. El sistema modela un circuito de Randles (R_series + R_ct || C_dl + Warburg) con parametros distintos para cada clase:

| Parametro | Control (label 0) | Candida (label 1) |
|---|---|---|
| R_series (Ohm) | 310 | 220 |
| R_ct (Ohm) | 11500 | 7200 |
| C_dl (F) | 1.9e-6 | 3.2e-6 |
| Sigma Warburg | 250 | 420 |

Cada constante de normalizacion se obtiene como el punto medio aproximado entre los valores tipicos que produce cada clase al recorrer el rango de frecuencias 1 kHz - 100 kHz con 50 puntos:

| Feature | Valor tipico Control | Valor tipico Candida | Centro elegido | Escala | Razonamiento |
|---|---|---|---|---|---|
| mag_mean | ~330 Ohm | ~230 Ohm | 270 | 85 | Punto medio entre 330 y 230. La escala (85) cubre aprox. la mitad de la separacion, de modo que tanh satura (~0.7) en las regiones tipicas de cada clase sin llegar a ±1 demasiado rapido. |
| mag_slope | ~-4.1 | ~-4.8 | -4.4 | 0.35 | Punto medio entre -4.1 y -4.8. La escala (0.35) es estrecha porque la separacion entre clases en pendiente es pequena (~0.7 unidades). |
| im_energy | ~12 Ohm | ~22 Ohm | 17 | 5 | Punto medio entre 12 y 22. La escala (5) permite que ambas clases caigan en zonas opuestas del tanh. |
| phase_span | ~12 grados | ~17 grados | 14.3 | 2.2 | Punto medio entre 12 y 17. La escala (2.2) da buena separacion para una diferencia de ~5 grados. |
| phase_std | ~3.3 grados | ~4.6 grados | 3.9 | 0.8 | Punto medio entre 3.3 y 4.6. La escala (0.8) es proporcional a la separacion de ~1.3 grados. |
| low_high_ratio | ~1.018 | ~1.028 | 1.022 | 0.01 | Punto medio entre 1.018 y 1.028. La escala (0.01) es muy pequena porque la diferencia entre clases en este ratio es de solo ~0.01. |

El criterio general es:

1. **Centro** = promedio de los valores tipicos de control y candida para esa feature, calculados a partir de multiples barridos simulados con los parametros del circuito de Randles de cada clase.
2. **Escala** = aproximadamente la mitad de la distancia entre los valores tipicos de ambas clases. Esto hace que `tanh(diferencia / escala)` produzca valores cercanos a ±0.6 o ±0.8 para muestras claramente de una clase, sin saturar inmediatamente a ±1 (lo que perderia granularidad). Para features con separacion muy pequena (como low_high_ratio), la escala es correspondientemente pequena.

### mag_mean_norm

Media de la magnitud de impedancia |Z| en todos los puntos del barrido. Formula: `tanh((270 - mag_mean) / 85)`. Control produce ~330 Ohm (resultado negativo), Candida produce ~230 Ohm (resultado positivo). Muestras con biopelicula tienen R_series y R_ct menores, reduciendo la impedancia promedio.

### mag_slope_norm

Pendiente de |Z| vs log10(frecuencia) por regresion lineal. Formula: `tanh((mag_slope + 4.4) / 0.35)`. Control produce pendiente ~-4.1 (resultado positivo), Candida produce ~-4.8 (resultado negativo). La mayor C_dl y sigma de candida generan una caida mas pronunciada con la frecuencia.

### im_energy_norm

Media del valor absoluto de Im(Z). Formula: `tanh((17 - im_energy) / 5)`. Control produce ~12 Ohm (resultado positivo), Candida produce ~22 Ohm (resultado negativo). El sigma de Warburg mayor en candida (420 vs 250) aumenta la componente reactiva.

### phase_span_norm

Rango de fase (max - min) del barrido. Formula: `tanh((14.3 - phase_span) / 2.2)`. Control produce ~12 grados (resultado positivo), Candida produce ~17 grados (resultado negativo). La C_dl mayor de candida amplia las transiciones de fase.

### phase_std_norm

Desviacion estandar de la fase. Formula: `tanh((3.9 - phase_std) / 0.8)`. Control produce ~3.3 grados (resultado positivo), Candida produce ~4.6 grados (resultado negativo). Mas componentes reactivas en candida generan mayor variabilidad de fase.

### low_high_ratio_norm

Relacion entre impedancia media del tercio inferior de frecuencias y el tercio superior. Formula: `tanh((low_high_ratio - 1.022) / 0.01)`. Control produce ~1.018 (resultado negativo), Candida produce ~1.028 (resultado positivo). El sigma de Warburg mayor en candida hace que la impedancia a bajas frecuencias sea proporcionalmente mas alta.

---

## Graficas

### Bode magnitud

Grafica de la magnitud de impedancia |Z| (eje Y, en Ohms) contra la frecuencia (eje X, en Hz, escala logaritmica). Permite visualizar:

- La resistencia de la solucion (R_s) como el valor de |Z| a frecuencias altas donde la curva se aplana.
- La resistencia de transferencia de carga (R_ct) como la diferencia entre el plateau de baja y alta frecuencia.
- Regiones de transicion que revelan constantes de tiempo del sistema electroquimico.

### Bode fase

Grafica del angulo de fase (eje Y, en grados) contra la frecuencia (eje X, en Hz, escala logaritmica). La fase indica el desfase entre la excitacion y la respuesta:

- **0 grados**: comportamiento puramente resistivo.
- **-90 grados**: comportamiento puramente capacitivo.
- Picos o valles en la curva de fase corresponden a frecuencias caracteristicas donde ocurren transiciones entre mecanismos (doble capa, transferencia de carga, difusion).

### Nyquist

Grafica de -Im(Z) (eje Y) contra Re(Z) (eje X), ambos en Ohms. Es la representacion mas clasica de espectroscopia de impedancia:

- **Semicirculo**: corresponde a un circuito RC paralelo (resistencia de transferencia de carga R_ct en paralelo con la capacitancia de doble capa C_dl). El diametro del semicirculo es R_ct.
- **Interseccion izquierda con eje X**: resistencia de la solucion R_s.
- **Interseccion derecha con eje X**: R_s + R_ct.
- **Cola a 45 grados**: impedancia de Warburg (difusion), visible a bajas frecuencias como una linea diagonal que se extiende desde el semicirculo.

La forma del diagrama de Nyquist cambia con la presencia de biopelicula: el semicirculo se deforma y los parametros del circuito equivalente varian, lo cual es la base para la clasificacion.
