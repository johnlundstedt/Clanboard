import { Hono } from "hono";
import { containerDb } from "../../core/container-db.js";
import { readJson, respond } from "../../web/helpers.js";
import * as core from "../../core/dashboard.js";

function migrate() {
  // Dashboard has no own tables; it aggregates tasks, users, and settings.
}

const app = new Hono();

// Household settings used by the dashboard (lat/lon for weather)
app.get("/settings", (c) => respond(c, () => core.weatherSettings(containerDb)));

app.post("/settings", (c) =>
  respond(c, async () => {
    const body = await readJson(c);
    return core.updateWeatherSettings(containerDb, body);
  })
);

// City-name search via Open-Meteo Geocoding (free, no API key)
app.get("/geocode", (c) => respond(c, () => core.geocode(c.req.query("q"))));

// Reverse geocode (used by the "use my location" button to name the spot)
app.get("/reverse-geocode", (c) =>
  respond(c, () => core.reverseGeocode(c.req.query("lat"), c.req.query("lon")))
);

app.get("/", (c) =>
  respond(c, () =>
    core.getDashboard(containerDb, {
      user_id: c.req.query("user_id"),
      timezone: c.get("timezone"),
    })
  )
);

export default {
  name: "dashboard",
  navLabel: "Home",
  migrate,
  app,
};