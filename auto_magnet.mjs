import 'dotenv/config.js';
// packages
import path from 'path';
// libs
import { MOVIE_STATUS, SHOW_STATUS } from './lib/utilities.mjs';
import { scratchStore as SCRATCH } from './lib/dataStore.mjs';
import { torrentSearch as TORRENTSEARCH } from './lib/torrentSearch.mjs';
import { transmissionMng as TRANSMISSION, } from './lib/manageTransmission.mjs';
import { actions as TMDB } from './lib/videoDataAPI.mjs';
import { subtitles } from './lib/subtitleFinder.mjs';

// express + websockets
import express from 'express';
import express_ws from 'express-ws'

const app = express();
const expressWs = express_ws(app);
const port = process.env.AMAGNET_PORT;

app.use(express.static('public'));
app.use(express.static('node_modules/bootstrap/dist/js'));
app.use('/js/', express.static('lib'));
app.use('/css/fonts/', express.static('node_modules/bootstrap-icons/font/fonts'));
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, './public/index.html'));
});
app.ws('/ws', function (ws, _req) {
    console.log('connection opened');
    broadCastData();
    ws.on('message', async function (rawMsg) {
        const msg = JSON.parse(rawMsg);
        console.log(`cmd: ${msg.cmd}`);
        switch (msg?.cmd) {
            case 'findMovies':
                findMovies(ws, msg.data);
                break;
            case 'addMovie':
                addMovie(msg.data);
                break;
            case 'findShows':
                findShows(ws, msg.data);
                break;
            case 'addShow':
                addShow(msg.data);
                break;
            case 'delMovie':
                deleteMovie(msg.data, false);
                break;
            case 'delMovieWithData':
                deleteMovie(msg.data, true);
                break;
            default:
                console.log("unknown ws command");
        }
    });
});
app.listen(port, () => {
    console.log(`Ready on port:${port}! `);
});

function broadcast(msg) {
    const aWss = expressWs.getWss('/ws');
    aWss.clients.forEach(function (client) {
        client.send(JSON.stringify(msg));
    });
}
function broadCastData() {
    broadcast({ cmd: 'data', data: { movies: SCRATCH.getMovies(), shows: SCRATCH.getShows() } });
}
async function findMovies(ws, data) {
    try {
        const movies = await TMDB.findMovies(data.query, data.options || {});
        ws.send(JSON.stringify({ cmd: 'foundMovies', data: { status: 'success', results: movies.results } }));
    } catch (error) {
        console.log(error);
        ws.send(JSON.stringify({ cmd: 'foundMovies', data: { status: 'error' } }));
    }
}
async function findShows(ws, data) {
    try {
        const shows = await TMDB.findShows(data.query, data.options || {});
        ws.send(JSON.stringify({ cmd: 'foundShows', data: { status: 'succes', results: shows.results } }))
    } catch (error) {
        console.log(error);
        ws.send(JSON.stringify({ cmd: 'foundMovies', data: { status: 'error' } }));
    }
}
async function addMovie(movie) {
    try {
        SCRATCH.saveMovie({ ...await TMDB.movieDetails(movie), status: MOVIE_STATUS.SEARCHING, timeAdded: Date.now() });
        broadCastData();
        run();
    } catch (error) {
        console.log(error);
    }

}
async function addShow(show) {
    try {
        SCRATCH.saveShow({ ...await TMDB.showDetails(show), status: SHOW_STATUS.SEARCHING, timeAdded: Date.now() });
        broadCastData();
        run();
    } catch (error) {
        console.log(error);
    }

}
async function deleteMovie(movie, withData) {
    TRANSMISSION.deleteItem(movie, withData);
    SCRATCH.deleteMovie(movie);
    broadCastData();
}

let runEnabled = true;
async function run() { // TODO
    if (!runEnabled) return;
    try {
        console.log("run started");
        runEnabled = false;
        // append torrents to movies
        let updatedMovies = [];
        for (const movie of SCRATCH.getMovies()) {
            if (movie.status == MOVIE_STATUS.SEARCHING) {
                updatedMovies.push(TORRENTSEARCH.appendMovieTorrent(movie));
            }
        }
        // append torrents to shows
        let updatedShows = [];
        for (const show of SCRATCH.getShows()) {
            updatedShows.push(TORRENTSEARCH.appendShowTorrent(show));
        }
        // save items with their torrents and broadcast data
        await Promise.all([...updatedMovies, ...updatedShows]);
        for (const movie of updatedMovies) {
            SCRATCH.saveMovie(await movie);
        }
        for (const show of updatedShows) {
            SCRATCH.saveShow(await show);
        }
        // append transmission id's
        updatedMovies = [];
        for (const movie of SCRATCH.getMovies()) {
            if (!movie.transmissionId && movie.torrent?.magnet) {
                updatedMovies.push(TRANSMISSION.appendTransmissionIdMovie(movie))
            }
        }
        updatedShows = [];
        for (const show of SCRATCH.getShows()) {
            updatedShows.push(TRANSMISSION.appendTransmissionIdShow(show));
        }
        // save items with their torrents and broadcast data
        await Promise.all([...updatedMovies, ...updatedShows]);
        for (const movie of updatedMovies) {
            SCRATCH.saveMovie(await movie);
        }
        for (const show of updatedShows) {
            SCRATCH.saveShow(await show);
        }

        await updateStatuses();
        broadCastData();
        console.log('run ended');
    } catch (error) {
        console.log('Run error:');
        console.log(error);
    }
    runEnabled = true;
}

async function updateStatuses() {
    try {
        if (!runEnabled) return;
        const updatedMovies = [];
        for (const movie of SCRATCH.getMovies()) {
            updatedMovies.push(TRANSMISSION.setMovieStatus(movie));
        }
        const updatedShows = [];
        for (const show of SCRATCH.getShows()) { // TODO
        }
        await Promise.all([...updatedMovies, ...updatedShows]);
        for (const movie of updatedMovies) {
            SCRATCH.saveMovie(await movie);
        }
        for (const show of updatedShows) {
            SCRATCH.saveShow(await show);
        }
    } catch (error) {
        console.log('Updating Status error:');
        console.log(error);
    }

}
async function updateShowDetails() {
    // TODO once a day or so update show details
}

//setInterval(updateShowDetails, 1000 * 60 * 60 * 24);
//setInterval(updateStatuses, 1000 * 60);