"""Backward-compatible entry point for the shared Friday app server."""

from friday.app_server import Gateway, main, verification_status

__all__ = ["Gateway", "main", "verification_status"]


if __name__ == "__main__":
    main()
