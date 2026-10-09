# Weather Monitor

A responsive local weather dashboard powered by the public [Open-Meteo](https://open-meteo.com/) geocoding and forecast APIs. No API key, framework, or third-party Python package is required.

## Run locally

1. Install Python 3.9 or later.
2. From this folder, run:

   ```powershell
   python app.py
   ```

3. Open [http://127.0.0.1:8765](http://127.0.0.1:8765) in a browser. The app first tries an approximate location from your public IP, then defaults to New Delhi, India if lookup fails. Search globally for a city, locality, area, district, or country to change locations.
4. Stop the server with `Ctrl+C`.

Optional environment variables: `WEATHER_HOST` (defaults to `127.0.0.1`) and `WEATHER_PORT` (defaults to `8765`).

## Features

- Location search with regional/country disambiguation via Open-Meteo Geocoding.
- On startup the app attempts an **approximate network location** using FreeIPAPI (the location provider receives the browser's public IP address); no GPS permission prompt is shown. If that lookup fails, the forecast defaults to New Delhi, India. For a more precise device fix, select **Precise GPS location** and grant browser permission. Precise GPS requires a secure browser context (localhost is supported; deployed sites must use HTTPS). Device coordinates are used for weather and nearby-place lookup, not saved. Select a search result or choose **Stop live location** to stop following the device.
- Precise GPS coordinates are reverse-geocoded to the closest available village, hamlet, neighborhood, or locality name using OpenStreetMap Nominatim. The closest mapped name may not be the exact postal village if local map data is incomplete. Place names are © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
- Current conditions, apparent temperature, high/low, precipitation chance and total, humidity, wind direction/speed, gusts in forecasts, pressure, UV, visibility, cloud cover, sunrise and sunset.
- Three-hour-spaced hourly outlook for the next 24 hours and a seven-day forecast.
- Local timezone display, Celsius/Fahrenheit and km/h/mph toggles.
- Responsive layout, loading/error states, and refresh control.

Open-Meteo forecast values are model-derived estimates, not observations from a personal weather station. Forecast availability, update cadence, and accuracy vary by location and model. The app requests automatic timezone resolution and displays the service's local timestamps. API documentation: [Forecast API](https://open-meteo.com/en/docs) and [Geocoding API](https://open-meteo.com/en/docs/geocoding-api).

## Tests

Run the backend tests using the Python standard library:

```powershell
python -m unittest discover -s tests -v
```
