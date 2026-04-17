from __future__ import annotations

import asyncio
import csv
import datetime as dt
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

import serial

from src.classifier import analyze_sweep
from src.settings import (
    BAUDRATE,
    DATA_DIR,
    SERIAL_PORT,
    SERIAL_RETRY_SECONDS,
    SERIAL_TIMEOUT,
)
from src.utls import get_logger

logger = get_logger("collector")


MessageCallback = Callable[[dict[str, Any]], Any]


def _utc_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


@dataclass
class Session:
    id: str
    started_at: str
    source: str
    points: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)
    calibration: dict[str, Any] = field(default_factory=dict)
    temperature: float | None = None
    expected_label: int | None = None
    stop_reason: str = "pending"
    sweep_done_at: str | None = None
    saved_paths: dict[str, str] = field(default_factory=dict)
    analysis: dict[str, Any] | None = None


class Collector:
    conn: serial.Serial | None
    callbacks: list[MessageCallback]

    def __init__(self):
        self.conn = None
        self.callbacks = []
        self.current_config: dict[str, Any] = {
            "fmin": 1000.0,
            "fmax": 100000.0,
            "npoints": 50,
            "settle": 15,
        }
        self.current_calibration: dict[str, Any] = {}
        self.current_temperature: float | None = None
        self.current_session: Session | None = None
        self.last_session: Session | None = None
        self.pending_expected_label: int | None = None
        self.data_dir = Path(DATA_DIR)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def register(self, callback: MessageCallback) -> Callable[[], None]:
        self.callbacks.append(callback)

        def unregister() -> None:
            if callback in self.callbacks:
                self.callbacks.remove(callback)

        return unregister

    async def _publish(self, message: dict[str, Any]) -> None:
        if not self.callbacks:
            return
        tasks = []
        for callback in list(self.callbacks):
            try:
                result = callback(message)
                if asyncio.iscoroutine(result):
                    tasks.append(result)
            except Exception as exc:
                logger.warning(f"Callback error: {exc}")
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _emit(self, message: dict[str, Any]) -> None:
        if self.current_session:
            msg_type = str(message.get("type", ""))
            if msg_type not in {"data", "analysis", "history"}:
                self.current_session.events.append(
                    {
                        "ts": _utc_iso(),
                        "type": msg_type,
                        "payload": message,
                    }
                )
        await self._publish(message)

    def _build_session_id(self) -> str:
        now = dt.datetime.now(dt.timezone.utc)
        return now.strftime("session_%Y%m%d_%H%M%S_%f")

    def _session_path(self, session_id: str) -> Path:
        return self.data_dir / session_id

    def _start_session(self, source: str, expected_label: int | None = None) -> Session:
        session_id = self._build_session_id()
        session = Session(
            id=session_id,
            started_at=_utc_iso(),
            source=source,
            config=dict(self.current_config),
            calibration=dict(self.current_calibration),
            temperature=self.current_temperature,
            expected_label=expected_label,
        )
        self.current_session = session
        logger.info(f"Acquisition session started: {session_id} ({source})")
        return session

    def _ensure_session(self) -> Session:
        if self.current_session is None:
            return self._start_session(source="implicit")
        return self.current_session

    def _extract_expected_label(self, message: Mapping[str, Any]) -> int | None:
        raw = message.get("label")
        if raw in (0, 1, "0", "1"):
            return int(raw)
        return None

    def _update_state_from_message(self, message: Mapping[str, Any]) -> None:
        msg_type = str(message.get("type", ""))
        if msg_type in {"cfg", "cfg_ok"}:
            self.current_config = {
                "fmin": float(
                    message.get("fmin", self.current_config.get("fmin", 1000.0))
                ),
                "fmax": float(
                    message.get("fmax", self.current_config.get("fmax", 100000.0))
                ),
                "npoints": int(
                    message.get("npoints", self.current_config.get("npoints", 50))
                ),
                "settle": int(
                    message.get("settle", self.current_config.get("settle", 15))
                ),
            }
            if self.current_session:
                self.current_session.config = dict(self.current_config)
        elif msg_type == "cal":
            self.current_calibration = {
                "gain": float(message.get("gain", 0.0)),
                "phase": float(message.get("phase", 0.0)),
                "R_cal": float(message.get("R_cal", 0.0)),
            }
            if self.current_session:
                self.current_session.calibration = dict(self.current_calibration)
        elif msg_type == "temp":
            try:
                self.current_temperature = float(message.get("value", 0.0))
            except (TypeError, ValueError):
                self.current_temperature = None
            if self.current_session:
                self.current_session.temperature = self.current_temperature
        elif msg_type == "sweep_start":
            expected_label = self._extract_expected_label(message)
            if expected_label is None:
                expected_label = self.pending_expected_label
            if self.current_session and not self.current_session.points:
                session = self.current_session
                session.source = "device"
                if session.expected_label is None:
                    session.expected_label = expected_label
            else:
                session = self._start_session(
                    source="device", expected_label=expected_label
                )
            self.pending_expected_label = None
            session.config = dict(self.current_config)
            session.calibration = dict(self.current_calibration)
            session.temperature = self.current_temperature
        elif msg_type == "data":
            session = self._ensure_session()
            point = {
                "i": int(message.get("i", len(session.points))),
                "f": float(message.get("f", 0.0)),
                "Z": float(message.get("Z", 0.0)),
                "phase": float(message.get("phase", 0.0)),
                "reZ": float(message.get("reZ", 0.0)),
                "imZ": float(message.get("imZ", 0.0)),
                "ts": _utc_iso(),
            }
            session.points.append(point)

    def _save_session_csv(self, session: Session, directory: Path) -> Path:
        csv_path = directory / f"{session.id}_data.csv"
        with csv_path.open("w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(
                file,
                fieldnames=["i", "f", "Z", "phase", "reZ", "imZ", "ts"],
            )
            writer.writeheader()
            writer.writerows(session.points)
        return csv_path

    def _save_session_metadata(self, session: Session, directory: Path) -> Path:
        metadata_path = directory / f"{session.id}_metadata.json"
        metadata = {
            "session_id": session.id,
            "started_at": session.started_at,
            "finished_at": session.sweep_done_at,
            "source": session.source,
            "stop_reason": session.stop_reason,
            "config": session.config,
            "calibration": session.calibration,
            "temperature": session.temperature,
            "expected_label": session.expected_label,
            "point_count": len(session.points),
            "events": session.events,
            "analysis": session.analysis,
        }
        metadata_path.write_text(
            json.dumps(metadata, ensure_ascii=True, indent=2), encoding="utf-8"
        )
        return metadata_path

    def _save_session_summary(self, session: Session, directory: Path) -> Path:
        summary_path = directory / f"{session.id}_summary.txt"
        lines = [
            f"session_id={session.id}",
            f"started_at={session.started_at}",
            f"finished_at={session.sweep_done_at}",
            f"source={session.source}",
            f"stop_reason={session.stop_reason}",
            f"point_count={len(session.points)}",
            f"temperature={session.temperature}",
            f"expected_label={session.expected_label}",
        ]
        if session.analysis:
            lines.extend(
                [
                    f"quantum_probability={session.analysis.get('quantum_probability')}",
                    f"quantum_label={session.analysis.get('quantum_label')}",
                    f"classical_probability={session.analysis.get('classical_probability')}",
                    f"classical_label={session.analysis.get('classical_label')}",
                    f"agreement={session.analysis.get('agreement')}",
                    f"quantum_match={session.analysis.get('quantum_match')}",
                    f"classical_match={session.analysis.get('classical_match')}",
                ]
            )
        summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return summary_path

    def _persist_session(self, session: Session) -> dict[str, str]:
        directory = self._session_path(session.id)
        directory.mkdir(parents=True, exist_ok=True)
        csv_path = self._save_session_csv(session, directory)
        metadata_path = self._save_session_metadata(session, directory)
        summary_path = self._save_session_summary(session, directory)
        bundle_path = directory / f"{session.id}_bundle.json"
        bundle_path.write_text(
            json.dumps(
                {
                    "session": {
                        "id": session.id,
                        "started_at": session.started_at,
                        "finished_at": session.sweep_done_at,
                        "source": session.source,
                        "stop_reason": session.stop_reason,
                        "config": session.config,
                        "calibration": session.calibration,
                        "temperature": session.temperature,
                        "expected_label": session.expected_label,
                        "analysis": session.analysis,
                    },
                    "points": session.points,
                    "events": session.events,
                },
                ensure_ascii=True,
                indent=2,
            ),
            encoding="utf-8",
        )
        paths = {
            "dir": str(directory),
            "csv": str(csv_path),
            "metadata": str(metadata_path),
            "summary": str(summary_path),
            "bundle": str(bundle_path),
        }
        session.saved_paths = paths
        return paths

    async def _finalize_session(self, stop_reason: str) -> dict[str, Any] | None:
        session = self.current_session
        if session is None:
            return None

        session.stop_reason = stop_reason
        session.sweep_done_at = _utc_iso()
        session.analysis = analyze_sweep(session.points, session.expected_label)
        paths = self._persist_session(session)
        payload = {
            "type": "analysis",
            "session_id": session.id,
            "stop_reason": stop_reason,
            "result": session.analysis,
            "export": paths,
        }
        self.last_session = session
        self.current_session = None
        await self._publish(payload)
        logger.info(
            f"Session finalized: {session.id} points={len(session.points)} reason={stop_reason}"
        )
        return payload

    def _list_history(self) -> list[dict[str, Any]]:
        if not self.data_dir.exists():
            return []
        sessions: list[dict[str, Any]] = []
        for entry in sorted(self.data_dir.iterdir(), reverse=True):
            if not entry.is_dir():
                continue
            metadata_files = list(entry.glob("*_metadata.json"))
            if not metadata_files:
                continue
            try:
                content = json.loads(metadata_files[0].read_text(encoding="utf-8"))
                sessions.append(
                    {
                        "session_id": content.get("session_id", entry.name),
                        "started_at": content.get("started_at"),
                        "finished_at": content.get("finished_at"),
                        "point_count": content.get("point_count", 0),
                        "stop_reason": content.get("stop_reason"),
                        "expected_label": content.get("expected_label"),
                        "analysis": content.get("analysis"),
                    }
                )
            except Exception as exc:
                logger.warning(f"Unable to parse metadata from {entry}: {exc}")
        return sessions[:25]

    async def _export_last_session(self) -> dict[str, Any]:
        if self.last_session is None:
            return {
                "type": "error",
                "code": "NO_SESSION",
                "message": "No finished session available to export",
            }
        if not self.last_session.saved_paths:
            self._persist_session(self.last_session)
        return {
            "type": "export",
            "session_id": self.last_session.id,
            "paths": self.last_session.saved_paths,
        }

    async def _handle_local_command(self, line: str) -> bool:
        if not line.startswith("SIM_"):
            return False

        if line.startswith("SIM_EXPORT"):
            message = await self._export_last_session()
            await self._publish(message)
            return True

        if line.startswith("SIM_HISTORY"):
            await self._publish({"type": "history", "sessions": self._list_history()})
            return True

        if line.startswith("SIM_EXPECT"):
            value = line.split(":", 1)[1].strip() if ":" in line else ""
            if value not in {"0", "1"}:
                await self._publish(
                    {
                        "type": "error",
                        "code": "INVALID_EXPECTED_LABEL",
                        "message": "SIM_EXPECT requires label 0 or 1",
                    }
                )
                return True
            session = self._ensure_session()
            session.expected_label = int(value)
            self.pending_expected_label = session.expected_label
            await self._publish(
                {
                    "type": "expected_label",
                    "value": session.expected_label,
                    "session_id": session.id,
                }
            )
            return True

        return False

    async def start(self) -> None:
        while True:
            try:
                self.conn = serial.Serial(SERIAL_PORT, BAUDRATE, timeout=SERIAL_TIMEOUT)
                logger.info(f"Serial connected on {SERIAL_PORT} @ {BAUDRATE}")

                while True:
                    if not self.conn or not self.conn.is_open:
                        break

                    if self.conn.in_waiting <= 0:
                        await asyncio.sleep(0.002)
                        continue

                    line = self.conn.readline().decode("utf-8", errors="ignore").strip()
                    if not line:
                        continue

                    if await self._handle_local_command(line):
                        continue

                    message = self.parse(line)
                    if message is None:
                        continue

                    self._update_state_from_message(message)
                    await self._emit(message)

                    msg_type = str(message.get("type", ""))
                    if msg_type == "sweep_done":
                        await self._finalize_session(stop_reason="completed")
                    elif msg_type in {"sweep_stopped", "stopped"}:
                        await self._finalize_session(stop_reason="stopped")
                    elif msg_type == "error":
                        if self.current_session and self.current_session.points:
                            await self._finalize_session(stop_reason="error")

            except serial.SerialException as exc:
                logger.warning(
                    f"Serial connection error on {SERIAL_PORT}: {exc}. Retrying in {SERIAL_RETRY_SECONDS:.1f}s"
                )
                await asyncio.sleep(SERIAL_RETRY_SECONDS)
            except Exception as exc:
                logger.exception(f"Collector loop error: {exc}")
                await asyncio.sleep(SERIAL_RETRY_SECONDS)
            finally:
                if self.conn and self.conn.is_open:
                    self.conn.close()
                self.conn = None

    def parse(self, line: str) -> dict[str, Any] | None:
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            logger.debug(f"Non-JSON line: {line}")
            return None

    def send_command(self, command: str) -> bool:
        if not self.conn or not self.conn.is_open:
            logger.warning("Serial connection not open.")
            return False
        self.conn.write(f"{command}\n".encode("utf-8"))
        logger.info(f"Sent: {command}")
        return True

    def ping(self) -> bool:
        return self.send_command("PING")

    def configure(
        self, fmin: float, fmax: float, npoints: int, settle: int = 15
    ) -> bool:
        return self.send_command(f"CFG:{fmin},{fmax},{npoints},{settle}")

    def calibrate(self, resistance: float = 10000) -> bool:
        return self.send_command(f"CAL:{resistance}")

    def start_sweep(self, expected_label: int | None = None) -> bool:
        if expected_label in (0, 1):
            self.pending_expected_label = int(expected_label)
            logger.info(f"Expected label set to {self.pending_expected_label}")
        else:
            self.pending_expected_label = None
        return self.send_command("START")

    async def stop_sweep(self) -> bool:
        return self.send_command("STOP")

    def read_temp(self) -> bool:
        return self.send_command("TEMP")

    async def export_last(self) -> dict[str, Any]:
        return await self._export_last_session()

    async def history(self) -> list[dict[str, Any]]:
        return self._list_history()


collector = Collector()
