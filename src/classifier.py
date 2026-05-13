from __future__ import annotations

from math import cos, exp, log10, pi, sin, tanh
from typing import Any, Mapping


def _to_float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except TypeError, ValueError:
        return fallback


def _safe_mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _safe_std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    m = _safe_mean(values)
    variance = sum((v - m) ** 2 for v in values) / len(values)
    return variance**0.5


def _regression_slope(x: list[float], y: list[float]) -> float:
    if len(x) != len(y) or len(x) < 2:
        return 0.0
    x_mean = _safe_mean(x)
    y_mean = _safe_mean(y)
    denominator = sum((xi - x_mean) ** 2 for xi in x)
    if denominator == 0:
        return 0.0
    numerator = sum((xi - x_mean) * (yi - y_mean) for xi, yi in zip(x, y))
    return numerator / denominator


def _normalized(value: float, scale: float) -> float:
    if scale == 0:
        return 0.0
    return max(-1.0, min(1.0, tanh(value / scale)))


def extract_features(points: list[Mapping[str, Any]]) -> dict[str, float]:
    if not points:
        return {
            "mag_mean_norm": 0.0,
            "mag_slope_norm": 0.0,
            "im_energy_norm": 0.0,
            "phase_span_norm": 0.0,
            "phase_std_norm": 0.0,
            "low_high_ratio_norm": 0.0,
        }

    freqs = [max(_to_float(p.get("f"), 1.0), 1.0) for p in points]
    mags = [_to_float(p.get("Z")) for p in points]
    phases = [_to_float(p.get("phase")) for p in points]
    imags = [_to_float(p.get("imZ")) for p in points]

    logf = [log10(f) for f in freqs]
    mag_mean = _safe_mean(mags)
    mag_slope = _regression_slope(logf, mags)
    im_energy = _safe_mean([abs(v) for v in imags])
    phase_span = max(phases) - min(phases) if phases else 0.0
    phase_std = _safe_std(phases)

    third = max(1, len(mags) // 3)
    low_band = mags[:third]
    high_band = mags[-third:]
    high_mean = max(_safe_mean(high_band), 1e-6)
    low_high_ratio = _safe_mean(low_band) / high_mean

    return {
        "mag_mean_norm": _normalized(270.0 - mag_mean, 85.0),
        "mag_slope_norm": _normalized(mag_slope + 4.4, 0.35),
        "im_energy_norm": _normalized(17.0 - im_energy, 5.0),
        "phase_span_norm": _normalized(14.3 - phase_span, 2.2),
        "phase_std_norm": _normalized(3.9 - phase_std, 0.8),
        "low_high_ratio_norm": _normalized(low_high_ratio - 1.022, 0.01),
    }


def _zero_state(n_qubits: int) -> list[complex]:
    size = 1 << n_qubits
    state = [0j] * size
    state[0] = 1 + 0j
    return state


def _ry(theta: float) -> tuple[tuple[complex, complex], tuple[complex, complex]]:
    c = cos(theta / 2)
    s = sin(theta / 2)
    return ((c, -s), (s, c))


def _rz(phi: float) -> tuple[tuple[complex, complex], tuple[complex, complex]]:
    half = phi / 2
    p0 = complex(cos(-half), sin(-half))
    p1 = complex(cos(half), sin(half))
    return ((p0, 0j), (0j, p1))


def _apply_single(
    state: list[complex],
    gate: tuple[tuple[complex, complex], tuple[complex, complex]],
    wire: int,
) -> None:
    step = 1 << wire
    stride = step << 1
    for offset in range(0, len(state), stride):
        for i in range(step):
            i0 = offset + i
            i1 = i0 + step
            a = state[i0]
            b = state[i1]
            state[i0] = gate[0][0] * a + gate[0][1] * b
            state[i1] = gate[1][0] * a + gate[1][1] * b


def _apply_cnot(state: list[complex], control: int, target: int) -> None:
    if control == target:
        return
    control_mask = 1 << control
    target_mask = 1 << target
    for index in range(len(state)):
        if (index & control_mask) and not (index & target_mask):
            pair = index | target_mask
            state[index], state[pair] = state[pair], state[index]


def _expval_z(state: list[complex], wire: int) -> float:
    mask = 1 << wire
    value = 0.0
    for index, amp in enumerate(state):
        prob = amp.real * amp.real + amp.imag * amp.imag
        value += prob if (index & mask) == 0 else -prob
    return value


def _quantum_score_from_features(
    features: dict[str, float],
) -> tuple[float, float, int]:
    angles = [
        (features["mag_mean_norm"] + 1.0) * pi / 2,
        (features["mag_slope_norm"] + 1.0) * pi / 2,
        (features["im_energy_norm"] + 1.0) * pi / 2,
        (features["phase_span_norm"] + 1.0) * pi / 2,
    ]

    state = _zero_state(4)

    for wire, theta in enumerate(angles):
        _apply_single(state, _ry(theta), wire)

    _apply_cnot(state, 0, 1)
    _apply_cnot(state, 1, 2)
    _apply_cnot(state, 2, 3)
    _apply_cnot(state, 3, 0)

    layers = (
        ((0.75, 0.10), (0.55, -0.22), (0.60, 0.18), (0.80, -0.05)),
        ((-0.30, 0.25), (-0.45, -0.12), (-0.35, 0.28), (-0.25, -0.08)),
    )

    for layer in layers:
        for wire, (gain, bias) in enumerate(layer):
            theta = gain * angles[wire] + bias
            phase = 0.5 * angles[(wire + 1) % 4] - bias
            _apply_single(state, _ry(theta), wire)
            _apply_single(state, _rz(phase), wire)
        _apply_cnot(state, 0, 1)
        _apply_cnot(state, 2, 3)

    z0 = _expval_z(state, 0)
    z2 = _expval_z(state, 2)
    feature_drive = (
        0.35 * features["mag_mean_norm"]
        + 0.25 * features["im_energy_norm"]
        + 0.15 * features["phase_span_norm"]
        + 0.10 * features["phase_std_norm"]
        + 0.10 * features["mag_slope_norm"]
        + 0.05 * features["low_high_ratio_norm"]
    )

    score = max(-1.0, min(1.0, -0.35 * z0 - 0.20 * z2 + 0.45 * feature_drive))
    probability = (score + 1.0) / 2.0
    label = 1 if probability >= 0.5 else 0
    return score, probability, label


def _classical_score_from_features(features: dict[str, float]) -> tuple[float, int]:
    logit = (
        1.60 * features["mag_mean_norm"]
        + 0.70 * features["mag_slope_norm"]
        + 1.20 * features["im_energy_norm"]
        + 0.90 * features["phase_span_norm"]
        + 0.80 * features["phase_std_norm"]
        + 0.60 * features["low_high_ratio_norm"]
        + 0.05
    )
    probability = 1.0 / (1.0 + exp(-logit))
    label = 1 if probability >= 0.5 else 0
    return probability, label


def analyze_sweep(points: list, expected_label: Any = None) -> dict[str, Any]:
    features = extract_features(points)
    quantum_score, quantum_probability, quantum_label = _quantum_score_from_features(
        features
    )
    classical_probability, classical_label = _classical_score_from_features(features)

    expected: int | None
    if expected_label in (0, 1, "0", "1"):
        expected = int(expected_label)
    else:
        expected = None

    quantum_match = None if expected is None else quantum_label == expected
    classical_match = None if expected is None else classical_label == expected

    return {
        "quantum_score": round(quantum_score, 6),
        "quantum_probability": round(quantum_probability, 6),
        "quantum_label": quantum_label,
        "classical_probability": round(classical_probability, 6),
        "classical_label": classical_label,
        "agreement": quantum_label == classical_label,
        "expected_label": expected,
        "quantum_match": quantum_match,
        "classical_match": classical_match,
        "features": {k: round(v, 6) for k, v in features.items()},
        "point_count": len(points),
    }
