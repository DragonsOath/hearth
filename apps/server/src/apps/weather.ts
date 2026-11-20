import type { Fetch } from "./http";

/**
 * The home dashboard's weather (11-05: "What weather forecast thing are you using", "I
 * should be able to set a location if I'm using a VPN", "you should be able to have multiple
 * locations"). In the US from the National Weather Service (api.weather.gov: the current
 * reading from the nearest station, hourly and twice-daily forecasts); elsewhere from
 * Open-Meteo. Both are free and need no account or key. A place is found by town or US ZIP
 * code (Open-Meteo's place search, zippopotam.us for ZIPs). Only the place's coordinates are
 * sent; nothing about the home or the person.
 *
 * Conditions are given in Home Assistant's words (sunny, partlycloudy, rainy...) so the
 * dashboard shows them the same way whichever service they came from.
 */

export interface WeatherPlace {
  label: string;
  lat: number;
  lon: number;
}

export interface WeatherReport {
  source: "nws" | "open-meteo";
  /** "National Weather Service" or "Open-Meteo". */
  sourceName: string;
  /** Where the reading is for ("Hesperia, CA"). */
  place: string;
  condition: string;
  temperature?: number;
  humidity?: number;
  wind?: number;
  windUnit: string;
  windBearing?: number;
  feelsLike?: number;
  rainChance?: number;
  unit: "°F" | "°C";
  forecast: { date: string; condition?: string; high?: number; low?: number; rain?: number }[];
  hourly: { time: string; condition?: string; temperature?: number; rain?: number }[];
}

const UA = "Hearth home dashboard (github.com/DragonsOath/hearth)";
const TEN_MIN = 10 * 60_000;
const cache = new Map<string, { at: number; value: WeatherReport }>();

async function getJson<T>(fetchImpl: Fetch, url: string, geo = false): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": UA, Accept: geo ? "application/geo+json" : "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    throw Object.assign(new Error(`${res.status} from ${new URL(url).host}`), {
      status: res.status,
    });
  return (await res.json()) as T;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const round1 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 10) / 10);
const cToF = (c: number | undefined) => (c === undefined ? undefined : (c * 9) / 5 + 32);
const fToC = (f: number | undefined) => (f === undefined ? undefined : ((f - 32) * 5) / 9);
const COMPASS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** The National Weather Service's words as a Home Assistant condition. */
export function conditionOfText(text: string, day = true): string {
  const t = text.toLowerCase();
  if (/thunder|t-storm|tstorm/.test(t)) return "lightning-rainy";
  if (/sleet|freezing|wintry mix|rain and snow|snow and rain/.test(t)) return "snowy-rainy";
  if (/snow|flurr|blizzard/.test(t)) return "snowy";
  if (/hail/.test(t)) return "hail";
  if (/heavy rain/.test(t)) return "pouring";
  if (/rain|shower|drizzle/.test(t)) return "rainy";
  if (/fog|haze|smoke|mist|dust/.test(t)) return "fog";
  if (/partly|mostly sunny|mostly clear|few clouds|scattered clouds/.test(t)) return "partlycloudy";
  if (/cloud|overcast/.test(t)) return "cloudy";
  if (/wind|breezy|blustery/.test(t)) return "windy";
  if (/sunny|clear|fair/.test(t)) return day ? "sunny" : "clear-night";
  return "partlycloudy";
}

/** Open-Meteo's WMO weather codes as Home Assistant conditions. */
export function conditionOfCode(code: number | undefined, day = true): string {
  if (code === undefined) return "partlycloudy";
  if (code === 0) return day ? "sunny" : "clear-night";
  if (code <= 2) return "partlycloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 95) return "lightning-rainy";
  if (code === 66 || code === 67 || code === 56 || code === 57) return "snowy-rainy";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snowy";
  if (code === 65 || code === 82) return "pouring";
  if ((code >= 51 && code <= 63) || code === 80 || code === 81) return "rainy";
  return "cloudy";
}

/* ------------------------------------------------ finding a place ------------------------------------------------ */

/** Places matching a town ("Victorville", "Hesperia, CA") or a US ZIP code. */
export async function findPlaces(fetchImpl: Fetch, q: string): Promise<WeatherPlace[]> {
  const text = q.trim().slice(0, 100);
  if (!text) return [];
  if (/^\d{5}$/.test(text)) {
    try {
      const z = await getJson<{
        places?: {
          "place name": string;
          "state abbreviation": string;
          latitude: string;
          longitude: string;
        }[];
      }>(fetchImpl, `https://api.zippopotam.us/us/${text}`);
      return (z.places ?? []).slice(0, 1).map((p) => ({
        label: `${p["place name"]}, ${p["state abbreviation"]} ${text}`,
        lat: Number(p.latitude),
        lon: Number(p.longitude),
      }));
    } catch {
      return [];
    }
  }
  const [name, region] = text.split(",").map((x) => x.trim());
  const r = await getJson<{
    results?: {
      name: string;
      latitude: number;
      longitude: number;
      admin1?: string;
      country_code?: string;
      country?: string;
    }[];
  }>(
    fetchImpl,
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name ?? text)}&count=10&language=en&format=json`,
  ).catch(() => ({ results: [] }));
  const want = (region ?? "").toLowerCase();
  const STATES: Record<string, string> = US_STATES;
  return (r.results ?? [])
    .filter((x) => {
      if (!want) return true;
      const st = x.country_code === "US" ? (STATES[x.admin1 ?? ""] ?? "") : "";
      return [x.admin1, x.country, x.country_code, st].some((v) =>
        (v ?? "").toLowerCase().startsWith(want),
      );
    })
    .slice(0, 5)
    .map((x) => ({
      label:
        x.country_code === "US"
          ? `${x.name}, ${STATES[x.admin1 ?? ""] ?? x.admin1 ?? "US"}`
          : `${x.name}${x.admin1 ? `, ${x.admin1}` : ""}, ${x.country ?? x.country_code ?? ""}`.replace(
              /, $/,
              "",
            ),
      lat: x.latitude,
      lon: x.longitude,
    }));
}

/* ------------------------------------------------ the weather ------------------------------------------------ */

/** The weather at a place: the National Weather Service in the US, Open-Meteo elsewhere. */
export async function weatherAt(
  fetchImpl: Fetch,
  place: { lat: number; lon: number; label?: string },
  unit: "°F" | "°C",
): Promise<WeatherReport> {
  const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)},${unit}`;
  const kept = cache.get(key);
  if (kept && Date.now() - kept.at < TEN_MIN) return kept.value;
  let value: WeatherReport;
  try {
    value = await nws(fetchImpl, place, unit);
  } catch {
    // Outside the US the National Weather Service has no forecast, and when it is slow or
    // failing Open-Meteo still gives the weather.
    value = await openMeteo(fetchImpl, place, unit);
  }
  if (cache.size > 100) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

type Period = {
  startTime: string;
  isDaytime?: boolean;
  temperature?: number;
  temperatureUnit?: string;
  shortForecast?: string;
  probabilityOfPrecipitation?: { value?: number | null };
  relativeHumidity?: { value?: number | null };
  windSpeed?: string;
  windDirection?: string;
};

async function nws(
  fetchImpl: Fetch,
  place: { lat: number; lon: number; label?: string },
  unit: "°F" | "°C",
): Promise<WeatherReport> {
  const pt = await getJson<{
    properties: {
      forecast: string;
      forecastHourly: string;
      observationStations: string;
      relativeLocation?: { properties?: { city?: string; state?: string } };
    };
  }>(
    fetchImpl,
    `https://api.weather.gov/points/${place.lat.toFixed(4)},${place.lon.toFixed(4)}`,
    true,
  );
  const p = pt.properties;
  const [daily, hourly, current] = await Promise.all([
    getJson<{ properties: { periods: Period[] } }>(fetchImpl, p.forecast, true),
    getJson<{ properties: { periods: Period[] } }>(fetchImpl, p.forecastHourly, true),
    latestObservation(fetchImpl, p.observationStations).catch(() => undefined),
  ]);
  const temp = (t: number | undefined, from: string | undefined) =>
    round1(from === "C" ? (unit === "°F" ? cToF(t) : t) : unit === "°C" ? fToC(t) : t);
  const hours = hourly.properties.periods
    .filter((h) => Date.parse(h.startTime) > Date.now() - 60 * 60_000)
    .slice(0, 8);
  const now = hours[0];
  const windOf = (s?: string) => {
    const mph = Number(
      /(\d+)(?:\s*to\s*(\d+))?\s*mph/i
        .exec(s ?? "")
        ?.slice(1)
        .filter(Boolean)
        .pop(),
    );
    return Number.isFinite(mph) ? (unit === "°F" ? mph : Math.round(mph * 1.609)) : undefined;
  };
  // Days: each daytime period's high, with the night after it for the low.
  const periods = daily.properties.periods;
  const forecast: WeatherReport["forecast"] = [];
  for (let i = 0; i < periods.length && forecast.length < 7; i++) {
    const a = periods[i]!;
    if (!a.isDaytime) continue;
    const night = a.isDaytime ? periods[i + 1] : a;
    const day = a.isDaytime ? a : undefined;
    forecast.push({
      date: (day ?? a).startTime,
      condition: conditionOfText((day ?? a).shortForecast ?? "", Boolean(day)),
      ...(day ? { high: temp(day.temperature, day.temperatureUnit) } : {}),
      ...(night && !night.isDaytime ? { low: temp(night.temperature, night.temperatureUnit) } : {}),
      ...(num((day ?? a).probabilityOfPrecipitation?.value) !== undefined
        ? { rain: num((day ?? a).probabilityOfPrecipitation?.value) }
        : {}),
    });
  }
  const city = p.relativeLocation?.properties;
  const obsTemp = current?.temperature !== undefined ? temp(current.temperature, "C") : undefined;
  const feels = current?.feelsLike !== undefined ? temp(current.feelsLike, "C") : undefined;
  return {
    source: "nws",
    sourceName: "National Weather Service",
    place:
      place.label ?? (city?.city ? `${city.city}, ${city.state ?? ""}`.replace(/, $/, "") : "Home"),
    condition: current?.text
      ? conditionOfText(current.text, now?.isDaytime ?? true)
      : conditionOfText(now?.shortForecast ?? "", now?.isDaytime ?? true),
    temperature: obsTemp ?? temp(now?.temperature, now?.temperatureUnit),
    humidity: current?.humidity ?? num(now?.relativeHumidity?.value),
    wind:
      current?.windKmh !== undefined
        ? Math.round(unit === "°F" ? current.windKmh / 1.609 : current.windKmh)
        : windOf(now?.windSpeed),
    windUnit: unit === "°F" ? "mph" : "km/h",
    windBearing:
      current?.windBearing ??
      (now?.windDirection ? COMPASS.indexOf(now.windDirection) * 22.5 : undefined),
    feelsLike: feels,
    rainChance: num(now?.probabilityOfPrecipitation?.value),
    unit,
    forecast,
    hourly: hours.map((h) => ({
      time: h.startTime,
      condition: conditionOfText(h.shortForecast ?? "", h.isDaytime ?? true),
      temperature: temp(h.temperature, h.temperatureUnit),
      rain: num(h.probabilityOfPrecipitation?.value),
    })),
  };
}

/** The nearest station's latest reading, when it is recent (stations go quiet). */
async function latestObservation(fetchImpl: Fetch, stationsUrl: string) {
  const st = await getJson<{ features?: { properties?: { stationIdentifier?: string } }[] }>(
    fetchImpl,
    stationsUrl,
    true,
  );
  const id = st.features?.[0]?.properties?.stationIdentifier;
  if (!id || !/^\w{3,8}$/.test(id)) return undefined;
  const o = await getJson<{
    properties: {
      timestamp?: string;
      textDescription?: string;
      temperature?: { value?: number | null };
      relativeHumidity?: { value?: number | null };
      windSpeed?: { value?: number | null };
      windDirection?: { value?: number | null };
      heatIndex?: { value?: number | null };
      windChill?: { value?: number | null };
    };
  }>(fetchImpl, `https://api.weather.gov/stations/${id}/observations/latest`, true);
  const x = o.properties;
  if (!x.timestamp || Date.now() - Date.parse(x.timestamp) > 3 * 60 * 60_000) return undefined;
  const temperature = num(x.temperature?.value);
  return {
    text: x.textDescription || undefined,
    temperature,
    humidity:
      num(x.relativeHumidity?.value) !== undefined
        ? Math.round(num(x.relativeHumidity?.value)!)
        : undefined,
    windKmh: num(x.windSpeed?.value),
    windBearing: num(x.windDirection?.value),
    feelsLike: num(x.heatIndex?.value) ?? num(x.windChill?.value) ?? temperature,
  };
}

async function openMeteo(
  fetchImpl: Fetch,
  place: { lat: number; lon: number; label?: string },
  unit: "°F" | "°C",
): Promise<WeatherReport> {
  const f = unit === "°F";
  const r = await getJson<{
    current?: Record<string, number>;
    hourly?: {
      time: string[];
      temperature_2m: number[];
      precipitation_probability: number[];
      weather_code: number[];
      is_day: number[];
    };
    daily?: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max: number[];
    };
    utc_offset_seconds?: number;
  }>(
    fetchImpl,
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat.toFixed(4)}&longitude=${place.lon.toFixed(4)}` +
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,is_day" +
      "&hourly=temperature_2m,precipitation_probability,weather_code,is_day" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
      `&timezone=GMT&forecast_days=7&temperature_unit=${f ? "fahrenheit" : "celsius"}&wind_speed_unit=${f ? "mph" : "kmh"}`,
  );
  const c = r.current ?? {};
  const h = r.hourly;
  const start = Date.now() - 60 * 60_000;
  const hourly: WeatherReport["hourly"] = [];
  for (let i = 0; h && i < h.time.length && hourly.length < 8; i++) {
    const t = `${h.time[i]}:00Z`;
    if (Date.parse(t) < start) continue;
    hourly.push({
      time: new Date(t).toISOString(),
      condition: conditionOfCode(h.weather_code[i], h.is_day[i] === 1),
      temperature: round1(h.temperature_2m[i]),
      rain: num(h.precipitation_probability[i]),
    });
  }
  const d = r.daily;
  return {
    source: "open-meteo",
    sourceName: "Open-Meteo",
    place: place.label ?? "Home",
    condition: conditionOfCode(num(c.weather_code), c.is_day !== 0),
    temperature: round1(num(c.temperature_2m)),
    humidity: num(c.relative_humidity_2m),
    wind: num(c.wind_speed_10m) !== undefined ? Math.round(c.wind_speed_10m!) : undefined,
    windUnit: f ? "mph" : "km/h",
    windBearing: num(c.wind_direction_10m),
    feelsLike: round1(num(c.apparent_temperature)),
    rainChance: hourly[0]?.rain,
    unit,
    forecast: (d?.time ?? []).map((day, i) => ({
      date: `${day}T12:00:00Z`,
      condition: conditionOfCode(d!.weather_code[i]),
      high: round1(d!.temperature_2m_max[i]),
      low: round1(d!.temperature_2m_min[i]),
      rain: num(d!.precipitation_probability_max[i]),
    })),
    hourly,
  };
}

const US_STATES: Record<string, string> = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  "District of Columbia": "DC",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
  "Puerto Rico": "PR",
};
