const state = {
  location: null,
  weather: null,
  tempUnit: localStorage.getItem("weather-temp-unit") || "C",
  windUnit: localStorage.getItem("weather-wind-unit") || "kmh",
  timer: null,
  searchController: null,
  locationWatchId: null,
  lastDeviceLocation: null,
  deviceFixSequence: 0,
  startupController: null
};
let weatherSequence = 0;
let lastBrowserReverseRequest = 0;

const STATIC_API_URLS = {
  search: "https://geocoding-api.open-meteo.com/v1/search",
  weather: "https://api.open-meteo.com/v1/forecast",
  reverse: "https://api.bigdatacloud.net/data/reverse-geocode-client"
};

const STATIC_FORECAST_FIELDS = {
  current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
  hourly: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,visibility,uv_index,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
  daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,uv_index_max,precipitation_sum,rain_sum,showers_sum,snowfall_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant"
};

const $ = (id) => document.getElementById(id);

const weatherDescriptions = {
  0: ["Clear sky", "☀️"], 1: ["Mainly clear", "🌤️"], 2: ["Partly cloudy", "⛅"],
  3: ["Overcast", "☁️"], 45: ["Fog", "🌫️"], 48: ["Depositing rime fog", "🌫️"],
  51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Dense drizzle", "🌧️"],
  56: ["Freezing drizzle", "🌧️"], 57: ["Heavy freezing drizzle", "🌧️"],
  61: ["Light rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  66: ["Freezing rain", "🌧️"], 67: ["Heavy freezing rain", "🌧️"],
  71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "❄️"],
  77: ["Snow grains", "🌨️"], 80: ["Rain showers", "🌦️"], 81: ["Showers", "🌧️"],
  82: ["Heavy showers", "⛈️"], 85: ["Snow showers", "🌨️"], 86: ["Heavy snow showers", "❄️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm with hail", "⛈️"],
  99: ["Thunderstorm with heavy hail", "⛈️"]
};

function weatherForCode(code) {
  return weatherDescriptions[code] || ["Weather conditions", "🌤️"];
}
if (state.startupController) {
  state.startupController.abort();
  state.startupController = null;
}

function convertTemperature(value) {
  if (value == null || !Number.isFinite(Number(value))) return "--";
  const converted = state.tempUnit === "F" ? Number(value) * 9 / 5 + 32 : Number(value);
  return `${Math.round(converted)}°`;
}

async function initializeLocation() {
  const controller = new AbortController();
  state.startupController = controller;
  const timeout = setTimeout(() => controller.abort(), 7000);
  setStatus("Finding your approximate area without requesting GPS permission…", true);
  try {
    const result = await requestJson("https://freeipapi.com/api/json", controller.signal);
    const latitude = Number(result.latitude);
    const longitude = Number(result.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new Error("The network location service did not return valid coordinates.");
    }
    if (controller.signal.aborted || state.startupController !== controller) return;
    showLocation({
      latitude,
      longitude,
      name: result.cityName || result.regionName || result.countryName || "Nearby area",
      admin1: result.regionName || null,
      country: result.countryName || null,
      source: "network"
    });
  } catch {
    if (state.startupController !== controller) return;
    showLocation({
      latitude: 28.6139,
      longitude: 77.209,
      name: "New Delhi",
      admin1: "Delhi",
      country: "India",
      source: "fallback"
    });
    setStatus("Could not detect your approximate area. Showing New Delhi, India; search for a village, city, or district.");
  } finally {
    clearTimeout(timeout);
  }
  if (controller.signal.aborted || state.startupController !== controller) return;
  state.startupController = null;
  await loadWeather();
}

function convertWind(value) {
  if (value == null || !Number.isFinite(Number(value))) return "--";
  const converted = state.windUnit === "mph" ? Number(value) * 0.621371 : Number(value);
  return `${Math.round(converted)} ${state.windUnit}`;
}

function displayNumber(value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return "--";
  return Number(value).toFixed(digits);
}

function degreesToDirection(degrees) {
  if (!Number.isFinite(Number(degrees))) return "--";
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(Number(degrees) / 45) % 8];
}

function localDate(iso, options) {
  if (!iso) return "--";
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options }).format(date);
}

function localHour(iso) {
  if (!iso) return "--";
  const time = iso.includes("T") ? iso.slice(11, 16) : iso.slice(-5);
  const [hours, minutes] = time.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return time;
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    .format(new Date(Date.UTC(2020, 0, 1, hours, minutes)));
}

function readableDate(iso) {
  return localDate(`${iso}T12:00:00`, { weekday: "long", month: "long", day: "numeric" });
}

function setStatus(message = "", isLoading = false) {
  const status = $("status-message");
  status.hidden = !message;
  status.textContent = message;
  $("refresh-button").classList.toggle("loading", isLoading);
}

async function requestJson(url, signal) {
  if (window.location.hostname.endsWith(".github.io") && url.startsWith("/api/")) {
    const apiUrl = new URL(url, window.location.href);
    let remoteUrl;
    if (apiUrl.pathname === "/api/search") {
      const params = new URLSearchParams({
        name: apiUrl.searchParams.get("q") || "",
        count: "8",
        language: "en",
        format: "json"
      });
      remoteUrl = `${STATIC_API_URLS.search}?${params}`;
    } else if (apiUrl.pathname === "/api/weather") {
      const params = new URLSearchParams({
        latitude: apiUrl.searchParams.get("lat") || "",
        longitude: apiUrl.searchParams.get("lon") || "",
        current: STATIC_FORECAST_FIELDS.current,
        hourly: STATIC_FORECAST_FIELDS.hourly,
        daily: STATIC_FORECAST_FIELDS.daily,
        forecast_days: "7",
        timezone: "auto",
        wind_speed_unit: "kmh",
        precipitation_unit: "mm"
      });
      remoteUrl = `${STATIC_API_URLS.weather}?${params}`;
    } else if (apiUrl.pathname === "/api/reverse") {
      const elapsed = Date.now() - lastBrowserReverseRequest;
      if (elapsed < 1100) await new Promise((resolve) => setTimeout(resolve, 1100 - elapsed));
      if (signal?.aborted) throw new DOMException("Request was aborted.", "AbortError");
      lastBrowserReverseRequest = Date.now();
      const params = new URLSearchParams({
        latitude: apiUrl.searchParams.get("lat") || "",
        longitude: apiUrl.searchParams.get("lon") || "",
        localityLanguage: "en"
      });
      remoteUrl = `${STATIC_API_URLS.reverse}?${params}`;
    } else {
      throw new Error("This API endpoint is not available on the static website.");
    }

    const response = await fetch(remoteUrl, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.reason || data.error || `Request failed (${response.status}).`);
    if (apiUrl.pathname === "/api/reverse") {
      const administrative = data.localityInfo?.administrative || [];
      const district = administrative.find((area) => /\bdistrict\b/i.test(area.description || ""));
      return {
        name: data.locality || data.city || "Current location",
        admin2: district?.name?.replace(/\s+district$/i, "") || data.city || undefined,
        admin1: data.principalSubdivision || undefined,
        country: data.countryName || undefined,
        postcode: data.postcode || undefined
      };
    }
    return data;
  }

  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function locationDetail(location) {
  if (location.source === "device") {
    const area = [location.admin2, location.admin1, location.country].filter((part, index, all) => part && all.indexOf(part) === index).join(", ");
    return `Precise GPS${area ? ` · ${area}` : ""} · ${Number(location.latitude).toFixed(4)}°, ${Number(location.longitude).toFixed(4)}°`;
  }
  if (location.source === "network") {
    const area = [location.admin1, location.country].filter(Boolean).join(", ");
    return `Approximate internet location${area ? ` · ${area}` : ""}`;
  }
  if (location.source === "fallback") {
    return "India fallback · search for a more specific place";
  }
  return [location.admin1, location.admin2, location.country].filter((part, index, all) => part && all.indexOf(part) === index).join(", ");
}

let searchSequence = 0;
async function searchLocations(query) {
  const sequence = ++searchSequence;
  if (state.searchController) state.searchController.abort();
  state.searchController = new AbortController();
  const panel = $("search-results");
  if (query.trim().length < 2) {
    panel.hidden = true;
    return;
  }
  panel.innerHTML = '<div class="result-option"><span class="result-text"><small>Searching locations…</small></span></div>';
  panel.hidden = false;
  try {
    const data = await requestJson(`/api/search?q=${encodeURIComponent(query.trim())}`, state.searchController.signal);
    if (sequence !== searchSequence) return;
    if (!data.results.length) {
      panel.innerHTML = '<div class="result-option"><span class="result-text"><small>No matching places found. Try a nearby city or district.</small></span></div>';
      return;
    }
    panel.replaceChildren(...data.results.map((location) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result-option";
      button.setAttribute("role", "option");
      button.innerHTML = `<span class="result-pin">⌖</span><span class="result-text"><strong></strong><small></small></span>`;
      button.querySelector("strong").textContent = location.name;
      button.querySelector("small").textContent = locationDetail(location) || "Location";
      button.addEventListener("click", () => selectLocation(location));
      return button;
    }));
  } catch (error) {
    if (error.name === "AbortError" || sequence !== searchSequence) return;
    panel.innerHTML = '<div class="result-option"><span class="result-text"><small>Location search is unavailable. Check your connection and try again.</small></span></div>';
  }
}

function stopDeviceLocation() {
  if (state.locationWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.locationWatchId);
  }
  state.locationWatchId = null;
  state.lastDeviceLocation = null;
  state.deviceFixSequence++;
  $("location-button").disabled = false;
  $("location-button").setAttribute("aria-pressed", "false");
  $("location-button").querySelector("span").textContent = "Precise GPS location";
}

function showLocation(location) {
  state.location = location;
  $("search-results").hidden = true;
  $("empty-state").hidden = true;
  $("weather-content").hidden = false;
  $("sidebar-city").textContent = location.name;
  $("sidebar-region").textContent = locationDetail(location) || "Selected location";
  $("breadcrumb-city").textContent = location.name;
  $("location-line").textContent = [location.name, location.admin2, location.admin1, location.country].filter(Boolean).filter((part, index, all) => all.indexOf(part) === index).join(", ");
  $("coordinates").textContent = `${Number(location.latitude).toFixed(2)}°, ${Number(location.longitude).toFixed(2)}°`;
}

async function selectLocation(location) {
  if (state.startupController) {
    state.startupController.abort();
    state.startupController = null;
  }
  stopDeviceLocation();
  $("location-search").value = `${location.name}${location.country ? `, ${location.country}` : ""}`;
  showLocation(location);
  await loadWeather();
}

async function reverseDeviceLocation(coords, fixSequence) {
  try {
    const address = await requestJson(`/api/reverse?lat=${encodeURIComponent(coords.latitude)}&lon=${encodeURIComponent(coords.longitude)}`);
    if (fixSequence !== state.deviceFixSequence || state.location?.source !== "device") return;
    const location = { ...state.location, ...address, source: "device", resolved: true };
    showLocation(location);
  } catch {
    if (fixSequence !== state.deviceFixSequence || state.location?.source !== "device") return;
    setStatus("Weather is available, but the nearby village or area name could not be found. Showing your GPS coordinates instead.");
  }
}

function distanceInKm(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const value = Math.min(1, Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude))
    * Math.sin(longitudeDelta / 2) ** 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function locationErrorMessage(error) {
  if (error.code === 1) return "Location permission was denied. Allow location access for this site in your browser settings, then try again.";
  if (error.code === 2) return "Your device could not determine its location. Check that location services are turned on and try again.";
  if (error.code === 3) return "Finding your location timed out. Check that location services are available and try again.";
  return "Your location is unavailable. Check your browser permission and device location settings, then try again.";
}

function toggleDeviceLocation() {
  if (state.locationWatchId !== null) {
    stopDeviceLocation();
    setStatus("Live location is off. Your last forecast remains on screen.");
    return;
  }
  if (!navigator.geolocation) {
    setStatus("This browser does not provide location access. Try a current version of Chrome, Edge, Firefox, or Safari.");
    return;
  }
  $("location-button").disabled = false;
  $("location-button").setAttribute("aria-pressed", "true");
  $("location-button").querySelector("span").textContent = "Finding your location…";
  setStatus("Requesting location permission. Allow access in the browser prompt to load your local forecast.", true);
  state.locationWatchId = navigator.geolocation.watchPosition((position) => {
    const coords = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude
    };
    if (state.lastDeviceLocation && distanceInKm(state.lastDeviceLocation, coords) < 1) return;
    state.lastDeviceLocation = coords;
    const location = { ...coords, name: "Finding nearby area…", source: "device" };
    const fixSequence = ++state.deviceFixSequence;
    $("location-button").querySelector("span").textContent = "Stop live location";
    $("location-search").value = "";
    showLocation(location);
    setStatus("", true);
    loadWeather();
    reverseDeviceLocation(coords, fixSequence);
  }, (error) => {
    stopDeviceLocation();
    setStatus(locationErrorMessage(error));
  }, {
    enableHighAccuracy: true,
    maximumAge: 30000,
    timeout: 20000
  });
}

function selectedHourIndex(hours, currentTime) {
  let match = hours.time.findIndex((time) => time >= currentTime);
  return match < 0 ? 0 : match;
}

async function loadWeather() {
  if (!state.location) return;
  const sequence = ++weatherSequence;
  setStatus("", true);
  try {
    const data = await requestJson(`/api/weather?lat=${encodeURIComponent(state.location.latitude)}&lon=${encodeURIComponent(state.location.longitude)}`);
    if (sequence !== weatherSequence) return;
    state.weather = data;
    renderWeather();
    setStatus("");
  } catch (error) {
    if (sequence !== weatherSequence) return;
    setStatus(`${error.message} Your selected location is saved; refresh to try again.`);
  }
}

function renderWeather() {
  const data = state.weather;
  if (!data?.current || !data?.daily || !data?.hourly) {
    setStatus("The weather service returned incomplete forecast data. Please refresh and try again.");
    return;
  }
  const current = data.current;
  const daily = data.daily;
  const hourly = data.hourly;
  const today = 0;
  const [description, icon] = weatherForCode(current.weather_code);
  $("current-date").textContent = readableDate(current.time.slice(0, 10));
  $("local-time").textContent = `${localHour(current.time)} local time`;
  $("current-temperature").textContent = convertTemperature(current.temperature_2m);
  $("current-condition").textContent = description;
  $("feels-like").textContent = `Feels like ${convertTemperature(current.apparent_temperature)}`;
  $("weather-art").textContent = icon;
  $("today-high").textContent = convertTemperature(daily.temperature_2m_max?.[today]);
  $("today-low").textContent = convertTemperature(daily.temperature_2m_min?.[today]);
  $("today-rain").textContent = `${displayNumber(daily.precipitation_probability_max?.[today])}%`;
  $("humidity").textContent = `${displayNumber(current.relative_humidity_2m)}%`;
  $("humidity-meter").style.width = `${Math.max(0, Math.min(100, Number(current.relative_humidity_2m) || 0))}%`;
  const windValue = Number(current.wind_speed_10m);
  $("wind").textContent = convertWind(windValue);
  const direction = degreesToDirection(current.wind_direction_10m);
  $("wind-direction").textContent = `From ${direction} · gusts ${convertWind(current.wind_gusts_10m)}`;
  $("wind-arrow").style.transform = `rotate(${(Number(current.wind_direction_10m) || 0) + 180}deg)`;
  $("feels-detail").textContent = convertTemperature(current.apparent_temperature);
  $("feels-note").textContent = `${Number(current.apparent_temperature) > Number(current.temperature_2m) ? "Warmer" : "Cooler"} than actual`;
  $("comfort-marker").style.left = `${Math.max(3, Math.min(97, ((Number(current.temperature_2m) + 10) / 45) * 100))}%`;
  const currentHour = selectedHourIndex(hourly, current.time);
  const uv = hourly.uv_index?.[currentHour] ?? daily.uv_index_max?.[today];
  $("uv-index").textContent = displayNumber(uv, 1);
  $("uv-note").textContent = uvLabel(Number(uv));
  $("uv-meter").style.left = `${Math.max(0, Math.min(100, (Number(uv) / 11) * 100))}%`;
  const visibilityKm = Number(hourly.visibility?.[currentHour]) / 1000;
  $("visibility").textContent = Number.isFinite(visibilityKm) ? `${displayNumber(visibilityKm, 1)} km` : "--";
  $("pressure").textContent = `${displayNumber(current.pressure_msl)} hPa`;
  const rainToday = daily.precipitation_sum?.[today];
  $("precipitation").textContent = rainToday == null ? `${displayNumber(current.precipitation, 1)} mm` : `${displayNumber(rainToday, 1)} mm`;
  $("precipitation-note").textContent = rainToday == null ? "Current precipitation" : "Forecast total today";
  const rainProgress = Math.max(0, Math.min(9, Math.round(Number(rainToday || current.precipitation || 0) * 1.5)));
  document.querySelectorAll(".rain-dots i").forEach((dot, index) => dot.classList.toggle("filled", index < rainProgress));
  $("cloud-cover").textContent = `${displayNumber(current.cloud_cover)}%`;
  $("cloud-meter").style.width = `${Math.max(0, Math.min(100, Number(current.cloud_cover) || 0))}%`;
  const sunrise = daily.sunrise?.[today];
  const sunset = daily.sunset?.[today];
  const sunriseText = localHour(sunrise);
  const sunsetText = localHour(sunset);
  $("sunrise-time").textContent = sunriseText;
  $("sunset-time").textContent = sunsetText;
  $("sunrise-time-bottom").textContent = sunriseText;
  $("sunset-time-bottom").textContent = sunsetText;
  if (sunrise && sunset) {
    const daylightMinutes = Math.round((new Date(sunset) - new Date(sunrise)) / 60000);
    $("daylight-duration").textContent = `${Math.floor(daylightMinutes / 60)}h ${daylightMinutes % 60}m`;
  } else {
    $("daylight-duration").textContent = "--";
  }
  $("updated-time").textContent = `Updated ${localHour(current.time)}`;
  renderHourly(hourly, current.time);
  renderDaily(daily);
}

function uvLabel(value) {
  if (!Number.isFinite(value)) return "UV intensity";
  if (value < 3) return "Low · minimal protection";
  if (value < 6) return "Moderate · seek shade";
  if (value < 8) return "High · protection needed";
  if (value < 11) return "Very high · extra care";
  return "Extreme · avoid midday sun";
}

function renderHourly(hourly, currentTime) {
  const start = selectedHourIndex(hourly, currentTime);
  const items = [];
  for (let offset = 0; offset < 8; offset++) {
    const index = start + offset * 3;
    if (!hourly.time[index]) break;
    const [condition, icon] = weatherForCode(hourly.weather_code?.[index]);
    const label = offset === 0 ? "Now" : localHour(hourly.time[index]);
    const rainChance = hourly.precipitation_probability?.[index];
    items.push(`<div class="hour-item"><div class="hour-time">${label}</div><div class="hour-icon" title="${condition}">${icon}</div><div class="hour-temp">${convertTemperature(hourly.temperature_2m?.[index])}</div><div class="hour-rain">☂ ${displayNumber(rainChance)}%</div></div>`);
  }
  $("hourly-list").innerHTML = items.join("");
}

function renderDaily(daily) {
  const rows = daily.time.map((date, index) => {
    const [condition, icon] = weatherForCode(daily.weather_code?.[index]);
    const dayName = index === 0 ? "Today" : localDate(`${date}T12:00:00`, { weekday: "short" });
    return `<div class="day-row"><span class="day-name">${dayName}</span><span class="day-condition" title="${condition}"><span>${icon}</span>${condition}</span><span class="day-range"><strong>${convertTemperature(daily.temperature_2m_min?.[index])}</strong><i class="range-bar"></i><strong>${convertTemperature(daily.temperature_2m_max?.[index])}</strong></span><span class="day-rain">☂ ${displayNumber(daily.precipitation_probability_max?.[index])}%</span><span class="day-wind" title="Maximum wind speed / gusts">↗ ${convertWind(daily.wind_speed_10m_max?.[index])} · ${convertWind(daily.wind_gusts_10m_max?.[index])}</span><span class="day-uv">UV ${displayNumber(daily.uv_index_max?.[index], 1)}</span></div>`;
  });
  $("daily-list").innerHTML = rows.join("");
}

function rerenderIfAvailable() {
  if (state.weather) renderWeather();
}

$("location-search").addEventListener("input", (event) => {
  if (state.startupController) {
    state.startupController.abort();
    state.startupController = null;
  }
  clearTimeout(state.timer);
  const query = event.target.value;
  state.timer = setTimeout(() => searchLocations(query), 250);
});
$("location-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("search-results").hidden = true;
  if (event.key === "Enter") {
    const firstResult = $("search-results").querySelector(".result-option");
    if (firstResult && !$("search-results").hidden) firstResult.click();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-wrap")) $("search-results").hidden = true;
});
$("focus-search").addEventListener("click", () => $("location-search").focus());
$("refresh-button").addEventListener("click", loadWeather);
$("location-button").addEventListener("click", toggleDeviceLocation);
document.querySelectorAll("[data-temp-unit]").forEach((button) => button.addEventListener("click", () => {
  state.tempUnit = button.dataset.tempUnit;
  localStorage.setItem("weather-temp-unit", state.tempUnit);
  document.querySelectorAll("[data-temp-unit]").forEach((item) => item.classList.toggle("selected", item === button));
  rerenderIfAvailable();
}));
document.querySelectorAll("[data-wind-unit]").forEach((button) => button.addEventListener("click", () => {
  state.windUnit = button.dataset.windUnit;
  localStorage.setItem("weather-wind-unit", state.windUnit);
  document.querySelectorAll("[data-wind-unit]").forEach((item) => item.classList.toggle("selected", item === button));
  rerenderIfAvailable();
}));
document.querySelector(`[data-temp-unit="${state.tempUnit}"]`)?.classList.add("selected");
document.querySelector(`[data-wind-unit="${state.windUnit}"]`)?.classList.add("selected");

initializeLocation();
