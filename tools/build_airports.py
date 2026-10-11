"""Rebuild js/data/airports.json from the public-domain OurAirports data.

Usage:  python3 tools/build_airports.py airports.csv runways.csv js/data/airports.json
(CSV files from https://ourairports.com/data/)

Output: { ICAO: [name, city, country, lat, lon, elevation_ft, "16L/34R 13002 ASP|..."] }
"""
import csv
import json
import sys

airports_csv, runways_csv, out_path = sys.argv[1:4]

runways = {}
with open(runways_csv, encoding="utf-8") as f:
    for r in csv.DictReader(f):
        if r["closed"] == "1" or not r["le_ident"]:
            continue
        ends = r["le_ident"] + ("/" + r["he_ident"] if r["he_ident"] else "")
        surface = r["surface"].upper()[:4]
        runways.setdefault(r["airport_ident"], []).append(
            " ".join(x for x in (ends, r["length_ft"], surface) if x)
        )

out = {}
with open(airports_csv, encoding="utf-8") as f:
    for r in csv.DictReader(f):
        if r["type"] not in ("large_airport", "medium_airport"):
            continue
        icao = r["icao_code"] or r["gps_code"] or r["ident"]
        if len(icao) != 4 or not icao.isalnum():
            continue
        out[icao.upper()] = [
            r["name"],
            r["municipality"],
            r["iso_country"],
            round(float(r["latitude_deg"]), 4),
            round(float(r["longitude_deg"]), 4),
            int(float(r["elevation_ft"] or 0)),
            "|".join(runways.get(r["ident"], [])),
        ]

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
print(len(out), "airports")
