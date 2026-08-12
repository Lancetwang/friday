"""Friday general-purpose local CLI agent."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("friday-agent")
except PackageNotFoundError:
    __version__ = "0+unknown"
