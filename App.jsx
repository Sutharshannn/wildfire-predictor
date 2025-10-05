import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, GeoJSON, Polyline, CircleMarker } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* ------------ Province centroids (approx) ------------- */
const CENTROIDS = {
  AB: [53.9333, -116.5765],
  BC: [53.7267, -127.6476],
  MB: [53.7609, -98.8139],
  NB: [46.5653, -66.4619],
  NL: [53.1355, -57.6604],
  NS: [44.682, -63.7443],
  NT: [64.8255, -124.8457],
  NU: [70.2998, -83.1076],
  ON: [51.2538, -85.3232],
  PE: [46.5107, -63.4168],
  QC: [52.9399, -73.5491],
  SK: [52.9399, -106.4509],
  YT: [64.2823, -135],
};

/* ---- Full province names -> 2-letter code ---- */
const NAME_TO_CODE = {
  "alberta": "AB",
  "british columbia": "BC",
  "manitoba": "MB",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  "newfoundland & labrador": "NL",
  "nova scotia": "NS",
  "northwest territories": "NT",
  "nunavut": "NU",
  "ontario": "ON",
  "prince edward island": "PE",
  "quebec": "QC",
  "saskatchewan": "SK",
  "yukon": "YT",
  "pei": "PE",
};

/* ------------ helpers ------------- */
const toNum = (v) => {
  const n = Number(String(v ?? "").replace(/[, ]+/g, ""));
  return Number.isFinite(n) ? n : NaN;
};
const normName = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/* Auto-detect CSV headers (aliases supported) */
function detectColumns(headerCells) {
  const h = headerCells.map((s) => String(s).trim());
  const norm = h.map((x) => x.toLowerCase().replace(/\s+|_/g, ""));
  const findOne = (aliases) => {
    const i = norm.findIndex((k) => aliases.includes(k));
    return i >= 0 ? h[i] : null;
  };
  return {
    yearCol: findOne(["year", "yr"]),
    regionCol: findOne(["regioncode", "province", "prov", "region", "territory", "provinceterritory", "provincecode", "name", "nameen", "prname", "prename"]),
    areaCol: findOne(["area", "area_ha", "areaha", "burnedarea", "burned_area", "areaburned", "totalarea", "totalburned", "areahectares", "hectares"]),
  };
}

/* Lightweight CSV parser */
function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(",");
  const { yearCol, regionCol, areaCol } = detectColumns(header);

  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const obj = {};
    header.forEach((key, i) => (obj[key] = cells[i]));

    const regionRaw = obj[regionCol] ?? obj.RegionCode ?? obj.Province ?? obj.Region ?? obj.PRNAME ?? obj.PRENAME ?? obj.name ?? obj.NAME;
    const areaRaw = obj[areaCol] ?? obj.Area_ha ?? obj.Area ?? obj.BurnedArea;
    const yearRaw = obj[yearCol] ?? obj.YEAR ?? obj.Year;

    let region = String(regionRaw || "").trim();
    if (region.length > 2) {
      const code = NAME_TO_CODE[normName(region)];
      if (code) region = code;
    }
    region = region.toUpperCase();

    return { region, area_ha: toNum(areaRaw), year: toNum(yearRaw) };
  });
}

/* Sum total burned area per province across all years */
function aggregateByProvince(rows) {
  const totals = {};
  for (const r of rows) {
    if (!r.region || !(r.region in CENTROIDS)) continue;
    const val = toNum(r.area_ha);
    if (!Number.isFinite(val)) continue;
    totals[r.region] = (totals[r.region] || 0) + val;
  }
  return totals;
}

/* Convert totals -> GeoJSON points at province centroids */
function totalsToGeoJSON(totals) {
  const features = Object.entries(totals).map(([code, area]) => {
    const [lat, lon] = CENTROIDS[code];
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { province: code, total_burned_ha: Math.round(area) },
    };
  });
  return { type: "FeatureCollection", features };
}

/* ---- Marker size scale ---- */
function radiusFor(areaHa, maxArea) {
  if (!maxArea || !Number.isFinite(areaHa)) return 6;
  const t = Math.max(0, Math.min(1, Math.sqrt(areaHa / maxArea)));
  return 6 + t * 16; // 6..22 px
}

/* ==================== Wind heading (estimator) ==================== */
const WAF = { grass: 0.7, shrub: 0.5, forest: 0.3 };
const mod360 = d => ((d % 360) + 360) % 360;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;
function compassFromDeg(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(mod360(deg) / 22.5) % 16];
}
function predictHeading(speedKmh, dirFromDeg, env, slopePct, slopeDirTo) {
  // FROM -> TO
  const headingTo = mod360(dirFromDeg + 180);
  const speedMs = speedKmh / 3.6;
  const waf = WAF[env] ?? 0.7;

  // wind (mid-flame) vector
  let u = waf * speedMs * Math.cos(toRad(headingTo)); // east
  let v = waf * speedMs * Math.sin(toRad(headingTo)); // north

  // optional slope push (heuristic)
  if (Number.isFinite(slopePct) && Number.isFinite(slopeDirTo)) {
    const push = 0.02 * (slopePct / 10);
    u += push * Math.cos(toRad(slopeDirTo));
    v += push * Math.sin(toRad(slopeDirTo));
  }

  const heading = mod360(toDeg(Math.atan2(v, u)));
  return { headingDeg: heading, compass: compassFromDeg(heading) };
}

/* geo utils: destination point given start, bearing, distance */
function destPoint(lat, lon, bearingDeg, distanceKm) {
  const R = 6371;
  const brng = toRad(bearingDeg);
  const φ1 = toRad(lat), λ1 = toRad(lon);
  const dR = distanceKm / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(dR) + Math.cos(φ1) * Math.sin(dR) * Math.cos(brng));
  const λ2 = λ1 + Math.atan2(Math.sin(brng) * Math.sin(dR) * Math.cos(φ1), Math.cos(dR) - Math.sin(φ1) * Math.sin(φ2));
  return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI + 540) % 360) - 180];
}

/* Simple geocoder (OpenStreetMap Nominatim) */
async function geocodePlace(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Geocode HTTP ${res.status}`);
  const arr = await res.json();
  if (!arr.length) throw new Error("No results");
  const { lat, lon, display_name } = arr[0];
  return { lat: parseFloat(lat), lon: parseFloat(lon), name: display_name };
}

/* ===================== Component ===================== */
export default function App() {
  const mapRef = useRef(null);

  // Province totals as points
  const [fc, setFc] = useState(null);
  const [totalCanada, setTotalCanada] = useState(0);
  const [error, setError] = useState("");

  // Step 1: where do you live?
  const [query, setQuery] = useState("");
  const [home, setHome] = useState(null); // { lat, lon, name }

  // Step 2: wind UI (appears after we have a home point)
  const [wind, setWind] = useState({
    speed: "",
    dirFrom: "",
    env: "grass",
    slopePct: "",
    slopeDirTo: "",
  });

  // Load CSV -> aggregate -> province points
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/data/burned_area_canada_tidy.csv");
        if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
        const text = await res.text();
        const rows = parseCSV(text);
        const totals = aggregateByProvince(rows);
        const grand = Object.values(totals).reduce((a, b) => a + b, 0);
        setTotalCanada(Math.round(grand));
        setFc(totalsToGeoJSON(totals));
      } catch (e) {
        console.error(e);
        setError("Failed to load or parse burned_area_canada_tidy.csv");
      }
    })();
  }, []);

  // Max for marker scaling
  const maxArea = useMemo(() => {
    if (!fc) return 0;
    const vals = fc.features.map(f => f.properties.total_burned_ha || 0);
    return Math.max(...vals, 0);
  }, [fc]);

  // Compute heading from wind UI (only when we have values)
  const slopePctVal = wind.slopePct === "" ? NaN : Number(wind.slopePct);
  const slopeDirVal = wind.slopeDirTo === "" ? NaN : Number(wind.slopeDirTo);
  const res = (wind.speed !== "" && wind.dirFrom !== "")
    ? predictHeading(Number(wind.speed) || 0, Number(wind.dirFrom) || 0, wind.env, slopePctVal, slopeDirVal)
    : null;

  // Build arrow over the home city
  const line = useMemo(() => {
    if (!home || !res) return null;
    const { lat, lon } = home;
    // city-scale visible length: 5–25 km depending on speed
    const lengthKm = Math.max(5, Math.min(25, (Number(wind.speed) || 0) * 0.8));
    const end = destPoint(lat, lon, res.headingDeg, lengthKm);
    const head = Math.max(2, lengthKm * 0.35);
    const left = destPoint(end[0], end[1], res.headingDeg - 155, head);
    const right = destPoint(end[0], end[1], res.headingDeg + 155, head);
    return { start: [lat, lon], end, left, right };
  }, [home, res, wind.speed]);

  // Actions
  async function onFindPlace(e) {
    e.preventDefault();
    setError("");
    try {
      const g = await geocodePlace(query);
      setHome(g);
      // fly the map to the place (zoom to city level)
      const m = mapRef.current;
      if (m) m.flyTo([g.lat, g.lon], 10, { duration: 1.25 });
    } catch (err) {
      console.error(err);
      setError("Couldn’t find that place. Try a more specific name (City, Province/Country).");
    }
  }

  return (
    <div style={{ height: "100vh", width: "100vw", display: "grid", gridTemplateRows: "auto 1fr" }}>
      {/* Header */}
      <header style={{ background: "#0f172a", color: "#fff", padding: "10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <h1 style={{ margin: 0, fontSize: 18 }}>🔥 Wildfire Predictor — Provincial Totals + Your City Wind</h1>
          {fc && (
            <div style={{ marginLeft: "auto", fontSize: 14 }}>
              Canada total (all years) ≈ <b>{totalCanada.toLocaleString("en-US")}</b> ha
            </div>
          )}
        </div>

        {/* Step 1: where do you live? */}
        <form onSubmit={onFindPlace} style={{ display: "grid", gridTemplateColumns: "minmax(260px, 1fr) 120px", gap: 8, marginTop: 10 }}>
          <input
            placeholder="Where do you live? (e.g., Calgary, AB or Ottawa, ON)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ padding: "8px", fontSize: 14 }}
          />
          <button type="submit" style={{ padding: "8px", fontSize: 14, background: "#22c55e", color: "#0f172a", border: "none", borderRadius: 4 }}>
            Find
          </button>
        </form>

        {/* Step 2: wind inputs (after we have a home point) */}
        {home && (
          <>
            <div style={{ marginTop: 8, fontSize: 13, opacity: .95 }}>
              Centered on: <b>{home.name}</b>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginTop: 8 }}>
              <div>
                <label style={{ fontSize: 12, opacity: .9 }}>Wind speed (km/h)</label>
                <input
                  type="number" step="0.1" value={wind.speed}
                  onChange={e => setWind(w => ({ ...w, speed: e.target.value }))}
                  style={{ width: "100%", padding: "6px" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, opacity: .9 }}>Wind FROM (°)</label>
                <input
                  type="number" min="0" max="360" step="1" value={wind.dirFrom}
                  onChange={e => setWind(w => ({ ...w, dirFrom: e.target.value }))}
                  style={{ width: "100%", padding: "6px" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, opacity: .9 }}>Environment</label>
                <select
                  value={wind.env}
                  onChange={e => setWind(w => ({ ...w, env: e.target.value }))}
                  style={{ width: "100%", padding: "6px" }}
                >
                  <option value="grass">Grass/open</option>
                  <option value="shrub">Shrub</option>
                  <option value="forest">Forest/understory</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, opacity: .9 }}>Slope % (opt)</label>
                <input
                  type="number" step="0.1" value={wind.slopePct}
                  onChange={e => setWind(w => ({ ...w, slopePct: e.target.value }))}
                  style={{ width: "100%", padding: "6px" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, opacity: .9 }}>Slope TO (°) (opt)</label>
                <input
                  type="number" min="0" max="360" step="1" value={wind.slopeDirTo}
                  onChange={e => setWind(w => ({ ...w, slopeDirTo: e.target.value }))}
                  style={{ width: "100%", padding: "6px" }}
                />
              </div>
            </div>
            {res && (
              <div style={{ marginTop: 6, fontSize: 13, opacity: .95 }}>
                Predicted flame heading (TO): <b>{res.headingDeg.toFixed(1)}°</b> ({res.compass})
              </div>
            )}
          </>
        )}

        {error && (
          <div style={{ marginTop: 8, background: "#fee2e2", color: "#7f1d1d", padding: "8px 12px", border: "1px solid #fecaca", borderRadius: 8 }}>
            {error}
          </div>
        )}
      </header>

      {/* Map */}
      <main>
        <MapContainer
          center={[56, -96]}
          zoom={4}
          style={{ height: "100%", width: "100%" }}
          whenCreated={(map) => (mapRef.current = map)}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />

          {/* Province dots (size by burned area) */}
          {fc && (
            <GeoJSON
              data={fc}
              pointToLayer={(feat, latlng) =>
                L.circleMarker(latlng, {
                  radius: radiusFor(
                    feat.properties.total_burned_ha,
                    fc.features.map(f => f.properties.total_burned_ha || 0).reduce((a, b) => Math.max(a, b), 0)
                  ),
                  color: "#ef4444",
                  weight: 1,
                  fillOpacity: 0.85,
                })
              }
              onEachFeature={(f, layer) => {
                const p = f.properties || {};
                layer.bindPopup(
                  `<b>${p.province}</b><br/>Total burned: ${Math.round(p.total_burned_ha).toLocaleString("en-US")} ha`
                );
                layer.bindTooltip(p.province, {
                  permanent: true,
                  direction: "right",
                  offset: L.point(8, 0),
                  className: "prov-label",
                });
              }}
            />
          )}

          {/* Your city + wind arrow (only after we have a home + inputs) */}
          {home && (
            <>
              <CircleMarker
                center={[home.lat, home.lon]}
                radius={6}
                pathOptions={{ color: "#0ea5e9", fillColor: "#0ea5e9", fillOpacity: 1 }}
              />
              {line && (
                <>
                  <Polyline positions={[line.start, line.end]} pathOptions={{ color: "#0ea5e9", weight: 5 }} />
                  <Polyline positions={[line.end, line.left]} pathOptions={{ color: "#0ea5e9", weight: 5 }} />
                  <Polyline positions={[line.end, line.right]} pathOptions={{ color: "#0ea5e9", weight: 5 }} />
                </>
              )}
            </>
          )}
        </MapContainer>
      </main>
    </div>
  );
}