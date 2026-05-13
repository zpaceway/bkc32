import asyncio
import datetime
import json
from typing import Any, Callable

import websockets
from websockets.asyncio.connection import Connection

from src.collector import collector
from src.settings import SERVER_HOST, SERVER_PORT
from src.utls import get_logger

logger = get_logger("coordinator")


async def handler(websocket: Connection):
    unregister: Callable[[], None] | None = None

    async def on_message(message: dict[str, Any]):
        try:
            await websocket.send(
                json.dumps(
                    {
                        "type": message.get("type", "unknown"),
                        "payload": message,
                        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    }
                )
            )
        except Exception:
            if unregister:
                unregister()

    unregister = collector.register(on_message)

    try:
        async for raw in websocket:
            data = json.loads(str(raw))
            cmd_type = str(data.get("type", "")).lower()
            payload = data.get("payload", {})
            if not isinstance(payload, dict):
                payload = {}

            if cmd_type == "ping":
                collector.ping()
            elif cmd_type == "cfg":
                collector.configure(
                    fmin=float(payload.get("fmin", 1000)),
                    fmax=float(payload.get("fmax", 100000)),
                    npoints=int(payload.get("npoints", 50)),
                    settle=int(payload.get("settle", 15)),
                )
            elif cmd_type == "cal":
                collector.calibrate(resistance=float(payload.get("resistance", 10000)))
            elif cmd_type == "start":
                label = payload.get("label")
                expected_label: int | None
                if label in (0, 1, "0", "1"):
                    expected_label = int(label)
                else:
                    expected_label = None
                collector.start_sweep(expected_label=expected_label)
            elif cmd_type == "stop":
                await collector.stop_sweep()
            elif cmd_type == "temp":
                collector.read_temp()
            elif cmd_type == "export":
                await on_message(await collector.export_last())
            elif cmd_type == "history":
                await on_message(
                    {"type": "history", "sessions": await collector.history()}
                )
            else:
                await on_message(
                    {
                        "type": "error",
                        "code": "UNKNOWN_COMMAND",
                        "message": f"Unsupported command: {cmd_type}",
                    }
                )

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        unregister()


async def serve():
    async with websockets.serve(handler, SERVER_HOST, SERVER_PORT):
        logger.info(f"WebSocket server running on ws://{SERVER_HOST}:{SERVER_PORT}")
        await asyncio.Future()
