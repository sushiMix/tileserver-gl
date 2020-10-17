# Merging multiple MBTiles files in a single virtual source
## Objective
Client implementation of Mapbox GL JS is severely impacted by the number of client layers being displayed. If Tileserver GL is used to serve multiple data sources, it is more effective, performance-wise from the client point of view, to merge all these sources into a single virtual endpoint exposed by the server.

## How it works
### Configuration
- Virtual sources are declared in the `virtual` section of the configuration file.  
- Virtual sources can only reference sources declared in the `data` section of the configuration file. The `id` field must point to a valid identifier in the `data` section.  
- A source merged into a virtual source can be assigned a min and max zoom level. Outside of this range, the source is not used.
- If a source is missing, the virtual source keeps merging the present sources.
- A virtual source may declare an optional `center` value, as in the [TileJSON spec](https://github.com/mapbox/tilejson-spec/tree/master/2.2.0).

Example of the `virtual` section of the configuration file:
```json
{
    "options": { ... },
    "styles": { ... },
    "data": {...},
    "virtual": {
        "america": {
            "center": [-105, 32, 3],
            "sources": [
                { "id": "world", "minzoom": 0, "maxzoom": 6 },
                { "id": "illinois-chicago", "minzoom": 7, "maxzoom": 14 },
                { "id": "jamaica", "minzoom": 7, "maxzoom": 14 },
                { "id": "mexico-city", "minzoom": 7, "maxzoom": 14 }
            ]
        },
        "europe": {
            "center": [0, 32, 3],
            "sources": [
                { "id": "world", "minzoom": 0, "maxzoom": 6 },
                { "id": "idf", "minzoom": 7, "maxzoom": 14 }
            ]
        },
        "east": { 
            "sources": [
                { "id": "world", "minzoom": 0, "maxzoom": 6 },
                { "id": "gcc-states", "minzoom": 7, "maxzoom": 14 },
                { "id": "mumbai", "minzoom": 7, "maxzoom": 14 },
                { "id": "singapore", "minzoom": 7, "maxzoom": 14 }
            ]
        }
    }
}
```

### GUI
- Virtual sources are displayed in the `data` section of the landing page like the other regular sources.

### Raster support
- Virtual sources can be used like any other regular source when defining a style.