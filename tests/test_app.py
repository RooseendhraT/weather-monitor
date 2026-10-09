import json
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import app


class WeatherServiceTests(unittest.TestCase):
    def test_location_search_encodes_query_and_normalizes_admin_areas(self):
        payload = {
            "results": [
                {
                    "id": 1,
                    "name": "Springfield",
                    "admin1": "Illinois",
                    "admin2": "Sangamon County",
                    "country": "United States",
                    "latitude": 39.8,
                    "longitude": -89.6,
                    "timezone": "America/Chicago",
                },
                {"name": "Invalid", "latitude": 91, "longitude": 0},
            ]
        }
        with patch.object(app, "fetch_json", return_value=payload) as fetch:
            result = app.search_locations(" Springfield, IL ")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["admin2"], "Sangamon County")
        self.assertEqual(result[0]["timezone"], "America/Chicago")
        self.assertEqual(parse_qs(urlparse(fetch.call_args.args[0]).query)["name"], ["Springfield, IL"])

    def test_location_search_skips_api_for_short_query(self):
        with patch.object(app, "fetch_json") as fetch:
            self.assertEqual(app.search_locations(" x "), [])
        fetch.assert_not_called()

    def test_forecast_requests_local_timezone_and_complete_fields(self):
        with patch.object(app, "fetch_json", return_value={"current": {}}) as fetch:
            result = app.get_forecast(40.7, -74.0)
        self.assertIn("current", result)
        params = parse_qs(urlparse(fetch.call_args.args[0]).query)
        self.assertEqual(params["timezone"], ["auto"])
        self.assertEqual(params["forecast_days"], ["7"])
        self.assertIn("wind_gusts_10m", params["current"][0])
        self.assertIn("visibility", params["hourly"][0])
        self.assertIn("sunrise", params["daily"][0])

    def test_forecast_rejects_out_of_range_coordinates(self):
        with self.assertRaises(ValueError):
            app.get_forecast(91, 0)

    def test_reverse_geocode_prefers_village_and_returns_admin_areas(self):
        payload = {
            "address": {
                "village": "Greenfield",
                "suburb": "Old Town",
                "city": "Sample City",
                "county": "Sample District",
                "state": "Sample State",
                "country": "Sample Country",
                "postcode": "12345",
            }
        }
        with patch.object(app, "fetch_json", return_value=payload) as fetch:
            result = app.reverse_geocode(12.3, 45.6)
        self.assertEqual(result["name"], "Greenfield")
        self.assertEqual(result["admin2"], "Sample District")
        self.assertEqual(result["admin1"], "Sample State")
        self.assertEqual(result["country"], "Sample Country")
        self.assertEqual(result["postcode"], "12345")
        params = parse_qs(urlparse(fetch.call_args.args[0]).query)
        self.assertEqual(params["zoom"], ["18"])
        self.assertEqual(params["addressdetails"], ["1"])
        self.assertEqual(fetch.call_args.args[1]["Accept-Language"], "en")

    def test_reverse_geocode_rejects_out_of_range_coordinates(self):
        with patch.object(app, "fetch_json") as fetch:
            with self.assertRaises(ValueError):
                app.reverse_geocode(0, 181)
        fetch.assert_not_called()

    def test_fetch_json_reports_upstream_error_payload(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps({"error": True, "reason": "Bad coordinates"}).encode()

        with patch.object(app, "urlopen", return_value=Response()):
            with self.assertRaisesRegex(app.WeatherServiceError, "Bad coordinates"):
                app.fetch_json("https://example.invalid/")


if __name__ == "__main__":
    unittest.main()
