require('dotenv').config();
const store = require('./dstore')
const Transmission = require('transmission');
const transmission = new Transmission({
    host: process.env.TRANSMISSION_HOST,
    username: process.env.TRANSMISSION_USER,
    password: process.env.TRANSMISSION_PW
});
const TorrentSearchApi = require('torrent-search-api');
TorrentSearchApi.enablePublicProviders();
TorrentSearchApi.disableProvider('Torrent9');
TorrentSearchApi.disableProvider('Limetorrents');

const active = true;
const moviePath = process.env.MOVIEPATH;
const seriesPath = process.env.SERIESPATH;


async function run() {
    if (!active) return;
    console.log("Run started:")
    for (const movie of store.data.movies) {
        await runMovie(movie);
    }
    for (const serie of store.data.series) {
        await runSerie(serie);
    }
    console.log("Run Ended;")
}
async function runMovie(movie) {
    if (movie.torrent) return;
    console.log(`   Trying ${movie.term}`);
    const torrent = (await TorrentSearchApi.search(movie.term, 'Movies', 1))[0];
    if (!torrent) { console.log(`   FAILED`); return }
    console.log(`   SUCCESS`);
    const magnet = await TorrentSearchApi.getMagnet(torrent);
    transmission.addUrl(magnet, { "download-dir": moviePath }, function (err, arg) {
        if (err) {
            console.error(err);
        } else {
            movie.torrent = torrent;
            movie.magnet = magnet;
            movie.torID = arg.id;
            store.save();
        }
    });
}
async function runSerie(serie) {
    if (!serie.active) return;
    let nextEpisode = nextEp(serie.magnets);
    console.log(`   Trying  ${serie.term}; ${nextEpisode}`);
    let torrent = (await TorrentSearchApi.search(`${serie.term} ${nextEpisode}`, 'TV', 1))[0];
    if (!torrent) {
        nextEpisode = seasonPlusOne(nextEpisode);
        console.log(`   Trying  ${serie.term}; ${nextEpisode}`);
        torrent = (await TorrentSearchApi.search(`${serie.term} ${nextEpisode}`, 'TV', 1))[0];
    }
    if (!torrent) { console.log(`   FAILED`); return } else { console.log(`   SUCCESS`) }
    const magnet = await TorrentSearchApi.getMagnet(torrent);
    transmission.addUrl(magnet, { "download-dir": `${seriesPath}/${serie.term}`}, function (err, arg) {
        if (err) {
            console.error(err);
        } else {
            serie.magnets.push({
                episode: nextEpisode,
                magnet: magnet,
                torrent: torrent,
                torID: arg.id
            })
            store.save();
        }
    });
}
function nextEp(magnets) {
    if (!magnets.length) {
        return "S01E01";
    }
    const episodes = [];
    for (const magnet of magnets) {
        episodes.push(magnet.episode);
    }
    episodes.sort();
    const lastEpisode = episodes[episodes.length - 1];
    return epPlusOne(lastEpisode);
}
function epPlusOne(episode) {
    const s = Number(episode.substr(1, 2));
    const e = Number(episode.substr(4, 5));
    return `S${String(s).padStart(2, '0')}E${String(e + 1).padStart(2, '0')}`
}
function seasonPlusOne(episode) {
    const s = Number(episode.substr(1, 2));
    return `S${String(s + 1).padStart(2, '0')}E01`
}

setInterval(run, 3600000); // once an hour
store.load().then(() => {
    run();
});


const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const port = process.env.AMAGNET_PORT;
app.use(express.static('public'));
app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <link rel="stylesheet" href="/style.css">
    <link rel="icon" type="image/png" href="/favicon.png">
    </head>
    <body>
    ${addItem()}
    ${mngMovies()}
    ${mngSeries()}
    ${rawEditor()}
    ${actionBtn()}
    </body>
    </html>
    `);
});

app.post('/raw', (req, res) => {
    console.log("update raw");
    store.data = req.body
    store.save();
    res.sendStatus(200);
});

app.post('/action', (req, res) => {
    let index;
    switch (req.body.action) {
        case "RemoveMov":
            index = indexOfTerm(store.data.movies, req.body.term);
            if (index != -1) {
                store.data.movies.splice(index, 1);
            }
            break;
        case "RemoveSerie":
            index = indexOfTerm(store.data.series, req.body.term);
            if (index != -1) {
                store.data.series.splice(index, 1);
            }
            break;
        case "Activate":
            index = indexOfTerm(store.data.series, req.body.term);
            if (index != -1) {
                store.data.series[index].active = true;
            }
            break;
        case "Disable":
            index = indexOfTerm(store.data.series, req.body.term);
            if (index != -1) {
                store.data.series[index].active = false;
            }
            break;
        case "AddMov":
            if (req.body.term) {
                store.data.movies.push({ term: req.body.term });
            }
            break;
        case "AddSerie":
            if (req.body.term) {
                store.data.series.push({ term: req.body.term, active: true, magnets: [] });
            }
            break;
        default:
    }
    store.save();
    res.sendStatus(200);
    console.log(req.body);
});

app.listen(port, () => {
    console.log('Ready!');
});

function mngMovies() {
    return `
    <table>
        <h2>Movies</h2>
        <tr>
            <th style="width:15%">Term</th>
            <th style="width:30%">Torrent</th>
            <th style="width:7%">Size</th>
            <th style="width:15%">Date</th>            
            <th style="width:7%">Provider</th>
            <th style="width:20%">Link</th>
            <th style="width:100px">Action</th>
        </tr>
    ${moviesList()}
    </table>
    `
}
function moviesList() {
    let res = "";
    for (const movie of store.data.movies) {
        res += `
        <tr>
            <td>${movie.term}</td>
            <td>${movie.torrent?.title}</td>
            <td>${movie.torrent?.size}</td>
            <td>${movie.torrent?.time}</td>
            <td>${movie.torrent?.provider}</td>
            <td><a href="${movie.torrent?.desc}">${movie.torrent?.desc}</a></td>
            <td><button onclick='actionBtn({"term": "${movie.term}", "action": "RemoveMov"})'>Remove</button></td>
        </tr>
        `
    }
    return res;
}

function mngSeries() {
    return `
    <table>
        <h2>Shows</h2>
        <tr>
            <th style="width:15%">Term</th>
            <th style="width:7%">Episode</th>
            <th style="width:30%">Torrent</th>
            <th style="width:7%">Size</th>
            <th style="width:15%">Date</th>            
            <th style="width:7%">Provider</th>
            <th style="width:20%">Link</th>
            <th style="width:100px">Action</th>
        </tr>
    ${seriesList()}
    </table>
    `
}
function seriesList() {
    let res = "";
    for (const serie of store.data.series) {
        res += `
        <tr>
            <td>${serie.term}</td>
            <td>-</td>
            <td>-</td>
            <td>-</td>
            <td>-</td>
            <td>-</td>
            <td>-</td>
            <td>${seriesBtn(serie)}</td>
        </tr>
        ${episodesList(serie.magnets)}
        `
    }
    return res;
}
function seriesBtn(serie) {
    const act = serie.active ? "Disable" : "Activate";
    return `
    <button onclick="actionBtn({'term': '${serie.term}', 'action': '${act}'})">${act}</button>
    <button onclick='actionBtn({"term": "${serie.term}", "action": "RemoveSerie"})'>Remove</button>
    `
}
function episodesList(magnets) {
    let res = "";
    for (const magnet of magnets) {
        res += `
        <tr>
            <td>-</td>
            <td>${magnet.episode}</td>
            <td>${magnet.torrent?.title}</td>
            <td>${magnet.torrent?.size}</td>
            <td>${magnet.torrent?.time}</td>
            <td>${magnet.torrent?.provider}</td>
            <td><a href="${magnet.torrent?.desc}">${magnet.torrent?.desc}</a></td>
            <td>-</td>
        </tr>
        `
    }
    return res;
}

function rawEditor() {
    return `
    <div style="height:600px;overflow:scroll;">
    <pre contenteditable="true" id="rawPre">${JSON.stringify(store.data, undefined, 2)}</pre>
    </div>
    <button onclick="postData()">Update from raw</button>
    <script>
    async function postData() {
        const url = window.location.href + "raw";
        const data = JSON.parse(document.getElementById("rawPre").innerHTML);
        const response = await fetch(url, {
          method: 'POST',
          mode: 'cors',
          cache: 'no-cache',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data) // body data type must match "Content-Type" header
        });
        location.reload();
    }</script>
    `
}

function actionBtn() {
    return `
    <script>
        async function actionBtn(action) {
            const url = window.location.href + "action";
            const response = await fetch(url, {
                method: 'POST',
                mode: 'cors',
                cache: 'no-cache',
                credentials: 'same-origin',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(action) // body data type must match "Content-Type" header
            });
            location.reload();
        }
    </script>
    `
}

function addItem() {
    return `
    <div class="addRow">
        <input type="text" id="movieInp"><button onclick="async function m(){
            const url = window.location.href + 'action';
            const term = await document.getElementById('movieInp').value;
            const response = await fetch(url, {
                method: 'POST',
                mode: 'cors',
                cache: 'no-cache',
                credentials: 'same-origin',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({'term': term, 'action': 'AddMov'})
            });
            location.reload();
        }; m();">Add movie</button>
    </div>
    <div class="addRow">
    <input type="text" id="serieInp"><button onclick="async function m(){
        const url = window.location.href + 'action';
        const term = await document.getElementById('serieInp').value;
        const response = await fetch(url, {
            method: 'POST',
            mode: 'cors',
            cache: 'no-cache',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({'term': term, 'action': 'AddSerie'})
        });
        location.reload();
    }; m();">Add show</button>
    </div>
    `
}

function indexOfTerm(array, term) {
    for (let i = 0; i < array.length; i++) {
        if (array[i].term === term) {
            return i;
        }
    }
    return -1;
}

