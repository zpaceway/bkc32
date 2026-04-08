import serial
import json
from src.settings import SERIAL_PORT, BAUDRATE
from typing import Callable
import asyncio
from src.utls import get_logger

logger = get_logger("collector")


class Collector:
    conn: serial.Serial | None = None
    callbacks: list[Callable]

    def __init__(self):
        self.callbacks = []

    def register(self, callback: Callable):
        self.callbacks.append(callback)

        def unregister():
            self.callbacks.remove(callback)

        return unregister

    async def start(self):
        try:
            self.conn = serial.Serial(SERIAL_PORT, BAUDRATE, timeout=1)
            logger.info(f"Serial connected on {SERIAL_PORT} @ {BAUDRATE}")

            while True:
                if self.conn.in_waiting <= 0:
                    await asyncio.sleep(0)
                    continue

                line = self.conn.readline().decode("utf-8", errors="ignore").strip()
                if not line:
                    continue

                message = self.parse(line)
                if message is None:
                    continue

                if not self.callbacks:
                    continue

                tasks = [callback(message) for callback in self.callbacks]
                await asyncio.gather(*tasks, return_exceptions=True)

        except serial.SerialException as e:
            raise e

        except KeyboardInterrupt:
            pass

        finally:
            if self.conn and self.conn.is_open:
                self.conn.close()

    def parse(self, line: str) -> dict | None:
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            logger.debug(f"Non-JSON line: {line}")
            return None

    def send_command(self, command: str):
        if not self.conn or not self.conn.is_open:
            logger.warning("Serial connection not open.")
            return
        self.conn.write(f"{command}\n".encode("utf-8"))
        logger.info(f"Sent: {command}")

    def ping(self):
        self.send_command("PING")

    def configure(self, fmin: float, fmax: float, npoints: int, settle: int = 15):
        self.send_command(f"CFG:{fmin},{fmax},{npoints},{settle}")

    def calibrate(self, resistance: float = 10000):
        self.send_command(f"CAL:{resistance}")

    def start_sweep(self):
        self.send_command("START")

    def stop_sweep(self):
        self.send_command("STOP")

    def read_temp(self):
        self.send_command("TEMP")


collector = Collector()
