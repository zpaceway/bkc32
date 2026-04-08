from dotenv import load_dotenv
from src.utls import get_env

load_dotenv()

SERIAL_PORT = get_env("SERIAL_PORT", "/dev/ttyUSB0")
BAUDRATE = int(get_env("BAUDRATE", "115200"))
SERVER_PORT = int(get_env("SERVER_PORT", "8765"))
SERVER_HOST = get_env("SERVER_HOST", "localhost")
