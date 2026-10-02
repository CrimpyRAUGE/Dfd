# MK Driving for Dollars

A phone app (installable web app) for driving for dollars, in the spirit of DealMachine.
Tap a property on the map to pin it. The app looks up the parcel number and address
from Utah's free public parcel data and adds it to a lead list. Export the list as a
CSV and upload it to your skip tracing service.

It is a plain static site with no build step, no server, and no account. Pins, notes,
photos, and routes are stored on the phone itself.

## What it does

- **Tap to pin.** Tap a house and it drops a pin, outlines the parcel, and fills in the
  parcel number, address, city, ZIP, and county. If you tap the street, it uses the
  closest parcel and moves the pin onto it.
- **Pin my spot.** Parked in front of a house? One button pins the parcel at your GPS spot.
- **No duplicates.** Tapping a parcel that's already pinned opens the existing pin.
- **Tags, status, notes, owner name, photos** on each pin. Tags are editable in Settings.
- **Property facts** in Salt Lake County: market value, year built, square feet, acres,
  and whether it's the owner's primary residence (non-owner-occupied is a good signal).
- **County record link** (Salt Lake County) that shows the owner's name.
- **Driving mode** follows your location, records the route you drove, shows miles, and
  keeps the screen on.
- **Parcel lines** appear when you zoom in close, so you can see lot boundaries.
- **Lead list** with search, filters by status, tag, and driving session, and sorting
  (newest, oldest, address, status, or highest value).
- **Sessions.** Every drive (Start driving to Stop driving) is saved as a session with its
  date, time, duration, miles, and the pins you dropped on it. From the Sessions tab you can
  view a drive's pins, show its route and pins on the map, export its pins as a CSV, rename it,
  or delete it (pins are kept). Pins dropped while not driving are grouped as "Not during a drive".
- **Export lists.** Export the sessions list as a CSV (one row per drive, with pin counts by
  status and the pin addresses), copy it as plain text, or copy a numbered address list of the
  pins currently shown.
- **Export CSV for skip trace.** One row per lead, plus "Copy parcel #s" for a plain list.
  After export it offers to mark the leads as "Sent to skip trace".
- **Works with weak signal.** If the parcel lookup fails, the pin is saved and the lookup
  retries when signal comes back. The app itself and map tiles you've seen are cached.
- **Backup and restore** to a JSON file (includes photos).

## CSV columns

`Parcel Number, Parcel Number (Formatted), Property Address, Property City, Property State,
Property Zip, County, Owner First Name, Owner Last Name, Owner Full Name, Status, Tags, Notes,
Market Value, Year Built, Building Sq Ft, Acres, Owner Occupied, Latitude, Longitude,
Date Added, Map Link, Drive Session`

Most skip tracing services match on property address, city, state, and ZIP, and map those
columns on upload. Tip: if you open the CSV in Excel first, the 14-digit "Parcel Number"
column can turn into scientific notation. Use the "Parcel Number (Formatted)" column, or
upload the CSV directly without saving it from Excel.

## Data sources

Parcel data comes from the Utah Geospatial Resource Center (UGRC), checked in this order:

1. `Parcels_SaltLake_LIR` (Salt Lake County with tax roll details)
2. `Parcels_Utah` (statewide basic parcels: address, city, ZIP)

Both are free public ArcGIS layers. Utah parcel layers do not include owner names; use the
county record link or your skip trace results for those. The URLs are editable in Settings
if UGRC ever renames a layer. Base maps are OpenStreetMap (street) and Esri World Imagery
(satellite).

## Deploy (one time)

1. Netlify: **Add new site > Import an existing project**, pick this repo.
2. Leave the base directory, build command, and publish directory empty.
   `netlify.toml` publishes the repo root as is.
3. Deploy. Optional: add a custom domain such as `leads.mkhomepro.com`
   (DNS: CNAME `leads` to the new site's `*.netlify.app` hostname).

`netlify.toml` allows GPS and camera access (`Permissions-Policy`), which the app needs.
Don't host it under mkhomepro.com: that site's headers turn GPS off.
The app sends `noindex` headers and a `Disallow: /` robots.txt, so search engines skip it.

## Install on your phone

- **iPhone (Safari):** open the site, tap Share, then **Add to Home Screen**.
- **Android (Chrome):** open the site, tap the menu, then **Install app**.

Allow location access when asked. Download a backup from Settings now and then. Data lives
only on that phone, and deleting the app or clearing Safari data erases it.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `sw.js` | Service worker (offline app shell and tile cache) |
| `manifest.webmanifest`, `*.png` | Install-to-home-screen metadata and icons |
| `vendor/leaflet/` | Leaflet 1.9.4 map library (BSD-2-Clause), vendored so the app works offline |
| `netlify.toml`, `robots.txt` | Hosting headers and crawler rules |
| `tests/e2e.mjs`, `package.json` | Browser test with fake parcel data, tiles, and GPS (dev only) |

## Testing

```bash
npm install
npx playwright install chromium
npm test
```

The test serves the app locally and fakes the parcel service, map tiles, and GPS,
so it needs no internet connection.

When you change `app.js`, `styles.css`, or `index.html`, bump `VERSION` in `sw.js` so
installed copies pick up the new shell.
