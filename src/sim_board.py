from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import fcntl
import json
import math
import os
import pty
import random
import termios
from dataclasses import dataclass
from pathlib import Path


@dataclass
class SweepConfig:
    fmin: float = 1000.0
    fmax: float = 100000.0
    npoints: int = 50
    settle: int = 15


class SimulatedBoard:
    def __init__(
        self,
        link_path: str,
        profile: str,
        point_delay: float,
        seed: int | None,
    ):
        self.link_path = Path(link_path)
        self.profile = profile
        self.point_delay = max(0.005, point_delay)
        self.random = random.Random(seed)
        self.config = SweepConfig()
        self.calibrated = False
        self.calibration_r = 10000.0
        self.gain = 0.0000012
        self.phase_ref = -0.02
        self._master_fd = -1
        self._slave_fd = -1
        self._slave_name = ""
        self._buffer = ""
        self._running = True
        self._sweep_task: asyncio.Task[None] | None = None
        self._sweep_counter = 0

    def _set_nonblocking(self, fd: int) -> None:
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def _set_raw(self, fd: int) -> None:
        attrs = termios.tcgetattr(fd)
        attrs[0] &= ~(
            termios.IGNBRK
            | termios.BRKINT
            | termios.PARMRK
            | termios.ISTRIP
            | termios.INLCR
            | termios.IGNCR
            | termios.ICRNL
            | termios.IXON
        )
        attrs[1] &= ~termios.OPOST
        attrs[2] &= ~(termios.CSIZE | termios.PARENB)
        attrs[2] |= termios.CS8
        attrs[3] &= ~(
            termios.ECHO
            | termios.ECHONL
            | termios.ICANON
            | termios.ISIG
            | termios.IEXTEN
        )
        attrs[6][termios.VMIN] = 1
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attrs)

    def _create_pty(self) -> None:
        self._master_fd, self._slave_fd = pty.openpty()
        self._set_nonblocking(self._master_fd)
        self._set_raw(self._slave_fd)
        self._slave_name = os.ttyname(self._slave_fd)

        self.link_path.parent.mkdir(parents=True, exist_ok=True)
        if self.link_path.exists() or self.link_path.is_symlink():
            self.link_path.unlink()
        self.link_path.symlink_to(self._slave_name)

    def _cleanup(self) -> None:
        self._running = False
        if self._sweep_task:
            self._sweep_task.cancel()
            self._sweep_task = None
        try:
            if self.link_path.is_symlink() or self.link_path.exists():
                self.link_path.unlink()
        except OSError:
            pass
        for fd in (self._master_fd, self._slave_fd):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass

    def _write_message(self, payload: dict) -> None:
        line = json.dumps(payload, ensure_ascii=True)
        os.write(self._master_fd, (line + "\n").encode("utf-8"))

    def _choose_label(self) -> int:
        if self.profile == "control":
            return 0
        if self.profile == "candida":
            return 1
        if self.profile == "random":
            return self.random.randint(0, 1)
        return self._sweep_counter % 2

    def _simulate_point(self, freq: float, label: int, index: int) -> dict:
        omega = 2.0 * math.pi * max(freq, 1.0)

        if label == 1:
            r_series = 220.0
            r_ct = 7200.0
            c_dl = 3.2e-6
            sigma = 420.0
        else:
            r_series = 310.0
            r_ct = 11500.0
            c_dl = 1.9e-6
            sigma = 250.0

        z_cdl = complex(0.0, -1.0 / (omega * c_dl))
        z_parallel = 1.0 / ((1.0 / r_ct) + (1.0 / z_cdl))
        z_w = complex(sigma / math.sqrt(omega), -sigma / math.sqrt(omega))
        z_total = complex(r_series, 0.0) + z_parallel + z_w

        noise_mag = 0.004 + 0.002 * math.sin(index * 0.8)
        re_noise = 1.0 + self.random.uniform(-noise_mag, noise_mag)
        im_noise = 1.0 + self.random.uniform(-noise_mag, noise_mag)

        re_z = z_total.real * re_noise
        im_z = z_total.imag * im_noise
        z_abs = math.sqrt((re_z * re_z) + (im_z * im_z))
        phase = math.degrees(math.atan2(im_z, re_z))

        return {
            "type": "data",
            "i": index,
            "f": round(freq, 4),
            "Z": round(z_abs, 4),
            "phase": round(phase, 4),
            "reZ": round(re_z, 4),
            "imZ": round(im_z, 4),
        }

    def _log_space(self, start: float, stop: float, points: int) -> list[float]:
        if points <= 1:
            return [start]
        if start <= 0:
            start = 1.0
        if stop <= start:
            stop = start * 10.0
        start_l = math.log10(start)
        stop_l = math.log10(stop)
        step = (stop_l - start_l) / (points - 1)
        return [10 ** (start_l + i * step) for i in range(points)]

    async def _run_sweep(self) -> None:
        if not self.calibrated:
            self._write_message(
                {
                    "type": "error",
                    "code": "NOT_CALIBRATED",
                    "message": "Run CAL before START",
                }
            )
            return

        label = self._choose_label()
        self._write_message(
            {
                "type": "sweep_start",
                "points": self.config.npoints,
                "label": label,
                "profile": self.profile,
            }
        )

        frequencies = self._log_space(
            self.config.fmin, self.config.fmax, self.config.npoints
        )
        for i, freq in enumerate(frequencies):
            await asyncio.sleep(self.point_delay)
            if not self._running:
                return
            self._write_message(self._simulate_point(freq, label, i))

        self._write_message({"type": "sweep_done"})

    def _handle_cfg(self, command: str) -> None:
        if ":" not in command:
            self._write_message(
                {
                    "type": "cfg",
                    "fmin": self.config.fmin,
                    "fmax": self.config.fmax,
                    "npoints": self.config.npoints,
                    "settle": self.config.settle,
                    "calibrated": self.calibrated,
                }
            )
            return

        raw = command.split(":", 1)[1]
        parts = [p.strip() for p in raw.split(",")]
        try:
            if len(parts) >= 1 and parts[0]:
                self.config.fmin = max(1.0, float(parts[0]))
            if len(parts) >= 2 and parts[1]:
                self.config.fmax = max(self.config.fmin + 1.0, float(parts[1]))
            if len(parts) >= 3 and parts[2]:
                self.config.npoints = max(2, min(500, int(float(parts[2]))))
            if len(parts) >= 4 and parts[3]:
                self.config.settle = max(1, min(255, int(float(parts[3]))))
            self._write_message(
                {
                    "type": "cfg_ok",
                    "fmin": self.config.fmin,
                    "fmax": self.config.fmax,
                    "npoints": self.config.npoints,
                    "settle": self.config.settle,
                }
            )
        except ValueError:
            self._write_message(
                {
                    "type": "error",
                    "code": "CFG_FORMAT",
                    "message": "CFG must be CFG:fmin,fmax,npoints,settle",
                }
            )

    def _handle_cal(self, command: str) -> None:
        if ":" in command:
            raw = command.split(":", 1)[1].strip()
            if raw:
                try:
                    self.calibration_r = max(100.0, float(raw))
                except ValueError:
                    self._write_message(
                        {
                            "type": "error",
                            "code": "CAL_FORMAT",
                            "message": "CAL requires numeric resistance",
                        }
                    )
                    return

        self.gain = (1.0 / self.calibration_r) * (
            0.0105 + self.random.uniform(-0.0009, 0.0009)
        )
        self.phase_ref = -0.025 + self.random.uniform(-0.003, 0.003)
        self.calibrated = True
        self._write_message(
            {
                "type": "cal",
                "gain": round(self.gain, 10),
                "phase": round(self.phase_ref, 6),
                "R_cal": round(self.calibration_r, 2),
            }
        )

    def _handle_temp(self) -> None:
        seconds = dt.datetime.now(dt.timezone.utc).timestamp()
        base = 26.0 + 0.9 * math.sin(seconds / 35.0)
        noise = self.random.uniform(-0.15, 0.15)
        self._write_message({"type": "temp", "value": round(base + noise, 2)})

    def _start_sweep(self) -> None:
        if self._sweep_task and not self._sweep_task.done():
            self._write_message(
                {
                    "type": "error",
                    "code": "SWEEP_RUNNING",
                    "message": "Sweep already running",
                }
            )
            return
        self._sweep_counter += 1
        self._sweep_task = asyncio.create_task(self._run_sweep())

    def _stop_sweep(self) -> None:
        if self._sweep_task and not self._sweep_task.done():
            self._sweep_task.cancel()
            self._sweep_task = None
            self._write_message({"type": "sweep_stopped"})
            return
        self._write_message({"type": "stopped"})

    def _handle_command(self, raw: str) -> None:
        command = raw.strip()
        if not command:
            return

        upper = command.upper()
        if upper == "PING":
            self._write_message(
                {"type": "pong", "device": "BKC32-SIM", "version": "3.0"}
            )
            return
        if upper.startswith("CFG"):
            self._handle_cfg(command)
            return
        if upper.startswith("CAL"):
            self._handle_cal(command)
            return
        if upper in {"START", "SWEEP"}:
            self._start_sweep()
            return
        if upper == "STOP":
            self._stop_sweep()
            return
        if upper == "TEMP":
            self._handle_temp()
            return
        if upper == "SIM_EXPORT":
            self._write_message({"type": "ack", "command": "SIM_EXPORT"})
            return
        if upper == "SIM_HISTORY":
            self._write_message({"type": "ack", "command": "SIM_HISTORY"})
            return

        self._write_message(
            {
                "type": "error",
                "code": "UNKNOWN_COMMAND",
                "message": f"Unsupported command: {command}",
            }
        )

    def _poll_input(self) -> None:
        while True:
            try:
                chunk = os.read(self._master_fd, 4096)
                if not chunk:
                    return
                self._buffer += chunk.decode("utf-8", errors="ignore")
            except BlockingIOError:
                break
            except OSError:
                break

        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self._handle_command(line)

    async def run(self) -> None:
        self._create_pty()
        self._write_message({"type": "ready", "device": "BKC32-SIM", "version": "3.0"})
        print(f"SIM serial link: {self.link_path}")
        print(f"PTY slave target: {self._slave_name}")
        print(f"Profile mode: {self.profile}")
        print("Press Ctrl+C to stop")

        try:
            while self._running:
                self._poll_input()
                await asyncio.sleep(0.002)
        finally:
            self._cleanup()


async def _main() -> None:
    parser = argparse.ArgumentParser(description="BKC32 ESP32 serial board simulator")
    parser.add_argument("--link", default="/tmp/bkc32-sim-serial")
    parser.add_argument(
        "--profile",
        default="alternating",
        choices=["alternating", "random", "control", "candida"],
    )
    parser.add_argument("--point-delay", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    board = SimulatedBoard(
        link_path=args.link,
        profile=args.profile,
        point_delay=args.point_delay,
        seed=args.seed,
    )
    await board.run()


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
