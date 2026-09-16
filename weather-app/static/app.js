const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const content = document.getElementById("content");
const emptyState = document.getElementById("empty-state");
const locateBtn = document.getElementById("locate-btn");
const locateError = document.getElementById("locate-error");

let debounceTimer = null;

searchInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const query = searchInput.value.trim();
  if (!query) {
    searchResults.innerHTML = "";
    return;
  }
  debounceTimer = setTimeout(() => runSearch(query), 300);
});

document.addEventListener("click", (e) => {
  if (!searchResults.contains(e.target) && e.target !== searchInput) {
    searchResults.innerHTML = "";
  }
});

async function runSearch(query) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  searchResults.innerHTML = "";
  data.results.forEach((place) => {
    const div = document.createElement("div");
    div.className = "result-item";
    const region = [place.admin2, place.admin1, place.country].filter(Boolean).join(", ");
    div.textContent = region ? `${place.name} — ${region}` : place.name;
    div.addEventListener("click", () => selectPlace(place));
    searchResults.appendChild(div);
  });
}

locateBtn.addEventListener("click", () => {
  locateError.classList.add("hidden");
  if (!navigator.geolocation) {
    showLocateError("Geolocation is not supported by this browser.");
    return;
  }
  locateBtn.textContent = "Locating...";
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      try {
        const res = await fetch(`/api/reverse-geocode?lat=${latitude}&lon=${longitude}`);
        const place = await res.json();
        place.latitude = latitude;
        place.longitude = longitude;
        searchInput.value = place.name;
        await selectPlace(place);
      } catch (err) {
        showLocateError("Could not determine your location name, showing weather anyway.");
        await selectPlace({ name: "Your location", latitude, longitude });
      } finally {
        locateBtn.textContent = "📍 Use my location";
      }
    },
    (err) => {
      locateBtn.textContent = "📍 Use my location";
      showLocateError("Location access denied or unavailable. Please allow location access or search manually.");
    }
  );
});

function showLocateError(message) {
  locateError.textContent = message;
  locateError.classList.remove("hidden");
}

let hourlyChart = null;
let uvChart = null;
let weatherData = null;
let selectedDate = null;

const hourlyDateLabel = document.getElementById("hourly-date");
const backToTodayBtn = document.getElementById("back-to-today");
backToTodayBtn.addEventListener("click", () => showDayHourly(weatherData.daily[0].date));

async function selectPlace(place) {
  searchResults.innerHTML = "";
  searchInput.value = place.name;
  const res = await fetch(`/api/weather?lat=${place.latitude}&lon=${place.longitude}`);
  const data = await res.json();
  renderWeather(place, data);
}

function renderWeather(place, data) {
  emptyState.classList.add("hidden");
  content.classList.remove("hidden");
  weatherData = data;

  const region = [place.admin1, place.country].filter(Boolean).join(", ");
  document.getElementById("location-name").textContent = region ? `${place.name}, ${region}` : place.name;

  const c = data.current;
  document.getElementById("current-temp").textContent = `${Math.round(c.temperature_2m)}°C`;
  document.getElementById("current-desc").textContent = c.description;
  document.getElementById("feels-like").textContent = `Feels like ${Math.round(c.apparent_temperature)}°C`;
  document.getElementById("humidity").textContent = `Humidity ${c.relative_humidity_2m}%`;
  document.getElementById("wind").textContent = `Wind ${Math.round(c.wind_speed_10m)} km/h ${c.wind_direction_compass}`;
  document.getElementById("pressure").textContent = `Pressure ${Math.round(c.surface_pressure)} hPa`;

  document.getElementById("uv-value").textContent = c.uv_index != null ? c.uv_index.toFixed(1) : "-";
  document.getElementById("uv-label").textContent = uvLabel(c.uv_index);

  const dailyList = document.getElementById("daily-list");
  dailyList.innerHTML = "";
  data.daily.slice(1).forEach((d) => {
    const div = document.createElement("div");
    div.className = "daily-item";
    div.dataset.date = d.date;
    const date = new Date(d.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    div.innerHTML = `
      <div class="date">${date}</div>
      <div class="desc">${d.description}</div>
      <div class="range">${Math.round(d.temp_min)}° / ${Math.round(d.temp_max)}°</div>
    `;
    div.addEventListener("click", () => showDayHourly(d.date));
    dailyList.appendChild(div);
  });

  showDayHourly(data.daily[0].date);
}

function renderDayCards(day) {
  if (!day) return;
  const sunrise = new Date(day.sunrise).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sunset = new Date(day.sunset).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  document.getElementById("sun-value").textContent = `${sunrise} / ${sunset}`;

  document.getElementById("aqi-value").textContent = day.us_aqi ?? "-";
  document.getElementById("aqi-label").textContent = day.us_aqi != null ? day.us_aqi_label : "Unavailable";
}

function showDayHourly(dateStr) {
  selectedDate = dateStr;
  const isToday = dateStr === weatherData.daily[0].date;
  const dayHours = weatherData.hourly.filter((h) => h.time.startsWith(dateStr));

  const dayInfo = weatherData.daily.find((d) => d.date === dateStr);
  renderDayCards(dayInfo);

  const label = new Date(dateStr).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  hourlyDateLabel.textContent = isToday ? `Today, ${label}` : label;
  backToTodayBtn.classList.toggle("hidden", isToday);

  document.querySelectorAll(".daily-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.date === dateStr);
  });

  renderHourlyChart(dayHours);
  renderUvChart(dayHours);

  const hourlyList = document.getElementById("hourly-list");
  hourlyList.innerHTML = "";
  dayHours.forEach((h) => {
    const div = document.createElement("div");
    div.className = "hourly-item";
    const time = new Date(h.time).toLocaleTimeString([], { hour: "2-digit" });
    div.innerHTML = `
      <div class="time">${time}</div>
      <div class="temp">${Math.round(h.temperature)}°</div>
      <div class="rain">${h.precipitation_probability}%</div>
    `;
    div.addEventListener("click", () => openHourlyDetail(h));
    hourlyList.appendChild(div);
  });

  document.querySelector(".hourly").scrollIntoView({ behavior: "smooth", block: "start" });
}

function uvLabel(uv) {
  if (uv == null) return "-";
  if (uv < 3) return "Low";
  if (uv < 6) return "Moderate";
  if (uv < 8) return "High";
  if (uv < 11) return "Very high";
  return "Extreme";
}

function renderHourlyChart(hourly) {
  const canvas = document.getElementById("hourly-chart");
  const labels = hourly.map((h) => new Date(h.time).toLocaleTimeString([], { hour: "2-digit" }));
  const temps = hourly.map((h) => h.temperature);
  const rain = hourly.map((h) => h.precipitation_probability);

  if (hourlyChart) {
    hourlyChart.destroy();
  }
  hourlyChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Temperature (°C)",
          data: temps,
          borderColor: "#ffd166",
          backgroundColor: "rgba(255,209,102,0.15)",
          fill: true,
          tension: 0.35,
          yAxisID: "y",
          pointRadius: 3,
        },
        {
          label: "Rain chance (%)",
          data: rain,
          borderColor: "#5bc0f8",
          backgroundColor: "rgba(91,192,248,0.1)",
          fill: true,
          tension: 0.35,
          yAxisID: "y1",
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#fff" } },
      },
      scales: {
        x: { ticks: { color: "#fff" }, grid: { color: "rgba(255,255,255,0.08)" } },
        y: { position: "left", ticks: { color: "#fff" }, grid: { color: "rgba(255,255,255,0.08)" } },
        y1: { position: "right", min: 0, max: 100, ticks: { color: "#fff" }, grid: { display: false } },
      },
    },
  });
}

function renderUvChart(hourly) {
  const canvas = document.getElementById("uv-chart");
  const labels = hourly.map((h) => new Date(h.time).toLocaleTimeString([], { hour: "2-digit" }));
  const uv = hourly.map((h) => h.uv_index);

  if (uvChart) {
    uvChart.destroy();
  }
  uvChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "UV Index",
          data: uv,
          backgroundColor: uv.map((v) => uvColor(v)),
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: { ticks: { color: "#fff" }, grid: { display: false } },
        y: { min: 0, ticks: { color: "#fff" }, grid: { color: "rgba(255,255,255,0.08)" } },
      },
    },
  });
}

function uvColor(v) {
  if (v == null) return "rgba(255,255,255,0.2)";
  if (v < 3) return "#8bc34a";
  if (v < 6) return "#ffd166";
  if (v < 8) return "#ff9f40";
  if (v < 11) return "#ef5350";
  return "#9c27b0";
}

const modal = document.getElementById("detail-modal");
const modalBody = document.getElementById("modal-body");
document.getElementById("modal-close").addEventListener("click", closeModal);
document.querySelector(".modal-backdrop").addEventListener("click", closeModal);

function closeModal() {
  modal.classList.add("hidden");
}

function openHourlyDetail(h) {
  const dateTime = new Date(h.time).toLocaleString([], {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  modalBody.innerHTML = `
    <h3>${dateTime} — ${h.description}</h3>
    <div class="modal-row"><span>Temperature</span><span>${Math.round(h.temperature)}°C</span></div>
    <div class="modal-row"><span>Rain chance</span><span>${h.precipitation_probability}%</span></div>
    <div class="modal-row"><span>Wind</span><span>${Math.round(h.wind_speed)} km/h ${h.wind_direction_compass}</span></div>
    <div class="modal-row"><span>UV index</span><span>${h.uv_index.toFixed(1)} (${uvLabel(h.uv_index)})</span></div>
    <div class="modal-row"><span>Pressure</span><span>${Math.round(h.pressure)} hPa</span></div>
  `;
  modal.classList.remove("hidden");
}
