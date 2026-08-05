"""Bridges that let an IM client drive a local Friday workspace."""

from friday.im.bridge import FridayBridge
from friday.im.gateway_client import GatewayClient, GatewayError

__all__ = ["FridayBridge", "GatewayClient", "GatewayError"]
