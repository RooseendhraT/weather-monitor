"""Local weather monitor backed by the Open-Meteo public APIs."""

from __future__ import annotations

import json
import math
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("WEATHER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WEATHER_PORT", "8765"))
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
REVERSE_GEOCODING_URL = "https://nominatim.openstreetmap.org/reverse"
_reverse_request_lock = threading.Lock()
_last_reverse_request = 0.0

CURRENT_FIELDS = (
    "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,"
    "precipitation,rain,showers,snowfall,weather_code,cloud_cover,"
    "pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,"
    "wind_gusts_10m"
)
HOURLY_FIELDS = (
    "temperature_2m,relative_humidity_2m,apparent_temperature,"
    "precipitation_probability,precipitation,rain,showers,snowfall,"
    "weather_code,cloud_cover,pressure_msl,visibility,uv_index,"
    "wind_speed_10m,wind_direction_10m,wind_gusts_10m"
)
DAILY_FIELDS = (
    "weather_code,temperature_2m_max,temperature_2m_min,"
    "apparent_temperature_max,apparent_temperature_min,sunrise,sunset,"
    "uv_index_max,precipitation_sum,rain_sum,showers_sum,snowfall_sum,"
    "precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,"
    "wind_direction_10m_dominant"
)


class WeatherServiceError(Exception):
    """An upstream weather or geocoding service returned an error."""


def fetch_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    request_headers = {"User-Agent": "WeatherMonitor/1.0 (local weather dashboard)"}
    if headers:
        request_headers.update(headers)
    request = Request(url, headers=request_headers)
    try:
        with urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise WeatherServiceError("Weather data could not be reached. Please try again.") from exc
    if not isinstance(payload, dict):
        raise WeatherServiceError("The weather service returned an invalid response.")
    if payload.get("error"):
        raise WeatherServiceError(str(payload.get("reason", "The weather service returned an error.")))
    return payload


def search_locations(query: str) -> list[dict[str, Any]]:
    query = query.strip()
    if len(query) < 2:
        return []
    params = urlencode({"name": query, "count": 8, "language": "en", "format": "json"})
    response = fetch_json(f"{GEOCODING_URL}?{params}")
    results = []
    for item in response.get("results", []):
        try:
            latitude = float(item["latitude"])
            longitude = float(item["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not valid_coordinates(latitude, longitude):
            continue
        results.append(
            {
                "id": item.get("id"),
                "name": item.get("name", "Unknown location"),
                "admin1": item.get("admin1"),
                "admin2": item.get("admin2"),
                "country": item.get("country"),
                "country_code": item.get("country_code"),
                "latitude": latitude,
                "longitude": longitude,
                "timezone": item.get("timezone", "auto"),
                "population": item.get("population"),
            }
        )
    return results


def valid_coordinates(latitude: float, longitude: float) -> bool:
    return (
        math.isfinite(latitude)
        and math.isfinite(longitude)
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
    )


def get_forecast(latitude: float, longitude: float) -> dict[str, Any]:
    if not valid_coordinates(latitude, longitude):
        raise ValueError("Latitude or longitude is outside the valid range.")
    params = urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "current": CURRENT_FIELDS,
            "hourly": HOURLY_FIELDS,
            "daily": DAILY_FIELDS,
            "forecast_days": 7,
            "timezone": "auto",
            "wind_speed_unit": "kmh",
            "precipitation_unit": "mm",
        }
    )
    return fetch_json(f"{FORECAST_URL}?{params}")


def reverse_geocode(latitude: float, longitude: float) -> dict[str, Any]:
    if not valid_coordinates(latitude, longitude):
        raise ValueError("Latitude or longitude is outside the valid range.")
    global _last_reverse_request
    with _reverse_request_lock:
        wait = 1.0 - (time.monotonic() - _last_reverse_request)
        if wait > 0:
            time.sleep(wait)
        _last_reverse_request = time.monotonic()

    params = urlencode(
        {
            "format": "jsonv2",
            "lat": latitude,
            "lon": longitude,
            "zoom": 18,
            "addressdetails": 1,
        }
    )
    result = fetch_json(
        f"{REVERSE_GEOCODING_URL}?{params}",
        {"Accept-Language": "en"},
    )
    address = result.get("address", {})
    if not isinstance(address, dict):
        address = {}
    locality = next(
        (
            address[key]
            for key in (
                "village",
                "hamlet",
                "isolated_dwelling",
                "neighbourhood",
                "suburb",
                "quarter",
                "town",
                "city_district",
                "city",
                "municipality",
            )
            if address.get(key)
        ),
        None,
    )
    return {
        "name": locality or "Current location",
        "admin2": address.get("county") or address.get("state_district"),
        "admin1": address.get("state") or address.get("province"),
        "country": address.get("country"),
        "postcode": address.get("postcode"),
    }


class WeatherHandler(BaseHTTPRequestHandler):
    server_version = "WeatherMonitor/1.0"

    def send_json(self, status: int, data: dict[str, Any]) -> None:
        encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/search":
                query = params.get("q", [""])[0]
                if len(query.strip()) > 120:
                    self.send_json(400, {"error": "Search text must be 120 characters or fewer."})
                    return
                self.send_json(200, {"results": search_locations(query)})
                return
            if parsed.path == "/api/weather":
                try:
                    latitude = float(params.get("lat", [""])[0])
                    longitude = float(params.get("lon", [""])[0])
                except ValueError:
                    self.send_json(400, {"error": "A valid latitude and longitude are required."})
                    return
                if not valid_coordinates(latitude, longitude):
                    self.send_json(400, {"error": "Latitude or longitude is outside the valid range."})
                    return
                self.send_json(200, get_forecast(latitude, longitude))
                return
            if parsed.path == "/api/reverse":
                try:
                    latitude = float(params.get("lat", [""])[0])
                    longitude = float(params.get("lon", [""])[0])
                except ValueError:
                    self.send_json(400, {"error": "A valid latitude and longitude are required."})
                    return
                if not valid_coordinates(latitude, longitude):
                    self.send_json(400, {"error": "Latitude or longitude is outside the valid range."})
                    return
                self.send_json(200, reverse_geocode(latitude, longitude))
                return
            if parsed.path.startswith("/api/"):
                self.send_json(404, {"error": "API endpoint not found."})
                return
            self.serve_static(parsed.path)
        except WeatherServiceError as exc:
            self.send_json(502, {"error": str(exc)})
        except (ValueError, TypeError) as exc:
            self.send_json(400, {"error": str(exc)})

    def serve_static(self, requested_path: str) -> None:
        relative_path = "index.html" if requested_path in ("", "/") else requested_path.lstrip("/")
        target = (ROOT / relative_path).resolve()
        if ROOT not in target.parents and target != ROOT:
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404)
            return
        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }
        content = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_types.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"{self.log_date_time_string()} - {format_string % args}")


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), WeatherHandler)
    print(f"Weather Monitor is running at http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Weather Monitor.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
