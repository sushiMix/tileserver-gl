'use strict';

const fs = require('fs');
const path = require('path');

const MBTiles = require('@mapbox/mbtiles');

const utils = require('./utils');

const repo = {};

/**
 * @typedef {Object} MergedSourceDef
 * @description The settings of a concrete data source merged in a virtual source.
 * @property {string} id The identifier of the merged source, as appearing in the `data` section of the configuration file.
 * @property {number} [minzoom] The minimum zoom level at which the merged source is visible.
 * @property {number} [maxzoom] The maximum zoom level at which the merged source is visible.
 * @property {RepoInfo} source The RepoInfo structure of the merged data source.
 */

/**
 * @typedef {Object} RepoInfo
 * @description A structure representing a source declared in the configuration file.
 * @property {boolean} isVirtual True if the source is a virtual source, false otherwise.
 * @property {TileJSON} tileJSON The TileJSON structure describing the source.
 * @property {string} publicUrl The public URL, if any, supplied at server startup.
 * @property {Function} getTileData A function (z,x,y) => Promise({data,headers}) to get tile data from a source, concrete or virtual.
 * @property {MBTiles} [mbtWrapper] A wrapper object to access the SQLite database of the source. Present only for concrete data sources.
 * @property {string} [mbtiles] The name of the mbtiles file of the source. Present only for concrete data sources.
 * @property {*} [boundsPyramid] A pyramid of the bounds (in tile indices) of the source. Each zoom level is described as
 * [minx, miny, maxx, maxy] array of tile indices. Present only for concrete data sources.
 * @property {{Array.<MergedSourceDef>}} [sources] The array of concrete sources merged by a virtual source.
 * Present only for virtual data sources.
 */

/**
 * Build the pyramid of tile bounds. For each zoom level, a [minx, miny, maxx, maxy] array of the tile indices is built.
 * @param {RepoInfo} repoInfo 
 */
async function buildBoundsPyramid(repoInfo) {
    if (!repoInfo) {
        throw Error("Repo info cannot be null.");
    }

    if (!repoInfo.tileJSON) {
        throw Error("TileJSON was not found on repo info.");
    }

    if (!repoInfo.mbtWrapper) {
        throw Error("MBTiles was not found on repo info.");
    }

    let minZoom = 0;
    let maxZoom = 24;

    if (typeof repoInfo.tileJSON.minzoom === "number") {
        minZoom = repoInfo.tileJSON.minzoom;
    }

    if (typeof repoInfo.tileJSON.maxzoom === "number") {
        maxZoom = repoInfo.tileJSON.maxzoom;
    }

    const promises = [];
    for (let z = minZoom; z <= maxZoom; z++) {
        promises.push(getMbtilesBounds(repoInfo.mbtWrapper, z));
    }

    const boundsArray = await Promise.all(promises);
    const pyramid = [];
    for (let n = 0; n < boundsArray.length; n++) {
        pyramid[n + minZoom] = boundsArray[n];
    }

    repoInfo.boundsPyramid = pyramid;
}

/**
 * Get the index bounds for a specified zoom level.
 * @param {MBTiles} mbtiles A MBTiles instance representing the MbTiles to query.
 * @param {number} zoom The zoom level for which the bounds are extracted.
 */
function getMbtilesBounds(mbtiles, zoom) {
    if (!mbtiles) {
        throw Error("MBTiles cannot be null.");
    }

    if (typeof zoom !== "number") {
        throw Error("Zoom must be an integer.");
    }

    const boundsPromise = new Promise((resolve, reject) => {
        mbtiles._db.get(
            'SELECT MAX(tile_column) AS maxx, ' +
            'MIN(tile_column) AS minx, MAX(tile_row) AS maxy, ' +
            'MIN(tile_row) AS miny FROM tiles ' +
            'WHERE zoom_level = ?',
            zoom,
            function (err, row) {
                if (err) return reject(err);
                if (!row) return reject("Cannot get bounds");

                // Flip Y coordinate because MBTiles files are TMS.
                const flipY = (y, z) => (1 << z) - 1 - y;

                // const info = [row.minx, flipY(row.miny, zoom), row.maxx, flipY(row.maxy, zoom)];
                const info = [row.minx, flipY(row.maxy, zoom), row.maxx, flipY(row.miny, zoom)];
                return resolve(info);
            });
    });

    return boundsPromise;
}

/**
 * Get the identifier of the concrete source to use for the provided tile request.
 * @param {RepoInfo} source The virtual source to read the tile from.
 * @param {number} x The x coordinate of the tile to fetch.
 * @param {number} y The y coordinate of the tile to fetch.
 * @param {number} z The zoom level of the tile to fetch.
 */
function getConcreteSourceId(source, x, y, z) {
    if (!source) {
        throw Error("Source cannot be null.");
    }

    if (source.isVirtual !== true) {
        throw Error("Source must be virtual.");
    }

    // check zoom range for the whole virtual source
    if (z > source.tileJSON.maxzoom || z < source.tileJSON.minzoom) {
        return null;
    }

    // iterate over merged sources and return the first one matching the criteria
    let msource, minzoom, maxzoom, idxBounds;
    for (const msourceDef of source.sources) {
        minzoom = 0;
        maxzoom = 30;

        if (typeof msourceDef.minzoom === "number") {
            minzoom = msourceDef.minzoom;
        }

        if (typeof msourceDef.maxzoom === "number") {
            maxzoom = msourceDef.maxzoom;
        }

        msource = msourceDef.source;

        // check zoom range for the merged source
        if (z > maxzoom || z < minzoom) {
            continue;
        }

        idxBounds = msource.boundsPyramid[z];

        // check x
        if (x > idxBounds[2] || x < idxBounds[0]) {
            continue;
        }

        // check y
        if (y > idxBounds[3] || y < idxBounds[1]) {
            continue;
        }

        // source is eligible, return its identifier
        return msourceDef.id;
    }

    return null;
}

/**
 * Get a specific tile from a virtual source.
 * @param {RepoInfo} source The virtual source to read the tile from.
 * @param {number} x The x coordinate of the tile to fetch.
 * @param {number} y The y coordinate of the tile to fetch.
 * @param {number} z The zoom level of the tile to fetch.
 */
function getTileDataFromVirtual(source, x, y, z) {
    if (!source) {
        throw Error("Source cannot be null.");
    }

    if (source.isVirtual !== true) {
        throw Error("Source must be virtual.");
    }

    // check zoom range for the whole virtual source
    if (z > source.tileJSON.maxzoom || z < source.tileJSON.minzoom) {
        return Promise.reject({ message: "does not exist" });
    }

    // iterate over merged sources and return the first one matching the criteria
    let msource, minzoom, maxzoom, idxBounds;
    for (const msourceDef of source.sources) {
        minzoom = 0;
        maxzoom = 30;

        if (typeof msourceDef.minzoom === "number") {
            minzoom = msourceDef.minzoom;
        }

        if (typeof msourceDef.maxzoom === "number") {
            maxzoom = msourceDef.maxzoom;
        }

        msource = msourceDef.source;

        // check zoom range for the merged source
        if (z > maxzoom || z < minzoom) {
            continue;
        }

        idxBounds = msource.boundsPyramid[z];

        // check x
        if (x > idxBounds[2] || x < idxBounds[0]) {
            continue;
        }

        // check y
        if (y > idxBounds[3] || y < idxBounds[1]) {
            continue;
        }

        // source is eligible, get the tile from it
        return new Promise((resolve, reject) => {
            const mbtWrapper = msource.mbtWrapper;
            mbtWrapper.getTile(z, x, y, (err, data, headers) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({ data, headers });
                }
            });
        });
    }

    return Promise.reject({ message: "does not exist" });
}

/**
 * Get a specific tile from a concrete source.
 * @param {RepoInfo} source The concrete source to read the tile from.
 * @param {number} x The x coordinate of the tile to fetch.
 * @param {number} y The y coordinate of the tile to fetch.
 * @param {number} z The zoom level of the tile to fetch.
 */
function getTileDataFromConcrete(source, x, y, z) {
    if (!source) {
        throw Error("Source cannot be null.");
    }

    if (source.isVirtual === true) {
        throw Error("Source cannot be virtual.");
    }

    if (!source.mbtWrapper) {
        throw Error("Source MBTiles cannot be null.");
    }

    return new Promise((resolve, reject) => {
        const mbtWrapper = source.mbtWrapper;
        mbtWrapper.getTile(z, x, y, (err, data, headers) => {
            if (err) {
                reject(err);
            } else {
                resolve({ data, headers });
            }
        });
    });
}

/**
 * Parse a data source from the `data` section of the configuration file.
 * @param {*} options The `options` section of the configuration file.
 * @param {Object.<string, RepoInfo>} repo The repository to which the source should be added.
 * @param {*} params The source item, from the `data` section of the configuration file.
 * @param {string} id The identifier of the source
 * @param {string} publicUrl The public URL, if any, supplied when starting the server.
 */
async function parseDataSource(options, repo, params, id, publicUrl) {
    const mbtilesFile = path.resolve(options.paths.mbtiles, params.mbtiles);
    let tileJSON = {
        'tiles': params.domains || options.domains
    };

    const mbtilesFileStats = fs.statSync(mbtilesFile);
    if (!mbtilesFileStats.isFile() || mbtilesFileStats.size === 0) {
        throw Error(`Not valid MBTiles file: ${mbtilesFile}`);
    }
    let source;

    repo[id] = {
        isVirtual: false,
        tileJSON,
        publicUrl,
        getTileData: undefined,
        mbtWrapper: undefined,
        mbtiles: params.mbtiles,
        boundsPyramid: undefined
    };

    const sourceInfoPromise = new Promise((resolve, reject) => {
        source = new MBTiles(mbtilesFile, err => {
            if (err) {
                reject(err);
                return;
            }
            source.getInfo((err, info) => {
                if (err) {
                    reject(err);
                    return;
                }
                tileJSON['name'] = id;
                tileJSON['format'] = 'pbf';

                Object.assign(tileJSON, info);

                tileJSON['tilejson'] = '2.0.0';
                delete tileJSON['filesize'];
                delete tileJSON['mtime'];
                delete tileJSON['scheme'];

                Object.assign(tileJSON, params.tilejson || {});
                utils.fixTileJSONCenter(tileJSON);

                if (options.dataDecoratorFunc) {
                    tileJSON = options.dataDecoratorFunc(id, 'tilejson', tileJSON);
                }
                resolve();
            });
        });
    });

    await sourceInfoPromise;

    repo[id].mbtWrapper = source;

    repo[id].getTileData = (z, x, y) => {
        return getTileDataFromConcrete(repo[id], x, y, z);
    };

    await buildBoundsPyramid(repo[id]);
}

/**
 * Parse a data source from the `virtual` section of the configuration file.
 * @param {Object.<string, RepoInfo>} repo The repository to which the source should be added.
 * @param {*} params The source item, from the `virtual` section of the configuration file.
 * @param {string} id The identifier of the source
 * @param {string} publicUrl The public URL, if any, supplied when starting the server.
 */
function createVirtualSourceStubs(repo, vsourceDef, id, publicUrl) {
    const vsource = {
        isVirtual: true,
        tileJSON: undefined,
        publicUrl,
        getTileData: undefined,
        sources: []
    };

    // check presence of merged sources
    for (const msourceDef of vsourceDef.sources) {
        if (!repo[msourceDef.id]) {
            console.warn(`Source '${msourceDef.id}' in virtual source '${id}' was not found. Skipping it.`);
        } else {
            vsource.sources.push(msourceDef);
        }
    }

    repo[id] = vsource;
}

/**
 * Parse a data source from the `virtual` section of the configuration file.
 * @param {Object.<string, RepoInfo>} repo The repository to which the source should be added.
 * @param {*} vsourceDef The source item, from the `virtual` section of the configuration file.
 * @param {string} id The identifier of the source
 */
function parseVirtualSource(repo, vsourceDef, id) {
    const vsource = repo[id];
    let msource;

    let minlat = 90;
    let maxlat = -90;
    let minlng = 180;
    let maxlng = -180;
    let minzoom = 30;
    let maxzoom = 0;

    let repoLayers = {};

    // check presence of merged sources
    for (const msourceDef of vsource.sources) {
        if (repo[msourceDef.id]) {
            msource = repo[msourceDef.id];
            msourceDef.source = msource;

            if (msource.tileJSON.bounds[0] < minlng) {
                minlng = msource.tileJSON.bounds[0];
            }
            if (msource.tileJSON.bounds[1] < minlat) {
                minlat = msource.tileJSON.bounds[1];
            }
            if (msource.tileJSON.bounds[2] > maxlng) {
                maxlng = msource.tileJSON.bounds[2];
            }
            if (msource.tileJSON.bounds[3] > maxlat) {
                maxlat = msource.tileJSON.bounds[3];
            }

            if (msource.tileJSON.minzoom < minzoom) {
                minzoom = msource.tileJSON.minzoom;
            }

            if (msource.tileJSON.maxzoom > maxzoom) {
                maxzoom = msource.tileJSON.maxzoom;
            }

            for (const l of msource.tileJSON.vector_layers) {
                repoLayers[l.id] = l;
            }
        }
    }

    let center;
    if (vsourceDef.center) {
        // use the center defined in the virtual source definition
        center = vsourceDef.center;
    } else {
        // compute center from the bounds of the source
        center = [(minlng + maxlng) / 2, (minlat + maxlat) / 2, maxzoom]
    }

    vsource.tileJSON = {
        version: "3.6.1",
        tilejson: "2.0.0",
        bounds: [minlng, minlat, maxlng, maxlat],
        center: center,
        id: id,
        name: id,
        format: "pbf",
        minzoom: minzoom,
        maxzoom: maxzoom,
        vector_layers: Object.values(repoLayers)
    };

    vsource.getTileData = (z, x, y) => {
        return getTileDataFromVirtual(vsource, x, y, z);
    };
}

/**
 * Parse the configuration file to populate the source repository
 * @param {*} config The configuration file of the server
 * @param {string} publicUrl The public URL, if any, supplied when starting the server.
 */
const init = async (config, publicUrl) => {
    if (!config) {
        throw new Error("Config cannot be null.");
    }

    const options = config.options || {};
    const data = config.data || {};
    const virtual = config.virtual || {};

    const promises = [];
    let promise;

    for (const id of Object.keys(data)) {
        promise = parseDataSource(options, repo, data[id], id, publicUrl);
        promises.push(promise);
    }
   
    // create a stub for each virtual source
    for (const id of Object.keys(virtual)) {
        createVirtualSourceStubs(repo, virtual[id], id, publicUrl);
    }

    await Promise.all(promises);

    for (const id of Object.keys(virtual)) {
        parseVirtualSource(repo, virtual[id], id);
    }
}

module.exports = {
    repo,
    init,
    getConcreteSourceId
};
