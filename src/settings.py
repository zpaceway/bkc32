from dotenv import load_dotenv
from src.utls import get_env

load_dotenv()

SERIAL_PORT = get_env("SERIAL_PORT", "/dev/ttyUSB0")
BAUDRATE = int(get_env("BAUDRATE", "115200"))
SERVER_PORT = int(get_env("SERVER_PORT", "8765"))
SERVER_HOST = get_env("SERVER_HOST", "localhost")
SERIAL_TIMEOUT = float(get_env("SERIAL_TIMEOUT", "1"))
SERIAL_RETRY_SECONDS = float(get_env("SERIAL_RETRY_SECONDS", "2"))
DATA_DIR = get_env("DATA_DIR", "data/acquisitions")
