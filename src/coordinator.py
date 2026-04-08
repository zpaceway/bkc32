import asyncio
import websockets
from src.settings import SERVER_HOST, SERVER_PORT
from src.utls import get_logger
from src.collector import collector
from websockets.asyncio.connection import Connection
import json
import datetime
from typing import Callable

logger = get_logger("coordinator")


async def handler(websocket: Connection):
    unregister: Callable | None = None

    async def on_message(message: dict):
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
            cmd_type = data.get("type", "")

            if cmd_type == "ping":
                collector.ping()
            elif cmd_type == "cfg":
                p = data.get("payload", {})
                collector.configure(
                    fmin=p.get("fmin", 1000),
                    fmax=p.get("fmax", 100000),
                    npoints=p.get("npoints", 50),
                    settle=p.get("settle", 15),
                )
            elif cmd_type == "cal":
                p = data.get("payload", {})
                collector.calibrate(resistance=p.get("resistance", 10000))
            elif cmd_type == "start":
                collector.start_sweep()
            elif cmd_type == "stop":
                collector.stop_sweep()
            elif cmd_type == "temp":
                collector.read_temp()

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if unregister:
            unregister()


async def serve():
    async with websockets.serve(handler, SERVER_HOST, SERVER_PORT):
        logger.info(f"WebSocket server running on ws://{SERVER_HOST}:{SERVER_PORT}")
        await asyncio.Future()
