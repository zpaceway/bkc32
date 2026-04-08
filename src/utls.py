import logging
import os


def get_env(key: str, default: str | None = None) -> str:
    value = os.getenv(key, default)

    if value is None:
        raise ValueError(
            f"Environment variable '{key}' is not set and no default value provided."
        )

    return value


def get_logger(name: str):
    logger = logging.getLogger(name)

    if not logger.hasHandlers():
        logger.setLevel(logging.DEBUG)
        logger.propagate = False

        handler = logging.StreamHandler()
        handler.setLevel(logging.DEBUG)

        formatter = logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )
        handler.setFormatter(formatter)

        logger.addHandler(handler)
        return logger

    return logger
