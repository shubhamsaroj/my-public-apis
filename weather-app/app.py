import truststore

truststore.inject_into_ssl()

import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
REVERSE_GEOCODE_URL = "https://nominatim.openstreetmap.org/reverse"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
NOMINATIM_HEADERS = {"User-Agent": "ad-free-weather-app/1.0 (personal project)"}

WIND_DIRECTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def compass(degrees):
    return WIND_DIRECTIONS[round(degrees / 22.5) % 16]


def aqi_label(us_aqi):
    if us_aqi is None:
        return "Unknown"
    if us_aqi <= 50:
        return "Good"
    if us_aqi <= 100:
        return "Moderate"
    if us_aqi <= 150:
        return "Unhealthy for sensitive groups"
    if us_aqi <= 200:
        return "Unhealthy"
    if us_aqi <= 300:
        return "Very unhealthy"
    return "Hazardous"

WEATHER_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Freezing fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow",
    80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/search")
def search_city():
    name = request.args.get("q", "").strip()
    if not name:
        return jsonify({"results": []})
    r = requests.get(GEOCODE_URL, params={"name": name, "count": 5}, timeout=10)
    r.raise_for_status()
    data = r.json()
    results = [
        {
            "name": item["name"],
            "country": item.get("country", ""),
            "admin1": item.get("admin1", ""),
            "admin2": item.get("admin2", ""),
            "latitude": item["latitude"],
            "longitude": item["longitude"],
        }
        for item in data.get("results", [])
    ]
    return jsonify({"results": results})


@app.route("/api/reverse-geocode")
def reverse_geocode():
    lat = request.args.get("lat")
    lon = request.args.get("lon")
    if not lat or not lon:
        return jsonify({"error": "lat and lon are required"}), 400

    r = requests.get(
        REVERSE_GEOCODE_URL,
        params={"format": "json", "lat": lat, "lon": lon, "zoom": 14},
        headers=NOMINATIM_HEADERS,
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    address = data.get("address", {})
    name = (
        address.get("village")
        or address.get("town")
        or address.get("city")
        or address.get("suburb")
        or data.get("name")
        or "Your location"
    )
    admin1 = address.get("state", "")
    admin2 = address.get("state_district", "")
    country = address.get("country", "")
    return jsonify({"name": name, "admin1": admin1, "admin2": admin2, "country": country})


@app.route("/api/weather")
def weather():
    lat = request.args.get("lat")
    lon = request.args.get("lon")
    if not lat or not lon:
        return jsonify({"error": "lat and lon are required"}), 400

    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,"
                    "wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,uv_index",
        "hourly": "temperature_2m,weather_code,precipitation_probability,wind_speed_10m,"
                  "wind_direction_10m,uv_index,surface_pressure",
        "daily": "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,"
                 "sunrise,sunset,uv_index_max,wind_speed_10m_max,wind_direction_10m_dominant",
        "timezone": "auto",
        "forecast_days": 8,
    }
    r = requests.get(FORECAST_URL, params=params, timeout=10)
    r.raise_for_status()
    data = r.json()

    aq_params = {
        "latitude": lat,
        "longitude": lon,
        "current": "pm2_5,pm10,us_aqi,european_aqi",
        "hourly": "pm2_5,pm10,us_aqi,european_aqi",
        "timezone": "auto",
        "forecast_days": 7,
    }
    aq_current = {}
    aq_hourly_by_time = {}
    try:
        aq_r = requests.get(AIR_QUALITY_URL, params=aq_params, timeout=10)
        aq_r.raise_for_status()
        aq_data = aq_r.json()
        aq_current = aq_data.get("current", {})
        aq_hourly = aq_data.get("hourly", {})
        aq_hourly_by_time = {
            aq_hourly["time"][i]: {
                "us_aqi": aq_hourly["us_aqi"][i],
                "pm2_5": aq_hourly["pm2_5"][i],
                "pm10": aq_hourly["pm10"][i],
            }
            for i in range(len(aq_hourly.get("time", [])))
        }
    except requests.RequestException:
        aq_current = {}

    current = data["current"]
    current["description"] = WEATHER_CODES.get(current["weather_code"], "Unknown")
    current["wind_direction_compass"] = compass(current["wind_direction_10m"])
    current["air_quality"] = {
        "us_aqi": aq_current.get("us_aqi"),
        "european_aqi": aq_current.get("european_aqi"),
        "pm2_5": aq_current.get("pm2_5"),
        "pm10": aq_current.get("pm10"),
        "label": aqi_label(aq_current.get("us_aqi")),
    }

    hourly = data["hourly"]
    hourly_forecast = [
        {
            "time": hourly["time"][i],
            "temperature": hourly["temperature_2m"][i],
            "precipitation_probability": hourly["precipitation_probability"][i],
            "description": WEATHER_CODES.get(hourly["weather_code"][i], "Unknown"),
            "wind_speed": hourly["wind_speed_10m"][i],
            "wind_direction_compass": compass(hourly["wind_direction_10m"][i]),
            "uv_index": hourly["uv_index"][i],
            "pressure": hourly["surface_pressure"][i],
            "us_aqi": aq_hourly_by_time.get(hourly["time"][i], {}).get("us_aqi"),
            "pm2_5": aq_hourly_by_time.get(hourly["time"][i], {}).get("pm2_5"),
        }
        for i in range(len(hourly["time"]))
    ]

    def avg_aqi_for_date(date_str):
        values = [v["us_aqi"] for k, v in aq_hourly_by_time.items() if k.startswith(date_str) and v["us_aqi"] is not None]
        return round(sum(values) / len(values)) if values else None

    daily = data["daily"]
    daily_forecast = [
        {
            "date": daily["time"][i],
            "temp_max": daily["temperature_2m_max"][i],
            "temp_min": daily["temperature_2m_min"][i],
            "precipitation_probability": daily["precipitation_probability_max"][i],
            "description": WEATHER_CODES.get(daily["weather_code"][i], "Unknown"),
            "sunrise": daily["sunrise"][i],
            "sunset": daily["sunset"][i],
            "uv_index_max": daily["uv_index_max"][i],
            "wind_speed_max": daily["wind_speed_10m_max"][i],
            "wind_direction_compass": compass(daily["wind_direction_10m_dominant"][i]),
            "us_aqi": (aqi := avg_aqi_for_date(daily["time"][i])),
            "us_aqi_label": aqi_label(aqi),
        }
        for i in range(len(daily["time"]))
    ]

    return jsonify({
        "timezone": data["timezone"],
        "current": current,
        "hourly": hourly_forecast,
        "daily": daily_forecast,
    })


if __name__ == "__main__":
    app.run(debug=True, port=5001)
